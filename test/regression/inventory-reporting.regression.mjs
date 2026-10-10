/**
 * The admin dashboard's stock projection reads product.stock (audit H2-09, Option A).
 *
 * `buildDashboardData` aggregated `InventoryModel` for `inventory.totalStock`,
 * `inventory.inStock`, `inventory.outOfStock` and `tables.lowStockProducts`. No
 * order, cancellation, return, RTO or reservation path has ever written that model —
 * `product.stock` is what those paths move, atomically, with $inc. So the projection
 * diverged from the first sale onwards, and in the live database it had diverged
 * completely: 17 inventory rows, every one of them orphaned, reporting 873 units
 * against a real catalogue total of 7882.
 *
 * The consequence that could actually cost money was the reorder signal.
 * `lowStockProducts` matched `InventoryModel.stock <= threshold`, so a product sold
 * down to zero never appeared — the list came back EMPTY while six products were at
 * or below the threshold, and nothing told the operator to reorder.
 *
 * The fix reads product.stock. It does NOT synchronise InventoryModel from the order
 * paths: that would put a second, non-atomic ledger write inside every stock
 * movement. This suite asserts both halves — that the projection is now truthful,
 * and that nothing started writing the second ledger.
 *
 * Run with `npm run test:inventory-reporting` (or `npm test` for everything).
 */
process.env.NOTIFICATIONS_ENABLED = "false";
process.env.PAYMENTS_ENABLED = "false";
process.env.SHIPROCKET_ENABLED = "false";
process.env.INVENTORY_ENFORCE_STOCK = "true";

import mongoose from "mongoose";
import { readFile } from "node:fs/promises";
import { connect, createSuite, marker, productFixture } from "./helpers.mjs";

const { ok, section, finish } = createSuite("inventory-reporting");
await connect();

const ProductModel = (await import("../../src/modules/products/Product.model.js")).default;
const InventoryModel = (await import("../../src/modules/inventory/inventory.model.js")).default;
const InventorySetting = (await import("../../src/modules/inventory/InventorySetting.model.js")).default;
await import("../../src/modules/categories/Category.model.js");
const { buildDashboardData } = await import("../../src/modules/admin/admin-report.service.js");
const { decrementStock, incrementStock } = await import(
  "../../src/modules/inventory/variant.service.js"
);

const MARKER = marker("invreport");
const trash = { products: [], inventory: [] };
let seq = 0;

const makeProduct = async (stock) => {
  const product = await ProductModel.create(productFixture(`${MARKER}-${(seq += 1)}`, { stock }));
  trash.products.push(product._id);
  return product;
};

/** The dashboard's stock numbers, straight from the real service. */
const dashboardStock = async () => {
  const data = await buildDashboardData();
  return {
    totalStock: data.inventory.totalStock,
    inStock: data.inventory.inStock,
    outOfStock: data.inventory.outOfStock,
    lowStockProducts: data.tables.lowStockProducts,
    raw: data,
  };
};

/** The same figures computed directly off the collection — the thing being claimed. */
const truthFromProducts = async () => {
  const [row] = await ProductModel.aggregate([
    {
      $group: {
        _id: null,
        totalStock: { $sum: "$stock" },
        inStock: { $sum: { $cond: [{ $eq: ["$stock", 0] }, 0, 1] } },
        outOfStock: { $sum: { $cond: [{ $eq: ["$stock", 0] }, 1, 0] } },
      },
    },
  ]);
  return row || { totalStock: 0, inStock: 0, outOfStock: 0 };
};

const stockOf = async (id) => (await ProductModel.findById(id)).stock;

try {
  // ═══════════════════════════════════════════════════════════════════════════
  section("1 — the numbers equal the authoritative product stock");

  {
    // Fixtures across the interesting boundaries: plenty, zero, and low.
    const plenty = await makeProduct(40);
    const zero = await makeProduct(0);
    const { lowStockThreshold } = await InventorySetting.getSettings();
    const low = await makeProduct(Math.max(0, lowStockThreshold - 1));

    const dash = await dashboardStock();
    const truth = await truthFromProducts();

    ok("totalStock equals the sum of product.stock",
      dash.totalStock === truth.totalStock, `${dash.totalStock} vs ${truth.totalStock}`);
    ok("inStock is counted from product.stock",
      dash.inStock === truth.inStock, `${dash.inStock} vs ${truth.inStock}`);
    ok("outOfStock is counted from product.stock",
      dash.outOfStock === truth.outOfStock, `${dash.outOfStock} vs ${truth.outOfStock}`);
    ok("in + out accounts for every product",
      dash.inStock + dash.outOfStock === (await ProductModel.countDocuments()),
      `${dash.inStock}+${dash.outOfStock} vs ${await ProductModel.countDocuments()}`);

    // The rule is carried over from InventoryModel's pre-save hook, not redefined:
    // out of stock means exactly stock === 0.
    ok("a product with stock 0 counts as out of stock, nothing else does",
      truth.outOfStock === (await ProductModel.countDocuments({ stock: 0 })),
      `${truth.outOfStock}`);
    ok("the fixtures are reflected in the totals",
      dash.totalStock >= 40 + Math.max(0, lowStockThreshold - 1), String(dash.totalStock));

    // And crucially: NOT the InventoryModel figure.
    //
    // Proved by planting a row that DELIBERATELY disagrees, rather than by relying on
    // the database already containing a divergence — the divergence is a property of
    // whatever data happens to be present, and a test that depends on that passes or
    // fails for reasons unrelated to the code. This is the fix stated as behaviour:
    // a wrong second ledger must not move the dashboard by a single unit.
    const planted = await InventoryModel.create({
      product_id: plenty._id,
      stock: 999_999,
      history: [
        { previousStock: 40, newStock: 999_999, change: 999_959, note: "deliberately wrong" },
      ],
    });
    trash.inventory.push(planted._id);

    const withWrongLedger = await dashboardStock();
    ok("a wildly wrong InventoryModel row does not move totalStock",
      withWrongLedger.totalStock === dash.totalStock,
      `${withWrongLedger.totalStock} vs ${dash.totalStock}`);
    ok("nor the in-stock count", withWrongLedger.inStock === dash.inStock);
    ok("nor the out-of-stock count", withWrongLedger.outOfStock === dash.outOfStock);
    ok("the dashboard still equals the product-stock sum",
      withWrongLedger.totalStock === (await truthFromProducts()).totalStock);

    // The same row, if it were still the source, would have reported this instead.
    const [inventoryFigure] = await InventoryModel.aggregate([
      { $group: { _id: null, totalStock: { $sum: "$stock" } } },
    ]);
    ok("and the two figures genuinely differ, so the assertion above has teeth",
      inventoryFigure.totalStock !== withWrongLedger.totalStock,
      `inventory ${inventoryFigure.totalStock} vs dashboard ${withWrongLedger.totalStock}`);

    // A zero-stock inventory row must not create a phantom out-of-stock either.
    const phantom = await InventoryModel.create({ product_id: zero._id, stock: 0 });
    trash.inventory.push(phantom._id);
    const withPhantom = await dashboardStock();
    ok("an extra InventoryModel row adds no phantom product to the counts",
      withPhantom.inStock + withPhantom.outOfStock === (await ProductModel.countDocuments()),
      `${withPhantom.inStock}+${withPhantom.outOfStock}`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("2 — lowStockProducts uses the existing configured threshold");

  {
    const { lowStockThreshold } = await InventorySetting.getSettings();
    ok("the threshold comes from InventorySetting, not a new constant",
      Number.isFinite(lowStockThreshold), String(lowStockThreshold));

    const dash = await dashboardStock();
    const rows = dash.lowStockProducts;

    ok("every listed product is at or below the threshold",
      rows.every((row) => row.stock <= lowStockThreshold),
      JSON.stringify(rows.map((r) => r.stock)));
    ok("the list is sorted lowest stock first",
      rows.every((row, index) => index === 0 || rows[index - 1].stock <= row.stock),
      JSON.stringify(rows.map((r) => r.stock)));
    ok("and capped at 10", rows.length <= 10, String(rows.length));

    const qualifying = await ProductModel.countDocuments({ stock: { $lte: lowStockThreshold } });
    ok("the list is non-empty when products actually qualify",
      qualifying === 0 || rows.length > 0, `${qualifying} qualify, ${rows.length} listed`);
    ok("it lists as many as it can, up to the cap",
      rows.length === Math.min(qualifying, 10), `${rows.length} vs min(${qualifying},10)`);

    // A product sold down to zero MUST appear — the old query never surfaced one.
    const zeroCount = await ProductModel.countDocuments({ stock: 0 });
    const sold = await makeProduct(3);
    ok("the decrement succeeds", await decrementStock({ productId: sold._id, quantity: 3 }));
    ok("  leaving it at zero", (await stockOf(sold._id)) === 0);

    const afterSale = await dashboardStock();
    if (zeroCount + 1 <= 10) {
      ok("a product sold down to zero now appears in the low-stock list",
        afterSale.lowStockProducts.some((row) => String(row.productId) === String(sold._id)),
        JSON.stringify(afterSale.lowStockProducts.map((r) => r.stock)));
    } else {
      ok("more than 10 products sit at zero, so the cap decides membership — skipped",
        true, `${zeroCount + 1} at zero`);
    }
    ok("and it is reported as Out of Stock",
      afterSale.lowStockProducts
        .filter((row) => String(row.productId) === String(sold._id))
        .every((row) => row.status === "Out of Stock"), "status mismatch");
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("3 — a real production-path decrement moves the dashboard");

  {
    const product = await makeProduct(25);
    const before = await dashboardStock();

    // decrementStock is the function order placement actually calls — three call
    // sites: order.controller.js, payment-order.service.js and the reservation
    // service. Not a hand-written database mutation.
    const applied = await decrementStock({ productId: product._id, quantity: 10 });
    ok("the production decrement path succeeds", applied === true);
    ok("product.stock fell to 15", (await stockOf(product._id)) === 15,
      String(await stockOf(product._id)));

    const after = await dashboardStock();
    ok("the dashboard total fell by exactly the units sold",
      after.totalStock === before.totalStock - 10,
      `${after.totalStock} vs ${before.totalStock - 10}`);
    ok("and still equals the collection sum",
      after.totalStock === (await truthFromProducts()).totalStock);
    ok("the product is still counted as in stock", after.inStock === before.inStock,
      `${after.inStock} vs ${before.inStock}`);

    // Selling the remainder must flip it to out of stock.
    await decrementStock({ productId: product._id, quantity: 15 });
    const emptied = await dashboardStock();
    ok("selling the last unit moves it to out of stock",
      emptied.outOfStock === before.outOfStock + 1,
      `${emptied.outOfStock} vs ${before.outOfStock + 1}`);
    ok("and out of the in-stock count", emptied.inStock === before.inStock - 1,
      `${emptied.inStock} vs ${before.inStock - 1}`);
    ok("the total is down by the full 25", emptied.totalStock === before.totalStock - 25,
      `${emptied.totalStock} vs ${before.totalStock - 25}`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("4 — a real restock moves it back");

  {
    const product = await makeProduct(12);
    const start = await dashboardStock();

    await decrementStock({ productId: product._id, quantity: 12 });
    const sold = await dashboardStock();
    ok("after the sale the product is out of stock",
      sold.outOfStock === start.outOfStock + 1 && sold.totalStock === start.totalStock - 12,
      `${sold.outOfStock}/${sold.totalStock}`);

    // incrementStock is what CancelOrder calls (order.controller.js:729) and what the
    // return and RTO restocks go through.
    await incrementStock({ productId: product._id, quantity: 12 });
    const restored = await dashboardStock();
    ok("the restock returns the units to the dashboard total",
      restored.totalStock === start.totalStock, `${restored.totalStock} vs ${start.totalStock}`);
    ok("and the product counts as in stock again",
      restored.inStock === start.inStock && restored.outOfStock === start.outOfStock,
      `${restored.inStock}/${restored.outOfStock} vs ${start.inStock}/${start.outOfStock}`);
    ok("product.stock is back to 12", (await stockOf(product._id)) === 12);
    ok("and the projection still matches the collection",
      restored.totalStock === (await truthFromProducts()).totalStock);

    // A partial restock — a cancellation of some units — is reflected proportionally.
    await decrementStock({ productId: product._id, quantity: 12 });
    await incrementStock({ productId: product._id, quantity: 5 });
    const partial = await dashboardStock();
    ok("a partial restock is reflected exactly",
      partial.totalStock === start.totalStock - 7,
      `${partial.totalStock} vs ${start.totalStock - 7}`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("5 — nothing started writing the second ledger");

  {
    const before = await InventoryModel.countDocuments();
    const beforeRows = await InventoryModel.find().select("stock product_id updatedAt").lean();

    const product = await makeProduct(30);
    await decrementStock({ productId: product._id, quantity: 7 });
    await incrementStock({ productId: product._id, quantity: 3 });
    await dashboardStock();

    ok("a stock movement creates no InventoryModel row",
      (await InventoryModel.countDocuments()) === before, `${await InventoryModel.countDocuments()} vs ${before}`);
    const afterRows = await InventoryModel.find().select("stock product_id updatedAt").lean();
    ok("and modifies none of the existing rows",
      JSON.stringify(afterRows) === JSON.stringify(beforeRows));
    ok("reading the dashboard writes nothing either",
      (await InventoryModel.countDocuments()) === before);

    // Structural: the order paths must not have acquired a second ledger write.
    const files = [
      "../../src/modules/orders/order.controller.js",
      "../../src/modules/inventory/variant.service.js",
      "../../src/modules/inventory/restock.service.js",
      "../../src/modules/inventory/inventory-reservation.service.js",
      "../../src/modules/inventory/stock-reservation-cleanup.service.js",
      "../../src/modules/payments/payment-order.service.js",
      "../../src/modules/returns/return.controller.js",
      "../../src/modules/shipping/shipping.controller.js",
    ];
    for (const file of files) {
      const source = await readFile(new URL(file, import.meta.url), "utf8");
      ok(`${file.split("/").pop()} does not touch InventoryModel`,
        !/inventory\.model|InventoryModel/.test(source));
    }

    const report = await readFile(
      new URL("../../src/modules/admin/admin-report.service.js", import.meta.url),
      "utf8",
    );
    ok("the dashboard no longer imports InventoryModel at all",
      !/inventory\/inventory\.model/.test(report));
    ok("but still reads the existing low-stock setting",
      /InventorySetting\.getSettings\(\)/.test(report));
    ok("and the stock projection is built from Product",
      /Product\.aggregate\(\[\s*\{\s*\$group/.test(report));

    // The model itself is untouched — this phase reports it, it does not remove it.
    ok("InventoryModel still exists", Boolean(InventoryModel));
    ok("and its admin controller still uses it",
      /InventoryModel/.test(
        await readFile(
          new URL("../../src/modules/inventory/inventory.controller.js", import.meta.url),
          "utf8",
        ),
      ));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("6 — the response shape is unchanged");

  {
    const { raw } = await dashboardStock();

    ok("the top-level keys are unchanged",
      JSON.stringify(Object.keys(raw)) === JSON.stringify(["cards", "inventory", "charts", "tables"]),
      JSON.stringify(Object.keys(raw)));
    ok("inventory still carries the same three figures",
      ["totalStock", "inStock", "outOfStock"].every((key) => key in raw.inventory),
      JSON.stringify(Object.keys(raw.inventory)));
    ok("including the _id the $group has always emitted, so no consumer loses a key",
      "_id" in raw.inventory, JSON.stringify(Object.keys(raw.inventory)));
    ok("all three are numbers",
      ["totalStock", "inStock", "outOfStock"].every(
        (key) => typeof raw.inventory[key] === "number",
      ));
    ok("charts are unchanged",
      ["productsByCategory", "ordersLast7Days", "revenueLast7Days"].every((k) => k in raw.charts),
      JSON.stringify(Object.keys(raw.charts)));
    ok("tables still include lowStockProducts",
      "lowStockProducts" in raw.tables, JSON.stringify(Object.keys(raw.tables)));

    const row = raw.tables.lowStockProducts[0];
    if (row) {
      ok("each low-stock row keeps its existing fields",
        ["productId", "productName", "brand", "image", "stock", "status"].every((k) => k in row),
        JSON.stringify(Object.keys(row)));
      ok("and no more than those", Object.keys(row).length === 6, JSON.stringify(Object.keys(row)));
      ok("status uses the existing vocabulary",
        ["In Stock", "Out of Stock"].includes(row.status), row.status);
      ok("productId is the product's own id, resolvable in the catalogue",
        Boolean(await ProductModel.findById(row.productId)));
    } else {
      ok("no low-stock rows to shape-check in this database", true);
    }

    ok("cards are untouched by this change",
      "totalProducts" in raw.cards && "totalRevenue" in raw.cards,
      JSON.stringify(Object.keys(raw.cards).slice(0, 4)));
  }
} catch (error) {
  console.error("\nSUITE ABORTED:", error);
  process.exitCode = 1;
} finally {
  await ProductModel.deleteMany({ _id: { $in: trash.products } });
  await InventoryModel.deleteMany({ _id: { $in: trash.inventory } });
  await mongoose.disconnect();
  finish();
}
