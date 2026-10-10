/**
 * Shiprocket capability toggles — "how much of Shiprocket does this store use?"
 *
 * The admin panel now offers three fulfilment levels (manual / basics / end to end)
 * over three stored capabilities. Before this, that decision lived entirely in .env and
 * an admin could only look at read-only status pills; the one thing they could actually
 * choose was COD coverage.
 *
 * The rule the whole design rests on, and most of what this suite pins down:
 *
 *   EFFECTIVE = ENV CEILING **AND** ADMIN CHOICE
 *
 * AND, never OR. .env stays the deployment kill switch — an admin can narrow what the
 * store uses but can never switch on something the environment forbids. The stored
 * fields default to true so a deployment that never opens the panel behaves exactly as
 * it did before these fields existed, which is what makes this safe to ship to a live
 * store.
 *
 * Run with `npm run test:shipping-capabilities` (or `npm test` for everything).
 *
 * Shiprocket is never contacted: `globalThis.fetch` is stubbed, and any call reaching it
 * fails the assertion that nothing was contacted. `ShiprocketSetting.getSettings` is
 * stubbed on the model rather than written to, because it is a singleton shared with the
 * running dev store — this suite must not alter the admin's real configuration.
 */
process.env.PAYMENTS_ENABLED = "false";
process.env.INVENTORY_ENFORCE_STOCK = "false";
process.env.INVENTORY_RESERVE_DURING_PAYMENT = "false";
process.env.NOTIFICATIONS_ENABLED = "false";

import mongoose from "mongoose";
import { connect, createSuite, marker, productFixture, addressFixture } from "./helpers.mjs";

const { ok, section, finish } = createSuite("shipping-capabilities");
await connect();

const OrderModel = (await import("../../src/modules/orders/Order.model.js")).default;
const ProductModel = (await import("../../src/modules/products/Product.model.js")).default;
const ShiprocketSetting = (await import("../../src/modules/shipping/ShiprocketSetting.model.js")).default;

const shippingController = await import("../../src/modules/shipping/shipping.controller.js");
const settingsController = await import("../../src/modules/shipping/shiprocket-settings.controller.js");
const { getShippingCapabilities } = await import("../../src/modules/shipping/shiprocket.service.js");
const { syncOrderToShiprocketIfEnabled, cancelShipmentForCancelledOrder } = await import(
  "../../src/modules/orders/order-shipping.service.js"
);

await OrderModel.init();

const MARKER = marker("shipcap");
const trash = { orders: [], products: [] };
let seq = 0;

// ---------------------------------------------------------------- boundary stubs

const realFetch = globalThis.fetch;
const realGetSettings = ShiprocketSetting.getSettings;
const savedEnv = {
  SHIPROCKET_ENABLED: process.env.SHIPROCKET_ENABLED,
  SHIPROCKET_AUTO_CREATE_ORDER: process.env.SHIPROCKET_AUTO_CREATE_ORDER,
  SHIPROCKET_WEBHOOK_ENABLED: process.env.SHIPROCKET_WEBHOOK_ENABLED,
};

let calls = [];
globalThis.fetch = async (url) => {
  calls.push(String(url));
  // Every test here is about whether Shiprocket is contacted at all, so a reply only
  // has to be well-formed enough not to throw before the assertion is made.
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ token: "stub", status_code: 200 }),
  };
};
const resetCalls = () => {
  calls = [];
};

/** Stored settings: credentials present, all three capabilities chosen. */
let stored = {
  email: "stub@example.com",
  password: "stub-password",
  pickupLocation: "Primary",
  pickupPostcode: "411001",
  webhookToken: "stub-webhook-token",
  shipmentsEnabled: true,
  autoPushEnabled: true,
  deliveryWebhookEnabled: true,
  defaultLengthCm: 10,
  defaultBreadthCm: 10,
  defaultHeightCm: 10,
  defaultWeightKg: 0.5,
};
ShiprocketSetting.getSettings = async () => {
  const doc = { ...stored };
  doc.save = async () => {
    stored = { ...stored, ...doc };
    delete stored.save;
    return doc;
  };
  return doc;
};

/** Sets the .env ceiling. All three default to permitted unless a test narrows them. */
const setEnvCeiling = ({ enabled = true, autoCreate = true, webhook = true } = {}) => {
  process.env.SHIPROCKET_ENABLED = String(enabled);
  process.env.SHIPROCKET_AUTO_CREATE_ORDER = String(autoCreate);
  process.env.SHIPROCKET_WEBHOOK_ENABLED = String(webhook);
};

const setChoice = (patch) => {
  stored = { ...stored, ...patch };
};

const restore = () => {
  globalThis.fetch = realFetch;
  ShiprocketSetting.getSettings = realGetSettings;
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
};

// ---------------------------------------------------------------- fixtures

const callController = async (handler, { params = {}, body = {}, user, headers = {} } = {}) => {
  let statusCode = 200;
  let payload;
  const res = {
    status(code) { statusCode = code; return this; },
    json(data) { payload = data; return this; },
  };
  await handler(
    { params, body, user, query: {}, get: (name) => headers[String(name).toLowerCase()] },
    res,
  );
  return { statusCode, body: payload };
};

const makeOrder = async (overrides = {}) => {
  seq += 1;
  const product = await ProductModel.create(productFixture(`${MARKER}-${seq}`, { stock: 50 }));
  trash.products.push(product._id);
  const order = await OrderModel.create({
    user: new mongoose.Types.ObjectId(),
    idempotencyKey: `${MARKER}-key-${seq}-aaaaaaaaaaaaaaaa`,
    items: [
      { product: product._id, name: product.name, image: "x.png", price: 500, quantity: 1 },
    ],
    shippingAddress: addressFixture(),
    paymentMethod: "COD",
    paymentStatus: "Pending",
    orderStatus: "Confirmed",
    subtotal: 500,
    totalAmount: 500,
    ...overrides,
  });
  trash.orders.push(order._id);
  return order;
};

// ================================================================ THE RULE

section("effective = env ceiling AND admin choice");

{
  setEnvCeiling({ enabled: false });
  setChoice({ shipmentsEnabled: true, autoPushEnabled: true, deliveryWebhookEnabled: true });
  const capabilities = await getShippingCapabilities();
  ok(
    "env forbids everything: the admin's choices cannot switch it on",
    capabilities.permitted === false &&
      capabilities.shipments === false &&
      capabilities.autoPush === false &&
      capabilities.deliveryWebhook === false,
    JSON.stringify(capabilities),
  );
}

{
  setEnvCeiling({ enabled: true, autoCreate: true, webhook: true });
  setChoice({ shipmentsEnabled: true, autoPushEnabled: true, deliveryWebhookEnabled: true });
  const capabilities = await getShippingCapabilities();
  ok(
    "env permits and admin chose everything: all capabilities active",
    capabilities.shipments && capabilities.autoPush && capabilities.deliveryWebhook,
    JSON.stringify(capabilities),
  );
}

{
  setChoice({ shipmentsEnabled: false });
  const capabilities = await getShippingCapabilities();
  ok(
    "admin choosing manual fulfilment narrows a permitting env",
    capabilities.permitted === true && capabilities.shipments === false,
    JSON.stringify(capabilities),
  );
  ok(
    "auto-push and the webhook are nested under shipments, not independent",
    capabilities.autoPush === false && capabilities.deliveryWebhook === false,
    JSON.stringify(capabilities),
  );
}

{
  setChoice({ shipmentsEnabled: true, autoPushEnabled: false, deliveryWebhookEnabled: true });
  const capabilities = await getShippingCapabilities();
  ok(
    "each capability can be narrowed on its own",
    capabilities.shipments === true &&
      capabilities.autoPush === false &&
      capabilities.deliveryWebhook === true,
    JSON.stringify(capabilities),
  );
}

{
  // The upgrade-safety case. A singleton written before these fields existed has them
  // absent; reading absent as `false` would silently disable fulfilment on deploy.
  const saved = stored;
  stored = { ...stored };
  delete stored.shipmentsEnabled;
  delete stored.autoPushEnabled;
  delete stored.deliveryWebhookEnabled;
  setEnvCeiling({ enabled: true, autoCreate: true, webhook: true });

  const capabilities = await getShippingCapabilities();
  ok(
    "a settings document saved before these fields existed keeps working",
    capabilities.shipments && capabilities.autoPush && capabilities.deliveryWebhook,
    JSON.stringify(capabilities),
  );
  stored = saved;
}

{
  setEnvCeiling({ enabled: true, autoCreate: false, webhook: false });
  setChoice({ shipmentsEnabled: true, autoPushEnabled: true, deliveryWebhookEnabled: true });
  const capabilities = await getShippingCapabilities();
  ok(
    "a narrower env ceiling still wins over a broader admin choice",
    capabilities.shipments === true &&
      capabilities.autoPush === false &&
      capabilities.deliveryWebhook === false,
    JSON.stringify(capabilities),
  );
}

// ================================================================ ENFORCEMENT

section("enforcement — the choice actually changes behaviour");

{
  setEnvCeiling({ enabled: false });
  setChoice({ shipmentsEnabled: true });
  const order = await makeOrder();
  resetCalls();
  const result = await callController(shippingController.CreateShipment, {
    params: { orderId: String(order._id) },
    user: { id: String(new mongoose.Types.ObjectId()), roles: ["admin"] },
  });
  ok(
    "env off: creating a shipment is refused as an environment problem (503)",
    result.statusCode === 503,
    `${result.statusCode} ${JSON.stringify(result.body?.message)}`,
  );
  ok("env off: Shiprocket was not contacted", calls.length === 0, `calls=${calls.length}`);
}

{
  setEnvCeiling({ enabled: true });
  setChoice({ shipmentsEnabled: false });
  const order = await makeOrder();
  resetCalls();
  const result = await callController(shippingController.CreateShipment, {
    params: { orderId: String(order._id) },
    user: { id: String(new mongoose.Types.ObjectId()), roles: ["admin"] },
  });
  ok(
    "manual fulfilment: creating a shipment is refused as a setting (409), not a 503",
    result.statusCode === 409,
    `${result.statusCode} ${JSON.stringify(result.body?.message)}`,
  );
  ok(
    "the refusal tells the admin what THEY can change",
    /Operations → Shipping/.test(result.body?.message || ""),
    result.body?.message,
  );
  ok("manual fulfilment: Shiprocket was not contacted", calls.length === 0, `calls=${calls.length}`);
}

{
  setEnvCeiling({ enabled: true, autoCreate: true });
  setChoice({ shipmentsEnabled: true, autoPushEnabled: false });
  const order = await makeOrder();
  resetCalls();
  await syncOrderToShiprocketIfEnabled(order);
  ok(
    "auto-push off: a confirmed order is not pushed to Shiprocket",
    calls.length === 0,
    `calls=${calls.length}`,
  );
  const after = await OrderModel.findById(order._id).select("shiprocket.syncStatus");
  ok(
    "auto-push off: the order is left untouched, not marked failed",
    after.shiprocket?.syncStatus === "not_created",
    String(after.shiprocket?.syncStatus),
  );
}

{
  setEnvCeiling({ enabled: true, webhook: true });
  setChoice({ shipmentsEnabled: true, deliveryWebhookEnabled: false });
  const order = await makeOrder({
    orderStatus: "Shipped",
    shiprocket: { orderId: 987654, awbCode: `${MARKER}-awb`, syncStatus: "created" },
  });
  resetCalls();
  const result = await callController(shippingController.ShippingWebhook, {
    // shipment_status_id 7 is what Shiprocket's mapper reads for Delivered — the text
    // alone never maps, so a payload without it would prove nothing here.
    body: {
      order_id: String(order._id),
      shipment_status_id: 7,
      current_status: "Delivered",
      awb: `${MARKER}-awb`,
    },
    headers: { "x-api-key": "stub-webhook-token" },
  });
  const after = await OrderModel.findById(order._id).select("orderStatus deliveredAt paymentStatus");
  ok(
    "webhook off: Shiprocket is answered 200 so it stops retrying",
    result.statusCode === 200,
    `${result.statusCode} ${JSON.stringify(result.body)}`,
  );
  ok(
    "webhook off: a Delivered event does NOT advance the order",
    after.orderStatus === "Shipped" && after.deliveredAt === null,
    JSON.stringify({ status: after.orderStatus, deliveredAt: after.deliveredAt }),
  );
  ok(
    "webhook off: COD cash is not recorded as collected",
    after.paymentStatus === "Pending",
    after.paymentStatus,
  );
}

{
  // Same event with the capability on — otherwise the assertion above would pass even
  // if the webhook were broken for an unrelated reason.
  setChoice({ shipmentsEnabled: true, deliveryWebhookEnabled: true });
  const order = await makeOrder({
    orderStatus: "Shipped",
    shiprocket: { orderId: 987655, awbCode: `${MARKER}-awb2`, syncStatus: "created" },
  });
  const result = await callController(shippingController.ShippingWebhook, {
    body: {
      order_id: String(order._id),
      shipment_status_id: 7,
      current_status: "Delivered",
      awb: `${MARKER}-awb2`,
    },
    headers: { "x-api-key": "stub-webhook-token" },
  });
  const after = await OrderModel.findById(order._id).select("orderStatus deliveredAt");
  ok(
    "webhook on: the same event DOES advance the order",
    result.statusCode === 200 && after.orderStatus === "Delivered" && after.deliveredAt !== null,
    JSON.stringify({ code: result.statusCode, status: after.orderStatus }),
  );
}

{
  setEnvCeiling({ enabled: true });
  setChoice({ shipmentsEnabled: false });
  const order = await makeOrder({
    orderStatus: "Confirmed",
    shiprocket: { orderId: 987656, syncStatus: "created" },
  });
  resetCalls();
  const outcome = await cancelShipmentForCancelledOrder(order);
  ok(
    "manual fulfilment: cancelling an order does not call Shiprocket",
    calls.length === 0,
    `calls=${calls.length}`,
  );
  ok(
    "and the shipment is NOT falsely marked cancelled — it still exists at the courier",
    outcome.attempted === false && outcome.cancelled === false,
    JSON.stringify(outcome),
  );
}

section("automation is refused until an account is connected");

{
  // The state the admin panel now locks: Shiprocket permitted and switched on, but no
  // credentials saved. Every shipment action must refuse with something the admin can act
  // on, rather than the deep "credentials are not configured" that reads as a server fault.
  setEnvCeiling({ enabled: true });
  setChoice({ shipmentsEnabled: true });
  const saved = stored;
  stored = { ...stored, email: "", password: "" };
  const savedEmail = process.env.SHIPROCKET_EMAIL;
  const savedPassword = process.env.SHIPROCKET_PASSWORD;
  delete process.env.SHIPROCKET_EMAIL;
  delete process.env.SHIPROCKET_PASSWORD;

  const capabilities = await getShippingCapabilities();
  ok(
    "the capability still reports the admin's CHOICE separately from readiness",
    capabilities.shipments === true && capabilities.configured === false,
    JSON.stringify(capabilities),
  );

  const order = await makeOrder();
  resetCalls();
  const result = await callController(shippingController.CreateShipment, {
    params: { orderId: String(order._id) },
    user: { id: String(new mongoose.Types.ObjectId()), roles: ["admin"] },
  });
  ok(
    "creating a shipment with no account connected is refused as a setting (409)",
    result.statusCode === 409,
    `${result.statusCode} ${JSON.stringify(result.body?.message)}`,
  );
  ok(
    "and the message tells the admin what THEY can do about it",
    /Operations → Shipping/.test(result.body?.message || "") &&
      /email and password/i.test(result.body?.message || ""),
    result.body?.message,
  );
  ok(
    "nothing is sent to Shiprocket, not even a login attempt",
    calls.length === 0,
    JSON.stringify(calls.map((c) => c.href)),
  );

  stored = saved;
  if (savedEmail !== undefined) process.env.SHIPROCKET_EMAIL = savedEmail;
  if (savedPassword !== undefined) process.env.SHIPROCKET_PASSWORD = savedPassword;
}

// ================================================================ SETTINGS API

section("settings endpoint");

{
  setEnvCeiling({ enabled: true, autoCreate: true, webhook: true });
  setChoice({ shipmentsEnabled: true, autoPushEnabled: true, deliveryWebhookEnabled: true });

  const adminUser = { id: String(new mongoose.Types.ObjectId()), roles: ["admin"] };
  const patch = (body) =>
    callController(settingsController.UpdateShiprocketSettings, { body, user: adminUser });

  // "Manual fulfilment" preset — the UI sends all three at once.
  const manual = await patch({
    shipmentsEnabled: false,
    autoPushEnabled: false,
    deliveryWebhookEnabled: false,
  });
  ok(
    "the manual-fulfilment preset round-trips",
    manual.statusCode === 200 &&
      manual.body?.settings?.shipmentsEnabled === false &&
      manual.body?.settings?.autoPushEnabled === false &&
      manual.body?.settings?.deliveryWebhookEnabled === false,
    JSON.stringify(manual.body?.settings),
  );
  ok(
    "the reply reports what the server will actually do",
    manual.body?.capabilities?.shipments === false && manual.body?.capabilities?.permitted === true,
    JSON.stringify(manual.body?.capabilities),
  );

  const full = await patch({
    shipmentsEnabled: true,
    autoPushEnabled: true,
    deliveryWebhookEnabled: true,
  });
  ok(
    "the end-to-end preset round-trips",
    full.body?.capabilities?.shipments &&
      full.body?.capabilities?.autoPush &&
      full.body?.capabilities?.deliveryWebhook,
    JSON.stringify(full.body?.capabilities),
  );

  // Same discipline as the COD coverage mode: junk must not switch fulfilment off.
  for (const junk of ["false", 0, null, "", "off", {}, []]) {
    await patch({ shipmentsEnabled: junk });
  }
  ok(
    "non-boolean payloads cannot switch a capability off",
    stored.shipmentsEnabled === true,
    JSON.stringify(stored.shipmentsEnabled),
  );

  // The ceiling must be reported separately from the choice, so the UI can show a
  // switch as chosen-but-blocked rather than silently flipping it off.
  setEnvCeiling({ enabled: true, autoCreate: false, webhook: false });
  const narrowed = await callController(settingsController.GetShiprocketSettings, {});
  ok(
    "the endpoint reports the env ceiling separately from the admin's choice",
    narrowed.body?.settings?.autoPushEnabled === true &&
      narrowed.body?.envCeiling?.autoPush === false &&
      narrowed.body?.capabilities?.autoPush === false,
    JSON.stringify({
      chose: narrowed.body?.settings?.autoPushEnabled,
      ceiling: narrowed.body?.envCeiling?.autoPush,
      effective: narrowed.body?.capabilities?.autoPush,
    }),
  );
  ok(
    "no secret is echoed back by the settings endpoint",
    narrowed.body?.settings?.password === undefined &&
      narrowed.body?.settings?.webhookToken === undefined &&
      narrowed.body?.settings?.passwordSet === true,
    JSON.stringify(Object.keys(narrowed.body?.settings || {})),
  );
}

// ---------------------------------------------------------------- cleanup

restore();

await Promise.all([
  OrderModel.deleteMany({ _id: { $in: trash.orders } }),
  ProductModel.deleteMany({ _id: { $in: trash.products } }),
]);

const leftovers =
  (await OrderModel.countDocuments({ idempotencyKey: new RegExp(MARKER) })) +
  (await ProductModel.countDocuments({ name: new RegExp(MARKER) }));
ok("every fixture this suite created is gone", leftovers === 0, `leftovers=${leftovers}`);

const summary = finish();
await mongoose.disconnect();
process.exit(summary.failed > 0 ? 1 : 0);
