/**
 * Partial cancellation: when it is allowed, and what happens when it empties the
 * order (S1 + G4).
 *
 * S1 — a line could be cancelled after the parcel already existed. Shiprocket's
 * payload is fixed at creation and /orders/cancel cancels a whole order, so the
 * cancelled unit still shipped (and, on COD, was still collected for) while the
 * customer was refunded for it. Partial cancellation is now refused once a
 * shipment exists — a live Shiprocket order, a creation claim in flight, or a
 * manually recorded tracking number — and outside Confirmed/Packed, and while a
 * prepaid order is still awaiting capture.
 *
 * G4 — cancelling the last remaining unit set orderStatus "Cancelled" by plain
 * assignment, outside the transition table: no history entry, no cancellation
 * record, no coupon release, no customer notification. That request is now
 * DELEGATED to the full-cancellation core, which does all of it under its atomic
 * claim and still writes the cancellations[] record and the partial-cancel refund
 * key this path has always used.
 *
 * Run with `npm run test:partial-cancel-guard` (or `npm test` for everything).
 *
 * Controllers are called directly. `globalThis.fetch` is stubbed at the Shiprocket
 * HTTP boundary and throws on any URL it does not expect; the Razorpay SDK is
 * stubbed on its cached instance. Nothing leaves the machine.
 */
process.env.SHIPROCKET_ENABLED = "true";
process.env.SHIPROCKET_EMAIL = "stub@example.test";
process.env.SHIPROCKET_PASSWORD = "stub-password";
process.env.SHIPROCKET_BASE_URL = "https://shiprocket.invalid/v1/external";
process.env.INVENTORY_ENFORCE_STOCK = "true";
process.env.NOTIFICATIONS_ENABLED = "false";
process.env.PAYMENTS_ENABLED = "true";
process.env.PAYMENT_PROVIDER = "razorpay";
process.env.RAZORPAY_KEY_ID = "rzp_test_stub0000000";
process.env.RAZORPAY_KEY_SECRET = "stub_secret_for_tests";

import mongoose from "mongoose";
import {
  connect,
  createSuite,
  marker,
  productFixture,
  addressFixture,
  pinShiprocketCapabilities,
} from "./helpers.mjs";

const { ok, section, finish } = createSuite("partial-cancel-guard");
await connect();
// Pinned: the emptying case asserts the courier IS told, which an admin choosing
// manual fulfilment would correctly prevent.
const restoreCapabilities = await pinShiprocketCapabilities();

const OrderModel = (await import("../../src/modules/orders/Order.model.js")).default;
const ProductModel = (await import("../../src/modules/products/Product.model.js")).default;
const CouponModel = (await import("../../src/modules/coupons/coupon.model.js")).default;
const CouponRedemption = (await import("../../src/modules/coupons/coupon-redemption.model.js")).default;
const UserProfile = (await import("../../src/modules/profiles/UserProfile.model.js")).default;
const NotificationEvent = (await import("../../src/model/NotificationEvent.model.js")).default;
await import("../../src/modules/categories/Category.model.js");
const orderController = await import("../../src/modules/orders/order.controller.js");
const { sumRefunded } = await import("../../src/modules/payments/return-refund.service.js");
const razorpayService = await import("../../src/modules/payments/razorpay.service.js");

await OrderModel.init();

// ── Razorpay stub ───────────────────────────────────────────────────────────
const razorpayCalls = { refund: [] };
const { razorpay: sharedRazorpay } = razorpayService.getRazorpay();
let refundSeq = 0;
sharedRazorpay.payments.refund = async (paymentId, options) => {
  razorpayCalls.refund.push({ paymentId, options });
  return { id: `rfnd_pcg_${process.pid}_${++refundSeq}`, status: "processed" };
};
sharedRazorpay.payments.fetchMultipleRefund = async () => ({ items: [] });

// ── Shiprocket stub, at the HTTP boundary ──────────────────────────────────
const courier = { cancelCalls: [] };
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = String(input instanceof URL ? input.href : input);
  if (url.includes("/auth/login")) {
    return new Response(JSON.stringify({ token: "stub-token" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (url.includes("/orders/cancel")) {
    courier.cancelCalls.push(JSON.parse(init.body || "{}").ids || []);
    return new Response(JSON.stringify({ status: 200, message: "Order cancelled successfully" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  throw new Error(`Unexpected outbound call in tests: ${url}`);
};

const resetStubs = () => {
  courier.cancelCalls = [];
  razorpayCalls.refund = [];
};

const MARKER = marker("pcguard");
const trash = { orders: [], products: [], coupons: [], profiles: [] };
let seq = 0;

const makeProduct = async (label, stock = 20) => {
  const product = await ProductModel.create(productFixture(`${MARKER}-${label}`, { stock }));
  trash.products.push(product._id);
  return product;
};

const makeOrder = async ({
  product,
  quantity = 2,
  orderStatus = "Confirmed",
  paymentMethod = "RAZORPAY",
  paymentStatus = "Paid",
  srOrderId = null,
  syncStatus = null,
  trackingNumber = "",
  userId = new mongoose.Types.ObjectId(),
  ...fields
}) => {
  seq += 1;
  const subtotal = product.price * quantity;
  const order = await OrderModel.create({
    user: userId,
    items: [
      { product: product._id, name: product.name, image: "x.png", price: product.price, quantity },
    ],
    shippingAddress: addressFixture(),
    paymentMethod,
    paymentStatus,
    orderStatus,
    subtotal,
    totalAmount: subtotal,
    ...(paymentMethod === "RAZORPAY" && paymentStatus !== "Pending"
      ? { razorpayPaymentId: `pay_${MARKER}_${seq}` }
      : {}),
    ...(srOrderId
      ? {
          shiprocket: {
            orderId: srOrderId,
            shipmentId: srOrderId + 100000,
            status: "NEW",
            syncStatus: syncStatus || "created",
          },
        }
      : {}),
    ...(trackingNumber
      ? { shipment: { provider: "MANUAL", carrierName: "India Post", trackingNumber, status: orderStatus } }
      : {}),
    ...fields,
  });
  trash.orders.push(order._id);
  return order;
};

const callController = async (handler, { params = {}, body = {}, user }) => {
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
  await handler({ params, body, user, query: {}, headers: {} }, res);
  return { statusCode, body: payload };
};

const admin = () => ({ id: String(new mongoose.Types.ObjectId()), roles: ["admin"] });

const partialCancel = (order, productId, quantity, reason = "Damaged in store") =>
  callController(orderController.PartialCancelOrder, {
    params: { orderId: String(order._id) },
    body: { productId: String(productId), quantity, reason },
    user: admin(),
  });

const stockOf = async (id) => (await ProductModel.findById(id)).stock;
const fresh = (id) => OrderModel.findById(id);

/** Asserts a refused request left the order exactly as it was. */
const assertUntouched = async (label, order, product, stockBefore) => {
  const after = await fresh(order._id);
  ok(`${label}: no unit was cancelled`, (after.items[0].cancelledQuantity || 0) === 0,
    String(after.items[0].cancelledQuantity));
  ok(`${label}: no cancellation record`, after.cancellations.length === 0);
  ok(`${label}: no refund row`, after.refunds.length === 0, String(after.refunds.length));
  ok(`${label}: status unchanged`, after.orderStatus === order.orderStatus, after.orderStatus);
  ok(`${label}: stock untouched`, (await stockOf(product._id)) === stockBefore,
    `${await stockOf(product._id)} vs ${stockBefore}`);
};

try {
  // ═══════════════════════════════════════════════════════════════════════════
  section("1 — refused once a shipment exists (S1)");

  {
    resetStubs();
    const product = await makeProduct("sr-live");
    const order = await makeOrder({ product, quantity: 3, srOrderId: 7700000 + process.pid % 10000 * 10 + 1 });
    const response = await partialCancel(order, product._id, 1);
    ok(
      "a live Shiprocket order → 409 PARTIAL_CANCEL_SHIPMENT_EXISTS",
      response.statusCode === 409 && response.body?.code === "PARTIAL_CANCEL_SHIPMENT_EXISTS",
      `${response.statusCode} ${response.body?.code}`,
    );
    ok(
      "  the message names both remedies",
      /cancel the whole order/i.test(response.body?.message || "") && /Returns/.test(response.body?.message || ""),
      response.body?.message,
    );
    await assertUntouched("live Shiprocket order", order, product, 20);
    ok("  the courier was not contacted", courier.cancelCalls.length === 0);
    ok("  no gateway refund", razorpayCalls.refund.length === 0);
  }

  {
    resetStubs();
    const product = await makeProduct("creating");
    const order = await makeOrder({ product, quantity: 3 });
    // Written straight to the collection: the `creating` claim value belongs to the
    // forward-create service, and this suite must not depend on whether the model
    // enum in this working tree has caught up with it yet.
    await OrderModel.collection.updateOne(
      { _id: order._id },
      { $set: { "shiprocket.syncStatus": "creating", "shiprocket.claimedAt": new Date() } },
    );
    const response = await partialCancel(order, product._id, 1);
    ok(
      "a creation claim in flight (syncStatus creating, no Shiprocket id yet) → 409",
      response.statusCode === 409 && response.body?.code === "PARTIAL_CANCEL_SHIPMENT_EXISTS",
      `${response.statusCode} ${response.body?.code}`,
    );
    await assertUntouched("creating claim", order, product, 20);
  }

  {
    resetStubs();
    const product = await makeProduct("manual");
    const order = await makeOrder({ product, quantity: 3, trackingNumber: `EM${seq}IN` });
    const response = await partialCancel(order, product._id, 1);
    ok(
      "a manually recorded tracking number → 409",
      response.statusCode === 409 && response.body?.code === "PARTIAL_CANCEL_SHIPMENT_EXISTS",
      `${response.statusCode} ${response.body?.code}`,
    );
    await assertUntouched("manual tracking", order, product, 20);
  }

  {
    resetStubs();
    const product = await makeProduct("packed-sr");
    const order = await makeOrder({
      product,
      quantity: 3,
      orderStatus: "Packed",
      srOrderId: 7700000 + process.pid % 10000 * 10 + 2,
      syncStatus: "awb_assigned",
    });
    const response = await partialCancel(order, product._id, 1);
    ok(
      "Packed with an AWB assigned → 409 as well",
      response.statusCode === 409 && response.body?.code === "PARTIAL_CANCEL_SHIPMENT_EXISTS",
      `${response.statusCode} ${response.body?.code}`,
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("2 — refused outside Confirmed/Packed, and while awaiting payment");

  for (const status of ["Shipped", "Out For Delivery", "Delivered", "RTO", "Cancelled"]) {
    resetStubs();
    const product = await makeProduct(`status-${status}`);
    const order = await makeOrder({ product, quantity: 3, orderStatus: status });
    const response = await partialCancel(order, product._id, 1);
    ok(
      `"${status}" → 409 PARTIAL_CANCEL_NOT_ALLOWED`,
      response.statusCode === 409 && response.body?.code === "PARTIAL_CANCEL_NOT_ALLOWED",
      `${response.statusCode} ${response.body?.code}`,
    );
    await assertUntouched(status, order, product, 20);
  }

  {
    resetStubs();
    const product = await makeProduct("awaiting");
    const order = await makeOrder({
      product,
      quantity: 3,
      orderStatus: "Pending",
      paymentMethod: "RAZORPAY",
      paymentStatus: "Pending",
      razorpayOrderId: `order_${MARKER}_awaiting`,
    });
    const response = await partialCancel(order, product._id, 1);
    ok(
      "an unpaid prepaid checkout → 409 PAYMENT_NOT_CAPTURED",
      response.statusCode === 409 && response.body?.code === "PAYMENT_NOT_CAPTURED",
      `${response.statusCode} ${response.body?.code}`,
    );
    await assertUntouched("awaiting payment", order, product, 20);
  }

  {
    // Awaiting payment is checked BEFORE the emptying delegation, so a request for
    // every unit is refused too — a full cancel of an unpaid checkout is the
    // customer's or admin's Cancel Order, not this endpoint.
    resetStubs();
    const product = await makeProduct("awaiting-all");
    const order = await makeOrder({
      product,
      quantity: 1,
      orderStatus: "Pending",
      paymentStatus: "Pending",
      razorpayOrderId: `order_${MARKER}_awaiting_all`,
    });
    const response = await partialCancel(order, product._id, 1);
    ok(
      "  even when the request would empty it",
      response.statusCode === 409 && response.body?.code === "PAYMENT_NOT_CAPTURED",
      `${response.statusCode} ${response.body?.code}`,
    );
    ok("  and it stays Pending", (await fresh(order._id)).orderStatus === "Pending");
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("3 — allowed before any shipment exists");

  for (const orderStatus of ["Confirmed", "Packed"]) {
    resetStubs();
    const product = await makeProduct(`allowed-${orderStatus}`);
    const order = await makeOrder({ product, quantity: 3, orderStatus });
    const response = await partialCancel(order, product._id, 1);
    ok(`${orderStatus}, no shipment → 200`, response.statusCode === 200,
      `${response.statusCode} ${response.body?.code || ""} ${response.body?.message || ""}`);
    ok("  orderFullyCancelled is false", response.body?.orderFullyCancelled === false);
    ok("  nothing is reported pending at the courier", response.body?.shipmentCancellationPending === false);

    const after = await fresh(order._id);
    ok("  the order stays live", after.orderStatus === orderStatus, after.orderStatus);
    ok("  one unit is cancelled", after.items[0].cancelledQuantity === 1, String(after.items[0].cancelledQuantity));
    ok("  one cancellation record", after.cancellations.length === 1);
    ok("  one refund row under its partial-cancel key",
      after.refunds.length === 1 &&
        after.refunds[0].idempotencyKey === `partial-cancel:${after.cancellations[0]._id}`,
      JSON.stringify(after.refunds.map((r) => r.idempotencyKey)));
    ok("  paid once through the gateway", razorpayCalls.refund.length === 1, `${razorpayCalls.refund.length}x`);
    ok("  one unit restocked", (await stockOf(product._id)) === 21, String(await stockOf(product._id)));
    ok("  the courier was not contacted", courier.cancelCalls.length === 0);
  }

  {
    // A Shiprocket order that has itself been cancelled is not an active shipment.
    resetStubs();
    const product = await makeProduct("sr-cancelled");
    const order = await makeOrder({
      product,
      quantity: 3,
      srOrderId: 7700000 + process.pid % 10000 * 10 + 3,
      syncStatus: "cancelled",
    });
    const response = await partialCancel(order, product._id, 1);
    ok("a CANCELLED Shiprocket order does not block a partial cancellation",
      response.statusCode === 200, `${response.statusCode} ${response.body?.code || ""}`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("4 — emptying the order is delegated to the full cancellation (G4)");

  {
    resetStubs();
    const product = await makeProduct("empty-sr", 20);
    const userId = new mongoose.Types.ObjectId();
    const profile = await UserProfile.create({ userid: userId, walletBalance: 0 });
    trash.profiles.push(profile._id);
    const coupon = await CouponModel.create({
      couponId: `${MARKER}-EMPTY`.toUpperCase(),
      discountType: "fixed",
      discountValue: 50,
      isActive: true,
      startDate: new Date(Date.now() - 86400000),
      expireDate: new Date(Date.now() + 86400000),
      usage: 1,
    });
    trash.coupons.push(coupon._id);
    await CouponRedemption.create({ coupon: coupon.couponId, user: userId, count: 1 });

    const srOrderId = 7700000 + process.pid % 10000 * 10 + 4;
    const order = await makeOrder({
      product,
      quantity: 2,
      userId,
      srOrderId,
      coupon: coupon.couponId,
      couponDiscount: 50,
      walletDiscount: 30,
    });

    // Every remaining unit, on an order that HAS a live Shiprocket shipment: the
    // shipment guard must not apply, because a full cancellation cancels the courier.
    const response = await partialCancel(order, product._id, 2, "Customer called");
    ok("an emptying request succeeds even with a live shipment", response.statusCode === 200,
      `${response.statusCode} ${response.body?.code || ""} ${response.body?.message || ""}`);
    ok("  the response keeps its shape: orderFullyCancelled", response.body?.orderFullyCancelled === true);
    ok("  shipmentCancelled", response.body?.shipmentCancelled === true);
    ok("  shipmentCancellationPending", response.body?.shipmentCancellationPending === false);
    ok("  walletCredited", response.body?.walletCredited === 30, String(response.body?.walletCredited));
    ok("  and the order", String(response.body?.order?._id) === String(order._id));

    const after = await fresh(order._id);
    ok("the order is Cancelled", after.orderStatus === "Cancelled", after.orderStatus);
    const entry = after.statusHistory.at(-1);
    ok("WITH a statusHistory entry (was missing)",
      entry?.from === "Confirmed" && entry?.to === "Cancelled" && entry?.source === "admin",
      JSON.stringify(entry));
    ok("WITH the cancellation subdocument (was missing)",
      after.cancellation?.cancelledAt instanceof Date &&
        after.cancellation?.cancelledBy === "admin" &&
        after.cancellation?.reason === "Customer called",
      JSON.stringify(after.cancellation));
    ok("exactly one cancellations[] record", after.cancellations.length === 1, String(after.cancellations.length));
    ok("  for the units cancelled",
      after.cancellations[0]?.quantity === 2 &&
        String(after.cancellations[0]?.product) === String(product._id),
      JSON.stringify(after.cancellations[0]));
    ok("  valued at the whole outstanding balance (nothing ships)",
      Math.abs(after.cancellations[0]?.refundAmount - after.totalAmount) < 0.01,
      `${after.cancellations[0]?.refundAmount} vs ${after.totalAmount}`);
    ok("the line is marked fully cancelled", after.items[0].cancelledQuantity === 2,
      String(after.items[0].cancelledQuantity));

    ok("the coupon redemption is RELEASED (was never released)",
      (await CouponRedemption.findOne({ coupon: coupon.couponId, user: userId }))?.count === 0);
    ok("  and the coupon's global usage with it", (await CouponModel.findById(coupon._id)).usage === 0);
    ok("the wallet share is credited once", (await UserProfile.findById(profile._id)).walletBalance === 30);

    ok("one refund row", after.refunds.length === 1, String(after.refunds.length));
    ok("  keyed partial-cancel:<cancellationId>",
      after.refunds[0]?.idempotencyKey === `partial-cancel:${after.cancellations[0]?._id}`,
      after.refunds[0]?.idempotencyKey);
    ok("  for the whole outstanding balance", Math.abs(after.refunds[0]?.amount - after.totalAmount) < 0.01);
    ok("  paid once, carrying the same key to Razorpay",
      razorpayCalls.refund.length === 1 &&
        razorpayCalls.refund[0].options?.notes?.refundKey === after.refunds[0]?.idempotencyKey,
      JSON.stringify(razorpayCalls.refund.map((c) => c.options?.notes)));
    ok("  and the order reads Refunded", after.paymentStatus === "Refunded", after.paymentStatus);

    ok("the courier was told exactly once", courier.cancelCalls.length === 1 && courier.cancelCalls[0][0] === srOrderId,
      JSON.stringify(courier.cancelCalls));
    ok("  and the shipment is marked cancelled", after.shiprocket.syncStatus === "cancelled", after.shiprocket.syncStatus);
    ok("stock: both units restored exactly once", (await stockOf(product._id)) === 22, String(await stockOf(product._id)));

    // Fire-and-forget in the controller, so give the queue row a moment to land.
    let notified = 0;
    for (let i = 0; i < 20 && notified === 0; i += 1) {
      notified = await NotificationEvent.countDocuments({ order: order._id, event: "order.cancelled" });
      if (notified === 0) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    ok("the customer is notified of the cancellation (was never told)", notified === 1, String(notified));
  }

  {
    // Line by line: one ordinary partial cancellation, then the emptying one.
    resetStubs();
    const product = await makeProduct("empty-two-step", 20);
    const order = await makeOrder({ product, quantity: 2 });

    const first = await partialCancel(order, product._id, 1);
    ok("first unit: an ordinary partial cancellation", first.statusCode === 200 && first.body?.orderFullyCancelled === false);
    const last = await partialCancel(order, product._id, 1);
    ok("last unit: delegated", last.statusCode === 200 && last.body?.orderFullyCancelled === true,
      `${last.statusCode} ${last.body?.message || ""}`);

    const after = await fresh(order._id);
    ok("the order is Cancelled", after.orderStatus === "Cancelled");
    ok("two cancellation records, one per request", after.cancellations.length === 2);
    ok("two refund rows, each under its own partial-cancel key",
      after.refunds.length === 2 &&
        after.refunds.every((r, i) => r.idempotencyKey === `partial-cancel:${after.cancellations[i]._id}`),
      JSON.stringify(after.refunds.map((r) => r.idempotencyKey)));
    ok("together exactly the order total — the same as one full cancellation",
      Math.abs(sumRefunded(after) - after.totalAmount) < 0.01, `${sumRefunded(after)} of ${after.totalAmount}`);
    ok("both units restocked, once each", (await stockOf(product._id)) === 22, String(await stockOf(product._id)));
    ok("no courier call — this order never had a shipment", courier.cancelCalls.length === 0);
  }

  {
    // The delegation acts on a picture of the lines taken in another transaction.
    // A partial cancellation committing in between must make the delegated claim
    // miss rather than cancel units it no longer describes.
    resetStubs();
    const product = await makeProduct("empty-race", 20);
    const order = await makeOrder({ product, quantity: 2 });

    const results = await Promise.all([
      partialCancel(order, product._id, 1),
      partialCancel(order, product._id, 2),
    ]);
    const succeeded = results.filter((r) => r.statusCode === 200);
    ok("a racing emptying request and a partial one: exactly one wins",
      succeeded.length === 1, JSON.stringify(results.map((r) => `${r.statusCode}:${r.body?.code || ""}`)));

    const after = await fresh(order._id);
    const recorded = after.cancellations.reduce((sum, c) => sum + c.quantity, 0);
    ok("the line's cancelled units match the records exactly",
      after.items[0].cancelledQuantity === recorded, `${after.items[0].cancelledQuantity} vs ${recorded}`);
    ok("stock restored by exactly the recorded units",
      (await stockOf(product._id)) === 20 + recorded, `${await stockOf(product._id)} vs ${20 + recorded}`);
    ok("never over the refund ceiling", sumRefunded(after) <= after.totalAmount + 0.01);
    ok("the status matches what happened",
      after.orderStatus === (recorded === 2 ? "Cancelled" : "Confirmed"), `${after.orderStatus} after ${recorded}`);
  }

  {
    // Three concurrent emptying requests: one full cancellation, not three.
    resetStubs();
    const product = await makeProduct("empty-triple", 20);
    const order = await makeOrder({
      product,
      quantity: 1,
      srOrderId: 7700000 + process.pid % 10000 * 10 + 5,
    });
    const results = await Promise.all([
      partialCancel(order, product._id, 1),
      partialCancel(order, product._id, 1),
      partialCancel(order, product._id, 1),
    ]);
    ok("exactly one of three concurrent emptying requests succeeds",
      results.filter((r) => r.statusCode === 200).length === 1,
      JSON.stringify(results.map((r) => r.statusCode)));
    const after = await fresh(order._id);
    ok("one cancellation record", after.cancellations.length === 1, String(after.cancellations.length));
    ok("one statusHistory entry to Cancelled",
      after.statusHistory.filter((e) => e.to === "Cancelled").length === 1);
    ok("one refund, one gateway call", after.refunds.length === 1 && razorpayCalls.refund.length === 1,
      `${after.refunds.length} rows, ${razorpayCalls.refund.length} calls`);
    ok("one courier cancellation", courier.cancelCalls.length === 1, `${courier.cancelCalls.length}`);
    ok("stock restored once", (await stockOf(product._id)) === 21, String(await stockOf(product._id)));
  }
} catch (error) {
  console.error(`\nSUITE ABORTED: ${error?.stack || error}`);
  ok("suite ran to completion", false, error?.message);
} finally {
  globalThis.fetch = originalFetch;
  await NotificationEvent.deleteMany({ order: { $in: trash.orders } });
  await OrderModel.deleteMany({ _id: { $in: trash.orders } });
  await ProductModel.deleteMany({ _id: { $in: trash.products } });
  await CouponModel.deleteMany({ _id: { $in: trash.coupons } });
  await CouponRedemption.deleteMany({ coupon: new RegExp(MARKER, "i") });
  await UserProfile.deleteMany({ _id: { $in: trash.profiles } });
  restoreCapabilities();
  const { failed } = finish();
  await mongoose.disconnect();
  process.exit(failed ? 1 : 0);
}
