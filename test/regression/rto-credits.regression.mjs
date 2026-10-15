/**
 * An RTO gives back the wallet credit and the coupon use the order spent — once.
 *
 * A parcel that came back undelivered delivered nothing, but only the cash half of a
 * prepaid RTO was ever accounted for (recordRtoRefundObligation). The wallet balance
 * the order spent and the coupon redemption it consumed were simply kept, on COD and
 * prepaid alike. A cancellation has always handed both back; releaseRtoOrderCredits
 * does the same when an order reaches "RTO Received", from either path that gets it
 * there: an admin's manual status move, or the courier feed (code 10).
 *
 * The coupon release is claimed per order through `couponReleasedAt`, shared with
 * the cancellation path, so racing paths and replays release once. And the allowance
 * checks (checkout and the customer's coupon list) no longer count Cancelled / RTO /
 * RTO Received / Closed orders as uses.
 *
 * Also covers the two other UpdateOrderStatus changes in this package: leaving NDR
 * by hand clears syncStatus "ndr", and a courier-type move notifies the customer.
 *
 * Run with `node test/regression/rto-credits.regression.mjs` (or `npm test`).
 */
process.env.SHIPROCKET_ENABLED = "true";
process.env.SHIPROCKET_WEBHOOK_ENABLED = "true";
process.env.SHIPROCKET_WEBHOOK_TOKEN = "stub-webhook-token";
process.env.SHIPROCKET_EMAIL = "stub@example.test";
process.env.SHIPROCKET_PASSWORD = "stub-password";
process.env.SHIPROCKET_BASE_URL = "https://shiprocket.invalid/v1/external";
process.env.INVENTORY_ENFORCE_STOCK = "false";
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

const { ok, section, finish } = createSuite("rto-credits");
await connect();
const restoreCapabilities = await pinShiprocketCapabilities();

const OrderModel = (await import("../../src/modules/orders/Order.model.js")).default;
const ProductModel = (await import("../../src/modules/products/Product.model.js")).default;
const CouponModel = (await import("../../src/modules/coupons/coupon.model.js")).default;
const CouponRedemption = (await import("../../src/modules/coupons/coupon-redemption.model.js")).default;
const UserProfile = (await import("../../src/modules/profiles/UserProfile.model.js")).default;
const NotificationEvent = (await import("../../src/model/NotificationEvent.model.js")).default;
await import("../../src/modules/categories/Category.model.js");
const orderController = await import("../../src/modules/orders/order.controller.js");
const { GetAvailableCoupons } = await import("../../src/modules/coupons/coupon.controller.js");
const { calculateCouponDiscount, COUPON_RELEASED_ORDER_STATUSES } = await import(
  "../../src/modules/coupons/coupon.service.js"
);
const { releaseRtoOrderCredits } = await import("../../src/modules/orders/rto-compensation.service.js");
const { applyCourierEvent } = await import("../../src/modules/shipping/courier-event.service.js");

await OrderModel.init();

const originalFetch = globalThis.fetch;
globalThis.fetch = async (input) => {
  throw new Error(`Unexpected outbound call in tests: ${String(input instanceof URL ? input.href : input)}`);
};

const MARKER = marker("rtocredits");
const COUPON_PREFIX = MARKER.toUpperCase().replace(/[^A-Z0-9]/g, "");
const SR_BASE = 880_000_000 + (process.pid % 100_000) * 100;
const trash = { orders: [], products: [], coupons: [], couponIds: [], users: [] };
let seq = 0;

const product = await ProductModel.create(productFixture(`${MARKER}-book`, { price: 500, stock: 50 }));
trash.products.push(product._id);

const admin = () => ({ id: String(new mongoose.Types.ObjectId()), roles: ["admin"] });

const callController = async (handler, { params = {}, body = {}, user, query = {} }) => {
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
  await handler({ params, body, user, query, headers: {}, get: () => undefined }, res);
  return { statusCode, body: payload };
};

/**
 * A customer with a wallet, a coupon they redeemed, and an order that spent both.
 * `priorRedemptions` models other orders that legitimately used the same coupon, so
 * a double release is visible as a count that drops by two instead of one.
 */
const makeScenario = async ({
  paymentMethod = "RAZORPAY",
  paymentStatus = "Paid",
  orderStatus = "RTO",
  priorRedemptions = 1,
  couponOverrides = {},
  // A cancelled order has no parcel; without one the cancellation does not try to
  // cancel a courier booking (which would only log against the stubbed fetch).
  withShiprocket = !["Pending", "Confirmed"].includes(orderStatus),
} = {}) => {
  seq += 1;
  const userId = new mongoose.Types.ObjectId();
  trash.users.push(userId);
  await UserProfile.create({ userid: userId, walletBalance: 0 });

  const couponId = `${COUPON_PREFIX}C${seq}`;
  const coupon = await CouponModel.create({
    couponId,
    targetType: "all",
    discountType: "fixed",
    discountValue: 50,
    startDate: new Date(Date.now() - 86_400_000),
    expireDate: new Date(Date.now() + 86_400_000),
    maxLimit: 1,
    isActive: true,
    usage: 1 + priorRedemptions,
    ...couponOverrides,
  });
  trash.coupons.push(coupon._id);
  trash.couponIds.push(couponId);
  await CouponRedemption.create({ coupon: couponId, user: userId, count: 1 + priorRedemptions });

  const srOrderId = SR_BASE + seq;
  const awbCode = `AWB-${MARKER}-${seq}`;
  const order = await OrderModel.create({
    user: userId,
    items: [{ product: product._id, name: product.name, image: "x.png", price: 500, quantity: 1 }],
    shippingAddress: addressFixture(),
    paymentMethod,
    paymentStatus,
    orderStatus,
    subtotal: 500,
    couponDiscount: 50,
    coupon: couponId,
    walletDiscount: 100,
    totalAmount: 350,
    ...(paymentMethod === "RAZORPAY" ? { razorpayPaymentId: `pay_${MARKER}_${seq}` } : {}),
    ...(withShiprocket
      ? {
          shiprocket: {
            orderId: srOrderId,
            shipmentId: srOrderId + 500,
            awbCode,
            status: "RTO IN TRANSIT",
            syncStatus: "rto",
          },
        }
      : {}),
  });
  trash.orders.push(order._id);
  return { order, userId, couponId, coupon, srOrderId, awbCode, priorRedemptions };
};

const courierRtoDelivered = (scenario) =>
  applyCourierEvent(
    {
      sourceOrderId: "",
      shiprocketOrderId: scenario.srOrderId,
      awbCode: scenario.awbCode,
      statusCode: 10,
      currentStatus: "RTO DELIVERED",
      courierName: null,
      ndrReason: "",
      rtoReason: "",
      eventAt: null,
    },
    { source: "webhook" },
  );

const adminMove = (orderId, orderStatus) =>
  callController(orderController.UpdateOrderStatus, {
    params: { orderId: String(orderId) },
    body: { orderStatus },
    user: admin(),
  });

const snapshot = async (scenario) => {
  const [order, profile, redemption, coupon] = await Promise.all([
    OrderModel.findById(scenario.order._id).lean(),
    UserProfile.findOne({ userid: scenario.userId }).lean(),
    CouponRedemption.findOne({ coupon: scenario.couponId, user: scenario.userId }).lean(),
    CouponModel.findById(scenario.coupon._id).lean(),
  ]);
  return {
    orderStatus: order.orderStatus,
    walletRefunded: Number(order.walletRefunded || 0),
    couponReleasedAt: order.couponReleasedAt,
    walletBalance: Number(profile?.walletBalance || 0),
    redemptionCount: Number(redemption?.count || 0),
    usage: Number(coupon?.usage || 0),
  };
};

/** Exactly one release: wallet back in full, counters down by exactly one. */
const assertReleasedOnce = (label, state, scenario) => {
  ok(`${label}: the order is RTO Received`, state.orderStatus === "RTO Received", state.orderStatus);
  ok(`${label}: the wallet got its 100 back`, state.walletBalance === 100, String(state.walletBalance));
  ok(`${label}: walletRefunded records it`, state.walletRefunded === 100, String(state.walletRefunded));
  ok(
    `${label}: the redemption count dropped by exactly one`,
    state.redemptionCount === scenario.priorRedemptions,
    `${state.redemptionCount} (expected ${scenario.priorRedemptions})`,
  );
  ok(
    `${label}: the coupon's total usage dropped by exactly one`,
    state.usage === scenario.priorRedemptions,
    `${state.usage} (expected ${scenario.priorRedemptions})`,
  );
  ok(`${label}: couponReleasedAt is stamped`, state.couponReleasedAt instanceof Date);
};

const couponAccepted = async (couponId, userId) => {
  try {
    await calculateCouponDiscount({
      couponId,
      userId,
      items: [{ product: String(product._id), quantity: 1 }],
      redeem: false,
    });
    return true;
  } catch {
    return false;
  }
};

const couponListed = async (couponId, userId) => {
  let payload;
  await GetAvailableCoupons(
    { user: { id: String(userId) }, query: {} },
    { status() { return this; }, json(data) { payload = data; return this; } },
  );
  return (payload?.data || []).some((coupon) => String(coupon.couponId).toUpperCase() === couponId);
};

try {
  // ═══════════════════════════════════════════════════════════════════════════
  section("the released-status list is the one the allowance checks read");

  ok(
    "COUPON_RELEASED_ORDER_STATUSES is Cancelled, RTO, RTO Received and Closed",
    JSON.stringify(COUPON_RELEASED_ORDER_STATUSES) ===
      JSON.stringify(["Cancelled", "RTO", "RTO Received", "Closed"]),
    JSON.stringify(COUPON_RELEASED_ORDER_STATUSES),
  );

  // ═══════════════════════════════════════════════════════════════════════════
  section("admin move to RTO Received — prepaid and COD");

  for (const [label, payment] of [
    ["prepaid", { paymentMethod: "RAZORPAY", paymentStatus: "Paid" }],
    ["COD", { paymentMethod: "COD", paymentStatus: "Pending" }],
  ]) {
    const scenario = await makeScenario(payment);
    const moved = await adminMove(scenario.order._id, "RTO Received");
    ok(`${label}: the move succeeds`, moved.statusCode === 200, `${moved.statusCode} ${moved.body?.message}`);
    assertReleasedOnce(`${label} (admin)`, await snapshot(scenario), scenario);
    ok(
      `${label}: the response already shows the credit`,
      Number(moved.body?.order?.walletRefunded) === 100,
      String(moved.body?.order?.walletRefunded),
    );

    // Replays: the courier event arriving late, and a direct call.
    await courierRtoDelivered(scenario);
    const again = await releaseRtoOrderCredits(scenario.order._id);
    ok(
      `${label}: a direct replay credits nothing`,
      again.walletCredited === 0 && again.couponReleased === false,
      JSON.stringify(again),
    );
    assertReleasedOnce(`${label} (after replays)`, await snapshot(scenario), scenario);

    const notified = await NotificationEvent.countDocuments({
      event: "shipment.updated",
      order: scenario.order._id,
    });
    ok(`${label}: the customer was told about the move (shipment.updated)`, notified >= 1, String(notified));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("courier event (code 10) to RTO Received — prepaid and COD");

  for (const [label, payment] of [
    ["prepaid", { paymentMethod: "RAZORPAY", paymentStatus: "Paid" }],
    ["COD", { paymentMethod: "COD", paymentStatus: "Pending" }],
  ]) {
    const scenario = await makeScenario(payment);
    await courierRtoDelivered(scenario);
    assertReleasedOnce(`${label} (courier)`, await snapshot(scenario), scenario);

    await courierRtoDelivered(scenario);
    assertReleasedOnce(`${label} (courier replay)`, await snapshot(scenario), scenario);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("the admin move racing the courier event releases once");

  for (let round = 1; round <= 3; round += 1) {
    const scenario = await makeScenario({ priorRedemptions: 2 });
    await Promise.all([
      adminMove(scenario.order._id, "RTO Received"),
      courierRtoDelivered(scenario),
      releaseRtoOrderCredits(scenario.order._id).catch(() => null),
    ]);
    assertReleasedOnce(`race round ${round}`, await snapshot(scenario), scenario);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("nothing is released for an order that is not at RTO Received");

  {
    const scenario = await makeScenario({ orderStatus: "RTO" });
    const result = await releaseRtoOrderCredits(scenario.order._id);
    ok("an order still in transit back gets nothing", result.walletCredited === 0 && !result.couponReleased,
      JSON.stringify(result));
    const state = await snapshot(scenario);
    ok("its wallet and coupon are untouched",
      state.walletBalance === 0 && state.redemptionCount === 2 && state.couponReleasedAt === null,
      JSON.stringify(state));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("a double cancellation releases the coupon once");

  {
    const scenario = await makeScenario({
      paymentMethod: "COD",
      paymentStatus: "Pending",
      orderStatus: "Confirmed",
      priorRedemptions: 2,
    });
    const cancel = () =>
      callController(orderController.CancelOrder, {
        params: { orderId: String(scenario.order._id) },
        body: { reason: "Changed my mind" },
        user: { id: String(scenario.userId), roles: [] },
      });
    const results = await Promise.all([cancel(), cancel(), cancel()]);
    const wins = results.filter((result) => result.statusCode === 200).length;
    ok("exactly one cancellation wins", wins === 1, results.map((r) => r.statusCode).join(","));
    const state = await snapshot(scenario);
    ok("the order is Cancelled", state.orderStatus === "Cancelled", state.orderStatus);
    ok("the redemption count dropped by exactly one", state.redemptionCount === 2, String(state.redemptionCount));
    ok("the coupon's usage dropped by exactly one", state.usage === 2, String(state.usage));
    ok("the wallet came back once", state.walletBalance === 100, String(state.walletBalance));
    ok("couponReleasedAt is stamped by the cancellation", state.couponReleasedAt instanceof Date);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("a coupon with maxLimit 1 is usable again after a cancel, and after an RTO");

  {
    // Cancel.
    const cancelled = await makeScenario({
      paymentMethod: "COD",
      paymentStatus: "Pending",
      orderStatus: "Confirmed",
      priorRedemptions: 0,
    });
    ok("before: the used coupon is refused at checkout",
      !(await couponAccepted(cancelled.couponId, cancelled.userId)));
    ok("before: and not offered in the list", !(await couponListed(cancelled.couponId, cancelled.userId)));
    const response = await callController(orderController.CancelOrder, {
      params: { orderId: String(cancelled.order._id) },
      body: { reason: "Changed my mind" },
      user: { id: String(cancelled.userId), roles: [] },
    });
    ok("the cancellation succeeds", response.statusCode === 200, `${response.statusCode} ${response.body?.message}`);
    ok("after a cancel: checkout accepts the coupon again",
      await couponAccepted(cancelled.couponId, cancelled.userId));
    ok("after a cancel: the coupon list offers it again — the two agree",
      await couponListed(cancelled.couponId, cancelled.userId));

    // RTO.
    const returned = await makeScenario({ priorRedemptions: 0 });
    ok("before the RTO: refused at checkout", !(await couponAccepted(returned.couponId, returned.userId)));
    await courierRtoDelivered(returned);
    ok("after an RTO: checkout accepts the coupon again",
      await couponAccepted(returned.couponId, returned.userId));
    ok("after an RTO: the coupon list offers it again",
      await couponListed(returned.couponId, returned.userId));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("a live order still spends the allowance");

  {
    const live = await makeScenario({
      paymentMethod: "COD",
      paymentStatus: "Pending",
      orderStatus: "Delivered",
      priorRedemptions: 0,
    });
    // Even with the redemption counter zeroed, a delivered order carrying the coupon
    // is a use — the order-history cross-check is what catches it.
    await CouponRedemption.updateOne({ coupon: live.couponId, user: live.userId }, { $set: { count: 0 } });
    ok("a delivered order's coupon is still refused at checkout",
      !(await couponAccepted(live.couponId, live.userId)));
    ok("and still not offered in the list", !(await couponListed(live.couponId, live.userId)));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("leaving NDR by hand clears the courier-side ndr flag");

  {
    const toOfd = await makeScenario({ orderStatus: "NDR" });
    await OrderModel.updateOne({ _id: toOfd.order._id }, { $set: { "shiprocket.syncStatus": "ndr" } });
    const moved = await adminMove(toOfd.order._id, "Out For Delivery");
    ok("NDR → Out For Delivery succeeds", moved.statusCode === 200, `${moved.statusCode} ${moved.body?.message}`);
    const afterOfd = await OrderModel.findById(toOfd.order._id).lean();
    ok("syncStatus is back to awb_assigned", afterOfd.shiprocket.syncStatus === "awb_assigned",
      afterOfd.shiprocket.syncStatus);
    ok(
      "and the customer is told (shipment.updated)",
      (await NotificationEvent.countDocuments({ event: "shipment.updated", order: toOfd.order._id })) >= 1,
    );

    const toRto = await makeScenario({ orderStatus: "NDR" });
    await OrderModel.updateOne({ _id: toRto.order._id }, { $set: { "shiprocket.syncStatus": "ndr" } });
    await adminMove(toRto.order._id, "RTO");
    const afterRto = await OrderModel.findById(toRto.order._id).lean();
    ok("NDR → RTO records syncStatus rto", afterRto.shiprocket.syncStatus === "rto", afterRto.shiprocket.syncStatus);

    const intoNdr = await makeScenario({ orderStatus: "Shipped" });
    await OrderModel.updateOne({ _id: intoNdr.order._id }, { $set: { "shiprocket.syncStatus": "awb_assigned" } });
    await adminMove(intoNdr.order._id, "NDR");
    const afterNdr = await OrderModel.findById(intoNdr.order._id).lean();
    ok("a move INTO NDR leaves syncStatus alone", afterNdr.shiprocket.syncStatus === "awb_assigned",
      afterNdr.shiprocket.syncStatus);
  }
} catch (error) {
  console.error(`\nSUITE ABORTED: ${error?.stack || error}`);
  ok("suite ran to completion", false, error?.message);
} finally {
  globalThis.fetch = originalFetch;
  restoreCapabilities();
  await OrderModel.deleteMany({ _id: { $in: trash.orders } });
  await ProductModel.deleteMany({ _id: { $in: trash.products } });
  await CouponModel.deleteMany({ _id: { $in: trash.coupons } });
  await CouponRedemption.deleteMany({ coupon: { $in: trash.couponIds } });
  await UserProfile.deleteMany({ userid: { $in: trash.users } });
  await NotificationEvent.deleteMany({ order: { $in: trash.orders } });
  const { failed } = finish();
  await mongoose.disconnect();
  process.exit(failed ? 1 : 0);
}
