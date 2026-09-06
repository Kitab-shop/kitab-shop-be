/**
 * Closed-state enforcement (audit H2-05, Tier 2) + the owed-refund operator surface.
 *
 * TWO INVARIANTS:
 *
 *   1. An RTO order cannot become "Closed" until its disposition is recorded.
 *
 *      The transition table defines "Closed" as "the parcel is back, its condition
 *      recorded, and any refund owed settled", but could only enforce the first
 *      part. RecordRtoDisposition accepts ONLY "RTO Received" and "Closed" is
 *      terminal, so closing early left the units neither restocked nor written off,
 *      with no path back to record them. One click, stock silently stranded.
 *
 *   2. Every refund liability with status "owed" is discoverable by an authorized
 *      operator, without any of it moving money.
 *
 *      The obligation is recorded the moment it is incurred and deliberately not
 *      pushed to the gateway — an unattended courier feed must not issue
 *      irreversible refunds. Correct, but until now nothing read those rows.
 *
 * Everything here drives the REAL controllers, including the courier webhook and its
 * token auth, so the transition table, the disposition claim, the obligation ledger
 * and the aggregation all run as deployed.
 *
 * Run with `npm run test:closed-owed-refunds` (or `npm test` for everything).
 */
process.env.SHIPROCKET_ENABLED = "true";
process.env.SHIPROCKET_WEBHOOK_ENABLED = "true";
process.env.SHIPROCKET_WEBHOOK_TOKEN = "stub-webhook-token";
process.env.SHIPROCKET_EMAIL = "stub@example.test";
process.env.SHIPROCKET_PASSWORD = "stub-password";
process.env.SHIPROCKET_BASE_URL = "https://shiprocket.invalid/v1/external";
process.env.INVENTORY_ENFORCE_STOCK = "true";
process.env.NOTIFICATIONS_ENABLED = "false";
process.env.PAYMENTS_ENABLED = "false";

import mongoose from "mongoose";
import { readFile } from "node:fs/promises";
import { connect, createSuite, marker, productFixture, addressFixture, pinShiprocketCapabilities } from "./helpers.mjs";

const { ok, section, finish } = createSuite("closed-owed-refunds");
await connect();
// Pinned so this suite does not depend on how the store happens to be configured in the
// admin panel: it drives Shiprocket paths, and an admin choosing "manual fulfilment" or
// "Shiprocket basics" would otherwise make it fail for a correct reason.
const restoreCapabilities = await pinShiprocketCapabilities();

const OrderModel = (await import("../src/modules/orders/Order.model.js")).default;
const ProductModel = (await import("../src/modules/products/Product.model.js")).default;
const UserModel = (await import("../src/model/User.model.js")).default;
await import("../src/modules/categories/Category.model.js");
const orderController = await import("../src/modules/orders/order.controller.js");
const shippingController = await import("../src/modules/shipping/shipping.controller.js");
const { AdminGetOwedRefunds } = await import("../src/modules/payments/owed-refund.controller.js");
const { recordRefundObligation, recomputeRefundState, sumRefunded, sumOwedRefunds } = await import(
  "../src/modules/payments/return-refund.service.js"
);
const { ADMIN_PERMISSIONS } = await import("../src/config/admin-permissions.config.js");
const { requirePermission } = await import("../src/middleware/require-permission.middleware.js");

const MARKER = marker("closedowed");
const trash = { orders: [], products: [], users: [] };
let seq = 0;

const makeProduct = async (label, { stock = 20 } = {}) => {
  const product = await ProductModel.create(
    productFixture(`${MARKER}-${label}-${(seq += 1)}`, { stock }),
  );
  trash.products.push(product._id);
  return product;
};

const makeOrder = async ({
  product,
  units = 2,
  orderStatus = "RTO Received",
  paymentMethod = "RAZORPAY",
  paymentStatus = "Paid",
} = {}) => {
  seq += 1;
  const item = product || (await makeProduct("auto"));
  const subtotal = item.price * units;
  const order = await OrderModel.create({
    user: new mongoose.Types.ObjectId(),
    items: [
      { product: item._id, name: item.name, image: "x.png", price: item.price, quantity: units },
    ],
    shippingAddress: addressFixture(),
    paymentMethod,
    paymentStatus,
    orderStatus,
    subtotal,
    totalAmount: subtotal,
    ...(paymentMethod === "RAZORPAY" ? { razorpayPaymentId: `pay_${MARKER}_${seq}` } : {}),
    shiprocket: {
      orderId: 950000 + seq,
      shipmentId: 850000 + seq,
      awbCode: `AWB-${MARKER}-${seq}`,
      syncStatus: "rto",
    },
  });
  trash.orders.push(order._id);
  return { order, product: item };
};

const callController = async (handler, { params = {}, body = {}, user, query = {}, headers = {} }) => {
  let statusCode = 200;
  let payload;
  const res = {
    status(code) { statusCode = code; return this; },
    json(data) { payload = data; return this; },
  };
  await handler({ params, body, user, query, get: (key) => headers[key.toLowerCase()] }, res);
  return { statusCode, body: payload };
};

const admin = () => ({ id: String(new mongoose.Types.ObjectId()), roles: ["admin"] });

const setStatus = (orderId, orderStatus, user = admin()) =>
  callController(orderController.UpdateOrderStatus, {
    params: { orderId: String(orderId) },
    body: { orderStatus },
    user,
  });

const recordDisposition = (orderId, disposition, dispositionNote = "") =>
  callController(orderController.RecordRtoDisposition, {
    params: { orderId: String(orderId) },
    body: { disposition, dispositionNote },
    user: admin(),
  });

const sendWebhook = (body) =>
  callController(shippingController.ShippingWebhook, {
    body,
    headers: { "x-api-key": "stub-webhook-token" },
  });

const listOwed = (query = {}) =>
  callController(AdminGetOwedRefunds, { query, user: admin() });

const fresh = (id) => OrderModel.findById(id);
const stockOf = async (id) => (await ProductModel.findById(id)).stock;

/** Everything the GET must not change. */
const snapshot = async (orderId, productId) => {
  const order = await fresh(orderId);
  return JSON.stringify({
    orderStatus: order.orderStatus,
    paymentStatus: order.paymentStatus,
    refunds: order.refunds.map((r) => ({ amount: r.amount, status: r.status, reason: r.reason })),
    rtoDisposition: order.rtoDisposition,
    stock: productId ? await stockOf(productId) : null,
  });
};

try {
  // ═══════════════════════════════════════════════════════════════════════════
  section("1 — INVARIANT 1: Closed refuses an unrecorded parcel");

  {
    // Not a legal move at all: the table permits Closed only from RTO Received.
    const { order: fromRto } = await makeOrder({ orderStatus: "RTO" });
    const premature = await setStatus(fromRto._id, "Closed");
    ok("RTO → Closed is refused by the transition table",
      premature.statusCode === 400 && premature.body?.code === "INVALID_STATUS_TRANSITION",
      `${premature.statusCode} ${premature.body?.code}`);
    ok("  and the order is untouched", (await fresh(fromRto._id)).orderStatus === "RTO");

    const { order } = await makeOrder({ orderStatus: "RTO Received" });
    const noDisposition = await setStatus(order._id, "Closed");
    ok("RTO Received → Closed without a disposition is refused",
      noDisposition.statusCode === 409 &&
        noDisposition.body?.code === "RTO_DISPOSITION_REQUIRED",
      `${noDisposition.statusCode} ${noDisposition.body?.code}`);
    ok("  with the remedy stated, not a generic error",
      /resellable/i.test(noDisposition.body?.message || "") &&
        /damaged/i.test(noDisposition.body?.message || ""),
      noDisposition.body?.message);
    ok("  and reports where the order actually is",
      noDisposition.body?.currentStatus === "RTO Received");

    const after = await fresh(order._id);
    ok("  the order stays at RTO Received, so the disposition is still recordable",
      after.orderStatus === "RTO Received", after.orderStatus);
    ok("  and nothing was appended to its history",
      after.statusHistory.every((entry) => entry.to !== "Closed"));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("2 — a recorded parcel closes, in both conditions");

  {
    for (const disposition of ["resellable", "damaged"]) {
      const { order, product } = await makeOrder({ orderStatus: "RTO Received", units: 2 });
      const before = await stockOf(product._id);

      const recorded = await recordDisposition(order._id, disposition, "checked on arrival");
      ok(`a ${disposition} disposition is accepted`, recorded.statusCode === 200,
        `${recorded.statusCode} ${recorded.body?.message}`);

      const afterDisposition = await stockOf(product._id);
      const expected = disposition === "resellable" ? before + 2 : before;
      ok(`  stock moves exactly as the existing rules say (${disposition})`,
        afterDisposition === expected, `${afterDisposition} vs ${expected}`);

      const closed = await setStatus(order._id, "Closed");
      ok(`  and the order can now be closed (${disposition})`, closed.statusCode === 200,
        `${closed.statusCode} ${closed.body?.code || closed.body?.message}`);

      const saved = await fresh(order._id);
      ok("  it is Closed", saved.orderStatus === "Closed", saved.orderStatus);
      ok("  the disposition is preserved", saved.rtoDisposition === disposition);
      ok("  the note is preserved", saved.rtoDispositionNote === "checked on arrival");
      const entry = saved.statusHistory.at(-1);
      ok("  the move is audited", entry?.from === "RTO Received" && entry?.to === "Closed",
        JSON.stringify(entry));

      ok("  CLOSING ITSELF RESTOCKED NOTHING", (await stockOf(product._id)) === expected,
        `${await stockOf(product._id)} vs ${expected}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("3 — Closed is terminal");

  {
    const { order, product } = await makeOrder({ orderStatus: "RTO Received" });
    await recordDisposition(order._id, "damaged");
    await setStatus(order._id, "Closed");
    const stockAtClose = await stockOf(product._id);

    for (const target of ["RTO", "RTO Received", "Delivered", "Shipped", "Pending"]) {
      const attempt = await setStatus(order._id, target);
      ok(`Closed → ${target} is refused`,
        attempt.statusCode === 400 && attempt.body?.code === "INVALID_STATUS_TRANSITION",
        `${attempt.statusCode} ${attempt.body?.code}`);
    }
    // Cancelled is refused earlier, by the cancel-endpoint guard — a different
    // refusal for a different reason, and still a refusal.
    const cancelled = await setStatus(order._id, "Cancelled");
    ok("Closed → Cancelled is refused",
      cancelled.statusCode === 400 && cancelled.body?.code === "USE_CANCEL_ENDPOINT",
      `${cancelled.statusCode} ${cancelled.body?.code}`);

    const saved = await fresh(order._id);
    ok("the order is still Closed", saved.orderStatus === "Closed", saved.orderStatus);
    ok("and nothing restocked on any of those attempts",
      (await stockOf(product._id)) === stockAtClose);

    // The trap this phase closes: a disposition can never be recorded after closing.
    const late = await recordDisposition(order._id, "resellable");
    ok("a disposition still cannot be recorded once Closed — which is why the guard exists",
      late.statusCode === 409 && late.body?.code === "NOT_RTO_RECEIVED",
      `${late.statusCode} ${late.body?.code}`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("4 — the existing disposition endpoint is unchanged");

  {
    const { order } = await makeOrder({ orderStatus: "RTO" });
    const tooEarly = await recordDisposition(order._id, "resellable");
    ok("a disposition still requires RTO Received",
      tooEarly.statusCode === 409 && tooEarly.body?.code === "NOT_RTO_RECEIVED");

    const { order: received, product } = await makeOrder({ orderStatus: "RTO Received", units: 3 });
    const invalid = await recordDisposition(received._id, "sellable-ish");
    ok("an invalid disposition value is still refused",
      invalid.statusCode === 400 && invalid.body?.code === "DISPOSITION_REQUIRED");
    ok("  and no new disposition values were introduced",
      JSON.stringify(
        OrderModel.schema.path("rtoDisposition").enumValues.filter(Boolean),
      ) === JSON.stringify(["resellable", "damaged"]),
      JSON.stringify(OrderModel.schema.path("rtoDisposition").enumValues));

    const before = await stockOf(product._id);
    await recordDisposition(received._id, "resellable");
    const once = await stockOf(product._id);
    ok("a resellable parcel restocks exactly once", once === before + 3, `${once} vs ${before + 3}`);

    const second = await recordDisposition(received._id, "damaged");
    ok("a second disposition is still refused",
      second.statusCode === 409 && second.body?.code === "DISPOSITION_ALREADY_RECORDED");
    ok("  and it did not restock again", (await stockOf(product._id)) === once);
    ok("  rtoRestockedAt idempotency is intact",
      (await fresh(received._id)).rtoRestockedAt instanceof Date);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("5 — concurrency");

  {
    // Without a disposition, BOTH attempts must fail.
    const { order: unrecorded } = await makeOrder({ orderStatus: "RTO Received" });
    const bothRefused = await Promise.all([
      setStatus(unrecorded._id, "Closed"),
      setStatus(unrecorded._id, "Closed"),
    ]);
    ok("two concurrent closes without a disposition both fail",
      bothRefused.every((r) => r.statusCode === 409),
      JSON.stringify(bothRefused.map((r) => r.statusCode)));
    ok("  and neither closed the order",
      (await fresh(unrecorded._id)).orderStatus === "RTO Received");

    // With a disposition, exactly one transition and one history entry.
    const { order, product } = await makeOrder({ orderStatus: "RTO Received", units: 2 });
    await recordDisposition(order._id, "resellable");
    const stockAfterDisposition = await stockOf(product._id);

    const races = await Promise.all([
      setStatus(order._id, "Closed"),
      setStatus(order._id, "Closed"),
      setStatus(order._id, "Closed"),
    ]);
    const won = races.filter((r) => r.statusCode === 200 && r.body?.message === "Order closed");
    ok("exactly one concurrent close wins the claim", won.length === 1,
      JSON.stringify(races.map((r) => `${r.statusCode}:${r.body?.code || r.body?.message}`)));

    const saved = await fresh(order._id);
    ok("the order is Closed", saved.orderStatus === "Closed");
    ok("and there is exactly ONE Closed history entry",
      saved.statusHistory.filter((entry) => entry.to === "Closed").length === 1,
      String(saved.statusHistory.filter((e) => e.to === "Closed").length));
    ok("and the race restocked nothing",
      (await stockOf(product._id)) === stockAfterDisposition);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("6 — the guard cannot drift, and nothing else can produce Closed");

  {
    const orderSource = await readFile(
      new URL("../src/modules/orders/order.controller.js", import.meta.url),
      "utf8",
    );
    ok("the valid dispositions are read off the schema, not restated",
      /enumValues\.filter\(Boolean\)/.test(orderSource));
    ok("the guard has a dedicated error code",
      /RTO_DISPOSITION_REQUIRED/.test(orderSource));
    ok("and it is enforced with the precondition in the FILTER, not a read-then-write",
      /rtoDisposition:\s*\{\s*\$in:\s*RECORDED_RTO_DISPOSITIONS\s*\}/.test(orderSource));
    // Asserted against the SCHEMA, not the source: the source mentions the flag it
    // deliberately did not add, and a comment is not a field.
    ok("no new readiness flag was invented — the existing disposition fields carry it",
      !Object.keys(OrderModel.schema.paths).some((path) => /readyToClose|readyForClose/i.test(path)),
      JSON.stringify(Object.keys(OrderModel.schema.paths).filter((p) => /rto/i.test(p))));

    // The courier webhook must remain unable to close an order.
    const shippingSource = await readFile(
      new URL("../src/modules/shipping/shipping.controller.js", import.meta.url),
      "utf8",
    );
    const mapper = shippingSource.slice(shippingSource.indexOf("const mapOrderStatus"));
    // Bounded by the function's own closing brace, not a fixed character count —
    // a 900-char window stopped covering the whole body once the status-code
    // tables were added, so the assertion was reading a partial function.
    const body = mapper.slice(0, mapper.indexOf("\n};") + 3);
    const mapped = [...body.matchAll(/return "([^"]+)"/g)].map((m) => m[1]);
    ok("mapOrderStatus cannot produce Closed, so no courier event can close an order",
      !mapped.includes("Closed"), JSON.stringify(mapped));

    const { order } = await makeOrder({ orderStatus: "RTO Received" });
    const viaWebhook = await sendWebhook({
      order_id: String(order._id),
      shipment_status_id: 10,
      shipment_status: "RTO DELIVERED",
    });
    ok("an RTO arrival event is still accepted", viaWebhook.statusCode === 200);
    ok("and it did NOT close the order",
      (await fresh(order._id)).orderStatus === "RTO Received");
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("7 — INVARIANT 2: the owed liability is discoverable");

  {
    // The full chain: prepaid → unsettled partial obligation → Refund Pending →
    // RTO Received → RTO obligation → owed.
    const { order, product } = await makeOrder({ orderStatus: "RTO", units: 3 });
    const oneUnit = Math.round((order.totalAmount / 3) * 100) / 100;
    await recordRefundObligation({
      order,
      amount: oneUnit,
      reason: "Partial cancellation",
      dedupeKey: `PARTIAL ${order._id}`,
    });
    const pending = await fresh(order._id);
    ok("the order is at Refund Pending", pending.paymentStatus === "Refund Pending",
      pending.paymentStatus);

    await sendWebhook({
      sr_order_id: order.shiprocket.orderId,
      shipment_status_id: 10,
      shipment_status: "RTO DELIVERED",
    });
    const withRto = await fresh(order._id);
    ok("the RTO obligation is recorded", withRto.refunds.length === 2,
      String(withRto.refunds.length));
    ok("both are owed", withRto.refunds.every((r) => r.status === "owed"));
    ok("and the ceiling holds", sumRefunded(withRto) <= withRto.totalAmount + 0.01,
      `${sumRefunded(withRto)} of ${withRto.totalAmount}`);

    const listed = await listOwed({ limit: "100" });
    ok("the operator surface responds", listed.statusCode === 200);
    const mine = (listed.body?.data || []).filter(
      (row) => String(row.orderId) === String(order._id),
    );
    ok("it finds BOTH liabilities for this order", mine.length === 2, String(mine.length));

    const rtoRow = mine.find((row) => row.isRto);
    const partialRow = mine.find((row) => !row.isRto);
    ok("the RTO one is flagged from its existing dedupe key", Boolean(rtoRow));
    ok("  with the remaining amount", Math.abs(rtoRow.amount - (order.totalAmount - oneUnit)) < 0.01,
      `${rtoRow?.amount}`);
    ok("the ordinary obligation is present but NOT flagged as RTO", Boolean(partialRow),
      JSON.stringify(mine.map((r) => r.isRto)));
    ok("  so an operator can tell them apart", rtoRow.isRto === true && partialRow.isRto === false);

    ok("each row identifies the order", Boolean(rtoRow.orderId));
    ok("the refund amount", typeof rtoRow.amount === "number");
    ok("the reason", typeof rtoRow.reason === "string" && rtoRow.reason.length > 0);
    ok("the refund status", rtoRow.refundStatus === "owed");
    ok("the order's payment status", rtoRow.paymentStatus === "Refund Pending");
    ok("when it became owed", Boolean(rtoRow.owedSince));
    ok("how it must be settled", ["gateway", "manual"].includes(rtoRow.confirmationMethod));
    ok("the RTO context already on the order", "rtoDisposition" in rtoRow);
    ok("and the order status", rtoRow.orderStatus === "RTO Received", rtoRow.orderStatus);

    ok("the total outstanding is summed across all rows, not just this page",
      listed.body?.summary?.totalOwedAmount >= sumOwedRefunds(withRto) - 0.01,
      JSON.stringify(listed.body?.summary));

    // No payment identifiers or secrets.
    for (const leaked of [
      "razorpayPaymentId", "razorpayOrderId", "providerPaymentId", "providerRefundId",
      "idempotencyKey", "shippingAddress", "items",
    ]) {
      ok(`  "${leaked}" is not exposed`, !(leaked in rtoRow), JSON.stringify(Object.keys(rtoRow)));
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("8 — what must NOT appear in the list");

  {
    // COD RTO: nothing was collected, so nothing is owed.
    const { order: cod } = await makeOrder({
      orderStatus: "RTO",
      paymentMethod: "COD",
      paymentStatus: "Pending",
    });
    await sendWebhook({
      sr_order_id: cod.shiprocket.orderId,
      shipment_status_id: 10,
      shipment_status: "RTO DELIVERED",
    });
    const codFresh = await fresh(cod._id);
    ok("a COD RTO records no obligation", codFresh.refunds.length === 0);
    const afterCod = await listOwed({ limit: "100" });
    ok("and never appears in the owed list",
      !(afterCod.body?.data || []).some((row) => String(row.orderId) === String(cod._id)));

    // Fully refunded: no headroom, so no additional owed amount.
    const { order: settled } = await makeOrder({ orderStatus: "RTO", units: 1 });
    await recordRefundObligation({
      order: settled,
      amount: settled.totalAmount,
      reason: "Full cancellation",
      dedupeKey: `FULL ${settled._id}`,
    });
    const owedDoc = await fresh(settled._id);
    owedDoc.refunds[0].status = "processed";
    owedDoc.refunds[0].providerRefundId = `rfnd_${MARKER}_${settled._id}`;
    await owedDoc.save();
    const toRecompute = await fresh(settled._id);
    await recomputeRefundState(toRecompute);
    ok("the order is fully Refunded", toRecompute.paymentStatus === "Refunded",
      toRecompute.paymentStatus);

    await sendWebhook({
      sr_order_id: settled.shiprocket.orderId,
      shipment_status_id: 10,
      shipment_status: "RTO DELIVERED",
    });
    const afterSettledRto = await fresh(settled._id);
    ok("no additional obligation is created", afterSettledRto.refunds.length === 1);
    ok("and the ceiling is preserved",
      sumRefunded(afterSettledRto) <= afterSettledRto.totalAmount + 0.01);

    const afterSettled = await listOwed({ limit: "100" });
    ok("a fully refunded RTO is absent from the owed list",
      !(afterSettled.body?.data || []).some((row) => String(row.orderId) === String(settled._id)));

    // A settled refund of any kind must not be listed.
    ok("no processed refund appears anywhere in the list",
      (afterSettled.body?.data || []).every((row) => row.refundStatus === "owed"));

    // An abandoned checkout must never reach a revenue-shaped list. This aggregate
    // does not apply EXCLUDE_AWAITING_PAYMENT because matching on an owed refund is
    // stricter than the filter — recordRefundObligation refuses to write one unless
    // money was collected, and an awaiting-payment order is "Pending". That is the
    // reasoning behind its entry in lifecycle.regression.mjs's EXEMPT list, so it is
    // proved here with a fixture rather than left as an argument.
    const { order: awaiting } = await makeOrder({
      orderStatus: "Pending",
      paymentStatus: "Pending",
    });
    const refused = await recordRefundObligation({
      order: awaiting,
      amount: awaiting.totalAmount,
      reason: "should never be owed",
      dedupeKey: `NEVER ${awaiting._id}`,
    });
    ok("an unpaid checkout cannot be given an owed refund at all",
      refused.created === false && refused.noMoneyCollected === true,
      JSON.stringify(refused));
    ok("  so it has no refund rows", (await fresh(awaiting._id)).refunds.length === 0);
    const afterAwaiting = await listOwed({ limit: "100" });
    ok("  and it is structurally absent from the owed list",
      !(afterAwaiting.body?.data || []).some((row) => String(row.orderId) === String(awaiting._id)));
    ok("  every listed row belongs to an order where money was collected",
      (afterAwaiting.body?.data || []).every((row) =>
        ["Paid", "Partially Refunded", "Refund Pending", "Refunded"].includes(row.paymentStatus)),
      JSON.stringify([...new Set((afterAwaiting.body?.data || []).map((r) => r.paymentStatus))]));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("9 — the list moves no money");

  {
    const { order, product } = await makeOrder({ orderStatus: "RTO Received", units: 2 });
    await recordRefundObligation({
      order,
      amount: order.totalAmount,
      reason: "Parcel returned to origin undelivered",
      dedupeKey: `RTO ${order._id}`,
    });

    const before = await snapshot(order._id, product._id);
    const first = await listOwed({ limit: "100" });
    const afterOne = await snapshot(order._id, product._id);
    ok("one GET changes nothing at all", before === afterOne);

    const second = await listOwed({ limit: "100" });
    const third = await listOwed({ limit: "100" });
    const afterMany = await snapshot(order._id, product._id);
    ok("repeated GETs change nothing", before === afterMany);
    ok("and return identical results",
      JSON.stringify(second.body?.data) === JSON.stringify(third.body?.data));

    const saved = await fresh(order._id);
    ok("no refund was created", saved.refunds.length === 1);
    ok("no refund was settled", saved.refunds[0].status === "owed");
    ok("no gateway attempt was recorded", saved.refunds[0].gatewayAttemptedAt === null);
    ok("the order status is unchanged", saved.orderStatus === "RTO Received");
    ok("the payment status is unchanged", saved.paymentStatus === "Refund Pending",
      saved.paymentStatus);
    ok("the disposition is unchanged", saved.rtoDisposition === "");
    ok("and inventory is unchanged", (await stockOf(product._id)) === product.stock,
      `${await stockOf(product._id)} vs ${product.stock}`);

    // Pagination must not silently drop liabilities.
    const paged = await listOwed({ page: "1", limit: "1" });
    ok("pagination returns one row per page", (paged.body?.data || []).length === 1);
    ok("with the real total, not the page size", paged.body?.pagination?.total > 1,
      JSON.stringify(paged.body?.pagination));
    ok("and totalPages reflects it",
      paged.body?.pagination?.totalPages === paged.body?.pagination?.total);
    ok("the summary counts every liability, not just the page",
      paged.body?.summary?.count === paged.body?.pagination?.total);
    ok("oldest owed first, so the worst case is not buried",
      (first.body?.data || []).every((row, index, all) =>
        index === 0 || new Date(all[index - 1].owedSince) <= new Date(row.owedSince)));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("10 — authorization");

  {
    const makeUser = async (roles, extra = {}) => {
      const user = await UserModel.create({
        name: `${MARKER} user`,
        email: `${MARKER}-${trash.users.length}@test.local`,
        password: "x".repeat(60),
        roles,
        ...extra,
      });
      trash.users.push(user._id);
      return user;
    };

    const gate = requirePermission(ADMIN_PERMISSIONS.ORDERS_MANAGE);
    const runGate = async (user) => {
      let statusCode = 200;
      let passed = false;
      const res = { status(code) { statusCode = code; return this; }, json() { return this; } };
      await gate({ user: user ? { id: String(user._id) } : undefined }, res, () => { passed = true; });
      return { statusCode, passed };
    };

    const anonymous = await runGate(null);
    ok("an unauthenticated caller is refused", !anonymous.passed && anonymous.statusCode === 403);

    const customer = await makeUser(["user"]);
    ok("a signed-in customer is refused", !(await runGate(customer)).passed);

    const themeEditor = await makeUser(["themeEditor"]);
    ok("an admin without orders:manage is refused", !(await runGate(themeEditor)).passed);

    const blocked = await makeUser(["admin"], { isBlocked: true });
    ok("a blocked admin is refused", !(await runGate(blocked)).passed);

    const orderAdmin = await makeUser(["admin"]);
    ok("an admin with orders:manage is allowed", (await runGate(orderAdmin)).passed === true);

    const routes = await readFile(
      new URL("../src/modules/admin/admin.routes.js", import.meta.url),
      "utf8",
    );
    const route = routes.split("\n").find((line) => line.includes('"/refunds/owed"'));
    ok("the route exists", Boolean(route), String(route));
    ok("it is admin-gated", /isAdmin/.test(route || ""));
    ok("it requires the established orders:manage permission",
      /ORDERS_MANAGE/.test(route || ""));
    ok("and it is a GET — the surface cannot mutate", /router\.get/.test(route || ""));

    const controllerSource = await readFile(
      new URL("../src/modules/payments/owed-refund.controller.js", import.meta.url),
      "utf8",
    );
    // The contract changed deliberately: the LIST stays read-only (the GET
    // check above), but the controller now also hosts the manual-settle
    // endpoint for obligations no gateway can pay. What must hold instead:
    // the settle is an atomic owed-only claim (double-click safe), it refuses
    // gateway-payable rows, and paymentStatus is derived from the ledger.
    ok("settlement claims the owed row atomically",
      /findOneAndUpdate[\s\S]{0,400}status: "owed"/.test(controllerSource));
    ok("gateway-payable rows are refused a manual settle",
      /canAutoRefund/.test(controllerSource) && /USE_GATEWAY_REFUND/.test(controllerSource));
    ok("a manual method and reference are mandatory evidence",
      /MANUAL_METHODS/.test(controllerSource) && /reference/.test(controllerSource));
    ok("paymentStatus follows the ledger, never asserted directly",
      /recomputeRefundState/.test(controllerSource) &&
        !/paymentStatus\s*=/.test(controllerSource));
    ok("and it filters in the database, not in JavaScript",
      /\$match[\s\S]*refunds\.status/.test(controllerSource) &&
        !/\.filter\(\s*\(?\s*\w+\s*\)?\s*=>\s*\w+\.refunds/.test(controllerSource));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("11 — the FE surface");

  {
    const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
    const page = await read("../../kitab-shop-fe/src/pages/admin/AdminOwedRefunds.jsx");
    ok("the admin page calls the owed endpoint", /admin\/refunds\/owed/.test(page));
    ok("it distinguishes owed from settled", /Owed/.test(page));
    ok("it shows the RTO indicator", /isRto/.test(page));
    ok("the amount", /row\.amount/.test(page));
    ok("the reason", /row\.reason/.test(page));
    ok("the payment status", /row\.paymentStatus/.test(page));
    ok("the customer", /customerName/.test(page));
    ok("and how long it has been outstanding", /outstanding/.test(page));
    for (const state of ["loading", "error", "pagination"]) {
      ok(`it has a ${state} state`, new RegExp(state, "i").test(page));
    }
    ok("it has an empty state", /Nothing outstanding/.test(page));
    ok("it links to the existing refund workflow rather than duplicating it",
      /admin\/orders\/\$\{row\.orderId\}/.test(page));
    ok("and adds no refund trigger of its own",
      !/razorpay\/refund/.test(page) && !/idempotencyKey/.test(page));

    const app = await read("../../kitab-shop-fe/src/App.jsx");
    ok("the route is registered", /refunds\/owed/.test(app));
    const nav = await read("../../kitab-shop-fe/src/features/admin-layout/adminLayout.helpers.js");
    ok("and it is reachable from the admin nav", /refunds\/owed/.test(nav));
    ok("gated on the same permission as the backend", /Outstanding Refunds[\s\S]{0,80}orders:manage/.test(nav));
  }
} catch (error) {
  console.error("\nSUITE ABORTED:", error);
  process.exitCode = 1;
} finally {
  await OrderModel.deleteMany({ _id: { $in: trash.orders } });
  await ProductModel.deleteMany({ _id: { $in: trash.products } });
  await UserModel.deleteMany({ _id: { $in: trash.users } });
  await mongoose.disconnect();
  restoreCapabilities();
  finish();
}
