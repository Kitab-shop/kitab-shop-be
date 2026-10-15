/**
 * Refund-ledger sync regression: a Razorpay refund is only `processed` when the
 * money has moved.
 *
 * Until this fix ANY refund reply other than `failed` — `pending` included, which
 * is what every normal-speed refund replies with — was recorded as `processed`, so
 * orders read "Refunded" and the customer was told so before any money moved.
 * This suite covers the replacement end to end:
 *
 *   1. the status mapping;
 *   2. the settle guard (a late reply cannot drag a settled row backwards);
 *   3. the poller that finishes `created` rows (never issues a refund);
 *   4. the refund webhook resolver, including its fallbacks for rows whose
 *      reply never arrived and for orphaned-capture refunds;
 *   5. the return refund flow through refundReturnRequest;
 *   6. the webhook beating the synchronous reply: the row is settled (and the
 *      customer told) by the webhook before the reply is written, and nobody
 *      sends a second "refund processed";
 *   7. settlement side effects: a received return closes when its refund settles,
 *      concurrent settlements derive paymentStatus by CAS, a backfill-marked row
 *      settles silently, and a refund that fails is logged as an error and listed
 *      as owed until something replaces it.
 *
 * Same shape as refund-safety: the database is real, only Razorpay is stubbed,
 * and each stub counts its calls. Notifications are counted as NotificationEvent
 * rows (queued as `skipped`, since notifications are forced off here).
 *
 * Run with `node test/regression/refund-ledger-sync.regression.mjs`.
 */
import mongoose from "mongoose";
import { connect, createSuite, marker } from "./helpers.mjs";

process.env.PAYMENTS_ENABLED = "true";
process.env.PAYMENT_PROVIDER = "razorpay";
process.env.RAZORPAY_KEY_ID = "rzp_test_stub0000000";
process.env.RAZORPAY_KEY_SECRET = "stub_secret_for_tests";
process.env.NOTIFICATIONS_ENABLED = "false";

const { ok, section, finish } = createSuite("refund-ledger-sync");
await connect();

const OrderModel = (await import("../../src/modules/orders/Order.model.js")).default;
const ReturnModel = (await import("../../src/modules/returns/return.model.js")).default;
const UnmatchedPayment = (await import("../../src/modules/payments/UnmatchedPayment.model.js")).default;
const NotificationEvent = (await import("../../src/model/NotificationEvent.model.js")).default;
const {
  applyGatewayRefundState,
  listUnresolvedFailedRefunds,
  mapGatewayRefundStatus,
  refundReturnRequest,
  settleGatewayRefund,
  settleRefundRecord,
} = await import("../../src/modules/payments/return-refund.service.js");
const { syncPendingGatewayRefunds, applyRazorpayRefundWebhook } = await import(
  "../../src/modules/payments/refund-sync.service.js"
);
const razorpayService = await import("../../src/modules/payments/razorpay.service.js");
const paymentController = await import("../../src/modules/payments/payment.controller.js");
const AuditLog = (await import("../../src/modules/audit/AuditLog.model.js")).default;
const { AdminGetOwedRefunds } = await import("../../src/modules/payments/owed-refund.controller.js");

await OrderModel.init();
await ReturnModel.init();
await UnmatchedPayment.init();

const MARKER = marker("refundsync");
const trash = { orders: [], returns: [], unmatched: [] };
let seq = 0;

// ── Razorpay stub ───────────────────────────────────────────────────────────
const calls = { refund: [], fetchMultipleRefund: 0, fetchRefund: [] };
let refundIdSeq = 0;
const nextRefundId = () => `rfnd_${MARKER}_${++refundIdSeq}`;
let refundBehaviour = () => ({ id: nextRefundId(), status: "processed" });
let gatewayRefundsOnRecord = [];
// Keyed by refund id. A refund this suite did not create is not ours to answer
// for: the poller scans the whole collection, so anything else in the test
// database is refused rather than settled by a stub.
const gatewayState = new Map();
const failFetchFor = new Set();

const { razorpay: sharedRazorpay } = razorpayService.getRazorpay();
sharedRazorpay.payments.refund = async (paymentId, options) => {
  calls.refund.push({ paymentId, options });
  return refundBehaviour(paymentId, options);
};
sharedRazorpay.payments.fetchMultipleRefund = async () => {
  calls.fetchMultipleRefund += 1;
  return { items: gatewayRefundsOnRecord };
};
sharedRazorpay.payments.fetchRefund = async (paymentId, refundId) => {
  calls.fetchRefund.push({ paymentId, refundId });
  if (failFetchFor.has(refundId)) throw new Error("gateway unreachable");
  if (!gatewayState.has(refundId)) throw new Error(`not a ${MARKER} refund`);
  return { id: refundId, payment_id: paymentId, ...gatewayState.get(refundId) };
};

const resetGateway = () => {
  calls.refund = [];
  calls.fetchMultipleRefund = 0;
  calls.fetchRefund = [];
  gatewayRefundsOnRecord = [];
  refundBehaviour = () => ({ id: nextRefundId(), status: "processed" });
};

const makeOrder = async (fields = {}) => {
  seq += 1;
  const order = await OrderModel.create({
    user: new mongoose.Types.ObjectId(),
    items: [
      { product: new mongoose.Types.ObjectId(), name: `${MARKER}-item`, price: 1000, quantity: 1 },
    ],
    shippingAddress: {
      fullName: "Refund Sync",
      phone: "9999999999",
      address: "1 Test Street",
      city: "Pune",
      state: "Maharashtra",
      pincode: "411001",
      country: "India",
    },
    paymentMethod: "RAZORPAY",
    paymentStatus: "Paid",
    orderStatus: "Delivered",
    subtotal: 1000,
    totalAmount: 1000,
    razorpayPaymentId: `pay_${MARKER}_${seq}`,
    ...fields,
  });
  trash.orders.push(order._id);
  return order;
};

/** Pushes one refund row the way the live paths leave it, and returns it. */
const seedRow = async (order, row) => {
  const updated = await OrderModel.findOneAndUpdate(
    { _id: order._id },
    {
      $set: { paymentStatus: row.status === "processed" ? "Refunded" : "Refund Pending" },
      $push: {
        refunds: {
          paymentProvider: "razorpay",
          providerPaymentId: order.razorpayPaymentId,
          amount: 1000,
          reason: "Order cancelled",
          confirmationMethod: "gateway",
          ...row,
        },
      },
    },
    { returnDocument: "after" },
  );
  return updated.refunds.at(-1);
};

const makeReturn = async (order, fields = {}) => {
  seq += 1;
  const returnRequest = await ReturnModel.create({
    order: order._id,
    user: order.user,
    product: new mongoose.Types.ObjectId(),
    productSnapshot: { name: `${MARKER}-item`, image: "x.png", price: 1000 },
    quantity: 1,
    reason: "damaged on arrival",
    refundAmount: 1000,
    resolutionType: "refund",
    status: "received",
    returnNumber: `${MARKER}-RET-${seq}`,
    ...fields,
  });
  trash.returns.push(returnRequest._id);
  return returnRequest;
};

const rowOf = async (orderId, refundId) => (await OrderModel.findById(orderId)).refunds.id(refundId);
const notices = (orderId, event) => NotificationEvent.countDocuments({ order: orderId, event });

try {
  // ═══════════════════════════════════════════════════════════════════════════
  section("1. Gateway status mapping");

  ok("pending → created", mapGatewayRefundStatus("pending") === "created");
  ok("processed → processed", mapGatewayRefundStatus("processed") === "processed");
  ok("failed → failed", mapGatewayRefundStatus("failed") === "failed");
  ok("anything else → created", mapGatewayRefundStatus("something_new") === "created");

  // ═══════════════════════════════════════════════════════════════════════════
  section("2. Settle guard — a late reply cannot downgrade a settled row");

  {
    const order = await makeOrder();
    const row = await seedRow(order, { status: "processed", providerRefundId: nextRefundId() });
    await settleRefundRecord({ orderId: order._id, refundId: row._id, status: "created" });
    ok("a late `pending` (created) leaves a processed row processed",
      (await rowOf(order._id, row._id)).status === "processed");
    await settleRefundRecord({ orderId: order._id, refundId: row._id, status: "failed" });
    ok("a late reply cannot fail a processed row either (only the gateway EVENT may)",
      (await rowOf(order._id, row._id)).status === "processed");

    const applied = await applyGatewayRefundState({
      orderId: order._id,
      refundId: row._id,
      gatewayRefund: { id: row.providerRefundId, status: "pending" },
      source: "test",
    });
    ok("an async `pending` does not match a processed row", applied.matched === false, JSON.stringify(applied));
    ok("the order still reads Refunded", (await OrderModel.findById(order._id)).paymentStatus === "Refunded");
  }

  {
    const order = await makeOrder();
    const row = await seedRow(order, { status: "created", providerRefundId: nextRefundId() });
    const applied = await applyGatewayRefundState({
      orderId: order._id,
      refundId: row._id,
      gatewayRefund: { id: `rfnd_${MARKER}_someone_else`, status: "processed" },
      source: "test",
    });
    ok("a row is never re-pointed at a different gateway refund", applied.matched === false);
    ok("and stays created", (await rowOf(order._id, row._id)).status === "created");
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("3. Poller");

  {
    resetGateway();
    const now = new Date();
    const processedOrder = await makeOrder();
    const processedRow = await seedRow(processedOrder, { status: "created", providerRefundId: nextRefundId() });
    gatewayState.set(processedRow.providerRefundId, { status: "processed" });

    const pendingOrder = await makeOrder();
    const pendingRow = await seedRow(pendingOrder, { status: "created", providerRefundId: nextRefundId() });
    gatewayState.set(pendingRow.providerRefundId, { status: "pending" });

    const erroringOrder = await makeOrder();
    const erroringRow = await seedRow(erroringOrder, { status: "created", providerRefundId: nextRefundId() });
    failFetchFor.add(erroringRow.providerRefundId);

    // Rows the poller must NOT touch.
    const manualOrder = await makeOrder();
    const manualRow = await seedRow(manualOrder, {
      status: "created",
      providerRefundId: nextRefundId(),
      confirmationMethod: "manual",
    });
    gatewayState.set(manualRow.providerRefundId, { status: "processed" });
    const noIdOrder = await makeOrder();
    const noIdRow = await seedRow(noIdOrder, { status: "created", idempotencyKey: `k-${MARKER}-noid` });

    const first = await syncPendingGatewayRefunds({ limit: 1000, now });
    ok("the poller issues no refunds", calls.refund.length === 0, `${calls.refund.length}x`);
    ok("it settled at least our processed row", first.changed >= 1, JSON.stringify(first));
    ok("and counted the erroring row as an error", first.errors >= 1, JSON.stringify(first));

    const settled = await OrderModel.findById(processedOrder._id);
    ok("processed at Razorpay → processed in the ledger", settled.refunds.id(processedRow._id).status === "processed");
    ok("the order is Refunded", settled.paymentStatus === "Refunded", settled.paymentStatus);
    ok("the customer is told once", (await notices(processedOrder._id, "refund.processed")) === 1);

    const stillPending = await rowOf(pendingOrder._id, pendingRow._id);
    ok("pending at Razorpay → still created", stillPending.status === "created");
    ok("but stamped gatewaySyncedAt", Boolean(stillPending.gatewaySyncedAt));
    ok("no refund notice for a pending refund", (await notices(pendingOrder._id, "refund.processed")) === 0);

    ok("an error on one order did not stop the rest",
      settled.refunds.id(processedRow._id).status === "processed" && Boolean(stillPending.gatewaySyncedAt));
    ok("the erroring row is stamped too, so it rotates to the back",
      Boolean((await rowOf(erroringOrder._id, erroringRow._id)).gatewaySyncedAt));
    ok("a manual row is never polled",
      !calls.fetchRefund.some((c) => c.refundId === manualRow.providerRefundId));
    ok("a manual row stays created", (await rowOf(manualOrder._id, manualRow._id)).status === "created");
    ok("a row with no gateway id is never polled", !(await rowOf(noIdOrder._id, noIdRow._id)).gatewaySyncedAt);

    // Second run inside the resync window: our rows are not looked at again.
    calls.fetchRefund = [];
    await syncPendingGatewayRefunds({ limit: 1000, now: new Date(now.getTime() + 60_000) });
    const ours = [processedRow, pendingRow, erroringRow].map((r) => r.providerRefundId);
    ok("a stamped row is skipped until the window passes",
      !calls.fetchRefund.some((c) => ours.includes(c.refundId)),
      calls.fetchRefund.map((c) => c.refundId).join(","));
    ok("the settled row is not re-notified", (await notices(processedOrder._id, "refund.processed")) === 1);

    // After the window it is checked again, and settles when Razorpay does.
    gatewayState.set(pendingRow.providerRefundId, { status: "processed" });
    calls.fetchRefund = [];
    await syncPendingGatewayRefunds({ limit: 1000, now: new Date(now.getTime() + 31 * 60_000) });
    ok("after the window the pending row is checked again",
      calls.fetchRefund.some((c) => c.refundId === pendingRow.providerRefundId));
    ok("and settles", (await rowOf(pendingOrder._id, pendingRow._id)).status === "processed");
    ok("notified exactly once", (await notices(pendingOrder._id, "refund.processed")) === 1);

    // Overlapping runs: the second backs off.
    const [a, b] = await Promise.all([
      syncPendingGatewayRefunds({ limit: 1000 }),
      syncPendingGatewayRefunds({ limit: 1000 }),
    ]);
    ok("an overlapping run is skipped", [a, b].some((r) => r.skipped === "already_running"),
      JSON.stringify([a, b]));
    failFetchFor.delete(erroringRow.providerRefundId);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("4. Webhook resolver");

  {
    // Replay is a no-op.
    const order = await makeOrder();
    const row = await seedRow(order, { status: "created", providerRefundId: nextRefundId() });
    const entity = { id: row.providerRefundId, payment_id: order.razorpayPaymentId, status: "processed" };
    const first = await applyRazorpayRefundWebhook({ event: "refund.processed", refundEntity: entity });
    const replay = await applyRazorpayRefundWebhook({ event: "refund.processed", refundEntity: entity });
    ok("refund.processed settles the row", (await rowOf(order._id, row._id)).status === "processed",
      JSON.stringify(first));
    ok("a replay changes nothing", replay.changed === false, JSON.stringify(replay));
    ok("the customer is told once", (await notices(order._id, "refund.processed")) === 1);

    // processed → failed is allowed.
    const failed = await applyRazorpayRefundWebhook({
      event: "refund.failed",
      refundEntity: { ...entity, status: "failed", error_description: "Beneficiary bank rejected" },
    });
    const afterFail = await OrderModel.findById(order._id);
    ok("refund.failed after processed moves the row to failed", afterFail.refunds.id(row._id).status === "failed",
      JSON.stringify(failed));
    ok("with the gateway's reason", afterFail.refunds.id(row._id).failureReason === "Beneficiary bank rejected");
    ok("and the order falls back to Paid", afterFail.paymentStatus === "Paid", afterFail.paymentStatus);

    // A failed row ignores a later processed.
    const late = await applyRazorpayRefundWebhook({ event: "refund.processed", refundEntity: entity });
    ok("a failed row ignores a later refund.processed", (await rowOf(order._id, row._id)).status === "failed",
      JSON.stringify(late));
  }

  {
    // Fallback by refundKey: the reply never arrived, so the row has no gateway id.
    const order = await makeOrder();
    const key = `cancel:${order._id}`;
    const row = await seedRow(order, { status: "created", idempotencyKey: key });
    const id = nextRefundId();
    const result = await applyRazorpayRefundWebhook({
      event: "refund.processed",
      refundEntity: { id, payment_id: order.razorpayPaymentId, notes: { refundKey: key } },
    });
    const fresh = await rowOf(order._id, row._id);
    ok("fallback by notes.refundKey finds the row", result.via === "payment_fallback", JSON.stringify(result));
    ok("settles it", fresh.status === "processed");
    ok("and records the gateway id", fresh.providerRefundId === id, fresh.providerRefundId);

    // A different key must not match.
    const other = await makeOrder();
    const otherRow = await seedRow(other, { status: "created", idempotencyKey: `cancel:${other._id}` });
    const miss = await applyRazorpayRefundWebhook({
      event: "refund.processed",
      refundEntity: { id: nextRefundId(), payment_id: other.razorpayPaymentId, notes: { refundKey: "cancel:nope" } },
    });
    ok("a non-matching key does not settle anything", miss.matched === false &&
      (await rowOf(other._id, otherRow._id)).status === "created", JSON.stringify(miss));
  }

  {
    // Fallback by returnNumber.
    const order = await makeOrder();
    const returnRequest = await makeReturn(order, { status: "refunded" });
    const row = await seedRow(order, {
      status: "created",
      returnRequest: returnRequest._id,
      reason: `Return ${returnRequest.returnNumber}`,
    });
    const result = await applyRazorpayRefundWebhook({
      event: "refund.processed",
      refundEntity: {
        id: nextRefundId(),
        payment_id: order.razorpayPaymentId,
        notes: { returnNumber: returnRequest.returnNumber },
      },
    });
    ok("fallback by notes.returnNumber finds the row", result.via === "payment_fallback", JSON.stringify(result));
    ok("and settles it", (await rowOf(order._id, row._id)).status === "processed");
  }

  {
    // Return rollback: a refund that fails after the return was marked refunded.
    const order = await makeOrder();
    const returnRequest = await makeReturn(order, { status: "refunded", refundedAt: new Date() });
    const row = await seedRow(order, {
      status: "created",
      providerRefundId: nextRefundId(),
      returnRequest: returnRequest._id,
    });
    await applyRazorpayRefundWebhook({
      event: "refund.failed",
      refundEntity: { id: row.providerRefundId, payment_id: order.razorpayPaymentId },
    });
    const reopened = await ReturnModel.findById(returnRequest._id);
    ok("the return goes back to received", reopened.status === "received", reopened.status);
    ok("refundedAt is cleared", reopened.refundedAt === null, String(reopened.refundedAt));
    ok("with a history note telling the operator to retry",
      /failed — retry the refund/.test(reopened.statusHistory.at(-1)?.note || ""),
      reopened.statusHistory.at(-1)?.note);
  }

  {
    // A return with ANOTHER live refund row is not reopened.
    const order = await makeOrder();
    const returnRequest = await makeReturn(order, { status: "refunded", refundedAt: new Date() });
    const row = await seedRow(order, {
      status: "created", providerRefundId: nextRefundId(), returnRequest: returnRequest._id, amount: 400,
    });
    await seedRow(order, {
      status: "processed", providerRefundId: nextRefundId(), returnRequest: returnRequest._id, amount: 400,
    });
    await applyRazorpayRefundWebhook({
      event: "refund.failed",
      refundEntity: { id: row.providerRefundId, payment_id: order.razorpayPaymentId },
    });
    ok("a return still covered by a live refund stays refunded",
      (await ReturnModel.findById(returnRequest._id)).status === "refunded");
  }

  {
    // Unmatched refund.failed → the orphaned-capture record goes back to failed.
    const paymentId = `pay_${MARKER}_orphan`;
    const refundId = nextRefundId();
    await UnmatchedPayment.create({
      paymentId,
      amount: 100000,
      resolution: "refunded",
      refundId,
      detectedReason: "regression fixture",
    });
    trash.unmatched.push(paymentId);
    const result = await applyRazorpayRefundWebhook({
      event: "refund.failed",
      refundEntity: { id: refundId, payment_id: paymentId, error_description: "Card closed" },
    });
    const record = await UnmatchedPayment.findOne({ paymentId });
    ok("an unmatched refund.failed marks the UnmatchedPayment failed", record.resolution === "failed",
      JSON.stringify(result));
    ok("with the reason", record.failureReason === "Card closed", record.failureReason);

    const unknown = await applyRazorpayRefundWebhook({
      event: "refund.processed",
      refundEntity: { id: `rfnd_${MARKER}_nowhere`, payment_id: `pay_${MARKER}_nowhere` },
    });
    ok("an event matching nothing is a quiet no-op", unknown.matched === false);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("5. Return refund flow (refundReturnRequest)");

  {
    resetGateway();
    const order = await makeOrder();
    const returnRequest = await makeReturn(order);
    refundBehaviour = () => ({ id: nextRefundId(), status: "failed" });
    let thrown;
    try {
      await refundReturnRequest({ order, returnRequest, adminId: null });
    } catch (error) {
      thrown = error;
    }
    ok("a failed reply throws GATEWAY_REFUND_REJECTED", thrown?.code === "GATEWAY_REFUND_REJECTED", thrown?.code);
    ok("as a 502", thrown?.statusCode === 502, String(thrown?.statusCode));
    const afterReject = await OrderModel.findById(order._id);
    const rejectedRow = afterReject.refunds.find((r) => String(r.returnRequest) === String(returnRequest._id));
    ok("the row is failed", rejectedRow?.status === "failed", rejectedRow?.status);
    ok("the gateway call carried notes.returnNumber",
      calls.refund[0]?.options?.notes?.returnNumber === returnRequest.returnNumber);

    // Retry: times out. The old failed refund is on record at Razorpay under the
    // same returnNumber — the next retry must NOT adopt it.
    resetGateway();
    refundBehaviour = () => {
      throw new Error("socket hang up");
    };
    let timeout;
    try {
      await refundReturnRequest({ order: afterReject, returnRequest, adminId: null });
    } catch (error) {
      timeout = error;
    }
    ok("a timeout throws GATEWAY_REFUND_FAILED", timeout?.code === "GATEWAY_REFUND_FAILED", timeout?.code);

    resetGateway();
    gatewayRefundsOnRecord = [
      { id: rejectedRow.providerRefundId, status: "failed", notes: { returnNumber: returnRequest.returnNumber } },
    ];
    const retried = await refundReturnRequest({
      order: await OrderModel.findById(order._id),
      returnRequest,
      adminId: null,
    });
    ok("the timed-out retry does not adopt the old failed refund", calls.refund.length === 1,
      `${calls.refund.length} refund call(s)`);
    ok("it refunds and settles", retried.refundStatus === "processed", retried.refundStatus);
    ok("on a NEW gateway id", retried.refund.providerRefundId !== rejectedRow.providerRefundId);
    const live = (await OrderModel.findById(order._id)).refunds.filter((r) => r.status !== "failed");
    ok("exactly one live row for the return", live.length === 1, `${live.length}`);
  }

  {
    // A timed-out attempt that DID land: adopted, not repeated.
    resetGateway();
    const order = await makeOrder();
    const returnRequest = await makeReturn(order);
    refundBehaviour = () => {
      throw new Error("ETIMEDOUT");
    };
    await refundReturnRequest({ order, returnRequest, adminId: null }).catch(() => {});
    resetGateway();
    const landed = nextRefundId();
    gatewayRefundsOnRecord = [
      { id: `rfnd_${MARKER}_old_failed`, status: "failed", notes: { returnNumber: returnRequest.returnNumber } },
      { id: landed, status: "processed", notes: { returnNumber: returnRequest.returnNumber } },
    ];
    const adopted = await refundReturnRequest({
      order: await OrderModel.findById(order._id),
      returnRequest,
      adminId: null,
    });
    ok("a live match wins over a failed one", adopted.refund.providerRefundId === landed,
      adopted.refund.providerRefundId);
    ok("adopted without a second refund", calls.refund.length === 0, `${calls.refund.length}x`);
    ok("reported as already refunded", adopted.alreadyRefunded === true && adopted.refundStatus === "processed");
  }

  {
    // `pending`: the return can be marked refunded, but the customer is told
    // "initiated" — and a later reconcile finishes it without refunding again.
    resetGateway();
    const order = await makeOrder();
    const returnRequest = await makeReturn(order);
    refundBehaviour = () => ({ id: nextRefundId(), status: "pending" });
    const accepted = await refundReturnRequest({ order, returnRequest, adminId: null });
    ok("a pending reply resolves with refundStatus created", accepted.refundStatus === "created",
      accepted.refundStatus);
    ok("the row is created with its gateway id",
      accepted.refund?.status === "created" && Boolean(accepted.refund?.providerRefundId));
    ok("the order is Refund Pending", (await OrderModel.findById(order._id)).paymentStatus === "Refund Pending");

    gatewayState.set(accepted.refund.providerRefundId, { status: "processed" });
    const reconciled = await refundReturnRequest({
      order: await OrderModel.findById(order._id),
      returnRequest,
      adminId: null,
    });
    ok("a return reconcile looks the refund up instead of re-sending",
      calls.refund.length === 1 && calls.fetchRefund.length >= 1, `${calls.refund.length}x refund`);
    ok("and settles it", reconciled.refundStatus === "processed", reconciled.refundStatus);
    ok("the order is Refunded", (await OrderModel.findById(order._id)).paymentStatus === "Refunded");
  }

  {
    // processed reply: unchanged happy path.
    resetGateway();
    const order = await makeOrder();
    const returnRequest = await makeReturn(order);
    const result = await refundReturnRequest({ order, returnRequest, adminId: null });
    ok("a processed reply resolves processed", result.refundStatus === "processed" && result.alreadyRefunded === false);
    const again = await refundReturnRequest({
      order: await OrderModel.findById(order._id),
      returnRequest,
      adminId: null,
    });
    ok("a repeat is idempotent", again.alreadyRefunded === true && calls.refund.length === 1);
  }

  {
    // COD: the manual branch is unchanged and reports processed.
    const order = await makeOrder({ paymentMethod: "COD", razorpayPaymentId: undefined });
    const returnRequest = await makeReturn(order);
    const manual = await refundReturnRequest({
      order,
      returnRequest,
      adminId: null,
      manual: { method: "upi", reference: `UTR-${MARKER}` },
    });
    ok("a manual refund reports processed", manual.refundStatus === "processed" &&
      manual.refund.confirmationMethod === "manual");
  }

  // Sanity: settleGatewayRefund outcomes all carry refundStatus.
  {
    resetGateway();
    const order = await makeOrder();
    const row = await seedRow(order, { status: "created", idempotencyKey: `cancel:${order._id}` });
    const result = await settleGatewayRefund({
      order, refundId: row._id, amount: 1000, refundKey: `cancel:${order._id}`, reason: "c",
    });
    ok("settleGatewayRefund carries refundStatus", result.refundStatus === "processed", JSON.stringify(result));
    ok("a refund this call settled reports notified: false — the caller announces it",
      result.notified === false && !result.alreadySettled, JSON.stringify(result));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("6. Webhook beats the synchronous reply — one notice, not two");

  // The stub plays Razorpay delivering refund.processed WHILE the refund call is
  // still in flight: the webhook resolver finds the row by notes.refundKey (it has
  // no gateway id yet), settles it and notifies. Only then does the reply return.
  const webhookFirst = (replyStatus) => async (paymentId, options) => {
    const id = nextRefundId();
    await applyRazorpayRefundWebhook({
      event: "refund.processed",
      refundEntity: { id, payment_id: paymentId, notes: options?.notes || {}, status: "processed" },
    });
    return { id, status: replyStatus };
  };

  for (const replyStatus of ["processed", "pending"]) {
    resetGateway();
    refundBehaviour = webhookFirst(replyStatus);
    const order = await makeOrder();
    const row = await seedRow(order, { status: "created", idempotencyKey: `cancel:${order._id}` });
    const result = await settleGatewayRefund({
      order, refundId: row._id, amount: 1000, refundKey: `cancel:${order._id}`, reason: "c",
    });
    ok(`[reply ${replyStatus}] the row reads processed`, result.refundStatus === "processed",
      JSON.stringify(result));
    ok(`[reply ${replyStatus}] settleGatewayRefund reports the notice as already sent`,
      result.notified === true && result.alreadySettled === true, JSON.stringify(result));
    ok(`[reply ${replyStatus}] exactly one refund.processed notice (the webhook's)`,
      (await notices(order._id, "refund.processed")) === 1);
    ok(`[reply ${replyStatus}] the row carries the gateway id`,
      Boolean((await rowOf(order._id, row._id)).providerRefundId));
  }

  {
    // The return flow passes `notified` through to AdminUpdateReturnStatus.
    resetGateway();
    refundBehaviour = webhookFirst("processed");
    const order = await makeOrder();
    const returnRequest = await makeReturn(order);
    const result = await refundReturnRequest({ order, returnRequest, adminId: null });
    ok("refundReturnRequest reports notified when the webhook settled first",
      result.refundStatus === "processed" && result.notified === true, JSON.stringify({
        refundStatus: result.refundStatus, notified: result.notified,
      }));
    ok("one refund.processed notice for the return", (await notices(order._id, "refund.processed")) === 1);
  }

  {
    // The admin endpoint writes the reply itself rather than via settleGatewayRefund.
    resetGateway();
    refundBehaviour = webhookFirst("processed");
    const order = await makeOrder({ orderStatus: "Delivered" });
    let statusCode = 200;
    let body;
    const res = {
      status(code) { statusCode = code; return this; },
      json(data) { body = data; return this; },
    };
    await paymentController.RefundRazorpayPayment(
      {
        params: { orderId: String(order._id) },
        body: { amount: 1000, reason: `${MARKER} race` },
        user: { id: String(new mongoose.Types.ObjectId()), roles: ["admin"] },
        query: {},
        headers: {},
        get: () => undefined,
      },
      res,
    );
    ok("RefundRazorpayPayment answers 200 processed", statusCode === 200 && body?.success === true && !body?.pending,
      JSON.stringify({ statusCode, message: body?.message }));
    ok("RefundRazorpayPayment sends no second refund.processed",
      (await notices(order._id, "refund.processed")) === 1);
    ok("and no refund.initiated either", (await notices(order._id, "refund.initiated")) === 0);
  }

  {
    // Control: without the race the admin endpoint still announces its own refund.
    resetGateway();
    const order = await makeOrder({ orderStatus: "Delivered" });
    const res = { status() { return this; }, json() { return this; } };
    await paymentController.RefundRazorpayPayment(
      {
        params: { orderId: String(order._id) },
        body: { amount: 1000, reason: `${MARKER} plain` },
        user: { id: String(new mongoose.Types.ObjectId()), roles: ["admin"] },
        query: {},
        headers: {},
        get: () => undefined,
      },
      res,
    );
    ok("a plain processed refund is announced once by the endpoint",
      (await notices(order._id, "refund.processed")) === 1);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("7. Settlement side effects");

  {
    // A pending return refund that settles out of band (here: after the return
    // was put back at `received`) moves the return to refunded on its own.
    const order = await makeOrder({ orderStatus: "Delivered" });
    const returnRequest = await makeReturn(order);
    const providerRefundId = nextRefundId();
    const row = await seedRow(order, { status: "created", providerRefundId, returnRequest: returnRequest._id });
    await applyGatewayRefundState({
      orderId: order._id,
      refundId: row._id,
      gatewayRefund: { id: providerRefundId, status: "processed" },
      source: "test",
    });
    const settled = await ReturnModel.findById(returnRequest._id);
    ok("a received refund-return moves to refunded when its refund settles", settled.status === "refunded",
      settled.status);
    ok("  with refundedAt", Boolean(settled.refundedAt));
    ok("  and a history note", settled.statusHistory.at(-1)?.note === "Refund settled by Razorpay",
      settled.statusHistory.at(-1)?.note);
    ok("  the customer is told once", (await notices(order._id, "refund.processed")) === 1);
  }

  {
    // A replacement-resolution return is not the refund's to close.
    const order = await makeOrder({ orderStatus: "Delivered" });
    const returnRequest = await makeReturn(order, { resolutionType: "replacement" });
    const providerRefundId = nextRefundId();
    const row = await seedRow(order, { status: "created", providerRefundId, returnRequest: returnRequest._id });
    await applyGatewayRefundState({
      orderId: order._id,
      refundId: row._id,
      gatewayRefund: { id: providerRefundId, status: "processed" },
      source: "test",
    });
    ok("a replacement return stays received", (await ReturnModel.findById(returnRequest._id)).status === "received");
  }

  {
    // Two rows settling at the same moment: paymentStatus is derived from the
    // ledger by compare-and-swap, so neither can leave a stale value behind.
    // Forced deterministically: the first settlement's ledger read happens, then
    // the second settlement runs to completion, then the first one writes.
    const order = await makeOrder({ orderStatus: "Cancelled" });
    const a = await seedRow(order, { status: "created", amount: 500, providerRefundId: nextRefundId() });
    const b = await seedRow(order, { status: "created", amount: 500, providerRefundId: nextRefundId() });
    const settle = (row) =>
      applyGatewayRefundState({
        orderId: order._id,
        refundId: row._id,
        gatewayRefund: { id: row.providerRefundId, status: "processed" },
        source: "test",
      });
    const realFindById = OrderModel.findById;
    let armed = true;
    OrderModel.findById = function (...args) {
      const query = realFindById.apply(this, args);
      if (!armed || String(args[0]) !== String(order._id)) return query;
      armed = false;
      return (async () => {
        const staleRead = await query;
        await settle(b);
        return staleRead;
      })();
    };
    try {
      await settle(a);
    } finally {
      OrderModel.findById = realFindById;
    }
    const after = await OrderModel.findById(order._id);
    ok("both rows processed", after.refunds.every((row) => row.status === "processed"));
    ok("a settlement that read the ledger before the other's write leaves no stale status",
      after.paymentStatus === "Refunded", after.paymentStatus);
  }

  {
    // The backfill re-opened a row whose "refund processed" notice had already
    // gone out under the old code; its real settlement must not send another.
    const order = await makeOrder({ orderStatus: "Cancelled" });
    const providerRefundId = nextRefundId();
    const row = await seedRow(order, { status: "created", providerRefundId, suppressProcessedNotice: true });
    const applied = await applyGatewayRefundState({
      orderId: order._id,
      refundId: row._id,
      gatewayRefund: { id: providerRefundId, status: "processed" },
      source: "poller",
    });
    ok("the marked row settles", applied.matched && (await rowOf(order._id, row._id)).status === "processed");
    ok("  paymentStatus follows", (await OrderModel.findById(order._id)).paymentStatus === "Refunded");
    ok("  but no second refund.processed notice", (await notices(order._id, "refund.processed")) === 0);
  }

  {
    // A pending refund that later FAILS: logged at error level, listed as owed
    // money until something replaces it, and gone from the list once retried.
    const order = await makeOrder({ orderStatus: "Cancelled" });
    const providerRefundId = nextRefundId();
    const row = await seedRow(order, { status: "created", providerRefundId, idempotencyKey: `cancel:${order._id}` });
    const errors = [];
    const realError = console.error;
    console.error = (line, ...rest) => {
      errors.push(String(line));
      realError(line, ...rest);
    };
    try {
      await applyGatewayRefundState({
        orderId: order._id,
        refundId: row._id,
        gatewayRefund: { id: providerRefundId, status: "failed", error_description: "Bank declined" },
        source: "poller",
      });
    } finally {
      console.error = realError;
    }
    ok("a move to failed is logged at error level",
      errors.some((line) => line.includes('"gateway_refund_failed"') && line.includes('"level":"error"')),
      errors.join(" | "));

    const unresolved = await listUnresolvedFailedRefunds({ _id: order._id });
    ok("the failed row is an unresolved failed refund", unresolved.length === 1 &&
      String(unresolved[0].refund._id) === String(row._id));

    const listed = async () => {
      for (let page = 1; page <= 50; page += 1) {
        let body;
        await AdminGetOwedRefunds(
          { query: { page: String(page), limit: "100" } },
          { status() { return this; }, json(data) { body = data; return this; } },
        );
        const hit = (body?.data || []).find((entry) => String(entry.refundId) === String(row._id));
        if (hit || page >= (body?.pagination?.totalPages || 1)) return hit || null;
      }
      return null;
    };
    const entry = await listed();
    ok("it is in the owed-refunds list", Boolean(entry));
    ok("  as refundStatus failed", entry?.refundStatus === "failed", entry?.refundStatus);
    ok("  payable through Razorpay (the retry)", entry?.gatewayPayable === true);
    ok("  not as a manual payout", entry?.manualPayable === false);
    ok("  with Razorpay's reason", entry?.failureReason === "Bank declined", entry?.failureReason);

    await OrderModel.updateOne(
      { _id: order._id },
      {
        $push: {
          refunds: {
            paymentProvider: "razorpay",
            amount: 1000,
            reason: "Order cancelled",
            status: "created",
            idempotencyKey: `retry:${row._id}`,
            confirmationMethod: "gateway",
          },
        },
      },
    );
    ok("once retried it is no longer unresolved", (await listUnresolvedFailedRefunds({ _id: order._id })).length === 0);
    ok("  nor listed", (await listed()) === null);
  }
} catch (error) {
  console.error(`\nSUITE ABORTED: ${error?.stack || error}`);
  ok("suite ran to completion", false, error?.message);
} finally {
  await OrderModel.deleteMany({ _id: { $in: trash.orders } });
  await ReturnModel.deleteMany({ _id: { $in: trash.returns } });
  await UnmatchedPayment.deleteMany({ paymentId: { $in: trash.unmatched } });
  await NotificationEvent.deleteMany({ order: { $in: trash.orders } });
  await AuditLog.deleteMany({ targetId: { $in: trash.orders } }).catch(() => {});
  const { failed } = finish();
  await mongoose.disconnect();
  process.exit(failed ? 1 : 0);
}
