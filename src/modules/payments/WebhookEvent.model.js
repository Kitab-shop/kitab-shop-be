import mongoose from "mongoose";

/**
 * One row per webhook event we have accepted, so a replayed delivery is a no-op.
 *
 * Gateways retry webhooks by design and do not guarantee ordering, and this
 * codebase previously stored nothing at all — no event id, no idempotency key.
 * That is what allowed a replayed `payment.failed` to reopen a completed payment
 * intent and, via retry, produce a second order and a second charge.
 *
 * The unique index is the actual guard: two concurrent deliveries of the same
 * event race to insert, exactly one wins, and the loser gets E11000 and stops.
 * An application-level "have I seen this?" check could not do that.
 */
const webhookEventSchema = new mongoose.Schema(
  {
    // Only "razorpay" is written today. "shiprocket" is reserved and unused:
    // Shiprocket sends no event id, and genuine repeats (OFD → NDR → OFD on a
    // re-attempt) carry identical payloads and must all apply, so courier events are
    // not deduplicated here. Courier-time ordering (shiprocket.lastEventAt) plus
    // idempotent side effects in courier-event.service.js cover replays instead.
    provider: {
      type: String,
      required: true,
      enum: ["razorpay", "shiprocket"],
    },
    // Gateway-supplied event id (Razorpay: the x-razorpay-event-id header).
    eventId: {
      type: String,
      required: true,
    },
    eventType: {
      type: String,
      default: "",
    },
    // Kept for a short window only — enough to debug a failed delivery without
    // retaining payment payloads indefinitely.
    processedAt: {
      type: Date,
      default: Date.now,
      expires: 60 * 60 * 24 * 30,
    },
  },
  { timestamps: true },
);

webhookEventSchema.index({ provider: 1, eventId: 1 }, { unique: true });

export default mongoose.model("WebhookEvent", webhookEventSchema);
