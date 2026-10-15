import { getFeatures } from "../../config/features.config.js";
import NotificationEvent from "../../model/NotificationEvent.model.js";
import { sendNotificationChannel } from "./provider-adapters.js";
import { logLifecycleEvent, logLifecycleError } from "../../utils/lifecycle-logger.service.js";

const enabledChannels = () => {
  const { notifications } = getFeatures();
  if (!notifications.enabled) return [];

  return [
    notifications.sms ? "sms" : null,
    notifications.whatsapp ? "whatsapp" : null,
    notifications.phone ? "phone" : null,
  ].filter(Boolean);
};

const queueNotification = async (event, payload) => {
  const channels = enabledChannels();
  if (channels.length === 0) {
    await NotificationEvent.create({
      event,
      channels: [],
      status: "skipped",
      order: payload?.order?._id || payload?.orderId || null,
      user: payload?.order?.user?._id || payload?.order?.user || payload?.userId || null,
      phone: payload?.order?.shippingAddress?.phone || payload?.phone || "",
      email: payload?.order?.user?.email || payload?.email || "",
      message: "Notifications disabled by configuration",
    }).catch(() => {});
    return { queued: false, channels: [] };
  }

  const providerResults = await Promise.allSettled(
    channels.map((channel) =>
      sendNotificationChannel({ channel, event, payload }),
    ),
  );
  const failed = providerResults.filter((result) => result.status === "rejected");
  const firstResult = providerResults.find((result) => result.status === "fulfilled")?.value;

  await NotificationEvent.create({
    event,
    channels,
    orderId: payload?.order?._id || payload?.orderId || null,
    order: payload?.order?._id || payload?.orderId || null,
    user: payload?.order?.user?._id || payload?.order?.user || payload?.userId || null,
    phone: payload?.order?.shippingAddress?.phone || payload?.phone || "",
    email: payload?.order?.user?.email || payload?.email || "",
    status: failed.length > 0 ? "failed" : "queued",
    message: payload?.message || "",
    provider: firstResult?.provider || "noop",
    providerResponse: providerResults.map((result) =>
      result.status === "fulfilled" ? result.value : { error: result.reason?.message || String(result.reason) },
    ),
    error: failed.map((result) => result.reason?.message || String(result.reason)).join("; "),
  }).catch((error) => {
    logLifecycleError("notification", "record_failed", error, { event });
  });

  logLifecycleEvent("notification", failed.length > 0 ? "queued_with_failures" : "queued", {
    event,
    channels,
  });

  return { queued: true, channels };
};

export const notifyOrderPlaced = (order) =>
  queueNotification("order.placed", { order });

export const notifyPaymentSuccess = (order) =>
  queueNotification("payment.success", { order });

export const notifyPaymentFailed = ({ orderId, reason }) =>
  queueNotification("payment.failed", { orderId, reason });

/**
 * Fire an email without awaiting it. The promise is detached and every
 * failure swallowed, so a slow or broken SMTP server can neither delay nor
 * fail the order action that triggered the notification.
 *
 * order-emails.js is loaded lazily, on the first email, on purpose: it pulls in
 * the mailer, whose module-level `dotenv.config()` re-reads .env. Importing it
 * statically here would run that in every module that imports this service
 * (returns, shipping, cart) — re-injecting variables a caller had deliberately
 * removed, as the regression helpers do with SHIPROCKET_*. It also keeps this
 * file free of any import cycle with order-emails.js and the models.
 */
const fireEmail = (send) => {
  import("./order-emails.js")
    .then(send)
    .catch((error) => logLifecycleError("notification", "email_failed", error));
};

// Only these shipment statuses have a customer email; the rest are tracked on
// the order page and in the queue row.
const SHIPMENT_EMAIL_STATUSES = new Set(["Shipped", "Delivered"]);

export const notifyShipmentUpdated = ({ orderId, status }) => {
  if (orderId && SHIPMENT_EMAIL_STATUSES.has(status)) {
    fireEmail((emails) => emails.sendShipmentStatusEmail({ orderId, status }));
  }
  return queueNotification("shipment.updated", { orderId, status });
};

// Callers invoke this only once the gateway (or an admin, for a manual payout)
// has confirmed the money moved — a `pending` gateway reply goes to
// notifyRefundInitiated instead — so the email can say "processed".
export const notifyRefundProcessed = ({ orderId, paymentId }) => {
  if (orderId) fireEmail((emails) => emails.sendRefundProcessedEmail({ orderId }));
  return queueNotification("refund.processed", { orderId, paymentId });
};

/**
 * The gateway accepted a refund but has not settled it yet (Razorpay replied
 * `pending`, or anything else that is not `processed`/`failed`). The customer
 * is told the refund is on its way — never that it has been processed. The
 * poller / webhook sends notifyRefundProcessed once the gateway settles it.
 */
export const notifyRefundInitiated = ({ orderId, paymentId }) =>
  queueNotification("refund.initiated", {
    orderId,
    paymentId,
    message: "Refund initiated; your bank may take 5–7 working days",
  });

export const notifyReturnUpdated = ({ orderId, userId, status }) =>
  queueNotification("return.updated", {
    orderId,
    userId,
    message: `Return status updated to ${status}`,
  });

// "system" is the abandoned-checkout sweeper: nobody chose to cancel, the
// payment window simply ran out.
const cancelledMessage = (source) =>
  source === "system"
    ? "Order cancelled automatically — payment was not completed in time"
    : `Order cancelled by ${source || "customer"}`;

export const notifyOrderCancelled = ({ orderId, userId, reason, source }) =>
  queueNotification("order.cancelled", {
    orderId,
    userId,
    message: `${cancelledMessage(source)}${reason ? ` — ${reason}` : ""}`,
  });

// The success sign-off (Delivered → Completed). Distinct from order.closed,
// which is an RTO case being settled.
export const notifyOrderCompleted = ({ orderId, userId }) =>
  queueNotification("order.completed", {
    orderId,
    userId,
    message: "Order completed successfully",
  });

export const notifyOrderClosed = ({ orderId, userId }) =>
  queueNotification("order.closed", {
    orderId,
    userId,
    message: "Returned order settled",
  });

export const notifyAbandonedCart = ({ userId, email, phone }) =>
  queueNotification("cart.abandoned", {
    userId,
    email,
    phone,
    message: "Cart recovery reminder",
  });
