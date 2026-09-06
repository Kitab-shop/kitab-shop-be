import mongoose from "mongoose";
import Order from "../orders/Order.model.js";
import { EXCLUDE_AWAITING_PAYMENT } from "../orders/order-visibility.js";
import UserAuthentication from "../../model/User.model.js";
import UserProfile from "../profiles/UserProfile.model.js";
import {
  ADMIN_ROLES,
  getPrimaryRole,
  getUserPermissions,
  normalizeRoles,
} from "../../config/admin-permissions.config.js";

export const escapeCsv = (value) => {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

export const sendCsv = (res, filename, rows) => {
  const csv = rows.map((row) => row.map(escapeCsv).join(",")).join("\n");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  return res.status(200).send(csv);
};

export const buildLast7Days = () => {
  const days = [];

  for (let i = 6; i >= 0; i -= 1) {
    const date = new Date();
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() - i);

    days.push({
      key: date.toISOString().slice(0, 10),
      day: date.toLocaleDateString("en-IN", { weekday: "short" }),
    });
  }

  return days;
};

const formatUserProfile = (profile) => {
  if (!profile) return null;

  return {
    fullName: profile.fullName || "",
    firstName: profile.firstName || "",
    lastName: profile.lastName || "",
    phoneNumber: profile.phoneNumber || "",
    city: profile.address?.city || "",
    state: profile.address?.state || "",
  };
};

export const formatAdminUser = ({ user, profile, ordersCount = 0 }) => ({
  _id: user._id,
  id: user._id,
  email: user.email,
  role: getPrimaryRole(user),
  roles: normalizeRoles(user),
  permissions: Array.isArray(user.permissions) ? user.permissions : [],
  effectivePermissions: getUserPermissions(user),
  isVerified: Boolean(user.isVerified),
  isActive: user.isActive !== false && user.isBlocked !== true,
  createdAt: user.createdAt,
  updatedAt: user.updatedAt,
  ordersCount,
  walletBalance: profile?.walletBalance || 0,
  totalReferrals: profile?.totalReferrals || 0,
  referralCode: profile?.referralCode || "",
  profile: formatUserProfile(profile),
});

export const setUserActiveStatus = async ({ id, isActive, adminId }) => {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    const error = new Error("Invalid user id");
    error.statusCode = 400;
    throw error;
  }

  if (String(id) === String(adminId)) {
    const error = new Error("You cannot change your own account status");
    error.statusCode = 403;
    throw error;
  }

  const user = await UserAuthentication.findById(id).select("-password -Resettoken");

  if (!user) {
    const error = new Error("User not found");
    error.statusCode = 404;
    throw error;
  }

  if (normalizeRoles(user).some((role) => ADMIN_ROLES.includes(role))) {
    const error = new Error("Admin accounts cannot be blocked");
    error.statusCode = 403;
    throw error;
  }

  user.isActive = isActive;
  user.isBlocked = !isActive;
  user.blockedAt = isActive ? null : new Date();
  await user.save();

  const [profile, ordersCount] = await Promise.all([
    UserProfile.findOne({ userid: user._id }),
    // Excludes abandoned prepaid checkouts — this count is shown to admins as
    // "orders placed" on a customer's profile.
    Order.countDocuments({ user: user._id, ...EXCLUDE_AWAITING_PAYMENT }),
  ]);

  return formatAdminUser({ user, profile, ordersCount });
};

// Bulk-import CSVs are filled in by non-technical admins who have no way to
// look up a category's raw Mongo ObjectId, so a plain category name (matched
// case-insensitively against categoryIdByName) is accepted alongside an id.
export const normalizeBulkProduct = (item = {}, categoryIdByName = new Map()) => {
  // "category" (not "category_id") is what Export Products actually emits —
  // accepted here too so an admin who exports, edits, and re-imports a CSV
  // doesn't have every row fail just because of the column name.
  const rawCategory = String(item.category_id || item.categoryId || item.category || "").trim();
  const category_id = mongoose.Types.ObjectId.isValid(rawCategory)
    ? rawCategory
    : categoryIdByName.get(rawCategory.toLowerCase()) || "";

  return {
    name: String(item.name || "").trim(),
    description: String(item.description || "").trim(),
    price: Number(item.price),
    mrp: item.mrp === undefined || item.mrp === "" ? Number(item.price) : Number(item.mrp),
    category_id,
    size: item.size || "Standard",
    brand: String(item.brand || "").trim() || String(item.publisher || "").trim(),
    stock: Number(item.stock || 0),
    producthightlight: String(item.producthightlight || item.highlight || "").trim(),
    image: String(item.image || "").trim(),
    public_id: item.public_id || "",
    bestseller: Boolean(item.bestseller),
    // Book columns — all optional; the Product model mirrors publisher into
    // brand when brand is blank, and normalization here keeps that possible
    // by defaulting brand from publisher for CSV rows too.
    author: String(item.author || "").trim(),
    // The bulk template and its field guide have always listed authorBio, but
    // it was never read here — every imported bio was silently discarded while
    // the UI said the column was supported.
    authorBio: String(item.authorBio || item.authorbio || "").trim(),
    publisher: String(item.publisher || "").trim(),
    isbn: String(item.isbn || "").trim(),
    language: String(item.language || "").trim() || "English",
    pages: Math.max(0, Number(item.pages) || 0),
    edition: String(item.edition || "").trim(),
    publicationYear:
      item.publicationYear === undefined || item.publicationYear === "" || !Number.isFinite(Number(item.publicationYear))
        ? null
        : Number(item.publicationYear),
  };
};

export const dateRange = (query = {}) => {
  const from = query.from ? new Date(query.from) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const to = query.to ? new Date(query.to) : new Date();
  // A bare "YYYY-MM-DD" (what <input type="date"> sends) parses as UTC
  // midnight, which is already several hours into the day in IST — without
  // this, orders placed early that morning fall outside the range on both
  // ends.
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(query.from || ""))) from.setHours(0, 0, 0, 0);
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(query.to || ""))) to.setHours(23, 59, 59, 999);
  return { from, to };
};
