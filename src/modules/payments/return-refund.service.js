import crypto from "node:crypto";
import mongoose from "mongoose";
import { isPaymentEnabled } from "../../config/features.config.js";
import { notifyRefundProcessed } from "../notifications/notification.service.js";
import OrderModel from "../orders/Order.model.js";
import UserProfile from "../profiles/UserProfile.model.js";
import ReturnModel from "../returns/return.model.js";
import { restockReturnedItems } from "../inventory/restock.service.js";
import { logLifecycleError, logLifecycleEvent } from "../../utils/lifecycle-logger.service.js";
import { getRazorpay, getRazorpayErrorMessage } from "./razorpay.service.js";

const MANUAL_METHODS = ["upi", "bank_transfer", "cash", "wallet", "other"];

// Payment statuses that only a refund can put an order into. Used to decide
// whether a now-empty refund ledger should fall back to "Paid".
const REFUND_STATUSES = ["Refund Pending", "Refunded", "Partially Refunded"];

/**
 * What one line of an order is actually worth refunding.
 *
 * Item prices are stored pre-discount, while coupon and wallet reductions are
 * applied once at the order level — so `price × qty` is what the item listed
 * for, not what the customer paid. Refunding that on a discounted order would
 * hand back more than was ever taken (₹150 for an item bought at ₹50 after a
 * ₹100 coupon). Discounts are therefore spread across lines in proportion to
 * their share of the subtotal, which is also how the customer would expect a
 * partial return to be valued.
 *
 * The ratio is capped at 1 so a hypothetical order whose total exceeds its
 * subtotal (shipping or tax added later) can never inflate a refund above the
 * item's own price.
 */
export const proportionalRefundAmount = ({
  unitPrice,
  quantity,
  orderSubtotal,
  orderTotal,
  // Deliberately NOT defaulted to 0. A caller that does not say what the shipping
  // charge was has not told us how much of an excess over the subtotal is
  // refundable, and guessing "none of it is shipping" would refund freight by
  // accident. Omitting it therefore keeps the old conservative cap — the new
  // tax-inclusive behaviour is opt-in, per call site, and visible in the diff.
  orderShippingCharge,
} = {}) => {
  const lineValue = Number(unitPrice) * Number(quantity);
  if (!Number.isFinite(lineValue) || lineValue <= 0) return 0;

  const subtotal = Number(orderSubtotal);
  const total = Number(orderTotal);
  if (!Number.isFinite(subtotal) || subtotal <= 0 || !Number.isFinite(total)) {
    return Math.round(lineValue * 100) / 100;
  }

  // ── WHAT IS REFUNDABLE ON A RETURN (audit H2-03) ─────────────────────────
  // Everything the customer paid EXCEPT the shipping charge:
  //
  //   refundable = totalAmount − shippingCharge
  //              = subtotal + tax − discount
  //
  // Tax follows the goods. It is levied on the goods' value, so returning them
  // reverses the sale it was charged on — keeping it both short-changes the
  // customer and over-reports the tax we owe. Shipping does not follow the
  // goods: the parcel was shipped and the courier was paid, so outbound shipping
  // is not refunded on a return. A pre-dispatch CANCELLATION is the opposite case
  // — nothing shipped — and that path deliberately refunds the whole
  // `totalAmount`, shipping included.
  //
  // This replaced `lineValue × min(1, total/subtotal)`. That cap existed to stop
  // an order whose total exceeded its subtotal from refunding more than the
  // item's list price, but it did so by discarding shipping AND tax together: the
  // shortfall against what the customer paid was exactly
  // max(0, shipping + tax − discount). Apportioning by the line's SHARE of the
  // goods, against a base that already excludes shipping, gets the tax back
  // without ever exceeding what was paid.
  // `null` and `""` are treated as NOT TOLD, not as zero — Number() turns both into
  // 0, which would claim the excess is all tax and refund it. Only an actual value
  // counts as a declaration.
  const declared =
    orderShippingCharge === null || orderShippingCharge === undefined || orderShippingCharge === ""
      ? Number.NaN
      : Number(orderShippingCharge);
  const refundable = Number.isFinite(declared)
    ? Math.max(0, total - declared)
    // Shipping unknown: fall back to the pre-H2-03 behaviour and refund no more
    // than the goods are worth, so an unexplained excess is never paid out.
    : Math.min(total, subtotal);

  // The line's fraction of the goods. Capped at 1 so bad data (a line worth more
  // than the whole subtotal) cannot inflate a refund; `refundable ≤ total`, so the
  // result can never exceed the order total either — and the cumulative ledger
  // ceiling in claimRefundSlot remains the backstop across multiple returns.
  const share = Math.min(1, Math.max(0, lineValue / subtotal));
  return Math.round(share * refundable * 100) / 100;
};

/**
 * The wallet-credit half of the same line valuation.
 *
 * A customer who paid ₹1000 of goods with ₹200 of wallet credit and ₹800 cash is
 * owed BOTH back on a full return. proportionalRefundAmount returns the ₹800
 * (the cash the gateway can reverse); this returns the ₹200, which has to go
 * back as wallet credit because there is no card transaction to reverse it
 * against. Previously only the cash half was returned, so every return silently
 * destroyed the prepaid portion.
 *
 * Same subtotal-share ratio as the cash half, so the two always add up to the
 * full value of the returned goods.
 */
export const proportionalWalletRefund = ({
  unitPrice,
  quantity,
  orderSubtotal,
  walletDiscount,
}) => {
  const wallet = Number(walletDiscount);
  if (!Number.isFinite(wallet) || wallet <= 0) return 0;

  const lineValue = Number(unitPrice) * Number(quantity);
  const subtotal = Number(orderSubtotal);
  if (!Number.isFinite(lineValue) || lineValue <= 0) return 0;
  if (!Number.isFinite(subtotal) || subtotal <= 0) return 0;

  const share = Math.min(1, lineValue / subtotal);
  return Math.round(wallet * share * 100) / 100;
};

/**
 * Credits wallet money back to the customer, capped at what this order actually
 * spent from the wallet and at what has not already been returned.
 *
 * Claim-then-pay, in that order and deliberately: the headroom is consumed by a
 * conditional `$inc` on the order first, and only a winning claim credits the
 * balance. Crediting first would double-pay on any retry, whereas a crash
 * between the two steps merely under-credits — visible in `walletRefunded` and
 * fixable by an admin. Under-crediting is recoverable; over-crediting is money
 * gone.
 *
 * Returns the amount actually credited (0 if there was no headroom).
 */
export const restoreWalletCredit = async ({ order, amount, session = null }) => {
  const walletSpent = Number(order?.walletDiscount) || 0;
  if (walletSpent <= 0 || !order?.user) return 0;

  const requested = Math.round((Number(amount) || 0) * 100) / 100;
  if (requested <= 0) return 0;

  const alreadyRestored = Number(order.walletRefunded) || 0;
  const headroom = Math.round((walletSpent - alreadyRestored) * 100) / 100;
  if (headroom <= 0) return 0;

  const credit = Math.min(requested, headroom);
  const options = session ? { session } : {};

  // The $expr keeps the cap in the FILTER, so two concurrent refunds on one
  // order cannot both pass a read-then-write check and over-credit.
  const claimed = await OrderModel.findOneAndUpdate(
    {
      _id: order._id,
      $expr: {
        $lte: [
          { $add: [{ $ifNull: ["$walletRefunded", 0] }, credit] },
          walletSpent + 0.01,
        ],
      },
    },
    { $inc: { walletRefunded: credit } },
    { ...options, returnDocument: "after" },
  );
  if (!claimed) return 0;

  await UserProfile.updateOne(
    { userid: order.user },
    { $inc: { walletBalance: credit } },
    options,
  );

  // Keep the in-memory document consistent with what was just persisted, so a
  // later order.save() in the same request cannot write back a stale value.
  order.walletRefunded = claimed.walletRefunded;
  return credit;
};

const fail = (message, statusCode, code) =>
  Object.assign(new Error(message), { statusCode, code });

/**
 * Money committed to being refunded — everything except `failed`, so it includes
 * `owed` (liability recorded, nothing attempted) and `created` (gateway called,
 * outcome unknown). Deliberately conservative: this is the "never refund more
 * than was paid" ceiling, and counting an unsettled refund is what stops a second
 * one slipping past the cap.
 */
export const sumRefunded = (order) =>
  (order.refunds || [])
    .filter((refund) => refund.status !== "failed")
    .reduce((total, refund) => total + Number(refund.amount || 0), 0);

/**
 * Money the business owes but has not yet even attempted to send.
 *
 * This is the payout/action queue. Today only a prepaid RTO that came back creates
 * an `owed` row (recordRtoRefundObligation); a COD return is settled by hand at
 * the moment its return reaches `refunded`, and is recorded `processed` with the
 * admin's payout reference — so it never sits here. Before the `owed` state
 * existed an RTO had no ledger row at all until someone acted on it, so the
 * liability was invisible — you could not answer "how much do we owe customers
 * right now?" from the data.
 */
export const sumOwedRefunds = (order) =>
  (order.refunds || [])
    .filter((refund) => refund.status === "owed")
    .reduce((total, refund) => total + Number(refund.amount || 0), 0);

/**
 * Money already committed to refunds, as a SERVER-SIDE aggregation expression.
 *
 * Mirrors sumRefunded() exactly (everything except `failed`). The point of having
 * it in this form is that MongoDB evaluates it against the live document inside
 * the update filter, so the ceiling becomes a real precondition instead of a
 * value read into the application a moment earlier.
 */
const COMMITTED_REFUND_SUM = {
  $reduce: {
    input: {
      $filter: {
        input: { $ifNull: ["$refunds", []] },
        as: "refund",
        cond: { $ne: ["$$refund.status", "failed"] },
      },
    },
    initialValue: 0,
    in: { $add: ["$$value", { $ifNull: ["$$this.amount", 0] }] },
  },
};

/**
 * A stable key for callers that don't supply one.
 *
 * Derived from the order, the exact paise amount and the reason, so a repeated
 * request for the same refund collapses onto one record while a genuinely
 * different refund (different amount or reason) gets its own. Deterministic on
 * purpose — a random key per request would defeat the whole guard.
 */
export const deriveRefundIdempotencyKey = ({ orderId, amount, reason = "" }) => {
  const paise = Math.round((Number(amount) || 0) * 100);
  const digest = crypto.createHash("sha1").update(String(reason)).digest("hex").slice(0, 12);
  return `auto:${orderId}:${paise}:${digest}`;
};

/**
 * Claims the right to make ONE refund, atomically.
 *
 * Both preconditions live in the FILTER, so MongoDB's single-document atomicity
 * picks the winner and the loser cannot proceed:
 *
 *   1. IDEMPOTENCY — no live (non-`failed`) refund already carries this key.
 *   2. CEILING     — committed + this amount stays within `totalAmount`.
 *
 * This replaces a read-then-act pair (read `sumRefunded`, check, then push and
 * save). Mongoose does NOT version-guard a subdocument-array `$push`, so two
 * concurrent handlers both saved and both went on to call the gateway — two real
 * refunds against one order. Verified by probing the driver, not assumed.
 *
 * Losing the claim is not an error when the key already exists: the existing
 * record is returned so the caller can adopt it and stay idempotent. It is only
 * an error when the ceiling is what rejected the write.
 *
 * @returns {{order, refund, created: boolean}} `created: false` means adopt, don't re-refund.
 */
export const claimRefundSlot = async ({
  orderId,
  idempotencyKey,
  amount,
  record = {},
  // A return id: the claim also fails while ANY live row already settles this
  // return, whatever its key. In the filter, so a retry racing the Returns page
  // cannot both pass a read and both push.
  blockIfLiveForReturn = null,
  session = null,
}) => {
  const value = Math.round((Number(amount) || 0) * 100) / 100;
  if (!Number.isFinite(value) || value <= 0) {
    throw fail("Invalid refund amount", 400, "INVALID_REFUND_AMOUNT");
  }
  if (!idempotencyKey) {
    throw fail("A refund idempotency key is required", 400, "REFUND_KEY_REQUIRED");
  }

  const options = session ? { session } : {};

  const notLive = [{ refunds: { $not: { $elemMatch: { idempotencyKey, status: { $ne: "failed" } } } } }];
  if (blockIfLiveForReturn) {
    notLive.push({
      refunds: {
        $not: { $elemMatch: { returnRequest: blockIfLiveForReturn, status: { $ne: "failed" } } },
      },
    });
  }

  const claimed = await OrderModel.findOneAndUpdate(
    {
      _id: orderId,
      $and: notLive,
      $expr: {
        $lte: [
          { $add: [COMMITTED_REFUND_SUM, value] },
          { $add: [{ $ifNull: ["$totalAmount", 0] }, 0.01] },
        ],
      },
    },
    { $push: { refunds: { ...record, idempotencyKey, amount: value } } },
    { ...options, returnDocument: "after" },
  );

  if (claimed) {
    return { order: claimed, refund: claimed.refunds.at(-1), created: true };
  }

  // Lost the claim. Two very different reasons, and they need different answers.
  const current = await OrderModel.findById(orderId).session(session || null);
  if (!current) throw fail("Order not found", 404, "ORDER_NOT_FOUND");

  const existing = (current.refunds || []).find(
    (entry) => entry.idempotencyKey === idempotencyKey && entry.status !== "failed",
  );
  if (existing) return { order: current, refund: existing, created: false };

  if (blockIfLiveForReturn && findRefundForReturn(current, blockIfLiveForReturn)) {
    throw fail(
      "This return has already been refunded again through a newer refund on this order. Check that one instead — retrying this row would pay the customer twice.",
      409,
      "REFUND_ALREADY_REISSUED",
    );
  }

  const committed = sumRefunded(current);
  const headroom = Math.round((Number(current.totalAmount) - committed) * 100) / 100;
  throw fail(
    headroom <= 0
      ? `This order has already been fully refunded (₹${committed} of ₹${current.totalAmount}).`
      : `Refunding ₹${value} would exceed the order total — at most ₹${headroom} remains refundable (₹${committed} already committed).`,
    400,
    "REFUND_EXCEEDS_ORDER_TOTAL",
  );
};

/**
 * How long a gateway call is assumed to still be in flight.
 *
 * Beyond this an attempt is treated as abandoned, so a retry may take it over —
 * after reconciling against the gateway first. Generous on purpose: taking an
 * attempt over too eagerly is what risks a double refund, while taking it over
 * too late merely delays a retry an operator can trigger again.
 */
const GATEWAY_ATTEMPT_STALE_MS = 2 * 60 * 1000;

/**
 * Claims the right to actually CALL the gateway for one refund row.
 *
 * Winning the ledger row (claimRefundSlot) decides who owns the refund; this
 * decides who may talk to Razorpay right now. They are genuinely different
 * questions, and conflating them left a hole: the request that lost the row
 * would find it `created`, ask the gateway whether that refund existed, be told
 * "no" — because the winner's call was still in flight — and take that as proof
 * the earlier attempt never happened. It would then refund again.
 *
 * The precondition is in the filter, so only one holder exists at a time. A row
 * whose attempt is older than `staleAfterMs` can be taken over, which is what
 * keeps a genuine timeout recoverable.
 *
 * @returns {boolean} true if this caller may proceed to the gateway.
 */
export const claimGatewayAttempt = async ({
  orderId,
  refundId,
  staleAfterMs = GATEWAY_ATTEMPT_STALE_MS,
  session = null,
}) => {
  const cutoff = new Date(Date.now() - staleAfterMs);
  const options = { ...(session ? { session } : {}), returnDocument: "after" };
  const notInFlight = [
    { gatewayAttemptedAt: null },
    { gatewayAttemptedAt: { $exists: false } },
    { gatewayAttemptedAt: { $lte: cutoff } },
  ];

  // ── AN OWED ROW BECOMES `created` IN THE SAME WRITE THAT CLAIMS THE ATTEMPT ──
  // `owed` means "liability recorded, nothing attempted"; `created` means "the
  // gateway was called and the outcome is unknown". The moment this claim is won
  // the first is no longer true, so the flip belongs in the claim itself. Done as
  // a separate write afterwards, a crash between the two would leave a row that
  // reads "nothing attempted" while a Razorpay call may in fact have gone out —
  // and the owed-refunds queue would offer it for payment again.
  //
  // Tried FIRST and on its own because it is a strict subset of the general
  // claim below: a row that is still `owed` can only be claimed here, and once
  // flipped it can never become `owed` again, so falling through to the general
  // claim cannot double-claim it.
  const claimedOwed = await OrderModel.findOneAndUpdate(
    {
      _id: orderId,
      refunds: { $elemMatch: { _id: refundId, status: "owed", $or: notInFlight } },
    },
    {
      $set: {
        "refunds.$.gatewayAttemptedAt": new Date(),
        "refunds.$.status": "created",
      },
    },
    options,
  );
  if (claimedOwed) return true;

  const claimed = await OrderModel.findOneAndUpdate(
    {
      _id: orderId,
      refunds: {
        $elemMatch: {
          _id: refundId,
          status: { $ne: "processed" },
          $or: notInFlight,
        },
      },
    },
    { $set: { "refunds.$.gatewayAttemptedAt": new Date() } },
    options,
  );
  return Boolean(claimed);
};

/**
 * What a Razorpay refund status means for OUR ledger row.
 *
 * Only `processed` is money that has moved and only `failed` is money that
 * demonstrably did not. Everything else — `pending` above all, which is what a
 * normal-speed refund replies with, but also any status Razorpay adds later — is
 * "accepted, not yet settled", which is exactly what `created` means. This used to
 * be `status === "failed" ? "failed" : "processed"`, so a `pending` reply marked
 * the order Refunded and told the customer so before any money had moved.
 */
export const mapGatewayRefundStatus = (status) =>
  status === "processed" ? "processed" : status === "failed" ? "failed" : "created";

// Which row states each settlement may move FROM. A `processed` or `failed` row
// is final as far as a gateway REPLY is concerned: a late or replayed reply (a
// slow `pending` arriving after the webhook said `processed`) must not drag the
// row backwards.
const SETTLE_FROM = {
  created: ["owed", "created"],
  processed: ["owed", "created"],
  failed: ["owed", "created"],
};

// Same, for an asynchronous gateway EVENT (webhook / poller). One extra edge:
// processed → failed, because Razorpay can fail a refund it previously reported
// as processed, and the ledger has to follow the money. A `failed` row never
// moves anywhere — a retry is a NEW row (see ReconcileOrderRefund).
const GATEWAY_EVENT_FROM = {
  created: ["owed", "created"],
  processed: ["owed", "created"],
  failed: ["owed", "created", "processed"],
};

/**
 * Persists the outcome of a gateway call onto one refund row, by _id.
 *
 * Targeted positional update rather than `order.save()`: the claim above wrote
 * via the collection, so a whole-document save from a stale in-memory copy could
 * drop a refund row a concurrent handler had legitimately added.
 *
 * Guarded by SETTLE_FROM, so a row the webhook or poller has already settled is
 * left alone. The order is still re-read and returned either way; callers that
 * care what the row ended up as read it from that document.
 *
 * `transitioned` says whether THIS write was the one that moved the row. When it
 * is false the row was already past SETTLE_FROM — typically the refund webhook
 * landed between Razorpay's synchronous reply and this write, settled the row
 * through applyGatewayRefundState and sent the "refund processed" notice itself.
 * A caller that would otherwise notify must not do it a second time.
 *
 * @returns {Promise<{order: object|null, transitioned: boolean}>}
 */
export const writeRefundSettlement = async ({
  orderId,
  refundId,
  providerRefundId,
  status,
  failureReason = "",
  releaseAttempt = false,
  session = null,
}) => {
  const set = { "refunds.$.status": status, "refunds.$.failureReason": failureReason };
  if (providerRefundId !== undefined) set["refunds.$.providerRefundId"] = providerRefundId;
  if (status === "processed") set["refunds.$.processedAt"] = new Date();
  // The gateway call returned (with an error) — so it is demonstrably no longer in
  // flight, and holding the attempt claim would make an operator wait out the
  // staleness window for no reason. Safe to release because the retry reconciles
  // against the gateway before it refunds anything.
  if (releaseAttempt) set["refunds.$.gatewayAttemptedAt"] = null;

  const result = await OrderModel.updateOne(
    {
      _id: orderId,
      refunds: {
        $elemMatch: { _id: refundId, status: { $in: SETTLE_FROM[status] || ["owed", "created"] } },
      },
    },
    { $set: set },
    session ? { session } : {},
  );

  const fresh = await OrderModel.findById(orderId).session(session || null);
  if (fresh) await recomputeRefundState(fresh, { session });
  // matchedCount, not modifiedCount: a `created` → `created` write that changes
  // nothing still owned the row; a filter miss is what "someone else settled it" is.
  return { order: fresh, transitioned: result.matchedCount > 0 };
};

/** writeRefundSettlement, returning only the re-read order (the original contract). */
export const settleRefundRecord = async (args) => (await writeRefundSettlement(args)).order;

/**
 * Whether a settlement write lost to another writer that had already settled the
 * row as `processed` — the webhook, the poller or a reconcile, each of which goes
 * through applyGatewayRefundState and notifies the customer itself.
 */
const settledElsewhere = (write, refundId) =>
  !write.transitioned && write.order?.refunds?.id(refundId)?.status === "processed";

/**
 * Applies what Razorpay now says about a refund to one ledger row — from the
 * refund webhook, the status poller, or a reconcile that looked the refund up.
 *
 * One compare-and-swap, with the allowed source states (GATEWAY_EVENT_FROM) in
 * the filter. The webhook, the poller and an operator's "Check with Razorpay" can
 * all learn the same fact at the same moment; only the write that wins acts on
 * it, so the customer is told "refund processed" once, not once per observer.
 *
 * The row may not yet carry the gateway id (a reply that never arrived), so the
 * id is written here — but only onto a row that has none or already has this
 * one. A row is never re-pointed at a different gateway refund.
 *
 * A refund that failed AFTER its return was marked refunded puts the return
 * back at `received`, so it reappears in the operator's queue for a retry
 * instead of claiming money that never moved.
 *
 * @returns {{changed: boolean, matched: boolean, refundStatus: string, previousStatus?: string, order?: object}}
 *   `matched: false` means the CAS lost — the row was already settled, or is not
 *   in a state this status may move it from.
 */
export const applyGatewayRefundState = async ({
  orderId,
  refundId,
  gatewayRefund,
  source = "gateway",
}) => {
  const to = mapGatewayRefundStatus(gatewayRefund?.status);
  const providerRefundId = gatewayRefund?.id ? String(gatewayRefund.id) : null;
  const now = new Date();

  const rowMatch = { _id: refundId, status: { $in: GATEWAY_EVENT_FROM[to] } };
  // `null` also matches an absent field.
  if (providerRefundId) rowMatch.providerRefundId = { $in: [null, providerRefundId] };

  const set = { "refunds.$.status": to, "refunds.$.gatewaySyncedAt": now };
  if (providerRefundId) set["refunds.$.providerRefundId"] = providerRefundId;
  if (to === "processed") {
    set["refunds.$.processedAt"] = now;
    set["refunds.$.failureReason"] = "";
  }
  if (to === "failed") {
    set["refunds.$.failureReason"] = String(
      gatewayRefund?.error_description || "Razorpay reported the refund as failed",
    ).slice(0, 500);
  }

  const before = await OrderModel.findOneAndUpdate(
    { _id: orderId, refunds: { $elemMatch: rowMatch } },
    { $set: set },
    { returnDocument: "before", projection: { refunds: 1, razorpayPaymentId: 1 } },
  ).lean();
  if (!before) return { changed: false, matched: false, refundStatus: to };

  const row = (before.refunds || []).find((entry) => String(entry._id) === String(refundId));
  const previousStatus = row?.status;

  // Compare-and-swap on the ledger, not findById → save: two rows settling at
  // once could otherwise each derive paymentStatus from a read that missed the
  // other's write, and the later save would leave a stale status behind.
  const order = await syncRefundPaymentStatus(orderId);

  const details = {
    orderId: String(orderId),
    refundId: String(refundId),
    providerRefundId,
    from: previousStatus,
    to,
    source,
  };

  if (to === "processed" && previousStatus !== "processed") {
    logLifecycleEvent("payments", "gateway_refund_processed", details);
    // A row the refund-status backfill re-opened was announced as processed once
    // already (suppressProcessedNotice); its real settlement is not news.
    if (!row?.suppressProcessedNotice) {
      await notifyRefundProcessed({
        orderId,
        paymentId: row?.providerPaymentId || before.razorpayPaymentId || null,
      }).catch((error) => logLifecycleError("payments", "refund_notification_failed", error, details));
    }

    // A return whose refund settled OUT OF BAND — a retry from the order page, or a
    // pending refund the webhook/poller finished after the return was put back at
    // `received` — would otherwise sit at `received` with its money returned. Only
    // a refund-resolution return still at `received` moves; the CAS makes a
    // concurrent admin move win cleanly. Restock is idempotent and follows the
    // disposition, exactly as on the admin's own move to `refunded`.
    if (row?.returnRequest) {
      try {
        const settledReturn = await ReturnModel.findOneAndUpdate(
          { _id: row.returnRequest, status: "received", resolutionType: "refund" },
          {
            $set: { status: "refunded", refundedAt: now },
            $push: { statusHistory: { status: "refunded", note: "Refund settled by Razorpay" } },
          },
          { returnDocument: "after" },
        );
        if (settledReturn) await restockReturnedItems({ returnRequest: settledReturn });
      } catch (error) {
        logLifecycleError("payments", "refund_settled_return_update_failed", error, {
          ...details,
          returnId: String(row.returnRequest),
        });
      }
    }
  }

  if (to === "failed") {
    // Every move to failed needs a human: money the ledger counted on has not
    // moved. One the customer was already told about has bounced as well.
    logLifecycleError(
      "payments",
      previousStatus === "processed" ? "gateway_refund_failed_after_processed" : "gateway_refund_failed",
      new Error(set["refunds.$.failureReason"]),
      { ...details, failureReason: set["refunds.$.failureReason"] },
    );

    const returnId = row?.returnRequest;
    const otherLiveRow = (order?.refunds || []).some(
      (entry) =>
        String(entry._id) !== String(refundId) &&
        String(entry.returnRequest || "") === String(returnId || "") &&
        entry.status !== "failed",
    );
    if (returnId && !otherLiveRow) {
      try {
        await ReturnModel.updateOne(
          { _id: returnId, status: "refunded" },
          {
            $set: { status: "received", refundedAt: null },
            $push: {
              statusHistory: {
                status: "received",
                note: `Razorpay reported refund ${providerRefundId || refundId} failed — retry the refund`,
              },
            },
          },
        );
      } catch (error) {
        // E11000 on one_open_return_per_order_line: the customer has since raised
        // another open return on this line, so this one cannot reopen. The failed
        // row is still on the ledger for an operator to act on.
        logLifecycleError("payments", "refund_failed_return_rollback_skipped", error, {
          ...details,
          returnId: String(returnId),
        });
      }
    }
  }

  return {
    changed: previousStatus !== to,
    matched: true,
    refundStatus: to,
    previousStatus,
    order,
  };
};

/**
 * The stable reconciliation key for a cancellation refund.
 *
 * Two different shapes because the two paths have different cardinality:
 *
 *   full cancel     one per order — the orderStatus claim in CancelOrder
 *                   guarantees a single execution, so the order id is enough.
 *   partial cancel  many per order — keyed on the `cancellations[]` subdocument
 *                   that caused it, so two genuinely separate partial
 *                   cancellations each get their own refund while retries of one
 *                   collapse onto a single record.
 *
 * Keying a partial cancel on the order id would have been wrong in the expensive
 * direction: the second partial cancellation would look like a duplicate of the
 * first and silently refund nothing.
 */
export const cancellationRefundKey = ({ orderId, cancellationId = null }) =>
  cancellationId ? `partial-cancel:${cancellationId}` : `cancel:${orderId}`;

/**
 * Moves money for a refund row that already exists in the ledger, safely.
 *
 * Extracted so the cancellation, returns and admin paths run the same sequence
 * instead of each hand-rolling the gateway call:
 *
 *   1. claim the gateway attempt, so a retry cannot race an in-flight call
 *   2. if a previous attempt exists, ASK the gateway before trying again
 *   3. call Razorpay with a reconciliation note (`notes.refundKey`, or whatever
 *      `lookupNote` names), which is what makes step 2 possible
 *   4. record what the gateway actually said, and re-derive paymentStatus
 *
 * A row that already carries a gateway refund id was ACCEPTED by Razorpay, so it
 * is never refunded again: it is looked up with fetchRefund and its current state
 * applied (applyGatewayRefundState, which sends the "refund processed" notice
 * itself when it settles the row — `notified: true` says so, and the caller must
 * not send a second one).
 *
 * Callers own the ledger row and the amount; this owns the money movement. It
 * assumes a gateway refund is appropriate — gate on `canAutoRefund(order)` first,
 * so COD and other offline orders never reach here.
 *
 * `refundStatus` on every outcome is what the ROW is now (or, for in_progress /
 * unconfirmed / gateway_failed, `created`: unsettled, outcome unknown). It is
 * what callers decide notifications and responses on — never `outcome` alone,
 * because a `refunded` call can come back `pending` (created) or `failed`.
 *
 * @returns {{outcome: "refunded"|"reconciled"|"gateway_failed"|"in_progress"|"unconfirmed"|"row_failed",
 *            refundStatus: "processed"|"created"|"failed", notified: boolean, ...}}
 */
export const settleGatewayRefund = async ({
  order,
  refundId,
  amount,
  refundKey,
  reason,
  speed = "normal",
  // The note the gateway refund is tagged with and later found by. Cancellation
  // and admin refunds use refundKey; returns use returnNumber.
  lookupNote = { key: "refundKey", value: refundKey },
  extraNotes = {},
  // Reconcile before refunding even when this row shows no earlier attempt — for
  // a caller that knows an attempt may have been made on its behalf.
  forceLookup = false,
}) => {
  // Read the row BEFORE claiming, to learn whether anyone has already tried.
  // Reading first can only mis-read a concurrent attempt that has just started —
  // and that case is caught by the claim below failing, so the conservative
  // decision (reconcile) is never skipped.
  const before = await OrderModel.findOne(
    { _id: order._id, "refunds._id": refundId },
    { "refunds.$": 1 },
  ).lean();
  const prior = before?.refunds?.[0];
  if (!prior) {
    throw fail("Refund record not found on this order", 404, "REFUND_RECORD_NOT_FOUND");
  }
  if (prior.status === "processed") {
    return {
      outcome: "reconciled",
      providerRefundId: prior.providerRefundId,
      alreadySettled: true,
      refundStatus: "processed",
      notified: false,
    };
  }
  // Final. A retry of a failed refund is a NEW row with its own key, never this one.
  if (prior.status === "failed") {
    return {
      outcome: "row_failed",
      providerRefundId: prior.providerRefundId,
      refundStatus: "failed",
      notified: false,
    };
  }

  // ── ACCEPTED BY RAZORPAY, NOT YET SETTLED ─────────────────────────────────
  // The row has a gateway id, so a refund exists at Razorpay. Ask what became of
  // it; never issue another. No attempt claim is needed: nothing is sent, and the
  // write is a compare-and-swap.
  if (prior.status === "created" && prior.providerRefundId) {
    let gatewayRefund;
    try {
      const { razorpay } = getRazorpay();
      gatewayRefund = await razorpay.payments.fetchRefund(
        prior.providerPaymentId || order.razorpayPaymentId,
        prior.providerRefundId,
      );
    } catch (error) {
      return {
        outcome: "unconfirmed",
        message: `Razorpay could not be reached to check refund ${prior.providerRefundId}: ${getRazorpayErrorMessage(error)}. Nothing was re-sent — check again in a few minutes.`,
        providerRefundId: prior.providerRefundId,
        refundStatus: "created",
        notified: false,
      };
    }
    const applied = await applyGatewayRefundState({
      orderId: order._id,
      refundId,
      gatewayRefund,
      source: "reconcile",
    });
    // Lost the CAS → the webhook or poller settled it first; report the row.
    const rowStatus = applied.matched
      ? applied.refundStatus
      : (await readRefundRowStatus(order._id, refundId)) || applied.refundStatus;
    return {
      outcome: "reconciled",
      providerRefundId: prior.providerRefundId,
      gatewayStatus: gatewayRefund?.status,
      refundStatus: rowStatus,
      // Whichever applyGatewayRefundState moved the row to `processed` — ours, or
      // the webhook/poller's that beat it — sent the notice.
      notified: rowStatus === "processed",
      ...(!applied.matched && rowStatus === "processed" ? { alreadySettled: true } : {}),
    };
  }

  const hadPriorAttempt =
    forceLookup || Boolean(prior.gatewayAttemptedAt) || Boolean(prior.failureReason);

  const mayCallGateway = await claimGatewayAttempt({ orderId: order._id, refundId });
  if (!mayCallGateway) {
    return { outcome: "in_progress", refundStatus: "created", notified: false };
  }

  if (hadPriorAttempt) {
    let existing;
    try {
      if (!lookupNote?.key || !lookupNote?.value) {
        // Nothing to look an earlier attempt up BY, so absence cannot be proven.
        throw new Error(
          "this refund has no reconciliation key, so an earlier attempt cannot be ruled out. Check the Razorpay dashboard before retrying.",
        );
      }
      // Refunds already recorded against OTHER rows of this order are not
      // candidates: a return refunded once, failed, and retried carries the same
      // returnNumber on both gateway refunds, and adopting the old failed one
      // would mark the retry failed without ever sending it.
      const ledger = await OrderModel.findById(order._id, { refunds: 1 }).lean();
      const excludeRefundIds = (ledger?.refunds || [])
        .filter((entry) => String(entry._id) !== String(refundId) && entry.providerRefundId)
        .map((entry) => entry.providerRefundId);
      existing = await findGatewayRefundByNote({
        order,
        noteKey: lookupNote.key,
        noteValue: lookupNote.value,
        label: reason || lookupNote.value,
        excludeRefundIds,
      });
    } catch (error) {
      // Razorpay unreachable. Refusing to retry blindly is the whole point:
      // "unknown" is not "didn't happen".
      await settleRefundRecord({
        orderId: order._id,
        refundId,
        status: "created",
        failureReason: error.message,
        releaseAttempt: true,
      });
      return { outcome: "unconfirmed", message: error.message, refundStatus: "created", notified: false };
    }
    if (existing) {
      const status = mapGatewayRefundStatus(existing.status);
      const write = await writeRefundSettlement({
        orderId: order._id,
        refundId,
        providerRefundId: existing.id,
        status,
        failureReason:
          status === "failed"
            ? String(existing.error_description || "Razorpay reported the refund as failed")
            : "",
      });
      const already = settledElsewhere(write, refundId);
      return {
        outcome: "reconciled",
        providerRefundId: existing.id,
        gatewayStatus: existing.status,
        refundStatus: write.order?.refunds?.id(refundId)?.status || status,
        notified: already,
        ...(already ? { alreadySettled: true } : {}),
      };
    }
    // Confirmed absent at the gateway, so reusing this row cannot double-pay.
  }

  let refund;
  try {
    const { razorpay } = getRazorpay();
    refund = await razorpay.payments.refund(order.razorpayPaymentId, {
      amount: Math.round(Number(amount) * 100),
      speed,
      notes: {
        reason: String(reason || "Refund").slice(0, 250),
        ...(refundKey ? { refundKey } : {}),
        ...extraNotes,
      },
    });
  } catch (error) {
    await settleRefundRecord({
      orderId: order._id,
      refundId,
      // Stays `created`, never `failed`. `failed` is excluded from the ceiling
      // and from the duplicate lookup, so recording an unknown outcome as failed
      // is what lets a later attempt refund the same money again.
      status: "created",
      failureReason: getRazorpayErrorMessage(error),
      releaseAttempt: true,
    });
    return {
      outcome: "gateway_failed",
      message: getRazorpayErrorMessage(error),
      refundStatus: "created",
      notified: false,
    };
  }

  // Razorpay replies `pending` for normal-speed refunds and settles later (the
  // webhook or the poller finishes the job), so record what it actually said.
  const status = mapGatewayRefundStatus(refund?.status);
  const write = await writeRefundSettlement({
    orderId: order._id,
    refundId,
    providerRefundId: refund.id,
    status,
    failureReason:
      status === "failed" ? String(refund.error_description || "Razorpay declined the refund") : "",
  });
  // The refund.processed webhook can beat this write: it finds the row by
  // notes.refundKey / returnNumber, settles it and notifies. Our guarded write then
  // matches nothing, and the row already reads `processed` — report that the
  // notice has gone, so the caller does not send a second one.
  const already = settledElsewhere(write, refundId);
  return {
    outcome: "refunded",
    providerRefundId: refund.id,
    gatewayStatus: refund.status,
    refundStatus: write.order?.refunds?.id(refundId)?.status || status,
    notified: already,
    ...(already ? { alreadySettled: true } : {}),
  };
};

/** The current status of one refund row, read fresh. */
const readRefundRowStatus = async (orderId, refundId) => {
  const doc = await OrderModel.findOne(
    { _id: orderId, "refunds._id": refundId },
    { "refunds.$": 1 },
  ).lean();
  return doc?.refunds?.[0]?.status || null;
};

/**
 * Records a refund LIABILITY without attempting to move money.
 *
 * Used where the obligation is created by an event but settled later by a
 * separate action. Today that is a prepaid RTO parcel arriving back (an operator
 * actions the gateway refund from the owed queue). A COD return does NOT come
 * through here: it is settled by hand at the moment the return reaches
 * `refunded`, with the payout reference recorded on a `processed` row
 * (refundReturnRequest's manual branch). The ledger row exists from the moment
 * the debt does.
 *
 * Idempotent: keyed on `dedupeKey`, so a replayed webhook or a double-clicked
 * button records one liability, not two. Respects the cumulative ceiling.
 *
 * ── ATOMIC, LIKE claimRefundSlot ─────────────────────────────────────────────
 * This used to be read-then-save: look for a row with this reason, compute the
 * headroom from the in-memory document, push, save. Mongoose does not
 * version-guard a subdocument-array `$push`, so two deliveries of the same
 * courier event arriving together (Shiprocket retries, and a manual move to
 * "RTO Received" can now race the webhook) both passed the read and both saved —
 * two liabilities for one parcel, and a ceiling that only held for whichever
 * write landed last.
 *
 * Every precondition now lives in the FILTER of one conditional `$push`:
 *
 *   1. MONEY COLLECTED — the order is still in a captured payment state.
 *   2. DEDUPE          — no non-failed row already carries this reason. The
 *                        legacy reason-as-key is kept rather than moved to
 *                        `idempotencyKey`: owed rows deliberately have NO key
 *                        until a gateway attempt is about to be made (see
 *                        ReconcileOrderRefund), and existing rows are found by
 *                        their reason.
 *   3. CEILING         — committed + this amount stays within `totalAmount`.
 *
 * The amount is computed from a read and then asserted by the filter, so a lost
 * race re-reads and re-decides rather than writing a stale figure. Bounded,
 * because a loop that cannot make progress must not spin.
 *
 * The caller's `order` document is read but no longer mutated or saved: writing
 * back a whole stale document is exactly what made the old version racy.
 */
const OBLIGATION_CLAIM_ATTEMPTS = 3;

export const recordRefundObligation = async ({
  order,
  amount,
  reason,
  dedupeKey,
  returnRequest = null,
  confirmationMethod = "gateway",
  createdBy = null,
  session = null,
}) => {
  const owedAmount = Math.round((Number(amount) || 0) * 100) / 100;
  if (owedAmount <= 0) return { refund: null, created: false };

  // ── NEVER OWE MONEY TO SOMEONE WHO DIDN'T PAY ────────────────────────────
  // Enforced here, not only in the callers. A COD order that has not been
  // delivered has collected nothing, so there is nothing to give back — and an
  // RTO is precisely the case where that is easy to get wrong, because the parcel
  // coming back *looks* like a return. Keeping the rule at the level of the
  // invariant means a future caller cannot reintroduce the mistake by forgetting
  // to check. Repeated in the write filter below, so a concurrent change of
  // payment state cannot slip past it either.
  const moneyCollected = MONEY_COLLECTED_PAYMENT_STATUSES.includes(order?.paymentStatus);
  if (!moneyCollected) {
    return { refund: null, created: false, noMoneyCollected: true };
  }

  const options = session ? { session } : {};
  let current = order;

  for (let attempt = 0; attempt < OBLIGATION_CLAIM_ATTEMPTS; attempt += 1) {
    if (attempt > 0) {
      current = await OrderModel.findById(order._id).session(session || null);
      if (!current) return { refund: null, created: false };
      if (!MONEY_COLLECTED_PAYMENT_STATUSES.includes(current.paymentStatus)) {
        return { refund: null, created: false, noMoneyCollected: true };
      }
    }

    const existing = (current.refunds || []).find(
      (refund) => refund.reason === dedupeKey && refund.status !== "failed",
    );
    if (existing) return { refund: existing, created: false };

    const alreadyCommitted = sumRefunded(current);
    const headroom = Math.round((Number(current.totalAmount) - alreadyCommitted) * 100) / 100;
    if (headroom <= 0) return { refund: null, created: false, noHeadroom: true };

    const value = Math.min(owedAmount, headroom);
    // Generated here so the row can be found in the returned document by id
    // rather than by position — a concurrent push may land after it.
    const refundId = new mongoose.Types.ObjectId();

    const claimed = await OrderModel.findOneAndUpdate(
      {
        _id: current._id,
        paymentStatus: { $in: MONEY_COLLECTED_PAYMENT_STATUSES },
        refunds: { $not: { $elemMatch: { reason: dedupeKey, status: { $ne: "failed" } } } },
        $expr: {
          $lte: [
            { $add: [COMMITTED_REFUND_SUM, value] },
            { $add: [{ $ifNull: ["$totalAmount", 0] }, 0.01] },
          ],
        },
      },
      {
        $push: {
          refunds: {
            _id: refundId,
            paymentProvider: confirmationMethod === "manual" ? "manual" : "razorpay",
            providerPaymentId: current.razorpayPaymentId || "",
            returnRequest,
            amount: value,
            // The dedupe key IS the reason string, so the idempotency guard is visible
            // in the ledger rather than hidden in a side field.
            reason: dedupeKey,
            status: "owed",
            confirmationMethod,
            createdBy,
          },
        },
      },
      { ...options, returnDocument: "after" },
    );

    if (claimed) {
      // paymentStatus follows the ledger. Recomputed on the document the write
      // returned, which already contains every row — including any a concurrent
      // writer added — so the derived status cannot lag the ledger.
      await recomputeRefundState(claimed, { session });
      return { refund: claimed.refunds.id(refundId), created: true, note: reason };
    }
    // Lost: a duplicate landed, the headroom shrank, or the payment state moved.
    // Re-read and decide again.
  }

  // Still contended after every attempt. Say so rather than guess: the caller
  // records nothing, and a retried event will find the settled state.
  const settled = await OrderModel.findById(order._id).session(session || null);
  const existing = (settled?.refunds || []).find(
    (refund) => refund.reason === dedupeKey && refund.status !== "failed",
  );
  if (existing) return { refund: existing, created: false };
  return { refund: null, created: false, contended: true };
};

/**
 * Records what a returned-to-origin parcel means for the customer's money.
 *
 * The whole point of branching here explicitly: an RTO is NOT a customer return.
 * The customer did not ask for anything and, on COD, never paid — so issuing them
 * a refund would be handing money to someone who owes it. On a prepaid order the
 * opposite is true: they paid for goods they never received, so a refund is owed
 * the moment the parcel is confirmed back with us.
 *
 * Recorded as `owed`, not pushed to the gateway, because this runs unattended from
 * a courier feed. What it guarantees is that the liability is never invisible.
 *
 * Lives here, beside recordRefundObligation, rather than in the shipping
 * controller: there are now two ways an order reaches "RTO Received" — the courier
 * webhook and an admin's manual status move — and the second used to record no
 * obligation at all, so a prepaid customer whose parcel an operator marked as back
 * was owed money the ledger never mentioned. One definition, every caller.
 *
 * The `RTO <orderId>` dedupe key is unchanged and load-bearing: it is what makes a
 * replayed courier event (or a webhook racing a manual move) idempotent, and the
 * owed-refunds list recognises an RTO obligation by it.
 */
export const recordRtoRefundObligation = async (order) => {
  // COD: nothing was collected, so nothing is owed. Explicit and final.
  //
  // Reads the shared set rather than restating it. The hand-written version kept
  // {Paid, Partially Refunded}, two states short of the invariant
  // recordRefundObligation enforces — so a prepaid order whose earlier partial
  // refund had not settled yet, which leaves it at "Refund Pending", was told "no
  // payment was ever collected" and its RTO liability was never recorded. The
  // customer had paid in full, received nothing, and only the earlier partial
  // amount was owed back.
  const moneyCollected = MONEY_COLLECTED_PAYMENT_STATUSES.includes(order.paymentStatus);
  if (!moneyCollected) return { owed: 0, reason: "no payment was ever collected" };

  const outstanding =
    Math.round((Number(order.totalAmount) - sumRefunded(order)) * 100) / 100;
  if (outstanding <= 0) return { owed: 0, reason: "already fully refunded" };

  const fresh = await OrderModel.findById(order._id);
  if (!fresh) return { owed: 0, reason: "order no longer exists" };

  const { refund, created } = await recordRefundObligation({
    order: fresh,
    amount: outstanding,
    reason: "Parcel returned to origin undelivered",
    // Stable key = idempotency. A retried courier event finds this row and stops.
    dedupeKey: `RTO ${fresh._id}`,
    confirmationMethod: "gateway",
  });

  return { owed: created ? refund?.amount || 0 : 0, alreadyRecorded: !created };
};

/**
 * The payment states in which money HAS been captured, and is therefore refundable.
 *
 * Derived from what recomputeRefundState below can actually produce, not chosen:
 *
 *   Paid               captured, nothing refunded
 *   Refund Pending     captured; committed > 0 and settled == 0
 *   Partially Refunded captured; 0 < settled < total
 *   Refunded           captured; settled >= total
 *
 * The last three are reachable ONLY when a refund row exists, and a refund row can
 * only exist against a captured payment — so all four mean money was collected.
 * "Pending" and "Failed" are the only states that mean it was not.
 *
 * Exported because this list was previously written out by hand at each gate, and
 * the copies drifted. `recordRtoRefundObligation` in shipping.controller.js kept the
 * two-value version {Paid, Partially Refunded}, so an RTO on an order sitting at
 * "Refund Pending" — a prepaid customer with an unsettled partial refund — was told
 * "no payment was ever collected" and its liability was never recorded at all. The
 * customer had paid in full and received nothing.
 *
 * A gate that answers "was money collected?" must answer it the same way everywhere,
 * so there is one list and every caller reads it.
 */
export const MONEY_COLLECTED_PAYMENT_STATUSES = [
  "Paid",
  "Partially Refunded",
  "Refund Pending",
  "Refunded",
];

/**
 * Money that has DEMONSTRABLY moved — `processed` only.
 *
 * Kept separate from sumRefunded because paymentStatus must never say
 * "Refunded" on the strength of an intent record. That distinction is the whole
 * invariant of this module: a status may not claim something that hasn't
 * happened.
 */
export const sumSettledRefunds = (order) =>
  (order.refunds || [])
    .filter((refund) => refund.status === "processed")
    .reduce((total, refund) => total + Number(refund.amount || 0), 0);

/**
 * Derives paymentStatus from the refund ledger and persists the order.
 *
 * Single place for this so the "how much has actually been refunded" rule can't
 * drift between call sites — one of the audit findings was the admin endpoint
 * hand-rolling its own total that counted `failed` refunds.
 */
export const recomputeRefundState = async (order, { session = null } = {}) => {
  order.paymentStatus = deriveRefundPaymentStatus(order);
  await order.save(session ? { session } : undefined);
  return order.paymentStatus;
};

/** What paymentStatus the refund ledger implies — pure; recomputeRefundState persists it. */
const deriveRefundPaymentStatus = (order) => {
  // Settled only — an `owed` or `created` record must never move the status to
  // "Refunded".
  const settled = sumSettledRefunds(order);
  const committed = sumRefunded(order);
  const total = Number(order.totalAmount) || 0;

  if (settled >= total - 0.01 && total > 0) return "Refunded";
  if (settled > 0) return "Partially Refunded";
  // Money is owed and an attempt exists, but nothing has actually moved yet.
  if (committed > 0) return "Refund Pending";
  if (REFUND_STATUSES.includes(order.paymentStatus)) {
    // Nothing settled AND nothing in flight: every refund on this order failed,
    // so the money never left us. Without this branch the order stayed stuck in
    // "Refund Pending"/"Refunded" after a gateway-failed refund — the status
    // claiming a movement that had been reversed. Only orders already in a
    // refund state are touched, so a COD order still awaiting collection keeps
    // its "Pending".
    return "Paid";
  }
  return order.paymentStatus;
};

/**
 * recomputeRefundState as a compare-and-swap, for writers that run concurrently
 * with each other (the webhook, the poller, a reconcile).
 *
 * The status is written only while every row's status is still what it was read
 * as — row amounts never change — so a write derived from a ledger that has
 * since moved misses, re-reads and derives again. Bounded; after the last miss
 * the fresh document is returned as is, and whichever writer moved the ledger
 * derives from it.
 */
const syncRefundPaymentStatus = async (orderId) => {
  let order = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    order = await OrderModel.findById(orderId);
    if (!order) return null;
    const next = deriveRefundPaymentStatus(order);
    if (next === order.paymentStatus) return order;
    const statuses = (order.refunds || []).map((entry) => entry.status);
    const result = await OrderModel.updateOne(
      { _id: orderId, $expr: { $eq: [{ $ifNull: ["$refunds.status", []] }, statuses] } },
      { $set: { paymentStatus: next } },
    );
    if (result.matchedCount > 0) {
      order.paymentStatus = next;
      return order;
    }
  }
  return order;
};

/**
 * The key every retry in a failed refund's chain carries. A retry row already
 * carries it; any other failed row is the chain's root. See ReconcileOrderRefund.
 */
export const retryChainKey = (row) =>
  String(row?.idempotencyKey || "").startsWith("retry:") ? row.idempotencyKey : `retry:${row?._id}`;

// Keys naming the distinct event a refund was raised for. Two such rows with the
// same reason and amount (two identical partial cancellations) are two refunds,
// not one re-sent.
const DISTINCT_ORIGIN_KEY = /^(cancel|partial-cancel|owed):/;

/**
 * A live row that already pays what a FAILED row was for — so retrying the failed
 * row would pay the customer twice. In order:
 *   - the failed row's own retry chain (same retryChainKey) — only when
 *     `includeChain`; a retry adopts its chain's live row rather than refusing;
 *   - a refund for the same return (the returns flow pushes its own row);
 *   - the same money re-sent through the generic Refund form after the chain
 *     began: a fresh key, but the same reason and amount, later in the ledger.
 */
export const findRefundReissue = (order, failedRow, { includeChain = true } = {}) => {
  const ledger = order?.refunds || [];
  const chainKey = retryChainKey(failedRow);
  const rootId = chainKey.slice("retry:".length);
  const rootIndex = ledger.findIndex((entry) => String(entry._id) === rootId);
  const fromIndex =
    rootIndex >= 0 ? rootIndex : ledger.findIndex((entry) => String(entry._id) === String(failedRow._id));
  return (
    ledger.find((entry, index) => {
      if (String(entry._id) === String(failedRow._id) || entry.status === "failed") return false;
      if (entry.idempotencyKey === chainKey) return includeChain;
      if (failedRow.returnRequest && String(entry.returnRequest || "") === String(failedRow.returnRequest)) {
        return true;
      }
      return (
        index > fromIndex &&
        !DISTINCT_ORIGIN_KEY.test(String(entry.idempotencyKey || "")) &&
        entry.reason === failedRow.reason &&
        Math.abs(Number(entry.amount || 0) - Number(failedRow.amount || 0)) < 0.01
      );
    }) || null
  );
};

/**
 * Failed gateway refunds nothing has replaced — money still owed, with no live
 * row anywhere in the ledger saying so (a failed row is outside every sum). One
 * per retry chain, the latest: retrying it is what pays the chain.
 */
export const unresolvedFailedRefunds = (order) => {
  const byChain = new Map();
  for (const row of order?.refunds || []) {
    if (row.status !== "failed" || row.confirmationMethod === "manual") continue;
    if (findRefundReissue(order, row)) continue;
    byChain.set(retryChainKey(row), row);
  }
  return [...byChain.values()];
};

/** The orders that hold a failed gateway refund — candidates for unresolvedFailedRefunds. */
export const FAILED_GATEWAY_REFUND_MATCH = {
  refunds: { $elemMatch: { status: "failed", confirmationMethod: { $ne: "manual" } } },
};

/** Every unresolved failed refund in the store, as `{order, refund}` pairs. */
export const listUnresolvedFailedRefunds = async (extraFilter = {}) => {
  const orders = await OrderModel.find(
    { ...extraFilter, ...FAILED_GATEWAY_REFUND_MATCH },
    { refunds: 1 },
  ).lean();
  return orders.flatMap((order) =>
    unresolvedFailedRefunds(order).map((refund) => ({ order, refund })),
  );
};

export const findRefundForReturn = (order, returnId) =>
  (order.refunds || []).find(
    (refund) =>
      String(refund.returnRequest || "") === String(returnId) && refund.status !== "failed",
  );

// True when the money can be pushed back through the gateway automatically.
// Anything else (COD, or a Razorpay order whose payment id was never captured)
// has to be settled out-of-band and recorded by the admin.
export const canAutoRefund = (order) =>
  order.paymentMethod === "RAZORPAY" && Boolean(order.razorpayPaymentId) && isPaymentEnabled();

/**
 * Asks Razorpay whether a refund carrying this note already exists.
 *
 * This is what makes a retry after a network timeout safe. Every gateway refund
 * is tagged with a note (`notes.refundKey`, or `notes.returnNumber` for a
 * return), so if the previous attempt actually reached Razorpay before the
 * connection dropped, it can be found and adopted instead of issuing a second one.
 *
 * `excludeRefundIds` are gateway refunds already recorded on other ledger rows —
 * they belong to someone else and are never adopted. Among what remains, a live
 * (not failed) refund wins over a failed one: a failed refund under the same note
 * says nothing about whether a later attempt landed.
 *
 * @returns the matching gateway refund, or null if there demonstrably isn't one.
 * @throws if Razorpay cannot be reached — callers must NOT fall back to
 *         refunding again, because "unknown" is not "didn't happen".
 */
export const findGatewayRefundByNote = async ({
  order,
  noteKey,
  noteValue,
  label,
  excludeRefundIds = [],
}) => {
  const { razorpay } = getRazorpay();
  let response;
  try {
    response = await razorpay.payments.fetchMultipleRefund(order.razorpayPaymentId, { count: 100 });
  } catch (error) {
    throw fail(
      `A refund for ${label} may already have been issued, but Razorpay could not be reached to confirm: ${getRazorpayErrorMessage(error)}. Check the Razorpay dashboard before retrying — retrying blindly could refund this customer twice.`,
      502,
      "REFUND_RECONCILE_UNAVAILABLE",
    );
  }

  const excluded = new Set(excludeRefundIds.filter(Boolean).map(String));
  const refunds = Array.isArray(response?.items) ? response.items : [];
  const live = refunds.filter(
    (refund) =>
      String(refund?.notes?.[noteKey] || "") === String(noteValue) &&
      !excluded.has(String(refund?.id || "")),
  );
  return live.find((refund) => refund.status !== "failed") || live[0] || null;
};

/**
 * Settles a return by actually moving money, then records it on the order.
 *
 * Deliberately throws instead of returning a soft failure: the caller marks the
 * return "refunded" only if this resolves, so the customer is never told they
 * were refunded when they weren't. A gateway that DECLINES the refund throws too
 * (GATEWAY_REFUND_REJECTED), so the return goes back to `received` for a retry.
 *
 * Resolves with `refundStatus`: `processed` when the money has moved (or for a
 * manual / wallet-only refund), `created` when Razorpay accepted the refund but
 * has not settled it — the caller tells the customer "refund initiated", and the
 * webhook or poller sends "refund processed" later. A `created` refund that then
 * fails puts the return back at `received` by itself (applyGatewayRefundState).
 *
 * The gateway half runs through settleGatewayRefund, the same sequence the
 * cancellation and admin paths use, keyed on `notes.returnNumber`.
 *
 * @returns {{refund, refundStatus, alreadyRefunded: boolean, walletCredited: number, ...}}
 */
export const refundReturnRequest = async ({ order, returnRequest, adminId, manual = {} }) => {
  // ── WALLET HALF, FIRST ──────────────────────────────────────────────────────
  // Deliberately before the gateway work and before every early return, because
  // restoreWalletCredit is idempotent (capped by order.walletRefunded) while the
  // gateway call is not. Doing it here means the prepaid portion reaches the
  // customer even if the card refund then fails, and a retry cannot double it.
  // It also back-fills returns that were settled before this split existed.
  const walletCredited = await restoreWalletCredit({
    order,
    amount: returnRequest.walletRefundAmount,
  });

  const existing = findRefundForReturn(order, returnRequest._id);

  // Already settled — hand it back so the caller can finish flipping status.
  // `notified`: the customer was told when the row settled (by whichever path
  // settled it), so the caller must not send "refund processed" a second time.
  if (existing?.status === "processed") {
    return { refund: existing, refundStatus: "processed", alreadyRefunded: true, notified: true, walletCredited };
  }

  const amount = Number(returnRequest.refundAmount);
  if (!Number.isFinite(amount) || amount < 0) {
    throw fail("This return has no valid refund amount", 400, "INVALID_REFUND_AMOUNT");
  }
  if (amount === 0) {
    // Nothing to reverse through the gateway. Legitimate when the line was paid
    // entirely from wallet credit, which has already been returned above — the
    // refund is complete, so don't fabricate a zero-value gateway call or a
    // zero-value ledger row.
    if (walletCredited > 0) {
      return {
        refund: null,
        refundStatus: "processed",
        alreadyRefunded: false,
        walletCredited,
        walletOnly: true,
      };
    }
    throw fail("This return has no valid refund amount", 400, "INVALID_REFUND_AMOUNT");
  }

  // Never let cumulative refunds exceed what the customer actually paid. A row
  // this call is about to REUSE is already in the committed sum, so it is not
  // counted twice — otherwise retrying a timed-out full-order return would be
  // refused as exceeding the total.
  const alreadyRefunded = sumRefunded(order) - (existing ? Number(existing.amount || 0) : 0);
  if (alreadyRefunded + amount > Number(order.totalAmount) + 0.01) {
    throw fail(
      `Refunding ₹${amount} would exceed the order total (₹${order.totalAmount}, already refunded ₹${alreadyRefunded})`,
      400,
      "REFUND_EXCEEDS_ORDER_TOTAL",
    );
  }

  let refundRecord;

  if (canAutoRefund(order)) {
    // ── INTENT FIRST ────────────────────────────────────────────────────────
    // The record is persisted BEFORE the gateway is called. Previously the call
    // came first, so a response timeout on a refund Razorpay had actually
    // processed left no trace at all — and the operator's retry paid the
    // customer a second time. With the intent on disk, a retry finds it and
    // reconciles against Razorpay instead of blindly re-refunding.
    let pending = existing;
    let reusing = Boolean(existing);
    if (!pending) {
      const pushed = await pushReturnRefundRow({
        order,
        returnRequest,
        row: {
          paymentProvider: "razorpay",
          providerPaymentId: order.razorpayPaymentId,
          returnRequest: returnRequest._id,
          amount,
          reason: `Return ${returnRequest.returnNumber}`,
          status: "created",
          // Confirmed by Razorpay's refund.processed webhook, not by a human.
          confirmationMethod: "gateway",
          createdBy: adminId,
        },
      });
      if (pushed.settled) {
        return { refund: pushed.row, refundStatus: "processed", alreadyRefunded: true, notified: true, walletCredited };
      }
      pending = pushed.row;
      // Lost the push to a concurrent writer (a retry from the order page): its
      // row is reused like any earlier attempt, after asking Razorpay first.
      reusing = !pushed.created;
    }

    const result = await settleGatewayRefund({
      order,
      refundId: pending._id,
      amount,
      reason: `Return ${returnRequest.returnNumber}`,
      // The reconciliation key: a retry finds an earlier attempt by it.
      lookupNote: { key: "returnNumber", value: returnRequest.returnNumber },
      extraNotes: { returnNumber: returnRequest.returnNumber },
      // A reused row means an earlier attempt may have reached Razorpay even if
      // the row never recorded it (legacy rows, written before the attempt claim
      // existed). Ask first.
      forceLookup: reusing,
    });

    if (result.outcome === "in_progress") {
      throw fail(
        "A refund for this return is already being processed. Reload in a moment to see the result — do not retry, or the customer could be refunded twice.",
        409,
        "REFUND_IN_PROGRESS",
      );
    }
    if (result.outcome === "unconfirmed") {
      throw fail(result.message, 502, "REFUND_RECONCILE_UNAVAILABLE");
    }
    if (result.outcome === "gateway_failed") {
      // The row stays `created`, not `failed`: `failed` is excluded from
      // sumRefunded and from findRefundForReturn, which would make the next
      // attempt skip reconciliation and risk a double payment. "created"
      // deliberately means "outcome unknown — verify before retrying".
      throw fail(
        `Razorpay refund failed: ${result.message}. The attempt is recorded as pending — retrying will check with Razorpay first rather than refunding twice.`,
        502,
        "GATEWAY_REFUND_FAILED",
      );
    }
    if (result.refundStatus === "failed") {
      throw fail(
        "Razorpay declined this refund; the return is back at Received — retry it",
        502,
        "GATEWAY_REFUND_REJECTED",
      );
    }

    const fresh = await OrderModel.findById(order._id);
    return {
      refund: fresh?.refunds?.id(pending._id) || pending,
      refundStatus: result.refundStatus,
      alreadyRefunded: result.outcome === "reconciled",
      ...(result.outcome === "reconciled" ? { adopted: true } : {}),
      gatewayStatus: result.gatewayStatus,
      notified: result.notified,
      walletCredited,
    };
  } else {
    // COD and other offline orders: there's no payment to reverse, so the admin
    // must have already paid the customer and supply a reference. Without one
    // there'd be no evidence the refund happened — exactly the "says refunded
    // but isn't" problem this service exists to prevent.
    const method = String(manual.method || "").toLowerCase();
    const reference = String(manual.reference || "").trim();

    if (!MANUAL_METHODS.includes(method) || !reference) {
      throw fail(
        `This order was not paid through Razorpay, so the refund has to be settled manually. Record how you refunded the customer (${MANUAL_METHODS.join(", ")}) and a reference number.`,
        400,
        "MANUAL_REFUND_DETAILS_REQUIRED",
      );
    }

    refundRecord = {
      paymentProvider: "manual",
      providerRefundId: reference,
      providerPaymentId: "",
      returnRequest: returnRequest._id,
      amount,
      reason: `Return ${returnRequest.returnNumber} — refunded via ${method}`,
      // "processed" is honest here: unlike the gateway path there is no
      // asynchronous settlement to wait for. The admin has already moved the money
      // by hand and is recording the reference that proves it — the reference is
      // mandatory precisely so this status is backed by evidence.
      status: "processed",
      confirmationMethod: "manual",
      processedAt: new Date(),
      createdBy: adminId,
    };
  }

  const pushed = await pushReturnRefundRow({ order, returnRequest, row: refundRecord });
  if (!pushed.created) {
    if (pushed.settled) {
      return { refund: pushed.row, refundStatus: "processed", alreadyRefunded: true, notified: true, walletCredited };
    }
    throw fail(
      "Another refund for this return is already being recorded. Reload the return in a moment — do not record the payout twice.",
      409,
      "REFUND_IN_PROGRESS",
    );
  }
  await recomputeRefundState(pushed.order);

  return {
    refund: pushed.row,
    refundStatus: "processed",
    alreadyRefunded: false,
    walletCredited,
  };
};

/**
 * Pushes a NEW refund row for a return, atomically — only while no live
 * (non-`failed`) row already settles that return, and only within the order
 * total. Both preconditions are in the filter, the same shape claimRefundSlot
 * uses for a retry (`blockIfLiveForReturn`), so the Returns page and a "Retry
 * refund" on the order page cannot both pass a read and both push.
 *
 * @returns {{order, row, created: boolean, settled?: boolean}} `created: false`
 *   hands back the live row that won; `settled` says it is already `processed`.
 */
const pushReturnRefundRow = async ({ order, returnRequest, row }) => {
  const refundId = new mongoose.Types.ObjectId();
  const value = Math.round((Number(row.amount) || 0) * 100) / 100;
  const claimed = await OrderModel.findOneAndUpdate(
    {
      _id: order._id,
      refunds: {
        $not: { $elemMatch: { returnRequest: returnRequest._id, status: { $ne: "failed" } } },
      },
      $expr: {
        $lte: [
          { $add: [COMMITTED_REFUND_SUM, value] },
          { $add: [{ $ifNull: ["$totalAmount", 0] }, 0.01] },
        ],
      },
    },
    { $push: { refunds: { ...row, _id: refundId, amount: value } } },
    { returnDocument: "after" },
  );
  if (claimed) return { order: claimed, row: claimed.refunds.id(refundId), created: true };

  const current = await OrderModel.findById(order._id);
  const live = current ? findRefundForReturn(current, returnRequest._id) : null;
  if (live) {
    return { order: current, row: live, created: false, settled: live.status === "processed" };
  }
  throw fail(
    `Refunding ₹${value} would exceed the order total (₹${current?.totalAmount}, already refunded ₹${current ? sumRefunded(current) : 0})`,
    400,
    "REFUND_EXCEEDS_ORDER_TOTAL",
  );
};

export { MANUAL_METHODS };
