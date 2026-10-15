import mongoose from "mongoose";

const checkoutSettingSchema = new mongoose.Schema(
  {
    // Off by default: without an explicit admin opt-in, checkout only offers
    // Razorpay. Independent of SHIPROCKET_ENABLED, which only affects
    // post-order shipment automation, not which payment methods are offered.
    codEnabled: {
      type: Boolean,
      default: false,
    },
    // Off by default — the Shiprocket serviceability API (courier COD
    // availability per pincode) needs live, working credentials. Until an
    // admin confirms those are in place, checkout only enforces the flat
    // codEnabled toggle above, not per-pincode eligibility.
    codServiceabilityCheckEnabled: {
      type: Boolean,
      default: false,
    },
    // Charge the customer what the cheapest courier would actually cost, instead of
    // shipping free.
    //
    // OFF by default, and that default is load-bearing: shipping is currently free on every
    // order, so switching this on is the difference between charging a customer nothing and
    // charging them something. It must never happen as a side effect of a deploy. When on
    // and the rate cannot be fetched, checkout falls back to free rather than refusing —
    // the opposite of the COD serviceability check, because a rate blip must not cost a sale.
    shippingRatesEnabled: {
      type: Boolean,
      default: false,
    },
    // Free delivery once the books in the order are worth at least this much (after any
    // coupon, before wallet credit). Only meaningful while shippingRatesEnabled is on —
    // with it off every order already ships free. 0 means "no threshold": rates apply to
    // every order.
    freeShippingThreshold: {
      type: Number,
      default: 0,
      min: 0,
    },
    // 0 means "no minimum". Guards against COD being used for very small
    // orders where the delivery/handling cost isn't worth the fraud risk.
    codMinOrderAmount: {
      type: Number,
      default: 0,
      min: 0,
    },
    // 0 means "no maximum". Guards against high-value orders being placed
    // COD with no payment guarantee at all.
    codMaxOrderAmount: {
      type: Number,
      default: 0,
      min: 0,
    },
    // How long after placing an order a customer may still cancel it
    // themselves, counted from order creation. 0 means "no time limit" — the
    // pre-existing behaviour, where cancellation depends only on the order not
    // having shipped yet. Past this window the self-service button disappears
    // and the customer is pointed at support, mirroring the return-window rule.
    cancellationWindowHours: {
      type: Number,
      default: 0,
      min: 0,
    },
    // How the delivery charge appears on the store's own bill (the PDF customers and admins
    // download). Presentation only — what the customer is charged never changes, and the bill's
    // rows always still sum to the amount paid:
    //   "always"       a Delivery row on every bill, "Free" when nothing was charged (default,
    //                  the behaviour before this setting existed)
    //   "when_charged" the row only when delivery cost something
    //   "merged"       no separate row; a charged delivery is folded into the subtotal, which is
    //                  then labelled as including delivery
    // Shiprocket's own invoice is not affected: it is printed from the shipment's
    // shipping_charges, which must stay separate so the COD amount the courier collects is right.
    invoiceDeliveryDisplay: {
      type: String,
      enum: ["always", "when_charged", "merged"],
      default: "always",
    },
    singletonId: {
      type: String,
      default: "default",
      unique: true,
      index: true,
    },
  },
  {
    timestamps: true,
  },
);

// upsert, not findOne-then-create: the latter races if two requests hit this
// concurrently before the singleton exists yet (e.g. React StrictMode's
// double-invoked mount effect), and the loser's create() throws E11000.
checkoutSettingSchema.statics.getSettings = async function () {
  return this.findOneAndUpdate(
    { singletonId: "default" },
    { $setOnInsert: { singletonId: "default" } },
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
  );
};

export default mongoose.model("CheckoutSetting", checkoutSettingSchema);
