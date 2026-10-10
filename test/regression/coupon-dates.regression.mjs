/**
 * A coupon must not be created with an expiry that has already passed.
 *
 * Nothing checked the dates against *now*, only expireDate >= startDate. So an admin could
 * save a coupon whose expiry was last week: it validated, appeared in the coupon list, and
 * then failed for every customer who typed it — because both GetAvailableCoupons and the
 * redemption path require startDate <= now <= expireDate. A coupon that cannot be redeemed
 * by anyone is never what the admin meant.
 *
 * The asymmetry between the two dates is the point of this suite, and it is not arbitrary —
 * it falls out of how each is parsed:
 *
 *   parseDate(expireDate, endOfDay = true)  ->  YYYY-MM-DD becomes 23:59:59.999 of that day
 *   parseDate(startDate)                    ->  YYYY-MM-DD becomes 00:00:00.000 of that day
 *
 * So "today" as an expiry is still in the future, while "today" as a start is already in the
 * past. Refusing a past start date would reject the most ordinary entry an admin can make,
 * and backdating a start is legitimate regardless: it means "live immediately".
 *
 * Run with `npm run test:coupon-dates` (or `npm test` for everything).
 */
process.env.NOTIFICATIONS_ENABLED = "false";
process.env.SHIPROCKET_ENABLED = "false";

import mongoose from "mongoose";
import { connect, createSuite, marker } from "./helpers.mjs";

const { ok, section, finish } = createSuite("coupon-dates");
await connect();

const CouponModel = (await import("../../src/modules/coupons/coupon.model.js")).default;
const couponController = await import("../../src/modules/coupons/coupon.controller.js");

const MARKER = marker("cpndate");
const trash = [];
let seq = 0;

const callController = async (handler, { body = {}, params = {}, user } = {}) => {
  let statusCode = 200;
  let payload;
  const res = {
    status(code) { statusCode = code; return this; },
    json(data) { payload = data; return this; },
  };
  await handler({ body, params, query: {}, user }, res);
  return { statusCode, body: payload };
};

const admin = { id: String(new mongoose.Types.ObjectId()), role: "admin" };

/**
 * `YYYY-MM-DD`, `days` from now, in the LOCAL calendar.
 *
 * Not toISOString(), which is UTC — the first draft of this suite used it and failed at 02:22
 * IST, because UTC was still the previous day and "today" therefore arrived as yesterday. The
 * admin frontend had exactly the same bug in its date helpers, which is how that got noticed:
 * a coupon expiring today loaded into the form as expiring yesterday.
 */
const dayOffset = (days) => {
  const date = new Date();
  date.setDate(date.getDate() + days);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
};

const YESTERDAY = dayOffset(-1);
const LAST_WEEK = dayOffset(-7);
const TODAY = dayOffset(0);
const NEXT_WEEK = dayOffset(7);

const create = (overrides = {}) => {
  seq += 1;
  return callController(couponController.AdminCreateCoupon, {
    user: admin,
    body: {
      couponId: `${MARKER}${seq}`.toUpperCase(),
      discountType: "percentage",
      discountValue: 10,
      startDate: TODAY,
      expireDate: NEXT_WEEK,
      maxLimit: 1,
      ...overrides,
    },
  });
};

const trackCreated = async (couponId) => {
  const stored = await CouponModel.findOne({ couponId: String(couponId).toUpperCase() });
  if (stored) trash.push(stored._id);
  return stored;
};

// ================================================================

section("an expiry already in the past is refused");

{
  const result = await create({ startDate: LAST_WEEK, expireDate: YESTERDAY });
  ok(
    "a coupon expiring yesterday is refused",
    result.statusCode >= 400,
    `${result.statusCode} ${JSON.stringify(result.body?.message)}`,
  );
  ok(
    "the message explains it could never be redeemed",
    /never be redeemed/i.test(result.body?.message || ""),
    result.body?.message,
  );
  ok(
    "and points at the Active toggle as the way to end a coupon early",
    /active toggle/i.test(result.body?.message || ""),
    result.body?.message,
  );
  const stored = await CouponModel.countDocuments({ couponId: new RegExp(MARKER, "i") });
  ok("nothing was written", stored === 0, String(stored));
}

section("a past START date is still allowed — it means 'live now'");

{
  // The case that makes a naive "no past dates" rule wrong. This is also what an admin gets
  // by picking today in the date picker, because a date-only start parses to 00:00.
  const result = await create({ startDate: LAST_WEEK, expireDate: NEXT_WEEK });
  ok(
    "a coupon that started last week and runs for another week is accepted",
    result.statusCode === 200 || result.statusCode === 201,
    `${result.statusCode} ${JSON.stringify(result.body?.message)}`,
  );
  const stored = await trackCreated(`${MARKER}${seq}`);
  ok("and it was written", Boolean(stored), "not found");
  ok(
    "with the backdated start preserved rather than clamped to now",
    stored && stored.startDate < new Date(),
    String(stored?.startDate),
  );
}

{
  const result = await create({ startDate: TODAY, expireDate: TODAY });
  ok(
    "starting AND expiring today is accepted — the expiry is 23:59:59, still ahead",
    result.statusCode === 200 || result.statusCode === 201,
    `${result.statusCode} ${JSON.stringify(result.body?.message)}`,
  );
  const stored = await trackCreated(`${MARKER}${seq}`);
  ok(
    "and the expiry was stored as the end of the day, not midnight",
    stored && stored.expireDate.getHours() === 23,
    String(stored?.expireDate),
  );
}

section("an already-lapsed coupon stays editable");

{
  // Written directly, bypassing the controller, to represent a coupon that lapsed while it
  // sat in the database. Refusing every edit to such a row would make it uncorrectable
  // without first extending its expiry, which is not a reasonable thing to demand.
  seq += 1;
  const lapsed = await CouponModel.create({
    couponId: `${MARKER}LAPSED${seq}`.toUpperCase(),
    discountType: "percentage",
    discountValue: 10,
    startDate: new Date(Date.now() - 30 * 86400000),
    expireDate: new Date(Date.now() - 2 * 86400000),
    maxLimit: 1,
  });
  trash.push(lapsed._id);

  const renamed = await callController(couponController.AdminUpdateCoupon, {
    user: admin,
    params: { id: String(lapsed._id) },
    body: { discountValue: 15 },
  });
  ok(
    "editing a field other than the dates is allowed on a lapsed coupon",
    renamed.statusCode === 200,
    `${renamed.statusCode} ${JSON.stringify(renamed.body?.message)}`,
  );

  const extended = await callController(couponController.AdminUpdateCoupon, {
    user: admin,
    params: { id: String(lapsed._id) },
    body: { expireDate: NEXT_WEEK },
  });
  ok(
    "and its expiry can be extended into the future",
    extended.statusCode === 200,
    `${extended.statusCode} ${JSON.stringify(extended.body?.message)}`,
  );

  const pushedBack = await callController(couponController.AdminUpdateCoupon, {
    user: admin,
    params: { id: String(lapsed._id) },
    body: { expireDate: YESTERDAY },
  });
  ok(
    "but setting the expiry back into the past is refused",
    pushedBack.statusCode >= 400,
    `${pushedBack.statusCode} ${JSON.stringify(pushedBack.body?.message)}`,
  );
}

section("the frontend persists only the coupon CODE, never the money");

{
  // The applied coupon used to live only in Redux: POST /coupon/apply writes nothing and the
  // Cart model has no coupon field, so any reload silently dropped the shopper's discount.
  // The fix stores the CODE in localStorage and re-runs it through /coupon/apply once the cart
  // has loaded. These assertions pin the two properties that make that safe: nothing about
  // money is persisted (a stored rupee figure would outlive expiry, usage caps and basket
  // changes), and the restore path reuses the same server-validated thunk as a typed code.
  const { readFile } = await import("node:fs/promises");
  const cartSlice = await readFile(
    new URL("../../../kitab-shop-fe/src/store/cartSlice.js", import.meta.url),
    "utf8",
  );
  ok(
    "a successful apply stores the couponId",
    /saveStoredCouponCode\(action\.payload\?\.couponId\)/.test(cartSlice),
    "the fulfilled handler no longer persists the code",
  );
  ok(
    "no discount amount is ever written to storage",
    !/saveStoredCouponCode\([^)]*discount/i.test(cartSlice) &&
      !/setItem\([^)]*discount/i.test(cartSlice),
    "something persists a discount figure",
  );
  ok(
    "a rejected apply clears the stored code, so a dead code is not retried forever",
    /applyCoupon\.rejected[\s\S]{0,200}clearStoredCouponCode\(\)/.test(cartSlice),
    "the rejected handler does not clear storage",
  );
  ok(
    "restoreCoupon re-validates through the applyCoupon thunk — no second pricing path",
    /restoreCoupon[\s\S]{0,1500}dispatch\(applyCoupon\(code\)\)/.test(cartSlice),
    "restore does not go through applyCoupon",
  );

  const app = await readFile(
    new URL("../../../kitab-shop-fe/src/App.jsx", import.meta.url),
    "utf8",
  );
  ok(
    "the restore waits for the cart — /coupon/apply prices against the basket",
    /fetchCart\(\)\)\.then\(\(\) => dispatch\(restoreCoupon\(\)\)\)/.test(app),
    "App.jsx does not sequence restoreCoupon after fetchCart",
  );
}

// ---------------------------------------------------------------- cleanup

await CouponModel.deleteMany({ _id: { $in: trash } });
await CouponModel.deleteMany({ couponId: new RegExp(MARKER, "i") });
const leftovers = await CouponModel.countDocuments({ couponId: new RegExp(MARKER, "i") });
ok("every fixture this suite created is gone", leftovers === 0, `leftovers=${leftovers}`);

const summary = finish();
await mongoose.disconnect();
process.exit(summary.failed > 0 ? 1 : 0);
