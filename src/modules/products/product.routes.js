import express from "express";
import {
  CreateProduct,
  GetAllProduct,
  DeleteProduct,
  GetProductById,
  UpdateProduct,
  GetProductsByCategory,
  GetDeliveryEstimate,
  SearchProducts,
  AutocompleteProducts,
  TrackSearchClick,
} from "./product.controller.js";
import image from "../../middleware/image.middleware.js";

import { isAdmin } from "../../middleware/is-admin.middleware.js";
import { requirePermission } from "../../middleware/require-permission.middleware.js";
import { ADMIN_PERMISSIONS } from "../../config/admin-permissions.config.js";
import { deliveryEstimateRateLimit, searchRateLimit } from "../../middleware/rate-limit.middleware.js";

const routes = express.Router();

routes.post(
  "/create",
  isAdmin,
  requirePermission(ADMIN_PERMISSIONS.PRODUCTS_MANAGE),
  image.single("User_image"),
  CreateProduct,
);

routes.get("/all-product", GetAllProduct);
// Autocomplete fires per keystroke, so the ceiling is high but not absent.
routes.get("/search", searchRateLimit, SearchProducts);
routes.get("/autocomplete", searchRateLimit, AutocompleteProducts);
routes.post("/search/click", searchRateLimit, TrackSearchClick);

routes.get("/product-id/:id", GetProductById);

routes.get("/category/:categoryId", GetProductsByCategory);

routes.get("/:id/delivery-estimate", deliveryEstimateRateLimit, GetDeliveryEstimate);

routes.delete(
  "/delete/:id",
  isAdmin,
  requirePermission(ADMIN_PERMISSIONS.PRODUCTS_MANAGE),
  DeleteProduct,
);

routes.put(
  "/update/:id",
  isAdmin,
  requirePermission(ADMIN_PERMISSIONS.PRODUCTS_MANAGE),
  image.single("User_image"),
  UpdateProduct,
);

export default routes;
