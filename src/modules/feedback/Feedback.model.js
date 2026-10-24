import mongoose from "mongoose";

/**
 * Suggestions and feedback about the store itself — the site, the range, the
 * experience — as distinct from a ContactMessage, which is a support request that
 * expects a reply about the customer's own order or question.
 *
 * Login-required, so `user` is always set and cannot be claimed from the request
 * body. `userEmail` is a snapshot for the admin list, taken at submission.
 */
export const FEEDBACK_CATEGORIES = ["suggestion", "feedback", "bug", "compliment", "other"];

// new → in_review → planned/resolved/dismissed. Not a strict state machine: an
// admin may reopen or re-file a submission, and nothing hangs off the transition.
export const FEEDBACK_STATUSES = ["new", "in_review", "planned", "resolved", "dismissed"];

const feedbackSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "UserAuthenticationModel",
      required: true,
      index: true,
    },
    userEmail: {
      type: String,
      trim: true,
      lowercase: true,
      default: "",
    },
    category: {
      type: String,
      enum: FEEDBACK_CATEGORIES,
      default: "feedback",
      index: true,
    },
    // Optional 1–5 overall rating; null when the customer did not give one.
    rating: {
      type: Number,
      min: 1,
      max: 5,
      default: null,
    },
    subject: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
    },
    message: {
      type: String,
      required: true,
      trim: true,
      minlength: 5,
      maxlength: 3000,
    },
    status: {
      type: String,
      enum: FEEDBACK_STATUSES,
      default: "new",
      index: true,
    },
    // Shown to the customer on their feedback list.
    adminResponse: {
      message: { type: String, trim: true, maxlength: 2000, default: "" },
      respondedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "UserAuthenticationModel",
        default: null,
      },
      respondedAt: { type: Date, default: null },
    },
    // Admin-only. Never returned by the customer endpoint.
    internalNote: {
      type: String,
      trim: true,
      maxlength: 2000,
      default: "",
    },
    reviewedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "UserAuthenticationModel",
      default: null,
    },
    reviewedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true },
);

feedbackSchema.index({ createdAt: -1 });
feedbackSchema.index({ status: 1, createdAt: -1 });

export default mongoose.model("Feedback", feedbackSchema);
