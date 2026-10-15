import OrderModel from "./Order.model.js";
import { releaseOrderCouponRedemption } from "../coupons/coupon.service.js";
import { restoreWalletCredit } from "../payments/return-refund.service.js";
import { logLifecycleEvent } from "../../utils/lifecycle-logger.service.js";

/**
 * Gives back the non-cash credits an order spent once its parcel is confirmed
 * back with us undelivered: the wallet balance it used and the coupon redemption
 * it consumed.
 *
 * An RTO delivered nothing, so neither credit was really spent. Before this, the
 * cash half of a prepaid RTO was recorded as owed (recordRtoRefundObligation) but
 * the wallet half and the coupon use were simply kept — a customer whose parcel
 * bounced lost both, on COD as well as prepaid. A cancellation has always handed
 * them back; this is the same compensation for the other way an order ends
 * without being delivered.
 *
 * Applies to COD and prepaid alike: the wallet was debited and the coupon redeemed
 * at placement (COD) or capture (prepaid), whether or not any cash was collected.
 *
 * ── ONE TRANSACTION, BOTH IDEMPOTENT ────────────────────────────────────────
 * The order is re-read INSIDE the session, filtered on "RTO Received", so the
 * wallet headroom comes from a fresh `walletRefunded` and a call against an order
 * that is not (or no longer) at RTO Received does nothing at all. Both steps are
 * capped by claims on the order itself — restoreWalletCredit by `walletRefunded`
 * in its filter, releaseOrderCouponRedemption by `couponReleasedAt` — so the
 * courier webhook and an admin's manual move racing each other, or a replayed
 * courier event, credit once between them. The transaction makes the two land
 * together: a wallet credit never commits without the coupon release beside it.
 *
 * Callers: the admin move to "RTO Received" (UpdateOrderStatus) and the courier
 * event pipeline (courier-event.service.js). Both call it AFTER the status write
 * and never let it fail the status change — the parcel is back either way; a
 * failure is logged and a retry (replayed courier event) is safe.
 *
 * @param {string|import("mongoose").Types.ObjectId} orderId
 * @returns {Promise<{walletCredited: number, couponReleased: boolean}>}
 */
export const releaseRtoOrderCredits = async (orderId) => {
  let walletCredited = 0;
  let couponReleased = false;
  const session = await OrderModel.startSession();
  try {
    await session.withTransaction(async () => {
      // Reset per attempt: withTransaction re-runs this callback on a WriteConflict.
      walletCredited = 0;
      couponReleased = false;

      const order = await OrderModel.findOne({
        _id: orderId,
        orderStatus: "RTO Received",
      }).session(session);
      if (!order) return;

      walletCredited = await restoreWalletCredit({
        order,
        amount: order.walletDiscount,
        session,
      });
      couponReleased = await releaseOrderCouponRedemption({ orderId: order._id, session });
    });
  } finally {
    await session.endSession();
  }

  if (walletCredited > 0 || couponReleased) {
    logLifecycleEvent("orders", "rto_credits_released", {
      orderId: String(orderId),
      walletCredited,
      couponReleased,
    });
  }
  return { walletCredited, couponReleased };
};
