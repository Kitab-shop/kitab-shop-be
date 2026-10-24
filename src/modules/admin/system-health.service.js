import mongoose from "mongoose";
import { getFeatures } from "../../config/features.config.js";
import CheckoutSetting from "../orders/CheckoutSetting.model.js";
import {
  getShippingCapabilities,
  getShiprocketCredentials,
  isShiprocketConfigured,
  listPickupLocations,
} from "../shipping/shiprocket.service.js";
import { countUnresolvedOrphanedCaptures } from "../payments/orphaned-capture.service.js";
import { listUnresolvedFailedRefunds } from "../payments/return-refund.service.js";

/**
 * Operational health / configuration report for the admin panel.
 *
 * Motivated by the production audit: most of the worst problems found were
 * SILENT MISCONFIGURATIONS, not code bugs — payments live while the Razorpay
 * webhook was disabled (captured payments lost with no reconciler), test keys
 * that take no real money, auth-security off making logout a no-op, and a
 * standalone MongoDB that would make every checkout transaction throw. None of
 * those were visible anywhere in the product.
 *
 * Two rules this file follows:
 *   1. NEVER return a secret. Only booleans, modes, and masked hints.
 *   2. Severity comes from COMBINATIONS, not from individual flags. A flag dump
 *      tells an admin nothing; "payments are live but the webhook is off" does.
 */

const OK = "ok";           // working as intended
const WARN = "warn";       // works, but risky or incomplete
const CRITICAL = "critical"; // actively broken or unsafe
const OFF = "off";         // deliberately disabled; informational

const check = (id, label, status, detail, action = "") => ({
  id,
  label,
  status,
  detail,
  action,
});

const has = (name) => Boolean(String(process.env[name] || "").trim());

// ── Database ────────────────────────────────────────────────────────────────
const databaseChecks = async () => {
  const checks = [];
  const connected = mongoose.connection.readyState === 1;

  checks.push(
    connected
      ? check("db.connection", "Database connection", OK, `Connected to "${mongoose.connection.name}".`)
      : check("db.connection", "Database connection", CRITICAL, "Not connected.", "The site cannot serve orders until MongoDB is reachable."),
  );

  if (!connected) return checks;

  // Transactions require a replica set (or mongos). Checkout, cancellation and
  // partial cancellation all run inside withTransaction — on a standalone
  // mongod every one of them throws and checkout is fully down.
  try {
    const hello = await mongoose.connection.db.admin().command({ hello: 1 });
    const isReplicaSet = Boolean(hello.setName);
    const isSharded = hello.msg === "isdbgrid";
    checks.push(
      isReplicaSet || isSharded
        ? check(
            "db.transactions",
            "Multi-document transactions",
            OK,
            isSharded ? "Sharded cluster — transactions supported." : `Replica set "${hello.setName}" — transactions supported.`,
          )
        : check(
            "db.transactions",
            "Multi-document transactions",
            CRITICAL,
            "MongoDB is running as a standalone server, which does not support transactions.",
            "Placing, cancelling and partially cancelling orders will all fail. Run MongoDB as a replica set (even single-node) and include replicaSet= in the connection string.",
          ),
    );
  } catch (error) {
    checks.push(check("db.transactions", "Multi-document transactions", WARN, `Could not determine topology: ${error.message}`, "Verify manually that MongoDB supports transactions."));
  }

  // The unique indexes that actually prevent duplicate orders and duplicate
  // return requests. autoIndex builds these implicitly, and a build that fails
  // on pre-existing duplicates fails silently — so confirm they exist.
  const required = [
    ["orders", "razorpayPaymentId_1", "duplicate payments"],
    ["orders", "user_1_idempotencyKey_1", "duplicate orders from a double-submit"],
    // Named for the index that actually exists. This used to look for
    // "order_1_product_1_user_1" — Mongo's auto-generated name for the shape — but the
    // index is declared with an explicit name and a partial filter on the OPEN statuses, so
    // the check reported a missing index that was present and told the admin to rebuild for
    // nothing. A health check that cries wolf is worse than one less check, because the real
    // criticals beside it stop being believed.
    ["returnrequests", "one_open_return_per_order_line", "duplicate return requests"],
    // Without this a gateway refund id can be recorded against two orders, and
    // every refund webhook is a full collection scan of `orders`.
    ["orders", "refunds.providerRefundId_1", "the same refund landing on two orders"],
  ];
  const missing = [];
  for (const [collection, indexName, purpose] of required) {
    try {
      const indexes = await mongoose.connection.collection(collection).indexes();
      if (!indexes.some((index) => index.name === indexName)) missing.push(`${indexName} (${purpose})`);
    } catch {
      // Collection not created yet — nothing has been written, so not a fault.
    }
  }
  checks.push(
    missing.length === 0
      ? check("db.indexes", "Duplicate-protection indexes", OK, "All unique indexes that guard against duplicate orders, payments and returns are present.")
      : check("db.indexes", "Duplicate-protection indexes", CRITICAL, `Missing: ${missing.join("; ")}.`, "Rebuild indexes — without them duplicates are only prevented in application code."),
  );

  return checks;
};

// ── Payments ────────────────────────────────────────────────────────────────
const paymentChecks = async () => {
  const { payments } = getFeatures();
  const checks = [];
  const keyId = String(process.env.RAZORPAY_KEY_ID || "").trim();
  const isLiveKey = keyId.startsWith("rzp_live_");
  const isTestKey = keyId.startsWith("rzp_test_");
  const inProduction = process.env.NODE_ENV === "production";

  if (!payments.enabled) {
    checks.push(check("pay.enabled", "Online payments (Razorpay)", OFF, "PAYMENTS_ENABLED is false — only Cash on Delivery can be offered.", "Set PAYMENTS_ENABLED=true to accept online payments."));
    return checks;
  }

  checks.push(check("pay.enabled", "Online payments (Razorpay)", OK, "Enabled."));

  // Key mode vs environment is the single most expensive thing to get wrong.
  if (!keyId || !has("RAZORPAY_KEY_SECRET")) {
    checks.push(check("pay.keys", "Razorpay API keys", CRITICAL, "Payments are enabled but the key id or secret is missing.", "Every payment attempt will fail. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET."));
  } else if (isTestKey) {
    checks.push(
      inProduction
        ? check("pay.keys", "Razorpay API keys", CRITICAL, "TEST keys are in use while NODE_ENV=production.", "Real customers can place orders that take no real money. Switch to live keys before accepting real orders.")
        : check("pay.keys", "Razorpay API keys", WARN, "TEST keys — no real money moves.", "Expected in development. Switch to live keys before go-live."),
    );
  } else if (isLiveKey) {
    checks.push(
      inProduction
        ? check("pay.keys", "Razorpay API keys", OK, "LIVE keys in production.")
        : check("pay.keys", "Razorpay API keys", WARN, "LIVE keys outside production.", "Refunds and payments here move REAL money. Confirm this is intended."),
    );
  } else {
    checks.push(check("pay.keys", "Razorpay API keys", WARN, "Key id has an unrecognised prefix — cannot tell test from live.", "Confirm which environment this key belongs to."));
  }

  // The audit's #2 critical: with the webhook off the handler answers 200, so
  // Razorpay never retries and order creation depends entirely on the shopper's
  // browser reaching /verify.
  if (!payments.razorpayWebhookEnabled) {
    checks.push(check("pay.webhook", "Razorpay webhook", CRITICAL, "Payments are enabled but the webhook is disabled.", "If a shopper closes the tab or loses signal after paying, the payment is captured with no order created and no refund. Set RAZORPAY_WEBHOOK_ENABLED=true and register the webhook in the Razorpay dashboard."));
  } else if (!has("RAZORPAY_WEBHOOK_SECRET")) {
    checks.push(check("pay.webhook", "Razorpay webhook", CRITICAL, "Webhook is enabled but RAZORPAY_WEBHOOK_SECRET is not set.", "Every webhook is rejected as unsigned, so this behaves as if the webhook were off."));
  } else {
    checks.push(check("pay.webhook", "Razorpay webhook", OK, "Enabled and signed."));
  }

  // Captured payments that could not be turned into an order. These are
  // auto-refunded, so a non-zero count is not automatically money lost — but a
  // `failed` refund among them IS money sitting with no order behind it, and
  // nothing else in the product would show it.
  try {
    const outstanding = await countUnresolvedOrphanedCaptures();
    checks.push(
      outstanding === 0
        ? check("pay.unmatched", "Unmatched captured payments", OK, "None outstanding — every captured payment has an order or a confirmed refund.")
        : check(
            "pay.unmatched",
            "Unmatched captured payments",
            CRITICAL,
            `${outstanding} captured payment(s) have no completable order and no confirmed refund yet.`,
            "Each one is money taken with nothing behind it. Check the unmatchedpayments records against the Razorpay dashboard and refund or fulfil them.",
          ),
    );
  } catch {
    // Collection not created yet — nothing has ever been orphaned, so not a fault.
  }

  // Failed gateway refunds nothing has replaced. A failed row is outside every
  // ledger sum, so the order no longer reads as owing anything — the debt is
  // visible only here and in the outstanding-refunds queue.
  try {
    const failedRefunds = (await listUnresolvedFailedRefunds()).length;
    checks.push(
      failedRefunds === 0
        ? check("pay.failedRefunds", "Failed refunds", OK, "None outstanding — every failed refund has been retried or re-issued.")
        : check(
            "pay.failedRefunds",
            "Failed refunds",
            WARN,
            `${failedRefunds} refund(s) failed at Razorpay and have not been retried.`,
            "The customer is still owed this money. Retry each one from Outstanding Refunds (or the order page) once the cause is resolved.",
          ),
    );
  } catch {
    // Reporting only — a failed count must not take the health page down.
  }

  return checks;
};

// ── Checkout / COD ──────────────────────────────────────────────────────────
const checkoutChecks = async () => {
  const settings = await CheckoutSetting.getSettings();
  const { payments } = getFeatures();
  const checks = [];

  if (settings.codEnabled) {
    const limits = [];
    if (settings.codMinOrderAmount > 0) limits.push(`min ₹${settings.codMinOrderAmount}`);
    if (settings.codMaxOrderAmount > 0) limits.push(`max ₹${settings.codMaxOrderAmount}`);
    checks.push(check("checkout.cod", "Cash on Delivery", OK, `Enabled${limits.length ? ` (${limits.join(", ")})` : " with no order-value limits"}.`));
  } else {
    checks.push(
      payments.enabled
        ? check("checkout.cod", "Cash on Delivery", OFF, "Disabled — checkout offers online payment only.", "Enable it under Operations → Checkout if you want to accept COD.")
        : check("checkout.cod", "Cash on Delivery", CRITICAL, "COD is off AND online payments are disabled.", "Customers have no way to pay. Enable one of them."),
    );
  }

  checks.push(
    settings.cancellationWindowHours > 0
      ? check("checkout.cancelWindow", "Cancellation window", OK, `Customers can self-cancel within ${settings.cancellationWindowHours}h of ordering (and only before dispatch).`)
      : check("checkout.cancelWindow", "Cancellation window", OFF, "No time limit — customers can cancel any time before dispatch.", "Set a window under Operations → Checkout if you want to limit this."),
  );

  checks.push(
    getFeatures().orders.manualConfirmation
      ? check("checkout.manualConfirm", "Order confirmation", OK, "Manual — every new order (COD and prepaid) waits at Pending until an admin confirms it from Orders.", "Nothing ships or is pushed to the courier until then. Set ORDER_MANUAL_CONFIRMATION_ENABLED=false to confirm automatically.")
      : check("checkout.manualConfirm", "Order confirmation", OFF, "Automatic — COD orders are confirmed when placed and prepaid orders when the payment is captured.", "Set ORDER_MANUAL_CONFIRMATION_ENABLED=true to require an admin to approve every order."),
  );

  if (settings.codEnabled && settings.codServiceabilityCheckEnabled) {
    // Credentials only — deliberately NOT gated on shipping.enabled, because that is
    // what the order path itself requires. SHIPROCKET_ENABLED governs post-order
    // shipment automation, while serviceability is a checkout-time question answered
    // from credentials alone. Reporting readiness by a stricter rule than the one
    // actually enforced would tell an operator COD was blocked when it is not.
    const shiprocketReady = await isShiprocketConfigured();
    checks.push(
      shiprocketReady
        ? check("checkout.codPincode", "COD pincode check", OK, "COD is restricted to pincodes couriers actually accept it for.")
        : check(
            "checkout.codPincode",
            "COD pincode check",
            CRITICAL,
            "Pincode-based COD restriction is on, but Shiprocket credentials are missing.",
            "The check fails CLOSED, so every COD order is being refused right now. Add Shiprocket credentials under Operations → Shipping, or turn the pincode restriction off.",
          ),
    );
  }

  return checks;
};

// ── Shipping ────────────────────────────────────────────────────────────────
const shippingChecks = async () => {
  const { shipping } = getFeatures();
  const capabilities = await getShippingCapabilities();
  const checks = [];

  if (!capabilities.permitted) {
    checks.push(check("ship.mode", "Fulfilment mode", OFF, "Shiprocket is disabled — orders are fulfilled manually.", "Move order status by hand (Packed → Shipped → Delivered). Set SHIPROCKET_ENABLED=true to automate."));
    return checks;
  }

  // Permitted by the deployment but switched off by the admin. Reported as a normal
  // OFF state, not a problem: manual fulfilment is a legitimate choice, and it is the
  // one thing an admin can fix themselves without touching the server.
  if (!capabilities.shipments) {
    checks.push(check("ship.mode", "Fulfilment mode", OFF, "Shiprocket is available but this store is set to manual fulfilment.", "Shipments are recorded by hand on each order. Switch \"Use Shiprocket for shipments\" back on under Operations → Shipping to automate."));
    return checks;
  }

  const configured = capabilities.configured;
  if (!configured) {
    checks.push(check("ship.credentials", "Shiprocket credentials", CRITICAL, "Shiprocket is enabled but no email/password is saved.", "Every shipment action will fail. Add credentials under Operations → Shipping."));
    return checks;
  }

  checks.push(check("ship.credentials", "Shiprocket credentials", OK, "Saved."));
  checks.push(
    capabilities.autoPush
      ? check("ship.autoCreate", "Auto-push orders to Shiprocket", OK, "New orders are sent to Shiprocket automatically.")
      : check(
          "ship.autoCreate",
          "Auto-push orders to Shiprocket",
          OFF,
          "Off — you must click Create Shipment on each order.",
          shipping.autoCreateOrder
            ? 'Turned off under Operations → Shipping. Switch "Auto-push new orders" on there to automate this step.'
            : "Set SHIPROCKET_AUTO_CREATE_ORDER=true to allow this, then switch it on under Operations → Shipping.",
        ),
  );

  if (!capabilities.deliveryWebhook) {
    checks.push(
      check(
        "ship.webhook",
        "Shiprocket delivery webhook",
        WARN,
        "Off — delivery status will not update itself.",
        shipping.webhookEnabled
          ? 'Turned off under Operations → Shipping. You must mark orders Shipped/Delivered by hand; for COD that also means cash collection is never recorded automatically.'
          : "You must mark orders Shipped/Delivered by hand. For COD that also means cash collection is never recorded automatically.",
      ),
    );
  } else if (!(await getShiprocketCredentials()).webhookToken) {
    // The token the webhook actually checks — the admin-panel value first, .env as the
    // fallback — not just the env var. Reading only the env var reported CRITICAL on a
    // store whose token was saved in the panel and working fine.
    checks.push(check("ship.webhook", "Shiprocket delivery webhook", CRITICAL, "Webhook is enabled but no token is set.", "All webhook calls are rejected, so status updates silently never arrive."));
  } else {
    checks.push(check("ship.webhook", "Shiprocket delivery webhook", OK, "Enabled and token-protected."));
  }

  // Verified against Shiprocket rather than merely "a value is present". The name has to
  // match one registered in their dashboard EXACTLY, and a mismatch rejects every
  // shipment with an error naming neither the field nor the typo — so "configured" was
  // never the question worth answering here.
  const credentials = await getShiprocketCredentials();
  const configuredPickup = String(credentials.pickupLocation || "").trim();
  const pickupList = await listPickupLocations();
  if (!configuredPickup) {
    checks.push(check("ship.pickup", "Pickup location", CRITICAL, "No pickup location is configured.", "Every shipment will be rejected. Set one under Operations → Shipping — use \"Load from Shiprocket\" to pick a real one."));
  } else if (!pickupList.ok) {
    // Could not ask. Deliberately not reported as a mismatch: claiming the name is wrong
    // when we simply failed to check would send an operator to change a correct value.
    checks.push(check("ship.pickup", "Pickup location", WARN, `Set to "${configuredPickup}", but Shiprocket's pickup list could not be read to confirm it.`, "Not necessarily wrong. Use \"Load from Shiprocket\" under Operations → Shipping to verify once the API is reachable."));
  } else if (pickupList.locations.some((entry) => entry.name === configuredPickup)) {
    checks.push(check("ship.pickup", "Pickup location", OK, `"${configuredPickup}" matches a location registered on this Shiprocket account.`));
  } else {
    checks.push(check("ship.pickup", "Pickup location", CRITICAL, `"${configuredPickup}" is not registered on this Shiprocket account.`, `Every shipment will be rejected. Registered locations: ${pickupList.locations.map((entry) => entry.name).join(", ") || "none"}. Fix it under Operations → Shipping.`));
  }

  return checks;
};

// ── Email ───────────────────────────────────────────────────────────────────
const emailChecks = () => {
  const configured = has("EMAIL") && has("EMAIL_PASSWORD");
  return [
    configured
      ? check("email.smtp", "Outbound email", OK, "Sender configured.")
      : check("email.smtp", "Outbound email", CRITICAL, "EMAIL / EMAIL_PASSWORD are not both set.", "Signup verification, password reset and the Cash-on-Delivery OTP all silently fail — customers cannot complete COD orders."),
  ];
};

// ── Security ────────────────────────────────────────────────────────────────
const securityChecks = () => {
  const { authSecurity } = getFeatures();
  const inProduction = process.env.NODE_ENV === "production";
  const checks = [];

  checks.push(
    authSecurity.enabled
      ? check("sec.authSecurity", "Token revocation & admin 2FA", OK, "Enabled — logout invalidates tokens.")
      : check("sec.authSecurity", "Token revocation & admin 2FA", inProduction ? CRITICAL : WARN, "AUTH_SECURITY_ENABLED is false.", "Logging out does NOT invalidate the access token (it stays valid until it expires), and admin two-factor authentication is disabled."),
  );

  // This reads the SAME variable the CORS middleware in index.js now enforces, so a
  // green tick here means requests are genuinely restricted. It was previously
  // forward-looking — the middleware ignored the variable — which would have shown
  // a green "restricted" tick over a server still accepting every origin.
  const corsAllowlist = String(process.env.CORS_ALLOWED_ORIGINS || "").trim();
  checks.push(
    corsAllowlist
      ? check("sec.cors", "CORS policy", OK, `Restricted to ${corsAllowlist.split(",").length} configured origin(s).`)
      : check("sec.cors", "CORS policy", inProduction ? CRITICAL : WARN, "Any website's origin is reflected back and allowed, with credentials.", "Any third-party site can make authenticated API calls as your logged-in customers. Restrict to your own domains before going live."),
  );

  checks.push(
    inProduction
      ? check("sec.env", "Environment", OK, "NODE_ENV=production.")
      : check("sec.env", "Environment", WARN, `NODE_ENV is "${process.env.NODE_ENV || "not set"}".`, "Error responses may include internal detail. Set NODE_ENV=production when deploying."),
  );

  checks.push(
    authSecurity.rateLimitEnabled
      ? check("sec.rateLimit", "Rate limiting", OK, `Enabled (${authSecurity.rateLimitStore} store).`)
      : check("sec.rateLimit", "Rate limiting", WARN, "Disabled.", "Login and checkout endpoints are open to brute-force and abuse."),
  );

  return checks;
};

// ── Inventory ───────────────────────────────────────────────────────────────
const inventoryChecks = () => {
  const { inventory } = getFeatures();
  return [
    inventory.enforceStock
      ? check("inv.enforce", "Stock enforcement", OK, "Orders are rejected when stock is insufficient.")
      : check("inv.enforce", "Stock enforcement", CRITICAL, "INVENTORY_ENFORCE_STOCK is false.", "Customers can order items you do not have — overselling is unrestricted."),
    inventory.reserveDuringPayment
      ? check("inv.reserve", "Stock reservation during payment", OK, "Stock is held while a customer completes payment.")
      : check("inv.reserve", "Stock reservation during payment", OFF, "Off — stock is only deducted once payment succeeds.", "Two shoppers can pay for the same last item."),
  ];
};

export const buildSystemHealth = async () => {
  const groups = [
    { id: "database", label: "Database", checks: await databaseChecks() },
    { id: "payments", label: "Payments", checks: await paymentChecks() },
    { id: "checkout", label: "Checkout", checks: await checkoutChecks() },
    { id: "shipping", label: "Shipping & fulfilment", checks: await shippingChecks() },
    { id: "email", label: "Email", checks: emailChecks() },
    { id: "security", label: "Security", checks: securityChecks() },
    { id: "inventory", label: "Inventory", checks: inventoryChecks() },
  ];

  const all = groups.flatMap((group) => group.checks);
  const counts = {
    critical: all.filter((c) => c.status === CRITICAL).length,
    warn: all.filter((c) => c.status === WARN).length,
    ok: all.filter((c) => c.status === OK).length,
    off: all.filter((c) => c.status === OFF).length,
  };

  return {
    generatedAt: new Date().toISOString(),
    overall: counts.critical > 0 ? CRITICAL : counts.warn > 0 ? WARN : OK,
    counts,
    groups,
  };
};
