/**
 * The COD amount a courier collects is the amount the order says (S2).
 *
 * The forward payload used to ship `quantity` (ignoring cancelled units) and to send
 * `total_discount: order.discount` beside a `sub_total` that already had that discount
 * taken off. A COD order created after a partial cancellation asked the courier to
 * collect for goods that were no longer in the box, and whether Shiprocket subtracted
 * the discount a second time was simply not known.
 *
 * Now the discount is spread onto the lines (total_discount 0, Σ lines == sub_total),
 * only remaining units ship, and after creation the order is read back from Shiprocket
 * and its total compared with ours. A definite mismatch blocks AWB assignment on a COD
 * order until an admin acknowledges it; an unreadable total only warns.
 *
 * Run with `npm run test:cod-amount-guard` (or `npm test`).
 *
 * `globalThis.fetch` is stubbed at the HTTP boundary; unknown URLs throw.
 */
process.env.SHIPROCKET_ENABLED = "true";
process.env.SHIPROCKET_EMAIL = "stub@example.test";
process.env.SHIPROCKET_PASSWORD = "stub-password";
process.env.SHIPROCKET_BASE_URL = "https://shiprocket.invalid/v1/external";
process.env.NOTIFICATIONS_ENABLED = "false";
process.env.PAYMENTS_ENABLED = "false";

import mongoose from "mongoose";
import {
  addressFixture,
  connect,
  createSuite,
  marker,
  pinShiprocketCapabilities,
  productFixture,
} from "./helpers.mjs";

const { ok, section, finish } = createSuite("cod-amount-guard");
await connect();
const restoreCapabilities = await pinShiprocketCapabilities();

const OrderModel = (await import("../../src/modules/orders/Order.model.js")).default;
const ProductModel = (await import("../../src/modules/products/Product.model.js")).default;
const UserModel = (await import("../../src/model/User.model.js")).default;
const AuditLog = (await import("../../src/modules/audit/AuditLog.model.js")).default;
await import("../../src/modules/categories/Category.model.js");
const shippingController = await import("../../src/modules/shipping/shipping.controller.js");

// ── Shiprocket stub ─────────────────────────────────────────────────────────
const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const ID_BASE = 710_000_000 + (process.pid % 100_000) * 100;
let idSeq = 0;

const sr = {
  adhocCalls: [],
  awbCalls: [],
  showCalls: [],
  // What /orders/show answers for the next order. Receives the created payload.
  show: () => jsonResponse({ data: {} }),
};
let lastPayload = null;

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = String(input instanceof URL ? input.href : input);
  if (url.includes("/auth/login")) return jsonResponse({ token: "stub-token" });
  if (url.includes("/orders/create/adhoc")) {
    lastPayload = JSON.parse(init.body || "{}");
    sr.adhocCalls.push(lastPayload);
    idSeq += 1;
    return jsonResponse({ order_id: ID_BASE + idSeq, shipment_id: ID_BASE + 50 + idSeq, status: "NEW" });
  }
  if (url.includes("/orders/show/")) {
    sr.showCalls.push(url);
    return sr.show(lastPayload);
  }
  if (url.includes("/courier/assign/awb")) {
    const body = JSON.parse(init.body || "{}");
    sr.awbCalls.push(body);
    return jsonResponse({
      awb_assign_status: 1,
      response: { data: { awb_code: `AWB-${process.pid}-${body.shipment_id}`, courier_company_id: 7, courier_name: "Stub Express" } },
    });
  }
  throw new Error(`Unexpected Shiprocket call in tests: ${url}`);
};

const resetStubs = () => {
  sr.adhocCalls = [];
  sr.awbCalls = [];
  sr.showCalls = [];
  sr.show = () => jsonResponse({ data: {} });
};

/** Σ units × (selling_price − discount), in paise. */
const linesTotalPaise = (items = []) =>
  items.reduce(
    (sum, item) => sum + item.units * (Math.round(item.selling_price * 100) - Math.round(item.discount * 100)),
    0,
  );

// ── Fixtures ────────────────────────────────────────────────────────────────
const MARKER = marker("codamount");
const trash = { orders: [], products: [], users: [] };

const customer = await UserModel.create({
  name: `${MARKER} customer`,
  email: `${MARKER}@test.local`,
  password: "x".repeat(60),
  roles: ["user"],
});
trash.users.push(customer._id);
const bookA = await ProductModel.create(productFixture(`${MARKER}-a`, { weight: 0.3, length: 20, breadth: 15, height: 2 }));
const bookB = await ProductModel.create(productFixture(`${MARKER}-b`, { weight: 0.2, length: 18, breadth: 12, height: 2 }));
trash.products.push(bookA._id, bookB._id);

const item = (product, price, quantity, cancelledQuantity = 0) => ({
  product: product._id,
  name: product.name,
  image: "x.png",
  price,
  quantity,
  cancelledQuantity,
});

const makeOrder = async (fields = {}) => {
  const order = await OrderModel.create({
    user: customer._id,
    shippingAddress: addressFixture(),
    paymentMethod: "COD",
    paymentStatus: "Pending",
    orderStatus: "Confirmed",
    ...fields,
  });
  trash.orders.push(order._id);
  return order;
};

/** ₹1000 of goods, ₹100 coupon + ₹50 wallet, ₹40 shipping → ₹890 to collect. */
const discountedCodOrder = () =>
  makeOrder({
    items: [item(bookA, 300, 2), item(bookB, 400, 1)],
    subtotal: 1000,
    shippingCharge: 40,
    discount: 150,
    couponDiscount: 100,
    walletDiscount: 50,
    totalAmount: 890,
  });

const admin = () => ({ id: String(new mongoose.Types.ObjectId()), roles: ["admin"] });

const callController = async (handler, { params = {}, body = {}, user = admin() } = {}) => {
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
  await handler({ params, body, user, query: {}, headers: {}, ip: "127.0.0.1" }, res);
  return { statusCode, body: payload };
};

const createShipment = (order) =>
  callController(shippingController.CreateShipment, { params: { orderId: String(order._id) } });
const assignAwb = (order) =>
  callController(shippingController.AssignAwb, { params: { orderId: String(order._id) }, body: {} });
const acknowledge = (order, user) =>
  callController(shippingController.AcknowledgeAmountMismatch, { params: { orderId: String(order._id) }, user });
const fresh = (order) => OrderModel.findById(order._id).lean();

try {
  section("1. The payload states one unambiguous amount");
  {
    resetStubs();
    const order = await discountedCodOrder();
    sr.show = () => jsonResponse({ data: { id: 1, net_total: "890.00" } });
    const result = await createShipment(order);
    ok("the shipment is created", result.statusCode === 201, `${result.statusCode} ${result.body?.message}`);

    const payload = sr.adhocCalls[0] || {};
    ok("total_discount is 0 — the discount lives on the lines", payload.total_discount === 0, String(payload.total_discount));
    ok("sub_total is the goods net of discount", payload.sub_total === 850, String(payload.sub_total));
    ok(
      "Σ units × (selling_price − discount) == sub_total, to the paise",
      linesTotalPaise(payload.order_items) === Math.round(payload.sub_total * 100),
      `${linesTotalPaise(payload.order_items)} vs ${payload.sub_total}`,
    );
    ok(
      "sub_total + shipping_charges is what the courier collects",
      payload.sub_total + payload.shipping_charges === 890 && payload.payment_method === "COD",
      JSON.stringify({ sub: payload.sub_total, ship: payload.shipping_charges }),
    );

    section("2. A matching total is recorded as ok and does not block");
    const after = await fresh(order);
    ok(
      "the amount check reads ok, with both figures recorded",
      after.shiprocket.amountCheck?.status === "ok" &&
        after.shiprocket.amountCheck.expected === 890 &&
        after.shiprocket.amountCheck.reported === 890,
      JSON.stringify(after.shiprocket.amountCheck),
    );
    ok("Shiprocket was asked for exactly this order", sr.showCalls.length === 1 && sr.showCalls[0].endsWith(`/orders/show/${after.shiprocket.orderId}`), JSON.stringify(sr.showCalls));
    const awb = await assignAwb(order);
    ok("AWB assignment proceeds", awb.statusCode === 200 && sr.awbCalls.length === 1, `${awb.statusCode} ${awb.body?.message}`);
  }

  section("3. A mismatch blocks the AWB until it is acknowledged");
  {
    resetStubs();
    const order = await discountedCodOrder();
    // Shiprocket ignored the line discounts: it holds the undiscounted total.
    sr.show = () => jsonResponse({ data: { net_total: 1040 } });
    await createShipment(order);
    const after = await fresh(order);
    ok(
      "the check reads mismatch",
      after.shiprocket.amountCheck?.status === "mismatch" &&
        after.shiprocket.amountCheck.expected === 890 &&
        after.shiprocket.amountCheck.reported === 1040,
      JSON.stringify(after.shiprocket.amountCheck),
    );

    const blocked = await assignAwb(order);
    ok(
      "AssignAwb is refused with COD_AMOUNT_MISMATCH",
      blocked.statusCode === 409 && blocked.body?.code === "COD_AMOUNT_MISMATCH",
      `${blocked.statusCode} ${blocked.body?.code}`,
    );
    ok(
      "the refusal names both amounts",
      blocked.body?.expected === 890 && blocked.body?.reported === 1040 && /890/.test(blocked.body?.message) && /1040/.test(blocked.body?.message),
      blocked.body?.message,
    );
    ok("and no courier was assigned", sr.awbCalls.length === 0, `${sr.awbCalls.length} calls`);

    const actor = admin();
    const ack = await acknowledge(order, actor);
    const acked = await fresh(order);
    ok("an admin can acknowledge it", ack.statusCode === 200, `${ack.statusCode} ${ack.body?.message}`);
    ok(
      "the acknowledgement is recorded against the admin",
      acked.shiprocket.amountCheck?.acknowledgedAt && String(acked.shiprocket.amountCheck.acknowledgedBy) === actor.id,
      JSON.stringify(acked.shiprocket.amountCheck),
    );
    const audit = await AuditLog.findOne({ targetId: order._id, action: "ACK_COD_AMOUNT" }).lean();
    ok("and audited", audit && String(audit.admin) === actor.id, JSON.stringify(audit));

    const repeat = await acknowledge(order);
    ok(
      "acknowledging again is harmless and not re-audited",
      repeat.statusCode === 200 && (await AuditLog.countDocuments({ targetId: order._id, action: "ACK_COD_AMOUNT" })) === 1,
      `${repeat.statusCode}`,
    );

    const awb = await assignAwb(order);
    ok("after acknowledgement the AWB is assigned", awb.statusCode === 200 && sr.awbCalls.length === 1, `${awb.statusCode} ${awb.body?.message}`);
  }
  {
    resetStubs();
    const order = await discountedCodOrder();
    sr.show = () => jsonResponse({ data: { net_total: 890 } });
    await createShipment(order);
    const refused = await acknowledge(order);
    ok(
      "there is nothing to acknowledge on an order whose amount matched",
      refused.statusCode === 409 && refused.body?.code === "AMOUNT_CHECK_NOT_MISMATCH",
      `${refused.statusCode} ${refused.body?.code}`,
    );
  }
  {
    // A prepaid order collects nothing at the door, so a mismatch is recorded but does
    // not hold the parcel.
    resetStubs();
    const order = await makeOrder({
      paymentMethod: "RAZORPAY",
      paymentStatus: "Paid",
      items: [item(bookA, 300, 1)],
      subtotal: 300,
      shippingCharge: 0,
      totalAmount: 300,
    });
    sr.show = () => jsonResponse({ data: { net_total: 999 } });
    await createShipment(order);
    const after = await fresh(order);
    const awb = await assignAwb(order);
    ok(
      "a prepaid mismatch is recorded but does not block the AWB",
      after.shiprocket.amountCheck?.status === "mismatch" && awb.statusCode === 200,
      `${after.shiprocket.amountCheck?.status} ${awb.statusCode}`,
    );
  }

  section("4. An unreadable total is unverified and only warns");
  {
    resetStubs();
    const order = await discountedCodOrder();
    sr.show = () => jsonResponse({ data: { id: 1, products: [] } });
    await createShipment(order);
    const after = await fresh(order);
    ok(
      "an unrecognised response shape reads unverified, never ok",
      after.shiprocket.amountCheck?.status === "unverified" && after.shiprocket.amountCheck.reported === null,
      JSON.stringify(after.shiprocket.amountCheck),
    );
    const awb = await assignAwb(order);
    ok("AssignAwb is allowed", awb.statusCode === 200, `${awb.statusCode} ${awb.body?.code}`);
  }
  {
    resetStubs();
    const order = await discountedCodOrder();
    sr.show = () => {
      throw new Error("socket hang up");
    };
    const result = await createShipment(order);
    const after = await fresh(order);
    ok(
      "a failed read-back never fails the shipment itself",
      result.statusCode === 201 && after.shiprocket.syncStatus === "created",
      `${result.statusCode} ${after.shiprocket.syncStatus}`,
    );
    ok("and is recorded as unverified", after.shiprocket.amountCheck?.status === "unverified", JSON.stringify(after.shiprocket.amountCheck));
  }

  section("5. A partially cancelled COD order ships, and charges for, what is left");
  {
    resetStubs();
    // 3 × ₹200 + 1 × ₹100, ₹50 shipping → ₹750. One ₹200 unit cancelled before shipping.
    const order = await makeOrder({
      items: [item(bookA, 200, 3, 1), item(bookB, 100, 1)],
      subtotal: 700,
      shippingCharge: 50,
      totalAmount: 750,
      cancellations: [
        {
          product: bookA._id,
          quantity: 1,
          reason: "customer changed mind",
          refundAmount: 200,
          cancelledBy: new mongoose.Types.ObjectId(),
        },
      ],
    });
    sr.show = () => jsonResponse({ data: { net_total: "550" } });
    const result = await createShipment(order);
    const payload = sr.adhocCalls[0] || {};
    ok("the shipment is created", result.statusCode === 201, `${result.statusCode} ${result.body?.message}`);
    ok(
      "only the remaining units ship",
      payload.order_items?.length === 2 &&
        payload.order_items.find((line) => line.sku === String(bookA._id))?.units === 2 &&
        payload.order_items.find((line) => line.sku === String(bookB._id))?.units === 1,
      JSON.stringify(payload.order_items),
    );
    ok(
      "the cancelled ₹200 is not in the amount",
      payload.sub_total === 500 && payload.sub_total + payload.shipping_charges === 550,
      JSON.stringify({ sub: payload.sub_total, ship: payload.shipping_charges }),
    );
    ok(
      "the parcel is weighed for the remaining units only",
      payload.weight === 0.8,
      String(payload.weight),
    );
    const after = await fresh(order);
    ok(
      "the expected COD amount excludes the cancelled units, and matches",
      after.shiprocket.amountCheck?.expected === 550 && after.shiprocket.amountCheck.status === "ok",
      JSON.stringify(after.shiprocket.amountCheck),
    );
  }

  section("6. A figure that leaves out shipping is not a mismatch");
  // The live order that raised a false alarm: ₹429 of books + ₹99 shipping = ₹528, and
  // Shiprocket's first total field held ₹429.
  const booksPlusShipping = (fields = {}) =>
    makeOrder({
      items: [item(bookA, 429, 1)],
      subtotal: 429,
      shippingCharge: 99,
      totalAmount: 528,
      ...fields,
    });
  {
    resetStubs();
    const order = await booksPlusShipping();
    sr.show = () => jsonResponse({ data: { net_total: "429.00" } });
    await createShipment(order);
    const after = await fresh(order);
    const check = after.shiprocket.amountCheck || {};
    ok(
      "a goods-only figure on a COD order reads unverified, with the reason",
      check.status === "unverified" && check.expected === 528 && check.reported === 429 && check.reason === "goods_only_total",
      JSON.stringify(check),
    );
    ok(
      "which field it came from, and what Shiprocket sent, are recorded",
      check.matchedField === "net_total" && check.fields?.net_total === 429,
      JSON.stringify(check),
    );
    const awb = await assignAwb(order);
    ok("it does not block the AWB", awb.statusCode === 200 && sr.awbCalls.length === 1, `${awb.statusCode} ${awb.body?.code}`);
  }
  {
    resetStubs();
    const order = await booksPlusShipping();
    sr.show = () => jsonResponse({ data: { net_total: "429.00", total: "528.00" } });
    await createShipment(order);
    const check = (await fresh(order)).shiprocket.amountCheck || {};
    ok(
      "when another field holds goods + shipping, the check is ok and names that field",
      check.status === "ok" && check.reported === 528 && check.matchedField === "total",
      JSON.stringify(check),
    );
  }
  {
    resetStubs();
    const order = await booksPlusShipping();
    sr.show = () => jsonResponse({ data: { net_total: 300 } });
    await createShipment(order);
    const check = (await fresh(order)).shiprocket.amountCheck || {};
    const blocked = await assignAwb(order);
    ok(
      "a figure matching neither total still blocks a COD AWB",
      check.status === "mismatch" && blocked.statusCode === 409 && blocked.body?.code === "COD_AMOUNT_MISMATCH",
      `${check.status} ${blocked.statusCode} ${blocked.body?.code}`,
    );
  }
  {
    resetStubs();
    const order = await booksPlusShipping({ paymentMethod: "RAZORPAY", paymentStatus: "Paid" });
    sr.show = () => jsonResponse({ data: { net_total: 429 } });
    await createShipment(order);
    const check = (await fresh(order)).shiprocket.amountCheck || {};
    ok(
      "the same figure on a prepaid order is no longer recorded as a mismatch",
      check.status === "unverified" && check.reason === "goods_only_total",
      JSON.stringify(check),
    );
  }
} catch (error) {
  console.error(`\nSUITE ABORTED: ${error?.stack || error}`);
  ok("suite ran to completion", false, error?.message);
} finally {
  globalThis.fetch = realFetch;
  await AuditLog.deleteMany({ targetId: { $in: trash.orders } });
  await OrderModel.deleteMany({ _id: { $in: trash.orders } });
  await ProductModel.deleteMany({ _id: { $in: trash.products } });
  await UserModel.deleteMany({ _id: { $in: trash.users } });
  restoreCapabilities();
  const { failed } = finish();
  await mongoose.disconnect();
  process.exit(failed ? 1 : 0);
}
