import UnmatchedPayment from "./UnmatchedPayment.model.js";
import { getRazorpay, getRazorpayErrorMessage } from "./razorpay.service.js";
import { logLifecycleError, logLifecycleEvent } from "../../utils/lifecycle-logger.service.js";

/** How long a gateway call is assumed to still be in flight before a retry may take it over. */
const GATEWAY_ATTEMPT_STALE_MS = 2 * 60 * 1000;

/**
 * Compensation for a payment that was captured but cannot become an order.
 *
 * The policy is AUTO-REFUND, and specifically NOT resurrecting the order. An
 * order that has been swept to Cancelled has already had its stock released back
 * to the catalogue and, for a COD-style flow, may have been closed out to the
 * customer — promoting it later would confirm an order with no inventory behind
 * it. Returning the money is the only outcome that is correct without a human.
 *
 * Ordering is deliberate, and mirrors the returns path: the liability is
 * RECORDED FIRST, then the gateway is called, then the outcome is written back.
 * A crash between steps leaves a visible `pending` row rather than money that
 * moved with nothing to show for it.
 *
 * `gatewayStatus` is what Razorpay said about the refund THIS call issued or
 * adopted (`processed`, `pending`, `failed`…); absent when nothing was asked. Only
 * `processed` means the money has moved — a caller telling the customer must say
 * "initiated" for anything else.
 *
 * @returns {{record, refunded: boolean, alreadyHandled: boolean, gatewayStatus?: string}}
 */
export const refundOrphanedCapture = async ({
  paymentId,
  amount,
  currency = "INR",
  providerOrderId = "",
  paymentIntentId = null,
  orderId = null,
  userId = null,
  reason = "",
}) => {
  if (!paymentId) throw new Error("refundOrphanedCapture requires a paymentId");

  // ── CLAIM ────────────────────────────────────────────────────────────────
  // The unique {provider, paymentId} index is the idempotency guard. Two
  // concurrent webhook deliveries of the same capture race here and exactly one
  // creates the row; the loser reads the winner's row and refunds nothing.
  let record;
  let isFirstSighting = false;
  try {
    record = await UnmatchedPayment.create({
      provider: "razorpay",
      paymentId,
      providerOrderId,
      paymentIntent: paymentIntentId,
      order: orderId,
      user: userId,
      amount,
      currency,
      detectedReason: String(reason || "").slice(0, 500),
      resolution: "pending",
    });
    isFirstSighting = true;
  } catch (error) {
    if (error?.code !== 11000) throw error;
    record = await UnmatchedPayment.findOne({ provider: "razorpay", paymentId });
    if (!record) throw error;
  }

  // Already settled by an earlier delivery — nothing further to do, and above all
  // do not refund again.
  if (record.resolution === "refunded" || record.resolution === "resolved") {
    logLifecycleEvent("payment", "orphaned_capture_already_handled", {
      paymentId,
      resolution: record.resolution,
      unmatchedPaymentId: record._id,
    });
    return { record, refunded: record.resolution === "refunded", alreadyHandled: true };
  }

  if (isFirstSighting) {
    // Loud on first sighting: this is money in the account with no order behind
    // it, which an operator needs to know about even though it is being refunded
    // automatically. Uses the app's existing lifecycle logger rather than a new
    // monitoring channel; the admin System Health panel counts these rows.
    logLifecycleError(
      "payment",
      "captured_payment_without_order",
      new Error(reason || "Captured payment could not be matched to an order"),
      {
        paymentId,
        providerOrderId,
        paymentIntentId,
        orderId,
        amountPaise: amount,
        currency,
        unmatchedPaymentId: record._id,
      },
    );
  }

  // ── CLAIM THE GATEWAY CALL ───────────────────────────────────────────────
  // Winning the unique-index insert above decides who owns the record; this
  // decides who may call Razorpay right now. Without it, concurrent deliveries
  // of one capture all read a `pending` row and all refunded it — the unique
  // index kept the RECORD to one while the money went out three times.
  //
  // A stale attempt can be taken over so a genuine timeout stays retryable.
  const staleCutoff = new Date(Date.now() - GATEWAY_ATTEMPT_STALE_MS);
  const attemptClaim = await UnmatchedPayment.findOneAndUpdate(
    {
      _id: record._id,
      resolution: { $in: ["pending", "failed"] },
      $or: [
        { lastAttemptAt: null },
        { lastAttemptAt: { $exists: false } },
        { lastAttemptAt: { $lte: staleCutoff } },
      ],
    },
    { $set: { lastAttemptAt: new Date() }, $inc: { attempts: 1 } },
    { returnDocument: "after" },
  );
  if (!attemptClaim) {
    // Another delivery holds the attempt. Report not-refunded so the caller keeps
    // the event retryable rather than claiming success — the retry will find the
    // record settled and return cleanly.
    logLifecycleEvent("payment", "orphaned_capture_attempt_in_progress", {
      paymentId,
      unmatchedPaymentId: record._id,
    });
    return { record, refunded: false, alreadyHandled: false, inProgress: true };
  }
  record = attemptClaim;

  // ── REFUND ───────────────────────────────────────────────────────────────
  // Tagged with notes.refundKey so a repeat attempt can be reconciled against
  // the gateway instead of issuing a second refund.
  let refund;
  try {
    const { razorpay } = getRazorpay();

    // A prior attempt existed (this claim took over a stale one), so it may have
    // reached Razorpay. Ask before trying again.
    if (record.attempts > 1) {
      const existing = await razorpay.payments
        .fetchMultipleRefund(paymentId, { count: 100 })
        .catch(() => null);
      if (existing === null) {
        // Cannot confirm. Refusing to retry blindly is the whole point — an
        // unknown outcome is not a failed one.
        await UnmatchedPayment.updateOne(
          { _id: record._id },
          {
            $set: {
              failureReason:
                "Razorpay could not be reached to confirm whether an earlier refund landed. Check the dashboard before retrying.",
              // No gateway refund was attempted here — only the lookup failed —
              // so hold nothing: the next delivery should be free to try again.
              lastAttemptAt: null,
            },
          },
        );
        return { record, refunded: false, alreadyHandled: false, unconfirmed: true };
      }
      const items = Array.isArray(existing?.items) ? existing.items : [];
      const match = items.find(
        (item) => String(item?.notes?.refundKey || "") === String(paymentId),
      );
      if (match) {
        // The earlier attempt did land — adopt it instead of refunding again.
        const adopted = await UnmatchedPayment.findOneAndUpdate(
          { _id: record._id },
          {
            $set: {
              resolution: match.status === "failed" ? "failed" : "refunded",
              refundId: match.id,
              resolvedAt: new Date(),
              failureReason: "",
            },
          },
          { returnDocument: "after" },
        );
        return {
          record: adopted,
          refunded: match.status !== "failed",
          alreadyHandled: true,
          gatewayStatus: match.status,
        };
      }
    }

    refund = await razorpay.payments.refund(paymentId, {
      amount,
      speed: "normal",
      notes: {
        reason: "Captured payment had no completable order — auto-refunded",
        refundKey: paymentId,
      },
    });
  } catch (error) {
    const failureReason = getRazorpayErrorMessage(error);
    const failed = await UnmatchedPayment.findOneAndUpdate(
      { _id: record._id },
      {
        $set: {
          resolution: "failed",
          failureReason,
          // The call returned (with an error), so it is demonstrably not in
          // flight — release the attempt claim rather than making a retry wait
          // out the staleness window. Safe because a retry reconciles against
          // the gateway before refunding anything.
          lastAttemptAt: null,
        },
      },
      { returnDocument: "after" },
    );
    logLifecycleError("payment", "orphaned_capture_refund_failed", error, {
      paymentId,
      amountPaise: amount,
      unmatchedPaymentId: record._id,
    });
    return { record: failed || record, refunded: false, alreadyHandled: false };
  }

  // Deliberately NOT mapped through mapGatewayRefundStatus: here "accepted by
  // Razorpay" (`pending` as well as `processed`) counts as refunded. This row
  // tracks whether the money has been SENT BACK, not a customer-facing ledger
  // status, and a `pending` refund needs no further action from us. If Razorpay
  // later fails it, the refund.failed webhook finds no order row for this refund
  // id and marks this record `failed` by its refundId (applyRazorpayRefundWebhook,
  // refund-sync.service.js), which puts it back in front of an operator.
  const settled = await UnmatchedPayment.findOneAndUpdate(
    { _id: record._id },
    {
      $set: {
        resolution: refund?.status === "failed" ? "failed" : "refunded",
        refundId: refund?.id,
        failureReason: "",
        resolvedAt: new Date(),
      },
    },
    { returnDocument: "after" },
  );

  logLifecycleEvent("payment", "orphaned_capture_refunded", {
    paymentId,
    refundId: refund?.id,
    amountPaise: amount,
    unmatchedPaymentId: record._id,
  });

  return {
    record: settled || record,
    refunded: refund?.status !== "failed",
    alreadyHandled: false,
    gatewayStatus: refund?.status,
  };
};

/**
 * True when a capture can never legitimately become an order, so the only correct
 * response is to give the money back.
 *
 * `completeCapturedIntent` signals this with a 4xx statusCode: 409 for "the order
 * is no longer promotable / the stock behind it is gone", 404 for "the payment
 * session no longer exists". Anything else (a dropped connection, a replica-set
 * election) is transient and MUST keep answering 5xx so the gateway retries
 * rather than being refunded on the strength of a blip.
 */
export const isUnrecoverableCapture = (error) =>
  error?.statusCode === 409 || error?.statusCode === 404;

export const countUnresolvedOrphanedCaptures = () =>
  UnmatchedPayment.countDocuments({ resolution: { $in: ["pending", "failed"] } });
