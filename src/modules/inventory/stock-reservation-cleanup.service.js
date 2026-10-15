import StockReservation from "../../model/StockReservation.model.js";
import OrderModel from "../orders/Order.model.js";
import { incrementStock, resolveVariantId } from "./variant.service.js";
import { logLifecycleEvent, logLifecycleError } from "../../utils/lifecycle-logger.service.js";
import { closeUnpaidCheckout } from "../payments/unpaid-checkout.service.js";
import { syncPendingGatewayRefunds } from "../payments/refund-sync.service.js";

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
let cleanupTimer = null;

const readIntervalMs = () => {
  const configured = Number(process.env.INVENTORY_RESERVATION_CLEANUP_INTERVAL_MS);
  if (!Number.isFinite(configured) || configured < 60_000) return DEFAULT_INTERVAL_MS;
  return configured;
};

export const cleanupExpiredStockReservations = async ({ limit = 100 } = {}) => {
  const now = new Date();
  let processed = 0;

  while (processed < limit) {
    const reservation = await StockReservation.findOneAndUpdate(
      {
        status: "active",
        expiresAt: { $lte: now },
      },
      {
        $set: {
          status: "expired",
          releasedAt: now,
          reason: "reservation_expired",
        },
      },
      {
        sort: { expiresAt: 1 },
        returnDocument: "before",
      },
    );

    if (!reservation) break;

    // Variant-aware, matching how the reservation took the stock. The status flip
    // above is already a claim (returnDocument: "before" on an `active`-only
    // filter), so two cleanup passes cannot both restock this reservation.
    for (const item of reservation.items) {
      await incrementStock({
        productId: item.product,
        quantity: item.quantity,
        variantId: await resolveVariantId(item.product, item.variantKey || ""),
      });
    }
    processed += 1;
  }

  return processed;
};

/**
 * Closes out prepaid checkouts that were never paid for.
 *
 * Order-first means an unpaid Razorpay order exists from the moment checkout
 * starts. Every read path excludes it (order-visibility.js), but "invisible
 * forever" is not the same as resolved: the customer should see it end, and the
 * data should not accumulate rows that are neither orders nor anything else.
 *
 * They are moved to Cancelled rather than deleted — a checkout that was attempted
 * is a fact worth keeping, and `Pending → Cancelled` is already a legal transition.
 *
 * No money is touched here: an unpaid order never held any. After each cancellation
 * wins, closeUnpaidCheckout expires the payment intent and releases its stock hold —
 * the same close-out the customer and admin cancel paths run. Expiring the intent is
 * what stops RetryRazorpayOrder minting a fresh Razorpay order for a checkout that is
 * already Cancelled; a "created" intent left behind used to make that possible.
 * releaseReservation's active-only claim means this and the reservation sweeper above
 * can never both restock the same units.
 *
 * The filter (`orderStatus: "Pending"` AND `paymentStatus: "Pending"`) makes it a
 * claim, so a concurrent payment that completes at the same moment wins and its order
 * is never cancelled out from under it, and an order some other path already moved on
 * is never rewritten. `cancelledBy: "system"` keeps the admin banner and the customer
 * wording from blaming the customer for a timeout.
 */
export const cancelAbandonedCheckouts = async ({ limit = 200 } = {}) => {
  const now = new Date();
  let cancelled = 0;

  while (cancelled < limit) {
    const order = await OrderModel.findOneAndUpdate(
      {
        paymentMethod: "RAZORPAY",
        orderStatus: "Pending",
        paymentStatus: "Pending",
        paymentExpiresAt: { $ne: null, $lte: now },
      },
      {
        $set: {
          orderStatus: "Cancelled",
          paymentStatus: "Failed",
          paymentExpiresAt: null,
          cancellation: {
            reason: "Other",
            details: "Payment was not completed before the checkout expired",
            cancelledAt: now,
            cancelledBy: "system",
          },
        },
        $push: {
          statusHistory: {
            from: "Pending",
            to: "Cancelled",
            changedBy: null,
            source: "abandoned_checkout_sweeper",
            changedAt: now,
          },
        },
      },
      { sort: { paymentExpiresAt: 1 }, returnDocument: "after" },
    );
    if (!order) break;
    cancelled += 1;
    // Never throws — the cancellation above is already durable.
    await closeUnpaidCheckout({ orderId: order._id, razorpayOrderId: order.razorpayOrderId });
  }

  return cancelled;
};

export const startStockReservationCleanup = () => {
  if (cleanupTimer) return cleanupTimer;
  if (process.env.INVENTORY_RESERVATION_CLEANUP_ENABLED === "false") return null;

  const runCleanup = async () => {
    try {
      const count = await cleanupExpiredStockReservations();
      if (count > 0) {
        logLifecycleEvent("inventory", "expired_reservations_released", { count });
      }
    } catch (error) {
      logLifecycleError("inventory", "reservation_cleanup_failed", error);
    }
    // Shares this timer rather than adding a second one — both sweep the same
    // abandoned-checkout event from different angles, and they must not drift apart.
    try {
      const abandoned = await cancelAbandonedCheckouts();
      if (abandoned > 0) {
        logLifecycleEvent("orders", "abandoned_checkouts_cancelled", { count: abandoned });
      }
    } catch (error) {
      logLifecycleError("orders", "abandoned_checkout_sweep_failed", error);
    }
    // Refunds Razorpay accepted but has not settled yet (`created` rows with a refund
    // id). The webhook settles them when it is delivered; this poll is the backstop for
    // a missed or unsubscribed webhook. It only reads refund state from Razorpay and
    // never issues a refund. Independent of the two sweeps above, so a failure in one
    // never skips the others.
    if (process.env.REFUND_STATUS_SYNC_ENABLED !== "false") {
      try {
        const { changed = 0, checked = 0, errors = 0 } = (await syncPendingGatewayRefunds()) || {};
        if (changed > 0) {
          logLifecycleEvent("payments", "gateway_refunds_synced", { checked, changed, errors });
        }
      } catch (error) {
        logLifecycleError("payments", "refund_sync_failed", error);
      }
    }
  };

  cleanupTimer = setInterval(runCleanup, readIntervalMs());
  cleanupTimer.unref?.();
  runCleanup();
  return cleanupTimer;
};

/**
 * Stops the sweep. Called from the shutdown handler in index.js so a SIGTERM does not
 * start a fresh cleanup pass while the Mongo connection is being closed underneath it.
 *
 * The timer is already unref'd, so this is not what lets the process exit — it is what
 * stops a half-run sweep from writing during the close.
 */
export const stopStockReservationCleanup = () => {
  if (!cleanupTimer) return;
  clearInterval(cleanupTimer);
  cleanupTimer = null;
};
