import Wishlist from "./Wishlist.model.js";
import mongoose from "mongoose";
import ProductModel from "../products/Product.model.js";

const WISHLIST_PRODUCT_SELECT =
  "name image price mrp brand author category_id stock description producthightlight bestseller";

const populateWishlist = async (wishlist) => {
  await wishlist.populate({
    path: "products",
    select: WISHLIST_PRODUCT_SELECT,
    populate: { path: "category_id", select: "name" },
  });

  return wishlist;
};

const isValidProductId = (productId) => mongoose.Types.ObjectId.isValid(productId);

export const getWishlist = async (req, res) => {
  try {
    let wishlist = await Wishlist.findOne({ user: req.user.id });

    if (!wishlist) {
      wishlist = await Wishlist.create({ user: req.user.id, products: [] });
    }

    await populateWishlist(wishlist);

    res.status(200).json({
      success: true,
      count: wishlist.products.length,
      data: wishlist,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const addToWishlist = async (req, res) => {
  try {
    const { productId } = req.params;

    if (!isValidProductId(productId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid product id",
      });
    }

    const product = await ProductModel.exists({ _id: productId });
    if (!product) {
      return res.status(404).json({
        success: false,
        message: "Product not found",
      });
    }

    let wishlist = await Wishlist.findOne({ user: req.user.id });

    if (!wishlist) {
      wishlist = await Wishlist.create({
        user: req.user.id,
        products: [productId],
      });
    } else if (wishlist.products.some((id) => id.toString() === productId)) {
      await populateWishlist(wishlist);
      return res.status(200).json({
        success: true,
        message: "Product already in wishlist",
        data: wishlist,
      });
    } else {
      wishlist.products.push(productId);
      await wishlist.save();
    }

    await populateWishlist(wishlist);

    res.status(200).json({
      success: true,
      message: "Product added to wishlist",
      data: wishlist,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const removeFromWishlist = async (req, res) => {
  try {
    const { productId } = req.params;

    if (!isValidProductId(productId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid product id",
      });
    }

    const wishlist = await Wishlist.findOne({ user: req.user.id });

    if (!wishlist) {
      return res.status(200).json({
        success: true,
        message: "Wishlist is empty",
        data: {
          user: req.user.id,
          products: [],
        },
      });
    }

    wishlist.products = wishlist.products.filter(
      (id) => id.toString() !== productId,
    );

    await wishlist.save();
    await populateWishlist(wishlist);

    res.status(200).json({
      success: true,
      message: "Product removed from wishlist",
      data: wishlist,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
