/**
 * Customer lifecycle emails and the notifiers that send them.
 *
 * The notification queue reaches no real channel (every SMS/WhatsApp/phone
 * adapter is a no-op), so email is the only thing a customer actually receives.
 * Asserted here, with nodemailer stubbed:
 *
 *   - an admin move to Shipped / Delivered queues a `shipment.updated` row AND
 *     sends one email; other courier statuses send none;
 *   - the shipped email carries the courier and AWB (mirror first, Shiprocket
 *     fallback); the delivered email states the return window;
 *   - notifyRefundProcessed emails, notifyRefundInitiated does not;
 *   - a "system" cancellation is worded as automatic, never "by system";
 *   - a broken mailer never makes a notifier throw.
 *
 * Run with `node test/regression/order-emails.regression.mjs`.
 */
process.env.NOTIFICATIONS_ENABLED = "false";
process.env.PAYMENTS_ENABLED = "false";
process.env.SHIPROCKET_ENABLED = "false";
process.env.SMTP_HOST = "smtp.stub.invalid";
process.env.SMTP_PORT = "465";
process.env.SMTP_USER = "stub@example.test";
process.env.SMTP_PASSWORD = "stub-password";
process.env.FRONTEND_URL = "https://shop.example.test/";
process.env.EMAIL = "";
process.env.EMAIL_PASSWORD = "";

import mongoose from "mongoose";
import nodemailer from "nodemailer";
import { addressFixture, connect, createSuite, marker, productFixture } from "./helpers.mjs";

const sent = [];
let mailerBroken = false;
nodemailer.createTransport = () => ({
  sendMail: async (message) => {
    if (mailerBroken) {
      const error = new Error("stub: recipient rejected");
      error.responseCode = 550;
      throw error;
    }
    sent.push(message);
    return { messageId: `stub-${sent.length}` };
  },
});

const { ok, section, finish } = createSuite("order-emails");
await connect();

const OrderModel = (await import("../../src/modules/orders/Order.model.js")).default;
const ProductModel = (await import("../../src/modules/products/Product.model.js")).default;
const UserModel = (await import("../../src/model/User.model.js")).default;
const NotificationEvent = (await import("../../src/model/NotificationEvent.model.js")).default;
await import("../../src/modules/categories/Category.model.js");
const notifications = await import("../../src/modules/notifications/notification.service.js");
const emails = await import("../../src/modules/notifications/order-emails.js");
const orderController = await import("../../src/modules/orders/order.controller.js");
const BillCounter = (await import("../../src/modules/orders/BillCounter.model.js")).default;
const { financialYear } = await import("../../src/modules/orders/bill-number.service.js");

// The admin Delivered move mints a real bill number in the live financial year.
// Rewound in the finally block, guarded so another process's mint is never undone.
const LIVE_FY = financialYear();
const liveCounterBefore = (await BillCounter.findOne({ financialYear: LIVE_FY }).lean())?.seq ?? null;

const MARKER = marker("orderemails");
const trash = { orders: [], products: [], users: [] };
let seq = 0;

const makeUser = async () => {
  seq += 1;
  const user = await UserModel.create({
    name: `${MARKER}-user-${seq}`,
    email: `${MARKER}-${seq}@example.test`.toLowerCase(),
    password: "x".repeat(20),
  });
  trash.users.push(user._id);
  return user;
};

const makeOrder = async ({ status = "Packed", policy = null, overrides = {} } = {}) => {
  const user = await makeUser();
  const product = await ProductModel.create(
    productFixture(`${MARKER}-p-${(seq += 1)}`, policy ? { returnPolicy: policy } : {}),
  );
  trash.products.push(product._id);
  const order = await OrderModel.create({
    user: user._id,
    items: [{ product: product._id, name: product.name, image: "x.png", price: 450, quantity: 1 }],
    shippingAddress: addressFixture(),
    paymentMethod: "COD",
    paymentStatus: "Pending",
    orderStatus: status,
    subtotal: 450,
    totalAmount: 450,
    ...overrides,
  });
  trash.orders.push(order._id);
  return { order, user };
};

const mailsTo = (user) => sent.filter((message) => message.to === user.email);

// Emails from notifiers are fire-and-forget, so wait for them (bounded).
const waitForMail = async (user, count = 1, timeoutMs = 3000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (mailsTo(user).length >= count) return mailsTo(user);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return mailsTo(user);
};
// Settle window used to assert that NO email is sent.
const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

// With notifications disabled the queue row's message is replaced by "disabled
// by configuration", so wording checks run with the (no-op) SMS channel on.
const withNoopChannel = async (fn) => {
  process.env.NOTIFICATIONS_ENABLED = "true";
  process.env.NOTIFY_SMS_ENABLED = "true";
  try {
    return await fn();
  } finally {
    process.env.NOTIFICATIONS_ENABLED = "false";
    delete process.env.NOTIFY_SMS_ENABLED;
  }
};

const rows = (order, event) => NotificationEvent.find({ order: order._id, event }).lean();

const callController = async (handler, { params = {}, body = {}, user }) => {
  let statusCode = 200;
  let payload;
  const res = {
    status(code) { statusCode = code; return this; },
    json(data) { payload = data; return this; },
  };
  await handler({ params, body, user, query: {}, get: () => undefined }, res);
  return { statusCode, body: payload };
};
const admin = () => ({ id: String(new mongoose.Types.ObjectId()), roles: ["admin"] });
const setStatus = (order, orderStatus) =>
  callController(orderController.UpdateOrderStatus, {
    params: { orderId: String(order._id) },
    body: { orderStatus },
    user: admin(),
  });

try {
  // ================================================================ ADMIN PATH
  section("admin move to Shipped then Delivered: queue row + one email each");
  {
    const { order, user } = await makeOrder({
      status: "Packed",
      policy: { kind: "return", windowDays: 10 },
      overrides: { shipment: { provider: "MANUAL", carrierName: "Delhivery <Express>", trackingNumber: "AWB-1234" } },
    });

    const shipped = await setStatus(order, "Shipped");
    ok("Packed → Shipped accepted", shipped.statusCode === 200, JSON.stringify(shipped.body));
    const afterShip = await waitForMail(user, 1);
    ok("one shipment.updated row", (await rows(order, "shipment.updated")).length === 1);
    ok("one shipped email", afterShip.length === 1, String(afterShip.length));
    const shippedMail = afterShip[0] || {};
    ok("subject says shipped", /has shipped/.test(shippedMail.subject || ""), shippedMail.subject);
    ok("text carries courier and AWB", /Delhivery <Express>/.test(shippedMail.text || "") && /AWB-1234/.test(shippedMail.text || ""));
    ok("HTML escapes the courier name", /Delhivery &lt;Express&gt;/.test(shippedMail.html || ""));
    ok(
      "links to the customer's order page",
      (shippedMail.text || "").includes(`https://shop.example.test/account/orders/${order._id}`),
    );

    const delivered = await setStatus(order, "Delivered");
    ok("Shipped → Delivered accepted", delivered.statusCode === 200, JSON.stringify(delivered.body));
    const afterDeliver = await waitForMail(user, 2);
    ok("two shipment.updated rows", (await rows(order, "shipment.updated")).length === 2);
    ok("one delivered email", afterDeliver.length === 2, String(afterDeliver.length));
    const deliveredMail = afterDeliver[1] || {};
    ok("subject says delivered", /has been delivered/.test(deliveredMail.subject || ""), deliveredMail.subject);
    ok("states the product's 10-day return window", /Returns are open for 10 days/.test(deliveredMail.text || ""), deliveredMail.text);
  }

  section("other courier statuses: queue row, no email");
  {
    const { order, user } = await makeOrder({ status: "Shipped" });
    const result = await setStatus(order, "Out For Delivery");
    ok("Shipped → Out For Delivery accepted", result.statusCode === 200, JSON.stringify(result.body));
    await settle();
    ok("shipment.updated row written", (await rows(order, "shipment.updated")).length === 1);
    ok("no email", mailsTo(user).length === 0, String(mailsTo(user).length));
  }

  // ================================================================ DIRECT
  section("notifyShipmentUpdated directly: Shiprocket fallback and windows");
  {
    const { order, user } = await makeOrder({
      status: "Shipped",
      overrides: { shiprocket: { courierName: "Blue Dart", awbCode: `SR${process.pid}${seq}` } },
    });
    await notifications.notifyShipmentUpdated({ orderId: order._id, status: "Shipped" });
    const mails = await waitForMail(user, 1);
    ok("shipped email sent", mails.length === 1);
    ok("falls back to shiprocket courier + AWB", /Blue Dart/.test(mails[0]?.text || "") && (mails[0]?.text || "").includes(`SR${process.pid}`));
  }
  {
    const { order, user } = await makeOrder({ status: "Delivered", policy: { kind: "none", windowDays: 7 } });
    await notifications.notifyShipmentUpdated({ orderId: order._id, status: "Delivered" });
    const mails = await waitForMail(user, 1);
    ok("non-returnable: delivered email says so", /not eligible for return/.test(mails[0]?.text || ""), mails[0]?.text);
  }
  {
    const { order, user } = await makeOrder({ status: "Delivered" });
    await notifications.notifyShipmentUpdated({ orderId: order._id, status: "Delivered" });
    const mails = await waitForMail(user, 1);
    ok("default policy: 7 days", /Returns are open for 7 days/.test(mails[0]?.text || ""), mails[0]?.text);
  }

  // ================================================================ REFUNDS
  section("refund processed emails; refund initiated does not");
  {
    const { order, user } = await makeOrder({
      status: "Cancelled",
      overrides: {
        paymentMethod: "RAZORPAY",
        paymentStatus: "Refunded",
        refunds: [
          { amount: 120, status: "processed", processedAt: new Date(Date.now() - 60_000), reason: "a" },
          { amount: 330, status: "processed", processedAt: new Date(), reason: "b" },
        ],
      },
    });
    await withNoopChannel(() => notifications.notifyRefundInitiated({ orderId: order._id, paymentId: "pay_stub" }));
    await settle();
    const initiated = await rows(order, "refund.initiated");
    ok("refund.initiated row written", initiated.length === 1);
    ok(
      "refund.initiated says initiated, never processed",
      /Refund initiated/.test(initiated[0]?.message || "") && !/processed/i.test(initiated[0]?.message || ""),
      initiated[0]?.message,
    );
    ok("refund initiated sends no email", mailsTo(user).length === 0);

    await notifications.notifyRefundProcessed({ orderId: order._id, paymentId: "pay_stub" });
    const mails = await waitForMail(user, 1);
    ok("refund.processed row written", (await rows(order, "refund.processed")).length === 1);
    ok("one refund-processed email", mails.length === 1);
    ok("names the most recently processed amount", /₹330/.test(mails[0]?.text || ""), mails[0]?.text);
  }

  // ================================================================ CANCELLATION WORDING
  section("system cancellation wording");
  {
    const { order, user } = await makeOrder({ status: "Cancelled", overrides: { paymentMethod: "RAZORPAY" } });
    await emails.sendOrderCancelledEmail({ order, email: user.email, source: "system", autoRefund: false });
    const mail = mailsTo(user)[0] || {};
    ok(
      "email: cancelled automatically, payment not completed in time",
      /cancelled automatically, because payment was not completed in time/.test(mail.text || ""),
      mail.text,
    );
    ok("email never says 'by system'", !/by system/i.test(`${mail.text}${mail.html}`));
    ok("email says nothing was collected", /No payment had been collected/.test(mail.text || ""));

    await withNoopChannel(() =>
      notifications.notifyOrderCancelled({ orderId: order._id, userId: user._id, source: "system" }),
    );
    const row = (await rows(order, "order.cancelled"))[0];
    ok(
      "queue row: automatic wording",
      row?.message === "Order cancelled automatically — payment was not completed in time",
      row?.message,
    );
  }
  {
    const { order, user } = await makeOrder({ status: "Cancelled" });
    await emails.sendOrderCancelledEmail({ order, email: user.email, source: "admin" });
    await emails.sendOrderCancelledEmail({ order, email: user.email, source: "customer" });
    const [adminMail, customerMail] = mailsTo(user);
    ok("admin: by the store", /cancelled by the store/.test(adminMail?.text || ""));
    ok("customer: at your request", /cancelled at your request/.test(customerMail?.text || ""));
  }
  {
    // A refund that already settled still means the customer paid — never "no
    // payment had been collected".
    const { order, user } = await makeOrder({
      status: "Cancelled",
      overrides: { paymentMethod: "RAZORPAY", paymentStatus: "Refunded" },
    });
    await emails.sendOrderCancelledEmail({ order, email: user.email, source: "customer", autoRefund: true });
    const mail = mailsTo(user)[0] || {};
    ok("Refunded: not told nothing was collected", !/No payment had been collected/.test(mail.text || ""), mail.text);
    ok("Refunded: told the payment has been refunded", /has been refunded/.test(mail.text || ""), mail.text);
  }

  // ================================================================ HELPERS
  section("customerEmailForOrder");
  {
    const { order, user } = await makeOrder();
    ok("account email", (await emails.customerEmailForOrder(order)) === user.email);
    ok("populated user", (await emails.customerEmailForOrder({ user: { _id: user._id, email: "pop@example.test" } })) === "pop@example.test");
    ok(
      "legacy guest email when there is no account",
      (await emails.customerEmailForOrder({ user: null, guestEmail: "guest@example.test" })) === "guest@example.test",
    );
    ok("deleted account and no guest email → empty", (await emails.customerEmailForOrder({ user: new mongoose.Types.ObjectId() })) === "");
    ok("no order → empty", (await emails.customerEmailForOrder(null)) === "");
  }

  section("sendShipmentStatusEmail");
  {
    const { order, user } = await makeOrder({ status: "NDR" });
    ok("NDR has no email", (await emails.sendShipmentStatusEmail({ orderId: order._id, status: "NDR" })) === false);
    ok("unknown order → false", (await emails.sendShipmentStatusEmail({ orderId: new mongoose.Types.ObjectId(), status: "Shipped" })) === false);
    ok("nothing sent", mailsTo(user).length === 0);
  }

  // ================================================================ FAILURE
  section("a broken mailer never breaks a notifier");
  {
    const { order } = await makeOrder({ status: "Shipped" });
    mailerBroken = true;
    let threw = null;
    try {
      await notifications.notifyShipmentUpdated({ orderId: order._id, status: "Delivered" });
      await notifications.notifyRefundProcessed({ orderId: order._id, paymentId: "x" });
      await settle();
    } catch (error) {
      threw = error;
    } finally {
      mailerBroken = false;
    }
    ok("no throw", threw === null, threw?.message);
    ok("queue row still written", (await rows(order, "shipment.updated")).length === 1);
  }
} catch (error) {
  ok("suite ran without throwing", false, error?.stack || String(error));
} finally {
  const mintedLive = await OrderModel.countDocuments({ _id: { $in: trash.orders }, "bill.financialYear": LIVE_FY });
  if (mintedLive > 0) {
    if (liveCounterBefore === null) {
      await BillCounter.deleteOne({ financialYear: LIVE_FY, seq: mintedLive });
    } else {
      await BillCounter.updateOne(
        { financialYear: LIVE_FY, seq: liveCounterBefore + mintedLive },
        { $set: { seq: liveCounterBefore } },
      );
    }
  }
  await NotificationEvent.deleteMany({ order: { $in: trash.orders } });
  await OrderModel.deleteMany({ _id: { $in: trash.orders } });
  await ProductModel.deleteMany({ _id: { $in: trash.products } });
  await UserModel.deleteMany({ _id: { $in: trash.users } });
  finish();
  await mongoose.disconnect();
}
