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
 */
import OrderModel from "../orders/Order.model.js";
import UserModel from "../../model/User.model.js";
import { createAuditLog } from "../audit/audit-log.js";
import { canAutoRefund, MANUAL_METHODS, recomputeRefundState } from "./return-refund.service.js";

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
 * GET /api/v1/admin/refunds/owed?page=1&limit=10
 *
 * One row per owed refund, not per order: an order can owe more than one (a partial
 * cancellation and then an RTO), and they are separate pieces of work.
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
    const owedRows = [
      { $match: { "refunds.status": "owed" } },
      { $unwind: "$refunds" },
      { $match: { "refunds.status": "owed" } },
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
      data: rows.map((row) => ({
        ...row,
        // Derived on read from the existing dedupe key. No record was modified to
        // make it displayable.
        isRto: RTO_REASON_PATTERN.test(String(row.reason || "")),
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
 * gets a 409, not a second "success".
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
          "This refund can be paid through Razorpay automatically. Use the Refund action on the order page instead of recording a manual payout.",
      });
    }

    const claimed = await OrderModel.findOneAndUpdate(
      {
        _id: orderId,
        refunds: { $elemMatch: { _id: refundId, status: "owed" } },
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
