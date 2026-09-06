/**
 * Shiprocket webhook identity (H2-01) + partial-cancellation shipment closure (F5).
 *
 * The webhook resolved an order with a first-match cascade over
 * `_id` → `shiprocket.orderId` → `shiprocket.awbCode`, using `findOne`. Those two
 * shipment fields carried plain NON-UNIQUE indexes, so the lookup could match
 * several orders and the driver returned an arbitrary one. Applied to a `Delivered`
 * event that means: the wrong order is stamped delivered, and a COD order flips
 * Pending → Paid — revenue booked for cash nobody collected.
 *
 * Run with `npm run test:webhook-identity` (or `npm test` for everything).
 *
 * Everything here drives the REAL `ShippingWebhook` controller, including its token
 * auth, so identity resolution, the transition table, the COD promotion and the RTO
 * branch all run as deployed. Only `globalThis.fetch` is stubbed, for the courier
 * cancellation in the F5 section.
 */
process.env.SHIPROCKET_ENABLED = "true";
process.env.SHIPROCKET_WEBHOOK_ENABLED = "true";
process.env.SHIPROCKET_WEBHOOK_TOKEN = "stub-webhook-token";
process.env.SHIPROCKET_EMAIL = "stub@example.test";
process.env.SHIPROCKET_PASSWORD = "stub-password";
process.env.SHIPROCKET_BASE_URL = "https://shiprocket.invalid/v1/external";
process.env.INVENTORY_ENFORCE_STOCK = "true";
process.env.NOTIFICATIONS_ENABLED = "false";
process.env.PAYMENTS_ENABLED = "true";
process.env.PAYMENT_PROVIDER = "razorpay";
process.env.RAZORPAY_KEY_ID = "rzp_test_stub0000000";
process.env.RAZORPAY_KEY_SECRET = "stub_secret_for_tests";

import mongoose from "mongoose";
import { connect, createSuite, marker, productFixture, addressFixture, pinShiprocketCapabilities } from "./helpers.mjs";

const { ok, section, finish } = createSuite("webhook-identity");
await connect();
// Pinned so this suite does not depend on how the store happens to be configured in the
// admin panel: it drives Shiprocket paths, and an admin choosing "manual fulfilment" or
// "Shiprocket basics" would otherwise make it fail for a correct reason.
const restoreCapabilities = await pinShiprocketCapabilities();

const OrderModel = (await import("../src/modules/orders/Order.model.js")).default;
const ProductModel = (await import("../src/modules/products/Product.model.js")).default;
const ShiprocketSetting = (await import("../src/modules/shipping/ShiprocketSetting.model.js")).default;
await import("../src/modules/categories/Category.model.js");
const shippingController = await import("../src/modules/shipping/shipping.controller.js");
const orderController = await import("../src/modules/orders/order.controller.js");
const razorpayService = await import("../src/modules/payments/razorpay.service.js");

/**
 * The identity indexes are EXPLICITLY named in the schema, so autoIndex builds them
 * cleanly alongside the plain indexes they supersede. That naming is deliberate: an
 * auto-named unique index would collide with the existing `shiprocket.orderId_1` /
 * `shiprocket.awbCode_1` and fail with IndexKeySpecsConflict on every boot, leaving
 * the collection non-unique. Restored after the ambiguity fixtures drop them.
 */
const SHIPMENT_INDEX_SPECS = [
  { field: "shiprocket.orderId", name: "shiprocket_orderId_unique", bsonType: "number" },
  { field: "shiprocket.awbCode", name: "shiprocket_awbCode_unique", bsonType: "string" },
];

const applyShipmentIdentityIndexes = async () => {
  for (const spec of SHIPMENT_INDEX_SPECS) {
    await OrderModel.collection
      .createIndex(
        { [spec.field]: 1 },
        {
          name: spec.name,
          unique: true,
          partialFilterExpression: { [spec.field]: { $type: spec.bsonType } },
        },
      )
      .catch(() => {});
  }
};

await OrderModel.createIndexes().catch(() => {});
await applyShipmentIdentityIndexes();
await ShiprocketSetting.getSettings();

// ── Razorpay stub, for the prepaid partial-cancellation case ────────────────
const razorpayCalls = { refund: [] };
const { razorpay: sharedRazorpay } = razorpayService.getRazorpay();
let refundSeq = 0;
sharedRazorpay.payments.refund = async (paymentId, options) => {
  razorpayCalls.refund.push({ paymentId, options });
  return { id: `rfnd_wid_${++refundSeq}`, status: "processed" };
};
sharedRazorpay.payments.fetchMultipleRefund = async () => ({ items: [] });

// ── Shiprocket HTTP stub, for the F5 cancellation section ───────────────────
const courier = { cancelCalls: [] };
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = String(input instanceof URL ? input.href : input);
  if (url.includes("/auth/login")) {
    return new Response(JSON.stringify({ token: "t" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (url.includes("/orders/cancel")) {
    courier.cancelCalls.push(JSON.parse(init.body || "{}").ids || []);
    return new Response(JSON.stringify({ status: 200, message: "cancelled" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  throw new Error(`Unexpected call: ${url}`);
};

const MARKER = marker("webhookid");
const trash = { orders: [], products: [] };
let seq = 0;

const makeProduct = async (label, stock = 20) => {
  const product = await ProductModel.create(productFixture(`${MARKER}-${label}`, { stock }));
  trash.products.push(product._id);
  return product;
};

const makeOrder = async ({
  product,
  quantity = 1,
  srOrderId = null,
  awbCode = null,
  orderStatus = "Shipped",
  paymentMethod = "COD",
  paymentStatus = "Pending",
  ...fields
}) => {
  seq += 1;
  const subtotal = product.price * quantity;
  const order = await OrderModel.create({
    user: new mongoose.Types.ObjectId(),
    items: [
      { product: product._id, name: product.name, image: "x.png", price: product.price, quantity },
    ],
    shippingAddress: addressFixture(),
    paymentMethod,
    paymentStatus,
    orderStatus,
    subtotal,
    totalAmount: subtotal,
    ...(paymentMethod === "RAZORPAY" ? { razorpayPaymentId: `pay_${MARKER}_${seq}` } : {}),
    shiprocket: {
      orderId: srOrderId,
      shipmentId: srOrderId ? srOrderId + 1 : null,
      awbCode,
      status: "IN TRANSIT",
      syncStatus: awbCode ? "awb_assigned" : "created",
    },
    ...fields,
  });
  trash.orders.push(order._id);
  return order;
};

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
    { body, get: (header) => (header.toLowerCase() === "x-api-key" ? token : undefined) },
    res,
  );
  return { statusCode, body: payload };
};

const snapshot = async (id) => {
  const order = await OrderModel.findById(id).lean();
  return {
    orderStatus: order.orderStatus,
    paymentStatus: order.paymentStatus,
    deliveredAt: order.deliveredAt ? "set" : null,
    srOrderId: order.shiprocket?.orderId ?? null,
    awbCode: order.shiprocket?.awbCode ?? null,
    historyLength: (order.statusHistory || []).length,
    refunds: (order.refunds || []).length,
  };
};

/**
 * Ambiguity is now structurally impossible thanks to the unique partial indexes,
 * so to test the RUNTIME guard — which exists for rows written before those
 * indexes, and for the window while they build — the index has to come off for the
 * duration of the fixture.
 */
const withoutShipmentUniqueIndexes = async (fn) => {
  const collection = OrderModel.collection;
  const names = ["shiprocket_orderId_unique", "shiprocket_awbCode_unique"];
  for (const name of names) await collection.dropIndex(name).catch(() => {});
  try {
    return await fn();
  } finally {
    await applyShipmentIdentityIndexes();
  }
};

try {
  // ═══════════════════════════════════════════════════════════════════════════
  section("indexes — courier identity is enforced by the database");

  {
    const indexes = await OrderModel.collection.indexes();
    const byOrderId = indexes.find((i) => i.name === "shiprocket_orderId_unique");
    const byAwb = indexes.find((i) => i.name === "shiprocket_awbCode_unique");

    ok("a shiprocket.orderId index exists", Boolean(byOrderId));
    ok("it is unique", byOrderId?.unique === true, JSON.stringify(byOrderId?.unique));
    ok(
      "it is PARTIAL on $type, not sparse — stored nulls must not collide",
      JSON.stringify(byOrderId?.partialFilterExpression) ===
        JSON.stringify({ "shiprocket.orderId": { $type: "number" } }),
      JSON.stringify(byOrderId?.partialFilterExpression),
    );
    ok("a shiprocket.awbCode index exists and is unique", byAwb?.unique === true);
    ok(
      "also partial on $type",
      JSON.stringify(byAwb?.partialFilterExpression) ===
        JSON.stringify({ "shiprocket.awbCode": { $type: "string" } }),
      JSON.stringify(byAwb?.partialFilterExpression),
    );
  }

  {
    // The reason sparse would have been wrong: many orders legitimately carry null.
    const product = await makeProduct("nulls");
    const a = await makeOrder({ product, srOrderId: null, awbCode: null });
    const b = await makeOrder({ product, srOrderId: null, awbCode: null });
    ok("two shipment-less orders coexist (null is not indexed)", Boolean(a._id && b._id));

    let blocked = false;
    await makeOrder({ product, srOrderId: 5550001, awbCode: "AWB-UNIQ-1" });
    try {
      await makeOrder({ product, srOrderId: 5550001, awbCode: "AWB-UNIQ-2" });
    } catch (error) {
      blocked = error?.code === 11000;
    }
    ok("but two orders cannot share a real shiprocket.orderId", blocked, "duplicate accepted");

    let awbBlocked = false;
    try {
      await makeOrder({ product, srOrderId: 5550002, awbCode: "AWB-UNIQ-1" });
    } catch (error) {
      awbBlocked = error?.code === 11000;
    }
    ok("nor a real awbCode", awbBlocked, "duplicate accepted");
  }

  section("1/2 — exact identifiers resolve to the intended order");

  {
    const product = await makeProduct("exact");
    const target = await makeOrder({ product, srOrderId: 6010001, awbCode: "AWB-EXACT-1" });
    const other = await makeOrder({ product, srOrderId: 6010002, awbCode: "AWB-EXACT-2" });
    const otherBefore = await snapshot(other._id);

    const bySrId = await sendWebhook({
      sr_order_id: 6010001,
      shipment_status_id: 17,
      shipment_status: "OUT FOR DELIVERY",
    });
    ok("an exact sr_order_id event is accepted", bySrId.body?.ignored !== true, JSON.stringify(bySrId.body));
    ok(
      "the intended order advanced",
      (await snapshot(target._id)).orderStatus === "Out For Delivery",
      (await snapshot(target._id)).orderStatus,
    );
    ok(
      "the other order is untouched",
      JSON.stringify(await snapshot(other._id)) === JSON.stringify(otherBefore),
    );

    const byAwb = await sendWebhook({
      awb: "AWB-EXACT-2",
      shipment_status_id: 17,
      shipment_status: "OUT FOR DELIVERY",
    });
    ok("an exact awb event is accepted", byAwb.body?.ignored !== true, JSON.stringify(byAwb.body));
    ok(
      "and resolves to the AWB's own order",
      (await snapshot(other._id)).orderStatus === "Out For Delivery",
    );
  }

  {
    // Our own _id is honoured too, and an AWB we have not stored yet does not
    // block resolution — that is the normal first-AWB event.
    const product = await makeProduct("firstawb");
    const order = await makeOrder({ product, srOrderId: 6010010, awbCode: null });
    const response = await sendWebhook({
      order_id: String(order._id),
      sr_order_id: 6010010,
      awb: "AWB-BRAND-NEW",
      shipment_status_id: 6,
      shipment_status: "SHIPPED",
    });
    ok("an unseen AWB does not block resolution", response.body?.ignored !== true, JSON.stringify(response.body));
    const after = await snapshot(order._id);
    ok("the AWB is stored", after.awbCode === "AWB-BRAND-NEW", String(after.awbCode));
  }

  section("3 — unknown identifier mutates nothing");

  {
    const product = await makeProduct("unknown");
    const order = await makeOrder({ product, srOrderId: 6020001, awbCode: "AWB-KNOWN" });
    const before = await snapshot(order._id);

    const byUnknownSr = await sendWebhook({
      sr_order_id: 9999999,
      shipment_status_id: 7,
      shipment_status: "DELIVERED",
    });
    ok("an unknown sr_order_id is ignored", byUnknownSr.body?.ignored === true, JSON.stringify(byUnknownSr.body));
    ok("with reason no_match", byUnknownSr.body?.reason === "no_match", byUnknownSr.body?.reason);

    const byUnknownAwb = await sendWebhook({
      awb: "AWB-DOES-NOT-EXIST",
      shipment_status_id: 7,
      shipment_status: "DELIVERED",
    });
    ok("an unknown awb is ignored", byUnknownAwb.body?.ignored === true, JSON.stringify(byUnknownAwb.body));

    const garbageId = await sendWebhook({
      order_id: "not-an-object-id",
      shipment_status_id: 7,
      shipment_status: "DELIVERED",
    });
    ok(
      "an unparseable order_id is refused, NOT silently downgraded to a fuzzier match",
      garbageId.body?.reason === "unparseable_order_id",
      JSON.stringify(garbageId.body),
    );

    const empty = await sendWebhook({ shipment_status_id: 7, shipment_status: "DELIVERED" });
    ok("an event with no identifiers is ignored", empty.body?.reason === "no_identifiers", JSON.stringify(empty.body));

    ok(
      "the real order is unchanged throughout",
      JSON.stringify(await snapshot(order._id)) === JSON.stringify(before),
    );
  }

  section("4/6/7 — AMBIGUOUS identity: no order is modified");

  {
    await withoutShipmentUniqueIndexes(async () => {
      const product = await makeProduct("ambiguous");
      // Legacy-shaped duplicate data: two COD orders sharing an sr_order_id.
      const a = await makeOrder({ product, srOrderId: 7010001, awbCode: "AWB-AMB-A" });
      const b = await makeOrder({ product, srOrderId: 7010001, awbCode: "AWB-AMB-B" });
      const beforeA = await snapshot(a._id);
      const beforeB = await snapshot(b._id);

      const delivered = await sendWebhook({
        sr_order_id: 7010001,
        shipment_status_id: 7,
        shipment_status: "DELIVERED",
      });

      ok("the ambiguous Delivered event is ignored", delivered.body?.ignored === true, JSON.stringify(delivered.body));
      ok(
        "with an ambiguity reason",
        delivered.body?.reason === "ambiguous_sr_order_id",
        delivered.body?.reason,
      );
      ok(
        "order A is completely unmodified",
        JSON.stringify(await snapshot(a._id)) === JSON.stringify(beforeA),
        JSON.stringify(await snapshot(a._id)),
      );
      ok(
        "order B is completely unmodified",
        JSON.stringify(await snapshot(b._id)) === JSON.stringify(beforeB),
      );
      // ── the financial invariant ──
      ok("neither COD order became Paid", (await snapshot(a._id)).paymentStatus === "Pending" && (await snapshot(b._id)).paymentStatus === "Pending");
      ok("neither was stamped delivered", !(await snapshot(a._id)).deliveredAt && !(await snapshot(b._id)).deliveredAt);
      ok("no statusHistory was appended", (await snapshot(a._id)).historyLength === beforeA.historyLength);

      // Same for a duplicated AWB.
      const c = await makeOrder({ product, srOrderId: 7010005, awbCode: "AWB-AMB-DUP" });
      const d = await makeOrder({ product, srOrderId: 7010006, awbCode: "AWB-AMB-DUP" });
      const beforeC = await snapshot(c._id);
      const beforeD = await snapshot(d._id);
      const byAwb = await sendWebhook({
        awb: "AWB-AMB-DUP",
        shipment_status_id: 7,
        shipment_status: "DELIVERED",
      });
      ok("an ambiguous AWB event is ignored", byAwb.body?.reason === "ambiguous_awb", JSON.stringify(byAwb.body));
      ok(
        "neither AWB-sharing order changed",
        JSON.stringify(await snapshot(c._id)) === JSON.stringify(beforeC) &&
          JSON.stringify(await snapshot(d._id)) === JSON.stringify(beforeD),
      );
    });
  }

  section("5 — CONFLICTING identifiers: reject, never guess");

  {
    const product = await makeProduct("conflict");
    const a = await makeOrder({ product, srOrderId: 7020001, awbCode: "AWB-CONF-A" });
    const b = await makeOrder({ product, srOrderId: 7020002, awbCode: "AWB-CONF-B" });
    const beforeA = await snapshot(a._id);
    const beforeB = await snapshot(b._id);

    // sr_order_id names A, awb names B. Under the old cascade the first non-empty
    // identifier won and the OTHER one was written over the resolved order.
    const response = await sendWebhook({
      sr_order_id: 7020001,
      awb: "AWB-CONF-B",
      shipment_status_id: 7,
      shipment_status: "DELIVERED",
    });

    ok("the conflicting event is ignored", response.body?.ignored === true, JSON.stringify(response.body));
    ok(
      "with reason conflicting_identifiers",
      response.body?.reason === "conflicting_identifiers",
      response.body?.reason,
    );
    ok("order A unchanged", JSON.stringify(await snapshot(a._id)) === JSON.stringify(beforeA));
    ok("order B unchanged", JSON.stringify(await snapshot(b._id)) === JSON.stringify(beforeB));
    ok(
      "neither order's identity was overwritten",
      (await snapshot(a._id)).awbCode === "AWB-CONF-A" &&
        (await snapshot(b._id)).srOrderId === 7020002,
    );
    ok("no COD payment was booked", (await snapshot(a._id)).paymentStatus === "Pending");

    // And our own _id conflicting with an AWB belonging to someone else.
    const byIdAndForeignAwb = await sendWebhook({
      order_id: String(a._id),
      awb: "AWB-CONF-B",
      shipment_status_id: 7,
      shipment_status: "DELIVERED",
    });
    ok(
      "_id conflicting with a foreign AWB is refused",
      byIdAndForeignAwb.body?.reason === "conflicting_identifiers",
      JSON.stringify(byIdAndForeignAwb.body),
    );
  }

  section("8/9 — valid Delivered: COD paid exactly once");

  {
    const product = await makeProduct("cod-delivered");
    const order = await makeOrder({
      product,
      srOrderId: 7030001,
      awbCode: "AWB-COD-1",
      orderStatus: "Out For Delivery",
      paymentMethod: "COD",
      paymentStatus: "Pending",
    });

    const first = await sendWebhook({
      sr_order_id: 7030001,
      shipment_status_id: 7,
      shipment_status: "DELIVERED",
    });
    ok("the event is accepted", first.body?.ignored !== true, JSON.stringify(first.body));

    const afterFirst = await snapshot(order._id);
    ok("the order is Delivered", afterFirst.orderStatus === "Delivered", afterFirst.orderStatus);
    ok("COD is now Paid", afterFirst.paymentStatus === "Paid", afterFirst.paymentStatus);
    ok("deliveredAt is stamped", afterFirst.deliveredAt === "set");

    // Replay x2 — the existing idempotency (transition table + deliveredAt
    // first-wins + the paymentStatus:"Pending" filter) must hold.
    await sendWebhook({ sr_order_id: 7030001, shipment_status_id: 7, shipment_status: "DELIVERED" });
    await sendWebhook({ sr_order_id: 7030001, shipment_status_id: 7, shipment_status: "DELIVERED" });
    const afterReplays = await snapshot(order._id);

    ok(
      "replays add no statusHistory entries",
      afterReplays.historyLength === afterFirst.historyLength,
      `${afterFirst.historyLength} → ${afterReplays.historyLength}`,
    );
    ok("still Paid, not double-processed", afterReplays.paymentStatus === "Paid");
    const fresh = await OrderModel.findById(order._id);
    ok(
      "exactly one Delivered entry in history",
      fresh.statusHistory.filter((e) => e.to === "Delivered").length === 1,
      JSON.stringify(fresh.statusHistory.map((e) => e.to)),
    );
    ok("no refund rows were created", afterReplays.refunds === 0);
  }

  {
    // A prepaid order's paymentStatus must NOT be touched by delivery.
    const product = await makeProduct("prepaid-delivered");
    const order = await makeOrder({
      product,
      srOrderId: 7030010,
      orderStatus: "Out For Delivery",
      paymentMethod: "RAZORPAY",
      paymentStatus: "Paid",
    });
    await sendWebhook({ sr_order_id: 7030010, shipment_status_id: 7, shipment_status: "DELIVERED" });
    const after = await snapshot(order._id);
    ok("prepaid order is Delivered", after.orderStatus === "Delivered", after.orderStatus);
    ok("and stays Paid", after.paymentStatus === "Paid", after.paymentStatus);
  }

  section("10 — ambiguous RTO does not transition or create liabilities");

  {
    await withoutShipmentUniqueIndexes(async () => {
      const product = await makeProduct("rto-ambiguous");
      const a = await makeOrder({
        product,
        srOrderId: 7040001,
        orderStatus: "RTO",
        paymentMethod: "RAZORPAY",
        paymentStatus: "Paid",
      });
      const b = await makeOrder({
        product,
        srOrderId: 7040001,
        orderStatus: "RTO",
        paymentMethod: "RAZORPAY",
        paymentStatus: "Paid",
      });
      const beforeA = await snapshot(a._id);
      const beforeB = await snapshot(b._id);

      const response = await sendWebhook({
        sr_order_id: 7040001,
        shipment_status_id: 10,
        shipment_status: "RTO DELIVERED",
      });

      ok("the ambiguous RTO event is ignored", response.body?.ignored === true, JSON.stringify(response.body));
      ok("neither order reached RTO Received", (await snapshot(a._id)).orderStatus === "RTO" && (await snapshot(b._id)).orderStatus === "RTO");
      ok(
        "and NO refund obligation was recorded on either",
        (await snapshot(a._id)).refunds === 0 && (await snapshot(b._id)).refunds === 0,
      );
      ok(
        "both fully unchanged",
        JSON.stringify(await snapshot(a._id)) === JSON.stringify(beforeA) &&
          JSON.stringify(await snapshot(b._id)) === JSON.stringify(beforeB),
      );
    });
  }

  {
    // The unambiguous RTO arrival still works — the guard must not break it.
    const product = await makeProduct("rto-valid");
    const order = await makeOrder({
      product,
      srOrderId: 7040010,
      orderStatus: "RTO",
      paymentMethod: "RAZORPAY",
      paymentStatus: "Paid",
    });
    await sendWebhook({
      sr_order_id: 7040010,
      shipment_status_id: 10,
      shipment_status: "RTO DELIVERED",
    });
    const after = await snapshot(order._id);
    ok("a unique RTO arrival transitions to RTO Received", after.orderStatus === "RTO Received", after.orderStatus);
    ok("and records a refund obligation for the prepaid customer", after.refunds === 1, String(after.refunds));
    ok("as Refund Pending", after.paymentStatus === "Refund Pending", after.paymentStatus);
  }

  section("11/12 — out-of-order and illegal transitions");

  {
    const product = await makeProduct("outoforder");
    const order = await makeOrder({
      product,
      srOrderId: 7050001,
      orderStatus: "Out For Delivery",
      paymentMethod: "COD",
    });

    await sendWebhook({ sr_order_id: 7050001, shipment_status_id: 7, shipment_status: "DELIVERED" });
    const delivered = await snapshot(order._id);
    ok("delivered first", delivered.orderStatus === "Delivered");

    // Delivered is terminal — a late NDR must not walk it backwards.
    const lateNdr = await sendWebhook({
      sr_order_id: 7050001,
      shipment_status_id: 20,
      shipment_status: "NDR - Customer unavailable",
      // Supplied explicitly: the handler only records a reason on the event that
      // carries one, so a later status event cannot blank out why delivery failed.
      ndr_reason: "Customer unavailable",
    });
    const afterNdr = await snapshot(order._id);
    ok("the event is accepted for identity purposes", lateNdr.body?.ignored !== true);
    ok("but the order stays Delivered", afterNdr.orderStatus === "Delivered", afterNdr.orderStatus);
    ok("no history entry was added", afterNdr.historyLength === delivered.historyLength);
    ok("COD stays Paid, not reverted", afterNdr.paymentStatus === "Paid", afterNdr.paymentStatus);
    ok(
      "the courier's reason is still recorded on the shipment",
      Boolean((await OrderModel.findById(order._id)).shiprocket.ndrReason),
    );
  }

  {
    // A stale Delivered for a CANCELLED order must not resurrect it or book COD.
    const product = await makeProduct("cancelled-delivered");
    const order = await makeOrder({
      product,
      srOrderId: 7050010,
      orderStatus: "Cancelled",
      paymentMethod: "COD",
      paymentStatus: "Pending",
    });
    const before = await snapshot(order._id);
    await sendWebhook({ sr_order_id: 7050010, shipment_status_id: 7, shipment_status: "DELIVERED" });
    const after = await snapshot(order._id);
    ok("a Cancelled order is not resurrected", after.orderStatus === "Cancelled", after.orderStatus);
    ok("COD is NOT marked Paid", after.paymentStatus === "Pending", after.paymentStatus);
    ok("deliveredAt is not stamped", !after.deliveredAt);
    ok("no history entry", after.historyLength === before.historyLength);
  }

  section("13/14 — several event types for one shipment");

  {
    const product = await makeProduct("sequence");
    const order = await makeOrder({
      product,
      srOrderId: 7060001,
      orderStatus: "Confirmed",
      paymentMethod: "COD",
    });

    const events = [
      { shipment_status_id: 6, shipment_status: "SHIPPED" },
      { shipment_status_id: 17, shipment_status: "OUT FOR DELIVERY" },
      { shipment_status_id: 20, shipment_status: "NDR - not available" },
      { shipment_status_id: 17, shipment_status: "OUT FOR DELIVERY" },
      { shipment_status_id: 7, shipment_status: "DELIVERED" },
      { shipment_status_id: 7, shipment_status: "DELIVERED" }, // replay
    ];
    for (const event of events) await sendWebhook({ sr_order_id: 7060001, ...event });

    const fresh = await OrderModel.findById(order._id);
    const path = fresh.statusHistory.map((entry) => entry.to);
    ok(
      "the lifecycle walked Shipped → Out For Delivery → NDR → Out For Delivery → Delivered",
      JSON.stringify(path) ===
        JSON.stringify(["Shipped", "Out For Delivery", "NDR", "Out For Delivery", "Delivered"]),
      JSON.stringify(path),
    );
    ok("COD collected exactly once", fresh.paymentStatus === "Paid", fresh.paymentStatus);
    ok(
      "the Delivered replay added nothing",
      path.filter((status) => status === "Delivered").length === 1,
    );
    ok(
      "every history entry is attributed to the webhook",
      fresh.statusHistory.every((entry) => entry.source === "shiprocket_webhook" && entry.changedBy === null),
    );
  }

  {
    const product = await makeProduct("badtoken");
    const order = await makeOrder({ product, srOrderId: 7060010 });
    const before = await snapshot(order._id);
    const response = await sendWebhook(
      { sr_order_id: 7060010, shipment_status_id: 7, shipment_status: "DELIVERED" },
      { token: "wrong-token" },
    );
    ok("a bad webhook token is rejected with 401", response.statusCode === 401, String(response.statusCode));
    ok("and nothing is modified", JSON.stringify(await snapshot(order._id)) === JSON.stringify(before));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("15/16/17 — F5: partial cancellation and the courier");

  const partialCancel = (order, { productId, quantity }) => {
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
    return orderController
      .PartialCancelOrder(
        {
          params: { orderId: String(order._id) },
          body: { productId: String(productId), quantity, reason: "Damaged" },
          user: { id: String(new mongoose.Types.ObjectId()), roles: ["admin"] },
          query: {},
        },
        res,
      )
      .then(() => ({ statusCode, body: payload }));
  };

  {
    // 15 — order stays active: the courier must NOT be told.
    courier.cancelCalls = [];
    const product = await makeProduct("f5-active");
    const order = await makeOrder({
      product,
      quantity: 2,
      srOrderId: 8010001,
      orderStatus: "Confirmed",
      paymentMethod: "RAZORPAY",
      paymentStatus: "Paid",
    });

    const response = await partialCancel(order, { productId: product._id, quantity: 1 });
    ok("the partial cancellation succeeds", response.statusCode === 200, `${response.statusCode} ${response.body?.message || ""}`);
    ok("the order remains active", (await snapshot(order._id)).orderStatus === "Confirmed");
    ok("ZERO Shiprocket cancellations", courier.cancelCalls.length === 0, `${courier.cancelCalls.length}`);
    ok("orderFullyCancelled is false", response.body?.orderFullyCancelled === false);
    ok("nothing is reported pending", response.body?.shipmentCancellationPending === false);
  }

  {
    // 16 — cancelling the final unit: exactly one courier cancellation.
    courier.cancelCalls = [];
    razorpayCalls.refund = [];
    const product = await makeProduct("f5-final");
    const order = await makeOrder({
      product,
      quantity: 1,
      srOrderId: 8010002,
      orderStatus: "Confirmed",
      paymentMethod: "RAZORPAY",
      paymentStatus: "Paid",
    });

    const response = await partialCancel(order, { productId: product._id, quantity: 1 });
    ok("the partial cancellation succeeds", response.statusCode === 200, `${response.statusCode} ${response.body?.message || ""}`);

    const after = await OrderModel.findById(order._id);
    ok("the order became Cancelled", after.orderStatus === "Cancelled", after.orderStatus);
    ok("EXACTLY ONE Shiprocket cancellation", courier.cancelCalls.length === 1, `${courier.cancelCalls.length}`);
    ok("aimed at the right shipment", courier.cancelCalls[0]?.[0] === 8010002, JSON.stringify(courier.cancelCalls));
    ok("the shipment is marked cancelled", after.shiprocket.syncStatus === "cancelled", after.shiprocket.syncStatus);
    ok("the response reports it", response.body?.shipmentCancelled === true, JSON.stringify(response.body?.shipmentCancelled));
    ok("nothing left pending", response.body?.shipmentCancellationPending === false);

    // 4 — the refund safety of Phase 1/1.5 is untouched.
    ok("exactly one gateway refund", razorpayCalls.refund.length === 1, `${razorpayCalls.refund.length}`);
    ok("one refund row", after.refunds.length === 1, `${after.refunds.length}`);
    ok(
      "carrying its partial-cancellation reconciliation key",
      String(after.refunds[0].idempotencyKey || "").startsWith("partial-cancel:"),
      after.refunds[0].idempotencyKey,
    );
    ok(
      "notes.refundKey matches the ledger key",
      razorpayCalls.refund[0]?.options?.notes?.refundKey === after.refunds[0].idempotencyKey,
      JSON.stringify(razorpayCalls.refund[0]?.options?.notes),
    );
  }

  {
    // 17 — concurrent final-item cancellation.
    courier.cancelCalls = [];
    razorpayCalls.refund = [];
    const product = await makeProduct("f5-concurrent");
    const order = await makeOrder({
      product,
      quantity: 1,
      srOrderId: 8010003,
      orderStatus: "Confirmed",
      paymentMethod: "RAZORPAY",
      paymentStatus: "Paid",
    });

    const results = await Promise.all([
      partialCancel(order, { productId: product._id, quantity: 1 }),
      partialCancel(order, { productId: product._id, quantity: 1 }),
      partialCancel(order, { productId: product._id, quantity: 1 }),
    ]);

    ok(
      "exactly one succeeds",
      results.filter((r) => r.statusCode === 200).length === 1,
      JSON.stringify(results.map((r) => r.statusCode)),
    );
    ok("EXACTLY ONE Shiprocket cancellation", courier.cancelCalls.length === 1, `${courier.cancelCalls.length}`);
    ok("exactly one gateway refund", razorpayCalls.refund.length === 1, `${razorpayCalls.refund.length}`);

    const after = await OrderModel.findById(order._id);
    ok("the order is Cancelled", after.orderStatus === "Cancelled", after.orderStatus);
    ok("one cancellation record", after.cancellations.length === 1, `${after.cancellations.length}`);
    ok("one refund row", after.refunds.length === 1, `${after.refunds.length}`);
    // The fixture inserts the order directly, so stock was never decremented:
    // one restore takes 20 -> 21, and a double restore would show 22.
    ok(
      "stock restored exactly once, not once per concurrent request",
      (await ProductModel.findById(product._id)).stock === 21,
      String((await ProductModel.findById(product._id)).stock),
    );
  }

  {
    // 5 — COD final-item partial cancellation: shipment cancelled, no refund.
    courier.cancelCalls = [];
    razorpayCalls.refund = [];
    const product = await makeProduct("f5-cod");
    const order = await makeOrder({
      product,
      quantity: 1,
      srOrderId: 8010004,
      orderStatus: "Confirmed",
      paymentMethod: "COD",
      paymentStatus: "Pending",
    });

    const response = await partialCancel(order, { productId: product._id, quantity: 1 });
    ok("the COD partial cancellation succeeds", response.statusCode === 200, String(response.statusCode));

    const after = await OrderModel.findById(order._id);
    ok("the order became Cancelled", after.orderStatus === "Cancelled", after.orderStatus);
    ok("EXACTLY ONE Shiprocket cancellation", courier.cancelCalls.length === 1, `${courier.cancelCalls.length}`);
    ok("ZERO refund rows for unpaid COD", after.refunds.length === 0, `${after.refunds.length}`);
    ok("ZERO gateway calls", razorpayCalls.refund.length === 0, `${razorpayCalls.refund.length}`);
    ok("paymentStatus stays Pending", after.paymentStatus === "Pending", after.paymentStatus);
  }

  {
    // Ordering invariant: the courier is told only after the local commit.
    courier.cancelCalls = [];
    const product = await makeProduct("f5-ordering");
    const order = await makeOrder({
      product,
      quantity: 1,
      srOrderId: 8010005,
      orderStatus: "Confirmed",
      paymentMethod: "COD",
      paymentStatus: "Pending",
    });

    // Read the committed state at the moment the courier call is made.
    let stateAtCall = null;
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (input, init = {}) => {
      const url = String(input instanceof URL ? input.href : input);
      if (url.includes("/orders/cancel")) {
        const live = await OrderModel.findById(order._id).lean();
        stateAtCall = { orderStatus: live.orderStatus, cancellations: (live.cancellations || []).length };
      }
      return previousFetch(input, init);
    };
    await partialCancel(order, { productId: product._id, quantity: 1 });
    globalThis.fetch = previousFetch;

    ok(
      "the order was ALREADY Cancelled in the database when the courier was called",
      stateAtCall?.orderStatus === "Cancelled",
      JSON.stringify(stateAtCall),
    );
    ok(
      "and the cancellation record was already committed",
      stateAtCall?.cancellations === 1,
      JSON.stringify(stateAtCall),
    );
  }
} catch (error) {
  console.error(`\nSUITE ABORTED: ${error?.stack || error}`);
  ok("suite ran to completion", false, error?.message);
} finally {
  globalThis.fetch = originalFetch;
  await applyShipmentIdentityIndexes();
  await OrderModel.deleteMany({ _id: { $in: trash.orders } });
  await ProductModel.deleteMany({ _id: { $in: trash.products } });
  restoreCapabilities();
  const { failed } = finish();
  await mongoose.disconnect();
  process.exit(failed ? 1 : 0);
}
