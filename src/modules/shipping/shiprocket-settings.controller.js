import ShiprocketSetting from "./ShiprocketSetting.model.js";
import { getFeatures, isShippingEnabled } from "../../config/features.config.js";
import {
  clearPickupLocationCache,
  getShippingCapabilities,
  listPickupLocations,
  resetShiprocketToken,
  verifyShiprocketConnection,
} from "./shiprocket.service.js";
import { createAuditLog } from "../audit/audit-log.js";

// Password/webhook token are write-only from the client's point of view —
// GET reports whether one is set, never the value itself, so a saved
// credential is never re-displayed once submitted.
const presentSettings = (settings) => ({
  email: settings.email,
  passwordSet: Boolean(settings.password),
  pickupLocation: settings.pickupLocation,
  pickupPostcode: settings.pickupPostcode,
  webhookTokenSet: Boolean(settings.webhookToken),
  defaultLengthCm: settings.defaultLengthCm,
  defaultBreadthCm: settings.defaultBreadthCm,
  defaultHeightCm: settings.defaultHeightCm,
  defaultWeightKg: settings.defaultWeightKg,
  // The admin's capability choices. Reported raw (what they picked), separately from
  // `capabilities` below (what that resolves to once the .env ceiling is applied), so
  // the UI can show a switch as ON-but-blocked instead of silently flipping it off.
  shipmentsEnabled: settings.shipmentsEnabled !== false,
  autoPushEnabled: settings.autoPushEnabled !== false,
  // `=== true`, matching the resolver: absent means never opted in.
  autoAwbEnabled: settings.autoAwbEnabled === true,
  deliveryWebhookEnabled: settings.deliveryWebhookEnabled !== false,
  // `=== true`, matching the resolver: absent means never opted in, not enabled.
  reverseShipmentsEnabled: settings.reverseShipmentsEnabled === true,
  reverseAutoAwbEnabled: settings.reverseAutoAwbEnabled === true,
  // Reconciliation. `!== false` / `??` so a document written before these existed
  // reports the schema defaults rather than blanks.
  reconciliationEnabled: settings.reconciliationEnabled !== false,
  reconcileIntervalMinutes: settings.reconcileIntervalMinutes ?? 15,
  trackingStaleMinutes: settings.trackingStaleMinutes ?? 360,
  maxRetryAttempts: settings.maxRetryAttempts ?? 5,
});

// One helper for both handlers — the two used to hand-build the same object and could
// drift. `capabilities` is what the server will actually do; `status` is the .env
// ceiling, kept for the existing status pills.
const presentStatus = async () => {
  const { shipping } = getFeatures();
  const capabilities = await getShippingCapabilities();
  return {
    status: {
      enabled: isShippingEnabled(),
      configured: capabilities.configured,
      autoCreateOrder: Boolean(shipping.autoCreateOrder),
      webhookEnabled: capabilities.deliveryWebhook,
    },
    // What .env permits, independent of the admin's choice. The UI disables a switch
    // and explains why when the ceiling forbids it, rather than letting an admin turn
    // on something that cannot take effect.
    envCeiling: {
      shipments: isShippingEnabled(),
      autoPush: isShippingEnabled() && Boolean(shipping.autoCreateOrder),
      // No env flag of its own — it inherits the auto-push ceiling.
      autoAwb: isShippingEnabled() && Boolean(shipping.autoCreateOrder),
      deliveryWebhook: isShippingEnabled() && Boolean(shipping.webhookEnabled),
      // No env flag of its own — it inherits the shipments ceiling, so the panel is the
      // only place it is decided.
      reverseShipments: isShippingEnabled(),
    },
    capabilities,
  };
};

export const GetShiprocketSettings = async (req, res) => {
  try {
    const settings = await ShiprocketSetting.getSettings();

    return res.status(200).json({
      success: true,
      settings: presentSettings(settings),
      ...(await presentStatus()),
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

const STRING_FIELDS = ["email", "pickupLocation", "pickupPostcode"];
const SECRET_FIELDS = ["password", "webhookToken"];
const NUMBER_FIELDS = ["defaultLengthCm", "defaultBreadthCm", "defaultHeightCm", "defaultWeightKg"];
// Booleans only, like the COD coverage mode: a junk value must leave the admin's
// existing choice alone rather than being coerced into switching fulfilment off.
const CAPABILITY_FIELDS = [
  "shipmentsEnabled",
  "autoPushEnabled",
  "autoAwbEnabled",
  "deliveryWebhookEnabled",
  "reverseShipmentsEnabled",
];
// Whole numbers with hard bounds (mirrored on the schema). Unlike the package sizes,
// a bad value here is REFUSED with a message rather than skipped: an admin who types
// "1" for the polling interval and sees "saved" would reasonably believe it took.
const BOUNDED_INTEGER_FIELDS = {
  reconcileIntervalMinutes: { min: 5, max: 1440, label: "Reconciliation interval (minutes)" },
  trackingStaleMinutes: { min: 30, max: 10080, label: "Poll tracking after (minutes without an update)" },
  maxRetryAttempts: { min: 1, max: 20, label: "Maximum retry attempts" },
};
const RECONCILE_BOOLEAN_FIELDS = ["reconciliationEnabled", "reverseAutoAwbEnabled"];
const ALL_FIELDS = [
  ...STRING_FIELDS,
  ...SECRET_FIELDS,
  ...NUMBER_FIELDS,
  ...CAPABILITY_FIELDS,
  ...Object.keys(BOUNDED_INTEGER_FIELDS),
  ...RECONCILE_BOOLEAN_FIELDS,
];

/** Field → message for every bounded field present in the body but out of range. */
const validateBoundedIntegers = (body) => {
  const errors = {};
  for (const [field, { min, max, label }] of Object.entries(BOUNDED_INTEGER_FIELDS)) {
    if (body[field] === undefined || body[field] === null || body[field] === "") continue;
    const value = Number(body[field]);
    if (!Number.isInteger(value) || value < min || value > max) {
      errors[field] = `${label} must be a whole number from ${min} to ${max}.`;
    }
  }
  return errors;
};

export const UpdateShiprocketSettings = async (req, res) => {
  try {
    const body = req.body || {};
    // Validated before anything is touched, so a refused save changes nothing at all.
    const invalid = validateBoundedIntegers(body);
    if (Object.keys(invalid).length > 0) {
      return res.status(400).json({
        success: false,
        code: "INVALID_SETTINGS",
        message: Object.values(invalid)[0],
        errors: invalid,
      });
    }
    const settings = await ShiprocketSetting.getSettings();

    // Snapshot before any assignment, so "what changed" is a comparison with what was
    // stored rather than with a value this handler has already overwritten. The email
    // check used to compare the body against `settings.email` AFTER the loop below had
    // copied the body into it — so it was always equal, and changing only the email
    // never invalidated the caches tied to the old account.
    const before = Object.fromEntries(ALL_FIELDS.map((field) => [field, settings[field]]));

    for (const field of STRING_FIELDS) {
      if (typeof body[field] === "string") settings[field] = body[field].trim();
    }
    // A blank secret field means "leave it as-is" — only overwrite when the
    // admin actually typed a new value, so re-saving the form (with the
    // field shown blank, since it's never sent back) doesn't wipe it.
    for (const field of SECRET_FIELDS) {
      if (typeof body[field] === "string" && body[field].trim()) {
        settings[field] = body[field].trim();
      }
    }
    for (const field of NUMBER_FIELDS) {
      const value = Number(body[field]);
      if (Number.isFinite(value) && value >= 0) settings[field] = value;
    }
    for (const field of [...CAPABILITY_FIELDS, ...RECONCILE_BOOLEAN_FIELDS]) {
      if (typeof body[field] === "boolean") settings[field] = body[field];
    }
    for (const field of Object.keys(BOUNDED_INTEGER_FIELDS)) {
      if (body[field] !== undefined && body[field] !== null && body[field] !== "") {
        settings[field] = Number(body[field]);
      }
    }

    // Field NAMES only. The values of password and webhookToken must never reach the
    // audit log, and listing every field the same way means no value can leak through
    // a field later added to the wrong list.
    const changed = ALL_FIELDS.filter(
      (field) => String(before[field] ?? "") !== String(settings[field] ?? ""),
    );
    const credentialsChanged = changed.includes("email") || changed.includes("password");

    // The cached pickup list and the cached auth token both belong to whichever account
    // the credentials pointed at; keeping either after a change would have System Health
    // validating against — and shipments booked on — the previous Shiprocket account.
    // Cleared before the save (so a failed save still drops them, as it always has) AND
    // after it, because a request landing between the two could log in with the old
    // stored credentials and cache that token again.
    const dropAccountCaches = () => {
      clearPickupLocationCache();
      resetShiprocketToken();
    };
    if (credentialsChanged) dropAccountCaches();

    await settings.save();

    if (credentialsChanged) dropAccountCaches();

    if (changed.length > 0) {
      await createAuditLog({
        admin: req.user?.id,
        action: "UPDATE",
        module: "Shipping",
        targetId: settings._id,
        targetName: "Shiprocket settings",
        description: `Changed: ${changed.join(", ")}`,
        req,
      });
    }

    return res.status(200).json({
      success: true,
      message: "Shiprocket settings updated successfully",
      settings: presentSettings(settings),
      // Returned here too: saving credentials is exactly the moment `configured`
      // flips true, and the UI reads it straight off this reply.
      ...(await presentStatus()),
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * "Do these credentials work?" — answered on demand.
 *
 * Deliberately gated on `permitted` (the .env ceiling) but NOT on the `shipments`
 * capability. An admin testing credentials before switching Shiprocket on is the normal
 * case, and refusing to test until it is already on would make this useless for setup.
 *
 * Always 200 with an outcome. A failed CHECK is not a failed REQUEST — returning 502
 * here would make the browser treat a successful diagnosis as an error.
 */
export const TestShiprocketConnection = async (req, res) => {
  try {
    const capabilities = await getShippingCapabilities();
    if (!capabilities.permitted) {
      return res.status(200).json({
        success: true,
        ok: false,
        reason: "not_permitted",
        message:
          "Shiprocket is disabled for this environment (SHIPROCKET_ENABLED). Credentials cannot be tested until a developer enables it.",
      });
    }

    const result = await verifyShiprocketConnection();
    const messages = {
      authenticated: "Connected. These credentials work.",
      not_configured: "No email/password saved yet — enter them and save before testing.",
      rejected: "Shiprocket rejected these credentials.",
      unreachable: "Shiprocket could not be reached.",
      no_token: "Shiprocket accepted the login but returned no token.",
    };
    return res.status(200).json({
      success: true,
      ok: result.ok,
      reason: result.reason,
      message: messages[result.reason] || "Could not verify the connection.",
      // The API's own wording, which is the part that tells an admin whether it is a
      // wrong password or an outage. Never contains the credentials themselves.
      detail: result.detail || "",
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * The pickup locations actually registered on this Shiprocket account.
 *
 * The point is to replace a free-text field that must match one of these EXACTLY. Same
 * gating rationale as the connection test: needed during setup, so it does not require
 * the shipments capability to already be on.
 */
export const GetPickupLocations = async (req, res) => {
  try {
    const capabilities = await getShippingCapabilities();
    if (!capabilities.permitted) {
      return res
        .status(200)
        .json({ success: true, ok: false, reason: "not_permitted", locations: [] });
    }

    // forceRefresh: the admin clicked "Load from Shiprocket", which usually means they
    // just registered a location there. A cached list would show them the old one.
    const result = await listPickupLocations({ forceRefresh: true });
    return res.status(200).json({
      success: true,
      ok: result.ok,
      reason: result.reason || "",
      detail: result.detail || "",
      locations: result.locations,
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};
