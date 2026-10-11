import crypto from "node:crypto";
import mongoose from "mongoose";

export const RETURN_STATUSES = [
  "pending",
  "approved",
  "pickup_scheduled",
  "received",
  "refunded",
  // LEGACY terminal. Before the replacement lifecycle existed, "replaced" was the
  // single close-out for a replacement: it stamped replacedAt, restocked the
  // returned unit and declared the case finished — while the replacement parcel had
  // not been packed, the customer had nothing to track, and the outbound unit was
  // never deducted from stock. New replacements go through
  // replacement_dispatched → replacement_delivered instead. Kept in the enum so
  // any historical document remains valid.
  "replaced",
  // The replacement parcel has physically gone out, with a courier and AWB
  // recorded by hand. Deliberately still an OPEN status: the case is not finished
  // until the customer has it.
  "replacement_dispatched",
  "replacement_delivered",
  "rejected",
];

/**
 * A return still in flight — the customer is waiting on an outcome.
 *
 * This is the set that must be unique per order line: two open returns for the
 * same line are a duplicate request, whether from a double-click or two tabs.
 * Terminal returns are deliberately excluded — see the index at the bottom of
 * this file.
 */
export const OPEN_RETURN_STATUSES = [
  "pending",
  "approved",
  "pickup_scheduled",
  "received",
  // A dispatched replacement is still in flight, so the order line stays occupied
  // and no second return can be raised against it until the customer has the
  // replacement in hand.
  "replacement_dispatched",
];

/**
 * Statuses whose units are spoken for, and therefore count against how much of an
 * order line can still be returned.
 *
 * Everything except `rejected`: a rejected return's goods go back to the customer
 * and nothing is refunded or restocked, so it consumes no units. Same shape as
 * `sumRefunded` in return-refund.service.js, which likewise counts everything
 * except its one failed state.
 */
export const QUANTITY_CONSUMING_RETURN_STATUSES = RETURN_STATUSES.filter(
  (status) => status !== "rejected",
);

const statusHistorySchema = new mongoose.Schema(
  {
    status: {
      type: String,
      enum: RETURN_STATUSES,
      required: true,
    },
    changedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "UserAuthenticationModel",
    },
    note: {
      type: String,
      trim: true,
      default: "",
    },
    changedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { _id: false },
);

/** "" / whitespace → undefined, so an unset AWB is absent. See the AWB indexes below. */
const emptyToUndefined = (value) => {
  const trimmed = String(value ?? "").trim();
  return trimmed || undefined;
};

const returnSchema = new mongoose.Schema(
  {
    returnNumber: {
      type: String,
      unique: true,
      index: true,
      default: () =>
        `RET-${Date.now()}-${crypto.randomBytes(2).toString("hex").toUpperCase()}`,
    },
    order: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "orders",
      required: true,
      index: true,
    },
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "UserAuthenticationModel",
      required: true,
      index: true,
    },
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ProductModel",
      required: true,
    },
    productSnapshot: {
      name: { type: String, required: true, trim: true },
      image: { type: String, default: "" },
      price: { type: Number, required: true, min: 0 },
    },
    quantity: {
      type: Number,
      required: true,
      min: 1,
    },
    reason: {
      type: String,
      required: true,
      trim: true,
      maxlength: 300,
    },
    details: {
      type: String,
      trim: true,
      maxlength: 2000,
      default: "",
    },
    proofImages: {
      type: [String],
      default: [],
      validate: {
        validator: (images) => images.length <= 5,
        message: "A maximum of 5 proof images is allowed",
      },
    },
    refundAmount: {
      type: Number,
      required: true,
      min: 0,
    },

    // The wallet-credit share of this line, held separately from refundAmount
    // (the cash share) because the two are settled by different mechanisms: the
    // gateway reverses the cash, the wallet balance is credited directly. Both
    // are owed. Recorded at request time so the customer and the admin see the
    // same split the refund will actually use.
    walletRefundAmount: {
      type: Number,
      default: 0,
      min: 0,
    },
    // Decided once at request time from the product's returnPolicy.kind (see
    // CreateReturnRequest) — not a customer choice. Determines which terminal
    // status ("refunded" vs "replaced") this request is allowed to reach.
    resolutionType: {
      type: String,
      enum: ["refund", "replacement"],
      required: true,
    },
    // Where to send the money when there's no payment to reverse (COD).
    // Collected from the customer at request time, because the admin otherwise
    // knows the amount owed but has no way to actually pay it. Empty for
    // Razorpay refunds, which go back to the original payment method.
    refundDestination: {
      method: {
        type: String,
        enum: ["upi", "bank_transfer", ""],
        default: "",
      },
      upiId: { type: String, trim: true, default: "" },
      accountName: { type: String, trim: true, default: "" },
      accountNumber: { type: String, trim: true, default: "" },
      ifsc: { type: String, trim: true, uppercase: true, default: "" },
    },
    status: {
      type: String,
      enum: RETURN_STATUSES,
      default: "pending",
      index: true,
    },
    adminNote: {
      type: String,
      trim: true,
      maxlength: 1000,
      default: "",
    },
    // ── REVERSE PICKUP (the parcel coming back) ──────────────────────────────
    // Separate identity from the replacement leg above, because one return can have a
    // collection travelling in and a replacement travelling out at the same time, and a
    // courier event has to be attributable to exactly one of them.
    pickupCourier: { type: String, trim: true, default: "" },
    pickupAwb: { type: String, trim: true, set: emptyToUndefined },
    pickupShipmentId: { type: Number, default: null },
    pickupShiprocketOrderId: { type: Number, default: null },
    // Last courier status seen on each leg. Recorded, never acted on: a parcel arriving
    // at the warehouse is not the same event as someone having inspected it, so the
    // status transition stays with the operator doing QC.
    pickupCourierStatus: { type: String, trim: true, default: "" },
    pickupCourierUpdatedAt: { type: Date, default: null },
    replacementCourierStatus: { type: String, trim: true, default: "" },
    replacementCourierUpdatedAt: { type: Date, default: null },

    // ── BOOKING CLAIMS (one per leg) ─────────────────────────────────────────
    // Taken atomically BEFORE Shiprocket is asked to book a leg, and cleared in the same
    // write that stores the shipment ids. Without it a double click, or two admins on the
    // same return, both passed the "nothing booked yet" read and both booked a courier —
    // and the booking's own idempotency check keyed on the AWB, which booking never sets,
    // so even a second click AFTER success booked again.
    //
    // A claim is released automatically only when Shiprocket definitely refused (a 4xx, or
    // a failure before any request left). A timeout or 5xx keeps it: the booking may well
    // exist on Shiprocket's side, and retrying blind is how a customer gets two couriers.
    // An operator checks Shiprocket and releases it by hand (release-claim endpoints).
    pickupBookingClaimedAt: { type: Date, default: null },
    replacementBookingClaimedAt: { type: Date, default: null },
    // The last booking failure on each leg, so the admin page can say WHY a claim is held
    // rather than showing a button that silently refuses.
    pickupBookingError: { type: String, trim: true, default: "" },
    replacementBookingError: { type: String, trim: true, default: "" },

    pickupScheduledAt: {
      type: Date,
      default: null,
    },
    receivedAt: {
      type: Date,
      default: null,
    },
    refundedAt: {
      type: Date,
      default: null,
    },
    // Stamped when the returned goods are put back on sale. Also the idempotency
    // claim for the restock — a second status update or a double-clicked button
    // finds it already set and does nothing.
    restockedAt: {
      type: Date,
      default: null,
    },
    /**
     * What physical condition the goods came back in — recorded SEPARATELY from
     * whether the customer gets their money.
     *
     * These are two independent decisions and the code used to conflate them:
     * QC pass meant refund AND restock, QC fail meant reject AND no restock. So a
     * customer returning a genuinely faulty item left the admin choosing between
     * refunding them and putting a defective unit back on sale, or refusing a
     * legitimate refund to protect the shelf. Neither is acceptable.
     *
     *   resellable  → goes back into sellable stock
     *   damaged     → written off; customer is still refunded or replaced
     *
     * Required whenever a return reaches a resolved state, because defaulting it
     * either way silently reintroduces the bug.
     */
    disposition: {
      type: String,
      enum: ["", "resellable", "damaged"],
      default: "",
    },
    // Free text for why an item was written off — feeds shrinkage reporting and
    // supplier claims.
    dispositionNote: {
      type: String,
      trim: true,
      maxlength: 500,
      default: "",
    },
    replacedAt: {
      type: Date,
      default: null,
    },

    // ── REPLACEMENT FULFILMENT (manual) ──────────────────────────────────────
    // Recorded by an operator when shipped by hand, or filled in by the integration when
    // the replacement is booked through Shiprocket. Both routes write the same two fields,
    // so the customer-facing tracking details do not depend on how it was dispatched.
    replacementCourier: { type: String, trim: true, default: "" },
    // No default and an emptying setter, so an unset AWB is ABSENT rather than "" — see
    // the index comment below for why absence is the only representation that works.
    replacementAwb: { type: String, trim: true, set: emptyToUndefined },
    // Shiprocket's own ids for the OUTBOUND replacement parcel. Kept on the RETURN, not
    // on the order: the order's `shipment` subdocument stays singular, so the H2-07
    // one-shipment-per-order boundary is not reopened by any of this.
    replacementShipmentId: { type: Number, default: null },
    replacementShiprocketOrderId: { type: Number, default: null },
    replacementDispatchedAt: { type: Date, default: null },
    replacementDeliveredAt: { type: Date, default: null },
    // The idempotency claim for the OUTBOUND stock deduction, in the same
    // claim-first shape as restockedAt above. Dispatching a replacement sends a
    // second physical unit, which nothing used to deduct — so every completed
    // replacement inflated sellable stock by its own quantity.
    replacementStockDeductedAt: { type: Date, default: null },
    statusHistory: {
      type: [statusHistorySchema],
      default: () => [{ status: "pending", note: "Return requested" }],
    },
  },
  { timestamps: true },
);

/**
 * One OPEN return per order line — the duplicate guard, and the concurrency
 * primitive for creating returns.
 *
 * This replaced an unconditional `{order, product, user}` unique index, which made
 * exactly one return document per line possible FOR ALL TIME. That is stricter
 * than the lifecycle this model implements, and it produced two dead ends:
 *
 *   - `rejected` is terminal and there is no reopen endpoint, so a QC rejection
 *     made in error permanently barred the customer from re-requesting. The only
 *     remedy was editing the database by hand.
 *   - `quantity` is stored and validated per request, so returning 1 of 5 units is
 *     clearly intended — but the first such return exhausted the line and the
 *     other 4 could never be returned, inside the policy window or not.
 *
 * PARTIAL on the open statuses, which is what makes both legitimate cases work
 * while still refusing a genuine duplicate: a second request lands only once the
 * first has resolved, and two concurrent requests both write `pending`, both match
 * the filter, and the loser gets E11000. That E11000 is the real protection — the
 * application's `findOne` check ahead of it is a read-then-act pair that two
 * simultaneous requests can both pass.
 *
 * EXPLICITLY NAMED so it can coexist with the old auto-named index while
 * `npm run migrate:return-open-index` removes that one. An auto-named replacement
 * would collide with `order_1_product_1_user_1` and fail with IndexKeySpecsConflict
 * on every boot, silently leaving the old, over-strict constraint in force.
 *
 * Note this index bounds the NUMBER of concurrent returns, not their quantities.
 * Cumulative quantity is capped in CreateReturnRequest against
 * QUANTITY_CONSUMING_RETURN_STATUSES; that check is safe as a read-then-sum
 * precisely because this index serialises creations.
 */
// The return-AWB sync scans for legs booked through Shiprocket that have no AWB yet.
// Built in production by scripts/migrate-shipping-reliability-indexes.js.
returnSchema.index({ pickupShipmentId: 1 }, { name: "return_pickupShipmentId" });

returnSchema.index(
  { order: 1, product: 1, user: 1 },
  {
    name: "one_open_return_per_order_line",
    unique: true,
    partialFilterExpression: { status: { $in: OPEN_RETURN_STATUSES } },
  },
);
// One AWB, one leg, one return. `replacementAwb` has always been unindexed, which is the
// same non-unique-courier-identifier bug H2-01 fixed for forward shipments: the webhook
// resolver selects a record by AWB, and a duplicate would let a courier event land on an
// arbitrary return.
//
// Partial on $type:"string", paired with the emptying setters on both fields so an unset
// AWB is ABSENT rather than "". Three things had to line up here: `sparse` alone does not
// work because "" is a value and would be indexed, making every AWB-less return collide;
// MongoDB rejects `$ne` inside a partialFilterExpression ("Expression not supported in
// partial index: $not"), so the empty case cannot be filtered out at the index; hence the
// setters, which remove the field entirely and leave $type to do the filtering.
returnSchema.index(
  { pickupAwb: 1 },
  {
    name: "return_pickupAwb_unique",
    unique: true,
    partialFilterExpression: { pickupAwb: { $type: "string" } },
  },
);
returnSchema.index(
  { replacementAwb: 1 },
  {
    name: "return_replacementAwb_unique",
    unique: true,
    partialFilterExpression: { replacementAwb: { $type: "string" } },
  },
);
returnSchema.index({ createdAt: -1, status: 1 });
returnSchema.index({ user: 1, createdAt: -1 });

export default mongoose.model("ReturnRequest", returnSchema);
