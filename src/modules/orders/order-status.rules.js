/**
 * Legal order-status transitions.
 *
 * `UpdateOrderStatus` previously validated only that the target value existed
 * in the enum, never what the order's current status was — so all 81 ordered
 * pairs were permitted from the admin dropdown. That allowed, among others:
 *
 *   Cancelled → Confirmed   stock already restored and never re-deducted
 *                           (guaranteed oversell), wallet/coupon already
 *                           returned, refund already paid, order shippable
 *                           again → money out AND goods out.
 *   Cancelled → Delivered   COD flips to Paid, booking revenue for cash that
 *                           was never collected, and re-opens the return window.
 *   Shipped   → Pending     re-opens CUSTOMER self-cancellation on a parcel
 *                           already in transit → full refund + full restock
 *                           while the parcel still delivers.
 *
 * The returns module already had this pattern (return.controller.js); orders
 * never got it. Both the admin endpoint and the Shiprocket webhook validate
 * against this table so a replayed or out-of-order courier event cannot walk a
 * status backwards either.
 */
export const ORDER_STATUS_TRANSITIONS = {
  Pending: ["Confirmed", "Packed", "Cancelled"],
  Confirmed: ["Packed", "Shipped", "Cancelled"],
  Packed: ["Shipped", "Cancelled"],
  Shipped: ["Out For Delivery", "Delivered", "NDR", "RTO"],
  "Out For Delivery": ["Delivered", "NDR", "RTO"],
  NDR: ["Out For Delivery", "Delivered", "RTO"],
  // RTO covers initiated and in-transit; "RTO Received" is the parcel physically
  // arriving. Kept as separate states because the restock and the prepaid refund
  // obligation both hang off arrival, not off the courier merely giving up.
  //
  // "Cancelled" was removed from the RTO rows: no endpoint could ever perform
  // that move (UpdateOrderStatus refuses Cancelled outright, the cancel
  // endpoints claim pre-dispatch statuses only, the webhook never maps to it),
  // yet the admin dropdown offered it and every attempt died with a 400 — the
  // dead option read as "cancellation is broken". An RTO ends through its own
  // close-out below.
  RTO: ["RTO Received"],
  // "Closed" is how an RTO ends: the parcel is back, its condition recorded, and
  // any refund owed settled. It used to close out as "Cancelled", which
  // overloaded that status with two quite different meanings — "the customer or
  // seller called this off before dispatch" and "we shipped it, it came back".
  // Reporting has to exclude both from revenue, but only one of them is a
  // cancellation.
  "RTO Received": ["Closed"],
  // "Completed" is the admin's explicit sign-off that a delivered order's case
  // is finished — customer kept it, nothing pending. It stays REVENUE (it is
  // deliberately absent from NON_REVENUE_STATUSES) and closes self-service
  // returns, which gate on status "Delivered". Delivered orders are otherwise
  // unwound through the Returns flow.
  Delivered: ["Completed"],
  // Terminal. Cancelled orders must never be resurrected — cancellation
  // carries compensation logic that a bare status edit does not perform.
  Cancelled: [],
  // Terminal. A closed RTO is finished: nothing further ships, nothing further
  // restocks, and it is not revenue.
  Closed: [],
  // Terminal. The success end-state: delivered and signed off.
  Completed: [],
};

export const ORDER_STATUSES = Object.keys(ORDER_STATUS_TRANSITIONS);

/**
 * The return-to-origin lifecycle, in order.
 *
 * Grouped rather than enumerated at each call site because every one of these
 * means "this parcel is coming back or is already back", and the guards that care
 * have to treat them alike. `ensureFulfillable` previously compared against "RTO"
 * only, so an order at "RTO Received" — a parcel physically on the seller's shelf —
 * could still be given an AWB, a courier pickup and a printed label.
 */
export const RTO_LIFECYCLE_STATUSES = ["RTO", "RTO Received", "Closed"];

/**
 * Statuses from which no fulfilment action may be taken.
 *
 * A set rather than a chain of comparisons, so adding a status to the lifecycle
 * above cannot leave a fulfilment endpoint silently permissive.
 */
export const NON_FULFILLABLE_STATUSES = ["Cancelled", "Completed", ...RTO_LIFECYCLE_STATUSES];

export const isFulfillableStatus = (status) => !NON_FULFILLABLE_STATUSES.includes(status);

/**
 * Statuses that must never count as revenue.
 *
 * "Cancelled" never shipped; "Closed" shipped and came back. Both are excluded
 * from money reporting, and they are grouped here so a third such status cannot be
 * added without the reports noticing.
 */
export const NON_REVENUE_STATUSES = ["Cancelled", "Closed"];

/**
 * @returns {{ok: true} | {ok: false, reason: string}}
 * Re-setting the same status is allowed and treated as a no-op, so idempotent
 * saves and duplicate courier events don't error.
 */
export const canTransitionOrderStatus = (from, to) => {
  if (!ORDER_STATUSES.includes(to)) {
    return { ok: false, reason: `"${to}" is not a valid order status` };
  }
  if (from === to) return { ok: true };

  const allowed = ORDER_STATUS_TRANSITIONS[from] || [];
  if (!allowed.includes(to)) {
    return {
      ok: false,
      reason: allowed.length
        ? `An order that is "${from}" can only move to: ${allowed.join(", ")}`
        : `"${from}" is a final status and cannot be changed`,
    };
  }
  return { ok: true };
};

/**
 * Statuses a COURIER event may move an order out of.
 *
 * Pending is absent on purpose: a COD order is created Confirmed, so Pending only
 * ever means a prepaid checkout whose payment has not been captured. A courier
 * event against one is an integrity problem to surface, not a move to make — it
 * would ship goods nobody has paid for. Delivered and every terminal status are
 * absent because nothing a courier reports can legitimately take an order back
 * out of them.
 */
export const COURIER_SOURCE_STATUSES = [
  "Confirmed",
  "Packed",
  "Shipped",
  "Out For Delivery",
  "NDR",
  "RTO",
];

// The only intermediate steps a courier can make us miss. Both are the single gate
// into their branch: every in-transit status is entered through "Shipped", and
// "RTO Received" only through "RTO". Spelled out rather than searched for, so the
// set of moves the catch-up can make is reviewable by reading two lines.
const VIA_SHIPPED = ["Out For Delivery", "Delivered", "NDR", "RTO", "RTO Received"];
const PRE_DISPATCH = ["Confirmed", "Packed"];

/**
 * The sequence of moves that carries an order from `from` to the status a courier
 * just reported, or null if no legal sequence exists.
 *
 * Courier events are not guaranteed to arrive, and the transition table only
 * permits one step at a time. Without this, a single missed "Shipped" event left
 * an order at Packed forever: the later "Delivered" was refused as an illegal
 * jump, COD cash was never recorded, and the return window never opened. Each hop
 * returned here is individually legal under ORDER_STATUS_TRANSITIONS, so the
 * catch-up can never reach a status the table could not have reached by itself —
 * it only stops a lost event from freezing the order.
 *
 * @returns {Array<{from: string, to: string}> | null} [] when already there.
 */
export const resolveCourierPath = (from, to) => {
  if (!ORDER_STATUSES.includes(to)) return null;
  if (from === to) return [];
  if (!COURIER_SOURCE_STATUSES.includes(from)) return null;

  if (canTransitionOrderStatus(from, to).ok) return [{ from, to }];

  const hops = [];
  let current = from;
  if (PRE_DISPATCH.includes(current) && VIA_SHIPPED.includes(to)) {
    hops.push({ from: current, to: "Shipped" });
    current = "Shipped";
  }
  if (to === "RTO Received" && ["Shipped", "Out For Delivery", "NDR"].includes(current)) {
    hops.push({ from: current, to: "RTO" });
    current = "RTO";
  }
  if (!canTransitionOrderStatus(current, to).ok) return null;
  hops.push({ from: current, to });
  return hops;
};
