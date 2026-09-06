import mongoose from "mongoose";
import { isStockEnforced } from "../../config/features.config.js";
import cartModel from "./cart.model.js";
import ProductModel from "../products/Product.model.js";
import { notifyAbandonedCart } from "../notifications/notification.service.js";
import { hasAdminRole } from "../../config/admin-permissions.config.js";
import {
  lineAvailability,
  normalizeSelectedVariants,
  resolveSoleVariant,
  variantKeyFrom,
  variantKeyOf,
} from "../inventory/variant.service.js";

const ADMIN_PURCHASE_MESSAGE =
  "Admin accounts cannot add products to cart or place orders. Please use a customer account.";
// `variants` is loaded because availability is variant-binding: product.stock is
// the TOTAL across variants, so it cannot answer "can I buy this Blue one?".
const CART_PRODUCT_SELECT = "name image price mrp brand author category_id stock variants";

const assertCustomerCanPurchase = (user = {}) => {
  if (hasAdminRole(user)) {
    const error = new Error(ADMIN_PURCHASE_MESSAGE);
    error.status = 403;
    throw error;
  }
};

// Variant identity comes from ONE place. This file used to carry its own
// `normalizeSelectedVariants` + `buildVariantKey` pair — the key algorithm was
// identical to variant.service.js's, but the normalisation was not applied on the
// order side, so the same selection could key differently in the cart and on the
// order. Cart cleanup compares those two keys, so a mismatch meant purchased items
// stayed in the cart.
const buildVariantKey = (selectedVariants = {}) => variantKeyFrom(selectedVariants);

const getProductId = (item = {}) => item.productId || item.product || item.id || item._id;

const getOrCreateCart = async (userId) => {
  let cart = await cartModel.findOne({ user: userId });

  if (!cart) {
    cart = await cartModel.create({
      user: userId,
      items: [],
    });
  }

  return cart;
};

// Cart items snapshot price/mrp when added so the line total stays stable
// while shopping. Reconcile that snapshot against the live product price on
// every read: correct the stored value so it never drifts further from what
// checkout will actually charge (order-pricing.service.js always re-prices
// from the live product regardless), and flag the change so the UI can tell
// the customer what happened instead of silently showing a stale number.
const populateCart = async (cart) => {
  await cart.populate({
    path: "items.product",
    select: CART_PRODUCT_SELECT,
    populate: { path: "category_id", select: "name" },
  });

  let priceDrifted = false;
  const items = cart.items.map((item) => {
    const product = item.product;
    const previousPrice = Number(item.price) || 0;
    const livePrice = product ? Number(product.price) || 0 : previousPrice;
    const priceChanged = Boolean(product) && livePrice !== previousPrice;
    const liveMrp = product
      ? (product.mrp !== undefined ? Number(product.mrp) || livePrice : livePrice)
      : Number(item.mrp) || previousPrice;
    // mrp can drift independently of price (e.g. an admin only edits the
    // "was" price) — reconcile it on every read too, not only when price
    // itself changed, so the cart never shows a stale mrp.
    const mrpChanged = Boolean(product) && liveMrp !== (Number(item.mrp) || 0);

    if (priceChanged) {
      priceDrifted = true;
      item.price = livePrice;
    }
    if (mrpChanged) {
      priceDrifted = true;
      item.mrp = liveMrp;
    }

    // ── AVAILABILITY, PER VARIANT ────────────────────────────────────────────
    // Computed from the same source checkout uses, so the cart stops telling a
    // shopper that a sold-out or deactivated variant is available and only letting
    // them discover otherwise at checkout. Advisory: it describes now, and the
    // atomic decrement at checkout remains the authority.
    const availability = product ? lineAvailability(product, item.variantKey || "") : null;
    const quantity = Number(item.quantity) || 0;
    const available = availability ? availability.available : quantity;
    const variantUnavailable = Boolean(
      availability && availability.tracksVariant && item.variantKey && !availability.isActive,
    );
    // A line on a variant-stocked product that names no (resolvable) variant.
    // The order endpoint refuses these (unless a sole variant can be adopted),
    // so the cart must say so up front instead of letting the shopper reach
    // checkout and fail there. Sole-variant products are excluded: the add
    // and order paths adopt the only option automatically.
    const variantMissing = Boolean(
      availability &&
        availability.tracksVariant &&
        (!item.variantKey || !availability.variantFound) &&
        !resolveSoleVariant(product),
    );

    return {
      // flattenMaps is load-bearing: selectedVariants is a Mongoose Map, and
      // without it toObject() keeps a JS Map that JSON.stringify renders as
      // {} — every cart the API returned had its variant selection silently
      // erased, so checkout refused perfectly valid variant lines.
      ...item.toObject({ flattenMaps: true }),
      priceChanged,
      previousPrice: priceChanged ? previousPrice : undefined,
      availableStock: available,
      // The shopper is asking for more than exists — the cart can say so instead
      // of letting checkout reject the whole order.
      exceedsStock: available < quantity,
      inStock: available > 0,
      variantUnavailable,
      variantMissing,
    };
  });

  if (priceDrifted) {
    await cart.save();
  }

  return { ...cart.toObject({ flattenMaps: true }), items };
};

const findCartItem = (cart, { cartItemId, productId, variantKey = "" }) => {
  if (cartItemId) {
    return cart.items.find((item) => item._id.toString() === String(cartItemId));
  }

  return cart.items.find(
    (item) =>
      item.product.toString() === String(productId) &&
      String(item.variantKey || "") === String(variantKey || ""),
  );
};

const validateProductId = (productId) => {
  if (!productId || !mongoose.Types.ObjectId.isValid(productId)) {
    const error = new Error("Invalid product id");
    error.status = 400;
    throw error;
  }
};

// `collectErrors: true` (the BULK/merge path) turns per-line refusals into a
// `skipped` report instead of a thrown error. The guest→login merge is the
// reason: it replays every guest line through here in one request, and a
// single refused line used to abort the WHOLE merge before cart.save() — the
// good lines were discarded, the client kept the poisoned guest cart in
// localStorage, and every later load re-failed the same way, permanently.
// Single-add keeps throwing: one line, one clear error.
const addItemsToCart = async (userId, items, { collectErrors = false } = {}) => {
  if (!Array.isArray(items) || items.length === 0) {
    const error = new Error("Items are required");
    error.status = 400;
    throw error;
  }

  const cart = await getOrCreateCart(userId);
  const skipped = [];

  const addOneItem = async (item) => {
    const productId = getProductId(item);
    const quantity = Number(item.quantity ?? item.qty ?? 1);
    let selectedVariants = normalizeSelectedVariants(item.selectedVariants);
    let variantKey = buildVariantKey(selectedVariants);

    validateProductId(productId);

    if (!Number.isInteger(quantity) || quantity < 1) {
      const error = new Error("Quantity must be a positive whole number");
      error.status = 400;
      throw error;
    }

    const product = await ProductModel.findById(productId).select(
      "name price mrp stock variants",
    );
    if (!product) {
      const error = new Error("Product not found");
      error.status = 404;
      throw error;
    }

    // A variant-stocked product must be added WITH a resolvable variant.
    // Variantless lines used to slip through (wishlist/compare quick-add,
    // direct API calls) and then decremented only the product total at
    // checkout — leaving the per-variant counters stale, which the next
    // product save treated as truth, resurrecting sold units.
    //
    // One honest repair before refusing: a product with exactly ONE active
    // variant means one thing only — adopt it. Keeps single-option products
    // friction-free and stops a legacy guest line from failing the merge.
    // Done BEFORE the existing-line lookup and availability maths, both of
    // which key off variantKey.
    const preliminary = lineAvailability(product, variantKey);
    if (preliminary.tracksVariant && (!variantKey || !preliminary.variantFound)) {
      const sole = resolveSoleVariant(product);
      if (sole) {
        variantKey = variantKeyOf(sole);
        selectedVariants =
          sole.attributes && typeof sole.attributes.entries === "function"
            ? Object.fromEntries(sole.attributes.entries())
            : { ...(sole.attributes || {}) };
      } else if (!variantKey) {
        const error = new Error(
          `Select an option for ${product.name} before adding it to the cart.`,
        );
        error.status = 400;
        error.code = "VARIANT_REQUIRED";
        error.details = { productId: String(product._id) };
        throw error;
      } else {
        const error = new Error(
          `${product.name} (${variantKey}) is not available in that option any more. Please pick another.`,
        );
        error.status = 400;
        error.code = "VARIANT_NOT_FOUND";
        error.details = { productId: String(product._id), variantKey };
        throw error;
      }
    }

    const existingItem = findCartItem(cart, { productId, variantKey });
    const nextQuantity = (existingItem?.quantity || 0) + quantity;

    // Variant-binding, matching checkout. This compared `product.stock` — the
    // total across all variants — so a product with 10 units split 10 Red / 0 Blue
    // accepted 10 Blue into the cart and only failed at checkout.
    const { available, isActive, tracksVariant } = lineAvailability(product, variantKey);
    const variantLabel = tracksVariant && variantKey ? ` (${variantKey})` : "";

    if (isStockEnforced() && tracksVariant && variantKey && !isActive) {
      const error = new Error(`${product.name}${variantLabel} is no longer available`);
      error.status = 400;
      error.code = "VARIANT_UNAVAILABLE";
      error.details = { productId: String(product._id), variantKey, availableStock: 0 };
      throw error;
    }

    if (isStockEnforced() && available < nextQuantity) {
      const error = new Error(
        `${product.name}${variantLabel} has only ${available} item(s) in stock`,
      );
      error.status = 400;
      error.code = "INSUFFICIENT_STOCK";
      error.details = {
        productId: String(product._id),
        variantKey,
        availableStock: available,
        quantityInCart: existingItem?.quantity || 0,
        requestedQuantity: nextQuantity,
      };
      throw error;
    }

    const itemPrice = Number(product.price) || 0;
    const itemMrp = Number(product.mrp ?? itemPrice) || itemPrice;

    if (existingItem) {
      existingItem.quantity = nextQuantity;
      existingItem.price = itemPrice;
      existingItem.mrp = itemMrp;
    } else {
      cart.items.push({
        product: productId,
        quantity,
        selectedVariants,
        variantKey,
        price: itemPrice,
        mrp: itemMrp,
      });
    }
  };

  for (const item of items) {
    if (!collectErrors) {
      await addOneItem(item);
      continue;
    }
    try {
      await addOneItem(item);
    } catch (error) {
      // Only expected per-line refusals become skips; anything else (DB
      // failure etc.) still aborts the request.
      if (error.status === 400 || error.status === 404) {
        skipped.push({
          productId: String(getProductId(item) || ""),
          code: error.code || "REJECTED",
          message: error.message,
          // Same per-line details the thrown error carries (availableStock,
          // variantKey…), so the UI contract survives the skip.
          details: error.details,
        });
        continue;
      }
      throw error;
    }
  }

  await cart.save();
  return { cart: await populateCart(cart), skipped };
};

export const addToCart = async (req, res) => {
  try {
    assertCustomerCanPurchase(req.user);
    // Bulk is the guest→login merge path: skip-and-report per line, so one
    // refused line cannot abort the whole merge (see addItemsToCart).
    const { cart, skipped } = await addItemsToCart(req.user.id, req.body.items, {
      collectErrors: true,
    });

    return res.status(200).json({
      success: true,
      message:
        skipped.length > 0
          ? `${skipped.length} item(s) could not be added and were skipped`
          : "Items added successfully",
      data: cart,
      skipped,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
      code: error.code,
      details: error.details,
    });
  }
};

export const singleProduct = async (req, res) => {
  try {
    assertCustomerCanPurchase(req.user);
    const productId = req.body.productId || req.body.product;

    if (!productId) {
      return res.status(400).json({
        success: false,
        message: "ProductId is required",
      });
    }

    const { cart } = await addItemsToCart(req.user.id, [
      {
        productId,
        quantity: req.body.quantity ?? req.body.qty ?? 1,
        selectedVariants: req.body.selectedVariants,
        price: req.body.price,
        mrp: req.body.mrp,
      },
    ]);

    return res.status(200).json({
      success: true,
      message: "Product added successfully",
      data: cart,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
      code: error.code,
      details: error.details,
    });
  }
};

export const updateQuantity = async (req, res) => {
  try {
    assertCustomerCanPurchase(req.user);
    const userId = req.user.id;
    const { cartItemId, productId, selectedVariants } = req.body;
    const quantity = Number(req.body.quantity ?? req.body.qty);

    if (!Number.isInteger(quantity) || quantity < 1) {
      return res.status(400).json({
        success: false,
        message: "Quantity must be a positive whole number",
      });
    }

    const cart = await cartModel.findOne({ user: userId });
    if (!cart) {
      return res.status(404).json({
        success: false,
        message: "Cart not found",
      });
    }

    const variantKey = buildVariantKey(normalizeSelectedVariants(selectedVariants));
    const cartItem = findCartItem(cart, { cartItemId, productId, variantKey });

    if (!cartItem) {
      return res.status(404).json({
        success: false,
        message: "Product not found in cart",
      });
    }

    const product = await ProductModel.findById(cartItem.product).select(
      "name stock variants",
    );
    if (!product) {
      return res.status(404).json({
        success: false,
        message: "Product not found",
      });
    }

    // Availability for the line's OWN variant, not the product total — same source
    // checkout uses. The line's stored variantKey is used rather than the request's,
    // because `cartItemId` may have identified the line without one being supplied.
    const lineVariantKey = String(cartItem.variantKey || "");
    const { available, isActive, tracksVariant } = lineAvailability(product, lineVariantKey);
    const variantLabel = tracksVariant && lineVariantKey ? ` (${lineVariantKey})` : "";

    // Only block *increases* past available stock. A cart line can legitimately
    // sit above stock already — an admin lowering stock after the item was added
    // doesn't rewrite existing carts — and rejecting every value above stock made
    // that line impossible to fix: with 7 in the cart and 4 left, 7→6 failed too
    // (4 < 6), so the customer was stuck and could neither reduce nor check out.
    // A reduction always frees stock, so it's safe regardless of the ceiling.
    const isIncrease = quantity > cartItem.quantity;
    if (isStockEnforced() && isIncrease && tracksVariant && lineVariantKey && !isActive) {
      return res.status(400).json({
        success: false,
        message: `${product.name}${variantLabel} is no longer available`,
        code: "VARIANT_UNAVAILABLE",
        availableStock: 0,
      });
    }
    if (isStockEnforced() && isIncrease && available < quantity) {
      return res.status(400).json({
        success: false,
        message: `${product.name}${variantLabel} has only ${available} item(s) in stock`,
        code: "INSUFFICIENT_STOCK",
        availableStock: available,
      });
    }

    cartItem.quantity = quantity;
    await cart.save();

    return res.status(200).json({
      success: true,
      message: "Quantity updated successfully",
      data: await populateCart(cart),
    });
  } catch (ex) {
    return res.status(ex.status || 500).json({
      success: false,
      message: ex.message,
    });
  }
};

export const incrementQuantity = async (req, res) => {
  req.body.quantity = Number(req.body.quantity || 0) + 1;

  if (!req.body.quantity || req.body.quantity === 1) {
    const cart = await cartModel.findOne({ user: req.user.id });
    const cartItem = cart && findCartItem(cart, req.body);
    req.body.quantity = (cartItem?.quantity || 0) + 1;
  }

  return updateQuantity(req, res);
};

export const decrementedQuantity = async (req, res) => {
  const cart = await cartModel.findOne({ user: req.user.id });
  const cartItem = cart && findCartItem(cart, req.body);

  if (!cartItem || cartItem.quantity <= 1) {
    return res.status(400).json({
      success: false,
      message: "Quantity can't be less than 1",
    });
  }

  req.body.quantity = cartItem.quantity - 1;
  return updateQuantity(req, res);
};

export const getCart = async (req, res) => {
  try {
    const userId = req.user.id;
    const cart = await cartModel.findOne({ user: userId });

    if (!cart) {
      return res.status(200).json({
        success: true,
        message: "Cart is empty",
        data: {
          user: userId,
          items: [],
        },
      });
    }

    return res.status(200).json({
      success: true,
      message: cart.items.length === 0 ? "Cart is empty" : "Cart found successfully",
      data: await populateCart(cart),
    });
  } catch (ex) {
    return res.status(500).json({
      success: false,
      message: ex.message,
    });
  }
};

export const deletecartproduct = async (req, res) => {
  try {
    const userId = req.user.id;
    const { cartItemId, productId, selectedVariants } = req.body;

    const cart = await cartModel.findOne({ user: userId });
    if (!cart) {
      return res.status(404).json({
        success: false,
        message: "Cart not found",
      });
    }

    const variantKey = buildVariantKey(normalizeSelectedVariants(selectedVariants));
    const cartItem = findCartItem(cart, { cartItemId, productId, variantKey });

    if (!cartItem) {
      return res.status(404).json({
        success: false,
        message: "Product not found in cart",
      });
    }

    cart.items = cart.items.filter((item) => item._id.toString() !== cartItem._id.toString());
    await cart.save();

    return res.status(200).json({
      success: true,
      message: "Product deleted successfully",
      data: await populateCart(cart),
    });
  } catch (ex) {
    return res.status(500).json({
      success: false,
      message: ex.message,
    });
  }
};

export const clearCart = async (req, res) => {
  try {
    const cart = await getOrCreateCart(req.user.id);
    cart.items = [];
    await cart.save();

    return res.status(200).json({
      success: true,
      message: "Cart cleared successfully",
      data: await populateCart(cart),
    });
  } catch (ex) {
    return res.status(500).json({
      success: false,
      message: ex.message,
    });
  }
};

export const AdminGetAbandonedCarts = async (req, res) => {
  try {
    const hours = Math.min(Math.max(Number(req.query.hours) || 24, 1), 720);
    const shouldNotify = String(req.query.notify || "").toLowerCase() === "true";
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);
    const carts = await cartModel
      .find({
        updatedAt: { $lte: cutoff },
        "items.0": { $exists: true },
      })
      .populate("user", "email")
      .populate("items.product", CART_PRODUCT_SELECT)
      .sort({ updatedAt: 1 })
      .limit(100)
      .lean();

    if (shouldNotify) {
      await Promise.all(
        carts.map((cart) =>
          notifyAbandonedCart({
            userId: cart.user?._id || cart.user,
            email: cart.user?.email || "",
          }),
        ),
      );
    }

    return res.status(200).json({
      success: true,
      total: carts.length,
      data: carts,
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};
