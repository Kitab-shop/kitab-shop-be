import OrderModel from "./Order.model.js";
import UserProfile from "../profiles/UserProfile.model.js";
import ReferralSetting from "../referral/ReferralSetting.model.js";
import CouponModel from "../coupons/coupon.model.js";
import CheckoutSetting from "./CheckoutSetting.model.js";
import CodVerification from "./CodVerification.model.js";
import { isStockEnforced } from "../../config/features.config.js";
import {
  notifyOrderCancelled,
  notifyOrderClosed,
  notifyOrderCompleted,
  notifyOrderPlaced,
  notifyRefundProcessed,
} from "../notifications/notification.service.js";
import {
  sendOrderCancelledEmail,
  sendOrderClosedEmail,
  sendOrderCompletedEmail,
} from "../notifications/order-emails.js";
import UserModel from "../../model/User.model.js";
import { prepareOrderData } from "./order-pricing.service.js";
import { calculateCouponDiscount } from "../coupons/coupon.service.js";
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
import { createAuditLog } from "../audit/audit-log.js";
import {
  AWAITING_PAYMENT_TTL_MS,
  EXCLUDE_AWAITING_PAYMENT,
} from "./order-visibility.js";
import {
  canAutoRefund,
  cancellationRefundKey,
  proportionalRefundAmount,
  proportionalWalletRefund,
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
    } = req.body;

    const preparedOrder = await prepareOrderData({
      items,
      rawShippingAddress,
      coupon,
      userId,
      redeemCoupon: false,
      useWallet: Boolean(useWallet),
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
    console.log(error);

    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message,
    });
  } finally {
    if (session) await session.endSession();
  }
};

export const GetMyOrders = async (req, res) => {
  try {
    const userId = req.user.id;

    // A checkout the customer abandoned is not something they ordered, so it does
    // not belong in "My Orders". They still reach it by id if the payment later
    // completes and it is promoted.
    // returnPolicy included so the customer's return-eligibility UI runs on
    // the real per-product policy, not the frontend's hardcoded fallback.
    const orders = await OrderModel.find({ user: userId, ...EXCLUDE_AWAITING_PAYMENT })
      .populate("items.product", "name image price mrp brand author category_id returnPolicy")
      .sort({ createdAt: -1 })
      .lean();

    return res.status(200).json({
      success: true,
      total: orders.length,
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

export const UpdateOrderStatus = async (req, res) => {
  try {
    const { orderId } = req.params;
    const { orderStatus } = req.body;

    const order = await OrderModel.findById(orderId);
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
    if (orderStatus === "Closed") {
      const claimed = await OrderModel.findOneAndUpdate(
        {
          _id: order._id,
          orderStatus: "RTO Received",
          rtoDisposition: { $in: RECORDED_RTO_DISPOSITIONS },
        },
        {
          $set: { orderStatus: "Closed" },
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
          "orderStatus rtoDisposition",
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

      return res.status(200).json({
        success: true,
        message: "Order closed",
        order: claimed,
      });
    }

    const previousStatus = order.orderStatus;
    order.orderStatus = orderStatus;
    // Money-affecting mutations were previously untraceable — no history field
    // and no audit log anywhere in this controller.
    order.statusHistory.push({
      from: previousStatus,
      to: orderStatus,
      changedBy: req.user?.id || null,
      changedAt: new Date(),
    });
    // Only the first "Delivered" sets this — a later re-confirmation of the
    // same status shouldn't push the customer's return window forward.
    if (orderStatus === "Delivered" && !order.deliveredAt) {
      order.deliveredAt = new Date();
    }
    // COD money is collected at the door, so delivery IS the payment event.
    // Without this a delivered COD order stayed "Pending" forever, leaving COD
    // revenue invisible to reporting and making a COD return's "customer already
    // paid" premise untrue. Guarded so a later status edit can't overwrite a
    // refund that has since been issued.
    if (
      orderStatus === "Delivered" &&
      order.paymentMethod === "COD" &&
      order.paymentStatus === "Pending"
    ) {
      order.paymentStatus = "Paid";
    }
    await order.save();

    // The success sign-off: tell the customer their order completed. Fire-and-
    // forget, after the save is durable.
    if (orderStatus === "Completed") {
      notifyOrderCompleted({ orderId: order._id, userId: order.user || null }).catch(() => {});
      emailForOrder(order)
        .then((email) => sendOrderCompletedEmail({ order, email }))
        .catch(() => {});
    }

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

export const PartialCancelOrder = async (req, res) => {
  let session;
  let refundOwed = false;
  let refundAmountOwed = 0;
  let walletCredited = 0;
  let refundKey = null;
  // Set only when cancelling this line empties the order, which is the one case
  // where a partial cancellation has to reach the courier — see the end of this
  // function.
  let becameCancelled = false;
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
      becameCancelled = false;
      order = await OrderModel.findById(req.params.orderId).session(session);
      if (!order) {
        const error = new Error("Order not found");
        error.statusCode = 404;
        throw error;
      }
      if (["Delivered", "Cancelled"].includes(order.orderStatus)) {
        const error = new Error("This order cannot be partially cancelled");
        error.statusCode = 409;
        throw error;
      }

      const item = order.items.find((entry) => String(entry.product) === String(productId));
      if (!item) {
        const error = new Error("Product was not found in this order");
        error.statusCode = 404;
        throw error;
      }

      const remainingQuantity = item.quantity - (item.cancelledQuantity || 0);
      if (cancelQuantity > remainingQuantity) {
        const error = new Error(`Only ${remainingQuantity} item(s) can be cancelled`);
        error.statusCode = 400;
        throw error;
      }

      item.cancelledQuantity = (item.cancelledQuantity || 0) + cancelQuantity;
      // Valued against what the customer actually PAID, not the list price.
      // item.price is stored pre-discount while coupon/wallet reductions apply
      // at order level, so `price × qty` over-refunded every discounted order.
      // Shipping is excluded here for the same reason as a return, but for a
      // different fact: the remaining units still ship, so the parcel — and its
      // freight — is still incurred. The one exception is handled below, where
      // cancelling the LAST unit means nothing ships at all.
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

      const totalRemaining = order.items.reduce(
        (sum, entry) => sum + (entry.quantity - (entry.cancelledQuantity || 0)),
        0,
      );
      if (totalRemaining === 0) {
        order.orderStatus = "Cancelled";
        // Recorded so the courier can be told AFTER this commits. Cancelling the
        // last remaining unit leaves nothing to ship, but a partial cancellation
        // used not to notify Shiprocket at all — so the order read Cancelled while
        // its parcel was still live, and only an operator running the retry
        // endpoint could close it.
        becameCancelled = true;

        // Nothing ships now, so the freight is not incurred and the shipping
        // charge comes back — exactly as a full cancellation would refund it.
        // `headroom` is the outstanding balance (totalAmount − already refunded),
        // which is the same figure CancelOrder pays out.
        //
        // Without this, cancelling an order unit-by-unit refunded strictly less
        // than cancelling it in one go: the two paths disagreed by the shipping
        // charge even though the customer ends up in the identical position.
        if (headroom > refundAmount) refundAmount = headroom;
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
          status: "created",
          idempotencyKey: refundKey,
          createdBy: req.user.id,
        });
        refundOwed = true;
        refundAmountOwed = refundAmount;
      }

      await order.save({ session });
    });

    // Money moves only after the cancellation is durably committed — an external
    // payment call inside the transaction could succeed while the transaction
    // rolled back.
    if (refundOwed && canAutoRefund(order)) {
      const pending = order.refunds.find((entry) => entry.idempotencyKey === refundKey);
      if (pending) {
        // Same shared helper as the full-cancellation, returns and admin paths.
        // The behaviour here was already close to correct; what it lacked was
        // `notes.refundKey`, so a lost gateway response left a `created` row with
        // no way to ask Razorpay whether the money had actually gone.
        await settleGatewayRefund({
          order,
          refundId: pending._id,
          amount: refundAmountOwed,
          refundKey,
          reason: `Partial cancellation on order ${order._id}`,
        });
        order = await OrderModel.findById(req.params.orderId);
      }
    }

    // ── TELL THE COURIER, ONLY IF THE ORDER IS NOW FULLY CANCELLED ───────────
    // Same helper and same ordering as CancelOrder: local claim → commit → refund
    // → courier. A partial cancellation that leaves the order active must NOT
    // reach here — Shiprocket's /orders/cancel cancels a whole order and cannot
    // express "one unit of two", so calling it would cancel a parcel the customer
    // is still expecting.
    let shipmentCancellation = { attempted: false, cancelled: false };
    if (becameCancelled) {
      shipmentCancellation = await cancelShipmentForCancelledOrder(order);
      if (shipmentCancellation.cancelled) {
        order = await OrderModel.findById(req.params.orderId);
      }
    }

    // Only claim a refund to the customer once one has demonstrably happened.
    // This previously fired unconditionally — even on a COD order still at
    // "Pending", where nothing was ever owed.
    if (order.paymentStatus === "Refunded" || order.paymentStatus === "Partially Refunded") {
      await notifyRefundProcessed({
        orderId: order._id,
        paymentId: order.razorpayPaymentId || null,
      });
    }

    return res.status(200).json({
      success: true,
      message: walletCredited > 0
        ? `Order item cancelled. ${walletCredited} of wallet credit was returned to the customer's balance.`
        : "Order item cancelled",
      order,
      walletCredited,
      // Only meaningful when this cancellation emptied the order.
      orderFullyCancelled: becameCancelled,
      shipmentCancelled: shipmentCancellation.cancelled,
      shipmentCancellationPending:
        becameCancelled &&
        Boolean(order.shiprocket?.orderId) &&
        !shipmentCancellation.cancelled,
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message,
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
 */
export const ReconcileOrderRefund = async (req, res) => {
  try {
    const { orderId, refundId } = req.params;
    const order = await OrderModel.findById(orderId);
    if (!order) {
      return res.status(404).json({ success: false, message: "Order not found" });
    }

    const record = order.refunds.id(refundId);
    if (!record) {
      return res.status(404).json({ success: false, message: "Refund record not found on this order" });
    }

    if (record.status === "processed") {
      return res.status(200).json({
        success: true,
        message: "This refund has already settled",
        idempotent: true,
        order,
      });
    }

    // Rows written before reconciliation keys existed have nothing to match on at
    // the gateway. Say so rather than refunding blindly, which is the one thing
    // this endpoint must never do.
    if (!record.idempotencyKey) {
      return res.status(409).json({
        success: false,
        message:
          "This refund predates reconciliation keys, so it cannot be matched at Razorpay automatically. Check the Razorpay dashboard and settle it manually.",
        code: "REFUND_NOT_RECONCILABLE",
      });
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
      refundKey: record.idempotencyKey,
      reason: record.reason || `Refund on order ${order._id}`,
    });

    const fresh = await OrderModel.findById(orderId);

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

    await createAuditLog({
      admin: req.user.id,
      action: "RECONCILE_REFUND",
      module: "PAYMENT",
      targetId: order._id,
      targetName: String(order._id),
      description:
        result.outcome === "reconciled"
          ? `Adopted existing Razorpay refund ${result.providerRefundId} for ₹${record.amount} — no second refund issued`
          : `Issued Razorpay refund ${result.providerRefundId} for ₹${record.amount} after confirming none existed`,
      req,
    });

    return res.status(200).json({
      success: true,
      message:
        result.outcome === "reconciled"
          ? "Refund reconciled against Razorpay — no second refund was issued"
          : "Refund issued (Razorpay confirmed no earlier refund existed)",
      reconciled: result.outcome === "reconciled",
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

export const CreateSplitShipment = async (req, res) => {
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (items.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Shipment items are required",
      });
    }

    const order = await OrderModel.findById(req.params.orderId);
    if (!order) return res.status(404).json({ success: false, message: "Order not found" });
    if (["Cancelled", "Delivered"].includes(order.orderStatus)) {
      return res.status(409).json({
        success: false,
        message: "Cannot split this order in its current status",
      });
    }

    const shipmentItems = [];
    for (const requested of items) {
      const quantity = Number(requested.quantity);
      const orderItem = order.items.find(
        (entry) => String(entry.product) === String(requested.productId || requested.product),
      );
      if (!orderItem || !Number.isInteger(quantity) || quantity < 1) {
        return res.status(400).json({
          success: false,
          message: "Each shipment item must match an order product and positive quantity",
        });
      }
      shipmentItems.push({ product: orderItem.product, quantity });
    }

    order.shipments.push({
      shipmentNumber: `SHP-${Date.now()}-${order.shipments.length + 1}`,
      items: shipmentItems,
      status: "planned",
      createdBy: req.user.id,
    });
    await order.save();

    return res.status(201).json({
      success: true,
      message: "Split shipment planned",
      order,
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
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
}) => {
  let session;
  let refundOwed = false;
  let refundKey = null;
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

      // ─── ATOMIC CLAIM ───────────────────────────────────────────────────
      // The status gate above ran against a read taken OUTSIDE this session,
      // so two concurrent cancels could both pass it. Claiming the transition
      // here — with the permitted statuses in the FILTER — means exactly one
      // execution can ever win, and every compensation below runs at most
      // once. Without this, a retried callback re-credited the wallet,
      // re-restored stock and pushed a second refund for the same order.
      const claimed = await OrderModel.findOneAndUpdate(
        { _id: orderId, orderStatus: { $in: allowedStatuses } },
        {
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
      await restoreWalletCredit({
        order: claimed,
        amount: claimed.walletDiscount,
        session,
      });

      if (claimed.coupon && claimed.couponDiscount > 0) {
        // Conditional single-statement update rather than read-modify-save:
        // the `$gte: 1` in the filter makes the decrement atomic, and
        // updateOne skips Mongoose validators, so this no longer depends on
        // the subdocument's `min` at all.
        await CouponModel.updateOne(
          {
            couponId: claimed.coupon,
            usedBy: { $elemMatch: { user: claimed.user, count: { $gte: 1 } } },
          },
          { $inc: { "usedBy.$.count": -1, usage: -1 } },
          { session },
        );
      }

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

      if (moneyCollected && outstanding > 0) {
        // One full cancellation per order — the status claim above guarantees a
        // single execution — so the order id is a stable key. Carried into
        // notes.refundKey at the gateway, which is what lets a lost response be
        // reconciled instead of being retried blindly.
        refundKey = cancellationRefundKey({ orderId: claimed._id });
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
                status: "created",
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

    // Now that the cancellation is durably committed, actually move the money.
    // A failure here leaves the order cancelled and the refund visibly pending
    // with its reason recorded, so it can be retried — never silently lost.
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
        await settleGatewayRefund({
          order,
          refundId: pendingRefund._id,
          // The outstanding balance, not the whole order total — a prior partial
          // cancellation may already have refunded part of it.
          amount: refundAmountOwed,
          refundKey,
          reason: `Cancelled order ${order._id}`,
        });
        order = await OrderModel.findById(orderId);
      }
    }

    // ── TELL THE COURIER, LAST ───────────────────────────────────────────────
    // Everything local is durable by now: the cancellation claim, the restock, the
    // wallet credit, the coupon release and the refund. Only the request that WON
    // the claim reaches this line, so exactly one Shiprocket cancellation is ever
    // attempted per order.
    //
    // A failure here does not fail the cancellation. Safe because cancellation is
    // only permitted before dispatch (Pending/Confirmed) and every fulfilment
    // endpoint refuses a Cancelled order (ensureFulfillable), so the parcel cannot
    // be progressed by this system afterwards. The shipment is left in the derived
    // pending state with the reason recorded, and is retryable.
    const shipmentCancellation = await cancelShipmentForCancelledOrder(order);
    if (shipmentCancellation.attempted && shipmentCancellation.cancelled) {
      order = await OrderModel.findById(orderId);
    }

    // Only claim a refund to the customer once one has actually been processed.
    if (order.paymentStatus === "Refunded") {
      await notifyRefundProcessed({
        orderId: order._id,
        paymentId: order.razorpayPaymentId || null,
      });
    }

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

    return { order, shipmentCancellation };
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
 * The Pending/Confirmed gate stays: once the order is Packed the parcel is
 * moving, and the paths for that are Returns (after delivery) or per-item
 * partial cancellation — same rule the status machine enforces everywhere.
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
          "Only Pending, Confirmed or Packed orders can be fully cancelled. Once shipped, use partial cancellation or the Returns flow after delivery.",
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
