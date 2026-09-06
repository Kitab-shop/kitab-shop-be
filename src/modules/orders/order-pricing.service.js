import mongoose from "mongoose";
import { isStockEnforced } from "../../config/features.config.js";
import ProductModel from "../products/Product.model.js";
import UserProfile from "../profiles/UserProfile.model.js";
import { calculateCouponDiscount } from "../coupons/coupon.service.js";
import CheckoutSetting from "./CheckoutSetting.model.js";
import { getCheapestShippingRate } from "../shipping/shiprocket.service.js";
import {
  availableStockFor,
  findVariant,
  hasVariantStock,
  normalizeSelectedVariants,
  resolveSoleVariant,
  variantKeyFrom,
  variantKeyOf,
} from "../inventory/variant.service.js";
import {
  INDIAN_MOBILE_REGEX,
  INDIAN_PINCODE_REGEX,
  INDIAN_STATES,
} from "../../config/india-geo.config.js";

const INDIAN_STATE_SET = new Set(INDIAN_STATES.map((state) => state.toLowerCase()));

export const orderError = (message, statusCode = 400) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
};

export const normalizeShippingAddress = (address = {}) => ({
  fullName: address.fullName || address.name || "",
  phone: address.phone || address.mobile || "",
  address: address.address || address.line || address.addressLine1 || "",
  city: address.city || "",
  state: address.state || "",
  pincode: address.pincode || "",
  country: address.country || "India",
});

const validateShippingAddress = (shippingAddress) => {
  const missingFields = [];
  if (!shippingAddress.fullName?.trim()) missingFields.push("fullName");
  if (!shippingAddress.phone?.trim()) missingFields.push("phone");
  if (!shippingAddress.address?.trim()) missingFields.push("address");
  if (!shippingAddress.city?.trim()) missingFields.push("city");
  if (!shippingAddress.state?.trim()) missingFields.push("state");
  if (!shippingAddress.pincode?.trim()) missingFields.push("pincode");
  return missingFields;
};

export const prepareOrderData = async ({
  items = [],
  rawShippingAddress,
  coupon = null,
  userId,
  redeemCoupon = false,
  useWallet = false,
}) => {
  if (!Array.isArray(items) || items.length === 0) {
    throw orderError("Order must contain at least one item");
  }

  const shippingAddress = normalizeShippingAddress(rawShippingAddress);
  const missingAddressFields = validateShippingAddress(shippingAddress);
  if (missingAddressFields.length > 0) {
    throw orderError(`Missing shipping fields: ${missingAddressFields.join(", ")}`);
  }
  if (!INDIAN_MOBILE_REGEX.test(shippingAddress.phone)) {
    throw orderError("Enter a valid 10-digit Indian mobile number");
  }
  if (!INDIAN_PINCODE_REGEX.test(shippingAddress.pincode)) {
    throw orderError("Enter a valid 6-digit Indian PIN code");
  }
  if (!INDIAN_STATE_SET.has(shippingAddress.state.trim().toLowerCase())) {
    throw orderError("Select a valid Indian state or union territory");
  }

  const orderItems = [];
  let subtotal = 0;

  for (const item of items) {
    const productId = item.product || item.productId || item.id || item._id;
    const quantity = Number(item.quantity || item.qty || 1);
    // Normalised through the SAME canonical function the cart uses. Previously the
    // cart dropped empty attribute values before keying and this path did not, so
    // `{color:"red", size:""}` became `color:red` in the cart but `color:red|size:`
    // on the order — two names for one line, which then defeated cart cleanup.
    let selectedVariants = normalizeSelectedVariants(item.selectedVariants);
    let variantKey = item.variantKey || variantKeyFrom(selectedVariants);

    if (!mongoose.Types.ObjectId.isValid(productId)) {
      throw orderError(
        "Invalid product id in cart. Please remove this item and add it again.",
      );
    }
    if (!Number.isInteger(quantity) || quantity < 1) {
      throw orderError("Invalid product quantity");
    }

    const product = await ProductModel.findById(productId).select(
      "name image price stock variants author",
    );
    if (!product) throw orderError("Product not found", 404);

    // The binding limit is the chosen VARIANT's stock, not the product total.
    // product.stock is the sum across variants, so a product with 10 units split
    // 10 Red / 0 Blue passed this check for a Blue — variants[].stock was read by
    // nothing in any order path. availableStockFor falls back to product.stock
    // for the (currently universal) case of a product with no variants.
    let variant = findVariant(product, variantKey);
    // A variant-stocked product cannot sell a line that names no (resolvable)
    // variant: there is no honest answer to "which variant's units were sold",
    // and the decrement would corrupt the counters (total moves, variant
    // doesn't — the next product save then derives the total from the stale
    // variant numbers and resurrects sold units). Checked BEFORE availability,
    // which would otherwise pass on the product total.
    //
    // One honest repair first: a product with exactly one active variant has
    // exactly one thing the line can mean — adopt it, so legacy cart lines
    // and older clients keep working and the order records the real variant.
    if (hasVariantStock(product) && !variant) {
      const sole = resolveSoleVariant(product);
      if (sole) {
        variant = sole;
        variantKey = variantKeyOf(sole);
        selectedVariants = normalizeSelectedVariants(
          sole.attributes && typeof sole.attributes.entries === "function"
            ? Object.fromEntries(sole.attributes.entries())
            : sole.attributes,
        );
      } else {
        throw orderError(
          `Select an option for ${product.name} — this product is stocked per variant. Please remove it from the cart and add it again with an option selected.`,
        );
      }
    }
    const available = availableStockFor(product, variantKey);
    if (isStockEnforced() && available < quantity) {
      throw orderError(
        variant
          ? `${product.name} (${variant.name}) has only ${available} item(s) in stock`
          : `${product.name} has only ${available} item(s) in stock`,
      );
    }
    // An explicitly deactivated variant is not for sale at any stock level.
    if (variant && variant.active === false) {
      throw orderError(`${product.name} (${variant.name}) is no longer available`);
    }

    const price = Number(product.price) || 0;
    orderItems.push({
      product: product._id,
      name: product.name,
      // Snapshotted for the same reason as `name`: a line item is what was sold,
      // and it has to survive the product being renamed, re-attributed or deleted.
      author: product.author || "",
      image: product.image || "",
      price,
      quantity,
      selectedVariants,
      variantKey,
    });
    subtotal += price * quantity;
  }

  const couponResult = coupon
    ? await calculateCouponDiscount({
        couponId: coupon,
        userId,
        items,
        redeem: redeemCoupon,
      })
    : null;
  const couponDiscount = Math.min(subtotal, Math.max(0, Number(couponResult?.discount) || 0));
  
  let walletDiscount = 0;
  if (useWallet && userId) {
    const userProfile = await UserProfile.findOne({ userid: userId });
    const availableWalletBalance = userProfile?.walletBalance || 0;
    
    // Wallet discount can cover whatever is left after coupon discount, up to the available balance
    const remainingSubtotal = Math.max(0, subtotal - couponDiscount);
    walletDiscount = Math.min(availableWalletBalance, remainingSubtotal);
  }

  const discount = couponDiscount + walletDiscount;

  // Free unless an admin has switched live rates on. Reading the setting here rather than
  // in the controllers means both checkout paths — COD and Razorpay — price shipping
  // identically, and the preview the customer is shown is the figure the order is created
  // with. Falls back to free on any failure, so a courier API blip cannot block checkout.
  const { shippingRatesEnabled } = await CheckoutSetting.getSettings();
  let shippingCharge = 0;
  if (shippingRatesEnabled) {
    const rate = await getCheapestShippingRate({
      deliveryPostcode: shippingAddress.pincode,
      // The COD gate asks the same question a moment later; the memo inside
      // checkServiceability means both reads are one call.
      cod: false,
      declaredValue: subtotal,
    });
    if (rate.ok) shippingCharge = rate.amount;
  }

  const tax = 0;

  return {
    orderItems,
    shippingAddress,
    subtotal,
    shippingCharge,
    tax,
    discount,
    couponDiscount,
    walletDiscount,
    totalAmount: Math.max(0, subtotal + shippingCharge + tax - discount),
    couponId: couponResult?.couponId || null,
  };
};
