import mongoose from "mongoose";
import OrderModel from "./Order.model.js";
import UserProfile from "../profiles/UserProfile.model.js";
import ReferralSetting from "../referral/ReferralSetting.model.js";
import CheckoutSetting from "./CheckoutSetting.model.js";
import CodVerification from "./CodVerification.model.js";
import { isStockEnforced } from "../../config/features.config.js";
import {
  notifyOrderCancelled,
  notifyOrderClosed,
  notifyOrderCompleted,
  notifyOrderPlaced,
  notifyRefundInitiated,
  notifyRefundProcessed,
  notifyShipmentUpdated,
} from "../notifications/notification.service.js";
import {
  sendOrderCancelledEmail,
  sendOrderPlacedEmail,
  sendOrderClosedEmail,
  sendOrderCompletedEmail,
} from "../notifications/order-emails.js";
import UserModel from "../../model/User.model.js";
import { prepareOrderData } from "./order-pricing.service.js";
import {
  calculateCouponDiscount,
  releaseOrderCouponRedemption,
} from "../coupons/coupon.service.js";
import { ADMIN_PERMISSIONS, hasAdminRole } from "../../config/admin-permissions.config.js";
// No direct Shiprocket import here any more: courier calls, their feature-flag
// gating and their failure recording all live in order-shipping.service.js, so
// this controller states WHEN the shipment is cancelled and that module owns HOW.
import {
  cancelShipmentForCancelledOrder,
  syncOrderToShiprocketIfEnabled,
  evaluateCodPincodeRestriction,
} from "./order-shipping.service.js";
import { clearOrderedItemsFromCart } from "../cart/cart-cleanup.service.js";
import {
  decrementStock,
  incrementStock,
  resolveVariantId,
} from "../inventory/variant.service.js";
import { restockRtoOrder } from "../inventory/restock.service.js";
import { closeUnpaidCheckout } from "../payments/unpaid-checkout.service.js";
import { releaseRtoOrderCredits } from "./rto-compensation.service.js";
import { createAuditLog } from "../audit/audit-log.js";
import ReturnModel from "../returns/return.model.js";
import {
  AWAITING_PAYMENT_TTL_MS,
  EXCLUDE_AWAITING_PAYMENT,
  isAwaitingPayment,
} from "./order-visibility.js";
import {
  canAutoRefund,
  cancellationRefundKey,
  claimRefundSlot,
  findRefundReissue,
  proportionalRefundAmount,
  proportionalWalletRefund,
  recordRtoRefundObligation,
  restoreWalletCredit,
  settleGatewayRefund,
  sumOwedRefunds,
  sumRefunded,
} from "../payments/return-refund.service.js";
import { canTransitionOrderStatus } from "./order-status.rules.js";
// No direct Razorpay use here any more: every refund on this path goes through
// settleGatewayRefund, so the gateway call, its reconciliation key and the
// resulting ledger state live in one place rather than being re-implemented per
// cancellation path.
import { adminHasPermission } from "../../config/admin-access.service.js";
import { ensureBillNumber } from "./bill-number.service.js";
import { logLifecycleError } from "../../utils/lifecycle-logger.service.js";

const ADMIN_PURCHASE_MESSAGE =
  "Admin accounts cannot add products to cart or place orders. Please use a customer account.";

export const PreviewOrderPricing = async (req, res) => {
  try {
    const userId = req.user.id;
    if (hasAdminRole(req.user)) {
      return res.status(403).json({
        success: false,
        message: ADMIN_PURCHASE_MESSAGE,
      });
    }

    const {
      items = [],
      shippingAddress: rawShippingAddress,
      coupon,
      useWallet,
      paymentMethod,
    } = req.body;

    const preparedOrder = await prepareOrderData({
      items,
      rawShippingAddress,
      coupon,
      userId,
      redeemCoupon: false,
      useWallet: Boolean(useWallet),
      // The preview must quote the method the customer is actually looking at, or
      // the figure they are shown is not the figure they will be charged.
      paymentMethod,
    });

    return res.status(200).json({
      success: true,
      data: {
        subtotal: preparedOrder.subtotal,
        shippingCharge: preparedOrder.shippingCharge,
        tax: preparedOrder.tax,
        discount: preparedOrder.discount,
        couponDiscount: preparedOrder.couponDiscount,
        walletDiscount: preparedOrder.walletDiscount,
        totalAmount: preparedOrder.totalAmount,
        items: preparedOrder.orderItems.map((item) => ({
          productId: item.product,
          name: item.name,
          image: item.image,
          price: item.price,
          quantity: item.quantity,
          selectedVariants: item.selectedVariants,
          variantKey: item.variantKey,
        })),
      },
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || "Could not calculate checkout total",
    });
  }
};

// Order placement always requires a logged-in account (no guest checkout) —
// every order needs to be traceable to a real account.
export const PlaceOrder = async (req, res) => {
  let session;
  try {
    const userId = req.user.id;
    if (hasAdminRole(req.user)) {
      return res.status(403).json({
        success: false,
        message: ADMIN_PURCHASE_MESSAGE,
      });
    }

    const {
      items = [],
      shippingAddress: rawShippingAddress,
      paymentMethod,
      coupon,
      idempotencyKey,
      useWallet,
    } = req.body;

    if (!idempotencyKey || !/^[A-Za-z0-9_-]{16,100}$/.test(idempotencyKey)) {
      return res.status(400).json({
        success: false,
        message: "A valid checkout idempotency key is required",
      });
    }

    const existingOrder = await OrderModel.findOne({ user: userId, idempotencyKey });
    if (existingOrder) {
      return res.status(200).json({
        success: true,
        message: "Order already placed",
        order: existingOrder,
      });
    }

    if (String(paymentMethod || "cod").toLowerCase() !== "cod") {
      return res.status(400).json({
        success: false,
        message: "Online payments must be completed through Razorpay Checkout",
      });
    }

    const checkoutSettings = await CheckoutSetting.getSettings();
    if (!checkoutSettings.codEnabled) {
      return res.status(403).json({
        success: false,
        message: "Cash on Delivery is not available right now — please pay online through Razorpay.",
        code: "COD_DISABLED",
      });
    }

    // OTP verification is required per order, not per session — the record
    // is deleted the moment it's used (see below), so a stale/reused
    // verification from an earlier order can never satisfy this check.
    const verification = await CodVerification.findOne({ userId, isVerified: true }).sort({ verifiedAt: -1 });
    if (!verification) {
      return res.status(403).json({
        success: false,
        message: "Please verify your email with the OTP before placing a Cash on Delivery order.",
        code: "COD_OTP_REQUIRED",
      });
    }

    // Preview pricing only here — redemption happens inside the transaction
    // below, after stock is confirmed, so a coupon is never marked "used"
    // unless the order it was used for actually gets created.
    const preparedOrder = await prepareOrderData({
      items,
      rawShippingAddress,
      coupon,
      userId,
      redeemCoupon: false,
      useWallet: Boolean(useWallet),
      // A literal, not req.body: the guard at the top of this handler has already
      // refused every other method, so COD is a server-established fact here.
      paymentMethod: "COD",
    });

    if (checkoutSettings.codMinOrderAmount > 0 && preparedOrder.totalAmount < checkoutSettings.codMinOrderAmount) {
      return res.status(403).json({
        success: false,
        message: `Cash on Delivery is only available for orders above ₹${checkoutSettings.codMinOrderAmount}. Please pay online through Razorpay.`,
        code: "COD_BELOW_MIN",
      });
    }

    if (checkoutSettings.codMaxOrderAmount > 0 && preparedOrder.totalAmount > checkoutSettings.codMaxOrderAmount) {
      return res.status(403).json({
        success: false,
        message: `Cash on Delivery is only available for orders up to ₹${checkoutSettings.codMaxOrderAmount}. Please pay online through Razorpay.`,
        code: "COD_ABOVE_MAX",
      });
    }

    // Last COD gate, and deliberately the last thing before the transaction opens:
    // everything irreversible (order insert, stock decrement, coupon redemption,
    // wallet debit) happens inside withTransaction below, so a refusal here costs
    // nothing and leaves nothing to unwind.
    //
    // "COD" is passed as a literal rather than read from the body because the check at
    // the top of this handler has already refused every other payment method — at this
    // point COD is a server-established fact and req.body cannot influence it. The
    // pincode likewise comes from prepareOrderData's normalized address, not from the
    // raw request, so a client cannot pass a serviceable pincode to the check and a
    // different one to the courier.
    const codServiceability = await evaluateCodPincodeRestriction({
      paymentMethod: "COD",
      restrictionEnabled: checkoutSettings.codServiceabilityCheckEnabled,
      pincode: preparedOrder.shippingAddress?.pincode,
    });
    if (!codServiceability.allowed) {
      return res.status(403).json({
        success: false,
        message: codServiceability.message,
        code: codServiceability.code,
      });
    }

    session = await OrderModel.startSession();
    let order;
    await session.withTransaction(async () => {
      if (isStockEnforced()) {
        for (const item of preparedOrder.orderItems) {
          // Variant-aware: the chosen variant's stock is checked in the same
          // conditional update as the product total. Previously only the total was
          // checked, so a sold-out variant of an in-stock product still sold.
          const ok = await decrementStock({
            productId: item.product,
            quantity: item.quantity,
            variantId: await resolveVariantId(item.product, item.variantKey || ""),
            session,
          });
          if (!ok) {
            const error = new Error(`${item.name} no longer has enough stock`);
            error.statusCode = 409;
            throw error;
          }
        }
      }

      // Redeem the coupon atomically with order creation — if anything below
      // throws, the transaction rolls this back too, so a failed order never
      // leaves the coupon looking used.
      if (coupon) {
        await calculateCouponDiscount({
          couponId: coupon,
          userId,
          items,
          redeem: true,
          session,
        });
      }

      [order] = await OrderModel.create(
        [{
          user: userId,
          idempotencyKey,
          items: preparedOrder.orderItems,
          shippingAddress: preparedOrder.shippingAddress,
          paymentMethod: "COD",
          paymentStatus: "Pending",
          orderStatus: "Confirmed",
          subtotal: preparedOrder.subtotal,
          shippingCharge: preparedOrder.shippingCharge,
          tax: preparedOrder.tax,
          discount: preparedOrder.discount,
          couponDiscount: preparedOrder.couponDiscount,
          walletDiscount: preparedOrder.walletDiscount,
          totalAmount: preparedOrder.totalAmount,
          coupon: preparedOrder.couponId,
        }],
        { session },
      );

      // Consumed immediately — a COD OTP verification is good for exactly one
      // order, so the next COD order always needs a fresh code.
      await CodVerification.deleteMany({ userId, isVerified: true }, { session });

      // Referral Reward Logic: if first order, reward referrer
      // Same exclusion as the Razorpay path — an abandoned checkout is not a
      // prior order.
      const pastOrdersCount = await OrderModel.countDocuments({
        user: userId,
        _id: { $ne: order._id },
        ...EXCLUDE_AWAITING_PAYMENT,
      }).session(session);
      if (pastOrdersCount === 0) {
        const userProfile = await UserProfile.findOne({ userid: userId }).session(session);
        if (userProfile && userProfile.referredBy) {
          const referrerProfile = await UserProfile.findOne({ userid: userProfile.referredBy }).session(session);
          if (referrerProfile) {
            const settings = await ReferralSetting.getSettings();
            referrerProfile.walletBalance = (referrerProfile.walletBalance || 0) + settings.referrerRewardAmount;
            referrerProfile.totalWalletCreditEarned = (referrerProfile.totalWalletCreditEarned || 0) + settings.referrerRewardAmount;
            referrerProfile.totalReferrals = (referrerProfile.totalReferrals || 0) + 1;
            await referrerProfile.save({ session });
          }
        }
      }

      // Deduct wallet balance if used. Re-check the balance inside this same
      // transaction (not the earlier preview read) so two concurrent
      // checkouts can't both apply the same wallet balance and drive it negative.
      if (preparedOrder.walletDiscount > 0) {
        const walletUpdate = await UserProfile.updateOne(
          { userid: userId, walletBalance: { $gte: preparedOrder.walletDiscount } },
          { $inc: { walletBalance: -preparedOrder.walletDiscount } },
          { session }
        );
        if (walletUpdate.modifiedCount !== 1) {
          const error = new Error("Wallet balance is no longer sufficient for this order");
          error.statusCode = 409;
          throw error;
        }
      }
    });

    // A COD order is confirmed the moment this transaction commits, so the cart
    // is cleared here for the same reason as the Razorpay path — and post-commit
    // for the same reason too: a cart failure must not undo a placed order.
    // Idempotent via the order.cartClearedAt claim, so the repeat response served
    // to a re-submitted idempotencyKey above cannot subtract twice.
    await clearOrderedItemsFromCart({ order });

    await syncOrderToShiprocketIfEnabled(order);
    await notifyOrderPlaced(order);

    // The confirmation. Fire-and-forget, after the order is durable — a mail
    // failure must not fail a placed order.
    emailForOrder(order)
      .then((email) => sendOrderPlacedEmail({ order, email }))
      .catch(() => {});

    return res.status(201).json({
      success: true,
      message: "Order placed successfully",
      order,
    });
  } catch (error) {
    if (error?.code === 11000 && req.body?.idempotencyKey) {
      const order = await OrderModel.findOne({
        user: req.user.id,
        idempotencyKey: req.body.idempotencyKey,
      });
      if (order) {
        return res.status(200).json({ success: true, message: "Order already placed", order });
      }
    }
    // Structured, like every other lifecycle failure, instead of a bare console.log
    // in the checkout hot path.
    logLifecycleError("orders", "place_order_failed", error, {
      userId: req.user?.id,
      idempotencyKey: req.body?.idempotencyKey,
    });

    // A thrown `statusCode` means the message was written FOR the customer — "…no
    // longer has enough stock", "Wallet balance is no longer sufficient…" — and it
    // has to reach them to be actionable. Anything without one is an unexpected
    // failure whose message is internal detail, so it gets a fixed reply.
    const statusCode = error.statusCode || 500;
    return res.status(statusCode).json({
      success: false,
      message:
        statusCode === 500
          ? "We could not place your order just now. Please try again."
          : error.message,
    });
  } finally {
    if (session) await session.endSession();
  }
};

// One customer's own history is realistically small — but "realistically small" is an
// assumption about data, not a guarantee, and this response populates every line item
// of every order ever placed. The cap makes the worst case bounded. It is generous on
// purpose: the Orders page paginates and filters client-side within whatever it is
// given, so anything under the cap behaves exactly as before and needs no frontend
// change. Same shape as DEFAULT_ORDERS_LIMIT / MAX_ORDERS_LIMIT below.
const DEFAULT_MY_ORDERS_LIMIT = 200;
const MAX_MY_ORDERS_LIMIT = 1000;

export const GetMyOrders = async (req, res) => {
  try {
    const userId = req.user.id;
    const limit = Math.min(
      Math.max(Number.parseInt(req.query.limit, 10) || DEFAULT_MY_ORDERS_LIMIT, 1),
      MAX_MY_ORDERS_LIMIT,
    );

    // A checkout the customer abandoned is not something they ordered, so it does
    // not belong in "My Orders". They still reach it by id if the payment later
    // completes and it is promoted.
    // returnPolicy included so the customer's return-eligibility UI runs on
    // the real per-product policy, not the frontend's hardcoded fallback.
    const filter = { user: userId, ...EXCLUDE_AWAITING_PAYMENT };
    const orders = await OrderModel.find(filter)
      .populate("items.product", "name image price mrp brand author category_id returnPolicy")
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    // The true total, not `orders.length`, so a customer past the cap is not told
    // they have fewer orders than they do.
    const total = await OrderModel.countDocuments(filter);

    return res.status(200).json({
      success: true,
      total,
      returned: orders.length,
      limit,
      orders,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

// Admins narrow with filters instead of the page always loading the entire
// orders collection — the default (no filters) still returns only the most
// recent DEFAULT_LIMIT orders so the page stays fast as order volume grows.
const DEFAULT_ORDERS_LIMIT = 200;
const MAX_ORDERS_LIMIT = 1000;

export const GetAllOrders = async (req, res) => {
  try {
    // Hidden by default so counts and totals on this screen mean what they say.
    // `?includeAwaitingPayment=true` opts in, for diagnosing a stuck checkout.
    const includeAwaitingPayment = String(req.query.includeAwaitingPayment) === "true";
    const filter = includeAwaitingPayment ? {} : { ...EXCLUDE_AWAITING_PAYMENT };

    if (req.query.status) filter.orderStatus = req.query.status;

    if (req.query.from || req.query.to) {
      filter.createdAt = {};
      if (req.query.from) {
        const from = new Date(req.query.from);
        from.setHours(0, 0, 0, 0);
        filter.createdAt.$gte = from;
      }
      if (req.query.to) {
        const to = new Date(req.query.to);
        to.setHours(23, 59, 59, 999);
        filter.createdAt.$lte = to;
      }
    }

    const sortDir = req.query.sort === "oldest" ? 1 : -1;
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || DEFAULT_ORDERS_LIMIT, 1), MAX_ORDERS_LIMIT);

    const [orders, total] = await Promise.all([
      OrderModel.find(filter)
        .populate("user", "email roles")
        .populate("items.product", "name image price mrp brand author category_id returnPolicy")
        .sort({ createdAt: sortDir })
        .limit(limit)
        .lean(),
      OrderModel.countDocuments(filter),
    ]);

    return res.status(200).json({
      success: true,
      total,
      returned: orders.length,
      orders,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

export const GetSingleOrder = async (req, res) => {
  try {
    const { orderId } = req.params;

    const order = await OrderModel.findById(orderId)
      .populate("user", "email roles")
      .populate("items.product", "name image price mrp brand author category_id returnPolicy")
      .lean();

    if (!order) {
      return res.status(404).json({
        success: false,
        message: "Order not found",
      });
    }

    const isOwner = String(order.user?._id || order.user) === req.user.id;
    // orders:manage, not just "has some admin role" — an order exposes the
    // customer's name, phone, full address, email and payment ids, none of which
    // a CMS/theme-only admin account has any reason to read.
    const isAdmin =
      !isOwner && (await adminHasPermission(req.user, ADMIN_PERMISSIONS.ORDERS_MANAGE));

    if (!isOwner && !isAdmin) {
      return res.status(403).json({
        success: false,
        message: "Unauthorized",
      });
    }

    return res.status(200).json({
      success: true,
      order,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

/**
 * The dispositions that count as "the condition of this parcel has been recorded".
 *
 * Read off the schema rather than restated, because the same list already exists in
 * two places — the `rtoDisposition` enum and RecordRtoDisposition's own validation —
 * and a third hand-written copy is how the money-collected gate drifted (see
 * MONEY_COLLECTED_PAYMENT_STATUSES). Filtering the falsy member out is the whole
 * definition: the field defaults to "", so anything else in the enum means a human
 * has opened the box and said what was in it.
 *
 * Deliberately NOT a new boolean like `isRtoReadyToClose`. That would be a second
 * copy of a fact the existing fields already carry, free to disagree with them.
 */
const RECORDED_RTO_DISPOSITIONS = OrderModel.schema
  .path("rtoDisposition")
  .enumValues.filter(Boolean);

/**
 * True once the order has a shipment whose status the mirror describes.
 *
 * Read off the schema, like RECORDED_RTO_DISPOSITIONS, so a provider added to the
 * enum is covered without a second list here. `shipment.provider` defaults to null,
 * which is the "no shipment recorded" answer.
 */
const SHIPMENT_PROVIDERS_FOR_MIRROR = OrderModel.schema
  .path("shipment.provider")
  .enumValues.filter(Boolean);
const hasRecordedShipmentProvider = (order) =>
  SHIPMENT_PROVIDERS_FOR_MIRROR.includes(order?.shipment?.provider);

// The statuses a courier feed reports. A manual move to one of them is announced
// to the customer the same way the courier webhook announces it.
const SHIPMENT_NOTIFY_STATUSES = [
  "Shipped",
  "Out For Delivery",
  "NDR",
  "Delivered",
  "RTO",
  "RTO Received",
];

// The customer's email for lifecycle mails. Best-effort: a missing account or
// a lookup failure returns "", and the mail senders no-op on an empty address.
const emailForOrder = async (order) => {
  try {
    if (!order?.user) return "";
    const customer = await UserModel.findById(order.user).select("email").lean();
    return customer?.email || "";
  } catch {
    return "";
  }
};

/**
 * An admin moving an order's status by hand is a manual override of what the courier
 * feed and the checkout flow would otherwise decide, so it is audited like the other
 * order overrides (cancel, RTO disposition, shipment cancellation) rather than left
 * only in `statusHistory`, which records the move but not the request it came from.
 * Never throws: the status write is already durable.
 */
const auditStatusChange = (req, order, from, to) =>
  createAuditLog({
    admin: req.user?.id,
    action: "UPDATE_ORDER_STATUS",
    module: "ORDER",
    targetId: order._id,
    targetName: String(order._id),
    description: `Order status changed from ${from} to ${to}`,
    req,
  }).catch(() => null);

export const UpdateOrderStatus = async (req, res) => {
  try {
    const { orderId } = req.params;
    const { orderStatus } = req.body;

    let order = await OrderModel.findById(orderId);
    if (!order) {
      return res.status(404).json({
        success: false,
        message: "Order not found",
      });
    }

    // Cancelling is NOT a status change. CancelOrder restores stock, credits the
    // wallet, frees the coupon redemption and records the refund owed; this
    // endpoint does none of that, and it was the only path that could cancel an
    // order at all — so an admin using the status dropdown silently cancelled
    // without compensating anything. Routed to the real endpoint instead.
    if (orderStatus === "Cancelled") {
      return res.status(400).json({
        success: false,
        message:
          "Use Cancel Order rather than the status dropdown — cancelling has to restore stock, return any wallet credit and record the refund owed.",
        code: "USE_CANCEL_ENDPOINT",
        currentStatus: order.orderStatus,
      });
    }

    // Validates the TRANSITION, not just the value. Previously only enum
    // membership was checked and the current status was ignored entirely, so
    // any status could be set from any other — see order-status.rules.js for
    // the specific money-losing pairs that allowed.
    const transition = canTransitionOrderStatus(order.orderStatus, orderStatus);
    if (!transition.ok) {
      return res.status(400).json({
        success: false,
        message: transition.reason,
        code: "INVALID_STATUS_TRANSITION",
        currentStatus: order.orderStatus,
      });
    }

    // ── AN UNPAID PREPAID CHECKOUT IS NOT AN ORDER YET ───────────────────────
    // Pending → Confirmed and Pending → Packed are legal moves in the table, and for
    // a COD order (or a legacy row) they are what an operator means. For a Razorpay
    // order still awaiting capture they are not: the transition would put a
    // checkout nobody paid for into the fulfilment queue — reserved stock never
    // committed, wallet never debited, coupon never redeemed — and a later capture
    // could no longer promote it (the promotion is a compare-and-swap on
    // orderStatus "Pending"), so the customer's money would be refunded as an
    // orphan while the goods shipped. The payment confirms the order; an operator
    // cannot.
    if (
      order.orderStatus === "Pending" &&
      ["Confirmed", "Packed"].includes(orderStatus) &&
      isAwaitingPayment(order)
    ) {
      return res.status(409).json({
        success: false,
        message:
          "This prepaid order has not been paid for yet. It confirms itself when Razorpay captures the payment — it cannot be confirmed or packed by hand.",
        code: "PAYMENT_NOT_CAPTURED",
        currentStatus: order.orderStatus,
      });
    }

    // Same status re-submitted: nothing to do, and recording it would spam the
    // history. Return the order unchanged rather than erroring.
    if (order.orderStatus === orderStatus) {
      return res.status(200).json({
        success: true,
        message: "Order status unchanged",
        order,
      });
    }

    // ── CLOSING AN RTO REQUIRES ITS DISPOSITION (audit H2-05) ────────────────
    //
    // "Closed" is defined by the transition table as "the parcel is back, its
    // condition recorded, and any refund owed settled". The table could only
    // enforce the first part, so an admin could close an order the moment it
    // arrived — and RecordRtoDisposition accepts ONLY "RTO Received", while
    // "Closed" is terminal. The units were then neither restocked nor written off,
    // with no path back to record them: stock silently stranded by one click.
    //
    // Atomic on purpose. The generic path below is read-then-save, and
    // `statusHistory` is a subdocument array, which Mongoose does not version-guard
    // on $push — so two concurrent closes would both append a history entry for the
    // same move. Putting the precondition in the FILTER makes exactly one win, and
    // it is the same claim-in-filter shape used by every other state claim here.
    //
    // `orderStatus: "RTO Received"` is not a second transition check: the table
    // permits "Closed" only from there, so this is the CAS on the status that was
    // just validated. Closing restocks nothing — that already happened, or
    // deliberately did not, when the disposition was recorded.
    //
    // ── AND ITS REFUND SETTLED (G3) ──────────────────────────────────────────
    // The third clause of the definition — "any refund owed settled" — was not
    // enforced at all. A prepaid RTO records an `owed` refund on arrival, and an
    // operator could close the order the moment the parcel was inspected: "Closed"
    // is terminal and drops out of every working view, so the customer's money was
    // owed by an order nobody would ever open again. `owed` (nothing attempted) and
    // `created` (attempted, outcome unknown) both block; `processed` and `failed`
    // are settled facts. In the FILTER, with the other two preconditions, so a
    // refund recorded by a webhook a moment before the close is not raced past.
    if (orderStatus === "Closed") {
      const claimed = await OrderModel.findOneAndUpdate(
        {
          _id: order._id,
          orderStatus: "RTO Received",
          rtoDisposition: { $in: RECORDED_RTO_DISPOSITIONS },
          refunds: { $not: { $elemMatch: { status: { $in: ["owed", "created"] } } } },
        },
        {
          $set: {
            orderStatus: "Closed",
            // Same mirror rule as the generic move below: only an order that has a
            // shipment record gets its shipment status kept in step.
            ...(hasRecordedShipmentProvider(order) ? { "shipment.status": "Closed" } : {}),
          },
          $push: {
            statusHistory: {
              from: order.orderStatus,
              to: "Closed",
              changedBy: req.user?.id || null,
              changedAt: new Date(),
            },
          },
        },
        { returnDocument: "after" },
      );

      if (!claimed) {
        // Re-read to say WHICH precondition failed. Without this the operator gets
        // "something went wrong" on the one action that has a specific remedy:
        // record the disposition first.
        const current = await OrderModel.findById(order._id).select(
          "orderStatus rtoDisposition refunds",
        );
        if (current && !current.rtoDisposition) {
          return res.status(409).json({
            success: false,
            message:
              'Record the condition of the returned parcel before closing it — "resellable" puts the items back into stock, "damaged" writes them off. Closing first would strand them.',
            code: "RTO_DISPOSITION_REQUIRED",
            currentStatus: current.orderStatus,
          });
        }
        const outstandingRefunds = (current?.refunds || []).filter((refund) =>
          ["owed", "created"].includes(refund.status),
        );
        if (current?.orderStatus === "RTO Received" && outstandingRefunds.length > 0) {
          return res.status(409).json({
            success: false,
            message:
              "This order still owes the customer a refund. Pay it (Refund via Razorpay, or record the manual payout) before closing — a closed order drops out of every working view, and the debt with it.",
            code: "RTO_REFUND_OUTSTANDING",
            currentStatus: current.orderStatus,
            outstandingRefundAmount:
              Math.round(
                outstandingRefunds.reduce((sum, refund) => sum + Number(refund.amount || 0), 0) *
                  100,
              ) / 100,
          });
        }
        return res.status(409).json({
          success: false,
          message: "This order changed while it was being closed. Reload and try again.",
          code: "ORDER_CHANGED",
          currentStatus: current?.orderStatus ?? null,
        });
      }

      // Tell the customer their returned order's case is settled. Fire-and-
      // forget: the close is already durable.
      notifyOrderClosed({ orderId: claimed._id, userId: claimed.user || null }).catch(() => {});
      emailForOrder(claimed)
        .then((email) => sendOrderClosedEmail({ order: claimed, email }))
        .catch(() => {});

      await auditStatusChange(req, claimed, order.orderStatus, "Closed");

      return res.status(200).json({
        success: true,
        message: "Order closed",
        order: claimed,
      });
    }

    // ── THE GENERIC MOVE IS A COMPARE-AND-SWAP ON THE STATUS IT WAS READ FROM (S4) ──
    //
    // This used to be read → mutate → `order.save()`. Mongoose's save() writes the
    // fields it saw change, and `orderStatus` is a plain path with no version guard,
    // so the save carried no claim about what the status was by the time it landed.
    // An admin who picked "Shipped" from a dropdown opened a minute ago overwrote the
    // courier's "Delivered" that arrived in between — moving a delivered order
    // backwards, re-opening it to an RTO the courier would never send, and pushing a
    // `Delivered → Shipped` history entry for a move nobody made. Two admins
    // submitting the same move at once each pushed a history entry too, since
    // `statusHistory` is a subdocument array Mongoose does not version-guard on $push
    // (the reason the Closed path above was made atomic first).
    //
    // `orderStatus: previousStatus` in the FILTER is the status the transition and the
    // payment gate above were validated against. Everything they concluded is true
    // only of that status, so the write lands only while it still holds — the same
    // claim-in-filter shape as the Closed path, the manual-shipment advance and the
    // courier webhook.
    //
    // The `$set` is exactly what the old save changed, plus the shipment mirror.
    // Nothing else on the document is written, so a concurrent write to any OTHER
    // field (a refund row, a tracking number, an admin note) can no longer be lost
    // to a stale snapshot either.
    const previousStatus = order.orderStatus;
    const changedAt = new Date();
    const set = { orderStatus };
    // Only the first "Delivered" sets this — a later re-confirmation of the
    // same status shouldn't push the customer's return window forward. Read off the
    // snapshot, which the status CAS keeps honest: deliveredAt is only ever stamped
    // together with a move to Delivered, so if it had been stamped since the read,
    // the status would have moved too and this write would miss.
    if (orderStatus === "Delivered" && !order.deliveredAt) {
      set.deliveredAt = changedAt;
    }
    // `shipment.status` mirrors the order's own status and is written only in the
    // same operation that sets it (see the schema). An order with no provider has no
    // shipment to describe, so its mirror stays null rather than inventing one.
    if (hasRecordedShipmentProvider(order)) {
      set["shipment.status"] = orderStatus;
    }
    // Leaving NDR by hand clears the courier-side "ndr" flag, the same as a courier
    // event that moves the parcel on does (courier-event.service.js). Left behind,
    // it kept the order in the shipping-exceptions queue — which filters on
    // syncStatus — long after the delivery problem was resolved. A move to RTO
    // records that instead; anything else is back on an assigned AWB.
    if (order.shiprocket?.syncStatus === "ndr" && orderStatus !== "NDR") {
      set["shiprocket.syncStatus"] = orderStatus === "RTO" ? "rto" : "awb_assigned";
    }

    const updated = await OrderModel.findOneAndUpdate(
      { _id: order._id, orderStatus: previousStatus },
      {
        $set: set,
        // Money-affecting mutations were previously untraceable — no history field
        // and no audit log anywhere in this controller.
        $push: {
          statusHistory: {
            from: previousStatus,
            to: orderStatus,
            changedBy: req.user?.id || null,
            changedAt,
          },
        },
      },
      { returnDocument: "after" },
    );

    if (!updated) {
      // Re-read ONCE to say what happened. Not retried: the operator chose this move
      // while looking at the old status, and whether it still makes sense from the
      // new one (Delivered, say) is their call, not this endpoint's.
      const current = await OrderModel.findById(order._id);
      if (!current) {
        return res.status(404).json({
          success: false,
          message: "Order not found",
        });
      }
      // Someone else already made this exact move — a double-click, or two admins
      // acting on the same order. The order is where this caller wanted it, so it is
      // answered exactly like the same-status re-submit above, and no side effect
      // runs twice: whoever won the CAS ran them.
      if (current.orderStatus === orderStatus) {
        return res.status(200).json({
          success: true,
          message: "Order status unchanged",
          order: current,
        });
      }
      return res.status(409).json({
        success: false,
        message: `This order changed while you were editing it (it is now ${current.orderStatus}). Reload and try again.`,
        code: "ORDER_CHANGED",
        currentStatus: current.orderStatus,
      });
    }
    order = updated;

    // COD money is collected at the door, so delivery IS the payment event.
    // Without this a delivered COD order stayed "Pending" forever, leaving COD
    // revenue invisible to reporting and making a COD return's "customer already
    // paid" premise untrue. Guarded so a later status edit can't overwrite a
    // refund that has since been issued.
    //
    // Its own conditional write, the same one the courier webhook uses, and run only
    // because THIS request won the status CAS: a losing duplicate never reaches it,
    // and the payment precondition sits in the filter, so it cannot flip a payment
    // that changed after the order was read.
    if (orderStatus === "Delivered") {
      const promoted = await OrderModel.updateOne(
        { _id: order._id, paymentMethod: "COD", paymentStatus: "Pending" },
        { $set: { paymentStatus: "Paid" } },
      );
      if (promoted.modifiedCount === 1) order.paymentStatus = "Paid";
    }

    // ── A MANUAL "RTO RECEIVED" OWES THE SAME AS A COURIER ONE (G3) ──────────
    // The courier webhook records the prepaid refund obligation when it moves an
    // order to "RTO Received". An operator making the same move by hand — the
    // courier feed missed the arrival, or the parcel came back outside Shiprocket —
    // recorded nothing, so the ledger said the customer was owed nothing for goods
    // they paid for and never received. Same helper, same `RTO <id>` dedupe key, so
    // a webhook arriving later (or racing this) cannot owe it twice.
    //
    // After the status write and never thrown: the parcel IS back, and failing the
    // status change over a ledger write would leave the order claiming it is still
    // in transit. A failure is logged; the obligation can be recorded by replaying
    // the courier event or re-reading the order, both idempotent.
    if (orderStatus === "RTO Received") {
      try {
        const obligation = await recordRtoRefundObligation(order);
        // The obligation was written through the collection, so the in-memory
        // document is stale; the response should show the liability it created.
        if (obligation?.owed > 0) order = (await OrderModel.findById(order._id)) || order;
      } catch (error) {
        logLifecycleError("orders", "rto_refund_obligation_failed", error, {
          orderId: String(order._id),
          source: "manual_status_update",
        });
      }

      // The wallet balance and coupon use the order spent come back too — on COD
      // as well as prepaid, since an RTO delivered nothing. Its own try for the
      // same reason as the obligation above, and idempotent against the courier
      // webhook making the same move (see rto-compensation.service.js).
      try {
        const credits = await releaseRtoOrderCredits(order._id);
        if (credits.walletCredited > 0 || credits.couponReleased) {
          order = (await OrderModel.findById(order._id)) || order;
        }
      } catch (error) {
        logLifecycleError("orders", "rto_credit_release_failed", error, {
          orderId: String(order._id),
          source: "manual_status_update",
        });
      }
    }

    // Delivery is the point of supply, so it is where the bill of supply gets its
    // number. Three deliberate choices here:
    //
    // AFTER the status write, because the status change is what actually matters and is
    // already durable at this point; AWAITED, because the response below carries
    // the number back to the admin screen and a fire-and-forget mint would leave
    // it blank until a refetch; and CAUGHT, because a numbering failure must never
    // turn a successful delivery into a 500 — `npm run migrate:bill-numbers` is
    // the repair path, which is the second reason that script has to stay
    // re-runnable.
    //
    // The "Completed" arm is a BACKSTOP, not a second primary path: the transition
    // table makes Completed unreachable except from Delivered, so an order arriving
    // here as Completed either predates this feature or had its Delivered mint
    // fail. Do not "optimise" it away on the grounds that Delivered already covers
    // it. ensureBillNumber is a no-op when a number already exists.
    if (orderStatus === "Delivered" || orderStatus === "Completed") {
      try {
        const issued = await ensureBillNumber(order._id);
        if (issued?.order?.bill) order.bill = issued.order.bill;
      } catch (error) {
        logLifecycleError("orders", "bill_number_mint_failed", error, {
          orderId: String(order._id),
          orderStatus,
        });
      }
    }

    // A courier-type move made by hand tells the customer exactly what the courier
    // webhook would have: an operator recording a dispatch or a delivery the feed
    // missed is the same news to the customer. Only the request that won the status
    // CAS reaches here, so a double-click notifies once. Fire-and-forget.
    if (SHIPMENT_NOTIFY_STATUSES.includes(orderStatus)) {
      notifyShipmentUpdated({ orderId: order._id, status: orderStatus }).catch(() => {});
    }

    // The success sign-off: tell the customer their order completed. Fire-and-
    // forget, after the status write is durable.
    if (orderStatus === "Completed") {
      notifyOrderCompleted({ orderId: order._id, userId: order.user || null }).catch(() => {});
      emailForOrder(order)
        .then((email) => sendOrderCompletedEmail({ order, email }))
        .catch(() => {});
    }

    await auditStatusChange(req, order, previousStatus, orderStatus);

    return res.status(200).json({
      success: true,
      message: "Order status updated",
      order,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

export const AddOrderNote = async (req, res) => {
  try {
    const note = String(req.body?.note || "").trim();
    if (!note) {
      return res.status(400).json({ success: false, message: "Note is required" });
    }

    const order = await OrderModel.findByIdAndUpdate(
      req.params.orderId,
      {
        $push: {
          adminNotes: {
            note,
            createdBy: req.user.id,
            createdAt: new Date(),
          },
        },
      },
      { returnDocument: "after" },
    );
    if (!order) return res.status(404).json({ success: false, message: "Order not found" });

    return res.status(200).json({
      success: true,
      message: "Order note added",
      order,
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * The statuses a single line may be cancelled from.
 *
 * Confirmed and Packed only: the order is paid for (or is COD, which is created
 * Confirmed) and nothing has left the building. Pending is absent because the only
 * order that sits there is a prepaid checkout awaiting capture — there is nothing
 * to cancel a line of yet. Everything from Shipped onward is moving, and the paths
 * for that are a full cancellation of the courier booking (pre-pickup) or Returns
 * after delivery.
 */
const PARTIAL_CANCELLABLE_STATUSES = ["Confirmed", "Packed"];

/**
 * True once a parcel for this order exists outside the database — or is being
 * created.
 *
 * Three facts, any one of which is enough:
 *
 *   - a Shiprocket order that has not been cancelled. Shiprocket's /orders/cancel
 *     cancels a WHOLE order and its payload is fixed at creation, so a line
 *     cancelled here would still be picked, packed and — on COD — collected for.
 *   - a creation claim in flight (`syncStatus: "creating"`): the payload is being
 *     built from the document the claim returned, so a line cancelled now would
 *     ship anyway with no Shiprocket id yet to show for it.
 *   - a manually recorded tracking number: a human has already handed the parcel to
 *     a courier this system cannot talk to.
 *
 * Read from the session's snapshot inside PartialCancelOrder's transaction, so a
 * shipment created a moment before the cancel either shows here or makes the save
 * conflict and retry.
 */
const hasActiveShipment = (order) =>
  (Boolean(order?.shiprocket?.orderId) && order.shiprocket.syncStatus !== "cancelled") ||
  order?.shiprocket?.syncStatus === "creating" ||
  Boolean(String(order?.shipment?.trackingNumber || "").trim());

const partialCancelError = (message, statusCode, code) =>
  Object.assign(new Error(message), { statusCode, code });

export const PartialCancelOrder = async (req, res) => {
  let session;
  let refundOwed = false;
  let refundAmountOwed = 0;
  let walletCredited = 0;
  let refundKey = null;
  // Set when this request would cancel every remaining unit. That is not a
  // partial cancellation at all, and it is handed to executeOrderCancellation —
  // see below.
  let delegation = null;
  try {
    const { productId, quantity, reason = "" } = req.body || {};
    const cancelQuantity = Number(quantity);
    if (!productId || !Number.isInteger(cancelQuantity) || cancelQuantity < 1) {
      return res.status(400).json({
        success: false,
        message: "Product id and positive whole-number quantity are required",
      });
    }

    session = await OrderModel.startSession();
    let order;
    await session.withTransaction(async () => {
      // Reset per attempt: withTransaction re-runs this callback on a WriteConflict.
      refundOwed = false;
      refundAmountOwed = 0;
      walletCredited = 0;
      refundKey = null;
      delegation = null;
      order = await OrderModel.findById(req.params.orderId).session(session);
      if (!order) {
        throw partialCancelError("Order not found", 404);
      }

      // A checkout nobody has paid for has no line to cancel: nothing was taken,
      // so there is nothing to give back, and "Refund Pending" on it would claim a
      // liability that does not exist. The customer (or an admin) cancels the
      // whole checkout instead, which also releases its stock hold.
      if (isAwaitingPayment(order)) {
        throw partialCancelError(
          "This prepaid order has not been paid for yet, so there is nothing to cancel part of. Cancel the whole order instead.",
          409,
          "PAYMENT_NOT_CAPTURED",
        );
      }
      // Was a deny-list of Delivered/Cancelled, which let a line be cancelled on an
      // order already Shipped, Out For Delivery or in RTO — the parcel kept moving
      // with the unit in it while the customer was refunded for it (S1).
      if (!PARTIAL_CANCELLABLE_STATUSES.includes(order.orderStatus)) {
        throw partialCancelError(
          `An order that is "${order.orderStatus}" cannot be partially cancelled. Only Confirmed or Packed orders can — once dispatched, use Returns after delivery.`,
          409,
          "PARTIAL_CANCEL_NOT_ALLOWED",
        );
      }

      const itemIndex = order.items.findIndex(
        (entry) => String(entry.product) === String(productId),
      );
      const item = order.items[itemIndex];
      if (!item) {
        throw partialCancelError("Product was not found in this order", 404);
      }

      const remainingQuantity = item.quantity - (item.cancelledQuantity || 0);
      if (cancelQuantity > remainingQuantity) {
        throw partialCancelError(`Only ${remainingQuantity} item(s) can be cancelled`, 400);
      }

      // ── EMPTYING THE ORDER IS A FULL CANCELLATION (G4) ──────────────────────
      // Cancelling the last remaining unit used to flip orderStatus to "Cancelled"
      // right here, by assignment — outside the transition table. No statusHistory
      // entry, no `cancellation` record, the coupon redemption never released, the
      // customer never told, and the courier cancellation bolted on separately.
      // Every one of those is what executeOrderCancellation already does, under
      // its atomic status claim.
      //
      // So this transaction writes NOTHING in that case: it records what was
      // decided and hands over. The shared core re-claims the order with this
      // read's `cancellations` count in its filter, so a concurrent partial
      // cancellation that commits in between makes the claim miss (409) rather
      // than letting this request act on units it no longer describes.
      //
      // The active-shipment guard below deliberately does not apply here: a full
      // cancellation also cancels the courier booking, which is exactly the
      // remedy the guard's message points to.
      const totalRemainingAfter =
        order.items.reduce(
          (sum, entry) => sum + (entry.quantity - (entry.cancelledQuantity || 0)),
          0,
        ) - cancelQuantity;
      if (totalRemainingAfter === 0) {
        delegation = {
          fromOrder: order,
          productId: item.product,
          itemIndex,
          expectedCancellationCount: (order.cancellations || []).length,
        };
        return;
      }

      // ── NO PARTIAL CANCELLATION ONCE A PARCEL EXISTS (S1) ───────────────────
      // Checked on the session's read, inside the transaction — see
      // hasActiveShipment for what counts and why each one does.
      if (hasActiveShipment(order)) {
        throw partialCancelError(
          "A shipment already exists for this order, and a courier booking cannot be reduced by one item. Cancel the whole order instead (which also cancels the courier booking), or use Returns once it is delivered.",
          409,
          "PARTIAL_CANCEL_SHIPMENT_EXISTS",
        );
      }

      item.cancelledQuantity = (item.cancelledQuantity || 0) + cancelQuantity;
      // Valued against what the customer actually PAID, not the list price.
      // item.price is stored pre-discount while coupon/wallet reductions apply
      // at order level, so `price × qty` over-refunded every discounted order.
      // Shipping is excluded here for the same reason as a return, but for a
      // different fact: the remaining units still ship, so the parcel — and its
      // freight — is still incurred. Cancelling the LAST unit, where nothing ships
      // at all, is the full cancellation delegated above.
      let refundAmount = proportionalRefundAmount({
        unitPrice: item.price,
        quantity: cancelQuantity,
        orderSubtotal: order.subtotal,
        orderTotal: order.totalAmount,
        orderShippingCharge: order.shippingCharge,
      });

      // Never let cumulative refunds exceed what was taken. This path had no
      // ceiling at all, so successive partial cancellations could push the
      // total past the order value.
      const alreadyCommitted = sumRefunded(order);
      const headroom = Math.round((Number(order.totalAmount) - alreadyCommitted) * 100) / 100;
      if (refundAmount > headroom) refundAmount = Math.max(0, headroom);

      // The prepaid share of the same line. This path returned only the cash
      // half, so cancelling one item out of a wallet-discounted order quietly
      // kept the customer's credit. Capped by order.walletRefunded, so repeated
      // partial cancels (and a later full cancel) can't exceed what was spent.
      const walletShare = proportionalWalletRefund({
        unitPrice: item.price,
        quantity: cancelQuantity,
        orderSubtotal: order.subtotal,
        walletDiscount: order.walletDiscount,
      });
      walletCredited = await restoreWalletCredit({
        order,
        amount: walletShare,
        session,
      });

      order.cancellations.push({
        product: item.product,
        quantity: cancelQuantity,
        reason: String(reason).trim(),
        refundAmount,
        cancelledBy: req.user.id,
      });
      // Keyed on the cancellation that caused it, NOT on the order: a second
      // partial cancellation is a genuinely separate refund and must not look
      // like a duplicate of the first. The subdocument id exists as soon as it is
      // pushed, before the save.
      const cancellationRecord = order.cancellations.at(-1);
      refundKey = cancellationRefundKey({
        orderId: order._id,
        cancellationId: cancellationRecord._id,
      });

      if (isStockEnforced()) {
        await incrementStock({
          productId: item.product,
          quantity: cancelQuantity,
          variantId: await resolveVariantId(item.product, item.variantKey || ""),
          session,
        });
      }

      // Records that a refund is OWED. This used to assert
      // "Refunded"/"Partially Refunded" and push a record while never calling
      // the gateway at all — so the order claimed a refund that did not exist,
      // and the phantom record permanently lowered the ceiling for a later
      // genuine return. "Refund Pending" is the honest state; the gateway call
      // happens after this transaction commits.
      //
      // "Partially Refunded" is accepted alongside "Paid" so a second partial
      // cancellation on the same order is still refundable.
      //
      // "Refund Pending" belongs here for the same reason, and its absence was a
      // bug: it is where an earlier refund that has been RECORDED but not yet
      // SETTLED leaves the order — the normal state while Razorpay processes a
      // normal-speed refund, and the permanent state if the gateway is unreachable.
      // Money was collected, so a further cancellation is still owed. Without it,
      // the second partial cancellation on an order succeeded and silently recorded
      // no refund at all, and the customer simply lost the balance.
      //
      // "Refunded" is deliberately still absent: nothing is outstanding there, so
      // the `refundAmount > 0` guard below already handles it.
      const moneyCollected = ["Paid", "Partially Refunded", "Refund Pending"].includes(
        order.paymentStatus,
      );
      if (moneyCollected && refundAmount > 0) {
        order.paymentStatus = "Refund Pending";
        order.refunds.push({
          paymentProvider: order.paymentMethod === "RAZORPAY" ? "razorpay" : "manual",
          providerPaymentId: order.razorpayPaymentId || "",
          amount: refundAmount,
          reason: String(reason || "Partial cancellation").trim(),
          // `created` only when the gateway call below will actually be made: the
          // state means "the gateway was called and the outcome is unknown". A row
          // nothing will ever send — COD, or Razorpay switched off — is `owed`, so
          // it lands in the owed-refunds queue instead of reading as an attempt
          // stuck in flight that no queue ever offered for payment.
          status: canAutoRefund(order) ? "created" : "owed",
          confirmationMethod: order.paymentMethod === "RAZORPAY" ? "gateway" : "manual",
          idempotencyKey: refundKey,
          createdBy: req.user.id,
        });
        refundOwed = true;
        refundAmountOwed = refundAmount;
      }

      await order.save({ session });
    });

    // ── DELEGATED: THIS REQUEST CANCELS THE WHOLE ORDER ─────────────────────
    // Same core, same guarantees as CancelOrder/AdminCancelOrder: the status claim
    // (now also carrying the cancellations[] record and the line's cancelled
    // quantity), restock of exactly the units still outstanding, wallet and coupon
    // release, the outstanding balance — shipping included, since nothing ships —
    // recorded and refunded under a `partial-cancel:<id>` key, then the courier,
    // then the customer is told. The response keeps this endpoint's own shape.
    if (delegation) {
      const reasonText = String(reason || "").trim();
      const { order: cancelledOrder, shipmentCancellation, walletCredited: credited } =
        await executeOrderCancellation({
          order: delegation.fromOrder,
          orderId: req.params.orderId,
          cancelReason: reasonText.slice(0, 200) || "Partial cancellation",
          cancelDetails: "Every remaining item was cancelled individually.",
          actorId: req.user.id,
          source: "admin",
          allowedStatuses: PARTIAL_CANCELLABLE_STATUSES,
          partialCancellation: {
            productId: delegation.productId,
            itemIndex: delegation.itemIndex,
            quantity: cancelQuantity,
            reason: reasonText,
            cancelledBy: req.user.id,
            expectedCancellationCount: delegation.expectedCancellationCount,
          },
        });

      return res.status(200).json({
        success: true,
        message: credited > 0
          ? `Order item cancelled. ${credited} of wallet credit was returned to the customer's balance.`
          : "Order item cancelled",
        order: cancelledOrder,
        walletCredited: credited,
        orderFullyCancelled: true,
        shipmentCancelled: shipmentCancellation.cancelled,
        shipmentCancellationPending:
          Boolean(cancelledOrder.shiprocket?.orderId) && !shipmentCancellation.cancelled,
      });
    }

    // Money moves only after the cancellation is durably committed — an external
    // payment call inside the transaction could succeed while the transaction
    // rolled back.
    let refundStatus = null;
    if (refundOwed && canAutoRefund(order)) {
      const pending = order.refunds.find((entry) => entry.idempotencyKey === refundKey);
      if (pending) {
        // Same shared helper as the full-cancellation, returns and admin paths.
        // The behaviour here was already close to correct; what it lacked was
        // `notes.refundKey`, so a lost gateway response left a `created` row with
        // no way to ask Razorpay whether the money had actually gone.
        const settled = await settleGatewayRefund({
          order,
          refundId: pending._id,
          amount: refundAmountOwed,
          refundKey,
          reason: `Partial cancellation on order ${order._id}`,
        });
        order = await OrderModel.findById(req.params.orderId);
        refundStatus = settledRefundStatus(settled, order, pending._id);
      }
    }

    // No courier call on this path, by construction: it is reached only when the
    // order stays active AND has no shipment (the guard above), and Shiprocket's
    // /orders/cancel cancels a whole order and cannot express "one unit of two".

    // Tell the customer what THIS refund's gateway reply actually said. It used to
    // read the order's paymentStatus, which describes every refund on the order —
    // an earlier settled refund made this one look processed too.
    await notifyCancellationRefund({ order, refundStatus });

    return res.status(200).json({
      success: true,
      message: walletCredited > 0
        ? `Order item cancelled. ${walletCredited} of wallet credit was returned to the customer's balance.`
        : "Order item cancelled",
      order,
      walletCredited,
      // The order is still active on this path; an emptying request returns above.
      orderFullyCancelled: false,
      shipmentCancelled: false,
      shipmentCancellationPending: false,
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message,
      ...(error.code ? { code: error.code } : {}),
    });
  } finally {
    if (session) await session.endSession();
  }
};

/**
 * Retries the courier cancellation for an order already cancelled locally.
 *
 * The recovery path for a shipment left in the derived pending state — Shiprocket
 * timed out, was unreachable, or the process died between the local commit and the
 * call. Without this, a pending cancellation would have nowhere to go.
 *
 * Retrying is safe because the operation is idempotent in effect: it names one
 * Shiprocket order, the end state is terminal, and no money moves. This is exactly
 * why it needs none of the attempt-claim/verify-first machinery the refund paths
 * require — and an "already cancelled" reply is adopted as success, which is what
 * makes a lost response recoverable.
 *
 * It only ever cancels; it cannot un-cancel, re-dispatch, or touch the money.
 */
export const RetryShipmentCancellation = async (req, res) => {
  try {
    const { orderId } = req.params;
    const order = await OrderModel.findById(orderId);
    if (!order) {
      return res.status(404).json({ success: false, message: "Order not found" });
    }

    // Guard the precondition rather than trusting the caller: cancelling a
    // shipment for an order that is NOT cancelled locally would be the very
    // inversion this phase removed.
    if (order.orderStatus !== "Cancelled") {
      return res.status(409).json({
        success: false,
        message:
          "This order is not cancelled, so its shipment must not be cancelled. Use the cancel endpoint instead.",
        code: "ORDER_NOT_CANCELLED",
      });
    }

    if (!order.shiprocket?.orderId) {
      return res.status(400).json({
        success: false,
        message: "This order has no Shiprocket shipment to cancel.",
        code: "NO_SHIPMENT",
      });
    }

    const result = await cancelShipmentForCancelledOrder(order);
    const fresh = await OrderModel.findById(orderId);

    if (result.cancelled) {
      await createAuditLog({
        admin: req.user.id,
        action: "CANCEL_SHIPMENT",
        module: "ORDER",
        targetId: order._id,
        targetName: String(order._id),
        description: result.adopted
          ? `Shiprocket reported shipment ${order.shiprocket.orderId} already cancelled — adopted`
          : `Cancelled Shiprocket shipment ${order.shiprocket.orderId}`,
        req,
      });
      return res.status(200).json({
        success: true,
        message: result.adopted
          ? "Shiprocket had already cancelled this shipment"
          : "Shipment cancelled at Shiprocket",
        adopted: Boolean(result.adopted),
        order: fresh,
      });
    }

    if (result.reason === "shipping_disabled") {
      return res.status(503).json({
        success: false,
        message: "Shiprocket is disabled or not configured, so the shipment cannot be cancelled.",
        code: "SHIPPING_UNAVAILABLE",
      });
    }

    return res.status(502).json({
      success: false,
      message: `Shiprocket cancellation failed: ${result.error}. The order remains cancelled and this can be retried.`,
      code: "SHIPMENT_CANCEL_FAILED",
      order: fresh,
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message,
    });
  }
};

/**
 * Reconciles — and if genuinely necessary, retries — one unsettled refund row.
 *
 * The recovery path for a cancellation refund whose gateway response was lost.
 * Without it the reconciliation key would exist and nothing could ever use it:
 * a `created` row means "outcome unknown", and until now the only way to act on
 * one was to issue a NEW refund through the admin endpoint, which is exactly how
 * a customer gets paid twice.
 *
 * It never decides an amount and never creates a liability — the row already
 * exists and carries both. It asks Razorpay what happened, adopts the answer if
 * there is one, and only calls the gateway when the refund is confirmed absent.
 *
 * It is also how an OWED gateway refund gets paid (G2). A prepaid RTO records its
 * refund as `owed` — deliberately not pushed to the gateway from an unattended
 * courier feed — and until now nothing could ever pay it: this endpoint required a
 * reconciliation key the owed row never had, and the manual-settle endpoint
 * (correctly) refuses rows Razorpay can pay. The liability was visible and
 * permanently stuck. See the owed branch below.
 */
export const ReconcileOrderRefund = async (req, res) => {
  try {
    const { orderId, refundId } = req.params;
    let order = await OrderModel.findById(orderId);
    if (!order) {
      return res.status(404).json({ success: false, message: "Order not found" });
    }

    let record = order.refunds.id(refundId);
    if (!record) {
      return res.status(404).json({ success: false, message: "Refund record not found on this order" });
    }

    // ── AN OWED GATEWAY ROW: GIVE IT A KEY, THEN PAY IT LIKE ANY OTHER ───────
    // An `owed` row has never been sent anywhere, so there is nothing at Razorpay
    // to reconcile against — what it lacks is only the key that every gateway
    // attempt must carry in notes.refundKey (which is what makes a later lost
    // response recoverable). It is assigned here, ONCE, by a compare-and-swap on
    // the row still being owed and keyless: two operators pressing "Refund via
    // Razorpay" together both end up holding the same `owed:<refundId>` key, and
    // the gateway-attempt claim inside settleGatewayRefund then lets exactly one
    // of them call Razorpay. That claim is also where the row flips owed →
    // created, in the same write (claimGatewayAttempt).
    //
    // Deliberately NOT claimRefundSlot: the row is already in the ledger and
    // already counts toward the ceiling, so pushing a second row for the same
    // money would double it.
    //
    // A manual-confirmation row (a COD payout) is not the gateway's to pay at all,
    // and an order Razorpay cannot refund has no gateway path either; both are
    // refused before any key is written.
    if (record.status === "owed") {
      if (record.confirmationMethod === "manual" || !canAutoRefund(order)) {
        return res.status(400).json({
          success: false,
          message:
            "This refund cannot be paid through Razorpay. Pay the customer directly and record the payout and its reference from the owed refunds list.",
          code: "MANUAL_REFUND_ONLY",
        });
      }
      if (!record.idempotencyKey && !record.gatewayAttemptedAt) {
        await OrderModel.updateOne(
          {
            _id: order._id,
            refunds: {
              $elemMatch: {
                _id: record._id,
                status: "owed",
                // `null` matches a missing field as well as an explicit null — the
                // schema setter stores neither, but legacy rows may carry one.
                idempotencyKey: null,
              },
            },
          },
          { $set: { "refunds.$.idempotencyKey": `owed:${record._id}` } },
        );
        // Re-read whether this request set the key or a concurrent one did: either
        // way the row now carries it, and the gateway claim decides who proceeds.
        order = await OrderModel.findById(orderId);
        record = order?.refunds.id(refundId);
        if (!record) {
          return res.status(404).json({ success: false, message: "Refund record not found on this order" });
        }
      }
    }

    if (record.status === "processed") {
      return res.status(200).json({
        success: true,
        message: "This refund has already settled",
        idempotent: true,
        order,
      });
    }

    // The return this row settles, when it settles one. Its number is the key every
    // gateway refund for a return carries (notes.returnNumber), so it is how a
    // keyless return row is found at Razorpay and what a retry for it must carry.
    let returnNumber = null;
    if (record.returnRequest) {
      const returnDoc = await ReturnModel.findById(record.returnRequest)
        .select("returnNumber")
        .lean();
      returnNumber = returnDoc?.returnNumber || null;
    }

    // What the settle below is told. Defaults describe an ordinary keyed row.
    const originalRecord = record;
    let refundKey = record.idempotencyKey || null;
    let lookupNote;
    let extraNotes = returnNumber ? { returnNumber } : {};
    let forceLookup = false;
    let isRetry = false;

    // ── A FAILED ROW: RETRY IT AS A NEW ROW, NEVER BY REVIVING THE OLD ONE ────
    // `failed` is a settled fact — Razorpay said the money did not move — and the
    // row stays failed forever, so the ledger keeps the history. A retry is a new
    // refund, recorded as its own row before any gateway call, exactly like every
    // other refund: claimRefundSlot puts the idempotency key and the order-total
    // ceiling in the FILTER of one conditional push, so two operators pressing
    // "Retry refund" together create one row, and the gateway-attempt claim inside
    // settleGatewayRefund then lets one of them call Razorpay.
    //
    // The key is derived from the failed row's chain root (`retry:<rootId>`), so a
    // repeat of the same retry — from any failed link of the chain — adopts the
    // row it already created rather than issuing a second one. The REASON is copied unchanged on purpose: an RTO obligation is
    // recognised by its reason (`RTO <orderId>`), so a retry row carrying it is
    // what stops a replayed courier event from recording the debt a second time.
    if (record.status === "failed") {
      if (record.confirmationMethod === "manual" || !canAutoRefund(order)) {
        return res.status(400).json({
          success: false,
          message:
            "This refund cannot be retried through Razorpay. Pay the customer directly and record the payout and its reference from the owed refunds list.",
          code: "MANUAL_REFUND_ONLY",
        });
      }

      // ── ONE KEY PER RETRY CHAIN ───────────────────────────────────────────
      // A failed retry row is itself retryable, and keying ITS retry on its own id
      // gave every link of the chain a fresh key: A fails → retry R1 fails → retry
      // A again (R2, live) → retry R1 (R3, new key) paid the customer twice. Every
      // row of a chain therefore shares the root's key, so a live row anywhere in
      // the chain is found by claimRefundSlot and adopted, while a chain whose
      // every attempt failed can still be retried (failed rows never block).
      const retryKey = String(record.idempotencyKey || "").startsWith("retry:")
        ? record.idempotencyKey
        : `retry:${record._id}`;

      // ── ALREADY RE-ISSUED ANOTHER WAY ─────────────────────────────────────
      // The chain's own live row is adopted below; anything else that already pays
      // this money makes a retry a second payout: a failed RETURN refund re-issued
      // through the returns flow, or the same refund re-sent through the generic
      // Refund form after this one failed (findRefundReissue).
      const reissued = findRefundReissue(order, record, { includeChain: false });
      if (reissued) {
        return res.status(409).json({
          success: false,
          message: record.returnRequest
            ? "This return has already been refunded again through a newer refund on this order. Check that one instead — retrying this row would pay the customer twice."
            : "This refund has already been issued again through a newer refund on this order. Check that one instead — retrying this row would pay the customer twice.",
          code: "REFUND_ALREADY_REISSUED",
        });
      }

      const slot = await claimRefundSlot({
        orderId: order._id,
        idempotencyKey: retryKey,
        amount: record.amount,
        // The check above read the ledger; this repeats the return half of it in
        // the claim's filter, so a refund pushed from the Returns page in between
        // still stops the retry.
        blockIfLiveForReturn: record.returnRequest || null,
        record: {
          paymentProvider: "razorpay",
          providerPaymentId: record.providerPaymentId || order.razorpayPaymentId || "",
          returnRequest: record.returnRequest || null,
          reason: record.reason,
          status: "created",
          confirmationMethod: "gateway",
          createdBy: req.user.id,
        },
      });

      if (!slot.created && slot.refund?.status === "processed") {
        return res.status(200).json({
          success: true,
          message: "This refund was already retried, and the retry has settled",
          idempotent: true,
          order: slot.order,
        });
      }

      order = slot.order;
      record = order.refunds.id(slot.refund._id);
      if (!record) {
        return res.status(404).json({ success: false, message: "Refund record not found on this order" });
      }
      refundKey = retryKey;
      isRetry = true;
    } else if (!record.idempotencyKey) {
      // ── A KEYLESS ROW: RECONCILABLE IF RAZORPAY CAN STILL BE ASKED ABOUT IT ──
      // Rows written before reconciliation keys existed, and every return row (the
      // returns flow keys on returnNumber instead), have no notes.refundKey to
      // match. Two facts still identify them at Razorpay:
      //   - a recorded Razorpay refund id: the row is looked up by it directly;
      //   - a return: its gateway refunds all carry notes.returnNumber, so the
      //     lookup runs by that, forced, before anything is issued.
      // A row with neither has nothing to match on, and refunding it blindly is
      // the one thing this endpoint must never do.
      if (record.providerRefundId) {
        // settleGatewayRefund looks a `created` row with a refund id up by that id.
      } else if (record.returnRequest && returnNumber) {
        lookupNote = { key: "returnNumber", value: returnNumber };
        forceLookup = true;
      } else {
        return res.status(409).json({
          success: false,
          message:
            "This refund predates reconciliation keys, so it cannot be matched at Razorpay automatically. Check the Razorpay dashboard and settle it manually.",
          code: "REFUND_NOT_RECONCILABLE",
        });
      }
    }

    if (!canAutoRefund(order)) {
      return res.status(400).json({
        success: false,
        message:
          "This order was not paid through Razorpay, so there is nothing to reconcile. Record the payout and its reference instead.",
        code: "MANUAL_REFUND_ONLY",
      });
    }

    const result = await settleGatewayRefund({
      order,
      refundId: record._id,
      amount: record.amount,
      reason: record.reason || `Refund on order ${order._id}`,
      ...(refundKey ? { refundKey } : {}),
      ...(lookupNote ? { lookupNote } : {}),
      ...(Object.keys(extraNotes).length > 0 ? { extraNotes } : {}),
      ...(forceLookup ? { forceLookup } : {}),
    });

    const fresh = await OrderModel.findById(orderId);
    const refundStatus = result.refundStatus || fresh?.refunds.id(record._id)?.status || null;

    if (result.outcome === "in_progress") {
      return res.status(409).json({
        success: false,
        message:
          "This refund is already being processed. Reload the order in a moment — do not retry, or the customer could be refunded twice.",
        code: "REFUND_IN_PROGRESS",
      });
    }
    if (result.outcome === "unconfirmed") {
      return res.status(502).json({
        success: false,
        message: `Razorpay could not be reached to confirm whether this refund already landed: ${result.message}. Check the dashboard before retrying.`,
        code: "REFUND_RECONCILE_UNAVAILABLE",
      });
    }
    if (result.outcome === "gateway_failed") {
      return res.status(502).json({
        success: false,
        message: `Refund failed: ${result.message}. The attempt is recorded as pending — retrying will check with Razorpay first rather than refunding twice.`,
        code: "GATEWAY_REFUND_FAILED",
        order: fresh,
      });
    }
    if (result.outcome === "row_failed") {
      // The row turned `failed` between the read above and the settle (a webhook
      // or the poller recorded Razorpay's rejection). Retrying it is a separate,
      // deliberate action — the "Retry refund" button — not something to do here.
      return res.status(409).json({
        success: false,
        message:
          "Razorpay has reported this refund as failed. Reload the order and use Retry refund to issue a new one.",
        code: "REFUND_ROW_FAILED",
        order: fresh,
      });
    }

    const providerRefundId =
      result.providerRefundId || fresh?.refunds.id(record._id)?.providerRefundId || "";

    await createAuditLog({
      admin: req.user.id,
      action: "RECONCILE_REFUND",
      module: "PAYMENT",
      targetId: order._id,
      targetName: String(order._id),
      description:
        result.outcome === "reconciled"
          ? `Adopted existing Razorpay refund ${providerRefundId} for ₹${record.amount} (${refundStatus}) — no second refund issued`
          : isRetry
            ? `Retried failed refund ${originalRecord._id} of ₹${record.amount} through Razorpay (${providerRefundId}, ${refundStatus})`
            : originalRecord.status === "owed"
              ? `Paid owed refund of ₹${record.amount} through Razorpay (${providerRefundId}, ${refundStatus})`
              : `Issued Razorpay refund ${providerRefundId} for ₹${record.amount} after confirming none existed (${refundStatus})`,
      req,
    });

    // Razorpay rejected the refund outright. The row is `failed`; nothing moved.
    if (refundStatus === "failed") {
      return res.status(502).json({
        success: false,
        message:
          "Razorpay declined this refund, so no money moved. Check the failure reason on the refund row, then use Retry refund once it is resolved.",
        code: "GATEWAY_REFUND_REJECTED",
        order: fresh,
      });
    }

    // A refund this request issued is news for the customer; one it only adopted
    // was announced by whoever issued it (or by the sync that settled it). Nor one
    // the refund webhook settled — and announced — before Razorpay's reply was
    // written (`notified`).
    if (result.outcome === "refunded" && !result.notified) {
      const payload = { orderId: order._id, paymentId: order.razorpayPaymentId || null };
      if (refundStatus === "processed") {
        await notifyRefundProcessed(payload).catch(() => {});
      } else if (refundStatus === "created") {
        await notifyRefundInitiated(payload).catch(() => {});
      }
    }

    const pending = refundStatus === "created";
    return res.status(200).json({
      success: true,
      message: pending
        ? "Refund accepted by Razorpay — settles in 5–7 working days"
        : result.outcome === "reconciled"
          ? "Refund reconciled against Razorpay — no second refund was issued"
          : isRetry
            ? "Failed refund retried through Razorpay"
            : originalRecord.status === "owed"
              ? "Owed refund paid through Razorpay"
              : "Refund issued (Razorpay confirmed no earlier refund existed)",
      reconciled: result.outcome === "reconciled",
      ...(pending ? { pending: true } : {}),
      refundStatus,
      ...(isRetry ? { retriedRefundId: originalRecord._id, refundId: record._id } : {}),
      order: fresh,
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message,
      code: error.code,
    });
  }
};

/**
 * Records the condition of an RTO parcel on arrival, and restocks it if sellable.
 *
 * This is the RTO equivalent of a return's QC step, and it exists as a separate
 * human action for the same reason: the courier feed can tell us a parcel arrived,
 * but only a person opening the box can say whether its contents are still
 * sellable. The webhook therefore moves the order to "RTO Received" and records
 * any refund owed; restocking waits for this call.
 *
 * Claim-first and idempotent: restockRtoOrder stamps `rtoRestockedAt` under a
 * conditional update, so a double-clicked button restocks once.
 */
export const RecordRtoDisposition = async (req, res) => {
  try {
    const { orderId } = req.params;
    const disposition = String(req.body?.disposition || "").trim().toLowerCase();
    const dispositionNote = String(req.body?.dispositionNote || "").trim();

    if (!["resellable", "damaged"].includes(disposition)) {
      return res.status(400).json({
        success: false,
        message:
          'Record the condition of the returned parcel: "resellable" puts the items back into stock, "damaged" writes them off.',
        code: "DISPOSITION_REQUIRED",
      });
    }

    const order = await OrderModel.findById(orderId);
    if (!order) {
      return res.status(404).json({ success: false, message: "Order not found" });
    }
    // Only a parcel confirmed back with us can be inspected. Accepting this at
    // "RTO" would let stock be restocked while the parcel was still in transit —
    // the exact thing splitting these two states prevents.
    if (order.orderStatus !== "RTO Received") {
      return res.status(409).json({
        success: false,
        message: `This order is ${order.orderStatus}. A disposition can only be recorded once the parcel is marked "RTO Received".`,
        code: "NOT_RTO_RECEIVED",
        currentStatus: order.orderStatus,
      });
    }
    if (order.rtoDisposition) {
      return res.status(409).json({
        success: false,
        message: `This parcel was already recorded as ${order.rtoDisposition}.`,
        code: "DISPOSITION_ALREADY_RECORDED",
      });
    }

    order.rtoDisposition = disposition;
    order.rtoDispositionNote = dispositionNote;
    await order.save();

    const restockedQuantity = await restockRtoOrder({ orderId: order._id, disposition });

    await createAuditLog({
      admin: req.user.id,
      action: "RECORD_RTO_DISPOSITION",
      module: "ORDER",
      targetId: order._id,
      targetName: String(order._id),
      description:
        `RTO parcel recorded as ${disposition}` +
        (restockedQuantity > 0
          ? ` — ${restockedQuantity} unit(s) returned to stock`
          : " — written off, nothing restocked") +
        (dispositionNote ? ` (${dispositionNote})` : ""),
      req,
    });

    const owed = sumOwedRefunds(order);
    return res.status(200).json({
      success: true,
      message:
        disposition === "resellable"
          ? `Parcel recorded as resellable. ${restockedQuantity} unit(s) returned to stock.`
          : "Parcel recorded as damaged and written off. Nothing was returned to stock.",
      restockedQuantity,
      // Surfaced so the operator knows a prepaid refund is still outstanding —
      // the disposition settles the stock, not the money.
      refundOwed: owed,
      order: await OrderModel.findById(order._id),
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message,
    });
  }
};

// Mirrors CANCEL_REASONS in
// kitab-shop-fe/src/features/order-detail/CancelOrderDialog.jsx. Anything
// outside this list falls back to "Other" rather than being rejected — the
// reason is operational feedback, not something worth failing a cancellation
// (and blocking a refund) over.
const CANCEL_REASONS = [
  "Ordered by mistake",
  "Found a better price elsewhere",
  "Changed my mind",
  "Delivery is taking too long",
  "Want to change the address or payment method",
  "Other",
];

/**
 * What a cancellation refund's gateway call actually left the row at, for the
 * customer notice: "processed" | "created" | "failed", or null when there is
 * nothing to announce.
 *
 * Only an outcome where Razorpay actually answered about THIS refund counts:
 * `refunded` (this call issued it) or `reconciled` (an earlier attempt was found).
 * `gateway_failed`, `unconfirmed` and `in_progress` also report `created`, but
 * there it means "outcome unknown", which is not news for the customer. A notice
 * settleGatewayRefund already sent itself (`notified`) is not sent twice. Read per
 * ROW, never off the order's paymentStatus, which sums every refund on the order.
 */
const settledRefundStatus = (settled, order, refundId) => {
  if (!settled || settled.notified || settled.alreadySettled) return null;
  if (!["refunded", "reconciled"].includes(settled.outcome)) return null;
  return settled.refundStatus || order?.refunds?.id(refundId)?.status || null;
};

/**
 * Tells the customer about a cancellation refund, by the gateway's answer:
 * `processed` → refund processed; `created` (Razorpay accepted it, settlement
 * pending) → refund initiated; anything else — failed, an owed row nothing has
 * sent, an unknown outcome — says nothing, because nothing has demonstrably
 * moved. The poller and the refund webhook send "processed" when a pending one
 * settles. Never throws: the cancellation is already durable.
 */
const notifyCancellationRefund = async ({ order, refundStatus }) => {
  if (!order) return;
  const payload = { orderId: order._id, paymentId: order.razorpayPaymentId || null };
  if (refundStatus === "processed") {
    await notifyRefundProcessed(payload).catch(() => {});
  } else if (refundStatus === "created") {
    await notifyRefundInitiated(payload).catch(() => {});
  }
};

/**
 * Shared core of a FULL order cancellation — everything after the caller's own
 * authorisation/eligibility gates: the atomic status claim, restock, wallet
 * credit, coupon release, refund recording, post-commit gateway refund and the
 * courier cancellation. Extracted from CancelOrder unchanged so the customer
 * path keeps its exact behaviour; AdminCancelOrder reuses it with
 * source: "admin" and no owner/window checks.
 *
 * `order` is the caller's pre-claim read (used only for statusHistory.from);
 * the transaction re-claims against the collection, so a stale read here
 * cannot double-run any compensation. Throws on conflict (statusCode 409) —
 * callers translate errors into their own response shape.
 *
 * `partialCancellation` is set only by PartialCancelOrder, when a "cancel this
 * line" request would cancel every remaining unit. It makes the claim also push
 * the `cancellations[]` record and mark the line's units cancelled — in the same
 * atomic write, so the record exists exactly when the status flip does — and keys
 * the refund `partial-cancel:<cancellationId>`, the key that path has always used.
 * `expectedCancellationCount` is the caller's read of `cancellations.length`; it
 * goes in the claim filter so a concurrent partial cancellation committing in
 * between makes this claim miss instead of acting on a stale picture of the lines.
 */
const executeOrderCancellation = async ({
  order,
  orderId,
  cancelReason,
  cancelDetails,
  actorId,
  source,
  // Which statuses this caller may claim from. The customer path keeps the
  // original pair; the admin path also covers Packed (parcel booked but not
  // dispatched — the post-commit courier cancellation handles the shipment).
  allowedStatuses = ["Pending", "Confirmed"],
  partialCancellation = null,
}) => {
  let session;
  let refundOwed = false;
  let refundKey = null;
  let walletCredited = 0;
  // Set when the claimed order turned out to be a checkout nobody paid for. Its
  // clean-up (the payment intent and the stock hold) happens after commit.
  let unpaidCheckout = null;
  try {
    // The courier is told AFTER the local cancellation is committed — see the end
    // of this function. It used to be cancelled here, before the claim below, so
    // two concurrent cancellations both cancelled the shipment while only one
    // could win the claim: the loser had already cancelled a parcel for an order
    // it did not cancel, and a winner whose transaction then failed left an ACTIVE
    // order whose shipment was already dead at the courier.
    session = await OrderModel.startSession();
    let refundAmountOwed = 0;

    await session.withTransaction(async () => {
      // Reset per attempt: withTransaction re-runs this callback on a
      // WriteConflict, so anything accumulated outside it would double up.
      refundOwed = false;
      refundAmountOwed = 0;
      refundKey = null;
      walletCredited = 0;
      unpaidCheckout = null;

      // The delegated partial cancellation's record and preconditions. The id is
      // minted here, per attempt, so the refund key can be derived from it before
      // anything is written.
      const cancellationId = partialCancellation ? new mongoose.Types.ObjectId() : null;
      const claimPrecondition = partialCancellation
        ? { cancellations: { $size: partialCancellation.expectedCancellationCount } }
        : {};
      const claimRecord = partialCancellation
        ? {
            $push: {
              cancellations: {
                _id: cancellationId,
                product: partialCancellation.productId,
                quantity: partialCancellation.quantity,
                reason: partialCancellation.reason || "",
                // Filled in below from the claimed snapshot, once the outstanding
                // balance is known — see `outstanding`.
                refundAmount: 0,
                cancelledBy: partialCancellation.cancelledBy,
                cancelledAt: new Date(),
              },
            },
            $inc: {
              [`items.${partialCancellation.itemIndex}.cancelledQuantity`]:
                partialCancellation.quantity,
            },
          }
        : { $push: {} };

      // ─── ATOMIC CLAIM ───────────────────────────────────────────────────
      // The status gate above ran against a read taken OUTSIDE this session,
      // so two concurrent cancels could both pass it. Claiming the transition
      // here — with the permitted statuses in the FILTER — means exactly one
      // execution can ever win, and every compensation below runs at most
      // once. Without this, a retried callback re-credited the wallet,
      // re-restored stock and pushed a second refund for the same order.
      const claimed = await OrderModel.findOneAndUpdate(
        { _id: orderId, orderStatus: { $in: allowedStatuses }, ...claimPrecondition },
        {
          ...claimRecord,
          $set: {
            orderStatus: "Cancelled",
            cancellation: {
              reason: cancelReason,
              details: cancelDetails,
              cancelledAt: new Date(),
              cancelledBy: source,
            },
            // The shipment fields are deliberately NOT touched here. Writing
            // syncStatus "cancelled" inside this transaction would assert
            // something that has not happened — the courier has not been told
            // yet — and that is the one thing this codebase never does. It is set
            // only once Shiprocket confirms, below; until then the pending state
            // is derivable (SHIPMENT_CANCELLATION_PENDING).
          },
          $push: {
            ...claimRecord.$push,
            statusHistory: {
              from: order.orderStatus,
              to: "Cancelled",
              changedBy: actorId,
              source,
              changedAt: new Date(),
            },
          },
        },
        { session, returnDocument: "before" },
      );

      if (!claimed) {
        const conflict = new Error(
          "This order is no longer cancellable — it may already have been cancelled or dispatched.",
        );
        conflict.statusCode = 409;
        throw conflict;
      }

      // ── AN UNPAID CHECKOUT HAD NOTHING TAKEN, SO NOTHING IS GIVEN BACK (G1) ──
      // A prepaid order awaiting capture has not committed anything yet: its stock
      // is HELD by a reservation (decremented once, at reservation time), and the
      // wallet debit and coupon redemption both happen only at capture, inside
      // completeCapturedIntent. Running the compensations below on it was three
      // separate bugs at once — the units were restored here AND again when the
      // reservation was released or expired (double restock, phantom stock), the
      // order's walletDiscount was credited to a customer who was never debited
      // it, and a coupon redemption that was never made was "released", freeing a
      // slot someone else had genuinely used.
      //
      // And it left paymentStatus at "Pending", which is what let a late capture
      // resurrect the cancelled order to Confirmed/Paid. "Failed" is the honest
      // state — no money was ever collected for this order — and it takes the row
      // out of the abandoned-checkout sweeper's reach too. Filtered on the same
      // awaiting-payment shape, inside this transaction, so it cannot overwrite a
      // capture that won the race (that capture would have changed the status and
      // made the claim above see a paid order instead).
      //
      // The stock hold and the payment intent live outside this transaction and
      // are closed after commit — see closeUnpaidCheckout
      // (payments/unpaid-checkout.service.js).
      if (isAwaitingPayment(claimed)) {
        await OrderModel.updateOne(
          { _id: claimed._id, paymentMethod: "RAZORPAY", paymentStatus: "Pending" },
          { $set: { paymentStatus: "Failed", paymentExpiresAt: null } },
          { session },
        );
        unpaidCheckout = {
          orderId: claimed._id,
          razorpayOrderId: claimed.razorpayOrderId || null,
        };
        return;
      }

      // Everything below is driven from `claimed`, the pre-cancellation
      // snapshot, rather than the stale outer read.
      if (isStockEnforced()) {
        for (const item of claimed.items) {
          // Units already returned to stock by a partial cancellation must not
          // be restored a second time — restoring item.quantity outright gave
          // back 5 units for a 3-unit order after a 2-unit partial cancel.
          const restoreQuantity =
            Math.max(0, (Number(item.quantity) || 0) - (Number(item.cancelledQuantity) || 0));
          if (restoreQuantity > 0) {
            await incrementStock({
              productId: item.product,
              quantity: restoreQuantity,
              variantId: await resolveVariantId(item.product, item.variantKey || ""),
              session,
            });
          }
        }
      }

      // Reverse the wallet credit this order spent, and free up the coupon
      // redemption so the customer can use it again — mirrors the debit/redeem
      // done at order placement (order-pricing.service.js / coupon.service.js).
      //
      // Routed through restoreWalletCredit rather than incrementing the balance
      // directly, because a partial cancellation or a return may already have
      // given part of it back. The old unconditional $inc handed the whole
      // walletDiscount over a second time in that case.
      walletCredited = await restoreWalletCredit({
        order: claimed,
        amount: claimed.walletDiscount,
        session,
      });

      // Shared with the RTO path (releaseRtoOrderCredits), and claimed per order
      // through `couponReleasedAt`, so however an order ends without being
      // delivered its redemption is handed back exactly once. In this session, so
      // a rolled-back cancellation leaves the coupon redeemed.
      await releaseOrderCouponRedemption({ orderId: claimed._id, session });

      // Record that a refund is OWED, not that it happened. The gateway call is
      // deliberately made after this transaction commits: calling an external
      // payment API inside a DB transaction risks the money moving while the
      // transaction rolls back, leaving a refunded customer with a live order.
      // "Refund Pending" is the honest interim state.
      //
      // "Partially Refunded" counts as money-collected too: gating only on
      // "Paid" meant that once a partial cancellation had moved the status, a
      // later full cancellation refunded nothing at all. The outstanding
      // balance is what is owed, not the whole order total.
      // "Refund Pending" included for the same reason as in PartialCancelOrder: it is
      // where an unsettled earlier refund leaves the order, and money was still
      // collected. Its absence meant a full cancellation following a partial one
      // recorded nothing for the remaining balance — the same bug, on a larger
      // amount. "Refunded" is not needed: `outstanding` is 0 there and the guard
      // below already stops it.
      const moneyCollected = ["Paid", "Partially Refunded", "Refund Pending"].includes(
        claimed.paymentStatus,
      );
      const outstanding =
        Math.round((Number(claimed.totalAmount) - sumRefunded(claimed)) * 100) / 100;

      // The delegated partial cancellation's record carries the value it
      // cancelled, exactly as PartialCancelOrder's own records do: the outstanding
      // balance, shipping included, because emptying the order means nothing ships.
      // Recorded whether or not money was collected — on COD it is the amount no
      // longer to be collected, which is what the field has always meant there.
      if (cancellationId && outstanding > 0) {
        await OrderModel.updateOne(
          { _id: claimed._id, "cancellations._id": cancellationId },
          { $set: { "cancellations.$.refundAmount": outstanding } },
          { session },
        );
      }

      if (moneyCollected && outstanding > 0) {
        // One full cancellation per order — the status claim above guarantees a
        // single execution — so the order id is a stable key. Carried into
        // notes.refundKey at the gateway, which is what lets a lost response be
        // reconciled instead of being retried blindly.
        //
        // A delegated partial cancellation keeps the key that path has always
        // used, `partial-cancel:<cancellationId>`, so a refund is reconciled the
        // same way whichever line of reasoning recorded it.
        refundKey = cancellationId
          ? cancellationRefundKey({ orderId: claimed._id, cancellationId })
          : cancellationRefundKey({ orderId: claimed._id });
        await OrderModel.updateOne(
          { _id: claimed._id },
          {
            $set: { paymentStatus: "Refund Pending" },
            $push: {
              refunds: {
                paymentProvider: claimed.paymentMethod === "RAZORPAY" ? "razorpay" : "manual",
                providerPaymentId: claimed.razorpayPaymentId || "",
                amount: outstanding,
                reason: `Order cancelled by ${source} — ${cancelReason}`,
                // `created` only when the post-commit gateway call below will be
                // made; otherwise the liability is `owed` and waits in the
                // owed-refunds queue (see PartialCancelOrder for why).
                status: canAutoRefund(claimed) ? "created" : "owed",
                confirmationMethod: claimed.paymentMethod === "RAZORPAY" ? "gateway" : "manual",
                idempotencyKey: refundKey,
                createdBy: actorId,
              },
            },
          },
          { session },
        );
        refundOwed = true;
        refundAmountOwed = outstanding;
      }
    });

    // The in-memory `order` is now stale (the transaction wrote via the
    // collection, not this document), so re-read before using or returning it.
    order = await OrderModel.findById(orderId);

    // Expires the payment intent and releases the stock hold — shared with the
    // abandoned-checkout sweeper (payments/unpaid-checkout.service.js). Never throws.
    if (unpaidCheckout) await closeUnpaidCheckout(unpaidCheckout);

    // Now that the cancellation is durably committed, actually move the money.
    // A failure here leaves the order cancelled and the refund visibly pending
    // with its reason recorded, so it can be retried — never silently lost.
    let refundStatus = null;
    if (refundOwed && order && canAutoRefund(order)) {
      // Located by its key, not by position: `.at(-1)` happened to work only
      // because nothing else could have appended in between.
      const pendingRefund = order.refunds.find(
        (entry) => entry.idempotencyKey === refundKey,
      );
      if (pendingRefund) {
        // Shared with the returns, admin and partial-cancellation paths. This
        // block used to hand-roll the gateway call, and got two things wrong that
        // the shared helper does not:
        //
        //   - a gateway error wrote status "failed". `failed` is excluded from
        //     sumRefunded and from the duplicate lookup, so the ceiling sprang
        //     back to full and a later retry could refund money that had in fact
        //     already left — the customer paid twice.
        //   - success wrote "processed" and asserted paymentStatus "Refunded"
        //     without looking at refund.status, so an order could claim to be
        //     refunded on the strength of a refund Razorpay had only accepted as
        //     `pending` (its normal-speed default) and might yet fail.
        //
        // paymentStatus is now derived from the ledger rather than asserted here.
        const settled = await settleGatewayRefund({
          order,
          refundId: pendingRefund._id,
          // The outstanding balance, not the whole order total — a prior partial
          // cancellation may already have refunded part of it.
          amount: refundAmountOwed,
          refundKey,
          reason: `Cancelled order ${order._id}`,
        });
        order = await OrderModel.findById(orderId);
        refundStatus = settledRefundStatus(settled, order, pendingRefund._id);
      }
    }

    // ── TELL THE COURIER, LAST ───────────────────────────────────────────────
    // Everything local is durable by now: the cancellation claim, the restock, the
    // wallet credit, the coupon release and the refund. Only the request that WON
    // the claim reaches this line, so exactly one Shiprocket cancellation is ever
    // attempted per order.
    //
    // A failure here does not fail the cancellation. Safe because cancellation is
    // only permitted before dispatch (Pending/Confirmed, plus Packed for an admin
    // or a delegated partial cancellation) and every fulfilment
    // endpoint refuses a Cancelled order (ensureFulfillable), so the parcel cannot
    // be progressed by this system afterwards. The shipment is left in the derived
    // pending state with the reason recorded, and is retryable.
    const shipmentCancellation = await cancelShipmentForCancelledOrder(order);
    if (shipmentCancellation.attempted && shipmentCancellation.cancelled) {
      order = await OrderModel.findById(orderId);
    }

    // Only claim a refund to the customer once Razorpay has said so — and say
    // "initiated" when it has only accepted it.
    await notifyCancellationRefund({ order, refundStatus });

    // Tell the customer. Queue row for future channels + a real email now —
    // both fire-and-forget: the cancellation is already durable, and a mail
    // failure must not turn a completed cancellation into an error response.
    notifyOrderCancelled({
      orderId: order._id,
      userId: order.user || null,
      reason: cancelReason,
      source,
    }).catch(() => {});
    emailForOrder(order)
      .then((email) =>
        sendOrderCancelledEmail({
          order,
          email,
          reason: cancelReason,
          source,
          autoRefund: canAutoRefund(order),
        }),
      )
      .catch(() => {});

    return { order, shipmentCancellation, walletCredited };
  } finally {
    if (session) await session.endSession();
  }
};

export const CancelOrder = async (req, res) => {
  try {
    const { orderId } = req.params;
    const rawReason = String(req.body?.reason || "").trim();
    const cancelReason = CANCEL_REASONS.includes(rawReason) ? rawReason : "Other";
    const cancelDetails = String(req.body?.details || "").trim().slice(0, 1000);

    const order = await OrderModel.findById(orderId);

    if (!order) {
      return res.status(404).json({
        success: false,
        message: "Order not found",
      });
    }

    // Legacy guest orders permit user: null, so calling .toString() on it threw
    // a TypeError that surfaced as a 500 instead of a clean 403.
    if (!order.user || order.user.toString() !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: "Unauthorized",
      });
    }

    // A customer can only self-cancel before the order has actually shipped
    // (Pending/Confirmed). Once it's Packed/Shipped/Out For Delivery, the
    // package is already moving through Shiprocket, so the correct path is
    // the Returns flow (after delivery) rather than a cancellation here.
    if (order.orderStatus !== "Pending" && order.orderStatus !== "Confirmed") {
      return res.status(400).json({
        success: false,
        message: "Order cannot be cancelled",
      });
    }

    // Admin-configurable free-cancellation window, counted from order creation.
    // 0 keeps the original behaviour (no time limit — only the shipped-status
    // check above applies). Enforced here and not just in the UI, since the
    // endpoint is callable directly.
    const { cancellationWindowHours } = await CheckoutSetting.getSettings();
    if (cancellationWindowHours > 0) {
      const hoursSincePlaced = (Date.now() - order.createdAt.getTime()) / (60 * 60 * 1000);
      if (hoursSincePlaced > cancellationWindowHours) {
        return res.status(400).json({
          success: false,
          message: `Orders can only be cancelled within ${cancellationWindowHours} hour(s) of being placed. Please contact support for help with this order.`,
          code: "CANCEL_WINDOW_CLOSED",
        });
      }
    }

    const { order: cancelledOrder, shipmentCancellation } = await executeOrderCancellation({
      order,
      orderId,
      cancelReason,
      cancelDetails,
      actorId: req.user.id,
      source: "customer",
    });

    return res.status(200).json({
      success: true,
      message: "Order cancelled successfully",
      order: cancelledOrder,
      // Surfaced so an admin can see a shipment still awaiting cancellation at the
      // courier instead of having to infer it. The order itself IS cancelled.
      shipmentCancelled: shipmentCancellation.cancelled,
      shipmentCancellationPending:
        Boolean(cancelledOrder.shiprocket?.orderId) && !shipmentCancellation.cancelled,
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message,
    });
  }
};

/**
 * Admin counterpart of CancelOrder: cancels the WHOLE order on the customer's
 * behalf. Same shared core (atomic claim, restock, wallet credit, coupon
 * release, refund recording, courier cancellation) — the differences are
 * exactly the two gates it skips:
 *
 *   - no owner check (the admin is acting for the customer), replaced by
 *     orders:manage on the route;
 *   - no cancellation-window check — the window limits customer self-service,
 *     and "contact support" past the window hands off to precisely this
 *     endpoint.
 *
 * The status gate is wider than the customer's by one step: Pending, Confirmed
 * AND Packed. A Packed order may already be booked with a courier, but it has not
 * been handed over, and the shared core's post-commit step cancels the booking
 * (a failure there is recorded and retryable through RetryShipmentCancellation).
 * From Shipped onward the parcel is moving and the paths are Returns (after
 * delivery) or the RTO close-out — the status machine has no Cancelled edge out of
 * them. Per-item partial cancellation is no longer a route out once a parcel
 * exists: PartialCancelOrder refuses it then (S1).
 *
 * `cancellation.cancelledBy` is recorded as "admin" (the customer path records
 * "customer", the abandoned-checkout sweeper "system"), and the cancellation is
 * audit-logged as CANCEL_ORDER. Refunds follow the shared core: an auto-refundable
 * order is refunded through Razorpay after commit; anything else is recorded as an
 * `owed` row for the owed-refunds queue.
 */
export const AdminCancelOrder = async (req, res) => {
  try {
    const { orderId } = req.params;
    // Free text, unlike the customer's fixed list — the admin is recording an
    // operational reason ("customer called", "payment issue"), not picking
    // from a survey.
    const cancelReason = String(req.body?.reason || "").trim().slice(0, 200) || "Cancelled by store";
    const cancelDetails = String(req.body?.details || "").trim().slice(0, 1000);

    const order = await OrderModel.findById(orderId);
    if (!order) {
      return res.status(404).json({ success: false, message: "Order not found" });
    }

    // Through Packed: the parcel may be booked with a courier but has not
    // dispatched, and the shared core's post-commit step already cancels the
    // shipment. From Shipped onward the parcel is moving — the paths are the
    // Returns flow (after delivery) or the RTO close-out.
    const ADMIN_CANCELLABLE_STATUSES = ["Pending", "Confirmed", "Packed"];
    if (!ADMIN_CANCELLABLE_STATUSES.includes(order.orderStatus)) {
      return res.status(400).json({
        success: false,
        code: "ORDER_NOT_CANCELLABLE",
        message:
          "Only Pending, Confirmed or Packed orders can be fully cancelled. Once shipped, use the Returns flow after delivery.",
      });
    }

    const { order: cancelledOrder, shipmentCancellation } = await executeOrderCancellation({
      order,
      orderId,
      cancelReason,
      cancelDetails,
      actorId: req.user.id,
      source: "admin",
      allowedStatuses: ADMIN_CANCELLABLE_STATUSES,
    });

    await createAuditLog({
      admin: req.user.id,
      action: "CANCEL_ORDER",
      module: "ORDER",
      targetId: cancelledOrder._id,
      targetName: String(cancelledOrder._id),
      description: `Cancelled order on the customer's behalf — ${cancelReason}`,
      req,
    });

    return res.status(200).json({
      success: true,
      message: "Order cancelled",
      order: cancelledOrder,
      shipmentCancelled: shipmentCancellation.cancelled,
      shipmentCancellationPending:
        Boolean(cancelledOrder.shiprocket?.orderId) && !shipmentCancellation.cancelled,
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message,
    });
  }
};
