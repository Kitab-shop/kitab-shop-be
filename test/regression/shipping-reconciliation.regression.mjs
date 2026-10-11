/**
 * The shipping reconciliation pass (shipping-reconciliation.service.js) — the safety net
 * under the courier webhook.
 *
 * Covers the plan's Phase 3 verification row `shipping-reconciliation`:
 *
 *   1. gating: settings switch, env kill switch, Shiprocket not in use — and the admin
 *      "Run now" endpoint reports each one;
 *   2. the in-process `running` guard: a second pass (scheduled or admin) never overlaps;
 *   3. tracking polls un-stall an order (catch-up, COD Paid), respect the stale window,
 *      and never poll MANUAL shipments;
 *   4. courier cancellation retries back off, become an exception after the limit, and
 *      stop;
 *   5. a 429 (or Shiprocket being unreachable) halts the pass;
 *   6. auto-push retries only `failed` / recently-missed orders, never `creating`, never
 *      inside the grace window or past the missed window, and not at all when auto-push
 *      is off;
 *   7. return-leg AWBs are fetched and stored, never overwriting an admin's AWB;
 *   8. getReconciliationStatus reports the last completed pass.
 *
 * Run with `npm run test:shipping-reconciliation` (or `npm test`).
 *
 * The database is a SHARED dev database with real orders: every pass is called with a
 * `scope` naming only the orders and returns this suite created, and the admin
 * "Run now" handler (which takes no scope) is only exercised in states where it returns
 * before touching anything.
 *
 * `globalThis.fetch` is stubbed at the HTTP boundary and routes by URL; unknown URLs
 * throw, and every call is counted per route.
 */
process.env.SHIPROCKET_ENABLED = "true";
process.env.SHIPROCKET_AUTO_CREATE_ORDER = "true";
process.env.SHIPROCKET_WEBHOOK_ENABLED = "true";
process.env.SHIPROCKET_WEBHOOK_TOKEN = "stub-webhook-token";
process.env.SHIPROCKET_EMAIL = "stub@example.test";
process.env.SHIPROCKET_PASSWORD = "stub-password";
process.env.SHIPROCKET_BASE_URL = "https://shiprocket.invalid/v1/external";
process.env.NOTIFICATIONS_ENABLED = "false";
process.env.PAYMENTS_ENABLED = "false";
// A developer's .env must not silently switch the subject of this suite off.
delete process.env.SHIPPING_RECONCILE_ENABLED;

import mongoose from "mongoose";
import {
  addressFixture,
  connect,
  createSuite,
  marker,
  pinShiprocketCapabilities,
  productFixture,
} from "./helpers.mjs";

const { ok, section, finish } = createSuite("shipping-reconciliation");
await connect();
let restoreCapabilities = await pinShiprocketCapabilities();
/** Re-pins capabilities/settings with different overrides for one scenario. */
const repin = async (overrides = {}) => {
  restoreCapabilities();
  restoreCapabilities = await pinShiprocketCapabilities(overrides);
};

const OrderModel = (await import("../../src/modules/orders/Order.model.js")).default;
const ProductModel = (await import("../../src/modules/products/Product.model.js")).default;
const ReturnModel = (await import("../../src/modules/returns/return.model.js")).default;
const UserModel = (await import("../../src/model/User.model.js")).default;
const AuditLog = (await import("../../src/modules/audit/AuditLog.model.js")).default;
const BillCounter = (await import("../../src/modules/orders/BillCounter.model.js")).default;
await import("../../src/modules/categories/Category.model.js");
const { financialYear } = await import("../../src/modules/orders/bill-number.service.js");
const {
  runReconciliationPass,
  syncReturnLegAwb,
  backoffDelayMs,
  getReconciliationStatus,
} = await import("../../src/modules/shipping/shipping-reconciliation.service.js");
const opsController = await import("../../src/modules/shipping/shipping-ops.controller.js");

await OrderModel.init();
await ReturnModel.init().catch(() => {});

// Delivered events mint bill numbers in the LIVE financial year. Captured here and
// rewound in finally, exactly as courier-event-pipeline does.
const LIVE_FY = financialYear();
const liveCounterBefore = (await BillCounter.findOne({ financialYear: LIVE_FY }).lean())?.seq ?? null;
const suiteStartedAt = new Date();

// ── Shiprocket stub ─────────────────────────────────────────────────────────
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// Shiprocket ids are uniquely indexed across the collection: namespaced per process.
const ID_BASE = 660_000_000 + (process.pid % 100_000) * 100;
let idSeq = 0;
const nextId = () => {
  idSeq += 1;
  return ID_BASE + idSeq;
};

const sr = {
  calls: { login: 0, track: 0, cancel: 0, adhoc: 0, show: 0, shipments: 0 },
  trackCalls: [], // AWBs, in call order
  cancelCalls: [], // shiprocket order ids
  adhocCalls: [], // our order ids (payload.order_id)
  shipmentCalls: [], // shipment ids
  unknown: [],
  track: new Map(), // awb → async responder
  cancel: new Map(), // shiprocket order id → async responder
  adhoc: new Map(), // our order id → async responder
  shipments: new Map(), // shipment id → async responder
};
const totalCalls = () => Object.values(sr.calls).reduce((a, b) => a + b, 0) + sr.unknown.length;
const tracked = (awb) => sr.trackCalls.filter((a) => a === awb).length;
const cancelledAt = (srOrderId) => sr.cancelCalls.filter((id) => id === srOrderId).length;
const pushed = (order) => sr.adhocCalls.filter((id) => id === String(order._id)).length;
const fetchedShipment = (id) => sr.shipmentCalls.filter((s) => s === id).length;

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = String(input instanceof URL ? input.href : input);
  const path = url.replace(/^https:\/\/shiprocket\.invalid\/v1\/external/, "").split("?")[0];
  if (path === "/auth/login") {
    sr.calls.login += 1;
    return jsonResponse({ token: "stub-token" });
  }
  let match;
  if ((match = /^\/courier\/track\/awb\/(.+)$/.exec(path))) {
    const awb = decodeURIComponent(match[1]);
    sr.calls.track += 1;
    sr.trackCalls.push(awb);
    const responder = sr.track.get(awb);
    if (!responder) throw new Error(`No track responder for AWB ${awb}`);
    return responder();
  }
  if (path === "/orders/cancel") {
    const ids = JSON.parse(init.body || "{}").ids || [];
    sr.calls.cancel += 1;
    ids.forEach((id) => sr.cancelCalls.push(Number(id)));
    const responder = sr.cancel.get(Number(ids[0]));
    if (!responder) throw new Error(`No cancel responder for Shiprocket order ${ids[0]}`);
    return responder();
  }
  if (path === "/orders/create/adhoc") {
    const payload = JSON.parse(init.body || "{}");
    sr.calls.adhoc += 1;
    sr.adhocCalls.push(String(payload.order_id));
    const responder = sr.adhoc.get(String(payload.order_id));
    if (responder) return responder(payload);
    const id = nextId();
    return jsonResponse({ order_id: id, shipment_id: id + 50_000_000, status: "NEW", status_code: 1 });
  }
  if ((match = /^\/orders\/show\/(\d+)$/.exec(path))) {
    sr.calls.show += 1;
    return jsonResponse({ data: { id: Number(match[1]), net_total: 540 } });
  }
  if ((match = /^\/shipments\/(\d+)$/.exec(path))) {
    const id = Number(match[1]);
    sr.calls.shipments += 1;
    sr.shipmentCalls.push(id);
    const responder = sr.shipments.get(id);
    if (!responder) throw new Error(`No shipment responder for ${id}`);
    return responder();
  }
  sr.unknown.push(url);
  throw new Error(`Unexpected Shiprocket call in tests: ${url}`);
};

// ── Fixtures ────────────────────────────────────────────────────────────────
const MARKER = marker("shiprecon");
const trash = { orders: [], products: [], users: [], returns: [] };
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const customer = await UserModel.create({
  name: `${MARKER} customer`,
  email: `${MARKER}@test.local`,
  password: "x".repeat(60),
  roles: ["user"],
});
trash.users.push(customer._id);
const product = await ProductModel.create(
  productFixture(`${MARKER}-book`, { stock: 500, weight: 0.4, length: 20, breadth: 15, height: 3 }),
);
trash.products.push(product._id);

let awbSeq = 0;
const nextAwb = () => {
  awbSeq += 1;
  return `AWB-${MARKER}-${awbSeq}`;
};

/**
 * An order owned by this suite. `createdAt` is written straight to the collection after
 * creation, because Mongoose treats it as immutable and would drop it from an update.
 */
const makeOrder = async ({
  orderStatus = "Packed",
  paymentMethod = "COD",
  paymentStatus = "Pending",
  shiprocket = null,
  createdAt = null,
  ...fields
} = {}) => {
  const order = await OrderModel.create({
    user: customer._id,
    items: [{ product: product._id, name: product.name, image: "x.png", price: 250, quantity: 2 }],
    shippingAddress: addressFixture(),
    paymentMethod,
    paymentStatus,
    orderStatus,
    subtotal: 500,
    shippingCharge: 40,
    totalAmount: 540,
    ...(shiprocket ? { shiprocket } : {}),
    ...fields,
  });
  trash.orders.push(order._id);
  if (createdAt) await OrderModel.collection.updateOne({ _id: order._id }, { $set: { createdAt } });
  return order;
};

/** A tracked forward shipment: Shiprocket ids, an AWB, last courier update `syncedAgo` ago. */
const makeTrackedOrder = async ({ syncedAgo = 2 * DAY, shiprocket = {}, ...fields } = {}) => {
  const srOrderId = nextId();
  const awbCode = nextAwb();
  const order = await makeOrder({
    shiprocket: {
      orderId: srOrderId,
      shipmentId: srOrderId + 50_000_000,
      awbCode,
      status: "AWB ASSIGNED",
      syncStatus: "awb_assigned",
      lastSyncedAt: syncedAgo === null ? null : new Date(Date.now() - syncedAgo),
      ...shiprocket,
    },
    ...fields,
  });
  return { order, awbCode, srOrderId };
};

let returnSeq = 0;
const makeReturn = async (fields = {}) => {
  returnSeq += 1;
  // One open return per order line is uniquely indexed, so each return gets its own order.
  const parent = await makeOrder({
    orderStatus: "Delivered",
    paymentStatus: "Paid",
    deliveredAt: new Date(Date.now() - DAY),
  });
  const ret = await ReturnModel.create({
    order: parent._id,
    user: customer._id,
    product: product._id,
    productSnapshot: { name: product.name, image: "x.png", price: 250 },
    quantity: 1,
    reason: "damaged on arrival",
    refundAmount: 250,
    resolutionType: "refund",
    status: "pickup_scheduled",
    returnNumber: `${MARKER}-RET-${returnSeq}`,
    ...fields,
  });
  trash.returns.push(ret._id);
  return ret;
};

const reload = (id) => OrderModel.findById(id).lean();
const reloadReturn = (id) => ReturnModel.findById(id).lean();
const hopsOf = (order) => (order.statusHistory || []).map((h) => `${h.from}->${h.to}`);

/**
 * One reconciliation pass, ALWAYS scoped. Both id lists are always present: an absent
 * list means "no restriction" to the service, which on a shared database would
 * reconcile real orders.
 */
const pass = ({ orders = [], returns = [], reason = "regression", now } = {}) =>
  runReconciliationPass({
    reason,
    ...(now === undefined ? {} : { now }),
    scope: {
      orderIds: orders.map((o) => o._id ?? o),
      returnIds: returns.map((r) => r._id ?? r),
    },
  });

const callController = async (handler) => {
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
    { params: {}, body: {}, query: {}, headers: {}, ip: "127.0.0.1", user: { id: String(new mongoose.Types.ObjectId()), roles: ["admin"] } },
    res,
  );
  return { statusCode, body: payload };
};

// IST wall-clock "YYYY-MM-DD HH:mm:ss", the tracking API's activity date shape.
const IST_MS = (5 * 60 + 30) * MINUTE;
const pad = (n) => String(n).padStart(2, "0");
const istYearFirst = (date) => {
  const d = new Date(date.getTime() + IST_MS);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(
    d.getUTCMinutes(),
  )}:${pad(d.getUTCSeconds())}`;
};

const trackingResponse = (awbCode, code, currentStatus, at = new Date(Date.now() - HOUR)) =>
  jsonResponse({
    tracking_data: {
      track_status: 1,
      shipment_status: code,
      shipment_track: [{ awb_code: awbCode, courier_name: "Delhivery", current_status: currentStatus }],
      shipment_track_activities: [{ date: istYearFirst(at), activity: currentStatus, location: "Pune" }],
    },
  });

const waitFor = async (predicate, label, timeoutMs = 5000) => {
  const started = Date.now();
  while (!(await predicate())) {
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

const near = (actual, expected, toleranceMs) =>
  Boolean(actual) && Math.abs(new Date(actual).getTime() - expected) <= toleranceMs;

try {
  // ═══════════════════════════════════════════════════════════════════════════
  section("0 — backoff schedule");
  {
    ok("backoffDelayMs(1) = 5 minutes", backoffDelayMs(1) === 5 * MINUTE, String(backoffDelayMs(1)));
    ok("backoffDelayMs(2) = 10 minutes", backoffDelayMs(2) === 10 * MINUTE, String(backoffDelayMs(2)));
    ok("backoffDelayMs(3) = 20 minutes", backoffDelayMs(3) === 20 * MINUTE, String(backoffDelayMs(3)));
    ok("backoffDelayMs(0) never goes below the base", backoffDelayMs(0) === 5 * MINUTE, String(backoffDelayMs(0)));
    ok("backoffDelayMs is capped at 24h", backoffDelayMs(50) === DAY, String(backoffDelayMs(50)));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("1 — gating: settings switch, env kill switch, Shiprocket not in use");
  {
    // A due order in scope, so "zero calls" means the gate held, not that nothing was due.
    const due = await makeTrackedOrder();
    sr.track.set(due.awbCode, async () => trackingResponse(due.awbCode, 6, "SHIPPED"));

    const statusBefore = getReconciliationStatus();

    await repin({ reconciliationEnabled: false });
    let callsBefore = totalCalls();
    const offInSettings = await pass({ orders: [due.order] });
    ok("reconciliationEnabled false → {ran:false, reason:'disabled_in_settings'}",
      offInSettings.ran === false && offInSettings.reason === "disabled_in_settings", JSON.stringify(offInSettings));
    ok("…zero Shiprocket calls", totalCalls() === callsBefore, `${totalCalls() - callsBefore} calls`);
    const ctlSettings = await callController(opsController.RunShippingReconciliation);
    ok("Run now reports it: 200, ran false, reason disabled_in_settings",
      ctlSettings.statusCode === 200 && ctlSettings.body?.ran === false
        && ctlSettings.body?.reason === "disabled_in_settings" && ctlSettings.body?.success === true,
      JSON.stringify(ctlSettings));
    ok("…with the settings message",
      /switched off under Operations/.test(ctlSettings.body?.message || ""), ctlSettings.body?.message);

    await repin();
    process.env.SHIPPING_RECONCILE_ENABLED = "false";
    callsBefore = totalCalls();
    const offByEnv = await pass({ orders: [due.order] });
    const ctlEnv = await callController(opsController.RunShippingReconciliation);
    delete process.env.SHIPPING_RECONCILE_ENABLED;
    ok("SHIPPING_RECONCILE_ENABLED=false → disabled_by_env",
      offByEnv.ran === false && offByEnv.reason === "disabled_by_env", JSON.stringify(offByEnv));
    ok("…zero Shiprocket calls", totalCalls() === callsBefore, `${totalCalls() - callsBefore} calls`);
    ok("Run now reports it with the env message",
      ctlEnv.statusCode === 200 && ctlEnv.body?.reason === "disabled_by_env"
        && /SHIPPING_RECONCILE_ENABLED=false/.test(ctlEnv.body?.message || ""),
      JSON.stringify(ctlEnv));

    await repin({ shipmentsEnabled: false });
    callsBefore = totalCalls();
    const notInUse = await pass({ orders: [due.order] });
    const ctlNotInUse = await callController(opsController.RunShippingReconciliation);
    ok("shipmentsEnabled false → shiprocket_not_in_use",
      notInUse.ran === false && notInUse.reason === "shiprocket_not_in_use", JSON.stringify(notInUse));
    ok("…zero Shiprocket calls", totalCalls() === callsBefore, `${totalCalls() - callsBefore} calls`);
    ok("Run now reports it with the not-in-use message",
      ctlNotInUse.statusCode === 200 && ctlNotInUse.body?.reason === "shiprocket_not_in_use"
        && /not connected/.test(ctlNotInUse.body?.message || ""),
      JSON.stringify(ctlNotInUse));

    await repin({ email: "", password: "" });
    const prevEmail = process.env.SHIPROCKET_EMAIL;
    const prevPassword = process.env.SHIPROCKET_PASSWORD;
    delete process.env.SHIPROCKET_EMAIL;
    delete process.env.SHIPROCKET_PASSWORD;
    const unconfigured = await pass({ orders: [due.order] });
    process.env.SHIPROCKET_EMAIL = prevEmail;
    process.env.SHIPROCKET_PASSWORD = prevPassword;
    ok("no credentials → shiprocket_not_in_use",
      unconfigured.ran === false && unconfigured.reason === "shiprocket_not_in_use", JSON.stringify(unconfigured));

    await repin();
    ok("the due order was left untouched by every gated pass",
      (await reload(due.order._id)).shiprocket.trackingCheckedAt === null && tracked(due.awbCode) === 0,
      `tracked ${tracked(due.awbCode)}`);
    ok("a gated pass does not overwrite lastRun",
      getReconciliationStatus().lastRun === statusBefore.lastRun, JSON.stringify(getReconciliationStatus().lastRun));
    ok("…and the guard is released after each gated pass", getReconciliationStatus().running === false);
    // Leave it out of every later scope.
    await OrderModel.updateOne({ _id: due.order._id }, { $set: { orderStatus: "Delivered" } });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("2 — overlap guard: one pass at a time, shared with Run now");
  {
    const blocker = await makeTrackedOrder();
    const entered = deferred();
    const release = deferred();
    sr.track.set(blocker.awbCode, async () => {
      entered.resolve();
      await release.promise;
      return trackingResponse(blocker.awbCode, 6, "SHIPPED");
    });

    const first = pass({ orders: [blocker.order], reason: "first" });
    await Promise.race([
      entered.promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("first pass never reached tracking")), 5000)),
    ]);

    const callsWhileBlocked = totalCalls();
    const second = await pass({ orders: [blocker.order], reason: "second" });
    ok("a concurrent pass returns {ran:false, reason:'already_running'}",
      second.ran === false && second.reason === "already_running", JSON.stringify(second));
    const ctlRun = await callController(opsController.RunShippingReconciliation);
    ok("Run now during a pass → 409 already_running",
      ctlRun.statusCode === 409 && ctlRun.body?.reason === "already_running" && ctlRun.body?.ran === false,
      JSON.stringify(ctlRun));
    ok("…with the already-running message", /already running/.test(ctlRun.body?.message || ""), ctlRun.body?.message);
    const ctlStatus = await callController(opsController.GetShippingReconciliationStatus);
    ok("status endpoint reports running: true",
      ctlStatus.statusCode === 200 && ctlStatus.body?.success === true && ctlStatus.body?.running === true,
      JSON.stringify(ctlStatus));
    ok("the refused passes made no Shiprocket calls", totalCalls() === callsWhileBlocked,
      `${totalCalls() - callsWhileBlocked} calls`);

    release.resolve();
    const firstResult = await first;
    ok("the first pass completes normally", firstResult.ran === true && !firstResult.halted, JSON.stringify(firstResult));
    ok("…and advanced the blocked order", (await reload(blocker.order._id)).orderStatus === "Shipped");
    ok("the AWB was polled exactly once", tracked(blocker.awbCode) === 1, String(tracked(blocker.awbCode)));
    ok("guard released afterwards", getReconciliationStatus().running === false);
    ok("lastRun is the first pass, not the refused one",
      getReconciliationStatus().lastRun?.reason === "first", JSON.stringify(getReconciliationStatus().lastRun));
    const again = await pass({ orders: [], reason: "after-release" });
    ok("a pass after release runs", again.ran === true, JSON.stringify(again));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("3 — tracking un-stalls an order; stale window; MANUAL never polled");
  {
    const stalled = await makeTrackedOrder({ orderStatus: "Packed", syncedAgo: 2 * DAY });
    const fresh = await makeTrackedOrder({ orderStatus: "Packed", syncedAgo: MINUTE });
    const silent = await makeTrackedOrder({ orderStatus: "Packed", syncedAgo: 2 * DAY });
    const manualAwb = nextAwb();
    const manual = await makeOrder({
      orderStatus: "Shipped",
      shipment: { provider: "MANUAL", carrierName: "India Post", trackingNumber: manualAwb, status: "Shipped" },
      shiprocket: { awbCode: manualAwb, lastSyncedAt: new Date(Date.now() - 3 * DAY) },
    });
    sr.track.set(stalled.awbCode, async () => trackingResponse(stalled.awbCode, 7, "DELIVERED"));
    sr.track.set(fresh.awbCode, async () => trackingResponse(fresh.awbCode, 7, "DELIVERED"));
    sr.track.set(silent.awbCode, async () =>
      jsonResponse({ tracking_data: { track_status: 0, error: "Aahh! There is no activities found in our DB." } }));
    sr.track.set(manualAwb, async () => trackingResponse(manualAwb, 7, "DELIVERED"));

    const scope = { orders: [stalled.order, fresh.order, silent.order, manual] };
    const beforePass = Date.now();
    const result = await pass(scope);
    ok("pass ran, not halted", result.ran === true && !result.halted, JSON.stringify(result));

    const after = await reload(stalled.order._id);
    ok("stalled Packed order polled once", tracked(stalled.awbCode) === 1, String(tracked(stalled.awbCode)));
    ok("…is now Delivered", after.orderStatus === "Delivered", after.orderStatus);
    ok("…via catch-up: Packed→Shipped, Shipped→Delivered",
      JSON.stringify(hopsOf(after)) === JSON.stringify(["Packed->Shipped", "Shipped->Delivered"]),
      JSON.stringify(hopsOf(after)));
    ok("…both hops sourced shiprocket_catchup",
      (after.statusHistory || []).length === 2 && after.statusHistory.every((h) => h.source === "shiprocket_catchup"),
      JSON.stringify((after.statusHistory || []).map((h) => h.source)));
    ok("…COD paymentStatus Paid", after.paymentStatus === "Paid", after.paymentStatus);
    ok("…deliveredAt stamped", Boolean(after.deliveredAt));
    ok("…trackingCheckedAt stamped", near(after.shiprocket.trackingCheckedAt, Date.now(), Date.now() - beforePass + 5000),
      String(after.shiprocket.trackingCheckedAt));
    ok("…lastSyncedAt refreshed", near(after.shiprocket.lastSyncedAt, Date.now(), Date.now() - beforePass + 5000));
    ok("…courier status recorded", after.shiprocket.statusCode === 7 && after.shiprocket.status === "DELIVERED",
      `${after.shiprocket.statusCode} ${after.shiprocket.status}`);
    ok("…shipment mirror follows", after.shipment?.status === "Delivered", after.shipment?.status);
    ok("…bill number minted", Boolean(after.bill?.number), JSON.stringify(after.bill));
    ok("summary.tracking.advanced === 1", result.summary?.tracking?.advanced === 1, JSON.stringify(result.summary?.tracking));
    ok("summary.tracking.checked === 1", result.summary?.tracking?.checked === 1, JSON.stringify(result.summary?.tracking));
    ok("summary.tracking.noData === 1", result.summary?.tracking?.noData === 1, JSON.stringify(result.summary?.tracking));

    const freshAfter = await reload(fresh.order._id);
    ok("an order synced 1 minute ago is NOT polled", tracked(fresh.awbCode) === 0, String(tracked(fresh.awbCode)));
    ok("…and stays Packed with no trackingCheckedAt",
      freshAfter.orderStatus === "Packed" && freshAfter.shiprocket.trackingCheckedAt === null,
      `${freshAfter.orderStatus} ${freshAfter.shiprocket.trackingCheckedAt}`);

    const silentAfter = await reload(silent.order._id);
    ok("track_status 0: polled once", tracked(silent.awbCode) === 1, String(tracked(silent.awbCode)));
    ok("…order unchanged", silentAfter.orderStatus === "Packed" && (silentAfter.statusHistory || []).length === 0,
      silentAfter.orderStatus);
    ok("…trackingCheckedAt stamped anyway", Boolean(silentAfter.shiprocket.trackingCheckedAt));
    ok("…lastSyncedAt not refreshed (no courier fact arrived)",
      near(silentAfter.shiprocket.lastSyncedAt, Date.now() - 2 * DAY, Date.now() - beforePass + 5000),
      String(silentAfter.shiprocket.lastSyncedAt));

    const manualAfter = await reload(manual._id);
    ok("a MANUAL-provider order is never polled", tracked(manualAwb) === 0, String(tracked(manualAwb)));
    ok("…and is untouched", manualAfter.orderStatus === "Shipped" && manualAfter.shiprocket.trackingCheckedAt === null);

    const second = await pass(scope);
    ok("second pass immediately after: ran", second.ran === true, JSON.stringify(second));
    ok("…does NOT poll the silent AWB again (stale window)", tracked(silent.awbCode) === 1, String(tracked(silent.awbCode)));
    ok("…does not poll the now-Delivered order", tracked(stalled.awbCode) === 1, String(tracked(stalled.awbCode)));
    ok("…nothing checked", second.summary?.tracking?.checked === 0 && second.summary?.tracking?.noData === 0,
      JSON.stringify(second.summary?.tracking));
    ok("…COD still Paid once, history unchanged",
      JSON.stringify(hopsOf(await reload(stalled.order._id))) === JSON.stringify(["Packed->Shipped", "Shipped->Delivered"]));

    // Past the stale window (injected `now`), the silent AWB is asked about again.
    const later = await pass({ ...scope, now: Date.now() + 7 * HOUR });
    ok("past the stale window the silent AWB is polled again",
      later.ran === true && tracked(silent.awbCode) === 2, `${tracked(silent.awbCode)} ${JSON.stringify(later.summary?.tracking)}`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("4 — cancellation retry with backoff, then an exception");
  {
    const make = () =>
      makeTrackedOrder({ orderStatus: "Cancelled", syncedAgo: HOUR, shiprocket: { syncStatus: "awb_assigned" } });
    const failing = await make();
    sr.cancel.set(failing.srOrderId, async () => jsonResponse({ message: "Internal Server Error" }, 500));

    const before = Date.now();
    const first = await pass({ orders: [failing.order] });
    const after = Date.now();
    let row = await reload(failing.order._id);
    ok("first failure: one cancel call", cancelledAt(failing.srOrderId) === 1, String(cancelledAt(failing.srOrderId)));
    ok("…not halted (a 500 is not a throttle)", first.ran === true && !first.halted, JSON.stringify(first));
    ok("…cancelAttempts 1", row.shiprocket.cancelAttempts === 1, String(row.shiprocket.cancelAttempts));
    ok("…nextAttemptAt ≈ now + backoffDelayMs(1)",
      Boolean(row.shiprocket.nextAttemptAt)
        && new Date(row.shiprocket.nextAttemptAt).getTime() >= before + backoffDelayMs(1)
        && new Date(row.shiprocket.nextAttemptAt).getTime() <= after + backoffDelayMs(1),
      `${row.shiprocket.nextAttemptAt?.toISOString?.()} vs ${new Date(before + backoffDelayMs(1)).toISOString()}`);
    ok("…syncStatus still awb_assigned (pending state preserved)", row.shiprocket.syncStatus === "awb_assigned",
      row.shiprocket.syncStatus);
    ok("…lastError records the failure", /Cancellation failed/.test(row.shiprocket.lastError || ""), row.shiprocket.lastError);
    ok("…no exception yet", !row.shiprocket.exception, JSON.stringify(row.shiprocket.exception));
    ok("…summary.cancellations.failed 1, exhausted 0",
      first.summary?.cancellations?.failed === 1 && first.summary?.cancellations?.exhausted === 0,
      JSON.stringify(first.summary?.cancellations));

    await pass({ orders: [failing.order] });
    ok("an immediate second pass does not call cancel again", cancelledAt(failing.srOrderId) === 1,
      String(cancelledAt(failing.srOrderId)));

    await OrderModel.updateOne({ _id: failing.order._id }, { $set: { "shiprocket.nextAttemptAt": new Date(Date.now() - MINUTE) } });
    await repin({ maxRetryAttempts: 2 });
    const second = await pass({ orders: [failing.order] });
    row = await reload(failing.order._id);
    ok("once due again: second cancel call", cancelledAt(failing.srOrderId) === 2, String(cancelledAt(failing.srOrderId)));
    ok("…cancelAttempts 2", row.shiprocket.cancelAttempts === 2, String(row.shiprocket.cancelAttempts));
    ok("…shiprocket.exception.meaning mentions cancellation",
      /cancel/i.test(row.shiprocket.exception?.meaning || ""), JSON.stringify(row.shiprocket.exception));
    ok("…summary.cancellations.exhausted 1", second.summary?.cancellations?.exhausted === 1,
      JSON.stringify(second.summary?.cancellations));

    await OrderModel.updateOne({ _id: failing.order._id }, { $set: { "shiprocket.nextAttemptAt": new Date(Date.now() - MINUTE) } });
    await pass({ orders: [failing.order] });
    ok("a third pass (even when due) makes no call — attempt limit reached", cancelledAt(failing.srOrderId) === 2,
      String(cancelledAt(failing.srOrderId)));
    await repin();

    const succeeding = await make();
    sr.cancel.set(succeeding.srOrderId, async () => jsonResponse({ status: 200, message: "Order cancelled successfully" }));
    const ok1 = await pass({ orders: [succeeding.order] });
    row = await reload(succeeding.order._id);
    ok("a successful cancel: one call", cancelledAt(succeeding.srOrderId) === 1, String(cancelledAt(succeeding.srOrderId)));
    ok("…syncStatus cancelled", row.shiprocket.syncStatus === "cancelled", row.shiprocket.syncStatus);
    ok("…summary.cancellations.cancelled 1", ok1.summary?.cancellations?.cancelled === 1,
      JSON.stringify(ok1.summary?.cancellations));
    ok("…no attempt counted", !row.shiprocket.cancelAttempts, String(row.shiprocket.cancelAttempts));
    await pass({ orders: [succeeding.order] });
    ok("…and it is never retried", cancelledAt(succeeding.srOrderId) === 1, String(cancelledAt(succeeding.srOrderId)));

    const adopted = await make();
    sr.cancel.set(adopted.srOrderId, async () =>
      jsonResponse({ message: "Order has already been cancelled" }, 400));
    await pass({ orders: [adopted.order] });
    row = await reload(adopted.order._id);
    ok("'already cancelled' from Shiprocket is adopted as success",
      row.shiprocket.syncStatus === "cancelled" && !row.shiprocket.cancelAttempts,
      `${row.shiprocket.syncStatus} attempts=${row.shiprocket.cancelAttempts}`);

    // Shiprocket switched off in the panel: nothing is attempted, so nothing is spent.
    const parked = await make();
    sr.cancel.set(parked.srOrderId, async () => jsonResponse({ message: "should not be called" }, 500));
    await repin({ shipmentsEnabled: false });
    await pass({ orders: [parked.order] });
    await repin();
    ok("shipments off: no cancel call and no attempt spent",
      cancelledAt(parked.srOrderId) === 0 && !(await reload(parked.order._id)).shiprocket.cancelAttempts);
    await OrderModel.updateOne({ _id: parked.order._id }, { $set: { "shiprocket.syncStatus": "cancelled" } });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("5 — a 429 (or Shiprocket unreachable) halts the pass");
  {
    const first = await makeTrackedOrder({ orderStatus: "Shipped", syncedAgo: 3 * DAY });
    const second = await makeTrackedOrder({ orderStatus: "Shipped", syncedAgo: 2 * DAY });
    // A cancellation that is due: the halted pass must not reach the later jobs either.
    const cancelDue = await makeTrackedOrder({ orderStatus: "Cancelled", syncedAgo: HOUR });
    sr.cancel.set(cancelDue.srOrderId, async () => jsonResponse({ status: 200, message: "Order cancelled successfully" }));
    sr.track.set(first.awbCode, async () => jsonResponse({ message: "Too Many Attempts." }, 429));
    sr.track.set(second.awbCode, async () => trackingResponse(second.awbCode, 18, "IN TRANSIT"));

    const result = await pass({ orders: [first.order, second.order, cancelDue.order], reason: "throttled" });
    ok("pass ran but was halted", result.ran === true && Boolean(result.halted), JSON.stringify(result));
    ok("the 429 AWB was asked once", tracked(first.awbCode) === 1, String(tracked(first.awbCode)));
    ok("the second AWB was NOT fetched", tracked(second.awbCode) === 0, String(tracked(second.awbCode)));
    ok("later jobs did not run (no cancel call)", cancelledAt(cancelDue.srOrderId) === 0,
      String(cancelledAt(cancelDue.srOrderId)));
    ok("lastRun records the halt",
      getReconciliationStatus().lastRun?.reason === "throttled" && Boolean(getReconciliationStatus().lastRun?.halted),
      JSON.stringify(getReconciliationStatus().lastRun));
    const firstRow = await reload(first.order._id);
    ok("the throttled order is unchanged but stamped as checked",
      firstRow.orderStatus === "Shipped" && Boolean(firstRow.shiprocket.trackingCheckedAt));

    // Next pass: the throttled AWB waits out its window; the rest is picked up.
    const resumed = await pass({ orders: [first.order, second.order, cancelDue.order] });
    ok("next pass picks up the AWB the halt skipped", tracked(second.awbCode) === 1, String(tracked(second.awbCode)));
    ok("…and the cancellation", cancelledAt(cancelDue.srOrderId) === 1, String(cancelledAt(cancelDue.srOrderId)));
    ok("…without re-asking the throttled AWB inside its window", tracked(first.awbCode) === 1,
      String(tracked(first.awbCode)));
    ok("…not halted", resumed.ran === true && !resumed.halted, JSON.stringify(resumed.halted));

    // Transport failure (fetch itself rejects) surfaces as 503 → halt.
    const third = await makeTrackedOrder({ orderStatus: "Shipped", syncedAgo: 3 * DAY });
    const fourth = await makeTrackedOrder({ orderStatus: "Shipped", syncedAgo: 2 * DAY });
    sr.track.set(third.awbCode, async () => {
      throw new TypeError("fetch failed");
    });
    sr.track.set(fourth.awbCode, async () => trackingResponse(fourth.awbCode, 18, "IN TRANSIT"));
    const unreachable = await pass({ orders: [third.order, fourth.order] });
    ok("Shiprocket unreachable halts the pass too", unreachable.ran === true && Boolean(unreachable.halted),
      JSON.stringify(unreachable));
    ok("…the next AWB is not fetched", tracked(fourth.awbCode) === 0, String(tracked(fourth.awbCode)));

    // A non-throttle error on one AWB is counted and the pass carries on.
    const fifth = await makeTrackedOrder({ orderStatus: "Shipped", syncedAgo: 3 * DAY });
    const sixth = await makeTrackedOrder({ orderStatus: "Shipped", syncedAgo: 2 * DAY });
    sr.track.set(fifth.awbCode, async () => jsonResponse({ message: "Invalid AWB" }, 404));
    sr.track.set(sixth.awbCode, async () => trackingResponse(sixth.awbCode, 18, "IN TRANSIT"));
    const carriesOn = await pass({ orders: [fifth.order, sixth.order] });
    ok("a 404 on one AWB does not halt", carriesOn.ran === true && !carriesOn.halted, JSON.stringify(carriesOn.halted));
    ok("…it is counted as an error and the next AWB is still polled",
      carriesOn.summary?.tracking?.errors === 1 && tracked(sixth.awbCode) === 1,
      `${JSON.stringify(carriesOn.summary?.tracking)} sixth=${tracked(sixth.awbCode)}`);

    // 429 on the CANCELLATION job must halt it too (plan: "the pass stops on 429/503").
    // Shiprocket is a Laravel API whose throttle body is {"message":"Too Many Attempts."}.
    const throttledCancel = await makeTrackedOrder({ orderStatus: "Cancelled", syncedAgo: HOUR });
    const nextCancel = await makeTrackedOrder({ orderStatus: "Cancelled", syncedAgo: HOUR });
    sr.cancel.set(throttledCancel.srOrderId, async () => jsonResponse({ message: "Too Many Attempts." }, 429));
    sr.cancel.set(nextCancel.srOrderId, async () => jsonResponse({ status: 200, message: "Order cancelled successfully" }));
    const cancel429 = await pass({ orders: [throttledCancel.order, nextCancel.order] });
    ok("a 429 on /orders/cancel halts the pass", Boolean(cancel429.halted), JSON.stringify(cancel429));
    ok("…the next cancellation is not attempted", cancelledAt(nextCancel.srOrderId) === 0,
      String(cancelledAt(nextCancel.srOrderId)));

    // …and a non-throttle cancel failure must NOT halt just because its text contains "rate".
    const generated = await makeTrackedOrder({ orderStatus: "Cancelled", syncedAgo: HOUR });
    const afterGenerated = await makeTrackedOrder({ orderStatus: "Cancelled", syncedAgo: HOUR });
    sr.cancel.set(generated.srOrderId, async () =>
      jsonResponse({ message: "Order cannot be cancelled as the manifest is generated" }, 400));
    sr.cancel.set(afterGenerated.srOrderId, async () =>
      jsonResponse({ status: 200, message: "Order cancelled successfully" }));
    const wordRate = await pass({ orders: [generated.order, afterGenerated.order] });
    ok("a 400 whose message contains 'generated' does not halt the pass", !wordRate.halted, JSON.stringify(wordRate.halted));
    ok("…the next cancellation is attempted", cancelledAt(afterGenerated.srOrderId) === 1,
      String(cancelledAt(afterGenerated.srOrderId)));

    // Tidy: take every order of this section out of the active/pending sets.
    for (const o of [throttledCancel, nextCancel, generated, afterGenerated, cancelDue]) {
      await OrderModel.updateOne({ _id: o.order._id }, { $set: { "shiprocket.syncStatus": "cancelled" } });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("6 — auto-push retries: failed / recently missed only, never `creating`");
  {
    const oneHourAgo = new Date(Date.now() - HOUR);
    const failed = await makeOrder({ orderStatus: "Confirmed", createdAt: oneHourAgo,
      shiprocket: { syncStatus: "failed", lastError: "earlier failure" } });
    const creating = await makeOrder({ orderStatus: "Confirmed", createdAt: oneHourAgo,
      shiprocket: { syncStatus: "creating", claimToken: `${MARKER}-stale`, claimedAt: oneHourAgo, attempts: 1 } });
    const tooNew = await makeOrder({ orderStatus: "Confirmed", createdAt: new Date(Date.now() - 2 * MINUTE) });
    const tooOld = await makeOrder({ orderStatus: "Confirmed", createdAt: new Date(Date.now() - 3 * DAY) });
    const missed = await makeOrder({ orderStatus: "Confirmed", createdAt: oneHourAgo });
    const all = [failed, creating, tooNew, tooOld, missed];

    const adhocBefore = sr.calls.adhoc;
    const result = await pass({ orders: all });
    ok("pass ran, not halted", result.ran === true && !result.halted, JSON.stringify(result));
    ok("failed order: createForwardShipment called once (one adhoc call)", pushed(failed) === 1, String(pushed(failed)));
    const failedRow = await reload(failed._id);
    ok("…shiprocket.orderId stored", typeof failedRow.shiprocket.orderId === "number", String(failedRow.shiprocket.orderId));
    ok("…syncStatus created", failedRow.shiprocket.syncStatus === "created", failedRow.shiprocket.syncStatus);
    ok("`creating` (stale claim) is never sent to adhoc", pushed(creating) === 0, String(pushed(creating)));
    const creatingRow = await reload(creating._id);
    ok("…and its claim is left exactly as it was",
      creatingRow.shiprocket.syncStatus === "creating" && creatingRow.shiprocket.claimToken === `${MARKER}-stale`,
      `${creatingRow.shiprocket.syncStatus} ${creatingRow.shiprocket.claimToken}`);
    ok("summary.staleClaims ≥ 1", result.summary?.staleClaims >= 1, String(result.summary?.staleClaims));
    ok("not_created 2 minutes old: not pushed (grace)", pushed(tooNew) === 0, String(pushed(tooNew)));
    ok("not_created 3 days old: not pushed (missed-window guard)", pushed(tooOld) === 0, String(pushed(tooOld)));
    ok("not_created 1 hour old: pushed", pushed(missed) === 1, String(pushed(missed)));
    ok("…shiprocket.orderId stored", typeof (await reload(missed._id)).shiprocket.orderId === "number");
    ok("exactly two adhoc calls in the pass", sr.calls.adhoc - adhocBefore === 2, String(sr.calls.adhoc - adhocBefore));
    ok("summary.autoPush.created === 2", result.summary?.autoPush?.created === 2, JSON.stringify(result.summary?.autoPush));

    const again = await pass({ orders: all });
    ok("a second pass pushes nothing more", sr.calls.adhoc - adhocBefore === 2 && again.summary?.autoPush?.created === 0,
      `${sr.calls.adhoc - adhocBefore} ${JSON.stringify(again.summary?.autoPush)}`);

    // Auto-push switched off in the panel.
    const offOrder = await makeOrder({ orderStatus: "Confirmed", createdAt: oneHourAgo, shiprocket: { syncStatus: "failed" } });
    await repin({ autoPushEnabled: false });
    const offBefore = sr.calls.adhoc;
    const off = await pass({ orders: [offOrder] });
    await repin();
    ok("autoPush capability off → no adhoc calls at all", off.ran === true && sr.calls.adhoc === offBefore,
      `${sr.calls.adhoc - offBefore} calls`);
    ok("…order left failed", (await reload(offOrder._id)).shiprocket.syncStatus === "failed");
    await OrderModel.updateOne({ _id: offOrder._id }, { $set: { orderStatus: "Cancelled" } });

    // A definite 4xx refusal: back to failed, with a backoff.
    const refused = await makeOrder({ orderStatus: "Confirmed", createdAt: oneHourAgo, shiprocket: { syncStatus: "failed" } });
    sr.adhoc.set(String(refused._id), async () =>
      jsonResponse({ message: "The given data was invalid.", errors: { billing_pincode: ["invalid"] } }, 422));
    const before422 = Date.now();
    const r422 = await pass({ orders: [refused] });
    const refusedRow = await reload(refused._id);
    ok("422: one adhoc call", pushed(refused) === 1, String(pushed(refused)));
    ok("…syncStatus failed", refusedRow.shiprocket.syncStatus === "failed", refusedRow.shiprocket.syncStatus);
    ok("…nextAttemptAt in the future", Boolean(refusedRow.shiprocket.nextAttemptAt)
      && new Date(refusedRow.shiprocket.nextAttemptAt).getTime() > before422,
      String(refusedRow.shiprocket.nextAttemptAt));
    ok("…≈ now + backoffDelayMs(1)", near(refusedRow.shiprocket.nextAttemptAt, before422 + backoffDelayMs(1), 10_000),
      String(refusedRow.shiprocket.nextAttemptAt));
    ok("…summary.autoPush.failed 1, not halted", r422.summary?.autoPush?.failed === 1 && !r422.halted,
      JSON.stringify(r422));
    await pass({ orders: [refused] });
    ok("…the next immediate pass does not retry it", pushed(refused) === 1, String(pushed(refused)));

    // Once due again it is retried, and the attempt budget then stops it.
    await repin({ maxRetryAttempts: 2 });
    await OrderModel.updateOne({ _id: refused._id }, { $set: { "shiprocket.nextAttemptAt": new Date(Date.now() - MINUTE) } });
    await pass({ orders: [refused] });
    ok("once due, it is retried", pushed(refused) === 2, String(pushed(refused)));
    await OrderModel.updateOne({ _id: refused._id }, { $set: { "shiprocket.nextAttemptAt": new Date(Date.now() - MINUTE) } });
    await pass({ orders: [refused] });
    ok("…and after maxRetryAttempts creation attempts it is not retried again", pushed(refused) === 2,
      String(pushed(refused)));
    await repin();

    // Tidy: the creating order must not appear in later passes' stale-claim counts.
    await OrderModel.updateOne({ _id: creating._id }, { $set: { "shiprocket.syncStatus": "failed", orderStatus: "Cancelled" } });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("7 — return-leg AWB sync");
  {
    const SHIP = ID_BASE + 90;
    const awbOf = (n) => `RTN123-${MARKER}-${n}`;

    const assigned = await makeReturn({ pickupShipmentId: SHIP + 1 });
    sr.shipments.set(SHIP + 1, async () => jsonResponse({ data: { awb: awbOf(1), courier: "Delhivery" } }));
    const blank = await makeReturn({ pickupShipmentId: SHIP + 2 });
    sr.shipments.set(SHIP + 2, async () => jsonResponse({ data: { awb: "", courier: "" } }));
    const zero = await makeReturn({ pickupShipmentId: SHIP + 3 });
    sr.shipments.set(SHIP + 3, async () => jsonResponse({ data: { awb: "0", courier: "Delhivery" } }));
    const adminFirst = await makeReturn({ pickupShipmentId: SHIP + 4, pickupAwb: `ADMIN-${MARKER}-4`, pickupCourier: "BlueDart" });
    sr.shipments.set(SHIP + 4, async () => jsonResponse({ data: { awb: awbOf(4), courier: "Delhivery" } }));
    // An admin records the AWB while the sync's request is in flight.
    const racing = await makeReturn({ pickupShipmentId: SHIP + 5 });
    sr.shipments.set(SHIP + 5, async () => {
      await ReturnModel.updateOne({ _id: racing._id }, { $set: { pickupAwb: `ADMIN-${MARKER}-5`, pickupCourier: "BlueDart" } });
      return jsonResponse({ data: { awb: awbOf(5), courier: "Delhivery" } });
    });
    const replacement = await makeReturn({ status: "received", resolutionType: "replacement", replacementShipmentId: SHIP + 6 });
    sr.shipments.set(SHIP + 6, async () => jsonResponse({ data: { awb_code: awbOf(6), courier_name: "Xpressbees" } }));
    const notOurs = await makeReturn({ status: "approved", pickupShipmentId: SHIP + 7 });
    sr.shipments.set(SHIP + 7, async () => jsonResponse({ data: { awb: awbOf(7), courier: "Delhivery" } }));

    const returns = [assigned, blank, zero, adminFirst, racing, replacement, notOurs];
    const result = await pass({ returns });
    ok("pass ran, not halted", result.ran === true && !result.halted, JSON.stringify(result));

    const a = await reloadReturn(assigned._id);
    ok("pickupAwb stored from GET /shipments/{id}", a.pickupAwb === awbOf(1), a.pickupAwb);
    ok("…pickupCourier set", a.pickupCourier === "Delhivery", a.pickupCourier);
    ok("…statusHistory note added",
      (a.statusHistory || []).some((h) => /Pickup AWB/.test(h.note || "") && (h.note || "").includes(awbOf(1))),
      JSON.stringify((a.statusHistory || []).map((h) => h.note)));
    ok("…return status unchanged", a.status === "pickup_scheduled", a.status);

    const b = await reloadReturn(blank._id);
    const z = await reloadReturn(zero._id);
    ok("awb '' → stays unset", fetchedShipment(SHIP + 2) === 1 && !b.pickupAwb, JSON.stringify(b.pickupAwb));
    ok("awb '0' → stays unset", fetchedShipment(SHIP + 3) === 1 && !z.pickupAwb, JSON.stringify(z.pickupAwb));
    // statusHistory starts with the schema default ("Return requested"); only a sync note matters.
    const syncNotes = (r) => (r.statusHistory || []).filter((h) => /synced from Shiprocket/.test(h.note || "")).length;
    ok("…and no sync note for either", syncNotes(b) === 0 && syncNotes(z) === 0,
      JSON.stringify([...(b.statusHistory || []), ...(z.statusHistory || [])].map((h) => h.note)));

    const adm = await reloadReturn(adminFirst._id);
    ok("an AWB the admin recorded before the pass: not fetched", fetchedShipment(SHIP + 4) === 0,
      String(fetchedShipment(SHIP + 4)));
    ok("…and not overwritten", adm.pickupAwb === `ADMIN-${MARKER}-4` && adm.pickupCourier === "BlueDart",
      `${adm.pickupAwb} ${adm.pickupCourier}`);

    const rc = await reloadReturn(racing._id);
    ok("an AWB the admin recorded concurrently: not overwritten", fetchedShipment(SHIP + 5) === 1
      && rc.pickupAwb === `ADMIN-${MARKER}-5` && rc.pickupCourier === "BlueDart",
      `${rc.pickupAwb} ${rc.pickupCourier}`);
    ok("…and no sync note written", !(rc.statusHistory || []).some((h) => /synced from Shiprocket/.test(h.note || "")));

    const rp = await reloadReturn(replacement._id);
    ok("replacement leg (status received): replacementAwb stored",
      rp.replacementAwb === awbOf(6) && rp.replacementCourier === "Xpressbees",
      `${rp.replacementAwb} ${rp.replacementCourier}`);
    ok("…with a Replacement AWB note", (rp.statusHistory || []).some((h) => /Replacement AWB/.test(h.note || "")));

    ok("a return not yet at pickup_scheduled is not asked about", fetchedShipment(SHIP + 7) === 0,
      String(fetchedShipment(SHIP + 7)));
    ok("summary.returnAwbs.synced === 2", result.summary?.returnAwbs?.synced === 2, JSON.stringify(result.summary?.returnAwbs));
    ok("summary.returnAwbs.pending === 3 (blank, zero, raced)", result.summary?.returnAwbs?.pending === 3,
      JSON.stringify(result.summary?.returnAwbs));

    const replay = await pass({ returns });
    ok("a second pass does not re-fetch synced AWBs",
      fetchedShipment(SHIP + 1) === 1 && fetchedShipment(SHIP + 6) === 1 && replay.summary?.returnAwbs?.synced === 0,
      `${fetchedShipment(SHIP + 1)} ${fetchedShipment(SHIP + 6)} ${JSON.stringify(replay.summary?.returnAwbs)}`);
    ok("…but keeps asking for the unassigned ones", fetchedShipment(SHIP + 2) === 2 && fetchedShipment(SHIP + 3) === 2,
      `${fetchedShipment(SHIP + 2)} ${fetchedShipment(SHIP + 3)}`);

    // Direct call.
    const direct = await makeReturn({ pickupShipmentId: SHIP + 8 });
    sr.shipments.set(SHIP + 8, async () => jsonResponse({ data: { awb: awbOf(8), courier: "Delhivery" } }));
    const res = await syncReturnLegAwb(direct._id, "pickup");
    ok("syncReturnLegAwb(id, 'pickup') → {ok:true, awbCode}", res.ok === true && res.awbCode === awbOf(8), JSON.stringify(res));
    ok("…stored", (await reloadReturn(direct._id)).pickupAwb === awbOf(8));
    const repeat = await syncReturnLegAwb(direct._id, "pickup");
    ok("…a repeat reports alreadyRecorded without asking Shiprocket",
      repeat.ok === true && repeat.alreadyRecorded === true && fetchedShipment(SHIP + 8) === 1, JSON.stringify(repeat));
    ok("unknown leg → unknown_leg", (await syncReturnLegAwb(direct._id, "sideways")).reason === "unknown_leg");
    const unbooked = await makeReturn({});
    ok("no shipment id → not_booked", (await syncReturnLegAwb(unbooked._id, "pickup")).reason === "not_booked");
    const pendingDirect = await syncReturnLegAwb(blank._id, "pickup");
    ok("no AWB assigned yet → awb_not_assigned_yet",
      pendingDirect.ok === false && pendingDirect.reason === "awb_not_assigned_yet", JSON.stringify(pendingDirect));

    // Tidy: out of every later scope (they are scoped anyway).
    await ReturnModel.updateMany({ _id: { $in: trash.returns } }, { $set: { status: "rejected" } });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("8 — getReconciliationStatus reflects the last completed pass");
  {
    const target = await makeTrackedOrder({ orderStatus: "Shipped", syncedAgo: 2 * DAY });
    sr.track.set(target.awbCode, async () => trackingResponse(target.awbCode, 17, "OUT FOR DELIVERY"));
    const result = await pass({ orders: [target.order], reason: "final-check" });
    const status = getReconciliationStatus();
    ok("lastRun.reason is the last pass's reason", status.lastRun?.reason === "final-check", JSON.stringify(status.lastRun));
    ok("lastRun.summary is that pass's summary",
      JSON.stringify(status.lastRun?.summary) === JSON.stringify(result.summary), JSON.stringify(status.lastRun?.summary));
    ok("lastRun.halted null, at is a Date", status.lastRun?.halted === null && status.lastRun?.at instanceof Date);
    ok("running false", status.running === false);
    ok("that pass advanced the order to Out For Delivery",
      result.summary?.tracking?.advanced === 1 && (await reload(target.order._id)).orderStatus === "Out For Delivery");

    const ctl = await callController(opsController.GetShippingReconciliationStatus);
    ok("status endpoint returns {success, running:false, lastRun}",
      ctl.statusCode === 200 && ctl.body?.success === true && ctl.body?.running === false
        && ctl.body?.lastRun?.reason === "final-check",
      JSON.stringify(ctl.body));

    await repin({ reconciliationEnabled: false });
    await pass({ orders: [target.order], reason: "disabled-after" });
    await repin();
    ok("a pass that did not run leaves lastRun alone", getReconciliationStatus().lastRun?.reason === "final-check",
      JSON.stringify(getReconciliationStatus().lastRun?.reason));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("Z — hygiene");
  ok("no unknown Shiprocket URLs were called", sr.unknown.length === 0, JSON.stringify(sr.unknown));
  ok("the admin Run now never ran a pass (no audit row)",
    (await AuditLog.countDocuments({ action: "RUN_SHIPPING_RECONCILIATION", createdAt: { $gte: suiteStartedAt } })) === 0);
} catch (error) {
  console.error(`\nSUITE ABORTED: ${error?.stack || error}`);
  ok("suite ran to completion", false, error?.message);
} finally {
  globalThis.fetch = realFetch;
  delete process.env.SHIPPING_RECONCILE_ENABLED;
  await ReturnModel.deleteMany({ _id: { $in: trash.returns } });
  await OrderModel.deleteMany({ _id: { $in: trash.orders } });
  await ProductModel.deleteMany({ _id: { $in: trash.products } });
  await UserModel.deleteMany({ _id: { $in: trash.users } });
  restoreCapabilities();

  // Give back live bill numbers, only if no surviving order holds a higher one.
  const highest = await OrderModel.findOne({ "bill.financialYear": LIVE_FY })
    .sort({ "bill.sequence": -1 })
    .select("bill.sequence")
    .lean();
  const inUse = highest?.bill?.sequence ?? 0;
  if (inUse <= (liveCounterBefore ?? 0)) {
    if (liveCounterBefore === null) {
      await BillCounter.deleteOne({ financialYear: LIVE_FY });
    } else {
      await BillCounter.updateOne({ financialYear: LIVE_FY }, { $set: { seq: liveCounterBefore } });
    }
  } else {
    console.log(`\n  note: live counter for ${LIVE_FY} left as is — order ${highest?._id} holds sequence ${inUse}`);
  }

  const { failed } = finish();
  await mongoose.disconnect();
  process.exit(failed ? 1 : 0);
}
