/**
 * Cancellation → Shiprocket ordering (Phase 4 / audit F5).
 *
 * `cancelShiprocketOrder` used to run BEFORE the local cancellation claim. Two
 * concurrent cancellations therefore both cancelled the parcel at the courier
 * while only one could win the claim — and a winner whose transaction then failed
 * left an ACTIVE order whose shipment was already dead.
 *
 * Run with `npm run test:shipment-cancel` (or `npm test` for everything).
 *
 * ── How this tests the real boundary ────────────────────────────────────────
 * `globalThis.fetch` is stubbed, NOT the helper. So the whole path runs for real:
 * CancelOrder → the atomic claim → order-shipping.service → shiprocket.service →
 * its auth/token handling → HTTP. The stub reads the order's COMMITTED state from
 * the database at the moment the cancel request arrives, which is what proves the
 * local claim happened first rather than merely asserting call counts.
 *
 * Razorpay is stubbed separately, on the cached SDK instance, so the Phase 1/1.5
 * refund path is exercised without contacting a gateway.
 */
process.env.SHIPROCKET_ENABLED = "true";
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

const { ok, section, finish } = createSuite("shipment-cancel");
await connect();
// Pinned so this suite does not depend on the store's own Shiprocket configuration or on
// whether real credentials happen to be saved: it asserts that a cancellation reaches the
// courier, which an admin choosing manual fulfilment would correctly prevent.
const restoreCapabilities = await pinShiprocketCapabilities();

const OrderModel = (await import("../../src/modules/orders/Order.model.js")).default;
const ProductModel = (await import("../../src/modules/products/Product.model.js")).default;
const CouponModel = (await import("../../src/modules/coupons/coupon.model.js")).default;
const CouponRedemption = (await import("../../src/modules/coupons/coupon-redemption.model.js")).default;
const UserProfile = (await import("../../src/modules/profiles/UserProfile.model.js")).default;
const ShiprocketSetting = (await import("../../src/modules/shipping/ShiprocketSetting.model.js")).default;
await import("../../src/modules/categories/Category.model.js");
const orderController = await import("../../src/modules/orders/order.controller.js");
const { SHIPMENT_CANCELLATION_PENDING } = await import(
  "../../src/modules/orders/order-shipping.service.js"
);
const { sumRefunded } = await import("../../src/modules/payments/return-refund.service.js");
const razorpayService = await import("../../src/modules/payments/razorpay.service.js");

// ── Razorpay stub (cached instance, as in the refund suites) ────────────────
const razorpayCalls = { refund: [] };
const { razorpay: sharedRazorpay } = razorpayService.getRazorpay();
let razorpayRefundSeq = 0;
sharedRazorpay.payments.refund = async (paymentId, options) => {
  razorpayCalls.refund.push({ paymentId, options });
  return { id: `rfnd_stub_${++razorpayRefundSeq}`, status: "processed" };
};
sharedRazorpay.payments.fetchMultipleRefund = async () => ({ items: [] });

// ── Shiprocket stub, at the HTTP boundary ──────────────────────────────────
const shiprocket = {
  cancelCalls: [],
  // Snapshot of the order as the DATABASE sees it when /orders/cancel arrives.
  // This is the ordering proof.
  stateAtCancel: [],
  behaviour: "success",
};

const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = String(input instanceof URL ? input.href : input);

  if (url.includes("/auth/login")) {
    return jsonResponse({ token: "stub-token" });
  }

  if (url.includes("/orders/cancel")) {
    const ids = JSON.parse(init.body || "{}").ids || [];
    shiprocket.cancelCalls.push({ ids });

    // Read the committed state of the order this shipment belongs to.
    const order = await OrderModel.findOne({ "shiprocket.orderId": ids[0] }).lean();
    shiprocket.stateAtCancel.push({
      shiprocketOrderId: ids[0],
      orderStatus: order?.orderStatus ?? null,
      paymentStatus: order?.paymentStatus ?? null,
      refundRows: (order?.refunds || []).length,
      cancellationRecorded: Boolean(order?.cancellation?.cancelledAt),
    });

    if (shiprocket.behaviour === "timeout") {
      throw new Error("The operation was aborted due to timeout");
    }
    if (shiprocket.behaviour === "unavailable") {
      return jsonResponse({ message: "Service Unavailable" }, 503);
    }
    if (shiprocket.behaviour === "already_cancelled") {
      // Shiprocket answers 200 with a logical error for this case.
      return jsonResponse({ status: 400, message: "Order already cancelled." });
    }
    return jsonResponse({ status: 200, message: "Order cancelled successfully" });
  }

  throw new Error(`Unexpected Shiprocket call in tests: ${url}`);
};

const resetStubs = (behaviour = "success") => {
  shiprocket.cancelCalls = [];
  shiprocket.stateAtCancel = [];
  shiprocket.behaviour = behaviour;
  razorpayCalls.refund = [];
};

const MARKER = marker("shipcancel");
const trash = { orders: [], products: [], coupons: [], profiles: [] };
let seq = 0;

const makeProduct = async (label, stock = 20) => {
  const product = await ProductModel.create(productFixture(`${MARKER}-${label}`, { stock }));
  trash.products.push(product._id);
  return product;
};

/** An order eligible for cancellation, optionally with a live shipment. */
const makeOrder = async ({
  product,
  quantity = 2,
  withShipment = true,
  paymentMethod = "RAZORPAY",
  paymentStatus = "Paid",
  userId = new mongoose.Types.ObjectId(),
  ...fields
} = {}) => {
  seq += 1;
  const subtotal = product.price * quantity;
  const order = await OrderModel.create({
    user: userId,
    items: [
      {
        product: product._id,
        name: product.name,
        image: "x.png",
        price: product.price,
        quantity,
      },
    ],
    shippingAddress: addressFixture(),
    paymentMethod,
    paymentStatus,
    orderStatus: "Confirmed",
    subtotal,
    totalAmount: subtotal,
    ...(paymentMethod === "RAZORPAY" ? { razorpayPaymentId: `pay_${MARKER}_${seq}` } : {}),
    ...(withShipment
      ? {
          shiprocket: {
            orderId: 900000 + seq,
            shipmentId: 800000 + seq,
            awbCode: null,
            status: "NEW",
            syncStatus: "created",
            lastSyncedAt: new Date(),
          },
        }
      : {}),
    ...fields,
  });
  trash.orders.push(order._id);
  return order;
};

const callController = async (handler, { params = {}, body = {}, user }) => {
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
  await handler({ params, body, user, query: {} }, res);
  return { statusCode, body: payload };
};

const cancel = (order, userId) =>
  callController(orderController.CancelOrder, {
    params: { orderId: String(order._id) },
    body: { reason: "Ordered by mistake" },
    user: { id: String(userId || order.user), roles: [] },
  });

const isPending = async (orderId) =>
  Boolean(
    await OrderModel.findOne({ _id: orderId, ...SHIPMENT_CANCELLATION_PENDING }).lean(),
  );

try {
  // Ensure the settings doc exists so credentials resolve from env.
  await ShiprocketSetting.getSettings();

  // ═══════════════════════════════════════════════════════════════════════════
  section("ordering — the local claim happens BEFORE Shiprocket is told");

  {
    resetStubs("success");
    const product = await makeProduct("order", 20);
    const order = await makeOrder({ product });

    const response = await cancel(order);
    ok("the cancellation succeeds", response.statusCode === 200, String(response.statusCode));
    ok("Shiprocket was called once", shiprocket.cancelCalls.length === 1, `${shiprocket.cancelCalls.length}x`);

    const snapshot = shiprocket.stateAtCancel[0];
    ok(
      "the order was ALREADY Cancelled in the database when Shiprocket was called",
      snapshot?.orderStatus === "Cancelled",
      `orderStatus was ${snapshot?.orderStatus}`,
    );
    ok(
      "the cancellation record was already committed too",
      snapshot?.cancellationRecorded === true,
      JSON.stringify(snapshot),
    );
    ok(
      "and the refund liability already existed",
      snapshot?.refundRows === 1,
      `${snapshot?.refundRows} refund rows`,
    );

    const fresh = await OrderModel.findById(order._id);
    ok("syncStatus is cancelled after confirmation", fresh.shiprocket.syncStatus === "cancelled", fresh.shiprocket.syncStatus);
    ok("shipment status reads CANCELLED", fresh.shiprocket.status === "CANCELLED", fresh.shiprocket.status);
    ok("no pending cancellation remains", (await isPending(order._id)) === false);
    ok("the response reports the shipment cancelled", response.body?.shipmentCancelled === true);
  }

  section("1/2 — concurrent cancellation: one claim, one courier call");

  {
    resetStubs("success");
    const product = await makeProduct("concurrent", 20);
    const order = await makeOrder({ product });

    const [a, b] = await Promise.all([cancel(order), cancel(order)]);
    const statuses = [a.statusCode, b.statusCode].sort();

    ok("exactly one request succeeds", statuses[0] === 200 && statuses[1] === 409, JSON.stringify(statuses));
    ok(
      "the loser is refused with 409",
      [a, b].some((r) => r.statusCode === 409),
      JSON.stringify(statuses),
    );
    ok(
      "Shiprocket is called EXACTLY ONCE — the loser never calls it",
      shiprocket.cancelCalls.length === 1,
      `${shiprocket.cancelCalls.length} calls`,
    );

    const fresh = await OrderModel.findById(order._id);
    ok("the order is cancelled once", fresh.orderStatus === "Cancelled", fresh.orderStatus);
    ok(
      "exactly one refund liability was recorded",
      fresh.refunds.length === 1,
      `${fresh.refunds.length} rows`,
    );
    ok(
      "stock was restored once, not twice",
      (await ProductModel.findById(product._id)).stock === 22,
      String((await ProductModel.findById(product._id)).stock),
    );
    ok(
      "one Cancelled entry in statusHistory",
      fresh.statusHistory.filter((entry) => entry.to === "Cancelled").length === 1,
      JSON.stringify(fresh.statusHistory.map((e) => e.to)),
    );
  }

  {
    // Five at once, to be sure the winner is decided by the database.
    resetStubs("success");
    const product = await makeProduct("concurrent5", 20);
    const order = await makeOrder({ product });

    const results = await Promise.all(Array.from({ length: 5 }, () => cancel(order)));
    ok(
      "one of five wins",
      results.filter((r) => r.statusCode === 200).length === 1,
      JSON.stringify(results.map((r) => r.statusCode)),
    );
    ok(
      "still exactly one Shiprocket call",
      shiprocket.cancelCalls.length === 1,
      `${shiprocket.cancelCalls.length} calls`,
    );
  }

  section("3/6 — Shiprocket timeout and unavailability");

  {
    resetStubs("timeout");
    const product = await makeProduct("timeout", 20);
    const coupon = await CouponModel.create({
      couponId: `${MARKER}-TIMEOUT`.toUpperCase(),
      discountType: "fixed",
      discountValue: 50,
      isActive: true,
      startDate: new Date(Date.now() - 86400000),
      expireDate: new Date(Date.now() + 86400000),
      usage: 1,
    });
    trash.coupons.push(coupon._id);

    const userId = new mongoose.Types.ObjectId();
    const profile = await UserProfile.create({ userid: userId, walletBalance: 0 });
    trash.profiles.push(profile._id);
    // Per-customer redemptions live in their own collection now, so the fixture
    // seeds the row directly instead of patching an array on the coupon.
    await CouponRedemption.create({ coupon: coupon.couponId, user: userId, count: 1 });

    const order = await makeOrder({
      product,
      userId,
      coupon: coupon.couponId,
      couponDiscount: 50,
      walletDiscount: 30,
    });

    const response = await cancel(order, userId);

    ok("the cancellation still SUCCEEDS despite the timeout", response.statusCode === 200, String(response.statusCode));
    ok("Shiprocket was attempted", shiprocket.cancelCalls.length === 1, `${shiprocket.cancelCalls.length}x`);
    ok(
      "the response flags the shipment cancellation as pending",
      response.body?.shipmentCancellationPending === true,
      JSON.stringify({
        cancelled: response.body?.shipmentCancelled,
        pending: response.body?.shipmentCancellationPending,
      }),
    );

    const fresh = await OrderModel.findById(order._id);
    ok("the order is Cancelled locally", fresh.orderStatus === "Cancelled", fresh.orderStatus);
    ok(
      "syncStatus is NOT falsely marked cancelled",
      fresh.shiprocket.syncStatus !== "cancelled",
      fresh.shiprocket.syncStatus,
    );
    ok(
      "the real fulfilment state is preserved, not overwritten with 'failed'",
      fresh.shiprocket.syncStatus === "created",
      fresh.shiprocket.syncStatus,
    );
    ok("the failure reason is recorded", /Cancellation failed/i.test(fresh.shiprocket.lastError || ""), fresh.shiprocket.lastError);
    ok("the pending state is derivable", (await isPending(order._id)) === true);

    // Requirement 6: nothing else is corrupted.
    ok("stock was restored", (await ProductModel.findById(product._id)).stock === 22, String((await ProductModel.findById(product._id)).stock));
    const freshCoupon = await CouponModel.findById(coupon._id);
    const freshRedemption = await CouponRedemption.findOne({ coupon: coupon.couponId, user: userId });
    ok("coupon usage was released", freshRedemption.count === 0, String(freshRedemption.count));
    ok("coupon total usage decremented", freshCoupon.usage === 0, String(freshCoupon.usage));
    ok(
      "wallet credit was returned",
      (await UserProfile.findById(profile._id)).walletBalance === 30,
      String((await UserProfile.findById(profile._id)).walletBalance),
    );
    ok(
      "the refund ledger is intact and within the ceiling",
      fresh.refunds.length === 1 && sumRefunded(fresh) <= fresh.totalAmount + 0.01,
      `${fresh.refunds.length} rows, ${sumRefunded(fresh)} of ${fresh.totalAmount}`,
    );
    ok(
      "the refund still carries its Phase 1.5 idempotency key",
      fresh.refunds[0].idempotencyKey === `cancel:${order._id}`,
      fresh.refunds[0].idempotencyKey,
    );
  }

  {
    resetStubs("unavailable");
    const product = await makeProduct("unavailable", 20);
    const order = await makeOrder({ product });
    const response = await cancel(order);

    ok("a 503 from Shiprocket does not fail the cancellation", response.statusCode === 200, String(response.statusCode));
    const fresh = await OrderModel.findById(order._id);
    ok("the order is Cancelled", fresh.orderStatus === "Cancelled", fresh.orderStatus);
    ok("the shipment cancellation is pending", (await isPending(order._id)) === true);
    ok("stock restored exactly once", (await ProductModel.findById(product._id)).stock === 22);
  }

  section("4/5 — retry, and a lost response");

  {
    // Timeout first, then a successful retry through the admin endpoint.
    resetStubs("timeout");
    const product = await makeProduct("retry", 20);
    const order = await makeOrder({ product });
    await cancel(order);
    ok("pending after the timeout", (await isPending(order._id)) === true);

    resetStubs("success");
    const retry = await callController(orderController.RetryShipmentCancellation, {
      params: { orderId: String(order._id) },
      user: { id: String(new mongoose.Types.ObjectId()), roles: ["admin"] },
    });
    ok("the retry succeeds", retry.statusCode === 200, `${retry.statusCode} ${retry.body?.message || ""}`);
    ok("it called Shiprocket once", shiprocket.cancelCalls.length === 1, `${shiprocket.cancelCalls.length}x`);
    ok("the shipment is now cancelled", (await isPending(order._id)) === false);
    const fresh = await OrderModel.findById(order._id);
    ok("syncStatus is cancelled", fresh.shiprocket.syncStatus === "cancelled", fresh.shiprocket.syncStatus);
    ok("lastError was cleared", !fresh.shiprocket.lastError, fresh.shiprocket.lastError);
  }

  {
    // The response was LOST: the first attempt actually cancelled at Shiprocket,
    // but we recorded a timeout. The retry must adopt, not create a problem.
    resetStubs("timeout");
    const product = await makeProduct("lostresponse", 20);
    const order = await makeOrder({ product });
    await cancel(order);

    resetStubs("already_cancelled");
    const retry = await callController(orderController.RetryShipmentCancellation, {
      params: { orderId: String(order._id) },
      user: { id: String(new mongoose.Types.ObjectId()), roles: ["admin"] },
    });
    ok("the retry succeeds by adopting the existing cancellation", retry.statusCode === 200, String(retry.statusCode));
    ok("it is reported as adopted", retry.body?.adopted === true, JSON.stringify(retry.body?.adopted));
    ok("the pending state clears", (await isPending(order._id)) === false);
    const fresh = await OrderModel.findById(order._id);
    ok("syncStatus is cancelled", fresh.shiprocket.syncStatus === "cancelled", fresh.shiprocket.syncStatus);
    ok(
      "no money moved as a side effect of the retry",
      razorpayCalls.refund.length === 0,
      `${razorpayCalls.refund.length} refund calls`,
    );
  }

  {
    // A retry on an order that is NOT cancelled locally must be refused — that
    // inversion is the whole bug this phase removed.
    resetStubs("success");
    const product = await makeProduct("guard", 20);
    const live = await makeOrder({ product });
    const refused = await callController(orderController.RetryShipmentCancellation, {
      params: { orderId: String(live._id) },
      user: { id: String(new mongoose.Types.ObjectId()), roles: ["admin"] },
    });
    ok("retrying on a live order is refused", refused.statusCode === 409, String(refused.statusCode));
    ok("with ORDER_NOT_CANCELLED", refused.body?.code === "ORDER_NOT_CANCELLED", refused.body?.code);
    ok("and Shiprocket was never called", shiprocket.cancelCalls.length === 0, `${shiprocket.cancelCalls.length}x`);
    ok(
      "the order is still Confirmed",
      (await OrderModel.findById(live._id)).orderStatus === "Confirmed",
    );
  }

  {
    // An already-cancelled shipment short-circuits without a courier call.
    resetStubs("success");
    const product = await makeProduct("noop", 20);
    const order = await makeOrder({ product });
    await cancel(order);
    resetStubs("success");
    const again = await callController(orderController.RetryShipmentCancellation, {
      params: { orderId: String(order._id) },
      user: { id: String(new mongoose.Types.ObjectId()), roles: ["admin"] },
    });
    ok("retrying an already-cancelled shipment succeeds", again.statusCode === 200, String(again.statusCode));
    ok("without calling Shiprocket again", shiprocket.cancelCalls.length === 0, `${shiprocket.cancelCalls.length}x`);
  }

  section("orders with no shipment");

  {
    resetStubs("success");
    const product = await makeProduct("noship", 20);
    const order = await makeOrder({ product, withShipment: false });
    const response = await cancel(order);
    ok("cancellation succeeds", response.statusCode === 200, String(response.statusCode));
    ok("Shiprocket is not called at all", shiprocket.cancelCalls.length === 0, `${shiprocket.cancelCalls.length}x`);
    ok("nothing is reported as pending", response.body?.shipmentCancellationPending === false);
    ok("and it is not in the pending query", (await isPending(order._id)) === false);
  }

  section("7 — COD");

  {
    resetStubs("success");
    const product = await makeProduct("cod", 20);
    const order = await makeOrder({
      product,
      paymentMethod: "COD",
      paymentStatus: "Pending",
    });
    const response = await cancel(order);

    ok("a COD cancellation succeeds", response.statusCode === 200, String(response.statusCode));
    ok("the shipment is still cancelled", shiprocket.cancelCalls.length === 1, `${shiprocket.cancelCalls.length}x`);

    const fresh = await OrderModel.findById(order._id);
    ok("the order is Cancelled", fresh.orderStatus === "Cancelled", fresh.orderStatus);
    ok(
      "NO refund liability for an unpaid COD order",
      fresh.refunds.length === 0,
      `${fresh.refunds.length} refund rows`,
    );
    ok("paymentStatus stays Pending", fresh.paymentStatus === "Pending", fresh.paymentStatus);
    ok("and no Razorpay refund was issued", razorpayCalls.refund.length === 0, `${razorpayCalls.refund.length}x`);
    ok("stock was restored", (await ProductModel.findById(product._id)).stock === 22);
  }

  section("8 — Razorpay uses the existing refund safety");

  {
    resetStubs("success");
    const product = await makeProduct("razorpay", 20);
    const order = await makeOrder({ product });
    const response = await cancel(order);

    ok("cancellation succeeds", response.statusCode === 200, String(response.statusCode));
    ok("exactly one gateway refund", razorpayCalls.refund.length === 1, `${razorpayCalls.refund.length}x`);
    ok(
      "it carries notes.refundKey for reconciliation",
      razorpayCalls.refund[0]?.options?.notes?.refundKey === `cancel:${order._id}`,
      JSON.stringify(razorpayCalls.refund[0]?.options?.notes),
    );

    const fresh = await OrderModel.findById(order._id);
    ok("the refund row is processed", fresh.refunds[0].status === "processed", fresh.refunds[0].status);
    ok("providerRefundId is recorded", Boolean(fresh.refunds[0].providerRefundId));
    ok(
      "the ledger keeps its idempotency key",
      fresh.refunds[0].idempotencyKey === `cancel:${order._id}`,
      fresh.refunds[0].idempotencyKey,
    );
    ok(
      "paymentStatus is derived as Refunded",
      fresh.paymentStatus === "Refunded",
      fresh.paymentStatus,
    );
    ok(
      "cumulative refunds respect the ceiling",
      sumRefunded(fresh) <= fresh.totalAmount + 0.01,
      `${sumRefunded(fresh)} of ${fresh.totalAmount}`,
    );
  }

  {
    // Concurrent cancellation on a PAID order must still refund only once.
    resetStubs("success");
    const product = await makeProduct("razorpay-race", 20);
    const order = await makeOrder({ product });
    await Promise.all([cancel(order), cancel(order), cancel(order)]);

    ok("only one gateway refund from three concurrent cancels", razorpayCalls.refund.length === 1, `${razorpayCalls.refund.length}x`);
    ok("only one Shiprocket cancellation", shiprocket.cancelCalls.length === 1, `${shiprocket.cancelCalls.length}x`);
    const fresh = await OrderModel.findById(order._id);
    ok("one refund row", fresh.refunds.length === 1, `${fresh.refunds.length}`);
    ok("never over-refunded", sumRefunded(fresh) <= fresh.totalAmount + 0.01, String(sumRefunded(fresh)));
  }

  section("9 — partial cancellation does not touch Shiprocket");

  {
    resetStubs("success");
    const product = await makeProduct("partial", 20);
    const order = await makeOrder({ product, quantity: 3 });

    const response = await callController(orderController.PartialCancelOrder, {
      params: { orderId: String(order._id) },
      body: { productId: String(product._id), quantity: 1, reason: "One damaged" },
      user: { id: String(new mongoose.Types.ObjectId()), roles: ["admin"] },
    });

    ok("the partial cancellation succeeds", response.statusCode === 200, `${response.statusCode} ${response.body?.message || ""}`);
    ok(
      "Shiprocket is NOT called — a part-cancel cannot be expressed to the courier",
      shiprocket.cancelCalls.length === 0,
      `${shiprocket.cancelCalls.length}x`,
    );

    const fresh = await OrderModel.findById(order._id);
    ok("the order stays live", fresh.orderStatus === "Confirmed", fresh.orderStatus);
    ok("one unit was cancelled", fresh.items[0].cancelledQuantity === 1, String(fresh.items[0].cancelledQuantity));
    ok(
      "the shipment is untouched and NOT flagged pending",
      fresh.shiprocket.syncStatus === "created" && (await isPending(order._id)) === false,
      fresh.shiprocket.syncStatus,
    );
    ok(
      "a partial refund liability was recorded",
      fresh.refunds.length === 1,
      `${fresh.refunds.length} rows`,
    );
    ok("stock for the cancelled unit was restored", (await ProductModel.findById(product._id)).stock === 21, String((await ProductModel.findById(product._id)).stock));
  }

  {
    // Cancelling every remaining unit flips the order to Cancelled — and still
    // does not tell the courier, which is the documented limitation.
    resetStubs("success");
    const product = await makeProduct("partial-all", 20);
    const order = await makeOrder({ product, quantity: 1 });
    await callController(orderController.PartialCancelOrder, {
      params: { orderId: String(order._id) },
      body: { productId: String(product._id), quantity: 1, reason: "All damaged" },
      user: { id: String(new mongoose.Types.ObjectId()), roles: ["admin"] },
    });

    const fresh = await OrderModel.findById(order._id);
    ok(
      "a fully partial-cancelled order becomes Cancelled",
      fresh.orderStatus === "Cancelled",
      fresh.orderStatus,
    );
    // Phase 4.1 closed this gap: emptying the order via partial cancellation now
    // reaches the courier, using the same helper and the same ordering as
    // CancelOrder. It used to be left pending for an operator to chase.
    ok(
      "the courier IS told once the order is fully cancelled",
      shiprocket.cancelCalls.length === 1,
      `${shiprocket.cancelCalls.length}x`,
    );
    ok(
      "so nothing is left pending",
      (await isPending(order._id)) === false,
    );
  }
} catch (error) {
  console.error(`\nSUITE ABORTED: ${error?.stack || error}`);
  ok("suite ran to completion", false, error?.message);
} finally {
  globalThis.fetch = originalFetch;
  await OrderModel.deleteMany({ _id: { $in: trash.orders } });
  await ProductModel.deleteMany({ _id: { $in: trash.products } });
  await CouponModel.deleteMany({ _id: { $in: trash.coupons } });
  await CouponRedemption.deleteMany({ coupon: new RegExp(MARKER, "i") });
  await UserProfile.deleteMany({ _id: { $in: trash.profiles } });
  restoreCapabilities();
  const { failed } = finish();
  await mongoose.disconnect();
  process.exit(failed ? 1 : 0);
}
