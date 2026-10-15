import mongoose from "mongoose";
import OrderModel from "../orders/Order.model.js";
import ReturnModel from "../returns/return.model.js";
import { logLifecycleError, logLifecycleEvent } from "../../utils/lifecycle-logger.service.js";
import { notifyShipmentUpdated } from "../notifications/notification.service.js";
import { ensureBillNumber } from "../orders/bill-number.service.js";
import { resolveCourierPath } from "../orders/order-status.rules.js";
import { recordRtoRefundObligation } from "../payments/return-refund.service.js";
import { releaseRtoOrderCredits } from "../orders/rto-compensation.service.js";
import { markReplacementDelivered, markReturnReceived } from "../returns/return-lifecycle.service.js";
import {
  COURIER_CANCELLED_CODES,
  SHIPMENT_EXCEPTIONS,
  isRtoReceived,
  mapOrderStatus,
} from "./shipment-status-map.js";

/**
 * ONE pipeline for every courier status update, whoever delivers it.
 *
 * The webhook used to be the only way a courier fact reached an order, and it did
 * everything inline. The reconciler (which polls tracking for orders the webhook has
 * gone quiet on) has to apply exactly the same rules — identity, transition legality,
 * ordering, side effects — or the two would disagree about the same parcel. So the
 * rules live here and both are thin callers.
 *
 * What this adds over the old inline handler, each closing a verified hole:
 *
 *   - Compare-and-swap on the status that was READ. The old write filtered on `_id`
 *     only, so a "Shipped" event read a moment before an admin cancellation committed
 *     wrote Shipped over Cancelled — after the refund and restock had already run.
 *   - Catch-up (resolveCourierPath). Transitions are one step at a time, so one lost
 *     "Shipped" event froze an order at Packed forever: every later event was an
 *     illegal jump, COD cash was never recorded, the return window never opened.
 *   - Ordering on courier time (`shiprocket.lastEventAt`). NDR ⇄ Out For Delivery are
 *     both legal in either direction, so the transition table alone cannot stop a
 *     late-arriving older event flipping a newer state back.
 *   - Exceptions persisted (`shiprocket.exception`) instead of only logged, and
 *     courier-side cancellation (codes 8/45) adopted on orders we already cancelled.
 *   - The RTO refund obligation is recorded only when the order actually IS at
 *     "RTO Received". It used to fire on any code 10, including a stray one against a
 *     delivered prepaid order — a refund liability for goods the customer has.
 *
 * There is no event-dedupe table, deliberately: every side effect below is already
 * idempotent (same-status no-op, first-Delivered-wins, COD gated on an applied move,
 * bill-number CAS, obligation dedupe), and genuine repeats — OFD, NDR, OFD again on a
 * re-attempt — carry identical payloads and must all apply.
 */

/**
 * Resolves a courier event to EXACTLY ONE order, or refuses.
 *
 * The rule: every identifier the event actually carries must agree, and must name
 * exactly one order.
 *
 *   - an identifier matching MORE than one order  → ambiguous, refuse
 *   - identifiers naming DIFFERENT orders         → conflict, refuse
 *   - an identifier matching NOTHING is tolerated, because it is normal: the
 *     first AWB event arrives while our stored `awbCode` is still null.
 *
 * Unique partial indexes on both shiprocket fields make ambiguity structurally
 * impossible for new data; this check is defence in depth for older rows.
 */
export const resolveWebhookOrder = async ({ sourceOrderId, shiprocketOrderId, awbCode }) => {
  const identifiers = { sourceOrderId, shiprocketOrderId, awbCode };
  const lookups = [];

  // Our own _id, when the payload echoes back something that could be one. An
  // unparseable value is NOT treated as "no identifier": it means the event names
  // an order we cannot interpret, so it must not fall through to a fuzzier match.
  if (sourceOrderId) {
    if (!mongoose.Types.ObjectId.isValid(sourceOrderId)) {
      return { reason: "unparseable_order_id", identifiers };
    }
    lookups.push({ field: "order_id", filter: { _id: sourceOrderId } });
  }
  if (shiprocketOrderId) {
    lookups.push({ field: "sr_order_id", filter: { "shiprocket.orderId": shiprocketOrderId } });
  }
  if (awbCode) {
    lookups.push({ field: "awb", filter: { "shiprocket.awbCode": awbCode } });
  }

  if (lookups.length === 0) return { reason: "no_identifiers", identifiers };

  const matchedIds = new Set();
  for (const lookup of lookups) {
    // find(), not findOne(): the whole point is to SEE a second match rather than
    // silently take the first. Limited to 2 — one is enough to prove ambiguity.
    const matches = await OrderModel.find(lookup.filter).select("_id").limit(2).lean();
    if (matches.length > 1) {
      return { reason: `ambiguous_${lookup.field}`, identifiers };
    }
    if (matches.length === 1) matchedIds.add(String(matches[0]._id));
  }

  if (matchedIds.size === 0) return { reason: "no_match", identifiers };
  if (matchedIds.size > 1) return { reason: "conflicting_identifiers", identifiers };

  return { orderId: [...matchedIds][0], identifiers };
};

/**
 * Resolves a courier event to one leg of one RETURN, or refuses.
 *
 * Resolved by AWB ONLY, deliberately. One return can have a collection travelling in
 * and a replacement travelling out simultaneously, so its `_id` identifies the return
 * but not which parcel an event is about. The AWB is unique per leg (enforced by
 * `return_pickupAwb_unique` / `return_replacementAwb_unique`).
 */
export const resolveWebhookReturn = async (awbCode) => {
  if (!awbCode) return { reason: "no_awb" };

  const [pickupMatches, replacementMatches] = await Promise.all([
    ReturnModel.find({ pickupAwb: awbCode }).select("_id").limit(2).lean(),
    ReturnModel.find({ replacementAwb: awbCode }).select("_id").limit(2).lean(),
  ]);

  if (pickupMatches.length > 1) return { reason: "ambiguous_return_pickup_awb" };
  if (replacementMatches.length > 1) return { reason: "ambiguous_return_replacement_awb" };
  if (pickupMatches.length === 1 && replacementMatches.length === 1) {
    return { reason: "awb_on_both_return_legs" };
  }
  if (pickupMatches.length === 1) return { returnId: String(pickupMatches[0]._id), leg: "pickup" };
  if (replacementMatches.length === 1) {
    return { returnId: String(replacementMatches[0]._id), leg: "replacement" };
  }
  return { reason: "no_return_match" };
};

/**
 * Records where a return's parcel has got to, and advances the return on delivery.
 *
 * Every event updates the leg's courier status. A "Delivered" event also moves the
 * return, through the same compare-and-swaps the admin endpoints use
 * (return-lifecycle.service.js):
 *   - pickup leg:      pickup_scheduled → received
 *   - replacement leg: replacement_dispatched → replacement_delivered
 * Waiting for an operator to notice used to leave returns parked at pickup_scheduled
 * with the parcel already on the shelf. "received" decides nothing by itself — the QC
 * disposition, the refund and any restock are still recorded by an operator. A replay
 * finds the transition already taken and changes nothing.
 *
 * @returns {Promise<{advanced: boolean}>}
 */
export const recordReturnCourierEvent = async ({ returnId, leg, currentStatus, mappedStatus, awbCode }) => {
  const now = new Date();
  const update =
    leg === "pickup"
      ? { pickupCourierStatus: currentStatus || mappedStatus || "", pickupCourierUpdatedAt: now }
      : { replacementCourierStatus: currentStatus || mappedStatus || "", replacementCourierUpdatedAt: now };

  // First delivery wins: re-stamping on a replayed event would move the replacement's
  // own reference point.
  const stampsDelivery = leg === "replacement" && mappedStatus === "Delivered";
  const claimed = await ReturnModel.findOneAndUpdate(
    stampsDelivery ? { _id: returnId, replacementDeliveredAt: null } : { _id: returnId },
    stampsDelivery ? { $set: { ...update, replacementDeliveredAt: now } } : { $set: update },
    { returnDocument: "after" },
  );
  if (!claimed) await ReturnModel.updateOne({ _id: returnId }, { $set: update });

  let advanced = false;
  if (mappedStatus === "Delivered") {
    const note = `Courier reported delivered (AWB ${awbCode || "unknown"})`;
    try {
      const moved =
        leg === "pickup"
          ? await markReturnReceived({ returnId, note })
          : await markReplacementDelivered({ returnId, note });
      advanced = Boolean(moved);
    } catch (error) {
      // The courier status is recorded either way; an operator can still make the move.
      logLifecycleError("shipping", "return_courier_transition_failed", error, { returnId, leg, awbCode });
    }
  }

  logLifecycleEvent("shipping", "return_courier_event_recorded", {
    returnId,
    leg,
    awbCode,
    courierStatus: currentStatus || mappedStatus || null,
    statusUnchanged: !advanced,
  });
  return { advanced };
};

/**
 * Normalises a raw Shiprocket webhook body into the event shape applyCourierEvent takes.
 * Kept beside the pipeline so the webhook and any replay tooling read payloads alike.
 */
export const courierEventFromWebhook = (body = {}, eventAt = null) => ({
  sourceOrderId: String(body?.order_id || "").trim(),
  shiprocketOrderId: Number(body?.sr_order_id) || null,
  awbCode: String(body?.awb || "").trim(),
  statusCode: Number(body?.shipment_status_id || body?.current_status_id) || null,
  currentStatus: body?.shipment_status || body?.current_status || null,
  courierName: body?.courier_name || null,
  ndrReason: body?.ndr_reason || body?.reason || "",
  rtoReason: body?.rto_reason || "",
  eventAt,
});

const SOURCE_LABELS = {
  webhook: "shiprocket_webhook",
  reconciler: "shiprocket_reconciler",
};

const ORDER_FIELDS =
  "orderStatus deliveredAt paymentMethod paymentStatus shipment.provider shiprocket.lastEventAt shiprocket.syncStatus";

/**
 * Applies one courier event.
 *
 * @param {object} event       see courierEventFromWebhook
 * @param {{source?: "webhook"|"reconciler"}} [options]
 * @returns {Promise<{scope: "order"|"return"|"ignored", reason?: string, orderId?: string,
 *   hops?: string[], stale?: boolean, statusUnchanged?: boolean, leg?: string}>}
 */
export const applyCourierEvent = async (event, { source = "webhook" } = {}) => {
  const {
    sourceOrderId = "",
    shiprocketOrderId = null,
    awbCode = "",
    statusCode = null,
    currentStatus = null,
    courierName = null,
    ndrReason = "",
    rtoReason = "",
    eventAt = null,
  } = event || {};
  const sourceLabel = SOURCE_LABELS[source] || SOURCE_LABELS.webhook;

  // ── IDENTITY, RESOLVED ONCE ────────────────────────────────────────────────
  const resolution = await resolveWebhookOrder({ sourceOrderId, shiprocketOrderId, awbCode });

  // A reverse pickup or replacement parcel belongs to a return, not an order, so it
  // can never match above. Only attempted when no order matched, so an order event can
  // never be re-attributed to a return.
  if (!resolution.orderId) {
    const returnResolution = await resolveWebhookReturn(awbCode);
    if (returnResolution.returnId) {
      const { advanced } = await recordReturnCourierEvent({
        returnId: returnResolution.returnId,
        leg: returnResolution.leg,
        currentStatus,
        mappedStatus: mapOrderStatus(statusCode, currentStatus),
        awbCode,
      });
      return { scope: "return", leg: returnResolution.leg, statusUnchanged: !advanced };
    }
    if (
      returnResolution.reason?.startsWith("ambiguous_") ||
      returnResolution.reason === "awb_on_both_return_legs"
    ) {
      logLifecycleError(
        "shipping",
        "shiprocket_webhook_return_identity_unresolved",
        new Error(`Courier event could not be resolved to one return leg: ${returnResolution.reason}`),
        { reason: returnResolution.reason, awbCode, statusCode, currentStatus, source },
      );
      return { scope: "ignored", reason: returnResolution.reason };
    }

    const isIntegrityProblem =
      resolution.reason.startsWith("ambiguous_") || resolution.reason === "conflicting_identifiers";
    const details = { reason: resolution.reason, ...resolution.identifiers, statusCode, currentStatus, source };
    if (isIntegrityProblem) {
      logLifecycleError(
        "shipping",
        "shiprocket_webhook_identity_unresolved",
        new Error(`Courier event could not be resolved to one order: ${resolution.reason}`),
        details,
      );
    } else {
      logLifecycleEvent("shipping", "shiprocket_webhook_ignored", details);
    }
    return { scope: "ignored", reason: resolution.reason };
  }

  const orderId = resolution.orderId;
  const mappedStatus = mapOrderStatus(statusCode, currentStatus);

  // Two attempts: a CAS miss means something else moved the order between our read and
  // our write; the second pass re-reads and re-decides against the new state.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const existing = await OrderModel.findById(orderId).select(ORDER_FIELDS).lean();
    if (!existing) return { scope: "ignored", reason: "order_deleted" };

    const lastEventAt = existing.shiprocket?.lastEventAt ? new Date(existing.shiprocket.lastEventAt) : null;
    // Older than what we already applied: courier truth has moved on. Identifiers and
    // reasons are still worth keeping; the status is not.
    const stale = Boolean(eventAt && lastEventAt && eventAt < lastEventAt);
    const now = new Date();

    const set = {
      "shiprocket.lastError": null,
      "shiprocket.lastSyncedAt": now,
    };
    if (shiprocketOrderId) set["shiprocket.orderId"] = shiprocketOrderId;
    if (awbCode) set["shiprocket.awbCode"] = awbCode;
    if (courierName) set["shiprocket.courierName"] = courierName;
    // Reasons are only meaningful on the event that reports them; a later status
    // event must not blank out why a delivery failed.
    if (ndrReason) set["shiprocket.ndrReason"] = ndrReason;
    if (rtoReason) set["shiprocket.rtoReason"] = rtoReason;

    if (!stale) {
      set["shiprocket.status"] = currentStatus;
      set["shiprocket.statusCode"] = statusCode;
      if (eventAt) set["shiprocket.lastEventAt"] = eventAt;
    }

    // ── EXCEPTIONS ─────────────────────────────────────────────────────────────
    const exceptionMeaning = SHIPMENT_EXCEPTIONS[statusCode];
    let adoptedCancellation = false;
    if (!stale && exceptionMeaning) {
      if (
        COURIER_CANCELLED_CODES.includes(statusCode) &&
        existing.orderStatus === "Cancelled" &&
        existing.shiprocket?.syncStatus !== "cancelled"
      ) {
        // We cancelled first and the courier is confirming it: this closes the
        // derived "cancellation pending" state without another API call.
        set["shiprocket.syncStatus"] = "cancelled";
        adoptedCancellation = true;
      } else {
        set["shiprocket.exception"] = { code: statusCode, meaning: exceptionMeaning, at: now };
      }
    }

    // A courier reporting movement on an order whose payment never cleared is an
    // integrity problem for a human: shipping it would hand over unpaid goods.
    if (!stale && mappedStatus && existing.orderStatus === "Pending") {
      set["shiprocket.exception"] = {
        code: statusCode,
        meaning: `courier reported "${currentStatus || mappedStatus}" on an order awaiting payment`,
        at: now,
      };
    }

    // ── PROVIDER-NEUTRAL MIRROR ────────────────────────────────────────────────
    // Skipped for MANUAL shipments: the resolver can reach an order by our own `_id`,
    // which does not require the order to have any Shiprocket identity at all.
    const isManual = existing.shipment?.provider === "MANUAL";
    if (!isManual) {
      set["shipment.provider"] = "SHIPROCKET";
      set["shipment.updatedAt"] = now;
      if (awbCode) set["shipment.trackingNumber"] = awbCode;
      if (courierName) set["shipment.carrierName"] = courierName;
    }

    // ── STATUS ─────────────────────────────────────────────────────────────────
    const path = !stale && mappedStatus ? resolveCourierPath(existing.orderStatus, mappedStatus) : null;
    const applyStatus = Boolean(path && path.length > 0);
    let push = null;
    if (applyStatus) {
      set.orderStatus = mappedStatus;
      if (!isManual) set["shipment.status"] = mappedStatus;
      const hopSource = path.length > 1 ? "shiprocket_catchup" : sourceLabel;
      push = {
        statusHistory: {
          $each: path.map((hop) => ({
            from: hop.from,
            to: hop.to,
            changedBy: null,
            source: hopSource,
            changedAt: now,
          })),
        },
      };
      if (path.some((hop) => hop.to === "RTO" || hop.to === "RTO Received")) {
        set["shiprocket.syncStatus"] = "rto";
      } else if (mappedStatus === "NDR") {
        set["shiprocket.syncStatus"] = "ndr";
      } else if (existing.shiprocket?.syncStatus === "ndr") {
        // Leaving NDR (a re-attempt went Out For Delivery, or it was delivered): the
        // shipment is no longer an exception, so it stops showing as one.
        set["shiprocket.syncStatus"] = "awb_assigned";
      }
      // First Delivered wins: re-stamping on a replay silently re-opened an expired
      // return window.
      if (mappedStatus === "Delivered" && !existing.deliveredAt) set.deliveredAt = now;
    } else if (mappedStatus && !stale && existing.orderStatus !== mappedStatus && !path) {
      logLifecycleEvent("shipping", "courier_status_not_applicable", {
        orderId,
        from: existing.orderStatus,
        reported: mappedStatus,
        statusCode,
        source,
      });
    }

    // The CAS. Status moves are conditional on the status we decided from; every write
    // carrying a courier time is conditional on no newer event having landed meanwhile.
    const filter = { _id: orderId };
    if (applyStatus) filter.orderStatus = existing.orderStatus;
    if (!stale && eventAt) filter["shiprocket.lastEventAt"] = { $not: { $gt: eventAt } };

    let order;
    try {
      order = await OrderModel.findOneAndUpdate(
        filter,
        push ? { $set: set, $push: push } : { $set: set },
        { returnDocument: "after" },
      );
    } catch (error) {
      // E11000: the identifier this event carries already belongs to a DIFFERENT
      // order. Refuse the event rather than corrupt either order.
      if (error?.code === 11000) {
        logLifecycleError("shipping", "shiprocket_webhook_identifier_conflict", error, {
          orderId,
          ...resolution.identifiers,
          source,
        });
        return { scope: "ignored", reason: "identifier_belongs_to_another_order" };
      }
      throw error;
    }

    if (!order) {
      // Lost the race; go round once more against fresh state.
      continue;
    }

    if (exceptionMeaning && !adoptedCancellation && !stale) {
      logLifecycleEvent("shipping", "shiprocket_shipment_exception", {
        orderId: String(orderId),
        orderStatus: existing.orderStatus,
        statusCode,
        currentStatus,
        meaning: exceptionMeaning,
        awbCode: awbCode || null,
        source,
      });
    }

    await runSideEffects({ order, existing, mappedStatus, applyStatus, statusCode, currentStatus });

    return {
      scope: "order",
      orderId: String(orderId),
      hops: applyStatus ? path.map((hop) => hop.to) : [],
      stale,
      ...(adoptedCancellation ? { adoptedCancellation: true } : {}),
    };
  }

  logLifecycleEvent("shipping", "courier_event_lost_race_twice", { orderId, statusCode, source });
  return { scope: "ignored", reason: "concurrent_change" };
};

const runSideEffects = async ({ order, existing, mappedStatus, applyStatus, statusCode, currentStatus }) => {
  // COD cash is booked only when Delivered was actually APPLIED. A stale Delivered
  // event for an order the customer already cancelled is refused by the transition
  // rules, so booking cash here would be phantom revenue.
  if (applyStatus && mappedStatus === "Delivered") {
    await OrderModel.updateOne(
      { _id: order._id, paymentMethod: "COD", paymentStatus: "Pending" },
      { $set: { paymentStatus: "Paid" } },
    );
  }

  // Delivery is the point of supply, so the bill of supply is numbered here too. The
  // `existing === Delivered` half lets a duplicate event repair a mint that failed the
  // first time; ensureBillNumber is CAS-protected, so that is genuinely idempotent.
  if (mappedStatus === "Delivered" && (applyStatus || existing.orderStatus === "Delivered")) {
    await ensureBillNumber(order._id).catch((error) =>
      logLifecycleError("shipping", "bill_number_mint_failed", error, { orderId: String(order._id) }),
    );
  }

  // The parcel is physically back. Money only — stock waits for the operator's
  // inspection (RecordRtoDisposition). Gated on where the order ENDED UP, not on the
  // code alone: a code 10 that could not legally move the order (e.g. it was already
  // Delivered) must not create a refund liability for goods the customer still has.
  // Not gated on applyStatus, so a replayed arrival on an order already at
  // "RTO Received" still finds the (idempotent) obligation.
  if (order.orderStatus === "RTO Received" && (applyStatus || isRtoReceived(statusCode, currentStatus))) {
    await recordRtoRefundObligation(order).catch((error) =>
      logLifecycleError("shipping", "rto_refund_obligation_failed", error, { orderId: String(order._id) }),
    );
    // The wallet credit and coupon use the order consumed go back too, same as the
    // admin move to RTO Received. Idempotent, so a replayed arrival changes nothing.
    await releaseRtoOrderCredits(order._id).catch((error) =>
      logLifecycleError("shipping", "rto_credit_release_failed", error, { orderId: String(order._id) }),
    );
  }

  // Never tell the customer about a status we refused to record.
  if (applyStatus) {
    await notifyShipmentUpdated({ orderId: order._id, status: mappedStatus });
  }
};
