/**
 * Automatic AWB assignment after an auto-push (`autoAwbEnabled`).
 *
 * When the admin opts in, a shipment created automatically for a paid order is also
 * given its AWB at once, so the customer has a tracking number without waiting for a
 * click. It must book exactly one courier however many confirmation paths arrive, obey
 * the same COD amount gate as the Assign AWB button, and — when it cannot assign —
 * leave the order exactly as an un-automated one, with the reason on the order page.
 *
 * Run with `npm run test:auto-awb` (or `npm test`).
 *
 * `globalThis.fetch` is stubbed at the HTTP boundary; unknown URLs throw.
 */
process.env.SHIPROCKET_ENABLED = "true";
process.env.SHIPROCKET_AUTO_CREATE_ORDER = "true";
process.env.SHIPROCKET_EMAIL = "stub@example.test";
process.env.SHIPROCKET_PASSWORD = "stub-password";
process.env.SHIPROCKET_BASE_URL = "https://shiprocket.invalid/v1/external";
process.env.NOTIFICATIONS_ENABLED = "false";
process.env.PAYMENTS_ENABLED = "false";

import mongoose from "mongoose";
import {
  addressFixture,
  connect,
  createSuite,
  marker,
  pinShiprocketCapabilities,
  productFixture,
} from "./helpers.mjs";

const { ok, section, finish } = createSuite("auto-awb");
await connect();
let restoreCapabilities = await pinShiprocketCapabilities({ autoAwbEnabled: true });
const pin = async (overrides) => {
  restoreCapabilities();
  restoreCapabilities = await pinShiprocketCapabilities(overrides);
};

const OrderModel = (await import("../../src/modules/orders/Order.model.js")).default;
const ProductModel = (await import("../../src/modules/products/Product.model.js")).default;
const UserModel = (await import("../../src/model/User.model.js")).default;
await import("../../src/modules/categories/Category.model.js");
const shippingController = await import("../../src/modules/shipping/shipping.controller.js");
const { autoAssignForwardAwb, syncOrderToShiprocketIfEnabled } = await import(
  "../../src/modules/orders/order-shipping.service.js"
);
const { getShippingCapabilities } = await import("../../src/modules/shipping/shiprocket.service.js");

// ── Shiprocket stub ─────────────────────────────────────────────────────────
const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const ID_BASE = 720_000_000 + (process.pid % 100_000) * 100;
let idSeq = 0;

const issuedAwb = (shipmentId) =>
  jsonResponse({
    awb_assign_status: 1,
    response: { data: { awb_code: `AUTO-${process.pid}-${shipmentId}`, courier_company_id: 9, courier_name: "Stub Air" } },
  });

const sr = { adhocCalls: [], awbCalls: [], show: () => jsonResponse({ data: {} }), awb: (body) => issuedAwb(body.shipment_id) };

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = String(input instanceof URL ? input.href : input);
  if (url.includes("/auth/login")) return jsonResponse({ token: "stub-token" });
  if (url.includes("/orders/create/adhoc")) {
    sr.adhocCalls.push(JSON.parse(init.body || "{}"));
    idSeq += 1;
    return jsonResponse({ order_id: ID_BASE + idSeq, shipment_id: ID_BASE + 50 + idSeq, status: "NEW" });
  }
  if (url.includes("/orders/show/")) return sr.show();
  if (url.includes("/courier/assign/awb")) {
    const body = JSON.parse(init.body || "{}");
    sr.awbCalls.push(body);
    return sr.awb(body);
  }
  throw new Error(`Unexpected Shiprocket call in tests: ${url}`);
};

const resetStubs = () => {
  sr.adhocCalls = [];
  sr.awbCalls = [];
  sr.show = () => jsonResponse({ data: {} });
  sr.awb = (body) => issuedAwb(body.shipment_id);
};

// ── Fixtures ────────────────────────────────────────────────────────────────
const MARKER = marker("autoawb");
const trash = { orders: [], products: [], users: [] };

const customer = await UserModel.create({
  name: `${MARKER} customer`,
  email: `${MARKER}@test.local`,
  password: "x".repeat(60),
  roles: ["user"],
});
trash.users.push(customer._id);
const book = await ProductModel.create(productFixture(`${MARKER}-a`, { weight: 0.3, length: 20, breadth: 15, height: 2 }));
trash.products.push(book._id);

const makeOrder = async (fields = {}) => {
  const order = await OrderModel.create({
    user: customer._id,
    shippingAddress: addressFixture(),
    paymentMethod: "RAZORPAY",
    paymentStatus: "Paid",
    orderStatus: "Confirmed",
    items: [{ product: book._id, name: book.name, image: "x.png", price: 300, quantity: 1 }],
    subtotal: 300,
    shippingCharge: 0,
    totalAmount: 300,
    ...fields,
  });
  trash.orders.push(order._id);
  return order;
};

const fresh = (order) => OrderModel.findById(order._id).lean();

/** The auto step is detached from the checkout request, so wait for it to land. */
const settle = async (order, done, timeoutMs = 3000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const current = await fresh(order);
    if (done(current) || Date.now() > deadline) return current;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};
const hasAwb = (o) => Boolean(o?.shiprocket?.awbCode);
const hasError = (o) => Boolean(o?.shiprocket?.lastError);

const callController = async (handler, { params = {}, body = {} } = {}) => {
  let statusCode = 200;
  let payload;
  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(data) {
      payload = data;
      return this;
    },
  };
  const user = { id: String(new mongoose.Types.ObjectId()), roles: ["admin"] };
  await handler({ params, body, user, query: {}, headers: {}, ip: "127.0.0.1" }, res);
  return { statusCode, body: payload };
};

try {
  section("1. Capability: opt-in, and only on top of auto-push");
  {
    await pin({});
    ok("off when never opted in", (await getShippingCapabilities()).autoAwb === false);
    await pin({ autoAwbEnabled: true, autoPushEnabled: false });
    ok("off while auto-push is off, even if chosen", (await getShippingCapabilities()).autoAwb === false);
    await pin({ autoAwbEnabled: true });
    ok("on when chosen and auto-push is on", (await getShippingCapabilities()).autoAwb === true);
  }

  section("2. Off: an auto-pushed shipment waits for the admin, as before");
  {
    await pin({});
    resetStubs();
    const order = await makeOrder();
    await syncOrderToShiprocketIfEnabled(order);
    const after = await settle(order, hasAwb, 300);
    ok("the shipment is created", after.shiprocket?.syncStatus === "created", after.shiprocket?.syncStatus);
    ok("and no courier is booked", sr.awbCalls.length === 0 && !after.shiprocket?.awbCode, `${sr.awbCalls.length} calls`);
  }

  section("3. On: the paid order gets its AWB without a click");
  {
    await pin({ autoAwbEnabled: true });
    resetStubs();
    const order = await makeOrder();
    await syncOrderToShiprocketIfEnabled(order);
    const after = await settle(order, hasAwb);
    ok("the AWB is assigned", after.shiprocket?.awbCode === `AUTO-${process.pid}-${after.shiprocket?.shipmentId}`, after.shiprocket?.awbCode);
    ok("sync status reads awb_assigned", after.shiprocket?.syncStatus === "awb_assigned", after.shiprocket?.syncStatus);
    ok(
      "the customer-facing tracking mirror carries it",
      after.shipment?.trackingNumber === after.shiprocket?.awbCode && after.shipment?.carrierName === "Stub Air",
      JSON.stringify(after.shipment),
    );
    ok(
      "Shiprocket chooses the courier (no courier_id sent)",
      sr.awbCalls.length === 1 && sr.awbCalls[0].courier_id === undefined,
      JSON.stringify(sr.awbCalls),
    );
    ok("no error is left on the order", !after.shiprocket?.lastError, after.shiprocket?.lastError);
  }

  section("4. Browser verify and payment webhook together still book one courier");
  {
    resetStubs();
    const order = await makeOrder();
    await Promise.all([syncOrderToShiprocketIfEnabled(order), syncOrderToShiprocketIfEnabled(order)]);
    await settle(order, hasAwb);
    await new Promise((resolve) => setTimeout(resolve, 150));
    ok("one shipment", sr.adhocCalls.length === 1, `${sr.adhocCalls.length} creates`);
    ok("one AWB request", sr.awbCalls.length === 1, `${sr.awbCalls.length} AWB calls`);
  }

  section("5. A COD amount mismatch is held for a person, exactly like the button");
  {
    resetStubs();
    sr.show = () => jsonResponse({ data: { net_total: 999 } });
    const order = await makeOrder({ paymentMethod: "COD", paymentStatus: "Pending" });
    await syncOrderToShiprocketIfEnabled(order);
    const after = await settle(order, hasError);
    ok("the check reads mismatch", after.shiprocket?.amountCheck?.status === "mismatch", JSON.stringify(after.shiprocket?.amountCheck));
    ok("no courier is booked", sr.awbCalls.length === 0 && !after.shiprocket?.awbCode, `${sr.awbCalls.length} calls`);
    ok("the reason is on the order", /acknowledge the mismatch/i.test(after.shiprocket?.lastError || ""), after.shiprocket?.lastError);
  }

  section("6. Shiprocket answers without an AWB: reported, not recorded as assigned");
  {
    resetStubs();
    sr.awb = () =>
      jsonResponse({ awb_assign_status: 0, response: { data: { awb_assign_error: "Insufficient wallet balance" } } });
    const order = await makeOrder();
    await syncOrderToShiprocketIfEnabled(order);
    const after = await settle(order, hasError);
    ok("the order has no AWB", !after.shiprocket?.awbCode && after.shiprocket?.syncStatus === "created", `${after.shiprocket?.awbCode} ${after.shiprocket?.syncStatus}`);
    ok("Shiprocket's reason is on the order", /Insufficient wallet balance/.test(after.shiprocket?.lastError || ""), after.shiprocket?.lastError);

    // The same answer to the button is an error, not "AWB assigned".
    const clicked = await callController(shippingController.AssignAwb, { params: { orderId: String(order._id) } });
    ok("the button reports it too", clicked.statusCode === 502 && /Insufficient wallet balance/.test(clicked.body?.message), `${clicked.statusCode} ${clicked.body?.message}`);

    // Once the wallet is topped up, the admin assigns it by hand and the note clears.
    sr.awb = (body) => issuedAwb(body.shipment_id);
    const retry = await callController(shippingController.AssignAwb, { params: { orderId: String(order._id) } });
    const fixed = await fresh(order);
    ok("a manual retry assigns it", retry.statusCode === 200 && Boolean(fixed.shiprocket?.awbCode), `${retry.statusCode} ${retry.body?.message}`);
    ok("and clears the error", !fixed.shiprocket?.lastError, fixed.shiprocket?.lastError);
  }
  {
    resetStubs();
    sr.awb = () => {
      throw new Error("socket hang up");
    };
    const order = await makeOrder();
    await syncOrderToShiprocketIfEnabled(order);
    const after = await settle(order, hasError);
    ok("a network failure never fails the order", after.orderStatus === "Confirmed" && after.shiprocket?.syncStatus === "created", `${after.orderStatus} ${after.shiprocket?.syncStatus}`);
    ok("and is reported on it", /Automatic AWB assignment did not go through/.test(after.shiprocket?.lastError || ""), after.shiprocket?.lastError);
  }

  section("7. Nothing is booked for an order that should not get one");
  {
    resetStubs();
    const order = await makeOrder();
    await OrderModel.updateOne(
      { _id: order._id },
      { $set: { "shiprocket.shipmentId": String(ID_BASE + 99), "shiprocket.orderId": String(ID_BASE + 98), "shiprocket.syncStatus": "created", orderStatus: "Cancelled" } },
    );
    const result = await autoAssignForwardAwb(order._id);
    ok("a cancelled order is skipped", result.outcome === "skipped" && sr.awbCalls.length === 0, `${result.outcome} ${sr.awbCalls.length}`);
  }
  {
    resetStubs();
    const order = await makeOrder();
    await OrderModel.updateOne(
      { _id: order._id },
      { $set: { "shiprocket.shipmentId": String(ID_BASE + 97), "shiprocket.orderId": String(ID_BASE + 96), "shiprocket.syncStatus": "awb_assigned", "shiprocket.awbCode": `MANUAL-${process.pid}` } },
    );
    const result = await autoAssignForwardAwb(order._id);
    const after = await fresh(order);
    ok(
      "an order the admin already assigned is left alone",
      result.outcome === "skipped" && sr.awbCalls.length === 0 && after.shiprocket?.awbCode === `MANUAL-${process.pid}`,
      `${result.outcome} ${sr.awbCalls.length} ${after.shiprocket?.awbCode}`,
    );
  }
  {
    await pin({});
    resetStubs();
    const order = await makeOrder();
    await OrderModel.updateOne(
      { _id: order._id },
      { $set: { "shiprocket.shipmentId": String(ID_BASE + 95), "shiprocket.orderId": String(ID_BASE + 94), "shiprocket.syncStatus": "created" } },
    );
    const result = await autoAssignForwardAwb(order._id, { source: "reconciler" });
    ok("switched off, the reconciler path books nothing", result.outcome === "disabled" && sr.awbCalls.length === 0, `${result.outcome} ${sr.awbCalls.length}`);
  }
} catch (error) {
  console.error(`\nSUITE ABORTED: ${error?.stack || error}`);
  ok("suite ran to completion", false, error?.message);
} finally {
  // Detached auto steps may still be finishing; let them land before cleanup.
  await new Promise((resolve) => setTimeout(resolve, 200));
  globalThis.fetch = realFetch;
  await OrderModel.deleteMany({ _id: { $in: trash.orders } });
  await ProductModel.deleteMany({ _id: { $in: trash.products } });
  await UserModel.deleteMany({ _id: { $in: trash.users } });
  restoreCapabilities();
  const { failed } = finish();
  await mongoose.disconnect();
  process.exit(failed ? 1 : 0);
}
