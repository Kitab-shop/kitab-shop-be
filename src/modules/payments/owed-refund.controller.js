/**
 * The queue of refunds the store has admitted it owes and has not yet paid.
 *
 * `status: "owed"` is an entry in the existing refund ledger, written by
 * recordRefundObligation when money is due but must not be moved automatically —
 * an RTO detected from a courier feed being the main case. That was the right
 * decision (an unattended feed must not push irreversible refunds) but it left the
 * liability with no reader anywhere: correctly recorded, and invisible.
 *
 * The LIST endpoint is read-only. Settlement lives beside it in
 * AdminSettleOwedRefundManually below, but only for obligations that a gateway
 * can never pay (COD and other offline money): the operator has already moved
 * the money by hand and records the reference that proves it. Anything Razorpay
 * can refund automatically is refused here and must go through the existing
 * gateway refund endpoint — this must not become a way to mark a payable
 * gateway refund "done" without the money moving.
 *
 * Sorted oldest-first, because the age of an unpaid liability is what makes it
 * urgent — a list ordered by anything else buries the worst case.
 *
 * ── LEGACY `created` ROWS THAT WERE NEVER ATTEMPTED ──────────────────────────
 * Before cancellations wrote `owed` for refunds nothing would send, they wrote
 * `created` — the state that means "the gateway was called and the outcome is
 * unknown" — even on COD orders and with Razorpay switched off. Those rows were in
 * no queue at all: not owed, so not listed here, and keyed for a gateway that would
 * never be called. They are recognised by having no trace of an attempt
 * (NEVER_ATTEMPTED_CREATED) and are treated exactly like owed rows, both here and
 * in the manual settle. A `created` row with any trace of an attempt — an attempt
 * time, a Razorpay refund id, a failure reason — or one that belongs to a return
 * stays out: its outcome is genuinely unknown and is the reconcile endpoint's job.
 */
import OrderModel from "../orders/Order.model.js";
import UserModel from "../../model/User.model.js";
import { createAuditLog } from "../audit/audit-log.js";
import {
  canAutoRefund,
  listUnresolvedFailedRefunds,
  MANUAL_METHODS,
  recomputeRefundState,
} from "./return-refund.service.js";

// Read off the model, not written out: the user model registers an EXPLICIT
// collection name ("users") that does not match Mongoose's default pluralisation of
// "UserAuthenticationModel", so a hand-written $lookup target silently joins
// nothing and every row comes back with no customer.
const USERS_COLLECTION = UserModel.collection.name;

/**
 * Matches the dedupe key recordRtoRefundObligation writes: `RTO <orderId>`.
 *
 * Derived from the existing reason string rather than a new `isRto` column. The key
 * is already the identity of that obligation — it is what makes a replayed courier
 * event idempotent — so reading it costs nothing and adds no field that could
 * disagree with the ledger. Anchored so a customer-supplied reason merely
 * containing "RTO" cannot masquerade as one.
 */
const RTO_REASON_PATTERN = /^RTO [0-9a-f]{24}$/i;

/**
 * A `created` refund row that nothing ever sent: no gateway attempt time, no
 * Razorpay refund id, no failure reason, and no return behind it. See the module
 * comment. `null` matches a missing field as well as an explicit null.
 */
const NEVER_ATTEMPTED_CREATED = {
  status: "created",
  gatewayAttemptedAt: null,
  providerRefundId: { $exists: false },
  returnRequest: null,
  failureReason: { $in: ["", null] },
};

/**
 * How old a never-attempted `created` row must be before the queue offers it.
 * A cancellation writes its row and calls the gateway a moment later, after
 * commit; until that call claims the attempt the row looks exactly like a legacy
 * one. Ten minutes is far beyond that window, and costs a stuck row nothing.
 */
const NEVER_ATTEMPTED_GRACE_MS = 10 * 60 * 1000;

/**
 * GET /api/v1/admin/refunds/owed?page=1&limit=10
 *
 * One row per owed refund, not per order: an order can owe more than one (a partial
 * cancellation and then an RTO), and they are separate pieces of work.
 *
 * `gatewayPayable` says whether Razorpay can pay the row — the screen offers
 * "Refund via Razorpay" (POST /api/v1/order/:orderId/refunds/:refundId/reconcile)
 * when it is true and the manual payout form when it is false. Derived on the
 * SERVER from canAutoRefund, the same predicate the reconcile and manual-settle
 * endpoints enforce, so the button the operator sees cannot disagree with what
 * the endpoint behind it will accept.
 */
export const AdminGetOwedRefunds = async (req, res) => {
  try {
    const page = Math.max(Number.parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 10, 1), 100);

    // Filtered in the DATABASE, twice and deliberately. The first $match drops whole
    // orders that own no owed refund before anything is unwound; the second keeps
    // only the owed rows out of the orders that survive. Loading orders and
    // filtering in JavaScript would read the entire collection to find a handful of
    // rows.
    //
    // "Owed" here also covers the legacy never-attempted `created` rows (see the
    // module comment) once they are past the grace window. The second $match spells
    // NEVER_ATTEMPTED_CREATED out with unwound `refunds.*` paths.
    //
    // It also covers FAILED gateway rows that nothing has replaced: Razorpay said
    // the money did not move, so the row is outside every ledger sum and the debt
    // would otherwise be in no queue at all. Which failed rows qualify depends on
    // the rest of the ledger (no live retry, no re-issue), so their ids are worked
    // out first by the same predicate the retry endpoint refuses on, and the
    // listing itself still filters, sorts and pages in the database.
    const legacyCutoff = new Date(Date.now() - NEVER_ATTEMPTED_GRACE_MS);
    const failedRefundIds = (await listUnresolvedFailedRefunds()).map(({ refund }) => refund._id);
    const owedRows = [
      {
        $match: {
          refunds: {
            $elemMatch: {
              $or: [
                { status: "owed" },
                { ...NEVER_ATTEMPTED_CREATED, createdAt: { $lte: legacyCutoff } },
                { _id: { $in: failedRefundIds }, status: "failed" },
              ],
            },
          },
        },
      },
      { $unwind: "$refunds" },
      {
        $match: {
          $or: [
            { "refunds.status": "owed" },
            { "refunds._id": { $in: failedRefundIds }, "refunds.status": "failed" },
            {
              "refunds.status": "created",
              "refunds.gatewayAttemptedAt": null,
              "refunds.providerRefundId": { $exists: false },
              "refunds.returnRequest": null,
              "refunds.failureReason": { $in: ["", null] },
              "refunds.createdAt": { $lte: legacyCutoff },
            },
          ],
        },
      },
    ];

    const [rows, countResult, summaryResult] = await Promise.all([
      OrderModel.aggregate([
        ...owedRows,
        // _id breaks ties so pagination is stable when several rows share a timestamp.
        { $sort: { "refunds.createdAt": 1, _id: 1, "refunds._id": 1 } },
        { $skip: (page - 1) * limit },
        { $limit: limit },
        {
          $lookup: {
            from: USERS_COLLECTION,
            localField: "user",
            foreignField: "_id",
            as: "customer",
          },
        },
        { $unwind: { path: "$customer", preserveNullAndEmptyArrays: true } },
        {
          // An explicit allow-list, not an exclusion list. Payment identifiers
          // (razorpayPaymentId, refunds.providerPaymentId) are left out: nothing on
          // this screen acts on them, and an operator identifies the liability by
          // order. Address and item detail are left out for the same reason.
          $project: {
            _id: 0,
            refundId: "$refunds._id",
            orderId: "$_id",
            amount: "$refunds.amount",
            reason: "$refunds.reason",
            refundStatus: "$refunds.status",
            // Why Razorpay failed a `failed` row — what the operator fixes before
            // retrying it. Empty on every other row.
            failureReason: "$refunds.failureReason",
            // A gateway refund waiting on Razorpay and a COD payout waiting on a
            // human are different queues — the schema says so where this field is
            // declared. Showing it is what makes the row actionable.
            confirmationMethod: "$refunds.confirmationMethod",
            owedSince: "$refunds.createdAt",
            returnRequest: "$refunds.returnRequest",
            orderStatus: 1,
            paymentStatus: 1,
            paymentMethod: 1,
            orderTotal: "$totalAmount",
            orderPlacedAt: "$createdAt",
            // RTO context, only where it already exists on the order.
            rtoDisposition: 1,
            customerName: "$customer.name",
            customerEmail: "$customer.email",
            // Read only so canAutoRefund can be asked below, then dropped before
            // the response: a payment identifier stays off this screen.
            gatewayPaymentRef: "$razorpayPaymentId",
          },
        },
      ]),
      OrderModel.aggregate([...owedRows, { $count: "total" }]),
      // The whole outstanding liability, not just this page — a page total is
      // useless for the question an operator actually asks of this screen.
      OrderModel.aggregate([
        ...owedRows,
        { $group: { _id: null, totalAmount: { $sum: "$refunds.amount" } } },
      ]),
    ]);

    const total = countResult[0]?.total || 0;

    return res.status(200).json({
      success: true,
      data: rows.map(({ gatewayPaymentRef, ...row }) => ({
        ...row,
        // Derived on read from the existing dedupe key. No record was modified to
        // make it displayable.
        isRto: RTO_REASON_PATTERN.test(String(row.reason || "")),
        // Owed (or a never-attempted legacy `created` row), awaiting the gateway
        // (not a human payout), and on an order Razorpay can actually refund. The
        // row's reconciliation key is assigned only when the operator acts, and is
        // never exposed here.
        // A `failed` row is paid the same way — the reconcile endpoint retries it
        // as a new row — so it is gateway-payable on the same terms.
        gatewayPayable:
          ["owed", "created", "failed"].includes(row.refundStatus) &&
          (row.confirmationMethod || "gateway") === "gateway" &&
          canAutoRefund({ paymentMethod: row.paymentMethod, razorpayPaymentId: gatewayPaymentRef }),
        // Whether AdminSettleOwedRefundManually will accept this row: the same
        // predicate it enforces (USE_GATEWAY_REFUND), so the screen offers the
        // manual payout form exactly when the endpoint behind it says yes. Its
        // claim never takes a `failed` row.
        manualPayable:
          row.refundStatus !== "failed" &&
          (row.confirmationMethod === "manual" ||
            !canAutoRefund({ paymentMethod: row.paymentMethod, razorpayPaymentId: gatewayPaymentRef })),
      })),
      summary: {
        totalOwedAmount: Math.round((summaryResult[0]?.totalAmount || 0) * 100) / 100,
        count: total,
      },
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(Math.ceil(total / limit), 1),
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * POST /api/v1/admin/refunds/:orderId/:refundId/settle-manual
 * Body: { method, reference }
 *
 * Records that an owed refund has been paid out-of-band (UPI, bank transfer,
 * cash…). Mirrors the evidence rule of the returns manual-refund path: a method
 * from MANUAL_METHODS and a non-empty reference are mandatory, because the
 * reference is what makes "processed" a claim backed by proof rather than a
 * checkbox.
 *
 * The claim is a single conditional findOneAndUpdate on { refundId, status:
 * "owed" } — the same shape as claimRefundSlot — so two operators (or one
 * double-click) cannot both settle the same row: the second sees no match and
 * gets a 409, not a second "success". A legacy never-attempted `created` row
 * (NEVER_ATTEMPTED_CREATED) is accepted by the same claim; a `created` row with any
 * trace of a gateway attempt, or one belonging to a return, is not.
 */
export const AdminSettleOwedRefundManually = async (req, res) => {
  try {
    const { orderId, refundId } = req.params;
    const method = String(req.body?.method || "").toLowerCase();
    const reference = String(req.body?.reference || "").trim();

    if (!MANUAL_METHODS.includes(method) || !reference) {
      return res.status(400).json({
        success: false,
        code: "MANUAL_REFUND_DETAILS_REQUIRED",
        message: `Record how you refunded the customer (${MANUAL_METHODS.join(", ")}) and a reference number — the reference is the evidence the payout happened.`,
      });
    }

    const order = await OrderModel.findById(orderId);
    if (!order) {
      return res.status(404).json({ success: false, message: "Order not found" });
    }

    const refund = (order.refunds || []).id(refundId);
    if (!refund) {
      return res.status(404).json({ success: false, message: "Refund record not found on this order" });
    }

    // A row Razorpay can still pay must be refunded through the gateway
    // endpoint, not marked paid by hand — otherwise "settled" would stop
    // meaning "the money moved".
    if (refund.confirmationMethod !== "manual" && canAutoRefund(order)) {
      return res.status(409).json({
        success: false,
        code: "USE_GATEWAY_REFUND",
        message:
          "This refund can be paid through Razorpay automatically. Use \"Refund via Razorpay\" instead of recording a manual payout.",
      });
    }

    const claimed = await OrderModel.findOneAndUpdate(
      {
        _id: orderId,
        refunds: {
          $elemMatch: { _id: refundId, $or: [{ status: "owed" }, NEVER_ATTEMPTED_CREATED] },
        },
      },
      {
        $set: {
          "refunds.$.status": "processed",
          "refunds.$.processedAt": new Date(),
          "refunds.$.providerRefundId": reference,
          "refunds.$.confirmationMethod": "manual",
          "refunds.$.paymentProvider": "manual",
        },
      },
      { returnDocument: "after" },
    );

    if (!claimed) {
      return res.status(409).json({
        success: false,
        code: "REFUND_NOT_OWED",
        message: "This refund is no longer owed — it was settled (or changed) by someone else. Refresh the list.",
      });
    }

    // paymentStatus follows the ledger — never set directly.
    await recomputeRefundState(claimed);

    await createAuditLog({
      admin: req.user.id,
      action: "SETTLE_OWED_REFUND",
      module: "PAYMENT",
      targetId: claimed._id,
      targetName: String(claimed._id),
      description: `Manually settled owed refund of ₹${Number(refund.amount) || 0} via ${method} (ref: ${reference})`,
      req,
    });

    return res.status(200).json({
      success: true,
      message: "Refund recorded as paid",
      refund: claimed.refunds.id(refundId),
      paymentStatus: claimed.paymentStatus,
    });
  } catch (error) {
    // providerRefundId carries a unique index — the same reference cannot
    // vouch for two different refunds.
    if (error?.code === 11000) {
      return res.status(409).json({
        success: false,
        message: "That reference number is already recorded against another refund. Each payout needs its own reference.",
      });
    }
    return res.status(500).json({ success: false, message: error.message });
  }
};
