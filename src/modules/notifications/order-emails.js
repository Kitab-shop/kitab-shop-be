import { sendMail } from "../../utils/mailer.js";
import OrderModel from "../orders/Order.model.js";
import ProductModel from "../products/Product.model.js";
import UserModel from "../../model/User.model.js";

/**
 * Customer-facing lifecycle emails: order placed (the confirmation), shipped,
 * delivered, refund processed, plus the three end-states — cancelled,
 * completed (delivered and signed off) and closed (an RTO case settled). The
 * notification-service queue reaches no real channel (all provider adapters
 * are stubs), so email — the one transport this codebase actually sends
 * (verification, password reset, COD OTP) — is what makes "notify the
 * customer" true.
 *
 * Every sender is fire-and-forget at the call site: a mail failure must never
 * fail the order action it narrates.
 *
 * Imports only models and the mailer — never notification.service.js, which
 * imports THIS file. Keep it that way, or the two modules form a cycle.
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

// Courier names and AWBs are typed by an admin (manual shipments) or come from
// a courier API, so they are escaped before going into HTML.
const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);

const frontendOrigin = () =>
  String(process.env.FRONTEND_URL || "http://localhost:5173").replace(/\/+$/, "");

const orderLink = (order) => `${frontendOrigin()}/account/orders/${String(order._id)}`;

const orderLinkHtml = (order) =>
  `<p style="font-size:15px;color:#555;"><a href="${esc(orderLink(order))}" style="color:#2a6f4e;">View your order</a></p>`;

/**
 * The customer's email for an order. Best-effort: the account's address, then
 * the legacy guest-checkout address; "" when neither exists or the lookup
 * fails, and every sender no-ops on "".
 *
 * Accepts an order whose `user` is populated or a bare id.
 */
export const customerEmailForOrder = async (order) => {
  try {
    if (!order) return "";
    const populated = order.user && typeof order.user === "object" && order.user.email;
    if (populated) return String(order.user.email);
    if (order.user) {
      const userId = order.user?._id || order.user;
      const customer = await UserModel.findById(userId).select("email").lean();
      if (customer?.email) return customer.email;
    }
    return order.guestEmail || "";
  } catch {
    return "";
  }
};

/** Default return window when a product predates returnPolicy (return.controller.js). */
export const DEFAULT_RETURN_WINDOW_DAYS = 7;

/**
 * productId → returnPolicy, for a set of products in one query. Missing
 * products are simply absent from the map.
 */
export const loadReturnPolicies = async (productIds) => {
  const ids = [...new Set((productIds || []).filter(Boolean).map(String))];
  if (ids.length === 0) return new Map();
  const products = await ProductModel.find({ _id: { $in: ids } }).select("returnPolicy").lean();
  return new Map(products.map((product) => [String(product._id), product.returnPolicy || null]));
};

/**
 * How many days after delivery this order can still be returned: the longest
 * window over its lines. Same fallbacks as RequestReturn (return.controller.js):
 * kind "none" → 0, a deleted product → 7, otherwise `windowDays || 7`.
 *
 * Shared by the delivered email (which promises the window) and the
 * auto-complete sweep (which waits it out), so the two can never disagree.
 */
export const orderReturnWindowDays = (order, policies) => {
  const items = Array.isArray(order?.items) ? order.items : [];
  let longest = 0;
  for (const item of items) {
    const key = String(item?.product?._id || item?.product || "");
    let days;
    if (!policies.has(key)) {
      days = DEFAULT_RETURN_WINDOW_DAYS;
    } else {
      const policy = policies.get(key);
      const kind = policy?.kind || "return";
      days = kind === "none" ? 0 : Number(policy?.windowDays) || DEFAULT_RETURN_WINDOW_DAYS;
    }
    if (days > longest) longest = days;
  }
  return longest;
};

/** The order with what the shipped/delivered copy needs, or null. */
const loadOrderForEmail = (orderId) =>
  OrderModel.findById(orderId)
    .select("user guestEmail items orderStatus shipment shiprocket refunds totalAmount paymentMethod deliveredAt")
    .lean();

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
  // Under ORDER_MANUAL_CONFIRMATION_ENABLED the order is still Pending here, and
  // "Order confirmed" would be untrue until an admin approves it — which sends
  // sendOrderConfirmedEmail below.
  const awaitingApproval = order?.orderStatus === "Pending";

  const paymentLine = isCod
    ? `<p style="font-size:15px;color:#555;">Payment: <strong>Cash on Delivery</strong>. Please have ${total} ready for the courier.</p>`
    : `<p style="font-size:15px;color:#555;">Payment of <strong>${total}</strong> received. Thank you.</p>`;

  await sendOrderEmail({
    email,
    subject: awaitingApproval ? `Order received ${orderRef(order)}` : `Order confirmed ${orderRef(order)}`,
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
      awaitingApproval
        ? `We will email you as soon as the store confirms it, and again with tracking when it ships.`
        : `We will email you again with tracking as soon as it ships.`,
    ].join("\n"),
    bodyHtml: `
      <p style="font-size:15px;color:#555;">${
        awaitingApproval
          ? `We have received your order <strong>${orderRef(order)}</strong>. The store will confirm it shortly.`
          : `We have your order <strong>${orderRef(order)}</strong> and are getting it ready.`
      }</p>
      ${itemsTable(order)}
      <p style="font-size:16px;color:#333;"><strong>Total: ${total}</strong></p>
      ${paymentLine}
      <p style="font-size:15px;color:#555;">We will email you again with tracking as soon as it ships.</p>`,
  });
};

/**
 * Sent when an admin approves an order that ORDER_MANUAL_CONFIRMATION_ENABLED held
 * at Pending. The placed email for such an order said "received", not "confirmed",
 * so this is the customer's first word that it is going ahead.
 */
export const sendOrderConfirmedEmail = async ({ order, email }) => {
  await sendOrderEmail({
    email,
    subject: `Order confirmed ${orderRef(order)}`,
    title: "Your order is confirmed",
    text: `Your order ${orderRef(order)} has been confirmed and is being prepared. We will email you again with tracking as soon as it ships.`,
    bodyHtml: `
      <p style="font-size:15px;color:#555;">Your order <strong>${orderRef(order)}</strong> has been confirmed and is being prepared.</p>
      ${itemsTable(order)}
      <p style="font-size:15px;color:#555;">We will email you again with tracking as soon as it ships.</p>
      ${orderLinkHtml(order)}`,
  });
};

// Who cancelled, in words. "system" is the abandoned-checkout sweeper closing a
// prepaid order whose payment never completed — neither the customer nor the
// store decided it.
const cancelledByPhrase = (source) => {
  if (source === "admin") return "by the store";
  if (source === "system") return "automatically, because payment was not completed in time";
  return "at your request";
};

export const sendOrderCancelledEmail = async ({ order, email, reason, source, autoRefund }) => {
  const by = cancelledByPhrase(source);
  // Every state in which money was collected (MONEY_COLLECTED_PAYMENT_STATUSES).
  // "Refunded" included: a refund that settled before this email was built still
  // means the customer paid — telling them nothing was collected would be false.
  const refundLine =
    Number(order.totalAmount) > 0 &&
    ["Paid", "Refund Pending", "Partially Refunded", "Refunded"].includes(order.paymentStatus)
      ? autoRefund
        ? order.paymentStatus === "Refunded"
          ? "Your payment has been refunded to your original payment method."
          : "Your payment is being refunded to your original payment method — it typically arrives within 5–7 business days."
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

/** Courier and AWB, from the provider-neutral mirror first, then Shiprocket. */
const courierDetails = (order) => ({
  courier: order?.shipment?.carrierName || order?.shiprocket?.courierName || "",
  awb: order?.shipment?.trackingNumber || order?.shiprocket?.awbCode || "",
});

/**
 * "Your order has shipped", with the courier and AWB when one is recorded.
 * `email` is optional — resolved from the order when omitted.
 */
export const sendOrderShippedEmail = async ({ order, email }) => {
  if (!order) return;
  const to = email ?? (await customerEmailForOrder(order));
  const { courier, awb } = courierDetails(order);
  const trackingText = [courier ? `Courier: ${courier}` : "", awb ? `Tracking number (AWB): ${awb}` : ""]
    .filter(Boolean)
    .join("\n");
  const trackingHtml = courier || awb
    ? `<p style="font-size:15px;color:#555;">${courier ? `Courier: <strong>${esc(courier)}</strong><br>` : ""}${awb ? `Tracking number (AWB): <strong>${esc(awb)}</strong>` : ""}</p>`
    : "";

  await sendOrderEmail({
    email: to,
    subject: `Your order ${orderRef(order)} has shipped`,
    title: "Your order is on its way",
    text: [
      `Your order ${orderRef(order)} has shipped.`,
      ...(trackingText ? [trackingText] : []),
      ``,
      `Track it here: ${orderLink(order)}`,
    ].join("\n"),
    bodyHtml: `
      <p style="font-size:15px;color:#555;">Your order <strong>${orderRef(order)}</strong> has been handed to the courier.</p>
      ${trackingHtml}
      ${orderLinkHtml(order)}`,
  });
};

/**
 * "Your order was delivered", stating how long returns stay open. `windowDays`
 * is computed from the products' return policies when not supplied.
 */
export const sendOrderDeliveredEmail = async ({ order, email, windowDays }) => {
  if (!order) return;
  const to = email ?? (await customerEmailForOrder(order));
  const days = Number.isFinite(windowDays)
    ? windowDays
    : orderReturnWindowDays(order, await loadReturnPolicies((order.items || []).map((item) => item.product)));
  const returnLine = days > 0
    ? `Returns are open for ${days} day${days === 1 ? "" : "s"} from delivery, from your order page.`
    : "The items in this order are not eligible for return.";

  await sendOrderEmail({
    email: to,
    subject: `Your order ${orderRef(order)} has been delivered`,
    title: "Order delivered",
    text: [
      `Your order ${orderRef(order)} has been delivered.`,
      returnLine,
      ``,
      `Your order: ${orderLink(order)}`,
    ].join("\n"),
    bodyHtml: `
      <p style="font-size:15px;color:#555;">Your order <strong>${orderRef(order)}</strong> has been delivered. We hope you enjoy it!</p>
      <p style="font-size:15px;color:#555;">${returnLine}</p>
      ${orderLinkHtml(order)}`,
  });
};

const SHIPMENT_STATUS_EMAILS = {
  Shipped: sendOrderShippedEmail,
  Delivered: sendOrderDeliveredEmail,
};

/**
 * The email for a shipment status change, if that status has one (only
 * Shipped and Delivered do — the others are tracked on the order page).
 * Reads the order fresh, so a courier/AWB recorded in the same request is in
 * the copy. Never throws: returns true when a send was attempted.
 */
export const sendShipmentStatusEmail = async ({ orderId, status }) => {
  const sender = SHIPMENT_STATUS_EMAILS[status];
  if (!sender || !orderId) return false;
  try {
    const order = await loadOrderForEmail(orderId);
    if (!order) return false;
    await sender({ order });
    return true;
  } catch {
    return false;
  }
};

/**
 * "Your refund has been processed" — only ever sent once the gateway (or an
 * admin, for a manual payout) has confirmed the money moved. `amount` defaults
 * to the most recently processed refund row on the order.
 *
 * Accepts `{ order }` or `{ orderId }`.
 */
export const sendRefundProcessedEmail = async ({ order, orderId, email, amount } = {}) => {
  const target = order || (orderId ? await loadOrderForEmail(orderId) : null);
  if (!target) return;
  const to = email ?? (await customerEmailForOrder(target));

  let refundAmount = Number(amount);
  if (!Number.isFinite(refundAmount) || refundAmount <= 0) {
    const processed = (target.refunds || [])
      .filter((row) => row?.status === "processed")
      .sort((a, b) => new Date(b.processedAt || b.createdAt || 0) - new Date(a.processedAt || a.createdAt || 0));
    refundAmount = Number(processed[0]?.amount) || 0;
  }
  const amountText = refundAmount > 0 ? `${money(refundAmount)} ` : "";

  await sendOrderEmail({
    email: to,
    subject: `Refund processed for order ${orderRef(target)}`,
    title: "Refund processed",
    text: [
      `Your refund of ${amountText}for order ${orderRef(target)} has been processed.`,
      `If it was refunded to your original payment method, your bank may take 5–7 working days to show it on your statement.`,
      ``,
      `Your order: ${orderLink(target)}`,
    ].join("\n"),
    bodyHtml: `
      <p style="font-size:15px;color:#555;">Your refund ${amountText ? `of <strong>${amountText.trim()}</strong> ` : ""}for order <strong>${orderRef(target)}</strong> has been processed.</p>
      <p style="font-size:15px;color:#555;">If it was refunded to your original payment method, your bank may take 5–7 working days to show it on your statement.</p>
      ${orderLinkHtml(target)}`,
  });
};
