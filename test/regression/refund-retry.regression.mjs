/**
 * ReconcileOrderRefund: retrying a FAILED refund, reconciling keyless rows, and
 * answering by what Razorpay actually said.
 *
 * Before this, a `failed` refund row had no way forward at all — the reconcile
 * endpoint handed it to settleGatewayRefund, which (rightly) never revives a failed
 * row — and every row without a reconciliation key, which includes every return
 * refund, was refused with REFUND_NOT_RECONCILABLE even when Razorpay could be asked
 * about it by its refund id or its returnNumber.
 *
 * What is asserted:
 *   - a failed row is retried as a NEW row keyed `retry:<failedRowId>`, carrying the
 *     same reason, with exactly one gateway call; the failed row stays failed;
 *   - concurrent retries make one gateway call and one row;
 *   - the order-total ceiling still applies to a retry;
 *   - an RTO row's retry keeps the `RTO <orderId>` reason, so the RTO obligation is
 *     not recorded a second time;
 *   - a failed RETURN row already re-issued elsewhere is refused (409), and so is
 *     a row whose money was re-sent through the generic Refund form;
 *   - every retry in a chain carries the ROOT's key, so retrying a failed retry
 *     after another link settled adopts that link — one payout, never two;
 *   - a live row for the return blocks the retry claim and the returns-flow push
 *     in their filters, not only in a read;
 *   - a keyless `created` return row is adopted by returnNumber, never re-refunded;
 *   - a keyless row with a Razorpay refund id is looked up by that id;
 *   - responses follow refundStatus: processed 200, pending 200 + pending:true,
 *     failed 502 GATEWAY_REFUND_REJECTED;
 *   - order responses carry refunds[].idempotencyKey (the admin UI hides "Retry
 *     refund" once a live `retry:<id>` row exists).
 *
 * Run with `node test/regression/refund-retry.regression.mjs` (or `npm test`).
 *
 * Controllers are called directly. The Razorpay SDK is stubbed on its cached
 * instance; `globalThis.fetch` throws on any call. Nothing leaves the machine.
 */
process.env.PAYMENTS_ENABLED = "true";
process.env.PAYMENT_PROVIDER = "razorpay";
process.env.RAZORPAY_KEY_ID = "rzp_test_stub0000000";
process.env.RAZORPAY_KEY_SECRET = "stub_secret_for_tests";
process.env.INVENTORY_ENFORCE_STOCK = "false";
process.env.NOTIFICATIONS_ENABLED = "false";
process.env.SHIPROCKET_ENABLED = "false";
process.env.SHIPROCKET_BASE_URL = "https://shiprocket.invalid/v1/external";

import mongoose from "mongoose";
import { connect, createSuite, marker, productFixture, addressFixture } from "./helpers.mjs";

const { ok, section, finish } = createSuite("refund-retry");
await connect();

const OrderModel = (await import("../../src/modules/orders/Order.model.js")).default;
const ProductModel = (await import("../../src/modules/products/Product.model.js")).default;
const ReturnModel = (await import("../../src/modules/returns/return.model.js")).default;
const NotificationEvent = (await import("../../src/model/NotificationEvent.model.js")).default;
await import("../../src/modules/categories/Category.model.js");
const orderController = await import("../../src/modules/orders/order.controller.js");
const { claimRefundSlot, recordRtoRefundObligation, refundReturnRequest, sumRefunded } = await import(
  "../../src/modules/payments/return-refund.service.js"
);
const razorpayService = await import("../../src/modules/payments/razorpay.service.js");

await OrderModel.init();

// ── Razorpay stub ───────────────────────────────────────────────────────────
// Slow on purpose: concurrent retries must all be in flight at once, or the
// "exactly one gateway call" assertion proves nothing.
const gateway = { refunds: [], listed: [], fetched: [], replyStatus: "processed", delayMs: 60 };
const { razorpay: sharedRazorpay } = razorpayService.getRazorpay();
sharedRazorpay.payments.refund = async (paymentId, options) => {
  gateway.refunds.push({ paymentId, options });
  await new Promise((resolve) => setTimeout(resolve, gateway.delayMs));
  return {
    id: `rfnd_retry_${process.pid}_${gateway.refunds.length}_${Date.now()}`,
    status: gateway.replyStatus,
    ...(gateway.replyStatus === "failed" ? { error_description: "Bank rejected the refund" } : {}),
  };
};
sharedRazorpay.payments.fetchMultipleRefund = async () => ({ items: gateway.listed });
sharedRazorpay.payments.fetchRefund = async (paymentId, refundId) => {
  gateway.fetched.push(refundId);
  return { id: refundId, payment_id: paymentId, status: "processed" };
};
const resetGateway = ({ replyStatus = "processed", listed = [] } = {}) => {
  gateway.refunds = [];
  gateway.fetched = [];
  gateway.listed = listed;
  gateway.replyStatus = replyStatus;
};

const originalFetch = globalThis.fetch;
globalThis.fetch = async (input) => {
  throw new Error(`Unexpected outbound call in tests: ${String(input instanceof URL ? input.href : input)}`);
};

const MARKER = marker("refundretry");
const trash = { orders: [], products: [], returns: [] };
let seq = 0;

const product = await ProductModel.create(productFixture(`${MARKER}-book`, { price: 400, stock: 50 }));
trash.products.push(product._id);

const makeOrder = async ({
  paymentMethod = "RAZORPAY",
  paymentStatus = "Paid",
  orderStatus = "Cancelled",
  totalAmount = 400,
  refunds = [],
} = {}) => {
  seq += 1;
  const order = await OrderModel.create({
    user: new mongoose.Types.ObjectId(),
    items: [{ product: product._id, name: product.name, image: "x.png", price: totalAmount, quantity: 1 }],
    shippingAddress: addressFixture(),
    paymentMethod,
    paymentStatus,
    orderStatus,
    subtotal: totalAmount,
    totalAmount,
    ...(paymentMethod === "RAZORPAY" ? { razorpayPaymentId: `pay_${MARKER}_${seq}` } : {}),
    refunds,
  });
  trash.orders.push(order._id);
  return order;
};

const failedRow = (overrides = {}) => ({
  _id: new mongoose.Types.ObjectId(),
  paymentProvider: "razorpay",
  amount: 400,
  reason: "Order cancelled by customer — Changed my mind",
  status: "failed",
  idempotencyKey: `cancel:${new mongoose.Types.ObjectId()}`,
  providerRefundId: `rfnd_failed_${MARKER}_${new mongoose.Types.ObjectId()}`,
  failureReason: "Bank rejected the refund",
  confirmationMethod: "gateway",
  ...overrides,
});

const callController = async (handler, { params = {}, body = {}, user, query = {} }) => {
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
  await handler({ params, body, user, query, headers: {}, get: () => undefined }, res);
  return { statusCode, body: payload };
};

const admin = () => ({ id: String(new mongoose.Types.ObjectId()), roles: ["admin"] });
const reconcile = (orderId, refundId) =>
  callController(orderController.ReconcileOrderRefund, {
    params: { orderId: String(orderId), refundId: String(refundId) },
    user: admin(),
  });
const fresh = (id) => OrderModel.findById(id);
const notifications = (orderId, event) => NotificationEvent.countDocuments({ order: orderId, event });

try {
  // ═══════════════════════════════════════════════════════════════════════════
  section("a failed row is retried as a NEW row keyed retry:<id>");

  {
    resetGateway();
    const original = failedRow();
    const order = await makeOrder({ refunds: [original] });

    const response = await reconcile(order._id, original._id);
    ok("the retry succeeds", response.statusCode === 200, `${response.statusCode} ${response.body?.message}`);
    ok("exactly one gateway refund call", gateway.refunds.length === 1, String(gateway.refunds.length));
    ok(
      "for the failed row's amount, in paise",
      gateway.refunds[0]?.options?.amount === 40000,
      String(gateway.refunds[0]?.options?.amount),
    );
    ok(
      "tagged with the retry key in notes.refundKey",
      gateway.refunds[0]?.options?.notes?.refundKey === `retry:${original._id}`,
      JSON.stringify(gateway.refunds[0]?.options?.notes),
    );

    const after = await fresh(order._id);
    const retry = after.refunds.find((row) => row.idempotencyKey === `retry:${original._id}`);
    ok("a second row exists", after.refunds.length === 2, String(after.refunds.length));
    ok("it is the retry row", Boolean(retry));
    ok("processed", retry?.status === "processed", retry?.status);
    ok("carrying the SAME reason", retry?.reason === original.reason, retry?.reason);
    ok("the failed row stays failed (history kept)", after.refunds.id(original._id)?.status === "failed",
      after.refunds.id(original._id)?.status);
    ok("the order is Refunded", after.paymentStatus === "Refunded", after.paymentStatus);
    ok("the response says processed", response.body?.refundStatus === "processed", response.body?.refundStatus);
    ok(
      "the response's order carries refunds[].idempotencyKey",
      (response.body?.order?.refunds || []).some((row) => row.idempotencyKey === `retry:${original._id}`),
    );
    ok("the customer is told it was processed", (await notifications(order._id, "refund.processed")) === 1);

    resetGateway();
    const again = await reconcile(order._id, original._id);
    ok("retrying again is idempotent (200)", again.statusCode === 200 && again.body?.idempotent === true,
      `${again.statusCode} ${again.body?.message}`);
    ok("and makes no gateway call", gateway.refunds.length === 0, String(gateway.refunds.length));
    ok("and adds no row", (await fresh(order._id)).refunds.length === 2);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("concurrent retries make one gateway call");

  {
    resetGateway();
    const original = failedRow();
    const order = await makeOrder({ refunds: [original] });
    const responses = await Promise.all([1, 2, 3, 4].map(() => reconcile(order._id, original._id)));
    ok("exactly one gateway refund call", gateway.refunds.length === 1, String(gateway.refunds.length));
    const after = await fresh(order._id);
    const retries = after.refunds.filter((row) => row.idempotencyKey === `retry:${original._id}`);
    ok("exactly one retry row", retries.length === 1, String(retries.length));
    ok("one request reports success", responses.some((r) => r.statusCode === 200));
    ok(
      "the losers are told it is in progress or already settled — never a second refund",
      responses.every((r) => r.statusCode === 200 || r.body?.code === "REFUND_IN_PROGRESS"),
      responses.map((r) => `${r.statusCode}:${r.body?.code || ""}`).join(","),
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("the order-total ceiling still applies to a retry");

  {
    resetGateway();
    const original = failedRow();
    // A later refund already committed 300 of the 400: a full 400 retry would
    // refund 700 against a 400 order.
    const order = await makeOrder({
      refunds: [
        original,
        {
          paymentProvider: "razorpay",
          amount: 300,
          reason: "Later partial refund",
          status: "processed",
          idempotencyKey: `later:${MARKER}:${seq}`,
          providerRefundId: `rfnd_later_${MARKER}_${seq}`,
        },
      ],
      paymentStatus: "Partially Refunded",
    });
    const response = await reconcile(order._id, original._id);
    ok("refused with 400 REFUND_EXCEEDS_ORDER_TOTAL",
      response.statusCode === 400 && response.body?.code === "REFUND_EXCEEDS_ORDER_TOTAL",
      `${response.statusCode} ${response.body?.code}`);
    ok("no gateway call", gateway.refunds.length === 0, String(gateway.refunds.length));
    ok("no row added", (await fresh(order._id)).refunds.length === 2);
    ok("committed stays within the total", sumRefunded(await fresh(order._id)) <= 400);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("an RTO row's retry keeps its reason, so the obligation is not re-recorded");

  {
    resetGateway();
    const order = await makeOrder({ orderStatus: "RTO Received" });
    const original = failedRow({ reason: `RTO ${order._id}`, idempotencyKey: `owed:${new mongoose.Types.ObjectId()}` });
    await OrderModel.updateOne({ _id: order._id }, { $push: { refunds: original } });

    const response = await reconcile(order._id, original._id);
    ok("the retry succeeds", response.statusCode === 200, `${response.statusCode} ${response.body?.message}`);
    const after = await fresh(order._id);
    const retry = after.refunds.find((row) => row.idempotencyKey === `retry:${original._id}`);
    ok("the retry row carries the RTO reason", retry?.reason === `RTO ${order._id}`, retry?.reason);

    const replay = await recordRtoRefundObligation(after);
    ok("a replayed RTO arrival records no second obligation", !replay.owed, JSON.stringify(replay));
    ok("still two rows", (await fresh(order._id)).refunds.length === 2);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("responses follow what Razorpay said");

  {
    resetGateway({ replyStatus: "pending" });
    const original = failedRow();
    const order = await makeOrder({ refunds: [original] });
    const response = await reconcile(order._id, original._id);
    ok("a pending reply is a 200", response.statusCode === 200, `${response.statusCode} ${response.body?.message}`);
    ok("with pending: true", response.body?.pending === true);
    ok("and a human-readable message", /Razorpay/.test(String(response.body?.message || "")), response.body?.message);
    const retry = (await fresh(order._id)).refunds.find((row) => row.idempotencyKey === `retry:${original._id}`);
    ok("the retry row is created (accepted, not settled)", retry?.status === "created", retry?.status);
    ok("the order is Refund Pending, not Refunded", (await fresh(order._id)).paymentStatus === "Refund Pending");
    ok("the customer is told it was initiated", (await notifications(order._id, "refund.initiated")) === 1);
    ok("and NOT that it was processed", (await notifications(order._id, "refund.processed")) === 0);
  }

  {
    resetGateway({ replyStatus: "failed" });
    const original = failedRow();
    const order = await makeOrder({ refunds: [original] });
    const response = await reconcile(order._id, original._id);
    ok("a failed reply is 502 GATEWAY_REFUND_REJECTED",
      response.statusCode === 502 && response.body?.code === "GATEWAY_REFUND_REJECTED",
      `${response.statusCode} ${response.body?.code}`);
    ok("including the order", Boolean(response.body?.order?._id));
    const afterReject = await fresh(order._id);
    ok("both rows are failed", afterReject.refunds.every((row) => row.status === "failed"),
      afterReject.refunds.map((row) => row.status).join(","));
    ok("the order is back at Paid — nothing moved", afterReject.paymentStatus === "Paid", afterReject.paymentStatus);
    ok("no refund notice", (await notifications(order._id, "refund.processed")) +
      (await notifications(order._id, "refund.initiated")) === 0);

    resetGateway({ replyStatus: "processed" });
    const retryAgain = await reconcile(order._id, original._id);
    ok("the original can be retried again once the problem is fixed", retryAgain.statusCode === 200,
      `${retryAgain.statusCode} ${retryAgain.body?.message}`);
    const final = await fresh(order._id);
    ok("one live retry row now", final.refunds.filter((row) => row.status !== "failed").length === 1);
    ok("and the order is Refunded", final.paymentStatus === "Refunded", final.paymentStatus);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("a retry chain shares one key — no double payout across its links");

  {
    // A fails → retry R1 fails → retry A again succeeds (R2) → retry R1. R1's retry
    // used to be keyed `retry:<R1>`, a key no live row carried, so it paid again.
    // Headroom on purpose (₹400 of ₹800): the order-total ceiling must not be what
    // stops the second payout.
    resetGateway({ replyStatus: "failed" });
    const original = failedRow();
    const order = await makeOrder({ totalAmount: 800, refunds: [original] });
    const chainKey = `retry:${original._id}`;

    const first = await reconcile(order._id, original._id);
    ok("retry R1 is declined (502)", first.statusCode === 502, `${first.statusCode} ${first.body?.code}`);
    const r1 = (await fresh(order._id)).refunds.find((row) => row.idempotencyKey === chainKey);
    ok("R1 carries the chain key and is failed", r1?.status === "failed", r1?.status);

    resetGateway({ replyStatus: "processed" });
    const second = await reconcile(order._id, original._id);
    ok("retrying A again succeeds (R2)", second.statusCode === 200, `${second.statusCode} ${second.body?.message}`);
    ok("one gateway call for R2", gateway.refunds.length === 1, String(gateway.refunds.length));

    resetGateway({ replyStatus: "processed" });
    const third = await reconcile(order._id, r1._id);
    ok(
      "retrying R1 adopts the chain's settled row (200 idempotent) — or is refused",
      (third.statusCode === 200 && third.body?.idempotent === true) ||
        third.body?.code === "REFUND_ALREADY_REISSUED",
      `${third.statusCode} ${third.body?.code} ${third.body?.message}`,
    );
    ok("and makes NO gateway call", gateway.refunds.length === 0, String(gateway.refunds.length));
    const after = await fresh(order._id);
    ok("exactly one successful payout on the order",
      after.refunds.filter((row) => row.status === "processed").length === 1,
      after.refunds.map((row) => `${row.status}:${row.idempotencyKey}`).join(","));
    ok("every retry row carries the root's key",
      after.refunds.filter((row) => row !== after.refunds.id(original._id)).every((row) => row.idempotencyKey === chainKey));
    ok("₹400 committed — the failed refund's amount, once", sumRefunded(after) === 400, String(sumRefunded(after)));
  }

  {
    // A chain whose every link failed can still be retried from any link: the new
    // row carries the root's key, and failed rows never block it.
    resetGateway({ replyStatus: "failed" });
    const original = failedRow();
    const order = await makeOrder({ refunds: [original] });
    await reconcile(order._id, original._id);
    const r1 = (await fresh(order._id)).refunds.find((row) => row.idempotencyKey === `retry:${original._id}`);
    resetGateway({ replyStatus: "processed" });
    const response = await reconcile(order._id, r1._id);
    ok("retrying a failed retry row succeeds", response.statusCode === 200, `${response.statusCode} ${response.body?.message}`);
    ok("tagged with the ROOT's key", gateway.refunds[0]?.options?.notes?.refundKey === `retry:${original._id}`,
      JSON.stringify(gateway.refunds[0]?.options?.notes));
    const after = await fresh(order._id);
    ok("three rows: A, R1 failed and the live retry", after.refunds.length === 3, String(after.refunds.length));
  }

  section("a refund re-sent through the generic Refund form is not retried again");

  {
    resetGateway();
    const original = failedRow({ reason: "Admin refund", idempotencyKey: `auto:${new mongoose.Types.ObjectId()}` });
    const order = await makeOrder({
      totalAmount: 800,
      paymentStatus: "Partially Refunded",
      refunds: [
        original,
        {
          paymentProvider: "razorpay",
          amount: 400,
          reason: "Admin refund",
          status: "processed",
          idempotencyKey: `admin-ui-${MARKER}-${seq}`,
          providerRefundId: `rfnd_resent_${MARKER}_${seq}`,
        },
      ],
    });
    const response = await reconcile(order._id, original._id);
    ok("refused with 409 REFUND_ALREADY_REISSUED",
      response.statusCode === 409 && response.body?.code === "REFUND_ALREADY_REISSUED",
      `${response.statusCode} ${response.body?.code}`);
    ok("no gateway call", gateway.refunds.length === 0);
    ok("no row added", (await fresh(order._id)).refunds.length === 2);
  }

  {
    // Two partial cancellations of the same value are two refunds: a settled one
    // does not make the failed one a duplicate.
    resetGateway();
    const original = failedRow({
      reason: "Partial cancellation",
      idempotencyKey: `partial-cancel:${new mongoose.Types.ObjectId()}`,
    });
    const order = await makeOrder({
      totalAmount: 800,
      paymentStatus: "Partially Refunded",
      refunds: [
        original,
        {
          paymentProvider: "razorpay",
          amount: 400,
          reason: "Partial cancellation",
          status: "processed",
          idempotencyKey: `partial-cancel:${new mongoose.Types.ObjectId()}`,
          providerRefundId: `rfnd_pc_${MARKER}_${seq}`,
        },
      ],
    });
    const response = await reconcile(order._id, original._id);
    ok("a separate partial cancellation is not a reissue (200)", response.statusCode === 200,
      `${response.statusCode} ${response.body?.code} ${response.body?.message}`);
    ok("one gateway call", gateway.refunds.length === 1, String(gateway.refunds.length));
  }

  section("a live row for the return blocks the claim itself");

  {
    // The handler's ledger read can be stale; the claim's filter is what holds.
    const returnId = new mongoose.Types.ObjectId();
    const order = await makeOrder({
      orderStatus: "Delivered",
      totalAmount: 800,
      paymentStatus: "Refund Pending",
      refunds: [
        {
          paymentProvider: "razorpay",
          amount: 400,
          reason: "Return RET-LIVE",
          status: "created",
          returnRequest: returnId,
        },
      ],
    });
    let refused = null;
    try {
      await claimRefundSlot({
        orderId: order._id,
        idempotencyKey: `retry:${new mongoose.Types.ObjectId()}`,
        amount: 400,
        blockIfLiveForReturn: returnId,
        record: { returnRequest: returnId, reason: "Return RET-LIVE", status: "created" },
      });
    } catch (error) {
      refused = error;
    }
    ok("refused with REFUND_ALREADY_REISSUED", refused?.code === "REFUND_ALREADY_REISSUED", refused?.code);
    ok("no row added", (await fresh(order._id)).refunds.length === 1);
  }

  {
    // The Returns page working from a stale order document: the push is
    // conditional, so a row that landed meanwhile is adopted, never duplicated.
    resetGateway();
    const returnId = new mongoose.Types.ObjectId();
    const order = await makeOrder({ orderStatus: "Delivered", totalAmount: 800 });
    const stale = await fresh(order._id);
    await OrderModel.updateOne(
      { _id: order._id },
      {
        $push: {
          refunds: {
            paymentProvider: "razorpay",
            amount: 400,
            reason: "Return RET-RACE",
            status: "processed",
            returnRequest: returnId,
            providerRefundId: `rfnd_race_${MARKER}`,
          },
        },
        $set: { paymentStatus: "Partially Refunded" },
      },
    );
    const result = await refundReturnRequest({
      order: stale,
      returnRequest: { _id: returnId, returnNumber: "RET-RACE", refundAmount: 400 },
      adminId: new mongoose.Types.ObjectId(),
    });
    ok("the settled row is handed back", result.alreadyRefunded === true && result.refundStatus === "processed",
      JSON.stringify({ a: result.alreadyRefunded, s: result.refundStatus }));
    ok("marked notified, so the caller sends no second notice", result.notified === true);
    ok("no gateway call", gateway.refunds.length === 0, String(gateway.refunds.length));
    ok("no second row", (await fresh(order._id)).refunds.length === 1);

    // The same return refunded again from an up-to-date document: the settled row
    // is found up front, and the customer — told when it settled — is not told again.
    const again = await refundReturnRequest({
      order: await fresh(order._id),
      returnRequest: { _id: returnId, returnNumber: "RET-RACE", refundAmount: 400 },
      adminId: new mongoose.Types.ObjectId(),
    });
    ok("an already-refunded return reports notified: true",
      again.alreadyRefunded === true && again.notified === true, JSON.stringify({ a: again.alreadyRefunded, n: again.notified }));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("return rows");

  {
    // A return already re-refunded through the returns flow: retrying the failed
    // row too would refund the return twice.
    resetGateway();
    const returnId = new mongoose.Types.ObjectId();
    const original = failedRow({ returnRequest: returnId, idempotencyKey: undefined, reason: "Return RET-X" });
    const order = await makeOrder({
      orderStatus: "Delivered",
      totalAmount: 800,
      refunds: [
        original,
        {
          paymentProvider: "razorpay",
          amount: 400,
          reason: "Return RET-X",
          status: "processed",
          returnRequest: returnId,
          providerRefundId: `rfnd_reissued_${MARKER}`,
        },
      ],
      paymentStatus: "Partially Refunded",
    });
    const response = await reconcile(order._id, original._id);
    ok("refused with 409 REFUND_ALREADY_REISSUED",
      response.statusCode === 409 && response.body?.code === "REFUND_ALREADY_REISSUED",
      `${response.statusCode} ${response.body?.code}`);
    ok("no gateway call", gateway.refunds.length === 0);
  }

  {
    // A keyless `created` return row whose gateway refund DID land: adopted by its
    // returnNumber, never refunded again.
    const returnNumber = `RET-${MARKER}-${seq}`;
    const returnId = new mongoose.Types.ObjectId();
    await ReturnModel.collection.insertOne({
      _id: returnId,
      returnNumber,
      status: "refunded",
      order: new mongoose.Types.ObjectId(),
      product: new mongoose.Types.ObjectId(),
      user: new mongoose.Types.ObjectId(),
    });
    trash.returns.push(returnId);
    const order = await makeOrder({ orderStatus: "Delivered", paymentStatus: "Refund Pending" });
    const row = {
      _id: new mongoose.Types.ObjectId(),
      paymentProvider: "razorpay",
      amount: 400,
      reason: `Return ${returnNumber}`,
      status: "created",
      returnRequest: returnId,
      gatewayAttemptedAt: new Date(Date.now() - 10 * 60 * 1000),
      failureReason: "Request timed out",
    };
    await OrderModel.updateOne({ _id: order._id }, { $push: { refunds: row } });
    resetGateway({
      listed: [
        { id: `rfnd_landed_${MARKER}`, status: "processed", notes: { returnNumber } },
        { id: `rfnd_other_${MARKER}`, status: "processed", notes: { returnNumber: "RET-SOMEONE-ELSE" } },
      ],
    });

    const response = await reconcile(order._id, row._id);
    ok("the keyless return row is reconcilable (200)", response.statusCode === 200,
      `${response.statusCode} ${response.body?.code} ${response.body?.message}`);
    ok("reported as reconciled", response.body?.reconciled === true);
    ok("NO new gateway refund", gateway.refunds.length === 0, String(gateway.refunds.length));
    const adopted = (await fresh(order._id)).refunds.id(row._id);
    ok("the row adopted the matching Razorpay refund", adopted?.providerRefundId === `rfnd_landed_${MARKER}`,
      adopted?.providerRefundId);
    ok("and is processed", adopted?.status === "processed", adopted?.status);
  }

  {
    // Same shape, but nothing landed at Razorpay: the refund is issued, tagged with
    // the returnNumber so a later lookup can find it.
    const returnNumber = `RET-${MARKER}-absent`;
    const returnId = new mongoose.Types.ObjectId();
    await ReturnModel.collection.insertOne({
      _id: returnId,
      returnNumber,
      status: "refunded",
      order: new mongoose.Types.ObjectId(),
      product: new mongoose.Types.ObjectId(),
      user: new mongoose.Types.ObjectId(),
    });
    trash.returns.push(returnId);
    const order = await makeOrder({ orderStatus: "Delivered", paymentStatus: "Refund Pending" });
    const row = {
      _id: new mongoose.Types.ObjectId(),
      paymentProvider: "razorpay",
      amount: 400,
      reason: `Return ${returnNumber}`,
      status: "created",
      returnRequest: returnId,
    };
    await OrderModel.updateOne({ _id: order._id }, { $push: { refunds: row } });
    resetGateway({ listed: [] });
    const response = await reconcile(order._id, row._id);
    ok("issued after confirming absence (200)", response.statusCode === 200,
      `${response.statusCode} ${response.body?.message}`);
    ok("exactly one gateway call", gateway.refunds.length === 1, String(gateway.refunds.length));
    ok("tagged with notes.returnNumber", gateway.refunds[0]?.options?.notes?.returnNumber === returnNumber,
      JSON.stringify(gateway.refunds[0]?.options?.notes));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("other keyless rows");

  {
    // Accepted by Razorpay (has a refund id) but never settled locally: looked up
    // by that id, never re-sent.
    resetGateway();
    const order = await makeOrder({ paymentStatus: "Refund Pending" });
    const row = {
      _id: new mongoose.Types.ObjectId(),
      paymentProvider: "razorpay",
      amount: 400,
      reason: "Legacy refund",
      status: "created",
      providerRefundId: `rfnd_accepted_${MARKER}`,
    };
    await OrderModel.updateOne({ _id: order._id }, { $push: { refunds: row } });
    const response = await reconcile(order._id, row._id);
    ok("a keyless row with a refund id reconciles (200)", response.statusCode === 200,
      `${response.statusCode} ${response.body?.code} ${response.body?.message}`);
    ok("looked up by that id", gateway.fetched.includes(`rfnd_accepted_${MARKER}`), JSON.stringify(gateway.fetched));
    ok("no new refund", gateway.refunds.length === 0);
    ok("the row is processed", (await fresh(order._id)).refunds.id(row._id)?.status === "processed");
  }

  {
    resetGateway();
    const order = await makeOrder({ paymentStatus: "Refund Pending" });
    const row = {
      _id: new mongoose.Types.ObjectId(),
      paymentProvider: "razorpay",
      amount: 400,
      reason: "Ancient refund",
      status: "created",
    };
    await OrderModel.updateOne({ _id: order._id }, { $push: { refunds: row } });
    const response = await reconcile(order._id, row._id);
    ok("a keyless row with nothing to match on is still refused (409 REFUND_NOT_RECONCILABLE)",
      response.statusCode === 409 && response.body?.code === "REFUND_NOT_RECONCILABLE",
      `${response.statusCode} ${response.body?.code}`);
    ok("no gateway call", gateway.refunds.length === 0);
  }

  {
    resetGateway();
    const original = failedRow({ paymentProvider: "manual", confirmationMethod: "manual" });
    const order = await makeOrder({ paymentMethod: "COD", refunds: [original] });
    const response = await reconcile(order._id, original._id);
    ok("a failed row on a COD order is MANUAL_REFUND_ONLY (400)",
      response.statusCode === 400 && response.body?.code === "MANUAL_REFUND_ONLY",
      `${response.statusCode} ${response.body?.code}`);
    ok("no row added", (await fresh(order._id)).refunds.length === 1);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("an owed row paid with a pending reply");

  {
    resetGateway({ replyStatus: "pending" });
    const order = await makeOrder({ orderStatus: "RTO Received" });
    const row = {
      _id: new mongoose.Types.ObjectId(),
      paymentProvider: "razorpay",
      amount: 400,
      reason: `RTO ${order._id}`,
      status: "owed",
      confirmationMethod: "gateway",
    };
    await OrderModel.updateOne(
      { _id: order._id },
      { $push: { refunds: row }, $set: { paymentStatus: "Refund Pending" } },
    );
    const response = await reconcile(order._id, row._id);
    ok("200 with pending: true", response.statusCode === 200 && response.body?.pending === true,
      `${response.statusCode} ${response.body?.pending} ${response.body?.message}`);
    const paid = (await fresh(order._id)).refunds.id(row._id);
    ok("the row is created, with Razorpay's refund id", paid?.status === "created" && Boolean(paid?.providerRefundId),
      `${paid?.status} ${paid?.providerRefundId}`);
    ok("refund.initiated was queued", (await notifications(order._id, "refund.initiated")) === 1);
  }
} catch (error) {
  console.error(`\nSUITE ABORTED: ${error?.stack || error}`);
  ok("suite ran to completion", false, error?.message);
} finally {
  globalThis.fetch = originalFetch;
  await OrderModel.deleteMany({ _id: { $in: trash.orders } });
  await ProductModel.deleteMany({ _id: { $in: trash.products } });
  await ReturnModel.collection.deleteMany({ _id: { $in: trash.returns } });
  await NotificationEvent.deleteMany({ order: { $in: trash.orders } });
  const { failed } = finish();
  await mongoose.disconnect();
  process.exit(failed ? 1 : 0);
}
