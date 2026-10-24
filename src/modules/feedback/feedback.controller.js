import Feedback, { FEEDBACK_CATEGORIES, FEEDBACK_STATUSES } from "./Feedback.model.js";
import UserModel from "../../model/User.model.js";
import { createAuditLog } from "../audit/audit-log.js";

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// `includeInternal` is false for the customer's own list: the internal note is the
// store talking to itself and must never reach the person it may be about.
const formatFeedback = (doc, { includeInternal = false } = {}) => ({
  id: doc._id,
  userId: doc.user?._id || doc.user || "",
  userEmail: doc.userEmail || doc.user?.email || "",
  category: doc.category,
  rating: doc.rating ?? null,
  subject: doc.subject,
  message: doc.message,
  status: doc.status,
  adminResponse: doc.adminResponse?.message
    ? {
        message: doc.adminResponse.message,
        respondedAt: doc.adminResponse.respondedAt,
        ...(includeInternal
          ? { respondedBy: doc.adminResponse.respondedBy?.email || doc.adminResponse.respondedBy || "" }
          : {}),
      }
    : null,
  ...(includeInternal
    ? {
        internalNote: doc.internalNote || "",
        reviewedBy: doc.reviewedBy?.email || doc.reviewedBy || "",
        reviewedAt: doc.reviewedAt,
      }
    : {}),
  createdAt: doc.createdAt,
  updatedAt: doc.updatedAt,
});

export const CreateFeedback = async (req, res) => {
  try {
    const account = await UserModel.findById(req.user.id).select("email").lean();
    const feedback = await Feedback.create({
      user: req.user.id,
      userEmail: account?.email || "",
      category: req.body.category,
      rating: req.body.rating ?? null,
      subject: req.body.subject,
      message: req.body.message,
    });

    return res.status(201).json({
      success: true,
      message: "Thank you — your feedback has been sent.",
      feedback: formatFeedback(feedback.toObject()),
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const GetMyFeedback = async (req, res) => {
  try {
    const items = await Feedback.find({ user: req.user.id })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();
    return res.status(200).json({
      success: true,
      feedback: items.map((item) => formatFeedback(item)),
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const GetAdminFeedback = async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 12));
    const status = String(req.query.status || "").trim();
    const category = String(req.query.category || "").trim();
    const search = String(req.query.search || "").trim();
    const filter = {};

    if (FEEDBACK_STATUSES.includes(status)) filter.status = status;
    if (FEEDBACK_CATEGORIES.includes(category)) filter.category = category;
    if (search) {
      const pattern = { $regex: escapeRegex(search), $options: "i" };
      filter.$or = [{ subject: pattern }, { message: pattern }, { userEmail: pattern }];
    }

    const [total, statusCounts, items] = await Promise.all([
      Feedback.countDocuments(filter),
      Feedback.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]),
      Feedback.find(filter)
        .populate("user", "email")
        .populate("reviewedBy", "email")
        .populate("adminResponse.respondedBy", "email")
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
    ]);

    const counts = Object.fromEntries(FEEDBACK_STATUSES.map((value) => [value, 0]));
    for (const row of statusCounts) counts[row._id] = row.count;

    return res.status(200).json({
      success: true,
      total,
      page,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      counts,
      feedback: items.map((item) => formatFeedback(item, { includeInternal: true })),
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const UpdateFeedback = async (req, res) => {
  try {
    const { status, adminResponse, internalNote } = req.body;
    const now = new Date();
    const set = { reviewedBy: req.user.id, reviewedAt: now };
    if (status !== undefined) set.status = status;
    if (internalNote !== undefined) set.internalNote = internalNote;
    if (adminResponse !== undefined) {
      set["adminResponse.message"] = adminResponse;
      set["adminResponse.respondedBy"] = adminResponse ? req.user.id : null;
      set["adminResponse.respondedAt"] = adminResponse ? now : null;
    }

    const before = await Feedback.findById(req.params.feedbackId).select("status").lean();
    if (!before) {
      return res.status(404).json({ success: false, message: "Feedback not found." });
    }
    // Opening a "new" item to respond to it means it is being looked at.
    if (status === undefined && before.status === "new") set.status = "in_review";

    const updated = await Feedback.findByIdAndUpdate(
      req.params.feedbackId,
      { $set: set },
      { returnDocument: "after", runValidators: true },
    )
      .populate("user", "email")
      .populate("reviewedBy", "email")
      .populate("adminResponse.respondedBy", "email")
      .lean();

    if (!updated) {
      return res.status(404).json({ success: false, message: "Feedback not found." });
    }

    if (updated.status !== before.status) {
      await createAuditLog({
        admin: req.user.id,
        action: "UPDATE_FEEDBACK_STATUS",
        module: "FEEDBACK",
        targetId: updated._id,
        targetName: updated.subject,
        description: `Feedback status changed from ${before.status} to ${updated.status}`,
        req,
      }).catch(() => null);
    }

    return res.status(200).json({
      success: true,
      message: "Feedback updated.",
      feedback: formatFeedback(updated, { includeInternal: true }),
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const DeleteFeedback = async (req, res) => {
  try {
    const removed = await Feedback.findByIdAndDelete(req.params.feedbackId).lean();
    if (!removed) {
      return res.status(404).json({ success: false, message: "Feedback not found." });
    }
    await createAuditLog({
      admin: req.user.id,
      action: "DELETE_FEEDBACK",
      module: "FEEDBACK",
      targetId: removed._id,
      targetName: removed.subject,
      description: `Deleted feedback "${removed.subject}" from ${removed.userEmail || "a customer"}`,
      req,
    }).catch(() => null);
    return res.status(200).json({ success: true, message: "Feedback deleted.", id: removed._id });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};
