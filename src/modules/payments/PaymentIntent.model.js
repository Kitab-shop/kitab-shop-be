import mongoose from "mongoose";

/**
 * Retention for abandoned payment intents — see `expiresAt` below for why this is
 * deliberately far longer than the 20-minute order sweep. Configurable so a
 * deployment can widen it without a code change; floored at one day because a
 * value below the sweep window would defeat reconciliation entirely.
 */
const DAY_MS = 24 * 60 * 60 * 1000;
export const PAYMENT_INTENT_RETENTION_MS = Math.max(
  DAY_MS,
  Number(process.env.PAYMENT_INTENT_RETENTION_MS) || 7 * DAY_MS,
);

const paymentItemSchema = new mongoose.Schema(
  {
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ProductModel",
      required: true,
    },
    name: { type: String, required: true },
    image: { type: String, default: "" },
    price: { type: Number, required: true, min: 0 },
    quantity: { type: Number, required: true, min: 1 },
    selectedVariants: { type: Map, of: String, default: {} },
    variantKey: { type: String, default: "" },
  },
  { _id: false },
);

const paymentIntentSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "UserAuthenticationModel",
      required: true,
      index: true,
    },
    idempotencyKey: {
      type: String,
      default: null,
    },
    razorpayOrderId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    // Every Razorpay order id this checkout has previously used. A retry issues a
    // NEW Razorpay order and used to overwrite razorpayOrderId in place, which
    // orphaned any payment the customer completed against the old one: the webhook
    // looked the intent up by order id, found nothing, and so created no order and
    // ran no auto-refund — the customer was charged with nothing to show for it.
    // Keeping the history means a late capture on a superseded id still resolves to
    // this checkout.
    // The order row created BEFORE payment (order-first), still at Pending.
    //
    // Deliberately NOT `storeOrder`. That field means "a PAID order exists for this
    // checkout" and is load-bearing as the double-charge guard: completeCapturedIntent
    // returns early on it, and RetryRazorpayOrder refuses an intent that has it.
    // Setting it at creation time would short-circuit the promotion to Paid and
    // block every legitimate retry. Two different facts, two different fields.
    pendingOrder: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "orders",
      default: null,
    },

    previousRazorpayOrderIds: {
      type: [String],
      default: [],
      index: true,
    },
    razorpayPaymentId: {
      type: String,
      unique: true,
      sparse: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 1,
    },
    currency: {
      type: String,
      default: "INR",
    },
    items: {
      type: [paymentItemSchema],
      required: true,
    },
    shippingAddress: {
      fullName: { type: String, required: true },
      phone: { type: String, required: true },
      address: { type: String, required: true },
      addressLine1: { type: String, default: "" },
      addressLine2: { type: String, default: "" },
      landmark: { type: String, default: "" },
      district: { type: String, default: "" },
      city: { type: String, required: true },
      state: { type: String, required: true },
      pincode: { type: String, required: true },
      country: { type: String, default: "India" },
    },
    subtotal: { type: Number, required: true, min: 0 },
    shippingCharge: { type: Number, default: 0, min: 0 },
    tax: { type: Number, default: 0, min: 0 },
    discount: { type: Number, default: 0, min: 0 },
    walletDiscount: { type: Number, default: 0, min: 0 },
    couponDiscount: { type: Number, default: 0, min: 0 },
    totalAmount: { type: Number, required: true, min: 0 },
    coupon: { type: String, default: null },
    status: {
      type: String,
      enum: ["created", "processing", "completed", "failed", "refunded", "expired"],
      default: "created",
      index: true,
    },
    retryCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    stockReserved: {
      type: Boolean,
      default: false,
    },
    storeOrder: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "orders",
      default: null,
    },
    failureReason: { type: String, default: "" },
    /**
     * How long an ABANDONED intent is retained. Cleared (`undefined`) the moment
     * the intent completes, so this only ever expires checkouts nobody paid for.
     *
     * This is a RECONCILIATION window, and it is deliberately much longer than
     * the 20-minute abandoned-order sweep — the two are not the same clock and
     * must not be equalised:
     *
     *   RESERVATION_TTL_MS       20 min   how long stock is held. Short because
     *                                     holding it starves other buyers.
     *   AWAITING_PAYMENT_TTL_MS  20 min   when the unpaid order row is closed
     *                                     out. Short so abandoned checkouts stop
     *                                     looking like live orders.
     *   this                     7 days   how long we can still IDENTIFY a late
     *                                     capture. Long on purpose: a Razorpay
     *                                     order stays payable after our order row
     *                                     has been swept, and deleting the intent
     *                                     destroys the only link from that
     *                                     payment back to a customer and a cart.
     *
     * Shortening this to match the sweep would make late captures *less*
     * recoverable, not more. The safety property does not come from the TTL at
     * all: a capture with no intent is recorded in `unmatchedpayments` and
     * auto-refunded, so there is no window in which money can be captured, be
     * unpromotable, and go uncompensated. The TTL only decides how much context
     * that compensation gets to record.
     */
    expiresAt: {
      type: Date,
      default: () => new Date(Date.now() + PAYMENT_INTENT_RETENTION_MS),
      index: { expires: 0 },
    },
  },
  { timestamps: true },
);

paymentIntentSchema.index(
  { user: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: "string" } } },
);

export default mongoose.model("PaymentIntent", paymentIntentSchema);
