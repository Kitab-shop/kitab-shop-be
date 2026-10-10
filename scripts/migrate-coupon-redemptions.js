/**
 * Moves per-customer coupon redemptions out of `coupons.usedBy[]` and into the
 * `couponredemptions` collection.
 *
 * WHY. `usedBy` was an unbounded array — one subdocument per redeeming customer,
 * loaded and scanned in application memory on every coupon validation. It also made
 * `coupon.usage` ambiguous: a `pre("validate")` hook recomputed it from the array on
 * every `.save()`, while the cancellation path `$inc`-ed it directly. A coupon's new
 * `globalMaxRedemptions` budget gates real money on `usage`, and a counter that an
 * ordinary admin edit silently rewrites cannot carry that.
 *
 * WHAT IT DOES. One `couponredemptions` row per `usedBy` entry, and nothing else.
 *
 * WHAT IT DELIBERATELY DOES NOT DO:
 *   - It does not `$unset` `usedBy`. The field is gone from the schema, so Mongoose
 *     ignores it; leaving the data costs nothing and makes this reversible. Drop it
 *     in a later, separate cleanup once you are satisfied.
 *   - It does not rewrite `coupon.usage`. It REPORTS any coupon where `usage`
 *     disagrees with the sum of its entries and leaves the value alone — a
 *     disagreement means something happened that this script does not understand,
 *     and quietly "fixing" it would destroy the evidence.
 *   - It does not set `globalMaxRedemptions`. The schema default of 0 (unlimited)
 *     is correct for every pre-existing coupon: they were sold with no total cap and
 *     must keep behaving that way until an admin decides otherwise.
 *
 * SAFE TO RE-RUN. Every write is an idempotent upsert keyed on {coupon, user}, and
 * the count is `$set`, not `$inc`, so a second run writes the same values.
 *
 * DEPLOYMENT ORDER. Run this BEFORE the new code serves traffic. Until it runs, the
 * new code reads an empty redemption collection and would let a customer redeem a
 * coupon they had already used.
 *
 *   node scripts/migrate-coupon-redemptions.js --check    # report only
 *   node scripts/migrate-coupon-redemptions.js            # apply
 */
import "dotenv/config";
import mongoose from "mongoose";

const CHECK_ONLY = process.argv.includes("--check");

// Dynamically imported so this cannot drift from the live schema.
const { default: CouponRedemption } = await import(
  "../src/modules/coupons/coupon-redemption.model.js"
);
// CouponModel is imported for ONE reason: to get the collection name from the model
// rather than guess it. Mongoose derives it from the model NAME, and this model is
// registered as "CouponModel", so the collection is `couponmodels` — not `coupons`.
// This script originally hardcoded "coupons", which does not exist: it would have
// found nothing, reported "0 coupons carrying redemptions", exited 0, and left every
// real redemption unmigrated. The new code would then have read an empty redemption
// collection and let customers re-spend coupons they had already used.
const { default: CouponModel } = await import("../src/modules/coupons/coupon.model.js");

const uri =
  process.env.mango_url ||
  process.env.mongo_url ||
  process.env.MONGO_URI ||
  process.env.MONGODB_URI ||
  process.env.MONGO_URL;

if (!uri) {
  console.error("No MongoDB connection string in the environment.");
  process.exit(1);
}

await mongoose.connect(uri);

console.log(`\nDatabase: ${mongoose.connection.name}`);
console.log(CHECK_ONLY ? "Mode: CHECK ONLY (no changes)\n" : "Mode: APPLY\n");

// ── 1. Indexes first ────────────────────────────────────────────────────────
// The unique {coupon, user} index is what stops two rows existing for one pair.
// Creating it after the backfill would mean a concurrent live redemption could
// insert a duplicate that the index then refuses to build over.
if (!CHECK_ONLY) {
  await CouponRedemption.syncIndexes();
  console.log("Indexes ensured on couponredemptions.\n");
}

// ── 2. Read the legacy arrays ───────────────────────────────────────────────
// Through the model's RAW COLLECTION HANDLE, which is the point: the raw driver
// bypasses the schema (so `usedBy`, which the schema no longer declares, is still
// readable) while the collection NAME still comes from the model, so it cannot be
// wrong. Printed below so a run against the wrong database is obvious.
const couponCollection = CouponModel.collection;
console.log(`Reading coupons from: ${couponCollection.collectionName}`);

const coupons = await couponCollection
  .find({ "usedBy.0": { $exists: true } })
  .project({ couponId: 1, usage: 1, usedBy: 1 })
  .toArray();

console.log(`Coupons in collection:        ${await couponCollection.countDocuments({})}`);
console.log(`Coupons carrying redemptions: ${coupons.length}`);

let rows = 0;
let written = 0;
let skipped = 0;
const mismatches = [];

for (const coupon of coupons) {
  const entries = Array.isArray(coupon.usedBy) ? coupon.usedBy : [];
  const summed = entries.reduce((total, entry) => total + (Number(entry?.count) || 0), 0);
  const stored = Number(coupon.usage) || 0;
  if (summed !== stored) {
    mismatches.push({ couponId: coupon.couponId, stored, summed });
  }

  for (const entry of entries) {
    if (!entry?.user) {
      skipped += 1;
      continue;
    }
    rows += 1;
    if (CHECK_ONLY) continue;

    // $set, not $inc: re-running must converge on the same number rather than
    // doubling every count.
    await CouponRedemption.updateOne(
      { coupon: String(coupon.couponId).toUpperCase(), user: entry.user },
      {
        $set: {
          count: Number(entry.count) || 0,
          lastUsedAt: entry.lastUsedAt || new Date(),
        },
      },
      { upsert: true },
    );
    written += 1;
  }
}

console.log(`Redemption rows found:   ${rows}`);
console.log(CHECK_ONLY ? "Rows that would be written: " + rows : `Rows written:            ${written}`);
if (skipped) console.log(`Entries skipped (no user): ${skipped}`);

if (mismatches.length) {
  console.log(`\n${mismatches.length} coupon(s) where usage disagrees with the sum of entries.`);
  console.log("NOT corrected — investigate before trusting the global cap on these:");
  for (const row of mismatches) {
    console.log(`  ${row.couponId}: usage=${row.stored}, sum(usedBy)=${row.summed}`);
  }
} else {
  console.log("\nusage matches the sum of entries on every coupon.");
}

console.log("\nRe-running is safe and converges on the same rows.");

await mongoose.disconnect();
process.exit(0);
