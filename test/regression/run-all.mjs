/**
 * Runs every regression suite in a fresh process each and reports a single
 * verdict, so `npm test` is one command before a deploy.
 *
 * Separate processes on purpose: each suite opens its own Mongoose connection and
 * asserts on module-load-time state, so sharing one process would let one suite's
 * connection or model registry mask a problem in another.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const suites = [
  "money.regression.mjs",
  "inventory.regression.mjs",
  "returns.regression.mjs",
  "lifecycle.regression.mjs",
  "security.regression.mjs",
  "refund-safety.regression.mjs",
  "cart-cleanup.regression.mjs",
  "variant-cart.regression.mjs",
  "shipment-cancel.regression.mjs",
  "webhook-identity.regression.mjs",
  "shipment-status-mapping.regression.mjs",
  "order-package.regression.mjs",
  "return-uniqueness.regression.mjs",
  "shipping-tax-refund.regression.mjs",
  "refund-state-gate.regression.mjs",
  "rto-closed.regression.mjs",
  "replacement-fulfilment.regression.mjs",
  "manual-shipment.regression.mjs",
  "closed-owed-refunds.regression.mjs",
  "refund-confirmation.regression.mjs",
  "inventory-reporting.regression.mjs",
  "cod-serviceability.regression.mjs",
  "delivery-estimate-cod.regression.mjs",
  "shipping-capabilities.regression.mjs",
  "shipping-utilities.regression.mjs",
  "courier-recovery.regression.mjs",
  "cod-reconciliation.regression.mjs",
  "reverse-logistics.regression.mjs",
  "shipping-rates.regression.mjs",
  "intent-amount-guard.regression.mjs",
  "price-mrp.regression.mjs",
  "variant-pricing.regression.mjs",
  "coupon-availability.regression.mjs",
  "coupon-global-cap.regression.mjs",
  "coupon-dates.regression.mjs",
  "catalogue-scale.regression.mjs",
  "bulk-products.regression.mjs",
  "bill-number.regression.mjs",
  "partial-cancel-guard.regression.mjs",
  "late-capture-cancelled.regression.mjs",
  "rto-refund-settlement.regression.mjs",
  "cod-amount-guard.regression.mjs",
  "auto-awb.regression.mjs",
  "shipment-create-idempotency.regression.mjs",
  "return-booking-claims.regression.mjs",
  "order-status-cas.regression.mjs",
  "courier-event-pipeline.regression.mjs",
  "shipping-reconciliation.regression.mjs",
  "customer-shipping-endpoints.regression.mjs",
  "reverse-awb.regression.mjs",
];

const run = (file) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(here, file)], {
      stdio: "inherit",
      // The PACKAGE ROOT, two levels up now that suites live in test/regression.
      // Load-bearing, and it fails OPEN rather than loud: several suites read
      // application source relative to cwd rather than to themselves —
      // lifecycle.regression.mjs walks `srcDir = "src"` for its unguarded-order-query
      // sweep, and it and money.regression.mjs both readFile("src/modules/…"). Point
      // this at the wrong directory and the sweep finds zero files and PASSES.
      cwd: path.join(here, "../.."),
    });
    child.on("close", (code) => resolve({ file, code }));
  });

const results = [];
for (const suite of suites) {
  console.log(`\n${"─".repeat(72)}\n▶ ${suite}\n${"─".repeat(72)}`);
  results.push(await run(suite));
}

const failed = results.filter((r) => r.code !== 0);
console.log(`\n${"═".repeat(72)}`);
for (const { file, code } of results) {
  console.log(`${code === 0 ? "PASS" : "FAIL"}  ${file}`);
}
console.log("═".repeat(72));

if (failed.length) {
  console.log(`\n${failed.length} of ${results.length} suite(s) failed.`);
  process.exit(1);
}
console.log(`\nAll ${results.length} suites passed.`);
