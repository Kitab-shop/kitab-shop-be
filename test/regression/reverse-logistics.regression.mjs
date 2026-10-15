/**
 * Reverse logistics (Phase C1/C2) — return pickups and replacement parcels.
 *
 * Returns were complete and entirely internal: no courier was ever booked to collect, and
 * a replacement's courier/AWB were free text an operator typed in. Two shipments now exist
 * per return — a collection travelling in and a replacement travelling out.
 *
 * The H2-07 boundary is NOT reopened. `order.shipment` stays singular; both reverse parcels
 * live on the ReturnRequest, which is the right grain because a return is per order line
 * and each can have its own two legs.
 *
 * Four properties carry the safety of this phase:
 *
 *   OFF BY DEFAULT. `reverseShipmentsEnabled` defaults false, unlike the three capabilities
 *   that describe pre-existing behaviour. It books real courier collections at customer
 *   addresses, so a settings document written before the field existed must not opt in.
 *
 *   ONE AWB, ONE LEG, ONE RETURN. `replacementAwb` was unindexed — the same non-unique
 *   courier identifier bug H2-01 fixed for orders, which lets a webhook event land on an
 *   arbitrary record. Both legs are now uniquely indexed.
 *
 *   NEVER COD. A collection takes nothing from the customer, and a replacement is owed —
 *   charging cash on either would take money twice for one sale.
 *
 *   THE COURIER IS ASKED BEFORE THE RETURN MOVES. A courier event advances the return only
 *   on delivery, through the same compare-and-swaps as the admin endpoints: a delivered
 *   pickup makes the return `received` (QC, the refund and any restock still wait for an
 *   operator), a delivered replacement makes it `replacement_delivered`. Replays no-op.
 *
 * Run with `npm run test:reverse-logistics` (or `npm test` for everything).
 */
process.env.PAYMENTS_ENABLED = "false";
process.env.INVENTORY_ENFORCE_STOCK = "false";
process.env.INVENTORY_RESERVE_DURING_PAYMENT = "false";
process.env.NOTIFICATIONS_ENABLED = "false";

import mongoose from "mongoose";
import { connect, createSuite, marker, productFixture, addressFixture } from "./helpers.mjs";

const { ok, section, finish } = createSuite("reverse-logistics");
await connect();

const OrderModel = (await import("../../src/modules/orders/Order.model.js")).default;
const ProductModel = (await import("../../src/modules/products/Product.model.js")).default;
const ReturnModel = (await import("../../src/modules/returns/return.model.js")).default;
const ShiprocketSetting = (await import("../../src/modules/shipping/ShiprocketSetting.model.js")).default;
const returnController = await import("../../src/modules/returns/return.controller.js");
const shippingController = await import("../../src/modules/shipping/shipping.controller.js");
const { getShippingCapabilities, resolveWarehouseAddress, clearPickupLocationCache } =
  await import("../../src/modules/shipping/shiprocket.service.js");

await OrderModel.init();
await ReturnModel.init();

const MARKER = marker("revlog");
const trash = { orders: [], products: [], returns: [] };
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
let pickupListResponder = () => ({
  status: 200,
  body: {
    data: {
      shipping_address: [
        {
          pickup_location: "Primary",
          address: "1 Warehouse Road",
          city: "Pune",
          state: "Maharashtra",
          pin_code: "411001",
        },
      ],
    },
  },
});
let returnCreateResponder = () => ({ status: 200, body: { order_id: 7001, shipment_id: 8001 } });
let adhocResponder = () => ({ status: 200, body: { order_id: 7002, shipment_id: 8002 } });

const jsonResponse = ({ status = 200, body = {} }) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
});

globalThis.fetch = async (url, options) => {
  const href = String(url);
  calls.push({ href, method: options?.method || "GET", body: options?.body });
  if (href.includes("/auth/login")) return jsonResponse({ status: 200, body: { token: "stub" } });
  const route = href.includes("/settings/company/pickup")
    ? pickupListResponder
    : href.includes("/orders/create/return")
      ? returnCreateResponder
      : href.includes("/orders/create/adhoc")
        ? adhocResponder
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
const payloadOf = (call) => (call?.body ? JSON.parse(call.body) : {});

let stored = {
  email: "stub@example.com",
  password: "stub-password",
  pickupLocation: "Primary",
  pickupPostcode: "411001",
  webhookToken: "stub-webhook-token",
  shipmentsEnabled: true,
  autoPushEnabled: true,
  deliveryWebhookEnabled: true,
  reverseShipmentsEnabled: true,
  defaultLengthCm: 10,
  defaultBreadthCm: 10,
  defaultHeightCm: 10,
  defaultWeightKg: 0.5,
};
ShiprocketSetting.getSettings = async () => ({ ...stored });
const setChoice = (patch) => {
  stored = { ...stored, ...patch };
  clearPickupLocationCache();
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
  await handler(
    { params, body, user, query: {}, get: (name) => ({ "x-api-key": "stub-webhook-token" })[String(name).toLowerCase()] },
    res,
  );
  return { statusCode, body: payload };
};

const adminUser = () => ({ id: String(new mongoose.Types.ObjectId()), roles: ["admin"] });

const makeReturn = async ({ status = "approved", resolutionType = "replacement", ...overrides } = {}) => {
  seq += 1;
  const product = await ProductModel.create(productFixture(`${MARKER}-${seq}`, { stock: 20 }));
  trash.products.push(product._id);
  const userId = new mongoose.Types.ObjectId();
  const order = await OrderModel.create({
    user: userId,
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
    user: userId,
    product: product._id,
    productSnapshot: { name: product.name, image: "x.png", price: 500 },
    quantity: 1,
    reason: "damaged on arrival",
    refundAmount: 500,
    resolutionType,
    status,
    returnNumber: `${MARKER}-RET-${seq}`,
    ...overrides,
  });
  trash.returns.push(returnRequest._id);
  return { returnRequest, order, product, userId };
};

// The order's user must have an email for any Shiprocket payload. `populate("user")` needs
// a real user document, so patch the order's user field to a created one.
const UserModel = (await import("../../src/model/User.model.js")).default;
const makeUser = async () => {
  seq += 1;
  const user = await UserModel.create({
    name: `${MARKER}-user-${seq}`,
    email: `${MARKER}-${seq}@example.test`,
    password: "x".repeat(20),
  });
  return user;
};

// ================================================================ DEFAULT OFF

section("the capability is off until someone opts in");

{
  const saved = stored;
  stored = { ...stored };
  delete stored.reverseShipmentsEnabled;
  const capabilities = await getShippingCapabilities();
  ok(
    "a settings document written before the field existed does NOT book couriers",
    capabilities.reverseShipments === false,
    JSON.stringify(capabilities),
  );
  ok(
    "while the pre-existing capabilities stay enabled for that same document",
    capabilities.shipments === true && capabilities.autoPush === true,
    JSON.stringify(capabilities),
  );
  stored = saved;
}

{
  setChoice({ reverseShipmentsEnabled: false });
  const { returnRequest } = await makeReturn({ status: "approved" });
  resetCalls();
  const result = await callController(returnController.BookReturnPickup, {
    params: { id: String(returnRequest._id) },
    user: adminUser(),
  });
  ok(
    "with it off, booking is refused and names the setting",
    result.statusCode === 409 && result.body?.code === "REVERSE_SHIPMENTS_DISABLED",
    `${result.statusCode} ${JSON.stringify(result.body?.code)}`,
  );
  ok("and no courier is contacted", callsTo("/orders/create/return").length === 0, JSON.stringify(calls.map(c=>c.href)));
  setChoice({ reverseShipmentsEnabled: true });
}

{
  setChoice({ shipmentsEnabled: false, reverseShipmentsEnabled: true });
  const capabilities = await getShippingCapabilities();
  ok(
    "reverse shipments are nested under shipments — manual fulfilment disables them too",
    capabilities.reverseShipments === false,
    JSON.stringify(capabilities),
  );
  setChoice({ shipmentsEnabled: true });
}

// ================================================================ C1 — RETURN PICKUP

section("C1 — booking a return pickup");

{
  const user = await makeUser();
  const { returnRequest, order } = await makeReturn({ status: "approved" });
  await OrderModel.updateOne({ _id: order._id }, { $set: { user: user._id } });
  resetCalls();

  const result = await callController(returnController.BookReturnPickup, {
    params: { id: String(returnRequest._id) },
    user: adminUser(),
  });
  const after = await ReturnModel.findById(returnRequest._id).lean();

  ok(
    "the pickup is booked and the return moves to pickup_scheduled",
    result.statusCode === 200 && after.status === "pickup_scheduled",
    `${result.statusCode} ${after.status} ${JSON.stringify(result.body?.message)}`,
  );
  ok(
    "Shiprocket's ids for the collection are stored on the RETURN",
    after.pickupShiprocketOrderId === 7001 && after.pickupShipmentId === 8001,
    JSON.stringify({ o: after.pickupShiprocketOrderId, s: after.pickupShipmentId }),
  );
  ok(
    "and pickupScheduledAt is stamped",
    Boolean(after.pickupScheduledAt),
    String(after.pickupScheduledAt),
  );

  const payload = payloadOf(callsTo("/orders/create/return")[0]);
  // Getting this backwards sends a courier to the warehouse to collect from itself.
  ok(
    "the courier collects FROM the customer",
    payload.pickup_pincode === "411001" && payload.pickup_address === "1 Test Street",
    JSON.stringify({ pincode: payload.pickup_pincode, address: payload.pickup_address }),
  );
  ok(
    "and delivers TO the warehouse address resolved from Shiprocket's own list",
    payload.shipping_address === "1 Warehouse Road" && payload.shipping_city === "Pune",
    JSON.stringify({ address: payload.shipping_address, city: payload.shipping_city }),
  );
  ok(
    "a collection is never COD — it must not take cash for goods coming back",
    payload.payment_method === "Prepaid",
    payload.payment_method,
  );
  ok(
    "only the returned quantity is collected, not the whole order line",
    payload.order_items?.length === 1 && payload.order_items[0].units === 1,
    JSON.stringify(payload.order_items),
  );
  ok(
    "the return number identifies the shipment, leaving the order id to the forward parcel",
    payload.order_id === returnRequest.returnNumber,
    payload.order_id,
  );

  // Idempotent: a second click must not send a second courier.
  await ReturnModel.updateOne({ _id: returnRequest._id }, { $set: { pickupAwb: `${MARKER}-pawb1` } });
  resetCalls();
  const second = await callController(returnController.BookReturnPickup, {
    params: { id: String(returnRequest._id) },
    user: adminUser(),
  });
  ok(
    "a return that already has a pickup AWB is not booked again",
    second.statusCode === 200 &&
      second.body?.alreadyBooked === true &&
      callsTo("/orders/create/return").length === 0,
    `${second.statusCode} ${JSON.stringify(second.body?.alreadyBooked)}`,
  );
}

{
  const { returnRequest } = await makeReturn({ status: "pending" });
  resetCalls();
  const result = await callController(returnController.BookReturnPickup, {
    params: { id: String(returnRequest._id) },
    user: adminUser(),
  });
  ok(
    "a return that has not been approved cannot have a pickup booked",
    result.statusCode === 409 && result.body?.code === "RETURN_NOT_APPROVED",
    `${result.statusCode} ${JSON.stringify(result.body?.code)}`,
  );
  ok("and no courier is contacted", callsTo("/orders/create/return").length === 0, "call made");
}

{
  // The Phase A pickup-location check doing real work: a name that is not registered has
  // no address, so there is nowhere to send the parcel and nothing is booked.
  setChoice({ pickupLocation: "Warehouse Nine" });
  const user = await makeUser();
  const { returnRequest, order } = await makeReturn({ status: "approved" });
  await OrderModel.updateOne({ _id: order._id }, { $set: { user: user._id } });
  resetCalls();

  const result = await callController(returnController.BookReturnPickup, {
    params: { id: String(returnRequest._id) },
    user: adminUser(),
  });
  const after = await ReturnModel.findById(returnRequest._id).select("status");
  ok(
    "an unregistered pickup location blocks the booking",
    result.statusCode === 409 && result.body?.code === "WAREHOUSE_ADDRESS_UNRESOLVED",
    `${result.statusCode} ${JSON.stringify(result.body?.code)}`,
  );
  ok("and the return is left where it was", after.status === "approved", after.status);
  ok("with no courier contacted", callsTo("/orders/create/return").length === 0, "call made");
  setChoice({ pickupLocation: "Primary" });
}

{
  // Shiprocket accepted nothing, so the return must not claim a scheduled pickup.
  returnCreateResponder = () => ({ status: 200, body: { message: "no ids" } });
  const user = await makeUser();
  const { returnRequest, order } = await makeReturn({ status: "approved" });
  await OrderModel.updateOne({ _id: order._id }, { $set: { user: user._id } });

  const result = await callController(returnController.BookReturnPickup, {
    params: { id: String(returnRequest._id) },
    user: adminUser(),
  });
  const after = await ReturnModel.findById(returnRequest._id).select("status pickupShipmentId");
  ok(
    "a response with no shipment ids is an error, not a silent success",
    result.statusCode >= 400,
    `${result.statusCode} ${JSON.stringify(result.body?.message)}`,
  );
  ok(
    "and the return does NOT claim a pickup that was never booked",
    after.status === "approved" && after.pickupShipmentId === null,
    JSON.stringify({ status: after.status, shipmentId: after.pickupShipmentId }),
  );
  returnCreateResponder = () => ({ status: 200, body: { order_id: 7001, shipment_id: 8001 } });
}

// ================================================================ C2 — REPLACEMENT

section("C2 — booking a replacement parcel");

{
  const user = await makeUser();
  const { returnRequest, order } = await makeReturn({ status: "received", resolutionType: "replacement" });
  await OrderModel.updateOne({ _id: order._id }, { $set: { user: user._id } });
  resetCalls();

  const result = await callController(returnController.BookReplacementShipment, {
    params: { id: String(returnRequest._id) },
    user: adminUser(),
  });
  const after = await ReturnModel.findById(returnRequest._id).lean();

  ok(
    "the replacement parcel is booked",
    result.statusCode === 200 && after.replacementShipmentId === 8002,
    `${result.statusCode} ${JSON.stringify(after.replacementShipmentId)}`,
  );
  // Booking is not dispatching: dispatch is what deducts the outbound unit from stock.
  ok(
    "booking does NOT change the return status — that is the dispatch step's job",
    after.status === "received",
    after.status,
  );

  const payload = payloadOf(callsTo("/orders/create/adhoc")[0]);
  ok(
    "a replacement is never COD — the customer is owed it, not charged again",
    payload.payment_method === "Prepaid",
    payload.payment_method,
  );
  ok(
    "it goes to the customer's address",
    payload.billing_pincode === "411001",
    payload.billing_pincode,
  );
  ok(
    "only the replaced line is sent, at the returned quantity",
    payload.order_items?.length === 1 && payload.order_items[0].units === 1,
    JSON.stringify(payload.order_items),
  );
  ok(
    "its shipment id cannot collide with the pickup booked under the same return number",
    payload.order_id === `${returnRequest.returnNumber}-REP`,
    payload.order_id,
  );
  ok(
    "and no shipping is charged for a replacement",
    payload.shipping_charges === 0,
    String(payload.shipping_charges),
  );
}

{
  const { returnRequest } = await makeReturn({ status: "received", resolutionType: "refund" });
  resetCalls();
  const result = await callController(returnController.BookReplacementShipment, {
    params: { id: String(returnRequest._id) },
    user: adminUser(),
  });
  ok(
    "a refund return cannot have a replacement parcel booked",
    result.statusCode === 400 && result.body?.code === "NOT_A_REPLACEMENT",
    `${result.statusCode} ${JSON.stringify(result.body?.code)}`,
  );
  ok("and no courier is contacted", callsTo("/orders/create/adhoc").length === 0, "call made");
}

{
  const { returnRequest } = await makeReturn({ status: "approved", resolutionType: "replacement" });
  const result = await callController(returnController.BookReplacementShipment, {
    params: { id: String(returnRequest._id) },
    user: adminUser(),
  });
  ok(
    "a replacement cannot be booked before the returned goods are received",
    result.statusCode === 409 && result.body?.code === "RETURN_NOT_RECEIVED",
    `${result.statusCode} ${JSON.stringify(result.body?.code)}`,
  );
}

// ================================================================ IDENTITY

section("one AWB, one leg, one return");

{
  const indexes = await mongoose.connection.collection("returnrequests").indexes();
  const names = indexes.map((i) => i.name);
  ok(
    "both reverse legs carry a unique index",
    names.includes("return_pickupAwb_unique") && names.includes("return_replacementAwb_unique"),
    names.join(","),
  );
  ok(
    "both are partial on $type so unset AWBs are not indexed",
    indexes
      .filter((i) => /Awb_unique/.test(i.name))
      .every((i) => JSON.stringify(i.partialFilterExpression).includes('"$type":"string"')),
    JSON.stringify(indexes.filter((i) => /Awb_unique/.test(i.name)).map((i) => i.partialFilterExpression)),
  );
}

{
  // Many returns with no AWB must coexist. Before the emptying setters this was the
  // failure: "" is a value, so every AWB-less return entered the unique index and the
  // second one was rejected.
  const a = await makeReturn({ status: "approved" });
  const b = await makeReturn({ status: "approved" });
  ok(
    "two returns with no AWB can both exist",
    Boolean(a.returnRequest._id) && Boolean(b.returnRequest._id),
    "one of them was rejected",
  );

  await ReturnModel.updateOne({ _id: a.returnRequest._id }, { $set: { pickupAwb: `${MARKER}-dup` } });
  let rejected = false;
  try {
    await ReturnModel.updateOne({ _id: b.returnRequest._id }, { $set: { pickupAwb: `${MARKER}-dup` } });
  } catch (error) {
    rejected = error?.code === 11000;
  }
  ok(
    "but the same pickup AWB cannot be recorded against two returns",
    rejected,
    "duplicate pickup AWB was accepted",
  );
}

// ================================================================ WEBHOOK

section("courier events reach the right leg; delivery advances the return");

{
  const { returnRequest } = await makeReturn({ status: "pickup_scheduled" });
  await ReturnModel.updateOne(
    { _id: returnRequest._id },
    { $set: { pickupAwb: `${MARKER}-wpick`, pickupShipmentId: 8100 } },
  );
  resetCalls();

  const result = await callController(shippingController.ShippingWebhook, {
    body: { awb: `${MARKER}-wpick`, shipment_status_id: 7, current_status: "Delivered" },
  });
  const after = await ReturnModel.findById(returnRequest._id).lean();
  ok(
    "an event for the collection resolves to the pickup leg",
    result.statusCode === 200 && result.body?.scope === "return" && result.body?.leg === "pickup",
    `${result.statusCode} ${JSON.stringify(result.body)}`,
  );
  ok(
    "the courier status is recorded",
    after.pickupCourierStatus === "Delivered" && Boolean(after.pickupCourierUpdatedAt),
    JSON.stringify({ s: after.pickupCourierStatus, at: after.pickupCourierUpdatedAt }),
  );
  // The parcel is on the shelf: the return moves to received. QC (the disposition), the
  // refund and any restock still wait for the operator resolving it.
  ok(
    "a delivered pickup moves the return to received",
    after.status === "received" && Boolean(after.receivedAt),
    JSON.stringify({ status: after.status, receivedAt: after.receivedAt }),
  );
  ok(
    "and the history says the courier did it",
    after.statusHistory.at(-1)?.status === "received" &&
      /Courier reported delivered/.test(after.statusHistory.at(-1)?.note || "") &&
      (after.statusHistory.at(-1)?.note || "").includes(`${MARKER}-wpick`),
    JSON.stringify(after.statusHistory.at(-1)),
  );
  ok(
    "and the reply says the return progressed",
    result.body?.statusUnchanged === false,
    JSON.stringify(result.body),
  );
  ok(
    "nothing about money or stock is decided by the courier",
    !after.refundedAt && !after.restockedAt && after.disposition === "",
    JSON.stringify({ refundedAt: after.refundedAt, restockedAt: after.restockedAt, disposition: after.disposition }),
  );

  const replay = await callController(shippingController.ShippingWebhook, {
    body: { awb: `${MARKER}-wpick`, shipment_status_id: 7, current_status: "Delivered" },
  });
  const replayed = await ReturnModel.findById(returnRequest._id).lean();
  ok(
    "a replayed delivery is a no-op",
    replayed.status === "received" &&
      String(replayed.receivedAt) === String(after.receivedAt) &&
      replayed.statusHistory.filter((h) => h.status === "received").length === 1 &&
      replay.body?.statusUnchanged === true,
    JSON.stringify({ status: replayed.status, body: replay.body }),
  );
}

{
  // A pickup that has not been scheduled is not moved, whatever the courier says.
  const { returnRequest } = await makeReturn({ status: "received", resolutionType: "refund" });
  await ReturnModel.updateOne({ _id: returnRequest._id }, { $set: { pickupAwb: `${MARKER}-wpick-late` } });
  const result = await callController(shippingController.ShippingWebhook, {
    body: { awb: `${MARKER}-wpick-late`, shipment_status_id: 18, current_status: "IN TRANSIT" },
  });
  const after = await ReturnModel.findById(returnRequest._id).lean();
  ok(
    "a non-delivery event only records the courier status",
    result.body?.statusUnchanged === true && after.status === "received" && after.pickupCourierStatus === "IN TRANSIT",
    JSON.stringify({ body: result.body, status: after.status }),
  );
}

{
  const { returnRequest } = await makeReturn({ status: "replacement_dispatched" });
  await ReturnModel.updateOne(
    { _id: returnRequest._id },
    { $set: { replacementAwb: `${MARKER}-wrep`, replacementCourier: "Stub Express" } },
  );

  const result = await callController(shippingController.ShippingWebhook, {
    body: { awb: `${MARKER}-wrep`, shipment_status_id: 7, current_status: "Delivered" },
  });
  const after = await ReturnModel.findById(returnRequest._id).lean();
  ok(
    "an event for the replacement resolves to the replacement leg",
    result.body?.leg === "replacement",
    JSON.stringify(result.body),
  );
  ok(
    "a delivered replacement stamps the delivery timestamp — a fact, not a decision",
    Boolean(after.replacementDeliveredAt),
    String(after.replacementDeliveredAt),
  );
  ok(
    "and the replacement is marked delivered",
    after.status === "replacement_delivered" && after.statusHistory.at(-1)?.status === "replacement_delivered",
    after.status,
  );
  ok("the reply says the return progressed", result.body?.statusUnchanged === false, JSON.stringify(result.body));

  // Replay: first delivery wins, so the reference point cannot drift.
  const firstStamp = after.replacementDeliveredAt;
  await callController(shippingController.ShippingWebhook, {
    body: { awb: `${MARKER}-wrep`, shipment_status_id: 7, current_status: "Delivered" },
  });
  const replayed = await ReturnModel.findById(returnRequest._id).select("replacementDeliveredAt status statusHistory");
  ok(
    "a replayed delivery does not move the timestamp",
    String(replayed.replacementDeliveredAt) === String(firstStamp),
    JSON.stringify({ first: firstStamp, after: replayed.replacementDeliveredAt }),
  );
  ok(
    "and changes nothing else",
    replayed.status === "replacement_delivered" &&
      replayed.statusHistory.filter((h) => h.status === "replacement_delivered").length === 1,
    JSON.stringify(replayed.statusHistory.map((h) => h.status)),
  );

  // The admin confirming afterwards finds the transition already taken.
  const confirm = await callController(returnController.ConfirmReplacementDelivery, {
    params: { id: String(returnRequest._id) },
    body: {},
    user: adminUser(),
  });
  ok(
    "an admin confirmation after the courier's is refused, not repeated",
    confirm.statusCode === 409 && confirm.body?.code === "REPLACEMENT_NOT_DISPATCHED",
    `${confirm.statusCode} ${JSON.stringify(confirm.body?.code)}`,
  );
}

{
  // The admin confirming FIRST keeps working, and a later courier delivery keeps its own
  // timestamp only when none was recorded.
  const { returnRequest } = await makeReturn({ status: "replacement_dispatched" });
  await ReturnModel.updateOne({ _id: returnRequest._id }, { $set: { replacementAwb: `${MARKER}-wrep2` } });
  const confirm = await callController(returnController.ConfirmReplacementDelivery, {
    params: { id: String(returnRequest._id) },
    body: { adminNote: "customer confirmed by phone" },
    user: adminUser(),
  });
  const confirmed = await ReturnModel.findById(returnRequest._id).lean();
  ok(
    "admin confirmation marks it delivered and stamps the time",
    confirm.statusCode === 200 && confirmed.status === "replacement_delivered" && Boolean(confirmed.replacementDeliveredAt) &&
      confirmed.adminNote === "customer confirmed by phone",
    `${confirm.statusCode} ${confirmed.status}`,
  );
  const late = await callController(shippingController.ShippingWebhook, {
    body: { awb: `${MARKER}-wrep2`, shipment_status_id: 7, current_status: "Delivered" },
  });
  const after = await ReturnModel.findById(returnRequest._id).lean();
  ok(
    "a courier delivery afterwards changes no status",
    late.body?.statusUnchanged === true && after.status === "replacement_delivered" &&
      after.statusHistory.filter((h) => h.status === "replacement_delivered").length === 1,
    JSON.stringify(late.body),
  );
}

{
  // An order event must never be re-attributed to a return. Returns are only consulted
  // when no order matched.
  const { order } = await makeReturn({ status: "approved" });
  await OrderModel.updateOne(
    { _id: order._id },
    { $set: { orderStatus: "Shipped", "shiprocket.awbCode": `${MARKER}-orderawb`, "shiprocket.orderId": 9100 } },
  );
  const { returnRequest: otherReturn } = await makeReturn({ status: "pickup_scheduled" });
  await ReturnModel.updateOne({ _id: otherReturn._id }, { $set: { pickupAwb: `${MARKER}-otherpick` } });

  const result = await callController(shippingController.ShippingWebhook, {
    body: { awb: `${MARKER}-orderawb`, shipment_status_id: 7, current_status: "Delivered" },
  });
  const afterOrder = await OrderModel.findById(order._id).select("orderStatus");
  const afterReturn = await ReturnModel.findById(otherReturn._id).select("pickupCourierStatus");
  ok(
    "an order's AWB still resolves to the order, not to a return",
    result.body?.scope !== "return" && afterOrder.orderStatus === "Delivered",
    JSON.stringify({ scope: result.body?.scope, status: afterOrder.orderStatus }),
  );
  ok(
    "and no unrelated return is touched",
    afterReturn.pickupCourierStatus === "",
    afterReturn.pickupCourierStatus,
  );
}

{
  const result = await callController(shippingController.ShippingWebhook, {
    body: { awb: `${MARKER}-nothing-owns-this`, shipment_status_id: 7, current_status: "Delivered" },
  });
  ok(
    "an AWB nothing owns is still ignored, as before",
    result.statusCode === 200 && result.body?.ignored === true,
    JSON.stringify(result.body),
  );
}

{
  // The same AWB on both legs cannot be disambiguated by anything in the payload, so it
  // must be refused rather than guessed — the H2-01 rule, applied to returns.
  const { returnRequest } = await makeReturn({ status: "pickup_scheduled" });
  await ReturnModel.updateOne(
    { _id: returnRequest._id },
    { $set: { pickupAwb: `${MARKER}-bothlegs`, replacementAwb: `${MARKER}-bothlegs` } },
  );
  const result = await callController(shippingController.ShippingWebhook, {
    body: { awb: `${MARKER}-bothlegs`, shipment_status_id: 7, current_status: "Delivered" },
  });
  const after = await ReturnModel.findById(returnRequest._id).select("pickupCourierStatus replacementCourierStatus");
  ok(
    "one AWB on both legs is refused, not guessed",
    result.body?.ignored === true && result.body?.reason === "awb_on_both_return_legs",
    JSON.stringify(result.body),
  );
  ok(
    "and neither leg is written",
    after.pickupCourierStatus === "" && after.replacementCourierStatus === "",
    JSON.stringify(after),
  );
}

// ================================================================ DISPATCH REUSE

section("dispatch uses what the booking stored");

{
  const user = await makeUser();
  const { returnRequest, order } = await makeReturn({ status: "received", resolutionType: "replacement" });
  await OrderModel.updateOne({ _id: order._id }, { $set: { user: user._id } });
  await ReturnModel.updateOne(
    { _id: returnRequest._id },
    { $set: { replacementCourier: "Booked Courier", replacementAwb: `${MARKER}-booked` } },
  );

  const result = await callController(returnController.DispatchReplacement, {
    params: { id: String(returnRequest._id) },
    body: { disposition: "resellable" },
    user: adminUser(),
  });
  const after = await ReturnModel.findById(returnRequest._id).select("status replacementAwb replacementCourier");
  ok(
    "dispatch succeeds without the admin retyping the courier and AWB",
    result.statusCode === 200 && after.status === "replacement_dispatched",
    `${result.statusCode} ${after.status} ${JSON.stringify(result.body?.message)}`,
  );
  ok(
    "and keeps the booked details",
    after.replacementAwb === `${MARKER}-booked` && after.replacementCourier === "Booked Courier",
    JSON.stringify({ awb: after.replacementAwb, courier: after.replacementCourier }),
  );
}

{
  // Manual dispatch is unchanged: typing details by hand still works and still wins.
  const user = await makeUser();
  const { returnRequest, order } = await makeReturn({ status: "received", resolutionType: "replacement" });
  await OrderModel.updateOne({ _id: order._id }, { $set: { user: user._id } });

  const result = await callController(returnController.DispatchReplacement, {
    params: { id: String(returnRequest._id) },
    body: { courier: "Hand Carried", awb: `${MARKER}-manual`, disposition: "resellable" },
    user: adminUser(),
  });
  const after = await ReturnModel.findById(returnRequest._id).select("status replacementAwb replacementCourier");
  ok(
    "a hand-typed dispatch still works with no booking at all",
    result.statusCode === 200 && after.replacementCourier === "Hand Carried",
    `${result.statusCode} ${JSON.stringify(after.replacementCourier)}`,
  );
}

{
  const { returnRequest } = await makeReturn({ status: "received", resolutionType: "replacement" });
  const result = await callController(returnController.DispatchReplacement, {
    params: { id: String(returnRequest._id) },
    body: { disposition: "resellable" },
    user: adminUser(),
  });
  ok(
    "with neither a booking nor typed details, dispatch is still refused",
    result.statusCode === 400 && result.body?.code === "REPLACEMENT_TRACKING_REQUIRED",
    `${result.statusCode} ${JSON.stringify(result.body?.code)}`,
  );
}

// ================================================================ BOUNDARY

section("the H2-07 boundary is not reopened");

{
  const paths = OrderModel.schema.paths;
  ok(
    "the order still has exactly one shipment record",
    Boolean(paths["shipment.provider"]) && Boolean(paths["shipment.trackingNumber"]),
    "order shipment shape changed",
  );
  ok(
    "and reverse-logistics identity lives on the return, not on the order",
    !Object.keys(paths).some((p) => /pickupAwb|replacementAwb/.test(p)) &&
      Boolean(ReturnModel.schema.paths.pickupAwb) &&
      Boolean(ReturnModel.schema.paths.replacementAwb),
    Object.keys(paths).filter((p) => /Awb/.test(p)).join(","),
  );
}

// ---------------------------------------------------------------- cleanup

restore();

const userIds = await OrderModel.find({ _id: { $in: trash.orders } }).distinct("user");
await Promise.all([
  OrderModel.deleteMany({ _id: { $in: trash.orders } }),
  ProductModel.deleteMany({ _id: { $in: trash.products } }),
  ReturnModel.deleteMany({ _id: { $in: trash.returns } }),
  UserModel.deleteMany({ _id: { $in: userIds } }),
  UserModel.deleteMany({ name: new RegExp(MARKER) }),
]);

const leftovers =
  (await OrderModel.countDocuments({ idempotencyKey: new RegExp(MARKER) })) +
  (await ProductModel.countDocuments({ name: new RegExp(MARKER) })) +
  (await ReturnModel.countDocuments({ returnNumber: new RegExp(MARKER) })) +
  (await UserModel.countDocuments({ name: new RegExp(MARKER) }));
ok("every fixture this suite created is gone", leftovers === 0, `leftovers=${leftovers}`);

const summary = finish();
await mongoose.disconnect();
process.exit(summary.failed > 0 ? 1 : 0);
