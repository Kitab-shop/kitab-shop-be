/**
 * Confirm uploads/static/ holds every asset the frontend hardcodes.
 *
 *   node scripts/verify-static-assets.js
 *
 * This used to be fetch-static-images.js, which downloaded these from three
 * third-party image hosts on first run — including one account this project no
 * longer owns. That made a deploy depend on hosts nobody here controls, for
 * files that are COMMITTED to the repo and so already present after a clone.
 *
 * So it verifies instead of fetching, and reaches no network at all. A missing
 * file is restored from git, not re-downloaded:
 *
 *   git checkout -- uploads/static/
 *
 * The one exception is placeholder.webp, drawn locally below: it is what every
 * broken <img> in the storefront falls back to, so being able to reproduce it
 * without a network or a working checkout is worth the twenty lines.
 */
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { uploadsRoot } from "../src/config/storage.config.js";

const staticDir = join(uploadsRoot, "static");

// Required: each of these is named by a frontend constant, so a missing one is
// a visible break — a broken image, not a degraded one.
const REQUIRED = [
  { file: "placeholder.webp", usedBy: "PLACEHOLDER_IMAGE — every failed <img>" },
  { file: "default-banner.webp", usedBy: "DEFAULT_BANNER_IMAGE — homepage with no banner set" },
  { file: "stardust.png", usedBy: "TEXTURE_IMAGE — admin background texture" },
  { file: "about-default.webp", usedBy: "DEFAULT_ABOUT_IMAGE — about page" },
];

// Present in the repo but not referenced by any current frontend constant.
// Reported, never fatal: they are astrology-era leftovers, and deleting them is
// a decision for whoever owns that content.
const OPTIONAL = [
  "book-placeholder.webp",
  "blog-diwali-pooja-vidhi-checklist.webp",
  "blog-how-to-choose-the-right-gemstone.webp",
  "blog-live-astrology-consultation-guide.webp",
  "blog-rudraksha-mukhi-guide.webp",
  "blog-understanding-mangal-dosha.webp",
  "blog-vastu-tips-for-new-home.webp",
];

const exists = async (path) => {
  const info = await stat(path).catch(() => null);
  return info?.size > 0;
};

/** A neutral local stand-in, drawn rather than downloaded. */
const drawPlaceholder = async () => {
  const size = 600;
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
       <rect width="${size}" height="${size}" fill="#f0ebe8"/>
       <circle cx="${size / 2}" cy="${size / 2 - 28}" r="72" fill="none"
               stroke="#8B6914" stroke-width="8" opacity="0.55"/>
       <path d="M${size / 2 - 46} ${size / 2 + 84} h92" stroke="#8B6914"
             stroke-width="8" stroke-linecap="round" opacity="0.55"/>
     </svg>`,
  );
  return sharp(svg).webp({ quality: 82 }).toBuffer();
};

await mkdir(staticDir, { recursive: true });
console.log(`Verifying static assets in ${staticDir}\n`);

const missing = [];

for (const { file, usedBy } of REQUIRED) {
  const target = join(staticDir, file);
  if (await exists(target)) {
    console.log(`  ok      ${file}`);
    continue;
  }

  if (file === "placeholder.webp") {
    await writeFile(target, await drawPlaceholder());
    console.log(`  redrawn ${file}`);
    continue;
  }

  console.error(`  MISSING ${file}  — ${usedBy}`);
  missing.push(file);
}

const optionalMissing = [];
for (const file of OPTIONAL) {
  if (!(await exists(join(staticDir, file)))) optionalMissing.push(file);
}
if (optionalMissing.length > 0) {
  console.log(`\n  ${optionalMissing.length} unreferenced extra(s) absent — harmless:`);
  optionalMissing.forEach((file) => console.log(`    - ${file}`));
}

if (missing.length > 0) {
  console.error(
    `\n${missing.length} required asset(s) missing. They are committed, so restore them with:\n` +
      `  git checkout -- uploads/static/\n`,
  );
  process.exitCode = 1;
} else {
  console.log(`\nAll ${REQUIRED.length} required assets present.`);
}
