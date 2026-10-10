/**
 * Courier recovery (Phase B) — courier options, reassignment, and NDR resolution.
 *
 * Both features exist so an operator stops needing a second dashboard, or a developer:
 *
 *   `AssignAwb` accepted a `courierId` that nothing in the product ever told the admin,
 *   so in practice it was called with none and Shiprocket picked. Choosing a courier is a
 *   cost decision, and the rates were never shown.
 *
 *   NDR events arrived on the webhook and were stored, but could not be ACTED on. Every
 *   failed delivery was resolved in Shiprocket's dashboard, and this system drifted.
 *
 * Three properties carry the safety of this phase:
 *
 *   A REASSIGN THAT DIDN'T HAPPEN IS NOT A SUCCESS. `AssignAwb` used `data.awb_code ||
 *   order.shiprocket.awbCode`, which is right for a first assignment and quietly wrong
 *   for a reassign: a response with no new AWB left the old one in place and still
 *   answered "AWB assigned", so the admin believed the courier had changed.
 *
 *   AN AWB COLLISION IS A REFUSAL, NOT A 500. H2-01's unique partial index on
 *   `shiprocket.awbCode` rejects an AWB already recorded against another order; that
 *   surfaced as a raw Mongo error with no indication the assignment had been rejected.
 *
 *   THE COURIER IS ASKED BEFORE THE ORDER MOVES. An NDR action that moved the order first
 *   would show "re-attempt requested" for a re-attempt the courier never accepted.
 *
 * Run with `npm run test:courier-recovery` (or `npm test` for everything).
 *
 * Shiprocket is never contacted: `globalThis.fetch` is stubbed, which is also what lets
 * responses be made hostile. `ShiprocketSetting.getSettings` is stubbed on the model
 * rather than written to — it is a singleton shared with the running dev store.
 */
process.env.PAYMENTS_ENABLED = "false";
process.env.INVENTORY_ENFORCE_STOCK = "false";
process.env.INVENTORY_RESERVE_DURING_PAYMENT = "false";
process.env.NOTIFICATIONS_ENABLED = "false";

import mongoose from "mongoose";
import { connect, createSuite, marker, productFixture, addressFixture } from "./helpers.mjs";

const { ok, section, finish } = createSuite("courier-recovery");
await connect();

const OrderModel = (await import("../../src/modules/orders/Order.model.js")).default;
const ProductModel = (await import("../../src/modules/products/Product.model.js")).default;
const ShiprocketSetting = (await import("../../src/modules/shipping/ShiprocketSetting.model.js")).default;
const shippingController = await import("../../src/modules/shipping/shipping.controller.js");
const { canTransitionOrderStatus } = await import("../../src/modules/orders/order-status.rules.js");

await OrderModel.init();

const MARKER = marker("courierrec");
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
process.env.SHIPROCKET_ENABLED = "true";
process.env.SHIPROCKET_AUTO_CREATE_ORDER = "true";
process.env.SHIPROCKET_WEBHOOK_ENABLED = "true";

let calls = [];
let serviceabilityResponder = () => ({ status: 200, body: { data: { available_courier_companies: [] } } });
let awbResponder = () => ({ status: 200, body: { response: { data: { awb_code: "NEW-AWB", courier_company_id: 11, courier_name: "Stub Express" } } } });
let ndrResponder = () => ({ status: 200, body: { status: 200, message: "accepted" } });

const jsonResponse = ({ status = 200, body = {} }) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
});

globalThis.fetch = async (url, options) => {
  const href = String(url);
  calls.push({ href, method: options?.method || "GET", body: options?.body });
  if (href.includes("/auth/login")) {
    return jsonResponse({ status: 200, body: { token: "stub-token" } });
  }
  const route = href.includes("/courier/serviceability/")
    ? serviceabilityResponder
    : href.includes("/courier/assign/awb")
      ? awbResponder
      : href.includes("/ndr/")
        ? ndrResponder
        : null;
  if (!route) throw new Error(`unexpected Shiprocket call in test: ${href}`);
  const outcome = route(href, options);
  if (outcome instanceof Error) throw outcome;
  return jsonResponse(outcome);
};

const resetCalls = () => {
  calls = [];
};
const callsTo = (fragment) => calls.filter((c) => c.href.includes(fragment));

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

const makeOrder = async ({ shiprocket = {}, ...overrides } = {}) => {
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
    ...overrides,
  });
  trash.orders.push(order._id);
  return order;
};

// ================================================================ B1 — COURIER OPTIONS

section("B1 — courier options");

{
  serviceabilityResponder = () => ({
    status: 200,
    body: {
      data: {
        available_courier_companies: [
          { courier_company_id: 22, courier_name: "Pricey Post", rate: 95, cod: 1, estimated_delivery_days: 2 },
          { courier_company_id: 11, courier_name: "Cheap Cart", rate: 42, cod: 1, estimated_delivery_days: 5 },
          { courier_company_id: 33, courier_name: "Prepaid Only", rate: 30, cod: 0, estimated_delivery_days: 3 },
        ],
      },
    },
  });
  const order = await makeOrder({ shiprocket: { orderId: 900, shipmentId: 901, courierId: 11 } });
  resetCalls();
  const result = await callController(shippingController.GetCourierOptions, {
    params: { orderId: String(order._id) },
    user: adminUser(),
  });

  ok(
    "the couriers that serve this order are listed",
    result.statusCode === 200 && result.body?.couriers?.length === 3,
    `${result.statusCode} ${JSON.stringify(result.body?.couriers?.length)}`,
  );
  ok(
    "cheapest first — the admin is making a cost decision",
    result.body?.couriers?.map((c) => c.rate).join(",") === "30,42,95",
    JSON.stringify(result.body?.couriers?.map((c) => c.rate)),
  );
  ok(
    "the courier already carrying the parcel is marked, not presented as a fresh choice",
    result.body?.couriers?.find((c) => c.courierId === 11)?.current === true &&
      result.body?.currentCourierId === 11,
    JSON.stringify(result.body?.couriers?.map((c) => ({ id: c.courierId, current: c.current }))),
  );
  ok(
    "COD support is reported per courier",
    result.body?.couriers?.find((c) => c.courierId === 33)?.codAvailable === false,
    JSON.stringify(result.body?.couriers?.find((c) => c.courierId === 33)),
  );

  // Derived from the ORDER, never from query parameters an admin assembles by hand.
  const query = new URL(callsTo("/courier/serviceability/")[0].href).searchParams;
  ok(
    "the route comes from the order's own delivery pincode",
    query.get("delivery_postcode") === "411001",
    query.get("delivery_postcode"),
  );
  ok(
    "and cod=1 because this order is COD — prepaid-only couriers would be useless",
    query.get("cod") === "1",
    query.get("cod"),
  );
}

{
  const order = await makeOrder({
    paymentMethod: "RAZORPAY",
    paymentStatus: "Paid",
    shiprocket: { orderId: 902, shipmentId: 903 },
  });
  resetCalls();
  await callController(shippingController.GetCourierOptions, {
    params: { orderId: String(order._id) },
    user: adminUser(),
  });
  const query = new URL(callsTo("/courier/serviceability/")[0].href).searchParams;
  ok(
    "a prepaid order asks without the COD constraint",
    query.get("cod") === "0",
    query.get("cod"),
  );
}

{
  serviceabilityResponder = () => ({ status: 200, body: {} });
  const order = await makeOrder({ shiprocket: { orderId: 904, shipmentId: 905 } });
  const result = await callController(shippingController.GetCourierOptions, {
    params: { orderId: String(order._id) },
    user: adminUser(),
  });
  ok(
    "an unreadable response is an error, not an empty courier list",
    result.statusCode === 502,
    `${result.statusCode} ${JSON.stringify(result.body?.message)}`,
  );
}

{
  serviceabilityResponder = () => ({ status: 200, body: { data: { available_courier_companies: [] } } });
  const order = await makeOrder({ shiprocket: { orderId: 906, shipmentId: 907 } });
  const result = await callController(shippingController.GetCourierOptions, {
    params: { orderId: String(order._id) },
    user: adminUser(),
  });
  ok(
    "genuinely no courier is 200 with an empty list — distinct from unreadable",
    result.statusCode === 200 && result.body?.couriers?.length === 0,
    `${result.statusCode} ${JSON.stringify(result.body)}`,
  );
}

{
  const order = await makeOrder({ orderStatus: "Cancelled", shiprocket: { orderId: 908, shipmentId: 909 } });
  resetCalls();
  const result = await callController(shippingController.GetCourierOptions, {
    params: { orderId: String(order._id) },
    user: adminUser(),
  });
  ok(
    "a cancelled order cannot have couriers listed for it",
    result.statusCode === 409 && callsTo("/courier/serviceability/").length === 0,
    `${result.statusCode} ${JSON.stringify(result.body?.message)}`,
  );
}

// ================================================================ B1 — REASSIGNMENT

section("B1 — reassignment");

{
  serviceabilityResponder = () => ({ status: 200, body: { data: { available_courier_companies: [] } } });
  awbResponder = () => ({
    status: 200,
    body: { response: { data: { awb_code: `${MARKER}-first`, courier_company_id: 11, courier_name: "Cheap Cart" } } },
  });
  const order = await makeOrder({ shiprocket: { orderId: 910, shipmentId: 911 } });
  const result = await callController(shippingController.AssignAwb, {
    params: { orderId: String(order._id) },
    body: { courierId: 11 },
    user: adminUser(),
  });
  const after = await OrderModel.findById(order._id).select("shiprocket shipment");
  ok(
    "a first assignment works and is described as an assignment",
    result.statusCode === 200 && result.body?.message === "AWB assigned",
    `${result.statusCode} ${JSON.stringify(result.body?.message)}`,
  );
  ok(
    "the AWB and courier are stored",
    after.shiprocket?.awbCode === `${MARKER}-first` && after.shiprocket?.courierId === 11,
    JSON.stringify({ awb: after.shiprocket?.awbCode, courier: after.shiprocket?.courierId }),
  );
  ok(
    "and mirrored to the provider-neutral shipment record",
    after.shipment?.trackingNumber === `${MARKER}-first` && after.shipment?.provider === "SHIPROCKET",
    JSON.stringify(after.shipment),
  );
}

{
  awbResponder = () => ({
    status: 200,
    body: { response: { data: { awb_code: `${MARKER}-second`, courier_company_id: 22, courier_name: "Pricey Post" } } },
  });
  const order = await makeOrder({
    shiprocket: { orderId: 912, shipmentId: 913, awbCode: `${MARKER}-old`, courierId: 11, courierName: "Cheap Cart" },
  });
  const result = await callController(shippingController.AssignAwb, {
    params: { orderId: String(order._id) },
    body: { courierId: 22 },
    user: adminUser(),
  });
  const after = await OrderModel.findById(order._id).select("shiprocket shipment");
  ok(
    "a reassignment is described as a reassignment, with the previous AWB reported",
    result.statusCode === 200 &&
      result.body?.message === "Courier reassigned" &&
      result.body?.previousAwb === `${MARKER}-old`,
    `${result.statusCode} ${JSON.stringify({ m: result.body?.message, p: result.body?.previousAwb })}`,
  );
  ok(
    "the new AWB and courier replace the old ones",
    after.shiprocket?.awbCode === `${MARKER}-second` && after.shiprocket?.courierName === "Pricey Post",
    JSON.stringify({ awb: after.shiprocket?.awbCode, courier: after.shiprocket?.courierName }),
  );
  ok(
    "and the customer-facing tracking number follows",
    after.shipment?.trackingNumber === `${MARKER}-second`,
    String(after.shipment?.trackingNumber),
  );
}

{
  // The bug this phase fixes. `data.awb_code || order.shiprocket.awbCode` kept the old
  // AWB and still answered success, so the admin believed the courier had changed.
  awbResponder = () => ({ status: 200, body: { response: { data: { courier_name: "Pricey Post" } } } });
  const order = await makeOrder({
    shiprocket: { orderId: 914, shipmentId: 915, awbCode: `${MARKER}-keep`, courierId: 11 },
  });
  const result = await callController(shippingController.AssignAwb, {
    params: { orderId: String(order._id) },
    body: { courierId: 22 },
    user: adminUser(),
  });
  const after = await OrderModel.findById(order._id).select("shiprocket");
  ok(
    "a reassign with no new AWB is refused, not reported as success",
    result.statusCode === 409 && /still with the original courier/i.test(result.body?.message || ""),
    `${result.statusCode} ${JSON.stringify(result.body?.message)}`,
  );
  ok(
    "and the order keeps the AWB it really has",
    after.shiprocket?.awbCode === `${MARKER}-keep` && after.shiprocket?.courierId === 11,
    JSON.stringify({ awb: after.shiprocket?.awbCode, courier: after.shiprocket?.courierId }),
  );
}

{
  // Same AWB returned again is also "nothing changed" — the parcel is still with the
  // courier it was with, whatever the response says about the courier name.
  awbResponder = () => ({
    status: 200,
    body: { response: { data: { awb_code: `${MARKER}-same`, courier_company_id: 22, courier_name: "Pricey Post" } } },
  });
  const order = await makeOrder({
    shiprocket: { orderId: 916, shipmentId: 917, awbCode: `${MARKER}-same`, courierId: 11 },
  });
  const result = await callController(shippingController.AssignAwb, {
    params: { orderId: String(order._id) },
    body: { courierId: 22 },
    user: adminUser(),
  });
  ok(
    "the same AWB coming back is treated as no change",
    result.statusCode === 409,
    `${result.statusCode} ${JSON.stringify(result.body?.message)}`,
  );
}

{
  // The unique partial index from H2-01 rejecting an identity collision. Before this it
  // was a raw 500 that gave no indication the assignment had been rejected.
  const holder = await makeOrder({
    shiprocket: { orderId: 918, shipmentId: 919, awbCode: `${MARKER}-taken` },
  });
  ok(
    "precondition: another order already owns the AWB we are about to be handed",
    Boolean(await OrderModel.exists({ _id: holder._id, "shiprocket.awbCode": `${MARKER}-taken` })),
    "holder not found",
  );

  awbResponder = () => ({
    status: 200,
    body: { response: { data: { awb_code: `${MARKER}-taken`, courier_company_id: 22, courier_name: "Pricey Post" } } },
  });
  const order = await makeOrder({
    shiprocket: { orderId: 920, shipmentId: 921, awbCode: `${MARKER}-mine`, courierId: 11 },
  });
  const result = await callController(shippingController.AssignAwb, {
    params: { orderId: String(order._id) },
    body: { courierId: 22 },
    user: adminUser(),
  });
  const after = await OrderModel.findById(order._id).select("shiprocket.awbCode");
  ok(
    "an AWB already recorded against another order is a 409, not a 500",
    result.statusCode === 409 && /already recorded against another order/i.test(result.body?.message || ""),
    `${result.statusCode} ${JSON.stringify(result.body?.message)}`,
  );
  ok(
    "and the order keeps its previous AWB rather than being left with neither",
    after.shiprocket?.awbCode === `${MARKER}-mine`,
    String(after.shiprocket?.awbCode),
  );
}

// ================================================================ B2 — NDR

section("B2 — resolving a failed delivery");

{
  ndrResponder = () => ({ status: 200, body: { status: 200, message: "accepted" } });
  const order = await makeOrder({
    orderStatus: "NDR",
    shiprocket: { orderId: 930, shipmentId: 931, awbCode: `${MARKER}-ndr1`, syncStatus: "ndr" },
  });
  resetCalls();
  const result = await callController(shippingController.ResolveNdr, {
    params: { orderId: String(order._id) },
    body: { action: "reattempt", comment: "gate code 4421" },
    user: adminUser(),
  });
  const after = await OrderModel.findById(order._id).select("orderStatus statusHistory shipment");
  ok(
    "re-attempt moves the order to Out For Delivery",
    result.statusCode === 200 && after.orderStatus === "Out For Delivery",
    `${result.statusCode} ${after.orderStatus}`,
  );
  ok(
    "the courier was actually asked",
    callsTo("/ndr/").length === 1 && callsTo("/ndr/")[0].method === "POST",
    JSON.stringify(callsTo("/ndr/").map((c) => c.href)),
  );
  ok(
    "the admin's note is passed to the courier",
    /gate code 4421/.test(callsTo("/ndr/")[0].body || ""),
    callsTo("/ndr/")[0].body,
  );
  ok(
    "the move is recorded in history, attributed to the NDR action",
    after.statusHistory?.some((entry) => entry.from === "NDR" && entry.source === "ndr_action"),
    JSON.stringify(after.statusHistory),
  );
}

{
  const order = await makeOrder({
    orderStatus: "NDR",
    shiprocket: { orderId: 932, shipmentId: 933, awbCode: `${MARKER}-ndr2`, syncStatus: "ndr" },
  });
  const result = await callController(shippingController.ResolveNdr, {
    params: { orderId: String(order._id) },
    body: { action: "return" },
    user: adminUser(),
  });
  const after = await OrderModel.findById(order._id).select("orderStatus refunds paymentStatus shiprocket.syncStatus");
  ok(
    "return sends the order to RTO",
    result.statusCode === 200 && after.orderStatus === "RTO",
    `${result.statusCode} ${after.orderStatus}`,
  );
  // The money invariant. The refund obligation belongs to the parcel ARRIVING
  // (RTO Received, via the webhook), not to it starting the journey back.
  ok(
    "no refund obligation is created for goods still in transit",
    (after.refunds?.length || 0) === 0 && after.paymentStatus === "Pending",
    JSON.stringify({ refunds: after.refunds?.length, paymentStatus: after.paymentStatus }),
  );
  ok(
    "the shipment sync state records the RTO",
    after.shiprocket?.syncStatus === "rto",
    String(after.shiprocket?.syncStatus),
  );
}

{
  // Ordering. If the order moved first, the admin would see "re-attempt requested" for a
  // re-attempt the courier never accepted.
  ndrResponder = () => new Error("connect ECONNREFUSED");
  const order = await makeOrder({
    orderStatus: "NDR",
    shiprocket: { orderId: 934, shipmentId: 935, awbCode: `${MARKER}-ndr3`, syncStatus: "ndr" },
  });
  const result = await callController(shippingController.ResolveNdr, {
    params: { orderId: String(order._id) },
    body: { action: "reattempt" },
    user: adminUser(),
  });
  const after = await OrderModel.findById(order._id).select("orderStatus statusHistory");
  ok(
    "a courier that cannot be reached is an error",
    result.statusCode >= 400,
    `${result.statusCode} ${JSON.stringify(result.body?.message)}`,
  );
  ok(
    "and the order does NOT claim a re-attempt the courier never accepted",
    after.orderStatus === "NDR" && (after.statusHistory?.length || 0) === 0,
    JSON.stringify({ status: after.orderStatus, history: after.statusHistory?.length }),
  );
}

{
  ndrResponder = () => ({ status: 200, body: { status: 422, message: "AWB not in NDR" } });
  const order = await makeOrder({
    orderStatus: "NDR",
    shiprocket: { orderId: 936, shipmentId: 937, awbCode: `${MARKER}-ndr4`, syncStatus: "ndr" },
  });
  const result = await callController(shippingController.ResolveNdr, {
    params: { orderId: String(order._id) },
    body: { action: "reattempt" },
    user: adminUser(),
  });
  const after = await OrderModel.findById(order._id).select("orderStatus");
  ok(
    "an HTTP 200 carrying an embedded rejection is still a rejection",
    result.statusCode >= 400 && after.orderStatus === "NDR",
    `${result.statusCode} ${after.orderStatus}`,
  );
}

{
  ndrResponder = () => ({ status: 200, body: { status: 200 } });
  const order = await makeOrder({
    orderStatus: "Shipped",
    shiprocket: { orderId: 938, shipmentId: 939, awbCode: `${MARKER}-ndr5` },
  });
  resetCalls();
  const result = await callController(shippingController.ResolveNdr, {
    params: { orderId: String(order._id) },
    body: { action: "reattempt" },
    user: adminUser(),
  });
  ok(
    "an order with no failed delivery cannot be resolved this way",
    result.statusCode === 409 && callsTo("/ndr/").length === 0,
    `${result.statusCode} ${JSON.stringify(result.body?.message)}`,
  );
  ok(
    "which keeps this from becoming a general-purpose status override",
    /NDR/.test(result.body?.message || ""),
    result.body?.message,
  );
}

{
  const order = await makeOrder({
    orderStatus: "NDR",
    shiprocket: { orderId: 940, shipmentId: 941, syncStatus: "ndr" },
  });
  resetCalls();
  const result = await callController(shippingController.ResolveNdr, {
    params: { orderId: String(order._id) },
    body: { action: "reattempt" },
    user: adminUser(),
  });
  ok(
    "no AWB means no parcel for the courier to act on",
    result.statusCode === 409 && callsTo("/ndr/").length === 0,
    `${result.statusCode} ${JSON.stringify(result.body?.message)}`,
  );
}

{
  const order = await makeOrder({
    orderStatus: "NDR",
    shiprocket: { orderId: 942, shipmentId: 943, awbCode: `${MARKER}-ndr6`, syncStatus: "ndr" },
  });
  resetCalls();
  for (const action of ["", "cancel", "deliver", "RTO Received", "reattempt; drop table", null, 7]) {
    const result = await callController(shippingController.ResolveNdr, {
      params: { orderId: String(order._id) },
      body: { action },
      user: adminUser(),
    });
    if (result.statusCode !== 400) {
      ok(`unknown action ${JSON.stringify(action)} is refused`, false, `${result.statusCode}`);
    }
  }
  ok(
    "only the two real decisions are accepted — no arbitrary status is reachable",
    callsTo("/ndr/").length === 0,
    JSON.stringify(callsTo("/ndr/").map((c) => c.href)),
  );
  const after = await OrderModel.findById(order._id).select("orderStatus");
  ok("and the order is untouched by the rejected attempts", after.orderStatus === "NDR", after.orderStatus);
}

{
  // Both targets must be legal moves in the shared rules, not just in this controller.
  ok(
    "re-attempt's target is a legal transition from NDR",
    canTransitionOrderStatus("NDR", "Out For Delivery").ok,
    JSON.stringify(canTransitionOrderStatus("NDR", "Out For Delivery")),
  );
  ok(
    "return's target is a legal transition from NDR",
    canTransitionOrderStatus("NDR", "RTO").ok,
    JSON.stringify(canTransitionOrderStatus("NDR", "RTO")),
  );
}

{
  // Two admins clicking at once. Claim-in-filter means one move, one refusal — never two
  // history entries for one decision.
  ndrResponder = () => ({ status: 200, body: { status: 200 } });
  const order = await makeOrder({
    orderStatus: "NDR",
    shiprocket: { orderId: 944, shipmentId: 945, awbCode: `${MARKER}-ndr7`, syncStatus: "ndr" },
  });
  const [first, second] = await Promise.all([
    callController(shippingController.ResolveNdr, {
      params: { orderId: String(order._id) },
      body: { action: "reattempt" },
      user: adminUser(),
    }),
    callController(shippingController.ResolveNdr, {
      params: { orderId: String(order._id) },
      body: { action: "return" },
      user: adminUser(),
    }),
  ]);
  const after = await OrderModel.findById(order._id).select("orderStatus statusHistory");
  const codes = [first.statusCode, second.statusCode].sort();
  ok(
    "concurrent decisions produce one success and one 409",
    codes[0] === 200 && codes[1] === 409,
    JSON.stringify(codes),
  );
  ok(
    "exactly one status-history entry for one decision",
    (after.statusHistory || []).filter((e) => e.source === "ndr_action").length === 1,
    JSON.stringify(after.statusHistory?.map((e) => e.to)),
  );
}

{
  stored = { ...stored, shipmentsEnabled: false };
  const order = await makeOrder({
    orderStatus: "NDR",
    shiprocket: { orderId: 946, shipmentId: 947, awbCode: `${MARKER}-ndr8`, syncStatus: "ndr" },
  });
  resetCalls();
  const result = await callController(shippingController.ResolveNdr, {
    params: { orderId: String(order._id) },
    body: { action: "reattempt" },
    user: adminUser(),
  });
  ok(
    "manual fulfilment refuses NDR actions — there is no Shiprocket parcel to act on",
    result.statusCode === 409 && callsTo("/ndr/").length === 0,
    `${result.statusCode} ${JSON.stringify(result.body?.message)}`,
  );
  stored = { ...stored, shipmentsEnabled: true };
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
