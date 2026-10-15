/**
 * The unmatched-payment queue: list the captured payments that never became an
 * order, and record how an operator settled one by hand.
 *
 * Before this, an `unmatchedpayments` row left at `failed` (or a `pending` one whose
 * refund never completed) was visible only as a count on System Health. Nothing could
 * list the rows, and nothing could close one, so the warning stayed CRITICAL forever
 * even after the money had been dealt with from the Razorpay dashboard.
 *
 * What must hold:
 *   - the list defaults to the outstanding rows, the same set System Health counts;
 *   - resolving needs a note, writes an audit log, and drops the outstanding count;
 *   - a row whose automatic refund is in flight right now cannot be resolved under it;
 *   - a second (or concurrent) resolve is refused, never a second "success";
 *   - once resolved, refundOrphanedCapture treats the capture as handled and never
 *     calls the gateway for it again.
 *
 * Run with `node test/regression/unmatched-payment-resolve.regression.mjs`.
 *
 * The Razorpay SDK is stubbed on its cached instance and `globalThis.fetch` throws on
 * any call, so nothing leaves the machine.
 */
process.env.PAYMENTS_ENABLED = "true";
process.env.PAYMENT_PROVIDER = "razorpay";
process.env.RAZORPAY_KEY_ID = "rzp_test_stub0000000";
process.env.RAZORPAY_KEY_SECRET = "stub_secret_for_tests";
process.env.NOTIFICATIONS_ENABLED = "false";

import mongoose from "mongoose";
import { readFile } from "node:fs/promises";
import { connect, createSuite, marker } from "./helpers.mjs";

const { ok, section, finish } = createSuite("unmatched-payment-resolve");
await connect();

const UnmatchedPayment = (await import("../../src/modules/payments/UnmatchedPayment.model.js")).default;
const AuditLog = (await import("../../src/modules/audit/AuditLog.model.js")).default;
const { AdminGetUnmatchedPayments, AdminResolveUnmatchedPayment } = await import(
  "../../src/modules/payments/unmatched-payment.controller.js"
);
const { refundOrphanedCapture, countUnresolvedOrphanedCaptures } = await import(
  "../../src/modules/payments/orphaned-capture.service.js"
);
const razorpayService = await import("../../src/modules/payments/razorpay.service.js");

await UnmatchedPayment.init();

// ── Razorpay stub ───────────────────────────────────────────────────────────
const gatewayCalls = { refund: 0, fetchMultipleRefund: 0 };
const { razorpay: sharedRazorpay } = razorpayService.getRazorpay();
sharedRazorpay.payments.refund = async () => {
  gatewayCalls.refund += 1;
  return { id: `rfnd_${process.pid}_${gatewayCalls.refund}`, status: "processed" };
};
sharedRazorpay.payments.fetchMultipleRefund = async () => {
  gatewayCalls.fetchMultipleRefund += 1;
  return { items: [] };
};

const originalFetch = globalThis.fetch;
globalThis.fetch = async (input) => {
  throw new Error(`Unexpected outbound call in tests: ${String(input instanceof URL ? input.href : input)}`);
};

const MARKER = marker("unmatched");
const OURS = new RegExp(`^pay_${MARKER}_`);
let seq = 0;
const adminId = new mongoose.Types.ObjectId();
const admin = { id: String(adminId), roles: ["admin"] };

const callController = async (handler, { params = {}, body = {}, query = {}, user = admin } = {}) => {
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
  await handler({ params, body, query, user, headers: {}, ip: "127.0.0.1" }, res);
  return { statusCode, body: payload };
};

const makeRow = async (fields = {}) => {
  seq += 1;
  return UnmatchedPayment.create({
    provider: "razorpay",
    paymentId: `pay_${MARKER}_${seq}`,
    providerOrderId: `order_${MARKER}_${seq}`,
    amount: 25000,
    currency: "INR",
    detectedReason: "fixture",
    resolution: "pending",
    ...fields,
  });
};

const resolve = (row, note = "Refunded from the Razorpay dashboard, rfnd_manual_1") =>
  callController(AdminResolveUnmatchedPayment, { params: { id: String(row._id) }, body: { note } });

const ourOutstanding = () =>
  UnmatchedPayment.countDocuments({ paymentId: OURS, resolution: { $in: ["pending", "failed"] } });

try {
  // ═══════════════════════════════════════════════════════════════════════════
  section("1 — the list defaults to the outstanding rows, oldest first");

  const failedRow = await makeRow({
    resolution: "failed",
    failureReason: "Razorpay rejected the refund",
    createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
  });
  const stalePending = await makeRow({
    resolution: "pending",
    lastAttemptAt: new Date(Date.now() - 10 * 60 * 1000),
    createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
  });
  const inFlight = await makeRow({ resolution: "pending", lastAttemptAt: new Date() });
  const refundedRow = await makeRow({ resolution: "refunded", refundId: `rfnd_${MARKER}_done` });

  {
    const list = await callController(AdminGetUnmatchedPayments, { query: { limit: "100" } });
    ok("the list answers 200", list.statusCode === 200, `${list.statusCode} ${list.body?.message || ""}`);
    // The collection is shared with other suites, so only our own rows are asserted on.
    // Fixtures are backdated, so ours sort ahead of anything created during the run.
    const ours = (list.body?.data || []).filter((row) => OURS.test(row.paymentId));
    const ids = ours.map((row) => String(row.id));
    ok("it includes the failed and both pending rows",
      [failedRow, stalePending, inFlight].every((row) => ids.includes(String(row._id))), JSON.stringify(ids));
    ok("it leaves out the refunded row by default", !ids.includes(String(refundedRow._id)));
    ok("oldest first",
      ids.indexOf(String(failedRow._id)) < ids.indexOf(String(stalePending._id)) &&
        ids.indexOf(String(stalePending._id)) < ids.indexOf(String(inFlight._id)),
      JSON.stringify(ids));
    const failedOut = ours.find((row) => String(row.id) === String(failedRow._id));
    ok("a row carries the amount in paise and rupees, and the failure reason",
      failedOut?.amountPaise === 25000 && failedOut?.amount === 250 &&
        failedOut?.failureReason === "Razorpay rejected the refund",
      JSON.stringify(failedOut));
    ok("an in-flight row is flagged as such",
      ours.find((row) => String(row.id) === String(inFlight._id))?.attemptInFlight === true &&
        failedOut?.attemptInFlight === false);
    ok("the summary counts the same set System Health counts",
      list.body?.summary?.count === (await countUnresolvedOrphanedCaptures()),
      `${list.body?.summary?.count} vs ${await countUnresolvedOrphanedCaptures()}`);
    ok("pagination is reported", list.body?.pagination?.limit === 100 && list.body?.pagination?.page === 1);

    const refundedOnly = await callController(AdminGetUnmatchedPayments, {
      query: { resolution: "refunded", limit: "100" },
    });
    const refundedIds = (refundedOnly.body?.data || []).map((row) => String(row.id));
    ok("?resolution=refunded lists settled rows instead",
      refundedIds.includes(String(refundedRow._id)) && !refundedIds.includes(String(failedRow._id)));

    const bad = await callController(AdminGetUnmatchedPayments, { query: { resolution: "bogus" } });
    ok("an unknown resolution → 400", bad.statusCode === 400 && bad.body?.code === "INVALID_RESOLUTION",
      `${bad.statusCode} ${bad.body?.code}`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("2 — resolving a failed row");

  {
    const noNote = await resolve(failedRow, "  ok ");
    ok("a note under 5 characters → 400 RESOLUTION_NOTE_REQUIRED",
      noNote.statusCode === 400 && noNote.body?.code === "RESOLUTION_NOTE_REQUIRED",
      `${noNote.statusCode} ${noNote.body?.code}`);
    ok("  and the row is untouched", (await UnmatchedPayment.findById(failedRow._id)).resolution === "failed");

    const before = await ourOutstanding();
    const resolved = await resolve(failedRow);
    ok("a failed row resolves (200)", resolved.statusCode === 200 && resolved.body?.data?.resolution === "resolved",
      `${resolved.statusCode} ${resolved.body?.code || ""} ${resolved.body?.message || ""}`);
    const row = await UnmatchedPayment.findById(failedRow._id);
    ok("  resolvedBy, resolvedAt and the note are recorded",
      String(row.resolvedBy) === String(adminId) && row.resolvedAt instanceof Date &&
        row.notes === "Refunded from the Razorpay dashboard, rfnd_manual_1");
    ok("  the outstanding (System Health) count drops by one", (await ourOutstanding()) === before - 1,
      `${before} → ${await ourOutstanding()}`);
    const audit = await AuditLog.findOne({ targetId: failedRow._id, action: "RESOLVE_UNMATCHED_PAYMENT" });
    ok("  an audit log is written", Boolean(audit) && String(audit.admin) === String(adminId) &&
      audit.description.includes(failedRow.paymentId), audit?.description);

    const again = await resolve(failedRow);
    ok("a second resolve → 409 ALREADY_SETTLED", again.statusCode === 409 && again.body?.code === "ALREADY_SETTLED",
      `${again.statusCode} ${again.body?.code}`);
    ok("  only one audit log",
      (await AuditLog.countDocuments({ targetId: failedRow._id, action: "RESOLVE_UNMATCHED_PAYMENT" })) === 1);

    const refunded = await resolve(refundedRow);
    ok("a row the gateway already refunded → 409 ALREADY_SETTLED",
      refunded.statusCode === 409 && refunded.body?.code === "ALREADY_SETTLED",
      `${refunded.statusCode} ${refunded.body?.code}`);
    ok("  and stays refunded", (await UnmatchedPayment.findById(refundedRow._id)).resolution === "refunded");
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("3 — a row whose automatic refund is in flight cannot be resolved under it");

  {
    const blocked = await resolve(inFlight);
    ok("→ 409 ATTEMPT_IN_PROGRESS", blocked.statusCode === 409 && blocked.body?.code === "ATTEMPT_IN_PROGRESS",
      `${blocked.statusCode} ${blocked.body?.code}`);
    ok("  the row is still pending", (await UnmatchedPayment.findById(inFlight._id)).resolution === "pending");

    const stale = await resolve(stalePending);
    ok("a pending row whose attempt went stale resolves", stale.statusCode === 200,
      `${stale.statusCode} ${stale.body?.code || ""}`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("4 — concurrent resolves: exactly one wins");

  {
    const contested = await makeRow({ resolution: "failed", failureReason: "declined" });
    const results = await Promise.all([resolve(contested), resolve(contested), resolve(contested)]);
    const wins = results.filter((r) => r.statusCode === 200).length;
    ok("one 200", wins === 1, results.map((r) => r.statusCode).join(","));
    ok("the others 409 ALREADY_SETTLED",
      results.filter((r) => r.statusCode === 409 && r.body?.code === "ALREADY_SETTLED").length === 2);
    ok("one audit log",
      (await AuditLog.countDocuments({ targetId: contested._id, action: "RESOLVE_UNMATCHED_PAYMENT" })) === 1);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("5 — a resolved capture is never refunded afterwards");

  {
    gatewayCalls.refund = 0;
    gatewayCalls.fetchMultipleRefund = 0;
    // A late webhook delivery for the capture the operator just settled by hand.
    const outcome = await refundOrphanedCapture({
      paymentId: failedRow.paymentId,
      amount: failedRow.amount,
      providerOrderId: failedRow.providerOrderId,
      reason: "late redelivery",
    });
    ok("refundOrphanedCapture reports alreadyHandled", outcome.alreadyHandled === true, JSON.stringify(outcome.alreadyHandled));
    ok("  and not refunded by this call", outcome.refunded === false);
    ok("  with no gateway call at all", gatewayCalls.refund === 0 && gatewayCalls.fetchMultipleRefund === 0,
      JSON.stringify(gatewayCalls));
    ok("  the row stays resolved", (await UnmatchedPayment.findById(failedRow._id)).resolution === "resolved");
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("6 — not-found and routing");

  {
    const missing = await callController(AdminResolveUnmatchedPayment, {
      params: { id: String(new mongoose.Types.ObjectId()) },
      body: { note: "nothing to see here" },
    });
    ok("an unknown id → 404", missing.statusCode === 404, String(missing.statusCode));
    const garbage = await callController(AdminResolveUnmatchedPayment, {
      params: { id: "not-an-id" },
      body: { note: "nothing to see here" },
    });
    ok("a malformed id → 404, not a 500", garbage.statusCode === 404, String(garbage.statusCode));

    const routes = await readFile(new URL("../../src/modules/admin/admin.routes.js", import.meta.url), "utf8");
    ok("GET /payments/unmatched is admin-only with orders:manage",
      /router\.get\("\/payments\/unmatched", isAdmin, requirePermission\(ADMIN_PERMISSIONS\.ORDERS_MANAGE\), AdminGetUnmatchedPayments\)/.test(routes));
    ok("POST /payments/unmatched/:id/resolve is admin-only with orders:manage",
      /router\.post\("\/payments\/unmatched\/:id\/resolve", isAdmin, requirePermission\(ADMIN_PERMISSIONS\.ORDERS_MANAGE\), AdminResolveUnmatchedPayment\)/.test(routes));
  }
} catch (error) {
  console.error(`\nSUITE ABORTED: ${error?.stack || error}`);
  ok("suite ran to completion", false, error?.message);
} finally {
  globalThis.fetch = originalFetch;
  const ours = await UnmatchedPayment.find({ paymentId: OURS }).select("_id").lean();
  await AuditLog.deleteMany({ targetId: { $in: ours.map((row) => row._id) } });
  await UnmatchedPayment.deleteMany({ paymentId: OURS });
  const { failed } = finish();
  await mongoose.disconnect();
  process.exit(failed ? 1 : 0);
}
