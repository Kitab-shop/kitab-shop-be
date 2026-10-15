/**
 * The queue of captured payments that could not become an order.
 *
 * `unmatchedpayments` rows are written by refundOrphanedCapture before it tries to
 * give the money back (see UnmatchedPayment.model.js). Most settle themselves as
 * `refunded`. The ones left at `pending` or `failed` are money taken with nothing
 * behind it, and until now the only reader was a count on the System Health panel:
 * an operator could see that something was wrong but had no way to list the rows
 * or record that they had dealt with one.
 *
 * The LIST endpoint is read-only. RESOLVE only records an operator's decision —
 * "I refunded this from the Razorpay dashboard", "we shipped the goods" — and never
 * moves money itself, which is why a note explaining what was done is mandatory.
 *
 * Sorted oldest-first, like the owed-refunds queue: the age of an unpaid liability
 * is what makes it urgent.
 */
import mongoose from "mongoose";
import UnmatchedPayment from "./UnmatchedPayment.model.js";
import UserModel from "../../model/User.model.js";
import { createAuditLog } from "../audit/audit-log.js";

const OUTSTANDING_RESOLUTIONS = ["pending", "failed"];
const ALL_RESOLUTIONS = ["pending", "refunded", "failed", "resolved"];

/**
 * Mirrors GATEWAY_ATTEMPT_STALE_MS in orphaned-capture.service.js. A row whose
 * gateway call started less than this long ago may still be refunding, and marking
 * it resolved underneath that call would leave two different accounts of where the
 * money went.
 */
const ATTEMPT_IN_FLIGHT_MS = 2 * 60 * 1000;

const MIN_NOTE_LENGTH = 5;

/**
 * GET /api/v1/admin/payments/unmatched?page=1&limit=10&resolution=pending,failed
 *
 * Defaults to the outstanding rows (`pending` and `failed`) — the same set the
 * System Health check counts — so the list and the warning that sends an operator
 * here always agree. `resolution` may name any of the model's values, comma-separated,
 * to look back at settled rows.
 */
export const AdminGetUnmatchedPayments = async (req, res) => {
  try {
    const page = Math.max(Number.parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 10, 1), 100);

    const requested = String(req.query.resolution || "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);
    const unknown = requested.filter((value) => !ALL_RESOLUTIONS.includes(value));
    if (unknown.length > 0) {
      return res.status(400).json({
        success: false,
        code: "INVALID_RESOLUTION",
        message: `Unknown resolution: ${unknown.join(", ")}. Use ${ALL_RESOLUTIONS.join(", ")}.`,
      });
    }
    const resolutions = requested.length > 0 ? requested : OUTSTANDING_RESOLUTIONS;
    const filter = { resolution: { $in: resolutions } };

    const [rows, total, summaryResult] = await Promise.all([
      UnmatchedPayment.find(filter)
        // _id breaks ties so pagination is stable when several rows share a timestamp.
        .sort({ createdAt: 1, _id: 1 })
        .skip((page - 1) * limit)
        .limit(limit)
        // Model passed explicitly so the join never depends on import order having
        // registered the user model first.
        .populate({ path: "user", model: UserModel, select: "name email" })
        .populate({ path: "resolvedBy", model: UserModel, select: "name email" })
        .lean(),
      UnmatchedPayment.countDocuments(filter),
      UnmatchedPayment.aggregate([
        { $match: filter },
        { $group: { _id: null, totalAmount: { $sum: "$amount" } } },
      ]),
    ]);

    const now = Date.now();
    return res.status(200).json({
      success: true,
      data: rows.map((row) => ({
        id: row._id,
        provider: row.provider,
        paymentId: row.paymentId,
        providerOrderId: row.providerOrderId,
        paymentIntent: row.paymentIntent,
        orderId: row.order,
        customerName: row.user?.name || "",
        customerEmail: row.user?.email || "",
        // Paise on the record, as the gateway reported it; rupees alongside so the
        // screen never has to guess which unit it is showing.
        amountPaise: row.amount,
        amount: Math.round(Number(row.amount || 0)) / 100,
        currency: row.currency,
        detectedReason: row.detectedReason,
        resolution: row.resolution,
        refundId: row.refundId || null,
        failureReason: row.failureReason,
        attempts: row.attempts,
        lastAttemptAt: row.lastAttemptAt,
        // Whether RESOLVE would currently be refused with ATTEMPT_IN_PROGRESS.
        attemptInFlight: Boolean(
          row.lastAttemptAt && now - new Date(row.lastAttemptAt).getTime() < ATTEMPT_IN_FLIGHT_MS,
        ),
        resolvedAt: row.resolvedAt,
        resolvedBy: row.resolvedBy?.name || row.resolvedBy?.email || null,
        notes: row.notes,
        detectedAt: row.createdAt,
      })),
      summary: {
        totalAmountPaise: summaryResult[0]?.totalAmount || 0,
        totalAmount: Math.round(Number(summaryResult[0]?.totalAmount || 0)) / 100,
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
 * POST /api/v1/admin/payments/unmatched/:id/resolve
 * Body: { note }
 *
 * Records that an operator settled an outstanding unmatched payment by hand. It
 * moves no money. The note is the evidence ("refunded from the Razorpay dashboard,
 * rfnd_…", "goods shipped on order …") and is required for that reason.
 *
 * One conditional findOneAndUpdate is the claim, so two operators (or one
 * double-click) cannot both resolve the row, and a row whose gateway refund is in
 * flight right now cannot be resolved underneath that call: refundOrphanedCapture
 * stamps `lastAttemptAt` before it calls Razorpay and clears it when the call
 * returns. Once resolved, refundOrphanedCapture treats the row as already handled,
 * so a late webhook retry for the same capture cannot refund it again.
 */
export const AdminResolveUnmatchedPayment = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(404).json({ success: false, message: "Unmatched payment not found" });
    }

    const note = String(req.body?.note || "").trim().slice(0, 1000);
    if (note.length < MIN_NOTE_LENGTH) {
      return res.status(400).json({
        success: false,
        code: "RESOLUTION_NOTE_REQUIRED",
        message:
          "Say how this payment was settled (for example the Razorpay refund id, or the order the goods were sent on). It is the only record of what happened to the money.",
      });
    }

    const now = new Date();
    const resolved = await UnmatchedPayment.findOneAndUpdate(
      {
        _id: id,
        resolution: { $in: OUTSTANDING_RESOLUTIONS },
        $or: [
          { lastAttemptAt: null },
          { lastAttemptAt: { $exists: false } },
          { lastAttemptAt: { $lte: new Date(now.getTime() - ATTEMPT_IN_FLIGHT_MS) } },
        ],
      },
      {
        $set: {
          resolution: "resolved",
          resolvedAt: now,
          resolvedBy: req.user.id,
          notes: note,
        },
      },
      { returnDocument: "after" },
    );

    if (!resolved) {
      const current = await UnmatchedPayment.findById(id).select("resolution").lean();
      if (!current) {
        return res.status(404).json({ success: false, message: "Unmatched payment not found" });
      }
      if (OUTSTANDING_RESOLUTIONS.includes(current.resolution)) {
        return res.status(409).json({
          success: false,
          code: "ATTEMPT_IN_PROGRESS",
          message:
            "An automatic refund for this payment is running right now. Wait two minutes, reload, and check whether it went through before resolving it by hand.",
        });
      }
      return res.status(409).json({
        success: false,
        code: "ALREADY_SETTLED",
        message: `This payment is already ${current.resolution}. Refresh the list.`,
        resolution: current.resolution,
      });
    }

    await createAuditLog({
      admin: req.user.id,
      action: "RESOLVE_UNMATCHED_PAYMENT",
      module: "PAYMENT",
      targetId: resolved._id,
      targetName: resolved.paymentId,
      description: `Resolved unmatched payment ${resolved.paymentId} (₹${
        Math.round(Number(resolved.amount || 0)) / 100
      }) by hand — ${note}`,
      req,
    });

    return res.status(200).json({
      success: true,
      message: "Unmatched payment marked as resolved",
      data: {
        id: resolved._id,
        paymentId: resolved.paymentId,
        resolution: resolved.resolution,
        resolvedAt: resolved.resolvedAt,
        notes: resolved.notes,
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};
