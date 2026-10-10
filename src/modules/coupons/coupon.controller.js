import mongoose from "mongoose";
import CouponModel from "./coupon.model.js";
import OrderModel from "../orders/Order.model.js";
import ProductModel from "../products/Product.model.js";
import CategoryModel from "../categories/Category.model.js";
import UserModel from "../../model/User.model.js";
import {
  calculateCouponDiscount,
  couponError,
  globalCapReached,
  hasCouponAllowanceLeft,
} from "./coupon.service.js";
import CouponRedemption from "./coupon-redemption.model.js";
import { EXCLUDE_AWAITING_PAYMENT } from "../orders/order-visibility.js";

const parseDate = (value, endOfDay = false) => {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  if (endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
    date.setHours(23, 59, 59, 999);
  }

  return date;
};

const getProductId = (body = {}) => body.product_id || body.productId;
const getCategoryId = (body = {}) => body.category_id || body.categoryId;
const getMinPurchaseAmount = (body = {}) =>
  body.minPurchaseAmount ??
  body.minimumPrice ??
  body.minPrice ??
  body.minimumAmount ??
  body.minOrderAmount;
const getMaxPurchaseAmount = (body = {}) =>
  body.maxPurchaseAmount ??
  body.maximumPrice ??
  body.maxPrice ??
  body.maximumAmount ??
  body.maxOrderAmount;
const normalizeEmail = (email = "") => String(email || "").trim().toLowerCase();
const escapeRegex = (value = "") => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const findUserByEmail = async (email) => {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) return null;

  return UserModel.findOne({
    email: { $regex: `^${escapeRegex(normalizedEmail)}$`, $options: "i" },
  }).select("email");
};

const getRefId = (value) => {
  if (!value) return null;
  if (typeof value === "object") return String(value._id || value.id || value);
  return String(value);
};

const serializeCoupon = (coupon) => {
  const source = typeof coupon.toObject === "function" ? coupon.toObject() : coupon;
  const product = source.product_id;
  const category = source.category_id;
  const productId = getRefId(product);
  const categoryId = getRefId(category);
  const targetType =
    (!source.targetType || source.targetType === "all") && productId && !categoryId
      ? "product"
      : source.targetType || (categoryId ? "category" : "all");

  return {
    id: source._id || source.id,
    couponId: source.couponId,
    targetType,
    category_id: categoryId,
    categoryId,
    categoryName: category && typeof category === "object" ? category.name : "",
    product_id: productId,
    productId,
    productName: product && typeof product === "object" ? product.name : "",
    productImage: product && typeof product === "object" ? product.image : "",
    productBrand: product && typeof product === "object" ? product.brand : "",
    assignedUser: getRefId(source.assignedUser),
    customerEmail: source.customerEmail || "",
    discountType: source.discountType,
    discountValue: source.discountValue,
    startDate: source.startDate,
    expireDate: source.expireDate,
    maxLimit: source.maxLimit,
    minPurchaseAmount: Number(source.minPurchaseAmount) || 0,
    maxPurchaseAmount: Number(source.maxPurchaseAmount) || 0,
    // Read straight off the coupon. This used to re-sum the `usedBy` array because
    // `usage` could not be trusted; per-customer counts now live in
    // CouponRedemption and `usage` is the authoritative total.
    usage: Number(source.usage) || 0,
    globalMaxRedemptions: Number(source.globalMaxRedemptions) || 0,
    isActive: source.isActive,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
  };
};

const buildCouponPayload = async (body = {}, existing = {}) => {
  const productId = getProductId(body);
  const categoryId = getCategoryId(body);
  const targetSpecified =
    body.targetType !== undefined || productId !== undefined || categoryId !== undefined;
  const payload = {};

  if (body.couponId !== undefined) {
    const couponId = String(body.couponId || "").trim().toUpperCase();
    if (couponId) {
      if (!/^[A-Z0-9][A-Z0-9_-]{3,31}$/.test(couponId)) {
        throw couponError(
          "Coupon code must be 4-32 characters using letters, numbers, hyphens, or underscores",
        );
      }
      payload.couponId = couponId;
    }
  }
  if (body.discountType !== undefined) payload.discountType = body.discountType;
  if (body.discountValue !== undefined) payload.discountValue = Number(body.discountValue);
  if (body.startDate !== undefined) payload.startDate = parseDate(body.startDate);
  if (body.expireDate !== undefined) payload.expireDate = parseDate(body.expireDate, true);
  if (body.maxLimit !== undefined) payload.maxLimit = Number(body.maxLimit);
  // The TOTAL budget across all customers; 0 means unlimited. Kept separate from
  // maxLimit, which is the per-customer allowance.
  if (body.globalMaxRedemptions !== undefined) {
    payload.globalMaxRedemptions = Math.max(0, Number(body.globalMaxRedemptions) || 0);
  }
  if (getMinPurchaseAmount(body) !== undefined) {
    payload.minPurchaseAmount = Number(getMinPurchaseAmount(body));
  }
  if (getMaxPurchaseAmount(body) !== undefined) {
    payload.maxPurchaseAmount = Number(getMaxPurchaseAmount(body));
  }
  if (body.isActive !== undefined) payload.isActive = Boolean(body.isActive);

  if (
    body.customerEmail !== undefined ||
    body.userEmail !== undefined ||
    body.email !== undefined
  ) {
    const customerEmail = normalizeEmail(body.customerEmail || body.userEmail || body.email);

    if (!customerEmail) {
      payload.assignedUser = undefined;
      payload.customerEmail = undefined;
    } else {
      const user = await findUserByEmail(customerEmail);
      if (!user) {
        throw couponError("No user found with this email", 404);
      }

      payload.assignedUser = user._id;
      payload.customerEmail = user.email;
    }
  }

  if (targetSpecified) {
    const targetType = body.targetType || (productId ? "product" : categoryId ? "category" : "all");
    payload.targetType = targetType;

    if (!["all", "category", "product"].includes(targetType)) {
      throw couponError("Coupon target must be all, category, or product");
    }

    if (targetType === "all") {
      payload.product_id = undefined;
      payload.category_id = undefined;
    }

    if (targetType === "category") {
      if (!mongoose.Types.ObjectId.isValid(categoryId)) {
        throw couponError("Invalid category id");
      }

      const category = await CategoryModel.findById(categoryId).select("_id");
      if (!category) {
        throw couponError("Category not found", 404);
      }

      payload.category_id = categoryId;
      payload.product_id = undefined;
    }

    if (targetType === "product") {
      if (!mongoose.Types.ObjectId.isValid(productId)) {
        throw couponError("Invalid product id");
      }

      const product = await ProductModel.findById(productId).select("_id");
      if (!product) {
        throw couponError("Product not found", 404);
      }

      payload.product_id = productId;
      payload.category_id = undefined;
    }
  }

  const merged = {
    discountType: "percentage",
    targetType: "all",
    maxLimit: 1,
    globalMaxRedemptions: 0,
    minPurchaseAmount: 0,
    maxPurchaseAmount: 0,
    isActive: true,
    ...existing,
    ...payload,
  };
  if (merged.targetType === "product" && !merged.product_id) {
    throw couponError("Product id is required");
  }
  if (merged.targetType === "category" && !merged.category_id) {
    throw couponError("Category id is required");
  }
  if (!merged.startDate) throw couponError("Start date is required");
  if (!merged.expireDate) throw couponError("Expire date is required");
  if (merged.expireDate < merged.startDate) {
    throw couponError("Expire date must be after start date");
  }
  // An expiry already in the past makes a coupon that can never be redeemed: GetAvailableCoupons
  // and the redemption path both require startDate <= now <= expireDate, so it saves cleanly,
  // appears in the admin list, and silently fails for every customer who types it.
  //
  // Checked only when THIS request sets the expiry (`payload`, not `merged`), so an existing
  // coupon that has already lapsed stays editable — otherwise you could not correct anything
  // about an expired coupon without first extending it.
  //
  // The START date is deliberately NOT checked against now. `parseDate` gives a date-only
  // expiry 23:59:59 of that day, so "today" is still in the future — but it gives the start
  // 00:00, so "today" is already in the past. Refusing a past start would therefore reject the
  // single most common entry, and backdating a start is legitimate anyway: it just means the
  // coupon is live immediately.
  if (payload.expireDate !== undefined && merged.expireDate < new Date()) {
    throw couponError(
      "Expire date cannot be in the past — the coupon could never be redeemed. " +
        "To end a coupon early, switch it off with the Active toggle instead.",
    );
  }
  if (!["percentage", "fixed"].includes(merged.discountType)) {
    throw couponError("Discount type must be percentage or fixed");
  }
  if (Number.isNaN(Number(merged.discountValue)) || Number(merged.discountValue) <= 0) {
    throw couponError("Discount value must be greater than 0");
  }
  if (merged.discountType === "percentage" && Number(merged.discountValue) > 100) {
    throw couponError("Percentage discount cannot be greater than 100");
  }
  if (Number.isNaN(Number(merged.maxLimit)) || Number(merged.maxLimit) < 1) {
    throw couponError("Max limit must be at least 1");
  }
  // 0 is the "unlimited" sentinel, so only negatives and non-numbers are rejected.
  if (
    Number.isNaN(Number(merged.globalMaxRedemptions)) ||
    Number(merged.globalMaxRedemptions) < 0
  ) {
    throw couponError("Total redemption limit must be 0 (unlimited) or greater");
  }
  if (
    Number.isNaN(Number(merged.minPurchaseAmount)) ||
    Number(merged.minPurchaseAmount) < 0
  ) {
    throw couponError("Minimum price must be 0 or greater");
  }
  if (
    Number.isNaN(Number(merged.maxPurchaseAmount)) ||
    Number(merged.maxPurchaseAmount) < 0
  ) {
    throw couponError("Maximum purchase amount must be 0 or greater");
  }
  if (
    Number(merged.maxPurchaseAmount) > 0 &&
    Number(merged.maxPurchaseAmount) < Number(merged.minPurchaseAmount)
  ) {
    throw couponError("Maximum purchase amount cannot be below the minimum price");
  }

  return payload;
};

const sendError = (res, error) => {
  if (error?.code === 11000) {
    return res.status(400).json({
      success: false,
      message: "Coupon id already exists",
    });
  }

  return res.status(error.statusCode || 500).json({
    success: false,
    message: error.message,
  });
};

const escapeCsv = (value) => {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

const sendCsv = (res, filename, rows) => {
  const csv = rows.map((row) => row.map(escapeCsv).join(",")).join("\n");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  return res.status(200).send(csv);
};

/**
 * Switches off every coupon whose expiry has passed.
 *
 * Expiry was already enforced at redemption (validateCouponDates in coupon.service.js),
 * so an expired coupon could never be used — but nothing said so in the admin panel,
 * where the status badge read `isActive` alone. A coupon that had lapsed still showed a
 * green "Active" pill, which is why setting an expiry date looked like it did nothing.
 *
 * Reconciled here rather than by a scheduler because this deployment has none, and the
 * admin list is the one place the answer has to be right. A write on a GET is unusual;
 * it is confined to a single conditional updateMany that only ever moves `true` -> `false`
 * for a date that has already passed, so it is idempotent and cannot race meaningfully —
 * two concurrent admins loading the page produce the same result as one.
 *
 * Note the consequence, which is deliberate: extending an expired coupon's date does NOT
 * bring it back on its own, because `isActive` has really been written to false. The admin
 * re-enables it with the Active toggle, and the form says so.
 */
const deactivateExpiredCoupons = async () => {
  const result = await CouponModel.updateMany(
    { isActive: true, expireDate: { $lt: new Date() } },
    { $set: { isActive: false } },
  );
  return result?.modifiedCount || 0;
};

export const AdminGetCoupons = async (req, res) => {
  try {
    // Before reading, not after: the list the admin sees must already agree with what
    // checkout would do, or the panel goes on lying about which coupons are live.
    await deactivateExpiredCoupons();

    const coupons = await CouponModel.find()
      .populate("product_id", "name image brand price")
      .populate("category_id", "name")
      .populate("assignedUser", "email")
      .sort({ createdAt: -1 })
      .lean();

    return res.status(200).json({
      success: true,
      count: coupons.length,
      data: coupons.map(serializeCoupon),
    });
  } catch (error) {
    return sendError(res, error);
  }
};

export const AdminCreateCoupon = async (req, res) => {
  try {
    const payload = await buildCouponPayload(req.body);
    const coupon = await CouponModel.create(payload);
    await coupon.populate("product_id", "name image brand price");
    await coupon.populate("category_id", "name");
    await coupon.populate("assignedUser", "email");

    return res.status(201).json({
      success: true,
      message: "Coupon created successfully",
      data: serializeCoupon(coupon),
    });
  } catch (error) {
    return sendError(res, error);
  }
};

export const AdminUpdateCoupon = async (req, res) => {
  try {
    const coupon = await CouponModel.findById(req.params.id);

    if (!coupon) {
      return res.status(404).json({
        success: false,
        message: "Coupon not found",
      });
    }

    const existing = coupon.toObject();
    const payload = await buildCouponPayload(req.body, existing);

    Object.assign(coupon, payload);
    await coupon.save();
    await coupon.populate("product_id", "name image brand price");
    await coupon.populate("category_id", "name");
    await coupon.populate("assignedUser", "email");

    return res.status(200).json({
      success: true,
      message: "Coupon updated successfully",
      data: serializeCoupon(coupon),
    });
  } catch (error) {
    return sendError(res, error);
  }
};

export const AdminDeleteCoupon = async (req, res) => {
  try {
    const coupon = await CouponModel.findByIdAndDelete(req.params.id);

    if (!coupon) {
      return res.status(404).json({
        success: false,
        message: "Coupon not found",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Coupon deleted successfully",
    });
  } catch (error) {
    return sendError(res, error);
  }
};

export const AdminCouponUsageReport = async (req, res) => {
  try {
    const coupons = await CouponModel.find()
      .populate("assignedUser", "email")
      .populate("product_id", "name")
      .populate("category_id", "name")
      .sort({ createdAt: -1 })
      .lean();

    const data = coupons.map((coupon) => {
      const usageCount = Number(coupon.usage) || 0;
      return {
        couponId: coupon.couponId,
        targetType: coupon.targetType,
        targetName: coupon.product_id?.name || coupon.category_id?.name || "All products",
        assignedUserEmail: coupon.assignedUser?.email || coupon.customerEmail || "",
        discountType: coupon.discountType,
        discountValue: coupon.discountValue,
        usageCount,
        maxLimit: coupon.maxLimit,
        isActive: coupon.isActive,
        startDate: coupon.startDate,
        expireDate: coupon.expireDate,
      };
    });

    return res.status(200).json({
      success: true,
      total: data.length,
      data,
    });
  } catch (error) {
    return sendError(res, error);
  }
};

export const ExportCouponUsageReport = async (req, res) => {
  try {
    const coupons = await CouponModel.find()
      .populate("assignedUser", "email")
      .populate("product_id", "name")
      .populate("category_id", "name")
      .sort({ createdAt: -1 })
      .lean();

    const rows = [
      [
        "couponId",
        "targetType",
        "targetName",
        "assignedUserEmail",
        "discountType",
        "discountValue",
        "usageCount",
        "maxLimit",
        "globalMaxRedemptions",
        "isActive",
        "startDate",
        "expireDate",
      ],
      ...coupons.map((coupon) => [
        coupon.couponId,
        coupon.targetType,
        coupon.product_id?.name || coupon.category_id?.name || "All products",
        coupon.assignedUser?.email || coupon.customerEmail || "",
        coupon.discountType,
        coupon.discountValue,
        Number(coupon.usage) || 0,
        coupon.maxLimit,
        Number(coupon.globalMaxRedemptions) || 0,
        coupon.isActive,
        coupon.startDate?.toISOString?.() || "",
        coupon.expireDate?.toISOString?.() || "",
      ]),
    ];

    return sendCsv(res, "coupon-usage-report.csv", rows);
  } catch (error) {
    return sendError(res, error);
  }
};

export const GetAvailableCoupons = async (req, res) => {
  try {
    const now = new Date();
    const productIds = String(req.query.productIds || "")
      .split(",")
      .map((id) => id.trim())
      .filter((id) => mongoose.Types.ObjectId.isValid(id));
    const productsInCart =
      productIds.length > 0
        ? await ProductModel.find({ _id: { $in: productIds } })
            .select("category_id")
            .lean()
        : [];
    const categoryIds = [
      ...new Set(productsInCart.map((product) => String(product.category_id)).filter(Boolean)),
    ];

    const filter = {
      isActive: true,
      startDate: { $lte: now },
      expireDate: { $gte: now },
      $and: [
        {
          $or: [
            { assignedUser: { $exists: false } },
            { assignedUser: null },
            { assignedUser: req.user.id },
          ],
        },
      ],
    };

    if (productIds.length > 0) {
      filter.$and.push({
        $or: [
          { targetType: "all" },
          { targetType: "product", product_id: { $in: productIds } },
          { targetType: "category", category_id: { $in: categoryIds } },
          { targetType: { $exists: false }, product_id: { $in: productIds } },
        ],
      });
    }

    const coupons = await CouponModel.find(filter)
      .populate("product_id", "name image brand price")
      .populate("category_id", "name")
      .populate("assignedUser", "email")
      .sort({ expireDate: 1 })
      .lean();

    // How many REAL orders this customer has placed per coupon.
    //
    // A grouped count, not `distinct`, because the allowance is `maxLimit` uses —
    // "appears at all" would cap every coupon at one regardless of configuration.
    // And EXCLUDE_AWAITING_PAYMENT, because a Razorpay order exists at Pending
    // BEFORE payment: without it, starting a checkout with a coupon and abandoning
    // it hid that coupon from this list forever, while calculateCouponDiscount --
    // which has always applied the filter -- would still have accepted it. The
    // customer could no longer see the coupon they were still entitled to use.
    const couponOrderCounts = await OrderModel.aggregate([
      {
        $match: {
          user: new mongoose.Types.ObjectId(String(req.user.id)),
          coupon: { $ne: null },
          paymentStatus: { $ne: "Failed" },
          ...EXCLUDE_AWAITING_PAYMENT,
        },
      },
      { $group: { _id: { $toUpper: "$coupon" }, count: { $sum: 1 } } },
    ]);
    const ordersByCoupon = new Map(
      couponOrderCounts.map((row) => [String(row._id), Number(row.count) || 0]),
    );

    // Every redemption row this customer has, in ONE indexed read, rather than a
    // lookup per listed coupon.
    const redemptions = await CouponRedemption.find({ user: req.user.id })
      .select("coupon count")
      .lean();
    const redemptionsByCoupon = new Map(
      redemptions.map((row) => [String(row.coupon).toUpperCase(), Number(row.count) || 0]),
    );

    // Exactly the rules the checkout validator applies, from the same functions, so
    // the list and checkout cannot disagree about whether a coupon is usable: the
    // per-customer allowance, and the coupon's total budget.
    const availableCoupons = coupons.filter((coupon) => {
      const key = String(coupon.couponId).toUpperCase();
      return (
        hasCouponAllowanceLeft(
          coupon,
          redemptionsByCoupon.get(key) || 0,
          ordersByCoupon.get(key) || 0,
        ) && !globalCapReached(coupon)
      );
    });

    return res.status(200).json({
      success: true,
      count: availableCoupons.length,
      data: availableCoupons.map(serializeCoupon),
    });
  } catch (error) {
    return sendError(res, error);
  }
};

export const ApplyCoupon = async (req, res) => {
  try {
    const { couponId, items = [] } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
      throw couponError("Cart items are required");
    }

    const result = await calculateCouponDiscount({
      couponId,
      userId: req.user.id,
      items,
      redeem: false,
    });

    return res.status(200).json({
      success: true,
      message: "Coupon applied successfully",
      data: {
        coupon: serializeCoupon(result.coupon),
        couponId: result.couponId,
        targetType: result.targetType,
        productId: result.productId,
        categoryId: result.categoryId,
        productName: result.productName,
        eligibleProductNames: result.eligibleProductNames,
        eligibleQuantity: result.eligibleQuantity,
        minPurchaseAmount: result.minPurchaseAmount,
        eligibleSubtotal: result.eligibleSubtotal,
        discount: result.discount,
        remainingUses: result.remainingUses,
      },
    });
  } catch (error) {
    return sendError(res, error);
  }
};
