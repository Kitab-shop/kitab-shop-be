import { sendMail } from "../../utils/mailer.js";

/**
 * Customer-facing lifecycle emails: order placed (the confirmation), plus the
 * three end-states an admin can trigger — cancelled, completed (delivered and
 * signed off) and closed (an RTO case settled). The notification-service queue reaches no real channel (all
 * provider adapters are stubs), so email — the one transport this codebase
 * actually sends (verification, password reset, COD OTP) — is what makes
 * "notify the customer" true.
 *
 * Every sender is fire-and-forget at the call site: a mail failure must never
 * fail the order action it narrates.
 */

const wrap = (title, bodyHtml) => `<!doctype html>
<html>
  <head><meta charset="utf-8" /><title>${title}</title></head>
  <body style="margin:0;padding:0;background:#f9f9f9;font-family:Arial,sans-serif;">
    <div style="max-width:600px;margin:0 auto;padding:24px;background:#ffffff;color:#333;border:1px solid #eee;border-radius:8px;">
      <h1 style="font-size:20px;text-align:center;margin-bottom:20px;">${title}</h1>
      ${bodyHtml}
      <p style="font-size:12px;color:#999;text-align:center;margin-top:28px;">
        Rivermoss Books — this is an automated update about your order.
      </p>
    </div>
  </body>
</html>`;

const sendOrderEmail = async ({ email, subject, title, bodyHtml, text }) => {
  if (!email) return;
  await sendMail({ to: email, subject, text, html: wrap(title, bodyHtml) });
};

const orderRef = (order) => `#${String(order._id)}`;

const money = (value) => `\u20B9${Number(value || 0).toLocaleString("en-IN")}`;

/** The line items, as a table. Falls back gracefully on an order with none. */
const itemsTable = (order) => {
  const items = Array.isArray(order?.items) ? order.items : [];
  if (items.length === 0) return "";

  const rows = items
    .map((item) => {
      // `author` is snapshotted onto the line at placement, so this renders what
      // was sold even if the book is later renamed or re-attributed.
      const byline = item.author ? `<br><span style="color:#888;font-size:13px;">${item.author}</span>` : "";
      return `
      <tr>
        <td style="padding:8px 0;border-bottom:1px solid #eee;font-size:14px;">${item.name || "Item"}${byline}</td>
        <td style="padding:8px 0;border-bottom:1px solid #eee;font-size:14px;text-align:center;">${item.quantity || 1}</td>
        <td style="padding:8px 0;border-bottom:1px solid #eee;font-size:14px;text-align:right;">${money((item.price || 0) * (item.quantity || 1))}</td>
      </tr>`;
    })
    .join("");

  return `
    <table style="width:100%;border-collapse:collapse;margin:20px 0;">
      <thead>
        <tr>
          <th style="text-align:left;padding-bottom:8px;font-size:12px;color:#888;text-transform:uppercase;">Item</th>
          <th style="text-align:center;padding-bottom:8px;font-size:12px;color:#888;text-transform:uppercase;">Qty</th>
          <th style="text-align:right;padding-bottom:8px;font-size:12px;color:#888;text-transform:uppercase;">Total</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
};

/**
 * The order confirmation — the one email a shop cannot do without.
 *
 * Until now nothing was sent when an order was placed. notifyOrderPlaced()
 * routes into the notification queue, whose only channels are sms/whatsapp/phone
 * and whose providers are all no-op stubs — so a customer paid and heard
 * nothing at all, which is how support tickets and chargebacks start.
 *
 * Sent for both paths: prepaid (after the payment is verified and the order
 * exists) and COD (at placement). The COD copy says what to have ready.
 */
export const sendOrderPlacedEmail = async ({ order, email }) => {
  const isCod = String(order?.paymentMethod || "").toUpperCase() === "COD";
  const total = money(order?.totalAmount);

  const paymentLine = isCod
    ? `<p style="font-size:15px;color:#555;">Payment: <strong>Cash on Delivery</strong>. Please have ${total} ready for the courier.</p>`
    : `<p style="font-size:15px;color:#555;">Payment of <strong>${total}</strong> received. Thank you.</p>`;

  await sendOrderEmail({
    email,
    subject: `Order confirmed ${orderRef(order)}`,
    title: "Thank you for your order",
    text: [
      `Thank you for your order.`,
      ``,
      `Order: ${orderRef(order)}`,
      `Total: ${total}`,
      isCod
        ? `Payment: Cash on Delivery — please have ${total} ready for the courier.`
        : `Payment received.`,
      ``,
      `We will email you again with tracking as soon as it ships.`,
    ].join("\n"),
    bodyHtml: `
      <p style="font-size:15px;color:#555;">We have your order <strong>${orderRef(order)}</strong> and are getting it ready.</p>
      ${itemsTable(order)}
      <p style="font-size:16px;color:#333;"><strong>Total: ${total}</strong></p>
      ${paymentLine}
      <p style="font-size:15px;color:#555;">We will email you again with tracking as soon as it ships.</p>`,
  });
};

export const sendOrderCancelledEmail = async ({ order, email, reason, source, autoRefund }) => {
  const by = source === "admin" ? "by the store" : "at your request";
  const refundLine =
    Number(order.totalAmount) > 0 &&
    ["Paid", "Refund Pending", "Partially Refunded"].includes(order.paymentStatus)
      ? autoRefund
        ? "Your payment is being refunded to your original payment method — it typically arrives within 5–7 business days."
        : "Any amount you paid will be refunded — our team will contact you if payout details are needed."
      : "No payment had been collected for this order, so there is nothing to refund.";

  await sendOrderEmail({
    email,
    subject: `Your order ${orderRef(order)} has been cancelled`,
    title: "Order cancelled",
    text: `Your order ${orderRef(order)} was cancelled ${by}.${reason ? ` Reason: ${reason}.` : ""} ${refundLine}`,
    bodyHtml: `
      <p style="font-size:15px;color:#555;">Your order <strong>${orderRef(order)}</strong> was cancelled ${by}.</p>
      ${reason ? `<p style="font-size:15px;color:#555;"><strong>Reason:</strong> ${reason}</p>` : ""}
      <p style="font-size:15px;color:#555;">${refundLine}</p>`,
  });
};

export const sendOrderCompletedEmail = async ({ order, email }) => {
  await sendOrderEmail({
    email,
    subject: `Your order ${orderRef(order)} is complete`,
    title: "Order completed",
    text: `Your order ${orderRef(order)} has been completed successfully. Thank you for shopping with us!`,
    bodyHtml: `
      <p style="font-size:15px;color:#555;">Your order <strong>${orderRef(order)}</strong> has been completed successfully.</p>
      <p style="font-size:15px;color:#555;">Thank you for shopping with us — we hope to see you again soon!</p>`,
  });
};

export const sendOrderClosedEmail = async ({ order, email }) => {
  await sendOrderEmail({
    email,
    subject: `Your returned order ${orderRef(order)} is settled`,
    title: "Returned order settled",
    // Deliberately NOT "completed": Closed means the parcel came back to us
    // and the case (including any refund owed) has been settled.
    text: `Your order ${orderRef(order)} that was returned to us has been settled. Any refund owed is handled separately and you will see it reflected on the order.`,
    bodyHtml: `
      <p style="font-size:15px;color:#555;">Your order <strong>${orderRef(order)}</strong> that was returned to us has now been settled.</p>
      <p style="font-size:15px;color:#555;">If a refund is owed for this order, it is handled separately — you can check its status on the order page.</p>`,
  });
};
