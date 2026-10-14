import OrderModel from "../orders/Order.model.js";
import ReturnModel from "../returns/return.model.js";
import ShiprocketSetting from "./ShiprocketSetting.model.js";
import { EXCLUDE_AWAITING_PAYMENT } from "../orders/order-visibility.js";
import {
  SHIPMENT_CANCELLATION_PENDING,
  autoAssignForwardAwb,
  cancelShipmentForCancelledOrder,
  createForwardShipment,
} from "../orders/order-shipping.service.js";
import {
  getShipment,
  getShippingCapabilities,
  readShipmentAwb,
  trackAwb,
} from "./shiprocket.service.js";
import { applyCourierEvent } from "./courier-event.service.js";
import { normalizeTracking } from "./tracking-normalize.js";
import { logLifecycleError, logLifecycleEvent } from "../../utils/lifecycle-logger.service.js";

/**
 * The safety net under the courier webhook.
 *
 * The webhook is the primary source of courier truth, but it is a push from a third
 * party: an event can be lost, arrive while the server is restarting, or never be sent.
 * Before this, nothing ever asked Shiprocket again — an order whose "Delivered" event
 * went missing stayed "Shipped" forever, its COD cash never recorded and its return
 * window never opened. Likewise a courier cancellation that timed out stayed pending
 * until someone noticed, and a failed auto-push was simply never retried.
 *
 * Each pass does five bounded jobs, every one of them already safe to repeat:
 *
 *   a. tracking   — orders with no courier update for `trackingStaleMinutes` have their
 *                   AWB polled, and the answer goes through the SAME courier-event
 *                   pipeline as the webhook (identity, legality, ordering, catch-up).
 *   b. cancels    — cancelled orders whose courier shipment is still live are retried
 *                   with exponential backoff; after `maxRetryAttempts` they become a
 *                   recorded exception for a person.
 *   c. auto-push  — when auto-push is on, orders whose push definitely FAILED (or that
 *                   recently missed it entirely) are retried through the claim-guarded
 *                   createForwardShipment. An order whose creation outcome is UNKNOWN
 *                   ("creating") is never retried — that is how a second courier gets
 *                   booked — it is reported instead (e).
 *   d. return AWB — return pickups and replacements booked through Shiprocket get their
 *                   AWB fetched once Shiprocket has assigned one; without it no courier
 *                   event can ever be matched to the return.
 *   e. stale claims — counted and logged for the exceptions queue; never touched.
 *
 * Throttling: every job is batch-bounded, and a rate-limit or outage answer (503 from
 * request(), which is how 429 and "unreachable" surface) ends the pass early instead of
 * continuing to hit an API that has just said stop.
 *
 * Runs in-process on a self-rescheduling timer. The deployment is a single PM2 fork
 * process, and every write below is claim- or CAS-protected anyway, so an in-process
 * `running` guard is enough to stop overlapping passes; the admin "run now" endpoint
 * shares the same guard.
 */

const BATCH = 25;
const RETRY_BASE_MS = 5 * 60 * 1000;
const RETRY_CAP_MS = 24 * 60 * 60 * 1000;
// An order younger than this is left to the inline auto-push it was confirmed with;
// retrying it here would only race that push into the claim.
const AUTO_PUSH_GRACE_MS = 10 * 60 * 1000;
// "not_created" (never attempted) is picked up only for orders this recent. An older
// one is far more likely a store that fulfilled manually and has just switched
// auto-push on — pushing its whole history would book couriers for parcels long gone.
const AUTO_PUSH_MISSED_WINDOW_MS = 48 * 60 * 60 * 1000;
const STALE_CLAIM_MS = 10 * 60 * 1000;

const ACTIVE_COURIER_STATUSES = ["Confirmed", "Packed", "Shipped", "Out For Delivery", "NDR", "RTO"];

let running = false;
let timer = null;
let lastRun = null;

export const backoffDelayMs = (attempts) =>
  Math.min(RETRY_BASE_MS * 2 ** Math.max(0, Number(attempts) - 1), RETRY_CAP_MS);

/** A Shiprocket answer that means "stop asking for now". */
const isThrottleOrOutage = (error) =>
  Number(error?.statusCode) === 503 || Number(error?.httpStatus) === 429;

class PassHalted extends Error {}

/**
 * Narrows a pass to given order/return ids. Exists for the regression suite, which runs
 * against a shared database and must never reconcile orders it did not create; in
 * production `scope` is absent and these add nothing to the queries.
 */
const orderScope = (scope) => (scope?.orderIds ? { _id: { $in: scope.orderIds } } : {});
const returnScope = (scope) => (scope?.returnIds ? { _id: { $in: scope.returnIds } } : {});

const readSettings = async () => {
  const settings = await ShiprocketSetting.getSettings();
  return {
    enabled: settings.reconciliationEnabled !== false,
    intervalMinutes: Number(settings.reconcileIntervalMinutes) || 15,
    trackingStaleMinutes: Number(settings.trackingStaleMinutes) || 360,
    maxRetryAttempts: Number(settings.maxRetryAttempts) || 5,
  };
};

const envAllows = () => String(process.env.SHIPPING_RECONCILE_ENABLED ?? "").trim().toLowerCase() !== "false";

// ── a. tracking ─────────────────────────────────────────────────────────────
const reconcileTracking = async ({ now, settings, summary, scope }) => {
  const cutoff = new Date(now - settings.trackingStaleMinutes * 60 * 1000);
  const orders = await OrderModel.find({
    ...orderScope(scope),
    "shiprocket.awbCode": { $type: "string" },
    orderStatus: { $in: ACTIVE_COURIER_STATUSES },
    "shipment.provider": { $ne: "MANUAL" },
    $and: [
      { $or: [{ "shiprocket.lastSyncedAt": null }, { "shiprocket.lastSyncedAt": { $lt: cutoff } }] },
      { $or: [{ "shiprocket.trackingCheckedAt": null }, { "shiprocket.trackingCheckedAt": { $lt: cutoff } }] },
    ],
    ...EXCLUDE_AWAITING_PAYMENT,
  })
    .select("_id shiprocket.awbCode orderStatus")
    .sort({ "shiprocket.lastSyncedAt": 1 })
    .limit(BATCH)
    .lean();

  for (const order of orders) {
    const awbCode = order.shiprocket.awbCode;
    // Stamped first, success or not: an AWB that Shiprocket cannot answer for is then
    // asked about once per stale window, not on every pass.
    await OrderModel.updateOne({ _id: order._id }, { $set: { "shiprocket.trackingCheckedAt": new Date() } });
    let response;
    try {
      response = await trackAwb(awbCode);
    } catch (error) {
      if (isThrottleOrOutage(error)) throw new PassHalted(error.message);
      summary.tracking.errors += 1;
      logLifecycleEvent("shipping", "reconcile_tracking_failed", { orderId: order._id, awbCode, reason: error.message });
      continue;
    }
    const tracking = normalizeTracking(response, { awbCode });
    if (!tracking.hasTracking || (!tracking.statusCode && !tracking.currentStatus)) {
      summary.tracking.noData += 1;
      continue;
    }
    const result = await applyCourierEvent(
      {
        sourceOrderId: String(order._id),
        awbCode,
        statusCode: tracking.statusCode,
        currentStatus: tracking.currentStatus,
        courierName: tracking.courierName,
        eventAt: tracking.eventAt,
      },
      { source: "reconciler" },
    );
    summary.tracking.checked += 1;
    if (result.hops?.length) {
      summary.tracking.advanced += 1;
      logLifecycleEvent("shipping", "reconcile_tracking_advanced", {
        orderId: order._id,
        from: order.orderStatus,
        hops: result.hops,
      });
    }
  }
};

// ── b. courier cancellations ───────────────────────────────────────────────
const reconcileCancellations = async ({ now, settings, summary, scope }) => {
  const orders = await OrderModel.find({
    ...orderScope(scope),
    ...SHIPMENT_CANCELLATION_PENDING,
    "shiprocket.cancelAttempts": { $not: { $gte: settings.maxRetryAttempts } },
    $or: [{ "shiprocket.nextAttemptAt": null }, { "shiprocket.nextAttemptAt": { $lte: new Date(now) } }],
  })
    // Oldest-due first, then oldest order: deterministic, and a long backlog is worked
    // through fairly instead of the same few being retried while others wait.
    .sort({ "shiprocket.nextAttemptAt": 1, _id: 1 })
    .limit(BATCH)
    .lean();

  for (const order of orders) {
    const result = await cancelShipmentForCancelledOrder(order);
    if (result.cancelled) {
      summary.cancellations.cancelled += 1;
      continue;
    }
    if (!result.attempted) {
      // Shiprocket switched off or unconfigured: nothing was tried, so nothing is
      // counted against the retry budget.
      summary.cancellations.skipped += 1;
      continue;
    }
    // Throttled or unreachable: Shiprocket did not judge this cancellation, so it costs
    // no attempt — and the rest of the pass stops rather than keep asking.
    if (isThrottleOrOutage(result)) throw new PassHalted(result.error || "Shiprocket throttled or unreachable");
    const attempts = Number(order.shiprocket?.cancelAttempts || 0) + 1;
    const exhausted = attempts >= settings.maxRetryAttempts;
    await OrderModel.updateOne(
      { _id: order._id },
      {
        $set: {
          "shiprocket.cancelAttempts": attempts,
          "shiprocket.nextAttemptAt": new Date(Date.now() + backoffDelayMs(attempts)),
          ...(exhausted
            ? {
                "shiprocket.exception": {
                  code: null,
                  meaning: `courier cancellation failed ${attempts} times — cancel it in Shiprocket, then retry here`,
                  at: new Date(),
                },
              }
            : {}),
        },
      },
    );
    summary.cancellations.failed += 1;
    if (exhausted) {
      summary.cancellations.exhausted += 1;
      logLifecycleError(
        "shipping",
        "reconcile_cancellation_exhausted",
        new Error(result.error || "courier cancellation failed"),
        { orderId: order._id, attempts },
      );
    }
  }
};

// ── c. auto-push retries ────────────────────────────────────────────────────
const reconcileAutoPush = async ({ now, settings, summary, scope }) => {
  const graceCutoff = new Date(now - AUTO_PUSH_GRACE_MS);
  const missedWindowStart = new Date(now - AUTO_PUSH_MISSED_WINDOW_MS);
  const orders = await OrderModel.find({
    ...orderScope(scope),
    orderStatus: { $in: ["Confirmed", "Packed"] },
    "shiprocket.orderId": null,
    "shipment.trackingNumber": { $in: [null, ""] },
    createdAt: { $lte: graceCutoff },
    "shiprocket.attempts": { $not: { $gte: settings.maxRetryAttempts } },
    $and: [
      {
        $or: [
          { "shiprocket.syncStatus": "failed" },
          {
            "shiprocket.syncStatus": { $in: ["not_created", null] },
            createdAt: { $gte: missedWindowStart, $lte: graceCutoff },
          },
        ],
      },
      { $or: [{ "shiprocket.nextAttemptAt": null }, { "shiprocket.nextAttemptAt": { $lte: new Date(now) } }] },
    ],
    ...EXCLUDE_AWAITING_PAYMENT,
  })
    .select("_id shiprocket.attempts")
    .sort({ "shiprocket.nextAttemptAt": 1, createdAt: 1 })
    .limit(BATCH)
    .lean();

  for (const order of orders) {
    const result = await createForwardShipment(order._id, { source: "reconciler" });
    if (result.outcome === "created" || result.outcome === "already_created") {
      summary.autoPush.created += 1;
      // A retried push finishes the same way a first-time one does. Only on "created":
      // "already_created" means another caller made it, and that caller assigns. Awaited
      // here — no customer is waiting on this pass. Never throws; checks autoAwb itself.
      if (result.outcome === "created") {
        await autoAssignForwardAwb(order._id, { source: "reconciler" });
      }
      continue;
    }
    if (result.outcome === "failed") {
      const attempts = Number(order.shiprocket?.attempts || 0) + 1;
      await OrderModel.updateOne(
        { _id: order._id, "shiprocket.syncStatus": "failed" },
        { $set: { "shiprocket.nextAttemptAt": new Date(Date.now() + backoffDelayMs(attempts)) } },
      );
      summary.autoPush.failed += 1;
      if (isThrottleOrOutage(result.error)) throw new PassHalted(result.message);
      continue;
    }
    // uncertain / in_progress / not shippable: never retried here.
    summary.autoPush.skipped += 1;
    if (result.outcome === "uncertain") throw new PassHalted(result.message);
  }
};

// ── d. return-leg AWBs ──────────────────────────────────────────────────────
const RETURN_LEGS = [
  {
    leg: "pickup",
    shipmentField: "pickupShipmentId",
    awbField: "pickupAwb",
    courierField: "pickupCourier",
    statuses: ["pickup_scheduled"],
  },
  {
    leg: "replacement",
    shipmentField: "replacementShipmentId",
    awbField: "replacementAwb",
    courierField: "replacementCourier",
    statuses: ["received"],
  },
];

export const syncReturnLegAwb = async (returnId, legName) => {
  const leg = RETURN_LEGS.find((entry) => entry.leg === legName);
  if (!leg) return { ok: false, reason: "unknown_leg" };
  const current = await ReturnModel.findById(returnId).lean();
  if (!current) return { ok: false, reason: "not_found" };
  if (current[leg.awbField]) return { ok: true, alreadyRecorded: true, awbCode: current[leg.awbField] };
  if (!current[leg.shipmentField]) return { ok: false, reason: "not_booked" };

  const { awbCode, courierName } = readShipmentAwb(await getShipment(current[leg.shipmentField]));
  if (!awbCode) return { ok: false, reason: "awb_not_assigned_yet" };

  try {
    // Conditional: never overwrite an AWB an admin recorded meanwhile.
    const updated = await ReturnModel.findOneAndUpdate(
      { _id: returnId, [leg.awbField]: { $in: [null, ""] } },
      {
        $set: {
          [leg.awbField]: awbCode,
          ...(courierName ? { [leg.courierField]: courierName } : {}),
        },
        $push: {
          statusHistory: {
            status: current.status,
            changedBy: null,
            note: `${leg.leg === "pickup" ? "Pickup" : "Replacement"} AWB ${awbCode} synced from Shiprocket`,
          },
        },
      },
      { returnDocument: "after" },
    );
    return updated ? { ok: true, awbCode, courierName } : { ok: true, alreadyRecorded: true };
  } catch (error) {
    if (error?.code === 11000) {
      logLifecycleError("returns", "return_awb_sync_conflict", error, { returnId, leg: leg.leg, awbCode });
      return { ok: false, reason: "awb_belongs_to_another_shipment" };
    }
    throw error;
  }
};

const reconcileReturnAwbs = async ({ summary, scope }) => {
  for (const leg of RETURN_LEGS) {
    const returns = await ReturnModel.find({
      ...returnScope(scope),
      status: { $in: leg.statuses },
      [leg.shipmentField]: { $type: "number" },
      [leg.awbField]: { $in: [null, ""] },
    })
      .select("_id")
      .limit(BATCH)
      .lean();
    for (const entry of returns) {
      try {
        const result = await syncReturnLegAwb(entry._id, leg.leg);
        if (result.ok && result.awbCode && !result.alreadyRecorded) summary.returnAwbs.synced += 1;
        else summary.returnAwbs.pending += 1;
      } catch (error) {
        if (isThrottleOrOutage(error)) throw new PassHalted(error.message);
        summary.returnAwbs.errors += 1;
      }
    }
  }
};

// ── e. stale creation claims ─────────────────────────────────────────────────
const reportStaleClaims = async ({ now, summary, scope }) => {
  const stale = await OrderModel.find({
    ...orderScope(scope),
    "shiprocket.syncStatus": "creating",
    "shiprocket.claimedAt": { $lt: new Date(now - STALE_CLAIM_MS) },
  })
    .select("_id shiprocket.claimedAt shiprocket.lastError")
    .limit(BATCH)
    .lean();
  summary.staleClaims = stale.length;
  if (stale.length) {
    logLifecycleError(
      "shipping",
      "reconcile_stale_creation_claims",
      new Error(`${stale.length} shipment creation(s) have an unknown outcome and need an admin`),
      { orderIds: stale.map((order) => String(order._id)) },
    );
  }
};

const emptySummary = () => ({
  tracking: { checked: 0, advanced: 0, noData: 0, errors: 0 },
  cancellations: { cancelled: 0, failed: 0, exhausted: 0, skipped: 0 },
  autoPush: { created: 0, failed: 0, skipped: 0 },
  returnAwbs: { synced: 0, pending: 0, errors: 0 },
  staleClaims: 0,
});

/**
 * One reconciliation pass.
 *
 * @param {{reason?: string, now?: number, scope?: {orderIds?: Array, returnIds?: Array}}} [options]
 *   `now` and `scope` are injectable for tests.
 * @returns {Promise<{ran: boolean, reason?: string, halted?: string, summary?: object}>}
 */
export const runReconciliationPass = async ({ reason = "scheduled", now = Date.now(), scope = null } = {}) => {
  if (running) return { ran: false, reason: "already_running" };
  running = true;
  const startedAt = new Date();
  try {
    if (!envAllows()) return { ran: false, reason: "disabled_by_env" };
    const settings = await readSettings();
    if (!settings.enabled) return { ran: false, reason: "disabled_in_settings" };
    const capabilities = await getShippingCapabilities();
    if (!capabilities.shipments || !capabilities.configured) {
      return { ran: false, reason: "shiprocket_not_in_use" };
    }

    const summary = emptySummary();
    let halted = null;
    const context = { now, settings, summary, scope };
    try {
      await reconcileTracking(context);
      await reconcileCancellations(context);
      if (capabilities.autoPush) await reconcileAutoPush(context);
      await reconcileReturnAwbs(context);
    } catch (error) {
      if (!(error instanceof PassHalted)) throw error;
      halted = error.message;
      logLifecycleEvent("shipping", "reconcile_pass_halted", { reason: halted });
    }
    await reportStaleClaims(context);

    lastRun = { at: startedAt, reason, halted, summary };
    logLifecycleEvent("shipping", "reconcile_pass_finished", { reason, halted, ...summary });
    return { ran: true, halted, summary };
  } catch (error) {
    lastRun = { at: startedAt, reason, error: error.message };
    logLifecycleError("shipping", "reconcile_pass_failed", error, { reason });
    return { ran: false, reason: "error", error: error.message };
  } finally {
    running = false;
  }
};

export const getReconciliationStatus = () => ({ running, lastRun });

const scheduleNext = async () => {
  let minutes = 15;
  try {
    minutes = (await readSettings()).intervalMinutes;
  } catch {
    // Settings unreadable (DB hiccup): fall back to the default rather than stop.
  }
  // Stopped while the settings were being read (graceful shutdown): stay stopped.
  if (timer === null) return;
  timer = setTimeout(async () => {
    await runReconciliationPass({ reason: "scheduled" });
    if (timer) scheduleNext();
  }, minutes * 60 * 1000);
  timer.unref?.();
};

/**
 * Starts the self-rescheduling timer. Idempotent per process. A chained setTimeout,
 * not setInterval: a slow pass can never overlap the next, and an interval changed in
 * the admin panel takes effect from the following pass.
 */
export const startShippingReconciliation = () => {
  if (timer || !envAllows()) return;
  timer = true; // reserve before the first await so a second call is a no-op
  scheduleNext();
};

export const stopShippingReconciliation = () => {
  if (timer && timer !== true) clearTimeout(timer);
  timer = null;
};
