/**
 * Re-checks recent "processed" gateway refunds against what Razorpay says now.
 *
 * Until the refund-ledger fix, ANY Razorpay refund reply other than `failed` —
 * `pending` included, which is what every normal-speed refund replies with — was
 * recorded as `processed`. So rows from before the fix can claim money moved when
 * Razorpay had only accepted the refund, or when it later failed it. This script
 * finds those rows.
 *
 * Scope: refund rows that are `processed`, gateway-confirmed, carry a Razorpay
 * refund id, and were processed in the last N days (default 30). Each one is
 * looked up with `payments.fetchRefund` and compared.
 *
 *   --check   (default) report only — nothing is written.
 *   --apply   correct each mismatch:
 *               Razorpay says pending → the row goes back to `created`, so the
 *                 status poller and the refund webhook finish it. This is the one
 *                 backwards move the live code never makes, and it is allowed
 *                 here deliberately: the row's `processed` was never true.
 *                 The row is also marked `suppressProcessedNotice`: the customer
 *                 was already sent "refund processed" when the row was wrongly
 *                 recorded, so when the poller/webhook later settles it
 *                 (applyGatewayRefundState) the ledger and paymentStatus follow
 *                 but no second notice goes out.
 *               Razorpay says failed  → the row goes to `failed` through the same
 *                 guarded write the webhook uses (applyGatewayRefundState), which
 *                 also re-opens a return that was marked refunded.
 *             Every write is a compare-and-swap on the row still being
 *             `processed` with the same refund id, so a row the webhook settled
 *             meanwhile is left alone. paymentStatus is re-derived afterwards.
 *   --days=N  look back N days instead of 30.
 *
 * Never issues a refund and never sends the customer anything.
 *
 *   node scripts/backfill-refund-statuses.js            # report
 *   node scripts/backfill-refund-statuses.js --apply    # correct
 */
import "dotenv/config";
import mongoose from "mongoose";

const APPLY = process.argv.includes("--apply");
const daysArg = process.argv.find((arg) => arg.startsWith("--days="));
const DAYS = daysArg ? Number(daysArg.split("=")[1]) : 30;
if (!Number.isFinite(DAYS) || DAYS <= 0) {
  console.error("--days must be a positive number");
  process.exit(1);
}

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

const OrderModel = (await import("../src/modules/orders/Order.model.js")).default;
const { getRazorpay, getRazorpayErrorMessage } = await import(
  "../src/modules/payments/razorpay.service.js"
);
const { applyGatewayRefundState, mapGatewayRefundStatus, recomputeRefundState } = await import(
  "../src/modules/payments/return-refund.service.js"
);

let razorpay;
try {
  ({ razorpay } = getRazorpay());
} catch (error) {
  // The message names which setting is missing; it never contains the key itself.
  console.error(`Razorpay is not configured: ${error.message}`);
  process.exit(1);
}

await mongoose.connect(uri);

console.log(`\nDatabase: ${mongoose.connection.name}`);
console.log(APPLY ? "Mode: APPLY\n" : "Mode: CHECK ONLY (no changes)\n");

const since = new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000);
const inScope = (row) =>
  row.status === "processed" &&
  row.confirmationMethod !== "manual" &&
  typeof row.providerRefundId === "string" &&
  row.providerRefundId !== "" &&
  new Date(row.processedAt || row.createdAt || 0) >= since;

const orders = await OrderModel.find(
  {
    refunds: {
      $elemMatch: {
        status: "processed",
        confirmationMethod: { $ne: "manual" },
        providerRefundId: { $exists: true, $type: "string" },
        $or: [{ processedAt: { $gte: since } }, { processedAt: null, createdAt: { $gte: since } }],
      },
    },
  },
  { refunds: 1, razorpayPaymentId: 1, paymentStatus: 1 },
).lean();

const tally = { checked: 0, confirmed: 0, pending: 0, failed: 0, errors: 0, corrected: 0, skipped: 0 };

for (const order of orders) {
  for (const row of (order.refunds || []).filter(inScope)) {
    tally.checked += 1;
    const label = `order ${order._id} refund ${row._id} (${row.providerRefundId}, ₹${row.amount})`;

    let gatewayRefund;
    try {
      gatewayRefund = await razorpay.payments.fetchRefund(
        row.providerPaymentId || order.razorpayPaymentId,
        row.providerRefundId,
      );
    } catch (error) {
      tally.errors += 1;
      console.log(`  ERROR    ${label}: ${getRazorpayErrorMessage(error)}`);
      continue;
    }

    const now = mapGatewayRefundStatus(gatewayRefund?.status);
    if (now === "processed") {
      tally.confirmed += 1;
      continue;
    }
    tally[now === "failed" ? "failed" : "pending"] += 1;
    console.log(
      `  MISMATCH ${label}: ledger says processed, Razorpay says ${gatewayRefund?.status || "unknown"}`,
    );
    if (!APPLY) continue;

    if (now === "failed") {
      const applied = await applyGatewayRefundState({
        orderId: order._id,
        refundId: row._id,
        gatewayRefund,
        source: "backfill",
      });
      if (applied.matched) {
        tally.corrected += 1;
        console.log(`           → failed (paymentStatus re-derived)`);
      } else {
        tally.skipped += 1;
        console.log(`           → skipped: the row changed since it was read`);
      }
      continue;
    }

    // processed → created. Not an edge the live code allows, so written here with
    // the same compare-and-swap shape: still processed, still this refund id.
    const updated = await OrderModel.findOneAndUpdate(
      {
        _id: order._id,
        refunds: {
          $elemMatch: { _id: row._id, status: "processed", providerRefundId: row.providerRefundId },
        },
      },
      {
        $set: {
          "refunds.$.status": "created",
          "refunds.$.processedAt": null,
          // Due for the poller on its next run.
          "refunds.$.gatewaySyncedAt": null,
          // Already announced as processed; the real settlement stays silent.
          "refunds.$.suppressProcessedNotice": true,
        },
      },
      { returnDocument: "after" },
    );
    if (updated) {
      await recomputeRefundState(updated);
      tally.corrected += 1;
      console.log(`           → created (paymentStatus now ${updated.paymentStatus})`);
    } else {
      tally.skipped += 1;
      console.log(`           → skipped: the row changed since it was read`);
    }
  }
}

console.log(
  `\nChecked ${tally.checked} processed gateway refund(s) from the last ${DAYS} day(s) across ${orders.length} order(s).`,
);
console.log(
  `  confirmed processed: ${tally.confirmed} · still pending: ${tally.pending} · failed: ${tally.failed} · lookup errors: ${tally.errors}`,
);
if (APPLY) console.log(`  corrected: ${tally.corrected} · skipped (changed meanwhile): ${tally.skipped}`);
else if (tally.pending + tally.failed > 0) {
  console.log("  Re-run with --apply to correct the mismatches above.");
}

await mongoose.disconnect();
process.exit(tally.errors > 0 ? 1 : 0);
