/**
 * Indexes and a data-readiness report for the order & logistics reliability work.
 *
 * Production runs with autoIndex OFF (src/database/mongo.db.js), so indexes declared on
 * a schema are never built there by themselves — that is why each index change ships
 * with a script like this one.
 *
 * Creates (if missing):
 *
 *   orders  shiprocket_sync_retry      {shiprocket.syncStatus, shiprocket.nextAttemptAt}
 *           The reconciler's auto-push and cancellation-retry scans, and the shipping
 *           exceptions queue, all filter on syncStatus and then on when a retry is due.
 *   returns return_pickupShipmentId    {pickupShipmentId}
 *           The return-AWB sync scans for booked legs with no AWB yet.
 *
 * Reports (never changes):
 *
 *   - Unpaid prepaid orders that are NOT at Pending. Late payment captures now only
 *     promote an order that is still Pending, so a capture for one of these would be
 *     refunded automatically rather than confirming it. Expected 0; any listed here
 *     were advanced by hand before payment and need a look.
 *   - Shipment creations with an unknown outcome ("creating" for over 10 minutes).
 *   - Owed RTO refunds now payable through "Refund via Razorpay".
 *
 * Safe to re-run: index creation is skipped when the index exists.
 *
 * Usage:
 *   node scripts/migrate-shipping-reliability-indexes.js            # apply
 *   node scripts/migrate-shipping-reliability-indexes.js --check    # report only
 */
import "dotenv/config";
import mongoose from "mongoose";

const CHECK_ONLY = process.argv.includes("--check");

const INDEXES = [
  {
    collection: "orders",
    name: "shiprocket_sync_retry",
    keys: { "shiprocket.syncStatus": 1, "shiprocket.nextAttemptAt": 1 },
  },
  {
    collection: "returns",
    name: "return_pickupShipmentId",
    keys: { pickupShipmentId: 1 },
  },
];

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
const db = mongoose.connection;

console.log(`\nDatabase: ${db.name}`);
console.log(CHECK_ONLY ? "Mode: CHECK ONLY (no changes)\n" : "Mode: APPLY\n");

for (const index of INDEXES) {
  const collection = db.collection(index.collection);
  // A collection that has never had a document (a fresh store with no returns yet) does
  // not exist, and listing its indexes throws NamespaceNotFound. That is "no indexes",
  // not an error; createIndex below creates the collection along with the index.
  const current = await collection.indexes().catch((error) => {
    if (error?.codeName === "NamespaceNotFound" || error?.code === 26) return [];
    throw error;
  });
  const existing = current.some((entry) => entry.name === index.name);
  if (existing) {
    console.log(`── ${index.collection}.${index.name}: already present`);
  } else if (CHECK_ONLY) {
    console.log(`── ${index.collection}.${index.name}: WOULD create`);
  } else {
    await collection.createIndex(index.keys, { name: index.name });
    console.log(`── ${index.collection}.${index.name}: created`);
  }
}

const orders = db.collection("orders");

const unpaidAdvanced = await orders
  .find(
    { paymentMethod: "RAZORPAY", paymentStatus: "Pending", orderStatus: { $ne: "Pending" } },
    { projection: { _id: 1, orderStatus: 1, createdAt: 1 } },
  )
  .limit(50)
  .toArray();
console.log(`\nUnpaid prepaid orders not at Pending: ${unpaidAdvanced.length}`);
for (const order of unpaidAdvanced) {
  console.log(`  ${order._id}  ${order.orderStatus}  created ${order.createdAt?.toISOString?.() ?? "?"}`);
}

const staleClaims = await orders
  .find(
    {
      "shiprocket.syncStatus": "creating",
      "shiprocket.claimedAt": { $lt: new Date(Date.now() - 10 * 60 * 1000) },
    },
    { projection: { _id: 1, "shiprocket.lastError": 1 } },
  )
  .limit(50)
  .toArray();
console.log(`\nShipment creations with an unknown outcome: ${staleClaims.length}`);
for (const order of staleClaims) {
  console.log(`  ${order._id}  ${order.shiprocket?.lastError || ""}`);
}

const owedRto = await orders
  .aggregate([
    { $match: { "refunds.status": "owed" } },
    { $unwind: "$refunds" },
    { $match: { "refunds.status": "owed", "refunds.reason": { $regex: "^RTO " } } },
    { $group: { _id: null, count: { $sum: 1 }, amount: { $sum: "$refunds.amount" } } },
  ])
  .toArray();
console.log(
  `\nOwed RTO refunds now payable via "Refund via Razorpay": ${owedRto[0]?.count || 0} (₹${owedRto[0]?.amount || 0})`,
);

await mongoose.disconnect();
console.log(CHECK_ONLY ? "\nCheck complete." : "\nDone.");
