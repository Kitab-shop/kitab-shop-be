import OrderModel from "../orders/Order.model.js";
import PaymentIntent from "./PaymentIntent.model.js";
import {
  getFeatures,
  isPaymentEnabled,
  isStockEnforced,
} from "../../config/features.config.js";
import {
  notifyPaymentFailed,
  notifyRefundInitiated,
  notifyRefundProcessed,
} from "../notifications/notification.service.js";
import { orderError, prepareOrderData } from "../orders/order-pricing.service.js";
import { logLifecycleEvent } from "../../utils/lifecycle-logger.service.js";
import {
  releaseReservation,
  reserveStockForIntent,
} from "../inventory/inventory-reservation.service.js";
import {
  createRazorpayReceipt,
  getRazorpay,
  getRazorpayErrorMessage,
  isValidSignature,
  isValidWebhookSignature,
} from "./razorpay.service.js";
import { completeCapturedIntent } from "./payment-order.service.js";
import { hasAdminRole } from "../../config/admin-permissions.config.js";
import {
  claimGatewayAttempt,
  claimRefundSlot,
  deriveRefundIdempotencyKey,
  findGatewayRefundByNote,
  mapGatewayRefundStatus,
  settleRefundRecord,
  writeRefundSettlement,
} from "./return-refund.service.js";
import { applyRazorpayRefundWebhook } from "./refund-sync.service.js";
import {
  isUnrecoverableCapture,
  refundOrphanedCapture,
} from "./orphaned-capture.service.js";
import { createAuditLog } from "../audit/audit-log.js";
import WebhookEvent from "./WebhookEvent.model.js";
import { AWAITING_PAYMENT_TTL_MS } from "../orders/order-visibility.js";

const ADMIN_PURCHASE_MESSAGE =
  "Admin accounts cannot place orders. Please use a customer account.";

export const CreateRazorpayOrder = async (req, res) => {
  try {
    if (!isPaymentEnabled()) {
      return res.status(503).json({
        success: false,
        message: "Razorpay payments are disabled for this environment",
        code: "PAYMENTS_DISABLED",
      });
    }

    if (hasAdminRole(req.user)) {
      return res.status(403).json({ success: false, message: ADMIN_PURCHASE_MESSAGE });
    }

    const { items = [], shippingAddress, coupon = null, useWallet, idempotencyKey } = req.body || {};
    if (!idempotencyKey || !/^[A-Za-z0-9_-]{16,100}$/.test(idempotencyKey)) {
      throw orderError("A valid checkout idempotency key is required");
    }

    const existingIntent = await PaymentIntent.findOne({
      user: req.user.id,
      idempotencyKey,
      status: { $in: ["created", "processing", "completed"] },
    });
    if (existingIntent) {
      // The intent's amount is what Razorpay will charge, and it was fixed when the intent was
      // created. Returning it without re-checking let a shopper be charged for a cart they no
      // longer have: create the intent at Rs 1,000, close the Razorpay window, change the
      // basket to Rs 500, press pay again, and this returned the Rs 1,000 order id.
      //
      // Refused rather than superseded, because an intent can own a stock reservation and may
      // already be `processing` — replacing one safely means releasing that reservation and
      // proving no payment is in flight. A refusal the client can recover from by starting a
      // fresh checkout is the honest, cheap answer.
      let currentAmount = null;
      try {
        const currentOrder = await prepareOrderData({
          items,
          rawShippingAddress: shippingAddress,
          coupon,
          userId: req.user.id,
          redeemCoupon: false,
          useWallet: Boolean(useWallet),
          paymentMethod: "RAZORPAY",
        });
        currentAmount = Math.round(currentOrder.totalAmount * 100);
      } catch {
        // Cannot even price the cart now (stock gone, coupon expired). Whatever the intent
        // says, it no longer describes a purchasable basket.
        currentAmount = null;
      }

      if (currentAmount === null || currentAmount !== existingIntent.amount) {
        logLifecycleEvent("payments", "payment_intent_amount_mismatch", {
          paymentIntentId: String(existingIntent._id),
          intentAmount: existingIntent.amount,
          currentAmount,
        });
        return res.status(409).json({
          success: false,
          message:
            "Your basket changed after this payment was started, so the amount no longer matches. Please start the payment again.",
          code: "CART_CHANGED",
        });
      }

      const { keyId } = getRazorpay();
      return res.status(200).json({
        success: true,
        data: {
          paymentIntentId: existingIntent._id,
          keyId,
          razorpayOrderId: existingIntent.razorpayOrderId,
          amount: existingIntent.amount,
          currency: existingIntent.currency,
        },
      });
    }
    const preparedOrder = await prepareOrderData({
      items,
      rawShippingAddress: shippingAddress,
      coupon,
      userId: req.user.id,
      redeemCoupon: false,
      useWallet: Boolean(useWallet),
      paymentMethod: "RAZORPAY",
    });
    const amount = Math.round(preparedOrder.totalAmount * 100);
    if (amount < 100) {
      return res.status(400).json({
        success: false,
        message: "Razorpay payment amount must be at least Rs 1",
      });
    }

    const { razorpay, keyId } = getRazorpay();
    const receipt = createRazorpayReceipt("kitab");
    const razorpayOrder = await razorpay.orders.create({
      amount,
      currency: "INR",
      receipt,
      notes: { userId: String(req.user.id), source: "Kitab Shop Checkout" },
    });

    const intent = await PaymentIntent.create({
      user: req.user.id,
      idempotencyKey,
      razorpayOrderId: razorpayOrder.id,
      amount,
      currency: razorpayOrder.currency || "INR",
      items: preparedOrder.orderItems,
      shippingAddress: preparedOrder.shippingAddress,
      subtotal: preparedOrder.subtotal,
      shippingCharge: preparedOrder.shippingCharge,
      tax: preparedOrder.tax,
      discount: preparedOrder.discount,
      walletDiscount: preparedOrder.walletDiscount,
      couponDiscount: preparedOrder.couponDiscount,
      totalAmount: preparedOrder.totalAmount,
      coupon: preparedOrder.couponId,
    });

    // ── ORDER-FIRST ──────────────────────────────────────────────────────────
    // The order row is created BEFORE the customer pays, at Pending/Pending, so
    // there is an order number to show immediately and a durable record to
    // reconcile a captured-but-unmatched payment against.
    //
    // It carries NO money and NO commitments yet: coupon redemption, the wallet
    // debit and the stock decrement all still happen at capture, inside the
    // transaction in completeCapturedIntent. Burning a coupon on a checkout that
    // is abandoned thirty seconds later would be wrong.
    //
    // Anything reading orders for revenue, counts or lists MUST exclude this state
    // — see order-visibility.js. `paymentExpiresAt` is what lets an abandoned one
    // be swept up rather than sitting Pending forever.
    const [pendingOrder] = await OrderModel.create([
      {
        user: req.user.id,
        items: preparedOrder.orderItems,
        shippingAddress: preparedOrder.shippingAddress,
        paymentMethod: "RAZORPAY",
        paymentStatus: "Pending",
        orderStatus: "Pending",
        subtotal: preparedOrder.subtotal,
        shippingCharge: preparedOrder.shippingCharge,
        tax: preparedOrder.tax,
        discount: preparedOrder.discount,
        walletDiscount: preparedOrder.walletDiscount,
        couponDiscount: preparedOrder.couponDiscount,
        totalAmount: preparedOrder.totalAmount,
        coupon: preparedOrder.couponId,
        razorpayOrderId: razorpayOrder.id,
        paymentExpiresAt: new Date(Date.now() + AWAITING_PAYMENT_TTL_MS),
        statusHistory: [
          {
            from: "",
            to: "Pending",
            changedBy: req.user.id,
            source: "checkout",
            changedAt: new Date(),
          },
        ],
      },
    ]);
    // pendingOrder, NOT storeOrder — see PaymentIntent.model.js. storeOrder is set
    // only once the payment is captured and the order is promoted.
    intent.pendingOrder = pendingOrder._id;
    await intent.save();

    const { inventory } = getFeatures();
    if (inventory.reserveDuringPayment && isStockEnforced()) {
      await reserveStockForIntent({
        userId: req.user.id,
        paymentIntentId: intent._id,
        idempotencyKey,
        items: preparedOrder.orderItems,
      });
      intent.stockReserved = true;
      await intent.save();
    }

    return res.status(201).json({
      success: true,
      data: {
        paymentIntentId: intent._id,
        // The customer can be shown this straight away.
        orderId: pendingOrder._id,
        keyId,
        razorpayOrderId: razorpayOrder.id,
        amount,
        currency: intent.currency,
        receipt,
      },
    });
  } catch (error) {
    return res.status(error.statusCode || error?.statusCode || 500).json({
      success: false,
      message: getRazorpayErrorMessage(error),
    });
  }
};

export const VerifyRazorpayPayment = async (req, res) => {
  let intent;
  let capturedPayment;
  let storeOrder;

  try {
    if (!isPaymentEnabled()) {
      return res.status(503).json({
        success: false,
        message: "Razorpay payments are disabled for this environment",
        code: "PAYMENTS_DISABLED",
      });
    }

    const {
      razorpay_order_id: returnedOrderId,
      razorpay_payment_id: paymentId,
      razorpay_signature: signature,
    } = req.body || {};

    if (!returnedOrderId || !paymentId || !signature) {
      throw orderError("Razorpay payment verification fields are required");
    }

    // Matches a superseded id too, so a customer who paid in a stale checkout
    // window still gets their order instead of a lost payment.
    intent = await PaymentIntent.findOne({
      user: req.user.id,
      $or: [
        { razorpayOrderId: returnedOrderId },
        { previousRazorpayOrderIds: returnedOrderId },
      ],
    });
    if (!intent) throw orderError("Payment session was not found", 404);

    const { razorpay, keySecret } = getRazorpay();
    if (
      // Signed against the id the payment was actually made on — which is the
      // returned one, now confirmed to belong to this intent. Using
      // intent.razorpayOrderId would reject every legitimate retry-window payment.
      !isValidSignature({
        razorpayOrderId: returnedOrderId,
        razorpayPaymentId: paymentId,
        signature,
        secret: keySecret,
      })
    ) {
      throw orderError("Payment signature verification failed", 400);
    }

    if (intent.status === "completed" && intent.storeOrder) {
      const existingOrder = await OrderModel.findById(intent.storeOrder);
      return res.status(200).json({
        success: true,
        message: "Payment already verified",
        order: existingOrder,
      });
    }

    capturedPayment = await razorpay.payments.fetch(paymentId);
    const knownOrderIds = [
      intent.razorpayOrderId,
      ...(intent.previousRazorpayOrderIds || []),
    ];
    if (!knownOrderIds.includes(capturedPayment.order_id)) {
      throw orderError("Payment does not belong to this Razorpay order");
    }
    if (
      Number(capturedPayment.amount) !== intent.amount ||
      String(capturedPayment.currency).toUpperCase() !== intent.currency
    ) {
      throw orderError("Paid amount does not match the checkout amount");
    }

    if (capturedPayment.status === "authorized") {
      capturedPayment = await razorpay.payments.capture(
        paymentId,
        intent.amount,
        intent.currency,
      );
    }
    if (capturedPayment.status !== "captured") {
      throw orderError(`Payment is ${capturedPayment.status}, not captured`, 409);
    }

    storeOrder = await completeCapturedIntent({
      intent,
      capturedPayment,
      signature,
    });

    return res.status(201).json({
      success: true,
      message: "Payment verified and order placed successfully",
      order: storeOrder,
    });
  } catch (error) {
    const paymentWasCaptured = capturedPayment?.status === "captured";
    const orderWasCreated = Boolean(storeOrder?._id);

    // An order may exist even though this request failed — e.g. a concurrent
    // verify or the webhook completed it first, and completeCapturedIntent then
    // threw a 409. Re-check the intent before deciding the payment is orphaned.
    let orderExistsForIntent = orderWasCreated;
    if (!orderExistsForIntent && intent?._id) {
      const latest = await PaymentIntent.findById(intent._id).select("storeOrder");
      orderExistsForIntent = Boolean(latest?.storeOrder);
    }

    // Never auto-refund a captured payment that has an order behind it. This
    // block used to fire on ANY failure after capture, so a stale
    // payment.failed webhook could flip the intent, make verify throw 409, and
    // this would refund the customer's PERFECTLY GOOD payment — leaving them
    // paid, refunded, and orderless with an error on screen.
    if (paymentWasCaptured && !orderExistsForIntent && intent) {
      // Routed through the shared compensation so this path also leaves a durable
      // `unmatchedpayments` row. It previously refunded without recording
      // anything, so a refund that then failed left no trace of the liability —
      // and the webhook path had no compensation at all. One function now, used
      // by both, which is what makes them equivalent rather than merely similar.
      const outcome = await refundOrphanedCapture({
        paymentId: capturedPayment.id,
        amount: intent.amount,
        currency: intent.currency || "INR",
        providerOrderId: capturedPayment.order_id || intent.razorpayOrderId || "",
        paymentIntentId: intent._id,
        orderId: intent.pendingOrder || null,
        userId: intent.user || null,
        reason: getRazorpayErrorMessage(error),
      });
      const refunded = outcome.refunded;
      if (refunded) {
        await releaseReservation({
          paymentIntentId: intent._id,
          reason: "payment_refunded_after_order_failure",
        });
        // "Processed" only when Razorpay said so; a normal-speed refund replies
        // `pending`, and the customer is told it has been initiated.
        await (outcome.gatewayStatus === "processed" ? notifyRefundProcessed : notifyRefundInitiated)({
          orderId: storeOrder?._id || intent.storeOrder || null,
          paymentId: capturedPayment.id,
        });
      }
      // Status filter so a late failure can't overwrite an intent that has since
      // been completed by a concurrent verify or the webhook.
      await PaymentIntent.findOneAndUpdate(
        { _id: intent._id, status: { $in: ["created", "processing", "failed"] } },
        {
          status: refunded ? "refunded" : "failed",
          failureReason: getRazorpayErrorMessage(error),
        },
      );

      if (!refunded) {
        return res.status(500).json({
          success: false,
          message:
            "Payment was captured but the order could not be created. Contact support with payment ID " +
            capturedPayment.id,
        });
      }

      return res.status(409).json({
        success: false,
        message: `Payment was refunded because the order could not be completed: ${getRazorpayErrorMessage(error)}`,
        code: "RAZORPAY_PAYMENT_REFUNDED",
      });
    }

    // Don't tell a customer their payment failed when an order exists for it —
    // this path is reachable via a 409 from a concurrent verify/webhook that
    // actually succeeded.
    if (!orderExistsForIntent) {
      // pendingOrder is the order the customer was shown at checkout (order-first);
      // without it this notification had no order and reached nobody useful.
      await notifyPaymentFailed({
        orderId: storeOrder?._id || intent?.storeOrder || intent?.pendingOrder || null,
        reason: getRazorpayErrorMessage(error),
      });
    }

    return res.status(error.statusCode || 500).json({
      success: false,
      message: getRazorpayErrorMessage(error),
      code: "RAZORPAY_VERIFICATION_FAILED",
    });
  }
};

export const RetryRazorpayOrder = async (req, res) => {
  try {
    if (!isPaymentEnabled()) {
      return res.status(503).json({
        success: false,
        message: "Razorpay payments are disabled for this environment",
        code: "PAYMENTS_DISABLED",
      });
    }

    const intent = await PaymentIntent.findOne({
      _id: req.params.intentId,
      user: req.user.id,
      status: { $in: ["created", "failed"] },
      // Defence in depth against the double-charge chain: an intent that already
      // produced an order must never be retried, whatever its status says. Even
      // if something flips the status back to "failed", there is nothing left to
      // retry once the order exists.
      $or: [{ storeOrder: null }, { storeOrder: { $exists: false } }],
    });
    if (!intent) {
      return res.status(404).json({
        success: false,
        message: "Retryable payment session was not found",
      });
    }

    // ── THE ORDER MUST STILL BE PAYABLE ──────────────────────────────────────
    // Claimed BEFORE a new Razorpay order is minted. The intent alone is not
    // enough: an order swept to Cancelled (or cancelled by the customer/admin)
    // could leave its intent at "created"/"failed", and a retry then took a
    // payment for a checkout that could never be promoted — the capture landed on
    // a Cancelled order and had to be refunded. Extending paymentExpiresAt in the
    // same write also stops the abandoned-checkout sweeper cancelling the order
    // while the customer is paying on the new Razorpay order.
    if (intent.pendingOrder) {
      const live = await OrderModel.findOneAndUpdate(
        { _id: intent.pendingOrder, orderStatus: "Pending", paymentStatus: "Pending" },
        { $set: { paymentExpiresAt: new Date(Date.now() + AWAITING_PAYMENT_TTL_MS) } },
        { returnDocument: "after" },
      );
      if (!live) {
        // Close the intent too, so this checkout is refused at the intent lookup
        // next time instead of reaching this check again.
        await PaymentIntent.updateOne(
          { _id: intent._id, status: { $in: ["created", "failed"] }, storeOrder: null },
          {
            $set: {
              status: "expired",
              failureReason: "Order is no longer awaiting payment",
            },
          },
        );
        return res.status(409).json({
          success: false,
          code: "ORDER_NOT_PAYABLE",
          message: "This checkout has expired — please start a new checkout",
        });
      }
    }

    const { razorpay, keyId } = getRazorpay();
    const receipt = createRazorpayReceipt("retry");
    const razorpayOrder = await razorpay.orders.create({
      amount: intent.amount,
      currency: intent.currency,
      receipt,
      notes: {
        userId: String(req.user.id),
        previousRazorpayOrderId: intent.razorpayOrderId,
      },
    });

    // Keep the superseded id rather than discarding it — see
    // PaymentIntent.previousRazorpayOrderIds. Without this a payment completed on
    // the old Razorpay order became unresolvable and the money was simply lost.
    if (intent.razorpayOrderId && intent.razorpayOrderId !== razorpayOrder.id) {
      intent.previousRazorpayOrderIds = [
        ...new Set([...(intent.previousRazorpayOrderIds || []), intent.razorpayOrderId]),
      ];
    }
    intent.razorpayOrderId = razorpayOrder.id;
    intent.status = "created";
    intent.failureReason = "";
    intent.retryCount += 1;
    await intent.save();

    // Carry the pending order onto the new Razorpay order and extend its window.
    // orders.razorpayOrderId is UNIQUE and is how payment.captured locates the
    // order, so leaving the superseded id here would orphan a payment made on the
    // retry — the same failure H-14 fixed on the intent side.
    if (intent.pendingOrder) {
      await OrderModel.updateOne(
        { _id: intent.pendingOrder, orderStatus: "Pending", paymentStatus: "Pending" },
        {
          $set: {
            razorpayOrderId: razorpayOrder.id,
            paymentExpiresAt: new Date(Date.now() + AWAITING_PAYMENT_TTL_MS),
          },
        },
      );
    }

    return res.status(201).json({
      success: true,
      data: {
        paymentIntentId: intent._id,
        keyId,
        razorpayOrderId: intent.razorpayOrderId,
        amount: intent.amount,
        currency: intent.currency,
        receipt,
      },
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      success: false,
      message: getRazorpayErrorMessage(error),
    });
  }
};

export const RefundRazorpayPayment = async (req, res) => {
  try {
    if (!hasAdminRole(req.user)) {
      return res.status(403).json({
        success: false,
        message: "You are not allowed to refund orders",
      });
    }

    if (!isPaymentEnabled()) {
      return res.status(503).json({
        success: false,
        message: "Razorpay payments are disabled for this environment",
        code: "PAYMENTS_DISABLED",
      });
    }

    let order = await OrderModel.findById(req.params.orderId);
    if (!order) return res.status(404).json({ success: false, message: "Order not found" });
    if (order.paymentMethod !== "RAZORPAY" || !order.razorpayPaymentId) {
      return res.status(400).json({
        success: false,
        message: "Only Razorpay paid orders can be refunded through this endpoint",
      });
    }

    const amountRupees = Number(req.body?.amount || order.totalAmount);
    if (!Number.isFinite(amountRupees) || amountRupees <= 0) {
      return res.status(400).json({ success: false, message: "Invalid refund amount" });
    }

    const reason = String(req.body?.reason || "Admin refund").trim();

    // "instant"/"optimum" carry gateway fees, so don't take an arbitrary value
    // from the request body.
    const speed = ["normal", "optimum"].includes(String(req.body?.speed))
      ? String(req.body.speed)
      : "normal";

    // ── THE IDEMPOTENCY KEY ──────────────────────────────────────────────────
    // Supplied by the admin UI (generated once when the confirmation dialog
    // opens, so a double-click reuses the same key). Derived deterministically
    // when absent, which keeps every existing caller working unchanged.
    const suppliedKey = String(req.body?.idempotencyKey || "").trim();
    if (suppliedKey && !/^[A-Za-z0-9_:-]{8,120}$/.test(suppliedKey)) {
      return res.status(400).json({
        success: false,
        message: "Invalid refund idempotency key",
        code: "REFUND_KEY_INVALID",
      });
    }
    const idempotencyKey =
      suppliedKey ||
      deriveRefundIdempotencyKey({ orderId: order._id, amount: amountRupees, reason });

    // ── ATOMIC CLAIM ─────────────────────────────────────────────────────────
    // The cumulative ceiling AND the duplicate check both live in the filter of
    // one conditional $push, so of two concurrent requests exactly one can reach
    // the gateway.
    //
    // This replaced a read-then-act pair: `sumRefunded` was read into the
    // handler, compared against totalAmount, and only then pushed and saved.
    // Mongoose does not version-guard a subdocument-array $push, so both
    // requests saved and both went on to refund — a double-clicked button issued
    // two real refunds on one order, and the ceiling never noticed.
    let claim;
    try {
      claim = await claimRefundSlot({
        orderId: order._id,
        idempotencyKey,
        amount: amountRupees,
        record: {
          paymentProvider: "razorpay",
          providerPaymentId: order.razorpayPaymentId,
          reason,
          status: "created",
          confirmationMethod: "gateway",
          createdBy: req.user.id,
        },
      });
    } catch (error) {
      return res.status(error.statusCode || 400).json({
        success: false,
        message: error.message,
        code: error.code || "REFUND_CLAIM_FAILED",
      });
    }

    const pending = claim.refund;

    // Already settled by an earlier request with this key — nothing to do.
    if (!claim.created && pending.status === "processed") {
      return res.status(200).json({
        success: true,
        message: "This refund has already been processed",
        idempotent: true,
        order: claim.order,
      });
    }

    // ── SECOND CLAIM: THE GATEWAY CALL ITSELF ────────────────────────────────
    // Owning the ledger row is not permission to talk to Razorpay. Without this,
    // the request that lost the row would find it `created`, ask the gateway
    // whether that refund existed, be told "no" because the winner's call was
    // still in flight, and refund again on the strength of it.
    const mayCallGateway = await claimGatewayAttempt({
      orderId: order._id,
      refundId: pending._id,
    });
    if (!mayCallGateway) {
      return res.status(409).json({
        success: false,
        message:
          "A refund for this order is already being processed. Reload the order in a moment to see the result — do not retry, or the customer could be refunded twice.",
        code: "REFUND_IN_PROGRESS",
      });
    }

    // We adopted an existing row whose attempt had gone stale, so a previous
    // attempt may or may not have reached Razorpay. Ask before trying again —
    // "unknown" is not "didn't happen".
    if (!claim.created) {
      // Refunds already recorded on OTHER rows are not this row's. Without the
      // exclusion, a retry after a declined refund (same key, new row) would find
      // the old declined refund by its note and mark this row failed too.
      const excludeRefundIds = (claim.order?.refunds || [])
        .filter((row) => String(row._id) !== String(pending._id) && row.providerRefundId)
        .map((row) => String(row.providerRefundId));
      const gatewayRefund = await findGatewayRefundByNote({
        order: claim.order,
        noteKey: "refundKey",
        noteValue: idempotencyKey,
        label: `order ${order._id}`,
        excludeRefundIds,
      });
      if (gatewayRefund) {
        // Mapped, not assumed: `pending` is NOT `processed`. Treating every
        // non-failed reply as processed showed orders as Refunded before any
        // money had moved.
        const adoptedStatus = mapGatewayRefundStatus(gatewayRefund.status);
        const settled = await settleRefundRecord({
          orderId: order._id,
          refundId: pending._id,
          providerRefundId: gatewayRefund.id,
          status: adoptedStatus,
          ...(adoptedStatus === "failed"
            ? { failureReason: gatewayRefund.error_description || "Razorpay declined the refund" }
            : {}),
        });
        if (adoptedStatus === "failed") {
          // The earlier attempt reached Razorpay and was declined. The row is now
          // `failed`, which claimRefundSlot ignores, so retrying with the same
          // key records a fresh attempt rather than adopting this one again.
          return res.status(502).json({
            success: false,
            message:
              "Razorpay declined the earlier attempt at this refund, so no money has moved. You can retry the refund.",
            code: "GATEWAY_REFUND_REJECTED",
            order: settled,
          });
        }
        return res.status(200).json({
          success: true,
          message:
            adoptedStatus === "processed"
              ? "Refund reconciled against Razorpay — no second refund was issued"
              : "Refund already accepted by Razorpay — settles in 5–7 working days. No second refund was issued.",
          idempotent: true,
          adopted: true,
          ...(adoptedStatus === "created" ? { pending: true } : {}),
          order: settled,
        });
      }
      // Confirmed absent at the gateway, so reusing this record cannot double-pay.
    }

    const { razorpay } = getRazorpay();
    let refund;
    try {
      refund = await razorpay.payments.refund(order.razorpayPaymentId, {
        amount: Math.round(amountRupees * 100),
        speed,
        notes: {
          reason: reason.slice(0, 250),
          // The reconciliation key. Without it this path could not recover from a
          // lost response: the returns path matches on notes.returnNumber, but an
          // admin refund had no tag to look itself up by.
          refundKey: idempotencyKey,
        },
      });
    } catch (error) {
      await settleRefundRecord({
        orderId: order._id,
        refundId: pending._id,
        // Deliberately stays `created`, not `failed`: `failed` is excluded from
        // the ceiling and from the duplicate lookup, so recording an unknown
        // outcome as failed would let the next attempt skip reconciliation.
        status: "created",
        failureReason: getRazorpayErrorMessage(error),
        releaseAttempt: true,
      });
      return res.status(502).json({
        success: false,
        message: `Refund failed: ${getRazorpayErrorMessage(error)}. The attempt is recorded as pending — retrying will check with Razorpay first rather than refunding twice.`,
        code: "GATEWAY_REFUND_FAILED",
      });
    }

    // Positional update rather than order.save(): the claim wrote via the
    // collection, so saving this stale in-memory document could drop a refund row
    // a concurrent handler legitimately added.
    //
    // What Razorpay said, mapped: `processed` is settled, `failed` is declined,
    // and anything else (`pending` is the normal reply at speed "normal") is
    // accepted-but-unsettled and stays `created` until the refund webhook or the
    // refund-status poller settles it. Only a settled refund is "processed".
    const replyStatus = mapGatewayRefundStatus(refund.status);
    const orderId = order._id;
    const razorpayPaymentId = order.razorpayPaymentId;
    const settlement = await writeRefundSettlement({
      orderId,
      refundId: pending._id,
      providerRefundId: refund.id,
      status: replyStatus,
      ...(replyStatus === "failed"
        ? { failureReason: refund.error_description || "Razorpay declined the refund" }
        : {}),
    });
    order = settlement.order;
    // The refund webhook can land between Razorpay's reply and the write above
    // (it finds the row by notes.refundKey). It then settled the row and sent the
    // customer notice itself, and our guarded write matched nothing. Report what
    // the ROW says, and do not notify a second time.
    const settledElsewhere = !settlement.transitioned;
    const refundStatus = settledElsewhere
      ? order?.refunds?.id(pending._id)?.status || replyStatus
      : replyStatus;

    // Written for every outcome, including a decline: the admin did ask for money
    // to move, and the record of that request must not depend on the answer.
    const outcomeLabel = {
      processed: "Refunded",
      created: "Refund accepted by Razorpay (pending)",
      failed: "Refund declined by Razorpay",
    }[refundStatus];
    await createAuditLog({
      admin: req.user.id,
      action: "REFUND_PAYMENT",
      module: "PAYMENT",
      targetId: orderId,
      targetName: String(orderId),
      description: `${outcomeLabel} ₹${amountRupees} (${speed}) — ${String(req.body?.reason || "no reason given")}`,
      req,
    });

    if (refundStatus === "failed") {
      return res.status(502).json({
        success: false,
        message: `Razorpay declined this refund${
          refund.error_description ? `: ${refund.error_description}` : ""
        }. No money has moved — you can retry the refund.`,
        code: "GATEWAY_REFUND_REJECTED",
        refund,
        order,
      });
    }

    if (refundStatus === "created") {
      if (!settledElsewhere) await notifyRefundInitiated({ orderId, paymentId: razorpayPaymentId });
      return res.status(200).json({
        success: true,
        pending: true,
        message: "Refund accepted by Razorpay — settles in 5–7 working days",
        refund,
        order,
      });
    }

    if (!settledElsewhere) await notifyRefundProcessed({ orderId, paymentId: razorpayPaymentId });

    return res.status(200).json({
      success: true,
      message: "Refund processed",
      refund,
      order,
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      success: false,
      message: getRazorpayErrorMessage(error),
    });
  }
};

export const RazorpayWebhook = async (req, res) => {
  // Tracked at handler scope so the catch block can release the replay claim.
  let claimedEventId = null;
  const { payments } = getFeatures();
  if (!isPaymentEnabled() || !payments.razorpayWebhookEnabled) {
    return res.status(200).json({ success: true, message: "Razorpay webhook disabled" });
  }

  try {
    const secret = String(process.env.RAZORPAY_WEBHOOK_SECRET || "").trim();
    const signature = req.get("x-razorpay-signature");
    if (!secret || !signature) {
      return res.status(401).json({ success: false, message: "Webhook signature is required" });
    }

    const body = req.rawBody || JSON.stringify(req.body || {});
    if (!isValidWebhookSignature({ body, signature, secret })) {
      return res.status(401).json({ success: false, message: "Invalid webhook signature" });
    }

    const event = req.body?.event;
    const payment = req.body?.payload?.payment?.entity;

    // ─── REPLAY GUARD ───────────────────────────────────────────────────────
    // Claim the event id before doing any work. Razorpay retries deliveries and
    // does not guarantee ordering, and nothing was stored here previously — so a
    // replay could reopen a completed intent and lead to a second charge. The
    // unique index does the real work; two concurrent deliveries race and only
    // one wins. The claim is released in the catch block so a genuine
    // processing failure can still be retried by Razorpay.
    const eventId = req.get("x-razorpay-event-id") || "";
    if (eventId) {
      try {
        await WebhookEvent.create({ provider: "razorpay", eventId, eventType: event || "" });
      } catch (error) {
        if (error?.code === 11000) {
          return res
            .status(200)
            .json({ success: true, message: "Duplicate event ignored", duplicate: true });
        }
        throw error;
      }
      claimedEventId = eventId;
    }

    if (event === "payment.captured" && payment?.order_id && payment?.id) {
      const intent = await PaymentIntent.findOne({
        $or: [
          { razorpayOrderId: payment.order_id },
          { previousRazorpayOrderIds: payment.order_id },
        ],
      });

      // ── NO INTENT: AN UNMATCHED CAPTURED PAYMENT ──────────────────────────
      // This used to fall straight through to `return 200` — reporting success
      // for a captured payment that was silently dropped. Reachable whenever the
      // intent has passed its retention TTL, or the capture belongs to a
      // Razorpay order this system never issued.
      //
      // Money has moved, so it is recorded and refunded rather than ignored.
      if (!intent) {
        const outcome = await refundOrphanedCapture({
          paymentId: payment.id,
          amount: Number(payment.amount),
          currency: payment.currency || "INR",
          providerOrderId: payment.order_id,
          reason: "No payment session exists for this captured payment",
        });
        if (!outcome.refunded && !outcome.alreadyHandled) {
          // Recorded but not yet returned — keep the event retryable rather than
          // claiming success. The row is visible in admin System Health meanwhile.
          if (claimedEventId) {
            await WebhookEvent.deleteOne({
              provider: "razorpay",
              eventId: claimedEventId,
            }).catch(() => {});
          }
          return res.status(500).json({
            success: false,
            message: "Captured payment recorded as unmatched; refund not yet confirmed",
            code: "UNMATCHED_PAYMENT_REFUND_PENDING",
          });
        }
        return res.status(200).json({
          success: true,
          message: "Captured payment had no order and has been refunded",
          code: "UNMATCHED_PAYMENT_REFUNDED",
        });
      }

      if (intent.status !== "completed") {
        // Verify the paid amount here too. The verify endpoint checks this, but
        // the webhook previously fabricated the payment object and dropped the
        // amount entirely — the more trusted path was doing less checking.
        if (Number(payment.amount) !== Number(intent.amount)) {
          // Release the claim: we did NOT process this event. Holding it would
          // make Razorpay's retry come back as "duplicate ignored" — reporting
          // success for an event that was rejected.
          if (claimedEventId) {
            await WebhookEvent.deleteOne({
              provider: "razorpay",
              eventId: claimedEventId,
            }).catch(() => {});
          }
          console.error(
            `Razorpay webhook amount mismatch: order=${payment.order_id} webhook=${payment.amount} intent=${intent.amount}`,
          );
          return res.status(400).json({
            success: false,
            message: "Webhook payment amount does not match the checkout amount",
          });
        }

        // ── PROMOTION FAILURE: COMPENSATE, DON'T RESURRECT ──────────────────
        // The browser-verify path has always auto-refunded a capture it could not
        // turn into an order. This path did not: it answered 5xx, Razorpay
        // retried into the identical failure, and after the retries were
        // exhausted the money simply stayed with no order and no refund.
        //
        // The most likely trigger is ordinary: the abandoned-checkout sweeper
        // moves an unpaid order to Cancelled/Failed 20 minutes after checkout
        // starts, and the promotion is a compare-and-swap on
        // `paymentStatus: "Pending"` — so any capture after that window can never
        // match. A slow netbanking or UPI-collect payment does exactly this.
        try {
          await completeCapturedIntent({
            intent,
            capturedPayment: { id: payment.id, status: "captured" },
          });
        } catch (error) {
          if (!isUnrecoverableCapture(error)) throw error; // transient → 5xx → retry

          const outcome = await refundOrphanedCapture({
            paymentId: payment.id,
            amount: Number(payment.amount),
            currency: payment.currency || "INR",
            providerOrderId: payment.order_id,
            paymentIntentId: intent._id,
            orderId: intent.pendingOrder || intent.storeOrder || null,
            userId: intent.user || null,
            reason: error.message,
          });

          // Mark the intent so it is never retried into the same dead end, and so
          // the state is readable afterwards. Status-filtered so a concurrent
          // verify that genuinely completed is never overwritten.
          await PaymentIntent.findOneAndUpdate(
            { _id: intent._id, status: { $in: ["created", "processing", "failed"] } },
            {
              status: outcome.refunded ? "refunded" : "failed",
              failureReason: error.message,
            },
          );

          if (!outcome.refunded && !outcome.alreadyHandled) {
            if (claimedEventId) {
              await WebhookEvent.deleteOne({
                provider: "razorpay",
                eventId: claimedEventId,
              }).catch(() => {});
            }
            return res.status(500).json({
              success: false,
              message: "Captured payment recorded as unmatched; refund not yet confirmed",
              code: "UNMATCHED_PAYMENT_REFUND_PENDING",
            });
          }

          // "Processed" only when Razorpay said so. A normal-speed refund replies
          // `pending` (and an earlier delivery's outcome is not re-read here), so
          // anything else is announced as initiated.
          await (outcome.gatewayStatus === "processed" ? notifyRefundProcessed : notifyRefundInitiated)({
            orderId: intent.pendingOrder || null,
            paymentId: payment.id,
          }).catch(() => {});

          return res.status(200).json({
            success: true,
            message: "Order could no longer be completed; the payment has been refunded",
            code: "CAPTURE_REFUNDED_ORDER_NOT_PROMOTABLE",
          });
        }
      }
    }

    if (event === "payment.failed" && payment?.order_id) {
      // The status filter is the fix for a double-CHARGE chain. Razorpay allows
      // several attempts against one order and does not guarantee delivery
      // order, so a late or replayed payment.failed used to flip an ALREADY
      // COMPLETED intent back to "failed" (this update had no filter at all).
      // From there RetryRazorpayOrder would accept it, reset it to "created",
      // and a subsequent verify would build a SECOND order for the same
      // checkout — billing the customer twice. Only a still-open attempt may be
      // marked failed.
      const failed = await PaymentIntent.findOneAndUpdate(
        {
          razorpayOrderId: payment.order_id,
          status: { $in: ["created", "processing"] },
        },
        { status: "failed", failureReason: payment.error_description || "Payment failed" },
        { returnDocument: "after" },
      );

      //
      // Matched on the CURRENT razorpayOrderId only, never on
      // previousRazorpayOrderIds. A failure on a superseded Razorpay order is about
      // an attempt the customer has already moved on from; matching it would mark
      // the live retry failed and release the stock it is holding while the
      // customer is still paying for it.
      if (failed) {
        await releaseReservation({ paymentIntentId: failed._id, reason: "payment_failed" });
        // pendingOrder first: order-first checkouts carry the order the customer
        // was shown there, and storeOrder is never set on an attempt that failed.
        await notifyPaymentFailed({
          orderId: failed.pendingOrder || failed.storeOrder || null,
          reason: "Payment failed",
        });
      } else {
        // Nothing matched: the intent was already completed or refunded, so this
        // is a stale/duplicate event, or the failure belongs to a superseded
        // Razorpay order. Ignoring it also stops the customer being told their
        // successful payment failed. Read-only check, logged so a superseded-id
        // failure is distinguishable from a genuinely unknown one.
        const superseded = await PaymentIntent.exists({
          previousRazorpayOrderIds: payment.order_id,
        });
        if (superseded) {
          logLifecycleEvent("payments", "payment_failed_on_superseded_order", {
            paymentIntentId: String(superseded._id),
            razorpayOrderId: payment.order_id,
            paymentId: payment.id || "",
          });
        }
      }
    }

    // ─── REFUND EVENTS ──────────────────────────────────────────────────────
    // Razorpay refunds at speed "normal" commonly return `pending` and settle
    // asynchronously, and can subsequently fail. Without these handlers a
    // gateway-failed refund stayed "processed" in our ledger forever with the
    // customer already notified — the exact "says refunded but isn't" failure
    // this system is built to avoid.
    //
    // The resolution lives in applyRazorpayRefundWebhook: it finds the ledger row
    // by refund id (or by payment id plus the refund's notes when the row never
    // learned its id), moves it with a compare-and-swap so a replayed or
    // out-of-order event cannot regress a settled row, recomputes paymentStatus,
    // and notifies only on the write that actually changed something. A refund
    // with no order behind it (an orphaned-capture refund) marks its
    // unmatchedpayments row failed instead. Errors propagate to the 5xx below so
    // Razorpay retries.
    if (event === "refund.processed" || event === "refund.failed") {
      const refundEntity = req.body?.payload?.refund?.entity;
      if (refundEntity?.id) {
        await applyRazorpayRefundWebhook({ event, refundEntity });
      }
    }

    return res.status(200).json({ success: true });
  } catch (error) {
    // Release the event claim so Razorpay's retry can reprocess this event —
    // otherwise the replay guard would swallow the retry of an event that never
    // actually completed.
    if (claimedEventId) {
      await WebhookEvent.deleteOne({ provider: "razorpay", eventId: claimedEventId }).catch(() => {});
    }

    // Answer 5xx, NOT 200. The handler used to swallow every error as a success,
    // so Razorpay recorded delivery and never retried — meaning a transient DB
    // failure mid-processing silently lost a real payment event forever.
    console.error("Razorpay webhook processing failed:", error?.message);
    return res.status(500).json({
      success: false,
      message: "Webhook processing failed; please retry this event",
    });
  }
};
