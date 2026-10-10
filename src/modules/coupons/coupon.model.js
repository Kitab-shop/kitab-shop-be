import mongoose from "mongoose";

const generateCouponId = () =>
  `CPN${Date.now().toString(36).toUpperCase()}${Math.random()
    .toString(36)
    .slice(2, 6)
    .toUpperCase()}`;

const couponSchema = new mongoose.Schema(
  {
    couponId: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      uppercase: true,
      index: true,
      default: generateCouponId,
    },
    targetType: {
      type: String,
      enum: ["all", "category", "product"],
      default: "all",
      index: true,
    },
    category_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Category",
      index: true,
    },
    product_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ProductModel",
      index: true,
    },
    assignedUser: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "UserAuthenticationModel",
      index: true,
    },
    customerEmail: {
      type: String,
      trim: true,
      lowercase: true,
      index: true,
    },
    discountType: {
      type: String,
      enum: ["percentage", "fixed"],
      required: true,
      default: "percentage",
    },
    discountValue: {
      type: Number,
      required: true,
      min: 0,
    },
    startDate: {
      type: Date,
      required: true,
    },
    expireDate: {
      type: Date,
      required: true,
    },
    maxLimit: {
      type: Number,
      required: true,
      default: 1,
      min: 1,
    },
    minPurchaseAmount: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    },
    maxPurchaseAmount: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    },
    /**
     * Total redemptions across ALL customers.
     *
     * Authoritative, not derived. It used to be recomputed from the `usedBy` array
     * by a pre("validate") hook on every save, while the cancellation path also
     * `$inc`-ed it directly — two definitions of one number. Per-user counts now
     * live in the CouponRedemption collection and this is maintained by the same
     * conditional updates that move them, so `globalMaxRedemptions` below has
     * something trustworthy to compare against.
     */
    usage: {
      type: Number,
      default: 0,
      min: 0,
    },
    /**
     * The coupon's TOTAL redemption budget across all customers. 0 means unlimited,
     * matching how `maxPurchaseAmount` and the COD amount gates already encode "no
     * limit", and it is the default so every existing coupon keeps behaving exactly
     * as it does today.
     *
     * Distinct from `maxLimit`, which is the PER-CUSTOMER allowance. Without this
     * there was no total cap of any kind: "first 100 customers" was not expressible,
     * and a code that leaked publicly was redeemable until an admin noticed and
     * deactivated it by hand. It was the last uncapped money lever in checkout.
     *
     * Enforced in the FILTER of the redemption update (coupon.service.js), never by
     * a read-then-check, so concurrent redemptions against the last slot cannot both
     * win.
     */
    globalMaxRedemptions: {
      type: Number,
      default: 0,
      min: 0,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true },
);

couponSchema.pre("validate", function () {
  if (!this.couponId) this.couponId = generateCouponId();
  this.couponId = String(this.couponId).trim().toUpperCase();
  this.customerEmail = this.customerEmail ? String(this.customerEmail).trim().toLowerCase() : undefined;

  if ((!this.targetType || this.targetType === "all") && this.product_id && !this.isModified("targetType")) {
    this.targetType = "product";
  }
  if (this.targetType === "all") {
    this.product_id = undefined;
    this.category_id = undefined;
  }
  if (this.targetType === "category" && !this.category_id) {
    this.invalidate("category_id", "Category is required for category coupon");
  }
  if (this.targetType === "product" && !this.product_id) {
    this.invalidate("product_id", "Product is required for product coupon");
  }
  if (this.discountType === "percentage" && this.discountValue > 100) {
    this.invalidate("discountValue", "Percentage discount cannot be greater than 100");
  }
  if (this.minPurchaseAmount === undefined || this.minPurchaseAmount < 0) {
    this.minPurchaseAmount = 0;
  }
  if (this.startDate && this.expireDate && this.expireDate < this.startDate) {
    this.invalidate("expireDate", "Expire date must be after start date");
  }
  // `usage` is deliberately NOT recomputed here any more. It used to be summed from
  // the `usedBy` array on every save, which meant an ordinary admin edit rewrote the
  // redemption total as a side effect — untenable once `globalMaxRedemptions` gates
  // real money on it. Per-user counts live in CouponRedemption now, and `usage` is
  // moved only by the conditional updates that move them.
});

couponSchema.index({ isActive: 1, startDate: 1, expireDate: 1 });
// Serves GetAvailableCoupons' `.sort({ expireDate: 1 })`, which the index above cannot:
// index bounds stop at the first RANGE key, so after `startDate: { $lte: now }` the keys
// are no longer ordered by expireDate and Mongo fell back to a blocking in-memory sort —
// on a customer-facing cart path, with no .limit() to bound it. Here expireDate is the
// second key, so the sort is satisfied by the scan and `startDate` becomes a residual.
couponSchema.index({ isActive: 1, expireDate: 1 });
couponSchema.index({ isActive: 1, assignedUser: 1, expireDate: 1 });
couponSchema.index({ createdAt: -1 });

export default mongoose.model("CouponModel", couponSchema);
