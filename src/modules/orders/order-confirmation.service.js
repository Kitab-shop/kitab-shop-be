import OrderModel from "./Order.model.js";
import { isManualOrderConfirmationEnabled } from "../../config/features.config.js";
import { EXCLUDE_AWAITING_PAYMENT, isAwaitingPayment } from "./order-visibility.js";
import { syncOrderToShiprocketIfEnabled } from "./order-shipping.service.js";
import { notifyOrderConfirmed } from "../notifications/notification.service.js";
import {
  customerEmailForOrder,
  sendOrderConfirmedEmail,
} from "../notifications/order-emails.js";
import { logLifecycleError, logLifecycleEvent } from "../../utils/lifecycle-logger.service.js";

/**
 * Admin approval of new orders (ORDER_MANUAL_CONFIRMATION_ENABLED).
 *
 * With the flag off nothing here changes behaviour: COD orders are created
 * Confirmed and a captured payment promotes its order straight to Confirmed, as
 * they always have. With it on, both stop at Pending — the COD order at
 * Pending/Pending, the prepaid one at Pending/Paid — and only an admin moves them
 * on, singly through UpdateOrderStatus or in bulk through BulkConfirmOrders.
 *
 * Pending was reused rather than a new "Awaiting Confirmation" status because every
 * guard that has to keep an unapproved order out of fulfilment already treats
 * Pending that way: shipments are only claimable from Confirmed/Packed
 * (order-shipping.service.js), courier events refuse to move a Pending order
 * (COURIER_SOURCE_STATUSES), partial cancels need Confirmed/Packed, and the
 * customer can still cancel. What tells "awaiting approval" apart from "awaiting
 * payment" is the payment side, which is exactly what isAwaitingPayment reads.
 */

/** The status a newly placed or newly paid order starts at. */
export const initialOrderStatus = () =>
  isManualOrderConfirmationEnabled() ? "Pending" : "Confirmed";

/**
 * Pending orders an admin may confirm: COD (nothing is collected until delivery)
 * or anything already Paid. A prepaid checkout whose payment has not been captured
 * is excluded — the payment confirms that one, and confirming it by hand would ship
 * goods nobody has paid for (the same rule as PAYMENT_NOT_CAPTURED in
 * UpdateOrderStatus).
 *
 * Compose with `$and`, never by spreading next to another filter: both this and the
 * admin list filter carry `orderStatus`, `$or` and `$nor` keys that would silently
 * overwrite one another.
 */
export const CONFIRMABLE_ORDER_MATCH = {
  orderStatus: "Pending",
  ...EXCLUDE_AWAITING_PAYMENT,
  $or: [{ paymentMethod: "COD", paymentStatus: "Pending" }, { paymentStatus: "Paid" }],
};

/**
 * The admin order list's status/date filters, shared by GetAllOrders and the
 * "confirm everything matching these filters" action so both select the same rows.
 *
 * Dates are whole local days, as the list has always treated them. An unparseable
 * date is refused (400) rather than ignored: dropping it would silently WIDEN the
 * filter, and "confirm all matching" would then reach orders the admin never chose.
 */
const parseFilterDate = (value, label) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    const error = new Error(`${label} is not a valid date`);
    error.statusCode = 400;
    throw error;
  }
  return date;
};

export const buildAdminOrderFilter = ({ status, from, to } = {}, { includeAwaitingPayment = false } = {}) => {
  const filter = includeAwaitingPayment ? {} : { ...EXCLUDE_AWAITING_PAYMENT };

  if (status) filter.orderStatus = status;

  if (from || to) {
    filter.createdAt = {};
    if (from) {
      const start = parseFilterDate(from, "From");
      start.setHours(0, 0, 0, 0);
      filter.createdAt.$gte = start;
    }
    if (to) {
      const end = parseFilterDate(to, "To");
      end.setHours(23, 59, 59, 999);
      filter.createdAt.$lte = end;
    }
  }

  return filter;
};

/** Why a given order could not be confirmed, in the shape the bulk response reports. */
export const explainNotConfirmable = (order) => {
  if (!order) return { code: "NOT_FOUND", message: "Order not found" };
  if (order.orderStatus === "Cancelled") {
    return { code: "ORDER_CANCELLED", message: "The order has been cancelled" };
  }
  if (order.orderStatus !== "Pending") {
    return {
      code: "ALREADY_CONFIRMED",
      message: `The order is already ${order.orderStatus}`,
    };
  }
  if (isAwaitingPayment(order)) {
    return {
      code: "PAYMENT_NOT_CAPTURED",
      message: "The prepaid payment has not been captured yet — it confirms itself when it is",
    };
  }
  return {
    code: "NOT_CONFIRMABLE",
    message: `An order whose payment is ${order.paymentStatus} cannot be confirmed`,
  };
};

/**
 * Pending → Confirmed for one order, as a compare-and-swap on CONFIRMABLE_ORDER_MATCH.
 *
 * The eligibility rule IS the filter, so two admins (or a bulk action and a single
 * click) confirming the same order produce one Confirmed, one history entry and one
 * set of side effects; and an order cancelled or paid-for in between is judged on
 * what it is at the moment of the write, not on the list the admin was looking at.
 *
 * @returns {Promise<{ok: true, order} | {ok: false, code: string, message: string}>}
 */
export const confirmOrder = async ({ orderId, actorId = null, source = "admin" }) => {
  const now = new Date();
  const order = await OrderModel.findOneAndUpdate(
    { _id: orderId, ...CONFIRMABLE_ORDER_MATCH },
    {
      $set: { orderStatus: "Confirmed", confirmedAt: now },
      $push: {
        statusHistory: {
          from: "Pending",
          to: "Confirmed",
          changedBy: actorId,
          source,
          changedAt: now,
        },
      },
    },
    { returnDocument: "after" },
  );
  if (order) return { ok: true, order };

  const current = await OrderModel.findById(orderId)
    .select("orderStatus paymentMethod paymentStatus")
    .lean();
  return { ok: false, ...explainNotConfirmable(current) };
};

/**
 * What follows an admin's confirmation: the Shiprocket auto-push that a
 * self-confirming order gets at placement or capture, and the customer's
 * "your order is confirmed" message. Only the caller that won the confirmation
 * runs this. Never throws — the confirmation is already durable.
 */
export const runConfirmationSideEffects = async (order) => {
  try {
    await syncOrderToShiprocketIfEnabled(order);
  } catch (error) {
    logLifecycleError("orders", "confirmation_shipment_failed", error, { orderId: String(order?._id) });
  }
  notifyOrderConfirmed({ orderId: order._id, userId: order.user || null }).catch(() => {});
  customerEmailForOrder(order)
    .then((email) => sendOrderConfirmedEmail({ order, email }))
    .catch(() => {});
};

// One request's worth. Large enough to clear a busy day's queue in a click, small
// enough that the response returns promptly; `remaining` tells the admin to repeat.
export const BULK_CONFIRM_LIMIT = 500;

/**
 * Confirms many orders: either the given ids, or every confirmable order matching
 * the admin list's filters.
 *
 * Each order is its own compare-and-swap — there is no all-or-nothing batch, because
 * one order being cancelled mid-run is no reason to leave the rest unapproved. Ids
 * are de-duplicated first so the same order sent twice is not reported as a failure
 * against itself.
 *
 * Side effects (courier push, customer email) run after the response, one order at a
 * time: a few hundred Shiprocket calls must not hold the admin's request open, and a
 * push that never happens is retried by the shipping reconciler from confirmedAt.
 *
 * @returns {Promise<{confirmed: Array<{orderId: string}>, skipped: Array<{orderId: string, code: string, message: string}>, remaining: number}>}
 */
export const bulkConfirmOrders = async ({ orderIds, filters, listedAt, actorId = null }) => {
  let ids;
  let filterMatch = null;

  if (Array.isArray(orderIds)) {
    ids = [...new Set(orderIds.map(String))].slice(0, BULK_CONFIRM_LIMIT);
  } else {
    // Only orders placed before the admin's list was loaded. Without this bound the
    // filter was re-run at click time, so every order placed in between — which the
    // admin never saw — was approved and pushed to the courier too, defeating the
    // review this flag exists for.
    const listedBefore = parseFilterDate(listedAt, "listedAt");
    filterMatch = {
      $and: [buildAdminOrderFilter(filters), CONFIRMABLE_ORDER_MATCH, { createdAt: { $lte: listedBefore } }],
    };
    const rows = await OrderModel.find(filterMatch)
      .select("_id")
      .sort({ createdAt: 1 })
      .limit(BULK_CONFIRM_LIMIT)
      .lean();
    ids = rows.map((row) => String(row._id));
  }

  const confirmed = [];
  const confirmedOrders = [];
  const skipped = [];
  for (const orderId of ids) {
    const result = await confirmOrder({ orderId, actorId, source: "admin_bulk_confirm" });
    if (result.ok) {
      confirmed.push({ orderId });
      confirmedOrders.push(result.order);
    } else {
      skipped.push({ orderId, code: result.code, message: result.message });
    }
  }

  // filterMatch carries EXCLUDE_AWAITING_PAYMENT through CONFIRMABLE_ORDER_MATCH.
  const remaining = filterMatch ? await OrderModel.countDocuments(filterMatch) : 0;

  logLifecycleEvent("orders", "bulk_confirm_finished", {
    mode: filterMatch ? "filters" : "selected",
    requested: ids.length,
    confirmed: confirmed.length,
    skipped: skipped.length,
    remaining,
  });

  if (confirmedOrders.length > 0) {
    void (async () => {
      for (const order of confirmedOrders) await runConfirmationSideEffects(order);
    })();
  }

  return { confirmed, skipped, remaining };
};

/** How many orders the admin list's current filters would let a bulk confirm reach. */
export const countConfirmableOrders = (filters) =>
  OrderModel.countDocuments({
    $and: [buildAdminOrderFilter(filters), CONFIRMABLE_ORDER_MATCH],
  });
