/**
 * The coupon list a customer is SHOWN must agree with what checkout ACCEPTS.
 *
 * `GetAvailableCoupons` and `calculateCouponDiscount` both answer "may this customer
 * use this coupon?", and they answered it differently in two ways:
 *
 *  1. The list counted orders WITHOUT `EXCLUDE_AWAITING_PAYMENT`. A Razorpay order
 *     exists at paymentStatus "Pending" BEFORE the customer pays, so starting a
 *     checkout with a coupon and abandoning it at the gateway made the coupon look
 *     spent — permanently. The validator has always excluded those, so checkout
 *     would still have accepted the coupon the customer could no longer see.
 *
 *  2. The list hardcoded the allowance at 1 (`usage.count < 1`) rather than reading
 *     `maxLimit`, the per-user allowance. A coupon configured for two uses vanished
 *     after the first — the exact hardcoded-1 bug that had already been fixed in the
 *     validator, in a call site the fix missed.
 *
 * Both are the same failure: one rule written twice. The rule now lives in
 * `hasCouponAllowanceLeft` and both callers use it, so the assertion that matters
 * most here is the LAST section — list and checkout agreeing across every fixture.
 *
 * Run with `node test/regression/coupon-availability.regression.mjs` (or `npm test`).
 */
process.env.NOTIFICATIONS_ENABLED = "false";
process.env.SHIPROCKET_ENABLED = "false";

import mongoose from "mongoose";
import { addressFixture, connect, createSuite, marker, productFixture } from "./helpers.mjs";

const { ok, section, finish } = createSuite("coupon-availability");
await connect();

const CouponModel = (await import("../../src/modules/coupons/coupon.model.js")).default;
const CouponRedemption = (await import("../../src/modules/coupons/coupon-redemption.model.js")).default;
const OrderModel = (await import("../../src/modules/orders/Order.model.js")).default;
const ProductModel = (await import("../../src/modules/products/Product.model.js")).default;
const { GetAvailableCoupons } = await import("../../src/modules/coupons/coupon.controller.js");
const { calculateCouponDiscount, hasCouponAllowanceLeft } = await import(
  "../../src/modules/coupons/coupon.service.js"
);

const MARKER = marker("couponavail").toUpperCase().replace(/[^A-Z0-9]/g, "");
const trash = { coupons: [], orders: [], products: [] };
let seq = 0;

const userId = new mongoose.Types.ObjectId();

const makeProduct = async (overrides = {}) => {
  seq += 1;
  const product = await ProductModel.create(
    productFixture(`${MARKER}-${seq}`, { price: 500, stock: 20, ...overrides }),
  );
  trash.products.push(product._id);
  return product;
};

const makeCoupon = async (overrides = {}) => {
  seq += 1;
  const coupon = await CouponModel.create({
    couponId: `${MARKER}${seq}`,
    targetType: "all",
    discountType: "percentage",
    discountValue: 10,
    startDate: new Date(Date.now() - 86400000),
    expireDate: new Date(Date.now() + 86400000),
    maxLimit: 1,
    isActive: true,
    ...overrides,
  });
  trash.coupons.push(coupon._id);
  return coupon;
};

/** An order carrying a coupon. Defaults to a REAL, paid one. */
const makeOrder = async (couponId, overrides = {}) => {
  seq += 1;
  const order = await OrderModel.create({
    user: userId,
    items: [
      { product: new mongoose.Types.ObjectId(), name: `${MARKER} line`, price: 500, quantity: 1 },
    ],
    shippingAddress: addressFixture(),
    paymentMethod: "RAZORPAY",
    paymentStatus: "Paid",
    orderStatus: "Confirmed",
    coupon: couponId,
    subtotal: 500,
    totalAmount: 500,
    ...overrides,
  });
  trash.orders.push(order._id);
  return order;
};

/** An abandoned prepaid checkout: the row exists, no money ever moved. */
const makeAbandonedCheckout = (couponId) =>
  makeOrder(couponId, { paymentMethod: "RAZORPAY", paymentStatus: "Pending", orderStatus: "Pending" });

const listAvailable = async () => {
  let payload;
  const res = {
    status() { return this; },
    json(data) { payload = data; return this; },
  };
  await GetAvailableCoupons({ user: { id: String(userId) }, query: {} }, res);
  return (payload?.data || []).map((coupon) => String(coupon.couponId).toUpperCase());
};

const checkoutAccepts = async (coupon, product) => {
  try {
    await calculateCouponDiscount({
      couponId: coupon.couponId,
      userId,
      items: [{ product: String(product._id), quantity: 1 }],
      redeem: false,
    });
    return true;
  } catch {
    return false;
  }
};

try {
  const product = await makeProduct();

  // ================================================================

  section("an abandoned prepaid checkout does not spend the coupon");

  {
    const coupon = await makeCoupon();
    ok("a fresh coupon is offered", (await listAvailable()).includes(coupon.couponId));

    await makeAbandonedCheckout(coupon.couponId);
    ok(
      "still offered after the customer abandons a Razorpay checkout",
      (await listAvailable()).includes(coupon.couponId),
      "an unpaid RAZORPAY/Pending row is not a use",
    );
    ok(
      "and checkout still accepts it — the two agree",
      await checkoutAccepts(coupon, product),
    );
  }

  {
    const coupon = await makeCoupon();
    await makeOrder(coupon.couponId);
    ok(
      "a genuinely PAID order does spend it",
      !(await listAvailable()).includes(coupon.couponId),
    );
    ok(
      "and checkout refuses it — the two agree",
      !(await checkoutAccepts(coupon, product)),
    );
  }

  {
    // A COD order at Pending is real: the customer owes cash on delivery.
    const coupon = await makeCoupon();
    await makeOrder(coupon.couponId, { paymentMethod: "COD", paymentStatus: "Pending" });
    ok(
      "a COD order at Pending DOES spend the coupon",
      !(await listAvailable()).includes(coupon.couponId),
      "the exclusion is narrow: only prepaid-and-unpaid",
    );
  }

  section("maxLimit is the per-user allowance, in the list as well as at checkout");

  {
    const coupon = await makeCoupon({ maxLimit: 2 });
    await makeOrder(coupon.couponId);
    ok(
      "a 2-use coupon is still offered after ONE use",
      (await listAvailable()).includes(coupon.couponId),
      "the list used to hardcode the allowance at 1",
    );
    ok("and checkout still accepts it — the two agree", await checkoutAccepts(coupon, product));

    await makeOrder(coupon.couponId);
    ok(
      "a 2-use coupon is withdrawn after TWO uses",
      !(await listAvailable()).includes(coupon.couponId),
    );
    ok("and checkout refuses it — the two agree", !(await checkoutAccepts(coupon, product)));
  }

  {
    // The redemption counter and order history can disagree (the counter is
    // decremented on cancellation); the higher of the two is the honest usage.
    const coupon = await makeCoupon({ maxLimit: 2 });
    await CouponRedemption.create({ coupon: coupon.couponId, user: userId, count: 2 });
    ok(
      "the redemption counter alone can exhaust the allowance",
      !(await listAvailable()).includes(coupon.couponId),
    );
  }

  section("list and checkout agree on EVERY fixture — the invariant both bugs broke");

  {
    const cases = [
      { label: "unused", maxLimit: 1, paid: 0, abandoned: 0 },
      { label: "one abandoned checkout", maxLimit: 1, paid: 0, abandoned: 2 },
      { label: "one paid order", maxLimit: 1, paid: 1, abandoned: 0 },
      { label: "2-use, one paid", maxLimit: 2, paid: 1, abandoned: 1 },
      { label: "2-use, two paid", maxLimit: 2, paid: 2, abandoned: 0 },
      { label: "3-use, two paid", maxLimit: 3, paid: 2, abandoned: 3 },
    ];
    let allAgree = true;
    const disagreements = [];
    for (const testCase of cases) {
      const coupon = await makeCoupon({ maxLimit: testCase.maxLimit });
      for (let i = 0; i < testCase.paid; i += 1) await makeOrder(coupon.couponId);
      for (let i = 0; i < testCase.abandoned; i += 1) await makeAbandonedCheckout(coupon.couponId);

      const listed = (await listAvailable()).includes(coupon.couponId);
      const accepted = await checkoutAccepts(coupon, product);
      if (listed !== accepted) {
        allAgree = false;
        disagreements.push(`${testCase.label}: listed=${listed} accepted=${accepted}`);
      }
    }
    ok(
      `the list and the validator agree across all ${cases.length} fixtures`,
      allAgree,
      disagreements.join("; "),
    );
  }

  section("the shared allowance helper");

  {
    ok("one of two uses spent leaves allowance", hasCouponAllowanceLeft({ maxLimit: 2 }, 1, 0));
    ok("two of two spent leaves none", !hasCouponAllowanceLeft({ maxLimit: 2 }, 2, 0));
    ok(
      "order history outranks a lower counter",
      !hasCouponAllowanceLeft({ maxLimit: 1 }, 0, 1),
    );
    ok(
      "a missing maxLimit defaults to one use",
      !hasCouponAllowanceLeft({}, 0, 1),
    );
  }

  section("a coupon discounts the VARIANT's price, not the base product's");

  {
    // Same root cause as the charged price: a percentage OF a subtotal has to use
    // the subtotal the customer is actually charged, and minPurchaseAmount has to
    // compare against it too.
    const dearer = await makeProduct({
      price: 299,
      mrp: 350,
      stock: 5,
      variants: [
        { name: "Hardcover", attributes: { format: "Hardcover" }, price: 999, mrp: 1200, stock: 5, active: true },
      ],
    });
    const coupon = await makeCoupon({ discountType: "percentage", discountValue: 10 });
    const result = await calculateCouponDiscount({
      couponId: coupon.couponId,
      userId,
      items: [
        { product: String(dearer._id), quantity: 1, selectedVariants: { format: "Hardcover" } },
      ],
      redeem: false,
    });
    ok(
      "10% of a ₹999 variant is ₹100, not ₹30 off the ₹299 base",
      result.discount === 100,
      `discount=${result.discount} eligibleSubtotal=${result.eligibleSubtotal}`,
    );
  }
} finally {
  await CouponModel.deleteMany({ _id: { $in: trash.coupons } });
  await CouponRedemption.deleteMany({ coupon: new RegExp(MARKER, "i") });
  await OrderModel.deleteMany({ _id: { $in: trash.orders } });
  await ProductModel.deleteMany({ _id: { $in: trash.products } });
}

const leftovers =
  (await CouponModel.countDocuments({ couponId: new RegExp(MARKER) })) +
  (await OrderModel.countDocuments({ user: userId })) +
  (await ProductModel.countDocuments({ name: new RegExp(MARKER) }));
ok("every fixture this suite created is gone", leftovers === 0, `leftovers=${leftovers}`);

const summary = finish();
await mongoose.disconnect();
process.exit(summary.failed > 0 ? 1 : 0);
