import mongoose from "mongoose";
import CouponModel from "./coupon.model.js";
import CouponRedemption from "./coupon-redemption.model.js";
import OrderModel from "../orders/Order.model.js";
import { EXCLUDE_AWAITING_PAYMENT } from "../orders/order-visibility.js";
import ProductModel from "../products/Product.model.js";
import { effectiveUnitPrice, findVariant, variantKeyFrom } from "../inventory/variant.service.js";

export const normalizeCouponId = (couponId = "") =>
  String(couponId || "").trim().toUpperCase();

export const couponError = (message, statusCode = 400) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
};

const getProductIdFromItem = (item = {}) =>
  item.product || item.productId || item.id || item._id;

const getQuantityFromItem = (item = {}) => Math.max(1, Number(item.quantity || item.qty || 1));

/**
 * The variant a cart line names, in the same canonical form the cart and the order
 * path use. Read here because a coupon is a percentage OF a subtotal, so the
 * subtotal has to be the one the customer will actually be charged.
 */
const getVariantKeyFromItem = (item = {}) =>
  item.variantKey || variantKeyFrom(item.selectedVariants);

/**
 * How many times this customer has already redeemed this coupon.
 *
 * An indexed lookup on CouponRedemption. This used to be a linear scan of the
 * coupon's `usedBy` array in application memory, which is what made that array's
 * unbounded growth a checkout-latency problem and not merely a storage one.
 */
export const redemptionCountFor = async ({ couponId, userId, session = null }) => {
  const query = CouponRedemption.findOne({
    coupon: normalizeCouponId(couponId),
    user: userId,
  }).select("count");
  if (session) query.session(session);
  const row = await query;
  return Number(row?.count || 0);
};

/**
 * THE per-user allowance rule, in one place.
 *
 * `maxLimit` is the PER-USER allowance (see calculateCouponDiscount below for why).
 * This was written out twice — here and in GetAvailableCoupons, which hardcoded the
 * limit at 1 — so a coupon configured for two uses was accepted by checkout and
 * simultaneously hidden from the customer's coupon list after the first. Two copies
 * of a rule is what let them disagree; one function is the fix.
 *
 * Both `redemptionCount` and `ordersWithCoupon` are passed in rather than queried,
 * because the two callers count them differently for good reason: checkout counts one
 * coupon for one customer, while the list counts every coupon for that customer in a
 * single query apiece.
 */
export const perUserCouponLimit = (coupon) => Math.max(1, Number(coupon?.maxLimit) || 1);

export const couponUsesRemaining = (coupon, redemptionCount = 0, ordersWithCoupon = 0) => {
  // Two independent records of the same usage: the redemption counter, and the
  // customer's live orders that carry the coupon. Each excludes what was handed
  // back (the counter is decremented, the order count skips
  // COUPON_RELEASED_ORDER_STATUSES), so the higher of the two is the honest usage —
  // and an RTO from before the release existed, whose counter was never
  // decremented, still counts through the counter.
  const used = Math.max(Number(redemptionCount) || 0, Number(ordersWithCoupon) || 0);
  return Math.max(0, perUserCouponLimit(coupon) - used);
};

export const hasCouponAllowanceLeft = (coupon, redemptionCount = 0, ordersWithCoupon = 0) =>
  couponUsesRemaining(coupon, redemptionCount, ordersWithCoupon) > 0;

/**
 * Whether the coupon's TOTAL budget across all customers is spent.
 *
 * Advisory only — it is what lets ApplyCoupon explain itself and what keeps an
 * exhausted coupon out of the customer's list. The authority is the conditional
 * update in the redeem branch below, which puts the same comparison in the filter so
 * concurrent redemptions against the last slot cannot both succeed.
 */
export const globalCapReached = (coupon) => {
  const cap = Number(coupon?.globalMaxRedemptions) || 0;
  if (cap <= 0) return false;
  return (Number(coupon?.usage) || 0) >= cap;
};

export const GLOBAL_CAP_MESSAGE = "This coupon has reached its redemption limit";

/**
 * Order statuses whose coupon use has been handed back to the customer.
 *
 * A cancelled order releases its redemption in the cancellation transaction, and
 * an RTO parcel received back releases it through releaseRtoOrderCredits ("RTO" is
 * included so the order does not briefly count while it is on its way back, and
 * "Closed" is only reachable from "RTO Received"). Neither order delivered
 * anything, so neither should spend the customer's allowance.
 *
 * POLICY: this is a deliberate change — before it, a customer whose earlier order
 * was cancelled still had that use counted against them by the order-history
 * cross-check, even though the redemption counter had been decremented. Both the
 * checkout validator and the customer's coupon list read this one list, so they
 * cannot disagree.
 */
export const COUPON_RELEASED_ORDER_STATUSES = ["Cancelled", "RTO", "RTO Received", "Closed"];

/**
 * Hands one order's coupon redemption back, at most once per order.
 *
 * The order's own `couponReleasedAt` is the claim: a conditional write moves it
 * from null, and only the caller that wins it decrements anything. Without the
 * claim, a cancellation and an RTO arrival — or a courier event and an admin's
 * manual move to "RTO Received" racing each other — could each decrement the
 * counter, freeing two slots against one real redemption.
 *
 * Per-customer count first, coupon total second, and the total moves ONLY if the
 * per-customer row actually did. Ordering it the other way, or moving the total
 * unconditionally, would let a double-release free two global slots against one
 * real redemption — which, with globalMaxRedemptions gating money, is the
 * difference between a budget of 100 and a budget of 101. The `$gte: 1` in each
 * filter keeps the decrement atomic and independent of the schema's `min`.
 *
 * Pass the caller's `session` to make the claim and both decrements part of its
 * transaction, so a rolled-back cancellation does not leave the coupon released.
 *
 * @returns {Promise<boolean>} true when this call released a redemption.
 */
export const releaseOrderCouponRedemption = async ({ orderId, session = null }) => {
  const options = session ? { session } : {};
  const claimed = await OrderModel.findOneAndUpdate(
    {
      _id: orderId,
      coupon: { $type: "string" },
      couponDiscount: { $gt: 0 },
      couponReleasedAt: null,
    },
    { $set: { couponReleasedAt: new Date() } },
    { ...options, projection: { coupon: 1, user: 1 } },
  );
  if (!claimed || !claimed.coupon) return false;

  const released = await CouponRedemption.updateOne(
    { coupon: claimed.coupon, user: claimed.user, count: { $gte: 1 } },
    { $inc: { count: -1 } },
    options,
  );
  if (released.modifiedCount !== 1) return false;

  await CouponModel.updateOne(
    { couponId: claimed.coupon, usage: { $gte: 1 } },
    { $inc: { usage: -1 } },
    options,
  );
  return true;
};

/**
 * How many live orders this user has already placed with this coupon.
 *
 * A COUNT rather than the old boolean: with maxLimit now enforced as the
 * per-user allowance, "has used it at all" would still cap every coupon at one
 * use regardless of what the admin configured.
 */
const countOrdersWithCoupon = async ({ couponId, userId, session }) => {
  const query = {
    user: userId,
    coupon: normalizeCouponId(couponId),
    paymentStatus: { $ne: "Failed" },
    // Cancelled and returned-to-origin orders handed their use back — see
    // COUPON_RELEASED_ORDER_STATUSES.
    orderStatus: { $nin: COUPON_RELEASED_ORDER_STATUSES },
    // An unpaid prepaid checkout is not a use. Without this, starting a Razorpay
    // checkout with a coupon and abandoning it would consume the customer's
    // allowance for a discount they never received.
    ...EXCLUDE_AWAITING_PAYMENT,
  };
  const lookup = OrderModel.countDocuments(query);
  if (session) lookup.session(session);
  return Number(await lookup) || 0;
};

const getCouponTargetType = (coupon) => {
  if ((!coupon.targetType || coupon.targetType === "all") && coupon.product_id && !coupon.category_id) {
    return "product";
  }
  if (coupon.targetType) return coupon.targetType;
  if (coupon.product_id) return "product";
  if (coupon.category_id) return "category";
  return "all";
};

const validateCouponDates = (coupon) => {
  const now = new Date();

  if (!coupon.isActive) {
    throw couponError("Coupon is not active");
  }

  if (coupon.startDate && coupon.startDate > now) {
    throw couponError("Coupon has not started yet");
  }

  if (coupon.expireDate && coupon.expireDate < now) {
    throw couponError("Coupon has expired");
  }
};

export const calculateCouponDiscount = async ({
  couponId,
  userId,
  items = [],
  redeem = false,
  session = null,
}) => {
  const normalizedCouponId = normalizeCouponId(couponId);
  if (!normalizedCouponId) {
    return { coupon: null, couponId: null, discount: 0, productId: null };
  }

  if (!mongoose.Types.ObjectId.isValid(userId)) {
    throw couponError("Invalid user for coupon");
  }

  const couponQuery = CouponModel.findOne({ couponId: normalizedCouponId });
  if (session) couponQuery.session(session);
  const coupon = await couponQuery;
  if (!coupon) {
    throw couponError("Invalid coupon code", 404);
  }

  validateCouponDates(coupon);

  if (coupon.assignedUser && String(coupon.assignedUser) !== String(userId)) {
    throw couponError("This coupon is assigned to another user");
  }

  // maxLimit is the PER-USER allowance. It was stored, editable in the admin UI,
  // reported on the coupons report — and read by nothing: the check here was
  // hardcoded to 1, so setting a coupon to "usable twice" had no effect at all.
  //
  // Read as per-user rather than as a global cap deliberately: the default is 1
  // and the hardcoded check it replaces was per-user, so every existing coupon
  // keeps exactly the behaviour it has today, while the two that are configured
  // for 2 uses start working as configured. A global cap would instead have
  // retroactively killed every coupon already used once.
  const perUserLimit = perUserCouponLimit(coupon);
  const redemptionCount = await redemptionCountFor({
    couponId: normalizedCouponId,
    userId,
    session,
  });
  // Cross-checked against real orders as well as the counter, because the counter
  // is decremented on cancellation while the order history is the durable fact.
  const ordersWithCoupon = await countOrdersWithCoupon({
    couponId: normalizedCouponId,
    userId,
    session,
  });
  if (!hasCouponAllowanceLeft(coupon, redemptionCount, ordersWithCoupon)) {
    throw couponError(
      perUserLimit === 1
        ? "You have already used this coupon"
        : `You have already used this coupon the maximum ${perUserLimit} times`,
    );
  }
  // The TOTAL budget, checked here as well as in the redeem filter below. This check
  // is what makes an exhausted coupon explain itself in ApplyCoupon and disappear
  // from the customer's list; the filter is what actually decides a race.
  if (globalCapReached(coupon)) {
    throw couponError(GLOBAL_CAP_MESSAGE, 409);
  }
  // Captured BEFORE the redeem branch below consumes one, so the figure reported back
  // to the caller does not count this redemption twice.
  const usesRemaining = couponUsesRemaining(coupon, redemptionCount, ordersWithCoupon);

  const targetType = getCouponTargetType(coupon);
  const productIds = items
    .map(getProductIdFromItem)
    .filter((productId) => mongoose.Types.ObjectId.isValid(productId));

  if (productIds.length === 0) {
    throw couponError("Cart does not contain valid products");
  }

  const productFilter = { _id: { $in: productIds } };
  if (targetType === "product") {
    productFilter._id = coupon.product_id;
  }
  if (targetType === "category") {
    productFilter.category_id = coupon.category_id;
  }

  // `variants` is loaded because a variant carries its own price, and the discount
  // is computed against the line values below.
  const productsQuery = ProductModel.find(productFilter).select(
    "name price image brand category_id variants",
  );
  if (session) productsQuery.session(session);
  const products = await productsQuery;
  const productMap = new Map(products.map((product) => [String(product._id), product]));

  let eligibleQuantity = 0;
  let eligibleSubtotal = 0;
  const eligibleProductNames = [];

  for (const item of items) {
    const productId = String(getProductIdFromItem(item));
    const product = productMap.get(productId);
    if (!product) continue;

    const quantity = getQuantityFromItem(item);
    eligibleQuantity += quantity;
    // Priced per variant, matching prepareOrderData. Using `product.price` here made
    // a percentage coupon on a separately-priced variant discount the wrong base —
    // and made minPurchaseAmount/maxPurchaseAmount compare against a subtotal the
    // customer is never charged.
    const variant = findVariant(product, getVariantKeyFromItem(item));
    eligibleSubtotal += effectiveUnitPrice(product, variant) * quantity;
    if (!eligibleProductNames.includes(product.name)) eligibleProductNames.push(product.name);
  }

  if (eligibleQuantity <= 0 || eligibleSubtotal <= 0) {
    throw couponError("Coupon is not valid for the products in this cart");
  }

  const minPurchaseAmount = Math.max(0, Number(coupon.minPurchaseAmount || 0));
  if (eligibleSubtotal < minPurchaseAmount) {
    throw couponError(
      `Eligible cart value must be at least Rs ${minPurchaseAmount} to use this coupon`,
    );
  }
  const maxPurchaseAmount = Math.max(0, Number(coupon.maxPurchaseAmount || 0));
  if (maxPurchaseAmount > 0 && eligibleSubtotal > maxPurchaseAmount) {
    throw couponError(
      `Eligible cart value must not exceed Rs ${maxPurchaseAmount} to use this coupon`,
    );
  }

  const rawDiscount =
    coupon.discountType === "percentage"
      ? Math.round((eligibleSubtotal * Number(coupon.discountValue || 0)) / 100)
      : Number(coupon.discountValue || 0);
  const discount = Math.min(eligibleSubtotal, Math.max(0, rawDiscount));

  if (discount <= 0) {
    throw couponError("Coupon does not provide a valid discount");
  }

  if (redeem) {
    const options = session ? { session } : {};

    // ── 1. CLAIM A GLOBAL SLOT ────────────────────────────────────────────────
    // The cap lives in the FILTER, so this is a compare-and-swap rather than a
    // read-then-check: two customers racing for the last slot both match the filter
    // only if there really are two slots. The same pattern as the wallet debit in
    // PlaceOrder, and stronger than what this code did before — a full-document
    // `coupon.save()` that relied on transaction write-conflict retries alone.
    //
    // `$expr` because the comparison is between two fields of the same document.
    // The `$lte: 0` arm is the unlimited case, which is the default and therefore
    // the path every existing coupon takes.
    const claim = await CouponModel.updateOne(
      {
        _id: coupon._id,
        $or: [
          { globalMaxRedemptions: { $lte: 0 } },
          { $expr: { $lt: ["$usage", "$globalMaxRedemptions"] } },
        ],
      },
      { $inc: { usage: 1 } },
      options,
    );
    if (claim.modifiedCount !== 1) {
      throw couponError(GLOBAL_CAP_MESSAGE, 409);
    }

    // ── 2. RECORD THE PER-CUSTOMER ROW ────────────────────────────────────────
    // Upsert, so the first redemption creates the row and later ones increment it.
    // Both writes are inside the caller's transaction, so a rollback anywhere later
    // in checkout un-redeems the coupon completely rather than leaving the global
    // counter advanced against a row that never appeared.
    await CouponRedemption.updateOne(
      { coupon: normalizedCouponId, user: userId },
      { $inc: { count: 1 }, $set: { lastUsedAt: new Date() } },
      { upsert: true, ...options },
    );

    // Keep the in-memory document consistent with what was just written, since the
    // caller serialises this object straight back to the client.
    coupon.usage = (Number(coupon.usage) || 0) + 1;
  }

  return {
    coupon,
    couponId: coupon.couponId,
    discount,
    targetType,
    productId: targetType === "product" ? String(coupon.product_id) : null,
    categoryId: targetType === "category" ? String(coupon.category_id) : null,
    productName:
      targetType === "all"
        ? "All Products"
        : targetType === "category"
          ? "Selected Category"
          : eligibleProductNames[0],
    eligibleProductNames,
    eligibleQuantity,
    minPurchaseAmount,
    eligibleSubtotal,
    remainingUses: Math.max(0, usesRemaining - (redeem ? 1 : 0)),
  };
};
