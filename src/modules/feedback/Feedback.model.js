import mongoose from "mongoose";

/**
 * Suggestions and feedback about the store itself — the site, the range, the
 * experience — as distinct from a ContactMessage, which is a support request that
 * expects a reply about the customer's own order or question.
 *
 * Open to guests as well as signed-in customers (the footer form). `user` is set
 * only from a verified login token, never from the request body; a guest's
 * optional name and email are self-reported and shown to admins as such.
 * `userEmail` is the account's address, snapshotted at submission.
 */
export const FEEDBACK_CATEGORIES = ["suggestion", "feedback", "bug", "compliment", "other"];

// Shared with the schema and the storefront form, so the three cannot disagree.
export const FEEDBACK_MESSAGE_MIN = 20;
export const FEEDBACK_MESSAGE_MAX = 3000;

// Where the form was opened from.
export const FEEDBACK_SOURCES = ["footer", "account"];

// new → in_review → planned/resolved/dismissed. Not a strict state machine: an
// admin may reopen or re-file a submission, and nothing hangs off the transition.
export const FEEDBACK_STATUSES = ["new", "in_review", "planned", "resolved", "dismissed"];

const feedbackSchema = new mongoose.Schema(
  {
    // null for a guest.
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "UserAuthenticationModel",
      default: null,
      index: true,
    },
    // A guest's self-reported contact details, both optional. Unverified.
    guestName: {
      type: String,
      trim: true,
      maxlength: 120,
      default: "",
    },
    guestEmail: {
      type: String,
      trim: true,
      lowercase: true,
      maxlength: 254,
      default: "",
    },
    source: {
      type: String,
      enum: FEEDBACK_SOURCES,
      default: "account",
    },
    // The storefront path the form was opened on, e.g. "/product/abc". A path
    // only — never a full URL — so nothing off-site is ever stored or linked.
    pagePath: {
      type: String,
      trim: true,
      maxlength: 300,
      default: "",
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
      minlength: FEEDBACK_MESSAGE_MIN,
      maxlength: FEEDBACK_MESSAGE_MAX,
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
