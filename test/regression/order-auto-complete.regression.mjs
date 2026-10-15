/**
 * Auto-complete: Delivered → Completed once the return window has passed.
 *
 * Completing an order closes its case for good (Completed is terminal), so the
 * eligibility rules are asserted against the REAL database rather than assumed:
 *
 *   - past the window (+ grace) → Completed, with history, bill number,
 *     notification and email;
 *   - inside the window → untouched, and a product's LONGER window is honoured;
 *   - an open return, an `owed` or a `created` refund each block it, and so
 *     does a `failed` refund nothing has retried;
 *   - a non-returnable order (window 0) is seen — and emailed — as soon as it
 *     is eligible;
 *   - an order with no `deliveredAt` is never touched;
 *   - two concurrent sweeps complete an order exactly once;
 *   - the email is suppressed for a long-stale backlog, the notification is not;
 *   - ORDER_AUTO_COMPLETE_ENABLED=false turns the sweep off.
 *
 * Every order here is "delivered" in 2001 and every sweep runs with an injected
 * `now` in 2001, so a sweep can never pick up — and complete — a real Delivered
 * order in the local database. The mailer is stubbed at the nodemailer level.
 *
 * Run with `node test/regression/order-auto-complete.regression.mjs`.
 */
process.env.NOTIFICATIONS_ENABLED = "false";
process.env.PAYMENTS_ENABLED = "false";
process.env.SMTP_HOST = "smtp.stub.invalid";
process.env.SMTP_PORT = "465";
process.env.SMTP_USER = "stub@example.test";
process.env.SMTP_PASSWORD = "stub-password";
process.env.EMAIL = "";
process.env.EMAIL_PASSWORD = "";
delete process.env.ORDER_AUTO_COMPLETE_ENABLED;
delete process.env.ORDER_AUTO_COMPLETE_GRACE_DAYS;
delete process.env.ORDER_AUTO_COMPLETE_INTERVAL_MS;

import mongoose from "mongoose";
import nodemailer from "nodemailer";
import { addressFixture, connect, createSuite, marker, productFixture } from "./helpers.mjs";

// Stubbed before anything can build a real transport. mailer.js caches the
// transport per host, and this is the first one it will ever build.
const sent = [];
nodemailer.createTransport = () => ({
  sendMail: async (message) => {
    sent.push(message);
    return { messageId: `stub-${sent.length}` };
  },
});

const { ok, section, finish } = createSuite("order-auto-complete");
await connect();

const OrderModel = (await import("../../src/modules/orders/Order.model.js")).default;
const ProductModel = (await import("../../src/modules/products/Product.model.js")).default;
const ReturnModel = (await import("../../src/modules/returns/return.model.js")).default;
const UserModel = (await import("../../src/model/User.model.js")).default;
const BillCounter = (await import("../../src/modules/orders/BillCounter.model.js")).default;
const NotificationEvent = (await import("../../src/model/NotificationEvent.model.js")).default;
const { financialYear } = await import("../../src/modules/orders/bill-number.service.js");
const autoComplete = await import("../../src/modules/orders/order-auto-complete.service.js");
const { completeEligibleDeliveredOrders, runOrderAutoCompletePass, startOrderAutoComplete, stopOrderAutoComplete } =
  autoComplete;

const MARKER = marker("autocomplete");
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2001-06-15T12:00:00Z");
const daysAgo = (days) => new Date(NOW.getTime() - days * DAY);
const trash = { orders: [], products: [], users: [], returns: [] };
let seq = 0;

// Only one order mints a real bill number (the backstop check); the rest carry a
// pre-stamped one, so the live counter moves by at most one and is rewound below.
const LIVE_FY = financialYear();
const liveCounterBefore = (await BillCounter.findOne({ financialYear: LIVE_FY }).lean())?.seq ?? null;
let mintedLive = 0;

const makeProduct = async (returnPolicy) => {
  const product = await ProductModel.create(
    productFixture(`${MARKER}-p-${(seq += 1)}`, returnPolicy ? { returnPolicy } : {}),
  );
  trash.products.push(product._id);
  return product;
};

const makeUser = async () => {
  seq += 1;
  const user = await UserModel.create({
    name: `${MARKER}-user-${seq}`,
    email: `${MARKER}-${seq}@example.test`.toLowerCase(),
    password: "x".repeat(20),
  });
  trash.users.push(user._id);
  return user;
};

/**
 * A Delivered order. `policies` is one returnPolicy per line (null = product
 * default; "missing" = a product id that does not exist).
 */
const makeOrder = async ({
  deliveredDaysAgo = 30,
  deliveredAt,
  policies = [null],
  refunds = [],
  withBill = true,
  shipmentProvider = null,
} = {}) => {
  const user = await makeUser();
  const items = [];
  for (const policy of policies) {
    const productId =
      policy === "missing" ? new mongoose.Types.ObjectId() : (await makeProduct(policy))._id;
    items.push({ product: productId, name: `${MARKER}-item`, image: "x.png", price: 300, quantity: 1 });
  }
  seq += 1;
  const order = await OrderModel.create({
    user: user._id,
    items,
    shippingAddress: addressFixture(),
    paymentMethod: "RAZORPAY",
    paymentStatus: "Paid",
    orderStatus: "Delivered",
    deliveredAt: deliveredAt === undefined ? daysAgo(deliveredDaysAgo) : deliveredAt,
    subtotal: 300 * items.length,
    totalAmount: 300 * items.length,
    refunds,
    ...(withBill
      ? { bill: { number: `${MARKER}-B-${seq}`, financialYear: "2001-02", sequence: seq, issuedAt: NOW } }
      : {}),
    ...(shipmentProvider
      ? { shipment: { provider: shipmentProvider, carrierName: "Stub Courier", trackingNumber: `AWB${seq}`, status: "Delivered" } }
      : {}),
  });
  trash.orders.push(order._id);
  return { order, user };
};

const makeReturn = async (order, status) => {
  seq += 1;
  const returnRequest = await ReturnModel.create({
    order: order._id,
    user: order.user,
    product: order.items[0].product,
    productSnapshot: { name: "x", image: "x.png", price: 300 },
    quantity: 1,
    reason: "regression",
    refundAmount: 300,
    resolutionType: "refund",
    status,
    returnNumber: `${MARKER}-RET-${seq}`,
  });
  trash.returns.push(returnRequest._id);
  return returnRequest;
};

const statusOf = async (order) => (await OrderModel.findById(order._id).lean())?.orderStatus;
const completedRows = (order) => NotificationEvent.countDocuments({ event: "order.completed", order: order._id });
const emailsTo = (user) => sent.filter((message) => message.to === user.email).length;

const sweep = (options = {}) => completeEligibleDeliveredOrders({ now: NOW, ...options });

try {
  // ================================================================ ELIGIBLE
  section("past the window: completes, with history, bill, notification and email");
  {
    // 7-day default window + 1-day grace → eligible after 8 days; 9 days ago is past it.
    const { order, user } = await makeOrder({ deliveredDaysAgo: 9, withBill: false, shipmentProvider: "MANUAL" });
    const summary = await sweep();
    const after = await OrderModel.findById(order._id).lean();
    ok("order is Completed", after.orderStatus === "Completed", after.orderStatus);
    ok("summary lists it", summary.completed.includes(String(order._id)));
    const entry = (after.statusHistory || []).at(-1);
    ok(
      "history: Delivered → Completed by the system",
      entry?.from === "Delivered" && entry?.to === "Completed" && entry?.changedBy === null && entry?.source === "auto_complete",
      JSON.stringify(entry),
    );
    ok("shipment mirror follows when a provider is recorded", after.shipment?.status === "Completed", after.shipment?.status);
    ok("bill number minted by the backstop", Boolean(after.bill?.number), JSON.stringify(after.bill));
    if (after.bill?.financialYear === LIVE_FY) mintedLive += 1;
    ok("one order.completed notification", (await completedRows(order)) === 1);
    ok("one completion email", emailsTo(user) === 1, String(emailsTo(user)));
    ok(
      "the email is the completion email",
      sent.find((m) => m.to === user.email)?.subject?.includes("is complete"),
    );
  }

  {
    const { order } = await makeOrder({ deliveredDaysAgo: 9 });
    await sweep();
    const after = await OrderModel.findById(order._id).lean();
    ok("no provider → shipment mirror stays null", after.orderStatus === "Completed" && after.shipment?.status == null);
  }

  // ================================================================ WINDOW
  section("inside the window: untouched");
  {
    const { order: fresh } = await makeOrder({ deliveredDaysAgo: 3 });
    const { order: inGrace } = await makeOrder({ deliveredDaysAgo: 7.5 });
    await sweep();
    ok("delivered 3 days ago stays Delivered", (await statusOf(fresh)) === "Delivered");
    ok("delivered 7.5 days ago (inside window + grace) stays Delivered", (await statusOf(inGrace)) === "Delivered");
  }

  section("a product's longer window is honoured");
  {
    const long = { kind: "return", windowDays: 14 };
    const { order: inside } = await makeOrder({ deliveredDaysAgo: 10, policies: [long] });
    const { order: mixed } = await makeOrder({ deliveredDaysAgo: 10, policies: [null, long] });
    const { order: past } = await makeOrder({ deliveredDaysAgo: 16, policies: [long] });
    await sweep();
    ok("14-day window, delivered 10 days ago → Delivered", (await statusOf(inside)) === "Delivered");
    ok("longest line wins (7 + 14 → 14)", (await statusOf(mixed)) === "Delivered");
    ok("14-day window, delivered 16 days ago → Completed", (await statusOf(past)) === "Completed");
  }

  section("non-returnable and deleted products");
  {
    const { order: none } = await makeOrder({ deliveredDaysAgo: 9, policies: [{ kind: "none", windowDays: 30 }] });
    const { order: missing } = await makeOrder({ deliveredDaysAgo: 9, policies: ["missing"] });
    const { order: missingRecent } = await makeOrder({ deliveredDaysAgo: 7.5, policies: ["missing"] });
    await sweep();
    ok("kind none ignores its windowDays → Completed", (await statusOf(none)) === "Completed");
    ok("deleted product falls back to 7 days → Completed after 9", (await statusOf(missing)) === "Completed");
    ok("deleted product, 7.5 days → Delivered", (await statusOf(missingRecent)) === "Delivered");
  }

  // ================================================================ BLOCKERS
  section("an open return blocks; a closed one does not");
  {
    const { order: open } = await makeOrder({ deliveredDaysAgo: 20 });
    await makeReturn(open, "pending");
    const { order: received } = await makeOrder({ deliveredDaysAgo: 20 });
    await makeReturn(received, "received");
    const { order: rejected } = await makeOrder({ deliveredDaysAgo: 20 });
    await makeReturn(rejected, "rejected");
    const summary = await sweep();
    ok("pending return → Delivered", (await statusOf(open)) === "Delivered");
    ok("received return → Delivered", (await statusOf(received)) === "Delivered");
    ok("rejected return does not block → Completed", (await statusOf(rejected)) === "Completed");
    ok("summary counts the blocked ones", summary.skipped.openReturn >= 2, JSON.stringify(summary.skipped));
  }

  section("money in flight blocks");
  {
    const row = (status) => ({ amount: 100, status, reason: "regression", paymentProvider: "razorpay" });
    const { order: owed } = await makeOrder({ deliveredDaysAgo: 20, refunds: [row("owed")] });
    const { order: created } = await makeOrder({ deliveredDaysAgo: 20, refunds: [row("created")] });
    const { order: processed } = await makeOrder({ deliveredDaysAgo: 20, refunds: [row("processed")] });
    const { order: failed } = await makeOrder({ deliveredDaysAgo: 20, refunds: [row("failed")] });
    // A failed refund whose retry settled: nothing is owed any more.
    const failedRow = { ...row("failed"), _id: new mongoose.Types.ObjectId() };
    const { order: retried } = await makeOrder({
      deliveredDaysAgo: 20,
      refunds: [failedRow, { ...row("processed"), idempotencyKey: `retry:${failedRow._id}` }],
    });
    const summary = await sweep();
    ok("owed refund → Delivered", (await statusOf(owed)) === "Delivered");
    ok("created refund → Delivered", (await statusOf(created)) === "Delivered");
    ok("processed refund → Completed", (await statusOf(processed)) === "Completed");
    // Razorpay failed it and nothing replaced it: the customer is still owed the
    // money, so the case is not closed.
    ok("failed refund with no retry → Delivered", (await statusOf(failed)) === "Delivered");
    ok("summary counts it", summary.skipped.failedRefund >= 1, JSON.stringify(summary.skipped));
    ok("failed refund whose retry settled → Completed", (await statusOf(retried)) === "Completed");
  }

  section("a refund recorded between scan and claim wins");
  {
    // The CAS re-checks the refund condition, so a row pushed after the candidate
    // read still blocks the completion.
    const { order } = await makeOrder({ deliveredDaysAgo: 20 });
    const realFind = OrderModel.findOneAndUpdate.bind(OrderModel);
    OrderModel.findOneAndUpdate = async (filter, ...rest) => {
      if (String(filter?._id) === String(order._id) && filter?.orderStatus === "Delivered") {
        await OrderModel.updateOne(
          { _id: order._id },
          { $push: { refunds: { amount: 50, status: "owed", reason: "late", paymentProvider: "razorpay" } } },
        );
      }
      return realFind(filter, ...rest);
    };
    try {
      await sweep();
    } finally {
      OrderModel.findOneAndUpdate = realFind;
    }
    ok("still Delivered", (await statusOf(order)) === "Delivered");
    ok("no completion notification", (await completedRows(order)) === 0);
  }

  section("no deliveredAt: never touched");
  {
    const { order } = await makeOrder({ deliveredAt: null });
    await sweep();
    ok("stays Delivered", (await statusOf(order)) === "Delivered");
  }

  // ================================================================ CONCURRENCY
  section("two concurrent sweeps complete an order once");
  {
    const { order, user } = await makeOrder({ deliveredDaysAgo: 9 });
    const [a, b] = await Promise.all([sweep(), sweep()]);
    const wins = [a, b].filter((s) => s.completed.includes(String(order._id))).length;
    ok("exactly one sweep won", wins === 1, String(wins));
    ok("Completed", (await statusOf(order)) === "Completed");
    const history = (await OrderModel.findById(order._id).lean()).statusHistory.filter((h) => h.to === "Completed");
    ok("one history entry", history.length === 1, String(history.length));
    ok("one notification", (await completedRows(order)) === 1);
    ok("one email", emailsTo(user) === 1, String(emailsTo(user)));
  }

  // ================================================================ STALE EMAIL
  section("a long-stale backlog completes without an email");
  {
    const { order: stale, user: staleUser } = await makeOrder({ deliveredDaysAgo: 60 });
    // Eligible at 8 days; 11.5 days is 3.5 days after eligibility → stale.
    const { order: edge, user: edgeUser } = await makeOrder({ deliveredDaysAgo: 11.5 });
    // 10.5 days → 2.5 days after eligibility → still emailed.
    const { order: recent, user: recentUser } = await makeOrder({ deliveredDaysAgo: 10.5 });
    await sweep();
    ok("stale order Completed", (await statusOf(stale)) === "Completed");
    ok("stale order still gets the notification row", (await completedRows(stale)) === 1);
    ok("stale order gets NO email", emailsTo(staleUser) === 0);
    ok("3.5 days after eligibility → no email", (await statusOf(edge)) === "Completed" && emailsTo(edgeUser) === 0);
    ok("2.5 days after eligibility → email", (await statusOf(recent)) === "Completed" && emailsTo(recentUser) === 1);
  }

  section("a non-returnable order is emailed when it becomes eligible");
  {
    // Window 0 + 1-day grace → eligible 1 day after delivery. The candidate query
    // used to wait for the 7-day default window too, so such an order was first
    // seen 7 days after it became eligible — always stale, never emailed.
    const { order, user } = await makeOrder({ deliveredDaysAgo: 2, policies: [{ kind: "none", windowDays: 0 }] });
    await sweep();
    ok("Completed 2 days after delivery", (await statusOf(order)) === "Completed");
    ok("and emailed (1 day after eligibility)", emailsTo(user) === 1, String(emailsTo(user)));
    const { order: young } = await makeOrder({ deliveredDaysAgo: 0.5, policies: [{ kind: "none", windowDays: 0 }] });
    await sweep();
    ok("still inside the grace → Delivered", (await statusOf(young)) === "Delivered");
  }

  section("grace days are configurable");
  {
    process.env.ORDER_AUTO_COMPLETE_GRACE_DAYS = "5";
    const { order } = await makeOrder({ deliveredDaysAgo: 10 });
    await sweep();
    ok("grace 5: delivered 10 days ago stays Delivered", (await statusOf(order)) === "Delivered");
    process.env.ORDER_AUTO_COMPLETE_GRACE_DAYS = "0";
    const { order: zero } = await makeOrder({ deliveredDaysAgo: 7.2 });
    await sweep();
    ok("grace 0: delivered 7.2 days ago completes", (await statusOf(zero)) === "Completed");
    delete process.env.ORDER_AUTO_COMPLETE_GRACE_DAYS;
    ok("default grace is 1 day", autoComplete.orderAutoCompleteGraceDays() === 1);
  }

  // ================================================================ FLAGS
  section("the env flag turns it off");
  {
    const { order } = await makeOrder({ deliveredDaysAgo: 9 });
    process.env.ORDER_AUTO_COMPLETE_ENABLED = "false";
    const result = await runOrderAutoCompletePass({ now: NOW });
    ok("pass reports disabled", result.ran === false && result.reason === "disabled_by_env", JSON.stringify(result));
    ok("order untouched", (await statusOf(order)) === "Delivered");
    ok("start is a no-op", startOrderAutoComplete() === false);
    delete process.env.ORDER_AUTO_COMPLETE_ENABLED;

    const enabled = await runOrderAutoCompletePass({ now: NOW });
    ok("enabled by default", enabled.ran === true, JSON.stringify(enabled));
    ok("order completes once enabled", (await statusOf(order)) === "Completed");

    ok("start returns true when enabled", startOrderAutoComplete() === true);
    stopOrderAutoComplete();
  }

  section("interval parsing");
  {
    process.env.ORDER_AUTO_COMPLETE_INTERVAL_MS = "1000";
    ok("below 5 minutes clamps to 5 minutes", autoComplete.orderAutoCompleteIntervalMs() === 5 * 60 * 1000);
    process.env.ORDER_AUTO_COMPLETE_INTERVAL_MS = "nonsense";
    ok("garbage falls back to 1 hour", autoComplete.orderAutoCompleteIntervalMs() === 60 * 60 * 1000);
    process.env.ORDER_AUTO_COMPLETE_INTERVAL_MS = String(2 * 60 * 60 * 1000);
    ok("a valid value is used", autoComplete.orderAutoCompleteIntervalMs() === 2 * 60 * 60 * 1000);
    delete process.env.ORDER_AUTO_COMPLETE_INTERVAL_MS;
  }
} catch (error) {
  ok("suite ran without throwing", false, error?.stack || String(error));
} finally {
  stopOrderAutoComplete();
  await NotificationEvent.deleteMany({ order: { $in: trash.orders } });
  await ReturnModel.deleteMany({ _id: { $in: trash.returns } });
  await OrderModel.deleteMany({ _id: { $in: trash.orders } });
  await ProductModel.deleteMany({ _id: { $in: trash.products } });
  await UserModel.deleteMany({ _id: { $in: trash.users } });
  // Rewind the live bill counter only if nothing else minted in the meantime
  // (the filter is the guard: another process's mint moves seq past ours).
  if (mintedLive > 0) {
    if (liveCounterBefore === null) {
      await BillCounter.deleteOne({ financialYear: LIVE_FY, seq: mintedLive });
    } else {
      await BillCounter.updateOne(
        { financialYear: LIVE_FY, seq: liveCounterBefore + mintedLive },
        { $set: { seq: liveCounterBefore } },
      );
    }
  }
  finish();
  await mongoose.disconnect();
}
