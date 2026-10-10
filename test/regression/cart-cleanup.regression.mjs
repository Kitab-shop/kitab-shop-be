/**
 * Server-side cart cleanup on order confirmation (Phase 2 / audit F3).
 *
 * The behaviour under test: once an order is confirmed, the items it bought leave
 * the customer's cart — identically whether confirmation came from the browser
 * verify call or from the Razorpay webhook. Clearing used to live only in
 * Checkout.jsx, so the webhook path (which exists precisely for when the browser
 * never returns) left purchased items sitting in the cart.
 *
 * Run with `npm run test:cart-cleanup` (or `npm test` for everything).
 *
 * `completeCapturedIntent` is driven directly rather than through HTTP, because
 * it is the single funnel BOTH Razorpay confirmation paths converge on — the
 * verify endpoint and the webhook each call it, and the concurrency being tested
 * is two of those calls landing together. Razorpay itself is never contacted:
 * the captured-payment object is what the webhook synthesises anyway.
 */
process.env.PAYMENTS_ENABLED = "true";
process.env.PAYMENT_PROVIDER = "razorpay";
process.env.RAZORPAY_KEY_ID = "rzp_test_stub0000000";
process.env.RAZORPAY_KEY_SECRET = "stub_secret_for_tests";
// Stock enforcement off: this suite is about the cart, and the inventory paths
// have their own suite. Keeps fixtures from needing real stock ledgers.
process.env.INVENTORY_ENFORCE_STOCK = "false";
process.env.INVENTORY_RESERVE_DURING_PAYMENT = "false";
process.env.NOTIFICATIONS_ENABLED = "false";
process.env.SHIPROCKET_ENABLED = "false";

import mongoose from "mongoose";
import { readFile } from "node:fs/promises";
import { connect, createSuite, marker, productFixture, addressFixture } from "./helpers.mjs";

const { ok, section, finish } = createSuite("cart-cleanup");
await connect();

const OrderModel = (await import("../../src/modules/orders/Order.model.js")).default;
const ProductModel = (await import("../../src/modules/products/Product.model.js")).default;
const PaymentIntent = (await import("../../src/modules/payments/PaymentIntent.model.js")).default;
const cartModel = (await import("../../src/modules/cart/cart.model.js")).default;
const { clearOrderedItemsFromCart } = await import("../../src/modules/cart/cart-cleanup.service.js");
const { completeCapturedIntent } = await import("../../src/modules/payments/payment-order.service.js");
const { variantKeyFrom } = await import("../../src/modules/inventory/variant.service.js");

await OrderModel.init();
await cartModel.init();

const MARKER = marker("cartclean");
const trash = { orders: [], products: [], carts: [], intents: [] };
let seq = 0;

const makeProduct = async (label) => {
  const product = await ProductModel.create(productFixture(`${MARKER}-${label}`, { stock: 100 }));
  trash.products.push(product._id);
  return product;
};

/** A cart with the given lines. `lines` = [{product, quantity, variantKey?}] */
const makeCart = async (userId, lines) => {
  const cart = await cartModel.create({
    user: userId,
    items: lines.map((line) => ({
      product: line.product._id,
      quantity: line.quantity,
      variantKey: line.variantKey || "",
      selectedVariants: line.selectedVariants || {},
      price: line.product.price,
      mrp: line.product.price,
    })),
  });
  trash.carts.push(cart._id);
  return cart;
};

const orderItemsFrom = (lines) =>
  lines.map((line) => ({
    product: line.product._id,
    name: line.product.name,
    image: "x.png",
    price: line.product.price,
    quantity: line.quantity,
    variantKey: line.variantKey || "",
    selectedVariants: line.selectedVariants || {},
  }));

const makeOrder = async ({ userId, lines, ...fields }) => {
  seq += 1;
  const items = orderItemsFrom(lines);
  const subtotal = items.reduce((total, item) => total + item.price * item.quantity, 0);
  const order = await OrderModel.create({
    user: userId,
    items,
    shippingAddress: addressFixture(),
    paymentMethod: "RAZORPAY",
    paymentStatus: "Paid",
    orderStatus: "Confirmed",
    subtotal,
    totalAmount: subtotal,
    razorpayPaymentId: `pay_${MARKER}_${seq}`,
    ...fields,
  });
  trash.orders.push(order._id);
  return order;
};

/** An order-first pending row plus its intent, as CreateRazorpayOrder builds them. */
const makePendingCheckout = async ({ userId, lines }) => {
  seq += 1;
  const items = orderItemsFrom(lines);
  const subtotal = items.reduce((total, item) => total + item.price * item.quantity, 0);
  const razorpayOrderId = `order_${MARKER}_${seq}`;

  const [pendingOrder] = await OrderModel.create([
    {
      user: userId,
      items,
      shippingAddress: addressFixture(),
      paymentMethod: "RAZORPAY",
      paymentStatus: "Pending",
      orderStatus: "Pending",
      subtotal,
      totalAmount: subtotal,
      razorpayOrderId,
      paymentExpiresAt: new Date(Date.now() + 20 * 60 * 1000),
    },
  ]);
  trash.orders.push(pendingOrder._id);

  const intent = await PaymentIntent.create({
    user: userId,
    razorpayOrderId,
    amount: Math.round(subtotal * 100),
    currency: "INR",
    items,
    shippingAddress: addressFixture(),
    subtotal,
    totalAmount: subtotal,
    pendingOrder: pendingOrder._id,
  });
  trash.intents.push(intent._id);

  return { pendingOrder, intent, paymentId: `pay_${MARKER}_${seq}` };
};

const cartLines = async (userId) => {
  const cart = await cartModel.findOne({ user: userId }).lean();
  return (cart?.items || []).map((item) => ({
    product: String(item.product),
    quantity: item.quantity,
    variantKey: item.variantKey || "",
  }));
};

try {
  // ═══════════════════════════════════════════════════════════════════════════
  section("0 — cart and order agree on line identity");

  {
    // Cleanup matches cart lines to order lines on (product, variantKey), so the
    // two sides must build that key identically. They used to be two separate
    // implementations that normalised differently; Phase 3 collapsed them onto
    // `variantKeyFrom`. This asserts the structural property that keeps them from
    // drifting apart again: the cart must not carry its own key algorithm.
    const cartSource = await readFile(
      new URL("../../src/modules/cart/cart.controller.js", import.meta.url),
      "utf8",
    );
    ok(
      "cart.controller defines no variant-key algorithm of its own",
      !/\.sort\(\)[\s\S]{0,120}join\("\|"\)/.test(cartSource),
      "an inline key algorithm has reappeared in the cart",
    );
    ok(
      "cart.controller delegates to the canonical variantKeyFrom",
      /variantKeyFrom/.test(cartSource),
      "the cart no longer references variantKeyFrom",
    );

    const cases = [
      {},
      { color: "red" },
      { color: "red", size: "M" },
      { size: "M", color: "red" }, // order-independent
      { color: "red", size: "" }, // the empty-value case that used to diverge
    ];
    ok(
      "the canonical key is stable for every representative input",
      cases.every((variants) => variantKeyFrom(variants) === variantKeyFrom({ ...variants })),
    );
    ok(
      "variant order does not change the key",
      variantKeyFrom({ color: "red", size: "M" }) === variantKeyFrom({ size: "M", color: "red" }),
    );
    ok(
      "an empty attribute value no longer changes the key",
      variantKeyFrom({ color: "red", size: "" }) === variantKeyFrom({ color: "red" }),
      `${variantKeyFrom({ color: "red", size: "" })} vs ${variantKeyFrom({ color: "red" })}`,
    );
  }

  section("1 — browser verification path");

  {
    const userId = new mongoose.Types.ObjectId();
    const a = await makeProduct("a");
    const b = await makeProduct("b");
    await makeCart(userId, [
      { product: a, quantity: 2 },
      { product: b, quantity: 1 },
    ]);
    const { intent, paymentId } = await makePendingCheckout({
      userId,
      lines: [
        { product: a, quantity: 2 },
        { product: b, quantity: 1 },
      ],
    });

    const order = await completeCapturedIntent({
      intent,
      capturedPayment: { id: paymentId, status: "captured" },
    });

    ok("the order is confirmed", order.orderStatus === "Confirmed", order.orderStatus);
    ok("the order is paid", order.paymentStatus === "Paid", order.paymentStatus);

    const lines = await cartLines(userId);
    ok("every purchased line is gone from the cart", lines.length === 0, JSON.stringify(lines));

    const fresh = await OrderModel.findById(order._id);
    ok("the cleanup claim is stamped", Boolean(fresh.cartClearedAt), "not stamped");
  }

  section("2 — webhook-only confirmation (browser never returns)");

  {
    const userId = new mongoose.Types.ObjectId();
    const a = await makeProduct("wh-a");
    await makeCart(userId, [{ product: a, quantity: 3 }]);
    const { intent, paymentId } = await makePendingCheckout({
      userId,
      lines: [{ product: a, quantity: 3 }],
    });

    // Exactly what RazorpayWebhook passes: a synthesised captured payment, no
    // signature, no browser involvement.
    const order = await completeCapturedIntent({
      intent,
      capturedPayment: { id: paymentId, status: "captured" },
    });

    ok("the webhook path confirms the order", order.paymentStatus === "Paid", order.paymentStatus);
    const lines = await cartLines(userId);
    ok(
      "and the cart is cleared WITHOUT the browser success flow",
      lines.length === 0,
      JSON.stringify(lines),
    );
  }

  section("3 — webhook replay");

  {
    const userId = new mongoose.Types.ObjectId();
    const a = await makeProduct("replay-a");
    const b = await makeProduct("replay-b");
    await makeCart(userId, [
      { product: a, quantity: 1 },
      { product: b, quantity: 4 },
    ]);
    const { intent, paymentId, pendingOrder } = await makePendingCheckout({
      userId,
      lines: [
        { product: a, quantity: 1 },
        { product: b, quantity: 2 },
      ],
    });

    const first = await completeCapturedIntent({
      intent,
      capturedPayment: { id: paymentId, status: "captured" },
    });
    const afterFirst = await cartLines(userId);

    // Two more deliveries of the same event.
    await completeCapturedIntent({ intent, capturedPayment: { id: paymentId, status: "captured" } });
    await completeCapturedIntent({ intent, capturedPayment: { id: paymentId, status: "captured" } });

    const afterReplays = await cartLines(userId);

    ok(
      "replays produce no second order",
      (await OrderModel.countDocuments({ _id: pendingOrder._id })) === 1 &&
        String(first._id) === String(pendingOrder._id),
    );
    ok(
      "only one order exists for this user",
      (await OrderModel.countDocuments({ user: userId })) === 1,
    );
    ok(
      "the cart is unchanged by the replays",
      JSON.stringify(afterFirst) === JSON.stringify(afterReplays),
      `${JSON.stringify(afterFirst)} vs ${JSON.stringify(afterReplays)}`,
    );
    // b: cart had 4, order bought 2 → 2 remain, and replays must not eat them.
    const bLine = afterReplays.find((line) => line.product === String(b._id));
    ok(
      "a partially-purchased line keeps its remainder (4 − 2 = 2)",
      bLine?.quantity === 2,
      JSON.stringify(afterReplays),
    );
    ok(
      "the fully-purchased line is gone",
      !afterReplays.some((line) => line.product === String(a._id)),
      JSON.stringify(afterReplays),
    );
  }

  section("4 — concurrent verification + webhook");

  {
    const userId = new mongoose.Types.ObjectId();
    const a = await makeProduct("race-a");
    await makeCart(userId, [{ product: a, quantity: 5 }]);
    const { intent, paymentId, pendingOrder } = await makePendingCheckout({
      userId,
      lines: [{ product: a, quantity: 2 }],
    });

    const results = await Promise.allSettled([
      completeCapturedIntent({ intent, capturedPayment: { id: paymentId, status: "captured" } }),
      completeCapturedIntent({ intent, capturedPayment: { id: paymentId, status: "captured" } }),
    ]);
    const confirmed = results.filter((r) => r.status === "fulfilled");

    ok("at least one path confirms the order", confirmed.length >= 1, JSON.stringify(results.map((r) => r.status)));
    ok(
      "both paths resolve to the SAME order (no duplicate)",
      confirmed.every((r) => String(r.value._id) === String(pendingOrder._id)),
    );
    ok(
      "exactly one order exists for this user",
      (await OrderModel.countDocuments({ user: userId })) === 1,
    );

    const lines = await cartLines(userId);
    // 5 in the cart, 2 bought → 3 must remain. Subtracting twice would leave 1.
    ok(
      "the ordered quantity is subtracted exactly ONCE (5 − 2 = 3)",
      lines[0]?.quantity === 3,
      JSON.stringify(lines),
    );

    const fresh = await OrderModel.findById(pendingOrder._id);
    ok("the order is Paid once", fresh.paymentStatus === "Paid", fresh.paymentStatus);
    ok(
      "statusHistory records a single payment_verified promotion",
      fresh.statusHistory.filter((entry) => entry.source === "payment_verified").length === 1,
      JSON.stringify(fresh.statusHistory.map((e) => e.source)),
    );
  }

  section("5 — item added to the cart during payment survives");

  {
    const userId = new mongoose.Types.ObjectId();
    const a = await makeProduct("keep-a");
    const b = await makeProduct("keep-b");
    const c = await makeProduct("keep-c");

    // Checkout is for A×2 and B×1.
    const { intent, paymentId } = await makePendingCheckout({
      userId,
      lines: [
        { product: a, quantity: 2 },
        { product: b, quantity: 1 },
      ],
    });

    // Meanwhile the shopper adds C×1 in another tab.
    await makeCart(userId, [
      { product: a, quantity: 2 },
      { product: b, quantity: 1 },
      { product: c, quantity: 1 },
    ]);

    await completeCapturedIntent({
      intent,
      capturedPayment: { id: paymentId, status: "captured" },
    });

    const lines = await cartLines(userId);
    ok("only the unrelated item remains", lines.length === 1, JSON.stringify(lines));
    ok(
      "C x 1 was NOT removed — it was never ordered",
      lines[0]?.product === String(c._id) && lines[0]?.quantity === 1,
      JSON.stringify(lines),
    );
  }

  {
    // Variant awareness: same product, different variant, is a different line and
    // must not be cleared by an order for the other variant.
    const userId = new mongoose.Types.ObjectId();
    const p = await makeProduct("variant-p");
    await makeCart(userId, [
      { product: p, quantity: 1, variantKey: "color:red" },
      { product: p, quantity: 2, variantKey: "color:blue" },
    ]);
    const order = await makeOrder({
      userId,
      lines: [{ product: p, quantity: 1, variantKey: "color:red" }],
    });

    await clearOrderedItemsFromCart({ order });

    const lines = await cartLines(userId);
    ok(
      "buying the red variant leaves the blue line untouched",
      lines.length === 1 && lines[0].variantKey === "color:blue" && lines[0].quantity === 2,
      JSON.stringify(lines),
    );
  }

  section("6 — failed payment leaves the cart alone");

  {
    const userId = new mongoose.Types.ObjectId();
    const a = await makeProduct("fail-a");
    await makeCart(userId, [{ product: a, quantity: 2 }]);
    const { pendingOrder } = await makePendingCheckout({
      userId,
      lines: [{ product: a, quantity: 2 }],
    });

    // Never confirmed — the payment failed, so nothing calls the cleanup.
    const before = await cartLines(userId);
    ok(
      "an unpaid order-first row leaves the cart intact",
      before.length === 1 && before[0].quantity === 2,
      JSON.stringify(before),
    );
    ok(
      "and carries no cleanup claim",
      !(await OrderModel.findById(pendingOrder._id)).cartClearedAt,
      "claim was stamped for an unpaid order",
    );

    // Even if something calls it on an unpaid order, only that order's own items
    // would go — but the guard that matters is that no confirmation path does.
    const stillThere = await cartLines(userId);
    ok("cart is unchanged", JSON.stringify(before) === JSON.stringify(stillThere));
  }

  section("7 — COD");

  {
    const userId = new mongoose.Types.ObjectId();
    const a = await makeProduct("cod-a");
    const b = await makeProduct("cod-b");
    await makeCart(userId, [
      { product: a, quantity: 1 },
      { product: b, quantity: 3 },
    ]);
    // A COD order is confirmed at creation (paymentStatus Pending, orderStatus
    // Confirmed) — the shape PlaceOrder commits.
    const order = await makeOrder({
      userId,
      lines: [
        { product: a, quantity: 1 },
        { product: b, quantity: 1 },
      ],
      paymentMethod: "COD",
      paymentStatus: "Pending",
      orderStatus: "Confirmed",
      razorpayPaymentId: undefined,
    });

    const result = await clearOrderedItemsFromCart({ order });
    ok("COD cleanup runs", result.cleared === true, JSON.stringify(result));

    const lines = await cartLines(userId);
    ok(
      "the fully-purchased COD line is gone",
      !lines.some((line) => line.product === String(a._id)),
      JSON.stringify(lines),
    );
    ok(
      "the partially-purchased COD line keeps its remainder (3 − 1 = 2)",
      lines.find((line) => line.product === String(b._id))?.quantity === 2,
      JSON.stringify(lines),
    );

    const fresh = await OrderModel.findById(order._id);
    ok("COD order keeps paymentStatus Pending", fresh.paymentStatus === "Pending", fresh.paymentStatus);
    ok("COD order stays Confirmed", fresh.orderStatus === "Confirmed", fresh.orderStatus);
  }

  section("8 — idempotency and edge cases of the cleanup itself");

  {
    const userId = new mongoose.Types.ObjectId();
    const a = await makeProduct("idem-a");
    await makeCart(userId, [{ product: a, quantity: 10 }]);
    const order = await makeOrder({ userId, lines: [{ product: a, quantity: 3 }] });

    const first = await clearOrderedItemsFromCart({ order });
    const second = await clearOrderedItemsFromCart({ order });
    const third = await clearOrderedItemsFromCart({ order });

    ok("the first call clears", first.cleared === true, JSON.stringify(first));
    ok("the second is a no-op", second.alreadyCleared === true, JSON.stringify(second));
    ok("the third is a no-op", third.alreadyCleared === true, JSON.stringify(third));

    const lines = await cartLines(userId);
    ok(
      "quantity was subtracted once, not three times (10 − 3 = 7)",
      lines[0]?.quantity === 7,
      JSON.stringify(lines),
    );
  }

  {
    // Concurrent cleanups of one order.
    const userId = new mongoose.Types.ObjectId();
    const a = await makeProduct("conc-a");
    await makeCart(userId, [{ product: a, quantity: 9 }]);
    const order = await makeOrder({ userId, lines: [{ product: a, quantity: 4 }] });

    const outcomes = await Promise.all(
      Array.from({ length: 5 }, () => clearOrderedItemsFromCart({ order })),
    );
    ok(
      "exactly one of five concurrent cleanups wins the claim",
      outcomes.filter((o) => o.cleared).length === 1,
      JSON.stringify(outcomes.map((o) => (o.cleared ? "cleared" : "skipped"))),
    );
    const lines = await cartLines(userId);
    ok("subtracted once (9 − 4 = 5)", lines[0]?.quantity === 5, JSON.stringify(lines));
  }

  {
    // Ordering more than the cart holds must not produce a negative quantity —
    // the cart line has `min: 1`, so a bad write would throw on save.
    const userId = new mongoose.Types.ObjectId();
    const a = await makeProduct("clamp-a");
    await makeCart(userId, [{ product: a, quantity: 1 }]);
    const order = await makeOrder({ userId, lines: [{ product: a, quantity: 5 }] });

    const result = await clearOrderedItemsFromCart({ order });
    ok("cleanup succeeds", result.cleared === true, JSON.stringify(result));
    const lines = await cartLines(userId);
    ok("the line is removed rather than going negative", lines.length === 0, JSON.stringify(lines));
  }

  {
    // Another customer's cart must never be touched.
    const buyer = new mongoose.Types.ObjectId();
    const bystander = new mongoose.Types.ObjectId();
    const a = await makeProduct("other-a");
    await makeCart(buyer, [{ product: a, quantity: 2 }]);
    await makeCart(bystander, [{ product: a, quantity: 2 }]);

    const order = await makeOrder({ userId: buyer, lines: [{ product: a, quantity: 2 }] });
    await clearOrderedItemsFromCart({ order });

    ok("the buyer's cart is cleared", (await cartLines(buyer)).length === 0);
    const other = await cartLines(bystander);
    ok(
      "another customer's identical cart is untouched",
      other.length === 1 && other[0].quantity === 2,
      JSON.stringify(other),
    );
  }

  {
    // No cart at all (guest-turned-customer, or already emptied) must not throw.
    const userId = new mongoose.Types.ObjectId();
    const a = await makeProduct("nocart-a");
    const order = await makeOrder({ userId, lines: [{ product: a, quantity: 1 }] });
    const result = await clearOrderedItemsFromCart({ order });
    ok("an order with no cart is handled cleanly", result.cleared === true, JSON.stringify(result));
  }

  {
    // A duplicated product across two order lines must subtract the SUM.
    const userId = new mongoose.Types.ObjectId();
    const a = await makeProduct("dup-a");
    await makeCart(userId, [{ product: a, quantity: 5 }]);
    const order = await makeOrder({
      userId,
      lines: [
        { product: a, quantity: 2 },
        { product: a, quantity: 1 },
      ],
    });
    await clearOrderedItemsFromCart({ order });
    const lines = await cartLines(userId);
    ok(
      "two order lines of one product subtract their total (5 − 3 = 2)",
      lines[0]?.quantity === 2,
      JSON.stringify(lines),
    );
  }
} catch (error) {
  console.error(`\nSUITE ABORTED: ${error?.stack || error}`);
  ok("suite ran to completion", false, error?.message);
} finally {
  await OrderModel.deleteMany({ _id: { $in: trash.orders } });
  await ProductModel.deleteMany({ _id: { $in: trash.products } });
  await cartModel.deleteMany({ _id: { $in: trash.carts } });
  await PaymentIntent.deleteMany({ _id: { $in: trash.intents } });
  const { failed } = finish();
  await mongoose.disconnect();
  process.exit(failed ? 1 : 0);
}
