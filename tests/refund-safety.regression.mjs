/**
 * Phase 1 financial-safety regression: duplicate-refund prevention (F1) and
 * compensation for a captured payment that can no longer become an order (F2).
 *
 * Covers audit items F1, F2, H2-04. Run with `npm run test:refunds-safety`
 * (or `npm test` for everything).
 *
 * Two things about how this is written:
 *
 *   - Razorpay is STUBBED, but nothing else is. Every guard under test is a
 *     database atomicity property — a filter precondition, a unique index — so
 *     the database is real and the concurrency is real. Only the gateway, which
 *     would move actual money, is faked. Each stub counts its calls, because
 *     "how many times did we tell Razorpay to refund" is the entire question.
 *   - Concurrency is driven with Promise.all over independent handler calls, the
 *     same shape as two HTTP requests arriving together. A sequential test would
 *     pass against the broken code.
 */
import mongoose from "mongoose";
import { connect, createSuite, marker } from "./helpers.mjs";

const { ok, section, finish } = createSuite("refund-safety");
await connect();

const OrderModel = (await import("../src/modules/orders/Order.model.js")).default;
const PaymentIntent = (await import("../src/modules/payments/PaymentIntent.model.js")).default;
const UnmatchedPayment = (await import("../src/modules/payments/UnmatchedPayment.model.js")).default;
const {
  canAutoRefund,
  cancellationRefundKey,
  claimGatewayAttempt,
  claimRefundSlot,
  deriveRefundIdempotencyKey,
  recordRefundObligation,
  settleGatewayRefund,
  settleRefundRecord,
  sumRefunded,
  sumSettledRefunds,
} = await import("../src/modules/payments/return-refund.service.js");
const { isUnrecoverableCapture, refundOrphanedCapture, countUnresolvedOrphanedCaptures } =
  await import("../src/modules/payments/orphaned-capture.service.js");
const razorpayService = await import("../src/modules/payments/razorpay.service.js");
const { PAYMENT_INTENT_RETENTION_MS } = await import(
  "../src/modules/payments/PaymentIntent.model.js"
);
const { AWAITING_PAYMENT_TTL_MS } = await import("../src/modules/orders/order-visibility.js");

// Indexes are the guard under test in the H2-04 section, and autoIndex builds
// them asynchronously — so wait for them rather than racing the build.
await OrderModel.init();
await UnmatchedPayment.init();

const MARKER = marker("refundsafety");
const trash = { orders: [], intents: [], unmatched: [] };
let seq = 0;

// ── Razorpay stub ───────────────────────────────────────────────────────────
// Replaces getRazorpay for the whole suite. `calls.refund` is the assertion that
// matters most: the guards exist to keep that number at 1.
const calls = { refund: [], fetchMultipleRefund: 0 };
// Never reset, so ids stay unique for the whole run the way real Razorpay ids are.
// (Reusing them tripped the new unique index — the stub's fault, not the code's.)
let refundIdSeq = 0;
const nextRefundId = () => `rfnd_${MARKER}_${++refundIdSeq}`;
let refundBehaviour = () => ({ id: nextRefundId(), status: "processed" });
let gatewayRefundsOnRecord = [];
let fetchShouldThrow = false;

// Self-contained: force payments on with obviously-fake credentials, so the suite
// never depends on .env and never holds real keys. Nothing reaches the network —
// the two methods that would are replaced below.
process.env.PAYMENTS_ENABLED = "true";
process.env.PAYMENT_PROVIDER = "razorpay";
process.env.RAZORPAY_KEY_ID = "rzp_test_stub0000000";
process.env.RAZORPAY_KEY_SECRET = "stub_secret_for_tests";

// `getRazorpay()` caches one SDK instance in module scope and every caller shares
// it, so patching the METHODS on that instance reaches all code under test. An ES
// module namespace object cannot be redefined, so replacing the exported function
// is not an option — and this is closer to the real thing anyway: the production
// code path, the real client object, only the network call swapped out.
const { razorpay: sharedRazorpay } = razorpayService.getRazorpay();
sharedRazorpay.payments.refund = async (paymentId, options) => {
  calls.refund.push({ paymentId, options });
  return refundBehaviour(paymentId, options);
};
sharedRazorpay.payments.fetchMultipleRefund = async () => {
  calls.fetchMultipleRefund += 1;
  if (fetchShouldThrow) throw new Error("gateway unreachable");
  return { items: gatewayRefundsOnRecord };
};

const resetGateway = () => {
  calls.refund = [];
  calls.fetchMultipleRefund = 0;
  gatewayRefundsOnRecord = [];
  fetchShouldThrow = false;
  refundBehaviour = () => ({ id: nextRefundId(), status: "processed" });
};

const makeOrder = async (fields = {}) => {
  seq += 1;
  const order = await OrderModel.create({
    user: new mongoose.Types.ObjectId(),
    items: [
      {
        product: new mongoose.Types.ObjectId(),
        name: `${MARKER}-item`,
        price: 1000,
        quantity: 1,
      },
    ],
    shippingAddress: {
      fullName: "Refund Safety",
      phone: "9999999999",
      address: "1 Test Street",
      city: "Pune",
      state: "Maharashtra",
      pincode: "411001",
      country: "India",
    },
    paymentMethod: "RAZORPAY",
    paymentStatus: "Paid",
    orderStatus: "Confirmed",
    subtotal: 1000,
    totalAmount: 1000,
    razorpayPaymentId: `pay_${MARKER}_${seq}`,
    ...fields,
  });
  trash.orders.push(order._id);
  return order;
};

/**
 * The refund path under test, reduced to exactly what the controller does after
 * validation: claim, then call the gateway only if the claim was new, then settle.
 * Kept in the test rather than importing the Express handler so no HTTP layer,
 * auth or rate limiter sits between the assertion and the concurrency.
 */
const attemptRefund = async ({ order, amount, reason = "Admin refund", idempotencyKey }) => {
  const key =
    idempotencyKey || deriveRefundIdempotencyKey({ orderId: order._id, amount, reason });
  let claim;
  try {
    claim = await claimRefundSlot({
      orderId: order._id,
      idempotencyKey: key,
      amount,
      record: {
        paymentProvider: "razorpay",
        providerPaymentId: order.razorpayPaymentId,
        reason,
        status: "created",
        confirmationMethod: "gateway",
      },
    });
  } catch (error) {
    return { outcome: "rejected", code: error.code, message: error.message };
  }

  if (!claim.created && claim.refund.status === "processed") {
    return { outcome: "adopted_processed" };
  }

  // The second claim: permission to actually call the gateway.
  const mayCall = await claimGatewayAttempt({ orderId: order._id, refundId: claim.refund._id });
  if (!mayCall) return { outcome: "in_progress" };

  if (!claim.created) {
    const { razorpay } = razorpayService.getRazorpay();
    const found = (await razorpay.payments.fetchMultipleRefund().catch(() => null)) || null;
    const match = (found?.items || []).find((item) => item?.notes?.refundKey === key);
    if (match) {
      await settleRefundRecord({
        orderId: order._id,
        refundId: claim.refund._id,
        providerRefundId: match.id,
        status: match.status === "failed" ? "failed" : "processed",
      });
      return { outcome: "reconciled" };
    }
  }

  const { razorpay } = razorpayService.getRazorpay();
  let refund;
  try {
    refund = await razorpay.payments.refund(order.razorpayPaymentId, {
      amount: Math.round(amount * 100),
      speed: "normal",
      notes: { reason, refundKey: key },
    });
  } catch (error) {
    await settleRefundRecord({
      orderId: order._id,
      refundId: claim.refund._id,
      status: "created",
      failureReason: error.message,
      releaseAttempt: true,
    });
    return { outcome: "gateway_failed", message: error.message };
  }

  await settleRefundRecord({
    orderId: order._id,
    refundId: claim.refund._id,
    providerRefundId: refund.id,
    status: refund.status === "failed" ? "failed" : "processed",
  });
  return { outcome: "refunded", refundId: refund.id };
};

try {
  // ═══════════════════════════════════════════════════════════════════════════
  section("F1 — concurrent refunds on one order");

  {
    resetGateway();
    const order = await makeOrder();
    // Two simultaneous requests, same amount — the double-clicked button.
    const [a, b] = await Promise.all([
      attemptRefund({ order, amount: 1000 }),
      attemptRefund({ order, amount: 1000 }),
    ]);

    ok(
      "two concurrent identical refunds call the gateway exactly ONCE",
      calls.refund.length === 1,
      `gateway called ${calls.refund.length}x`,
    );
    const outcomes = [a.outcome, b.outcome].sort().join(",");
    ok(
      "one refunds, the other adopts or reconciles instead of paying again",
      calls.refund.length === 1 && [a, b].some((r) => r.outcome === "refunded"),
      `outcomes: ${outcomes}`,
    );

    const fresh = await OrderModel.findById(order._id);
    const live = fresh.refunds.filter((r) => r.status !== "failed");
    ok("only ONE live refund row exists", live.length === 1, `${live.length} rows`);
    ok(
      "total refunded never exceeds the order total",
      sumRefunded(fresh) <= fresh.totalAmount + 0.01,
      `refunded ${sumRefunded(fresh)} of ${fresh.totalAmount}`,
    );
    ok("paymentStatus settles to Refunded", fresh.paymentStatus === "Refunded", fresh.paymentStatus);
  }

  {
    resetGateway();
    const order = await makeOrder();
    // Five at once, to be sure the winner is decided by the database and not by
    // luck in a two-way race.
    const results = await Promise.all(
      Array.from({ length: 5 }, () => attemptRefund({ order, amount: 1000 })),
    );
    ok(
      "five concurrent refunds still call the gateway exactly ONCE",
      calls.refund.length === 1,
      `gateway called ${calls.refund.length}x`,
    );
    ok(
      "exactly one reports having refunded",
      results.filter((r) => r.outcome === "refunded").length === 1,
      results.map((r) => r.outcome).join(","),
    );
  }

  section("F1 — repeated requests and idempotency keys");

  {
    resetGateway();
    const order = await makeOrder();
    const key = `adm-${MARKER}-stable`;
    const first = await attemptRefund({ order, amount: 400, idempotencyKey: key });
    const second = await attemptRefund({ order, amount: 400, idempotencyKey: key });
    ok("same request repeated refunds once", calls.refund.length === 1, `${calls.refund.length}x`);
    ok("the repeat adopts the processed record", second.outcome === "adopted_processed", second.outcome);
    ok("the first genuinely refunded", first.outcome === "refunded", first.outcome);

    // A DIFFERENT deliberate refund on the same order must still be allowed.
    const third = await attemptRefund({
      order,
      amount: 400,
      idempotencyKey: `adm-${MARKER}-second-deliberate`,
    });
    ok("a distinct key issues a second, separate refund", third.outcome === "refunded", third.outcome);
    const fresh = await OrderModel.findById(order._id);
    ok(
      "cumulative refunds tracked across both (800 of 1000)",
      Math.abs(sumSettledRefunds(fresh) - 800) < 0.01,
      `settled ${sumSettledRefunds(fresh)}`,
    );
    ok(
      "partial total leaves the order Partially Refunded",
      fresh.paymentStatus === "Partially Refunded",
      fresh.paymentStatus,
    );
  }

  {
    resetGateway();
    const order = await makeOrder();
    await attemptRefund({ order, amount: 700, idempotencyKey: `adm-${MARKER}-a` });
    // 700 already committed; 700 more would exceed the 1000 total.
    const over = await attemptRefund({ order, amount: 700, idempotencyKey: `adm-${MARKER}-b` });
    ok("the ceiling rejects the excess", over.outcome === "rejected", over.outcome);
    ok("rejection is the ceiling error", over.code === "REFUND_EXCEEDS_ORDER_TOTAL", over.code);
    ok("no gateway call for the rejected attempt", calls.refund.length === 1, `${calls.refund.length}x`);
  }

  {
    resetGateway();
    const order = await makeOrder();
    // Concurrent DIFFERENT keys that together exceed the total: the ceiling has
    // to hold across distinct refunds too, not just identical ones.
    const results = await Promise.all([
      attemptRefund({ order, amount: 600, idempotencyKey: `adm-${MARKER}-x` }),
      attemptRefund({ order, amount: 600, idempotencyKey: `adm-${MARKER}-y` }),
    ]);
    ok(
      "concurrent distinct refunds cannot both pass the ceiling",
      calls.refund.length === 1,
      `gateway called ${calls.refund.length}x`,
    );
    ok(
      "the loser is rejected on the ceiling",
      results.filter((r) => r.code === "REFUND_EXCEEDS_ORDER_TOTAL").length === 1,
      results.map((r) => r.outcome).join(","),
    );
    const fresh = await OrderModel.findById(order._id);
    ok(
      "order is never over-refunded",
      sumRefunded(fresh) <= fresh.totalAmount + 0.01,
      `refunded ${sumRefunded(fresh)}`,
    );
  }

  section("F1 — gateway timeout, then a retry");

  {
    resetGateway();
    const order = await makeOrder();
    const key = `adm-${MARKER}-timeout`;

    // Attempt 1: the gateway call throws (a timeout), so the outcome is UNKNOWN.
    refundBehaviour = () => {
      throw new Error("socket hang up");
    };
    const first = await attemptRefund({ order, amount: 500, idempotencyKey: key });
    ok("a timeout is reported as a gateway failure", first.outcome === "gateway_failed", first.outcome);

    const afterTimeout = await OrderModel.findById(order._id);
    const pending = afterTimeout.refunds.find((r) => r.idempotencyKey === key);
    ok("the intent survives the timeout", Boolean(pending), "no record found");
    ok(
      "it stays `created`, NOT `failed` (unknown is not didn't-happen)",
      pending?.status === "created",
      pending?.status,
    );
    ok("the failure reason is recorded", Boolean(pending?.failureReason), "empty");
    ok(
      "an unsettled intent still counts toward the ceiling",
      Math.abs(sumRefunded(afterTimeout) - 500) < 0.01,
      `committed ${sumRefunded(afterTimeout)}`,
    );
    ok(
      "but it does NOT make the order look Refunded",
      afterTimeout.paymentStatus !== "Refunded",
      afterTimeout.paymentStatus,
    );

    // The refund HAD actually landed at Razorpay. A retry must find it.
    resetGateway();
    gatewayRefundsOnRecord = [
      { id: `rfnd_${MARKER}_recovered`, status: "processed", notes: { refundKey: key } },
    ];
    const retry = await attemptRefund({ order, amount: 500, idempotencyKey: key });
    ok("the retry reconciles instead of refunding again", retry.outcome === "reconciled", retry.outcome);
    ok("no second gateway refund was issued", calls.refund.length === 0, `${calls.refund.length}x`);

    const reconciled = await OrderModel.findById(order._id);
    const settledRow = reconciled.refunds.find((r) => r.idempotencyKey === key);
    ok("the adopted gateway id is stored", settledRow?.providerRefundId === `rfnd_${MARKER}_recovered`, settledRow?.providerRefundId);
    ok("the record is now processed", settledRow?.status === "processed", settledRow?.status);
  }

  {
    // "Gateway success but local response lost": the gateway processed it and our
    // record says processed, but the caller never saw the reply and retries.
    resetGateway();
    const order = await makeOrder();
    const key = `adm-${MARKER}-lost-response`;
    await attemptRefund({ order, amount: 300, idempotencyKey: key });
    const replay = await attemptRefund({ order, amount: 300, idempotencyKey: key });
    ok(
      "a lost-response retry pays nothing further",
      calls.refund.length === 1 && replay.outcome === "adopted_processed",
      `${calls.refund.length} calls, outcome ${replay.outcome}`,
    );
  }

  section("H2-04 — provider refund id uniqueness");

  {
    const indexes = await OrderModel.collection.indexes();
    const refundIndex = indexes.find((i) => i.key?.["refunds.providerRefundId"] === 1);
    ok("an index on refunds.providerRefundId exists", Boolean(refundIndex), "missing");
    ok("it is UNIQUE", refundIndex?.unique === true, JSON.stringify(refundIndex?.unique));
    ok("it is sparse", refundIndex?.sparse === true, JSON.stringify(refundIndex?.sparse));
    ok(
      "exactly one index covers this key (no duplicates)",
      indexes.filter((i) => i.key?.["refunds.providerRefundId"] === 1).length === 1,
      "duplicate indexes present",
    );
  }

  {
    // The index existing is not the same as the QUERY USING IT, and the scan is the
    // half of H2-04 that actually degrades with volume. Asserted from the execution
    // plan rather than inferred: a change to the query shape (a $regex, a cast
    // mismatch, wrapping the field) would silently fall back to a collection scan
    // while every other assertion here still passed.
    const plan = await OrderModel.find({
      "refunds.providerRefundId": `rfnd_${MARKER}_planprobe`,
    }).explain("executionStats");

    const serialised = JSON.stringify(plan.queryPlanner.winningPlan);
    const stageOf = (node) => {
      let current = node?.queryPlan || node;
      while (current?.inputStage) current = current.inputStage;
      return current?.stage;
    };

    // MongoDB 8 answers a single-equality lookup with EXPRESS_IXSCAN, a
    // specialised fast path for exactly this query shape. It is still an index
    // scan — which is the whole point of the assertion — so both stage names
    // count. Pinning the older name made this fail on a server upgrade while
    // the code was doing precisely the right thing.
    const INDEX_SCAN_STAGES = new Set(["IXSCAN", "EXPRESS_IXSCAN"]);
    ok(
      "the refund-webhook lookup resolves by INDEX SCAN, not a collection scan",
      !serialised.includes("COLLSCAN") &&
        INDEX_SCAN_STAGES.has(stageOf(plan.queryPlanner.winningPlan)),
      `${stageOf(plan.queryPlanner.winningPlan)} — ${serialised.slice(0, 160)}`,
    );
    ok(
      "using the providerRefundId index specifically",
      serialised.includes("refunds.providerRefundId_1"),
      serialised.slice(0, 200),
    );
    // An EXPRESS_IXSCAN plan reports keyPattern and indexName but omits
    // isMultiKey, so this can only be checked when the planner volunteers it.
    // Where it is silent, the lookups above already prove the index resolves a
    // value stored inside the refunds array, which is what multikey buys.
    ok(
      "and it is multikey wherever the planner reports it, as an array-subdocument index must be",
      !serialised.includes('"isMultiKey"') || serialised.includes('"isMultiKey":true'),
      serialised.slice(0, 200),
    );
    ok(
      "a miss examines ZERO documents — no scan cost at any collection size",
      plan.executionStats.totalDocsExamined === 0,
      String(plan.executionStats.totalDocsExamined),
    );
  }

  {
    // The whole reason the field must be ABSENT rather than "": sparse skips only
    // missing fields, so two stored ""s would collide and break the refund path.
    resetGateway();
    const a = await makeOrder();
    const b = await makeOrder();
    await claimRefundSlot({
      orderId: a._id,
      idempotencyKey: `adm-${MARKER}-empty-a`,
      amount: 10,
      record: { paymentProvider: "razorpay", providerRefundId: "", status: "created" },
    });
    let secondEmptyFailed = false;
    try {
      await claimRefundSlot({
        orderId: b._id,
        idempotencyKey: `adm-${MARKER}-empty-b`,
        amount: 10,
        record: { paymentProvider: "razorpay", providerRefundId: "", status: "created" },
      });
    } catch (error) {
      secondEmptyFailed = true;
      ok("second empty providerRefundId did not E11000", false, error.message);
    }
    if (!secondEmptyFailed) {
      ok("two un-issued refunds on different orders do not collide", true);
    }
    const freshA = await OrderModel.findById(a._id);
    ok(
      'an un-issued refund stores NO providerRefundId (not "")',
      freshA.refunds.at(-1).providerRefundId === undefined,
      `stored ${JSON.stringify(freshA.refunds.at(-1).providerRefundId)}`,
    );
  }

  {
    // Two orders must never claim one gateway refund id.
    const a = await makeOrder();
    const b = await makeOrder();
    await OrderModel.updateOne(
      { _id: a._id },
      { $push: { refunds: { amount: 5, status: "processed", providerRefundId: `rfnd_${MARKER}_shared` } } },
    );
    let blocked = false;
    try {
      await OrderModel.updateOne(
        { _id: b._id },
        { $push: { refunds: { amount: 5, status: "processed", providerRefundId: `rfnd_${MARKER}_shared` } } },
      );
    } catch (error) {
      blocked = error?.code === 11000;
    }
    ok("the same gateway refund id cannot land on two orders", blocked, "duplicate was accepted");
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("F2 — TTL relationship");

  {
    ok(
      "the intent is retained LONGER than the abandoned-order sweep",
      PAYMENT_INTENT_RETENTION_MS > AWAITING_PAYMENT_TTL_MS,
      `intent ${PAYMENT_INTENT_RETENTION_MS}ms vs sweep ${AWAITING_PAYMENT_TTL_MS}ms`,
    );
    ok(
      "retention is at least a day, so a late capture stays identifiable",
      PAYMENT_INTENT_RETENTION_MS >= 24 * 60 * 60 * 1000,
      `${PAYMENT_INTENT_RETENTION_MS}ms`,
    );
  }

  section("F2 — classifying a capture failure");

  {
    ok(
      "a 409 (order no longer promotable) is unrecoverable → compensate",
      isUnrecoverableCapture({ statusCode: 409 }),
    );
    ok("a 404 (intent gone) is unrecoverable → compensate", isUnrecoverableCapture({ statusCode: 404 }));
    ok(
      "a transient error is NOT unrecoverable → must retry, never auto-refund",
      !isUnrecoverableCapture({ statusCode: 500 }) && !isUnrecoverableCapture(new Error("boom")),
    );
  }

  section("F2 — captured payment with no completable order");

  {
    resetGateway();
    const paymentId = `pay_${MARKER}_orphan1`;
    const outcome = await refundOrphanedCapture({
      paymentId,
      amount: 120000,
      providerOrderId: `order_${MARKER}_1`,
      reason: "Order was swept to Cancelled before the capture arrived",
    });
    trash.unmatched.push(paymentId);

    ok("the capture is refunded", outcome.refunded === true, JSON.stringify(outcome.refunded));
    ok("the gateway was called once", calls.refund.length === 1, `${calls.refund.length}x`);
    ok(
      "the refund is tagged for reconciliation",
      calls.refund[0]?.options?.notes?.refundKey === paymentId,
      JSON.stringify(calls.refund[0]?.options?.notes),
    );
    ok(
      "the full captured amount is returned",
      calls.refund[0]?.options?.amount === 120000,
      String(calls.refund[0]?.options?.amount),
    );

    const record = await UnmatchedPayment.findOne({ paymentId });
    ok("an unmatched-payment record exists", Boolean(record), "missing");
    ok("it is marked refunded", record?.resolution === "refunded", record?.resolution);
    ok("it records why it could not be completed", Boolean(record?.detectedReason), "empty");
    ok("it stores the gateway refund id", Boolean(record?.refundId), "missing");
  }

  {
    // Webhook replay: the same capture delivered twice must refund once.
    resetGateway();
    const paymentId = `pay_${MARKER}_orphan_replay`;
    const first = await refundOrphanedCapture({ paymentId, amount: 50000, reason: "first" });
    const second = await refundOrphanedCapture({ paymentId, amount: 50000, reason: "replay" });
    trash.unmatched.push(paymentId);

    ok("a replayed orphaned capture refunds ONCE", calls.refund.length === 1, `${calls.refund.length}x`);
    ok("the replay reports already-handled", second.alreadyHandled === true, JSON.stringify(second));
    ok("the first actually refunded", first.refunded === true, JSON.stringify(first.refunded));
    ok(
      "only one record exists for the payment",
      (await UnmatchedPayment.countDocuments({ paymentId })) === 1,
    );
  }

  {
    // Concurrent deliveries of the same capture.
    resetGateway();
    const paymentId = `pay_${MARKER}_orphan_concurrent`;
    await Promise.all([
      refundOrphanedCapture({ paymentId, amount: 30000, reason: "a" }),
      refundOrphanedCapture({ paymentId, amount: 30000, reason: "b" }),
      refundOrphanedCapture({ paymentId, amount: 30000, reason: "c" }),
    ]);
    trash.unmatched.push(paymentId);
    ok(
      "three concurrent deliveries refund ONCE",
      calls.refund.length === 1,
      `${calls.refund.length}x`,
    );
    ok(
      "the unique index kept it to one record",
      (await UnmatchedPayment.countDocuments({ paymentId })) === 1,
    );
  }

  section("F2 — refund failure is visible, not swallowed");

  {
    resetGateway();
    refundBehaviour = () => {
      throw new Error("refund rejected by gateway");
    };
    const paymentId = `pay_${MARKER}_orphan_failed`;
    const outcome = await refundOrphanedCapture({ paymentId, amount: 45000, reason: "sweep" });
    trash.unmatched.push(paymentId);

    ok("a failed refund is reported as not refunded", outcome.refunded === false);
    const record = await UnmatchedPayment.findOne({ paymentId });
    ok("the record is marked failed", record?.resolution === "failed", record?.resolution);
    ok("the gateway's reason is stored", Boolean(record?.failureReason), "empty");
    ok(
      "it counts as outstanding for the admin health panel",
      (await countUnresolvedOrphanedCaptures()) > 0,
    );
  }

  {
    // A retry after a failure must reconcile before trying again, and must refuse
    // to retry blindly when the gateway cannot be reached.
    resetGateway();
    const paymentId = `pay_${MARKER}_orphan_unconfirmed`;
    refundBehaviour = () => {
      throw new Error("timeout");
    };
    await refundOrphanedCapture({ paymentId, amount: 20000, reason: "first attempt" });
    trash.unmatched.push(paymentId);

    resetGateway();
    fetchShouldThrow = true;
    const retry = await refundOrphanedCapture({ paymentId, amount: 20000, reason: "retry" });
    ok(
      "an unreachable gateway does NOT trigger a blind second refund",
      calls.refund.length === 0 && retry.unconfirmed === true,
      `${calls.refund.length} calls, ${JSON.stringify(retry.unconfirmed)}`,
    );

    // Now the gateway is reachable and reports the earlier refund did land.
    resetGateway();
    gatewayRefundsOnRecord = [
      { id: `rfnd_${MARKER}_orphan_adopted`, status: "processed", notes: { refundKey: paymentId } },
    ];
    const reconciled = await refundOrphanedCapture({ paymentId, amount: 20000, reason: "retry 2" });
    ok(
      "the earlier refund is adopted rather than repeated",
      calls.refund.length === 0 && reconciled.alreadyHandled === true,
      `${calls.refund.length} calls, ${JSON.stringify(reconciled.alreadyHandled)}`,
    );
    const record = await UnmatchedPayment.findOne({ paymentId });
    ok("the record settles to refunded", record?.resolution === "refunded", record?.resolution);
  }

  section("F2 — the abandoned-order state that triggers it");

  {
    // Reproduces the precondition: the sweeper's Failed/Cancelled state is exactly
    // what the promotion compare-and-swap can no longer match.
    const order = await makeOrder({
      paymentStatus: "Pending",
      orderStatus: "Pending",
      paymentExpiresAt: new Date(Date.now() - 60_000),
      razorpayPaymentId: undefined,
    });
    const { cancelAbandonedCheckouts } = await import(
      "../src/modules/inventory/stock-reservation-cleanup.service.js"
    );
    await cancelAbandonedCheckouts({ limit: 50 });

    const swept = await OrderModel.findById(order._id);
    ok("the sweeper closes the unpaid order", swept.orderStatus === "Cancelled", swept.orderStatus);
    ok("and marks the payment Failed", swept.paymentStatus === "Failed", swept.paymentStatus);

    // The promotion CAS requires paymentStatus:"Pending" — prove it cannot match.
    const promoted = await OrderModel.findOneAndUpdate(
      { _id: order._id, paymentStatus: "Pending" },
      { $set: { paymentStatus: "Paid", orderStatus: "Confirmed" } },
      { returnDocument: "after" },
    );
    ok(
      "a later capture can no longer promote it — hence the need to compensate",
      promoted === null,
      "the CAS unexpectedly matched",
    );
    const after = await OrderModel.findById(order._id);
    ok(
      "and the order is NOT resurrected",
      after.orderStatus === "Cancelled" && after.paymentStatus === "Failed",
      `${after.orderStatus}/${after.paymentStatus}`,
    );
  }
  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 1.5 — cancellation refund reconciliation
  //
  // Exercises settleGatewayRefund against a ledger row, which is what both
  // cancellation paths now call. The cancellation bookkeeping itself
  // (eligibility, stock, wallet, coupon) is covered by the lifecycle suite and is
  // deliberately not re-tested here.
  section("1.5 — cancellation refund keys");

  {
    const orderId = new mongoose.Types.ObjectId();
    const cancellationId = new mongoose.Types.ObjectId();
    ok(
      "a full cancellation keys on the order",
      cancellationRefundKey({ orderId }) === `cancel:${orderId}`,
      cancellationRefundKey({ orderId }),
    );
    ok(
      "a partial cancellation keys on the cancellation, not the order",
      cancellationRefundKey({ orderId, cancellationId }) === `partial-cancel:${cancellationId}`,
      cancellationRefundKey({ orderId, cancellationId }),
    );
    ok(
      "two partial cancellations on one order get DIFFERENT keys",
      cancellationRefundKey({ orderId, cancellationId: new mongoose.Types.ObjectId() }) !==
        cancellationRefundKey({ orderId, cancellationId }),
    );
  }

  /** Pushes an unsettled cancellation refund row the way the cancel paths do. */
  const seedCancellationRefund = async ({ order, amount, refundKey, reason = "Order cancelled" }) => {
    const updated = await OrderModel.findOneAndUpdate(
      { _id: order._id },
      {
        $set: { paymentStatus: "Refund Pending" },
        $push: {
          refunds: {
            paymentProvider: "razorpay",
            providerPaymentId: order.razorpayPaymentId,
            amount,
            reason,
            status: "created",
            idempotencyKey: refundKey,
          },
        },
      },
      { returnDocument: "after" },
    );
    return updated.refunds.find((entry) => entry.idempotencyKey === refundKey);
  };

  section("1.5 — normal cancellation refund");

  {
    resetGateway();
    const order = await makeOrder();
    const refundKey = cancellationRefundKey({ orderId: order._id });
    const row = await seedCancellationRefund({ order, amount: 1000, refundKey });

    const result = await settleGatewayRefund({
      order,
      refundId: row._id,
      amount: 1000,
      refundKey,
      reason: `Cancelled order ${order._id}`,
    });

    ok("the refund is issued", result.outcome === "refunded", result.outcome);
    ok("the gateway was called once", calls.refund.length === 1, `${calls.refund.length}x`);
    ok(
      "the gateway call carries notes.refundKey",
      calls.refund[0]?.options?.notes?.refundKey === refundKey,
      JSON.stringify(calls.refund[0]?.options?.notes),
    );

    const fresh = await OrderModel.findById(order._id);
    const settled = fresh.refunds.id(row._id);
    ok("the row records the gateway refund id", Boolean(settled.providerRefundId), "missing");
    ok("the row is processed", settled.status === "processed", settled.status);
    ok("paymentStatus is DERIVED, not asserted", fresh.paymentStatus === "Refunded", fresh.paymentStatus);
  }

  section("1.5 — partial cancellation refund");

  {
    resetGateway();
    const order = await makeOrder();
    const firstKey = cancellationRefundKey({
      orderId: order._id,
      cancellationId: new mongoose.Types.ObjectId(),
    });
    const secondKey = cancellationRefundKey({
      orderId: order._id,
      cancellationId: new mongoose.Types.ObjectId(),
    });

    const firstRow = await seedCancellationRefund({ order, amount: 400, refundKey: firstKey });
    await settleGatewayRefund({
      order,
      refundId: firstRow._id,
      amount: 400,
      refundKey: firstKey,
      reason: "Partial cancellation",
    });

    const afterFirst = await OrderModel.findById(order._id);
    ok(
      "a partial refund leaves the order Partially Refunded",
      afterFirst.paymentStatus === "Partially Refunded",
      afterFirst.paymentStatus,
    );

    // A SECOND, genuinely separate partial cancellation must still refund.
    const secondRow = await seedCancellationRefund({
      order: afterFirst,
      amount: 300,
      refundKey: secondKey,
    });
    const second = await settleGatewayRefund({
      order: afterFirst,
      refundId: secondRow._id,
      amount: 300,
      refundKey: secondKey,
      reason: "Partial cancellation",
    });
    ok("a second distinct partial cancellation refunds", second.outcome === "refunded", second.outcome);
    ok("two separate gateway calls, as intended", calls.refund.length === 2, `${calls.refund.length}x`);

    const afterSecond = await OrderModel.findById(order._id);
    ok(
      "cumulative settled is 700 of 1000",
      Math.abs(sumSettledRefunds(afterSecond) - 700) < 0.01,
      `settled ${sumSettledRefunds(afterSecond)}`,
    );
  }

  section("1.5 — concurrent cancellation refund attempts");

  {
    resetGateway();
    const order = await makeOrder();
    const refundKey = cancellationRefundKey({ orderId: order._id });
    const row = await seedCancellationRefund({ order, amount: 1000, refundKey });

    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        settleGatewayRefund({
          order,
          refundId: row._id,
          amount: 1000,
          refundKey,
          reason: "Cancelled",
        }),
      ),
    );

    ok(
      "four concurrent settlements call the gateway exactly ONCE",
      calls.refund.length === 1,
      `${calls.refund.length}x`,
    );
    ok(
      "exactly one refunds; the rest are refused as in-progress",
      results.filter((r) => r.outcome === "refunded").length === 1,
      results.map((r) => r.outcome).join(","),
    );
    const fresh = await OrderModel.findById(order._id);
    ok(
      "never over-refunded",
      sumRefunded(fresh) <= fresh.totalAmount + 0.01,
      `refunded ${sumRefunded(fresh)}`,
    );
  }

  section("1.5 — gateway timeout, retry, and reconciliation");

  {
    resetGateway();
    const order = await makeOrder();
    const refundKey = cancellationRefundKey({ orderId: order._id });
    const row = await seedCancellationRefund({ order, amount: 1000, refundKey });

    refundBehaviour = () => {
      throw new Error("socket hang up");
    };
    const first = await settleGatewayRefund({
      order,
      refundId: row._id,
      amount: 1000,
      refundKey,
      reason: "Cancelled",
    });
    ok("a timeout reports gateway_failed", first.outcome === "gateway_failed", first.outcome);

    const afterTimeout = await OrderModel.findById(order._id);
    const pending = afterTimeout.refunds.id(row._id);
    ok(
      "the row stays `created`, NOT `failed` — this was the double-refund bug",
      pending.status === "created",
      pending.status,
    );
    ok("the failure reason is recorded", Boolean(pending.failureReason), "empty");
    ok(
      "the unsettled row still holds the ceiling down",
      Math.abs(sumRefunded(afterTimeout) - 1000) < 0.01,
      `committed ${sumRefunded(afterTimeout)}`,
    );
    ok(
      "and the order does NOT claim to be Refunded",
      afterTimeout.paymentStatus === "Refund Pending",
      afterTimeout.paymentStatus,
    );

    // The refund HAD landed at Razorpay. The retry must find it by refundKey.
    resetGateway();
    gatewayRefundsOnRecord = [
      { id: `rfnd_${MARKER}_cancel_recovered`, status: "processed", notes: { refundKey } },
    ];
    const retry = await settleGatewayRefund({
      order: afterTimeout,
      refundId: row._id,
      amount: 1000,
      refundKey,
      reason: "Cancelled",
    });
    ok("the retry reconciles", retry.outcome === "reconciled", retry.outcome);
    ok("and issues NO second refund", calls.refund.length === 0, `${calls.refund.length}x`);

    const reconciled = await OrderModel.findById(order._id);
    ok(
      "the adopted gateway id is stored",
      reconciled.refunds.id(row._id).providerRefundId === `rfnd_${MARKER}_cancel_recovered`,
      reconciled.refunds.id(row._id).providerRefundId,
    );
    ok("the order settles to Refunded", reconciled.paymentStatus === "Refunded", reconciled.paymentStatus);
  }

  {
    // Success at the gateway but the response never arrived, and Razorpay is then
    // unreachable during reconciliation: must NOT refund again.
    resetGateway();
    const order = await makeOrder();
    const refundKey = cancellationRefundKey({ orderId: order._id });
    const row = await seedCancellationRefund({ order, amount: 1000, refundKey });

    refundBehaviour = () => {
      throw new Error("ETIMEDOUT");
    };
    await settleGatewayRefund({ order, refundId: row._id, amount: 1000, refundKey, reason: "c" });

    resetGateway();
    fetchShouldThrow = true;
    const blocked = await settleGatewayRefund({
      order,
      refundId: row._id,
      amount: 1000,
      refundKey,
      reason: "c",
    });
    ok("an unreachable gateway blocks the retry", blocked.outcome === "unconfirmed", blocked.outcome);
    ok("no blind second refund", calls.refund.length === 0, `${calls.refund.length}x`);

    // Reachable, and confirms no refund exists → refunding now is safe.
    resetGateway();
    gatewayRefundsOnRecord = [];
    const proceeded = await settleGatewayRefund({
      order,
      refundId: row._id,
      amount: 1000,
      refundKey,
      reason: "c",
    });
    ok(
      "confirmed-absent allows exactly one real refund",
      proceeded.outcome === "refunded" && calls.refund.length === 1,
      `${proceeded.outcome}, ${calls.refund.length}x`,
    );
  }

  section("1.5 — repeated request on an already-settled refund");

  {
    resetGateway();
    const order = await makeOrder();
    const refundKey = cancellationRefundKey({ orderId: order._id });
    const row = await seedCancellationRefund({ order, amount: 1000, refundKey });
    await settleGatewayRefund({ order, refundId: row._id, amount: 1000, refundKey, reason: "c" });

    const again = await settleGatewayRefund({
      order,
      refundId: row._id,
      amount: 1000,
      refundKey,
      reason: "c",
    });
    ok("a settled refund is not re-sent", calls.refund.length === 1, `${calls.refund.length}x`);
    ok("and reports already-settled", again.alreadySettled === true, JSON.stringify(again));
  }

  section("1.5 — ceiling interaction with the admin refund path");

  {
    // The scenario the old `status:"failed"` caused: a cancellation refund times
    // out, then an operator uses the admin endpoint. The unsettled row must keep
    // holding the ceiling so the admin path cannot re-refund the same money.
    resetGateway();
    const order = await makeOrder();
    const refundKey = cancellationRefundKey({ orderId: order._id });
    const row = await seedCancellationRefund({ order, amount: 1000, refundKey });
    refundBehaviour = () => {
      throw new Error("socket hang up");
    };
    await settleGatewayRefund({ order, refundId: row._id, amount: 1000, refundKey, reason: "c" });

    resetGateway();
    const adminAttempt = await attemptRefund({
      order,
      amount: 1000,
      idempotencyKey: `adm-${MARKER}-after-cancel-timeout`,
    });
    ok(
      "the admin path is refused by the ceiling, not allowed to double-refund",
      adminAttempt.outcome === "rejected" && adminAttempt.code === "REFUND_EXCEEDS_ORDER_TOTAL",
      `${adminAttempt.outcome} / ${adminAttempt.code}`,
    );
    ok("no gateway call from the admin path", calls.refund.length === 0, `${calls.refund.length}x`);
  }

  section("1.5 — COD cancellation is untouched");

  {
    resetGateway();
    const cod = await makeOrder({
      paymentMethod: "COD",
      paymentStatus: "Pending",
      razorpayPaymentId: undefined,
    });
    ok("a COD order is not auto-refundable", canAutoRefund(cod) === false);

    // The invariant the cancel paths rely on: nothing is owed to someone who
    // never paid, so no ledger row and no gateway call.
    const owed = await recordRefundObligation({
      order: cod,
      amount: 1000,
      reason: "COD cancelled before delivery",
      dedupeKey: `cod-cancel:${cod._id}`,
    });
    ok("no refund obligation is recorded for unpaid COD", owed.created === false, JSON.stringify(owed));
    ok("flagged as no-money-collected", owed.noMoneyCollected === true, JSON.stringify(owed));
    ok("the gateway was never called", calls.refund.length === 0, `${calls.refund.length}x`);

    const fresh = await OrderModel.findById(cod._id);
    ok("the COD order keeps paymentStatus Pending", fresh.paymentStatus === "Pending", fresh.paymentStatus);
    ok("and has no refund rows", (fresh.refunds || []).length === 0, `${fresh.refunds.length} rows`);
  }
} catch (error) {
  // Without this the process.exit() below swallows the stack and the suite looks
  // like it merely stopped early.
  console.error(`\nSUITE ABORTED: ${error?.stack || error}`);
  ok("suite ran to completion", false, error?.message);
} finally {
  await OrderModel.deleteMany({ _id: { $in: trash.orders } });
  await PaymentIntent.deleteMany({ _id: { $in: trash.intents } });
  await UnmatchedPayment.deleteMany({ paymentId: { $in: trash.unmatched } });
  const { failed } = finish();
  await mongoose.disconnect();
  process.exit(failed ? 1 : 0);
}
