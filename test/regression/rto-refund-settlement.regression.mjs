/**
 * An owed RTO refund can actually be paid, exactly once — and an order cannot be
 * Closed while it is still owed (G2 + G3).
 *
 * G2 — a prepaid RTO records its refund as `owed`: deliberately not pushed to the
 * gateway from an unattended courier feed. But nothing could ever pay it. The
 * reconcile endpoint required a reconciliation key the owed row never had, and the
 * manual-settle endpoint (correctly) refuses rows Razorpay can pay. The liability
 * was visible and permanently stuck. Reconcile now assigns `owed:<refundId>` by
 * compare-and-swap, the gateway-attempt claim flips the row to `created` in the
 * same write, and the existing settleGatewayRefund pays it.
 *
 * G3 — "Closed" is defined as "the parcel is back, its condition recorded, and any
 * refund owed settled", but only the first two were enforced. And a manual move to
 * "RTO Received" recorded no obligation at all, so a parcel an operator marked as
 * back owed the customer nothing in the ledger.
 *
 * Also: recordRefundObligation is now an atomic conditional $push, so concurrent
 * courier deliveries (or a webhook racing the manual move) owe once.
 *
 * Run with `npm run test:rto-refund-settlement` (or `npm test` for everything).
 *
 * Controllers are called directly. The Razorpay SDK is stubbed on its cached
 * instance; `globalThis.fetch` throws on any call. Nothing leaves the machine.
 */
process.env.PAYMENTS_ENABLED = "true";
process.env.PAYMENT_PROVIDER = "razorpay";
process.env.RAZORPAY_KEY_ID = "rzp_test_stub0000000";
process.env.RAZORPAY_KEY_SECRET = "stub_secret_for_tests";
process.env.INVENTORY_ENFORCE_STOCK = "true";
process.env.NOTIFICATIONS_ENABLED = "false";
process.env.SHIPROCKET_ENABLED = "false";
process.env.SHIPROCKET_BASE_URL = "https://shiprocket.invalid/v1/external";

import mongoose from "mongoose";
import { connect, createSuite, marker, productFixture, addressFixture } from "./helpers.mjs";

const { ok, section, finish } = createSuite("rto-refund-settlement");
await connect();

const OrderModel = (await import("../../src/modules/orders/Order.model.js")).default;
const ProductModel = (await import("../../src/modules/products/Product.model.js")).default;
const AuditLog = (await import("../../src/modules/audit/AuditLog.model.js")).default;
await import("../../src/modules/categories/Category.model.js");
const orderController = await import("../../src/modules/orders/order.controller.js");
const { AdminGetOwedRefunds, AdminSettleOwedRefundManually } = await import(
  "../../src/modules/payments/owed-refund.controller.js"
);
const {
  recordRefundObligation,
  recordRtoRefundObligation,
  sumRefunded,
  sumOwedRefunds,
} = await import("../../src/modules/payments/return-refund.service.js");
const razorpayService = await import("../../src/modules/payments/razorpay.service.js");

await OrderModel.init();

// ── Razorpay stub ───────────────────────────────────────────────────────────
// Slow on purpose: two concurrent reconciles must both be in flight at once, or
// the "exactly one gateway call" assertion proves nothing.
const gateway = { refund: [], lookups: 0, failNext: false, delayMs: 60 };
const { razorpay: sharedRazorpay } = razorpayService.getRazorpay();
sharedRazorpay.payments.refund = async (paymentId, options) => {
  gateway.refund.push({ paymentId, options });
  await new Promise((resolve) => setTimeout(resolve, gateway.delayMs));
  if (gateway.failNext) {
    gateway.failNext = false;
    throw Object.assign(new Error("Gateway timeout"), { error: { description: "Gateway timeout" } });
  }
  return { id: `rfnd_rrs_${process.pid}_${gateway.refund.length}`, status: "processed" };
};
sharedRazorpay.payments.fetchMultipleRefund = async () => {
  gateway.lookups += 1;
  return { items: [] };
};
const resetGateway = () => {
  gateway.refund = [];
  gateway.lookups = 0;
  gateway.failNext = false;
};

const originalFetch = globalThis.fetch;
globalThis.fetch = async (input) => {
  throw new Error(`Unexpected outbound call in tests: ${String(input instanceof URL ? input.href : input)}`);
};

const MARKER = marker("rtosettle");
const trash = { orders: [], products: [] };
let seq = 0;

const makeProduct = async (label) => {
  const product = await ProductModel.create(productFixture(`${MARKER}-${label}`, { stock: 20 }));
  trash.products.push(product._id);
  return product;
};

const makeOrder = async ({
  units = 2,
  orderStatus = "RTO Received",
  paymentMethod = "RAZORPAY",
  paymentStatus = "Paid",
} = {}) => {
  seq += 1;
  const product = await makeProduct(`p${seq}`);
  const subtotal = product.price * units;
  const order = await OrderModel.create({
    user: new mongoose.Types.ObjectId(),
    items: [{ product: product._id, name: product.name, image: "x.png", price: product.price, quantity: units }],
    shippingAddress: addressFixture(),
    paymentMethod,
    paymentStatus,
    orderStatus,
    subtotal,
    totalAmount: subtotal,
    ...(paymentMethod === "RAZORPAY" ? { razorpayPaymentId: `pay_${MARKER}_${seq}` } : {}),
  });
  trash.orders.push(order._id);
  return order;
};

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
  await handler({ params, body, user, query, headers: {} }, res);
  return { statusCode, body: payload };
};

const admin = () => ({ id: String(new mongoose.Types.ObjectId()), roles: ["admin"] });
const fresh = (id) => OrderModel.findById(id);

const reconcile = (orderId, refundId) =>
  callController(orderController.ReconcileOrderRefund, {
    params: { orderId: String(orderId), refundId: String(refundId) },
    user: admin(),
  });
const setStatus = (orderId, orderStatus) =>
  callController(orderController.UpdateOrderStatus, {
    params: { orderId: String(orderId) },
    body: { orderStatus },
    user: admin(),
  });
const recordDisposition = (orderId, disposition) =>
  callController(orderController.RecordRtoDisposition, {
    params: { orderId: String(orderId) },
    body: { disposition },
    user: admin(),
  });
const owedRowsFor = async (orderId) => {
  const listed = await callController(AdminGetOwedRefunds, { query: { limit: "100" }, user: admin() });
  return (listed.body?.data || []).filter((row) => String(row.orderId) === String(orderId));
};

try {
  // ═══════════════════════════════════════════════════════════════════════════
  section("1 — an owed prepaid RTO refund is paid once through the gateway (G2)");

  {
    resetGateway();
    const order = await makeOrder({ units: 2 });
    const recorded = await recordRtoRefundObligation(order);
    ok("the RTO obligation is recorded by the shared helper", recorded.owed === order.totalAmount,
      JSON.stringify(recorded));
    let current = await fresh(order._id);
    const owed = current.refunds[0];
    ok("  as owed, gateway-confirmed, keyed by its RTO reason",
      owed?.status === "owed" && owed?.confirmationMethod === "gateway" && owed?.reason === `RTO ${order._id}`,
      JSON.stringify({ status: owed?.status, method: owed?.confirmationMethod, reason: owed?.reason }));
    ok("  with NO reconciliation key yet", !owed?.idempotencyKey, owed?.idempotencyKey);
    ok("  and the order at Refund Pending", current.paymentStatus === "Refund Pending", current.paymentStatus);

    const [row] = await owedRowsFor(order._id);
    ok("the owed list offers it for gateway payment (gatewayPayable)", row?.gatewayPayable === true,
      JSON.stringify(row));
    ok("  flagged as an RTO", row?.isRto === true);
    ok("  without exposing the key or any payment identifier",
      row && !("idempotencyKey" in row) && !("razorpayPaymentId" in row) && !("gatewayPaymentRef" in row),
      JSON.stringify(Object.keys(row || {})));

    // G3 — Closed is refused while owed.
    await recordDisposition(order._id, "resellable");
    const refused = await setStatus(order._id, "Closed");
    ok("Closed is refused while the refund is owed (409 RTO_REFUND_OUTSTANDING)",
      refused.statusCode === 409 && refused.body?.code === "RTO_REFUND_OUTSTANDING",
      `${refused.statusCode} ${refused.body?.code}`);
    ok("  the outstanding amount is reported", refused.body?.outstandingRefundAmount === order.totalAmount,
      String(refused.body?.outstandingRefundAmount));
    ok("  and the order stays at RTO Received", (await fresh(order._id)).orderStatus === "RTO Received");

    // Two operators press "Refund via Razorpay" together.
    const results = await Promise.all([reconcile(order._id, owed._id), reconcile(order._id, owed._id)]);
    ok("two concurrent reconciles make EXACTLY ONE gateway call", gateway.refund.length === 1,
      `${gateway.refund.length} calls; ${JSON.stringify(results.map((r) => `${r.statusCode}:${r.body?.code || ""}`))}`);
    ok("  one of them succeeds", results.some((r) => r.statusCode === 200));
    ok("  the other is told it is in progress, never a second refund",
      results.every((r) => r.statusCode === 200 || r.body?.code === "REFUND_IN_PROGRESS"),
      JSON.stringify(results.map((r) => `${r.statusCode}:${r.body?.code || ""}`)));

    current = await fresh(order._id);
    const paid = current.refunds.id(owed._id);
    ok("still exactly one refund row — the ceiling was not doubled", current.refunds.length === 1,
      String(current.refunds.length));
    ok("the row is processed", paid?.status === "processed", paid?.status);
    ok("  carrying owed:<refundId>", paid?.idempotencyKey === `owed:${owed._id}`, paid?.idempotencyKey);
    ok("  and that key reached Razorpay as notes.refundKey",
      gateway.refund[0]?.options?.notes?.refundKey === `owed:${owed._id}`,
      JSON.stringify(gateway.refund[0]?.options?.notes));
    ok("  for the owed amount, in paise", gateway.refund[0]?.options?.amount === Math.round(owed.amount * 100),
      String(gateway.refund[0]?.options?.amount));
    ok("  against the order's payment", gateway.refund[0]?.paymentId === order.razorpayPaymentId);
    ok("  with the gateway's refund id recorded", Boolean(paid?.providerRefundId));
    ok("paymentStatus is recomputed from the ledger: Refunded", current.paymentStatus === "Refunded",
      current.paymentStatus);
    ok("nothing is owed any more", sumOwedRefunds(current) === 0);
    ok("the ceiling holds", sumRefunded(current) <= current.totalAmount + 0.01);

    const again = await reconcile(order._id, owed._id);
    ok("a third press is idempotent — already settled, no gateway call",
      again.statusCode === 200 && again.body?.idempotent === true && gateway.refund.length === 1,
      `${again.statusCode} ${gateway.refund.length}`);
    ok("the owed list no longer shows it", (await owedRowsFor(order._id)).length === 0);
    ok("the payment is audited",
      (await AuditLog.countDocuments({ targetId: order._id, action: "RECONCILE_REFUND" })) === 1);

    const closed = await setStatus(order._id, "Closed");
    ok("with the refund settled, the order can be Closed", closed.statusCode === 200,
      `${closed.statusCode} ${closed.body?.code || closed.body?.message}`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("2 — a gateway failure leaves the row `created`, still blocking Closed");

  {
    resetGateway();
    const order = await makeOrder({ units: 1 });
    await recordRtoRefundObligation(order);
    const owed = (await fresh(order._id)).refunds[0];
    await recordDisposition(order._id, "damaged");

    gateway.failNext = true;
    const failed = await reconcile(order._id, owed._id);
    ok("a gateway error is reported (502 GATEWAY_REFUND_FAILED)",
      failed.statusCode === 502 && failed.body?.code === "GATEWAY_REFUND_FAILED",
      `${failed.statusCode} ${failed.body?.code}`);
    let row = (await fresh(order._id)).refunds.id(owed._id);
    ok("the row left `owed` inside the attempt claim — it is `created` (outcome unknown)",
      row?.status === "created", row?.status);
    ok("  keeping its key", row?.idempotencyKey === `owed:${owed._id}`, row?.idempotencyKey);
    ok("  and its attempt released so a retry need not wait", row?.gatewayAttemptedAt === null);
    ok("the owed list no longer offers it (it is no longer owed)", (await owedRowsFor(order._id)).length === 0);

    const blocked = await setStatus(order._id, "Closed");
    ok("Closed is still refused while the refund is `created`",
      blocked.statusCode === 409 && blocked.body?.code === "RTO_REFUND_OUTSTANDING",
      `${blocked.statusCode} ${blocked.body?.code}`);

    const retry = await reconcile(order._id, owed._id);
    ok("the retry succeeds", retry.statusCode === 200, `${retry.statusCode} ${retry.body?.code || ""}`);
    ok("  after asking Razorpay first whether the earlier attempt landed", gateway.lookups === 1,
      String(gateway.lookups));
    row = (await fresh(order._id)).refunds.id(owed._id);
    ok("  and the row is processed", row?.status === "processed", row?.status);
    ok("Closed now succeeds", (await setStatus(order._id, "Closed")).statusCode === 200);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("3 — rows the gateway cannot pay are refused before any key is written");

  {
    resetGateway();
    // A COD payout obligation: manual confirmation.
    const cod = await makeOrder({ units: 1, orderStatus: "Delivered", paymentMethod: "COD", paymentStatus: "Paid" });
    await recordRefundObligation({
      order: cod,
      amount: cod.totalAmount,
      reason: "COD return payout",
      dedupeKey: `COD-PAYOUT ${cod._id}`,
      confirmationMethod: "manual",
    });
    const codRow = (await fresh(cod._id)).refunds[0];
    const codAttempt = await reconcile(cod._id, codRow._id);
    ok("a manual (COD) owed row → 400 MANUAL_REFUND_ONLY",
      codAttempt.statusCode === 400 && codAttempt.body?.code === "MANUAL_REFUND_ONLY",
      `${codAttempt.statusCode} ${codAttempt.body?.code}`);
    ok("  no key was written", !(await fresh(cod._id)).refunds[0].idempotencyKey);
    const [codListed] = await owedRowsFor(cod._id);
    ok("  and the list does not offer it for gateway payment", codListed?.gatewayPayable === false,
      JSON.stringify(codListed));

    // A prepaid row while payments are switched off: canAutoRefund is false.
    const order = await makeOrder({ units: 1 });
    await recordRtoRefundObligation(order);
    const owed = (await fresh(order._id)).refunds[0];
    process.env.PAYMENTS_ENABLED = "false";
    try {
      const attempt = await reconcile(order._id, owed._id);
      ok("a gateway row with payments disabled → 400 MANUAL_REFUND_ONLY",
        attempt.statusCode === 400 && attempt.body?.code === "MANUAL_REFUND_ONLY",
        `${attempt.statusCode} ${attempt.body?.code}`);
      const [listed] = await owedRowsFor(order._id);
      ok("  and gatewayPayable follows canAutoRefund to false", listed?.gatewayPayable === false);
      // Which is exactly when the manual settle is allowed — the two never both
      // claim the same row.
      const manual = await callController(AdminSettleOwedRefundManually, {
        params: { orderId: String(order._id), refundId: String(owed._id) },
        body: { method: "upi", reference: `UTR-${MARKER}-${seq}` },
        user: admin(),
      });
      ok("  and the manual payout path accepts it instead", manual.statusCode === 200,
        `${manual.statusCode} ${manual.body?.code || manual.body?.message}`);
    } finally {
      process.env.PAYMENTS_ENABLED = "true";
    }
    ok("no gateway call was made in this section", gateway.refund.length === 0);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("4 — a manual move to RTO Received records the obligation (G3)");

  {
    const order = await makeOrder({ units: 2, orderStatus: "RTO" });
    const moved = await setStatus(order._id, "RTO Received");
    ok("RTO → RTO Received by hand succeeds", moved.statusCode === 200,
      `${moved.statusCode} ${moved.body?.code || moved.body?.message}`);
    let current = await fresh(order._id);
    const rtoRows = () => current.refunds.filter((r) => r.reason === `RTO ${order._id}`);
    ok("exactly one owed obligation is recorded (was none)", rtoRows().length === 1 && rtoRows()[0].status === "owed",
      JSON.stringify(current.refunds.map((r) => [r.reason, r.status])));
    ok("  for the full outstanding amount", rtoRows()[0]?.amount === order.totalAmount);
    ok("  and the response already shows it", (moved.body?.order?.refunds || []).length === 1);

    const repeat = await setStatus(order._id, "RTO Received");
    ok("submitting it again is a no-op", repeat.statusCode === 200);
    await recordRtoRefundObligation(await fresh(order._id));
    current = await fresh(order._id);
    ok("and a courier event arriving afterwards owes nothing further", rtoRows().length === 1,
      String(rtoRows().length));

    const cod = await makeOrder({ units: 1, orderStatus: "RTO", paymentMethod: "COD", paymentStatus: "Pending" });
    const codMoved = await setStatus(cod._id, "RTO Received");
    ok("a COD order moved by hand records no obligation — nothing was collected",
      codMoved.statusCode === 200 && (await fresh(cod._id)).refunds.length === 0);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("5 — recordRefundObligation is atomic");

  {
    // Five concurrent deliveries of the same courier event.
    const order = await makeOrder({ units: 3, orderStatus: "RTO" });
    await Promise.all(Array.from({ length: 5 }, async () => recordRtoRefundObligation(await fresh(order._id))));
    let current = await fresh(order._id);
    ok("five concurrent RTO obligations → ONE row", current.refunds.length === 1, String(current.refunds.length));
    ok("  for the order total", current.refunds[0]?.amount === order.totalAmount);

    // Two DIFFERENT obligations racing for the same headroom: the ceiling must hold.
    const contested = await makeOrder({ units: 2, orderStatus: "RTO Received" });
    const results = await Promise.all([
      recordRefundObligation({
        order: await fresh(contested._id),
        amount: contested.totalAmount,
        reason: "first",
        dedupeKey: `FIRST ${contested._id}`,
      }),
      recordRefundObligation({
        order: await fresh(contested._id),
        amount: contested.totalAmount,
        reason: "second",
        dedupeKey: `SECOND ${contested._id}`,
      }),
    ]);
    current = await fresh(contested._id);
    ok("two different obligations for the full amount never exceed the ceiling",
      sumRefunded(current) <= current.totalAmount + 0.01,
      `${sumRefunded(current)} of ${current.totalAmount}`);
    ok("  exactly one of them is created", results.filter((r) => r.created).length === 1,
      JSON.stringify(results.map((r) => ({ created: r.created, noHeadroom: r.noHeadroom }))));
    ok("  and the order reads Refund Pending", current.paymentStatus === "Refund Pending", current.paymentStatus);

    // The return shape callers rely on is unchanged.
    const shape = await makeOrder({ units: 1, orderStatus: "Delivered" });
    const created = await recordRefundObligation({
      order: shape,
      amount: 100,
      reason: "shape probe",
      dedupeKey: `SHAPE ${shape._id}`,
    });
    ok("returns { refund, created: true, note } on creation",
      created.created === true && created.note === "shape probe" && created.refund?.status === "owed" &&
        created.refund?.amount === 100,
      JSON.stringify({ created: created.created, note: created.note, status: created.refund?.status }));
    const repeated = await recordRefundObligation({
      order: await fresh(shape._id),
      amount: 100,
      reason: "shape probe",
      dedupeKey: `SHAPE ${shape._id}`,
    });
    ok("and { refund: existing, created: false } on a repeat",
      repeated.created === false && String(repeated.refund?._id) === String(created.refund?._id));
  }
} catch (error) {
  console.error(`\nSUITE ABORTED: ${error?.stack || error}`);
  ok("suite ran to completion", false, error?.message);
} finally {
  globalThis.fetch = originalFetch;
  await AuditLog.deleteMany({ targetId: { $in: trash.orders } });
  await OrderModel.deleteMany({ _id: { $in: trash.orders } });
  await ProductModel.deleteMany({ _id: { $in: trash.products } });
  const { failed } = finish();
  await mongoose.disconnect();
  process.exit(failed ? 1 : 0);
}
