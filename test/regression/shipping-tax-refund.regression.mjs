/**
 * Shipping and tax in refunds (audit H2-03).
 *
 * THE POLICY THIS SUITE ENFORCES
 *
 *   refundable on a RETURN            = subtotal + tax − discount   (shipping EXCLUDED)
 *   refundable on a FULL CANCELLATION = totalAmount                 (shipping INCLUDED)
 *
 * Tax follows the goods: it is levied on their value, so returning them reverses the
 * sale it was charged on. Keeping it both short-changes the customer and over-reports
 * the tax owed. Shipping does not follow the goods — on a return the parcel was
 * shipped and the courier paid, so outbound freight is not refunded. A cancellation
 * before dispatch is the opposite case: nothing shipped, so everything comes back,
 * including when the order is emptied one unit at a time.
 *
 * Before this change, `lineValue × min(1, total/subtotal)` discarded shipping AND tax
 * together, short-changing a full return by exactly max(0, shipping + tax − discount).
 *
 * Run with `npm run test:shipping-tax-refund` (or `npm test` for everything).
 *
 * Every expectation below is an explicit rupee figure. Orders are built with
 * shippingCharge/tax set directly, because prepareOrderData still hardcodes both to
 * 0 — the whole point of H2-03 is what happens the moment someone sets them.
 */
process.env.INVENTORY_ENFORCE_STOCK = "false";
process.env.NOTIFICATIONS_ENABLED = "false";
process.env.PAYMENTS_ENABLED = "false";
process.env.SHIPROCKET_ENABLED = "false";

import mongoose from "mongoose";
import { readFile } from "node:fs/promises";
import { connect, createSuite, marker, productFixture, addressFixture } from "./helpers.mjs";

const { ok, section, finish } = createSuite("shipping-tax-refund");
await connect();

const OrderModel = (await import("../../src/modules/orders/Order.model.js")).default;
const ProductModel = (await import("../../src/modules/products/Product.model.js")).default;
const ReturnModel = (await import("../../src/modules/returns/return.model.js")).default;
await import("../../src/modules/categories/Category.model.js");
const {
  proportionalRefundAmount,
  proportionalWalletRefund,
  sumRefunded,
} = await import("../../src/modules/payments/return-refund.service.js");
const returnController = await import("../../src/modules/returns/return.controller.js");
const orderController = await import("../../src/modules/orders/order.controller.js");

const MARKER = marker("shiptax");
const trash = { orders: [], products: [] };
let seq = 0;

const money = (n) => Math.round(n * 100) / 100;

const makeProduct = async (label, price) => {
  const product = await ProductModel.create(
    productFixture(`${MARKER}-${label}`, { price, stock: 500, returnPolicy: { kind: "return", windowDays: 90 } }),
  );
  trash.products.push(product._id);
  return product;
};

/** An order with shipping/tax actually populated. */
const makeOrder = async ({
  product,
  units,
  shipping = 0,
  tax = 0,
  coupon = 0,
  wallet = 0,
  orderStatus = "Delivered",
  paymentStatus = "Paid",
  userId = new mongoose.Types.ObjectId(),
}) => {
  seq += 1;
  const subtotal = product.price * units;
  const discount = coupon + wallet;
  const totalAmount = Math.max(0, subtotal + shipping + tax - discount);
  const order = await OrderModel.create({
    user: userId,
    items: [
      { product: product._id, name: product.name, image: "x.png", price: product.price, quantity: units },
    ],
    shippingAddress: addressFixture(),
    paymentMethod: "RAZORPAY",
    paymentStatus,
    orderStatus,
    ...(orderStatus === "Delivered" ? { deliveredAt: new Date() } : {}),
    subtotal,
    shippingCharge: shipping,
    tax,
    discount,
    couponDiscount: coupon,
    walletDiscount: wallet,
    totalAmount,
    razorpayPaymentId: `pay_${MARKER}_${seq}`,
  });
  trash.orders.push(order._id);
  return order;
};

/** The cash half a return would quote for `units` of this order's single line. */
const returnCash = (order, units) =>
  proportionalRefundAmount({
    unitPrice: order.items[0].price,
    quantity: units,
    orderSubtotal: order.subtotal,
    orderTotal: order.totalAmount,
    orderShippingCharge: order.shippingCharge,
  });

const returnWallet = (order, units) =>
  proportionalWalletRefund({
    unitPrice: order.items[0].price,
    quantity: units,
    orderSubtotal: order.subtotal,
    walletDiscount: order.walletDiscount,
  });

const callController = async (handler, { params = {}, body = {}, user }) => {
  let statusCode = 200;
  let payload;
  const res = {
    status(code) { statusCode = code; return this; },
    json(data) { payload = data; return this; },
  };
  await handler({ params, body, user, query: {} }, res);
  return { statusCode, body: payload };
};

const requestReturn = (order, product, quantity) =>
  callController(returnController.CreateReturnRequest, {
    body: { orderId: String(order._id), productId: String(product._id), quantity, reason: "Not as described" },
    user: { id: String(order.user), roles: [] },
  });

const partialCancel = (order, product, quantity) =>
  callController(orderController.PartialCancelOrder, {
    params: { orderId: String(order._id) },
    body: { productId: String(product._id), quantity, reason: "Damaged" },
    user: { id: String(new mongoose.Types.ObjectId()), roles: ["admin"] },
  });

const cancelOrder = (order) =>
  callController(orderController.CancelOrder, {
    params: { orderId: String(order._id) },
    body: { reason: "Ordered by mistake" },
    user: { id: String(order.user), roles: [] },
  });

const setStatus = (returnId, status) => ReturnModel.updateOne({ _id: returnId }, { $set: { status } });

try {
  // ═══════════════════════════════════════════════════════════════════════════
  section("the policy, as exact rupee arithmetic");

  {
    // subtotal 1000 (5 x 200), shipping 0, tax 0, discount 0, total 1000
    const order = { items: [{ price: 200 }], subtotal: 1000, totalAmount: 1000, shippingCharge: 0, walletDiscount: 0 };
    ok("zero shipping + zero tax: full return refunds 1000", returnCash(order, 5) === 1000, String(returnCash(order, 5)));
    ok("partial 2 of 5 refunds 400", returnCash(order, 2) === 400, String(returnCash(order, 2)));
    ok("single unit refunds 200", returnCash(order, 1) === 200, String(returnCash(order, 1)));
  }

  {
    // subtotal 1000, shipping 200, tax 0 => total 1200. Refundable = 1000.
    const order = { items: [{ price: 200 }], subtotal: 1000, totalAmount: 1200, shippingCharge: 200, walletDiscount: 0 };
    ok(
      "non-zero shipping: full return refunds 1000, NOT 1200 — shipping is kept",
      returnCash(order, 5) === 1000,
      String(returnCash(order, 5)),
    );
    ok("partial 2 of 5 refunds 400 (no shipping share)", returnCash(order, 2) === 400, String(returnCash(order, 2)));
  }

  {
    // subtotal 1000, shipping 0, tax 100 => total 1100. Refundable = 1100.
    const order = { items: [{ price: 200 }], subtotal: 1000, totalAmount: 1100, shippingCharge: 0, walletDiscount: 0 };
    ok(
      "non-zero tax: full return refunds 1100 — the tax comes back",
      returnCash(order, 5) === 1100,
      String(returnCash(order, 5)),
    );
    ok(
      "partial 2 of 5 refunds 440 = goods 400 + tax share 40",
      returnCash(order, 2) === 440,
      String(returnCash(order, 2)),
    );
  }

  {
    // subtotal 1000, shipping 200, tax 100 => total 1300. Refundable = 1100.
    const order = { items: [{ price: 200 }], subtotal: 1000, totalAmount: 1300, shippingCharge: 200, walletDiscount: 0 };
    ok(
      "shipping + tax: full return refunds 1100 = goods 1000 + tax 100",
      returnCash(order, 5) === 1100,
      String(returnCash(order, 5)),
    );
    ok(
      "the customer paid 1300 and keeps exactly the 200 shipping",
      money(1300 - returnCash(order, 5)) === 200,
      String(money(1300 - returnCash(order, 5))),
    );
    ok("partial 2 of 5 refunds 440", returnCash(order, 2) === 440, String(returnCash(order, 2)));
    ok("partial 1 of 5 refunds 220", returnCash(order, 1) === 220, String(returnCash(order, 1)));
    ok(
      "BEFORE this change it would have refunded only 1000 (the old min(1,...) cap)",
      returnCash(order, 5) - 1000 === 100,
    );
  }

  {
    // discount + shipping + tax together.
    // subtotal 1000, ship 200, tax 100, coupon 100, wallet 200 => total 1000.
    // Refundable cash = 1000 + 100 - 300 = 800. Wallet half = 200.
    const order = {
      items: [{ price: 200 }], subtotal: 1000, totalAmount: 1000,
      shippingCharge: 200, walletDiscount: 200,
    };
    ok("discount+shipping+tax: cash half is 800", returnCash(order, 5) === 800, String(returnCash(order, 5)));
    ok("wallet half is 200", returnWallet(order, 5) === 200, String(returnWallet(order, 5)));
    ok(
      "the two halves sum to 1000 = goods 1000 + tax 100 − coupon 100",
      money(returnCash(order, 5) + returnWallet(order, 5)) === 1000,
      String(money(returnCash(order, 5) + returnWallet(order, 5))),
    );
    ok(
      "customer outlay was 1200 (1000 cash + 200 credit) and keeps exactly 200 shipping",
      money(1200 - (returnCash(order, 5) + returnWallet(order, 5))) === 200,
    );
  }

  {
    // A discount larger than shipping+tax must not produce a negative base.
    // subtotal 1000, ship 50, tax 0, coupon 300 => total 750. Refundable = 700.
    const order = { items: [{ price: 200 }], subtotal: 1000, totalAmount: 750, shippingCharge: 50, walletDiscount: 0 };
    ok("discount exceeding shipping+tax: full return refunds 700", returnCash(order, 5) === 700, String(returnCash(order, 5)));
    ok("never negative", returnCash(order, 5) >= 0);
  }

  {
    // Degenerate inputs must stay safe.
    const zeroSub = { items: [{ price: 200 }], subtotal: 0, totalAmount: 0, shippingCharge: 0, walletDiscount: 0 };
    ok("zero subtotal falls back to the line value", returnCash(zeroSub, 1) === 200, String(returnCash(zeroSub, 1)));
    ok(
      "shipping larger than the total cannot go negative",
      proportionalRefundAmount({ unitPrice: 200, quantity: 1, orderSubtotal: 1000, orderTotal: 100, orderShippingCharge: 500 }) === 0,
    );
    ok(
      "a free item refunds nothing",
      proportionalRefundAmount({ unitPrice: 0, quantity: 3, orderSubtotal: 1000, orderTotal: 1000, orderShippingCharge: 0 }) === 0,
    );
    ok(
      "a line worth more than the whole subtotal is capped at the refundable base",
      proportionalRefundAmount({ unitPrice: 5000, quantity: 1, orderSubtotal: 1000, orderTotal: 1200, orderShippingCharge: 200 }) === 1000,
    );
  }

  section("multiple returns");

  {
    // subtotal 1000, ship 200, tax 100 => refundable 1100. Returns 2 + 2 + 1.
    const order = { items: [{ price: 200 }], subtotal: 1000, totalAmount: 1300, shippingCharge: 200, walletDiscount: 0 };
    const parts = [2, 2, 1].map((q) => returnCash(order, q));
    ok("2 units => 440", parts[0] === 440, String(parts[0]));
    ok("2 units => 440", parts[1] === 440, String(parts[1]));
    ok("1 unit  => 220", parts[2] === 220, String(parts[2]));
    ok(
      "three returns sum to 1100, exactly one full return",
      money(parts[0] + parts[1] + parts[2]) === 1100,
      String(money(parts[0] + parts[1] + parts[2])),
    );
    ok("and never reach the 1300 ceiling — the 200 shipping is never claimed", money(parts.reduce((a, b) => a + b, 0)) < 1300);
  }

  {
    // Rounding: 3 x 33.33 with shipping 49.99 and tax 9.01. Refundable = 109.00.
    // Per-unit shares cannot always sum exactly to the whole; what matters is that
    // the residue is sub-paisa-per-line and lands on the UNDER side.
    const order = { items: [{ price: 33.33 }], subtotal: 99.99, totalAmount: 158.99, shippingCharge: 49.99, walletDiscount: 0 };
    const full = returnCash(order, 3);
    const perUnit = returnCash(order, 1);
    const sequential = money(perUnit * 3);
    ok("one combined return refunds 109.00", full === 109, String(full));
    ok("each single unit refunds 36.33", perUnit === 36.33, String(perUnit));
    ok(
      "three separate returns sum to 108.99 — one paisa UNDER, never over",
      sequential === 108.99 && sequential <= full,
      `${sequential} vs ${full}`,
    );
    ok(
      "the residue is at most one paisa per line",
      money(full - sequential) <= 0.03,
      String(money(full - sequential)),
    );
  }

  section("cancellation still refunds shipping");

  {
    const product = await makeProduct("cancel-full", 200);
    const order = await makeOrder({ product, units: 5, shipping: 200, tax: 100, orderStatus: "Confirmed" });
    ok("the order total is 1300", order.totalAmount === 1300, String(order.totalAmount));

    const response = await cancelOrder(order);
    ok("the cancellation succeeds", response.statusCode === 200, `${response.statusCode} ${response.body?.message || ""}`);

    const fresh = await OrderModel.findById(order._id);
    ok(
      "a full cancellation refunds the WHOLE 1300, shipping and tax included",
      money(sumRefunded(fresh)) === 1300,
      String(money(sumRefunded(fresh))),
    );
    ok("one refund row", fresh.refunds.length === 1, String(fresh.refunds.length));
  }

  {
    // Cancelling every unit one at a time must cost the same as one full cancel.
    const product = await makeProduct("cancel-piecemeal", 200);
    const order = await makeOrder({ product, units: 3, shipping: 200, tax: 100, orderStatus: "Confirmed" });
    ok("total is 900", order.totalAmount === 900, String(order.totalAmount));

    // Simulates the gateway settling each refund, which is what moves the order to
    // "Partially Refunded". Needed because PartialCancelOrder gates its refund on
    // paymentStatus ∈ {Paid, Partially Refunded} and an UNSETTLED refund leaves the
    // order at "Refund Pending" — where a further partial cancellation silently
    // records nothing. That is a pre-existing bug unrelated to H2-03 (see the report);
    // settling here keeps this test measuring the shipping top-up rather than that.
    const settleRefunds = (orderId) =>
      OrderModel.updateOne(
        { _id: orderId },
        { $set: { "refunds.$[].status": "processed", paymentStatus: "Partially Refunded" } },
      );

    const first = await partialCancel(order, product, 1);
    ok("first unit cancels", first.statusCode === 200, `${first.statusCode} ${first.body?.message || ""}`);
    const afterFirst = await OrderModel.findById(order._id);
    // refundable = 600 + 100 = 700; one of three units => 233.33
    ok(
      "a mid-order partial cancellation refunds goods+tax only (233.33)",
      money(sumRefunded(afterFirst)) === 233.33,
      String(money(sumRefunded(afterFirst))),
    );
    ok("the order is still live", afterFirst.orderStatus === "Confirmed", afterFirst.orderStatus);

    await settleRefunds(order._id);
    await partialCancel(order, product, 1);
    const afterSecond = await OrderModel.findById(order._id);
    ok(
      "two units cancelled: 466.66 so far",
      money(sumRefunded(afterSecond)) === 466.66,
      String(money(sumRefunded(afterSecond))),
    );

    await settleRefunds(order._id);

    const last = await partialCancel(order, product, 1);
    ok("the last unit cancels", last.statusCode === 200, `${last.statusCode} ${last.body?.message || ""}`);
    const afterLast = await OrderModel.findById(order._id);
    ok("the order is now Cancelled", afterLast.orderStatus === "Cancelled", afterLast.orderStatus);
    ok(
      "cancelling the LAST unit tops the refund up to the full 900 — nothing shipped",
      money(sumRefunded(afterLast)) === 900,
      String(money(sumRefunded(afterLast))),
    );
    ok(
      "so piecemeal cancellation now costs the same as one full cancellation",
      money(sumRefunded(afterLast)) === 900,
    );
    ok("never over the ceiling", money(sumRefunded(afterLast)) <= afterLast.totalAmount + 0.01);
  }

  section("end to end through the real return controller");

  {
    const product = await makeProduct("e2e", 200);
    const order = await makeOrder({ product, units: 5, shipping: 200, tax: 100 });

    const first = await requestReturn(order, product, 2);
    ok("a 2-unit return is created", first.statusCode === 201, `${first.statusCode} ${first.body?.message || ""}`);
    ok(
      "quoting 440 = goods 400 + tax 40, shipping excluded",
      first.body?.data?.refundAmount === 440,
      String(first.body?.data?.refundAmount),
    );
    await setStatus(first.body.data._id, "refunded");

    const second = await requestReturn(order, product, 3);
    ok("the remaining 3 units are returnable", second.statusCode === 201, `${second.statusCode} ${second.body?.message || ""}`);
    ok("quoting 660", second.body?.data?.refundAmount === 660, String(second.body?.data?.refundAmount));

    ok(
      "the two returns together quote 1100 — the whole order minus shipping",
      money(440 + 660) === 1100,
    );
  }

  {
    // Wallet-funded order end to end.
    const product = await makeProduct("e2e-wallet", 200);
    const order = await makeOrder({ product, units: 5, shipping: 200, tax: 100, coupon: 100, wallet: 200 });
    ok("total charged is 1000", order.totalAmount === 1000, String(order.totalAmount));

    const response = await requestReturn(order, product, 5);
    ok("the full return is created", response.statusCode === 201, `${response.statusCode} ${response.body?.message || ""}`);
    ok("cash half quoted 800", response.body?.data?.refundAmount === 800, String(response.body?.data?.refundAmount));
    ok("wallet half quoted 200", response.body?.data?.walletRefundAmount === 200, String(response.body?.data?.walletRefundAmount));
    ok(
      "together 1000, keeping exactly the 200 shipping of a 1200 outlay",
      money(response.body.data.refundAmount + response.body.data.walletRefundAmount) === 1000,
    );
  }

  section("the ceiling still holds");

  {
    const product = await makeProduct("ceiling", 200);
    const order = await makeOrder({ product, units: 5, shipping: 200, tax: 100 });

    // Quote every unit, then confirm the total sits under totalAmount with the
    // shipping charge left unclaimed.
    const quotes = [2, 2, 1].map((q) => returnCash(order, q));
    const claimed = money(quotes.reduce((a, b) => a + b, 0));
    ok("all five units quote 1100 in total", claimed === 1100, String(claimed));
    ok("which is below the 1300 ceiling", claimed < order.totalAmount);
    ok(
      "leaving exactly the shipping charge unclaimed",
      money(order.totalAmount - claimed) === 200,
      String(money(order.totalAmount - claimed)),
    );

    // A return can never on its own exceed the order total.
    const absurd = proportionalRefundAmount({
      unitPrice: 1e9, quantity: 1e6, orderSubtotal: 1000, orderTotal: 1300, orderShippingCharge: 200,
    });
    ok("an absurd line is still capped at the refundable base", absurd === 1100, String(absurd));
  }

  section("zero shipping and tax: behaviour is byte-identical to before");

  {
    // The regression guard. Every existing order has shipping = tax = 0, and the
    // pre-H2-03 formula was lineValue × min(1, total/subtotal).
    const legacyFormula = ({ unitPrice, quantity, orderSubtotal, orderTotal }) => {
      const lineValue = unitPrice * quantity;
      const ratio = Math.min(1, Math.max(0, orderTotal / orderSubtotal));
      return Math.round(lineValue * ratio * 100) / 100;
    };

    const cases = [
      { unitPrice: 200, quantity: 5, orderSubtotal: 1000, orderTotal: 1000 },
      { unitPrice: 200, quantity: 2, orderSubtotal: 1000, orderTotal: 700 },
      { unitPrice: 33.33, quantity: 3, orderSubtotal: 99.99, orderTotal: 66.66 },
      { unitPrice: 0.01, quantity: 1, orderSubtotal: 0.03, orderTotal: 0.02 },
      { unitPrice: 499.5, quantity: 1, orderSubtotal: 999, orderTotal: 899 },
    ];
    const identical = cases.every(
      (c) => proportionalRefundAmount({ ...c, orderShippingCharge: 0 }) === legacyFormula(c),
    );
    ok(
      "with shipping = 0 the new formula matches the old one exactly, on every probe",
      identical,
      JSON.stringify(
        cases.map((c) => `${proportionalRefundAmount({ ...c, orderShippingCharge: 0 })} vs ${legacyFormula(c)}`),
      ),
    );
    ok(
      "so this change is inert on all existing orders",
      identical,
    );
  }

  section("an omitted shipping charge falls back to the conservative cap");

  {
    // The footgun this closes: if a caller does not say what the shipping charge
    // was, we cannot know how much of an excess over the subtotal is refundable.
    // Guessing "none of it is shipping" would refund freight by accident, so
    // omitting the parameter keeps the pre-H2-03 cap instead.
    const omitted = proportionalRefundAmount({
      unitPrice: 500, quantity: 1, orderSubtotal: 1000, orderTotal: 1200,
    });
    ok(
      "shipping omitted on a total above subtotal: capped at the line price (500)",
      omitted === 500,
      String(omitted),
    );

    const declaredZero = proportionalRefundAmount({
      unitPrice: 500, quantity: 1, orderSubtotal: 1000, orderTotal: 1200, orderShippingCharge: 0,
    });
    ok(
      "declaring shipping = 0 means the excess IS tax, so the line refunds 600",
      declaredZero === 600,
      String(declaredZero),
    );

    const declaredShipping = proportionalRefundAmount({
      unitPrice: 500, quantity: 1, orderSubtotal: 1000, orderTotal: 1200, orderShippingCharge: 200,
    });
    ok(
      "declaring shipping = 200 excludes it again, so the line refunds 500",
      declaredShipping === 500,
      String(declaredShipping),
    );
    ok(
      "so the tax-inclusive behaviour is OPT-IN and cannot happen by omission",
      omitted === 500 && declaredZero === 600,
    );

    for (const bad of [null, "", "abc", Number.NaN, undefined]) {
      ok(
        `a non-numeric shipping charge (${JSON.stringify(bad)}) also falls back to the cap`,
        proportionalRefundAmount({
          unitPrice: 500, quantity: 1, orderSubtotal: 1000, orderTotal: 1200, orderShippingCharge: bad,
        }) === 500,
      );
    }
  }

  section("both call sites pass the shipping charge");

  {
    // The one real footgun: orderShippingCharge defaults to 0, so a caller that
    // forgets it would silently refund the shipping. Asserted structurally rather
    // than trusted, in the style of the order-visibility guard in the lifecycle suite.
    const sources = {
      "returns/return.controller.js": "../../src/modules/returns/return.controller.js",
      "orders/order.controller.js": "../../src/modules/orders/order.controller.js",
    };
    for (const [label, relative] of Object.entries(sources)) {
      const source = await readFile(new URL(relative, import.meta.url), "utf8");
      const callCount = (source.match(/proportionalRefundAmount\(\{/g) || []).length;
      const shippingCount = (source.match(/orderShippingCharge:/g) || []).length;
      ok(
        `${label} passes orderShippingCharge at every call site (${callCount})`,
        callCount > 0 && shippingCount >= callCount,
        `${callCount} calls, ${shippingCount} with shipping`,
      );
    }

    const allSources = await Promise.all(
      Object.values(sources).map((relative) => readFile(new URL(relative, import.meta.url), "utf8")),
    );
    const totalCalls = allSources.reduce(
      (sum, source) => sum + (source.match(/proportionalRefundAmount\(\{/g) || []).length,
      0,
    );
    ok("exactly two call sites exist in total", totalCalls === 2, String(totalCalls));
  }
} catch (error) {
  console.error(`\nSUITE ABORTED: ${error?.stack || error}`);
  ok("suite ran to completion", false, error?.message);
} finally {
  await ReturnModel.deleteMany({ order: { $in: trash.orders } });
  await OrderModel.deleteMany({ _id: { $in: trash.orders } });
  await ProductModel.deleteMany({ _id: { $in: trash.products } });
  const { failed } = finish();
  await mongoose.disconnect();
  process.exit(failed ? 1 : 0);
}
