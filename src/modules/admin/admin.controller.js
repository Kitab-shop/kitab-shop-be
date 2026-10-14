import Product from "../products/Product.model.js";
import Category from "../categories/Category.model.js";
import UserAuthentication from "../../model/User.model.js";
import UserProfile from "../profiles/UserProfile.model.js";
import Order from "../orders/Order.model.js";
import { EXCLUDE_AWAITING_PAYMENT } from "../orders/order-visibility.js";
import mongoose from "mongoose";
import { VARIANT_MANAGED_STOCK_MESSAGE, hasVariantStock } from "../inventory/variant.service.js";
import { saveImageAsset } from "../../utils/image-upload.js";
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
  isAcceptableImageUrl,
  normalizeBulkProduct,
  parseBulkBoolean,
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
  mrp: "mrp must be a number of 0 or more",
  category_id: "category could not be matched — check the category name is spelled exactly as it appears in Products, or use its category ID",
  brand: "brand (or publisher) is required",
  stock: "stock must be a whole number of 0 or more",
  producthightlight: "producthightlight (a short highlight/USP for the product) is required",
  image: "image must be the file name of a picture you selected (e.g. rivers-daughter.jpg) or a direct picture link starting with https://",
  publicationYear: "publicationYear must be a year, e.g. 2025",
};

const describePriceAboveMrp = (price, mrp) =>
  `price (₹${price}) is above mrp (₹${mrp}) — MRP is the maximum retail price, so the selling price must be equal to or below it`;

// Which spreadsheet columns feed each stored field when a row UPDATES an
// existing product. Only filled-in cells are applied — a blank cell means
// "leave this as it is", so a half-filled sheet cannot wipe a product. public_id
// and slug are never written from a sheet, matching UpdateProduct.
const BULK_UPDATE_COLUMNS = {
  name: ["name"],
  description: ["description"],
  price: ["price"],
  mrp: ["mrp"],
  category_id: ["category_id", "categoryId", "category"],
  size: ["size"],
  brand: ["brand"],
  stock: ["stock"],
  producthightlight: ["producthightlight", "highlight"],
  image: ["image"],
  bestseller: ["bestseller"],
  author: ["author"],
  authorBio: ["authorBio", "authorbio"],
  publisher: ["publisher"],
  isbn: ["isbn"],
  language: ["language"],
  pages: ["pages"],
  edition: ["edition"],
  publicationYear: ["publicationYear"],
};

const hasFilledCell = (item, columns) =>
  columns.some((column) => String(item[column] ?? "").trim() !== "");

// Export Products writes the id as "id"; API callers may send either of the others.
const bulkRowProductId = (item) => String(item.id || item._id || item.productId || "").trim();

/**
 * Turns one sheet row that names an existing product into an updateOne, or a
 * row error. Returns {} when the row asks for no change at all.
 */
const buildBulkProductUpdate = ({ item, product, productId, stored, seenIds, imageOk }) => {
  if (!stored) {
    return {
      error: {
        fields: ["id"],
        message: `id ${productId} does not match any product in the shop — it may have been deleted. To add this row as a new product, clear its id cell.`,
      },
    };
  }
  if (seenIds.has(productId)) {
    return {
      error: {
        fields: ["id"],
        message: `this product (id ${productId}) appears more than once in the file — keep only one row for it`,
      },
    };
  }
  seenIds.add(productId);

  const $set = {};
  for (const [field, columns] of Object.entries(BULK_UPDATE_COLUMNS)) {
    if (hasFilledCell(item, columns)) $set[field] = product[field];
  }

  const problems = [];
  const notes = [];
  const refuse = (field, note = BULK_IMPORT_FIELD_HINTS[field]) => {
    problems.push(field);
    notes.push(note);
  };

  if ("price" in $set && (!Number.isFinite($set.price) || $set.price < 0)) refuse("price");
  if ("mrp" in $set && (!Number.isFinite($set.mrp) || $set.mrp < 0)) refuse("mrp");
  if ("category_id" in $set && !mongoose.Types.ObjectId.isValid($set.category_id)) refuse("category_id");
  if ("publicationYear" in $set && $set.publicationYear === null) refuse("publicationYear");
  if ("image" in $set) {
    // Unchanged is not re-checked: older products hold full-URL images from
    // before /uploads paths, and re-importing an export must not refuse them.
    if ($set.image === stored.image) delete $set.image;
    else if (!imageOk($set.image)) refuse("image");
  }
  if ("stock" in $set) {
    if (!Number.isInteger($set.stock) || $set.stock < 0) {
      refuse("stock");
    } else if (hasVariantStock(stored)) {
      // An export carries the variant total, so the same number coming back is
      // no request at all; a different one cannot be honoured.
      if ($set.stock === Number(stored.stock)) delete $set.stock;
      else refuse("stock", `stock: ${VARIANT_MANAGED_STOCK_MESSAGE}`);
    }
  }

  // Compared against what the product will be SAVED with, as BulkUpdateProducts
  // does: a row raising only the price must be checked against the stored MRP.
  if (("price" in $set || "mrp" in $set) && !problems.includes("price") && !problems.includes("mrp")) {
    const nextPrice = "price" in $set ? $set.price : Number(stored.price);
    const nextMrp = "mrp" in $set ? $set.mrp : Number(stored.mrp);
    if (Number.isFinite(nextPrice) && Number.isFinite(nextMrp) && nextPrice > nextMrp) {
      problems.push("price", "mrp");
      notes.push(describePriceAboveMrp(nextPrice, nextMrp));
    }
  }

  if (problems.length > 0) {
    return { error: { fields: [...new Set(problems)], message: notes.join("; ") } };
  }

  // Re-importing a whole export where a few rows were edited is the normal case,
  // so cells that already match are dropped: the untouched rows write nothing
  // (Mongoose would otherwise bump updatedAt on each) and the "updated" count
  // reported back means products that actually changed.
  for (const field of Object.keys($set)) {
    if (String(stored[field] ?? "") === String($set[field] ?? "")) delete $set[field];
  }

  if ($set.image) {
    // Same shape as mergePrimaryImage in product.controller.js: the new picture
    // becomes the primary, the rest of the gallery is kept.
    $set.images = [$set.image, ...(stored.images || []).slice(1).filter((image) => image !== $set.image)];
  }

  if (Object.keys($set).length === 0) return {};
  return { update: { updateOne: { filter: { _id: productId }, update: { $set } } } };
};

export const BulkImportProducts = async (req, res) => {
  try {
    const products = Array.isArray(req.body?.products) ? req.body.products : [];
    if (products.length === 0) {
      return res.status(400).json({ success: false, message: "Products array is required" });
    }

    // A dry run validates the whole file and writes nothing. The admin page uses
    // it to check a CSV BEFORE uploading its pictures, so a file with mistakes
    // never leaves orphaned pictures on disk. Selected picture file names count
    // as valid images only here; the real import must carry the /uploads paths
    // the picture upload returned.
    const dryRun = req.body?.dryRun === true;
    const uploadNames = new Set(
      dryRun && Array.isArray(req.body?.uploadNames)
        ? req.body.uploadNames.map((name) => String(name).trim().toLowerCase())
        : [],
    );
    const imageOk = (value) =>
      isAcceptableImageUrl(value) || uploadNames.has(String(value || "").trim().toLowerCase());

    const categories = await Category.find().select("name");
    const categoryIdByName = new Map(
      categories.map((category) => [category.name.trim().toLowerCase(), String(category._id)]),
    );

    // Rows carrying an id update that product. Looked up once, not per row.
    const targetIds = products
      .map(bulkRowProductId)
      .filter((id) => mongoose.Types.ObjectId.isValid(id));
    const targets = targetIds.length > 0
      ? await Product.find({ _id: { $in: targetIds } })
        .select(["_id", "variants", "images", ...Object.keys(BULK_UPDATE_COLUMNS)].join(" "))
        .lean()
      : [];
    const storedById = new Map(targets.map((product) => [String(product._id), product]));
    const seenIds = new Set();

    const errors = [];
    const payload = [];
    const updates = [];
    let updateRowCount = 0;
    products.forEach((item, index) => {
      // +2: CSV rows are 1-indexed and row 1 is the header, so this matches
      // the row number an admin would count in their spreadsheet.
      const row = index + 2;
      const product = normalizeBulkProduct(item, categoryIdByName);
      const productId = bulkRowProductId(item);

      if (productId) {
        updateRowCount += 1;
        const result = buildBulkProductUpdate({
          item,
          product,
          productId,
          stored: storedById.get(productId),
          seenIds,
          imageOk,
        });
        if (result.error) errors.push({ row, ...result.error });
        else if (result.update) updates.push(result.update);
        return;
      }

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
      if (!imageOk(product.image)) missing.push("image");

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
        if (priceAboveMrp) notes.push(describePriceAboveMrp(product.price, product.mrp));
        errors.push({
          row,
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

    if (dryRun) {
      return res.status(200).json({
        success: true,
        dryRun: true,
        message: `The file looks good: ${payload.length} new product(s) to add and ${updateRowCount} existing product(s) to update.`,
        toCreate: payload.length,
        toUpdate: updateRowCount,
      });
    }

    let modifiedCount = 0;
    if (updates.length > 0) {
      try {
        const result = await Product.bulkWrite(updates, { ordered: false });
        modifiedCount = result.modifiedCount;
      } catch (bulkError) {
        invalidateCatalogueCache();
        return res.status(207).json({
          success: false,
          message: `Updating existing products stopped with an error, so no new products were added: ${bulkError.message}`,
          count: 0,
          updated: bulkError.result?.modifiedCount || 0,
        });
      }
    }

    let created = [];
    if (payload.length > 0) {
      try {
        created = await Product.insertMany(payload, { ordered: false });
      } catch (bulkError) {
        invalidateCatalogueCache();
        const insertedCount = bulkError.insertedDocs?.length || bulkError.result?.insertedCount || 0;
        return res.status(207).json({
          success: false,
          message: `${modifiedCount} existing product(s) were updated, but only ${insertedCount} of ${payload.length} new products were added before an error occurred: ${bulkError.message}`,
          count: insertedCount,
          updated: modifiedCount,
        });
      }
    }

    invalidateCatalogueCache();
    await createAuditLog({
      admin: req.user?.id,
      action: "BULK_IMPORT_PRODUCTS",
      module: "PRODUCT",
      description: `Bulk import: ${created.length} added, ${modifiedCount} updated`,
      req,
    });

    return res.status(created.length > 0 ? 201 : 200).json({
      success: true,
      message: `${created.length} new product(s) added, ${modifiedCount} updated`,
      count: created.length,
      created: created.length,
      updated: modifiedCount,
      // Rows that named a product but changed nothing — re-importing a whole
      // export where only a few rows were edited is the normal case.
      unchanged: updateRowCount - modifiedCount,
      data: created,
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// Pictures for a bulk import, uploaded in small batches BEFORE the import itself:
// one request cannot carry them all (nginx caps a body at 12 MB). Stored exactly
// as a single-product upload is, so a bulk-imported cover is indistinguishable
// from one added through the product form. Results are in the same order as the
// files sent, so callers match by position rather than by a re-encoded file name.
export const UploadBulkProductImages = async (req, res) => {
  const files = Array.isArray(req.files) ? req.files : [];
  if (files.length === 0) {
    return res.status(400).json({ success: false, message: "Select at least one picture to upload" });
  }

  const images = [];
  for (const file of files) {
    try {
      const saved = await saveImageAsset({
        file,
        folder: "products",
        name: file.originalname.replace(/\.[^.]+$/, ""),
        width: 500,
        height: 500,
        quality: 80,
      });
      images.push({ name: file.originalname, image: saved.image });
    } catch {
      // sharp refuses a file that claims to be a picture but isn't a readable one.
      return res.status(400).json({
        success: false,
        message: `The picture "${file.originalname}" could not be read. Open it and save it again as JPG or PNG, then retry.`,
        images,
      });
    }
  }

  await createAuditLog({
    admin: req.user?.id,
    action: "BULK_UPLOAD_PRODUCT_IMAGES",
    module: "PRODUCT",
    description: `Uploaded ${images.length} product picture(s) for bulk import`,
    req,
  });

  return res.status(201).json({ success: true, images });
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
      ["id", "name", "description", "price", "mrp", "category_id", "brand", "author", "authorBio", "publisher", "isbn", "language", "pages", "edition", "publicationYear", "stock", "producthightlight", "image", "bestseller", "createdAt"],
      ...products.map((product) => [
        product._id,
        product.name,
        product.description,
        product.price,
        product.mrp,
        product.category_id?.name || "",
        product.brand,
        product.author || "",
        product.authorBio || "",
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
      if (item.bestseller !== undefined) $set.bestseller = parseBulkBoolean(item.bestseller);

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
