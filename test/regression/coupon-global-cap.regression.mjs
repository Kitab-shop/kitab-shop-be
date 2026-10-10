/**
 * A coupon's TOTAL redemption budget, across all customers.
 *
 * `maxLimit` has always been the PER-CUSTOMER allowance. There was no total cap of
 * any kind: `coupon.usage` counted redemptions and was compared to nothing, so
 * "first 100 customers" was not expressible and a code that leaked publicly stayed
 * redeemable until an admin noticed and deactivated it by hand. It was the last
 * uncapped money lever in checkout.
 *
 * The cap lives in the FILTER of the redemption update, not in a read-then-check, so
 * the assertion that matters most here is the concurrency one: several customers
 * racing for the last slot must produce exactly one winner. A read-then-check would
 * pass every other test in this file and fail that one.
 *
 * Also covers the move of per-customer counts out of the coupon's `usedBy` array and
 * into the CouponRedemption collection, which is what made `usage` trustworthy enough
 * to gate money on — it used to be recomputed from that array on every `.save()`, so
 * an ordinary admin edit rewrote it.
 *
 * Run with `node test/regression/coupon-global-cap.regression.mjs` (or `npm test`).
 */
process.env.NOTIFICATIONS_ENABLED = "false";
process.env.SHIPROCKET_ENABLED = "false";

import mongoose from "mongoose";
import { connect, createSuite, marker, productFixture } from "./helpers.mjs";

const { ok, section, finish } = createSuite("coupon-global-cap");
await connect();

const CouponModel = (await import("../../src/modules/coupons/coupon.model.js")).default;
const CouponRedemption = (await import("../../src/modules/coupons/coupon-redemption.model.js")).default;
const ProductModel = (await import("../../src/modules/products/Product.model.js")).default;
const { calculateCouponDiscount, globalCapReached } = await import(
  "../../src/modules/coupons/coupon.service.js"
);
const { GetAvailableCoupons } = await import("../../src/modules/coupons/coupon.controller.js");

const MARKER = marker("globalcap").toUpperCase().replace(/[^A-Z0-9]/g, "");
const trash = { coupons: [], products: [] };
let seq = 0;

const makeProduct = async () => {
  seq += 1;
  const product = await ProductModel.create(
    productFixture(`${MARKER}-${seq}`, { price: 500, stock: 100 }),
  );
  trash.products.push(product._id);
  return product;
};

const makeCoupon = async (overrides = {}) => {
  seq += 1;
  const coupon = await CouponModel.create({
    couponId: `${MARKER}${seq}`,
    targetType: "all",
    discountType: "fixed",
    discountValue: 50,
    startDate: new Date(Date.now() - 86400000),
    expireDate: new Date(Date.now() + 86400000),
    maxLimit: 1,
    isActive: true,
    ...overrides,
  });
  trash.coupons.push(coupon._id);
  return coupon;
};

const redeem = (coupon, product, userId) =>
  calculateCouponDiscount({
    couponId: coupon.couponId,
    userId,
    items: [{ product: String(product._id), quantity: 1 }],
    redeem: true,
  });

const usageOf = async (coupon) => (await CouponModel.findById(coupon._id)).usage;

try {
  const product = await makeProduct();

  // ================================================================

  section("the default is unlimited, so existing coupons are unaffected");

  {
    const coupon = await makeCoupon();
    ok("globalMaxRedemptions defaults to 0", coupon.globalMaxRedemptions === 0);
    ok("a 0 budget never reads as reached", !globalCapReached(coupon));

    for (let i = 0; i < 5; i += 1) {
      await redeem(coupon, product, new mongoose.Types.ObjectId());
    }
    ok("five different customers all redeem", (await usageOf(coupon)) === 5, String(await usageOf(coupon)));
  }

  section("a budget of N allows N redemptions and refuses the next");

  {
    const coupon = await makeCoupon({ globalMaxRedemptions: 3 });
    for (let i = 0; i < 3; i += 1) {
      await redeem(coupon, product, new mongoose.Types.ObjectId());
    }
    ok("the budget is exactly spent", (await usageOf(coupon)) === 3, String(await usageOf(coupon)));

    let refusal = null;
    try {
      await redeem(coupon, product, new mongoose.Types.ObjectId());
    } catch (error) {
      refusal = error;
    }
    ok("the fourth redemption is refused", Boolean(refusal));
    ok("with a 409, not a 400", refusal?.statusCode === 409, String(refusal?.statusCode));
    ok(
      "and the message names the limit",
      /redemption limit/i.test(refusal?.message || ""),
      refusal?.message,
    );
    ok("the refusal did not advance the counter", (await usageOf(coupon)) === 3, String(await usageOf(coupon)));
  }

  section("CONCURRENCY: racing for the last slot produces exactly one winner");

  {
    // The assertion the $expr-in-filter claim exists for. A read-then-check passes
    // every other test in this file and fails this one.
    const coupon = await makeCoupon({ globalMaxRedemptions: 1 });
    const attempts = await Promise.allSettled(
      Array.from({ length: 8 }, () => redeem(coupon, product, new mongoose.Types.ObjectId())),
    );
    const won = attempts.filter((a) => a.status === "fulfilled").length;
    ok("exactly one of 8 simultaneous redemptions succeeds", won === 1, `winners=${won}`);
    ok("and usage is 1, not 8", (await usageOf(coupon)) === 1, String(await usageOf(coupon)));
    ok(
      "the losers all report the cap",
      attempts
        .filter((a) => a.status === "rejected")
        .every((a) => /redemption limit/i.test(a.reason?.message || "")),
    );
    ok(
      "exactly one redemption row exists",
      (await CouponRedemption.countDocuments({ coupon: coupon.couponId })) === 1,
    );
  }

  section("a cancellation frees a slot, and a double release cannot free two");

  {
    const coupon = await makeCoupon({ globalMaxRedemptions: 1 });
    const userId = new mongoose.Types.ObjectId();
    await redeem(coupon, product, userId);
    ok("the only slot is spent", (await usageOf(coupon)) === 1);

    // Exactly what executeOrderCancellation does.
    const releaseOnce = async () => {
      const released = await CouponRedemption.updateOne(
        { coupon: coupon.couponId, user: userId, count: { $gte: 1 } },
        { $inc: { count: -1 } },
      );
      if (released.modifiedCount === 1) {
        await CouponModel.updateOne(
          { couponId: coupon.couponId, usage: { $gte: 1 } },
          { $inc: { usage: -1 } },
        );
      }
      return released.modifiedCount;
    };

    ok("the first release applies", (await releaseOnce()) === 1);
    ok("the slot is free again", (await usageOf(coupon)) === 0, String(await usageOf(coupon)));
    ok("a repeated release is a no-op", (await releaseOnce()) === 0);
    ok("and cannot drive usage negative", (await usageOf(coupon)) === 0, String(await usageOf(coupon)));

    await redeem(coupon, product, new mongoose.Types.ObjectId());
    ok("the freed slot is genuinely reusable", (await usageOf(coupon)) === 1);
  }

  section("the per-customer allowance still works, through the new collection");

  {
    const coupon = await makeCoupon({ maxLimit: 2, globalMaxRedemptions: 10 });
    const userId = new mongoose.Types.ObjectId();
    const first = await redeem(coupon, product, userId);
    ok("one use remains after the first", first.remainingUses === 1, String(first.remainingUses));
    await redeem(coupon, product, userId);

    let refusal = null;
    try {
      await redeem(coupon, product, userId);
    } catch (error) {
      refusal = error;
    }
    ok("the third use by that customer is refused", /maximum 2 times/.test(refusal?.message || ""), refusal?.message);
    ok("but the global budget still has room", (await usageOf(coupon)) === 2);
    ok(
      "so a different customer can still redeem",
      Boolean(await redeem(coupon, product, new mongoose.Types.ObjectId())),
    );
    ok(
      "one redemption row per customer, not one array entry",
      (await CouponRedemption.countDocuments({ coupon: coupon.couponId })) === 2,
    );
  }

  section("an exhausted coupon is hidden AND refused — the list/checkout invariant");

  {
    const userId = new mongoose.Types.ObjectId();
    const coupon = await makeCoupon({ globalMaxRedemptions: 1 });

    const listAvailable = async () => {
      let payload;
      const res = { status() { return this; }, json(data) { payload = data; return this; } };
      await GetAvailableCoupons({ user: { id: String(userId) }, query: {} }, res);
      return (payload?.data || []).map((row) => String(row.couponId).toUpperCase());
    };

    ok("offered while the budget has room", (await listAvailable()).includes(coupon.couponId));

    // Spent by somebody else entirely.
    await redeem(coupon, product, new mongoose.Types.ObjectId());

    ok("hidden once the budget is spent", !(await listAvailable()).includes(coupon.couponId));
    let refusal = null;
    try {
      await redeem(coupon, product, userId);
    } catch (error) {
      refusal = error;
    }
    ok("and checkout refuses it too — the two agree", Boolean(refusal));
  }

  section("admin edits no longer rewrite the redemption total");

  {
    // The pre("validate") hook used to recompute `usage` from `usedBy` on every save,
    // so an unrelated admin edit silently rewrote the number the budget is measured
    // against. That is why the cap could not rest on it before.
    const coupon = await makeCoupon({ globalMaxRedemptions: 5 });
    await redeem(coupon, product, new mongoose.Types.ObjectId());
    await redeem(coupon, product, new mongoose.Types.ObjectId());
    ok("two redemptions recorded", (await usageOf(coupon)) === 2);

    const fresh = await CouponModel.findById(coupon._id);
    fresh.discountValue = 75;
    await fresh.save();
    ok(
      "an admin edit leaves usage alone",
      (await usageOf(coupon)) === 2,
      String(await usageOf(coupon)),
    );
  }
} finally {
  await CouponRedemption.deleteMany({ coupon: new RegExp(MARKER, "i") });
  await CouponModel.deleteMany({ _id: { $in: trash.coupons } });
  await ProductModel.deleteMany({ _id: { $in: trash.products } });
}

const leftovers =
  (await CouponModel.countDocuments({ couponId: new RegExp(MARKER) })) +
  (await CouponRedemption.countDocuments({ coupon: new RegExp(MARKER, "i") })) +
  (await ProductModel.countDocuments({ name: new RegExp(MARKER) }));
ok("every fixture this suite created is gone", leftovers === 0, `leftovers=${leftovers}`);

const summary = finish();
await mongoose.disconnect();
process.exit(summary.failed > 0 ? 1 : 0);
