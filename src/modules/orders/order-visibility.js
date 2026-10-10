/**
 * The single definition of "this order is real".
 *
 * Razorpay orders are created BEFORE the customer pays, at
 * `paymentStatus: "Pending"` / `orderStatus: "Pending"`, and are promoted to
 * `Paid` / `Confirmed` once the payment is verified. That gives an order number
 * up front and a durable record to reconcile a captured-but-unmatched payment
 * against — but it also means the `orders` collection now contains checkouts that
 * were started and abandoned.
 *
 * Those are not orders. They have no money behind them, the customer does not
 * think they bought anything, and no stock has been committed to them. Counting
 * one as revenue is the single most likely way this design goes wrong: before this
 * module existed, every revenue aggregate filtered on
 * `orderStatus: { $ne: "Cancelled" }` and nothing else, so an abandoned checkout
 * would have landed in `totalRevenue` and in the daily charts.
 *
 * Hence one exported filter, used everywhere, and a sweep over `src/` in
 * `test/regression/lifecycle.regression.mjs` (section 1b) that fails if a new aggregate,
 * count or distinct over `orders` forgets it.
 *
 * A COD order at `Pending` is genuinely real — the customer placed it and owes cash
 * on delivery — so the filter is deliberately narrow: it excludes only the
 * prepaid-and-unpaid case.
 */

/** Matches ONLY a Razorpay order whose payment has never completed. */
export const AWAITING_PAYMENT_MATCH = {
  paymentMethod: "RAZORPAY",
  paymentStatus: "Pending",
};

/**
 * Spread into any `find`/`countDocuments`/`$match` over orders that feeds revenue,
 * counts, charts, exports or customer-facing lists.
 *
 *   OrderModel.find({ ...EXCLUDE_AWAITING_PAYMENT, user })
 *
 * `$nor` rather than a negated `$and` so it composes safely: it never collides
 * with a caller's own `paymentStatus` or `paymentMethod` conditions.
 */
export const EXCLUDE_AWAITING_PAYMENT = {
  $nor: [AWAITING_PAYMENT_MATCH],
};

/** True when this order is a prepaid checkout that was never paid for. */
export const isAwaitingPayment = (order) =>
  order?.paymentMethod === "RAZORPAY" && order?.paymentStatus === "Pending";

/**
 * How long an unpaid Razorpay order stays open before it is swept to
 * Cancelled/Failed.
 *
 * Matches the stock-reservation TTL, which is the window that actually matters
 * here: once the reservation expires the units are back on sale, so keeping the
 * order row "live" past that point would be claiming inventory it no longer has.
 *
 * It does NOT match the payment-intent TTL, and an earlier comment here wrongly
 * said it did. The intent is retained far longer on purpose — it is the
 * reconciliation record, and a Razorpay order remains payable after this sweep
 * has closed our order row. See `PAYMENT_INTENT_RETENTION_MS`.
 *
 * That gap is real and cannot be closed by tuning either number, because the
 * gateway decides when a payment can still be captured. It is made safe instead
 * by compensation: a capture that can no longer be promoted is recorded in
 * `unmatchedpayments` and auto-refunded, on the webhook path as well as the
 * browser-verify path. See orphaned-capture.service.js.
 */
export const AWAITING_PAYMENT_TTL_MS = 20 * 60 * 1000;
