/**
 * Money-path regression: refund accounting, wallet credit, webhook replay, and
 * the retry-orphaning fix.
 *
 * Covers audit items C-02, C-05, C-06, C-10, C-11, C-12, H-03, H-14, M-02.
 * Run with `npm run test:money` (or `npm test` for everything).
 */
import mongoose from "mongoose";
import { readFile } from "node:fs/promises";
import {
  addressFixture,
  connect,
  createSuite,
  marker,
  productFixture,
} from "./helpers.mjs";

const { ok, section, finish } = createSuite("money");
await connect();

const OrderModel = (await import("../../src/modules/orders/Order.model.js")).default;
const ProductModel = (await import("../../src/modules/products/Product.model.js")).default;
const CouponModel = (await import("../../src/modules/coupons/coupon.model.js")).default;
const CouponRedemption = (await import("../../src/modules/coupons/coupon-redemption.model.js")).default;
const PaymentIntent = (await import("../../src/modules/payments/PaymentIntent.model.js")).default;
const UserProfile = (await import("../../src/modules/profiles/UserProfile.model.js")).default;
const WebhookEvent = (await import("../../src/modules/payments/WebhookEvent.model.js")).default;
const {
  proportionalRefundAmount,
  proportionalWalletRefund,
  recomputeRefundState,
  restoreWalletCredit,
  sumRefunded,
  sumSettledRefunds,
} = await import("../../src/modules/payments/return-refund.service.js");
const { calculateCouponDiscount } = await import("../../src/modules/coupons/coupon.service.js");

const MARKER = marker("money");
const trash = { orders: [], products: [], coupons: [], couponIds: [], profiles: [], intents: [], events: [] };
let seq = 0;

const makeOrder = async (fields = {}) => {
  seq += 1;
  const order = await OrderModel.create({
    user: new mongoose.Types.ObjectId(),
    items: [
      { product: new mongoose.Types.ObjectId(), name: `${MARKER} line`, price: 1000, quantity: 1 },
    ],
    shippingAddress: addressFixture(),
    paymentMethod: "RAZORPAY",
    razorpayPaymentId: `pay_${MARKER}_${seq}`,
    subtotal: 1000,
    totalAmount: 1000,
    ...fields,
  });
  trash.orders.push(order._id);
  return order;
};

try {
  // ═══ C-12 / C-05: a status may never claim money that hasn't moved ═════════
  section("Refund status reflects the gateway, not our intentions (C-05, C-12)");

  const inflight = await makeOrder({ paymentStatus: "Paid" });
  inflight.refunds.push({
    paymentProvider: "razorpay",
    providerRefundId: `rfnd_${MARKER}_a`,
    amount: 1000,
    status: "created",
  });
  let status = await recomputeRefundState(inflight);
  ok('an in-flight refund reads "Refund Pending", never "Refunded"', status === "Refund Pending", status);
  ok("the in-flight amount still consumes the refund ceiling", sumRefunded(inflight) === 1000);
  ok("but does not count as settled", sumSettledRefunds(inflight) === 0);

  let doc = await OrderModel.findById(inflight._id);
  doc.refunds[0].status = "processed";
  doc.refunds[0].processedAt = new Date();
  status = await recomputeRefundState(doc);
  ok('refund.processed on the full amount → "Refunded"', status === "Refunded", status);

  doc = await OrderModel.findById(inflight._id);
  doc.refunds[0].status = "failed";
  doc.refunds[0].failureReason = "regression: gateway declined";
  status = await recomputeRefundState(doc);
  ok('refund.failed drops the order back out of "Refunded"', status === "Paid", status);
  ok("a failed refund frees its ceiling again", sumRefunded(doc) === 0);

  const partial = await makeOrder({ paymentStatus: "Paid" });
  partial.refunds.push({ amount: 400, status: "processed", processedAt: new Date() });
  ok(
    '400 settled of 1000 → "Partially Refunded"',
    (await recomputeRefundState(partial)) === "Partially Refunded",
  );
  doc = await OrderModel.findById(partial._id);
  doc.refunds.push({ amount: 600, status: "failed" });
  ok(
    'a failed second refund cannot promote it to "Refunded"',
    (await recomputeRefundState(doc)) === "Partially Refunded",
  );

  const cod = await makeOrder({ paymentMethod: "COD", razorpayPaymentId: "", paymentStatus: "Pending" });
  cod.refunds.push({ paymentProvider: "manual", amount: 100, status: "failed" });
  ok(
    'a COD order awaiting collection is never promoted to "Paid"',
    (await recomputeRefundState(cod)) === "Pending",
  );

  // ═══ C-10 / C-11: refunds are valued against what was PAID ════════════════
  section("Refunds are valued against what the customer paid (C-10, C-11)");

  ok(
    "a ₹100 coupon on a ₹1000 order refunds ₹450 for a ₹500 line, not ₹500",
    proportionalRefundAmount({ unitPrice: 500, quantity: 1, orderSubtotal: 1000, orderTotal: 900 }) === 450,
  );
  ok(
    "a total above subtotal cannot inflate the refund past the line price",
    proportionalRefundAmount({ unitPrice: 500, quantity: 1, orderSubtotal: 1000, orderTotal: 1200 }) === 500,
  );
  ok(
    "a zero subtotal falls back to the line value rather than dividing by zero",
    proportionalRefundAmount({ unitPrice: 500, quantity: 2, orderSubtotal: 0, orderTotal: 900 }) === 1000,
  );

  // ═══ H-03: the prepaid half comes back as wallet credit ════════════════════
  section("Wallet credit is returned as wallet credit (H-03)");

  const walletArgs = { unitPrice: 1000, quantity: 1, orderSubtotal: 1000 };
  ok(
    "the cash half and the wallet half add up to the goods value",
    proportionalRefundAmount({ ...walletArgs, orderTotal: 800 }) +
      proportionalWalletRefund({ ...walletArgs, walletDiscount: 200 }) === 1000,
  );
  ok(
    "half the order returns half the wallet",
    proportionalWalletRefund({ unitPrice: 500, quantity: 1, orderSubtotal: 1000, walletDiscount: 200 }) === 100,
  );

  const walletUser = new mongoose.Types.ObjectId();
  const profile = await UserProfile.create({ userid: walletUser, walletBalance: 0 });
  trash.profiles.push(profile._id);
  const walletOrder = await makeOrder({
    user: walletUser, subtotal: 1000, totalAmount: 800, walletDiscount: 200, paymentStatus: "Paid",
  });

  ok("₹200 of wallet credit is returned", (await restoreWalletCredit({ order: walletOrder, amount: 200 })) === 200);
  ok("the balance actually moved", (await UserProfile.findById(profile._id)).walletBalance === 200);
  ok("a repeat call credits nothing", (await restoreWalletCredit({ order: walletOrder, amount: 200 })) === 0);
  ok("and the balance did not double", (await UserProfile.findById(profile._id)).walletBalance === 200);

  const raceOrder = await makeOrder({
    user: walletUser, subtotal: 1000, totalAmount: 800, walletDiscount: 200, paymentStatus: "Paid",
  });
  const raced = await Promise.all(
    Array.from({ length: 5 }, () => restoreWalletCredit({ order: raceOrder, amount: 200 })),
  );
  const racedTotal = raced.reduce((a, b) => a + b, 0);
  ok("5 concurrent restores pay out ₹200 in total, not ₹1000", racedTotal === 200, `got ${racedTotal}`);

  const stepped = await makeOrder({
    user: walletUser, subtotal: 1000, totalAmount: 800, walletDiscount: 200, paymentStatus: "Paid",
  });
  const stepOne = await restoreWalletCredit({ order: stepped, amount: 120 });
  const stepTwo = await restoreWalletCredit({ order: stepped, amount: 200 });
  ok("a partial cancel returns ₹120", stepOne === 120, String(stepOne));
  ok("a later full cancel returns only the remaining ₹80", stepTwo === 80, String(stepTwo));

  // ═══ C-02: webhook replay guard ════════════════════════════════════════════
  section("A replayed webhook cannot reprocess a payment (C-02)");

  await WebhookEvent.syncIndexes();
  const indexes = await WebhookEvent.collection.indexes();
  ok(
    "the unique {provider,eventId} index exists in the database",
    indexes.some((i) => i.unique && i.key?.provider === 1 && i.key?.eventId === 1),
  );

  const raceEventId = `evt_${MARKER}_race`;
  const attempts = await Promise.allSettled(
    Array.from({ length: 5 }, () =>
      WebhookEvent.create({ provider: "razorpay", eventId: raceEventId, eventType: "payment.captured" }),
    ),
  );
  const winners = attempts.filter((a) => a.status === "fulfilled");
  winners.forEach((w) => trash.events.push(w.value._id));
  ok("5 concurrent deliveries of one event: exactly 1 wins", winners.length === 1, `${winners.length}`);
  ok(
    "the losers all fail with E11000, not some other error",
    attempts.filter((a) => a.status === "rejected").every((a) => a.reason?.code === 11000),
  );

  const releasable = `evt_${MARKER}_release`;
  const claim = await WebhookEvent.create({ provider: "razorpay", eventId: releasable });
  trash.events.push(claim._id);
  await WebhookEvent.deleteOne({ provider: "razorpay", eventId: releasable });
  const reclaim = await WebhookEvent.create({ provider: "razorpay", eventId: releasable });
  trash.events.push(reclaim._id);
  ok("releasing the claim lets a genuine retry reprocess", Boolean(reclaim._id));

  const controllerSource = await readFile("src/modules/payments/payment.controller.js", "utf8");
  const webhookBody = controllerSource.slice(controllerSource.indexOf("export const RazorpayWebhook"));
  const catchBody = webhookBody.slice(webhookBody.lastIndexOf("} catch (error) {"));
  ok("a processing failure answers 500, not 200", catchBody.includes("res.status(500)"));
  ok(
    "and releases the claim before answering, so Razorpay's retry is not swallowed",
    catchBody.includes("WebhookEvent.deleteOne") &&
      catchBody.indexOf("WebhookEvent.deleteOne") < catchBody.indexOf("res.status(500)"),
  );
  ok(
    "the claim is taken before any payment processing",
    webhookBody.indexOf("WebhookEvent.create") < webhookBody.indexOf("completeCapturedIntent"),
  );
  ok(
    "refund.processed and refund.failed are handled",
    webhookBody.includes('event === "refund.processed"') && webhookBody.includes('event === "refund.failed"'),
  );

  // ═══ H-14: a retry must not orphan a payment ═══════════════════════════════
  section("A payment on a superseded Razorpay order still resolves (H-14)");

  const intent = await PaymentIntent.create({
    user: new mongoose.Types.ObjectId(),
    idempotencyKey: `${MARKER}-intent`,
    razorpayOrderId: `order_${MARKER}_1`,
    amount: 50000,
    currency: "INR",
    items: [{ product: new mongoose.Types.ObjectId(), name: "x", price: 500, quantity: 1 }],
    shippingAddress: addressFixture(),
    subtotal: 500,
    totalAmount: 500,
  });
  trash.intents.push(intent._id);

  const retryTo = async (newId) => {
    if (intent.razorpayOrderId !== newId) {
      intent.previousRazorpayOrderIds = [
        ...new Set([...(intent.previousRazorpayOrderIds || []), intent.razorpayOrderId]),
      ];
    }
    intent.razorpayOrderId = newId;
    intent.retryCount += 1;
    await intent.save();
  };
  await retryTo(`order_${MARKER}_2`);
  await retryTo(`order_${MARKER}_3`);

  const byOrderId = (id) =>
    PaymentIntent.findOne({ $or: [{ razorpayOrderId: id }, { previousRazorpayOrderIds: id }] });
  ok(
    "a late capture on the FIRST (orphaned) id resolves to the intent",
    String((await byOrderId(`order_${MARKER}_1`))?._id) === String(intent._id),
  );
  ok(
    "a capture on the live id resolves",
    String((await byOrderId(`order_${MARKER}_3`))?._id) === String(intent._id),
  );
  ok("an unrelated order id resolves to nothing", (await byOrderId(`order_${MARKER}_x`)) === null);

  const verifyFn = controllerSource.slice(
    controllerSource.indexOf("export const VerifyRazorpayPayment"),
    controllerSource.indexOf("export const RetryRazorpayOrder"),
  );
  ok("verify accepts a superseded id", /previousRazorpayOrderIds: returnedOrderId/.test(verifyFn));
  ok(
    "verify signs against the id the payment was actually made on",
    /razorpayOrderId: returnedOrderId,\s*\n\s*razorpayPaymentId: paymentId/.test(verifyFn),
  );
  ok(
    "verify's belongs-to check accepts a superseded id",
    /knownOrderIds\.includes\(capturedPayment\.order_id\)/.test(verifyFn),
  );

  // ═══ M-02: coupon maxLimit is enforced, without breaking existing coupons ══
  section("Coupon maxLimit is the per-user allowance (M-02)");

  const product = await ProductModel.create(productFixture(`${MARKER} product`));
  trash.products.push(product._id);
  const items = [{ product: String(product._id), quantity: 1 }];

  let couponSeq = 0;
  const makeCoupon = async (maxLimit) => {
    couponSeq += 1;
    const coupon = await CouponModel.create({
      couponId: `RG${process.pid}C${couponSeq}`.toUpperCase().slice(0, 20),
      discountType: "fixed",
      discountValue: 50,
      startDate: new Date(Date.now() - 86_400_000),
      expireDate: new Date(Date.now() + 86_400_000),
      maxLimit,
      minPurchaseAmount: 0,
      targetType: "all",
      isActive: true,
    });
    trash.coupons.push(coupon._id);
    // The ID as well as the _id: redemption rows are keyed by couponId, and this
    // suite's coupons are named RG<pid>C<n> rather than after MARKER, so a
    // marker-based sweep silently matches nothing and leaks every row.
    trash.couponIds.push(coupon.couponId);
    return coupon;
  };

  const singleUse = await makeCoupon(1);
  const userA = new mongoose.Types.ObjectId();
  const useA1 = await calculateCouponDiscount({ couponId: singleUse.couponId, userId: userA, items, redeem: true });
  ok("maxLimit=1: the first use succeeds (unchanged behaviour)", useA1.discount === 50);
  let refusal = null;
  try {
    await calculateCouponDiscount({ couponId: singleUse.couponId, userId: userA, items, redeem: true });
  } catch (error) {
    refusal = error;
  }
  ok("maxLimit=1: the second use is refused", Boolean(refusal));
  ok(
    "maxLimit=1: with the familiar message, so existing coupons are unaffected",
    refusal?.message === "You have already used this coupon",
    refusal?.message,
  );

  const twiceUsable = await makeCoupon(2);
  const userB = new mongoose.Types.ObjectId();
  const useB1 = await calculateCouponDiscount({ couponId: twiceUsable.couponId, userId: userB, items, redeem: true });
  ok("maxLimit=2: 1 use remains after the first", useB1.remainingUses === 1, String(useB1.remainingUses));
  const useB2 = await calculateCouponDiscount({ couponId: twiceUsable.couponId, userId: userB, items, redeem: true });
  ok("maxLimit=2: the second use now succeeds (was silently refused)", useB2.discount === 50);
  refusal = null;
  try {
    await calculateCouponDiscount({ couponId: twiceUsable.couponId, userId: userB, items, redeem: true });
  } catch (error) {
    refusal = error;
  }
  ok("maxLimit=2: the third use is refused", Boolean(refusal));
  ok("maxLimit=2: the message names the limit", /maximum 2 times/.test(refusal?.message || ""), refusal?.message);
  ok(
    "the limit is per user — another customer gets the full allowance",
    (await calculateCouponDiscount({
      couponId: twiceUsable.couponId,
      userId: new mongoose.Types.ObjectId(),
      items,
      redeem: false,
    })).remainingUses === 2,
  );
  ok(
    "usage totals both redemptions",
    (await CouponModel.findById(twiceUsable._id)).usage === 2,
  );

  // ═══ C-01: cancelling a coupon order must not throw ════════════════════════
  section("A cancelled coupon order can decrement usage to zero (C-01)");

  const cancelCoupon = await makeCoupon(1);
  const userC = new mongoose.Types.ObjectId();
  await calculateCouponDiscount({ couponId: cancelCoupon.couponId, userId: userC, items, redeem: true });

  // The release, as executeOrderCancellation performs it: per-customer row first,
  // coupon total only if that row actually moved.
  const releaseOnce = async () => {
    const released = await CouponRedemption.updateOne(
      { coupon: cancelCoupon.couponId, user: userC, count: { $gte: 1 } },
      { $inc: { count: -1 } },
    );
    if (released.modifiedCount === 1) {
      await CouponModel.updateOne(
        { couponId: cancelCoupon.couponId, usage: { $gte: 1 } },
        { $inc: { usage: -1 } },
      );
    }
    return released;
  };

  const decremented = await releaseOnce();
  ok("the atomic decrement applies", decremented.modifiedCount === 1);
  const afterCancel = await CouponRedemption.findOne({ coupon: cancelCoupon.couponId, user: userC });
  ok("count reaches 0 without a ValidationError", afterCancel.count === 0);
  ok(
    "usage reaches 0 too",
    (await CouponModel.findById(cancelCoupon._id)).usage === 0,
    String((await CouponModel.findById(cancelCoupon._id)).usage),
  );
  const secondDecrement = await releaseOnce();
  ok("a repeated cancel cannot drive it negative", secondDecrement.modifiedCount === 0);
  ok(
    "and the coupon total is untouched by the repeated cancel",
    (await CouponModel.findById(cancelCoupon._id)).usage === 0,
  );
} finally {
  await Promise.all([
    OrderModel.deleteMany({ _id: { $in: trash.orders } }),
    ProductModel.deleteMany({ _id: { $in: trash.products } }),
    CouponModel.deleteMany({ _id: { $in: trash.coupons } }),
    // Keyed by couponId, so swept by the exact ids this suite minted — not by
    // MARKER, which these fixtures are deliberately not named after.
    CouponRedemption.deleteMany({ coupon: { $in: trash.couponIds } }),
    UserProfile.deleteMany({ _id: { $in: trash.profiles } }),
    PaymentIntent.deleteMany({ _id: { $in: trash.intents } }),
    WebhookEvent.deleteMany({ _id: { $in: trash.events } }),
  ]);
  await mongoose.disconnect();
}

const { failed } = finish();
process.exit(failed > 0 ? 1 : 0);
