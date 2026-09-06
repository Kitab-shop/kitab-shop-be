import mongoose from "mongoose";
import { isStockEnforced } from "../../config/features.config.js";
import OrderModel from "../orders/Order.model.js";
import { EXCLUDE_AWAITING_PAYMENT } from "../orders/order-visibility.js";
import PaymentIntent from "./PaymentIntent.model.js";
import ReferralSetting from "../referral/ReferralSetting.model.js";
import UserProfile from "../profiles/UserProfile.model.js";
import { calculateCouponDiscount } from "../coupons/coupon.service.js";
import {
  notifyOrderPlaced,
  notifyPaymentSuccess,
} from "../notifications/notification.service.js";
import { orderError } from "../orders/order-pricing.service.js";
import UserAuthModel from "../../model/User.model.js";
import { sendOrderPlacedEmail } from "../notifications/order-emails.js";
import {
  commitReservation,
  findActiveReservationForIntent,
} from "../inventory/inventory-reservation.service.js";
import { decrementStock, resolveVariantId } from "../inventory/variant.service.js";
import { syncOrderToShiprocketIfEnabled } from "../orders/order-shipping.service.js";
import { clearOrderedItemsFromCart } from "../cart/cart-cleanup.service.js";
import { logLifecycleEvent } from "../../utils/lifecycle-logger.service.js";

const rewardReferrerForFirstOrder = async ({ userId, orderId, session }) => {
  // Excludes unpaid prepaid checkouts: one abandoned attempt would otherwise make
  // a genuine first order look like a second and silently deny the referrer their
  // reward.
  const pastOrdersCount = await OrderModel.countDocuments({
    user: userId,
    _id: { $ne: orderId },
    ...EXCLUDE_AWAITING_PAYMENT,
  }).session(session);
  if (pastOrdersCount !== 0) return;

  const userProfile = await UserProfile.findOne({ userid: userId }).session(session);
  if (!userProfile?.referredBy) return;

  const referrerProfile = await UserProfile.findOne({ userid: userProfile.referredBy }).session(session);
  if (!referrerProfile) return;

  const settings = await ReferralSetting.getSettings();
  const rewardAmount = Number(settings.referrerRewardAmount || 0);
  if (rewardAmount <= 0) return;

  referrerProfile.walletBalance = (referrerProfile.walletBalance || 0) + rewardAmount;
  referrerProfile.totalWalletCreditEarned =
    (referrerProfile.totalWalletCreditEarned || 0) + rewardAmount;
  referrerProfile.totalReferrals = (referrerProfile.totalReferrals || 0) + 1;
  await referrerProfile.save({ session });
};

export const completeCapturedIntent = async ({ intent, capturedPayment, signature = "" }) => {
  let storeOrder;
  logLifecycleEvent("payment", "complete_captured_intent_started", {
    intentId: intent?._id,
    paymentId: capturedPayment?.id,
  });
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const currentIntent = await PaymentIntent.findById(intent._id).session(session);
      if (!currentIntent) throw orderError("Payment session expired", 404);

      if (currentIntent.status === "completed" && currentIntent.storeOrder) {
        storeOrder = await OrderModel.findById(currentIntent.storeOrder).session(session);
        return;
      }
      // Keyed on storeOrder, not just status. The previous guard only checked
      // status, so an intent whose status had been reset (by a stale
      // payment.failed webhook, then a retry) would fall through and build a
      // SECOND order for a checkout that already had one — a double charge.
      // Having an order is the durable fact; the status is merely a label.
      if (currentIntent.storeOrder) {
        storeOrder = await OrderModel.findById(currentIntent.storeOrder).session(session);
        if (storeOrder) return;
      }
      if (!["created", "processing"].includes(currentIntent.status)) {
        throw orderError(`Payment session is ${currentIntent.status}`, 409);
      }

      currentIntent.status = "processing";
      currentIntent.razorpayPaymentId = capturedPayment.id;
      await currentIntent.save({ session });

      // Read inside the SESSION. Without it this saw a snapshot outside the
      // transaction, so a reservation released a moment earlier still looked
      // active — the decrement below was skipped and the order was created with
      // no stock behind it.
      const activeReservation = await findActiveReservationForIntent(
        currentIntent._id,
        session,
      );
      if (isStockEnforced() && !activeReservation) {
        for (const item of currentIntent.items) {
          // Variant-aware, and both counters are constrained in the update filter.
          const ok = await decrementStock({
            productId: item.product,
            quantity: item.quantity,
            variantId: await resolveVariantId(item.product, item.variantKey || ""),
            session,
          });
          if (!ok) {
            throw orderError(`${item.name} no longer has enough stock`, 409);
          }
        }
      }

      if (currentIntent.coupon) {
        await calculateCouponDiscount({
          couponId: currentIntent.coupon,
          userId: currentIntent.user,
          items: currentIntent.items,
          redeem: true,
          session,
        });
      }

      // ── PROMOTE, don't create ────────────────────────────────────────────
      // Order-first: the row already exists at Pending/Pending from
      // CreateRazorpayOrder. Promoting it keeps the order number the customer was
      // already shown, and keeps a single row per checkout.
      //
      // The promotion is a COMPARE-AND-SWAP: `paymentStatus: "Pending"` is in the
      // filter, so of two concurrent captures (a verify and a webhook arriving
      // together) exactly one promotes and the other finds nothing and re-reads.
      // A plain save() here would let both run the compensations below twice.
      if (currentIntent.pendingOrder) {
        storeOrder = await OrderModel.findOneAndUpdate(
          { _id: currentIntent.pendingOrder, paymentStatus: "Pending" },
          {
            $set: {
              paymentStatus: "Paid",
              orderStatus: "Confirmed",
              razorpayOrderId: currentIntent.razorpayOrderId,
              razorpayPaymentId: capturedPayment.id,
              razorpaySignature: signature,
              paymentVerifiedAt: new Date(),
              paymentExpiresAt: null,
            },
            $push: {
              statusHistory: {
                from: "Pending",
                to: "Confirmed",
                changedBy: currentIntent.user,
                source: "payment_verified",
                changedAt: new Date(),
              },
            },
          },
          { session, returnDocument: "after" },
        );
        if (!storeOrder) {
          // Lost the claim. Either another execution promoted it a moment ago — in
          // which case the order is already correct and there is nothing to do — or
          // the row is gone. Re-read to tell those apart.
          const settled = await OrderModel.findById(currentIntent.pendingOrder).session(session);
          if (settled?.paymentStatus === "Paid") {
            storeOrder = settled;
            return;
          }
          throw orderError("The order for this payment could no longer be confirmed", 409);
        }
      } else {
        // No pending row: an intent created before order-first, or one whose row was
        // swept as abandoned. Create the order outright so a captured payment is
        // never left without one.
        [storeOrder] = await OrderModel.create(
          [
            {
              user: currentIntent.user,
              items: currentIntent.items,
              shippingAddress: currentIntent.shippingAddress,
              paymentMethod: "RAZORPAY",
              paymentStatus: "Paid",
              orderStatus: "Confirmed",
              subtotal: currentIntent.subtotal,
              shippingCharge: currentIntent.shippingCharge,
              tax: currentIntent.tax,
              discount: currentIntent.discount,
              walletDiscount: currentIntent.walletDiscount,
              couponDiscount: currentIntent.couponDiscount,
              totalAmount: currentIntent.totalAmount,
              coupon: currentIntent.coupon,
              razorpayOrderId: currentIntent.razorpayOrderId,
              razorpayPaymentId: capturedPayment.id,
              razorpaySignature: signature,
              paymentVerifiedAt: new Date(),
              statusHistory: [
                {
                  from: "",
                  to: "Confirmed",
                  changedBy: currentIntent.user,
                  source: "payment_verified",
                  changedAt: new Date(),
                },
              ],
            },
          ],
          { session },
        );
      }

      await rewardReferrerForFirstOrder({
        userId: currentIntent.user,
        orderId: storeOrder._id,
        session,
      });

      if (currentIntent.walletDiscount > 0) {
        // Re-check the balance inside this transaction (not the earlier
        // preview read) so two concurrent checkouts can't both apply the same
        // wallet balance and drive it negative — same guard as the stock
        // decrement above.
        const walletUpdate = await UserProfile.updateOne(
          { userid: currentIntent.user, walletBalance: { $gte: currentIntent.walletDiscount } },
          { $inc: { walletBalance: -currentIntent.walletDiscount } },
          { session },
        );
        if (walletUpdate.modifiedCount !== 1) {
          throw orderError("Wallet balance is no longer sufficient for this order", 409);
        }
      }

      currentIntent.status = "completed";
      currentIntent.storeOrder = storeOrder._id;
      currentIntent.expiresAt = undefined;
      await currentIntent.save({ session });
      if (activeReservation) {
        // The result is checked, not discarded. A null means the reservation was
        // released or expired between the read above and here — so the stock this
        // order is relying on has already gone back to the catalogue. Aborting
        // rolls the whole order back rather than confirming a paid order with no
        // inventory behind it.
        const committed = await commitReservation({
          paymentIntentId: currentIntent._id,
          session,
        });
        if (!committed) {
          throw orderError(
            "The stock held for this checkout expired before the payment completed. The payment will be refunded.",
            409,
          );
        }
      }
    });
  } finally {
    await session.endSession();
  }

  // ── CART CLEANUP ──────────────────────────────────────────────────────────
  // Deliberately AFTER the transaction, not inside it. The payment is captured
  // and the order is durably committed by this point; a cart write failing must
  // never roll that back, which is the same reason the refund gateway call is
  // made post-commit. The operation is idempotent (claimed on
  // order.cartClearedAt) because both the browser-verify and webhook paths reach
  // here, sometimes concurrently.
  //
  // This is the single funnel for BOTH Razorpay confirmation paths, so one call
  // covers the browser flow and the webhook alike — which is the whole point:
  // clearing used to live in Checkout.jsx, where the webhook path never ran it.
  await clearOrderedItemsFromCart({ order: storeOrder });

  await syncOrderToShiprocketIfEnabled(storeOrder);
  await notifyPaymentSuccess(storeOrder);
  await notifyOrderPlaced(storeOrder);

  // The confirmation. Fire-and-forget, and after the order is durable: a mail
  // failure must never fail a payment that has already been captured. This is
  // the single funnel for both Razorpay paths, so the browser flow and the
  // webhook both send exactly one.
  UserAuthModel.findById(storeOrder.user)
    .select("email")
    .lean()
    .then((customer) => sendOrderPlacedEmail({ order: storeOrder, email: customer?.email }))
    .catch(() => {});

  logLifecycleEvent("payment", "complete_captured_intent_finished", {
    intentId: intent?._id,
    paymentId: capturedPayment?.id,
    orderId: storeOrder?._id,
  });
  return storeOrder;
};
