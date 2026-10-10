/**
 * Issues bill-of-supply numbers to orders that were delivered before numbering
 * existed.
 *
 * Every order delivered from now on is numbered on the spot by ensureBillNumber()
 * (see order.controller.js and the Shiprocket webhook). This script is for the
 * orders already sitting at Delivered/Completed with `bill.number: null` — without
 * it the series would begin mid-life, with real supplies before it carrying no
 * number at all. That is not a defensible book of account, and it is visible to
 * customers: a January order downloads an unnumbered receipt while a February one
 * downloads RB/2025-26/0001, forever.
 *
 * What it does NOT number, deliberately: Cancelled, Closed, RTO and RTO Received.
 * Nothing was supplied, so nothing may be billed. An order that WAS delivered and
 * then fully returned still gets a number — the supply happened; unwinding it is a
 * credit note, which is out of scope.
 *
 * Numbers are assigned in order of delivery (`deliveredAt`, falling back to
 * `createdAt` for orders predating that field), bucketed into the financial year
 * each delivery actually fell in. So a backfill spanning two years produces two
 * correctly-dated series rather than one run-date series.
 *
 * Two caveats it prints at runtime, because both are real and neither is fixable:
 *   - `bill.seller` is TODAY's footer contact. The address in force at the time of
 *     an old delivery was never recorded anywhere, so this is the only honest
 *     option. Rows written here are marked `bill.source: "backfill"` so an audit
 *     can tell them apart from live mints.
 *   - `bill.issuedAt` is the historical delivery date, not the date this ran.
 *
 * ORDERING WITH DEPLOYMENT: run this before, or together with, the deploy that
 * starts minting. On first deploy there are no live-minted numbers and no
 * interleaving is possible. Once live numbers exist in a year, appending
 * historically-older orders to the END of that series would be wrong — so --check
 * refuses if it finds live mints in a year it is about to backfill.
 *
 * Safe to re-run: every write is a compare-and-swap on `bill.number: null`, so a
 * second run issues nothing and the counter does not move.
 *
 *   node scripts/migrate-bill-numbers.js            # apply
 *   node scripts/migrate-bill-numbers.js --check    # report only
 */
import "dotenv/config";
import mongoose from "mongoose";

const CHECK_ONLY = process.argv.includes("--check");

// Imported, never re-derived. The financial-year rule in particular is subtle
// enough (it is computed in IST, not UTC) that a second copy here would eventually
// disagree with the live one and file backfilled bills into the wrong year.
const { financialYear, formatBillNumber, sellerSnapshot, seedBillCounter } = await import(
  "../src/modules/orders/bill-number.service.js"
);
const { default: OrderModel } = await import("../src/modules/orders/Order.model.js");
const { default: BillCounter } = await import("../src/modules/orders/BillCounter.model.js");

const BILLABLE_STATUSES = ["Delivered", "Completed"];
const INDEX_NAME = "bill_number_unique";

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

// ── 1. The unique index must exist before anything is written ────────────────
// If it does not, a concurrent live mint could hand the same number to another
// order and nothing would stop it.
const indexes = await OrderModel.collection.indexes();
const billIndex = indexes.find((index) => index.name === INDEX_NAME);
if (!billIndex) {
  console.log(`${INDEX_NAME} is missing — creating it.`);
  if (!CHECK_ONLY) await OrderModel.createIndexes();
} else if (!billIndex.unique || billIndex.sparse) {
  console.error(`${INDEX_NAME} exists but is not the expected unique+partial index.`);
  console.error(JSON.stringify(billIndex));
  process.exit(1);
} else {
  console.log(`${INDEX_NAME}: present, unique, partial.`);
}

// ── 2. Gather what needs numbering ───────────────────────────────────────────
const pending = await OrderModel.find({
  orderStatus: { $in: BILLABLE_STATUSES },
  "bill.number": null,
})
  // Chronological by date of supply. `_id` is the tiebreaker so a re-run after a
  // partial failure reproduces exactly the same assignment rather than shuffling
  // orders that share a timestamp.
  .sort({ deliveredAt: 1, createdAt: 1, _id: 1 })
  .select("_id deliveredAt createdAt orderStatus")
  .lean();

const alreadyBilled = await OrderModel.countDocuments({ "bill.number": { $type: "string" } });

console.log(`orders at ${BILLABLE_STATUSES.join("/")} without a bill number: ${pending.length}`);
console.log(`orders already carrying a bill number: ${alreadyBilled}`);

if (pending.length === 0) {
  console.log("\nNothing to do.");
  await mongoose.disconnect();
  process.exit(0);
}

// Bucket by the financial year the delivery actually fell in.
const buckets = new Map();
for (const order of pending) {
  const supplied = order.deliveredAt ?? order.createdAt;
  const fy = financialYear(supplied);
  if (!buckets.has(fy)) buckets.set(fy, []);
  buckets.get(fy).push({ ...order, supplied });
}

const years = [...buckets.keys()].sort();
console.log(`\nfinancial years to backfill: ${years.join(", ")}`);

// ── 3. Refuse to interleave with a live series ───────────────────────────────
let blocked = false;
for (const fy of years) {
  const live = await OrderModel.countDocuments({
    "bill.financialYear": fy,
    "bill.source": "delivery",
  });
  if (live > 0) {
    console.error(
      `\nREFUSING ${fy}: ${live} bill(s) in that year were already issued live.\n` +
        "  Backfilling now would append older deliveries to the end of a series that\n" +
        "  has already moved on, so the numbers would not follow the delivery dates.\n" +
        "  Number those orders by hand, or accept that they stay unnumbered.",
    );
    blocked = true;
  }
}
if (blocked) {
  await mongoose.disconnect();
  process.exit(1);
}

for (const fy of years) {
  const rows = buckets.get(fy);
  const counter = await BillCounter.findOne({ financialYear: fy }).lean();
  const from = (counter?.seq || 0) + 1;
  console.log(
    `  ${fy}: ${rows.length} order(s), ${formatBillNumber(fy, from)} … ${formatBillNumber(fy, from + rows.length - 1)}`,
  );
}

if (CHECK_ONLY) {
  console.log("\nCheck only — nothing written.");
  await mongoose.disconnect();
  process.exit(0);
}

// ── 4. Write ─────────────────────────────────────────────────────────────────
const seller = await sellerSnapshot();
console.log(`\nSeller snapshot (TODAY's footer contact, not the one in force at the time):`);
console.log(`  ${seller.name || "(no name — check FooterSetting.contact.address)"}`);

let issued = 0;
let skipped = 0;

for (const fy of years) {
  const counter = await BillCounter.findOne({ financialYear: fy }).lean();
  let sequence = counter?.seq || 0;
  let highest = sequence;

  for (const row of buckets.get(fy)) {
    sequence += 1;
    const number = formatBillNumber(fy, sequence);
    try {
      const result = await OrderModel.updateOne(
        { _id: row._id, "bill.number": null },
        {
          $set: {
            bill: {
              number,
              financialYear: fy,
              sequence,
              issuedAt: row.supplied,
              source: "backfill",
              seller,
            },
          },
        },
      );
      if (result.modifiedCount === 1) {
        issued += 1;
        highest = sequence;
      } else {
        // Claimed by a live mint between the read above and this write.
        skipped += 1;
      }
    } catch (error) {
      if (error?.code !== 11000) throw error;
      console.error(`  ${number} already belongs to another order — skipping ${row._id}`);
      skipped += 1;
    }
  }

  // $max, never $set: a live mint may have pushed the counter past us while this
  // loop ran, and rewinding it would hand out a number that is already in use.
  await seedBillCounter(fy, highest);
  console.log(`  ${fy}: counter at ${highest}`);
}

console.log(`\nissued: ${issued}   skipped: ${skipped}`);
console.log("Re-running is safe and will issue nothing further.");

await mongoose.disconnect();
process.exit(0);
