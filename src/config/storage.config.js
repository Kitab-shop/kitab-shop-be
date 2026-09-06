import { mkdir } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

dotenv.config();

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// Images live on the VPS disk, served from the backend's own /uploads.
// UPLOADS_DIR is absolute in
// production (a mounted volume, kept out of the deploy directory so a redeploy
// cannot wipe the catalogue) and defaults to ./uploads for local development.
export const uploadsRoot = process.env.UPLOADS_DIR
  ? resolve(process.env.UPLOADS_DIR)
  : join(projectRoot, "uploads");

// The URL prefix under which uploadsRoot is served. Stored paths begin with it,
// so changing it means rewriting the database — treat it as fixed.
export const uploadsPublicPath = "/uploads";

// Every asset type gets its own subfolder. Keys are the folder names callers
// pass to saveImageAsset; the historical folder names are accepted too so
// that a caller missed during the migration still lands somewhere sensible.
// The astro-* aliases predate the bookstore conversion and stay for
// back-compat with any stored URLs; book-* are the current-era equivalents.
const FOLDER_ALIASES = {
  products: "products",
  "astro-products": "products",
  "astro-products-image": "products",
  "book-products": "products",
  categories: "categories",
  "astro-categories": "categories",
  "book-categories": "categories",
  banners: "banners",
  "astro-banners": "banners",
  "book-banners": "banners",
  reviews: "reviews",
  "astro-reviews": "reviews",
  profiles: "profiles",
  "astro-profiles": "profiles",
  static: "static",
};

export const IMAGE_FOLDERS = [...new Set(Object.values(FOLDER_ALIASES))];

export const resolveFolder = (folder) =>
  FOLDER_ALIASES[String(folder || "").trim().toLowerCase()] || "misc";

/**
 * Absolute path for a stored asset. Rejects anything that would escape
 * uploadsRoot, so a crafted public_id from the database cannot delete files
 * elsewhere on the box.
 */
export const resolveStoragePath = (relativePath) => {
  const clean = String(relativePath || "")
    .trim()
    .replace(new RegExp(`^${uploadsPublicPath}/`), "")
    .replace(/^\/+/, "");

  if (!clean) return null;

  const absolute = resolve(uploadsRoot, clean);
  if (absolute !== uploadsRoot && !absolute.startsWith(uploadsRoot + sep)) {
    return null;
  }

  return absolute;
};

/** The value stored in Mongo, e.g. /uploads/products/red-coral-1783974426364.webp */
export const toPublicPath = (folder, fileName) =>
  `${uploadsPublicPath}/${resolveFolder(folder)}/${fileName}`;

export const ensureUploadDirs = async () => {
  await Promise.all(
    IMAGE_FOLDERS.map((folder) =>
      mkdir(join(uploadsRoot, folder), { recursive: true }),
    ),
  );
};
