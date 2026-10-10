import mongoose from "mongoose";

/**
 * One row per (coupon, customer): how many times that customer has redeemed it.
 *
 * This used to be a `usedBy` array on the coupon document, and moving it out fixed
 * two things at once.
 *
 * **The array had no ceiling.** One subdocument per redeeming customer, loaded and
 * scanned linearly in application memory on every validation — so a public code with
 * 50k redemptions meant a multi-megabyte document re-read on every checkout, heading
 * for Mongo's 16MB document limit. This store runs a self-hosted Mongo on a small
 * VPS, so that is a real ceiling rather than a theoretical one.
 *
 * **`coupon.usage` had two definitions.** It was both an independently `$inc`-ed
 * counter (the cancellation path) and a value recomputed from `usedBy` by a
 * `pre("validate")` hook on every `.save()`. They agreed only by luck, and a global
 * redemption cap cannot rest on a field that any admin edit silently rewrites. With
 * per-user rows here, `usage` on the coupon is the single authoritative total and
 * the hook is gone.
 *
 * Keyed by the `couponId` STRING rather than the coupon's `_id`, because that is how
 * the rest of the system already references a coupon: `order.coupon` stores the
 * string, `countOrdersWithCoupon` queries on it, and the cancellation release path
 * filters by it. Using `_id` here would have meant a lookup on every release for no
 * gain. It does assume `couponId` is stable — which the codebase already assumes,
 * since orders record the string and would otherwise orphan too.
 */
const couponRedemptionSchema = new mongoose.Schema(
  {
    coupon: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
    },
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "UserAuthenticationModel",
      required: true,
    },
    count: {
      // 0 is a legitimate state, and `min: 0` rather than `min: 1` is load-bearing:
      // the customer redeemed the coupon and then cancelled the order, so the
      // redemption was given back. `min: 1` made that decrement throw a
      // ValidationError, which is NOT a TransientTransactionError — so
      // withTransaction aborted instead of retrying and every cancellation of a
      // coupon order failed with a 500. The row is kept rather than deleted so
      // redemption history survives a cancellation.
      type: Number,
      default: 0,
      min: 0,
    },
    lastUsedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true },
);

// The allowance lookup AND the race guard. Unique so two concurrent redemptions by
// the same customer cannot create two rows and each see an allowance of zero used.
couponRedemptionSchema.index({ coupon: 1, user: 1 }, { unique: true });
// GetAvailableCoupons reads every row for one customer in a single query rather than
// one lookup per listed coupon; without this that read is a collection scan.
couponRedemptionSchema.index({ user: 1 });

export default mongoose.model("CouponRedemption", couponRedemptionSchema);
