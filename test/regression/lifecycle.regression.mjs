/**
 * The five flow changes:
 *   1. Razorpay order-first — created Pending, promoted to Paid on verification
 *   2. RTO branches explicitly into Razorpay-refund-owed vs COD-no-refund
 *   3. Customer resolution (refund/replace) separated from inventory disposition
 *   4. COD payout confirmation separated from gateway confirmation
 *   5. Atomic claims / idempotency preserved on every new path
 *
 * Run with `npm run test:lifecycle` (or `npm test`).
 */
import mongoose from "mongoose";
import { readFile } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { addressFixture, connect, createSuite, marker, productFixture } from "./helpers.mjs";

const { ok, section, finish } = createSuite("lifecycle");
await connect();

const OrderModel = (await import("../../src/modules/orders/Order.model.js")).default;
const ProductModel = (await import("../../src/modules/products/Product.model.js")).default;
const ReturnModel = (await import("../../src/modules/returns/return.model.js")).default;
const PaymentIntent = (await import("../../src/modules/payments/PaymentIntent.model.js")).default;
const StockReservation = (await import("../../src/model/StockReservation.model.js")).default;
const { ORDER_STATUS_TRANSITIONS, canTransitionOrderStatus } = await import(
  "../../src/modules/orders/order-status.rules.js"
);
const {
  AWAITING_PAYMENT_MATCH,
  EXCLUDE_AWAITING_PAYMENT,
  isAwaitingPayment,
} = await import("../../src/modules/orders/order-visibility.js");
const {
  recordRefundObligation,
  recomputeRefundState,
  sumOwedRefunds,
  sumRefunded,
  sumSettledRefunds,
} = await import("../../src/modules/payments/return-refund.service.js");
const { restockReturnedItems, restockRtoOrder } = await import(
  "../../src/modules/inventory/restock.service.js"
);
const { cancelAbandonedCheckouts } = await import(
  "../../src/modules/inventory/stock-reservation-cleanup.service.js"
);
const { isStockEnforced } = await import("../../src/config/features.config.js");

const MARKER = marker("life");
const trash = { orders: [], products: [], returns: [], intents: [] };
let seq = 0;

const makeOrder = async (fields = {}) => {
  seq += 1;
  const order = await OrderModel.create({
    user: new mongoose.Types.ObjectId(),
    items: [{ product: new mongoose.Types.ObjectId(), name: `${MARKER} line`, price: 1000, quantity: 1 }],
    shippingAddress: addressFixture(),
    paymentMethod: "RAZORPAY",
    // Set per-fixture where a paid order is needed; omitted (not "") otherwise, so
    // the UNIQUE+sparse index is exercised the way production does.
    razorpayPaymentId: fields.paymentStatus === "Pending" ? undefined : `pay_${MARKER}_${seq}`,
    subtotal: 1000,
    totalAmount: 1000,
    ...fields,
  });
  trash.orders.push(order._id);
  return order;
};

try {
  // ══ 1. ORDER-FIRST ═════════════════════════════════════════════════════════
  section("1. A prepaid order starts Pending and is promoted on verification");

  const pending = await makeOrder({
    paymentStatus: "Pending",
    orderStatus: "Pending",
    razorpayOrderId: `order_${MARKER}_p`,
    paymentExpiresAt: new Date(Date.now() + 20 * 60 * 1000),
  });
  ok("a prepaid order can exist at Pending/Pending", pending.paymentStatus === "Pending" && pending.orderStatus === "Pending");
  ok("isAwaitingPayment identifies it", isAwaitingPayment(pending) === true);
  // Regression for the collision this suite caught: razorpayPaymentId is
  // UNIQUE + sparse, and sparse skips ABSENT fields only — a stored "" is indexed,
  // so a second unpaid order would have failed with E11000 and taken checkout down.
  ok(
    "an unpaid order stores NO payment id, not an empty string",
    pending.razorpayPaymentId === undefined,
    JSON.stringify(pending.razorpayPaymentId),
  );
  ok(
    'writing "" to either Razorpay id normalises to undefined',
    (() => {
      const probe = new OrderModel({ razorpayPaymentId: "", razorpayOrderId: "" });
      return probe.razorpayPaymentId === undefined && probe.razorpayOrderId === undefined;
    })(),
  );
  ok("Pending → Confirmed is a legal promotion", canTransitionOrderStatus("Pending", "Confirmed").ok === true);
  ok("Pending → Cancelled is legal (the sweeper's move)", canTransitionOrderStatus("Pending", "Cancelled").ok === true);

  // A COD order at Pending is REAL and must never be excluded.
  const codPending = await makeOrder({
    paymentMethod: "COD",
    paymentStatus: "Pending",
    orderStatus: "Confirmed",
  });
  ok("a COD order awaiting collection is NOT treated as awaiting payment", isAwaitingPayment(codPending) === false);

  const visible = await OrderModel.countDocuments({
    _id: { $in: [pending._id, codPending._id] },
    ...EXCLUDE_AWAITING_PAYMENT,
  });
  ok("the filter hides the unpaid prepaid order but keeps the COD one", visible === 1, String(visible));

  // The promotion is a compare-and-swap.
  const promote = () =>
    OrderModel.findOneAndUpdate(
      { _id: pending._id, paymentStatus: "Pending" },
      { $set: { paymentStatus: "Paid", orderStatus: "Confirmed", paymentExpiresAt: null } },
      { returnDocument: "after" },
    );
  const races = await Promise.all([promote(), promote(), promote(), promote()]);
  ok(
    "4 concurrent promotions: exactly 1 wins (verify + webhook arriving together)",
    races.filter(Boolean).length === 1,
    String(races.filter(Boolean).length),
  );
  const promoted = await OrderModel.findById(pending._id);
  ok("the promoted order is Paid/Confirmed", promoted.paymentStatus === "Paid" && promoted.orderStatus === "Confirmed");
  ok("it is now visible to the filter", isAwaitingPayment(promoted) === false);
  ok("paymentExpiresAt is cleared so the sweeper cannot touch it", promoted.paymentExpiresAt === null);

  // ── the customer's own history is a BOUNDED response ───────────────────────
  section("1a. GetMyOrders is capped");

  {
    // It returned every order a customer had ever placed, with every line item
    // populated. Realistically small, but "realistically small" is an assumption
    // about data rather than a guarantee. The cap bounds the worst case; the Orders
    // page still paginates client-side within whatever it is given.
    const { GetMyOrders } = await import("../../src/modules/orders/order.controller.js");
    const shopper = new mongoose.Types.ObjectId();
    for (let i = 0; i < 5; i += 1) {
      trash.orders.push((await makeOrder({ user: shopper, paymentStatus: "Paid" }))._id);
    }

    const call = async (query) => {
      let payload;
      const res = { status() { return this; }, json(data) { payload = data; return this; } };
      await GetMyOrders({ user: { id: String(shopper) }, query }, res);
      return payload;
    };

    const capped = await call({ limit: "2" });
    ok("the limit is honoured", capped.orders.length === 2, String(capped.orders.length));
    ok(
      "but `total` still reports the true count, not the page size",
      capped.total === 5,
      String(capped.total),
    );
    ok("and `returned` says how many came back", capped.returned === 2, String(capped.returned));

    const uncapped = await call({});
    ok("no limit returns everything under the default", uncapped.orders.length === 5, String(uncapped.orders.length));

    const absurd = await call({ limit: "999999" });
    ok(
      "a limit above the maximum is clamped, not obeyed",
      absurd.limit === 1000,
      String(absurd.limit),
    );
    // A negative parses truthy, so it survives the `|| DEFAULT` and is clamped by the
    // Math.max floor instead — 1, not 200. Asserted rather than "fixed" because
    // GetAllOrders has used this exact expression for as long as it has existed, and
    // two limit parsers behaving differently is worse than one behaving oddly. Both
    // answers are bounded, which is all this cap has to guarantee.
    const nonsense = await call({ limit: "-4" });
    ok("a negative limit is floored to 1, never unbounded", nonsense.limit === 1, String(nonsense.limit));
    const garbage = await call({ limit: "abc" });
    ok("an unparseable limit falls back to the default", garbage.limit === 200, String(garbage.limit));
  }

  // ── the safeguard: every aggregate over orders must exclude unpaid ones ─────
  section("1b. Every revenue query excludes unpaid checkouts");

  const srcDir = "src";
  const walk = async (dir) => {
    const out = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...(await walk(full)));
      else if (entry.name.endsWith(".js")) out.push(full);
    }
    return out;
  };
  const files = await walk(srcDir);

  // Files allowed to query orders without the filter, with the reason.
  const EXEMPT = new Set([
    "src/modules/orders/order-visibility.js", // defines it
    "src/modules/inventory/stock-reservation-cleanup.service.js", // sweeps exactly these
    "src/modules/inventory/restock.service.js", // by _id
    "src/modules/returns/return.controller.js", // by _id
    "src/modules/payments/return-refund.service.js", // by _id
    "src/modules/payments/payment.controller.js", // by _id / razorpayOrderId
    "src/modules/payments/payment-order.service.js", // guarded; by _id
    "src/modules/shipping/shipping.controller.js", // by _id / awb
    "src/modules/orders/order.controller.js", // guarded; rest are by _id
    "src/modules/orders/order-shipping.service.js", // by _id
    "src/modules/reviews/review.controller.js", // ownership check by _id
    "src/modules/coupons/coupon.service.js", // guarded
    // Matches refunds.status "owed" first, which is STRICTER than the filter:
    // recordRefundObligation only writes an owed row when money was collected, and an
    // awaiting-payment checkout is paymentStatus "Pending". Proved by fixture in
    // closed-owed-refunds.regression.mjs rather than argued here.
    "src/modules/payments/owed-refund.controller.js",
    // Every query filters `paymentMethod: "COD"`, which is disjoint from the excluded
    // shape (RAZORPAY + Pending) — so the exclusion is satisfied by construction and
    // adding it would be dead. Order-visibility says so itself: "A COD order at Pending
    // is genuinely real ... the filter excludes only the prepaid-and-unpaid case."
    // Proved by fixture in cod-reconciliation.regression.mjs, not argued here.
    "src/modules/admin/cod-reconciliation.service.js",
  ]);

  const unguarded = [];
  for (const file of files) {
    const src = await readFile(file, "utf8");
    // Aggregates and counts are the dangerous shapes: they produce totals.
    //
    // `distinct` is here because it was missing, and GetAvailableCoupons used it to
    // ask "which coupons has this customer spent?" — an unguarded question that
    // counted abandoned prepaid checkouts and hid the coupon from the customer for
    // good. It produces a set rather than a total, but it drives a decision off the
    // orders collection just the same, which is what this sweep is actually for.
    const risky =
      /Order(?:Model)?\.aggregate\(/.test(src) ||
      /Order(?:Model)?\.countDocuments\(/.test(src) ||
      /Order(?:Model)?\.distinct\(/.test(src);
    if (!risky) continue;
    if (src.includes("EXCLUDE_AWAITING_PAYMENT")) continue;
    if (EXEMPT.has(file)) continue;
    unguarded.push(file);
  }
  ok(
    "no unreviewed file aggregates or counts orders without the exclusion",
    unguarded.length === 0,
    unguarded.join(", "),
  );

  const reportSrc = await readFile("src/modules/admin/admin-report.service.js", "utf8");
  const guardCount = (reportSrc.match(/EXCLUDE_AWAITING_PAYMENT/g) || []).length - 1; // minus the import
  ok(
    "all 5 revenue queries in admin-report are guarded",
    guardCount === 5,
    `found ${guardCount}`,
  );
  ok(
    "the coupon allowance check excludes unpaid checkouts",
    (await readFile("src/modules/coupons/coupon.service.js", "utf8")).includes("EXCLUDE_AWAITING_PAYMENT"),
  );
  ok(
    "the referral first-order check excludes unpaid checkouts (both paths)",
    (await readFile("src/modules/payments/payment-order.service.js", "utf8")).includes("EXCLUDE_AWAITING_PAYMENT") &&
      (await readFile("src/modules/orders/order.controller.js", "utf8")).includes("EXCLUDE_AWAITING_PAYMENT"),
  );
  const authSrc = await readFile("src/modules/auth/auth.controller.js", "utf8");
  ok(
    "referral signup coupons are shared by email/password and Google first-signup paths",
    (authSrc.match(/createReferralSignupCoupon\(\{ user \}\)/g) || []).length === 2,
  );
  ok(
    "invalid referral codes are rejected before auth rows are created",
    /const referredByForNewUser = isNewUser[\s\S]{0,500}await findReferrerByCode\(req\.body\?\.referralCode\)[\s\S]{0,500}if \(!user\) \{[\s\S]{0,500}UserModel\.create\(\{/.test(authSrc) &&
      /const referredBy = await findReferrerByCode\(referralCode\);[\s\S]{0,500}const hashedPassword[\s\S]{0,500}UserModel\.create\(\{/.test(authSrc),
  );
  ok(
    "Google signup validation accepts the optional referral code field",
    (await readFile("src/modules/auth/auth.schema.js", "utf8")).includes("referralCode: boundedString"),
  );
  ok(
    "Google referral signup records attribution before creating the signup coupon",
    authSrc.indexOf("referredBy,") < authSrc.indexOf("createReferralSignupCoupon({ user })"),
  );
  ok(
    "customer referral stats include admin-configured reward settings",
    (await readFile("src/modules/profiles/profile.controller.js", "utf8")).includes("ReferralSetting.getSettings()"),
  );
  ok(
    "customer referral stats self-heal existing profiles with missing referral codes",
    (await readFile("src/modules/profiles/profile.controller.js", "utf8")).includes("ensureReferralCode(profile)"),
  );
  ok(
    "customer referral stats distinguish signups from first-order rewards",
    (await readFile("src/modules/profiles/profile.controller.js", "utf8")).includes("totalReferralSignups") &&
      (await readFile("../kitab-shop-fe/src/store/referralSlice.js", "utf8")).includes("pendingWalletCredit"),
  );
  ok(
    "customer referral stats return the referred user's unused signup discount coupon",
    (await readFile("src/modules/profiles/profile.controller.js", "utf8")).includes("signupDiscountCoupon") &&
      // The page shows the code and offers to copy it. Case-insensitive: the button's
      // wording follows the storefront's sentence-case style, which is not the feature.
      /signupDiscountCoupon\.couponId/.test(await readFile("../kitab-shop-fe/src/pages/Referral.jsx", "utf8")) &&
      /copy coupon/i.test(await readFile("../kitab-shop-fe/src/pages/Referral.jsx", "utf8")),
  );
  ok(
    "the customer Refer & Earn page uses backend settings rather than only hard-coded constants",
    (await readFile("../kitab-shop-fe/src/pages/Referral.jsx", "utf8")).includes("selectReferralSettings"),
  );
  ok(
    "pendingOrder is a SEPARATE field from storeOrder (preserves the double-charge guard)",
    (await readFile("src/modules/payments/PaymentIntent.model.js", "utf8")).includes("pendingOrder") &&
      (await readFile("src/modules/payments/payment.controller.js", "utf8")).includes("intent.pendingOrder = pendingOrder._id"),
  );
  ok(
    "default policy pages are restored when the policy collection is empty",
    (await readFile("src/modules/policy/policy.controller.js", "utf8")).includes("ensureDefaultPolicies()") &&
      (await readFile("src/modules/policy/policy.controller.js", "utf8")).includes('slug: "privacy"') &&
      (await readFile("src/modules/policy/policy.controller.js", "utf8")).includes('slug: "refund"') &&
      (await readFile("src/modules/policy/policy.controller.js", "utf8")).includes('slug: "terms"'),
  );

  // ── the sweeper ────────────────────────────────────────────────────────────
  section("1c. Abandoned checkouts are closed out, not left Pending forever");

  const abandoned = await makeOrder({
    paymentStatus: "Pending",
    orderStatus: "Pending",
    razorpayOrderId: `order_${MARKER}_a`,
    paymentExpiresAt: new Date(Date.now() - 60_000),
  });
  const stillOpen = await makeOrder({
    paymentStatus: "Pending",
    orderStatus: "Pending",
    razorpayOrderId: `order_${MARKER}_b`,
    paymentExpiresAt: new Date(Date.now() + 600_000),
  });
  // The abandoned checkout's payment side, as CreateRazorpayOrder leaves it: an open
  // intent pointing at the order and an active stock hold. An empty hold is enough —
  // what is asserted is that the sweeper closes it, not how many units it held.
  const abandonedIntent = await PaymentIntent.create({
    user: abandoned.user,
    idempotencyKey: `${MARKER}-abandoned-key`,
    razorpayOrderId: abandoned.razorpayOrderId,
    amount: 100000,
    currency: "INR",
    items: [{ product: new mongoose.Types.ObjectId(), name: `${MARKER} line`, price: 1000, quantity: 1 }],
    shippingAddress: addressFixture(),
    subtotal: 1000,
    totalAmount: 1000,
    pendingOrder: abandoned._id,
  });
  trash.intents.push(abandonedIntent._id);
  const abandonedHold = await StockReservation.create({
    user: abandoned.user,
    paymentIntent: abandonedIntent._id,
    idempotencyKey: `${MARKER}-abandoned-key`,
    items: [],
    status: "active",
    // Still inside its own window, so only the checkout sweep can be what releases it.
    expiresAt: new Date(Date.now() + 600_000),
  });
  // Already moved on by another path but never had its paymentStatus fixed — the
  // sweeper's orderStatus condition must leave it alone.
  const movedOn = await makeOrder({
    paymentStatus: "Pending",
    orderStatus: "Cancelled",
    razorpayOrderId: `order_${MARKER}_c`,
    paymentExpiresAt: new Date(Date.now() - 60_000),
  });
  const sweptCount = await cancelAbandonedCheckouts({ limit: 50 });
  ok("the sweeper closes at least the expired one", sweptCount >= 1, String(sweptCount));
  const sweptOrder = await OrderModel.findById(abandoned._id);
  ok("an expired checkout becomes Cancelled", sweptOrder.orderStatus === "Cancelled", sweptOrder.orderStatus);
  ok("and Failed rather than Pending", sweptOrder.paymentStatus === "Failed", sweptOrder.paymentStatus);
  ok("with a reason recorded", Boolean(sweptOrder.cancellation?.details));
  ok("and a history entry naming the sweeper", sweptOrder.statusHistory.at(-1)?.source === "abandoned_checkout_sweeper");
  ok(
    'cancelledBy is "system", not the customer',
    sweptOrder.cancellation?.cancelledBy === "system",
    sweptOrder.cancellation?.cancelledBy,
  );
  {
    const intentAfter = await PaymentIntent.findById(abandonedIntent._id);
    ok(
      "its payment intent is expired, so RetryRazorpayOrder can no longer reopen it",
      intentAfter?.status === "expired",
      intentAfter?.status,
    );
    const holdAfter = await StockReservation.findById(abandonedHold._id);
    ok(
      "its stock hold is released straight away, not left to its own expiry",
      holdAfter?.status === "released",
      holdAfter?.status,
    );
  }
  {
    const movedOnAfter = await OrderModel.findById(movedOn._id);
    ok(
      "an order no longer at Pending is not rewritten by the sweeper",
      movedOnAfter.paymentStatus === "Pending" &&
        !movedOnAfter.statusHistory.some((entry) => entry.source === "abandoned_checkout_sweeper"),
      `${movedOnAfter.orderStatus}/${movedOnAfter.paymentStatus}`,
    );
  }
  ok(
    "a checkout still inside its window is untouched",
    (await OrderModel.findById(stillOpen._id)).orderStatus === "Pending",
  );
  ok(
    "a promoted (paid) order is never swept",
    (await OrderModel.findById(pending._id)).orderStatus === "Confirmed",
  );

  // ══ 2. RTO ═════════════════════════════════════════════════════════════════
  section("2. RTO branches into Razorpay-refund-owed vs COD-no-refund");

  ok('"RTO Received" is a real order status', ORDER_STATUS_TRANSITIONS["RTO Received"] !== undefined);
  ok("RTO → RTO Received is legal", canTransitionOrderStatus("RTO", "RTO Received").ok === true);
  // "Cancelled" was removed from the RTO rows: no endpoint could ever perform
  // that move, and the dead dropdown option read as "cancellation is broken".
  // An RTO ends through its own close-out (RTO Received → Closed).
  ok("RTO Received → Closed closes it out", canTransitionOrderStatus("RTO Received", "Closed").ok === true);
  ok("RTO Received → Cancelled is refused (dead transition removed)", canTransitionOrderStatus("RTO Received", "Cancelled").ok === false);
  ok("RTO Received → Delivered is refused", canTransitionOrderStatus("RTO Received", "Delivered").ok === false);
  ok(
    "NDR can still be reattempted (not forced straight to RTO)",
    canTransitionOrderStatus("NDR", "Out For Delivery").ok === true &&
      canTransitionOrderStatus("NDR", "Delivered").ok === true,
  );

  // The status map and the courier pipeline moved out of the controller (shared by the
  // webhook and the reconciler); the properties are checked where the code now lives.
  const statusMapSrc = await readFile("src/modules/shipping/shipment-status-map.js", "utf8");
  const pipelineSrc = await readFile("src/modules/shipping/courier-event.service.js", "utf8");
  const arrivalCheck = statusMapSrc.indexOf('isRtoReceived(statusCode, text)) return "RTO Received"');
  ok(
    'the webhook maps RTO-arrival to "RTO Received" before the generic RTO test',
    arrivalCheck !== -1 && arrivalCheck < statusMapSrc.indexOf("return to origin/i.test"),
  );
  ok("the webhook no longer restocks blind on arrival", !pipelineSrc.includes("restockRtoOrder"));
  ok("it records a refund obligation instead", pipelineSrc.includes("recordRtoRefundObligation(order)"));

  // Prepaid RTO: a refund is owed.
  const prepaidRto = await makeOrder({ paymentStatus: "Paid", orderStatus: "RTO" });
  const owedResult = await recordRefundObligation({
    order: prepaidRto,
    amount: 1000,
    reason: "Parcel returned to origin undelivered",
    dedupeKey: `RTO ${prepaidRto._id}`,
  });
  ok("a prepaid RTO records a refund obligation", owedResult.created === true);
  ok('the ledger row is "owed", not "processed"', owedResult.refund.status === "owed");
  ok("it is confirmed by the gateway, not a human", owedResult.refund.confirmationMethod === "gateway");
  let reread = await OrderModel.findById(prepaidRto._id);
  ok('the order reads "Refund Pending" — owed but not moved', reread.paymentStatus === "Refund Pending", reread.paymentStatus);
  ok("the owed amount is visible as a liability", sumOwedRefunds(reread) === 1000);
  ok("owed money counts toward the refund ceiling", sumRefunded(reread) === 1000);
  ok("but NOT toward settled money", sumSettledRefunds(reread) === 0);

  const repeat = await recordRefundObligation({
    order: reread,
    amount: 1000,
    reason: "Parcel returned to origin undelivered",
    dedupeKey: `RTO ${prepaidRto._id}`,
  });
  ok("a replayed courier event records NO second liability", repeat.created === false);
  ok("the owed total is still 1000", sumOwedRefunds(await OrderModel.findById(prepaidRto._id)) === 1000);

  // COD RTO: nothing is owed, because nothing was collected.
  const codRto = await makeOrder({
    paymentMethod: "COD",
    paymentStatus: "Pending",
    orderStatus: "RTO",
  });
  const codOwed = await recordRefundObligation({
    order: codRto,
    amount: 1000,
    reason: "Parcel returned to origin undelivered",
    dedupeKey: `RTO ${codRto._id}`,
  });
  // The caller gates on money-collected; assert the end state is right either way.
  const codAfter = await OrderModel.findById(codRto._id);
  ok(
    "a COD RTO records NO refund obligation — the customer never paid",
    codOwed.created === false && codOwed.noMoneyCollected === true,
    JSON.stringify(codOwed),
  );
  ok(
    "and the order stays at Pending, not Refund Pending",
    codAfter.paymentStatus === "Pending",
    codAfter.paymentStatus,
  );
  ok("nothing is owed on it", sumOwedRefunds(codAfter) === 0);
  // The guard is in the invariant, not just the caller — so a future call site
  // cannot reintroduce refunding an unpaid COD customer.
  const unpaidProbe = await makeOrder({
    paymentMethod: "COD",
    paymentStatus: "Pending",
    orderStatus: "Delivered",
  });
  const refusedDirect = await recordRefundObligation({
    order: unpaidProbe,
    amount: 500,
    reason: "direct call bypassing the caller's check",
    dedupeKey: `PROBE ${unpaidProbe._id}`,
    confirmationMethod: "manual",
  });
  ok(
    "recordRefundObligation itself refuses an unpaid order",
    refusedDirect.created === false && refusedDirect.noMoneyCollected === true,
  );
  ok(
    "a COD order that WAS collected can be owed a refund",
    (await recordRefundObligation({
      order: await makeOrder({
        paymentMethod: "COD",
        paymentStatus: "Paid",
        orderStatus: "Delivered",
      }),
      amount: 500,
      reason: "collected COD return",
      dedupeKey: `PROBE-PAID ${Date.now()}`,
      confirmationMethod: "manual",
    })).created === true,
  );

  // ══ 3. DISPOSITION ═════════════════════════════════════════════════════════
  section("3. Resolution and inventory disposition are independent");

  const dispProduct = await ProductModel.create(productFixture(`${MARKER} disp`, { stock: 5 }));
  trash.products.push(dispProduct._id);
  const dispOrder = await makeOrder({
    items: [{ product: dispProduct._id, name: dispProduct.name, price: 500, quantity: 2 }],
    orderStatus: "Delivered",
  });

  const makeReturn = async (disposition) => {
    const r = await ReturnModel.create({
      order: dispOrder._id,
      user: new mongoose.Types.ObjectId(),
      product: dispProduct._id,
      productSnapshot: { name: dispProduct.name, price: 500 },
      quantity: 2,
      reason: "faulty",
      refundAmount: 1000,
      resolutionType: "refund",
      status: "received",
      disposition,
    });
    trash.returns.push(r._id);
    return r;
  };

  if (isStockEnforced()) {
    const before = (await ProductModel.findById(dispProduct._id)).stock;

    const damaged = await makeReturn("damaged");
    const damagedRestocked = await restockReturnedItems({ returnRequest: damaged });
    ok("a DAMAGED return restocks nothing", damagedRestocked === 0, String(damagedRestocked));
    ok(
      "the faulty unit stays off the shelf",
      (await ProductModel.findById(dispProduct._id)).stock === before,
    );

    await ReturnModel.deleteOne({ _id: damaged._id });
    const resellable = await makeReturn("resellable");
    const resellableRestocked = await restockReturnedItems({ returnRequest: resellable });
    ok("a RESELLABLE return restocks", resellableRestocked === 2, String(resellableRestocked));
    ok(
      "stock went up by 2",
      (await ProductModel.findById(dispProduct._id)).stock === before + 2,
    );

    await ReturnModel.deleteOne({ _id: resellable._id });
    const blank = await makeReturn("");
    ok(
      "an unset disposition restocks nothing (no silent default)",
      (await restockReturnedItems({ returnRequest: blank })) === 0,
    );
  } else {
    ok("disposition restock is a no-op while stock enforcement is off", (await restockReturnedItems({ returnRequest: await makeReturn("resellable") })) === 0);
  }

  const returnSrc = await readFile("src/modules/returns/return.controller.js", "utf8");
  ok(
    "resolving a return REQUIRES an explicit disposition",
    returnSrc.includes("DISPOSITION_REQUIRED") && /"resellable", "damaged"/.test(returnSrc),
  );
  ok(
    "a write-off is reported out loud, not inferred from silence",
    returnSrc.includes("written off as damaged"),
  );

  // RTO disposition gates the RTO restock the same way.
  const rtoProduct = await ProductModel.create(productFixture(`${MARKER} rto`, { stock: 1 }));
  trash.products.push(rtoProduct._id);
  const rtoOrder = await makeOrder({
    items: [{ product: rtoProduct._id, name: rtoProduct.name, price: 500, quantity: 3, cancelledQuantity: 1 }],
    orderStatus: "RTO Received",
  });
  ok(
    "an RTO parcel recorded DAMAGED restocks nothing",
    (await restockRtoOrder({ orderId: rtoOrder._id, disposition: "damaged" })) === 0,
  );
  ok("stock unchanged", (await ProductModel.findById(rtoProduct._id)).stock === 1);
  if (isStockEnforced()) {
    ok(
      "an RTO parcel recorded RESELLABLE restocks the uncancelled units",
      (await restockRtoOrder({ orderId: rtoOrder._id, disposition: "resellable" })) === 2,
    );
    ok("stock went 1 → 3", (await ProductModel.findById(rtoProduct._id)).stock === 3);
    ok(
      "and a repeat is idempotent",
      (await restockRtoOrder({ orderId: rtoOrder._id, disposition: "resellable" })) === 0,
    );
  }

  const orderSrc = await readFile("src/modules/orders/order.controller.js", "utf8");
  ok("an RTO disposition endpoint exists", orderSrc.includes("export const RecordRtoDisposition"));
  ok(
    "it refuses an order that is not yet RTO Received",
    orderSrc.includes("NOT_RTO_RECEIVED"),
  );
  ok(
    "and refuses a second disposition",
    orderSrc.includes("DISPOSITION_ALREADY_RECORDED"),
  );

  // ══ 4. CONFIRMATION SEPARATION ═════════════════════════════════════════════
  section("4. COD payout confirmation is distinct from gateway confirmation");

  const refundSrc = await readFile("src/modules/payments/return-refund.service.js", "utf8");
  ok(
    "the gateway path is labelled gateway-confirmed",
    /confirmationMethod: "gateway"/.test(refundSrc),
  );
  ok(
    "the manual path is labelled manual-confirmed",
    /confirmationMethod: "manual"/.test(refundSrc),
  );
  ok(
    "a manual refund still requires a reference before it may read as processed",
    refundSrc.includes("MANUAL_REFUND_DETAILS_REQUIRED"),
  );

  const codPayout = await makeOrder({
    paymentMethod: "COD",
    paymentStatus: "Paid",
    orderStatus: "Delivered",
  });
  const payoutOwed = await recordRefundObligation({
    order: codPayout,
    amount: 400,
    reason: "COD return payout",
    dedupeKey: `COD-PAYOUT ${codPayout._id}`,
    confirmationMethod: "manual",
  });
  ok("a COD payout obligation is recorded as owed", payoutOwed.refund.status === "owed");
  ok("marked manual, so it lands in the human payout queue", payoutOwed.refund.confirmationMethod === "manual");
  ok("recorded against the manual provider", payoutOwed.refund.paymentProvider === "manual");
  reread = await OrderModel.findById(codPayout._id);
  ok('the order reads "Refund Pending" until the payout happens', reread.paymentStatus === "Refund Pending");
  ok("the liability is queryable", sumOwedRefunds(reread) === 400);

  // Settling it moves the order, and only then.
  reread.refunds[0].status = "processed";
  reread.refunds[0].providerRefundId = "UTR123456";
  reread.refunds[0].processedAt = new Date();
  const settledStatus = await recomputeRefundState(reread);
  ok('once the UTR is recorded the order is "Partially Refunded"', settledStatus === "Partially Refunded", settledStatus);
  ok("nothing remains owed", sumOwedRefunds(await OrderModel.findById(codPayout._id)) === 0);

  // ══ 5. ATOMICITY PRESERVED ═════════════════════════════════════════════════
  section("5. Atomic claims and idempotency survived the changes");

  // The claim filter is now parametrized (allowedStatuses) so the admin path
  // can also claim Packed; the atomicity contract is unchanged — the permitted
  // statuses live in the FILTER of a findOneAndUpdate, never a read-then-write.
  ok(
    "cancellation still claims the order status in the filter",
    /findOneAndUpdate\([\s\S]{0,80}_id: orderId,\s*orderStatus: \{ \$in: allowedStatuses \}/.test(orderSrc) &&
      /allowedStatuses = \["Pending", "Confirmed"\]/.test(orderSrc),
  );
  // The filter also carries orderStatus "Pending" (G1): an unpaid checkout that was
  // cancelled must not be promotable by a capture that lands afterwards, which the
  // paymentStatus condition alone allowed — the cancellation left it at "Pending".
  ok(
    "the order promotion is a CAS on paymentStatus AND orderStatus",
    (await readFile("src/modules/payments/payment-order.service.js", "utf8")).includes(
      '{ _id: currentIntent.pendingOrder, paymentStatus: "Pending", orderStatus: "Pending" }',
    ),
  );
  ok(
    "the return status change is still a CAS",
    returnSrc.includes("RETURN_STATUS_CONFLICT"),
  );
  ok(
    "the abandoned-checkout sweeper claims via a status filter",
    (await readFile("src/modules/inventory/stock-reservation-cleanup.service.js", "utf8")).includes(
      'paymentStatus: "Pending"',
    ),
  );
  ok(
    "webhook replay protection is still a unique index",
    (await readFile("src/modules/payments/WebhookEvent.model.js", "utf8")).includes("unique: true"),
  );
  ok(
    "refund obligations dedupe on a stable key",
    refundSrc.includes("refund.reason === dedupeKey"),
  );
  ok(
    "AWAITING_PAYMENT_MATCH names only the prepaid-unpaid case",
    AWAITING_PAYMENT_MATCH.paymentMethod === "RAZORPAY" && AWAITING_PAYMENT_MATCH.paymentStatus === "Pending",
  );
} finally {
  await Promise.all([
    OrderModel.deleteMany({ _id: { $in: trash.orders } }),
    ProductModel.deleteMany({ _id: { $in: trash.products } }),
    ReturnModel.deleteMany({ _id: { $in: trash.returns } }),
    PaymentIntent.deleteMany({ _id: { $in: trash.intents } }),
    StockReservation.deleteMany({ idempotencyKey: new RegExp(`^${MARKER}`) }),
  ]);
  await mongoose.disconnect();
}

section("the admin warning about customer cancellation is true");

{
  // The admin order page warns, before a status change, that it removes the customer's
  // ability to cancel. That warning is only worth showing if it matches the real gate, and
  // the real gate lives in CancelOrder on the server while the warning reads a mirrored list
  // in the frontend. Asserted from source so the two cannot drift into a warning that is
  // false — which would be worse than no warning at all.
  const controller = await readFile(
    new URL("../../src/modules/orders/order.controller.js", import.meta.url),
    "utf8",
  );
  const rules = await readFile(
    new URL("../../../kitab-shop-fe/src/features/admin-orders/orderStatus.rules.js", import.meta.url),
    "utf8",
  );

  const serverGate = controller.match(
    /order\.orderStatus !== "(\w+)" && order\.orderStatus !== "(\w+)"/,
  );
  ok(
    "the server still gates customer cancellation on exactly two statuses",
    Boolean(serverGate),
    "CancelOrder's status gate no longer has the shape this assertion reads",
  );

  const mirror = rules.match(/CUSTOMER_CANCELLABLE_STATUSES = \[([^\]]*)\]/);
  ok(
    "the admin UI mirrors that list",
    Boolean(mirror) &&
      Boolean(serverGate) &&
      mirror[1].includes(`"${serverGate[1]}"`) &&
      mirror[1].includes(`"${serverGate[2]}"`),
    JSON.stringify({ server: serverGate?.slice(1, 3), mirror: mirror?.[1]?.trim() }),
  );
  ok(
    "and the mirror claims nothing extra the server would refuse",
    Boolean(mirror) && (mirror[1].match(/"[^"]+"/g) || []).length === 2,
    mirror?.[1]?.trim(),
  );
}

const { failed } = finish();
process.exit(failed > 0 ? 1 : 0);
