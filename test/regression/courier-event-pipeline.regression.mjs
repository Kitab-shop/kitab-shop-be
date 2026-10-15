/**
 * The courier-event pipeline (courier-event.service.js): ONE set of rules for every
 * courier status update, whether it arrives by webhook or by the reconciler.
 *
 * Covers the plan's "State machines and rules" for courier events:
 *
 *   1. every status write is a compare-and-swap on the status it was read from — a
 *      cancellation that commits between read and write must win;
 *   2. catch-up over a missed event follows the explicit table (via Shipped / via RTO),
 *      never from Pending, never out of Delivered or a terminal status;
 *   3. side effects follow the FINAL status (deliveredAt once, COD Paid once, bill
 *      number once, RTO refund obligation only at RTO Received);
 *   4. the out-of-order guard on `shiprocket.lastEventAt`, with IST timestamp parsing
 *      and "unparseable → guard skipped", and genuine OFD→NDR→OFD repeats still apply.
 *
 * Plus the code table (19/27 record only; 8/45 adopt a local cancellation; other
 * exception codes persisted), MANUAL shipments, identity refusal, webhook auth and the
 * return leg.
 *
 * Run with `npm run test:courier-event-pipeline` (or `npm test` for everything).
 *
 * The pipeline must never call Shiprocket: `globalThis.fetch` throws on ANY call and
 * every call is counted.
 */
process.env.SHIPROCKET_ENABLED = "true";
process.env.SHIPROCKET_WEBHOOK_ENABLED = "true";
process.env.SHIPROCKET_WEBHOOK_TOKEN = "stub-webhook-token";
process.env.SHIPROCKET_EMAIL = "stub@example.test";
process.env.SHIPROCKET_PASSWORD = "stub-password";
process.env.SHIPROCKET_BASE_URL = "https://shiprocket.invalid/v1/external";
process.env.INVENTORY_ENFORCE_STOCK = "true";
process.env.NOTIFICATIONS_ENABLED = "false";
process.env.PAYMENTS_ENABLED = "false";

import mongoose from "mongoose";
import { connect, createSuite, marker, productFixture, addressFixture, pinShiprocketCapabilities } from "./helpers.mjs";

const { ok, section, finish } = createSuite("courier-event-pipeline");
await connect();
const restoreCapabilities = await pinShiprocketCapabilities();

const OrderModel = (await import("../../src/modules/orders/Order.model.js")).default;
const ProductModel = (await import("../../src/modules/products/Product.model.js")).default;
const ReturnModel = (await import("../../src/modules/returns/return.model.js")).default;
const BillCounter = (await import("../../src/modules/orders/BillCounter.model.js")).default;
const ShiprocketSetting = (await import("../../src/modules/shipping/ShiprocketSetting.model.js")).default;
await import("../../src/modules/categories/Category.model.js");
const { financialYear } = await import("../../src/modules/orders/bill-number.service.js");
const { applyCourierEvent, courierEventFromWebhook } = await import(
  "../../src/modules/shipping/courier-event.service.js"
);
const { extractCourierEventTime, parseCourierTimestamp } = await import(
  "../../src/modules/shipping/courier-event-time.js"
);
const { mapOrderStatus, COURIER_CANCELLED_CODES } = await import(
  "../../src/modules/shipping/shipment-status-map.js"
);
const { resolveCourierPath } = await import("../../src/modules/orders/order-status.rules.js");
const shippingController = await import("../../src/modules/shipping/shipping.controller.js");

await OrderModel.init();
await ReturnModel.init().catch(() => {});
await ShiprocketSetting.getSettings();

// Delivered events mint bill numbers in the LIVE financial year (the pipeline takes no
// date). Captured here and rewound in finally, exactly as bill-number.regression does.
const LIVE_FY = financialYear();
const liveCounterBefore = (await BillCounter.findOne({ financialYear: LIVE_FY }).lean())?.seq ?? null;

// ── Shiprocket must never be contacted by the pipeline ──────────────────────
const fetchCalls = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input) => {
  const url = String(input instanceof URL ? input.href : input);
  fetchCalls.push(url);
  throw new Error(`Unexpected network call from the courier-event pipeline: ${url}`);
};

const MARKER = marker("courierpipe");
const trash = { orders: [], products: [], returns: [] };
let seq = 0;
// Shiprocket order ids are uniquely indexed; keep ours in a per-process band.
const SR_BASE = 880_000_000 + (process.pid % 100_000) * 1_000;

let sharedProduct = null;
const product = async () => {
  if (sharedProduct) return sharedProduct;
  sharedProduct = await ProductModel.create(productFixture(`${MARKER}-p`, { stock: 500 }));
  trash.products.push(sharedProduct._id);
  return sharedProduct;
};

const makeOrder = async ({
  orderStatus = "Shipped",
  paymentMethod = "COD",
  paymentStatus = "Pending",
  withShiprocket = true,
  shiprocket = {},
  ...fields
} = {}) => {
  seq += 1;
  const p = await product();
  const srOrderId = SR_BASE + seq;
  const awbCode = `AWB-${MARKER}-${seq}`;
  const order = await OrderModel.create({
    user: new mongoose.Types.ObjectId(),
    items: [{ product: p._id, name: p.name, image: "x.png", price: p.price, quantity: 1 }],
    shippingAddress: addressFixture(),
    paymentMethod,
    paymentStatus,
    orderStatus,
    subtotal: p.price,
    totalAmount: p.price,
    ...(paymentMethod === "RAZORPAY" && paymentStatus !== "Pending"
      ? { razorpayPaymentId: `pay_${MARKER}_${seq}` }
      : {}),
    ...(withShiprocket
      ? {
          shiprocket: {
            orderId: srOrderId,
            shipmentId: srOrderId + 500,
            awbCode,
            status: "IN TRANSIT",
            syncStatus: "awb_assigned",
            ...shiprocket,
          },
        }
      : {}),
    ...fields,
  });
  trash.orders.push(order._id);
  return { order, srOrderId, awbCode };
};

const reload = (id) => OrderModel.findById(id).lean();

/** An event in the shape applyCourierEvent takes. */
const ev = (target, statusCode, currentStatus, extra = {}) => ({
  sourceOrderId: "",
  shiprocketOrderId: target.srOrderId,
  awbCode: target.awbCode,
  statusCode,
  currentStatus,
  courierName: null,
  ndrReason: "",
  rtoReason: "",
  eventAt: null,
  ...extra,
});

/** Drives the real webhook, including its x-api-key check. */
const sendWebhook = async (body, { token = "stub-webhook-token" } = {}) => {
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
  await shippingController.ShippingWebhook(
    {
      body,
      // token === null models a request that carries no x-api-key header at all.
      get: (header) => (header.toLowerCase() === "x-api-key" ? token ?? undefined : undefined),
      header: (header) => (header.toLowerCase() === "x-api-key" ? token ?? undefined : undefined),
      headers: token === null ? {} : { "x-api-key": token },
    },
    res,
  );
  return { statusCode, body: payload };
};

// IST wall-clock renderings of an instant, in the two shapes Shiprocket sends.
const IST_MS = (5 * 60 + 30) * 60 * 1000;
const pad = (n) => String(n).padStart(2, "0");
const istParts = (date) => {
  const d = new Date(date.getTime() + IST_MS);
  return {
    Y: d.getUTCFullYear(),
    M: pad(d.getUTCMonth() + 1),
    D: pad(d.getUTCDate()),
    h: pad(d.getUTCHours()),
    m: pad(d.getUTCMinutes()),
    s: pad(d.getUTCSeconds()),
  };
};
const istDayFirst = (date) => {
  const { Y, M, D, h, m, s } = istParts(date);
  return `${D} ${M} ${Y} ${h}:${m}:${s}`;
};
const istYearFirst = (date) => {
  const { Y, M, D, h, m, s } = istParts(date);
  return `${Y}-${M}-${D} ${h}:${m}:${s}`;
};

const HOUR = 60 * 60 * 1000;
const secondsAligned = (ms) => new Date(Math.floor(ms / 1000) * 1000);
const sameInstant = (a, b) => Boolean(a && b) && new Date(a).getTime() === new Date(b).getTime();
const hopsOf = (order) => (order.statusHistory || []).map((h) => `${h.from}->${h.to}`);
const rtoRows = (order) => (order.refunds || []).filter((r) => r.reason === `RTO ${order._id}`);

try {
  // ═══════════════════════════════════════════════════════════════════════════
  section("0 — building blocks the pipeline relies on");
  {
    ok("19 maps to no status", mapOrderStatus(19, "OUT FOR PICKUP") === null, String(mapOrderStatus(19, "OUT FOR PICKUP")));
    ok("27 maps to no status", mapOrderStatus(27, "PICKUP BOOKED") === null, String(mapOrderStatus(27, "PICKUP BOOKED")));
    ok("8 and 45 are the courier-cancelled codes",
      COURIER_CANCELLED_CODES.includes(8) && COURIER_CANCELLED_CODES.includes(45), JSON.stringify(COURIER_CANCELLED_CODES));
    ok("Pending → Shipped has no courier path", resolveCourierPath("Pending", "Shipped") === null);
    ok("Delivered → RTO Received has no courier path", resolveCourierPath("Delivered", "RTO Received") === null);
    ok("Cancelled → Shipped has no courier path", resolveCourierPath("Cancelled", "Shipped") === null);

    const now = Date.UTC(2026, 9, 10, 12, 0, 0);
    const dayFirst = parseCourierTimestamp("10 10 2026 15:30:00", { now });
    ok("'DD MM YYYY HH:mm:ss' is read as IST",
      dayFirst?.toISOString() === "2026-10-10T10:00:00.000Z", dayFirst?.toISOString());
    const yearFirst = parseCourierTimestamp("2026-10-10 15:30:00", { now });
    ok("'YYYY-MM-DD HH:mm:ss' is read as IST",
      yearFirst?.toISOString() === "2026-10-10T10:00:00.000Z", yearFirst?.toISOString());
    ok("junk is rejected, not guessed", parseCourierTimestamp("05 06 2024", { now }) === null);
    ok("a future time is rejected", parseCourierTimestamp("2026-10-11 15:30:00", { now }) === null);
    const latest = extractCourierEventTime(
      { current_timestamp: "10 10 2026 09:00:00", scans: [{ date: "2026-10-10 11:00:00" }, { date: "2026-10-10 10:00:00" }] },
      { now },
    );
    ok("the latest scan beats current_timestamp",
      latest?.toISOString() === "2026-10-10T05:30:00.000Z", latest?.toISOString());
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("1 — a cancellation committed concurrently with a Shipped event wins");
  {
    const runs = [];
    for (let i = 0; i < 10; i += 1) {
      const target = await makeOrder({ orderStatus: "Packed", shiprocket: { syncStatus: "created" } });
      const delayMs = i % 5;
      const cancel = (async () => {
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
        return OrderModel.updateOne(
          { _id: target.order._id, orderStatus: "Packed" },
          { $set: { orderStatus: "Cancelled" } },
        );
      })();
      const event = applyCourierEvent(ev(target, 6, "SHIPPED"), { source: "webhook" });
      const [cancelResult, eventResult] = await Promise.all([cancel, event]);
      const after = await reload(target.order._id);
      runs.push({
        cancelled: cancelResult.modifiedCount === 1,
        final: after.orderStatus,
        shippedHops: (after.statusHistory || []).filter((h) => h.to === "Shipped").length,
        eventHops: eventResult.hops,
      });
    }

    const cancelWins = runs.filter((r) => r.cancelled);
    const eventWins = runs.filter((r) => !r.cancelled);
    ok("every run where the cancel committed ends Cancelled",
      cancelWins.every((r) => r.final === "Cancelled"), JSON.stringify(cancelWins));
    ok("…and no Shipped entry was ever pushed on those orders",
      cancelWins.every((r) => r.shippedHops === 0), JSON.stringify(cancelWins));
    ok("every run where the cancel lost ends Shipped (the event's CAS won first)",
      eventWins.every((r) => r.final === "Shipped" && r.shippedHops === 1), JSON.stringify(eventWins));
    ok("no run ends in any third state",
      runs.every((r) => r.final === "Cancelled" || r.final === "Shipped"), JSON.stringify(runs.map((r) => r.final)));
    console.log(`       (interleavings: cancel won ${cancelWins.length}, event won ${eventWins.length})`);
  }

  {
    // Deterministic: the pipeline's first read is a stale Packed snapshot, the DB
    // already says Cancelled. The CAS on "Packed" must miss, the re-read must see
    // Cancelled, and there must be no legal path from there.
    const target = await makeOrder({ orderStatus: "Packed", shiprocket: { syncStatus: "created" } });
    await OrderModel.updateOne({ _id: target.order._id }, { $set: { orderStatus: "Cancelled" } });
    const staleSnapshot = await OrderModel.findById(target.order._id)
      .select("orderStatus deliveredAt paymentMethod paymentStatus shipment.provider shiprocket.lastEventAt shiprocket.syncStatus")
      .lean();
    staleSnapshot.orderStatus = "Packed";

    const realFindById = OrderModel.findById;
    let findByIdCalls = 0;
    let served = false;
    OrderModel.findById = function patched(id, ...rest) {
      if (String(id) === String(target.order._id)) findByIdCalls += 1;
      if (!served && String(id) === String(target.order._id)) {
        served = true;
        const fake = {
          select() {
            return fake;
          },
          lean: () => Promise.resolve(structuredClone(staleSnapshot)),
        };
        return fake;
      }
      return realFindById.call(this, id, ...rest);
    };
    let result;
    try {
      result = await applyCourierEvent(ev(target, 6, "SHIPPED"), { source: "webhook" });
    } finally {
      OrderModel.findById = realFindById;
    }
    const after = await reload(target.order._id);
    ok("the stale snapshot was served (test precondition)", served);
    ok("the pipeline re-read after the CAS miss", findByIdCalls >= 2, String(findByIdCalls));
    ok("the order is still Cancelled", after.orderStatus === "Cancelled", after.orderStatus);
    ok("no Shipped history entry was pushed",
      !(after.statusHistory || []).some((h) => h.to === "Shipped"), JSON.stringify(hopsOf(after)));
    ok("the result reports no hops", Array.isArray(result?.hops) && result.hops.length === 0, JSON.stringify(result));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("2 — catch-up: Confirmed COD + Delivered = 2 hops, Paid once, bill once");
  {
    const target = await makeOrder({ orderStatus: "Confirmed", paymentMethod: "COD", paymentStatus: "Pending",
      shiprocket: { syncStatus: "created" } });
    const result = await applyCourierEvent(ev(target, 7, "DELIVERED"), { source: "webhook" });
    const after = await reload(target.order._id);
    const history = after.statusHistory || [];

    ok("the order is Delivered", after.orderStatus === "Delivered", after.orderStatus);
    ok("the result lists both hops",
      JSON.stringify(result?.hops) === JSON.stringify(["Shipped", "Delivered"]), JSON.stringify(result));
    ok("exactly two history entries were added", history.length === 2, JSON.stringify(hopsOf(after)));
    ok("Confirmed→Shipped then Shipped→Delivered",
      JSON.stringify(hopsOf(after)) === JSON.stringify(["Confirmed->Shipped", "Shipped->Delivered"]),
      JSON.stringify(hopsOf(after)));
    ok("both hops are tagged shiprocket_catchup",
      history.every((h) => h.source === "shiprocket_catchup"), JSON.stringify(history.map((h) => h.source)));
    ok("deliveredAt is set", Boolean(after.deliveredAt));
    ok("COD is now Paid", after.paymentStatus === "Paid", after.paymentStatus);
    ok("a bill number was minted", typeof after.bill?.number === "string" && after.bill.number.length > 0,
      JSON.stringify(after.bill?.number));
    ok("it belongs to the live financial year", after.bill?.financialYear === LIVE_FY, after.bill?.financialYear);

    const replay = await applyCourierEvent(ev(target, 7, "DELIVERED"), { source: "webhook" });
    const again = await reload(target.order._id);
    ok("replay: no new history", (again.statusHistory || []).length === 2, JSON.stringify(hopsOf(again)));
    ok("replay: reports zero hops", Array.isArray(replay?.hops) && replay.hops.length === 0, JSON.stringify(replay));
    ok("replay: still Paid", again.paymentStatus === "Paid", again.paymentStatus);
    ok("replay: deliveredAt unchanged", sameInstant(again.deliveredAt, after.deliveredAt),
      `${after.deliveredAt?.toISOString?.()} → ${again.deliveredAt?.toISOString?.()}`);
    ok("replay: bill number unchanged (minted once)", again.bill?.number === after.bill?.number,
      `${after.bill?.number} → ${again.bill?.number}`);
    ok("replay: bill sequence unchanged", again.bill?.sequence === after.bill?.sequence);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("3 — an unpaid prepaid order is never moved by the courier");
  {
    const target = await makeOrder({ orderStatus: "Pending", paymentMethod: "RAZORPAY", paymentStatus: "Pending",
      shiprocket: { syncStatus: "created" } });
    const result = await applyCourierEvent(ev(target, 6, "SHIPPED"), { source: "webhook" });
    const after = await reload(target.order._id);
    ok("status unchanged (Pending)", after.orderStatus === "Pending", after.orderStatus);
    ok("no history entry", (after.statusHistory || []).length === 0, JSON.stringify(hopsOf(after)));
    ok("no hops reported", Array.isArray(result?.hops) && result.hops.length === 0, JSON.stringify(result));
    ok("an exception is recorded", Boolean(after.shiprocket?.exception), JSON.stringify(after.shiprocket?.exception));
    ok("…mentioning awaiting payment",
      /awaiting payment/i.test(after.shiprocket?.exception?.meaning || ""), after.shiprocket?.exception?.meaning);
    ok("…with the event's code", after.shiprocket?.exception?.code === 6, String(after.shiprocket?.exception?.code));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("4 — the out-of-order guard on courier time");
  {
    const T = secondsAligned(Date.now() - 3 * HOUR);
    const target = await makeOrder({ orderStatus: "Out For Delivery",
      shiprocket: { status: "OUT FOR DELIVERY", statusCode: 17, lastEventAt: T } });

    const stale = await applyCourierEvent(
      ev(target, 21, "UNDELIVERED", { eventAt: new Date(T.getTime() - HOUR), ndrReason: "Customer not available" }),
      { source: "webhook" },
    );
    let after = await reload(target.order._id);
    ok("an older NDR is flagged stale", stale?.stale === true, JSON.stringify(stale));
    ok("…status unchanged", after.orderStatus === "Out For Delivery", after.orderStatus);
    ok("…no history entry", (after.statusHistory || []).length === 0, JSON.stringify(hopsOf(after)));
    ok("…shiprocket.status not overwritten", after.shiprocket?.status === "OUT FOR DELIVERY", after.shiprocket?.status);
    ok("…shiprocket.statusCode not overwritten", after.shiprocket?.statusCode === 17, String(after.shiprocket?.statusCode));
    ok("…lastEventAt not moved back", sameInstant(after.shiprocket?.lastEventAt, T),
      after.shiprocket?.lastEventAt?.toISOString?.());
    ok("…but the ndrReason IS kept", after.shiprocket?.ndrReason === "Customer not available", after.shiprocket?.ndrReason);

    const newer = new Date(T.getTime() + HOUR);
    const fresh = await applyCourierEvent(ev(target, 21, "UNDELIVERED", { eventAt: newer }), { source: "webhook" });
    after = await reload(target.order._id);
    ok("the same NDR, newer, is applied", after.orderStatus === "NDR", after.orderStatus);
    ok("…not stale", fresh?.stale === false, JSON.stringify(fresh));
    ok("…lastEventAt = T+1h", sameInstant(after.shiprocket?.lastEventAt, newer), after.shiprocket?.lastEventAt?.toISOString?.());
    ok("…shiprocket.status updated", after.shiprocket?.status === "UNDELIVERED", after.shiprocket?.status);

    const untimed = await applyCourierEvent(ev(target, 17, "OUT FOR DELIVERY", { eventAt: null }), { source: "webhook" });
    after = await reload(target.order._id);
    ok("an event without a time skips the guard and applies", after.orderStatus === "Out For Delivery", after.orderStatus);
    ok("…reported not stale", untimed?.stale === false, JSON.stringify(untimed));
    ok("…lastEventAt left at T+1h (never stamped with receipt time)",
      sameInstant(after.shiprocket?.lastEventAt, newer), after.shiprocket?.lastEventAt?.toISOString?.());
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("5 — webhook-level courier time parsing");
  {
    const T = secondsAligned(Date.now() - 3 * HOUR);
    const target = await makeOrder({ orderStatus: "Out For Delivery",
      shiprocket: { status: "OUT FOR DELIVERY", statusCode: 17, lastEventAt: T } });

    const older = await sendWebhook({
      sr_order_id: target.srOrderId, awb: target.awbCode,
      shipment_status_id: 21, shipment_status: "UNDELIVERED",
      current_timestamp: istDayFirst(new Date(T.getTime() - HOUR)),
    });
    let after = await reload(target.order._id);
    ok("older 'DD MM YYYY HH:mm:ss' event: 200", older.statusCode === 200, String(older.statusCode));
    ok("…reported stale", older.body?.stale === true, JSON.stringify(older.body));
    ok("…no status change", after.orderStatus === "Out For Delivery", after.orderStatus);
    ok("…lastEventAt unchanged", sameInstant(after.shiprocket?.lastEventAt, T), after.shiprocket?.lastEventAt?.toISOString?.());

    const newer = new Date(T.getTime() + HOUR);
    const viaScans = await sendWebhook({
      sr_order_id: target.srOrderId, awb: target.awbCode,
      shipment_status_id: 21, shipment_status: "UNDELIVERED",
      // current_timestamp is older than stored; the newest scan must win.
      current_timestamp: istDayFirst(new Date(T.getTime() - 2 * HOUR)),
      scans: [
        { date: istYearFirst(new Date(T.getTime() - 3 * HOUR)), activity: "old" },
        { date: istYearFirst(newer), activity: "Undelivered" },
      ],
    });
    after = await reload(target.order._id);
    ok("newer scans[] event: 200", viaScans.statusCode === 200, String(viaScans.statusCode));
    ok("…applied (NDR)", after.orderStatus === "NDR", after.orderStatus);
    ok("…lastEventAt = latest scan", sameInstant(after.shiprocket?.lastEventAt, newer),
      `${after.shiprocket?.lastEventAt?.toISOString?.()} vs ${newer.toISOString()}`);

    const junk = await sendWebhook({
      sr_order_id: target.srOrderId, awb: target.awbCode,
      shipment_status_id: 17, shipment_status: "OUT FOR DELIVERY",
      current_timestamp: "05 06 2024",
    });
    after = await reload(target.order._id);
    ok("unparseable time: 200", junk.statusCode === 200, String(junk.statusCode));
    ok("…guard skipped, event applied", after.orderStatus === "Out For Delivery", after.orderStatus);
    ok("…lastEventAt not stamped", sameInstant(after.shiprocket?.lastEventAt, newer), after.shiprocket?.lastEventAt?.toISOString?.());
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("6 — genuine repeats: OFD → NDR → OFD all apply");
  {
    const target = await makeOrder({ orderStatus: "Shipped" });
    for (const [code, text] of [[17, "OUT FOR DELIVERY"], [21, "UNDELIVERED"], [17, "OUT FOR DELIVERY"]]) {
      await applyCourierEvent(ev(target, code, text), { source: "webhook" });
    }
    const after = await reload(target.order._id);
    ok("three history entries", (after.statusHistory || []).length === 3, JSON.stringify(hopsOf(after)));
    ok("OFD, NDR, OFD in order",
      JSON.stringify((after.statusHistory || []).map((h) => h.to)) ===
        JSON.stringify(["Out For Delivery", "NDR", "Out For Delivery"]),
      JSON.stringify(hopsOf(after)));
    ok("single hops are tagged with the webhook source",
      (after.statusHistory || []).every((h) => h.source === "shiprocket_webhook"),
      JSON.stringify((after.statusHistory || []).map((h) => h.source)));
    ok("ends Out For Delivery", after.orderStatus === "Out For Delivery", after.orderStatus);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("7 — code 10 (RTO delivered) and the refund obligation");
  {
    const delivered = await makeOrder({ orderStatus: "Delivered", paymentMethod: "RAZORPAY", paymentStatus: "Paid",
      deliveredAt: new Date(Date.now() - 2 * HOUR) });
    const res = await applyCourierEvent(ev(delivered, 10, "RTO DELIVERED"), { source: "webhook" });
    const after = await reload(delivered.order._id);
    ok("Delivered prepaid + code 10: stays Delivered", after.orderStatus === "Delivered", after.orderStatus);
    ok("…no hops", Array.isArray(res?.hops) && res.hops.length === 0, JSON.stringify(res));
    ok("…NO 'RTO <id>' refund row", rtoRows(after).length === 0, JSON.stringify(after.refunds));
  }
  {
    const atRto = await makeOrder({ orderStatus: "RTO", paymentMethod: "RAZORPAY", paymentStatus: "Paid",
      shiprocket: { syncStatus: "rto", status: "RTO IN TRANSIT" } });
    const res = await applyCourierEvent(ev(atRto, 10, "RTO DELIVERED"), { source: "webhook" });
    let after = await reload(atRto.order._id);
    ok("RTO prepaid + code 10: RTO Received", after.orderStatus === "RTO Received", after.orderStatus);
    ok("…one hop", JSON.stringify(res?.hops) === JSON.stringify(["RTO Received"]), JSON.stringify(res));
    ok("…exactly one 'RTO <id>' row", rtoRows(after).length === 1, JSON.stringify(after.refunds));
    ok("…owed", rtoRows(after)[0]?.status === "owed", rtoRows(after)[0]?.status);
    ok("…for the order total", rtoRows(after)[0]?.amount === after.totalAmount,
      `${rtoRows(after)[0]?.amount} vs ${after.totalAmount}`);

    await applyCourierEvent(ev(atRto, 10, "RTO DELIVERED"), { source: "webhook" });
    after = await reload(atRto.order._id);
    ok("replay: still exactly one row", rtoRows(after).length === 1, String(rtoRows(after).length));
    ok("replay: no new history", (after.statusHistory || []).length === 1, JSON.stringify(hopsOf(after)));
  }
  {
    const shipped = await makeOrder({ orderStatus: "Shipped", paymentMethod: "RAZORPAY", paymentStatus: "Paid" });
    const res = await applyCourierEvent(ev(shipped, 10, "RTO DELIVERED"), { source: "webhook" });
    const after = await reload(shipped.order._id);
    ok("Shipped + code 10 (missed RTO): RTO Received", after.orderStatus === "RTO Received", after.orderStatus);
    ok("…via RTO, 2 hops", JSON.stringify(res?.hops) === JSON.stringify(["RTO", "RTO Received"]), JSON.stringify(res));
    ok("…history Shipped→RTO, RTO→RTO Received",
      JSON.stringify(hopsOf(after)) === JSON.stringify(["Shipped->RTO", "RTO->RTO Received"]), JSON.stringify(hopsOf(after)));
    ok("…tagged shiprocket_catchup",
      (after.statusHistory || []).every((h) => h.source === "shiprocket_catchup"));
    ok("…syncStatus rto", after.shiprocket?.syncStatus === "rto", after.shiprocket?.syncStatus);
    ok("…exactly one owed 'RTO <id>' row",
      rtoRows(after).length === 1 && rtoRows(after)[0].status === "owed", JSON.stringify(after.refunds));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("8 — courier cancellation codes and other exceptions");
  for (const code of [8, 45]) {
    const target = await makeOrder({ orderStatus: "Cancelled", paymentMethod: "COD", paymentStatus: "Pending",
      shiprocket: { syncStatus: "created", awbCode: null } });
    target.awbCode = "";
    const res = await applyCourierEvent(ev(target, code, "CANCELED"), { source: "webhook" });
    const after = await reload(target.order._id);
    ok(`code ${code} on a locally Cancelled order: syncStatus cancelled`,
      after.shiprocket?.syncStatus === "cancelled", after.shiprocket?.syncStatus);
    ok(`code ${code}: result.adoptedCancellation`, res?.adoptedCancellation === true, JSON.stringify(res));
    ok(`code ${code}: no exception stored`, !after.shiprocket?.exception, JSON.stringify(after.shiprocket?.exception));
    ok(`code ${code}: still Cancelled`, after.orderStatus === "Cancelled", after.orderStatus);
  }
  {
    const target = await makeOrder({ orderStatus: "Shipped" });
    await applyCourierEvent(ev(target, 12, "LOST"), { source: "webhook" });
    const after = await reload(target.order._id);
    ok("code 12 on Shipped: status unchanged", after.orderStatus === "Shipped", after.orderStatus);
    ok("…exception {code:12, meaning:'lost in transit'}",
      after.shiprocket?.exception?.code === 12 && after.shiprocket?.exception?.meaning === "lost in transit",
      JSON.stringify(after.shiprocket?.exception));
    ok("…no history entry", (after.statusHistory || []).length === 0);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("9 — 19 / 27 record the raw status only");
  for (const [code, text] of [[19, "OUT FOR PICKUP"], [27, "PICKUP BOOKED"]]) {
    const target = await makeOrder({ orderStatus: "Confirmed", shiprocket: { syncStatus: "pickup_scheduled", status: "AWB ASSIGNED" } });
    const res = await applyCourierEvent(ev(target, code, text), { source: "webhook" });
    const after = await reload(target.order._id);
    ok(`code ${code} on Confirmed: no status change`, after.orderStatus === "Confirmed", after.orderStatus);
    ok(`code ${code}: no hops / no history`,
      (res?.hops || []).length === 0 && (after.statusHistory || []).length === 0, JSON.stringify(res));
    ok(`code ${code}: shiprocket.status recorded`, after.shiprocket?.status === text, after.shiprocket?.status);
    ok(`code ${code}: shiprocket.statusCode recorded`, after.shiprocket?.statusCode === code, String(after.shiprocket?.statusCode));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("10 — a MANUAL shipment reached by order_id keeps its own tracking");
  {
    const target = await makeOrder({
      orderStatus: "Shipped",
      withShiprocket: false,
      shipment: { provider: "MANUAL", carrierName: "Hand Courier", trackingNumber: `MAN-${MARKER}`, status: "Shipped" },
    });
    const res = await applyCourierEvent(
      { sourceOrderId: String(target.order._id), shiprocketOrderId: null, awbCode: `AWB-${MARKER}-manual`,
        statusCode: 17, currentStatus: "OUT FOR DELIVERY", courierName: "Some Courier", eventAt: null },
      { source: "webhook" },
    );
    const after = await reload(target.order._id);
    ok("resolved to the order", res?.scope === "order" && res?.orderId === String(target.order._id), JSON.stringify(res));
    ok("shipment.provider stays MANUAL", after.shipment?.provider === "MANUAL", after.shipment?.provider);
    ok("shipment.trackingNumber unchanged", after.shipment?.trackingNumber === `MAN-${MARKER}`, after.shipment?.trackingNumber);
    ok("shipment.carrierName unchanged", after.shipment?.carrierName === "Hand Courier", after.shipment?.carrierName);
    // Recorded rather than asserted strictly: the plan does not say whether a MANUAL
    // order's status follows a courier event reached by our own _id.
    console.log(`       (MANUAL order status after OFD event: ${after.orderStatus})`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("11 — identity: refuse rather than guess");
  {
    const a = await makeOrder({ orderStatus: "Shipped" });
    const b = await makeOrder({ orderStatus: "Shipped" });

    // Ambiguity needs two orders sharing one AWB. Attempted with a raw insert; the
    // unique partial index is expected to refuse it, which makes the ambiguous branch
    // structurally unreachable for new data (webhook-identity covers it by dropping
    // the index, which this suite deliberately does not do on a shared database).
    const raw = (await OrderModel.findById(a.order._id).lean());
    delete raw._id;
    raw.shiprocket = { ...raw.shiprocket, orderId: null };
    let duplicateBlocked = false;
    let insertedId = null;
    try {
      const inserted = await OrderModel.collection.insertOne(raw);
      insertedId = inserted.insertedId;
      trash.orders.push(insertedId);
    } catch (error) {
      duplicateBlocked = error?.code === 11000;
    }
    if (duplicateBlocked) {
      ok("a raw insert of a duplicate AWB is refused by the unique index (ambiguous case skipped)", true);
    } else {
      const res = await applyCourierEvent({ awbCode: a.awbCode, statusCode: 7, currentStatus: "DELIVERED" });
      ok("two orders sharing an AWB: ignored", res?.scope === "ignored", JSON.stringify(res));
      ok("…as ambiguous_awb", res?.reason === "ambiguous_awb", res?.reason);
      const [sa, sb] = [await reload(a.order._id), await reload(insertedId)];
      ok("…neither order moved", sa.orderStatus === "Shipped" && sb.orderStatus === "Shipped");
    }

    const conflict = await applyCourierEvent(
      { shiprocketOrderId: a.srOrderId, awbCode: b.awbCode, statusCode: 7, currentStatus: "DELIVERED" },
    );
    ok("sr_order_id of A + AWB of B: ignored", conflict?.scope === "ignored", JSON.stringify(conflict));
    ok("…reason conflicting_identifiers", conflict?.reason === "conflicting_identifiers", conflict?.reason);
    const [ca, cb] = [await reload(a.order._id), await reload(b.order._id)];
    ok("…neither order moved", ca.orderStatus === "Shipped" && cb.orderStatus === "Shipped",
      `${ca.orderStatus}/${cb.orderStatus}`);

    const unknown = await applyCourierEvent({ awbCode: `AWB-${MARKER}-unknown`, statusCode: 7, currentStatus: "DELIVERED" });
    ok("unknown AWB: ignored no_match", unknown?.scope === "ignored" && unknown?.reason === "no_match", JSON.stringify(unknown));

    const viaWebhook = await sendWebhook({ awb: `AWB-${MARKER}-unknown`, shipment_status_id: 7, shipment_status: "DELIVERED" });
    ok("unknown AWB via webhook: 200", viaWebhook.statusCode === 200, String(viaWebhook.statusCode));
    ok("…body says ignored no_match", viaWebhook.body?.success === true && viaWebhook.body?.reason === "no_match",
      JSON.stringify(viaWebhook.body));

    const event = courierEventFromWebhook({ sr_order_id: String(a.srOrderId), awb: ` ${a.awbCode} `, current_status_id: "17" });
    ok("courierEventFromWebhook normalises ids and codes",
      event.shiprocketOrderId === a.srOrderId && event.awbCode === a.awbCode && event.statusCode === 17,
      JSON.stringify(event));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("12 — webhook authentication and the capability switch");
  {
    const target = await makeOrder({ orderStatus: "Shipped" });
    const body = { sr_order_id: target.srOrderId, awb: target.awbCode, shipment_status_id: 17, shipment_status: "OUT FOR DELIVERY" };

    const missing = await sendWebhook(body, { token: null });
    ok("missing x-api-key: 401", missing.statusCode === 401, String(missing.statusCode));
    const wrong = await sendWebhook(body, { token: "wrong-token-value" });
    ok("wrong x-api-key: 401", wrong.statusCode === 401, String(wrong.statusCode));
    let after = await reload(target.order._id);
    ok("…and nothing changed", after.orderStatus === "Shipped" && (after.statusHistory || []).length === 0, after.orderStatus);

    const restoreOff = await pinShiprocketCapabilities({ deliveryWebhookEnabled: false });
    let disabled;
    try {
      disabled = await sendWebhook(body);
    } finally {
      restoreOff();
    }
    after = await reload(target.order._id);
    ok("capability off: 200", disabled.statusCode === 200, String(disabled.statusCode));
    ok("…says disabled", /disabled/i.test(disabled.body?.message || ""), JSON.stringify(disabled.body));
    ok("…no DB change", after.orderStatus === "Shipped" && (after.statusHistory || []).length === 0
      && after.shiprocket?.status === "IN TRANSIT", `${after.orderStatus} ${after.shiprocket?.status}`);

    const good = await sendWebhook(body);
    after = await reload(target.order._id);
    ok("correct x-api-key: 200", good.statusCode === 200, String(good.statusCode));
    ok("…body {success:true, scope:'order', hops:['Out For Delivery']}",
      good.body?.success === true && good.body?.scope === "order"
        && JSON.stringify(good.body?.hops) === JSON.stringify(["Out For Delivery"]) && good.body?.stale === false,
      JSON.stringify(good.body));
    ok("…applied", after.orderStatus === "Out For Delivery", after.orderStatus);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("13 — a return's pickup leg");
  {
    const delivered = await makeOrder({ orderStatus: "Delivered", paymentMethod: "COD", paymentStatus: "Paid",
      withShiprocket: false, deliveredAt: new Date(Date.now() - 24 * HOUR) });
    const p = await product();
    const pickupAwb = `RPICK-${MARKER}`;
    const returnRequest = await ReturnModel.create({
      order: delivered.order._id,
      user: delivered.order.user,
      product: p._id,
      productSnapshot: { name: p.name, image: "x.png", price: p.price },
      quantity: 1,
      reason: "damaged on arrival",
      refundAmount: p.price,
      resolutionType: "refund",
      status: "pickup_scheduled",
      returnNumber: `${MARKER}-RET-1`,
      pickupAwb,
    });
    trash.returns.push(returnRequest._id);

    const res = await sendWebhook({ awb: pickupAwb, shipment_status_id: 18, shipment_status: "IN TRANSIT" });
    const after = await ReturnModel.findById(returnRequest._id).lean();
    ok("200", res.statusCode === 200, String(res.statusCode));
    ok("resolved to scope 'return', leg pickup", res.body?.scope === "return" && res.body?.leg === "pickup",
      JSON.stringify(res.body));
    ok("pickupCourierStatus written", after.pickupCourierStatus === "IN TRANSIT", after.pickupCourierStatus);
    ok("pickupCourierUpdatedAt stamped", Boolean(after.pickupCourierUpdatedAt));
    ok("return status unchanged", after.status === "pickup_scheduled", after.status);
    const order = await reload(delivered.order._id);
    ok("the parent order is untouched", order.orderStatus === "Delivered" && (order.statusHistory || []).length === 0,
      order.orderStatus);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("14 — leaving NDR clears the ndr syncStatus");
  {
    const target = await makeOrder({ orderStatus: "Shipped" });
    await applyCourierEvent(ev(target, 21, "UNDELIVERED", { ndrReason: "Door locked" }), { source: "webhook" });
    let after = await reload(target.order._id);
    ok("NDR sets syncStatus ndr", after.orderStatus === "NDR" && after.shiprocket?.syncStatus === "ndr",
      `${after.orderStatus} ${after.shiprocket?.syncStatus}`);

    await applyCourierEvent(ev(target, 17, "OUT FOR DELIVERY"), { source: "webhook" });
    after = await reload(target.order._id);
    ok("…a re-attempt (OFD) resets it to awb_assigned",
      after.orderStatus === "Out For Delivery" && after.shiprocket?.syncStatus === "awb_assigned",
      `${after.orderStatus} ${after.shiprocket?.syncStatus}`);
    ok("…and keeps the ndrReason for the record", after.shiprocket?.ndrReason === "Door locked", after.shiprocket?.ndrReason);

    await applyCourierEvent(ev(target, 7, "DELIVERED"), { source: "webhook" });
    after = await reload(target.order._id);
    ok("…Delivered leaves it at awb_assigned",
      after.orderStatus === "Delivered" && after.shiprocket?.syncStatus === "awb_assigned",
      `${after.orderStatus} ${after.shiprocket?.syncStatus}`);

    const direct = await makeOrder({ orderStatus: "Shipped" });
    await applyCourierEvent(ev(direct, 21, "UNDELIVERED"), { source: "webhook" });
    await applyCourierEvent(ev(direct, 7, "DELIVERED"), { source: "webhook" });
    const directAfter = await reload(direct.order._id);
    ok("NDR straight to Delivered also resets it",
      directAfter.orderStatus === "Delivered" && directAfter.shiprocket?.syncStatus === "awb_assigned",
      `${directAfter.orderStatus} ${directAfter.shiprocket?.syncStatus}`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("15 — a delivered pickup leg marks the return received");
  {
    const delivered = await makeOrder({ orderStatus: "Delivered", paymentMethod: "COD", paymentStatus: "Paid",
      withShiprocket: false, deliveredAt: new Date(Date.now() - 24 * HOUR) });
    const p = await product();
    const pickupAwb = `RPICKD-${MARKER}`;
    const returnRequest = await ReturnModel.create({
      order: delivered.order._id,
      user: delivered.order.user,
      product: p._id,
      productSnapshot: { name: p.name, image: "x.png", price: p.price },
      quantity: 1,
      reason: "damaged on arrival",
      refundAmount: p.price,
      resolutionType: "refund",
      status: "pickup_scheduled",
      returnNumber: `${MARKER}-RET-2`,
      pickupAwb,
    });
    trash.returns.push(returnRequest._id);

    const res = await sendWebhook({ awb: pickupAwb, shipment_status_id: 7, shipment_status: "DELIVERED" });
    const after = await ReturnModel.findById(returnRequest._id).lean();
    ok("resolved to the pickup leg and reported as a move",
      res.body?.scope === "return" && res.body?.leg === "pickup" && res.body?.statusUnchanged === false,
      JSON.stringify(res.body));
    ok("return is received, with receivedAt", after.status === "received" && Boolean(after.receivedAt), after.status);
    const replay = await sendWebhook({ awb: pickupAwb, shipment_status_id: 7, shipment_status: "DELIVERED" });
    const replayed = await ReturnModel.findById(returnRequest._id).lean();
    ok("a replay is a no-op",
      replay.body?.statusUnchanged === true &&
        replayed.statusHistory.filter((h) => h.status === "received").length === 1,
      JSON.stringify(replay.body));
    const order = await reload(delivered.order._id);
    ok("the parent order is untouched", order.orderStatus === "Delivered" && (order.statusHistory || []).length === 0,
      order.orderStatus);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("Z — the pipeline never called Shiprocket");
  ok("zero outbound fetch calls", fetchCalls.length === 0, JSON.stringify(fetchCalls));
} catch (error) {
  console.error(`\nSUITE ABORTED: ${error?.stack || error}`);
  ok("suite ran to completion", false, error?.message);
} finally {
  globalThis.fetch = originalFetch;
  await ReturnModel.deleteMany({ _id: { $in: trash.returns } });
  await OrderModel.deleteMany({ _id: { $in: trash.orders } });
  await ProductModel.deleteMany({ _id: { $in: trash.products } });
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
