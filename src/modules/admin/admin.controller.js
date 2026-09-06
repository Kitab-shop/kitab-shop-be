import Product from "../products/Product.model.js";
import Category from "../categories/Category.model.js";
import UserAuthentication from "../../model/User.model.js";
import UserProfile from "../profiles/UserProfile.model.js";
import Order from "../orders/Order.model.js";
import { EXCLUDE_AWAITING_PAYMENT } from "../orders/order-visibility.js";
import mongoose from "mongoose";
import { VARIANT_MANAGED_STOCK_MESSAGE } from "../inventory/variant.service.js";
import { buildSystemHealth } from "./system-health.service.js";
import {
  ADMIN_PERMISSIONS,
  ROLE_PERMISSIONS,
  VALID_USER_ROLES,
  getRolePermissions,
} from "../../config/admin-permissions.config.js";
import { createAuditLog } from "../audit/audit-log.js";
import {
  formatAdminUser,
  normalizeBulkProduct,
  sendCsv,
  setUserActiveStatus,
} from "./admin-response.service.js";
import {
  buildDashboardData,
  buildSalesReportData,
} from "./admin-report.service.js";
import { buildCodReconciliation } from "./cod-reconciliation.service.js";
import { buildSeoFields } from "../products/product-seo.service.js";
// The storefront catalogue is served from a cached, pre-serialised body; a bulk
// write that skips this leaves the shop showing the old catalogue until the TTL
// lapses. See GetAllProduct in products/product.controller.js.
import { invalidateCatalogueCache } from "../products/product.controller.js";

export const GetDashboard = async (req, res) => {
  try {
    const dashboard = await buildDashboardData();
    return res.status(200).json({ success: true, dashboard });
  } catch (error) {
    console.log(error);

    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

export const GetAdminPermissions = async (req, res) =>
  res.status(200).json({
    success: true,
    permissions: ADMIN_PERMISSIONS,
    rolePermissions: Object.fromEntries(
      Object.keys(ROLE_PERMISSIONS).map((role) => [role, getRolePermissions(role)]),
    ),
  });

export const UpdateUserPermissions = async (req, res) => {
  try {
    const permissions = Array.isArray(req.body?.permissions) ? req.body.permissions : [];
    const roles = Array.isArray(req.body?.roles) ? req.body.roles : null;
    const validPermissions = new Set(Object.values(ADMIN_PERMISSIONS));
    const invalid = permissions.filter((permission) => !validPermissions.has(permission));
    if (invalid.length > 0) {
      return res.status(400).json({
        success: false,
        message: `Invalid permissions: ${invalid.join(", ")}`,
      });
    }

    const update = { permissions };
    let normalizedRoles = null;
    if (roles) {
      normalizedRoles = [...new Set(roles.map((role) => String(role).trim()).filter(Boolean))];
      const invalidRoles = normalizedRoles.filter((role) => !VALID_USER_ROLES.includes(role));
      if (invalidRoles.length > 0) {
        return res.status(400).json({
          success: false,
          message: `Invalid roles: ${invalidRoles.join(", ")}`,
        });
      }

      update.roles = normalizedRoles.length > 0 ? normalizedRoles : ["user"];
    }

    // "admin" and "superAdmin" both hold users:manage, so the permission gate
    // above does not by itself stop a plain admin from editing a superAdmin.
    // superAdmin is the only rank above admin, so the only rank check needed
    // is: does the target currently hold it, and does the actor also hold it.
    const targetBeforeUpdate = await UserAuthentication.findById(req.params.id).select("roles");
    if (!targetBeforeUpdate) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const targetIsSuperAdmin = (targetBeforeUpdate.roles || []).includes("superAdmin");
    const actingIsSuperAdmin = (req.user?.roles || []).includes("superAdmin");

    if (targetIsSuperAdmin && !actingIsSuperAdmin) {
      return res.status(403).json({
        success: false,
        message: "Only a super admin can modify a super admin account",
      });
    }

    if (targetIsSuperAdmin && normalizedRoles && !normalizedRoles.includes("superAdmin")) {
      if (String(req.user?.id) === String(targetBeforeUpdate._id)) {
        return res.status(403).json({
          success: false,
          message: "You cannot remove your own super admin role",
        });
      }
      const otherSuperAdmins = await UserAuthentication.countDocuments({
        _id: { $ne: targetBeforeUpdate._id },
        roles: "superAdmin",
      });
      if (otherSuperAdmins === 0) {
        return res.status(403).json({
          success: false,
          message: "At least one super admin account must remain",
        });
      }
    }

    const user = await UserAuthentication.findByIdAndUpdate(
      req.params.id,
      update,
      { returnDocument: "after" },
    ).select("-password -Resettoken");
    if (!user) return res.status(404).json({ success: false, message: "User not found" });

    await createAuditLog({
      admin: req.user?.id,
      action: "UPDATE_PERMISSIONS",
      module: "USER",
      targetId: user._id,
      targetName: user.email,
      description: `Updated permissions for ${user.email}`,
      req,
    });

    return res.status(200).json({
      success: true,
      message: "Permissions updated",
      user,
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// The admin topbar's "Today's New Users" bell used to fetch every user in
// the system on a 30s poll just to filter for today's signups client-side —
// expensive as the user base grows, and it silently broke once /all-users
// required users:manage. This does the date filtering in the query instead
// of hauling the whole table over the wire.
export const GetTodayUsers = async (req, res) => {
  try {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const users = await UserAuthentication.find({ createdAt: { $gte: startOfToday } })
      .select("email createdAt")
      .sort({ createdAt: -1 });

    return res.status(200).json({
      success: true,
      count: users.length,
      users: users.map((user) => ({
        id: user._id,
        email: user.email,
        createdAt: user.createdAt,
      })),
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const GetAllUsers = async (req, res) => {
  try {
    const { search = "", role = "all", status = "all" } = req.query;
    const filter = {};

    if (role !== "all") {
      filter.roles = role;
    }
    if (status === "active") filter.isActive = { $ne: false };
    if (status === "blocked") filter.isActive = false;

    if (search.trim()) {
      filter.email = {
        $regex: search.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        $options: "i",
      };
    }

    const users = await UserAuthentication.find(filter)
      .select("-password -Resettoken")
      .sort({ createdAt: -1 });

    const userIds = users.map((user) => user._id);

    const [profiles, orderCounts] = await Promise.all([
      UserProfile.find({ userid: { $in: userIds } }),
      Order.aggregate([
        {
          $match: {
            user: { $in: userIds },
            // Per-customer order counts and spend must not include checkouts that
            // were started and never paid for.
            ...EXCLUDE_AWAITING_PAYMENT,
          },
        },
        {
          $group: {
            _id: "$user",
            ordersCount: { $sum: 1 },
          },
        },
      ]),
    ]);

    const profilesByUser = new Map(
      profiles.map((profile) => [String(profile.userid), profile]),
    );
    const ordersByUser = new Map(
      orderCounts.map((item) => [String(item._id), item.ordersCount]),
    );

    const result = users.map((user) =>
      formatAdminUser({
        user,
        profile: profilesByUser.get(String(user._id)),
        ordersCount: ordersByUser.get(String(user._id)) || 0,
      }),
    );

    return res.status(200).json({
      success: true,
      totalUsers: result.length,
      users: result,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

export const BlockUser = async (req, res) => {
  try {
    const user = await setUserActiveStatus({
      id: req.params.id,
      isActive: false,
      adminId: req.user?.id,
    });

    await createAuditLog({
      admin: req.user?.id,
      action: "BLOCK_USER",
      module: "USER",
      targetId: user.id,
      targetName: user.email,
      description: `Blocked user ${user.email}`,
      req,
    });

    return res.status(200).json({
      success: true,
      message: "User blocked successfully",
      user,
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message,
    });
  }
};

export const UnBlockUser = async (req, res) => {
  try {
    const user = await setUserActiveStatus({
      id: req.params.id,
      isActive: true,
      adminId: req.user?.id,
    });

    await createAuditLog({
      admin: req.user?.id,
      action: "UNBLOCK_USER",
      module: "USER",
      targetId: user.id,
      targetName: user.email,
      description: `Unblocked user ${user.email}`,
      req,
    });

    return res.status(200).json({
      success: true,
      message: "User unblocked successfully",
      user,
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message,
    });
  }
};

// Plain-language explanations shown to non-technical admins when a CSV row
// is rejected, instead of raw schema field names like "producthightlight".
const BULK_IMPORT_FIELD_HINTS = {
  name: "name is required",
  description: "description is required",
  price: "price must be a number of 0 or more",
  category_id: "category could not be matched — check the category name is spelled exactly as it appears in Products, or use its category ID",
  brand: "brand (or publisher) is required",
  stock: "stock must be a whole number of 0 or more",
  producthightlight: "producthightlight (a short highlight/USP for the product) is required",
  image: "image is required — paste a direct image URL",
};

export const BulkImportProducts = async (req, res) => {
  try {
    const products = Array.isArray(req.body?.products) ? req.body.products : [];
    if (products.length === 0) {
      return res.status(400).json({ success: false, message: "Products array is required" });
    }

    const categories = await Category.find().select("name");
    const categoryIdByName = new Map(
      categories.map((category) => [category.name.trim().toLowerCase(), String(category._id)]),
    );

    const errors = [];
    const payload = [];
    products.forEach((item, index) => {
      const product = normalizeBulkProduct(item, categoryIdByName);
      const missing = [];
      if (!product.name) missing.push("name");
      if (!product.description) missing.push("description");
      if (!Number.isFinite(product.price) || product.price < 0) missing.push("price");
      if (!product.category_id || !mongoose.Types.ObjectId.isValid(product.category_id)) {
        missing.push("category_id");
      }
      if (!product.brand) missing.push("brand");
      if (!Number.isInteger(product.stock) || product.stock < 0) missing.push("stock");
      if (!product.producthightlight) missing.push("producthightlight");
      if (!product.image) missing.push("image");

      // Parity with CreateProduct, which refuses this outright. Without the same
      // check here, bulk import was an open door to the exact bad data the
      // single-product endpoint rejects: a selling price above the printed MRP,
      // which makes the storefront's (mrp - price) / mrp discount badge negative
      // and, in India, is not merely a presentation problem.
      const priceAboveMrp =
        Number.isFinite(product.price) &&
        Number.isFinite(product.mrp) &&
        product.price > product.mrp;

      if (missing.length > 0 || priceAboveMrp) {
        const notes = missing.map((field) => BULK_IMPORT_FIELD_HINTS[field] || field);
        if (priceAboveMrp) {
          notes.push(
            `price (₹${product.price}) is above mrp (₹${product.mrp}) — MRP is the maximum retail price, so the selling price must be equal to or below it`,
          );
        }
        // +2: CSV rows are 1-indexed and row 1 is the header, so this matches
        // the row number an admin would count in their spreadsheet.
        errors.push({
          row: index + 2,
          fields: [...new Set(priceAboveMrp ? [...missing, "price", "mrp"] : missing)],
          message: notes.join("; "),
        });
      } else {
        // Imported products get the same derived SEO fields a created one does.
        // Without this they land with an empty slug, so the sitemap lists them
        // less readably than anything added through the admin form.
        payload.push({ ...product, ...buildSeoFields({ name: product.name }) });
      }
    });

    if (errors.length > 0) {
      return res.status(400).json({
        success: false,
        message: `${errors.length} of ${products.length} row(s) have problems. Nothing was imported yet — fix these and re-upload the file.`,
        errors,
      });
    }

    let created;
    try {
      created = await Product.insertMany(payload, { ordered: false });
    } catch (bulkError) {
      const insertedCount = bulkError.insertedDocs?.length || bulkError.result?.insertedCount || 0;
      return res.status(207).json({
        success: false,
        message: `Only ${insertedCount} of ${payload.length} products were imported before an error occurred: ${bulkError.message}`,
        count: insertedCount,
      });
    }

    invalidateCatalogueCache();
    await createAuditLog({
      admin: req.user?.id,
      action: "BULK_IMPORT_PRODUCTS",
      module: "PRODUCT",
      description: `Imported ${created.length} products`,
      req,
    });

    return res.status(201).json({
      success: true,
      message: "Products imported",
      count: created.length,
      data: created,
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const ExportProducts = async (req, res) => {
  try {
    const products = await Product.find()
      .populate("category_id", "name")
      .sort({ createdAt: -1 })
      .lean();

    // Same column names and order Bulk Import expects, so exporting, editing
    // a few rows in a spreadsheet, and re-importing actually round-trips
    // instead of failing on every row (category_id here is the category's
    // name, which Import also accepts — no one has to look up a raw id).
    const rows = [
      ["id", "name", "description", "price", "mrp", "category_id", "brand", "author", "publisher", "isbn", "language", "pages", "edition", "publicationYear", "stock", "producthightlight", "image", "bestseller", "createdAt"],
      ...products.map((product) => [
        product._id,
        product.name,
        product.description,
        product.price,
        product.mrp,
        product.category_id?.name || "",
        product.brand,
        product.author || "",
        product.publisher || "",
        product.isbn || "",
        product.language || "",
        product.pages || 0,
        product.edition || "",
        product.publicationYear ?? "",
        product.stock,
        product.producthightlight,
        product.image,
        product.bestseller,
        product.createdAt?.toISOString?.() || "",
      ]),
    ];

    return sendCsv(res, "products-export.csv", rows);
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const BulkUpdateProducts = async (req, res) => {
  try {
    const updates = Array.isArray(req.body?.updates) ? req.body.updates : [];
    if (updates.length === 0) {
      return res.status(400).json({ success: false, message: "Updates array is required" });
    }

    // Which of these products are stocked per variant? Their totals are the sum of
    // their variants, so an absolute stock write here would desynchronise the two —
    // the bulk path had no variant awareness at all. Looked up once, not per item.
    const targetIds = updates
      .map((item) => item.productId || item._id || item.id)
      .filter((id) => mongoose.Types.ObjectId.isValid(id));
    // One read, not two: the stored price and mrp are needed as well, because a
    // bulk row may set only one side of the pair and the guard has to compare
    // what the product will actually be saved with.
    const targets = await Product.find({ _id: { $in: targetIds } })
      .select("_id price mrp variants")
      .lean();
    const variantManaged = new Set(
      targets
        .filter((product) => (product.variants?.length || 0) > 0)
        .map((product) => String(product._id)),
    );
    const storedById = new Map(targets.map((product) => [String(product._id), product]));
    const stockSkipped = [];
    const priceRejected = [];

    const operations = [];
    for (const item of updates) {
      const productId = item.productId || item._id || item.id;
      if (!mongoose.Types.ObjectId.isValid(productId)) continue;

      const $set = {};
      if (item.price !== undefined) {
        const price = Number(item.price);
        if (Number.isFinite(price) && price >= 0) $set.price = price;
      }
      if (item.mrp !== undefined) {
        const mrp = Number(item.mrp);
        if (Number.isFinite(mrp) && mrp >= 0) $set.mrp = mrp;
      }
      if (item.stock !== undefined) {
        const stock = Number(item.stock);
        // Reported back rather than dropped quietly: the caller asked for something
        // that cannot be honoured, and a silent skip inside a bulk result looks
        // identical to success.
        if (variantManaged.has(String(productId))) {
          stockSkipped.push(String(productId));
        } else if (Number.isInteger(stock) && stock >= 0) {
          $set.stock = stock;
        }
      }
      if (item.bestseller !== undefined) $set.bestseller = Boolean(item.bestseller);

      // The same price <= mrp rule CreateProduct and UpdateProduct enforce, and
      // for the same reason: selling above the printed MRP is not merely a
      // negative discount badge. The case that matters is the ONE-SIDED row —
      // raising price without mentioning mrp, or lowering mrp without mentioning
      // price — so this compares the values the product will end up with, not
      // just the two numbers that happened to be in the row.
      const stored = storedById.get(String(productId));
      const nextPrice = $set.price !== undefined ? $set.price : Number(stored?.price);
      const nextMrp = $set.mrp !== undefined ? $set.mrp : Number(stored?.mrp);
      if (Number.isFinite(nextPrice) && Number.isFinite(nextMrp) && nextPrice > nextMrp) {
        // Reported, not silently dropped — and the whole pricing pair is backed
        // out rather than half-applied, which would leave the product in exactly
        // the state being refused.
        priceRejected.push({ productId: String(productId), price: nextPrice, mrp: nextMrp });
        delete $set.price;
        delete $set.mrp;
      }

      if (Object.keys($set).length > 0) {
        operations.push({
          updateOne: {
            filter: { _id: productId },
            update: { $set },
          },
        });
      }
    }

    if (operations.length === 0) {
      return res.status(400).json({
        success: false,
        message:
          priceRejected.length > 0
            ? "No updates were applied: every row asked for a price above its MRP."
            : "No valid updates provided",
        ...(priceRejected.length > 0 ? { priceRejected } : {}),
      });
    }

    const result = await Product.bulkWrite(operations);
    invalidateCatalogueCache();
    await createAuditLog({
      admin: req.user?.id,
      action: "BULK_UPDATE_PRODUCTS",
      module: "PRODUCT",
      description: `Bulk updated ${result.modifiedCount} products`,
      req,
    });

    return res.status(200).json({
      success: true,
      message: "Products updated",
      result,
      // Present only when something was refused, so existing callers see no change.
      ...(stockSkipped.length > 0
        ? {
            stockSkipped,
            stockSkippedReason: VARIANT_MANAGED_STOCK_MESSAGE,
          }
        : {}),
      ...(priceRejected.length > 0
        ? {
            priceRejected,
            priceRejectedReason:
              "Price cannot be greater than MRP. These rows kept their existing price and MRP; every other field in them was still applied.",
          }
        : {}),
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Read-only COD reconciliation. Writes nothing and fixes nothing: every discrepancy it
 * reports needs a human decision, and two of them have opposite remedies depending on
 * why they happened.
 */
export const GetCodReconciliation = async (req, res) => {
  try {
    const report = await buildCodReconciliation({ limit: req.query?.limit });
    return res.status(200).json({ success: true, ...report });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const GetSalesReport = async (req, res) => {
  try {
    const report = await buildSalesReportData(req.query);
    return res.status(200).json({
      success: true,
      ...report,
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// Operational health / configuration report. Deliberately gated behind
// DASHBOARD_READ rather than being public: it enumerates which safety
// mechanisms are switched off, which is useful to an operator and useful to an
// attacker. Returns no secrets — only booleans, modes and remediation text.
export const GetSystemHealth = async (req, res) => {
  try {
    const health = await buildSystemHealth();
    return res.status(200).json({ success: true, ...health });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};
