/**
 * Auto-complete: moves a Delivered order to Completed once nothing can still
 * happen to it.
 *
 * "Completed" is the sign-off that a delivered order's case is closed. Until
 * now only an admin could give it, so in practice orders sat at Delivered
 * forever — the bill of supply was already minted, but the customer never got
 * the "order complete" message and the admin's Delivered queue only grew.
 *
 * An order is eligible when ALL of these hold:
 *   - it is Delivered, with a recorded `deliveredAt`. An order delivered before
 *     that field existed has no clock to count from and is left for an admin;
 *   - its return window has passed: the LONGEST window over its lines
 *     (orderReturnWindowDays — the same computation the delivered email
 *     promises), plus a grace period for a request raised at the last minute;
 *   - it has no open return (pending → replacement_dispatched);
 *   - it has no `owed` or `created` refund row — money still in flight keeps
 *     the case open — and no `failed` gateway refund that nothing has retried
 *     or re-issued (unresolvedFailedRefunds): the customer is still owed it.
 *
 * The move itself is a compare-and-swap on `orderStatus: "Delivered"` plus the
 * refund condition, so an admin action, a refund recorded mid-sweep or a second
 * process running the same sweep all resolve to exactly one completion — and
 * only the winner runs the side effects (bill-number backstop, notification,
 * email).
 *
 * The email is skipped when the order became eligible (window + grace) more
 * than STALE_EMAIL_DAYS ago. The first run after deploy will complete a backlog
 * of long-delivered orders, and "your order is complete" weeks after the fact is
 * noise, not news. The queue notification row is still written for every
 * completion.
 *
 * Env:
 *   ORDER_AUTO_COMPLETE_ENABLED      default on; "false" disables the sweep
 *   ORDER_AUTO_COMPLETE_INTERVAL_MS  default 1 hour, minimum 5 minutes
 *   ORDER_AUTO_COMPLETE_GRACE_DAYS   default 1
 */
import OrderModel from "./Order.model.js";
import ReturnModel, { OPEN_RETURN_STATUSES } from "../returns/return.model.js";
import { ensureBillNumber } from "./bill-number.service.js";
import { notifyOrderCompleted } from "../notifications/notification.service.js";
import {
  customerEmailForOrder,
  loadReturnPolicies,
  orderReturnWindowDays,
  sendOrderCompletedEmail,
} from "../notifications/order-emails.js";
import { unresolvedFailedRefunds } from "../payments/return-refund.service.js";
import { logLifecycleError, logLifecycleEvent } from "../../utils/lifecycle-logger.service.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;
const MIN_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_GRACE_DAYS = 1;
// The first pass runs shortly after boot rather than a full interval later, so a
// process restarted more often than hourly (deploys, PM2 memory restarts) still
// sweeps. Short enough to matter, long enough to stay out of startup.
const FIRST_RUN_DELAY_MS = 2 * 60 * 1000;
export const STALE_EMAIL_DAYS = 3;

export const isOrderAutoCompleteEnabled = () =>
  String(process.env.ORDER_AUTO_COMPLETE_ENABLED ?? "").trim().toLowerCase() !== "false";

export const orderAutoCompleteIntervalMs = () => {
  const raw = Number(process.env.ORDER_AUTO_COMPLETE_INTERVAL_MS);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_INTERVAL_MS;
  return Math.max(raw, MIN_INTERVAL_MS);
};

export const orderAutoCompleteGraceDays = () => {
  const raw = process.env.ORDER_AUTO_COMPLETE_GRACE_DAYS;
  if (raw === undefined || String(raw).trim() === "") return DEFAULT_GRACE_DAYS;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_GRACE_DAYS;
};

// Money still in flight. An `owed` row is a liability nobody has paid; a
// `created` row is a gateway refund whose outcome is not yet known.
const NO_UNSETTLED_REFUND = {
  $not: { $elemMatch: { status: { $in: ["owed", "created"] } } },
};

/**
 * One sweep. Exported for tests and for an admin "run now" if one is ever
 * wanted; the scheduler below calls it through runOrderAutoCompletePass.
 *
 * @param {{ now?: Date, scanLimit?: number, completeLimit?: number, graceDays?: number }} [options]
 *   `now` is injectable so tests can place orders relative to a fixed clock.
 * @returns {Promise<{ scanned: number, completed: string[], skipped: object, emailed: number }>}
 */
export const completeEligibleDeliveredOrders = async ({
  now = new Date(),
  scanLimit = 500,
  completeLimit = 50,
  graceDays = orderAutoCompleteGraceDays(),
} = {}) => {
  const nowMs = now.getTime();
  const graceMs = graceDays * MS_PER_DAY;
  const summary = {
    scanned: 0,
    completed: [],
    skipped: { window: 0, openReturn: 0, failedRefund: 0, lostRace: 0, error: 0 },
    emailed: 0,
  };

  // Only the grace period bounds the query; each order's own window is checked
  // below. Bounding it by the default window too meant a "none"-policy order
  // (window 0) was first SEEN a week after it became eligible — always past the
  // stale-email cut-off, so it never got its "order complete" email.
  //
  // Bounded and oldest-first, so the orders whose windows are most likely over
  // come first. If more than scanLimit long-window orders ever sat at the head of
  // this list, newer short-window ones would wait — at this shop's volume that is
  // theoretical, and the bound is what keeps a backlog from turning one pass into
  // a full collection scan.
  const candidates = await OrderModel.find({
    orderStatus: "Delivered",
    deliveredAt: { $ne: null, $lte: new Date(nowMs - graceMs) },
    refunds: NO_UNSETTLED_REFUND,
  })
    .sort({ deliveredAt: 1 })
    .limit(scanLimit)
    .select("_id user guestEmail items deliveredAt shipment.provider totalAmount refunds")
    .lean();
  summary.scanned = candidates.length;
  if (candidates.length === 0) return summary;

  const policies = await loadReturnPolicies(
    candidates.flatMap((order) => (order.items || []).map((item) => item.product)),
  );

  for (const order of candidates) {
    if (summary.completed.length >= completeLimit) break;
    const orderId = String(order._id);

    try {
      const windowDays = orderReturnWindowDays(order, policies);
      const windowEndsMs = new Date(order.deliveredAt).getTime() + windowDays * MS_PER_DAY;
      if (windowEndsMs + graceMs > nowMs) {
        summary.skipped.window += 1;
        continue;
      }

      // Decided on the ledger as read; the claim below re-asserts that ledger, so
      // a refund that moves in between makes the claim miss and the next sweep
      // decides again.
      if (unresolvedFailedRefunds(order).length > 0) {
        summary.skipped.failedRefund += 1;
        continue;
      }

      const openReturn = await ReturnModel.exists({
        order: order._id,
        status: { $in: OPEN_RETURN_STATUSES },
      });
      if (openReturn) {
        summary.skipped.openReturn += 1;
        continue;
      }

      const set = { orderStatus: "Completed" };
      // Same mirror rule as UpdateOrderStatus: an order with no recorded
      // shipment provider has no shipment for `shipment.status` to describe.
      if (order.shipment?.provider) set["shipment.status"] = "Completed";

      const claimed = await OrderModel.findOneAndUpdate(
        {
          _id: order._id,
          orderStatus: "Delivered",
          refunds: NO_UNSETTLED_REFUND,
          $expr: {
            $eq: [
              { $ifNull: ["$refunds.status", []] },
              (order.refunds || []).map((entry) => entry.status),
            ],
          },
        },
        {
          $set: set,
          $push: {
            statusHistory: {
              from: "Delivered",
              to: "Completed",
              changedBy: null,
              source: "auto_complete",
              changedAt: new Date(),
            },
          },
        },
        { returnDocument: "after" },
      );
      if (!claimed) {
        summary.skipped.lostRace += 1;
        continue;
      }
      summary.completed.push(orderId);
      logLifecycleEvent("orders", "order_auto_completed", { orderId, windowDays, graceDays });

      // Backstop only: Delivered normally minted the number already, and
      // ensureBillNumber is a no-op when one exists. Caught — the completion is
      // durable and a numbering failure has its own repair script.
      try {
        await ensureBillNumber(claimed._id);
      } catch (error) {
        logLifecycleError("orders", "bill_number_mint_failed", error, { orderId, source: "auto_complete" });
      }

      await notifyOrderCompleted({ orderId: claimed._id, userId: claimed.user || null }).catch((error) =>
        logLifecycleError("orders", "auto_complete_notify_failed", error, { orderId }),
      );

      // Measured from when the order BECAME eligible (window + grace), not from
      // the window alone, so a larger grace setting cannot silently suppress
      // every email. With the default grace of 1 day a normal hourly sweep
      // completes within an hour of eligibility and always emails.
      if (nowMs - (windowEndsMs + graceMs) <= STALE_EMAIL_DAYS * MS_PER_DAY) {
        try {
          const email = await customerEmailForOrder(claimed);
          await sendOrderCompletedEmail({ order: claimed, email });
          if (email) summary.emailed += 1;
        } catch (error) {
          logLifecycleError("orders", "auto_complete_email_failed", error, { orderId });
        }
      }
    } catch (error) {
      // One bad order must not stop the rest of the sweep.
      summary.skipped.error += 1;
      logLifecycleError("orders", "auto_complete_order_failed", error, { orderId });
    }
  }

  return summary;
};

let running = false;
let timer = null;
let lastRun = null;

/**
 * One scheduled pass: env-gated, and guarded so passes never overlap within a
 * process (the CAS above is what makes overlapping processes safe).
 */
export const runOrderAutoCompletePass = async ({ reason = "scheduled", now } = {}) => {
  if (!isOrderAutoCompleteEnabled()) return { ran: false, reason: "disabled_by_env" };
  if (running) return { ran: false, reason: "already_running" };
  running = true;
  const startedAt = new Date();
  try {
    const summary = await completeEligibleDeliveredOrders(now ? { now } : {});
    lastRun = { at: startedAt, reason, summary };
    if (summary.scanned > 0) {
      logLifecycleEvent("orders", "auto_complete_pass_finished", {
        reason,
        scanned: summary.scanned,
        completed: summary.completed.length,
        emailed: summary.emailed,
        ...summary.skipped,
      });
    }
    return { ran: true, summary };
  } catch (error) {
    lastRun = { at: startedAt, reason, error: error.message };
    logLifecycleError("orders", "auto_complete_pass_failed", error, { reason });
    return { ran: false, reason: "error", error: error.message };
  } finally {
    running = false;
  }
};

export const getOrderAutoCompleteStatus = () => ({ running, lastRun });

const scheduleNext = (delayMs) => {
  // Stopped (graceful shutdown) between passes: stay stopped.
  if (timer === null) return;
  timer = setTimeout(async () => {
    await runOrderAutoCompletePass({ reason: "scheduled" });
    if (timer) scheduleNext(orderAutoCompleteIntervalMs());
  }, delayMs);
  timer.unref?.();
};

/**
 * Starts the self-rescheduling timer. Idempotent per process. A chained
 * setTimeout, not setInterval, so a slow pass can never overlap the next.
 * Returns false when ORDER_AUTO_COMPLETE_ENABLED=false.
 */
export const startOrderAutoComplete = () => {
  if (!isOrderAutoCompleteEnabled()) return false;
  if (timer) return true;
  timer = true; // reserve, so a second call is a no-op
  scheduleNext(Math.min(FIRST_RUN_DELAY_MS, orderAutoCompleteIntervalMs()));
  return true;
};

export const stopOrderAutoComplete = () => {
  if (timer && timer !== true) clearTimeout(timer);
  timer = null;
};
