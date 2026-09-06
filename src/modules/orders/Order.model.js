import mongoose from "mongoose";
// order-status.rules.js imports nothing, so this cannot cycle back through the
// model. The shipment subdocument below reuses ORDER_STATUSES rather than
// declaring a parallel status vocabulary.
import { ORDER_STATUSES } from "./order-status.rules.js";

/**
 * Who is carrying the parcel.
 *
 * MANUAL is not a fallback or an "unknown" — it is the seller shipping by hand
 * with their own courier, which is this deployment's normal mode. Kept to exactly
 * these two: a provider list is only worth extending when an integration actually
 * exists behind the name, and an enum with aspirational members accepts data no
 * code can act on.
 */
export const SHIPMENT_PROVIDERS = ["MANUAL", "SHIPROCKET"];

const OrderItemSchema = new mongoose.Schema(
  {
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ProductModel",
      required: true,
    },

    name: {
      type: String,
      required: true,
      trim: true,
    },

    // For a bookstore the author is half the product's identity, so an order line
    // that names only the title is incomplete. Snapshotted alongside `name` rather
    // than read live, so correcting a book's author later cannot rewrite what an
    // old invoice says was sold.
    //
    // Optional with a "" default on purpose: every order placed before this field
    // existed stays valid, and the read paths fall back to the populated product
    // for those — see the `items.product` selects in order.controller.js.
    author: {
      type: String,
      default: "",
      trim: true,
    },

    image: {
      type: String,
      default: "",
    },

    price: {
      type: Number,
      required: true,
      min: 0,
    },

    quantity: {
      type: Number,
      required: true,
      min: 1,
    },

    selectedVariants: {
      type: Map,
      of: String,
      default: {},
    },

    variantKey: {
      type: String,
      default: "",
    },

    cancelledQuantity: {
      type: Number,
      default: 0,
      min: 0,
    },

    refundedQuantity: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  { _id: false }
);

const OrderSchema = new mongoose.Schema(
  {
    // PlaceOrder now always requires a logged-in account, so this is always
    // set on new orders. Left optional (rather than `required: true`) so
    // historical guest orders placed before that change stay readable/savable.
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "UserAuthenticationModel",
      default: null,
    },

    // Legacy field from the guest-checkout era; no longer written by
    // PlaceOrder. Left on the schema so historical guest orders stay readable.
    guestEmail: {
      type: String,
      trim: true,
      lowercase: true,
      default: "",
    },

    idempotencyKey: {
      type: String,
      default: null,
    },

    items: {
      type: [OrderItemSchema],
      required: true,
      validate: {
        validator: (value) => value.length > 0,
        message: "Order must contain at least one product.",
      },
    },

    shippingAddress: {
      fullName: {
        type: String,
        required: true,
        trim: true,
      },

      phone: {
        type: String,
        required: true,
        trim: true,
      },

      address: {
        type: String,
        required: true,
        trim: true,
      },

      city: {
        type: String,
        required: true,
        trim: true,
      },

      state: {
        type: String,
        required: true,
        trim: true,
      },

      pincode: {
        type: String,
        required: true,
        trim: true,
      },

      country: {
        type: String,
        default: "India",
      },
    },

    paymentMethod: {
      type: String,
      enum: ["COD", "UPI", "CARD", "RAZORPAY"],
      default: "COD",
    },

    paymentStatus: {
      type: String,
      // "Refund Pending" means the store owes the customer money that hasn't
      // actually moved yet — a cancellation whose gateway refund failed, or a
      // COD refund waiting to be paid out by hand. Without it there was no way
      // to distinguish "we refunded them" from "we intend to", which is how the
      // system used to claim refunds it had never made.
      enum: [
        "Pending",
        "Paid",
        "Failed",
        "Refund Pending",
        "Refunded",
        "Partially Refunded",
      ],
      default: "Pending",
    },

    orderStatus: {
      type: String,
      enum: [
        "Pending",
        "Confirmed",
        "Packed",
        "Shipped",
        "Out For Delivery",
        "Delivered",
        "NDR",
        "RTO",
        // The parcel is physically back with the seller and inspected. Distinct
        // from "RTO" (which covers initiated and in-transit) because inventory and
        // refund obligations only become real on arrival — restocking or refunding
        // while a parcel is still on a truck is wrong in both directions.
        "RTO Received",
        "Cancelled",
        // How an RTO ends, once the parcel is back, its condition recorded and any
        // refund owed settled. Distinct from "Cancelled", which previously had to
        // serve both "called off before dispatch" and "shipped and came back" —
        // two states that need the same revenue treatment but mean different
        // things operationally.
        "Closed",
        // The admin's sign-off that a Delivered order's case is finished —
        // customer kept it, nothing pending. Counts as revenue (deliberately
        // NOT in NON_REVENUE_STATUSES) and ends self-service returns, which
        // gate on status "Delivered".
        "Completed",
      ],
      default: "Pending",
    },

    // When an unpaid Razorpay order stops being open. Cleared on promotion to Paid.
    // Without it an abandoned checkout would sit at Pending forever, and the sweeper
    // would have nothing to key on.
    paymentExpiresAt: {
      type: Date,
      default: null,
      index: true,
    },

    // Set once, the moment orderStatus first becomes "Delivered" (see
    // UpdateOrderStatus and the Shiprocket webhook handler) — this is what a
    // product's returnPolicy.windowDays counts down from. Orders placed
    // before this field existed will have it as null; return eligibility
    // for those falls back to "no window check" rather than blocking them.
    // Stamped when an RTO parcel is confirmed back with the seller and its units
    // are returned to sellable stock. Doubles as the idempotency claim, so a
    // retried courier webhook cannot restock the same parcel twice.
    rtoRestockedAt: {
      type: Date,
      default: null,
    },

    // Condition of the RTO parcel on arrival, recorded by whoever opens it. Same
    // separation as a return's disposition: the refund owed to a prepaid customer
    // does not depend on whether the goods survived the round trip.
    rtoDisposition: {
      type: String,
      enum: ["", "resellable", "damaged"],
      default: "",
    },
    rtoDispositionNote: {
      type: String,
      trim: true,
      maxlength: 500,
      default: "",
    },

    deliveredAt: {
      type: Date,
      default: null,
    },

    adminNotes: {
      type: [
        {
          note: { type: String, required: true, trim: true },
          createdBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "UserAuthenticationModel",
            required: true,
          },
          createdAt: { type: Date, default: Date.now },
        },
      ],
      default: [],
    },

    // Audit trail for every order-status change. Status mutations move money
    // (COD → Paid on delivery, refunds on cancel) and were previously entirely
    // untraceable — no history field and no audit-log call in the whole of
    // order.controller.js. `changedBy` is null for machine changes (courier
    // webhook) so a human change is distinguishable from an automated one.
    statusHistory: {
      type: [
        {
          from: { type: String, default: "" },
          to: { type: String, required: true },
          changedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "UserAuthenticationModel",
            default: null,
          },
          source: { type: String, default: "admin" },
          changedAt: { type: Date, default: Date.now },
        },
      ],
      default: [],
      _id: false,
    },

    // Why the customer cancelled the whole order (collected by
    // CancelOrderDialog and enforced in CancelOrder). Deliberately separate
    // from `cancellations[]` below, which records admin-driven *partial*,
    // per-product cancellations rather than one whole-order decision.
    cancellation: {
      reason: {
        type: String,
        trim: true,
        default: "",
      },
      details: {
        type: String,
        trim: true,
        maxlength: 1000,
        default: "",
      },
      cancelledAt: {
        type: Date,
        default: null,
      },
      // Who initiated the full cancellation. statusHistory records it too, but
      // the banner on the admin order page reads this subdocument alone —
      // without it every cancellation displayed as "Cancelled by customer".
      cancelledBy: {
        type: String,
        enum: ["customer", "admin"],
        default: "customer",
      },
    },

    cancellations: {
      type: [
        {
          product: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "ProductModel",
            required: true,
          },
          quantity: { type: Number, required: true, min: 1 },
          reason: { type: String, default: "" },
          refundAmount: { type: Number, default: 0, min: 0 },
          cancelledBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "UserAuthenticationModel",
            required: true,
          },
          cancelledAt: { type: Date, default: Date.now },
        },
      ],
      default: [],
    },

    shipments: {
      type: [
        {
          shipmentNumber: { type: String, required: true },
          items: [
            {
              product: {
                type: mongoose.Schema.Types.ObjectId,
                ref: "ProductModel",
                required: true,
              },
              quantity: { type: Number, required: true, min: 1 },
            },
          ],
          status: {
            type: String,
            enum: ["planned", "created", "shipped", "delivered", "cancelled"],
            default: "planned",
          },
          awbCode: { type: String, default: "" },
          courierName: { type: String, default: "" },
          createdBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "UserAuthenticationModel",
            required: true,
          },
          createdAt: { type: Date, default: Date.now },
        },
      ],
      default: [],
    },

    refunds: {
      type: [
        {
          // "razorpay" for gateway refunds, "manual" for COD/offline refunds
          // the admin settled out-of-band (UPI, bank transfer, cash).
          paymentProvider: { type: String, default: "razorpay" },
          // Razorpay's refund id, or — for manual refunds — whatever reference
          // the admin recorded (UPI txn id, bank UTR), so every rupee returned
          // is traceable to a real movement of money.
          //
          // Left ABSENT (not "") until the gateway actually issues an id. The
          // index below is UNIQUE + sparse, and `sparse` skips only documents
          // where the field is missing — a stored "" is indexed like any other
          // value, so the second intent-first refund anywhere in the system
          // would collide with E11000 and break the refund path. Same trap, and
          // the same fix, as razorpayOrderId / razorpayPaymentId below.
          providerRefundId: {
            type: String,
            set: (value) => (value === "" || value === null ? undefined : value),
          },
          // Stable key for one refund ATTEMPT, supplied by the caller (or
          // derived from the order + amount + reason when it isn't).
          //
          // This is what makes a refund idempotent: it is matched inside the
          // filter of the conditional $push that records the refund, so a
          // double-clicked button or a retried request adopts the existing
          // record instead of issuing a second real refund. It is also sent to
          // Razorpay as notes.refundKey, so an attempt whose response was lost
          // can be reconciled against the gateway rather than repeated.
          idempotencyKey: {
            type: String,
            set: (value) => (value === "" || value === null ? undefined : value),
          },
          providerPaymentId: { type: String, default: "" },
          // Set when this refund settles a specific return request. Doubles as
          // the double-refund guard: one processed refund per return, and it
          // makes a retry after a partial failure idempotent rather than paying
          // the customer twice.
          returnRequest: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "ReturnRequest",
            default: null,
          },
          amount: { type: Number, required: true, min: 0 },
          reason: { type: String, default: "" },
          // A four-state ledger, because "owed" and "attempted" are genuinely
          // different liabilities and collapsing them hid money:
          //   owed      liability recorded, nothing attempted yet. A COD payout
          //             sitting in the queue, or a prepaid RTO refund the operator
          //             still has to action. Previously these had NO ledger row at
          //             all until someone acted, so the liability was invisible.
          //   created   the gateway was called and the outcome is UNKNOWN
          //             (timeout). Never reuse for "failed" — see return-refund.service.js.
          //   processed money has demonstrably moved.
          //   failed    the gateway confirmed it did not move.
          status: {
            type: String,
            enum: ["owed", "created", "processed", "failed"],
            default: "created",
          },
          // How this refund gets confirmed, so a COD payout awaiting a human is
          // distinguishable from a gateway refund awaiting Razorpay. Both read as
          // "Refund Pending" on the order, but they need different queues and
          // different chasing.
          confirmationMethod: {
            type: String,
            enum: ["gateway", "manual"],
            default: "gateway",
          },
          // Why a gateway refund failed, so a stuck refund can be diagnosed and
          // retried instead of silently sitting in "created" forever.
          failureReason: { type: String, default: "" },
          // When someone last actually called the gateway for this refund.
          //
          // Claimed with a conditional update, which is what stops a SECOND
          // request refunding while the first is still in flight. Winning the
          // ledger row is not enough on its own: the loser would find status
          // `created`, ask Razorpay whether that refund exists, be told "no"
          // because the winner's call had not landed yet, and conclude the
          // earlier attempt never happened. "Not yet" is not "never".
          gatewayAttemptedAt: { type: Date, default: null },
          processedAt: { type: Date, default: null },
          createdBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "UserAuthenticationModel",
            default: null,
          },
          createdAt: { type: Date, default: Date.now },
        },
      ],
      default: [],
    },

    subtotal: {
      type: Number,
      required: true,
      min: 0,
    },

    shippingCharge: {
      type: Number,
      default: 0,
      min: 0,
    },

    tax: {
      type: Number,
      default: 0,
      min: 0,
    },

    discount: {
      type: Number,
      default: 0,
      min: 0,
    },

    walletDiscount: {
      type: Number,
      default: 0,
      min: 0,
    },

    // How much of walletDiscount has already been returned as wallet credit.
    // The cap lives in this field: cancel and return both refund only the
    // remaining headroom, so a partial cancel followed by a full cancel — or two
    // returns on one order — cannot hand the prepaid portion back twice.
    walletRefunded: {
      type: Number,
      default: 0,
      min: 0,
    },

    couponDiscount: {
      type: Number,
      default: 0,
      min: 0,
    },

    coupon: {
      type: String,
      default: null,
    },

    totalAmount: {
      type: Number,
      required: true,
      min: 0,
    },

    razorpayOrderId: {
      type: String,
      unique: true,
      sparse: true,
      index: true,
      // Same empty-string guard as razorpayPaymentId — same UNIQUE + sparse trap.
      set: (value) => (value === "" || value === null ? undefined : value),
    },

    razorpayPaymentId: {
      type: String,
      unique: true,
      sparse: true,
      index: true,
      // An empty string must never reach this field. The index is UNIQUE + sparse,
      // and `sparse` skips only documents where the field is ABSENT — a stored ""
      // is indexed like any other value, so a second "" collides with E11000.
      //
      // That matters much more under order-first: unpaid orders legitimately have
      // no payment id, so if anything ever wrote "" instead of leaving it unset,
      // the *second* unpaid checkout would fail and take checkout down entirely.
      // Normalising here makes that structurally impossible rather than a
      // convention every caller has to remember.
      set: (value) => (value === "" || value === null ? undefined : value),
    },

    razorpaySignature: {
      type: String,
      default: null,
    },

    paymentVerifiedAt: {
      type: Date,
      default: null,
    },

    /**
     * When the items this order bought were removed from the customer's cart.
     *
     * A claim, not a log line: cart cleanup SUBTRACTS ordered quantities, which is
     * not idempotent, and the confirmation path genuinely runs more than once — a
     * browser verify and a `payment.captured` webhook can arrive together and both
     * reach the post-commit block. Stamping this under a conditional update means
     * exactly one execution subtracts. See cart/cart-cleanup.service.js.
     */
    cartClearedAt: {
      type: Date,
      default: null,
    },

    /**
     * WHO carried the parcel and under WHAT tracking number — provider-neutral.
     *
     * Every shipment fact in this schema used to live under `shiprocket`, so a
     * seller shipping by hand — which is the actual operating mode, since
     * SHIPROCKET_AUTO_CREATE_ORDER defaults false — had nowhere to record a courier
     * or a tracking number except a field named after a provider they were not
     * using. The consequence was measurable rather than theoretical: every
     * delivered order in this database reached the customer with no courier name
     * and no tracking number recorded anywhere, and the customer's tracking panel
     * is gated on `shiprocket.awbCode`, so none of them could track anything.
     *
     * Deliberately a SIBLING of `shiprocket`, not a replacement. `shiprocket` keeps
     * every provider-specific identifier it owns — orderId, shipmentId, courierId,
     * statusCode, syncStatus — and remains the only thing the webhook resolves
     * against. This subdocument holds only the four facts that mean the same thing
     * whoever carries the parcel.
     */
    shipment: {
      provider: {
        type: String,
        enum: SHIPMENT_PROVIDERS,
        default: null,
      },
      carrierName: {
        type: String,
        trim: true,
        default: "",
      },
      // The customer-facing tracking number. For SHIPROCKET this mirrors
      // `shiprocket.awbCode`; for MANUAL it is whatever the courier issued.
      //
      // NOT uniquely indexed, and that is deliberate: `shiprocket_awbCode_unique`
      // is what the webhook resolves against and what H2-01 relies on, so a second
      // unique index over a mirror of the same value would reject the mirror write
      // itself once both carried the same AWB. Uniqueness stays where identity
      // lives.
      trackingNumber: {
        type: String,
        trim: true,
        default: "",
      },
      /**
       * Where the parcel is, in the order lifecycle's OWN vocabulary.
       *
       * Reusing ORDER_STATUSES rather than inventing a shipment enum is the whole
       * point: a second status machine would need its own transition table, its own
       * mapper from courier events, and its own set of illegal moves to get wrong.
       * `mapOrderStatus` already normalises Shiprocket's vocabulary into these
       * values, so the Shiprocket sync costs no new mapping logic at all.
       *
       * Written ONLY from the order's own status, in the same operation that sets
       * it — never independently. That restriction matters: an independently-written
       * copy of a status is free to drift out of step with the thing it describes,
       * which is exactly why shipment-cancellation-pending is derived rather than
       * stored (see order-shipping.service.js). This mirrors; it does not decide.
       */
      status: {
        type: String,
        enum: [...ORDER_STATUSES, null],
        default: null,
      },
      // Manual entry is a human typing into a box, so it gets the same audit trail
      // every other admin mutation in this schema has (statusHistory.changedBy,
      // partialCancellations.cancelledBy). A wrong tracking number is otherwise
      // untraceable to whoever entered it.
      updatedAt: {
        type: Date,
        default: null,
      },
      updatedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "UserAuthenticationModel",
        default: null,
      },
    },

    shiprocket: {
      orderId: {
        type: Number,
        default: null,
        index: true,
      },
      shipmentId: {
        type: Number,
        default: null,
        index: true,
      },
      awbCode: {
        type: String,
        default: null,
        index: true,
      },
      courierId: {
        type: Number,
        default: null,
      },
      courierName: {
        type: String,
        default: null,
      },
      status: {
        type: String,
        default: null,
      },
      statusCode: {
        type: Number,
        default: null,
      },
      syncStatus: {
        type: String,
        enum: [
          "not_created",
          "created",
          "awb_assigned",
          "pickup_scheduled",
          "ndr",
          "rto",
          "cancelled",
          "failed",
        ],
        default: "not_created",
      },
      ndrReason: {
        type: String,
        default: "",
      },
      rtoReason: {
        type: String,
        default: "",
      },
      package: {
        length: { type: Number, default: null },
        breadth: { type: Number, default: null },
        height: { type: Number, default: null },
        weight: { type: Number, default: null },
      },
      labelUrl: {
        type: String,
        default: null,
      },
      invoiceUrl: {
        type: String,
        default: null,
      },
      // Pickup handover document. A URL like labelUrl/invoiceUrl rather than the PDF —
      // Shiprocket hosts it, and re-generating for the same shipment is idempotent.
      manifestUrl: {
        type: String,
        default: null,
      },
      lastError: {
        type: String,
        default: null,
      },
      lastSyncedAt: {
        type: Date,
        default: null,
      },
    },
  },
  {
    timestamps: true,
  }
);

OrderSchema.index(
  { user: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: "string" } } },
);
OrderSchema.index({ user: 1, createdAt: -1 });
OrderSchema.index({ createdAt: -1 });
// Backs the admin Orders page's status filter (GetAllOrders), which always
// sorts by createdAt alongside any orderStatus filter it applies.
OrderSchema.index({ orderStatus: 1, createdAt: -1 });
OrderSchema.index({ "shiprocket.awbCode": 1, orderStatus: 1 });
/**
 * Courier identity, enforced by the database.
 *
 * The Shiprocket webhook resolves an order by these fields, and they carried
 * plain NON-UNIQUE indexes — so the lookup could legitimately match several orders
 * and the driver returned an arbitrary one. A `Delivered` event applied to the
 * wrong order stamps `deliveredAt` and flips a COD order to `Paid`, booking
 * revenue for cash nobody collected.
 *
 * PARTIAL, not sparse, and that distinction is load-bearing here. `sparse` skips
 * only ABSENT fields, and both of these are declared `default: null` — so 54 of 55
 * existing orders store an explicit `null`, which indexes like any other value. A
 * `unique + sparse` index would either fail to build on those duplicate nulls or
 * make the second shipment-less order collide with E11000. Keying the partial
 * filter on `$type` indexes only rows carrying a real identifier, which is exactly
 * the set that must be unique. Same reasoning as `user_1_idempotencyKey_1` above.
 *
 * Verified before adding: 0 duplicate real values in the live collection, so no
 * data cleanup was required.
 *
 * `shiprocket.orderId` is 1:1 with an order by construction — createShiprocketOrder
 * posts `order_id: String(order._id)`. `shiprocket.awbCode` is a single scalar for
 * the order's one shipment; per-shipment AWBs would live in `shipments[].awbCode`,
 * which nothing writes today.
 *
 * EXPLICITLY NAMED, and that matters for deployment. The plain indexes these
 * replace already own the auto-generated names `shiprocket.orderId_1` /
 * `shiprocket.awbCode_1`, and MongoDB refuses to redefine an index under an
 * existing name — so an auto-named version fails with IndexKeySpecsConflict on
 * every boot (autoIndex and syncIndexes alike), silently leaving the collection
 * non-unique. Distinct names let these build immediately, with no migration
 * ordering to get wrong; `npm run migrate:shipment-indexes` then drops the old
 * plain indexes, which are redundant once these exist.
 */
OrderSchema.index(
  { "shiprocket.orderId": 1 },
  {
    name: "shiprocket_orderId_unique",
    unique: true,
    partialFilterExpression: { "shiprocket.orderId": { $type: "number" } },
  },
);
OrderSchema.index(
  { "shiprocket.awbCode": 1 },
  {
    name: "shiprocket_awbCode_unique",
    unique: true,
    partialFilterExpression: { "shiprocket.awbCode": { $type: "string" } },
  },
);
/**
 * The refund webhook's lookup key, and the DB-level guard that one gateway
 * refund id can never be recorded against two orders.
 *
 * `refund.processed` / `refund.failed` resolve the order with
 * `findOne({"refunds.providerRefundId": id})`. Before this index that was a full
 * collection scan of `orders` on every refund webhook, and nothing stopped the
 * same Razorpay refund id appearing on two orders — where it would then resolve
 * to an arbitrary one of them.
 *
 * UNIQUE across documents is exactly the constraint that matters here: Razorpay
 * refund ids are globally unique, so two orders claiming one is always a bug.
 * Note that a unique index on an array-subdocument field CANNOT express "one per
 * array" — duplicate keys within a single document are de-duplicated before the
 * uniqueness check — so this does not replace the per-return guard, which is the
 * conditional $push in return-refund.service.js.
 *
 * `sparse` depends on un-issued refunds leaving the field ABSENT; see the setter
 * on providerRefundId above.
 */
OrderSchema.index({ "refunds.providerRefundId": 1 }, { unique: true, sparse: true });
OrderSchema.index({
  user: 1,
  "items.product": 1,
  orderStatus: 1,
  createdAt: -1,
});

export default mongoose.model("orders", OrderSchema);
