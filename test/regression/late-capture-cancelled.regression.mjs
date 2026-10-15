/**
 * A cancelled unpaid checkout stays cancelled, and a late capture is refunded (G1).
 *
 * Three bugs, one root: cancelling a Razorpay order that was still awaiting
 * capture ran the full-cancellation compensations on a checkout that had taken
 * nothing, and left paymentStatus at "Pending".
 *
 *   - Stock: the units were restored by the cancellation AND again when the
 *     reservation was released or expired — phantom stock, oversold later.
 *   - Wallet/coupon: walletDiscount was credited to a customer never debited it
 *     (the debit happens at capture), and a coupon redemption that was never made
 *     was "released", freeing someone else's slot.
 *   - Resurrection: the promotion compare-and-swap matched on paymentStatus
 *     "Pending" alone, so a capture landing after the cancellation flipped the
 *     CANCELLED order to Confirmed/Paid and it shipped.
 *
 * Now: the unpaid branch sets payment to Failed in the cancellation transaction,
 * releases the reservation exactly once and expires the intent after commit, and
 * the promotion also requires orderStatus "Pending". A late capture — by the
 * browser verify or the webhook — is refused and refunded through the
 * orphaned-capture path, exactly once.
 *
 * Also covered: `promotedNow`, so two concurrent confirmations of one ordinary
 * checkout notify (and push to the courier) once, not twice; and the
 * PAYMENT_NOT_CAPTURED refusals on the admin status dropdown and manual shipment.
 *
 * And the retry door (sections 7-9): the abandoned-checkout sweeper closes the
 * intent and the stock hold as well as the order, RetryRazorpayOrder refuses an
 * order that is no longer Pending/Pending (409 ORDER_NOT_PAYABLE, no new Razorpay
 * order), and payment.failed notifies against the pending order and ignores a
 * failure on a superseded Razorpay order id.
 *
 * Run with `npm run test:late-capture-cancelled` (or `npm test` for everything).
 *
 * The Razorpay SDK is stubbed on its cached instance and `globalThis.fetch` throws
 * on any call, so nothing leaves the machine.
 */
process.env.PAYMENTS_ENABLED = "true";
process.env.PAYMENT_PROVIDER = "razorpay";
process.env.RAZORPAY_KEY_ID = "rzp_test_stub0000000";
process.env.RAZORPAY_KEY_SECRET = "stub_secret_for_tests";
process.env.RAZORPAY_WEBHOOK_ENABLED = "true";
process.env.RAZORPAY_WEBHOOK_SECRET = "stub_webhook_secret_for_tests";
process.env.INVENTORY_ENFORCE_STOCK = "true";
process.env.INVENTORY_RESERVE_DURING_PAYMENT = "true";
process.env.NOTIFICATIONS_ENABLED = "false";
process.env.SHIPROCKET_ENABLED = "false";
process.env.SHIPROCKET_BASE_URL = "https://shiprocket.invalid/v1/external";

import crypto from "node:crypto";
import mongoose from "mongoose";
import { connect, createSuite, marker, productFixture, addressFixture } from "./helpers.mjs";

const { ok, section, finish } = createSuite("late-capture-cancelled");
await connect();

const OrderModel = (await import("../../src/modules/orders/Order.model.js")).default;
const ProductModel = (await import("../../src/modules/products/Product.model.js")).default;
const PaymentIntent = (await import("../../src/modules/payments/PaymentIntent.model.js")).default;
const StockReservation = (await import("../../src/model/StockReservation.model.js")).default;
const UnmatchedPayment = (await import("../../src/modules/payments/UnmatchedPayment.model.js")).default;
const WebhookEvent = (await import("../../src/modules/payments/WebhookEvent.model.js")).default;
const NotificationEvent = (await import("../../src/model/NotificationEvent.model.js")).default;
const AuditLog = (await import("../../src/modules/audit/AuditLog.model.js")).default;
const CouponModel = (await import("../../src/modules/coupons/coupon.model.js")).default;
const CouponRedemption = (await import("../../src/modules/coupons/coupon-redemption.model.js")).default;
const UserProfile = (await import("../../src/modules/profiles/UserProfile.model.js")).default;
await import("../../src/modules/categories/Category.model.js");
const orderController = await import("../../src/modules/orders/order.controller.js");
const paymentController = await import("../../src/modules/payments/payment.controller.js");
const { RecordManualShipment } = await import("../../src/modules/shipping/manual-shipment.controller.js");
const { completeCapturedIntent, completeCapturedIntentWithOutcome } = await import(
  "../../src/modules/payments/payment-order.service.js"
);
const { reserveStockForIntent } = await import("../../src/modules/inventory/inventory-reservation.service.js");
const { cleanupExpiredStockReservations, cancelAbandonedCheckouts } = await import(
  "../../src/modules/inventory/stock-reservation-cleanup.service.js"
);
const razorpayService = await import("../../src/modules/payments/razorpay.service.js");

await OrderModel.init();
await UnmatchedPayment.init();
await WebhookEvent.init();

// ── Razorpay stub ───────────────────────────────────────────────────────────
const razorpayCalls = { refund: [], fetch: [], ordersCreate: [] };
const { razorpay: sharedRazorpay } = razorpayService.getRazorpay();
let refundSeq = 0;
// What Razorpay replies to a refund. "processed" unless a test says otherwise; a
// normal-speed refund really replies "pending".
let refundReplyStatus = "processed";
sharedRazorpay.payments.refund = async (paymentId, options) => {
  razorpayCalls.refund.push({ paymentId, options });
  return { id: `rfnd_lcc_${process.pid}_${++refundSeq}`, status: refundReplyStatus };
};
sharedRazorpay.payments.fetchMultipleRefund = async () => ({ items: [] });
// What the verify endpoint fetches: a captured payment on the checkout's Razorpay
// order, for the checkout's amount. Filled per test.
const capturedPayments = new Map();
sharedRazorpay.payments.fetch = async (paymentId) => {
  razorpayCalls.fetch.push(paymentId);
  const payment = capturedPayments.get(paymentId);
  if (!payment) throw new Error(`unknown payment ${paymentId}`);
  return payment;
};

let retryOrderSeq = 0;
sharedRazorpay.orders.create = async (options) => {
  razorpayCalls.ordersCreate.push(options);
  return { id: `order_${MARKER}_retry_${++retryOrderSeq}`, currency: options?.currency || "INR" };
};

// No outbound HTTP at all in this suite.
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input) => {
  throw new Error(`Unexpected outbound call in tests: ${String(input instanceof URL ? input.href : input)}`);
};

const MARKER = marker("latecap");
const trash = { orders: [], products: [], intents: [], coupons: [], profiles: [] };
let seq = 0;

const callController = async (handler, { params = {}, body = {}, user, headers = {}, rawBody } = {}) => {
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
  await handler(
    { params, body, user, query: {}, headers, rawBody, get: (key) => headers[String(key).toLowerCase()] },
    res,
  );
  return { statusCode, body: payload };
};

const makeProduct = async (label, stock = 10) => {
  const product = await ProductModel.create(productFixture(`${MARKER}-${label}`, { stock }));
  trash.products.push(product._id);
  return product;
};

/**
 * An unpaid checkout exactly as CreateRazorpayOrder leaves it: the order row at
 * Pending/Pending, its intent, and an ACTIVE stock reservation that has already
 * taken the units. Optionally carries a coupon and a wallet discount — neither of
 * which has been applied yet, because both happen at capture.
 */
const makeUnpaidCheckout = async ({ product, quantity = 2, userId, coupon = null, couponDiscount = 0, walletDiscount = 0 }) => {
  seq += 1;
  const items = [
    { product: product._id, name: product.name, image: "x.png", price: product.price, quantity },
  ];
  const subtotal = product.price * quantity;
  const totalAmount = subtotal - couponDiscount - walletDiscount;
  const razorpayOrderId = `order_${MARKER}_${seq}`;

  const [order] = await OrderModel.create([
    {
      user: userId,
      items,
      shippingAddress: addressFixture(),
      paymentMethod: "RAZORPAY",
      paymentStatus: "Pending",
      orderStatus: "Pending",
      subtotal,
      couponDiscount,
      walletDiscount,
      coupon,
      totalAmount,
      razorpayOrderId,
      paymentExpiresAt: new Date(Date.now() + 20 * 60 * 1000),
      statusHistory: [{ from: "", to: "Pending", changedBy: userId, source: "checkout", changedAt: new Date() }],
    },
  ]);
  trash.orders.push(order._id);

  const intent = await PaymentIntent.create({
    user: userId,
    idempotencyKey: `${MARKER}-${seq}-key`,
    razorpayOrderId,
    amount: Math.round(totalAmount * 100),
    currency: "INR",
    items,
    shippingAddress: addressFixture(),
    subtotal,
    couponDiscount,
    walletDiscount,
    coupon,
    totalAmount,
    pendingOrder: order._id,
  });
  trash.intents.push(intent._id);

  const reservation = await reserveStockForIntent({
    userId,
    paymentIntentId: intent._id,
    idempotencyKey: `${MARKER}-${seq}-key`,
    items,
  });
  intent.stockReserved = true;
  await intent.save();

  return { order, intent, reservation, paymentId: `pay_${MARKER}_${seq}` };
};

/** A customer with a wallet balance and an EARLIER genuine coupon redemption. */
const makeCustomerWithCoupon = async (label) => {
  const userId = new mongoose.Types.ObjectId();
  const profile = await UserProfile.create({ userid: userId, walletBalance: 0 });
  trash.profiles.push(profile._id);
  const coupon = await CouponModel.create({
    couponId: `${MARKER}-${label}`.toUpperCase(),
    discountType: "fixed",
    discountValue: 50,
    isActive: true,
    startDate: new Date(Date.now() - 86400000),
    expireDate: new Date(Date.now() + 86400000),
    usage: 1,
  });
  trash.coupons.push(coupon._id);
  // A redemption that belongs to a PAID order elsewhere. The unpaid checkout never
  // redeemed anything, so cancelling it must leave this alone.
  await CouponRedemption.create({ coupon: coupon.couponId, user: userId, count: 1 });
  return { userId, profile, coupon };
};

const stockOf = async (id) => (await ProductModel.findById(id)).stock;
const admin = () => ({ id: String(new mongoose.Types.ObjectId()), roles: ["admin"] });

/**
 * Runs the reservation expiry sweeper against this suite's reservation.
 *
 * cleanupExpiredStockReservations sweeps EVERY expired hold in the database, so it
 * is only run for real when nothing else is due — otherwise this suite would
 * release reservations it does not own. In that case the sweeper's own claim (the
 * whole of what decides whether it restocks) is replayed, scoped to our row.
 */
const runSweeperOn = async (reservationId) => {
  await StockReservation.updateOne(
    { _id: reservationId },
    { $set: { expiresAt: new Date(Date.now() - 60_000) } },
  );
  const othersDue = await StockReservation.countDocuments({
    _id: { $ne: reservationId },
    status: "active",
    expiresAt: { $lte: new Date() },
  });
  if (othersDue === 0) {
    await cleanupExpiredStockReservations({ limit: 5 });
    return "sweeper";
  }
  const claimed = await StockReservation.findOneAndUpdate(
    { _id: reservationId, status: "active", expiresAt: { $lte: new Date() } },
    { $set: { status: "expired", releasedAt: new Date(), reason: "reservation_expired" } },
    { returnDocument: "before" },
  );
  return claimed ? "claimed" : "refused";
};

const verifyLate = ({ intent, order, paymentId, userId }) => {
  capturedPayments.set(paymentId, {
    id: paymentId,
    order_id: order.razorpayOrderId,
    amount: intent.amount,
    currency: "INR",
    status: "captured",
  });
  const signature = crypto
    .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
    .update(`${order.razorpayOrderId}|${paymentId}`)
    .digest("hex");
  return callController(paymentController.VerifyRazorpayPayment, {
    body: {
      razorpay_order_id: order.razorpayOrderId,
      razorpay_payment_id: paymentId,
      razorpay_signature: signature,
    },
    user: { id: String(userId) },
  });
};

let eventSeq = 0;
const sendWebhook = (body) => {
  const rawBody = JSON.stringify(body);
  const signature = crypto
    .createHmac("sha256", process.env.RAZORPAY_WEBHOOK_SECRET)
    .update(rawBody)
    .digest("hex");
  return callController(paymentController.RazorpayWebhook, {
    body,
    rawBody,
    headers: {
      "x-razorpay-signature": signature,
      "x-razorpay-event-id": `evt_${MARKER}_${++eventSeq}`,
    },
  });
};
const webhookPaymentFailed = ({ razorpayOrderId, paymentId }) =>
  sendWebhook({
    event: "payment.failed",
    payload: {
      payment: {
        entity: {
          id: paymentId,
          order_id: razorpayOrderId,
          status: "failed",
          error_description: "Bank declined the payment",
        },
      },
    },
  });
const webhookLate = ({ intent, order, paymentId }) => {
  const body = {
    event: "payment.captured",
    payload: {
      payment: {
        entity: {
          id: paymentId,
          order_id: order.razorpayOrderId,
          amount: intent.amount,
          currency: "INR",
          status: "captured",
        },
      },
    },
  };
  const rawBody = JSON.stringify(body);
  const signature = crypto
    .createHmac("sha256", process.env.RAZORPAY_WEBHOOK_SECRET)
    .update(rawBody)
    .digest("hex");
  return callController(paymentController.RazorpayWebhook, {
    body,
    rawBody,
    headers: {
      "x-razorpay-signature": signature,
      "x-razorpay-event-id": `evt_${MARKER}_${++eventSeq}`,
    },
  });
};

/** Everything a cancelled unpaid checkout must look like, whoever cancelled it. */
const assertClosedUnpaid = async (label, { order, intent, reservation, product, profile, coupon, userId, stockBefore }) => {
  const after = await OrderModel.findById(order._id);
  ok(`${label}: the order is Cancelled`, after.orderStatus === "Cancelled", after.orderStatus);
  ok(`${label}: payment is Failed, not left at Pending`, after.paymentStatus === "Failed", after.paymentStatus);
  ok(`${label}: the checkout expiry is cleared`, after.paymentExpiresAt === null);
  ok(`${label}: no refund row — nothing was collected`, after.refunds.length === 0, String(after.refunds.length));
  ok(`${label}: no wallet credit recorded on the order`, (after.walletRefunded || 0) === 0, String(after.walletRefunded));
  ok(`${label}: the customer's wallet is untouched (never debited)`,
    (await UserProfile.findById(profile._id)).walletBalance === 0);
  ok(`${label}: the earlier coupon redemption is NOT released`,
    (await CouponRedemption.findOne({ coupon: coupon.couponId, user: userId }))?.count === 1);
  ok(`${label}: and the coupon's usage is unchanged`, (await CouponModel.findById(coupon._id)).usage === 1);
  ok(`${label}: the reservation is released`,
    (await StockReservation.findById(reservation._id))?.status === "released",
    (await StockReservation.findById(reservation._id))?.status);
  ok(`${label}: stock is back EXACTLY once`, (await stockOf(product._id)) === stockBefore,
    `${await stockOf(product._id)} vs ${stockBefore}`);
  ok(`${label}: the payment intent is expired`,
    (await PaymentIntent.findById(intent._id))?.status === "expired",
    (await PaymentIntent.findById(intent._id))?.status);
  const swept = await runSweeperOn(reservation._id);
  ok(`${label}: the expiry sweeper does not restock it a second time (${swept})`,
    swept !== "claimed" && (await stockOf(product._id)) === stockBefore,
    `${swept}, stock ${await stockOf(product._id)}`);
};

try {
  // ═══════════════════════════════════════════════════════════════════════════
  section("1 — customer cancels an unpaid checkout; a late capture is refused");

  {
    const product = await makeProduct("customer", 10);
    const { userId, profile, coupon } = await makeCustomerWithCoupon("CUST");
    const checkout = await makeUnpaidCheckout({
      product, quantity: 2, userId, coupon: coupon.couponId, couponDiscount: 50, walletDiscount: 30,
    });
    ok("the reservation took the units (10 → 8)", (await stockOf(product._id)) === 8, String(await stockOf(product._id)));

    const response = await callController(orderController.CancelOrder, {
      params: { orderId: String(checkout.order._id) },
      body: { reason: "Changed my mind" },
      user: { id: String(userId) },
    });
    ok("the customer's cancellation succeeds", response.statusCode === 200,
      `${response.statusCode} ${response.body?.message || ""}`);

    await assertClosedUnpaid("customer", { ...checkout, product, profile, coupon, userId, stockBefore: 10 });

    let lateError = null;
    try {
      await completeCapturedIntent({
        intent: checkout.intent,
        capturedPayment: { id: checkout.paymentId, status: "captured" },
      });
    } catch (error) {
      lateError = error;
    }
    ok("a late capture is refused with a 4xx (unrecoverable → orphan refund)",
      lateError && lateError.statusCode >= 400 && lateError.statusCode < 500,
      `${lateError?.statusCode} ${lateError?.message}`);
    const after = await OrderModel.findById(checkout.order._id);
    ok("  the order stays Cancelled — not resurrected", after.orderStatus === "Cancelled", after.orderStatus);
    ok("  and unpaid", after.paymentStatus === "Failed", after.paymentStatus);
    ok("  no stock was taken by the refused capture", (await stockOf(product._id)) === 10, String(await stockOf(product._id)));
    ok("  no wallet was debited", (await UserProfile.findById(profile._id)).walletBalance === 0);
    ok("  no coupon was redeemed", (await CouponRedemption.findOne({ coupon: coupon.couponId, user: userId }))?.count === 1);
    ok("  the intent did not complete", (await PaymentIntent.findById(checkout.intent._id))?.status === "expired");
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("2 — admin cancels; late verify AND late webhook both refund, once");

  {
    razorpayCalls.refund = [];
    const product = await makeProduct("admin", 10);
    const { userId, profile, coupon } = await makeCustomerWithCoupon("ADMIN");
    const checkout = await makeUnpaidCheckout({
      product, quantity: 3, userId, coupon: coupon.couponId, couponDiscount: 50, walletDiscount: 30,
    });

    const response = await callController(orderController.AdminCancelOrder, {
      params: { orderId: String(checkout.order._id) },
      body: { reason: "Customer asked on the phone" },
      user: admin(),
    });
    ok("the admin cancellation succeeds", response.statusCode === 200,
      `${response.statusCode} ${response.body?.message || ""}`);
    await assertClosedUnpaid("admin", { ...checkout, product, profile, coupon, userId, stockBefore: 10 });

    const verify = await verifyLate({ ...checkout, userId });
    ok("a late browser verify is refused and the payment refunded (409 RAZORPAY_PAYMENT_REFUNDED)",
      verify.statusCode === 409 && verify.body?.code === "RAZORPAY_PAYMENT_REFUNDED",
      `${verify.statusCode} ${verify.body?.code} ${verify.body?.message || ""}`);
    ok("  one gateway refund, for the captured amount",
      razorpayCalls.refund.length === 1 &&
        razorpayCalls.refund[0].paymentId === checkout.paymentId &&
        razorpayCalls.refund[0].options?.amount === checkout.intent.amount,
      JSON.stringify(razorpayCalls.refund));
    const unmatched = await UnmatchedPayment.findOne({ paymentId: checkout.paymentId });
    ok("  recorded as an orphaned capture", unmatched?.resolution === "refunded", unmatched?.resolution);

    const hook = await webhookLate(checkout);
    ok("the late webhook for the same payment is answered 200 without refunding again",
      hook.statusCode === 200 && razorpayCalls.refund.length === 1,
      `${hook.statusCode} ${hook.body?.code} — ${razorpayCalls.refund.length} refunds`);

    const after = await OrderModel.findById(checkout.order._id);
    ok("the order is still Cancelled", after.orderStatus === "Cancelled", after.orderStatus);
    ok("  still unpaid", after.paymentStatus === "Failed", after.paymentStatus);
    ok("  stock still exact", (await stockOf(product._id)) === 10, String(await stockOf(product._id)));
    ok("  the intent stays expired, never completed",
      (await PaymentIntent.findById(checkout.intent._id))?.status === "expired");
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("3 — webhook-only late capture, replayed");

  {
    razorpayCalls.refund = [];
    const product = await makeProduct("webhook", 10);
    const userId = new mongoose.Types.ObjectId();
    const checkout = await makeUnpaidCheckout({ product, quantity: 1, userId });
    const response = await callController(orderController.CancelOrder, {
      params: { orderId: String(checkout.order._id) },
      body: { reason: "Ordered by mistake" },
      user: { id: String(userId) },
    });
    ok("cancelled", response.statusCode === 200, String(response.statusCode));
    ok("stock back exactly", (await stockOf(product._id)) === 10, String(await stockOf(product._id)));

    const first = await webhookLate(checkout);
    ok("the capture webhook refunds instead of promoting",
      first.statusCode === 200 && first.body?.code === "CAPTURE_REFUNDED_ORDER_NOT_PROMOTABLE",
      `${first.statusCode} ${first.body?.code}`);
    const replay = await webhookLate(checkout);
    ok("a redelivery (new event id) refunds nothing further",
      replay.statusCode === 200 && razorpayCalls.refund.length === 1,
      `${replay.statusCode} — ${razorpayCalls.refund.length} refunds`);
    ok("the order is still Cancelled", (await OrderModel.findById(checkout.order._id)).orderStatus === "Cancelled");
    ok("Razorpay said processed, so the customer is told processed",
      (await NotificationEvent.countDocuments({ order: checkout.order._id, event: "refund.processed" })) >= 1);
  }

  {
    // Same path, but Razorpay only ACCEPTED the refund (`pending`). The customer
    // must be told it was initiated — not that money has moved.
    razorpayCalls.refund = [];
    refundReplyStatus = "pending";
    try {
      const product = await makeProduct("webhook-pending", 10);
      const userId = new mongoose.Types.ObjectId();
      const checkout = await makeUnpaidCheckout({ product, quantity: 1, userId });
      await callController(orderController.CancelOrder, {
        params: { orderId: String(checkout.order._id) },
        body: { reason: "Ordered by mistake" },
        user: { id: String(userId) },
      });
      const hook = await webhookLate(checkout);
      ok("a pending orphan refund still answers CAPTURE_REFUNDED_ORDER_NOT_PROMOTABLE",
        hook.statusCode === 200 && hook.body?.code === "CAPTURE_REFUNDED_ORDER_NOT_PROMOTABLE",
        `${hook.statusCode} ${hook.body?.code}`);
      const count = (event) => NotificationEvent.countDocuments({ order: checkout.order._id, event });
      ok("  the customer is told the refund was initiated", (await count("refund.initiated")) === 1,
        String(await count("refund.initiated")));
      ok("  and NOT that it was processed", (await count("refund.processed")) === 0,
        String(await count("refund.processed")));
    } finally {
      refundReplyStatus = "processed";
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("4 — the promotion CAS itself refuses a cancelled order");

  {
    // Data cancelled BEFORE this fix: Cancelled but still paymentStatus "Pending",
    // with an intent that was never expired. Only the orderStatus condition in the
    // promotion filter stands between this row and a resurrection.
    const product = await makeProduct("legacy", 10);
    const userId = new mongoose.Types.ObjectId();
    const checkout = await makeUnpaidCheckout({ product, quantity: 1, userId });
    await OrderModel.updateOne(
      { _id: checkout.order._id },
      { $set: { orderStatus: "Cancelled", "cancellation.cancelledAt": new Date() } },
    );

    let lateError = null;
    try {
      await completeCapturedIntent({
        intent: checkout.intent,
        capturedPayment: { id: checkout.paymentId, status: "captured" },
      });
    } catch (error) {
      lateError = error;
    }
    ok("a capture on a Cancelled-but-Pending order throws 409",
      lateError?.statusCode === 409, `${lateError?.statusCode} ${lateError?.message}`);
    const after = await OrderModel.findById(checkout.order._id);
    ok("  it stays Cancelled", after.orderStatus === "Cancelled", after.orderStatus);
    ok("  and is NOT marked Paid", after.paymentStatus === "Pending", after.paymentStatus);
    ok("  the intent did not complete", (await PaymentIntent.findById(checkout.intent._id))?.status !== "completed");
    ok("  and the reservation was not committed — the transaction rolled back",
      (await StockReservation.findById(checkout.reservation._id))?.status === "active");
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("5 — promotedNow: one checkout, one set of side effects");

  {
    const product = await makeProduct("promoted", 10);
    const userId = new mongoose.Types.ObjectId();
    const checkout = await makeUnpaidCheckout({ product, quantity: 1, userId });

    const results = await Promise.allSettled([
      completeCapturedIntentWithOutcome({
        intent: checkout.intent,
        capturedPayment: { id: checkout.paymentId, status: "captured" },
      }),
      completeCapturedIntentWithOutcome({
        intent: checkout.intent,
        capturedPayment: { id: checkout.paymentId, status: "captured" },
      }),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled").map((r) => r.value);
    ok("at least one confirmation resolves", fulfilled.length >= 1,
      JSON.stringify(results.map((r) => r.status === "rejected" ? r.reason?.message : "ok")));
    ok("both resolve to the same order", fulfilled.every((r) => String(r.storeOrder?._id) === String(checkout.order._id)));
    ok("EXACTLY ONE reports promotedNow", fulfilled.filter((r) => r.promotedNow).length === 1,
      JSON.stringify(fulfilled.map((r) => r.promotedNow)));

    const replay = await completeCapturedIntentWithOutcome({
      intent: checkout.intent,
      capturedPayment: { id: checkout.paymentId, status: "captured" },
    });
    ok("a later replay adopts the order without promoting", replay.promotedNow === false &&
      String(replay.storeOrder?._id) === String(checkout.order._id));
    ok("the backward-compatible entry point still returns the order itself",
      String((await completeCapturedIntent({
        intent: checkout.intent,
        capturedPayment: { id: checkout.paymentId, status: "captured" },
      }))?._id) === String(checkout.order._id));

    const paymentSuccess = await NotificationEvent.countDocuments({ order: checkout.order._id, event: "payment.success" });
    const placed = await NotificationEvent.countDocuments({ order: checkout.order._id, event: "order.placed" });
    ok("one payment-success notification across four confirmations", paymentSuccess === 1, String(paymentSuccess));
    ok("one order-placed notification", placed === 1, String(placed));

    const order = await OrderModel.findById(checkout.order._id);
    ok("the order is Confirmed/Paid", order.orderStatus === "Confirmed" && order.paymentStatus === "Paid",
      `${order.orderStatus}/${order.paymentStatus}`);
    ok("stock was committed once (reservation, not a second decrement)",
      (await stockOf(product._id)) === 9, String(await stockOf(product._id)));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("6 — PAYMENT_NOT_CAPTURED on the admin paths");

  {
    const product = await makeProduct("refusals", 10);
    const userId = new mongoose.Types.ObjectId();
    const checkout = await makeUnpaidCheckout({ product, quantity: 1, userId });

    for (const target of ["Confirmed", "Packed"]) {
      const response = await callController(orderController.UpdateOrderStatus, {
        params: { orderId: String(checkout.order._id) },
        body: { orderStatus: target },
        user: admin(),
      });
      ok(`Pending → ${target} on an unpaid prepaid order → 409 PAYMENT_NOT_CAPTURED`,
        response.statusCode === 409 && response.body?.code === "PAYMENT_NOT_CAPTURED",
        `${response.statusCode} ${response.body?.code}`);
    }
    const manual = await callController(RecordManualShipment, {
      params: { orderId: String(checkout.order._id) },
      body: { carrierName: "India Post", trackingNumber: `EM${seq}IN`, provider: "MANUAL" },
      user: admin(),
    });
    ok("recording a manual shipment on it → 409 PAYMENT_NOT_CAPTURED",
      manual.statusCode === 409 && manual.body?.code === "PAYMENT_NOT_CAPTURED",
      `${manual.statusCode} ${manual.body?.code}`);
    const after = await OrderModel.findById(checkout.order._id);
    ok("  the order is untouched", after.orderStatus === "Pending" && !after.shipment?.trackingNumber,
      `${after.orderStatus} ${after.shipment?.trackingNumber}`);

    // A COD order at Pending is a real order: the dropdown still confirms it.
    const [cod] = await OrderModel.create([
      {
        user: userId,
        items: [{ product: product._id, name: product.name, image: "x.png", price: product.price, quantity: 1 }],
        shippingAddress: addressFixture(),
        paymentMethod: "COD",
        paymentStatus: "Pending",
        orderStatus: "Pending",
        subtotal: product.price,
        totalAmount: product.price,
      },
    ]);
    trash.orders.push(cod._id);
    const codConfirm = await callController(orderController.UpdateOrderStatus, {
      params: { orderId: String(cod._id) },
      body: { orderStatus: "Confirmed" },
      user: admin(),
    });
    ok("a Pending COD order can still be confirmed by hand", codConfirm.statusCode === 200,
      `${codConfirm.statusCode} ${codConfirm.body?.code || ""}`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("7 — the sweeper closes the whole checkout; a retry is then refused");

  {
    razorpayCalls.ordersCreate = [];
    const product = await makeProduct("swept", 10);
    const userId = new mongoose.Types.ObjectId();
    const checkout = await makeUnpaidCheckout({ product, quantity: 2, userId });
    ok("the reservation took the units (10 → 8)", (await stockOf(product._id)) === 8, String(await stockOf(product._id)));

    // The checkout window runs out. The hold itself is still inside its own TTL, so
    // only the checkout sweep can be what gives the stock back.
    await OrderModel.updateOne(
      { _id: checkout.order._id },
      { $set: { paymentExpiresAt: new Date(Date.now() - 60_000) } },
    );
    await cancelAbandonedCheckouts({ limit: 200 });

    const swept = await OrderModel.findById(checkout.order._id);
    ok("the order is Cancelled/Failed", swept.orderStatus === "Cancelled" && swept.paymentStatus === "Failed",
      `${swept.orderStatus}/${swept.paymentStatus}`);
    ok('cancelledBy is "system"', swept.cancellation?.cancelledBy === "system", swept.cancellation?.cancelledBy);
    ok("the payment intent is expired",
      (await PaymentIntent.findById(checkout.intent._id))?.status === "expired",
      (await PaymentIntent.findById(checkout.intent._id))?.status);
    ok("the reservation is released",
      (await StockReservation.findById(checkout.reservation._id))?.status === "released",
      (await StockReservation.findById(checkout.reservation._id))?.status);
    ok("stock is back exactly once", (await stockOf(product._id)) === 10, String(await stockOf(product._id)));
    const swept2 = await runSweeperOn(checkout.reservation._id);
    ok(`the expiry sweeper does not restock it again (${swept2})`,
      swept2 !== "claimed" && (await stockOf(product._id)) === 10, `${swept2}, stock ${await stockOf(product._id)}`);

    const retry = await callController(paymentController.RetryRazorpayOrder, {
      params: { intentId: String(checkout.intent._id) },
      user: { id: String(userId) },
    });
    ok("RetryRazorpayOrder on the swept checkout → 404 (its intent is closed)",
      retry.statusCode === 404, `${retry.statusCode} ${retry.body?.code || ""} ${retry.body?.message || ""}`);
    ok("  no new Razorpay order was minted", razorpayCalls.ordersCreate.length === 0,
      String(razorpayCalls.ordersCreate.length));
    ok("  the order keeps its original Razorpay order id",
      (await OrderModel.findById(checkout.order._id)).razorpayOrderId === checkout.order.razorpayOrderId);

    const again = await cancelAbandonedCheckouts({ limit: 200 });
    const history = (await OrderModel.findById(checkout.order._id)).statusHistory
      .filter((entry) => entry.source === "abandoned_checkout_sweeper");
    ok("a second sweep does not touch it again", history.length === 1, `${history.length} sweeper entries (${again} swept)`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("8 — RetryRazorpayOrder refuses an order that is no longer awaiting payment");

  {
    // Data from before the sweeper closed intents: the order is Cancelled (paymentStatus
    // never fixed) but its intent is still `failed`, which the intent lookup accepts.
    // Only the order check stands between it and a fresh Razorpay order that could be
    // paid but never promoted.
    razorpayCalls.ordersCreate = [];
    const product = await makeProduct("legacy-retry", 10);
    const userId = new mongoose.Types.ObjectId();
    const checkout = await makeUnpaidCheckout({ product, quantity: 1, userId });
    await OrderModel.updateOne(
      { _id: checkout.order._id },
      { $set: { orderStatus: "Cancelled", "cancellation.cancelledAt": new Date() } },
    );
    await PaymentIntent.updateOne({ _id: checkout.intent._id }, { $set: { status: "failed" } });

    const retry = await callController(paymentController.RetryRazorpayOrder, {
      params: { intentId: String(checkout.intent._id) },
      user: { id: String(userId) },
    });
    ok("→ 409 ORDER_NOT_PAYABLE", retry.statusCode === 409 && retry.body?.code === "ORDER_NOT_PAYABLE",
      `${retry.statusCode} ${retry.body?.code} ${retry.body?.message || ""}`);
    ok("  no Razorpay order was created", razorpayCalls.ordersCreate.length === 0,
      String(razorpayCalls.ordersCreate.length));
    const intentAfter = await PaymentIntent.findById(checkout.intent._id);
    ok("  the intent is expired so the next retry stops at the lookup", intentAfter?.status === "expired",
      intentAfter?.status);
    ok("  and keeps its Razorpay order id (nothing was superseded)",
      intentAfter?.razorpayOrderId === checkout.intent.razorpayOrderId &&
        (intentAfter?.previousRazorpayOrderIds || []).length === 0);
    const orderAfter = await OrderModel.findById(checkout.order._id);
    ok("  the order is untouched", orderAfter.orderStatus === "Cancelled" &&
      orderAfter.razorpayOrderId === checkout.order.razorpayOrderId, orderAfter.orderStatus);

    const second = await callController(paymentController.RetryRazorpayOrder, {
      params: { intentId: String(checkout.intent._id) },
      user: { id: String(userId) },
    });
    ok("a second retry → 404", second.statusCode === 404, String(second.statusCode));

    // Paid by another path in the meantime (Pending order, Paid payment) — also refused.
    const paidCheckout = await makeUnpaidCheckout({ product, quantity: 1, userId });
    await OrderModel.updateOne({ _id: paidCheckout.order._id }, { $set: { paymentStatus: "Paid" } });
    const paidRetry = await callController(paymentController.RetryRazorpayOrder, {
      params: { intentId: String(paidCheckout.intent._id) },
      user: { id: String(userId) },
    });
    ok("an order already marked Paid → 409 ORDER_NOT_PAYABLE",
      paidRetry.statusCode === 409 && paidRetry.body?.code === "ORDER_NOT_PAYABLE",
      `${paidRetry.statusCode} ${paidRetry.body?.code}`);
    ok("  still no Razorpay order created", razorpayCalls.ordersCreate.length === 0);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("9 — a live checkout still retries; payment.failed targets the pending order");

  {
    razorpayCalls.ordersCreate = [];
    const product = await makeProduct("live-retry", 10);
    const userId = new mongoose.Types.ObjectId();
    const checkout = await makeUnpaidCheckout({ product, quantity: 1, userId });
    const originalRzpOrderId = checkout.order.razorpayOrderId;
    // Close to expiry, so the extension is visible.
    await OrderModel.updateOne(
      { _id: checkout.order._id },
      { $set: { paymentExpiresAt: new Date(Date.now() + 30_000) } },
    );

    const retry = await callController(paymentController.RetryRazorpayOrder, {
      params: { intentId: String(checkout.intent._id) },
      user: { id: String(userId) },
    });
    ok("RetryRazorpayOrder on a Pending/Pending order → 201", retry.statusCode === 201,
      `${retry.statusCode} ${retry.body?.code || ""} ${retry.body?.message || ""}`);
    ok("  exactly one Razorpay order created", razorpayCalls.ordersCreate.length === 1,
      String(razorpayCalls.ordersCreate.length));
    const newRzpOrderId = retry.body?.data?.razorpayOrderId;
    const intentAfter = await PaymentIntent.findById(checkout.intent._id);
    ok("  the intent moved to the new Razorpay order and kept the old one",
      intentAfter.razorpayOrderId === newRzpOrderId &&
        intentAfter.previousRazorpayOrderIds.includes(originalRzpOrderId));
    const orderAfter = await OrderModel.findById(checkout.order._id);
    ok("  the order follows the new Razorpay order id", orderAfter.razorpayOrderId === newRzpOrderId,
      orderAfter.razorpayOrderId);
    ok("  and its payment window was extended",
      orderAfter.paymentExpiresAt && orderAfter.paymentExpiresAt.getTime() > Date.now() + 5 * 60 * 1000,
      String(orderAfter.paymentExpiresAt));

    // A late failure on the SUPERSEDED Razorpay order must not touch the live attempt.
    const stale = await webhookPaymentFailed({
      razorpayOrderId: originalRzpOrderId,
      paymentId: `pay_${MARKER}_stale_${seq}`,
    });
    ok("payment.failed on the superseded id is acknowledged", stale.statusCode === 200, String(stale.statusCode));
    ok("  the live intent stays created",
      (await PaymentIntent.findById(checkout.intent._id))?.status === "created",
      (await PaymentIntent.findById(checkout.intent._id))?.status);
    ok("  its stock hold stays active",
      (await StockReservation.findById(checkout.reservation._id))?.status === "active",
      (await StockReservation.findById(checkout.reservation._id))?.status);
    ok("  and the customer is not told their payment failed",
      (await NotificationEvent.countDocuments({ order: checkout.order._id, event: "payment.failed" })) === 0);

    // A failure on the CURRENT id is real.
    const live = await webhookPaymentFailed({
      razorpayOrderId: newRzpOrderId,
      paymentId: `pay_${MARKER}_live_${seq}`,
    });
    ok("payment.failed on the current id is acknowledged", live.statusCode === 200, String(live.statusCode));
    ok("  the intent is failed", (await PaymentIntent.findById(checkout.intent._id))?.status === "failed");
    ok("  its stock hold is released",
      (await StockReservation.findById(checkout.reservation._id))?.status === "released",
      (await StockReservation.findById(checkout.reservation._id))?.status);
    const failedNotices = await NotificationEvent.countDocuments({
      order: checkout.order._id,
      event: "payment.failed",
    });
    ok("  the payment.failed notification names the pending order", failedNotices === 1, String(failedNotices));

    // The customer can still retry a failed attempt on a live order.
    const retryAgain = await callController(paymentController.RetryRazorpayOrder, {
      params: { intentId: String(checkout.intent._id) },
      user: { id: String(userId) },
    });
    ok("a failed attempt on a live order can be retried (201)", retryAgain.statusCode === 201,
      `${retryAgain.statusCode} ${retryAgain.body?.code || ""}`);
  }
} catch (error) {
  console.error(`\nSUITE ABORTED: ${error?.stack || error}`);
  ok("suite ran to completion", false, error?.message);
} finally {
  globalThis.fetch = originalFetch;
  await NotificationEvent.deleteMany({ order: { $in: trash.orders } });
  await AuditLog.deleteMany({ targetId: { $in: trash.orders } });
  await UnmatchedPayment.deleteMany({ paymentId: new RegExp(`^pay_${MARKER}_`) });
  await WebhookEvent.deleteMany({ eventId: new RegExp(`^evt_${MARKER}_`) });
  await StockReservation.deleteMany({ idempotencyKey: new RegExp(`^${MARKER}`) });
  await PaymentIntent.deleteMany({ _id: { $in: trash.intents } });
  await OrderModel.deleteMany({ _id: { $in: trash.orders } });
  await ProductModel.deleteMany({ _id: { $in: trash.products } });
  await CouponModel.deleteMany({ _id: { $in: trash.coupons } });
  await CouponRedemption.deleteMany({ coupon: new RegExp(MARKER, "i") });
  await UserProfile.deleteMany({ _id: { $in: trash.profiles } });
  const { failed } = finish();
  await mongoose.disconnect();
  process.exit(failed ? 1 : 0);
}
