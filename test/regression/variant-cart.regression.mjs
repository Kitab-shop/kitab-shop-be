/**
 * Variant-aware cart availability (Phase 3 / audit F4).
 *
 * The cart validated against `product.stock` — the TOTAL across variants — while
 * checkout validated against the variant's own stock. So a product with 10 units
 * split 10 Red / 0 Blue accepted 10 Blue into the cart, and the shopper only
 * discovered otherwise when the order was rejected.
 *
 * Run with `npm run test:variant-cart` (or `npm test` for everything).
 *
 * Two deliberate choices about scope:
 *
 *   - Availability is ADVISORY and this suite treats it that way. The authority is
 *     the conditional `decrementStock` at checkout, which is asserted here to still
 *     reject what the cart merely warns about. Nothing in this suite claims the
 *     cart eliminates a checkout race.
 *   - The cart controller's own helpers are exercised through `addItemsToCart`'s
 *     HTTP handlers where practical, and through `lineAvailability` /
 *     `prepareOrderData` directly for the pure logic, so a failure points at the
 *     layer that owns it.
 */
process.env.INVENTORY_ENFORCE_STOCK = "true";
process.env.NOTIFICATIONS_ENABLED = "false";

import mongoose from "mongoose";
import { readFile } from "node:fs/promises";
import { connect, createSuite, marker, productFixture, addressFixture } from "./helpers.mjs";

const { ok, section, finish } = createSuite("variant-cart");
await connect();

const ProductModel = (await import("../../src/modules/products/Product.model.js")).default;
const cartModel = (await import("../../src/modules/cart/cart.model.js")).default;
// `populateCart` populates items.product and then its category_id, so the Category
// model has to be registered or every cart read throws MissingSchemaError.
await import("../../src/modules/categories/Category.model.js");
const {
  availableStockFor,
  decrementStock,
  findVariant,
  getVariantKey,
  hasVariantStock,
  lineAvailability,
  normalizeSelectedVariants,
  resolveVariantId,
  variantKeyFrom,
  variantKeyOf,
} = await import("../../src/modules/inventory/variant.service.js");
const { prepareOrderData } = await import("../../src/modules/orders/order-pricing.service.js");
const cartController = await import("../../src/modules/cart/cart.controller.js");
const productController = await import("../../src/modules/products/product.controller.js");
const { findUnsupportedVariantFormat } = await import(
  "../../src/modules/products/product-query.service.js"
);

const MARKER = marker("variantcart");
const trash = { products: [], carts: [] };

/** `variants` = [{name, attributes, stock, active?}] */
const makeProduct = async (label, { stock, variants = [] } = {}) => {
  const product = await ProductModel.create(
    productFixture(`${MARKER}-${label}`, {
      stock,
      variants: variants.map((variant) => ({
        name: variant.name,
        attributes: variant.attributes,
        stock: variant.stock,
        active: variant.active !== false,
      })),
    }),
  );
  trash.products.push(product._id);
  return product;
};

/** Drives the real HTTP handler, so route-level behaviour is what's asserted. */
const callHandler = async (handler, { body = {}, user }) => {
  let statusCode = 200;
  let payload;
  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(data) {
      payload = data;
      return this;
    },
  };
  await handler({ body, user, params: {}, query: {} }, res);
  return { statusCode, body: payload };
};

const asCustomer = (userId) => ({ id: String(userId), roles: [] });

const trackCart = async (userId) => {
  const cart = await cartModel.findOne({ user: userId });
  if (cart) trash.carts.push(cart._id);
  return cart;
};

try {
  // ═══════════════════════════════════════════════════════════════════════════
  section("canonical variant key — one algorithm, one normalisation");

  {
    ok(
      "attribute order does not change the key",
      variantKeyFrom({ color: "red", size: "M" }) === variantKeyFrom({ size: "M", color: "red" }),
      variantKeyFrom({ color: "red", size: "M" }),
    );
    ok(
      "color:red,size:M and color:red,size:L are DIFFERENT keys",
      variantKeyFrom({ color: "red", size: "M" }) !== variantKeyFrom({ color: "red", size: "L" }),
    );

    // The F3 divergence: the cart dropped empty values before keying, the order
    // path did not, so one selection produced two different names for one line.
    ok(
      "an empty attribute value is normalised away",
      variantKeyFrom({ color: "red", size: "" }) === variantKeyFrom({ color: "red" }),
      `${variantKeyFrom({ color: "red", size: "" })} vs ${variantKeyFrom({ color: "red" })}`,
    );
    ok(
      "null and undefined values are normalised away too",
      variantKeyFrom({ color: "red", size: null, fit: undefined }) === "color:red",
      variantKeyFrom({ color: "red", size: null, fit: undefined }),
    );
    ok(
      "the raw keyer still includes an empty value (so normalisation is doing the work)",
      getVariantKey({ color: "red", size: "" }) === "color:red|size:",
      getVariantKey({ color: "red", size: "" }),
    );
    ok("non-object input is safe", variantKeyFrom(null) === "" && variantKeyFrom("x") === "");
    ok(
      "numeric values are coerced consistently",
      variantKeyFrom({ ratti: 4.25 }) === "ratti:4.25",
      variantKeyFrom({ ratti: 4.25 }),
    );
    ok(
      "normalizeSelectedVariants strips empties",
      JSON.stringify(normalizeSelectedVariants({ a: "1", b: "", c: null })) === '{"a":"1"}',
      JSON.stringify(normalizeSelectedVariants({ a: "1", b: "", c: null })),
    );
  }

  {
    // A product's variant (attributes Map) must key the same way a cart/order line
    // (selectedVariants) does, or nothing can be matched to anything.
    const product = await makeProduct("keymatch", {
      stock: 5,
      variants: [{ name: "Red M", attributes: { color: "red", size: "M" }, stock: 5 }],
    });
    const key = variantKeyFrom({ color: "red", size: "M" });
    ok(
      "a product variant keys identically to a line selection",
      variantKeyOf(product.variants[0]) === key,
      `${variantKeyOf(product.variants[0])} vs ${key}`,
    );
    ok("and is therefore findable", Boolean(findVariant(product, key)));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("1 — non-variant product keeps existing behaviour");

  {
    const product = await makeProduct("plain", { stock: 7 });
    ok("not tracked per variant", hasVariantStock(product) === false);
    const availability = lineAvailability(product, "");
    ok("availability is product-level", availability.available === 7, String(availability.available));
    ok("tracksVariant is false", availability.tracksVariant === false);
    ok("treated as active", availability.isActive === true);

    // A line naming a variant on a product that has none falls back to the product
    // pool — the live catalogue actually contains exactly this shape.
    const stray = lineAvailability(product, "Size:Standard");
    ok(
      "a stray variantKey on a variant-less product falls back to product stock",
      stray.available === 7 && stray.variantFound === false,
      JSON.stringify(stray),
    );
  }

  section("2 — variant with sufficient stock");

  {
    const product = await makeProduct("sufficient", {
      stock: 8,
      variants: [
        { name: "Red", attributes: { color: "red" }, stock: 5 },
        { name: "Blue", attributes: { color: "blue" }, stock: 3 },
      ],
    });
    const red = lineAvailability(product, variantKeyFrom({ color: "red" }));
    ok("the variant's own stock is reported", red.available === 5, String(red.available));
    ok("NOT the product total of 8", red.available !== 8);
  }

  section("3 — variant sold out (the audit's exact case)");

  {
    // 10 units: 10 Red, 0 Blue. product.stock = 10, so the old cart check passed.
    const product = await makeProduct("soldout", {
      stock: 10,
      variants: [
        { name: "Red", attributes: { color: "red" }, stock: 10 },
        { name: "Blue", attributes: { color: "blue" }, stock: 0 },
      ],
    });
    const blueKey = variantKeyFrom({ color: "blue" });

    ok("product total still reads 10", product.stock === 10);
    ok(
      "but the sold-out variant reports 0",
      lineAvailability(product, blueKey).available === 0,
      String(lineAvailability(product, blueKey).available),
    );

    // The cart must now refuse it, where before it accepted 10.
    const userId = new mongoose.Types.ObjectId();
    const response = await callHandler(cartController.addToCart, {
      user: asCustomer(userId),
      body: {
        items: [{ productId: String(product._id), quantity: 1, selectedVariants: { color: "blue" } }],
      },
    });
    await trackCart(userId);

    // The BULK endpoint (the guest-merge path) now skips-and-reports refused
    // lines instead of aborting the whole request — one bad guest line used to
    // poison the entire merge forever. The refusal itself is unchanged: it
    // arrives in `skipped[]` with the same code and variant-naming message.
    const rejectedLine = (response.body?.skipped || [])[0];
    ok("adding a sold-out variant is rejected (skipped, not aborted)",
      response.statusCode === 200 && Boolean(rejectedLine),
      `${response.statusCode} ${JSON.stringify(response.body?.skipped)}`);
    ok("with INSUFFICIENT_STOCK", rejectedLine?.code === "INSUFFICIENT_STOCK", rejectedLine?.code);
    ok(
      "and the message names the variant, not the product total",
      /only 0 item/i.test(rejectedLine?.message || ""),
      rejectedLine?.message,
    );

    // The in-stock variant of the SAME product still works.
    const okResponse = await callHandler(cartController.addToCart, {
      user: asCustomer(userId),
      body: {
        items: [{ productId: String(product._id), quantity: 2, selectedVariants: { color: "red" } }],
      },
    });
    await trackCart(userId);
    ok("the in-stock variant is still addable", okResponse.statusCode === 200, String(okResponse.statusCode));
  }

  section("4 — variant partially available");

  {
    const product = await makeProduct("partial", {
      stock: 12,
      variants: [{ name: "Red", attributes: { color: "red" }, stock: 2 }],
    });
    const userId = new mongoose.Types.ObjectId();

    const tooMany = await callHandler(cartController.addToCart, {
      user: asCustomer(userId),
      body: {
        items: [{ productId: String(product._id), quantity: 3, selectedVariants: { color: "red" } }],
      },
    });
    await trackCart(userId);
    // Bulk endpoint: refusals arrive in skipped[] (see section 3's comment).
    const tooManySkipped = (tooMany.body?.skipped || [])[0];
    ok("asking for 3 of 2 is refused",
      tooMany.statusCode === 200 && tooManySkipped?.code === "INSUFFICIENT_STOCK",
      `${tooMany.statusCode} ${JSON.stringify(tooMany.body?.skipped)}`);
    ok(
      "the available count is reported for the UI",
      tooManySkipped?.details?.availableStock === 2,
      JSON.stringify(tooManySkipped?.details),
    );
    ok(
      "and the variantKey is reported",
      tooManySkipped?.details?.variantKey === variantKeyFrom({ color: "red" }),
      JSON.stringify(tooManySkipped?.details),
    );

    const exact = await callHandler(cartController.addToCart, {
      user: asCustomer(userId),
      body: {
        items: [{ productId: String(product._id), quantity: 2, selectedVariants: { color: "red" } }],
      },
    });
    await trackCart(userId);
    ok("asking for exactly 2 succeeds", exact.statusCode === 200, String(exact.statusCode));
  }

  section("5 — quantity increase beyond variant stock");

  {
    const product = await makeProduct("increase", {
      stock: 20,
      variants: [{ name: "Red", attributes: { color: "red" }, stock: 3 }],
    });
    const userId = new mongoose.Types.ObjectId();
    await callHandler(cartController.addToCart, {
      user: asCustomer(userId),
      body: {
        items: [{ productId: String(product._id), quantity: 1, selectedVariants: { color: "red" } }],
      },
    });
    await trackCart(userId);

    const tooHigh = await callHandler(cartController.updateQuantity, {
      user: asCustomer(userId),
      body: {
        productId: String(product._id),
        selectedVariants: { color: "red" },
        quantity: 4,
      },
    });
    ok(
      "increasing past variant stock is refused (4 of 3)",
      tooHigh.statusCode === 400,
      String(tooHigh.statusCode),
    );
    ok("availableStock reflects the VARIANT", tooHigh.body?.availableStock === 3, String(tooHigh.body?.availableStock));
    ok(
      "not the product total of 20",
      tooHigh.body?.availableStock !== 20,
      String(tooHigh.body?.availableStock),
    );

    const allowed = await callHandler(cartController.updateQuantity, {
      user: asCustomer(userId),
      body: { productId: String(product._id), selectedVariants: { color: "red" }, quantity: 3 },
    });
    ok("increasing to exactly the variant stock is allowed", allowed.statusCode === 200, String(allowed.statusCode));

    // Reductions must stay possible even when the line already exceeds stock —
    // otherwise an admin lowering stock strands the customer.
    await ProductModel.updateOne(
      { _id: product._id, "variants.name": "Red" },
      { $set: { "variants.$.stock": 1 } },
    );
    const reduced = await callHandler(cartController.updateQuantity, {
      user: asCustomer(userId),
      body: { productId: String(product._id), selectedVariants: { color: "red" }, quantity: 2 },
    });
    ok(
      "reducing is still allowed above the new ceiling (3 → 2 with 1 left)",
      reduced.statusCode === 200,
      `${reduced.statusCode} ${reduced.body?.message || ""}`,
    );
  }

  section("6/7 — multiple variants of one product, tracked separately");

  {
    const product = await makeProduct("multi", {
      stock: 9,
      variants: [
        { name: "Red M", attributes: { color: "red", size: "M" }, stock: 4 },
        { name: "Red L", attributes: { color: "red", size: "L" }, stock: 0 },
        { name: "Blue M", attributes: { color: "blue", size: "M" }, stock: 5 },
      ],
    });

    const redM = lineAvailability(product, variantKeyFrom({ color: "red", size: "M" }));
    const redL = lineAvailability(product, variantKeyFrom({ color: "red", size: "L" }));
    const blueM = lineAvailability(product, variantKeyFrom({ color: "blue", size: "M" }));

    ok("red/M has 4", redM.available === 4, String(redM.available));
    ok("red/L has 0 — a different quantity from red/M", redL.available === 0, String(redL.available));
    ok("blue/M has 5", blueM.available === 5, String(blueM.available));
    ok(
      "none of them reports the product total of 9",
      [redM, redL, blueM].every((a) => a.available !== 9),
    );

    // Two variants of one product coexist as separate cart lines.
    const userId = new mongoose.Types.ObjectId();
    await callHandler(cartController.addToCart, {
      user: asCustomer(userId),
      body: {
        items: [
          { productId: String(product._id), quantity: 2, selectedVariants: { color: "red", size: "M" } },
          { productId: String(product._id), quantity: 1, selectedVariants: { color: "blue", size: "M" } },
        ],
      },
    });
    const cart = await trackCart(userId);
    ok("both variants are separate cart lines", cart.items.length === 2, `${cart.items.length} lines`);
    ok(
      "each line stores its own canonical key",
      cart.items.some((i) => i.variantKey === variantKeyFrom({ color: "red", size: "M" })) &&
        cart.items.some((i) => i.variantKey === variantKeyFrom({ color: "blue", size: "M" })),
      JSON.stringify(cart.items.map((i) => i.variantKey)),
    );

    // The sold-out sibling is still refused while the others are in the cart.
    const soldOutSibling = await callHandler(cartController.addToCart, {
      user: asCustomer(userId),
      body: {
        items: [
          { productId: String(product._id), quantity: 1, selectedVariants: { color: "red", size: "L" } },
        ],
      },
    });
    ok(
      "the sold-out sibling variant is refused (skipped on the bulk path)",
      soldOutSibling.statusCode === 200 &&
        (soldOutSibling.body?.skipped || [])[0]?.code === "INSUFFICIENT_STOCK",
      `${soldOutSibling.statusCode} ${JSON.stringify(soldOutSibling.body?.skipped)}`,
    );
  }

  section("8 — variant deactivated or removed");

  {
    const product = await makeProduct("deactivated", {
      stock: 6,
      variants: [
        { name: "Red", attributes: { color: "red" }, stock: 6, active: false },
        { name: "Blue", attributes: { color: "blue" }, stock: 0 },
      ],
    });
    const redKey = variantKeyFrom({ color: "red" });
    const availability = lineAvailability(product, redKey);

    ok("a deactivated variant reports 0 available", availability.available === 0, String(availability.available));
    ok("even though it holds 6 units of stock", product.variants[0].stock === 6);
    ok("and is flagged inactive", availability.isActive === false);

    const userId = new mongoose.Types.ObjectId();
    const response = await callHandler(cartController.addToCart, {
      user: asCustomer(userId),
      body: {
        items: [{ productId: String(product._id), quantity: 1, selectedVariants: { color: "red" } }],
      },
    });
    await trackCart(userId);
    const deactivatedSkip = (response.body?.skipped || [])[0];
    ok("adding a deactivated variant is refused (skipped on the bulk path)",
      response.statusCode === 200 && Boolean(deactivatedSkip),
      `${response.statusCode} ${JSON.stringify(response.body?.skipped)}`);
    ok("with VARIANT_UNAVAILABLE, not INSUFFICIENT_STOCK", deactivatedSkip?.code === "VARIANT_UNAVAILABLE", deactivatedSkip?.code);
    ok(
      "and says it is unavailable rather than quoting a quantity",
      /no longer available/i.test(deactivatedSkip?.message || ""),
      deactivatedSkip?.message,
    );
  }

  {
    // A variant deleted from the catalogue after being added to the cart.
    const product = await makeProduct("removed", {
      stock: 4,
      variants: [{ name: "Red", attributes: { color: "red" }, stock: 4 }],
    });
    await ProductModel.updateOne({ _id: product._id }, { $set: { variants: [] } });
    const after = await ProductModel.findById(product._id);
    const availability = lineAvailability(after, variantKeyFrom({ color: "red" }));
    ok(
      "a removed variant falls back to the product pool, as the order path does",
      availability.available === 4 && availability.variantFound === false,
      JSON.stringify(availability),
    );
  }

  section("9 — checkout remains authoritative");

  {
    const product = await makeProduct("checkout", {
      stock: 10,
      variants: [
        { name: "Red", attributes: { color: "red" }, stock: 10 },
        { name: "Blue", attributes: { color: "blue" }, stock: 0 },
      ],
    });
    const blueKey = variantKeyFrom({ color: "blue" });

    let rejected = null;
    try {
      await prepareOrderData({
        items: [
          { product: String(product._id), quantity: 1, selectedVariants: { color: "blue" } },
        ],
        rawShippingAddress: addressFixture(),
        userId: new mongoose.Types.ObjectId(),
      });
    } catch (error) {
      rejected = error;
    }
    ok("checkout still rejects a sold-out variant", Boolean(rejected), "it was accepted");
    ok(
      "with a variant-specific message",
      /only 0 item/i.test(rejected?.message || ""),
      rejected?.message,
    );

    // The cart's advisory number and checkout's authority agree.
    ok(
      "cart availability and checkout's source agree",
      lineAvailability(product, blueKey).available === availableStockFor(product, blueKey),
    );

    // Deactivated variants are refused by checkout too (its own separate rule).
    const deactivated = await makeProduct("checkout-inactive", {
      stock: 5,
      variants: [{ name: "Red", attributes: { color: "red" }, stock: 5, active: false }],
    });
    let inactiveError = null;
    try {
      await prepareOrderData({
        items: [
          { product: String(deactivated._id), quantity: 1, selectedVariants: { color: "red" } },
        ],
        rawShippingAddress: addressFixture(),
        userId: new mongoose.Types.ObjectId(),
      });
    } catch (error) {
      inactiveError = error;
    }
    ok("checkout rejects a deactivated variant", Boolean(inactiveError), "it was accepted");
  }

  section("10 — the authority is still the atomic decrement, not the cart");

  {
    const product = await makeProduct("race", {
      stock: 1,
      variants: [{ name: "Red", attributes: { color: "red" }, stock: 1 }],
    });
    const variantId = await resolveVariantId(product._id, variantKeyFrom({ color: "red" }));
    ok("the variant resolves to an _id for the atomic filter", Boolean(variantId));

    // Two buyers, one unit. The cart would have told BOTH it was available — which
    // is exactly why the cart is advisory and this is the authority.
    const [first, second] = await Promise.all([
      decrementStock({ productId: product._id, quantity: 1, variantId }),
      decrementStock({ productId: product._id, quantity: 1, variantId }),
    ]);
    ok(
      "exactly one concurrent decrement succeeds",
      [first, second].filter(Boolean).length === 1,
      `${first} / ${second}`,
    );

    const after = await ProductModel.findById(product._id);
    ok("variant stock is 0, never negative", after.variants[0].stock === 0, String(after.variants[0].stock));
    ok("product total is 0, never negative", after.stock === 0, String(after.stock));
    ok(
      "cart availability now reports 0 for both",
      lineAvailability(after, variantKeyFrom({ color: "red" })).available === 0,
    );
  }

  section("cart GET reports availability");

  {
    const product = await makeProduct("getcart", {
      stock: 9,
      variants: [
        { name: "Red", attributes: { color: "red" }, stock: 2 },
        { name: "Blue", attributes: { color: "blue" }, stock: 7 },
      ],
    });
    const userId = new mongoose.Types.ObjectId();
    await callHandler(cartController.addToCart, {
      user: asCustomer(userId),
      body: {
        items: [{ productId: String(product._id), quantity: 2, selectedVariants: { color: "red" } }],
      },
    });
    await trackCart(userId);

    // Stock drops beneath what's already in the cart.
    await ProductModel.updateOne(
      { _id: product._id, "variants.name": "Red" },
      { $set: { "variants.$.stock": 1 } },
    );

    const response = await callHandler(cartController.getCart, { user: asCustomer(userId) });
    const line = response.body?.data?.items?.[0];
    ok("the cart GET succeeds", response.statusCode === 200, String(response.statusCode));
    ok("it reports the VARIANT's availability", line?.availableStock === 1, JSON.stringify(line?.availableStock));
    ok("not the product total of 9", line?.availableStock !== 9);
    ok("it flags the line as exceeding stock", line?.exceedsStock === true, JSON.stringify(line?.exceedsStock));
    ok("and still in stock (1 > 0)", line?.inStock === true, JSON.stringify(line?.inStock));
    ok("variantUnavailable is false for a merely-low variant", line?.variantUnavailable === false);
  }

  {
    // Deactivation surfaces distinctly on the GET, so the UI can say "unavailable"
    // instead of the useless "reduce to 0".
    const product = await makeProduct("getcart-inactive", {
      stock: 5,
      variants: [{ name: "Red", attributes: { color: "red" }, stock: 5 }],
    });
    const userId = new mongoose.Types.ObjectId();
    await callHandler(cartController.addToCart, {
      user: asCustomer(userId),
      body: {
        items: [{ productId: String(product._id), quantity: 1, selectedVariants: { color: "red" } }],
      },
    });
    await trackCart(userId);

    await ProductModel.updateOne(
      { _id: product._id, "variants.name": "Red" },
      { $set: { "variants.$.active": false } },
    );

    const response = await callHandler(cartController.getCart, { user: asCustomer(userId) });
    const line = response.body?.data?.items?.[0];
    ok("a deactivated variant is flagged on the GET", line?.variantUnavailable === true, JSON.stringify(line));
    ok("with 0 available", line?.availableStock === 0, String(line?.availableStock));
    ok("and inStock false", line?.inStock === false, String(line?.inStock));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("the variant WRITE contract — no silent data loss");

  {
    // The admin product form posts option GROUPS (the axes of variation); the schema
    // stores per-COMBINATION variants. normalizeVariants is a normaliser, so it
    // dropped everything it did not recognise and returned 200 — every size, price
    // and MRP the admin typed was destroyed, and the stored variant then made
    // hasVariantStock true with an empty attributes map, silently reverting
    // availability to product-level stock.
    const ADMIN_OPTION_GROUP = [
      {
        name: "Size",
        options: [
          { name: "M", price: "500", mrp: "700", stock: 12 },
          { name: "L", price: "600", mrp: "800", stock: 4 },
        ],
      },
    ];

    const callProduct = async (handler, { params = {}, body = {}, file, user } = {}) => {
      let statusCode = 200;
      let payload;
      const res = {
        status(code) { statusCode = code; return this; },
        json(data) { payload = data; return this; },
      };
      await handler({ params, body, file, user, query: {} }, res);
      return { statusCode, body: payload };
    };

    const snapshotProduct = async (id) => {
      const doc = await ProductModel.findById(id).lean();
      return JSON.stringify({
        name: doc.name, price: doc.price, mrp: doc.mrp, stock: doc.stock,
        variants: doc.variants, updatedAt: doc.updatedAt,
      });
    };

    // ── Test 1 + 2: rejected, and the product is untouched ──────────────────
    const product = await makeProduct("write-contract", { stock: 12 });
    const before = await snapshotProduct(product._id);

    const rejected = await callProduct(productController.UpdateProduct, {
      params: { id: String(product._id) },
      body: { variants: ADMIN_OPTION_GROUP },
      user: { id: String(new mongoose.Types.ObjectId()), roles: ["admin"] },
    });

    // ── The admin payload is now EXPANDED, not discarded ────────────────────
    const expanded = await callProduct(productController.UpdateProduct, {
      params: { id: String(product._id) },
      body: { variants: ADMIN_OPTION_GROUP },
      user: { id: String(new mongoose.Types.ObjectId()), roles: ["admin"] },
    });
    ok("the admin option-group payload is accepted", expanded.statusCode === 200,
      `${expanded.statusCode} ${expanded.body?.message}`);

    const grown = await ProductModel.findById(product._id);
    ok("it becomes one variant per option, not one stripped placeholder",
      grown.variants.length === 2, JSON.stringify(grown.variants.map((v) => v.name)));
    ok("NOT the old silent-loss result (attributes {}, stock 0)",
      !grown.variants.some((v) => Object.keys(v.attributes || {}).length === 0));

    const mVariant = grown.variants.find((v) => v.name === "M");
    const lVariant = grown.variants.find((v) => v.name === "L");
    ok("every option name survives", Boolean(mVariant) && Boolean(lVariant));
    ok("each price survives", mVariant.price === 500 && lVariant.price === 600,
      `${mVariant?.price}/${lVariant?.price}`);
    ok("each mrp survives", mVariant.mrp === 700 && lVariant.mrp === 800,
      `${mVariant?.mrp}/${lVariant?.mrp}`);
    ok("each STOCK survives — the field the old payload could not even carry",
      mVariant.stock === 12 && lVariant.stock === 4, `${mVariant?.stock}/${lVariant?.stock}`);
    ok("the axis name becomes the attribute key",
      variantKeyOf(mVariant) === variantKeyFrom({ Size: "M" }), variantKeyOf(mVariant));
    ok("so a storefront selection resolves to the right variant",
      findVariant(grown, variantKeyFrom({ Size: "M" }))?.stock === 12);
    ok("and the other variant is untouched by it",
      findVariant(grown, variantKeyFrom({ Size: "L" }))?.stock === 4);

    // ── product.stock is now DERIVED from the variants ──────────────────────
    ok("product.stock becomes the sum of its variants, not the form's 12",
      grown.stock === 16, `${grown.stock} vs 16`);

    const restocked = await callProduct(productController.UpdateProduct, {
      params: { id: String(product._id) },
      body: {
        stock: 999,
        variants: [{ name: "Size", options: [{ name: "M", price: 500, mrp: 700, stock: 3 }] }],
      },
      user: { id: String(new mongoose.Types.ObjectId()), roles: ["admin"] },
    });
    ok("a conflicting product-level stock is overridden by the variant sum",
      restocked.statusCode === 200 && (await ProductModel.findById(product._id)).stock === 3,
      String((await ProductModel.findById(product._id)).stock));
    ok("  and the removed option is gone", (await ProductModel.findById(product._id)).variants.length === 1);

    // ── availability is now variant-bound end to end ────────────────────────
    const liveProduct = await ProductModel.findById(product._id);
    ok("availableStockFor reports the VARIANT stock",
      availableStockFor(liveProduct, variantKeyFrom({ Size: "M" })) === 3,
      String(availableStockFor(liveProduct, variantKeyFrom({ Size: "M" }))));
    ok("and a size that no longer exists does not borrow it",
      availableStockFor(liveProduct, variantKeyFrom({ Size: "L" })) === liveProduct.stock);

    // Restore the two-option state for the refusal cases below.
    await callProduct(productController.UpdateProduct, {
      params: { id: String(product._id) },
      body: { variants: ADMIN_OPTION_GROUP },
      user: { id: String(new mongoose.Types.ObjectId()), roles: ["admin"] },
    });

    // ── An option group WITHOUT stock is still refused ──────────────────────
    const beforeNoStock = await snapshotProduct(product._id);
    const noStock = await callProduct(productController.UpdateProduct, {
      params: { id: String(product._id) },
      body: { variants: [{ name: "Size", options: [{ name: "M", price: 500, mrp: 700 }] }] },
      user: { id: String(new mongoose.Types.ObjectId()), roles: ["admin"] },
    });
    ok("an option group with no per-option stock is refused", noStock.statusCode === 400,
      `${noStock.statusCode} ${noStock.body?.message}`);
    ok("with a code a client can branch on",
      noStock.body?.code === "UNSUPPORTED_VARIANT_FORMAT", noStock.body?.code);
    ok("naming the option and the missing field",
      /"M"/.test(noStock.body?.message || "") && /stock/.test(noStock.body?.message || ""),
      noStock.body?.message);
    ok("THE PRODUCT IS BYTE-IDENTICAL — expanding it with stock 0 would be silent failure",
      (await snapshotProduct(product._id)) === beforeNoStock);

    for (const [label, payload, pattern] of [
      ["two axes", [{ name: "Size", options: [{ name: "M", stock: 1 }] }, { name: "Colour", options: [{ name: "Red", stock: 1 }] }], /Only one option group/],
      ["a duplicate option", [{ name: "Size", options: [{ name: "M", stock: 1 }, { name: "M", stock: 2 }] }], /appears twice/],
      ["an unnamed group", [{ name: "", options: [{ name: "M", stock: 1 }] }], /needs a name/],
      ["an empty group", [{ name: "Size", options: [] }], /no options/],
      ["a fractional stock", [{ name: "Size", options: [{ name: "M", stock: 1.5 }] }], /whole, non-negative/],
      ["a negative stock", [{ name: "Size", options: [{ name: "M", stock: -1 }] }], /whole, non-negative/],
    ]) {
      const snapshot = await snapshotProduct(product._id);
      const response = await callProduct(productController.UpdateProduct, {
        params: { id: String(product._id) },
        body: { variants: payload },
        user: { id: String(new mongoose.Types.ObjectId()), roles: ["admin"] },
      });
      ok(`${label} is refused`, response.statusCode === 400,
        `${response.statusCode} ${response.body?.message}`);
      ok(`  explaining why`, pattern.test(response.body?.message || ""), response.body?.message);
      ok(`  and the product is untouched`, (await snapshotProduct(product._id)) === snapshot);
    }

    // Reset to no variants so the canonical section below starts clean.
    await callProduct(productController.UpdateProduct, {
      params: { id: String(product._id) },
      body: { stock: 12, variants: [] },
      user: { id: String(new mongoose.Types.ObjectId()), roles: ["admin"] },
    });
    const cleared = await ProductModel.findById(product._id);
    ok("an empty array clears the variants", cleared.variants.length === 0);
    ok("and product stock is editable again once they are gone", cleared.stock === 12,
      String(cleared.stock));

    // ── Test 3: the canonical payload still works, end to end ───────────────
    const canonical = [
      {
        name: "Red M", sku: "RED-M",
        attributes: { color: "red", size: "M" },
        price: 500, mrp: 700, stock: 5, reservedStock: 0, active: true,
      },
    ];
    const accepted = await callProduct(productController.UpdateProduct, {
      params: { id: String(product._id) },
      body: { variants: canonical },
      user: { id: String(new mongoose.Types.ObjectId()), roles: ["admin"] },
    });
    ok("a canonical per-combination payload is accepted", accepted.statusCode === 200,
      `${accepted.statusCode} ${accepted.body?.message}`);

    const saved = await ProductModel.findById(product._id);
    ok("the variant persists", saved.variants.length === 1, String(saved.variants.length));
    ok("its attributes persist", variantKeyOf(saved.variants[0]) === variantKeyFrom({ color: "red", size: "M" }),
      variantKeyOf(saved.variants[0]));
    ok("its price persists", saved.variants[0].price === 500, String(saved.variants[0].price));
    ok("its mrp persists", saved.variants[0].mrp === 700, String(saved.variants[0].mrp));
    ok("its stock persists", saved.variants[0].stock === 5, String(saved.variants[0].stock));
    ok("its sku persists", saved.variants[0].sku === "RED-M", saved.variants[0].sku);
    ok("and it is findable, so cart lines can match it",
      Boolean(findVariant(saved, variantKeyFrom({ color: "red", size: "M" }))));

    // ── Test 4: the other silent-loss paths, each refused ───────────────────
    const malformed = [
      ["an unparseable JSON string", "{not json", /valid JSON/],
      ["a non-array payload", { name: "Size" }, /must be an array/],
      ["a non-object variant", ["Size"], /not a variant object/],
      ["a variant with no name", [{ attributes: { size: "M" }, stock: 1 }], /needs a name/],
      ["a variant with no attributes and no sku", [{ name: "Mystery", stock: 3 }], /needs attributes/],
    ];
    for (const [label, payload, pattern] of malformed) {
      const before2 = await snapshotProduct(product._id);
      const response = await callProduct(productController.UpdateProduct, {
        params: { id: String(product._id) },
        body: { variants: payload },
        user: { id: String(new mongoose.Types.ObjectId()), roles: ["admin"] },
      });
      ok(`${label} is refused`, response.statusCode === 400,
        `${response.statusCode} ${response.body?.message}`);
      ok(`  with a message that explains why`, pattern.test(response.body?.message || ""),
        response.body?.message);
      ok(`  and the product is untouched`, (await snapshotProduct(product._id)) === before2);
    }

    // An unparseable string previously WIPED the existing variants — the product now
    // has a real variant, so this proves the destructive case specifically.
    const withVariant = await ProductModel.findById(product._id);
    ok("the product still holds its canonical variant after all refusals",
      withVariant.variants.length === 1, String(withVariant.variants.length));

    // ── Omission must still mean "leave variants alone" ─────────────────────
    // The price here only has to be a value that visibly changes, so that "the other field
    // was applied" is provable. It used to be 555 against this fixture's MRP of 500, which
    // UpdateProduct now refuses outright — price may not exceed MRP. 455 keeps the assertion
    // identical while describing a product that could actually exist.
    const noVariantField = await callProduct(productController.UpdateProduct, {
      params: { id: String(product._id) },
      body: { price: 455 },
      user: { id: String(new mongoose.Types.ObjectId()), roles: ["admin"] },
    });
    ok("omitting variants entirely is not an error", noVariantField.statusCode === 200,
      `${noVariantField.statusCode} ${noVariantField.body?.message}`);
    const afterOmit = await ProductModel.findById(product._id);
    ok("and leaves the existing variant in place", afterOmit.variants.length === 1);
    ok("while applying the other field", afterOmit.price === 455, String(afterOmit.price));

    // ── Creation is guarded too, before any document exists ─────────────────
    const countBefore = await ProductModel.countDocuments();
    const createRejected = await callProduct(productController.CreateProduct, {
      body: {
        name: `${MARKER}-create-reject`, price: 100, mrp: 120, stock: 5,
        brand: "T", producthightlight: "stub", description: "stub",
        category_id: String(new mongoose.Types.ObjectId()),
        variants: [{ name: "Size", options: [{ name: "M", price: 500, mrp: 700 }] }],
      },
      file: { filename: "stub.webp", path: "/tmp/stub.webp", mimetype: "image/webp" },
      user: { id: String(new mongoose.Types.ObjectId()), roles: ["admin"] },
    });
    ok("CreateProduct refuses an option group with no stock", createRejected.statusCode === 400,
      `${createRejected.statusCode} ${createRejected.body?.message}`);
    ok("  with the same code", createRejected.body?.code === "UNSUPPORTED_VARIANT_FORMAT",
      JSON.stringify(createRejected.body));
    ok("  and NO product was created", (await ProductModel.countDocuments()) === countBefore,
      `${await ProductModel.countDocuments()} vs ${countBefore}`);

    // ── The validator itself, at the boundary ───────────────────────────────
    ok("omitted / null / empty are accepted by the validator",
      [undefined, null, ""].every((v) => findUnsupportedVariantFormat(v) === null));
    ok("an empty array is accepted (clearing variants is legitimate)",
      findUnsupportedVariantFormat([]) === null);
    // Changed contract: a SKU alone is now REFUSED. findVariant resolves by
    // attribute key, and the storefront only ever produces attribute keys —
    // a sku-only variant could never be matched, so every sale of it
    // decremented product stock only, silently diverging the counters.
    ok("a variant identified by sku alone is refused (unmatchable by any client)",
      findUnsupportedVariantFormat([{ name: "Red M", sku: "RED-M" }]) !== null);
    // ── THE REAL WIRE FORMAT ────────────────────────────────────────────────
    // The admin routes are multipart (multer), so the browser sends `variants` as a
    // JSON STRING. This is the path that actually failed in production: productsSlice
    // never appended the field at all, so per-size stock was dropped in the browser
    // before the request was made — the backend never saw it.
    const wireProduct = await makeProduct("wire-format", { stock: 1 });
    const asJsonString = await callProduct(productController.UpdateProduct, {
      params: { id: String(wireProduct._id) },
      body: { variants: JSON.stringify(ADMIN_OPTION_GROUP) },
      user: { id: String(new mongoose.Types.ObjectId()), roles: ["admin"] },
    });
    ok("a JSON-STRINGIFIED option group is accepted — the multipart wire format",
      asJsonString.statusCode === 200, `${asJsonString.statusCode} ${asJsonString.body?.message}`);
    const fromWire = await ProductModel.findById(wireProduct._id);
    ok("it expands to one variant per option", fromWire.variants.length === 2,
      String(fromWire.variants.length));
    ok("with each stock intact over the wire",
      fromWire.variants.find((v) => v.name === "M")?.stock === 12 &&
        fromWire.variants.find((v) => v.name === "L")?.stock === 4,
      JSON.stringify(fromWire.variants.map((v) => [v.name, v.stock])));
    ok("and product.stock derived from them", fromWire.stock === 16, String(fromWire.stock));
    ok("resolvable by a storefront selection",
      findVariant(fromWire, variantKeyFrom({ Size: "M" }))?.stock === 12);

    // ── The frontend must actually send the field ───────────────────────────
    const slice = await readFile(
      new URL("../../../kitab-shop-fe/src/store/productsSlice.js", import.meta.url),
      "utf8",
    );
    const appends = (slice.match(/body\.append\("variants"/g) || []).length;
    ok("productsSlice sends variants on BOTH create and update — the missing append",
      appends === 2, `${appends} append(s)`);
    ok("as JSON, matching the multipart contract the backend parses",
      /body\.append\("variants",\s*JSON\.stringify/.test(slice));
    ok("update only sends them when the patch touched them",
      /if \(patch\.variants !== undefined\)/.test(slice));
    ok("and the read path uses the backend's real variants, not a fabrication from `size`",
      /const backendVariants = Array\.isArray\(p\.variants\)/.test(slice));
    ok("falling back to the size list only when there are none",
      /backendVariants\.length > 0/.test(slice));

    // ── SIZE LABELS ARE INDEPENDENT OF THE VARIANTS PAYLOAD ─────────────────
    // productsSlice used to rebuild the `size` string FROM `variants`. Once variants
    // became conditional (per-size stock is opt-in) that derivation fell through to
    // "Standard", so saving a product quietly replaced its whole size list.
    ok("the admin sends the size labels explicitly",
      /size: \(form\.variantOptions \|\| \[\]\)\s*\.map\(\(opt\) => opt\.name\)/.test(
        await readFile(new URL("../../../kitab-shop-fe/src/pages/admin/AdminProducts.jsx", import.meta.url), "utf8"),
      ));
    ok("and the slice prefers that explicit value over deriving it from variants",
      /typeof productData\.size === "string" && productData\.size\.trim\(\)/.test(slice));
    ok("only sending size on update when the patch carried it",
      /if \(sizeValue !== null\) body\.append\("size", sizeValue\)/.test(slice));
    // On UPDATE the fallback is null (send nothing) rather than "Standard" — that
    // substitution is what shrank the list. Create still defaults a brand-new product
    // to "Standard", which is correct and deliberately left alone.
    const updateThunk = slice.slice(slice.indexOf("export const updateProduct"));
    ok("on update the size fallback is null, never \"Standard\"",
      /:\s*null;/.test(updateThunk.slice(0, updateThunk.indexOf('body.append("size"'))) &&
        !/"Standard"/.test(updateThunk.slice(0, updateThunk.indexOf('body.append("size"'))),
      "update still substitutes Standard");

    // The backend keeps `size` and `variants` as separate fields, which is what makes
    // that separation possible at all.
    const labelsOnly = await callProduct(productController.UpdateProduct, {
      params: { id: String(wireProduct._id) },
      body: { size: "M, L, XL" },
      user: { id: String(new mongoose.Types.ObjectId()), roles: ["admin"] },
    });
    ok("updating size labels alone succeeds", labelsOnly.statusCode === 200,
      `${labelsOnly.statusCode} ${labelsOnly.body?.message}`);
    const afterLabels = await ProductModel.findById(wireProduct._id);
    ok("the labels are stored", afterLabels.size === "M, L, XL", String(afterLabels.size));
    ok("and the variants are untouched by a label-only edit",
      afterLabels.variants.length === 2, String(afterLabels.variants.length));
    ok("with their stock intact",
      afterLabels.variants.find((v) => v.name === "M")?.stock === 12);

    // ── A variant-stocked product refuses a direct total ────────────────────
    const totalWrite = await callProduct(productController.UpdateProduct, {
      params: { id: String(wireProduct._id) },
      body: { stock: 500 },
      user: { id: String(new mongoose.Types.ObjectId()), roles: ["admin"] },
    });
    ok("setting the product total directly is refused when variants own it",
      totalWrite.statusCode === 409, `${totalWrite.statusCode} ${totalWrite.body?.message}`);
    ok("  with a code a client can branch on",
      totalWrite.body?.code === "STOCK_IS_VARIANT_MANAGED", totalWrite.body?.code);
    ok("  and the derived total is unchanged",
      (await ProductModel.findById(wireProduct._id)).stock === 16,
      String((await ProductModel.findById(wireProduct._id)).stock));
    ok("  it is NOT silently ignored with a 200 — the failure is visible",
      totalWrite.statusCode !== 200);

    // But the same request WITH variants is fine: the sum comes from them.
    const withVariants = await callProduct(productController.UpdateProduct, {
      params: { id: String(wireProduct._id) },
      body: { stock: 500, variants: [{ name: "Size", options: [{ name: "M", price: 500, mrp: 700, stock: 9 }] }] },
      user: { id: String(new mongoose.Types.ObjectId()), roles: ["admin"] },
    });
    ok("supplying stock alongside new variants is allowed", withVariants.statusCode === 200,
      `${withVariants.statusCode} ${withVariants.body?.message}`);
    ok("and the total is the variant sum, not the 500 sent",
      (await ProductModel.findById(wireProduct._id)).stock === 9,
      String((await ProductModel.findById(wireProduct._id)).stock));

    // A product with no variants still takes a direct total, as before.
    const plainProduct = await makeProduct("plain-stock", { stock: 4 });
    const plainWrite = await callProduct(productController.UpdateProduct, {
      params: { id: String(plainProduct._id) },
      body: { stock: 25 },
      user: { id: String(new mongoose.Types.ObjectId()), roles: ["admin"] },
    });
    ok("a product without variants still accepts a direct stock edit",
      plainWrite.statusCode === 200 && (await ProductModel.findById(plainProduct._id)).stock === 25,
      String((await ProductModel.findById(plainProduct._id)).stock));

    ok("a well-formed option group is accepted by the validator",
      findUnsupportedVariantFormat(ADMIN_OPTION_GROUP) === null,
      String(findUnsupportedVariantFormat(ADMIN_OPTION_GROUP)));
    ok("but a mix of a canonical variant and an option group is refused — that is neither shape",
      Boolean(findUnsupportedVariantFormat([canonical[0], ADMIN_OPTION_GROUP[0]])));
  }
} catch (error) {
  console.error(`\nSUITE ABORTED: ${error?.stack || error}`);
  ok("suite ran to completion", false, error?.message);
} finally {
  await ProductModel.deleteMany({ _id: { $in: trash.products } });
  await cartModel.deleteMany({ _id: { $in: trash.carts } });
  const { failed } = finish();
  await mongoose.disconnect();
  process.exit(failed ? 1 : 0);
}
