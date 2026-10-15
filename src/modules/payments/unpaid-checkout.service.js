import PaymentIntent from "./PaymentIntent.model.js";
import { releaseReservation } from "../inventory/inventory-reservation.service.js";
import { logLifecycleError, logLifecycleEvent } from "../../utils/lifecycle-logger.service.js";

// Shared by every path that cancels a never-paid checkout: the customer and admin
// cancellations in order.controller.js and the abandoned-checkout sweeper in
// stock-reservation-cleanup.service.js. One function, so the three cannot drift.

/**
 * Closes the payment side of a cancelled, never-paid checkout: expires its payment
 * intent and gives its stock hold back. Runs after the cancellation has committed.
 *
 * The intent is EXPIRED, not deleted and not failed. Deleting it would destroy the
 * only link from a late capture back to this customer and cart; "failed" is
 * retryable (RetryRazorpayOrder accepts it), and a retry would mint a new Razorpay
 * order for a checkout the customer has called off. An expired intent is refused by
 * both payment paths — completeCapturedIntent throws 409 "Payment session is
 * expired" — so a capture that lands anyway is recorded and refunded through
 * refundOrphanedCapture rather than promoted.
 *
 * Compare-and-swap from "created"/"failed" only. A "processing" intent has a
 * capture in flight; it is left alone, because that capture cannot win anyway — the
 * order is no longer at Pending, so its promotion compare-and-swap misses and it
 * takes the same 409 → refund path on its own.
 *
 * The reservation is released through releaseReservation, whose own active-only
 * claim means the expiry sweeper (cleanupExpiredStockReservations) and this call
 * can never both restock it. Reservation-less checkouts (reserveDuringPayment off)
 * took no stock, and releaseReservation simply finds nothing.
 *
 * Never throws: the cancellation is already durable. Anything left undone here is
 * still safe — the sweeper returns the stock when the hold expires, and the order's
 * own status refuses a late promotion.
 */
export const closeUnpaidCheckout = async ({ orderId, razorpayOrderId }) => {
  try {
    const links = [{ pendingOrder: orderId }];
    if (razorpayOrderId) {
      links.push({ razorpayOrderId }, { previousRazorpayOrderIds: razorpayOrderId });
    }
    const intents = await PaymentIntent.find({ $or: links }).select("_id status storeOrder");

    for (const intent of intents) {
      // An intent that produced a paid order is never this checkout's to close.
      if (intent.storeOrder) continue;
      const expired = await PaymentIntent.updateOne(
        { _id: intent._id, status: { $in: ["created", "failed"] }, storeOrder: null },
        {
          $set: {
            status: "expired",
            failureReason: "Order was cancelled before the payment was captured",
          },
        },
      );
      const released = await releaseReservation({
        paymentIntentId: intent._id,
        reason: "order_cancelled_unpaid",
      });
      logLifecycleEvent("orders", "unpaid_checkout_closed", {
        orderId: String(orderId),
        paymentIntentId: String(intent._id),
        intentExpired: expired.modifiedCount === 1,
        reservationReleased: Boolean(released),
      });
    }
  } catch (error) {
    logLifecycleError("orders", "unpaid_checkout_close_failed", error, {
      orderId: String(orderId),
    });
  }
};
