import crypto from "node:crypto";
import OrderModel from "./Order.model.js";
import { getFeatures } from "../../config/features.config.js";
import {
  cancelShiprocketOrder,
  checkCodServiceability,
  computeShipmentLines,
  getShippingCapabilities,
  createShiprocketOrder,
  getShiprocketOrder,
  isDefiniteShiprocketRejection,
  readReportedOrderTotal,
} from "../shipping/shiprocket.service.js";
import { logLifecycleEvent, logLifecycleError } from "../../utils/lifecycle-logger.service.js";
import { INDIAN_PINCODE_REGEX } from "../../config/india-geo.config.js";
import { EXCLUDE_AWAITING_PAYMENT, isAwaitingPayment } from "./order-visibility.js";

/**
 * A shipment that our records say should be cancelled but Shiprocket has not
 * confirmed yet.
 *
 * Deliberately DERIVED rather than stored as a new state. The two facts that
 * matter already exist: the order is cancelled locally, and a shipment exists
 * whose syncStatus is not yet "cancelled". A `cancel_pending` enum value would be
 * a third copy of that truth, free to drift out of step with both.
 *
 * Unambiguous because nothing else drives an order with a shipment to Cancelled:
 * `UpdateOrderStatus` refuses "Cancelled" outright (USE_CANCEL_ENDPOINT), and the
 * abandoned-checkout sweeper only touches unpaid prepaid orders, which never have
 * a shipment.
 */
export const SHIPMENT_CANCELLATION_PENDING = {
  orderStatus: "Cancelled",
  "shiprocket.orderId": { $ne: null },
  "shiprocket.syncStatus": { $ne: "cancelled" },
};

/**
 * Shiprocket's way of saying "this was already cancelled".
 *
 * Treated as success, and that is the whole reconciliation story for this
 * operation: if an earlier attempt's response was lost, the retry finds the
 * shipment already cancelled and adopts it. There is no way to *query* order state
 * in this integration (only `trackAwb`, which needs an AWB that a pre-dispatch
 * cancellation does not have), so retrying and reading the answer is the only
 * mechanism available — and it is sufficient here, because cancelling twice is
 * harmless.
 */
const isAlreadyCancelled = (error) =>
  /already\s+(been\s+)?cancell?ed|order\s+is\s+cancell?ed/i.test(String(error?.message || ""));

/**
 * Cancels the courier shipment for an order that has ALREADY been cancelled locally.
 *
 * Runs strictly after the local cancellation is committed. The previous ordering
 * called Shiprocket *before* the local claim, so two concurrent cancellations both
 * cancelled the shipment while only one could win the claim — and if the winner's
 * transaction then failed, the order stayed active with its parcel already
 * cancelled at the courier. The local order state is authoritative; the courier is
 * told afterwards.
 *
 * Unlike a refund, this operation is IDEMPOTENT IN EFFECT: it names one Shiprocket
 * order, the end state is terminal, and repeating it moves no money and cannot
 * touch a different order. So a plain retry is safe and no attempt-claim or
 * verify-before-retry is needed — the machinery the refund paths need would be
 * cargo-culting here.
 *
 * Never throws. The local cancellation, the restock, the wallet credit, the coupon
 * release and the refund liability are all already committed, and a courier API
 * problem must not undo or obscure any of them. A failure leaves the derived
 * pending state above, plus the reason in `shiprocket.lastError`.
 *
 * @returns {{attempted: boolean, cancelled: boolean, reason?: string, adopted?: boolean, error?: string}}
 */
export const cancelShipmentForCancelledOrder = async (order) => {
  const shiprocketOrderId = order?.shiprocket?.orderId;
  if (!shiprocketOrderId) return { attempted: false, cancelled: false, reason: "no_shipment" };
  if (order.shiprocket?.syncStatus === "cancelled") {
    return { attempted: false, cancelled: true, reason: "already_cancelled" };
  }
  // Uses `shipments` rather than the raw env flag: if the admin has moved the store to
  // manual fulfilment, we must not call Shiprocket to cancel either — and the shipment
  // genuinely still exists at the courier, so it stays in the derived pending state.
  const capabilities = await getShippingCapabilities();
  if (!capabilities.shipments || !capabilities.configured) {
    // Left in the derived pending state on purpose rather than silently marked
    // cancelled: the shipment really does still exist at the courier.
    logLifecycleEvent("shipping", "shiprocket_cancel_skipped", {
      orderId: order?._id,
      shiprocketOrderId,
      reason: "shipping_disabled_or_unconfigured",
    });
    return { attempted: false, cancelled: false, reason: "shipping_disabled" };
  }

  const markCancelled = async () => {
    await OrderModel.updateOne(
      { _id: order._id },
      {
        $set: {
          "shiprocket.syncStatus": "cancelled",
          "shiprocket.status": "CANCELLED",
          "shiprocket.lastError": null,
          "shiprocket.lastSyncedAt": new Date(),
        },
      },
    );
  };

  try {
    await cancelShiprocketOrder(shiprocketOrderId);
    await markCancelled();
    logLifecycleEvent("shipping", "shiprocket_cancel_succeeded", {
      orderId: order?._id,
      shiprocketOrderId,
    });
    return { attempted: true, cancelled: true };
  } catch (error) {
    if (isAlreadyCancelled(error)) {
      await markCancelled();
      logLifecycleEvent("shipping", "shiprocket_cancel_already_done", {
        orderId: order?._id,
        shiprocketOrderId,
      });
      return { attempted: true, cancelled: true, adopted: true };
    }

    // syncStatus is deliberately NOT set to "failed": that value means the
    // shipment SYNC failed, and overwriting the real fulfilment state
    // ("awb_assigned", say) would destroy the record of what actually exists at
    // the courier. The reason goes in lastError; the pending state stays derivable.
    await OrderModel.updateOne(
      { _id: order._id },
      {
        $set: {
          "shiprocket.lastError": `Cancellation failed: ${error.message}`,
          "shiprocket.lastSyncedAt": new Date(),
        },
      },
    ).catch(() => {});
    logLifecycleError("shipping", "shiprocket_cancel_failed", error, {
      orderId: order?._id,
      shiprocketOrderId,
    });
    // The status fields travel with the message so a caller can tell "Shiprocket said
    // slow down / is down" (stop and come back later) from "Shiprocket refused this
    // cancellation" (count it as a failed attempt) without parsing English.
    return {
      attempted: true,
      cancelled: false,
      error: error.message,
      statusCode: error?.statusCode ?? null,
      httpStatus: error?.httpStatus ?? null,
    };
  }
};

/**
 * Decides whether a COD order may be placed to this pincode.
 *
 * The admin panel has always offered "restrict COD by Shiprocket pincode
 * serviceability", and the setting was stored and read — but nothing in the order path
 * consulted it, so the restriction never applied. A customer could select COD for any
 * destination and the order was created. This function is that missing decision.
 *
 * FAILS CLOSED, and that is the whole point. A business restriction that cannot be
 * evaluated must refuse, not wave the order through: an expired token, a Shiprocket
 * outage or missing credentials would otherwise disable the restriction precisely when
 * nobody is watching. So "we could not ask" is treated the same as "no" — the customer
 * is told COD is unavailable for this address and pointed at online payment.
 *
 * Kept as a single pure-ish decision (one awaited carrier call, no writes) so it can be
 * exercised directly, and so every COD gate stays readable in one place in PlaceOrder.
 *
 * @returns {Promise<{allowed: boolean, reason: string, code?: string, message?: string, courierCount?: number}>}
 */
export const evaluateCodPincodeRestriction = async ({
  paymentMethod,
  restrictionEnabled,
  pincode,
} = {}) => {
  // Prepaid orders are untouched — the restriction is about collecting cash at the door.
  if (String(paymentMethod ?? "").toUpperCase() !== "COD") {
    return { allowed: true, reason: "not_cod" };
  }
  if (!restrictionEnabled) {
    return { allowed: true, reason: "restriction_disabled" };
  }

  // Re-validated with the project's existing rule rather than a new one. prepareOrderData
  // already enforces this, so reaching it here means the pincode was stripped or
  // tampered with on a path that skipped that validation.
  const normalized = String(pincode ?? "").trim();
  if (!INDIAN_PINCODE_REGEX.test(normalized)) {
    logLifecycleEvent("shipping", "cod_pincode_restriction_blocked", {
      reason: "invalid_pincode",
      pincode: normalized || null,
    });
    return {
      allowed: false,
      reason: "invalid_pincode",
      code: "COD_PINCODE_INVALID",
      message:
        "Enter a valid 6-digit delivery PIN code to pay by Cash on Delivery, or choose another payment method.",
    };
  }

  const result = await checkCodServiceability({ deliveryPostcode: normalized });

  if (result.serviceable) {
    return { allowed: true, reason: "serviceable", courierCount: result.courierCount };
  }

  // The distinction matters for OPERATORS — an outage needs investigating, an
  // unserviceable pincode does not — so the two are logged differently. The customer
  // sees the same message either way, and never the carrier's error text.
  if (result.unverified) {
    logLifecycleError(
      "shipping",
      "cod_serviceability_unverified",
      new Error(`COD serviceability could not be verified: ${result.reason}`),
      { pincode: normalized, reason: result.reason },
    );
  } else {
    logLifecycleEvent("shipping", "cod_pincode_not_serviceable", { pincode: normalized });
  }

  return {
    allowed: false,
    reason: result.unverified ? `unverified:${result.reason}` : "not_serviceable",
    code: result.unverified ? "COD_SERVICEABILITY_UNVERIFIED" : "COD_PINCODE_NOT_SERVICEABLE",
    message:
      "Cash on Delivery is not available for this delivery address. Please choose another payment method.",
  };
};

/**
 * The provider-neutral mirror of a shipment, as `$set` paths.
 *
 * Replaces the old `syncShipmentMirror(order, …)`, which mutated a loaded document that
 * was then saved whole — the write that let a stale snapshot overwrite concurrent
 * changes. Returning paths lets every caller fold the mirror into its own single,
 * filtered update.
 *
 * Shiprocket remains the source of truth for its own shipments: this writes a mirror,
 * never the other way round. Blank values are skipped rather than written, because a
 * partial result must not blank a courier name established earlier.
 *
 * `shipment.status` is deliberately NOT here. It mirrors the order's own status and must
 * come from the order as it is at write time, not from a snapshot read earlier — callers
 * that want it use an update pipeline and set it to `"$orderStatus"` (see
 * SHIPMENT_STATUS_FROM_ORDER), which reads the value inside the same atomic write.
 */
export const buildShipmentMirrorSet = ({ provider = "SHIPROCKET", carrierName, trackingNumber } = {}) => ({
  "shipment.provider": provider,
  ...(carrierName ? { "shipment.carrierName": String(carrierName) } : {}),
  ...(trackingNumber ? { "shipment.trackingNumber": String(trackingNumber) } : {}),
  "shipment.updatedAt": new Date(),
});

/** Pipeline `$set` entry that copies the order's CURRENT status into the mirror. */
export const SHIPMENT_STATUS_FROM_ORDER = { "shipment.status": "$orderStatus" };

/**
 * Wraps plain values for use in an update pipeline. Inside a pipeline a string starting
 * with "$" is a field path, so anything that came from outside (a courier name, a status
 * text) is passed as a literal — a value is never allowed to become an expression.
 */
const literalSet = (fields) =>
  Object.fromEntries(Object.entries(fields).map(([path, value]) => [path, { $literal: value }]));

/** Keeps the current value when one is already stored; otherwise writes `value`. */
const keepExisting = (path, value) => ({ $ifNull: [`$${path}`, { $literal: value }] });

/**
 * The single write that records a created shipment.
 *
 * Shared by the forward create and by the admin "link existing shipment" resolution, so
 * both store a shipment the same way. An update PIPELINE rather than a document save,
 * for three reasons:
 *
 *   - Only the paths it names are written. The old `order.shiprocket = {...}; save()`
 *     replaced the whole subdocument from a snapshot, wiping anything a courier webhook
 *     had written while the create request was in flight.
 *   - Fields a webhook may legitimately have filled first — status, statusCode, AWB,
 *     courier — are written only if still empty (`$ifNull`). A webhook can land between
 *     Shiprocket creating the order and this write; its newer facts win.
 *   - syncStatus moves to created/awb_assigned only FROM "creating". If something has
 *     already moved it on (a webhook marking pickup), it is left alone.
 *
 * `filter` carries the precondition — the claim token for a create, `syncStatus:
 * "creating"` for a link — so a write whose precondition no longer holds changes
 * nothing and returns null.
 */
const writeBackShipment = (filter, { shiprocketOrderId, shipmentId, data = {}, packageDetails } = {}) => {
  const awbCode = String(data.awb_code || "").trim();
  const courierId = Number(data.courier_company_id) || null;
  const courierName = String(data.courier_name || "").trim();
  const now = new Date();
  const set = {
    ...literalSet({
      "shiprocket.orderId": shiprocketOrderId,
      "shiprocket.shipmentId": shipmentId,
      "shiprocket.lastError": null,
      "shiprocket.lastSyncedAt": now,
      ...buildShipmentMirrorSet({ provider: "SHIPROCKET", carrierName: courierName, trackingNumber: awbCode }),
    }),
    // Dotted per field: an object value here would be merged by $set-in-a-pipeline
    // rather than replaced, and being explicit costs nothing.
    ...(packageDetails
      ? literalSet(
          Object.fromEntries(
            ["length", "breadth", "height", "weight"].map((key) => [
              `shiprocket.package.${key}`,
              Number(packageDetails[key]) || null,
            ]),
          ),
        )
      : {}),
    "shiprocket.status": keepExisting("shiprocket.status", String(data.status || "NEW")),
    "shiprocket.statusCode": keepExisting("shiprocket.statusCode", Number(data.status_code) || null),
    ...(awbCode ? { "shiprocket.awbCode": keepExisting("shiprocket.awbCode", awbCode) } : {}),
    ...(courierId ? { "shiprocket.courierId": keepExisting("shiprocket.courierId", courierId) } : {}),
    ...(courierName ? { "shiprocket.courierName": keepExisting("shiprocket.courierName", courierName) } : {}),
    "shiprocket.syncStatus": {
      $cond: [
        { $eq: ["$shiprocket.syncStatus", "creating"] },
        { $literal: awbCode ? "awb_assigned" : "created" },
        "$shiprocket.syncStatus",
      ],
    },
    ...SHIPMENT_STATUS_FROM_ORDER,
  };

  return OrderModel.findOneAndUpdate(
    filter,
    [{ $set: set }, { $unset: ["shiprocket.claimToken", "shiprocket.claimedAt"] }],
    { returnDocument: "after", updatePipeline: true },
  );
};

const AMOUNT_TOLERANCE = 0.5;

/**
 * Reads the created order back from Shiprocket and compares its total with ours.
 *
 * The payload's money fields are our interpretation of an API whose arithmetic is not
 * fully documented (see computeShipmentLines). If Shiprocket reads them differently, the
 * courier collects the wrong cash on a COD order — and nothing in the create response
 * would say so. So the answer is checked rather than assumed.
 *
 * Tolerance of 50 paise absorbs Shiprocket rounding to the rupee. Never throws: a check
 * that cannot be made records `unverified`, which warns but does not block, because
 * blocking every COD shipment on an API we cannot read would stop the store.
 *
 * @returns {Promise<{status: "ok"|"mismatch"|"unverified", expected: number, reported: number|null}>}
 */
export const runShipmentAmountCheck = async (orderId, shiprocketOrderId, expected) => {
  let reported = null;
  let reason = null;
  try {
    reported = readReportedOrderTotal(await getShiprocketOrder(shiprocketOrderId));
    if (reported === null) reason = "total_not_found_in_response";
  } catch (error) {
    reason = error?.message || "request_failed";
  }

  const status =
    reported === null || !Number.isFinite(Number(expected))
      ? "unverified"
      : Math.abs(reported - Number(expected)) > AMOUNT_TOLERANCE
        ? "mismatch"
        : "ok";
  const amountCheck = {
    status,
    expected: Number.isFinite(Number(expected)) ? Number(expected) : null,
    reported,
    checkedAt: new Date(),
    acknowledgedAt: null,
    acknowledgedBy: null,
  };

  try {
    await OrderModel.updateOne({ _id: orderId }, { $set: { "shiprocket.amountCheck": amountCheck } });
  } catch (error) {
    logLifecycleError("shipping", "shiprocket_amount_check_write_failed", error, { orderId });
  }

  const context = { orderId, shiprocketOrderId, expected: amountCheck.expected, reported, reason };
  if (status === "mismatch") {
    logLifecycleError(
      "shipping",
      "shiprocket_amount_mismatch",
      new Error(`Shiprocket holds ₹${reported} for this order; expected ₹${amountCheck.expected}`),
      context,
    );
  } else {
    logLifecycleEvent("shipping", `shiprocket_amount_${status}`, context);
  }
  return { status, expected: amountCheck.expected, reported };
};

/** Statuses from which a forward shipment may be CLAIMED. */
const CLAIMABLE_SYNC_STATUSES = ["not_created", "failed", null];
const SHIPPABLE_ORDER_STATUSES = ["Confirmed", "Packed"];

/**
 * Creates the forward Shiprocket shipment for an order — at most once.
 *
 * ── Why a claim ─────────────────────────────────────────────────────────────
 * Nothing used to stop two creations racing: a double click on Create Shipment, or the
 * browser-verify path and the payment webhook each auto-pushing the same order, both
 * read "no shiprocket.orderId" and both called Shiprocket — two courier orders for one
 * parcel. Now one atomic update wins the right to call Shiprocket (syncStatus
 * "creating" + a claim token) and every other caller is told what happened instead.
 *
 * The payload is built from the document THAT update returned, so it describes the
 * order as it was at the moment of the claim rather than a snapshot read earlier.
 *
 * ── Outcomes of the call ────────────────────────────────────────────────────
 *   - Created: one write-back, filtered on the claim token (writeBackShipment).
 *   - Definitely not created (failed before sending, or a clear 4xx refusal):
 *     syncStatus "failed", claim released — retrying is safe and allowed.
 *   - Anything else (timeout, network error, 5xx, 429, a 200 we could not read, our own
 *     DB write failing afterwards): the shipment MAY exist at Shiprocket. The claim is
 *     kept and syncStatus stays "creating" with the reason in lastError. Nothing retries
 *     it automatically — a retry is exactly how a second courier gets booked. An admin
 *     resolves it: link the shipment that exists, or confirm that none does.
 *
 * If the order was cancelled while the request was in flight, the shipment just created
 * is cancelled at once rather than left live for an operator to find.
 *
 * Never throws for an expected outcome; returns one of:
 *   { outcome: "created", order, amountCheck }
 *   { outcome: "already_created", order }
 *   { outcome: "in_progress", statusCode: 409, code: "SHIPMENT_CREATION_IN_PROGRESS", message }
 *   { outcome: "awaiting_payment", statusCode: 409, code: "PAYMENT_NOT_CAPTURED", message }
 *   { outcome: "not_fulfillable", statusCode: 409, code: "ORDER_NOT_SHIPPABLE", message }
 *   { outcome: "not_found", statusCode: 404, message }
 *   { outcome: "failed", statusCode, code: "SHIPMENT_CREATE_FAILED", message, error }
 *   { outcome: "uncertain", statusCode, code: "SHIPMENT_CREATE_UNCERTAIN", message, error }
 */
export const createForwardShipment = async (
  orderId,
  { packageOverrides = {}, source = "admin", actorId = null } = {},
) => {
  // Mongoose drops `_id: undefined` from a filter, which would let the claim below match
  // ANY order. A missing id must be a miss, never a wildcard.
  if (!orderId) return { outcome: "not_found", statusCode: 404, message: "Order not found" };

  const claimToken = crypto.randomUUID();
  const claimed = await OrderModel.findOneAndUpdate(
    {
      _id: orderId,
      "shiprocket.orderId": null,
      "shiprocket.syncStatus": { $in: CLAIMABLE_SYNC_STATUSES },
      orderStatus: { $in: SHIPPABLE_ORDER_STATUSES },
      // An unpaid prepaid checkout is not an order yet; booking a courier for it would
      // ship goods nobody has paid for.
      ...EXCLUDE_AWAITING_PAYMENT,
    },
    {
      $set: {
        "shiprocket.syncStatus": "creating",
        "shiprocket.claimToken": claimToken,
        "shiprocket.claimedAt": new Date(),
        "shiprocket.lastError": null,
      },
      $inc: { "shiprocket.attempts": 1 },
    },
    { returnDocument: "after" },
  );

  if (!claimed) return explainMissedClaim(orderId);

  const context = { orderId: claimed._id, source, actorId };
  logLifecycleEvent("shipping", "shiprocket_sync_started", context);

  try {
    // The email and the product measurements the payload needs.
    await claimed.populate([
      { path: "user", select: "email" },
      { path: "items.product", select: "_id weight length breadth height" },
    ]);
  } catch (error) {
    // A database error before any request: nothing was sent, so this is retryable.
    return recordCreateFailure({ orderId: claimed._id, claimToken, error, definite: true, context });
  }

  let created;
  try {
    created = await createShiprocketOrder(claimed, packageOverrides);
  } catch (error) {
    return recordCreateFailure({
      orderId: claimed._id,
      claimToken,
      error,
      definite: isDefiniteShiprocketRejection(error),
      context,
    });
  }

  const { data, packageDetails, shiprocketOrderId, shipmentId, lines } = created;
  let updated;
  try {
    updated = await writeBackShipment(
      { _id: claimed._id, "shiprocket.claimToken": claimToken },
      { shiprocketOrderId, shipmentId, data, packageDetails },
    );
  } catch (error) {
    // Shiprocket HAS the order; we failed to store it (E11000 on
    // shiprocket_orderId_unique, a dropped connection…). The ids go into lastError so
    // the admin can link them without searching Shiprocket's dashboard.
    const wrapped = new Error(
      `Shiprocket created order ${shiprocketOrderId} / shipment ${shipmentId}, but it could not be saved here: ${error.message}`,
    );
    return recordCreateFailure({ orderId: claimed._id, claimToken, error: wrapped, definite: false, context });
  }

  if (!updated) {
    // The claim was resolved by someone else while we waited (an admin confirming
    // "not created" on what looked like a stuck request). Our shipment exists at
    // Shiprocket but is no longer recorded; say so loudly rather than overwrite them.
    const error = new Error(
      `Shiprocket created order ${shiprocketOrderId} / shipment ${shipmentId}, but this attempt's claim had already been resolved, so it was not recorded. Link it from the order page or cancel it in Shiprocket.`,
    );
    logLifecycleError("shipping", "shiprocket_sync_claim_lost", error, {
      ...context,
      shiprocketOrderId,
      shipmentId,
    });
    await OrderModel.updateOne({ _id: claimed._id }, { $set: { "shiprocket.lastError": error.message } }).catch(() => {});
    return {
      outcome: "uncertain",
      statusCode: 409,
      code: "SHIPMENT_CREATE_UNCERTAIN",
      message: error.message,
      error,
    };
  }

  logLifecycleEvent("shipping", "shiprocket_sync_finished", {
    ...context,
    shiprocketOrderId,
    shipmentId,
    status: updated.shiprocket?.status,
  });

  if (updated.orderStatus === "Cancelled") {
    // Cancelled while the request was in flight: the cancellation already committed
    // and found no shipment to cancel, so it falls to us. Same helper and the same
    // never-throws contract as every other cancellation path.
    logLifecycleEvent("shipping", "shiprocket_created_for_cancelled_order", {
      ...context,
      shiprocketOrderId,
    });
    await cancelShipmentForCancelledOrder(updated);
    return { outcome: "created", order: await OrderModel.findById(claimed._id), amountCheck: null };
  }

  const amountCheck = await runShipmentAmountCheck(claimed._id, shiprocketOrderId, lines?.declaredTotal);
  return { outcome: "created", order: await OrderModel.findById(claimed._id), amountCheck };
};

/** Turns a lost claim into the reason, re-reading the order once. */
const explainMissedClaim = async (orderId) => {
  const current = await OrderModel.findById(orderId).lean();
  if (!current) return { outcome: "not_found", statusCode: 404, message: "Order not found" };
  if (current.shiprocket?.orderId) return { outcome: "already_created", order: current };
  if (current.shiprocket?.syncStatus === "creating") {
    return {
      outcome: "in_progress",
      statusCode: 409,
      code: "SHIPMENT_CREATION_IN_PROGRESS",
      message:
        "Shipment creation already in progress. If it does not finish, check Shiprocket and either link the shipment or confirm it was not created.",
    };
  }
  if (isAwaitingPayment(current)) {
    return {
      outcome: "awaiting_payment",
      statusCode: 409,
      code: "PAYMENT_NOT_CAPTURED",
      message: "This order has not been paid for yet, so it cannot be shipped.",
    };
  }
  return {
    outcome: "not_fulfillable",
    statusCode: 409,
    code: "ORDER_NOT_SHIPPABLE",
    message: SHIPPABLE_ORDER_STATUSES.includes(current.orderStatus)
      ? `A shipment cannot be created while its sync status is "${current.shiprocket?.syncStatus}".`
      : `Only Confirmed or Packed orders can be sent to Shiprocket (this one is ${current.orderStatus}).`,
  };
};

/**
 * Records a failed create, filtered on the claim token so it can never overwrite a
 * resolution made since. `definite` decides whether the claim is released.
 */
const recordCreateFailure = async ({ orderId, claimToken, error, definite, context }) => {
  const message = String(error?.message || "Shipment creation failed");
  const update = definite
    ? {
        $set: {
          "shiprocket.syncStatus": "failed",
          "shiprocket.lastError": message,
          "shiprocket.lastSyncedAt": new Date(),
        },
        $unset: { "shiprocket.claimToken": 1, "shiprocket.claimedAt": 1 },
      }
    : {
        // syncStatus stays "creating" and the claim stays held: the shipment may exist.
        $set: {
          "shiprocket.lastError": `Outcome unknown — check Shiprocket before retrying: ${message}`,
          "shiprocket.lastSyncedAt": new Date(),
        },
      };
  await OrderModel.updateOne({ _id: orderId, "shiprocket.claimToken": claimToken }, update).catch(
    (writeError) =>
      logLifecycleError("shipping", "shiprocket_sync_failure_not_recorded", writeError, context),
  );
  logLifecycleError("shipping", definite ? "shiprocket_sync_failed" : "shiprocket_sync_uncertain", error, {
    ...context,
    phase: error?.phase ?? null,
    httpStatus: error?.httpStatus ?? null,
  });
  return definite
    ? {
        outcome: "failed",
        statusCode: error?.statusCode || 502,
        code: "SHIPMENT_CREATE_FAILED",
        message,
        error,
      }
    : {
        outcome: "uncertain",
        statusCode: error?.statusCode && error.statusCode >= 500 ? error.statusCode : 502,
        code: "SHIPMENT_CREATE_UNCERTAIN",
        message: `Shiprocket may or may not have created this shipment (${message}). It will not be retried automatically — check Shiprocket, then link the shipment or confirm it was not created.`,
        error,
      };
};

/**
 * Admin resolution of a stuck "creating" claim: the shipment DOES exist at Shiprocket.
 * Uses the same write-back as a successful create; only valid while still "creating".
 *
 * @returns {Promise<{outcome: "linked"|"not_found"|"not_creating"|"conflict", order?: object}>}
 */
export const linkExistingShipment = async (orderId, { shiprocketOrderId, shipmentId }) => {
  if (!orderId) return { outcome: "not_found" };
  let updated;
  try {
    updated = await writeBackShipment(
      { _id: orderId, "shiprocket.syncStatus": "creating", "shiprocket.orderId": null },
      { shiprocketOrderId, shipmentId },
    );
  } catch (error) {
    if (error?.code === 11000) return { outcome: "conflict" };
    throw error;
  }
  if (!updated) {
    const exists = await OrderModel.exists({ _id: orderId });
    return { outcome: exists ? "not_creating" : "not_found" };
  }
  logLifecycleEvent("shipping", "shiprocket_shipment_linked", { orderId, shiprocketOrderId, shipmentId });
  if (updated.orderStatus === "Cancelled") {
    await cancelShipmentForCancelledOrder(updated);
    return { outcome: "linked", order: await OrderModel.findById(orderId), amountCheck: null };
  }

  // A linked shipment was created from a payload nobody saw come back, so its amount is
  // checked exactly like a fresh one. Skipped (unverified) when Shiprocket may not be
  // called at all, and when the order cannot be priced — never blocks the link itself.
  let expected = null;
  try {
    expected = computeShipmentLines(updated).declaredTotal;
  } catch {
    expected = null;
  }
  const capabilities = await getShippingCapabilities();
  const amountCheck =
    capabilities.shipments && capabilities.configured && expected !== null
      ? await runShipmentAmountCheck(orderId, shiprocketOrderId, expected)
      : await recordUnverifiedAmount(orderId, expected);
  return { outcome: "linked", order: await OrderModel.findById(orderId), amountCheck };
};

const recordUnverifiedAmount = async (orderId, expected) => {
  const amountCheck = {
    status: "unverified",
    expected,
    reported: null,
    checkedAt: new Date(),
    acknowledgedAt: null,
    acknowledgedBy: null,
  };
  await OrderModel.updateOne({ _id: orderId }, { $set: { "shiprocket.amountCheck": amountCheck } }).catch(() => {});
  return { status: "unverified", expected, reported: null };
};

/**
 * Admin resolution of a stuck "creating" claim: the shipment does NOT exist. Moves to
 * "failed", which makes it retryable again. Only valid while still "creating".
 *
 * @returns {Promise<{outcome: "confirmed"|"not_found"|"not_creating", order?: object}>}
 */
export const confirmShipmentNotCreated = async (orderId) => {
  if (!orderId) return { outcome: "not_found" };
  const updated = await OrderModel.findOneAndUpdate(
    { _id: orderId, "shiprocket.syncStatus": "creating", "shiprocket.orderId": null },
    {
      $set: {
        "shiprocket.syncStatus": "failed",
        "shiprocket.lastError": "An admin confirmed this shipment was not created in Shiprocket.",
        "shiprocket.lastSyncedAt": new Date(),
      },
      $unset: { "shiprocket.claimToken": 1, "shiprocket.claimedAt": 1 },
    },
    { returnDocument: "after" },
  );
  if (!updated) {
    const exists = await OrderModel.exists({ _id: orderId });
    return { outcome: exists ? "not_creating" : "not_found" };
  }
  logLifecycleEvent("shipping", "shiprocket_create_confirmed_absent", { orderId });
  return { outcome: "confirmed", order: updated };
};

/**
 * Admin acknowledgement of an amount mismatch, which unblocks AWB assignment.
 * Only a CURRENT, unacknowledged mismatch can be acknowledged.
 *
 * @returns {Promise<{outcome: "acknowledged"|"already_acknowledged"|"not_mismatch"|"not_found", order?: object}>}
 */
export const acknowledgeAmountMismatch = async (orderId, actorId) => {
  if (!orderId) return { outcome: "not_found" };
  const updated = await OrderModel.findOneAndUpdate(
    {
      _id: orderId,
      "shiprocket.amountCheck.status": "mismatch",
      "shiprocket.amountCheck.acknowledgedAt": null,
    },
    {
      $set: {
        "shiprocket.amountCheck.acknowledgedAt": new Date(),
        "shiprocket.amountCheck.acknowledgedBy": actorId || null,
      },
    },
    { returnDocument: "after" },
  );
  if (updated) return { outcome: "acknowledged", order: updated };
  const current = await OrderModel.findById(orderId);
  if (!current) return { outcome: "not_found" };
  if (current.shiprocket?.amountCheck?.status === "mismatch") {
    return { outcome: "already_acknowledged", order: current };
  }
  return { outcome: "not_mismatch", order: current };
};

export const syncOrderToShiprocketIfEnabled = async (order) => {
  // One capability call instead of three separate reads: `autoPush` already folds in
  // the env ceiling, the admin's "use Shiprocket for shipments" choice and the
  // auto-push choice, so those cannot drift apart at different call sites.
  const capabilities = await getShippingCapabilities();
  if (!capabilities.autoPush || !capabilities.configured) return;

  // Same claim as the admin button, so the verify path, the payment webhook and a
  // click can all arrive together and still create one shipment. Never throws: the
  // order is already placed and paid, and a courier problem must not fail that.
  try {
    const result = await createForwardShipment(order?._id, { source: "auto_push" });
    if (result.outcome !== "created") {
      logLifecycleEvent("shipping", "shiprocket_auto_push_skipped", {
        orderId: order?._id,
        outcome: result.outcome,
        code: result.code ?? null,
      });
    }
  } catch (error) {
    logLifecycleError("shipping", "shiprocket_sync_failed", error, { orderId: order?._id });
  }
};
