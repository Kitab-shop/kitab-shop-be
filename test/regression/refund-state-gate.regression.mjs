/**
 * Cancellation refunds must survive an UNSETTLED earlier refund.
 *
 * Found while testing H2-03. Both cancellation paths gated their refund on
 *
 *   paymentStatus ∈ { Paid, Partially Refunded }
 *
 * but a refund that has been recorded and NOT yet settled at the gateway leaves the
 * order at "Refund Pending" — money was collected, some of it is owed back, and the
 * rest is still owed. Neither cancellation path recognised that state, so a second
 * partial cancellation, or a full cancellation after a partial one, proceeded
 * normally and silently recorded NO refund obligation. The customer lost the
 * balance.
 *
 * "Refund Pending" is reached whenever the gateway is slow, unreachable, or
 * disabled — Razorpay returns `pending` for normal-speed refunds by design — so this
 * is an ordinary operating state, not an edge case.
 *
 * Run with `npm run test:refund-state-gate` (or `npm test` for everything).
 *
 * Refunds are left deliberately UNSETTLED here (payments disabled, so
 * canAutoRefund is false and rows are recorded "owed" — nothing will send them),
 * which is exactly the condition that produces "Refund Pending".
 *
 * The last sections cover the owed-refunds queue those rows land in: they are
 * listed with `manualPayable`, settle by hand, and legacy never-attempted
 * `created` rows (what cancellations wrote before `owed`) are settleable too.
 */
process.env.INVENTORY_ENFORCE_STOCK = "false";
process.env.NOTIFICATIONS_ENABLED = "false";
process.env.PAYMENTS_ENABLED = "false";
process.env.SHIPROCKET_ENABLED = "false";

import mongoose from "mongoose";
import { connect, createSuite, marker, productFixture, addressFixture } from "./helpers.mjs";

const { ok, section, finish } = createSuite("refund-state-gate");
await connect();

const OrderModel = (await import("../../src/modules/orders/Order.model.js")).default;
const ProductModel = (await import("../../src/modules/products/Product.model.js")).default;
await import("../../src/modules/categories/Category.model.js");
const { sumRefunded, sumSettledRefunds } = await import(
  "../../src/modules/payments/return-refund.service.js"
);
const orderController = await import("../../src/modules/orders/order.controller.js");
const owedController = await import("../../src/modules/payments/owed-refund.controller.js");

const MARKER = marker("refundgate");
const trash = { orders: [], products: [] };
let seq = 0;
const money = (n) => Math.round(n * 100) / 100;

const makeProduct = async (label, price = 200) => {
  const product = await ProductModel.create(
    productFixture(`${MARKER}-${label}`, { price, stock: 500 }),
  );
  trash.products.push(product._id);
  return product;
};

const makeOrder = async ({ product, units, paymentMethod = "RAZORPAY", paymentStatus = "Paid" }) => {
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
    orderStatus: "Confirmed",
    subtotal,
    totalAmount: subtotal,
    ...(paymentMethod === "RAZORPAY" ? { razorpayPaymentId: `pay_${MARKER}_${seq}` } : {}),
  });
  trash.orders.push(order._id);
  return order;
};

const callController = async (handler, { params = {}, body = {}, user }) => {
  let statusCode = 200;
  let payload;
  const res = {
    status(code) { statusCode = code; return this; },
    json(data) { payload = data; return this; },
  };
  await handler({ params, body, user, query: {} }, res);
  return { statusCode, body: payload };
};

const partialCancel = (order, product, quantity) =>
  callController(orderController.PartialCancelOrder, {
    params: { orderId: String(order._id) },
    body: { productId: String(product._id), quantity, reason: "Damaged" },
    user: { id: String(new mongoose.Types.ObjectId()), roles: ["admin"] },
  });

const fullCancel = (order) =>
  callController(orderController.CancelOrder, {
    params: { orderId: String(order._id) },
    body: { reason: "Ordered by mistake" },
    user: { id: String(order.user), roles: [] },
  });

try {
  // ═══════════════════════════════════════════════════════════════════════════
  section("the precondition: an unsettled refund leaves the order Refund Pending");

  {
    const product = await makeProduct("precondition");
    const order = await makeOrder({ product, units: 4 });

    const first = await partialCancel(order, product, 1);
    ok("the first partial cancellation succeeds", first.statusCode === 200, `${first.statusCode} ${first.body?.message || ""}`);

    const after = await OrderModel.findById(order._id);
    ok("one refund row was recorded", after.refunds.length === 1, String(after.refunds.length));
    // `owed`, not `created`: with payments off nothing will ever call the gateway
    // for it, and `created` means "the gateway was called, outcome unknown".
    ok("it is unsettled — recorded as owed", after.refunds[0].status === "owed", after.refunds[0].status);
    ok(
      "confirmed through the gateway (a Razorpay order), once Razorpay can pay it",
      after.refunds[0].confirmationMethod === "gateway",
      after.refunds[0].confirmationMethod,
    );
    ok("nothing has settled", sumSettledRefunds(after) === 0, String(sumSettledRefunds(after)));
    ok(
      'so the order sits at "Refund Pending" — the state neither cancel path recognised',
      after.paymentStatus === "Refund Pending",
      after.paymentStatus,
    );
    ok("200 is committed of the 800 total", money(sumRefunded(after)) === 200, String(money(sumRefunded(after))));
  }

  section("a SECOND partial cancellation from Refund Pending");

  {
    const product = await makeProduct("second-partial");
    const order = await makeOrder({ product, units: 4 }); // 4 x 200 = 800

    await partialCancel(order, product, 1);
    const afterFirst = await OrderModel.findById(order._id);
    ok("first cancellation committed 200", money(sumRefunded(afterFirst)) === 200, String(money(sumRefunded(afterFirst))));
    ok("order is Refund Pending", afterFirst.paymentStatus === "Refund Pending", afterFirst.paymentStatus);

    const second = await partialCancel(order, product, 1);
    ok("the second partial cancellation succeeds", second.statusCode === 200, `${second.statusCode} ${second.body?.message || ""}`);

    const afterSecond = await OrderModel.findById(order._id);
    ok(
      "the unit is recorded as cancelled either way",
      afterSecond.items[0].cancelledQuantity === 2,
      String(afterSecond.items[0].cancelledQuantity),
    );
    // THE BUG: this used to stay at 200 — the second cancellation refunded nothing.
    ok(
      "a SECOND refund obligation is recorded (was silently skipped)",
      afterSecond.refunds.length === 2,
      `${afterSecond.refunds.length} refund rows`,
    );
    ok(
      "committing 400 in total, 200 per cancelled unit",
      money(sumRefunded(afterSecond)) === 400,
      String(money(sumRefunded(afterSecond))),
    );
    ok(
      "the two rows carry DIFFERENT idempotency keys, one per cancellation",
      afterSecond.refunds[0].idempotencyKey !== afterSecond.refunds[1].idempotencyKey,
      JSON.stringify(afterSecond.refunds.map((r) => r.idempotencyKey)),
    );
    ok(
      "both keys are partial-cancellation keys",
      afterSecond.refunds.every((r) => String(r.idempotencyKey || "").startsWith("partial-cancel:")),
      JSON.stringify(afterSecond.refunds.map((r) => r.idempotencyKey)),
    );
    ok("still Refund Pending, nothing settled", afterSecond.paymentStatus === "Refund Pending", afterSecond.paymentStatus);
  }

  {
    // Third and fourth, to be sure it is not a one-off. The fourth empties the
    // order, which tops the refund up to the outstanding balance (H2-03).
    const product = await makeProduct("repeat-partial");
    const order = await makeOrder({ product, units: 4 });

    for (let i = 0; i < 3; i += 1) {
      const response = await partialCancel(order, product, 1);
      ok(`partial cancellation ${i + 1} succeeds`, response.statusCode === 200, String(response.statusCode));
    }
    const afterThree = await OrderModel.findById(order._id);
    ok("three refund rows", afterThree.refunds.length === 3, String(afterThree.refunds.length));
    ok("600 committed", money(sumRefunded(afterThree)) === 600, String(money(sumRefunded(afterThree))));
    ok("order still live", afterThree.orderStatus === "Confirmed", afterThree.orderStatus);

    await partialCancel(order, product, 1);
    const afterFour = await OrderModel.findById(order._id);
    ok("the order is now Cancelled", afterFour.orderStatus === "Cancelled", afterFour.orderStatus);
    ok(
      "the whole 800 is committed and no more",
      money(sumRefunded(afterFour)) === 800,
      String(money(sumRefunded(afterFour))),
    );
    ok(
      "the ceiling is respected exactly",
      money(sumRefunded(afterFour)) <= afterFour.totalAmount + 0.01,
      `${money(sumRefunded(afterFour))} of ${afterFour.totalAmount}`,
    );
  }

  section("a FULL cancellation from Refund Pending");

  {
    const product = await makeProduct("full-after-partial");
    const order = await makeOrder({ product, units: 4 }); // 800

    await partialCancel(order, product, 1);
    const afterPartial = await OrderModel.findById(order._id);
    ok("partial committed 200 and left Refund Pending", money(sumRefunded(afterPartial)) === 200 && afterPartial.paymentStatus === "Refund Pending");

    const response = await fullCancel(order);
    ok("the full cancellation succeeds", response.statusCode === 200, `${response.statusCode} ${response.body?.message || ""}`);

    const after = await OrderModel.findById(order._id);
    ok("the order is Cancelled", after.orderStatus === "Cancelled", after.orderStatus);
    // THE SAME BUG, larger amount: the remaining 600 used to be refunded to nobody.
    ok(
      "the OUTSTANDING 600 is now recorded (was silently skipped)",
      after.refunds.length === 2,
      `${after.refunds.length} refund rows`,
    );
    const cancelRow = after.refunds.find((r) => r.idempotencyKey === `cancel:${order._id}`);
    ok("under the full-cancellation idempotency key", Boolean(cancelRow), JSON.stringify(after.refunds.map((r) => r.idempotencyKey)));
    ok("for exactly the outstanding balance of 600", money(cancelRow?.amount) === 600, String(cancelRow?.amount));
    ok(
      "committing the full 800 — not 1000, so no double refund",
      money(sumRefunded(after)) === 800,
      String(money(sumRefunded(after))),
    );
    ok(
      "which is exactly the order total, ceiling intact",
      money(sumRefunded(after)) === after.totalAmount,
      `${money(sumRefunded(after))} vs ${after.totalAmount}`,
    );
  }

  section("existing Paid and Partially Refunded behaviour is unchanged");

  {
    // Paid: the ordinary first cancellation.
    const product = await makeProduct("paid");
    const order = await makeOrder({ product, units: 2 }); // 400
    const response = await fullCancel(order);
    ok("a Paid order cancels and refunds", response.statusCode === 200, String(response.statusCode));
    const after = await OrderModel.findById(order._id);
    ok("400 committed", money(sumRefunded(after)) === 400, String(money(sumRefunded(after))));
    ok("one refund row", after.refunds.length === 1, String(after.refunds.length));
  }

  {
    // Partially Refunded: a settled earlier refund.
    const product = await makeProduct("partially-refunded");
    const order = await makeOrder({ product, units: 4 }); // 800
    await partialCancel(order, product, 1);
    // Settle it, as a successful gateway refund would.
    await OrderModel.updateOne(
      { _id: order._id },
      { $set: { "refunds.$[].status": "processed", paymentStatus: "Partially Refunded" } },
    );
    const settled = await OrderModel.findById(order._id);
    ok("the order is Partially Refunded", settled.paymentStatus === "Partially Refunded", settled.paymentStatus);

    const response = await fullCancel(order);
    ok("it still cancels", response.statusCode === 200, String(response.statusCode));
    const after = await OrderModel.findById(order._id);
    ok("the outstanding 600 is refunded", after.refunds.length === 2, String(after.refunds.length));
    ok("800 committed in total", money(sumRefunded(after)) === 800, String(money(sumRefunded(after))));
  }

  {
    // Fully Refunded: nothing outstanding, so nothing more is recorded.
    const product = await makeProduct("fully-refunded");
    const order = await makeOrder({ product, units: 2 }); // 400
    await OrderModel.updateOne(
      { _id: order._id },
      {
        $set: { paymentStatus: "Refunded" },
        $push: { refunds: { amount: 400, status: "processed", reason: "prior full refund" } },
      },
    );
    const response = await fullCancel(order);
    ok("a fully refunded order still cancels", response.statusCode === 200, String(response.statusCode));
    const after = await OrderModel.findById(order._id);
    ok(
      "but records NO further refund — there is nothing outstanding",
      after.refunds.length === 1,
      String(after.refunds.length),
    );
    ok("400 committed, not 800", money(sumRefunded(after)) === 400, String(money(sumRefunded(after))));
  }

  section("COD is unchanged: no money collected, nothing owed");

  {
    const product = await makeProduct("cod-pending");
    const order = await makeOrder({ product, units: 3, paymentMethod: "COD", paymentStatus: "Pending" });

    const partial = await partialCancel(order, product, 1);
    ok("a COD partial cancellation succeeds", partial.statusCode === 200, String(partial.statusCode));
    let after = await OrderModel.findById(order._id);
    ok("NO refund row for an unpaid COD order", after.refunds.length === 0, String(after.refunds.length));
    ok("paymentStatus stays Pending", after.paymentStatus === "Pending", after.paymentStatus);

    const response = await fullCancel(order);
    ok("the COD full cancellation succeeds", response.statusCode === 200, String(response.statusCode));
    after = await OrderModel.findById(order._id);
    ok("still no refund rows", after.refunds.length === 0, String(after.refunds.length));
    ok("still Pending — nothing was ever collected", after.paymentStatus === "Pending", after.paymentStatus);
    ok("the order is Cancelled", after.orderStatus === "Cancelled", after.orderStatus);
  }

  {
    // A COD order delivered and collected, then cancelled, IS owed money — and the
    // Refund Pending path applies to it identically.
    const product = await makeProduct("cod-collected");
    const order = await makeOrder({ product, units: 4, paymentMethod: "COD", paymentStatus: "Paid" });
    await partialCancel(order, product, 1);
    const afterFirst = await OrderModel.findById(order._id);
    ok("a collected COD order records the obligation", afterFirst.refunds.length === 1, String(afterFirst.refunds.length));
    ok("as a manual payout", afterFirst.refunds[0].paymentProvider === "manual", afterFirst.refunds[0].paymentProvider);
    ok(
      "owed, and confirmed by a human — COD never reaches the gateway",
      afterFirst.refunds[0].status === "owed" && afterFirst.refunds[0].confirmationMethod === "manual",
      `${afterFirst.refunds[0].status} ${afterFirst.refunds[0].confirmationMethod}`,
    );
    ok("leaving Refund Pending", afterFirst.paymentStatus === "Refund Pending", afterFirst.paymentStatus);

    await partialCancel(order, product, 1);
    const afterSecond = await OrderModel.findById(order._id);
    ok(
      "and a second COD partial cancellation is also recorded",
      afterSecond.refunds.length === 2,
      String(afterSecond.refunds.length),
    );
    ok("400 owed in total", money(sumRefunded(afterSecond)) === 400, String(money(sumRefunded(afterSecond))));
  }

  section("no duplicate gateway refund");

  {
    // Payments are disabled in this suite, so nothing can reach Razorpay at all —
    // every row is recorded "owed". The guard that matters is that no row is ever
    // recorded twice under one key, which is what settleGatewayRefund keys on.
    const product = await makeProduct("no-dupes");
    const order = await makeOrder({ product, units: 4 });
    await partialCancel(order, product, 1);
    await partialCancel(order, product, 1);
    await fullCancel(order);

    const after = await OrderModel.findById(order._id);
    const keys = after.refunds.map((r) => String(r.idempotencyKey));
    ok("three refunds, one per cancellation action", after.refunds.length === 3, String(after.refunds.length));
    ok("every idempotency key is distinct", new Set(keys).size === keys.length, JSON.stringify(keys));
    ok("nothing settled, so no gateway money moved", sumSettledRefunds(after) === 0, String(sumSettledRefunds(after)));
    ok(
      "the committed total never exceeds the order total",
      money(sumRefunded(after)) <= after.totalAmount + 0.01,
      `${money(sumRefunded(after))} of ${after.totalAmount}`,
    );
    ok("which is exactly 800", money(sumRefunded(after)) === 800, String(money(sumRefunded(after))));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("the owed rows are in the owed-refunds queue, and settle by hand");

  const admin = { id: String(new mongoose.Types.ObjectId()), roles: ["admin"] };
  // The queue is global and paginated; walk it to find this suite's rows.
  const owedListRows = async () => {
    const rows = [];
    for (let page = 1; page <= 50; page += 1) {
      let payload;
      await owedController.AdminGetOwedRefunds(
        { query: { page: String(page), limit: "100" }, user: admin },
        { status() { return this; }, json(data) { payload = data; return this; } },
      );
      rows.push(...(payload?.data || []));
      if (!payload || page >= (payload.pagination?.totalPages || 1)) break;
    }
    return rows;
  };
  const settleManual = (orderId, refundId, reference) =>
    callController(owedController.AdminSettleOwedRefundManually, {
      params: { orderId: String(orderId), refundId: String(refundId) },
      body: { method: "upi", reference },
      user: admin,
    });

  {
    const product = await makeProduct("owed-queue");
    const order = await makeOrder({ product, units: 2 }); // Razorpay, payments off
    await fullCancel(order);
    const cancelled = await OrderModel.findById(order._id);
    const row = cancelled.refunds[0];
    ok("the cancellation refund is owed", row?.status === "owed", row?.status);

    const listed = (await owedListRows()).find((entry) => String(entry.refundId) === String(row._id));
    ok("it appears in the owed-refunds list", Boolean(listed));
    ok(
      "marked manualPayable — Razorpay cannot pay it while payments are off",
      listed?.manualPayable === true && listed?.gatewayPayable === false,
      JSON.stringify({ manualPayable: listed?.manualPayable, gatewayPayable: listed?.gatewayPayable }),
    );
    ok("with its refundStatus", listed?.refundStatus === "owed", listed?.refundStatus);

    const settled = await settleManual(order._id, row._id, `UTR-${MARKER}-owed`);
    ok("settle-manual accepts it", settled.statusCode === 200, `${settled.statusCode} ${settled.body?.message}`);
    const after = await OrderModel.findById(order._id);
    ok("the row is processed", after.refunds[0].status === "processed", after.refunds[0].status);
    ok("and the order Refunded", after.paymentStatus === "Refunded", after.paymentStatus);

    const again = await settleManual(order._id, row._id, `UTR-${MARKER}-owed-2`);
    ok("a second settle is refused", again.statusCode === 409 && again.body?.code === "REFUND_NOT_OWED",
      `${again.statusCode} ${again.body?.code}`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("legacy never-attempted `created` rows are settleable; attempted ones are not");

  {
    const product = await makeProduct("legacy-created");
    const order = await makeOrder({ product, units: 5, paymentMethod: "COD", paymentStatus: "Paid" }); // 1000
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const legacyRow = (overrides = {}) => ({
      _id: new mongoose.Types.ObjectId(),
      paymentProvider: "manual",
      amount: 100,
      reason: "Order cancelled by customer — legacy",
      status: "created",
      idempotencyKey: `legacy-${new mongoose.Types.ObjectId()}`,
      createdAt: hourAgo,
      ...overrides,
    });
    const legacy = legacyRow();
    const fresh = legacyRow({ createdAt: new Date() });
    const attempted = legacyRow({ gatewayAttemptedAt: hourAgo });
    const withFailure = legacyRow({ failureReason: "BAD_REQUEST_ERROR" });
    const forReturn = legacyRow({ returnRequest: new mongoose.Types.ObjectId() });
    const withRefundId = legacyRow({ providerRefundId: `rfnd_${MARKER}_legacy` });
    await OrderModel.updateOne(
      { _id: order._id },
      {
        $set: { paymentStatus: "Refund Pending" },
        $push: { refunds: { $each: [legacy, fresh, attempted, withFailure, forReturn, withRefundId] } },
      },
    );

    const listedIds = new Set((await owedListRows()).map((entry) => String(entry.refundId)));
    ok("the old never-attempted created row is listed", listedIds.has(String(legacy._id)));
    ok("a fresh one is not (its gateway call may be a moment away)", !listedIds.has(String(fresh._id)));
    ok(
      "rows with an attempt time, failure reason, return or refund id are not listed",
      ![attempted, withFailure, forReturn, withRefundId].some((row) => listedIds.has(String(row._id))),
    );
    const listedLegacy = (await owedListRows()).find((entry) => String(entry.refundId) === String(legacy._id));
    ok("it is manualPayable (COD)", listedLegacy?.manualPayable === true, String(listedLegacy?.manualPayable));
    ok("and reports refundStatus created", listedLegacy?.refundStatus === "created", listedLegacy?.refundStatus);

    const settled = await settleManual(order._id, legacy._id, `UTR-${MARKER}-legacy`);
    ok("settle-manual settles the legacy created row", settled.statusCode === 200,
      `${settled.statusCode} ${settled.body?.message}`);
    const afterLegacy = await OrderModel.findById(order._id);
    ok("it is processed", afterLegacy.refunds.id(legacy._id)?.status === "processed",
      afterLegacy.refunds.id(legacy._id)?.status);

    for (const [label, row] of [
      ["a gatewayAttemptedAt", attempted],
      ["a failureReason", withFailure],
      ["a returnRequest", forReturn],
    ]) {
      const refused = await settleManual(order._id, row._id, `UTR-${MARKER}-${row._id}`);
      ok(
        `a created row with ${label} is refused (409 REFUND_NOT_OWED)`,
        refused.statusCode === 409 && refused.body?.code === "REFUND_NOT_OWED",
        `${refused.statusCode} ${refused.body?.code}`,
      );
    }
    const untouched = await OrderModel.findById(order._id);
    ok(
      "and none of them moved",
      [attempted, withFailure, forReturn].every((row) => untouched.refunds.id(row._id)?.status === "created"),
    );
  }
} catch (error) {
  console.error(`\nSUITE ABORTED: ${error?.stack || error}`);
  ok("suite ran to completion", false, error?.message);
} finally {
  await OrderModel.deleteMany({ _id: { $in: trash.orders } });
  await ProductModel.deleteMany({ _id: { $in: trash.products } });
  const { failed } = finish();
  await mongoose.disconnect();
  process.exit(failed ? 1 : 0);
}
