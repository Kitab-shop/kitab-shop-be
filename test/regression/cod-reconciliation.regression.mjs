/**
 * COD reconciliation (Phase D1) — read-only.
 *
 * Cash collection in this system is INFERRED: delivery flips `paymentStatus` from Pending
 * to Paid, on the assumption the courier took the money at the door. Nothing verifies it.
 * This report names the four ways that inference goes wrong, each of which is money:
 *
 *   uncollected   Delivered but still Pending — cash taken, not recorded.
 *   phantom       Paid but never Delivered — revenue that does not exist.
 *   rtoStillPaid  Came back to you and still marked Paid — parcel AND cash both counted.
 *   missingDate   Delivered and Paid with no deliveredAt — the return window has no origin.
 *
 * Run with `npm run test:cod-reconciliation` (or `npm test` for everything).
 *
 * Every assertion is a DELTA: the report reads the whole orders collection, which on a dev
 * database contains real records (it currently finds 5 genuine `uncollected` orders from
 * seeded data). Asserting absolute counts would make this suite pass or fail on whatever
 * happens to be in the database, so each case snapshots, plants one fixture, and asserts
 * what changed. Nothing is stubbed — the report makes no external call by design.
 */
process.env.PAYMENTS_ENABLED = "false";
process.env.INVENTORY_ENFORCE_STOCK = "false";
process.env.INVENTORY_RESERVE_DURING_PAYMENT = "false";
process.env.NOTIFICATIONS_ENABLED = "false";

import mongoose from "mongoose";
import { connect, createSuite, marker, productFixture, addressFixture } from "./helpers.mjs";

const { ok, section, finish } = createSuite("cod-reconciliation");
await connect();

const OrderModel = (await import("../../src/modules/orders/Order.model.js")).default;
const ProductModel = (await import("../../src/modules/products/Product.model.js")).default;
const { buildCodReconciliation } = await import("../../src/modules/admin/cod-reconciliation.service.js");
const adminController = await import("../../src/modules/admin/admin.controller.js");

await OrderModel.init();

const MARKER = marker("codrecon");
const trash = { orders: [], products: [] };
let seq = 0;

const makeOrder = async (overrides = {}) => {
  seq += 1;
  const product = await ProductModel.create(productFixture(`${MARKER}-${seq}`, { stock: 20 }));
  trash.products.push(product._id);
  const order = await OrderModel.create({
    user: new mongoose.Types.ObjectId(),
    idempotencyKey: `${MARKER}-key-${seq}-aaaaaaaaaaaaaaaa`,
    items: [{ product: product._id, name: product.name, image: "x.png", price: 500, quantity: 1 }],
    shippingAddress: addressFixture(),
    paymentMethod: "COD",
    paymentStatus: "Pending",
    orderStatus: "Confirmed",
    subtotal: 500,
    totalAmount: 1000,
    ...overrides,
  });
  trash.orders.push(order._id);
  return order;
};

const counts = async () => {
  const report = await buildCodReconciliation({ limit: 1000 });
  return {
    uncollected: report.buckets.uncollected.count,
    phantom: report.buckets.phantom.count,
    rtoStillPaid: report.buckets.rtoStillPaid.count,
    missingDate: report.buckets.missingDate.count,
    amount: report.discrepancyAmount,
    report,
  };
};

/** Plants one order, returns how each bucket moved. */
const deltaFor = async (overrides) => {
  const before = await counts();
  const order = await makeOrder(overrides);
  const after = await counts();
  return {
    order,
    uncollected: after.uncollected - before.uncollected,
    phantom: after.phantom - before.phantom,
    rtoStillPaid: after.rtoStillPaid - before.rtoStillPaid,
    missingDate: after.missingDate - before.missingDate,
    amount: after.amount - before.amount,
    after,
  };
};

// ================================================================ DETECTION

section("each discrepancy is detected, and only by its own bucket");

{
  const delta = await deltaFor({ orderStatus: "Delivered", paymentStatus: "Pending", deliveredAt: new Date() });
  ok(
    "delivered but still Pending lands in uncollected",
    delta.uncollected === 1,
    JSON.stringify(delta),
  );
  ok(
    "and in no other bucket",
    delta.phantom === 0 && delta.rtoStillPaid === 0 && delta.missingDate === 0,
    JSON.stringify(delta),
  );
  ok(
    "the money at risk is the order's total, counted once",
    delta.amount === 1000,
    `delta=${delta.amount}`,
  );
}

{
  const delta = await deltaFor({ orderStatus: "Shipped", paymentStatus: "Paid", deliveredAt: null });
  ok(
    "Paid without ever being delivered lands in phantom",
    delta.phantom === 1 && delta.uncollected === 0,
    JSON.stringify(delta),
  );
}

{
  const delta = await deltaFor({ orderStatus: "RTO Received", paymentStatus: "Paid", deliveredAt: null });
  ok(
    "returned to origin but still Paid lands in rtoStillPaid",
    delta.rtoStillPaid === 1,
    JSON.stringify(delta),
  );
  ok(
    "and NOT also in phantom — one order must not be counted twice",
    delta.phantom === 0,
    JSON.stringify(delta),
  );
}

{
  const delta = await deltaFor({ orderStatus: "Delivered", paymentStatus: "Paid", deliveredAt: null });
  ok(
    "delivered and Paid with no deliveredAt lands in missingDate",
    delta.missingDate === 1,
    JSON.stringify(delta),
  );
  ok(
    "and is not treated as phantom — it WAS delivered, the timestamp is what's missing",
    delta.phantom === 0,
    JSON.stringify(delta),
  );
  ok(
    "missingDate is an audit-trail problem, so it adds nothing to the money at risk",
    delta.amount === 0,
    `delta=${delta.amount}`,
  );
}

// ================================================================ FALSE POSITIVES

section("legitimate states are not reported as discrepancies");

{
  const delta = await deltaFor({ orderStatus: "Delivered", paymentStatus: "Paid", deliveredAt: new Date() });
  ok(
    "the normal happy path — delivered, paid, timestamped — is in no bucket",
    delta.uncollected === 0 && delta.phantom === 0 && delta.rtoStillPaid === 0 && delta.missingDate === 0,
    JSON.stringify(delta),
  );
}

{
  const delta = await deltaFor({ orderStatus: "Confirmed", paymentStatus: "Pending", deliveredAt: null });
  ok(
    "an order still in transit is not a discrepancy — it simply hasn't been delivered yet",
    delta.uncollected === 0 && delta.phantom === 0,
    JSON.stringify(delta),
  );
}

{
  // A refund legitimately FOLLOWS collection, so a refunded COD order is not phantom
  // revenue — treating it as such would flag every completed return.
  for (const paymentStatus of ["Refunded", "Partially Refunded", "Refund Pending"]) {
    const delta = await deltaFor({
      orderStatus: "Delivered",
      paymentStatus,
      deliveredAt: new Date(),
    });
    ok(
      `a ${paymentStatus} COD order is not flagged`,
      delta.phantom === 0 && delta.uncollected === 0 && delta.missingDate === 0,
      JSON.stringify(delta),
    );
  }
}

{
  // A cancelled COD order showing Paid is a refund-ledger question, not a collection one,
  // and the refund suites already cover it. Reporting it here would be noise that buries
  // the discrepancies an operator can actually act on.
  const delta = await deltaFor({ orderStatus: "Cancelled", paymentStatus: "Paid", deliveredAt: null });
  ok(
    "a cancelled COD order is left to the refund ledger, not reported as phantom",
    delta.phantom === 0,
    JSON.stringify(delta),
  );
}

{
  const before = await counts();
  await makeOrder({
    paymentMethod: "RAZORPAY",
    orderStatus: "Shipped",
    paymentStatus: "Paid",
    deliveredAt: null,
    razorpayPaymentId: `pay_${MARKER}_${seq}`,
  });
  const after = await counts();
  ok(
    "prepaid orders never appear — money already moved through the gateway",
    after.phantom === before.phantom && after.uncollected === before.uncollected,
    JSON.stringify({ before: before.phantom, after: after.phantom }),
  );
}

{
  // Proves the lifecycle-suite exemption by fixture rather than by argument. This is the
  // EXACT shape EXCLUDE_AWAITING_PAYMENT exists to keep out of totals: a Razorpay checkout
  // that was started and abandoned, which is not an order at all. Filtering on
  // `paymentMethod: "COD"` excludes it more strictly than the shared filter would.
  const before = await counts();
  const abandoned = await makeOrder({
    paymentMethod: "RAZORPAY",
    paymentStatus: "Pending",
    orderStatus: "Pending",
    deliveredAt: null,
    totalAmount: 99999,
  });
  const after = await counts();
  ok(
    "an abandoned Razorpay checkout is in no bucket and no total",
    after.uncollected === before.uncollected &&
      after.phantom === before.phantom &&
      after.rtoStillPaid === before.rtoStillPaid &&
      after.missingDate === before.missingDate &&
      after.amount === before.amount,
    JSON.stringify({ before: before.amount, after: after.amount }),
  );
  ok(
    "and its value never reaches the COD totals",
    after.report.totals.codOrders === before.report.totals.codOrders &&
      after.report.totals.awaitingCollection === before.report.totals.awaitingCollection,
    JSON.stringify({ before: before.report.totals, after: after.report.totals }),
  );
  ok(
    "precondition: that fixture really is the excluded shape",
    abandoned.paymentMethod === "RAZORPAY" && abandoned.paymentStatus === "Pending",
    JSON.stringify({ method: abandoned.paymentMethod, status: abandoned.paymentStatus }),
  );
}

// ================================================================ HONESTY

section("the report does not overstate what it knows");

{
  const report = (await counts()).report;
  ok(
    "it states plainly that amounts are NOT matched against cash received",
    report.remittanceMatched === false && /not matched against cash/i.test(report.note || ""),
    JSON.stringify({ matched: report.remittanceMatched, note: report.note }),
  );
  ok(
    "totals separate what we believe was collected from what is still awaited",
    typeof report.totals?.recordedCollected === "number" &&
      typeof report.totals?.awaitingCollection === "number",
    JSON.stringify(report.totals),
  );
}

{
  // A truncated list that looks complete is how a reconciliation report under-reports the
  // very problem it exists to find.
  const capped = await buildCodReconciliation({ limit: 1 });
  ok(
    "truncation is declared rather than silent",
    capped.capped === true && capped.limit === 1,
    JSON.stringify({ capped: capped.capped, limit: capped.limit }),
  );
  const generous = await buildCodReconciliation({ limit: 1000 });
  ok(
    "and not declared when nothing was truncated",
    generous.capped === false,
    JSON.stringify({ capped: generous.capped }),
  );
  ok(
    "the limit is clamped so a hostile value cannot ask for the whole collection",
    (await buildCodReconciliation({ limit: 999999 })).limit === 1000 &&
      (await buildCodReconciliation({ limit: -5 })).limit === 1,
    JSON.stringify({
      huge: (await buildCodReconciliation({ limit: 999999 })).limit,
      negative: (await buildCodReconciliation({ limit: -5 })).limit,
    }),
  );
}

{
  const report = (await counts()).report;
  const sample = report.buckets.uncollected.orders[0];
  if (sample) {
    ok(
      "each reported order carries what an operator needs to look it up with the courier",
      Object.prototype.hasOwnProperty.call(sample, "totalAmount") &&
        Object.prototype.hasOwnProperty.call(sample, "orderStatus"),
      JSON.stringify(Object.keys(sample)),
    );
    ok(
      "and nothing beyond the allow-list — no customer or item data in a finance report",
      !Object.prototype.hasOwnProperty.call(sample, "items") &&
        !Object.prototype.hasOwnProperty.call(sample, "shippingAddress") &&
        !Object.prototype.hasOwnProperty.call(sample, "user"),
      JSON.stringify(Object.keys(sample)),
    );
  } else {
    ok("uncollected bucket had a sample row to inspect", false, "no rows — cannot verify projection");
  }
}

// ================================================================ READ-ONLY

section("the report changes nothing");

{
  const order = await makeOrder({ orderStatus: "Delivered", paymentStatus: "Pending", deliveredAt: new Date() });
  const snapshot = await OrderModel.findById(order._id).lean();

  await buildCodReconciliation({ limit: 1000 });
  await buildCodReconciliation({ limit: 1000 });

  const after = await OrderModel.findById(order._id).lean();
  ok(
    "a flagged order is not silently corrected — the fix needs a human decision",
    after.paymentStatus === "Pending" && after.orderStatus === "Delivered",
    JSON.stringify({ paymentStatus: after.paymentStatus, orderStatus: after.orderStatus }),
  );
  ok(
    "and nothing else on it changed either",
    String(after.updatedAt) === String(snapshot.updatedAt) &&
      (after.refunds?.length || 0) === (snapshot.refunds?.length || 0) &&
      (after.statusHistory?.length || 0) === (snapshot.statusHistory?.length || 0),
    JSON.stringify({
      updatedAt: String(after.updatedAt) === String(snapshot.updatedAt),
      refunds: after.refunds?.length,
      history: after.statusHistory?.length,
    }),
  );
}

{
  let statusCode = 200;
  let payload;
  const res = {
    status(code) { statusCode = code; return this; },
    json(data) { payload = data; return this; },
  };
  await adminController.GetCodReconciliation({ query: { limit: "50" }, user: { roles: ["admin"] } }, res);
  ok(
    "the endpoint answers with the report",
    statusCode === 200 && payload?.success === true && Boolean(payload?.buckets),
    `${statusCode} ${JSON.stringify(Object.keys(payload || {}))}`,
  );
  ok(
    "and honours the requested limit",
    payload?.limit === 50,
    String(payload?.limit),
  );
}

// ---------------------------------------------------------------- cleanup

await Promise.all([
  OrderModel.deleteMany({ _id: { $in: trash.orders } }),
  ProductModel.deleteMany({ _id: { $in: trash.products } }),
]);

const leftovers =
  (await OrderModel.countDocuments({ idempotencyKey: new RegExp(MARKER) })) +
  (await ProductModel.countDocuments({ name: new RegExp(MARKER) }));
ok("every fixture this suite created is gone", leftovers === 0, `leftovers=${leftovers}`);

const summary = finish();
await mongoose.disconnect();
process.exit(summary.failed > 0 ? 1 : 0);
