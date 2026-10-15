import { isPaymentEnabled } from "../../config/features.config.js";
import OrderModel from "../orders/Order.model.js";
import ReturnModel from "../returns/return.model.js";
import { logLifecycleError, logLifecycleEvent } from "../../utils/lifecycle-logger.service.js";
import { getRazorpay, getRazorpayErrorMessage } from "./razorpay.service.js";
import { applyGatewayRefundState } from "./return-refund.service.js";
import UnmatchedPayment from "./UnmatchedPayment.model.js";

/**
 * Keeps `created` gateway refunds moving to their final state.
 *
 * Razorpay answers a normal-speed refund with `pending` and settles it days
 * later. The refund webhook is the primary way we hear about that, but whether
 * the dashboard actually sends `refund.*` events is a setting outside this code,
 * and a missed delivery would leave the row "Refund Pending" forever. This module
 * is the two halves of closing that: a poller that asks Razorpay about rows still
 * waiting, and the resolver the webhook hands its events to. Both end in
 * applyGatewayRefundState, a compare-and-swap, so they can observe the same
 * settlement at the same moment and still notify the customer once.
 *
 * Neither ever ISSUES a refund. They only read what the gateway already did.
 */

const isDuplicateKeyError = (error) => error?.code === 11000;

// One run at a time. Production is a single PM2 fork, so a module flag is
// enough; a slow run must not have the next timer tick start a second one over
// the same rows.
let running = false;

/**
 * Asks Razorpay about `created` gateway refunds that already have a refund id.
 *
 * Each row is checked at most once per `resyncAfterMs`: every check — whatever
 * it found, including an error — stamps `gatewaySyncedAt`, which drops the row
 * out of the query until the window passes. That is also what rotates through a
 * backlog larger than `limit` without an index or a sort.
 *
 * @returns {{checked: number, changed: number, errors: number, skipped?: string}}
 */
export const syncPendingGatewayRefunds = async ({
  limit = 25,
  resyncAfterMs = 30 * 60_000,
  now = new Date(),
} = {}) => {
  if (!isPaymentEnabled()) {
    return { checked: 0, changed: 0, errors: 0, skipped: "payments_disabled" };
  }
  if (running) return { checked: 0, changed: 0, errors: 0, skipped: "already_running" };
  running = true;

  const cutoff = new Date(now.getTime() - resyncAfterMs);
  const due = (row) =>
    row.status === "created" &&
    typeof row.providerRefundId === "string" &&
    row.providerRefundId !== "" &&
    row.confirmationMethod !== "manual" &&
    (!row.gatewaySyncedAt || new Date(row.gatewaySyncedAt) <= cutoff);

  let checked = 0;
  let changed = 0;
  let errors = 0;

  try {
    const orders = await OrderModel.find(
      {
        refunds: {
          $elemMatch: {
            status: "created",
            providerRefundId: { $exists: true, $type: "string" },
            confirmationMethod: { $ne: "manual" },
            $or: [{ gatewaySyncedAt: null }, { gatewaySyncedAt: { $lte: cutoff } }],
          },
        },
      },
      { refunds: 1, razorpayPaymentId: 1 },
    )
      .limit(limit)
      .lean();

    const { razorpay } = getRazorpay();

    for (const order of orders) {
      for (const row of (order.refunds || []).filter(due)) {
        checked += 1;
        let moved = false;
        try {
          const gatewayRefund = await razorpay.payments.fetchRefund(
            row.providerPaymentId || order.razorpayPaymentId,
            row.providerRefundId,
          );
          const applied = await applyGatewayRefundState({
            orderId: order._id,
            refundId: row._id,
            gatewayRefund,
            source: "poller",
          });
          moved = applied.changed;
          if (moved) changed += 1;
        } catch (error) {
          errors += 1;
          logLifecycleError("payments", "refund_sync_row_failed", error, {
            orderId: String(order._id),
            refundId: String(row._id),
            providerRefundId: row.providerRefundId,
            message: getRazorpayErrorMessage(error),
          });
        }

        if (!moved) {
          // Still pending, lost the race, or the check errored: move the row to
          // the back of the queue so one stuck refund cannot starve the rest.
          await OrderModel.updateOne(
            { _id: order._id, "refunds._id": row._id },
            { $set: { "refunds.$.gatewaySyncedAt": now } },
          ).catch((error) =>
            logLifecycleError("payments", "refund_sync_stamp_failed", error, {
              orderId: String(order._id),
              refundId: String(row._id),
            }),
          );
        }
      }
    }
  } finally {
    running = false;
  }

  return { checked, changed, errors };
};

/**
 * Applies a Razorpay `refund.processed` / `refund.failed` webhook to the ledger.
 *
 * Finds the row three ways, in order of certainty:
 *
 *   1. by gateway refund id — the normal case, the id was recorded from the reply;
 *   2. by payment id + the refund's notes, for a row whose reply never arrived
 *      (a timeout): `notes.refundKey` matches the row's idempotencyKey, or
 *      `notes.returnNumber` matches the return the row settles. Only rows that
 *      do not yet carry a gateway id are candidates, so an event can never be
 *      pinned onto a row that belongs to a different refund;
 *   3. no ledger row at all: a refund of an orphaned capture (UnmatchedPayment).
 *      Those are recorded `refunded` the moment Razorpay accepts them, so a
 *      later `refund.failed` puts the record back in front of an operator.
 *
 * Replays are no-ops: the CAS in applyGatewayRefundState does not match a row
 * that has already moved. Errors other than a duplicate gateway id propagate, so
 * the webhook answers 5xx and Razorpay retries.
 *
 * @returns {{matched: boolean, via?: string, changed?: boolean, refundStatus?: string}}
 */
export const applyRazorpayRefundWebhook = async ({ event, refundEntity }) => {
  const status =
    event === "refund.processed" ? "processed" : event === "refund.failed" ? "failed" : null;
  const refundId = refundEntity?.id ? String(refundEntity.id) : "";
  if (!status || !refundId) return { matched: false };

  // The EVENT decides the status, not the entity's own field — they agree in
  // practice, and the event is what Razorpay signed for.
  const gatewayRefund = { ...refundEntity, status };
  const details = { event, providerRefundId: refundId, paymentId: refundEntity?.payment_id };

  let order = await OrderModel.findOne(
    { "refunds.providerRefundId": refundId },
    { refunds: 1, razorpayPaymentId: 1 },
  ).lean();
  let row = order?.refunds?.find((entry) => String(entry.providerRefundId) === refundId);
  let via = row ? "refund_id" : null;

  if (!row && refundEntity?.payment_id) {
    const byPayment = await OrderModel.findOne(
      { razorpayPaymentId: String(refundEntity.payment_id) },
      { refunds: 1, razorpayPaymentId: 1 },
    ).lean();
    if (byPayment) {
      const notes = refundEntity.notes || {};
      let returnId = null;
      if (notes.returnNumber) {
        const returnRequest = await ReturnModel.findOne(
          { returnNumber: String(notes.returnNumber) },
          { _id: 1 },
        ).lean();
        returnId = returnRequest?._id ? String(returnRequest._id) : null;
      }
      row = (byPayment.refunds || []).find(
        (entry) =>
          ["owed", "created"].includes(entry.status) &&
          !entry.providerRefundId &&
          ((notes.refundKey && entry.idempotencyKey === String(notes.refundKey)) ||
            (returnId && String(entry.returnRequest || "") === returnId)),
      );
      if (row) {
        order = byPayment;
        via = "payment_fallback";
      }
    }
  }

  if (row) {
    try {
      const applied = await applyGatewayRefundState({
        orderId: order._id,
        refundId: row._id,
        gatewayRefund,
        source: "webhook",
      });
      return { matched: true, via, changed: applied.changed, refundStatus: applied.refundStatus };
    } catch (error) {
      // The gateway id is already on another row. Retrying cannot fix that, so
      // answer 200 and leave it in the log.
      if (!isDuplicateKeyError(error)) throw error;
      logLifecycleError("payments", "refund_webhook_duplicate_refund_id", error, {
        ...details,
        orderId: String(order._id),
        refundId: String(row._id),
      });
      return { matched: true, via, changed: false };
    }
  }

  if (status === "failed") {
    const result = await UnmatchedPayment.updateOne(
      {
        ...(refundEntity?.payment_id
          ? { provider: "razorpay", paymentId: String(refundEntity.payment_id) }
          : {}),
        refundId,
        resolution: "refunded",
      },
      {
        $set: {
          resolution: "failed",
          failureReason: String(
            refundEntity?.error_description || "Razorpay reported the refund as failed",
          ).slice(0, 500),
        },
      },
    );
    if (result.modifiedCount > 0) {
      logLifecycleError(
        "payments",
        "orphaned_capture_refund_failed",
        new Error(refundEntity?.error_description || "Razorpay reported the refund as failed"),
        details,
      );
      return { matched: true, via: "unmatched_payment", changed: true, refundStatus: "failed" };
    }
  }

  logLifecycleEvent("payments", "refund_webhook_unmatched", details);
  return { matched: false };
};
