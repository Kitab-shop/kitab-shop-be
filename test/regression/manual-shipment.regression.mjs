/**
 * Provider-neutral shipment identity (audit H2-07, Tier 1).
 *
 * Every shipment fact used to live under `order.shiprocket`, so a seller shipping
 * by hand had nowhere to record a courier or a tracking number. That was not a
 * theoretical gap: in the live database every delivered order reached its customer
 * with no courier name and no tracking number stored anywhere, and the customer's
 * tracking panel is gated on `shiprocket.awbCode` — so none of them could track
 * anything at all.
 *
 * Tier 1 adds `order.shipment` beside `order.shiprocket`, never in place of it.
 * The tests below therefore care as much about what did NOT change as about what
 * did: no Shiprocket call, no fabricated identifier, no second status machine, and
 * every H2-01 identity guarantee intact.
 *
 * Run with `npm run test:manual-shipment` (or `npm test` for everything).
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
import { readFile } from "node:fs/promises";
import { connect, createSuite, marker, productFixture, addressFixture } from "./helpers.mjs";

const { ok, section, finish } = createSuite("manual-shipment");
await connect();

const OrderModel = (await import("../../src/modules/orders/Order.model.js")).default;
const { SHIPMENT_PROVIDERS } = await import("../../src/modules/orders/Order.model.js");
const ProductModel = (await import("../../src/modules/products/Product.model.js")).default;
const UserModel = (await import("../../src/model/User.model.js")).default;
await import("../../src/modules/categories/Category.model.js");
const { ORDER_STATUSES } = await import("../../src/modules/orders/order-status.rules.js");
const { ADMIN_PERMISSIONS } = await import("../../src/config/admin-permissions.config.js");
const { requirePermission } = await import("../../src/middleware/require-permission.middleware.js");
const manualController = await import("../../src/modules/shipping/manual-shipment.controller.js");
const shippingController = await import("../../src/modules/shipping/shipping.controller.js");
const { manualShipmentSchema } = await import("../../src/modules/orders/order.schema.js");

const MARKER = marker("manship");
const trash = { orders: [], products: [], users: [] };
let seq = 0;

const makeProduct = async () => {
  const product = await ProductModel.create(productFixture(`${MARKER}-${(seq += 1)}`, { stock: 20 }));
  trash.products.push(product._id);
  return product;
};

const makeOrder = async ({ status = "Confirmed", shiprocket, paymentMethod = "RAZORPAY" } = {}) => {
  seq += 1;
  const product = await makeProduct();
  const order = await OrderModel.create({
    user: new mongoose.Types.ObjectId(),
    items: [
      { product: product._id, name: product.name, image: "x.png", price: product.price, quantity: 1 },
    ],
    shippingAddress: addressFixture(),
    paymentMethod,
    paymentStatus: paymentMethod === "COD" ? "Pending" : "Paid",
    orderStatus: status,
    subtotal: product.price,
    totalAmount: product.price,
    ...(shiprocket ? { shiprocket } : {}),
  });
  trash.orders.push(order._id);
  return order;
};

const callController = async (handler, { params = {}, body = {}, user, query = {}, headers = {} }) => {
  let statusCode = 200;
  let payload;
  const res = {
    status(code) { statusCode = code; return this; },
    json(data) { payload = data; return this; },
  };
  await handler({ params, body, user, query, get: (key) => headers[key.toLowerCase()] }, res);
  return { statusCode, body: payload };
};

const admin = () => ({ id: String(new mongoose.Types.ObjectId()), roles: ["admin"] });

const record = (orderId, body, user = admin()) =>
  callController(manualController.RecordManualShipment, {
    params: { orderId: String(orderId) },
    body: { provider: "MANUAL", carrierName: "Delhivery", trackingNumber: `TRK-${MARKER}-${orderId}`, ...body },
    user,
  });

const fresh = (id) => OrderModel.findById(id);

/** Counts every outbound HTTP call so "zero Shiprocket calls" is measured, not assumed. */
const withFetchCounter = async (fn) => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push(String(url));
    throw new Error(`unexpected outbound call to ${url}`);
  };
  try {
    return { result: await fn(), calls };
  } finally {
    globalThis.fetch = original;
  }
};

try {
  // ═══════════════════════════════════════════════════════════════════════════
  section("1 — the schema, and the absence of a second status machine");

  {
    ok("providers are exactly MANUAL and SHIPROCKET",
      JSON.stringify(SHIPMENT_PROVIDERS) === JSON.stringify(["MANUAL", "SHIPROCKET"]),
      JSON.stringify(SHIPMENT_PROVIDERS));

    const paths = Object.keys(OrderModel.schema.paths).filter((p) => p.startsWith("shipment."));
    for (const field of ["provider", "carrierName", "trackingNumber", "status"]) {
      ok(`order.shipment.${field} exists`, paths.includes(`shipment.${field}`));
    }
    ok("it is a sibling of shiprocket, which is untouched",
      Object.keys(OrderModel.schema.paths).some((p) => p.startsWith("shiprocket.")));

    const statusEnum = OrderModel.schema.path("shipment.status").options.enum;
    ok("shipment.status reuses the ORDER status vocabulary — no parallel enum",
      ORDER_STATUSES.every((status) => statusEnum.includes(status)),
      JSON.stringify(statusEnum));
    ok("and adds no status of its own",
      statusEnum.filter(Boolean).every((status) => ORDER_STATUSES.includes(status)),
      JSON.stringify(statusEnum.filter((s) => s && !ORDER_STATUSES.includes(s))));

    const blank = new OrderModel();
    ok("defaults are inert — provider null, no fabricated carrier or number",
      blank.shipment.provider === null &&
        blank.shipment.carrierName === "" &&
        blank.shipment.trackingNumber === "" &&
        blank.shipment.status === null,
      JSON.stringify(blank.shipment));

    blank.shipment.provider = "DHL";
    ok("an unknown provider fails schema validation",
      Boolean(blank.validateSync()?.errors?.["shipment.provider"]));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("2 — an admin records a hand-shipped parcel");

  {
    const order = await makeOrder({ status: "Confirmed" });
    const actor = admin();
    const response = await record(order._id, { carrierName: "  DTDC  ", trackingNumber: "  DT12345  " }, actor);

    ok("the request succeeds", response.statusCode === 200, `${response.statusCode} ${response.body?.message}`);

    const saved = await fresh(order._id);
    ok("provider is MANUAL", saved.shipment.provider === "MANUAL", saved.shipment.provider);
    ok("the carrier is persisted, trimmed", saved.shipment.carrierName === "DTDC", `"${saved.shipment.carrierName}"`);
    ok("the tracking number is persisted, trimmed", saved.shipment.trackingNumber === "DT12345", `"${saved.shipment.trackingNumber}"`);
    ok("who recorded it is captured", String(saved.shipment.updatedBy) === actor.id);
    ok("and when", saved.shipment.updatedAt instanceof Date);

    ok("the order moved to Shipped — the parcel has actually gone out",
      saved.orderStatus === "Shipped", saved.orderStatus);
    ok("shipment.status agrees with the order, so there is one answer not two",
      saved.shipment.status === saved.orderStatus, `${saved.shipment.status} vs ${saved.orderStatus}`);
    const entry = saved.statusHistory.at(-1);
    ok("the move is in the audit trail", entry?.from === "Confirmed" && entry?.to === "Shipped",
      JSON.stringify(entry));
    ok("attributed to the manual shipment path", entry?.source === "manual_shipment", entry?.source);
    ok("and to the admin who did it", String(entry?.changedBy) === actor.id);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("3 — correcting a number, and orders already further along");

  {
    const order = await makeOrder({ status: "Confirmed" });
    await record(order._id, { carrierName: "Delhivery", trackingNumber: "WRONG-1" });
    const second = await record(order._id, { carrierName: "Delhivery", trackingNumber: "RIGHT-2" });
    ok("a correction is the same operation, not a second shipment", second.statusCode === 200);

    const saved = await fresh(order._id);
    ok("the corrected number replaces the wrong one", saved.shipment.trackingNumber === "RIGHT-2");
    ok("the status move is NOT recorded twice",
      saved.statusHistory.filter((h) => h.source === "manual_shipment").length === 1,
      String(saved.statusHistory.filter((h) => h.source === "manual_shipment").length));

    // Delivered is past dispatch, so this is a late correction rather than a
    // dispatch — the order must not be dragged backwards.
    const delivered = await makeOrder({ status: "Delivered" });
    const late = await record(delivered._id, { carrierName: "India Post", trackingNumber: "IP-9" });
    ok("a delivered order still accepts a tracking correction", late.statusCode === 200,
      `${late.statusCode} ${late.body?.message}`);
    const savedDelivered = await fresh(delivered._id);
    ok("and is NOT regressed to Shipped", savedDelivered.orderStatus === "Delivered", savedDelivered.orderStatus);
    ok("its shipment status mirrors Delivered, claiming nothing untrue",
      savedDelivered.shipment.status === "Delivered", savedDelivered.shipment.status);
    ok("no phantom history entry for a move that did not happen",
      savedDelivered.statusHistory.every((h) => h.source !== "manual_shipment"));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("4 — validation refuses what cannot be recorded");

  {
    const order = await makeOrder();

    const wrongProvider = await record(order._id, { provider: "SHIPROCKET" });
    ok("provider SHIPROCKET is refused — Shiprocket issues its own identifiers",
      wrongProvider.statusCode === 400 && wrongProvider.body?.code === "PROVIDER_NOT_MANUAL",
      `${wrongProvider.statusCode} ${wrongProvider.body?.code}`);

    const unknownProvider = await record(order._id, { provider: "DHL" });
    ok("an unknown provider is refused", unknownProvider.statusCode === 400 &&
      unknownProvider.body?.code === "PROVIDER_NOT_MANUAL");

    const omitted = await record(order._id, { provider: undefined });
    ok("omitting the provider is allowed and means MANUAL", omitted.statusCode === 200);
    ok("recorded as MANUAL", (await fresh(order._id)).shipment.provider === "MANUAL");

    for (const [label, body] of [
      ["no carrier", { carrierName: "" }],
      ["no tracking number", { trackingNumber: "" }],
      ["a whitespace-only carrier", { carrierName: "   " }],
      ["a whitespace-only tracking number", { trackingNumber: "   " }],
    ]) {
      const response = await record(order._id, body);
      ok(`${label} is refused`, response.statusCode === 400 &&
        response.body?.code === "MANUAL_SHIPMENT_INCOMPLETE",
        `${response.statusCode} ${response.body?.code}`);
    }

    // The route validator has to reject the same things before the DB is touched.
    const parseBody = (body) => manualShipmentSchema.body.safeParse(body);
    ok("the request validator requires a carrier",
      parseBody({ carrierName: "", trackingNumber: "X" }).success === false);
    ok("the request validator requires a tracking number",
      parseBody({ carrierName: "X", trackingNumber: "" }).success === false);
    ok("the request validator rejects a non-MANUAL provider",
      parseBody({ provider: "SHIPROCKET", carrierName: "X", trackingNumber: "Y" }).success === false);
    ok("and accepts a complete manual request",
      parseBody({ provider: "MANUAL", carrierName: "DTDC", trackingNumber: "D1" }).success === true);

    const missing = await record(new mongoose.Types.ObjectId(), {});
    ok("an unknown order is a 404", missing.statusCode === 404);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("5 — zero Shiprocket calls, zero fabricated identifiers");

  {
    // Structural, not behavioural: the guarantee holds by what the module imports.
    const source = await readFile(
      new URL("../../src/modules/shipping/manual-shipment.controller.js", import.meta.url),
      "utf8",
    );
    ok("the manual controller imports nothing from shiprocket.service",
      !/from\s+".*shiprocket\.service\.js"/.test(source));
    ok("and names no Shiprocket function",
      !/(createShiprocketOrder|assignAwb|schedulePickup|generateLabel|generateInvoice|trackAwb|cancelShiprocketOrder)/.test(source));

    const order = await makeOrder();
    const { result, calls } = await withFetchCounter(() => record(order._id, {}));
    ok("recording succeeds", result.statusCode === 200, `${result.statusCode} ${result.body?.message}`);
    ok("and made no outbound HTTP call at all", calls.length === 0, JSON.stringify(calls));

    const saved = await fresh(order._id);
    ok("no Shiprocket order id was invented", saved.shiprocket.orderId === null, String(saved.shiprocket.orderId));
    ok("no Shiprocket shipment id was invented", saved.shiprocket.shipmentId === null);
    ok("no AWB was invented", saved.shiprocket.awbCode === null);
    ok("no courier id was invented", saved.shiprocket.courierId === null);
    ok("syncStatus stays not_created — nothing was synced",
      saved.shiprocket.syncStatus === "not_created", saved.shiprocket.syncStatus);
    ok("and the manual carrier did NOT leak into the Shiprocket courier field",
      !saved.shiprocket.courierName, String(saved.shiprocket.courierName));

    // A second call must not start inventing them either.
    const { calls: updateCalls } = await withFetchCounter(() =>
      record(order._id, { trackingNumber: "SECOND-1" }));
    ok("an update also makes no outbound call", updateCalls.length === 0);
    const updated = await fresh(order._id);
    ok("and still creates no Shiprocket identifiers",
      updated.shiprocket.orderId === null && updated.shiprocket.shipmentId === null &&
        updated.shiprocket.awbCode === null);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("6 — coexistence with a real Shiprocket shipment");

  {
    const srOrder = await makeOrder({
      status: "Confirmed",
      shiprocket: {
        orderId: 900000 + seq,
        shipmentId: 800000 + seq,
        awbCode: `SRAWB-${MARKER}-${seq}`,
        courierName: "Bluedart",
        syncStatus: "awb_assigned",
        status: "PICKUP SCHEDULED",
      },
    });

    const refused = await record(srOrder._id, { carrierName: "DTDC", trackingNumber: "MINE-1" });
    ok("a manual record is refused once Shiprocket owns the shipment",
      refused.statusCode === 409 && refused.body?.code === "SHIPROCKET_SHIPMENT_EXISTS",
      `${refused.statusCode} ${refused.body?.code}`);

    const untouched = await fresh(srOrder._id);
    ok("the Shiprocket order id is untouched", untouched.shiprocket.orderId === srOrder.shiprocket.orderId);
    ok("the AWB is untouched", untouched.shiprocket.awbCode === srOrder.shiprocket.awbCode);
    ok("the Shiprocket courier is untouched", untouched.shiprocket.courierName === "Bluedart");
    ok("and no MANUAL provider was written over it",
      untouched.shipment.provider !== "MANUAL", String(untouched.shipment.provider));

    // Both representations must be able to hold data for the same order at once.
    await OrderModel.updateOne({ _id: srOrder._id }, {
      $set: {
        "shipment.provider": "SHIPROCKET",
        "shipment.carrierName": "Bluedart",
        "shipment.trackingNumber": srOrder.shiprocket.awbCode,
        "shipment.status": "Shipped",
      },
    });
    const both = await fresh(srOrder._id);
    ok("provider SHIPROCKET coexists with the existing shiprocket subdocument",
      both.shipment.provider === "SHIPROCKET" && both.shiprocket.orderId === srOrder.shiprocket.orderId);
    ok("the neutral tracking number mirrors the AWB",
      both.shipment.trackingNumber === both.shiprocket.awbCode);
    ok("while Shiprocket keeps its own identifiers",
      both.shiprocket.shipmentId === srOrder.shiprocket.shipmentId &&
        both.shiprocket.syncStatus === "awb_assigned");
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("7 — the existing lifecycle rules are reused, not restated");

  {
    for (const status of ["Cancelled", "RTO", "RTO Received", "Closed"]) {
      const order = await makeOrder({ status });
      const response = await record(order._id, {});
      ok(`an order at "${status}" cannot be recorded as shipped`,
        response.statusCode === 409 && response.body?.code === "ORDER_NOT_FULFILLABLE",
        `${response.statusCode} ${response.body?.code}`);
      const saved = await fresh(order._id);
      ok(`  and nothing was written to its shipment record`,
        saved.shipment.provider === null && saved.shipment.trackingNumber === "");
    }

    const source = await readFile(
      new URL("../../src/modules/shipping/manual-shipment.controller.js", import.meta.url),
      "utf8",
    );
    ok("the guard reuses isFulfillableStatus rather than listing statuses again",
      /isFulfillableStatus/.test(source) && !/"RTO Received"/.test(source));
    ok("and the transition reuses canTransitionOrderStatus",
      /canTransitionOrderStatus\(/.test(source));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("8 — the Shiprocket webhook keeps its H2-01 guarantees");

  {
    const headers = { "x-api-key": "stub-webhook-token" };
    const hook = (body) => callController(shippingController.ShippingWebhook, { body, headers });

    // A Shiprocket-carried order gets the neutral mirror populated.
    const srOrder = await makeOrder({
      status: "Shipped",
      shiprocket: { orderId: 910000 + seq, shipmentId: 810000 + seq, awbCode: `HK-${MARKER}-${seq}`, syncStatus: "awb_assigned" },
    });
    const delivered = await hook({
      order_id: String(srOrder._id),
      awb: srOrder.shiprocket.awbCode,
      courier_name: "Ecom Express",
      shipment_status_id: 7,
      shipment_status: "DELIVERED",
    });
    ok("the webhook still accepts a valid event", delivered.statusCode === 200 && !delivered.body?.ignored,
      JSON.stringify(delivered.body));
    const afterHook = await fresh(srOrder._id);
    ok("the order is Delivered, exactly as before", afterHook.orderStatus === "Delivered");
    ok("deliveredAt is stamped, exactly as before", afterHook.deliveredAt instanceof Date);
    ok("the Shiprocket subdocument is still updated", afterHook.shiprocket.statusCode === 7);
    ok("and the neutral mirror now carries the courier", afterHook.shipment.carrierName === "Ecom Express");
    ok("and the tracking number", afterHook.shipment.trackingNumber === srOrder.shiprocket.awbCode);
    ok("and the mirrored status matches the order", afterHook.shipment.status === "Delivered");
    ok("provider is recorded as SHIPROCKET", afterHook.shipment.provider === "SHIPROCKET");

    // A hand-shipped order must never be relabelled by a courier feed.
    const manualOrder = await makeOrder({ status: "Confirmed" });
    await record(manualOrder._id, { carrierName: "India Post", trackingNumber: "IP-KEEP-1" });
    const hijack = await hook({
      order_id: String(manualOrder._id),
      awb: "SR-HIJACK-1",
      courier_name: "Xpressbees",
      shipment_status_id: 7,
      shipment_status: "DELIVERED",
    });
    ok("an event naming a MANUAL order is still processed", hijack.statusCode === 200);
    const keptManual = await fresh(manualOrder._id);
    ok("but the provider stays MANUAL", keptManual.shipment.provider === "MANUAL", String(keptManual.shipment.provider));
    ok("the hand-entered carrier is not overwritten", keptManual.shipment.carrierName === "India Post",
      keptManual.shipment.carrierName);
    ok("nor the hand-entered tracking number", keptManual.shipment.trackingNumber === "IP-KEEP-1",
      keptManual.shipment.trackingNumber);

    // H2-01: ambiguity and conflict still refuse, and now must also leave the
    // neutral record alone.
    //
    // The duplicate AWB has to be planted with the unique index temporarily
    // dropped — the index refusing it IS the H2-01 fix working, so this is the only
    // way to exercise the defence-in-depth check behind it. Same technique, and the
    // same restore, as webhook-identity.regression.mjs.
    const awb = `AMB-${MARKER}`;
    const a = await makeOrder({ status: "Shipped", shiprocket: { awbCode: awb, syncStatus: "awb_assigned" } });
    const b = await makeOrder({ status: "Shipped", shiprocket: { orderId: 930000 + seq, syncStatus: "created" } });
    await OrderModel.collection.dropIndex("shiprocket_awbCode_unique").catch(() => {});
    await OrderModel.collection.updateOne({ _id: b._id }, { $set: { "shiprocket.awbCode": awb } });
    ok("the duplicate AWB only exists because the index was dropped for this fixture",
      (await OrderModel.countDocuments({ "shiprocket.awbCode": awb })) === 2);

    const ambiguous = await hook({ awb, shipment_status_id: 7, shipment_status: "DELIVERED" });
    ok("two orders sharing an AWB is refused as ambiguous",
      ambiguous.body?.ignored === true && ambiguous.body?.reason === "ambiguous_awb",
      JSON.stringify(ambiguous.body));
    for (const id of [a._id, b._id]) {
      const untouched = await fresh(id);
      ok("  neither order is delivered", untouched.orderStatus === "Shipped");
      ok("  and neither gains a shipment provider", untouched.shipment.provider === null);
    }

    // Restored before anything else runs, and proven to be back.
    await OrderModel.collection.updateOne({ _id: b._id }, { $unset: { "shiprocket.awbCode": "" } });
    await OrderModel.collection.createIndex(
      { "shiprocket.awbCode": 1 },
      {
        name: "shiprocket_awbCode_unique",
        unique: true,
        partialFilterExpression: { "shiprocket.awbCode": { $type: "string" } },
      },
    );
    ok("the H2-01 uniqueness index is restored",
      (await OrderModel.collection.indexes()).some(
        (index) => index.name === "shiprocket_awbCode_unique" && index.unique === true,
      ));
    let secondClaimRefused = false;
    try {
      await OrderModel.collection.updateOne({ _id: b._id }, { $set: { "shiprocket.awbCode": awb } });
    } catch (error) {
      secondClaimRefused = error?.code === 11000;
    }
    ok("and structurally refuses a second order claiming the same AWB again",
      secondClaimRefused);

    // A genuine conflict needs both identifiers to match, and to match DIFFERENT
    // orders. An identifier matching nothing is deliberately tolerated by H2-01 —
    // the first AWB event legitimately arrives before we have stored one — so
    // pairing a real order id with a nonexistent sr_order_id resolves cleanly and
    // proves nothing.
    const conflict = await hook({
      order_id: String(a._id),
      sr_order_id: b.shiprocket.orderId,
      shipment_status_id: 7,
      shipment_status: "DELIVERED",
    });
    ok("identifiers naming DIFFERENT orders is refused as a conflict",
      conflict.body?.ignored === true && conflict.body?.reason === "conflicting_identifiers",
      JSON.stringify(conflict.body));
    for (const id of [a._id, b._id]) {
      const untouched = await fresh(id);
      ok("  and that order is left alone", untouched.orderStatus === "Shipped", untouched.orderStatus);
    }

    const unknownIdentifier = await hook({
      order_id: String(a._id),
      sr_order_id: 999777666,
      shipment_status_id: 6,
      shipment_status: "SHIPPED",
    });
    ok("while an identifier matching nothing is still tolerated, as H2-01 intends",
      unknownIdentifier.body?.ignored !== true, JSON.stringify(unknownIdentifier.body));

    const unparseable = await hook({ order_id: "not-an-object-id", shipment_status_id: 7 });
    ok("an unparseable order id is refused",
      unparseable.body?.ignored === true && unparseable.body?.reason === "unparseable_order_id");

    const noIds = await hook({ shipment_status_id: 7, shipment_status: "DELIVERED" });
    ok("an event with no identifiers is refused",
      noIds.body?.ignored === true && noIds.body?.reason === "no_identifiers");

    const badToken = await callController(shippingController.ShippingWebhook, {
      body: { order_id: String(srOrder._id) },
      headers: { "x-api-key": "wrong" },
    });
    ok("a bad webhook token is still rejected", badToken.statusCode === 401);

    // RTO is unchanged: the parcel is back, but nothing restocks here.
    const rtoOrder = await makeOrder({ status: "RTO", shiprocket: { orderId: 920000 + seq, syncStatus: "rto" } });
    const stockBefore = (await ProductModel.findById(rtoOrder.items[0].product)).stock;
    const rto = await hook({
      order_id: String(rtoOrder._id),
      shipment_status_id: 43,
      shipment_status: "RTO DELIVERED",
    });
    ok("an RTO arrival event is accepted", rto.statusCode === 200);
    const afterRto = await fresh(rtoOrder._id);
    ok("the order reaches RTO Received", afterRto.orderStatus === "RTO Received", afterRto.orderStatus);
    ok("and stock is still NOT restocked at arrival",
      (await ProductModel.findById(rtoOrder.items[0].product)).stock === stockBefore);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("9 — authorization");

  {
    const makeUser = async (roles, extra = {}) => {
      const user = await UserModel.create({
        name: `${MARKER} user`,
        email: `${MARKER}-${trash.users.length}@test.local`,
        password: "x".repeat(60),
        roles,
        ...extra,
      });
      trash.users.push(user._id);
      return user;
    };

    const gate = requirePermission(ADMIN_PERMISSIONS.ORDERS_MANAGE);
    const runGate = async (user) => {
      let statusCode = 200;
      let passed = false;
      const res = { status(code) { statusCode = code; return this; }, json() { return this; } };
      await gate({ user: user ? { id: String(user._id) } : undefined }, res, () => { passed = true; });
      return { statusCode, passed };
    };

    const anonymous = await runGate(null);
    ok("an unauthenticated caller is refused", anonymous.passed === false && anonymous.statusCode === 403,
      `${anonymous.statusCode}`);

    const customer = await makeUser(["user"]);
    const asCustomer = await runGate(customer);
    ok("a signed-in customer is refused", asCustomer.passed === false && asCustomer.statusCode === 403);

    const themeEditor = await makeUser(["themeEditor"]);
    const asThemeEditor = await runGate(themeEditor);
    ok("an admin without orders:manage is refused",
      asThemeEditor.passed === false && asThemeEditor.statusCode === 403);

    const blocked = await makeUser(["admin"], { isBlocked: true });
    const asBlocked = await runGate(blocked);
    ok("a blocked admin is refused", asBlocked.passed === false && asBlocked.statusCode === 403);

    const orderAdmin = await makeUser(["admin"]);
    const asAdmin = await runGate(orderAdmin);
    ok("an admin with orders:manage is allowed through", asAdmin.passed === true);

    const routes = await readFile(new URL("../../src/modules/orders/order.routes.js", import.meta.url), "utf8");
    const route = routes.split("\n").join(" ").match(/routes\.put\(\s*"\/:orderId\/shipment\/manual",([^;]*)\)/);
    ok("the route exists", Boolean(route), String(route));
    ok("it requires authentication", /TokenVerify/.test(route?.[1] || ""));
    ok("it requires orders:manage", /canManageOrders/.test(route?.[1] || ""));
    ok("and validates the body before the handler runs",
      /validate\(manualShipmentSchema\)/.test(route?.[1] || ""));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("10 — the customer actually sees the tracking number");

  {
    const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
    const slice = await read("../../../kitab-shop-fe/src/store/ordersSlice.js");
    ok("the order state exposes the provider-neutral shipment", /shipment:\s*order\.shipment/.test(slice));
    ok("without dropping shiprocket", /shiprocket:\s*order\.shiprocket/.test(slice));

    const timeline = await read("../../../kitab-shop-fe/src/features/order-detail/OrderTimelineAndItems.jsx");
    ok("the customer panel reads the neutral tracking number first",
      /order\.shipment\?\.trackingNumber\s*\|\|\s*order\.shiprocket\?\.awbCode/.test(timeline));
    ok("and the neutral carrier first",
      /order\.shipment\?\.carrierName\s*\|\|\s*order\.shiprocket\?\.courierName/.test(timeline));
    ok("the panel is no longer gated on a Shiprocket AWB",
      !/\{order\.shiprocket\?\.awbCode\s*&&\s*\(/.test(timeline));
    ok("Shiprocket's own sync fields are shown only for Shiprocket parcels",
      /isShiprocket\s*&&/.test(timeline));

    const adminDetail = await read("../../../kitab-shop-fe/src/pages/admin/AdminOrderDetail.jsx");
    ok("the admin screen has a provider-neutral Shipment card", /title="Shipment"/.test(adminDetail));
    ok("it shows the provider", /label="Provider"/.test(adminDetail));
    ok("it offers manual entry", /Record Manual Shipment/.test(adminDetail));
    ok("calling the manual endpoint with PUT",
      /shipment\/manual`[\s\S]{0,200}"PUT"/.test(adminDetail));
    ok("and hides the form when Shiprocket owns the shipment",
      /hasShiprocketShipment\s*\?/.test(adminDetail));
  }
} catch (error) {
  console.error("\nSUITE ABORTED:", error);
  process.exitCode = 1;
} finally {
  await OrderModel.deleteMany({ _id: { $in: trash.orders } });
  await ProductModel.deleteMany({ _id: { $in: trash.products } });
  await UserModel.deleteMany({ _id: { $in: trash.users } });
  await mongoose.disconnect();
  finish();
}
