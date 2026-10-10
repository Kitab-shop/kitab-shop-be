/**
 * Shiprocket admin utilities (Phase A) — connection test, pickup locations, manifests.
 *
 * All three exist to move a diagnosis out of the server log and into the admin panel.
 * Before this: a wrong Shiprocket password produced no signal at save time and only
 * surfaced later as a failed shipment; `pickupLocation` was free text that had to match
 * a name in Shiprocket's dashboard exactly, with a mismatch rejecting every shipment
 * while naming neither the field nor the typo; and manifests — the document couriers
 * ask for at handover — were not generated at all.
 *
 * The properties that matter here are mostly about NOT lying to the admin:
 *
 *   A failed CHECK is a successful REQUEST. Both diagnostics answer HTTP 200 with an
 *   outcome, because a 502 would make the browser treat a correct diagnosis as a
 *   transport error and show nothing useful.
 *
 *   "Could not ask" never reads as "the answer is no". An unreachable pickup-location
 *   list must not render as "this account has no pickup locations", which would send an
 *   admin to fix the wrong thing.
 *
 *   Diagnostics work while the store is set to manual fulfilment, because testing
 *   credentials BEFORE switching Shiprocket on is the normal setup order. They still
 *   respect the .env ceiling.
 *
 * Run with `npm run test:shipping-utilities` (or `npm test` for everything).
 *
 * Shiprocket is never contacted: `globalThis.fetch` is stubbed, which is also what lets
 * the responses be made hostile on purpose. `ShiprocketSetting.getSettings` is stubbed on
 * the model rather than written to — it is a singleton shared with the running dev store.
 */
process.env.PAYMENTS_ENABLED = "false";
process.env.INVENTORY_ENFORCE_STOCK = "false";
process.env.INVENTORY_RESERVE_DURING_PAYMENT = "false";
process.env.NOTIFICATIONS_ENABLED = "false";

import mongoose from "mongoose";
import { connect, createSuite, marker, productFixture, addressFixture } from "./helpers.mjs";

const { ok, section, finish } = createSuite("shipping-utilities");
await connect();

const OrderModel = (await import("../../src/modules/orders/Order.model.js")).default;
const ProductModel = (await import("../../src/modules/products/Product.model.js")).default;
const ShiprocketSetting = (await import("../../src/modules/shipping/ShiprocketSetting.model.js")).default;

const shippingController = await import("../../src/modules/shipping/shipping.controller.js");
const settingsController = await import("../../src/modules/shipping/shiprocket-settings.controller.js");
const { verifyShiprocketConnection, listPickupLocations, clearPickupLocationCache } =
  await import("../../src/modules/shipping/shiprocket.service.js");

/** Every direct call here is testing the FETCH, so none of them may be served a cache. */
const listFresh = () => listPickupLocations({ forceRefresh: true });

await OrderModel.init();

const MARKER = marker("shiputil");
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
let loginResponder = () => ({ status: 200, body: { token: "stub-token" } });
let pickupResponder = () => ({ status: 200, body: { data: { shipping_address: [] } } });
let manifestResponder = () => ({ status: 200, body: { manifest_url: "https://stub/manifest.pdf" } });

const jsonResponse = ({ status = 200, body = {} }) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
});

globalThis.fetch = async (url, options) => {
  const href = String(url);
  calls.push({ href, method: options?.method || "GET" });
  const route = href.includes("/auth/login")
    ? loginResponder
    : href.includes("/settings/company/pickup")
      ? pickupResponder
      : href.includes("/manifests/generate")
        ? manifestResponder
        : null;
  if (!route) throw new Error(`unexpected Shiprocket call in test: ${href}`);
  const outcome = route(href);
  if (outcome instanceof Error) throw outcome;
  return jsonResponse(outcome);
};

const resetCalls = () => {
  calls = [];
};
const loginCalls = () => calls.filter((c) => c.href.includes("/auth/login"));

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
ShiprocketSetting.getSettings = async () => ({ ...stored });

const setEnvCeiling = ({ enabled = true } = {}) => {
  process.env.SHIPROCKET_ENABLED = String(enabled);
  process.env.SHIPROCKET_AUTO_CREATE_ORDER = "true";
  process.env.SHIPROCKET_WEBHOOK_ENABLED = "true";
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

const callController = async (handler, { params = {}, body = {}, user } = {}) => {
  let statusCode = 200;
  let payload;
  const res = {
    status(code) { statusCode = code; return this; },
    json(data) { payload = data; return this; },
  };
  await handler({ params, body, user, query: {} }, res);
  return { statusCode, body: payload };
};

const adminUser = () => ({ id: String(new mongoose.Types.ObjectId()), roles: ["admin"] });

const makeOrder = async (shiprocket = {}) => {
  seq += 1;
  const product = await ProductModel.create(productFixture(`${MARKER}-${seq}`, { stock: 20 }));
  trash.products.push(product._id);
  const order = await OrderModel.create({
    user: new mongoose.Types.ObjectId(),
    idempotencyKey: `${MARKER}-key-${seq}-aaaaaaaaaaaaaaaa`,
    items: [{ product: product._id, name: product.name, image: "x.png", price: 500, quantity: 1 }],
    shippingAddress: addressFixture(),
    paymentMethod: "COD",
    paymentStatus: "Pending",
    orderStatus: "Confirmed",
    subtotal: 500,
    totalAmount: 500,
    shiprocket,
  });
  trash.orders.push(order._id);
  return order;
};

// ================================================================ A1 — CONNECTION TEST

section("A1 — connection test");

{
  setEnvCeiling({ enabled: true });
  loginResponder = () => ({ status: 200, body: { token: "stub-token" } });
  resetCalls();
  const result = await verifyShiprocketConnection();
  ok(
    "working credentials report authenticated",
    result.ok === true && result.reason === "authenticated",
    JSON.stringify(result),
  );
  ok(
    "the check performs a real login rather than trusting the cached token",
    loginCalls().length === 1,
    `logins=${loginCalls().length}`,
  );
}

{
  // The reason this forces a refresh: a token cached for 9 days would report "works"
  // long after the password was changed underneath us.
  loginResponder = () => ({ status: 401, body: { message: "invalid email or password" } });
  resetCalls();
  const result = await verifyShiprocketConnection();
  ok(
    "a wrong password is detected even though a valid token was cached a moment ago",
    result.ok === false && result.reason === "rejected",
    JSON.stringify(result),
  );
  ok(
    "and Shiprocket's own wording is passed through for the admin",
    /invalid email or password/i.test(result.detail || ""),
    result.detail,
  );
}

{
  loginResponder = () => new Error("connect ETIMEDOUT");
  const result = await verifyShiprocketConnection();
  ok(
    "an outage is reported as unreachable, distinctly from rejected credentials",
    result.ok === false && result.reason === "unreachable",
    JSON.stringify(result),
  );
}

{
  loginResponder = () => ({ status: 200, body: { message: "ok but no token" } });
  const result = await verifyShiprocketConnection();
  ok(
    "a 200 with no token is not treated as a working connection",
    result.ok === false,
    JSON.stringify(result),
  );
}

{
  const saved = stored;
  stored = { ...stored, email: "", password: "" };
  const savedEmail = process.env.SHIPROCKET_EMAIL;
  const savedPassword = process.env.SHIPROCKET_PASSWORD;
  delete process.env.SHIPROCKET_EMAIL;
  delete process.env.SHIPROCKET_PASSWORD;
  resetCalls();

  const result = await verifyShiprocketConnection();
  ok(
    "no credentials saved is its own answer, not a failed login",
    result.ok === false && result.reason === "not_configured",
    JSON.stringify(result),
  );
  ok("and no login is attempted", calls.length === 0, `calls=${calls.length}`);

  stored = saved;
  if (savedEmail !== undefined) process.env.SHIPROCKET_EMAIL = savedEmail;
  if (savedPassword !== undefined) process.env.SHIPROCKET_PASSWORD = savedPassword;
}

{
  // HTTP contract. The endpoint must answer 200 for a FAILED check, because the browser
  // treats a non-2xx as a transport error and would show nothing useful.
  loginResponder = () => ({ status: 401, body: { message: "invalid email or password" } });
  const failed = await callController(settingsController.TestShiprocketConnection, {
    user: adminUser(),
  });
  ok(
    "a failed check is still HTTP 200 with an outcome",
    failed.statusCode === 200 && failed.body?.ok === false,
    `${failed.statusCode} ${JSON.stringify(failed.body)}`,
  );
  ok(
    "the failure carries an admin-readable message",
    typeof failed.body?.message === "string" && failed.body.message.length > 10,
    failed.body?.message,
  );
  ok(
    "no credential value is echoed anywhere in the reply",
    !JSON.stringify(failed.body).includes("stub-password"),
    JSON.stringify(failed.body),
  );

  loginResponder = () => ({ status: 200, body: { token: "stub-token" } });
  const passed = await callController(settingsController.TestShiprocketConnection, {
    user: adminUser(),
  });
  ok(
    "a passing check reports ok",
    passed.statusCode === 200 && passed.body?.ok === true,
    JSON.stringify(passed.body),
  );
}

{
  // Setup order: an admin tests credentials BEFORE switching Shiprocket on. Refusing to
  // test until it is already on would make the button useless for its main purpose.
  setEnvCeiling({ enabled: true });
  setChoice({ shipmentsEnabled: false });
  loginResponder = () => ({ status: 200, body: { token: "stub-token" } });
  const result = await callController(settingsController.TestShiprocketConnection, {
    user: adminUser(),
  });
  ok(
    "the test works while the store is set to manual fulfilment",
    result.body?.ok === true,
    JSON.stringify(result.body),
  );
  setChoice({ shipmentsEnabled: true });
}

{
  setEnvCeiling({ enabled: false });
  resetCalls();
  const result = await callController(settingsController.TestShiprocketConnection, {
    user: adminUser(),
  });
  ok(
    "but the .env ceiling still applies — no login attempted at all",
    result.statusCode === 200 && result.body?.ok === false && result.body?.reason === "not_permitted",
    JSON.stringify(result.body),
  );
  ok("nothing was sent to Shiprocket", calls.length === 0, `calls=${calls.length}`);
  ok(
    "and the message names the env variable a developer must change",
    /SHIPROCKET_ENABLED/.test(result.body?.message || ""),
    result.body?.message,
  );
}

// ================================================================ A2 — PICKUP LOCATIONS

section("A2 — pickup locations");

{
  setEnvCeiling({ enabled: true });
  loginResponder = () => ({ status: 200, body: { token: "stub-token" } });
  pickupResponder = () => ({
    status: 200,
    body: {
      data: {
        shipping_address: [
          { pickup_location: "Primary", address: "1 Test St", city: "Pune", state: "Maharashtra", pin_code: "411001" },
          { pickup_location: "Warehouse 2", address: "2 Test St", city: "Mumbai", state: "Maharashtra", pin_code: "400001" },
        ],
      },
    },
  });
  const result = await listFresh();
  ok(
    "the registered pickup locations are returned",
    result.ok === true && result.locations.length === 2,
    JSON.stringify(result),
  );
  ok(
    "each entry carries the name the shipment payload must match",
    result.locations[0]?.name === "Primary" && result.locations[1]?.name === "Warehouse 2",
    JSON.stringify(result.locations.map((l) => l.name)),
  );
  ok(
    "and enough context to tell two similarly named locations apart",
    result.locations[1]?.city === "Mumbai" && result.locations[1]?.pincode === "400001",
    JSON.stringify(result.locations[1]),
  );
}

{
  // A nameless entry cannot be matched against anything, so it must not be offered as a
  // choice — picking it would produce exactly the failure this feature exists to prevent.
  pickupResponder = () => ({
    status: 200,
    body: { data: { shipping_address: [{ pickup_location: "", city: "Nowhere" }, { pickup_location: "  ", city: "X" }] } },
  });
  const result = await listFresh();
  ok(
    "entries with no usable name are dropped",
    result.ok === true && result.locations.length === 0,
    JSON.stringify(result),
  );
}

{
  pickupResponder = () => ({ status: 200, body: { data: { shipping_address: [] } } });
  const result = await listFresh();
  ok(
    "an account with none registered reports ok with an empty list",
    result.ok === true && result.locations.length === 0,
    JSON.stringify(result),
  );
}

// "Could not ask" must never render as "the answer is no" — an admin told they have no
// pickup locations, when really the call failed, goes and fixes the wrong thing.
const unreadableCases = [
  ["carrier unreachable", () => new Error("socket hang up")],
  ["HTTP 500", () => ({ status: 500, body: { message: "server error" } })],
  ["no address list in the response", () => ({ status: 200, body: {} })],
  ["address list is not an array", () => ({ status: 200, body: { data: { shipping_address: "Primary" } } })],
  ["HTTP 200 with an embedded error status", () => ({ status: 200, body: { status: 422, message: "bad request" } })],
  ["body is not JSON", () => ({ status: 200, body: "<html>maintenance</html>" })],
];

for (const [label, responder] of unreadableCases) {
  pickupResponder = responder;
  const result = await listFresh();
  ok(
    `cannot-list is distinguishable from none-registered: ${label}`,
    result.ok === false && result.locations.length === 0 && Boolean(result.reason),
    JSON.stringify(result),
  );
}

{
  pickupResponder = () => ({
    status: 200,
    body: { data: { shipping_address: [{ pickup_location: "Primary", city: "Pune", pin_code: "411001" }] } },
  });
  const result = await callController(settingsController.GetPickupLocations, { user: adminUser() });
  ok(
    "the endpoint answers 200 with the list",
    result.statusCode === 200 && result.body?.ok === true && result.body?.locations?.length === 1,
    JSON.stringify(result.body),
  );

  pickupResponder = () => new Error("socket hang up");
  const failed = await callController(settingsController.GetPickupLocations, { user: adminUser() });
  ok(
    "a failed listing is 200 with ok:false, not an HTTP error",
    failed.statusCode === 200 && failed.body?.ok === false,
    `${failed.statusCode} ${JSON.stringify(failed.body)}`,
  );
}

{
  setEnvCeiling({ enabled: false });
  resetCalls();
  const result = await callController(settingsController.GetPickupLocations, { user: adminUser() });
  ok(
    "the .env ceiling applies to listing too",
    result.body?.ok === false && result.body?.reason === "not_permitted" && calls.length === 0,
    JSON.stringify(result.body),
  );
}

// ================================================================ A3 — MANIFESTS

section("A3 — manifests");

{
  setEnvCeiling({ enabled: true });
  setChoice({ shipmentsEnabled: true });
  loginResponder = () => ({ status: 200, body: { token: "stub-token" } });
  manifestResponder = () => ({ status: 200, body: { manifest_url: "https://stub/manifest.pdf" } });

  const order = await makeOrder({ orderId: 5001, shipmentId: 6001, awbCode: `${MARKER}-awb` });
  const result = await callController(shippingController.GenerateManifest, {
    params: { orderId: String(order._id) },
    user: adminUser(),
  });
  const after = await OrderModel.findById(order._id).select("shiprocket.manifestUrl shiprocket.lastSyncedAt");
  ok(
    "a manifest is generated for a shipment with an AWB",
    result.statusCode === 200 && result.body?.manifestUrl === "https://stub/manifest.pdf",
    `${result.statusCode} ${JSON.stringify(result.body?.manifestUrl)}`,
  );
  ok(
    "and the URL is persisted on the order like the label and invoice",
    after.shiprocket?.manifestUrl === "https://stub/manifest.pdf",
    String(after.shiprocket?.manifestUrl),
  );
}

{
  // Nested shape, since Shiprocket is inconsistent about this across endpoints.
  manifestResponder = () => ({ status: 200, body: { data: { manifest_url: "https://stub/nested.pdf" } } });
  const order = await makeOrder({ orderId: 5002, shipmentId: 6002, awbCode: `${MARKER}-awb2` });
  await callController(shippingController.GenerateManifest, {
    params: { orderId: String(order._id) },
    user: adminUser(),
  });
  const after = await OrderModel.findById(order._id).select("shiprocket.manifestUrl");
  ok(
    "a nested manifest_url is read too",
    after.shiprocket?.manifestUrl === "https://stub/nested.pdf",
    String(after.shiprocket?.manifestUrl),
  );
}

{
  // A manifest lists the AWBs being handed to the courier, so there is nothing to hand
  // over before one exists. Same precondition as the label.
  const order = await makeOrder({ orderId: 5003, shipmentId: 6003 });
  resetCalls();
  const result = await callController(shippingController.GenerateManifest, {
    params: { orderId: String(order._id) },
    user: adminUser(),
  });
  ok(
    "no AWB yet is refused with 409 rather than calling Shiprocket",
    result.statusCode === 409 && !calls.some((c) => c.href.includes("/manifests/")),
    `${result.statusCode} ${JSON.stringify(result.body?.message)}`,
  );
}

{
  // The guard every other fulfilment action shares: a parcel for a cancelled order must
  // not get handover paperwork, or it physically leaves after the money went back.
  const order = await makeOrder({ orderId: 5004, shipmentId: 6004, awbCode: `${MARKER}-awb4` });
  await OrderModel.updateOne({ _id: order._id }, { $set: { orderStatus: "Cancelled" } });
  resetCalls();
  const result = await callController(shippingController.GenerateManifest, {
    params: { orderId: String(order._id) },
    user: adminUser(),
  });
  ok(
    "a cancelled order cannot have a manifest generated",
    result.statusCode === 409 && !calls.some((c) => c.href.includes("/manifests/")),
    `${result.statusCode} ${JSON.stringify(result.body?.message)}`,
  );
}

{
  const order = await makeOrder({ orderId: 5005, shipmentId: 6005, awbCode: `${MARKER}-awb5` });
  await OrderModel.updateOne({ _id: order._id }, { $set: { orderStatus: "RTO Received" } });
  const result = await callController(shippingController.GenerateManifest, {
    params: { orderId: String(order._id) },
    user: adminUser(),
  });
  ok(
    "an order already back from a failed delivery cannot either",
    result.statusCode === 409,
    `${result.statusCode} ${JSON.stringify(result.body?.message)}`,
  );
}

{
  // Manifests are a shipment action, so unlike the diagnostics they DO follow the
  // capability: a store on manual fulfilment has no Shiprocket handover to document.
  setChoice({ shipmentsEnabled: false });
  const order = await makeOrder({ orderId: 5006, shipmentId: 6006, awbCode: `${MARKER}-awb6` });
  resetCalls();
  const result = await callController(shippingController.GenerateManifest, {
    params: { orderId: String(order._id) },
    user: adminUser(),
  });
  ok(
    "manual fulfilment refuses the manifest as a setting (409), naming what to change",
    result.statusCode === 409 && /Operations → Shipping/.test(result.body?.message || ""),
    `${result.statusCode} ${JSON.stringify(result.body?.message)}`,
  );
  ok("and Shiprocket was not contacted", !calls.some((c) => c.href.includes("/manifests/")), JSON.stringify(calls.map(c=>c.href)));
  setChoice({ shipmentsEnabled: true });
}

{
  manifestResponder = () => new Error("connect ECONNREFUSED");
  const order = await makeOrder({ orderId: 5007, shipmentId: 6007, awbCode: `${MARKER}-awb7` });
  const result = await callController(shippingController.GenerateManifest, {
    params: { orderId: String(order._id) },
    user: adminUser(),
  });
  const after = await OrderModel.findById(order._id).select("shiprocket.manifestUrl");
  ok(
    "a Shiprocket failure is reported, not swallowed",
    result.statusCode >= 400,
    `${result.statusCode} ${JSON.stringify(result.body?.message)}`,
  );
  ok(
    "and no manifest URL is stored for a manifest that was never produced",
    after.shiprocket?.manifestUrl === null,
    String(after.shiprocket?.manifestUrl),
  );
}

{
  const paths = OrderModel.schema.paths;
  ok(
    "manifestUrl sits beside labelUrl/invoiceUrl on the order, not in a new collection",
    Object.prototype.hasOwnProperty.call(paths, "shiprocket.manifestUrl") &&
      Object.prototype.hasOwnProperty.call(paths, "shiprocket.labelUrl"),
    Object.keys(paths).filter((p) => p.startsWith("shiprocket.")).join(","),
  );
}

section("A2 — the pickup cache");

{
  setEnvCeiling({ enabled: true });
  loginResponder = () => ({ status: 200, body: { token: "stub-token" } });
  clearPickupLocationCache();
  let hits = 0;
  pickupResponder = () => {
    hits += 1;
    return {
      status: 200,
      body: { data: { shipping_address: [{ pickup_location: "Primary", city: "Pune", pin_code: "411001" }] } },
    };
  };

  await listPickupLocations();
  await listPickupLocations();
  const third = await listPickupLocations();
  ok(
    "repeated reads are served from cache — System Health does not call Shiprocket on every load",
    hits === 1 && third.cached === true,
    `shiprocketCalls=${hits}`,
  );

  const forced = await listPickupLocations({ forceRefresh: true });
  ok(
    'the admin\'s explicit "Load from Shiprocket" bypasses the cache',
    hits === 2 && forced.cached !== true,
    `shiprocketCalls=${hits}`,
  );

  // A cached failure would let one transient outage suppress the health check for the
  // whole TTL, which is the opposite of what the check is for.
  clearPickupLocationCache();
  pickupResponder = () => new Error("socket hang up");
  const failed = await listPickupLocations();
  const retried = await listPickupLocations();
  ok(
    "failures are never cached — the next read tries again",
    failed.ok === false && retried.ok === false && retried.cached !== true,
    JSON.stringify({ failed: failed.reason, retried: retried.reason, cached: retried.cached }),
  );

  // The staleness bug: a cached list belongs to whichever account those credentials
  // pointed at, so changing them must drop it.
  clearPickupLocationCache();
  hits = 0;
  pickupResponder = () => {
    hits += 1;
    return {
      status: 200,
      body: { data: { shipping_address: [{ pickup_location: "OldAccount", city: "Pune", pin_code: "411001" }] } },
    };
  };
  await listPickupLocations();
  await callController(settingsController.UpdateShiprocketSettings, {
    body: { password: "a-different-password" },
    user: adminUser(),
  });
  pickupResponder = () => {
    hits += 1;
    return {
      status: 200,
      body: { data: { shipping_address: [{ pickup_location: "NewAccount", city: "Delhi", pin_code: "110001" }] } },
    };
  };
  const afterCredentialChange = await listPickupLocations();
  ok(
    "changing credentials drops the cached list from the previous account",
    afterCredentialChange.locations[0]?.name === "NewAccount" && hits === 2,
    JSON.stringify({ locations: afterCredentialChange.locations.map((l) => l.name), hits }),
  );
}

// ================================================================ A4 — HEALTH

section("A4 — System Health tells the truth about the pickup location");

{
  const { buildSystemHealth } = await import("../../src/modules/admin/system-health.service.js");
  const findPickupCheck = async () => {
    const health = await buildSystemHealth();
    return health.groups.flatMap((group) => group.checks || []).find((c) => c?.id === "ship.pickup");
  };

  setEnvCeiling({ enabled: true });
  setChoice({ shipmentsEnabled: true, pickupLocation: "Warehouse 2" });
  loginResponder = () => ({ status: 200, body: { token: "stub-token" } });
  pickupResponder = () => ({
    status: 200,
    body: { data: { shipping_address: [{ pickup_location: "Primary", city: "Pune", pin_code: "411001" }] } },
  });

  clearPickupLocationCache();
  const mismatch = await findPickupCheck();
  ok(
    "a pickup name not registered on the account is reported as critical",
    mismatch?.status === "critical",
    JSON.stringify(mismatch),
  );
  ok(
    "and the real registered names are listed so it can be corrected",
    /Primary/.test(mismatch?.action || ""),
    mismatch?.action,
  );

  setChoice({ pickupLocation: "Primary" });
  clearPickupLocationCache();
  const match = await findPickupCheck();
  ok(
    "a matching pickup name is reported as ok",
    match?.status === "ok",
    JSON.stringify(match),
  );

  // The distinction the old check could not make: "we could not verify" is not the same
  // claim as "your value is wrong", and reporting the latter sends an operator to
  // change a correct setting.
  pickupResponder = () => new Error("socket hang up");
  clearPickupLocationCache();
  const unverified = await findPickupCheck();
  ok(
    "an unreachable list is a warning, never a false mismatch",
    unverified?.status === "warn" && !/not registered/i.test(unverified?.detail || ""),
    JSON.stringify(unverified),
  );

  // An unset pickup location cannot be blank: getShiprocketCredentials() resolves it
  // through `resolved(db, env, "Primary")`, so it silently becomes "Primary". That is a
  // quiet footgun — a store that never configured one looks configured — and the value
  // of verifying against the account is that it surfaces exactly this: "Primary" is only
  // correct if "Primary" is actually registered.
  setChoice({ pickupLocation: "" });
  const savedEnvPickup = process.env.SHIPROCKET_PICKUP_LOCATION;
  delete process.env.SHIPROCKET_PICKUP_LOCATION;
  pickupResponder = () => ({
    status: 200,
    body: { data: { shipping_address: [{ pickup_location: "Warehouse 2", city: "Mumbai", pin_code: "400001" }] } },
  });

  clearPickupLocationCache();
  const defaulted = await findPickupCheck();
  ok(
    'an unconfigured pickup location defaults to "Primary" rather than blank',
    /"Primary"/.test(`${defaulted?.detail} ${defaulted?.action}`),
    JSON.stringify(defaulted),
  );
  ok(
    "and is reported critical when that default is not registered on the account",
    defaulted?.status === "critical",
    JSON.stringify(defaulted),
  );

  if (savedEnvPickup !== undefined) process.env.SHIPROCKET_PICKUP_LOCATION = savedEnvPickup;
  setChoice({ pickupLocation: "Primary" });
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
