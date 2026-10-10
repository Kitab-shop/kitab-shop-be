/**
 * Returns lifecycle regression, driven through the real controller functions.
 *
 * Covers audit items C-06 (status CAS), H-05 (bank-detail exposure), M-08
 * (already-refunded returns), M-09 (cancelled units), plus the return-creation
 * policy window and COD payout-destination rules.
 *
 * Run with `npm run test:returns` (or `npm test` for everything).
 */
import mongoose from "mongoose";
import {
  addressFixture,
  connect,
  createSuite,
  marker,
  productFixture,
} from "./helpers.mjs";

const { ok, section, finish } = createSuite("returns");
await connect();

const OrderModel = (await import("../../src/modules/orders/Order.model.js")).default;
const ProductModel = (await import("../../src/modules/products/Product.model.js")).default;
const ReturnModel = (await import("../../src/modules/returns/return.model.js")).default;
const UserModel = (await import("../../src/model/User.model.js")).default;
const { CreateReturnRequest, GetMyReturns, GetReturnById } = await import(
  "../../src/modules/returns/return.controller.js"
);

const MARKER = marker("ret");
const trash = { orders: [], products: [], returns: [], users: [] };
let seq = 0;

/** Captures what a controller answered, so assertions read like HTTP. */
const call = async (handler, { user, params = {}, body = {}, query = {} }) => {
  const captured = {};
  const res = {
    status(code) {
      captured.status = code;
      return this;
    },
    json(payload) {
      captured.body = payload;
      return this;
    },
  };
  await handler({ user, params, body, query, get: () => undefined }, res);
  return captured;
};

const makeUser = async (roles = ["user"]) => {
  seq += 1;
  const user = await UserModel.create({
    name: `${MARKER} user`,
    email: `${MARKER}-${seq}@test.local`,
    password: "x".repeat(60),
    roles,
  });
  trash.users.push(user._id);
  return user;
};

const makeProduct = async (overrides = {}) => {
  seq += 1;
  const product = await ProductModel.create(productFixture(`${MARKER} product ${seq}`, overrides));
  trash.products.push(product._id);
  return product;
};

const makeDeliveredOrder = async ({ user, product, quantity = 2, ...fields }) => {
  seq += 1;
  const order = await OrderModel.create({
    user: user._id,
    items: [
      {
        product: product._id,
        name: product.name,
        price: 500,
        quantity,
        ...(fields.cancelledQuantity ? { cancelledQuantity: fields.cancelledQuantity } : {}),
      },
    ],
    shippingAddress: addressFixture(),
    paymentMethod: "RAZORPAY",
    razorpayPaymentId: `pay_${MARKER}_${seq}`,
    paymentStatus: fields.paymentStatus || "Paid",
    orderStatus: "Delivered",
    deliveredAt: fields.deliveredAt || new Date(),
    subtotal: 500 * quantity,
    totalAmount: fields.totalAmount ?? 500 * quantity,
    walletDiscount: fields.walletDiscount || 0,
  });
  trash.orders.push(order._id);
  return order;
};

const track = (created) => {
  const id = created?.body?.data?._id;
  if (id) trash.returns.push(id);
  return created;
};

try {
  // ═══ A return can be created for a delivered, returnable item ══════════════
  section("A return request can be created for delivered goods");

  const customer = await makeUser();
  const product = await makeProduct({ returnPolicy: { kind: "return", windowDays: 7 } });
  const order = await makeDeliveredOrder({ user: customer, product, quantity: 2 });

  const created = track(
    await call(CreateReturnRequest, {
      user: { id: String(customer._id) },
      body: { orderId: String(order._id), productId: String(product._id), quantity: 1, reason: "damaged" },
    }),
  );
  ok("a valid return is created (201)", created.status === 201, `status ${created.status} ${created.body?.message || ""}`);
  ok("it is a refund, per the product's return policy", created.body?.data?.resolutionType === "refund");
  ok("the refund is valued at the price paid", created.body?.data?.refundAmount === 500, String(created.body?.data?.refundAmount));
  ok("no wallet share on a card-only order", created.body?.data?.walletRefundAmount === 0);
  ok("it starts at pending", created.body?.data?.status === "pending");

  const mine = await call(GetMyReturns, { user: { id: String(customer._id) } });
  ok("the customer can list their own returns", mine.status === 200 && mine.body?.total === 1);

  // ═══ H-03 wiring: the wallet share is recorded at creation ═════════════════
  section("The wallet share is quoted at request time (H-03)");

  const walletCustomer = await makeUser();
  const walletProduct = await makeProduct({ returnPolicy: { kind: "return", windowDays: 7 } });
  // ₹1000 of goods, ₹200 from wallet, ₹800 charged.
  const walletOrder = await makeDeliveredOrder({
    user: walletCustomer,
    product: walletProduct,
    quantity: 2,
    totalAmount: 800,
    walletDiscount: 200,
  });
  const walletReturn = track(
    await call(CreateReturnRequest, {
      user: { id: String(walletCustomer._id) },
      body: {
        orderId: String(walletOrder._id),
        productId: String(walletProduct._id),
        quantity: 2,
        reason: "not as described",
      },
    }),
  );
  ok("the card share is ₹800", walletReturn.body?.data?.refundAmount === 800, String(walletReturn.body?.data?.refundAmount));
  ok("the wallet share is ₹200", walletReturn.body?.data?.walletRefundAmount === 200, String(walletReturn.body?.data?.walletRefundAmount));
  ok(
    "the two together are the full ₹1000 the customer is owed",
    walletReturn.body?.data?.refundAmount + walletReturn.body?.data?.walletRefundAmount === 1000,
  );

  // ═══ M-09: units already cancelled are not returnable ═════════════════════
  section("Units already cancelled cannot be returned again (M-09)");

  const cancelCustomer = await makeUser();
  const cancelProduct = await makeProduct({ returnPolicy: { kind: "return", windowDays: 7 } });
  const partlyCancelled = await makeDeliveredOrder({
    user: cancelCustomer,
    product: cancelProduct,
    quantity: 3,
    cancelledQuantity: 2,
  });

  const overReturn = await call(CreateReturnRequest, {
    user: { id: String(cancelCustomer._id) },
    body: { orderId: String(partlyCancelled._id), productId: String(cancelProduct._id), quantity: 3, reason: "x" },
  });
  ok("returning 3 of 3 when 2 were cancelled is refused", overReturn.status === 400, String(overReturn.status));
  ok("and the message quotes the returnable quantity, not the ordered one", /between 1 and 1/.test(overReturn.body?.message || ""), overReturn.body?.message);

  const withinReturn = track(
    await call(CreateReturnRequest, {
      user: { id: String(cancelCustomer._id) },
      body: { orderId: String(partlyCancelled._id), productId: String(cancelProduct._id), quantity: 1, reason: "x" },
    }),
  );
  ok("returning the 1 remaining unit is allowed", withinReturn.status === 201, String(withinReturn.status));

  const allCancelledCustomer = await makeUser();
  const allCancelledProduct = await makeProduct({ returnPolicy: { kind: "return", windowDays: 7 } });
  const allCancelled = await makeDeliveredOrder({
    user: allCancelledCustomer,
    product: allCancelledProduct,
    quantity: 2,
    cancelledQuantity: 2,
  });
  const nothingLeft = await call(CreateReturnRequest, {
    user: { id: String(allCancelledCustomer._id) },
    body: { orderId: String(allCancelled._id), productId: String(allCancelledProduct._id), quantity: 1, reason: "x" },
  });
  ok("a fully-cancelled line is not returnable at all", nothingLeft.body?.code === "NOTHING_LEFT_TO_RETURN", nothingLeft.body?.message);

  // ═══ M-08: an already-refunded order is refused at creation ════════════════
  section("An already-refunded order is refused before pickup (M-08)");

  const refundedCustomer = await makeUser();
  const refundedProduct = await makeProduct({ returnPolicy: { kind: "return", windowDays: 7 } });
  const refundedOrder = await makeDeliveredOrder({
    user: refundedCustomer,
    product: refundedProduct,
    paymentStatus: "Refunded",
  });
  const refusedRefund = await call(CreateReturnRequest, {
    user: { id: String(refundedCustomer._id) },
    body: { orderId: String(refundedOrder._id), productId: String(refundedProduct._id), quantity: 1, reason: "x" },
  });
  ok(
    "a refund return on a fully-refunded order is refused at creation",
    refusedRefund.body?.code === "ORDER_ALREADY_REFUNDED",
    refusedRefund.body?.message,
  );

  // A replacement needs no money, so it stays allowed.
  const replaceProduct = await makeProduct({ returnPolicy: { kind: "replacement", windowDays: 10 } });
  const replaceOrder = await makeDeliveredOrder({
    user: refundedCustomer,
    product: replaceProduct,
    paymentStatus: "Refunded",
  });
  const replacement = track(
    await call(CreateReturnRequest, {
      user: { id: String(refundedCustomer._id) },
      body: { orderId: String(replaceOrder._id), productId: String(replaceProduct._id), quantity: 1, reason: "x" },
    }),
  );
  ok("a REPLACEMENT on the same order is still allowed", replacement.status === 201, replacement.body?.message);
  ok("and is typed as a replacement", replacement.body?.data?.resolutionType === "replacement");

  // ═══ Policy window and policy kind ═════════════════════════════════════════
  section("The product's own return policy is enforced");

  const lateCustomer = await makeUser();
  const shortWindow = await makeProduct({ returnPolicy: { kind: "return", windowDays: 7 } });
  const lateOrder = await makeDeliveredOrder({
    user: lateCustomer,
    product: shortWindow,
    deliveredAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
  });
  const expired = await call(CreateReturnRequest, {
    user: { id: String(lateCustomer._id) },
    body: { orderId: String(lateOrder._id), productId: String(shortWindow._id), quantity: 1, reason: "x" },
  });
  ok("a return after the window is refused", expired.status === 400);
  ok("and says which window and how long it was", /7 days from delivery/.test(expired.body?.message || ""), expired.body?.message);

  const noReturnCustomer = await makeUser();
  const noReturnProduct = await makeProduct({ returnPolicy: { kind: "none", windowDays: 0 } });
  const noReturnOrder = await makeDeliveredOrder({ user: noReturnCustomer, product: noReturnProduct });
  const ineligible = await call(CreateReturnRequest, {
    user: { id: String(noReturnCustomer._id) },
    body: { orderId: String(noReturnOrder._id), productId: String(noReturnProduct._id), quantity: 1, reason: "x" },
  });
  ok("a non-returnable product is refused", ineligible.status === 400 && /not eligible/.test(ineligible.body?.message || ""));

  const undeliveredCustomer = await makeUser();
  const undeliveredProduct = await makeProduct({ returnPolicy: { kind: "return", windowDays: 7 } });
  const undelivered = await makeDeliveredOrder({ user: undeliveredCustomer, product: undeliveredProduct });
  await OrderModel.updateOne({ _id: undelivered._id }, { $set: { orderStatus: "Shipped" } });
  const notDelivered = await call(CreateReturnRequest, {
    user: { id: String(undeliveredCustomer._id) },
    body: { orderId: String(undelivered._id), productId: String(undeliveredProduct._id), quantity: 1, reason: "x" },
  });
  ok("an undelivered order cannot be returned", notDelivered.status === 400 && /after the order is delivered/.test(notDelivered.body?.message || ""));

  // ═══ COD needs a payout destination ════════════════════════════════════════
  section("A COD refund must collect somewhere to send the money");

  const codCustomer = await makeUser();
  const codProduct = await makeProduct({ returnPolicy: { kind: "return", windowDays: 7 } });
  const codOrder = await makeDeliveredOrder({ user: codCustomer, product: codProduct });
  await OrderModel.updateOne(
    { _id: codOrder._id },
    { $set: { paymentMethod: "COD", razorpayPaymentId: "" } },
  );

  const missingDestination = await call(CreateReturnRequest, {
    user: { id: String(codCustomer._id) },
    body: { orderId: String(codOrder._id), productId: String(codProduct._id), quantity: 1, reason: "x" },
  });
  ok("a COD refund with no destination is refused", missingDestination.body?.code === "REFUND_DESTINATION_REQUIRED");

  const badUpi = await call(CreateReturnRequest, {
    user: { id: String(codCustomer._id) },
    body: {
      orderId: String(codOrder._id),
      productId: String(codProduct._id),
      quantity: 1,
      reason: "x",
      refundDestination: { method: "upi", upiId: "not-a-upi" },
    },
  });
  ok("a malformed UPI id is refused", badUpi.body?.code === "REFUND_DESTINATION_REQUIRED");

  const badIfsc = await call(CreateReturnRequest, {
    user: { id: String(codCustomer._id) },
    body: {
      orderId: String(codOrder._id),
      productId: String(codProduct._id),
      quantity: 1,
      reason: "x",
      refundDestination: {
        method: "bank_transfer",
        accountName: "A Customer",
        accountNumber: "123456789012",
        ifsc: "BADIFSC",
      },
    },
  });
  ok("a malformed IFSC is refused", badIfsc.body?.code === "REFUND_DESTINATION_REQUIRED");

  const codReturn = track(
    await call(CreateReturnRequest, {
      user: { id: String(codCustomer._id) },
      body: {
        orderId: String(codOrder._id),
        productId: String(codProduct._id),
        quantity: 1,
        reason: "x",
        refundDestination: {
          method: "bank_transfer",
          accountName: "A Customer",
          accountNumber: "123456789012",
          ifsc: "HDFC0001234",
        },
      },
    }),
  );
  ok("a valid bank destination is accepted", codReturn.status === 201, codReturn.body?.message);
  ok("and stored", codReturn.body?.data?.refundDestination?.ifsc === "HDFC0001234");

  // ═══ H-05: who may read a return, and what they see ════════════════════════
  section("Bank details are not readable by the wrong people (H-05)");

  const codReturnId = String(codReturn.body.data._id);
  const owner = await call(GetReturnById, {
    user: { id: String(codCustomer._id) },
    params: { id: codReturnId },
  });
  ok("the owner can read their own return", owner.status === 200);
  ok(
    "the owner sees the account number MASKED, not in full",
    owner.body?.data?.refundDestination?.accountNumber === "••••••••9012",
    owner.body?.data?.refundDestination?.accountNumber,
  );
  ok("the IFSC is left intact (useless alone)", owner.body?.data?.refundDestination?.ifsc === "HDFC0001234");

  const themeEditor = await makeUser(["themeEditor"]);
  const editorRead = await call(GetReturnById, {
    user: { id: String(themeEditor._id), roles: ["themeEditor"] },
    params: { id: codReturnId },
  });
  ok("a themeEditor is refused (403) — no bank details at all", editorRead.status === 403, String(editorRead.status));

  const otherCustomer = await makeUser();
  const strangerRead = await call(GetReturnById, {
    user: { id: String(otherCustomer._id), roles: ["user"] },
    params: { id: codReturnId },
  });
  ok("an unrelated customer is refused", strangerRead.status === 403);

  const returnsAdmin = await makeUser(["admin"]);
  const adminRead = await call(GetReturnById, {
    user: { id: String(returnsAdmin._id), roles: ["admin"] },
    params: { id: codReturnId },
  });
  ok("an admin with returns:manage can read it", adminRead.status === 200, String(adminRead.status));
  ok(
    "and gets the FULL account number, because they have to pay it out",
    adminRead.body?.data?.refundDestination?.accountNumber === "123456789012",
    adminRead.body?.data?.refundDestination?.accountNumber,
  );

  // ═══ Duplicate returns ═════════════════════════════════════════════════════
  section("One return per product per order");
  const duplicate = await call(CreateReturnRequest, {
    user: { id: String(customer._id) },
    body: { orderId: String(order._id), productId: String(product._id), quantity: 1, reason: "again" },
  });
  ok("a second return for the same line is refused with 409", duplicate.status === 409, String(duplicate.status));

  // ═══ Ownership ═════════════════════════════════════════════════════════════
  section("A customer cannot return someone else's order");
  const thief = await call(CreateReturnRequest, {
    user: { id: String(otherCustomer._id) },
    body: { orderId: String(order._id), productId: String(product._id), quantity: 1, reason: "x" },
  });
  ok("returning another customer's order is refused", thief.status === 403);
} finally {
  await Promise.all([
    OrderModel.deleteMany({ _id: { $in: trash.orders } }),
    ProductModel.deleteMany({ _id: { $in: trash.products } }),
    UserModel.deleteMany({ _id: { $in: trash.users } }),
    ReturnModel.deleteMany({ returnNumber: { $exists: true }, _id: { $in: trash.returns } }),
  ]);
  await mongoose.disconnect();
}

const { failed } = finish();
process.exit(failed > 0 ? 1 : 0);
