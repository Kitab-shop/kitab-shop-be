/**
 * Return transitions that more than one caller can drive.
 *
 * "The pickup parcel reached us" and "the customer has the replacement" can each be
 * reported by an operator (AdminUpdateReturnStatus / ConfirmReplacementDelivery) or by
 * the courier (a Delivered event on the leg's AWB, via courier-event.service.js). Both
 * paths go through these functions so they apply the same compare-and-swap, write the
 * same history entry and send the same notification — and so whichever arrives second
 * finds the transition already taken and does nothing.
 *
 * Neither transition moves money or stock. "received" opens the QC step; the refund,
 * the disposition and any restock are still recorded by an operator when resolving.
 */
import ReturnModel from "./return.model.js";
import { notifyReturnUpdated } from "../notifications/notification.service.js";
import { logLifecycleError } from "../../utils/lifecycle-logger.service.js";

const notify = (claimed, status) =>
  notifyReturnUpdated({ orderId: claimed.order, userId: claimed.user, status }).catch((error) =>
    logLifecycleError("returns", "return_notification_failed", error, {
      returnId: String(claimed._id),
      status,
    }),
  );

/**
 * pickup_scheduled → received, stamping receivedAt.
 *
 * @returns {Promise<object|null>} the claimed return, or null when it was not at
 *   pickup_scheduled (already received, cancelled, never scheduled, or missing)
 */
export const markReturnReceived = async ({ returnId, actorId = null, note = "" }) => {
  const now = new Date();
  const claimed = await ReturnModel.findOneAndUpdate(
    { _id: returnId, status: "pickup_scheduled" },
    {
      $set: { status: "received", receivedAt: now },
      $push: { statusHistory: { status: "received", changedBy: actorId, note: note || "", changedAt: now } },
    },
    { returnDocument: "after" },
  );
  if (!claimed) return null;
  await notify(claimed, "received");
  return claimed;
};

/**
 * replacement_dispatched → replacement_delivered.
 *
 * replacementDeliveredAt is stamped only when still empty: the courier may already have
 * recorded the real delivery time on its Delivered event, and that fact must not be
 * replaced by the moment an operator happened to confirm it.
 *
 * @returns {Promise<object|null>} the claimed return, or null when it was not at
 *   replacement_dispatched
 */
export const markReplacementDelivered = async ({ returnId, actorId = null, note = "" }) => {
  const now = new Date();
  const claimed = await ReturnModel.findOneAndUpdate(
    { _id: returnId, status: "replacement_dispatched" },
    {
      $set: { status: "replacement_delivered" },
      $push: {
        statusHistory: { status: "replacement_delivered", changedBy: actorId, note: note || "", changedAt: now },
      },
    },
    { returnDocument: "after" },
  );
  if (!claimed) return null;

  if (!claimed.replacementDeliveredAt) {
    await ReturnModel.updateOne(
      { _id: claimed._id, replacementDeliveredAt: null },
      { $set: { replacementDeliveredAt: now } },
    );
    claimed.replacementDeliveredAt = now;
  }
  await notify(claimed, "replacement_delivered");
  return claimed;
};
