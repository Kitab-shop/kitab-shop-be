/**
 * Admin approval of orders (ORDER_MANUAL_CONFIRMATION_ENABLED) and bulk confirmation.
 *
 * Proves, against the real database and the real handlers:
 *
 *   - flag OFF: COD and captured prepaid orders still confirm themselves, as before;
 *   - flag ON: both stop at Pending — COD at Pending/Pending, prepaid at Pending/Paid —
 *     with the payment side settled and no status move recorded;
 *   - a single confirmation (UpdateOrderStatus) stamps confirmedAt; an unpaid
 *     prepaid checkout is still refused;
 *   - bulk confirmation validates every order on its own: duplicates collapse,
 *     already-confirmed, cancelled, unpaid and missing orders are reported, not
 *     confirmed, and payment statuses are untouched;
 *   - a bulk confirm racing a single confirm produces one confirmation;
 *   - "confirm all matching filters" reaches exactly the confirmable orders in the
 *     date range, and nothing when the status filter excludes Pending;
 *   - cancelling a paid order that is still awaiting approval takes the paid
 *     cancellation path (stock back, refund owed), not the unpaid-checkout one.
 *
 * Every fixture that the "filtered" scope could reach is dated in 2001, and every
 * filtered call is bounded to that range, so the suite can never confirm a real
 * order sitting in a developer's database.
 *
 * Run with `npm run test:manual-confirmation` (or `npm test` for everything).
 */
process.env.SHIPROCKET_ENABLED = "false";
process.env.SHIPROCKET_WEBHOOK_ENABLED = "false";
process.env.PAYMENTS_ENABLED = "false";
process.env.INVENTORY_ENFORCE_STOCK = "true";
process.env.INVENTORY_RESERVE_DURING_PAYMENT = "false";
process.env.NOTIFICATIONS_ENABLED = "false";
process.env.ORDER_MANUAL_CONFIRMATION_ENABLED = "false";

import mongoose from "mongoose";
import { addressFixture, connect, createSuite, marker, productFixture } from "./helpers.mjs";

const { ok, section, finish } = createSuite("manual-confirmation");
await connect();

const OrderModel = (await import("../../src/modules/orders/Order.model.js")).default;
const ProductModel = (await import("../../src/modules/products/Product.model.js")).default;
const PaymentIntent = (await import("../../src/modules/payments/PaymentIntent.model.js")).default;
const CheckoutSetting = (await import("../../src/modules/orders/CheckoutSetting.model.js")).default;
const CodVerification = (await import("../../src/modules/orders/CodVerification.model.js")).default;
await import("../../src/modules/categories/Category.model.js");
const orderController = await import("../../src/modules/orders/order.controller.js");
const { BulkConfirmOrders } = await import("../../src/modules/orders/order-confirmation.controller.js");
const { countConfirmableOrders } = await import("../../src/modules/orders/order-confirmation.service.js");
const { completeCapturedIntent } = await import("../../src/modules/payments/payment-order.service.js");
const { bulkConfirmOrdersSchema } = await import("../../src/modules/orders/order.schema.js");

await OrderModel.init();

const MARKER = marker("manualconfirm");
const trash = { orders: [], products: [], intents: [], verifications: [] };
let seq = 0;

const realFetch = globalThis.fetch;
globalThis.fetch = async (input) => {
  throw new Error(`Unexpected network call: ${String(input instanceof URL ? input.href : input)}`);
};
const realCheckoutGetSettings = CheckoutSetting.getSettings;
CheckoutSetting.getSettings = async () => ({
  codEnabled: true,
  codServiceabilityCheckEnabled: false,
  codMinOrderAmount: 0,
  codMaxOrderAmount: 0,
  cancellationWindowHours: 0,
});

const setManual = (on) => {
  process.env.ORDER_MANUAL_CONFIRMATION_ENABLED = on ? "true" : "false";
};

const makeProduct = async (stock = 50) => {
  const product = await ProductModel.create(productFixture(`${MARKER}-${(seq += 1)}`, { stock }));
  trash.products.push(product._id);
  return product;
};

const makeOrder = async ({
  orderStatus = "Pending",
  paymentMethod = "COD",
  paymentStatus = "Pending",
  createdAt = null,
  ...fields
} = {}) => {
  const product = await makeProduct();
  seq += 1;
  const order = await OrderModel.create({
    user: new mongoose.Types.ObjectId(),
    items: [
      { product: product._id, name: product.name, image: "x.png", price: product.price, quantity: 1 },
    ],
    shippingAddress: addressFixture(),
    paymentMethod,
    paymentStatus,
    orderStatus,
    subtotal: product.price,
    totalAmount: product.price,
    ...(paymentMethod === "RAZORPAY" && paymentStatus === "Paid"
      ? { razorpayPaymentId: `pay_${MARKER}_${seq}` }
      : {}),
    ...fields,
  });
  trash.orders.push(order._id);
  if (createdAt) await OrderModel.collection.updateOne({ _id: order._id }, { $set: { createdAt } });
  return order;
};

const callController = async (handler, { params = {}, body = {}, user, query = {} }) => {
  let statusCode = 200;
  let payload;
  const res = {
    status(code) { statusCode = code; return this; },
    json(data) { payload = data; return this; },
  };
  await handler({ params, body, user, query, headers: {} }, res);
  return { statusCode, body: payload };
};

const admin = () => ({ id: String(new mongoose.Types.ObjectId()), roles: ["admin"] });

const placeCodOrder = async () => {
  const product = await makeProduct();
  const userId = new mongoose.Types.ObjectId();
  const verification = await CodVerification.create({
    userId,
    email: `${MARKER}-${seq}@example.test`,
    channel: "email",
    otpHash: "stub-hash-not-used-by-placeorder",
    isVerified: true,
    verifiedAt: new Date(),
  });
  trash.verifications.push(verification._id);
  seq += 1;
  const result = await callController(orderController.PlaceOrder, {
    user: { id: String(userId), roles: [] },
    body: {
      items: [{ product: String(product._id), quantity: 1 }],
      shippingAddress: addressFixture(),
      paymentMethod: "cod",
      idempotencyKey: `${MARKER}-key-${seq}-aaaaaaaaaaaaaaaa`,
    },
  });
  if (result.body?.order?._id) trash.orders.push(result.body.order._id);
  return result;
};

/** An order-first pending row plus its intent, as CreateRazorpayOrder builds them. */
const capturePrepaid = async () => {
  const product = await makeProduct();
  seq += 1;
  const userId = new mongoose.Types.ObjectId();
  const items = [
    { product: product._id, name: product.name, image: "x.png", price: product.price, quantity: 1 },
  ];
  const razorpayOrderId = `order_${MARKER}_${seq}`;
  const pendingOrder = await OrderModel.create({
    user: userId,
    items,
    shippingAddress: addressFixture(),
    paymentMethod: "RAZORPAY",
    paymentStatus: "Pending",
    orderStatus: "Pending",
    subtotal: product.price,
    totalAmount: product.price,
    razorpayOrderId,
    paymentExpiresAt: new Date(Date.now() + 20 * 60 * 1000),
  });
  trash.orders.push(pendingOrder._id);
  const intent = await PaymentIntent.create({
    user: userId,
    razorpayOrderId,
    amount: product.price * 100,
    currency: "INR",
    items,
    shippingAddress: addressFixture(),
    subtotal: product.price,
    totalAmount: product.price,
    pendingOrder: pendingOrder._id,
  });
  trash.intents.push(intent._id);
  const order = await completeCapturedIntent({
    intent,
    capturedPayment: { id: `pay_${MARKER}_${seq}`, amount: product.price * 100 },
  });
  return { order, product };
};

const bulk = (body, user = admin()) => callController(BulkConfirmOrders, { body, user });

try {
  section("1 — flag off: orders confirm themselves, as before");
  {
    setManual(false);
    const placed = await placeCodOrder();
    ok("COD order is placed", placed.statusCode === 201, JSON.stringify(placed.body?.message));
    const cod = await OrderModel.findById(placed.body?.order?._id).lean();
    ok("COD order is Confirmed at placement", cod?.orderStatus === "Confirmed", cod?.orderStatus);
    ok("COD order records confirmedAt", cod?.confirmedAt instanceof Date);

    const { order: prepaid } = await capturePrepaid();
    ok(
      "captured prepaid order is Confirmed/Paid",
      prepaid.orderStatus === "Confirmed" && prepaid.paymentStatus === "Paid",
      `${prepaid.orderStatus}/${prepaid.paymentStatus}`,
    );
    ok("captured prepaid order records confirmedAt", prepaid.confirmedAt instanceof Date);
    ok(
      "its history records the Pending → Confirmed move",
      prepaid.statusHistory.some((entry) => entry.from === "Pending" && entry.to === "Confirmed"),
    );
  }

  section("2 — flag on: COD and prepaid both wait for an admin");
  let heldCod;
  let heldPrepaid;
  {
    setManual(true);
    const placed = await placeCodOrder();
    ok("COD order is placed", placed.statusCode === 201, JSON.stringify(placed.body?.message));
    heldCod = await OrderModel.findById(placed.body?.order?._id).lean();
    ok(
      "COD order is held at Pending/Pending",
      heldCod?.orderStatus === "Pending" && heldCod?.paymentStatus === "Pending",
      `${heldCod?.orderStatus}/${heldCod?.paymentStatus}`,
    );
    ok("COD order has no confirmedAt yet", heldCod?.confirmedAt === null);

    const captured = await capturePrepaid();
    heldPrepaid = captured.order;
    ok(
      "captured prepaid order is held at Pending but its payment is Paid",
      heldPrepaid.orderStatus === "Pending" && heldPrepaid.paymentStatus === "Paid",
      `${heldPrepaid.orderStatus}/${heldPrepaid.paymentStatus}`,
    );
    ok("its payment expiry is cleared, so the sweeper cannot cancel it", heldPrepaid.paymentExpiresAt === null);
    ok("no status move is recorded for it", heldPrepaid.statusHistory.length === 0);
    ok("it has no confirmedAt yet", heldPrepaid.confirmedAt === null);

    const list = await callController(orderController.GetAllOrders, {
      user: admin(),
      query: { status: "Pending", limit: "1000" },
    });
    const ids = (list.body?.orders || []).map((order) => String(order._id));
    ok(
      "both appear in the admin Pending list (neither is hidden as awaiting payment)",
      ids.includes(String(heldCod._id)) && ids.includes(String(heldPrepaid._id)),
    );
    ok("the list reports that manual confirmation is on", list.body?.manualConfirmation === true);
    ok("the list reports a confirmable count", Number(list.body?.confirmableTotal) >= 2);
  }

  section("3 — single confirmation through UpdateOrderStatus");
  {
    const response = await callController(orderController.UpdateOrderStatus, {
      params: { orderId: String(heldCod._id) },
      body: { orderStatus: "Confirmed" },
      user: admin(),
    });
    ok("Pending → Confirmed succeeds", response.statusCode === 200, JSON.stringify(response.body?.message));
    const after = await OrderModel.findById(heldCod._id).lean();
    ok("it stamps confirmedAt", after.confirmedAt instanceof Date);
    ok("the COD payment stays Pending until delivery", after.paymentStatus === "Pending", after.paymentStatus);

    const unpaid = await makeOrder({ paymentMethod: "RAZORPAY", paymentStatus: "Pending" });
    const refused = await callController(orderController.UpdateOrderStatus, {
      params: { orderId: String(unpaid._id) },
      body: { orderStatus: "Confirmed" },
      user: admin(),
    });
    ok(
      "an unpaid prepaid checkout is still refused (PAYMENT_NOT_CAPTURED)",
      refused.statusCode === 409 && refused.body?.code === "PAYMENT_NOT_CAPTURED",
      `${refused.statusCode} ${refused.body?.code}`,
    );
  }

  section("4 — bulk confirm of selected orders validates each one");
  {
    const cod = await makeOrder();
    const paid = await makeOrder({ paymentMethod: "RAZORPAY", paymentStatus: "Paid" });
    const unpaid = await makeOrder({ paymentMethod: "RAZORPAY", paymentStatus: "Pending" });
    const cancelled = await makeOrder({ orderStatus: "Cancelled" });
    const confirmed = await makeOrder({ orderStatus: "Confirmed" });
    const shipped = await makeOrder({ orderStatus: "Shipped" });
    const missing = new mongoose.Types.ObjectId();

    const response = await bulk({
      scope: "selected",
      orderIds: [cod, paid, unpaid, cancelled, confirmed, shipped, cod].map((o) => String(o._id)).concat(String(missing)),
    });
    const body = response.body || {};
    const skippedCode = (order) => body.skipped?.find((row) => row.orderId === String(order._id || order))?.code;

    ok("the request succeeds", response.statusCode === 200, JSON.stringify(body.message));
    ok("exactly the COD and the paid order are confirmed", body.confirmedCount === 2, JSON.stringify(body.confirmed));
    ok("a duplicated id is processed once, not reported against itself", body.skippedCount === 5, JSON.stringify(body.skipped));
    ok("unpaid prepaid → PAYMENT_NOT_CAPTURED", skippedCode(unpaid) === "PAYMENT_NOT_CAPTURED");
    ok("cancelled → ORDER_CANCELLED", skippedCode(cancelled) === "ORDER_CANCELLED");
    ok("already confirmed → ALREADY_CONFIRMED", skippedCode(confirmed) === "ALREADY_CONFIRMED");
    ok("already shipped → ALREADY_CONFIRMED", skippedCode(shipped) === "ALREADY_CONFIRMED");
    ok("unknown id → NOT_FOUND", skippedCode(missing) === "NOT_FOUND");

    const [codAfter, paidAfter, unpaidAfter, cancelledAfter, shippedAfter] = await Promise.all(
      [cod, paid, unpaid, cancelled, shipped].map((o) => OrderModel.findById(o._id).lean()),
    );
    ok(
      "COD is Confirmed with its payment still Pending",
      codAfter.orderStatus === "Confirmed" && codAfter.paymentStatus === "Pending",
      `${codAfter.orderStatus}/${codAfter.paymentStatus}`,
    );
    ok(
      "the paid order is Confirmed with its payment still Paid",
      paidAfter.orderStatus === "Confirmed" && paidAfter.paymentStatus === "Paid",
      `${paidAfter.orderStatus}/${paidAfter.paymentStatus}`,
    );
    ok(
      "the confirmation is recorded once, attributed to the bulk action",
      codAfter.statusHistory.filter((entry) => entry.to === "Confirmed").length === 1 &&
        codAfter.statusHistory[0].source === "admin_bulk_confirm",
      JSON.stringify(codAfter.statusHistory),
    );
    ok("the unpaid checkout is untouched", unpaidAfter.orderStatus === "Pending" && unpaidAfter.paymentStatus === "Pending");
    ok("the cancelled order is untouched", cancelledAfter.orderStatus === "Cancelled");
    ok("the shipped order is untouched", shippedAfter.orderStatus === "Shipped");

    const again = await bulk({ scope: "selected", orderIds: [String(cod._id)] });
    ok(
      "confirming it a second time is a reported no-op",
      again.body?.confirmedCount === 0 && again.body?.skipped?.[0]?.code === "ALREADY_CONFIRMED",
      JSON.stringify(again.body),
    );
  }

  section("5 — a bulk confirm racing a single confirm confirms once");
  {
    const order = await makeOrder();
    const [bulkResult, singleResult] = await Promise.all([
      bulk({ scope: "selected", orderIds: [String(order._id)] }),
      callController(orderController.UpdateOrderStatus, {
        params: { orderId: String(order._id) },
        body: { orderStatus: "Confirmed" },
        user: admin(),
      }),
    ]);
    const after = await OrderModel.findById(order._id).lean();
    ok("the order ends Confirmed", after.orderStatus === "Confirmed");
    ok(
      "with exactly one history entry",
      after.statusHistory.filter((entry) => entry.to === "Confirmed").length === 1,
      JSON.stringify(after.statusHistory),
    );
    ok(
      "and both callers were answered without an error",
      bulkResult.statusCode === 200 && singleResult.statusCode === 200,
      `${bulkResult.statusCode} ${singleResult.statusCode}`,
    );
  }

  section("6 — confirm everything matching the filters");
  {
    const day = (d) => new Date(`2001-01-0${d}T12:00:00`);
    const inRange = [
      await makeOrder({ createdAt: day(2) }),
      await makeOrder({ createdAt: day(3) }),
      await makeOrder({ paymentMethod: "RAZORPAY", paymentStatus: "Paid", createdAt: day(4) }),
    ];
    const unpaidInRange = await makeOrder({ paymentMethod: "RAZORPAY", paymentStatus: "Pending", createdAt: day(3) });
    const outOfRange = await makeOrder({ createdAt: day(8) });
    const filters = { status: "Pending", from: "2001-01-01", to: "2001-01-05" };

    const preview = await countConfirmableOrders(filters);
    ok("the confirmable count for the filters is 3", preview === 3, String(preview));

    const wrongStatus = await bulk({ scope: "filtered", filters: { ...filters, status: "Confirmed" } });
    ok("a status filter that excludes Pending confirms nothing", wrongStatus.body?.confirmedCount === 0, JSON.stringify(wrongStatus.body));

    const response = await bulk({ scope: "filtered", filters });
    ok("all 3 confirmable orders in range are confirmed", response.body?.confirmedCount === 3, JSON.stringify(response.body));
    ok("nothing is left matching", response.body?.remaining === 0, String(response.body?.remaining));
    const states = await OrderModel.find({ _id: { $in: inRange.map((o) => o._id) } }).select("orderStatus").lean();
    ok("each is Confirmed", states.every((o) => o.orderStatus === "Confirmed"), JSON.stringify(states));
    ok(
      "the unpaid checkout in range is not touched",
      (await OrderModel.findById(unpaidInRange._id).lean()).orderStatus === "Pending",
    );
    ok(
      "the order outside the date range is not touched",
      (await OrderModel.findById(outOfRange._id).lean()).orderStatus === "Pending",
    );
    ok("afterwards the confirmable count is 0", (await countConfirmableOrders(filters)) === 0);
  }

  section("7 — request validation");
  {
    const parse = (body) => bulkConfirmOrdersSchema.body.safeParse(body);
    ok("selected scope with no ids is refused", !parse({ scope: "selected", orderIds: [] }).success);
    ok("an unknown scope is refused", !parse({ scope: "everything" }).success);
    ok("a malformed id is refused", !parse({ scope: "selected", orderIds: ["nope"] }).success);
    ok("a malformed date is refused", !parse({ scope: "filtered", filters: { from: "01/02/2001" } }).success);
    ok("more than 500 ids is refused", !parse({
      scope: "selected",
      orderIds: Array.from({ length: 501 }, () => String(new mongoose.Types.ObjectId())),
    }).success);
    ok("a well-formed filtered request is accepted", parse({ scope: "filtered", filters: { status: "Pending", from: "2001-01-01", to: "" } }).success);
    ok("an impossible calendar date is refused", !parse({ scope: "filtered", filters: { from: "2026-13-45" } }).success);
    ok("a status sent as an operator object is refused", !parse({ scope: "filtered", filters: { status: { $ne: "Cancelled" } } }).success);

    const listBadDate = await callController(orderController.GetAllOrders, {
      user: admin(),
      query: { from: "2026-13-45" },
    });
    ok("the order list answers an impossible date with 400, not 500", listBadDate.statusCode === 400, String(listBadDate.statusCode));
    const bulkBadDate = await bulk({ scope: "filtered", filters: { from: "2026-13-45" } });
    ok("bulk confirm refuses it too, confirming nothing", bulkBadDate.statusCode === 400, String(bulkBadDate.statusCode));
  }

  section("8 — cancelling a paid order awaiting approval refunds it");
  {
    const { order, product } = await capturePrepaid();
    const stockBefore = (await ProductModel.findById(product._id).lean()).stock;
    const response = await callController(orderController.AdminCancelOrder, {
      params: { orderId: String(order._id) },
      body: { reason: "regression" },
      user: admin(),
    });
    ok("the cancellation succeeds", response.statusCode === 200, JSON.stringify(response.body?.message));
    const after = await OrderModel.findById(order._id).lean();
    const stockAfter = (await ProductModel.findById(product._id).lean()).stock;
    ok("the order is Cancelled", after.orderStatus === "Cancelled");
    ok(
      "its payment is not marked Failed (money was collected)",
      after.paymentStatus !== "Failed" && after.paymentStatus !== "Pending",
      after.paymentStatus,
    );
    ok(
      "a refund for the full amount is recorded",
      (after.refunds || []).some((refund) => Number(refund.amount) === Number(order.totalAmount)),
      JSON.stringify(after.refunds),
    );
    ok("its stock is returned", stockAfter === stockBefore + 1, `${stockBefore} → ${stockAfter}`);
  }
} finally {
  setManual(false);
  globalThis.fetch = realFetch;
  CheckoutSetting.getSettings = realCheckoutGetSettings;
  await OrderModel.deleteMany({ _id: { $in: trash.orders } });
  await ProductModel.deleteMany({ _id: { $in: trash.products } });
  await PaymentIntent.deleteMany({ _id: { $in: trash.intents } });
  await CodVerification.deleteMany({ _id: { $in: trash.verifications } });
  const { failed } = finish();
  await mongoose.disconnect();
  process.exit(failed ? 1 : 0);
}
