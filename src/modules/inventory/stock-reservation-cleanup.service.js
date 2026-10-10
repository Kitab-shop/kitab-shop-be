import StockReservation from "../../model/StockReservation.model.js";
import OrderModel from "../orders/Order.model.js";
import { incrementStock, resolveVariantId } from "./variant.service.js";
import { logLifecycleEvent, logLifecycleError } from "../../utils/lifecycle-logger.service.js";

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
 * No stock or money is touched here on purpose: an unpaid order never held either.
 * Reserved stock is released by the reservation sweeper above, keyed on its own
 * expiry, so the two never both act on the same units.
 *
 * The status filter makes it a claim, so a concurrent payment that completes at the
 * same moment wins and its order is never cancelled out from under it.
 */
export const cancelAbandonedCheckouts = async ({ limit = 200 } = {}) => {
  const now = new Date();
  let cancelled = 0;

  while (cancelled < limit) {
    const order = await OrderModel.findOneAndUpdate(
      {
        paymentMethod: "RAZORPAY",
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
