/**
 * AWBs on the two reverse legs (return pickup, replacement parcel).
 *
 * Booking a reverse leg through Shiprocket stores only its order and shipment ids; the
 * AWB is assigned afterwards. Courier events for return legs are resolved by AWB ALONE,
 * so until the AWB is on the return every webhook for that parcel is ignored. Three ways
 * it gets there, all covered here:
 *
 *   RECORD (by hand)  — validated, never overwrites a different AWB, idempotent on the
 *                       same one, unique across returns, only while the leg is travelling,
 *                       audited and noted in the return's history.
 *   SYNC (fetch now)  — reads GET /shipments/{id}; nothing assigned yet is synced:false,
 *                       an unbooked leg or Shiprocket being off is a 409.
 *   AUTO (on booking) — behind reverseAutoAwbEnabled: assign-AWB with is_return:1 right
 *                       after the pickup is booked; never fails the booking.
 *
 * And the point of all of it: once recorded, a webhook for that AWB resolves to the
 * return (scope "return"), writes the courier status and leaves the return status alone.
 *
 * Plus a sanity check mirroring return-booking-claims: concurrent replacement bookings
 * make exactly one Shiprocket call.
 *
 * Run with `npm run test:reverse-awb` (or `npm test` for everything).
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

import mongoose from "mongoose";
import {
  connect,
  createSuite,
  marker,
  productFixture,
  addressFixture,
  pinShiprocketCapabilities,
} from "./helpers.mjs";

const { ok, section, finish } = createSuite("reverse-awb");
await connect();

// Reverse shipments are pinned OFF by default; this suite opts in. Auto-AWB stays off
// unless a section switches it on.
const BASE_CAPS = { reverseShipmentsEnabled: true, reverseAutoAwbEnabled: false };
let restoreCapabilities = await pinShiprocketCapabilities(BASE_CAPS);

const OrderModel = (await import("../../src/modules/orders/Order.model.js")).default;
const ProductModel = (await import("../../src/modules/products/Product.model.js")).default;
const ReturnModel = (await import("../../src/modules/returns/return.model.js")).default;
const UserModel = (await import("../../src/model/User.model.js")).default;
const AuditLog = (await import("../../src/modules/audit/AuditLog.model.js")).default;
const returnController = await import("../../src/modules/returns/return.controller.js");
const shippingController = await import("../../src/modules/shipping/shipping.controller.js");
const { clearPickupLocationCache } = await import("../../src/modules/shipping/shiprocket.service.js");

await OrderModel.init();
// Builds return_pickupAwb_unique / return_replacementAwb_unique, which AWB_IN_USE relies on.
await ReturnModel.init();

const MARKER = marker("revawb");
const trash = { orders: [], products: [], returns: [], users: [] };
let seq = 0;
// Shipment ids in a per-process band, so parallel runs never share one.
const SHIPMENT_BASE = 770_000_000 + (process.pid % 100_000) * 1_000;

// ---------------------------------------------------------------- boundary stubs

clearPickupLocationCache();
const realFetch = globalThis.fetch;
let calls = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const ROUTES = {
  login: "/auth/login",
  pickupList: "/settings/company/pickup",
  createReturn: "/orders/create/return",
  createAdhoc: "/orders/create/adhoc",
  assignAwb: "/courier/assign/awb",
  shipment: "/shipments/",
};

const pickupListResponder = () => ({
  status: 200,
  body: {
    data: {
      shipping_address: [
        { pickup_location: "Primary", address: "1 Warehouse Road", city: "Pune", state: "Maharashtra", pin_code: "411001" },
      ],
    },
  },
});
let nextShipmentId = SHIPMENT_BASE + 500;
const bookingOk = () => {
  nextShipmentId += 1;
  return { status: 200, body: { order_id: nextShipmentId + 50_000, shipment_id: nextShipmentId } };
};
let createReturnResponder = bookingOk;
let adhocResponder = bookingOk;
let assignResponder = () => new Error("assign-AWB was not expected in this section");
// GET /shipments/{id}, keyed by id.
const shipmentResponses = new Map();

const jsonResponse = ({ status = 200, body = {} }) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
});

globalThis.fetch = async (url, options) => {
  const href = String(url instanceof URL ? url.href : url);
  const route = Object.entries(ROUTES).find(([, fragment]) => href.includes(fragment))?.[0] || "unknown";
  calls.push({ href, route, method: options?.method || "GET", body: options?.body });
  if (!href.startsWith("https://shiprocket.invalid/")) {
    throw new Error(`unexpected non-Shiprocket call in test: ${href}`);
  }
  let outcome;
  switch (route) {
    case "login":
      return jsonResponse({ status: 200, body: { token: "stub" } });
    case "pickupList":
      outcome = pickupListResponder();
      break;
    case "createReturn":
      await sleep(40);
      outcome = await createReturnResponder(href, options);
      break;
    case "createAdhoc":
      // Every create waits, so concurrent clicks genuinely overlap inside the handler.
      await sleep(40);
      outcome = await adhocResponder(href, options);
      break;
    case "assignAwb":
      outcome = await assignResponder(href, options);
      break;
    case "shipment": {
      const id = Number(new URL(href).pathname.split("/").pop());
      if (!shipmentResponses.has(id)) throw new Error(`unexpected shipment lookup in test: ${href}`);
      outcome = shipmentResponses.get(id);
      break;
    }
    default:
      throw new Error(`unexpected Shiprocket call in test: ${href}`);
  }
  if (outcome instanceof Error) throw outcome;
  return jsonResponse(outcome);
};

const resetCalls = () => {
  calls = [];
};
const callsTo = (route) => calls.filter((c) => c.route === route);

const repin = async (overrides = {}) => {
  restoreCapabilities();
  restoreCapabilities = await pinShiprocketCapabilities({ ...BASE_CAPS, ...overrides });
};

const callController = async (handler, { params = {}, body = {}, user, headers = {} } = {}) => {
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
    { params, body, user, query: {}, headers, ip: "127.0.0.1", get: (name) => headers[String(name).toLowerCase()] },
    res,
  );
  return { statusCode, body: payload };
};

/** Drives the real webhook, including its x-api-key check. */
const sendWebhook = (body, token = "stub-webhook-token") =>
  callController(shippingController.ShippingWebhook, { body, headers: { "x-api-key": token } });

const adminUser = () => ({ id: String(new mongoose.Types.ObjectId()), roles: ["admin"] });

const makeReturn = async ({ status = "approved", resolutionType = "refund", fields = {} } = {}) => {
  seq += 1;
  const product = await ProductModel.create(productFixture(`${MARKER}-${seq}`, { stock: 20 }));
  trash.products.push(product._id);
  // populate("user", "email") needs a real user document for the booking payload.
  const user = await UserModel.create({
    name: `${MARKER}-user-${seq}`,
    email: `${MARKER}-${seq}@example.test`,
    password: "x".repeat(20),
  });
  trash.users.push(user._id);
  const order = await OrderModel.create({
    user: user._id,
    guestEmail: `${MARKER}-${seq}@example.test`,
    idempotencyKey: `${MARKER}-key-${seq}-aaaaaaaaaaaaaaaa`,
    items: [{ product: product._id, name: product.name, image: "x.png", price: 500, quantity: 2 }],
    shippingAddress: addressFixture(),
    paymentMethod: "COD",
    paymentStatus: "Paid",
    orderStatus: "Delivered",
    deliveredAt: new Date(),
    subtotal: 1000,
    totalAmount: 1000,
  });
  trash.orders.push(order._id);

  const returnRequest = await ReturnModel.create({
    order: order._id,
    user: user._id,
    product: product._id,
    productSnapshot: { name: product.name, image: "x.png", price: 500 },
    quantity: 1,
    reason: "damaged on arrival",
    refundAmount: 500,
    resolutionType,
    status,
    returnNumber: `${MARKER}-RET-${seq}`,
    ...fields,
  });
  trash.returns.push(returnRequest._id);
  return { returnRequest, order };
};

const reload = (returnRequest) => ReturnModel.findById(returnRequest._id).lean();
const record = (handler, returnRequest, body) =>
  callController(handler, { params: { id: String(returnRequest._id) }, body, user: adminUser() });
const recordPickup = (returnRequest, body) => record(returnController.RecordReturnPickupAwb, returnRequest, body);
const recordReplacement = (returnRequest, body) => record(returnController.RecordReplacementAwb, returnRequest, body);
const syncPickup = (returnRequest) =>
  callController(returnController.SyncReturnPickupAwb, { params: { id: String(returnRequest._id) }, user: adminUser() });
const syncReplacement = (returnRequest) =>
  callController(returnController.SyncReplacementAwb, { params: { id: String(returnRequest._id) }, user: adminUser() });
const bookPickup = (returnRequest) =>
  callController(returnController.BookReturnPickup, { params: { id: String(returnRequest._id) }, user: adminUser() });
const bookReplacement = (returnRequest) =>
  callController(returnController.BookReplacementShipment, {
    params: { id: String(returnRequest._id) },
    user: adminUser(),
  });
const auditRows = (returnRequest, action = "RECORD_RETURN_AWB") =>
  AuditLog.countDocuments({ targetId: returnRequest._id, action });
const parseBody = (call) => {
  try {
    return JSON.parse(call?.body || "{}");
  } catch {
    return {};
  }
};

try {
  // ═══════════════════════════════════════════════════════════════════════════
  section("1 — recording the pickup AWB by hand");
  {
    const { returnRequest } = await makeReturn({ status: "pickup_scheduled" });
    const awb = `RPK-${MARKER}-1`;
    const event = { awb, shipment_status_id: 18, shipment_status: "IN TRANSIT" };

    // Before the AWB is on the return, nothing can match the courier's event.
    resetCalls();
    const before = await sendWebhook(event);
    let after = await reload(returnRequest);
    ok("before recording: the webhook answers 200 but ignores the event",
      before.statusCode === 200 && before.body?.ignored === true
        && ["no_match", "no_return_match"].includes(before.body?.reason),
      `${before.statusCode} ${JSON.stringify(before.body)}`);
    ok("…and writes nothing to the return", !after.pickupCourierStatus && after.status === "pickup_scheduled",
      JSON.stringify({ c: after.pickupCourierStatus, s: after.status }));

    for (const bad of ["ab", "has space", "", "AWB/123", "x".repeat(65)]) {
      const res = await recordPickup(returnRequest, { awb: bad });
      ok(`invalid AWB ${JSON.stringify(bad.length > 12 ? `${bad.slice(0, 6)}…(${bad.length})` : bad)} → 400 AWB_REQUIRED`,
        res.statusCode === 400 && res.body?.code === "AWB_REQUIRED", `${res.statusCode} ${JSON.stringify(res.body)}`);
    }
    after = await reload(returnRequest);
    ok("…none of them stored anything", !after.pickupAwb && (await auditRows(returnRequest)) === 0,
      JSON.stringify({ awb: after.pickupAwb }));

    const invalidId = await callController(returnController.RecordReturnPickupAwb, {
      params: { id: "not-an-id" }, body: { awb }, user: adminUser(),
    });
    ok("an invalid return id → 400", invalidId.statusCode === 400, String(invalidId.statusCode));

    const first = await recordPickup(returnRequest, { awb: `  ${awb}  `, courier: "Delhivery" });
    after = await reload(returnRequest);
    ok("a valid AWB → 200 success:true", first.statusCode === 200 && first.body?.success === true,
      `${first.statusCode} ${JSON.stringify(first.body?.message)}`);
    ok("…pickupAwb stored (trimmed), courier stored", after.pickupAwb === awb && after.pickupCourier === "Delhivery",
      JSON.stringify({ a: after.pickupAwb, c: after.pickupCourier }));
    ok("…the response carries the updated return", first.body?.data?.pickupAwb === awb, JSON.stringify(first.body?.data?.pickupAwb));
    ok("…the return status is unchanged", after.status === "pickup_scheduled", after.status);
    const notes = (after.statusHistory || []).filter((h) => (h.note || "").includes(awb));
    ok("…a statusHistory note names the AWB", notes.length === 1 && /recorded/i.test(notes[0].note)
      && notes[0].status === "pickup_scheduled", JSON.stringify((after.statusHistory || []).map((h) => h.note)));
    ok("…one AuditLog row RECORD_RETURN_AWB", (await auditRows(returnRequest)) === 1, String(await auditRows(returnRequest)));
    ok("…recording contacts nobody", calls.length === 0, JSON.stringify(calls.map((c) => c.href)));

    const again = await recordPickup(returnRequest, { awb });
    after = await reload(returnRequest);
    ok("the same AWB again → 200 (idempotent)", again.statusCode === 200 && again.body?.success === true,
      `${again.statusCode} ${JSON.stringify(again.body?.message)}`);
    ok("…no second history note, no second audit row",
      (after.statusHistory || []).filter((h) => (h.note || "").includes(awb)).length === 1
        && (await auditRows(returnRequest)) === 1,
      JSON.stringify((after.statusHistory || []).map((h) => h.note)));

    const different = await recordPickup(returnRequest, { awb: `RPK-${MARKER}-OTHER` });
    after = await reload(returnRequest);
    ok("a different AWB → 409 AWB_ALREADY_RECORDED",
      different.statusCode === 409 && different.body?.code === "AWB_ALREADY_RECORDED",
      `${different.statusCode} ${JSON.stringify(different.body)}`);
    ok("…and the original is kept", after.pickupAwb === awb, after.pickupAwb);

    const { returnRequest: other } = await makeReturn({ status: "pickup_scheduled" });
    const inUse = await recordPickup(other, { awb });
    const otherAfter = await reload(other);
    ok("an AWB already used by another return → 409 AWB_IN_USE",
      inUse.statusCode === 409 && inUse.body?.code === "AWB_IN_USE", `${inUse.statusCode} ${JSON.stringify(inUse.body)}`);
    ok("…and the other return is untouched", !otherAfter.pickupAwb && (await auditRows(other)) === 0,
      JSON.stringify({ a: otherAfter.pickupAwb }));

    const { returnRequest: approved } = await makeReturn({ status: "approved" });
    const notBooked = await recordPickup(approved, { awb: `RPK-${MARKER}-APPR` });
    ok("a return still at approved → 409 RETURN_LEG_NOT_BOOKED",
      notBooked.statusCode === 409 && notBooked.body?.code === "RETURN_LEG_NOT_BOOKED",
      `${notBooked.statusCode} ${JSON.stringify(notBooked.body)}`);
    ok("…nothing stored", !(await reload(approved)).pickupAwb);

    // And the point of it all: the courier's event now resolves to the return.
    resetCalls();
    const resolved = await sendWebhook(event);
    after = await reload(returnRequest);
    ok("after recording: the same webhook → 200 scope 'return', leg pickup",
      resolved.statusCode === 200 && resolved.body?.scope === "return" && resolved.body?.leg === "pickup",
      `${resolved.statusCode} ${JSON.stringify(resolved.body)}`);
    ok("…pickupCourierStatus written", after.pickupCourierStatus === "IN TRANSIT", String(after.pickupCourierStatus));
    ok("…pickupCourierUpdatedAt stamped", Boolean(after.pickupCourierUpdatedAt));
    ok("…return status unchanged", after.status === "pickup_scheduled", after.status);
    ok("…the webhook contacts nobody", calls.length === 0, JSON.stringify(calls.map((c) => c.href)));

    const wrongToken = await sendWebhook(event, "wrong-token");
    ok("a webhook with the wrong x-api-key → 401", wrongToken.statusCode === 401, String(wrongToken.statusCode));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("2 — recording the replacement AWB by hand");
  {
    const { returnRequest } = await makeReturn({ status: "received", resolutionType: "replacement" });
    const awb = `RRP-${MARKER}-1`;
    const event = { awb, shipment_status_id: 17, shipment_status: "OUT FOR DELIVERY" };

    const before = await sendWebhook(event);
    ok("before recording: the webhook ignores the event",
      before.statusCode === 200 && before.body?.ignored === true
        && ["no_match", "no_return_match"].includes(before.body?.reason),
      `${before.statusCode} ${JSON.stringify(before.body)}`);

    const bad = await recordReplacement(returnRequest, { awb: "has space" });
    ok("invalid AWB → 400 AWB_REQUIRED", bad.statusCode === 400 && bad.body?.code === "AWB_REQUIRED",
      `${bad.statusCode} ${JSON.stringify(bad.body)}`);
    const short = await recordReplacement(returnRequest, { awb: "ab" });
    ok("too short → 400 AWB_REQUIRED", short.statusCode === 400 && short.body?.code === "AWB_REQUIRED",
      `${short.statusCode} ${JSON.stringify(short.body)}`);

    const first = await recordReplacement(returnRequest, { awb, courier: "Bluedart" });
    let after = await reload(returnRequest);
    ok("a valid AWB at received → 200", first.statusCode === 200 && first.body?.success === true,
      `${first.statusCode} ${JSON.stringify(first.body?.message)}`);
    ok("…replacementAwb and courier stored", after.replacementAwb === awb && after.replacementCourier === "Bluedart",
      JSON.stringify({ a: after.replacementAwb, c: after.replacementCourier }));
    ok("…pickupAwb untouched", !after.pickupAwb, String(after.pickupAwb));
    ok("…status unchanged", after.status === "received", after.status);
    ok("…history note", (after.statusHistory || []).filter((h) => (h.note || "").includes(awb)).length === 1,
      JSON.stringify((after.statusHistory || []).map((h) => h.note)));
    ok("…one AuditLog row RECORD_RETURN_AWB", (await auditRows(returnRequest)) === 1, String(await auditRows(returnRequest)));

    const again = await recordReplacement(returnRequest, { awb });
    ok("the same AWB again → 200 (idempotent)", again.statusCode === 200 && (await auditRows(returnRequest)) === 1,
      `${again.statusCode}`);
    const different = await recordReplacement(returnRequest, { awb: `RRP-${MARKER}-OTHER` });
    ok("a different AWB → 409 AWB_ALREADY_RECORDED",
      different.statusCode === 409 && different.body?.code === "AWB_ALREADY_RECORDED",
      `${different.statusCode} ${JSON.stringify(different.body)}`);

    const { returnRequest: other } = await makeReturn({ status: "received", resolutionType: "replacement" });
    const inUse = await recordReplacement(other, { awb });
    ok("an AWB used by another return's replacement → 409 AWB_IN_USE",
      inUse.statusCode === 409 && inUse.body?.code === "AWB_IN_USE", `${inUse.statusCode} ${JSON.stringify(inUse.body)}`);

    const { returnRequest: early } = await makeReturn({ status: "pickup_scheduled", resolutionType: "replacement" });
    const notBooked = await recordReplacement(early, { awb: `RRP-${MARKER}-EARLY` });
    ok("a return not yet received → 409 RETURN_LEG_NOT_BOOKED",
      notBooked.statusCode === 409 && notBooked.body?.code === "RETURN_LEG_NOT_BOOKED",
      `${notBooked.statusCode} ${JSON.stringify(notBooked.body)}`);

    const resolved = await sendWebhook(event);
    after = await reload(returnRequest);
    ok("after recording: the webhook → scope 'return', leg replacement",
      resolved.statusCode === 200 && resolved.body?.scope === "return" && resolved.body?.leg === "replacement",
      `${resolved.statusCode} ${JSON.stringify(resolved.body)}`);
    ok("…replacementCourierStatus written", after.replacementCourierStatus === "OUT FOR DELIVERY",
      String(after.replacementCourierStatus));
    ok("…status unchanged", after.status === "received", after.status);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("3 — syncing the AWB from Shiprocket");
  {
    const shipmentId = SHIPMENT_BASE + 1;
    const { returnRequest } = await makeReturn({ status: "pickup_scheduled", fields: { pickupShipmentId: shipmentId } });
    const awb = `RTN-${MARKER}`;

    shipmentResponses.set(shipmentId, { status: 200, body: { data: { awb: "", courier: "" } } });
    resetCalls();
    const notYet = await syncPickup(returnRequest);
    let after = await reload(returnRequest);
    ok("Shiprocket has no AWB yet → 200 synced:false", notYet.statusCode === 200 && notYet.body?.synced === false,
      `${notYet.statusCode} ${JSON.stringify(notYet.body?.message)}`);
    ok("…nothing stored", !after.pickupAwb, String(after.pickupAwb));
    ok("…asked GET /shipments/<id>", callsTo("shipment").length === 1
      && callsTo("shipment")[0].href.endsWith(`/shipments/${shipmentId}`), JSON.stringify(calls.map((c) => c.href)));

    shipmentResponses.set(shipmentId, { status: 200, body: { data: { awb, courier: "Delhivery" } } });
    resetCalls();
    const synced = await syncPickup(returnRequest);
    after = await reload(returnRequest);
    ok("an assigned AWB → 200 synced:true", synced.statusCode === 200 && synced.body?.synced === true,
      `${synced.statusCode} ${JSON.stringify(synced.body?.message)}`);
    ok("…pickupAwb and courier stored", after.pickupAwb === awb && after.pickupCourier === "Delhivery",
      JSON.stringify({ a: after.pickupAwb, c: after.pickupCourier }));
    ok("…with a history note", (after.statusHistory || []).some((h) => (h.note || "").includes(awb)),
      JSON.stringify((after.statusHistory || []).map((h) => h.note)));
    ok("…status unchanged", after.status === "pickup_scheduled", after.status);

    resetCalls();
    const repeat = await syncPickup(returnRequest);
    ok("syncing again → 200 synced:false (already recorded), no Shiprocket call",
      repeat.statusCode === 200 && repeat.body?.synced === false && callsTo("shipment").length === 0,
      `${repeat.statusCode} ${JSON.stringify(repeat.body?.message)} calls=${callsTo("shipment").length}`);

    const resolved = await sendWebhook({ awb, shipment_status_id: 42, shipment_status: "PICKED UP" });
    ok("a synced AWB resolves webhook events to the return",
      resolved.body?.scope === "return" && resolved.body?.leg === "pickup", JSON.stringify(resolved.body));

    const { returnRequest: unbooked } = await makeReturn({ status: "pickup_scheduled" });
    resetCalls();
    const notBooked = await syncPickup(unbooked);
    ok("no shipment id → 409 RETURN_LEG_NOT_BOOKED, no Shiprocket call",
      notBooked.statusCode === 409 && notBooked.body?.code === "RETURN_LEG_NOT_BOOKED" && callsTo("shipment").length === 0,
      `${notBooked.statusCode} ${JSON.stringify(notBooked.body)}`);

    const offId = SHIPMENT_BASE + 2;
    const { returnRequest: offReturn } = await makeReturn({ status: "pickup_scheduled", fields: { pickupShipmentId: offId } });
    shipmentResponses.set(offId, { status: 200, body: { data: { awb: `RTN-${MARKER}-OFF`, courier: "X" } } });
    await repin({ shipmentsEnabled: false });
    let off;
    try {
      resetCalls();
      off = await syncPickup(offReturn);
    } finally {
      await repin();
    }
    ok("shipments capability off → 409 SHIPROCKET_NOT_IN_USE",
      off.statusCode === 409 && off.body?.code === "SHIPROCKET_NOT_IN_USE", `${off.statusCode} ${JSON.stringify(off.body)}`);
    ok("…no Shiprocket call and nothing stored", calls.length === 0 && !(await reload(offReturn)).pickupAwb,
      JSON.stringify(calls.map((c) => c.href)));

    // Shiprocket hands back an AWB another return already holds.
    const clashId = SHIPMENT_BASE + 3;
    const { returnRequest: clash } = await makeReturn({ status: "pickup_scheduled", fields: { pickupShipmentId: clashId } });
    shipmentResponses.set(clashId, { status: 200, body: { data: { awb, courier: "Delhivery" } } });
    const clashed = await syncPickup(clash);
    ok("a synced AWB already on another return → 409 AWB_IN_USE",
      clashed.statusCode === 409 && clashed.body?.code === "AWB_IN_USE" && !(await reload(clash)).pickupAwb,
      `${clashed.statusCode} ${JSON.stringify(clashed.body)}`);

    // The replacement leg reads the replacement shipment id.
    const repId = SHIPMENT_BASE + 4;
    const { returnRequest: rep } = await makeReturn({
      status: "received", resolutionType: "replacement", fields: { replacementShipmentId: repId },
    });
    shipmentResponses.set(repId, { status: 200, body: { data: { awb_code: `RTN-${MARKER}-REP`, courier_name: "Ekart" } } });
    resetCalls();
    const repSynced = await syncReplacement(rep);
    const repAfter = await reload(rep);
    ok("replacement leg: synced:true from the replacement shipment",
      repSynced.statusCode === 200 && repSynced.body?.synced === true && repAfter.replacementAwb === `RTN-${MARKER}-REP`
        && repAfter.replacementCourier === "Ekart" && !repAfter.pickupAwb
        && callsTo("shipment")[0]?.href.endsWith(`/shipments/${repId}`),
      `${repSynced.statusCode} ${JSON.stringify({ a: repAfter.replacementAwb, c: repAfter.replacementCourier })}`);
    const { returnRequest: repUnbooked } = await makeReturn({ status: "received", resolutionType: "replacement" });
    const repNotBooked = await syncReplacement(repUnbooked);
    ok("replacement leg not booked → 409 RETURN_LEG_NOT_BOOKED",
      repNotBooked.statusCode === 409 && repNotBooked.body?.code === "RETURN_LEG_NOT_BOOKED",
      `${repNotBooked.statusCode} ${JSON.stringify(repNotBooked.body)}`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("4 — auto-assigning the AWB when the pickup is booked");
  {
    await repin({ reverseAutoAwbEnabled: true });
    try {
      const { returnRequest } = await makeReturn({ status: "approved" });
      const autoAwb = `AUTO-${MARKER}`;
      assignResponder = () => ({
        status: 200,
        body: { awb_assign_status: 1, response: { data: { awb_code: autoAwb, courier_name: "X" } } },
      });
      resetCalls();
      const booked = await bookPickup(returnRequest);
      const after = await reload(returnRequest);
      ok("booking with auto-AWB on → 200", booked.statusCode === 200 && booked.body?.success === true,
        `${booked.statusCode} ${JSON.stringify(booked.body?.message || booked.body)}`);
      ok("…one return booking, then one assign call",
        callsTo("createReturn").length === 1 && callsTo("assignAwb").length === 1,
        `create=${callsTo("createReturn").length} assign=${callsTo("assignAwb").length}`);
      const assignBody = parseBody(callsTo("assignAwb")[0]);
      ok("…the assign request carries is_return: 1", assignBody.is_return === 1, JSON.stringify(assignBody));
      ok("…for the shipment just booked", Number(assignBody.shipment_id) === Number(after.pickupShipmentId)
        && Boolean(after.pickupShipmentId), JSON.stringify({ body: assignBody, stored: after.pickupShipmentId }));
      ok("…pickupAwb is the assigned AUTO-… and the courier is stored",
        after.pickupAwb === autoAwb && after.pickupCourier === "X", JSON.stringify({ a: after.pickupAwb, c: after.pickupCourier }));
      ok("…status pickup_scheduled", after.status === "pickup_scheduled", after.status);
      ok("…the response's return carries the AWB", booked.body?.returnRequest?.pickupAwb === autoAwb,
        JSON.stringify(booked.body?.returnRequest?.pickupAwb));

      const resolved = await sendWebhook({ awb: autoAwb, shipment_status_id: 19, shipment_status: "OUT FOR PICKUP" });
      ok("an auto-assigned AWB resolves webhook events immediately",
        resolved.body?.scope === "return" && resolved.body?.leg === "pickup", JSON.stringify(resolved.body));

      // The assign call fails: the parcel is booked regardless.
      const { returnRequest: failing } = await makeReturn({ status: "approved" });
      assignResponder = () => ({ status: 500, body: { message: "assign exploded" } });
      resetCalls();
      const stillBooked = await bookPickup(failing);
      const failingAfter = await reload(failing);
      ok("assign HTTP 500 → booking still 200", stillBooked.statusCode === 200 && stillBooked.body?.success === true,
        `${stillBooked.statusCode} ${JSON.stringify(stillBooked.body)}`);
      ok("…the assign was attempted", callsTo("assignAwb").length === 1, String(callsTo("assignAwb").length));
      ok("…pickupAwb unset, shipment and status recorded",
        !failingAfter.pickupAwb && Boolean(failingAfter.pickupShipmentId) && failingAfter.status === "pickup_scheduled",
        JSON.stringify({ a: failingAfter.pickupAwb, id: failingAfter.pickupShipmentId, s: failingAfter.status }));
      ok("…and the claim is cleared", failingAfter.pickupBookingClaimedAt === null, String(failingAfter.pickupBookingClaimedAt));

      // A transport error on assign is no different.
      const { returnRequest: transport } = await makeReturn({ status: "approved" });
      assignResponder = () => new Error("socket hang up");
      const transportBooked = await bookPickup(transport);
      ok("assign transport error → booking still 200, no AWB",
        transportBooked.statusCode === 200 && !(await reload(transport)).pickupAwb,
        `${transportBooked.statusCode} ${JSON.stringify(transportBooked.body?.message)}`);

      // Replacement leg with auto-AWB: assigned, but NOT flagged as a return.
      const { returnRequest: rep } = await makeReturn({ status: "received", resolutionType: "replacement" });
      assignResponder = () => ({
        status: 200,
        body: { awb_assign_status: 1, response: { data: { awb_code: `AUTO-${MARKER}-REP`, courier_name: "Y" } } },
      });
      resetCalls();
      const repBooked = await bookReplacement(rep);
      const repAfter = await reload(rep);
      const repAssign = parseBody(callsTo("assignAwb")[0]);
      ok("replacement booking with auto-AWB → 200 and replacementAwb stored",
        repBooked.statusCode === 200 && repAfter.replacementAwb === `AUTO-${MARKER}-REP`,
        `${repBooked.statusCode} ${JSON.stringify({ a: repAfter.replacementAwb })}`);
      ok("…its assign request is NOT flagged is_return", callsTo("assignAwb").length === 1 && !("is_return" in repAssign),
        JSON.stringify(repAssign));
    } finally {
      await repin();
      assignResponder = () => new Error("assign-AWB was not expected in this section");
    }

    // Switch off (the default): no assign call at all.
    const { returnRequest: plain } = await makeReturn({ status: "approved" });
    resetCalls();
    const booked = await bookPickup(plain);
    const after = await reload(plain);
    ok("auto-AWB off → booking 200", booked.statusCode === 200, `${booked.statusCode} ${JSON.stringify(booked.body)}`);
    ok("…no assign call", callsTo("assignAwb").length === 0 && callsTo("createReturn").length === 1,
      `assign=${callsTo("assignAwb").length} create=${callsTo("createReturn").length}`);
    ok("…pickupAwb unset", !after.pickupAwb && after.status === "pickup_scheduled",
      JSON.stringify({ a: after.pickupAwb, s: after.status }));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("5 — concurrent replacement bookings make one Shiprocket call");
  {
    const { returnRequest } = await makeReturn({ status: "received", resolutionType: "replacement" });
    resetCalls();
    const results = await Promise.all(Array.from({ length: 5 }, () => bookReplacement(returnRequest)));
    const after = await reload(returnRequest);
    ok("five simultaneous clicks → exactly ONE /orders/create/adhoc call", callsTo("createAdhoc").length === 1,
      `calls=${callsTo("createAdhoc").length}`);
    ok("exactly one click reports the booking",
      results.filter((r) => r.statusCode === 200 && !r.body?.alreadyBooked).length === 1,
      JSON.stringify(results.map((r) => [r.statusCode, r.body?.code, r.body?.alreadyBooked])));
    ok("the others are alreadyBooked or BOOKING_IN_PROGRESS",
      results.every((r) => (r.statusCode === 200) || r.body?.code === "BOOKING_IN_PROGRESS"),
      JSON.stringify(results.map((r) => [r.statusCode, r.body?.code])));
    ok("one shipment stored, claim cleared, status untouched",
      Boolean(after.replacementShipmentId) && after.replacementBookingClaimedAt === null && after.status === "received",
      JSON.stringify({ id: after.replacementShipmentId, c: after.replacementBookingClaimedAt, s: after.status }));
  }
} catch (error) {
  console.error(`\nSUITE ABORTED: ${error?.stack || error}`);
  ok("suite ran to completion", false, error?.message);
} finally {
  globalThis.fetch = realFetch;
  restoreCapabilities();

  await Promise.all([
    OrderModel.deleteMany({ _id: { $in: trash.orders } }),
    ProductModel.deleteMany({ _id: { $in: trash.products } }),
    ReturnModel.deleteMany({ _id: { $in: trash.returns } }),
    UserModel.deleteMany({ _id: { $in: trash.users } }),
    AuditLog.deleteMany({ targetId: { $in: trash.returns } }),
  ]);
  const leftovers =
    (await OrderModel.countDocuments({ idempotencyKey: new RegExp(MARKER) })) +
    (await ProductModel.countDocuments({ name: new RegExp(MARKER) })) +
    (await ReturnModel.countDocuments({ returnNumber: new RegExp(MARKER) })) +
    (await UserModel.countDocuments({ name: new RegExp(MARKER) })) +
    (await AuditLog.countDocuments({ targetId: { $in: trash.returns } }));
  ok("every fixture this suite created is gone", leftovers === 0, `leftovers=${leftovers}`);

  const { failed } = finish();
  await mongoose.disconnect();
  process.exit(failed ? 1 : 0);
}
