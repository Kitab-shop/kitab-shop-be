/**
 * The RTO lifecycle terminal state (audit H2-05, Option A: `Closed` only).
 *
 *   RTO ──▶ RTO Received ──▶ Closed
 *
 * An RTO used to close out as "Cancelled", which made that status mean two
 * different things: "called off before dispatch" and "we shipped it and it came
 * back". Both must stay out of revenue, but only one is a cancellation, and the
 * overloading hid the distinction from every report and every operator.
 *
 * `RTO In Transit` is deliberately NOT added: the reporting need it was meant to
 * serve (awaiting receipt vs received) is already answered by RTO vs RTO Received,
 * and its only trigger would be a fragile courier text match with no status id.
 *
 * Run with `npm run test:rto-closed` (or `npm test` for everything).
 *
 * The webhook scenarios drive the REAL ShippingWebhook including its token auth, so
 * the mapper, the transition table, the COD promotion and the RTO refund branch all
 * run as deployed.
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
// Payments stay OFF for this suite; only payOwedRefund below switches them on, for
// the duration of one stubbed Razorpay refund. The keys are needed for getRazorpay()
// to build its (stubbed) client then.
process.env.PAYMENT_PROVIDER = "razorpay";
process.env.RAZORPAY_KEY_ID = "rzp_test_stub0000000";
process.env.RAZORPAY_KEY_SECRET = "stub_secret_for_tests";

import mongoose from "mongoose";
import { readFile } from "node:fs/promises";
import { connect, createSuite, marker, productFixture, addressFixture, pinShiprocketCapabilities } from "./helpers.mjs";

const { ok, section, finish } = createSuite("rto-closed");
await connect();
// Pinned so this suite does not depend on how the store happens to be configured in the
// admin panel: it drives Shiprocket paths, and an admin choosing "manual fulfilment" or
// "Shiprocket basics" would otherwise make it fail for a correct reason.
const restoreCapabilities = await pinShiprocketCapabilities();

const OrderModel = (await import("../../src/modules/orders/Order.model.js")).default;
const ProductModel = (await import("../../src/modules/products/Product.model.js")).default;
const ShiprocketSetting = (await import("../../src/modules/shipping/ShiprocketSetting.model.js")).default;
await import("../../src/modules/categories/Category.model.js");
const {
  ORDER_STATUSES,
  ORDER_STATUS_TRANSITIONS,
  NON_FULFILLABLE_STATUSES,
  NON_REVENUE_STATUSES,
  RTO_LIFECYCLE_STATUSES,
  canTransitionOrderStatus,
  isFulfillableStatus,
} = await import("../../src/modules/orders/order-status.rules.js");
const { recordRefundObligation, sumOwedRefunds, sumRefunded, sumSettledRefunds } = await import(
  "../../src/modules/payments/return-refund.service.js"
);
const shippingController = await import("../../src/modules/shipping/shipping.controller.js");
const orderController = await import("../../src/modules/orders/order.controller.js");
const { buildSalesReportData } = await import("../../src/modules/admin/admin-report.service.js");
const razorpayService = await import("../../src/modules/payments/razorpay.service.js");

await OrderModel.init();
await ShiprocketSetting.getSettings();

const MARKER = marker("rtoclosed");
const trash = { orders: [], products: [] };
let seq = 0;

// Shiprocket is never contacted; only the cancel endpoint would be, and nothing
// here cancels a shipment.
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input) => {
  const url = String(input instanceof URL ? input.href : input);
  if (url.includes("/auth/login")) {
    return new Response(JSON.stringify({ token: "t" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  throw new Error(`Unexpected Shiprocket call: ${url}`);
};

const makeProduct = async (label, stock = 50) => {
  const product = await ProductModel.create(productFixture(`${MARKER}-${label}`, { stock }));
  trash.products.push(product._id);
  return product;
};

const makeOrder = async ({
  product,
  units = 2,
  orderStatus = "RTO",
  paymentMethod = "RAZORPAY",
  paymentStatus = "Paid",
  srOrderId = null,
  ...fields
}) => {
  seq += 1;
  const subtotal = product.price * units;
  const order = await OrderModel.create({
    user: new mongoose.Types.ObjectId(),
    items: [
      { product: product._id, name: product.name, image: "x.png", price: product.price, quantity: units },
    ],
    shippingAddress: addressFixture(),
    paymentMethod,
    paymentStatus,
    orderStatus,
    subtotal,
    totalAmount: subtotal,
    ...(paymentMethod === "RAZORPAY" ? { razorpayPaymentId: `pay_${MARKER}_${seq}` } : {}),
    shiprocket: {
      orderId: srOrderId ?? 940000 + seq,
      shipmentId: 840000 + seq,
      awbCode: `AWB-${MARKER}-${seq}`,
      status: "RTO IN TRANSIT",
      syncStatus: "rto",
    },
    ...fields,
  });
  trash.orders.push(order._id);
  return order;
};

const callController = async (handler, { params = {}, body = {}, user, query = {} }) => {
  let statusCode = 200;
  let payload;
  const res = {
    status(code) { statusCode = code; return this; },
    json(data) { payload = data; return this; },
  };
  await handler({ params, body, user, query }, res);
  return { statusCode, body: payload };
};

const sendWebhook = (body, { token = "stub-webhook-token" } = {}) =>
  callController(
    (req, res) =>
      shippingController.ShippingWebhook(
        { ...req, get: (h) => (h.toLowerCase() === "x-api-key" ? token : undefined) },
        res,
      ),
    { body },
  );

const admin = () => ({ id: String(new mongoose.Types.ObjectId()), roles: ["admin"] });

const setStatus = (order, status) =>
  callController(orderController.UpdateOrderStatus, {
    params: { orderId: String(order._id) },
    body: { orderStatus: status },
    user: admin(),
  });

const recordDisposition = (order, disposition) =>
  callController(orderController.RecordRtoDisposition, {
    params: { orderId: String(order._id) },
    body: { disposition },
    user: admin(),
  });

/**
 * Settles an owed RTO refund the way an operator now does (G2): "Refund via
 * Razorpay", i.e. the reconcile endpoint, against a stubbed gateway. Payments are
 * switched on only for this call — the rest of the suite keeps them off, as it
 * always has.
 */
const razorpayRefundCalls = [];
const payOwedRefund = async (order) => {
  const current = await OrderModel.findById(order._id);
  const owed = current.refunds.find((refund) => refund.status === "owed");
  const previous = process.env.PAYMENTS_ENABLED;
  process.env.PAYMENTS_ENABLED = "true";
  try {
    const { razorpay } = razorpayService.getRazorpay();
    razorpay.payments.refund = async (paymentId, options) => {
      razorpayRefundCalls.push({ paymentId, options });
      return { id: `rfnd_${MARKER}_${razorpayRefundCalls.length}`, status: "processed" };
    };
    razorpay.payments.fetchMultipleRefund = async () => ({ items: [] });
    return await callController(orderController.ReconcileOrderRefund, {
      params: { orderId: String(order._id), refundId: String(owed?._id) },
      user: admin(),
    });
  } finally {
    process.env.PAYMENTS_ENABLED = previous;
  }
};

const snapshot = async (id) => {
  const order = await OrderModel.findById(id).lean();
  return {
    orderStatus: order.orderStatus,
    paymentStatus: order.paymentStatus,
    deliveredAt: order.deliveredAt ? "set" : null,
    history: (order.statusHistory || []).map((e) => e.to),
    refunds: (order.refunds || []).length,
    rtoRestockedAt: order.rtoRestockedAt ? "set" : null,
    rtoDisposition: order.rtoDisposition || "",
  };
};

try {
  // ═══════════════════════════════════════════════════════════════════════════
  section("the state machine");

  {
    ok('"Closed" is a real order status', ORDER_STATUSES.includes("Closed"));
    ok("RTO → RTO Received is legal", canTransitionOrderStatus("RTO", "RTO Received").ok === true);
    ok("RTO Received → Closed is legal", canTransitionOrderStatus("RTO Received", "Closed").ok === true);
    ok(
      "RTO → Closed is REFUSED — a parcel that has not arrived cannot be closed",
      canTransitionOrderStatus("RTO", "Closed").ok === false,
      canTransitionOrderStatus("RTO", "Closed").reason,
    );
    ok("Closed is terminal", ORDER_STATUS_TRANSITIONS.Closed.length === 0);
    for (const target of ["Delivered", "Shipped", "Cancelled", "RTO", "RTO Received", "Pending"]) {
      ok(
        `Closed → ${target} is refused`,
        canTransitionOrderStatus("Closed", target).ok === false,
        canTransitionOrderStatus("Closed", target).reason,
      );
    }
    ok("Closed → Closed is a legal no-op", canTransitionOrderStatus("Closed", "Closed").ok === true);
    ok(
      "no other status can jump straight to Closed",
      Object.entries(ORDER_STATUS_TRANSITIONS)
        .filter(([from]) => from !== "RTO Received")
        .every(([, tos]) => !tos.includes("Closed")),
      JSON.stringify(
        Object.entries(ORDER_STATUS_TRANSITIONS).filter(([, tos]) => tos.includes("Closed")),
      ),
    );
    // Removed deliberately: no endpoint could ever perform RTO → Cancelled
    // (UpdateOrderStatus refuses Cancelled, the cancel endpoints claim
    // pre-dispatch statuses only), so the dropdown option it produced was a
    // guaranteed 400 that read as "cancellation is broken".
    ok(
      "RTO Received → Cancelled is refused (dead transition removed)",
      canTransitionOrderStatus("RTO Received", "Cancelled").ok === false,
    );
  }

  section("the full lifecycle, end to end");

  {
    const product = await makeProduct("lifecycle");
    const order = await makeOrder({ product, units: 2, orderStatus: "RTO" });

    const arrival = await sendWebhook({
      sr_order_id: order.shiprocket.orderId,
      shipment_status_id: 43,
      shipment_status: "RTO DELIVERED",
    });
    ok("the arrival webhook is accepted", arrival.body?.ignored !== true, JSON.stringify(arrival.body));

    let state = await snapshot(order._id);
    ok("the order is RTO Received", state.orderStatus === "RTO Received", state.orderStatus);
    ok("one prepaid refund obligation was recorded", state.refunds === 1, String(state.refunds));

    const disposition = await recordDisposition(order, "resellable");
    ok("the disposition is recorded", disposition.statusCode === 200, `${disposition.statusCode} ${disposition.body?.message || ""}`);

    // Changed on purpose (G3). Closing used to succeed here with the prepaid refund
    // still owed — "Closed" is defined as "any refund owed settled", but only the
    // disposition was enforced, so the debt dropped out of every working view.
    // Now: refused while owed, then the refund is paid, then the close succeeds.
    const refusedWhileOwed = await setStatus(order, "Closed");
    ok(
      "closing is refused while the refund is still owed (409 RTO_REFUND_OUTSTANDING)",
      refusedWhileOwed.statusCode === 409 && refusedWhileOwed.body?.code === "RTO_REFUND_OUTSTANDING",
      `${refusedWhileOwed.statusCode} ${refusedWhileOwed.body?.code}`,
    );
    ok("  and the order stays at RTO Received", (await snapshot(order._id)).orderStatus === "RTO Received");

    const paid = await payOwedRefund(order);
    ok("the owed refund is paid through Razorpay", paid.statusCode === 200, `${paid.statusCode} ${paid.body?.code || ""} ${paid.body?.message || ""}`);
    ok("  the refund row is processed", (await OrderModel.findById(order._id)).refunds[0]?.status === "processed");

    const closed = await setStatus(order, "Closed");
    ok("the order can then be closed", closed.statusCode === 200, `${closed.statusCode} ${closed.body?.message || ""}`);

    state = await snapshot(order._id);
    ok("the order is Closed", state.orderStatus === "Closed", state.orderStatus);
    ok(
      "the history records RTO Received then Closed",
      state.history.slice(-2).join(" → ") === "RTO Received → Closed",
      JSON.stringify(state.history),
    );
    ok("and it is terminal — no further status may be set", (await setStatus(order, "Delivered")).statusCode === 400);
  }

  {
    // Closing before arrival must be refused by the endpoint, not just the table.
    const product = await makeProduct("closetoosoon");
    const order = await makeOrder({ product, orderStatus: "RTO" });
    const response = await setStatus(order, "Closed");
    ok("closing an order still in transit is refused", response.statusCode === 400, String(response.statusCode));
    ok("the order stays at RTO", (await snapshot(order._id)).orderStatus === "RTO");
  }

  section("repeated and out-of-order courier events");

  {
    const product = await makeProduct("replay");
    const order = await makeOrder({ product, units: 2, orderStatus: "RTO", paymentStatus: "Paid" });
    const arrival = {
      sr_order_id: order.shiprocket.orderId,
      shipment_status_id: 43,
      shipment_status: "RTO DELIVERED",
    };

    await sendWebhook(arrival);
    const first = await snapshot(order._id);
    await sendWebhook(arrival);
    await sendWebhook(arrival);
    const afterReplays = await snapshot(order._id);

    ok(
      "three arrival deliveries produce ONE transition",
      afterReplays.history.filter((s) => s === "RTO Received").length === 1,
      JSON.stringify(afterReplays.history),
    );
    ok(
      "and ONE refund obligation (dedupe key RTO <id>)",
      afterReplays.refunds === 1,
      String(afterReplays.refunds),
    );
    ok(
      "the order is otherwise unchanged by the replays",
      JSON.stringify(first) === JSON.stringify(afterReplays),
      `${JSON.stringify(first)} vs ${JSON.stringify(afterReplays)}`,
    );
  }

  {
    // A late "RTO In Transit" / "RTO Initiated" must not walk the status back.
    const product = await makeProduct("backwards");
    const order = await makeOrder({ product, orderStatus: "RTO" });
    await sendWebhook({
      sr_order_id: order.shiprocket.orderId,
      shipment_status_id: 43,
      shipment_status: "RTO DELIVERED",
    });
    const arrived = await snapshot(order._id);
    ok("arrived first", arrived.orderStatus === "RTO Received");

    for (const text of ["RTO IN TRANSIT", "RTO Initiated", "Return to origin"]) {
      await sendWebhook({
        sr_order_id: order.shiprocket.orderId,
        shipment_status_id: 21,
        shipment_status: text,
      });
      const after = await snapshot(order._id);
      ok(
        `a late "${text}" cannot move the status back to RTO`,
        after.orderStatus === "RTO Received",
        after.orderStatus,
      );
    }
    const finalState = await snapshot(order._id);
    ok(
      "and no extra history entries were appended",
      finalState.history.length === arrived.history.length,
      `${arrived.history.length} → ${finalState.history.length}`,
    );
  }

  {
    // A late Delivered after RTO must not deliver the order or book COD cash.
    const product = await makeProduct("latedelivered");
    const order = await makeOrder({
      product,
      orderStatus: "RTO",
      paymentMethod: "COD",
      paymentStatus: "Pending",
    });
    const before = await snapshot(order._id);

    await sendWebhook({
      sr_order_id: order.shiprocket.orderId,
      shipment_status_id: 7,
      shipment_status: "DELIVERED",
    });
    const after = await snapshot(order._id);
    ok("the order is NOT delivered", after.orderStatus === "RTO", after.orderStatus);
    ok("COD is NOT marked Paid", after.paymentStatus === "Pending", after.paymentStatus);
    ok("deliveredAt is not stamped", !after.deliveredAt);
    ok("no history entry", after.history.length === before.history.length);
  }

  {
    // The same, but from Closed — a courier event must never revive a closed order.
    const product = await makeProduct("closedlate");
    const order = await makeOrder({
      product,
      orderStatus: "Closed",
      paymentMethod: "COD",
      paymentStatus: "Pending",
    });
    const before = await snapshot(order._id);
    for (const event of [
      { shipment_status_id: 7, shipment_status: "DELIVERED" },
      { shipment_status_id: 43, shipment_status: "RTO DELIVERED" },
      { shipment_status_id: 17, shipment_status: "OUT FOR DELIVERY" },
    ]) {
      await sendWebhook({ sr_order_id: order.shiprocket.orderId, ...event });
    }
    const after = await snapshot(order._id);
    ok("a Closed order stays Closed through every courier event", after.orderStatus === "Closed", after.orderStatus);
    ok("COD stays Pending", after.paymentStatus === "Pending", after.paymentStatus);
    ok("no history was appended", after.history.length === before.history.length);
    ok(
      "and no refund obligation was created for the unpaid COD order",
      after.refunds === 0,
      String(after.refunds),
    );
  }

  section("ambiguous and unresolvable events mutate nothing");

  {
    const product = await makeProduct("ambiguous");
    const order = await makeOrder({ product, orderStatus: "RTO", paymentStatus: "Paid" });
    const before = await snapshot(order._id);

    const unknown = await sendWebhook({
      sr_order_id: 99999999,
      shipment_status_id: 43,
      shipment_status: "RTO DELIVERED",
    });
    ok("an unknown identifier is ignored", unknown.body?.reason === "no_match", JSON.stringify(unknown.body));

    const conflicting = await sendWebhook({
      sr_order_id: order.shiprocket.orderId,
      awb: `AWB-${MARKER}-does-not-exist-elsewhere`,
      shipment_status_id: 43,
      shipment_status: "RTO DELIVERED",
    });
    // The AWB matches nothing, which is tolerated; the sr id resolves. So this one
    // is applied — the conflict case needs two identifiers naming DIFFERENT orders.
    ok("an unmatched AWB alongside a valid id still resolves", conflicting.body?.ignored !== true, JSON.stringify(conflicting.body));

    const other = await makeOrder({ product, orderStatus: "RTO" });
    const genuinelyConflicting = await sendWebhook({
      sr_order_id: order.shiprocket.orderId,
      awb: other.shiprocket.awbCode,
      shipment_status_id: 43,
      shipment_status: "RTO DELIVERED",
    });
    ok(
      "two identifiers naming different orders are refused",
      genuinelyConflicting.body?.reason === "conflicting_identifiers",
      JSON.stringify(genuinelyConflicting.body),
    );
    ok(
      "and the second order is untouched",
      (await snapshot(other._id)).orderStatus === "RTO",
    );

    const noIdentifiers = await sendWebhook({ shipment_status_id: 43, shipment_status: "RTO DELIVERED" });
    ok("an event with no identifiers is ignored", noIdentifiers.body?.reason === "no_identifiers");

    const badToken = await sendWebhook(
      { sr_order_id: order.shiprocket.orderId, shipment_status_id: 43, shipment_status: "RTO DELIVERED" },
      { token: "wrong" },
    );
    ok("a bad token is rejected 401", badToken.statusCode === 401, String(badToken.statusCode));
    void before;
  }

  section("money: prepaid owes once, COD owes nothing");

  {
    const product = await makeProduct("prepaid");
    const order = await makeOrder({ product, units: 2, orderStatus: "RTO", paymentStatus: "Paid" });
    await sendWebhook({
      sr_order_id: order.shiprocket.orderId,
      shipment_status_id: 43,
      shipment_status: "RTO DELIVERED",
    });
    const fresh = await OrderModel.findById(order._id);
    ok("exactly one obligation", fresh.refunds.length === 1, String(fresh.refunds.length));
    ok("recorded as owed", fresh.refunds[0].status === "owed", fresh.refunds[0].status);
    ok(
      "for the full outstanding amount",
      Math.abs(sumOwedRefunds(fresh) - fresh.totalAmount) < 0.01,
      `${sumOwedRefunds(fresh)} of ${fresh.totalAmount}`,
    );
    ok("within the ceiling", sumRefunded(fresh) <= fresh.totalAmount + 0.01);

    // Changed on purpose (G3). This used to close with the refund still owed and
    // assert the obligation survived the close. Closing is now refused until the
    // refund is settled — and an attempted close still must not settle, duplicate
    // or clear the obligation.
    await recordDisposition(order, "damaged");
    const refused = await setStatus(order, "Closed");
    ok(
      "closing is refused while the refund is owed (409 RTO_REFUND_OUTSTANDING)",
      refused.statusCode === 409 && refused.body?.code === "RTO_REFUND_OUTSTANDING",
      `${refused.statusCode} ${refused.body?.code}`,
    );
    const afterRefusal = await OrderModel.findById(order._id);
    ok("the refused close leaves the obligation intact", afterRefusal.refunds.length === 1, String(afterRefusal.refunds.length));
    ok("still owed", afterRefusal.refunds[0].status === "owed", afterRefusal.refunds[0].status);
    ok("and the order is still RTO Received", afterRefusal.orderStatus === "RTO Received", afterRefusal.orderStatus);

    const callsBefore = razorpayRefundCalls.length;
    const paid = await payOwedRefund(order);
    ok("the owed refund is paid once through Razorpay", paid.statusCode === 200 && razorpayRefundCalls.length === callsBefore + 1,
      `${paid.statusCode} ${paid.body?.code || ""} ${razorpayRefundCalls.length - callsBefore}x`);
    ok("  for the full owed amount",
      razorpayRefundCalls.at(-1)?.options?.amount === Math.round(fresh.refunds[0].amount * 100),
      JSON.stringify(razorpayRefundCalls.at(-1)?.options));

    await setStatus(order, "Closed");
    const closed = await OrderModel.findById(order._id);
    ok("closing then leaves exactly the one (now settled) refund row", closed.refunds.length === 1, String(closed.refunds.length));
    ok("settled, not owed", closed.refunds[0].status === "processed", closed.refunds[0].status);
    ok("the order is fully Refunded", closed.paymentStatus === "Refunded", closed.paymentStatus);
    ok("and the order is Closed", closed.orderStatus === "Closed", closed.orderStatus);
  }

  {
    const product = await makeProduct("codrto");
    const order = await makeOrder({
      product,
      orderStatus: "RTO",
      paymentMethod: "COD",
      paymentStatus: "Pending",
    });
    await sendWebhook({
      sr_order_id: order.shiprocket.orderId,
      shipment_status_id: 43,
      shipment_status: "RTO DELIVERED",
    });
    const fresh = await snapshot(order._id);
    ok("a COD RTO records NO refund obligation", fresh.refunds === 0, String(fresh.refunds));
    ok("paymentStatus stays Pending", fresh.paymentStatus === "Pending", fresh.paymentStatus);
    ok("but the arrival is still recorded", fresh.orderStatus === "RTO Received", fresh.orderStatus);
  }

  section("money: an RTO on an order that already owes an UNSETTLED refund");

  {
    // The last surviving instance of the money-collected gate bug. A prepaid order
    // whose earlier partial refund has been recorded but not yet settled sits at
    // "Refund Pending" — money WAS captured, part of it is owed back, the rest is
    // still owed. recordRtoRefundObligation gated on {Paid, Partially Refunded}
    // only, so it returned "no payment was ever collected" for a customer who
    // demonstrably paid, and the RTO liability was never recorded at all.
    //
    // "Refund Pending" is ordinary, not exotic: it is what a disabled, slow or
    // unreachable gateway produces, and Razorpay returns `pending` for normal-speed
    // refunds by design.
    const product = await makeProduct("rtopending");
    const order = await makeOrder({ product, units: 3, orderStatus: "RTO", paymentStatus: "Paid" });
    const oneUnit = Math.round(order.totalAmount / 3 * 100) / 100;

    // A real prior obligation, created through the real service — not stamped by hand.
    const prior = await recordRefundObligation({
      order,
      amount: oneUnit,
      reason: "Partial cancellation",
      dedupeKey: `PARTIAL ${order._id}`,
    });
    ok("the earlier partial obligation is recorded", prior.created === true);

    const beforeRto = await OrderModel.findById(order._id);
    ok("which leaves the order at Refund Pending",
      beforeRto.paymentStatus === "Refund Pending", beforeRto.paymentStatus);
    ok("with nothing settled yet", sumSettledRefunds(beforeRto) === 0, String(sumSettledRefunds(beforeRto)));
    ok("but money genuinely committed", sumRefunded(beforeRto) > 0, String(sumRefunded(beforeRto)));

    await sendWebhook({
      sr_order_id: order.shiprocket.orderId,
      shipment_status_id: 43,
      shipment_status: "RTO DELIVERED",
    });

    const afterRto = await OrderModel.findById(order._id);
    const rtoRow = afterRto.refunds.find((refund) => refund.reason === `RTO ${order._id}`);
    ok("the RTO records its own obligation — the customer paid and got nothing",
      Boolean(rtoRow), JSON.stringify(afterRto.refunds.map((r) => r.reason)));
    ok("as owed, not as a settled refund", rtoRow?.status === "owed", rtoRow?.status);
    ok("for the REMAINING outstanding amount, not the whole order",
      Math.abs((rtoRow?.amount || 0) - (order.totalAmount - oneUnit)) < 0.01,
      `${rtoRow?.amount} vs ${order.totalAmount - oneUnit}`);
    ok("so the full order value is now accounted for",
      Math.abs(sumRefunded(afterRto) - afterRto.totalAmount) < 0.01,
      `${sumRefunded(afterRto)} of ${afterRto.totalAmount}`);
    ok("and the refund ceiling still holds",
      sumRefunded(afterRto) <= afterRto.totalAmount + 0.01);
    ok("the arrival is recorded", afterRto.orderStatus === "RTO Received", afterRto.orderStatus);

    // Replaying the courier event must not owe it twice.
    await sendWebhook({
      sr_order_id: order.shiprocket.orderId,
      shipment_status_id: 43,
      shipment_status: "RTO DELIVERED",
    });
    const replayed = await OrderModel.findById(order._id);
    ok("a replayed RTO event owes nothing further",
      replayed.refunds.filter((refund) => refund.reason === `RTO ${order._id}`).length === 1,
      String(replayed.refunds.filter((r) => r.reason === `RTO ${order._id}`).length));
    ok("and the total owed is unchanged",
      Math.abs(sumRefunded(replayed) - afterRto.totalAmount) < 0.01);
  }

  {
    // Fully refunded already: owed must be 0 — but because there is no headroom
    // left, NOT because "no payment was ever collected". The distinction matters:
    // one is arithmetic, the other is a false statement about a customer who paid.
    const product = await makeProduct("rtofullrefund");
    const order = await makeOrder({ product, units: 1, orderStatus: "RTO", paymentStatus: "Paid" });
    await recordRefundObligation({
      order,
      amount: order.totalAmount,
      reason: "Full cancellation",
      dedupeKey: `FULL ${order._id}`,
    });
    // Settle it, so paymentStatus derives to "Refunded".
    const owedOrder = await OrderModel.findById(order._id);
    owedOrder.refunds[0].status = "processed";
    owedOrder.refunds[0].providerRefundId = `rfnd_${MARKER}_${order._id}`;
    await owedOrder.save();
    const { recomputeRefundState } = await import("../../src/modules/payments/return-refund.service.js");
    const settledOrder = await OrderModel.findById(order._id);
    await recomputeRefundState(settledOrder);
    ok("the order is fully Refunded", settledOrder.paymentStatus === "Refunded", settledOrder.paymentStatus);

    await sendWebhook({
      sr_order_id: order.shiprocket.orderId,
      shipment_status_id: 43,
      shipment_status: "RTO DELIVERED",
    });
    const afterRto = await OrderModel.findById(order._id);
    ok("no second obligation is created — there is no headroom",
      afterRto.refunds.length === 1, String(afterRto.refunds.length));
    ok("the settled refund is untouched", afterRto.refunds[0].status === "processed");
    ok("nothing exceeds the ceiling", sumRefunded(afterRto) <= afterRto.totalAmount + 0.01);
    ok("and the arrival is still recorded", afterRto.orderStatus === "RTO Received", afterRto.orderStatus);
  }

  {
    // Prepaid but never captured: still nothing owed, for the right reason.
    for (const paymentStatus of ["Pending", "Failed"]) {
      const product = await makeProduct(`rtouncaptured-${paymentStatus}`);
      const order = await makeOrder({ product, units: 1, orderStatus: "RTO", paymentStatus });
      await sendWebhook({
        sr_order_id: order.shiprocket.orderId,
        shipment_status_id: 43,
        shipment_status: "RTO DELIVERED",
      });
      const fresh = await OrderModel.findById(order._id);
      ok(`a prepaid order at "${paymentStatus}" owes nothing — no money was captured`,
        fresh.refunds.length === 0, String(fresh.refunds.length));
    }
  }

  {
    // The gate must not be able to drift out of step with the invariant again. The
    // obligation moved from the webhook into the refund service (shared by the courier
    // pipeline and the manual RTO Received move), so that is where it is checked now.
    const shippingSource = await readFile(
      new URL("../../src/modules/shipping/shipping.controller.js", import.meta.url),
      "utf8",
    );
    const serviceSource = await readFile(
      new URL("../../src/modules/payments/return-refund.service.js", import.meta.url),
      "utf8",
    );
    const obligationSource = serviceSource.slice(
      serviceSource.indexOf("export const recordRtoRefundObligation"),
    );
    ok("the RTO obligation no longer hardcodes its own money-collected list",
      !/\["Paid",\s*"Partially Refunded"\]/.test(shippingSource) &&
        !/\["Paid",\s*"Partially Refunded"\]/.test(obligationSource));
    ok("it references the shared set instead",
      /MONEY_COLLECTED_PAYMENT_STATUSES\.includes/.test(obligationSource));
    ok("which is exported from the refund service, where the invariant lives",
      /export const MONEY_COLLECTED_PAYMENT_STATUSES/.test(serviceSource));
    ok("and recordRefundObligation itself uses that same set",
      /MONEY_COLLECTED_PAYMENT_STATUSES\.includes/.test(serviceSource));

    const { MONEY_COLLECTED_PAYMENT_STATUSES } = await import(
      "../../src/modules/payments/return-refund.service.js"
    );
    ok("the set is exactly the four states in which money has been captured",
      JSON.stringify([...MONEY_COLLECTED_PAYMENT_STATUSES].sort()) ===
        JSON.stringify(["Paid", "Partially Refunded", "Refund Pending", "Refunded"].sort()),
      JSON.stringify(MONEY_COLLECTED_PAYMENT_STATUSES));
    ok("and excludes every state in which it has not",
      ["Pending", "Failed"].every((status) => !MONEY_COLLECTED_PAYMENT_STATUSES.includes(status)));
  }

  section("stock: disposition rules unchanged, closing never restocks");

  {
    const product = await makeProduct("dispo-gate", 50);
    const inTransit = await makeOrder({ product, orderStatus: "RTO" });
    const refused = await recordDisposition(inTransit, "resellable");
    ok(
      "a disposition still requires RTO Received",
      refused.statusCode === 409 && refused.body?.code === "NOT_RTO_RECEIVED",
      `${refused.statusCode} ${refused.body?.code}`,
    );
    ok("nothing was restocked", (await ProductModel.findById(product._id)).stock === 50);
  }

  {
    const product = await makeProduct("dispo-damaged", 50);
    const order = await makeOrder({ product, units: 2, orderStatus: "RTO Received" });
    const response = await recordDisposition(order, "damaged");
    ok("a damaged parcel is accepted", response.statusCode === 200, String(response.statusCode));
    ok(
      "and restocks NOTHING",
      (await ProductModel.findById(product._id)).stock === 50,
      String((await ProductModel.findById(product._id)).stock),
    );

    await setStatus(order, "Closed");
    ok(
      "closing does not restock either",
      (await ProductModel.findById(product._id)).stock === 50,
      String((await ProductModel.findById(product._id)).stock),
    );
  }

  {
    const product = await makeProduct("dispo-resellable", 50);
    const order = await makeOrder({ product, units: 3, orderStatus: "RTO Received" });
    const response = await recordDisposition(order, "resellable");
    ok("a resellable parcel is accepted", response.statusCode === 200, String(response.statusCode));
    ok(
      "and restocks exactly the ordered units once (50 + 3)",
      (await ProductModel.findById(product._id)).stock === 53,
      String((await ProductModel.findById(product._id)).stock),
    );

    const repeat = await recordDisposition(order, "resellable");
    ok(
      "a second disposition is refused",
      repeat.statusCode === 409 && repeat.body?.code === "DISPOSITION_ALREADY_RECORDED",
      `${repeat.statusCode} ${repeat.body?.code}`,
    );
    ok(
      "so stock is unchanged by the repeat",
      (await ProductModel.findById(product._id)).stock === 53,
      String((await ProductModel.findById(product._id)).stock),
    );

    await setStatus(order, "Closed");
    ok(
      "and closing restocks nothing further",
      (await ProductModel.findById(product._id)).stock === 53,
      String((await ProductModel.findById(product._id)).stock),
    );
  }

  section("fulfilment guard covers every RTO state");

  {
    ok(
      "the non-fulfillable set is Cancelled, Completed, plus the whole RTO lifecycle",
      JSON.stringify(NON_FULFILLABLE_STATUSES) ===
        JSON.stringify(["Cancelled", "Completed", "RTO", "RTO Received", "Closed"]),
      JSON.stringify(NON_FULFILLABLE_STATUSES),
    );
    ok(
      "RTO_LIFECYCLE_STATUSES is RTO, RTO Received, Closed",
      JSON.stringify(RTO_LIFECYCLE_STATUSES) === JSON.stringify(["RTO", "RTO Received", "Closed"]),
      JSON.stringify(RTO_LIFECYCLE_STATUSES),
    );
    for (const status of ["Cancelled", "RTO", "RTO Received", "Closed"]) {
      ok(`${status} is not fulfillable`, isFulfillableStatus(status) === false);
    }
    for (const status of ["Confirmed", "Packed", "Shipped", "Out For Delivery", "Delivered"]) {
      ok(`${status} is still fulfillable`, isFulfillableStatus(status) === true);
    }
  }

  {
    // Through the real endpoints. Each must refuse with 409 before doing anything.
    const endpoints = [
      ["CreateShipment", shippingController.CreateShipment],
      ["AssignAwb", shippingController.AssignAwb],
      ["SchedulePickup", shippingController.SchedulePickup],
      ["GenerateLabel", shippingController.GenerateLabel],
      ["GenerateInvoice", shippingController.GenerateInvoice],
    ];
    for (const status of ["RTO", "RTO Received", "Closed"]) {
      const product = await makeProduct(`guard-${status.replace(/\s/g, "")}`);
      const order = await makeOrder({ product, orderStatus: status });
      for (const [name, handler] of endpoints) {
        const response = await callController(handler, {
          params: { orderId: String(order._id) },
          user: admin(),
        });
        ok(
          `${name} refuses ${status} with 409`,
          response.statusCode === 409,
          `${response.statusCode} ${response.body?.message || ""}`,
        );
      }
    }
  }

  section("revenue: Closed is excluded exactly like Cancelled");

  {
    ok(
      "the non-revenue set is Cancelled and Closed",
      JSON.stringify(NON_REVENUE_STATUSES) === JSON.stringify(["Cancelled", "Closed"]),
      JSON.stringify(NON_REVENUE_STATUSES),
    );

    // Every reporting aggregate must reference the shared set, not a bare
    // $ne: "Cancelled" that a new status would slip past.
    const reportSource = await readFile(
      new URL("../../src/modules/admin/admin-report.service.js", import.meta.url),
      "utf8",
    );
    ok(
      "the report service uses the shared NON_REVENUE_STATUSES set",
      reportSource.includes("NON_REVENUE_STATUSES"),
    );
    ok(
      "no reporting aggregate still excludes Cancelled alone",
      !/orderStatus: \{ \$ne: "Cancelled" \}/.test(reportSource),
      "a bare $ne: Cancelled remains",
    );
    ok(
      "both revenue matches use it (totalRevenue and the sales report)",
      (reportSource.match(/\$nin: NON_REVENUE_STATUSES/g) || []).length === 2,
      String((reportSource.match(/\$nin: NON_REVENUE_STATUSES/g) || []).length),
    );
    ok(
      "and the 7-day chart excludes Closed",
      /orderStatus: \{ \$ne: "Closed" \}/.test(reportSource),
    );
  }

  {
    // End to end through the real sales report.
    const product = await makeProduct("revenue", 100);
    const counted = await makeOrder({ product, units: 1, orderStatus: "Delivered" });
    const closedOrder = await makeOrder({ product, units: 1, orderStatus: "Closed" });
    const cancelledOrder = await makeOrder({ product, units: 1, orderStatus: "Cancelled" });

    const report = await buildSalesReportData({});
    const ids = JSON.stringify(report);
    ok("the report has the expected shape", Boolean(report?.data?.byDate), JSON.stringify(Object.keys(report || {})));
    ok("the sales report builds", Boolean(report), "no report");
    ok(
      "a Closed order does not appear in it",
      !ids.includes(String(closedOrder._id)),
      "closed order present",
    );
    ok(
      "nor does a Cancelled one (unchanged)",
      !ids.includes(String(cancelledOrder._id)),
      "cancelled order present",
    );

    // Compare revenue totals with and without the closed order, by date bucket.
    const totalFor = (rows) => (rows || []).reduce((sum, row) => sum + (row.revenue || row.total || 0), 0);
    const withClosed = totalFor(report.data.byDate);
    await OrderModel.updateOne({ _id: closedOrder._id }, { $set: { orderStatus: "Delivered" } });
    const reopened = await buildSalesReportData({});
    const withDelivered = totalFor(reopened.data.byDate);
    ok(
      "flipping it to Delivered increases reported revenue by exactly its total",
      Math.abs(withDelivered - withClosed - closedOrder.totalAmount) < 0.01,
      `${withClosed} → ${withDelivered}, order ${closedOrder.totalAmount}`,
    );
    void counted;
  }

  section("the frontend mirror stays consistent");

  {
    const feSource = await readFile(
      new URL("../../../kitab-shop-fe/src/features/admin-orders/orderStatus.rules.js", import.meta.url),
      "utf8",
    );
    ok("the FE mirror is readable", feSource.length > 0);
    ok('the FE mirror declares "Closed"', /Closed:\s*\[\]/.test(feSource), "missing Closed");
    ok(
      "and RTO Received → Closed",
      /"RTO Received":\s*\["Closed"/.test(feSource),
      "missing RTO Received → Closed",
    );
    ok(
      "every backend transition appears in the FE mirror",
      (() => {
        // Same fix as security.regression.mjs: scope to the transitions object, and to the
        // key's own array, instead of searching the whole file and slicing to its end.
        const start = feSource.indexOf("export const ORDER_STATUS_TRANSITIONS = {");
        const end = feSource.indexOf("\n};", start);
        if (start < 0 || end < 0) return false;
        const table = feSource.slice(start, end);
        return Object.entries(ORDER_STATUS_TRANSITIONS).every(([from, tos]) => {
          const keyAt =
            table.indexOf(`"${from}":`) >= 0 ? table.indexOf(`"${from}":`) : table.indexOf(`${from}:`);
          if (keyAt < 0) return false;
          const arrayEnd = table.indexOf("]", keyAt);
          const block = table.slice(keyAt, arrayEnd < 0 ? undefined : arrayEnd);
          return tos.every((to) => block.includes(to));
        });
      })(),
      "a transition is missing from the FE mirror",
    );

    // The status list and the badge colours used to be declared inline in AdminOrders.jsx, and
    // these assertions read that file. They now live in orderStatus.rules.js so the customer's
    // My Orders list can share them: that page kept its OWN copy covering only Confirmed /
    // Shipped / Delivered / Cancelled, so an order at Packed, Out For Delivery, NDR, RTO,
    // "RTO Received" or Closed matched no step, lit no timeline and fell through to a grey
    // badge — the list looked frozen while the detail page showed the true status.
    const statusRules = await readFile(
      new URL("../../../kitab-shop-fe/src/features/admin-orders/orderStatus.rules.js", import.meta.url),
      "utf8",
    );
    ok('the status filter offers "RTO Received"', statusRules.includes('"RTO Received":'));
    ok('the status filter offers "Closed"', statusRules.includes("Closed: ["));
    ok(
      "both have a status colour, so the badge is never unstyled",
      /"RTO Received": "bg-/.test(statusRules) && /Closed: "bg-/.test(statusRules),
      "a colour is missing",
    );

    // Stronger than naming the two statuses this suite is about: EVERY status the backend can
    // store needs a badge colour, which is the invariant whose absence caused the bug above.
    const badgeStart = statusRules.indexOf("export const ORDER_STATUS_BADGE = {");
    const badgeBlock = statusRules.slice(badgeStart, statusRules.indexOf("\n};", badgeStart));
    const uncoloured = ORDER_STATUSES.filter(
      (status) => !badgeBlock.includes(`"${status}":`) && !badgeBlock.includes(`${status}:`),
    );
    ok(
      "every backend order status has a badge colour",
      badgeStart >= 0 && uncoloured.length === 0,
      `no colour for: ${uncoloured.join(", ")}`,
    );

    // And the two list screens must render from that shared model rather than a private copy,
    // because a private copy is exactly how one screen fell behind the other.
    for (const [label, path] of [
      ["admin orders list", "../../../kitab-shop-fe/src/pages/admin/AdminOrders.jsx"],
      ["customer My Orders list", "../../../kitab-shop-fe/src/pages/Orders.jsx"],
    ]) {
      const source = await readFile(new URL(path, import.meta.url), "utf8");
      ok(
        `the ${label} takes its badge colours from the shared model`,
        source.includes("ORDER_STATUS_BADGE") && !/^const statusColor = \{/m.test(source),
        "it declares its own status colour map again",
      );
    }

    // The customer list must walk the same steps as the customer DETAIL page.
    const ordersList = await readFile(
      new URL("../../../kitab-shop-fe/src/pages/Orders.jsx", import.meta.url),
      "utf8",
    );
    ok(
      "the My Orders timeline uses the shared STEPS/ISSUE_STEPS, not a local 3-step list",
      ordersList.includes("ISSUE_STATUS_KEYS") &&
        ordersList.includes("orderDetail.helpers") &&
        !/^const STEPS = \[/m.test(ordersList),
      "Orders.jsx still defines its own STEPS",
    );

    const helpers = await readFile(
      new URL("../../../kitab-shop-fe/src/features/order-detail/orderDetail.helpers.js", import.meta.url),
      "utf8",
    );
    ok('the customer timeline has an "RTO Received" step', helpers.includes('key: "RTO Received"'));
    ok('and a "Closed" step', helpers.includes('key: "Closed"'));
    ok(
      "the timeline branch is derived from ISSUE_STEPS, not a hardcoded list",
      helpers.includes("ISSUE_STATUS_KEYS"),
    );
    const orderDetail = await readFile(
      new URL("../../../kitab-shop-fe/src/pages/account/OrderDetail.jsx", import.meta.url),
      "utf8",
    );
    ok(
      "and OrderDetail uses it rather than [\"NDR\", \"RTO\"]",
      orderDetail.includes("ISSUE_STATUS_KEYS.includes(displayStatus)") &&
        !orderDetail.includes('["NDR", "RTO"].includes(displayStatus)'),
    );
  }

  section("the dead restock import is gone");

  {
    const shippingSource = await readFile(
      new URL("../../src/modules/shipping/shipping.controller.js", import.meta.url),
      "utf8",
    );
    ok(
      "shipping.controller.js no longer imports restockRtoOrder",
      !shippingSource.includes("restockRtoOrder"),
      "the dead import is still present",
    );
    // The webhook hands every event to the courier pipeline, which records it.
    const pipelineSource = await readFile(
      new URL("../../src/modules/shipping/courier-event.service.js", import.meta.url),
      "utf8",
    );
    ok(
      "and the webhook still records the RTO refund obligation",
      shippingSource.includes("applyCourierEvent(") &&
        pipelineSource.includes("recordRtoRefundObligation(order)") &&
        !pipelineSource.includes("restockRtoOrder"),
    );
  }
} catch (error) {
  console.error(`\nSUITE ABORTED: ${error?.stack || error}`);
  ok("suite ran to completion", false, error?.message);
} finally {
  globalThis.fetch = originalFetch;
  await OrderModel.deleteMany({ _id: { $in: trash.orders } });
  await ProductModel.deleteMany({ _id: { $in: trash.products } });
  restoreCapabilities();
  const { failed } = finish();
  await mongoose.disconnect();
  process.exit(failed ? 1 : 0);
}
