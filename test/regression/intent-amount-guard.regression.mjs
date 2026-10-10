/**
 * A payment intent must never charge for a basket the shopper no longer has.
 *
 * `CreateRazorpayOrder` reuses an existing intent when the same idempotency key arrives again —
 * which is right, it is what stops a double-click creating two Razorpay orders. But it returned
 * the intent's STORED amount without re-checking the cart, and that amount is what Razorpay
 * charges. So:
 *
 *   1. Place Order          → intent created for ₹1,000, Razorpay window opens
 *   2. Shopper closes it
 *   3. Shopper changes the basket → now ₹500
 *   4. Place Order again    → same key → the ₹1,000 razorpayOrderId came back
 *   5. They pay ₹1,000 for a ₹500 basket
 *
 * Until now that needed a second tab or a back-navigation. Editable quantities on the checkout
 * screen make it a one-click path, so the guard comes first.
 *
 * Refused rather than superseded, deliberately: an intent can own a stock reservation and may
 * already be `processing`, so replacing one safely means releasing that reservation and proving
 * no payment is in flight. A refusal the shopper can recover from is the cheap, honest answer.
 *
 * Run with `npm run test:intent-amount-guard` (or `npm test` for everything).
 */
process.env.PAYMENTS_ENABLED = "true";
process.env.PAYMENT_PROVIDER = "razorpay";
process.env.RAZORPAY_KEY_ID = "rzp_test_stub0000000";
process.env.RAZORPAY_KEY_SECRET = "stub_secret_for_tests";
process.env.INVENTORY_ENFORCE_STOCK = "false";
process.env.INVENTORY_RESERVE_DURING_PAYMENT = "false";
process.env.NOTIFICATIONS_ENABLED = "false";
process.env.SHIPROCKET_ENABLED = "false";

import mongoose from "mongoose";
import { connect, createSuite, marker, productFixture, addressFixture } from "./helpers.mjs";

const { ok, section, finish } = createSuite("intent-amount-guard");
await connect();

const OrderModel = (await import("../../src/modules/orders/Order.model.js")).default;
const ProductModel = (await import("../../src/modules/products/Product.model.js")).default;
const PaymentIntent = (await import("../../src/modules/payments/PaymentIntent.model.js")).default;
const paymentController = await import("../../src/modules/payments/payment.controller.js");

await OrderModel.init();

const MARKER = marker("intentguard");
const trash = { products: [], intents: [] };
let seq = 0;

const callController = async (handler, { body = {}, user } = {}) => {
  let statusCode = 200;
  let payload;
  const res = {
    status(code) { statusCode = code; return this; },
    json(data) { payload = data; return this; },
  };
  await handler({ body, user, params: {}, query: {} }, res);
  return { statusCode, body: payload };
};

const makeProduct = async (price) => {
  seq += 1;
  const product = await ProductModel.create(
    productFixture(`${MARKER}-${seq}`, { stock: 50, price }),
  );
  trash.products.push(product._id);
  return product;
};

/** An intent already created for `amount` rupees, under `key`. */
const plantIntent = async ({ userId, key, product, quantity, amountRupees }) => {
  const intent = await PaymentIntent.create({
    user: userId,
    idempotencyKey: key,
    razorpayOrderId: `order_${MARKER}_${seq}`,
    amount: Math.round(amountRupees * 100),
    currency: "INR",
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
    subtotal: amountRupees,
    totalAmount: amountRupees,
  });
  trash.intents.push(intent._id);
  return intent;
};

const askForPayment = ({ userId, key, product, quantity }) =>
  callController(paymentController.CreateRazorpayOrder, {
    user: { id: String(userId) },
    body: {
      items: [{ product: String(product._id), quantity }],
      shippingAddress: addressFixture(),
      idempotencyKey: key,
    },
  });

// ================================================================

section("an unchanged basket still reuses its intent");

{
  const userId = new mongoose.Types.ObjectId();
  const product = await makeProduct(500);
  seq += 1;
  const key = `${MARKER}-same-${seq}-aaaaaaaaaaaaaaaa`;
  // 2 × ₹500 = ₹1,000, which is what the intent was created for.
  const intent = await plantIntent({ userId, key, product, quantity: 2, amountRupees: 1000 });

  const result = await askForPayment({ userId, key, product, quantity: 2 });
  ok(
    "the same basket gets the same Razorpay order back",
    result.statusCode === 200 && result.body?.data?.razorpayOrderId === intent.razorpayOrderId,
    `${result.statusCode} ${JSON.stringify(result.body?.data?.razorpayOrderId)}`,
  );
  ok(
    "at the amount it was created for",
    result.body?.data?.amount === 100000,
    String(result.body?.data?.amount),
  );
  // The whole reason the reuse exists: a double-click must not create a second Razorpay order.
  const [first, second] = await Promise.all([
    askForPayment({ userId, key, product, quantity: 2 }),
    askForPayment({ userId, key, product, quantity: 2 }),
  ]);
  const intentCount = await PaymentIntent.countDocuments({ user: userId });
  ok(
    "a double submit still produces one intent, not two",
    // String(): paymentIntentId is a Mongoose ObjectId, and two distinct instances holding the
    // same value are never === to each other. Comparing them directly made this assertion fail
    // while the behaviour was correct.
    String(first.body?.data?.paymentIntentId) === String(second.body?.data?.paymentIntentId) &&
      intentCount === 1,
    JSON.stringify({
      a: first.body?.data?.paymentIntentId,
      b: second.body?.data?.paymentIntentId,
      count: intentCount,
      firstStatus: first.statusCode,
      secondStatus: second.statusCode,
    }),
  );
}

section("a changed basket is refused, not charged the old amount");

{
  const userId = new mongoose.Types.ObjectId();
  const product = await makeProduct(500);
  seq += 1;
  const key = `${MARKER}-down-${seq}-aaaaaaaaaaaaaaaa`;
  const intent = await plantIntent({ userId, key, product, quantity: 2, amountRupees: 1000 });

  // The shopper reduced the quantity: ₹500 now, ₹1,000 on the intent.
  const result = await askForPayment({ userId, key, product, quantity: 1 });
  ok(
    "reducing the quantity is refused with 409 CART_CHANGED",
    result.statusCode === 409 && result.body?.code === "CART_CHANGED",
    `${result.statusCode} ${JSON.stringify(result.body?.code)}`,
  );
  ok(
    "and the stale amount is NOT handed to the browser",
    !JSON.stringify(result.body).includes("100000") &&
      result.body?.data?.razorpayOrderId === undefined,
    JSON.stringify(result.body),
  );
  ok(
    "the message tells the shopper what happened and what to do",
    /basket changed/i.test(result.body?.message || "") &&
      /start the payment again/i.test(result.body?.message || ""),
    result.body?.message,
  );
  ok(
    "the intent is left alone rather than half-modified",
    Boolean(await PaymentIntent.findOne({ _id: intent._id, amount: 100000, status: "created" })),
    "the intent was mutated",
  );
}

{
  // Increasing matters just as much, in the other direction: the shopper would be UNDERcharged
  // and the order would ship goods that were never paid for.
  const userId = new mongoose.Types.ObjectId();
  const product = await makeProduct(500);
  seq += 1;
  const key = `${MARKER}-up-${seq}-aaaaaaaaaaaaaaaa`;
  await plantIntent({ userId, key, product, quantity: 1, amountRupees: 500 });

  const result = await askForPayment({ userId, key, product, quantity: 3 });
  ok(
    "increasing the quantity is refused too — undercharging is not safer",
    result.statusCode === 409 && result.body?.code === "CART_CHANGED",
    `${result.statusCode} ${JSON.stringify(result.body?.code)}`,
  );
}

{
  // A different product at the same total must not slip through: the amounts match, so an
  // amount-only comparison passes it. Worth knowing this guard does NOT catch that case.
  const userId = new mongoose.Types.ObjectId();
  const original = await makeProduct(500);
  const swapped = await makeProduct(500);
  seq += 1;
  const key = `${MARKER}-swap-${seq}-aaaaaaaaaaaaaaaa`;
  await plantIntent({ userId, key, product: original, quantity: 2, amountRupees: 1000 });

  const result = await askForPayment({ userId, key, product: swapped, quantity: 2 });
  ok(
    "a swap to a different product at the SAME total is still accepted (amount-only guard)",
    result.statusCode === 200,
    `${result.statusCode} ${JSON.stringify(result.body?.code)}`,
  );
  ok(
    "…and the order is built from the INTENT's items, so the shopper gets what they paid for",
    Boolean(
      await PaymentIntent.findOne({
        idempotencyKey: key,
        "items.product": original._id,
      }),
    ),
    "the intent's items changed, which would be the real problem",
  );
}

section("an unpriceable basket is refused rather than reused");

{
  const userId = new mongoose.Types.ObjectId();
  const product = await makeProduct(500);
  seq += 1;
  const key = `${MARKER}-gone-${seq}-aaaaaaaaaaaaaaaa`;
  await plantIntent({ userId, key, product, quantity: 2, amountRupees: 1000 });

  // The product is gone, so prepareOrderData cannot price the basket at all. Whatever the
  // intent says, it no longer describes something purchasable.
  await ProductModel.deleteOne({ _id: product._id });
  const result = await askForPayment({ userId, key, product, quantity: 2 });
  ok(
    "a basket that can no longer be priced is refused",
    result.statusCode === 409 && result.body?.code === "CART_CHANGED",
    `${result.statusCode} ${JSON.stringify(result.body?.code)}`,
  );
}

// ---------------------------------------------------------------- cleanup

await Promise.all([
  ProductModel.deleteMany({ _id: { $in: trash.products } }),
  PaymentIntent.deleteMany({ _id: { $in: trash.intents } }),
  PaymentIntent.deleteMany({ idempotencyKey: new RegExp(MARKER) }),
]);

const leftovers =
  (await ProductModel.countDocuments({ name: new RegExp(MARKER) })) +
  (await PaymentIntent.countDocuments({ idempotencyKey: new RegExp(MARKER) }));
ok("every fixture this suite created is gone", leftovers === 0, `leftovers=${leftovers}`);

const summary = finish();
await mongoose.disconnect();
process.exit(summary.failed > 0 ? 1 : 0);
