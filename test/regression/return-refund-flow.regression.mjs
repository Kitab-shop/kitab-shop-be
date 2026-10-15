/**
 * A return refund through AdminUpdateReturnStatus, against what Razorpay actually says.
 *
 *   failed  → 502 GATEWAY_REFUND_REJECTED, and the return goes back to received so the
 *             refund can be retried. Nothing tells the customer they were refunded.
 *   pending → the return reads refunded (Razorpay has accepted it), the ledger row stays
 *             `created`, and the customer is told the refund is INITIATED — never
 *             "processed" — until the poller or webhook sees it settle.
 *   processed, and a manual (COD) refund → "refund processed", once.
 *
 * The rollback after a failed refund is a compare-and-swap on "refunded", so a return
 * something else moved meanwhile is not overwritten with a stale status.
 *
 * Run with `node test/regression/return-refund-flow.regression.mjs`.
 */
process.env.PAYMENTS_ENABLED = "true";
process.env.RAZORPAY_KEY_ID = "rzp_test_stub0000000";
process.env.RAZORPAY_KEY_SECRET = "stub_secret_for_tests";
process.env.INVENTORY_ENFORCE_STOCK = "false";
process.env.NOTIFICATIONS_ENABLED = "false";
process.env.SHIPROCKET_ENABLED = "false";

import mongoose from "mongoose";
import { connect, createSuite, marker, productFixture, addressFixture } from "./helpers.mjs";

const { ok, section, finish } = createSuite("return-refund-flow");
await connect();

const OrderModel = (await import("../../src/modules/orders/Order.model.js")).default;
const ProductModel = (await import("../../src/modules/products/Product.model.js")).default;
const ReturnModel = (await import("../../src/modules/returns/return.model.js")).default;
const NotificationEvent = (await import("../../src/model/NotificationEvent.model.js")).default;
const razorpayService = await import("../../src/modules/payments/razorpay.service.js");
const returnController = await import("../../src/modules/returns/return.controller.js");

await ReturnModel.init().catch(() => {});

const MARKER = marker("retrefund");
const trash = { orders: [], products: [], returns: [] };
let seq = 0;

// ── Razorpay stub ───────────────────────────────────────────────────────────
// getRazorpay() caches one SDK instance every caller shares, so patching its methods
// reaches the code under test (the refund-safety / refund-confirmation technique).
const calls = { refund: [] };
let refundIdSeq = 0;
const gatewayRefunds = new Map();
let refundReply = () => "processed";
let duringRefund = async () => {};

const { razorpay: sharedRazorpay } = razorpayService.getRazorpay();
sharedRazorpay.payments.refund = async (paymentId, options) => {
  calls.refund.push({ paymentId, options });
  await duringRefund(paymentId, options);
  const refund = {
    id: `rfnd_${MARKER}_${++refundIdSeq}`,
    payment_id: paymentId,
    amount: options?.amount,
    status: refundReply(),
    notes: options?.notes || {},
  };
  gatewayRefunds.set(refund.id, refund);
  return refund;
};
sharedRazorpay.payments.fetchRefund = async (_paymentId, refundId) => {
  const refund = gatewayRefunds.get(refundId);
  if (!refund) throw new Error(`no such refund ${refundId}`);
  return refund;
};
sharedRazorpay.payments.fetchMultipleRefund = async (paymentId) => ({
  items: [...gatewayRefunds.values()].filter((r) => r.payment_id === paymentId),
});

const resetGateway = () => {
  calls.refund = [];
  refundReply = () => "processed";
  duringRefund = async () => {};
};

const call = async (handler, { params = {}, body = {}, user, query = {} } = {}) => {
  let statusCode = 200;
  let payload;
  const res = {
    status(code) { statusCode = code; return this; },
    json(data) { payload = data; return this; },
  };
  await handler({ params, body, user, query, get: () => undefined }, res);
  return { statusCode, body: payload };
};

const admin = () => ({ id: String(new mongoose.Types.ObjectId()), roles: ["admin"] });

/** A Delivered order with one return already at "received", ready to refund. */
const receivedReturn = async ({ paymentMethod = "RAZORPAY" } = {}) => {
  seq += 1;
  const product = await ProductModel.create(productFixture(`${MARKER}-${seq}`, { stock: 10, price: 500 }));
  trash.products.push(product._id);
  const userId = new mongoose.Types.ObjectId();
  const order = await OrderModel.create({
    user: userId,
    items: [{ product: product._id, name: product.name, image: "x.png", price: 500, quantity: 2 }],
    shippingAddress: addressFixture(),
    paymentMethod,
    paymentStatus: "Paid",
    orderStatus: "Delivered",
    deliveredAt: new Date(),
    subtotal: 1000,
    totalAmount: 1000,
    ...(paymentMethod === "RAZORPAY" ? { razorpayPaymentId: `pay_${MARKER}_${seq}` } : {}),
  });
  trash.orders.push(order._id);
  const returnRequest = await ReturnModel.create({
    order: order._id,
    user: userId,
    product: product._id,
    productSnapshot: { name: product.name, image: "x.png", price: 500 },
    quantity: 1,
    reason: "damaged",
    refundAmount: 500,
    resolutionType: "refund",
    status: "received",
    receivedAt: new Date(),
    returnNumber: `${MARKER}-RET-${seq}`,
    ...(paymentMethod === "RAZORPAY" ? {} : { refundDestination: { method: "upi", upiId: "cust@upi" } }),
  });
  trash.returns.push(returnRequest._id);
  return { order, returnRequest };
};

const refund = (returnId, extra = {}) =>
  call(returnController.AdminUpdateReturnStatus, {
    params: { id: String(returnId) },
    body: { status: "refunded", disposition: "resellable", ...extra },
    user: admin(),
  });

const events = (event, orderId) => NotificationEvent.countDocuments({ event, order: orderId });
const freshReturn = (id) => ReturnModel.findById(id).lean();
const freshOrder = (id) => OrderModel.findById(id).lean();
const rowsFor = (order, returnId) =>
  (order.refunds || []).filter((r) => String(r.returnRequest) === String(returnId));

try {
  // ═══════════════════════════════════════════════════════════════════════════
  section("1 — Razorpay declines the refund");
  const declined = await receivedReturn();
  {
    resetGateway();
    refundReply = () => "failed";
    const res = await refund(declined.returnRequest._id);
    const after = await freshReturn(declined.returnRequest._id);
    const order = await freshOrder(declined.order._id);
    ok("502 GATEWAY_REFUND_REJECTED", res.statusCode === 502 && res.body?.code === "GATEWAY_REFUND_REJECTED",
      `${res.statusCode} ${JSON.stringify(res.body)}`);
    ok("the return is back at received, with no refundedAt",
      after.status === "received" && !after.refundedAt, `${after.status} ${after.refundedAt}`);
    ok("the ledger row is failed", rowsFor(order, declined.returnRequest._id).every((r) => r.status === "failed") &&
      rowsFor(order, declined.returnRequest._id).length === 1, JSON.stringify(rowsFor(order, declined.returnRequest._id)));
    ok("the order is not marked refunded", order.paymentStatus === "Paid", order.paymentStatus);
    ok("nothing told the customer they were refunded",
      (await events("refund.processed", declined.order._id)) === 0 &&
        (await events("refund.initiated", declined.order._id)) === 0);
    ok("no restock or disposition was recorded", !after.restockedAt && after.disposition === "",
      JSON.stringify({ r: after.restockedAt, d: after.disposition }));
  }

  section("2 — retried, Razorpay processes it");
  {
    resetGateway();
    refundReply = () => "processed";
    const res = await refund(declined.returnRequest._id);
    const after = await freshReturn(declined.returnRequest._id);
    const order = await freshOrder(declined.order._id);
    const rows = rowsFor(order, declined.returnRequest._id);
    ok("200", res.statusCode === 200, `${res.statusCode} ${JSON.stringify(res.body?.message)}`);
    ok("the retry made a new gateway call", calls.refund.length === 1, String(calls.refund.length));
    ok("the return is refunded", after.status === "refunded" && Boolean(after.refundedAt), after.status);
    ok("a new processed row beside the failed one",
      rows.filter((r) => r.status === "processed").length === 1 && rows.filter((r) => r.status === "failed").length === 1,
      JSON.stringify(rows.map((r) => r.status)));
    ok("response says processed", res.body?.refundStatus === "processed" && res.body?.pending === false,
      JSON.stringify({ s: res.body?.refundStatus, p: res.body?.pending }));
    ok("exactly one refund.processed notification",
      (await events("refund.processed", declined.order._id)) === 1, String(await events("refund.processed", declined.order._id)));
    ok("and no refund.initiated", (await events("refund.initiated", declined.order._id)) === 0);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("3 — Razorpay accepts but has not settled (pending)");
  {
    const pending = await receivedReturn();
    resetGateway();
    refundReply = () => "pending";
    const res = await refund(pending.returnRequest._id);
    const after = await freshReturn(pending.returnRequest._id);
    const order = await freshOrder(pending.order._id);
    const rows = rowsFor(order, pending.returnRequest._id);
    ok("200", res.statusCode === 200, `${res.statusCode} ${JSON.stringify(res.body)}`);
    ok("the return reads refunded", after.status === "refunded", after.status);
    ok("the ledger row stays created, with the refund id",
      rows.length === 1 && rows[0].status === "created" && /^rfnd_/.test(rows[0].providerRefundId || ""),
      JSON.stringify(rows));
    ok("the response says it is pending", res.body?.refundStatus === "created" && res.body?.pending === true,
      JSON.stringify({ s: res.body?.refundStatus, p: res.body?.pending }));
    ok("and the message tells the operator", /5–7 working days/.test(res.body?.message || ""), res.body?.message);
    ok("only refund.initiated is sent",
      (await events("refund.initiated", pending.order._id)) === 1 &&
        (await events("refund.processed", pending.order._id)) === 0,
      JSON.stringify({
        initiated: await events("refund.initiated", pending.order._id),
        processed: await events("refund.processed", pending.order._id),
      }));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("4 — a manual (COD) refund is processed on the spot");
  {
    const cod = await receivedReturn({ paymentMethod: "COD" });
    resetGateway();
    const res = await refund(cod.returnRequest._id, { refundMethod: "upi", refundReference: `UTR-${MARKER}` });
    const after = await freshReturn(cod.returnRequest._id);
    ok("200", res.statusCode === 200, `${res.statusCode} ${JSON.stringify(res.body)}`);
    ok("refunded, with no gateway call", after.status === "refunded" && calls.refund.length === 0);
    ok("response says processed", res.body?.refundStatus === "processed");
    ok("refund.processed once, no refund.initiated",
      (await events("refund.processed", cod.order._id)) === 1 && (await events("refund.initiated", cod.order._id)) === 0);

    const missing = await receivedReturn({ paymentMethod: "COD" });
    const refused = await refund(missing.returnRequest._id);
    ok("without a reference: 400 and back at received",
      refused.statusCode === 400 && (await freshReturn(missing.returnRequest._id)).status === "received",
      `${refused.statusCode} ${refused.body?.code}`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("5 — the rollback is a compare-and-swap");
  {
    const raced = await receivedReturn();
    resetGateway();
    // While the gateway call is in flight, something else moves the return on. The
    // failed refund's rollback must not drag it back to received.
    duringRefund = async () => {
      await ReturnModel.updateOne(
        { _id: raced.returnRequest._id },
        { $set: { status: "rejected" } },
      );
    };
    refundReply = () => "failed";
    const res = await refund(raced.returnRequest._id);
    const after = await freshReturn(raced.returnRequest._id);
    ok("the refund still reports the rejection", res.statusCode === 502, `${res.statusCode}`);
    ok("and the concurrent status is left alone", after.status === "rejected", after.status);
  }
} catch (error) {
  console.error(`\nSUITE ABORTED: ${error?.stack || error}`);
  ok("suite ran to completion", false, error?.message);
} finally {
  await ReturnModel.deleteMany({ _id: { $in: trash.returns } });
  await NotificationEvent.deleteMany({ order: { $in: trash.orders } });
  await OrderModel.deleteMany({ _id: { $in: trash.orders } });
  await ProductModel.deleteMany({ _id: { $in: trash.products } });
  const { failed } = finish();
  await mongoose.disconnect();
  process.exit(failed ? 1 : 0);
}
