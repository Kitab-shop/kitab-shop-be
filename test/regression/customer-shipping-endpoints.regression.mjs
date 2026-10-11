/**
 * The two shipping endpoints a CUSTOMER can reach, plus the basket-priced rate quote.
 *
 *   CheckServiceability — checkout's COD pre-check. Answers two booleans and nothing
 *     else (no courier list, no rates), ignores every query override except the
 *     destination pincode, always asks for COD couriers, fails CLOSED (503) when the
 *     answer cannot be had, and is gated on credentials only — the same gate order
 *     placement uses, so the pre-check never disagrees with the decision.
 *   serviceabilityRateLimit — one live courier call per request, so it is limited
 *     (40 per IP per window) to stop it being used to sweep PIN codes.
 *   TrackShipment — a normalised, newest-first timeline with the consignee's personal
 *     data stripped, cached for five minutes per AWB.
 *   prepareOrderData — with live rates on, the quote is for THIS basket's parcel (summed
 *     product weights), not the store's default box; a failed quote falls back to free.
 *
 * Run with `npm run test:customer-shipping-endpoints` (or `npm test` for everything).
 *
 * Shiprocket is never contacted: `globalThis.fetch` is routed by URL, counts every call
 * per route, and throws on anything it does not recognise.
 */
process.env.SHIPROCKET_ENABLED = "true";
process.env.SHIPROCKET_WEBHOOK_ENABLED = "true";
process.env.SHIPROCKET_WEBHOOK_TOKEN = "stub-webhook-token";
process.env.SHIPROCKET_EMAIL = "stub@example.test";
process.env.SHIPROCKET_PASSWORD = "stub-password";
process.env.SHIPROCKET_BASE_URL = "https://shiprocket.invalid/v1/external";
process.env.NOTIFICATIONS_ENABLED = "false";
process.env.PAYMENTS_ENABLED = "false";
process.env.INVENTORY_ENFORCE_STOCK = "false";
process.env.INVENTORY_RESERVE_DURING_PAYMENT = "false";
// The limiter reads these per request; in-process buckets so no Redis is touched.
process.env.RATE_LIMIT_ENABLED = "true";
process.env.RATE_LIMIT_STORE = "memory";

import mongoose from "mongoose";
import {
  connect,
  createSuite,
  marker,
  productFixture,
  addressFixture,
  pinShiprocketCapabilities,
} from "./helpers.mjs";

const { ok, section, finish } = createSuite("customer-shipping-endpoints");
await connect();

let restoreCapabilities = await pinShiprocketCapabilities();

const OrderModel = (await import("../../src/modules/orders/Order.model.js")).default;
const ProductModel = (await import("../../src/modules/products/Product.model.js")).default;
const UserModel = (await import("../../src/model/User.model.js")).default;
const CheckoutSetting = (await import("../../src/modules/orders/CheckoutSetting.model.js")).default;
const shippingController = await import("../../src/modules/shipping/shipping.controller.js");
const { serviceabilityRateLimit } = await import("../../src/middleware/rate-limit.middleware.js");
const { prepareOrderData } = await import("../../src/modules/orders/order-pricing.service.js");
const { resetShiprocketToken } = await import("../../src/modules/shipping/shiprocket.service.js");

await OrderModel.init();

const MARKER = marker("custship");
const trash = { orders: [], products: [], users: [] };
let seq = 0;

// ---------------------------------------------------------------- boundary stubs

const realFetch = globalThis.fetch;
const realCheckoutSettings = CheckoutSetting.getSettings;
let checkoutSettings = {
  codEnabled: true,
  codServiceabilityCheckEnabled: false,
  shippingRatesEnabled: false,
  codMinOrderAmount: 0,
  codMaxOrderAmount: 0,
  cancellationWindowHours: 0,
};
// A singleton on the shared database: stubbed, never written.
CheckoutSetting.getSettings = async () => ({ ...checkoutSettings });

const jsonResponse = ({ status = 200, body = {} }) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
});

const couriersBody = (couriers) => ({ status: 200, body: { data: { available_courier_companies: couriers } } });
let serviceabilityResponder = () =>
  couriersBody([{ courier_name: "A", rate: 50, cod: 1 }]);
let trackResponder = () => ({ status: 200, body: {} });

let calls = [];
const ROUTES = {
  login: "/auth/login",
  serviceability: "/courier/serviceability/",
  track: "/courier/track/awb/",
};

globalThis.fetch = async (url, options) => {
  const href = String(url instanceof URL ? url.href : url);
  const route = Object.entries(ROUTES).find(([, fragment]) => href.includes(fragment))?.[0] || "unknown";
  calls.push({ href, route, method: options?.method || "GET", body: options?.body });
  if (!href.startsWith("https://shiprocket.invalid/")) {
    throw new Error(`unexpected non-Shiprocket call in test: ${href}`);
  }
  if (route === "login") return jsonResponse({ status: 200, body: { token: "stub" } });
  let outcome;
  if (route === "serviceability") outcome = await serviceabilityResponder(href);
  else if (route === "track") outcome = await trackResponder(href);
  else throw new Error(`unexpected Shiprocket call in test: ${href}`);
  if (outcome instanceof Error) throw outcome;
  return jsonResponse(outcome);
};

const resetCalls = () => {
  calls = [];
};
const callsTo = (route) => calls.filter((c) => c.route === route);

/** Re-pins capabilities with overrides on top of the suite's defaults. */
const repin = async (overrides = {}) => {
  restoreCapabilities();
  restoreCapabilities = await pinShiprocketCapabilities(overrides);
};

const callController = async (handler, { params = {}, query = {}, body = {}, user, headers = {} } = {}) => {
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
  await handler(
    {
      params,
      query,
      body,
      user,
      headers,
      get: (name) => headers[String(name).toLowerCase()],
    },
    res,
  );
  return { statusCode, body: payload };
};

const checkServiceability = (query) => callController(shippingController.CheckServiceability, { query });

const callLimiter = async (limiter, ip) => {
  let nextCalled = false;
  let statusCode = null;
  let payload = null;
  const headers = {};
  const req = { ip, path: "/serviceability", headers: {}, socket: {} };
  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(data) {
      payload = data;
      return this;
    },
    setHeader(name, value) {
      headers[name] = value;
    },
  };
  await limiter(req, res, () => {
    nextCalled = true;
  });
  return { nextCalled, statusCode, payload, headers };
};

// IST wall-clock "YYYY-MM-DD HH:mm:ss", the shape Shiprocket's tracking scans carry.
const IST_MS = (5 * 60 + 30) * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const pad = (n) => String(n).padStart(2, "0");
const istYearFirst = (date) => {
  const d = new Date(date.getTime() + IST_MS);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(
    d.getUTCMinutes(),
  )}:${pad(d.getUTCSeconds())}`;
};

const makeUser = async () => {
  seq += 1;
  const user = await UserModel.create({
    name: `${MARKER}-user-${seq}`,
    email: `${MARKER}-${seq}@example.test`,
    password: "x".repeat(20),
  });
  trash.users.push(user._id);
  return user;
};

let sharedProduct = null;
const product = async () => {
  if (sharedProduct) return sharedProduct;
  sharedProduct = await ProductModel.create(productFixture(`${MARKER}-p`, { stock: 100 }));
  trash.products.push(sharedProduct._id);
  return sharedProduct;
};

const makeOrder = async ({ user, awbCode = null } = {}) => {
  seq += 1;
  const p = await product();
  const order = await OrderModel.create({
    user: user._id,
    idempotencyKey: `${MARKER}-key-${seq}-aaaaaaaaaaaaaaaa`,
    items: [{ product: p._id, name: p.name, image: "x.png", price: p.price, quantity: 1 }],
    shippingAddress: addressFixture(),
    paymentMethod: "COD",
    paymentStatus: "Pending",
    orderStatus: awbCode ? "Shipped" : "Packed",
    subtotal: p.price,
    totalAmount: p.price,
    ...(awbCode
      ? { shiprocket: { awbCode, status: "IN TRANSIT", syncStatus: "awb_assigned" } }
      : {}),
  });
  trash.orders.push(order._id);
  return order;
};

const userOf = (user, roles = ["user"]) => ({ id: String(user._id), roles });

try {
  // ═══════════════════════════════════════════════════════════════════════════
  section("1 — CheckServiceability: two booleans, overrides ignored, fails closed");
  {
    resetCalls();
    const invalid = await checkServiceability({ deliveryPostcode: "12345" });
    ok("a 5-digit pincode is a 400", invalid.statusCode === 400 && invalid.body?.success === false,
      `${invalid.statusCode} ${JSON.stringify(invalid.body)}`);
    const missing = await checkServiceability({});
    ok("a missing pincode is a 400", missing.statusCode === 400, String(missing.statusCode));
    const letters = await checkServiceability({ deliveryPostcode: "11000A" });
    ok("a non-numeric pincode is a 400", letters.statusCode === 400, String(letters.statusCode));
    ok("…and an invalid pincode contacts nobody", calls.length === 0, JSON.stringify(calls.map((c) => c.href)));

    serviceabilityResponder = () => couriersBody([{ courier_name: "A", rate: 50, cod: 1 }]);
    resetCalls();
    const yes = await checkServiceability({ deliveryPostcode: "110001" });
    ok("a courier list → 200 {success:true}", yes.statusCode === 200 && yes.body?.success === true,
      `${yes.statusCode} ${JSON.stringify(yes.body)}`);
    ok("…serviceable:true, codAvailable:true",
      yes.body?.data?.serviceable === true && yes.body?.data?.codAvailable === true, JSON.stringify(yes.body?.data));
    const dataKeys = Object.keys(yes.body?.data || {}).sort();
    ok("…and data carries NOTHING else (no courier list, no rates)",
      JSON.stringify(dataKeys) === JSON.stringify(["codAvailable", "serviceable"]), JSON.stringify(dataKeys));
    ok("…nor does the top level", JSON.stringify(Object.keys(yes.body || {}).sort()) === JSON.stringify(["data", "success"]),
      JSON.stringify(Object.keys(yes.body || {})));
    ok("…the courier name and rate are nowhere in the response",
      !/"A"|courier|rate|50/.test(JSON.stringify(yes.body)), JSON.stringify(yes.body));
    ok("exactly one serviceability call", callsTo("serviceability").length === 1, String(callsTo("serviceability").length));

    serviceabilityResponder = () => couriersBody([]);
    resetCalls();
    const no = await checkServiceability({ deliveryPostcode: "110001" });
    ok("an empty courier list → 200 serviceable:false, codAvailable:false",
      no.statusCode === 200 && no.body?.data?.serviceable === false && no.body?.data?.codAvailable === false,
      `${no.statusCode} ${JSON.stringify(no.body)}`);

    serviceabilityResponder = () => ({ status: 500, body: { message: "upstream exploded" } });
    resetCalls();
    const http500 = await checkServiceability({ deliveryPostcode: "110001" });
    ok("courier API HTTP 500 → 503 success:false (fails closed)",
      http500.statusCode === 503 && http500.body?.success === false, `${http500.statusCode} ${JSON.stringify(http500.body)}`);
    ok("…and the upstream error text is not shown to the customer",
      !/exploded/.test(JSON.stringify(http500.body)), JSON.stringify(http500.body));

    serviceabilityResponder = () => new Error("socket hang up");
    const thrown = await checkServiceability({ deliveryPostcode: "110001" });
    ok("a transport error → 503 success:false",
      thrown.statusCode === 503 && thrown.body?.success === false, `${thrown.statusCode} ${JSON.stringify(thrown.body)}`);

    serviceabilityResponder = () => ({ status: 200, body: { data: { something_else: true } } });
    const shape = await checkServiceability({ deliveryPostcode: "110001" });
    ok("an unexpected response shape → 503, never 'serviceable'",
      shape.statusCode === 503 && shape.body?.success === false, `${shape.statusCode} ${JSON.stringify(shape.body)}`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("2 — CheckServiceability: query overrides are ignored, COD is always asked");
  {
    serviceabilityResponder = () => couriersBody([{ courier_name: "A", rate: 50, cod: 1 }]);
    resetCalls();
    const res = await checkServiceability({
      deliveryPostcode: "110001",
      pickupPostcode: "999999",
      pickup_postcode: "999999",
      weight: "50",
      length: "99",
      breadth: "99",
      height: "99",
      cod: "0",
      declaredValue: "100000",
      mode: "Air",
    });
    ok("still 200", res.statusCode === 200, `${res.statusCode} ${JSON.stringify(res.body)}`);
    const sent = callsTo("serviceability")[0];
    const q = sent ? new URL(sent.href).searchParams : new URLSearchParams();
    ok("pickup_postcode is the pinned 411001, not the query's 999999", q.get("pickup_postcode") === "411001",
      String(q.get("pickup_postcode")));
    ok("delivery_postcode is the customer's", q.get("delivery_postcode") === "110001", String(q.get("delivery_postcode")));
    ok("weight is the default 0.5, not the query's 50", Number(q.get("weight")) === 0.5, String(q.get("weight")));
    ok("length/breadth/height are the defaults (10), not 99",
      ["length", "breadth", "height"].every((k) => Number(q.get(k)) === 10),
      JSON.stringify(["length", "breadth", "height"].map((k) => q.get(k))));
    ok("cod=1 is sent even though the query said cod=0", q.get("cod") === "1", String(q.get("cod")));
    ok("declared_value and mode from the query are not forwarded",
      !q.has("declared_value") && !q.has("mode"), sent?.href);

    resetCalls();
    await checkServiceability({ deliveryPostcode: "110001" });
    const plain = callsTo("serviceability")[0];
    ok("cod=1 with no cod in the query either", plain && new URL(plain.href).searchParams.get("cod") === "1", plain?.href);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("3 — CheckServiceability: gated on credentials only");
  {
    // getShiprocketCredentials falls back to SHIPROCKET_EMAIL/PASSWORD from the env, so a
    // genuinely unconfigured store needs both the settings AND the env blank.
    const savedEmail = process.env.SHIPROCKET_EMAIL;
    const savedPassword = process.env.SHIPROCKET_PASSWORD;
    delete process.env.SHIPROCKET_EMAIL;
    delete process.env.SHIPROCKET_PASSWORD;
    await repin({ email: "", password: "" });
    resetShiprocketToken();
    let res;
    try {
      resetCalls();
      res = await checkServiceability({ deliveryPostcode: "110001" });
    } finally {
      process.env.SHIPROCKET_EMAIL = savedEmail;
      process.env.SHIPROCKET_PASSWORD = savedPassword;
      await repin();
    }
    ok("no credentials → 503 success:false (fails closed)", res.statusCode === 503 && res.body?.success === false,
      `${res.statusCode} ${JSON.stringify(res.body)}`);
    ok("…with zero fetch calls", calls.length === 0, JSON.stringify(calls.map((c) => c.href)));

    await repin({ shipmentsEnabled: false });
    try {
      serviceabilityResponder = () => couriersBody([{ courier_name: "A", rate: 50, cod: 1 }]);
      resetCalls();
      res = await checkServiceability({ deliveryPostcode: "110001" });
    } finally {
      await repin();
    }
    ok("shipmentsEnabled:false with credentials present still answers (200, serviceable)",
      res.statusCode === 200 && res.body?.data?.serviceable === true, `${res.statusCode} ${JSON.stringify(res.body)}`);
    ok("…by asking the courier", callsTo("serviceability").length === 1, String(callsTo("serviceability").length));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("4 — serviceabilityRateLimit: 40 per IP per window");
  {
    ok("serviceabilityRateLimit is exported as a middleware", typeof serviceabilityRateLimit === "function",
      typeof serviceabilityRateLimit);
    const ip = `10.${process.pid % 250}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
    const results = [];
    for (let i = 0; i < 41; i += 1) results.push(await callLimiter(serviceabilityRateLimit, ip));
    ok("the first 40 pass through", results.slice(0, 40).every((r) => r.nextCalled && r.statusCode === null),
      JSON.stringify(results.slice(0, 40).map((r) => r.statusCode).filter(Boolean)));
    const last = results[40];
    ok("the 41st is a 429 success:false", last.statusCode === 429 && last.payload?.success === false && !last.nextCalled,
      `${last.statusCode} ${JSON.stringify(last.payload)}`);
    ok("…with a Retry-After header", Number(last.headers["Retry-After"]) >= 1, JSON.stringify(last.headers));
    ok("…and RateLimit-Limit 40", Number(last.headers["RateLimit-Limit"]) === 40, JSON.stringify(last.headers));
    const other = await callLimiter(serviceabilityRateLimit, `${ip}9`);
    ok("another IP is unaffected", other.nextCalled === true, `${other.statusCode}`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("5 — TrackShipment: normalised, private data stripped, cached");
  {
    shippingController.clearTrackingCache();
    const owner = await makeUser();
    const awbCode = `TRK-${MARKER}-1`;
    const order = await makeOrder({ user: owner, awbCode });
    const now = Date.now();
    const oldest = new Date(now - 50 * HOUR);
    const middle = new Date(now - 30 * HOUR);
    const newest = new Date(now - 5 * HOUR);
    trackResponder = () => ({
      status: 200,
      body: {
        tracking_data: {
          track_status: 1,
          shipment_status: 18,
          etd: "2026-12-01 18:00:00",
          shipment_track: [
            {
              awb_code: awbCode,
              courier_name: "Delhivery",
              current_status: "IN TRANSIT",
              consignee_name: "Private Person",
              destination: "Secretville",
              origin: "Pune",
              delivered_to: "Private Person",
              phone: "9123456780",
              customer_phone: "9123456780",
            },
          ],
          // Deliberately out of order: the endpoint must sort newest first.
          shipment_track_activities: [
            { date: istYearFirst(middle), activity: "In transit", location: "Mumbai Hub", "sr-status-label": "IN TRANSIT" },
            { date: istYearFirst(oldest), activity: "Picked up", location: "Pune", "sr-status-label": "PICKED UP" },
            { date: istYearFirst(newest), activity: "Reached destination hub", location: "Hub", "sr-status-label": "IN TRANSIT" },
          ],
        },
      },
    });

    resetCalls();
    const first = await callController(shippingController.TrackShipment, {
      params: { orderId: String(order._id) },
      user: userOf(owner),
    });
    ok("owner → 200 success:true", first.statusCode === 200 && first.body?.success === true,
      `${first.statusCode} ${JSON.stringify(first.body)}`);
    const data = first.body?.data || {};
    ok("data has exactly {currentStatus, courierName, etd, activities}",
      JSON.stringify(Object.keys(data).sort()) === JSON.stringify(["activities", "courierName", "currentStatus", "etd"]),
      JSON.stringify(Object.keys(data)));
    ok("currentStatus and courierName come from shipment_track",
      data.currentStatus === "IN TRANSIT" && data.courierName === "Delhivery", JSON.stringify(data));
    ok("etd is passed through", data.etd === "2026-12-01 18:00:00", String(data.etd));
    const ats = (data.activities || []).map((a) => a.at);
    ok("three activities, newest first",
      ats.length === 3 && ats[0] === new Date(Math.floor(newest.getTime() / 1000) * 1000).toISOString()
        && ats[2] === new Date(Math.floor(oldest.getTime() / 1000) * 1000).toISOString()
        && ats[0] > ats[1] && ats[1] > ats[2],
      JSON.stringify(ats));
    const json = JSON.stringify(first.body);
    ok("the consignee name from shipment_track is NOT in the response", !/Private Person/.test(json), json);
    ok("…nor the destination", !/Secretville/.test(json), json);
    ok("…nor the phone number", !/9123456780/.test(json), json);
    ok("…nor any raw consignee field names",
      !/consignee_name|delivered_to|"destination"|"phone"|customer_phone|"origin"/.test(json), json);
    ok("one tracking fetch", callsTo("track").length === 1, String(callsTo("track").length));

    resetCalls();
    const second = await callController(shippingController.TrackShipment, {
      params: { orderId: String(order._id) },
      user: userOf(owner),
    });
    ok("second call within 5 min → 200, same data", second.statusCode === 200
      && JSON.stringify(second.body?.data) === JSON.stringify(first.body?.data), `${second.statusCode}`);
    ok("…and NO additional fetch (cached)", calls.length === 0, JSON.stringify(calls.map((c) => c.href)));

    shippingController.clearTrackingCache();
    resetCalls();
    const third = await callController(shippingController.TrackShipment, {
      params: { orderId: String(order._id) },
      user: userOf(owner),
    });
    ok("after clearTrackingCache() it fetches again", third.statusCode === 200 && callsTo("track").length === 1,
      `${third.statusCode} track=${callsTo("track").length}`);

    const stranger = await makeUser();
    resetCalls();
    const forbidden = await callController(shippingController.TrackShipment, {
      params: { orderId: String(order._id) },
      user: userOf(stranger),
    });
    ok("non-owner non-admin → 403", forbidden.statusCode === 403 && forbidden.body?.success === false,
      `${forbidden.statusCode} ${JSON.stringify(forbidden.body)}`);
    ok("…without contacting the courier", calls.length === 0, JSON.stringify(calls.map((c) => c.href)));

    const noAwb = await makeOrder({ user: owner });
    resetCalls();
    const conflict = await callController(shippingController.TrackShipment, {
      params: { orderId: String(noAwb._id) },
      user: userOf(owner),
    });
    ok("order without an AWB → 409", conflict.statusCode === 409 && conflict.body?.success === false,
      `${conflict.statusCode} ${JSON.stringify(conflict.body)}`);
    ok("…without contacting the courier", calls.length === 0, JSON.stringify(calls.map((c) => c.href)));

    const pendingAwb = `TRK-${MARKER}-2`;
    const pending = await makeOrder({ user: owner, awbCode: pendingAwb });
    trackResponder = () => ({ status: 200, body: { tracking_data: { track_status: 0, shipment_status: 0, shipment_track: [], shipment_track_activities: [] } } });
    resetCalls();
    const empty = await callController(shippingController.TrackShipment, {
      params: { orderId: String(pending._id) },
      user: userOf(owner),
    });
    ok("track_status 0 → 200", empty.statusCode === 200 && empty.body?.success === true,
      `${empty.statusCode} ${JSON.stringify(empty.body)}`);
    ok("…with empty activities and null currentStatus",
      Array.isArray(empty.body?.data?.activities) && empty.body.data.activities.length === 0
        && empty.body?.data?.currentStatus === null,
      JSON.stringify(empty.body?.data));

    // AWB-keyed response shape seen in the wild.
    shippingController.clearTrackingCache();
    trackResponder = () => ({
      status: 200,
      body: { [pendingAwb]: { tracking_data: { track_status: 1, shipment_status: 6, shipment_track: [{ current_status: "SHIPPED", courier_name: "Bluedart" }], shipment_track_activities: [] } } },
    });
    const keyed = await callController(shippingController.TrackShipment, {
      params: { orderId: String(pending._id) },
      user: userOf(owner),
    });
    ok("an AWB-keyed response is unwrapped", keyed.statusCode === 200 && keyed.body?.data?.currentStatus === "SHIPPED"
      && keyed.body?.data?.courierName === "Bluedart", JSON.stringify(keyed.body));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("6 — the rate quote is for the basket's parcel");
  {
    seq += 1;
    const heavy = await ProductModel.create(productFixture(`${MARKER}-heavy-${seq}`, {
      stock: 50, price: 300, weight: 1.2, length: 22, breadth: 15, height: 3,
    }));
    const light = await ProductModel.create(productFixture(`${MARKER}-light-${seq}`, {
      stock: 50, price: 200, weight: 0.8, length: 20, breadth: 14, height: 2,
    }));
    trash.products.push(heavy._id, light._id);
    const basket = [
      { product: String(heavy._id), quantity: 2 },
      { product: String(light._id), quantity: 1 },
    ];
    const price = () => prepareOrderData({ items: basket, rawShippingAddress: addressFixture(), userId: null });

    checkoutSettings = { ...checkoutSettings, shippingRatesEnabled: true };
    serviceabilityResponder = () =>
      couriersBody([
        { courier_name: "Pricey", rate: 140, cod: 1 },
        { courier_name: "Cheap", rate: 87.2, cod: 1 },
      ]);
    resetCalls();
    const quoted = await price();
    const sent = callsTo("serviceability")[0];
    const q = sent ? new URL(sent.href).searchParams : new URLSearchParams();
    ok("one serviceability call for the quote", callsTo("serviceability").length === 1,
      String(callsTo("serviceability").length));
    ok("weight is the basket total 1.2×2 + 0.8 = 3.2, not the default 0.5", Number(q.get("weight")) === 3.2,
      String(q.get("weight")));
    ok("length/breadth are the widest item's footprint (22×15)",
      Number(q.get("length")) === 22 && Number(q.get("breadth")) === 15, `${q.get("length")}×${q.get("breadth")}`);
    ok("height is the stacked total 3×2 + 2 = 8", Number(q.get("height")) === 8, String(q.get("height")));
    ok("subtotal is 300×2 + 200", quoted.subtotal === 800, String(quoted.subtotal));
    ok("shippingCharge is the cheapest rate rounded up (87.2 → 88)", quoted.shippingCharge === 88,
      String(quoted.shippingCharge));
    ok("totalAmount includes it", quoted.totalAmount === 888, String(quoted.totalAmount));

    serviceabilityResponder = () => ({ status: 500, body: { message: "rates down" } });
    resetCalls();
    const fallback = await price();
    ok("rate call fails → shippingCharge 0 (falls back to free)", fallback.shippingCharge === 0,
      String(fallback.shippingCharge));
    ok("…the order still prices", fallback.totalAmount === 800 && callsTo("serviceability").length === 1,
      `${fallback.totalAmount} calls=${callsTo("serviceability").length}`);

    checkoutSettings = { ...checkoutSettings, shippingRatesEnabled: false };
    resetCalls();
    const off = await price();
    ok("rates off → free, and no courier call", off.shippingCharge === 0 && callsTo("serviceability").length === 0,
      `${off.shippingCharge} calls=${callsTo("serviceability").length}`);
  }
} catch (error) {
  console.error(`\nSUITE ABORTED: ${error?.stack || error}`);
  ok("suite ran to completion", false, error?.message);
} finally {
  globalThis.fetch = realFetch;
  CheckoutSetting.getSettings = realCheckoutSettings;
  restoreCapabilities();
  shippingController.clearTrackingCache();

  await Promise.all([
    OrderModel.deleteMany({ _id: { $in: trash.orders } }),
    ProductModel.deleteMany({ _id: { $in: trash.products } }),
    UserModel.deleteMany({ _id: { $in: trash.users } }),
  ]);
  const leftovers =
    (await OrderModel.countDocuments({ idempotencyKey: new RegExp(MARKER) })) +
    (await ProductModel.countDocuments({ name: new RegExp(MARKER) })) +
    (await UserModel.countDocuments({ name: new RegExp(MARKER) }));
  ok("every fixture this suite created is gone", leftovers === 0, `leftovers=${leftovers}`);

  const { failed } = finish();
  await mongoose.disconnect();
  process.exit(failed ? 1 : 0);
}
