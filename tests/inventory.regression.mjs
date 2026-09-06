/**
 * Inventory regression: variant-level stock, restock on return/RTO, and
 * reservation atomicity.
 *
 * Covers audit items H-04, H-09, H-10, H-11, H-12.
 * Run with `npm run test:inventory` (or `npm test` for everything).
 */
import mongoose from "mongoose";
import { readFile } from "node:fs/promises";
import {
  addressFixture,
  connect,
  createSuite,
  marker,
  productFixture,
} from "./helpers.mjs";

const { ok, section, finish } = createSuite("inventory");
await connect();

const OrderModel = (await import("../src/modules/orders/Order.model.js")).default;
const ProductModel = (await import("../src/modules/products/Product.model.js")).default;
const ReturnModel = (await import("../src/modules/returns/return.model.js")).default;
const StockReservation = (await import("../src/model/StockReservation.model.js")).default;
const { restockReturnedItems, restockRtoOrder } = await import(
  "../src/modules/inventory/restock.service.js"
);
const {
  availableStockFor,
  decrementStock,
  findVariant,
  getVariantKey,
  incrementStock,
  resolveVariantId,
  variantKeyOf,
} = await import("../src/modules/inventory/variant.service.js");
const { releaseReservation, reserveStockForIntent } = await import(
  "../src/modules/inventory/inventory-reservation.service.js"
);
const { isStockEnforced } = await import("../src/config/features.config.js");

const MARKER = marker("inv");
const trash = { orders: [], products: [], returns: [] };
let seq = 0;

const makeProduct = async (overrides = {}) => {
  seq += 1;
  const product = await ProductModel.create(
    productFixture(`${MARKER} product ${seq}`, overrides),
  );
  trash.products.push(product._id);
  return product;
};

const makeOrder = async (fields = {}) => {
  seq += 1;
  const order = await OrderModel.create({
    user: new mongoose.Types.ObjectId(),
    items: [
      { product: new mongoose.Types.ObjectId(), name: `${MARKER} line`, price: 500, quantity: 1 },
    ],
    shippingAddress: addressFixture(),
    paymentMethod: "RAZORPAY",
    razorpayPaymentId: `pay_${MARKER}_${seq}`,
    subtotal: 500,
    totalAmount: 500,
    ...fields,
  });
  trash.orders.push(order._id);
  return order;
};

try {
  if (!isStockEnforced()) {
    console.log(
      "\nNOTE: stock enforcement is OFF in this environment (STOCK_ENFORCED). " +
        "Restock assertions verify the no-op path; the variant assertions still run in full.",
    );
  }

  // ═══ H-12: variant stock is actually read and written ══════════════════════
  section("Variant-level stock is enforced (H-12)");

  const catalogue = await makeProduct({
    stock: 10,
    variants: [
      { name: "Red", attributes: { colour: "Red" }, stock: 10, active: true },
      { name: "Blue", attributes: { colour: "Blue" }, stock: 0, active: true },
    ],
  });
  const redKey = getVariantKey({ colour: "Red" });
  const blueKey = getVariantKey({ colour: "Blue" });

  ok("a product variant derives the same key an order line stores", variantKeyOf(catalogue.variants[0]) === redKey);
  ok("attribute order does not change the key", getVariantKey({ b: "2", a: "1" }) === getVariantKey({ a: "1", b: "2" }));
  ok("findVariant resolves a known key", findVariant(catalogue, redKey)?.name === "Red");
  ok("findVariant returns null for an unknown key", findVariant(catalogue, "colour:Pink") === null);
  ok(
    "availableStockFor reports the VARIANT's stock, not the product total",
    availableStockFor(catalogue, blueKey) === 0,
    String(availableStockFor(catalogue, blueKey)),
  );
  ok("with no variant key it falls back to the product total", availableStockFor(catalogue, "") === 10);
  ok(
    "a product with no variants at all falls back to the product total",
    availableStockFor({ stock: 7, variants: [] }, "size:L") === 7,
  );

  const redId = await resolveVariantId(catalogue._id, redKey);
  const blueId = await resolveVariantId(catalogue._id, blueKey);
  ok("resolveVariantId finds a variant _id", Boolean(redId) && Boolean(blueId));
  ok("resolveVariantId returns null for an empty key", (await resolveVariantId(catalogue._id, "")) === null);

  ok(
    "selling a SOLD-OUT variant of an in-stock product is refused",
    (await decrementStock({ productId: catalogue._id, quantity: 1, variantId: blueId })) === false,
  );
  let after = await ProductModel.findById(catalogue._id);
  ok("the refused sale left the product total untouched", after.stock === 10, String(after.stock));

  ok(
    "selling an in-stock variant succeeds",
    (await decrementStock({ productId: catalogue._id, quantity: 3, variantId: redId })) === true,
  );
  after = await ProductModel.findById(catalogue._id);
  ok("the product total dropped by 3", after.stock === 7, String(after.stock));
  ok("the Red variant dropped by 3", findVariant(after, redKey).stock === 7);
  ok("the Blue variant was not touched", findVariant(after, blueKey).stock === 0);
  ok(
    "over-ordering a variant is refused even when the product total allows it",
    (await decrementStock({ productId: catalogue._id, quantity: 8, variantId: redId })) === false,
  );

  await incrementStock({ productId: catalogue._id, quantity: 3, variantId: redId });
  after = await ProductModel.findById(catalogue._id);
  ok("restocking restores both counters", after.stock === 10 && findVariant(after, redKey).stock === 10);

  await incrementStock({
    productId: catalogue._id,
    quantity: 2,
    variantId: new mongoose.Types.ObjectId(),
  });
  after = await ProductModel.findById(catalogue._id);
  ok(
    "units from a since-deleted variant fall back to the product pool, not written off",
    after.stock === 12,
    String(after.stock),
  );

  const plain = await makeProduct({ stock: 4, variants: [] });
  ok(
    "a variant-less product still refuses an over-order",
    (await decrementStock({ productId: plain._id, quantity: 5, variantId: null })) === false,
  );
  ok(
    "and still sells within stock",
    (await decrementStock({ productId: plain._id, quantity: 4, variantId: null })) === true,
  );
  ok("reaching zero is allowed; going below is not", (await ProductModel.findById(plain._id)).stock === 0);

  // Every stock write must go through the shared helper, or a future variant
  // product silently regresses.
  const stockWriters = [
    "src/modules/orders/order.controller.js",
    "src/modules/payments/payment-order.service.js",
    "src/modules/inventory/inventory-reservation.service.js",
    "src/modules/inventory/stock-reservation-cleanup.service.js",
    "src/modules/inventory/restock.service.js",
  ];
  const rawWrites = [];
  for (const file of stockWriters) {
    const source = await readFile(file, "utf8");
    if (/\$inc:\s*\{\s*stock:/.test(source) || /stock:\s*\{\s*\$gte:/.test(source)) {
      rawWrites.push(file);
    }
  }
  ok(
    "no order path writes product.stock directly any more",
    rawWrites.length === 0,
    rawWrites.join(", "),
  );

  // ═══ H-04: returned and RTO goods go back on sale ══════════════════════════
  section("Physically-returned goods are restocked (H-04)");

  const returnedProduct = await makeProduct({ stock: 5 });
  const returnedOrder = await makeOrder({
    items: [{ product: returnedProduct._id, name: returnedProduct.name, price: 500, quantity: 2 }],
    orderStatus: "Delivered",
  });
  const returnRequest = await ReturnModel.create({
    order: returnedOrder._id,
    user: returnedOrder.user,
    product: returnedProduct._id,
    productSnapshot: { name: returnedProduct.name, price: 500 },
    quantity: 2,
    reason: "wrong size",
    refundAmount: 1000,
    resolutionType: "refund",
    status: "received",
    // Restock follows the DISPOSITION, not the resolution — a refunded return whose
    // goods came back damaged is written off. Stated explicitly here because there
    // is deliberately no default.
    disposition: "resellable",
  });
  trash.returns.push(returnRequest._id);

  const restocked = await restockReturnedItems({ returnRequest });
  if (isStockEnforced()) {
    ok("a resellable return restocks the returned quantity", restocked === 2, String(restocked));
    ok("stock went 5 → 7", (await ProductModel.findById(returnedProduct._id)).stock === 7);
    ok("the return is stamped restockedAt", Boolean((await ReturnModel.findById(returnRequest._id)).restockedAt));
    ok("a second status update restocks nothing", (await restockReturnedItems({ returnRequest })) === 0);
    ok("stock stayed at 7", (await ProductModel.findById(returnedProduct._id)).stock === 7);
    const concurrent = await Promise.all(
      Array.from({ length: 4 }, () =>
        restockReturnedItems({
          returnRequest: { ...returnRequest.toObject(), restockedAt: undefined },
        }),
      ),
    );
    ok("4 concurrent attempts all lose to the existing claim", concurrent.every((n) => n === 0));
  } else {
    ok("restock is a no-op while stock enforcement is off", restocked === 0);
  }

  const rtoProduct = await makeProduct({ stock: 1 });
  const rtoOrder = await makeOrder({
    items: [
      {
        product: rtoProduct._id,
        name: rtoProduct.name,
        price: 500,
        quantity: 3,
        cancelledQuantity: 1,
      },
    ],
    orderStatus: "RTO",
  });
  // An RTO parcel is inspected on arrival too; "resellable" is what releases it.
  const rtoRestocked = await restockRtoOrder({
    orderId: rtoOrder._id,
    disposition: "resellable",
  });
  if (isStockEnforced()) {
    ok("RTO restocks 2, excluding the unit already cancelled", rtoRestocked === 2, String(rtoRestocked));
    ok("stock went 1 → 3", (await ProductModel.findById(rtoProduct._id)).stock === 3);
    const retries = await Promise.all(
      Array.from({ length: 4 }, () =>
        restockRtoOrder({ orderId: rtoOrder._id, disposition: "resellable" }),
      ),
    );
    ok("Shiprocket webhook retries restock nothing further", retries.every((n) => n === 0));
    ok("stock stayed at 3", (await ProductModel.findById(rtoProduct._id)).stock === 3);
  } else {
    ok("RTO restock is a no-op while stock enforcement is off", rtoRestocked === 0);
  }

  // The rule the disposition split introduced: goods the customer is rightly
  // refunded for are NOT automatically resellable.
  const damagedReturn = await ReturnModel.create({
    order: returnedOrder._id,
    user: new mongoose.Types.ObjectId(),
    product: returnedProduct._id,
    productSnapshot: { name: returnedProduct.name, price: 500 },
    quantity: 2,
    reason: "arrived faulty",
    refundAmount: 1000,
    resolutionType: "refund",
    status: "received",
    disposition: "damaged",
  });
  trash.returns.push(damagedReturn._id);
  const stockBeforeDamaged = (await ProductModel.findById(returnedProduct._id)).stock;
  ok(
    "a DAMAGED return restocks nothing, even though the customer is refunded",
    (await restockReturnedItems({ returnRequest: damagedReturn })) === 0,
  );
  ok(
    "the faulty unit never reaches the shelf",
    (await ProductModel.findById(returnedProduct._id)).stock === stockBeforeDamaged,
  );

  // Behavioural, not a source-text match. This used to grep for the literal
  // `statusCode === 43` — which pinned a bug in place: 43 is SELF FULFILLED in
  // Shiprocket's list, and RTO DELIVERED is 10. Correcting the code therefore
  // broke the assertion, which is backwards. It now exercises the function.
  const { isRtoReceived, mapOrderStatus } = await import(
    "../src/modules/shipping/shipping.controller.js"
  );
  ok(
    "RTO DELIVERED (10) counts as the parcel being physically back",
    isRtoReceived(10, "") === true,
  );
  ok(
    "RTO initiated (9) does not — restocking a parcel still on a truck is wrong",
    isRtoReceived(9, "") === false,
  );
  ok(
    "SELF FULFILLED (43) is not mistaken for a returned parcel",
    isRtoReceived(43, "") === false,
  );
  ok(
    "a courier sending readable text instead of a code still resolves",
    isRtoReceived(0, "RTO Delivered") === true,
  );
  ok(
    "the arrival maps to RTO Received, distinct from in-transit RTO",
    mapOrderStatus(10, "") === "RTO Received" && mapOrderStatus(9, "") === "RTO",
  );

  // ═══ H-10 / H-11: reservation atomicity ═══════════════════════════════════
  section("Stock reservations are atomic (H-10, H-11)");

  const heldProduct = await makeProduct({ stock: 5 });
  const intentId = new mongoose.Types.ObjectId();
  const reservation = await reserveStockForIntent({
    userId: new mongoose.Types.ObjectId(),
    paymentIntentId: intentId,
    idempotencyKey: `${MARKER}-hold`,
    items: [{ product: heldProduct._id, name: heldProduct.name, quantity: 2, variantKey: "" }],
  });
  ok("a reservation row exists", Boolean(reservation?._id));
  ok(
    "and records exactly what was taken",
    reservation.items.length === 1 && reservation.items[0].quantity === 2,
  );
  ok("stock was held (5 → 3)", (await ProductModel.findById(heldProduct._id)).stock === 3);

  // H-11: a mid-loop failure must not deduct stock with no record of it.
  const plentiful = await makeProduct({ stock: 10 });
  const scarce = await makeProduct({ stock: 1 });
  let reserveError = null;
  try {
    await reserveStockForIntent({
      userId: new mongoose.Types.ObjectId(),
      paymentIntentId: new mongoose.Types.ObjectId(),
      idempotencyKey: `${MARKER}-fail`,
      items: [
        { product: plentiful._id, name: plentiful.name, quantity: 4, variantKey: "" },
        { product: scarce._id, name: scarce.name, quantity: 5, variantKey: "" },
      ],
    });
  } catch (error) {
    reserveError = error;
  }
  ok("a partly-unfulfillable reservation is rejected with 409", reserveError?.statusCode === 409);
  ok(
    "the line that DID succeed was rolled back (10, not 6)",
    (await ProductModel.findById(plentiful._id)).stock === 10,
    String((await ProductModel.findById(plentiful._id)).stock),
  );
  ok(
    "the failed row is marked released, not left dangling as active",
    (await StockReservation.findOne({ idempotencyKey: `${MARKER}-fail` }))?.status === "released",
  );

  // H-10: concurrent releases must restock exactly once.
  const releases = await Promise.all(
    Array.from({ length: 4 }, () => releaseReservation({ paymentIntentId: intentId, reason: "test" })),
  );
  ok("4 concurrent releases: exactly 1 wins", releases.filter(Boolean).length === 1);
  ok(
    "stock returned to 5 exactly once (not 7, 9 or 11)",
    (await ProductModel.findById(heldProduct._id)).stock === 5,
    String((await ProductModel.findById(heldProduct._id)).stock),
  );
  ok("releasing an already-released reservation returns null", (await releaseReservation({ paymentIntentId: intentId })) === null);

  // ═══ H-09: the commit result is not discarded ══════════════════════════════
  section("A paid order cannot outlive its stock reservation (H-09)");
  const captureSource = await readFile("src/modules/payments/payment-order.service.js", "utf8");
  ok(
    "the reservation is read inside the transaction session",
    /findActiveReservationForIntent\(\s*\n?\s*currentIntent\._id,\s*\n?\s*session/.test(captureSource),
  );
  ok(
    "commitReservation's result is checked, not discarded",
    /const committed = await commitReservation/.test(captureSource) && /if \(!committed\)/.test(captureSource),
  );
} finally {
  await Promise.all([
    OrderModel.deleteMany({ _id: { $in: trash.orders } }),
    ProductModel.deleteMany({ _id: { $in: trash.products } }),
    ReturnModel.deleteMany({ _id: { $in: trash.returns } }),
    StockReservation.deleteMany({ idempotencyKey: new RegExp(`^${MARKER}`) }),
  ]);
  await mongoose.disconnect();
}

const { failed } = finish();
process.exit(failed > 0 ? 1 : 0);
