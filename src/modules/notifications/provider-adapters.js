/**
 * SMS / WhatsApp / phone adapters for the notification queue.
 *
 * ALL THREE ARE DELIBERATE NO-OPS. Nothing here reaches a customer: email
 * (order-emails.js) is the only channel this codebase actually delivers on.
 * Real sending needs a vendor account, DLT registration (Indian SMS) and
 * approved WhatsApp templates, none of which exist yet — so an adapter that
 * pretended otherwise would only hide the gap.
 *
 * What a real adapter must implement, to slot into `adapters` below:
 *
 *   async ({ channel, event, payload }) => ({ provider, status, response })
 *
 *   - `event` is the queue event name ("order.placed", "shipment.updated",
 *     "refund.initiated", "refund.processed", "order.cancelled", ...). Map each
 *     one to an approved template id; an event with no template should
 *     resolve `{ status: "skipped" }` rather than send free text (DLT rejects
 *     unregistered content).
 *   - `payload` carries `order` or `orderId`, `userId`, `phone`, `message`,
 *     `status`, `paymentId`. The phone comes from the order's shipping
 *     address; normalise it to E.164 (+91…) before sending.
 *   - Resolve `{ provider: "<vendor>", status: "queued" | "sent", response }`
 *     with the vendor's message id in `response`, so the NotificationEvent row
 *     is traceable. Throw (reject) on a vendor error — queueNotification
 *     records the row as "failed" with the message — but never throw for a
 *     missing phone; resolve `skipped` instead.
 *   - Bound every vendor call with a timeout (a few seconds): callers await
 *     queueNotification, so a hung vendor would stall the order action.
 *   - Never log the phone number or message body in full, and keep vendor
 *     credentials in env vars, never in this file.
 */
const noopSend = async ({ channel }) => ({
  provider: "noop",
  status: "queued",
  response: {
    channel,
    message: "Provider integration is not enabled",
  },
});

const adapters = {
  sms: noopSend,
  whatsapp: noopSend,
  phone: noopSend,
};

export const sendNotificationChannel = async ({ channel, event, payload }) => {
  const adapter = adapters[channel] || noopSend;
  return adapter({ channel, event, payload });
};
