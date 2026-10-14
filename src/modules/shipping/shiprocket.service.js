import ShiprocketSetting from "./ShiprocketSetting.model.js";
import { getFeatures, isShippingEnabled } from "../../config/features.config.js";

const DEFAULT_BASE_URL = "https://apiv2.shiprocket.in/v1/external";
const TOKEN_LIFETIME_MS = 9 * 24 * 60 * 60 * 1000;

let cachedToken = null;
let tokenExpiresAt = 0;
let pendingLogin = null;
// Bumped by resetShiprocketToken(). A login that started under the previous credentials
// may still finish afterwards; it must not repopulate the cache with that account's token.
let tokenGeneration = 0;

// Pickup locations are account configuration that changes rarely, but System Health reads
// them on every load to verify the configured name — so without this, opening the admin
// health page meant a live Shiprocket call that could take up to the 20s request timeout.
// Five minutes keeps the check honest (a location added in Shiprocket's dashboard shows
// up quickly) while making repeated page loads free. The explicit "Load from Shiprocket"
// button bypasses it, because an admin clicking refresh has usually just changed
// something and must not be shown a stale list.
const PICKUP_CACHE_TTL_MS = 5 * 60 * 1000;
let cachedPickupLocations = null;
let pickupCachedAt = 0;


/**
 * `statusCode` is the HTTP status WE answer with, and its meaning is unchanged.
 *
 * `phase` and `httpStatus` were added for a different question, one only a caller that
 * CREATES something at Shiprocket has to ask: "might this request have taken effect?"
 * A forward shipment that failed before the request left this process can be retried
 * freely; one whose request reached Shiprocket and then went quiet might exist there,
 * and retrying it books a second courier for the same parcel. `statusCode` cannot answer
 * that — a 503 means both "our credentials are missing" and "Shiprocket timed out".
 *
 *   - "pre_request": nothing was sent for THIS call (validation, credentials, login).
 *   - "transport":   sent, or possibly sent, and no response came back (timeout, reset).
 *   - "response":    Shiprocket answered; `httpStatus` is what it answered with.
 *   - null:          not classified. Treated as "might have taken effect" by every
 *                    caller that cares, because guessing "safe to retry" is the
 *                    direction that duplicates parcels.
 */
export class ShiprocketError extends Error {
  constructor(message, statusCode = 502, details = null, { phase = null, httpStatus = null, providerStatus = null } = {}) {
    super(message);
    this.name = "ShiprocketError";
    this.statusCode = statusCode;
    this.details = details;
    this.phase = phase;
    this.httpStatus = httpStatus;
    // The status Shiprocket embedded in a 200 body ({ status: 400, message }), when that
    // is how it chose to reject the request.
    this.providerStatus = providerStatus;
  }
}

/**
 * Tags an error raised before a request was sent. Only fills a phase that is still
 * unknown, so an error that already knows it came from a response keeps saying so.
 * A non-Shiprocket error (a TypeError while building a payload, say) is wrapped rather
 * than passed through untagged, so the "nothing was sent" fact is not lost on the way up.
 */
const asPreRequest = (error) => {
  if (error instanceof ShiprocketError) {
    if (!error.phase) error.phase = "pre_request";
    return error;
  }
  return new ShiprocketError(error?.message || "Shiprocket request could not be prepared", 500, null, {
    phase: "pre_request",
  });
};

/**
 * Did Shiprocket DEFINITELY not create anything?
 *
 * True only when the request never left (pre_request), or Shiprocket answered with a
 * clear refusal: an HTTP 4xx, or a 200 whose body carries a 4xx status. 408 and 429 are
 * excluded — a request timeout and a rate limit say nothing about whether an earlier
 * attempt landed, and a 5xx is the textbook "maybe". A transport failure is the hardest
 * maybe of all: the request may have been processed and only the answer lost.
 *
 * Everything else is ambiguous, and ambiguous must be treated as "might exist".
 */
export const isDefiniteShiprocketRejection = (error) => {
  if (!(error instanceof ShiprocketError)) return false;
  if (error.phase === "pre_request") return true;
  if (error.phase !== "response") return false;
  const http = Number(error.httpStatus);
  if (http >= 400 && http < 500) return http !== 408 && http !== 429;
  const provider = Number(error.providerStatus);
  return http >= 200 && http < 300 && provider >= 400 && provider < 500 && provider !== 408 && provider !== 429;
};

// Admin-panel settings win when set; falling back to .env lets an existing
// deployment keep working before anyone touches the new admin panel.
const resolved = (dbValue, envName, fallback = "") => {
  const fromDb = String(dbValue ?? "").trim();
  if (fromDb) return fromDb;
  const fromEnv = String(process.env[envName] ?? "").trim();
  return fromEnv || fallback;
};

// The value the settings schema used to write into every new settings document.
const LEGACY_DEFAULT_PICKUP = "Primary";

/**
 * The pickup location name: admin panel, then .env, then "Primary".
 *
 * The schema used to default `pickupLocation` to "Primary", so every settings document
 * already holds that value whether or not an admin ever chose it — and because the
 * stored value wins, SHIPROCKET_PICKUP_LOCATION in .env could never take effect. Found
 * when configuring a live account whose pickup address is named "Home": every shipment
 * would have been booked against a "Primary" that does not exist.
 *
 * New documents now default to empty. For existing ones, a stored "Primary" is
 * indistinguishable from the untouched default, so an explicit .env value wins over it;
 * any other stored name is an admin's deliberate choice and still wins over .env.
 */
const resolvePickupLocation = (stored) => {
  const fromDb = String(stored ?? "").trim();
  const fromEnv = String(process.env.SHIPROCKET_PICKUP_LOCATION ?? "").trim();
  if (fromDb && !(fromDb === LEGACY_DEFAULT_PICKUP && fromEnv)) return fromDb;
  return fromEnv || LEGACY_DEFAULT_PICKUP;
};

export const getShiprocketCredentials = async () => {
  const settings = await ShiprocketSetting.getSettings();
  return {
    email: resolved(settings.email, "SHIPROCKET_EMAIL"),
    password: resolved(settings.password, "SHIPROCKET_PASSWORD"),
    pickupLocation: resolvePickupLocation(settings.pickupLocation),
    pickupPostcode: resolved(settings.pickupPostcode, "SHIPROCKET_PICKUP_POSTCODE"),
    webhookToken: resolved(settings.webhookToken, "SHIPROCKET_WEBHOOK_TOKEN"),
    defaultLengthCm: settings.defaultLengthCm || Number(process.env.SHIPROCKET_DEFAULT_LENGTH_CM) || 10,
    defaultBreadthCm: settings.defaultBreadthCm || Number(process.env.SHIPROCKET_DEFAULT_BREADTH_CM) || 10,
    defaultHeightCm: settings.defaultHeightCm || Number(process.env.SHIPROCKET_DEFAULT_HEIGHT_CM) || 10,
    defaultWeightKg: settings.defaultWeightKg || Number(process.env.SHIPROCKET_DEFAULT_WEIGHT_KG) || 0.5,
  };
};

export const isShiprocketConfigured = async () => {
  const { email, password } = await getShiprocketCredentials();
  return Boolean(email && password);
};

/**
 * How much of Shiprocket this store actually uses.
 *
 * Every capability is `env AND admin choice`. The .env flags stay the ops ceiling —
 * they say whether Shiprocket is permitted in this environment at all — and the
 * admin-panel booleans narrow that to what the business wants day to day. AND, never
 * OR: a store cannot switch on in the panel something the deployment forbids, so the
 * kill switch keeps working exactly as before.
 *
 * The DB fields default to true, so a deployment that never touches the panel behaves
 * identically to before these existed.
 *
 * `configured` is separate on purpose: credentials are a readiness fact, not a choice,
 * and callers report those two failures differently.
 *
 * @returns {Promise<{permitted: boolean, configured: boolean, shipments: boolean, autoPush: boolean, autoAwb: boolean, deliveryWebhook: boolean, reverseShipments: boolean}>}
 */
export const getShippingCapabilities = async () => {
  const permitted = isShippingEnabled();
  const settings = await ShiprocketSetting.getSettings();
  const { shipping } = getFeatures();

  // A missing field on an old document reads as undefined; treat that as the schema
  // default (true) rather than false, so an existing singleton written before these
  // fields existed does not silently disable fulfilment on deploy.
  const chosen = (value) => value !== false;

  const shipments = permitted && chosen(settings.shipmentsEnabled);
  // Both nested under shipments: auto-pushing or receiving status for shipments the
  // store does not create through Shiprocket is meaningless.
  const autoPush = shipments && shipping.autoCreateOrder && chosen(settings.autoPushEnabled);
  return {
    permitted,
    configured: await isShiprocketConfigured(),
    shipments,
    autoPush,
    // Nested under autoPush: it is the second half of the automatic push. `=== true` like
    // reverseShipments — a document written before the field existed never opted in to
    // booking couriers (and spending wallet balance) without a click.
    autoAwb: autoPush && settings.autoAwbEnabled === true,
    deliveryWebhook: shipments && shipping.webhookEnabled && chosen(settings.deliveryWebhookEnabled),
    // `=== true`, NOT `chosen()`. The others treat a missing field as enabled so existing
    // deployments are unchanged; this one must treat missing as DISABLED, because a
    // settings document written before the field existed never opted in to dispatching
    // couriers. There is no env ceiling of its own — it inherits the shipments ceiling.
    reverseShipments: shipments && settings.reverseShipmentsEnabled === true,
  };
};

const getConfig = async () => {
  const { email, password } = await getShiprocketCredentials();
  const baseUrl = String(process.env.SHIPROCKET_BASE_URL || DEFAULT_BASE_URL)
    .trim()
    .replace(/\/+$/, "");

  if (!email || !password) {
    throw new ShiprocketError("Shiprocket credentials are not configured", 503);
  }

  return { email, password, baseUrl };
};

const readResponse = async (response) => {
  const text = await response.text();
  if (!text) return {};

  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
};

const getErrorMessage = (data, fallback) => {
  if (typeof data?.message === "string") return data.message;
  if (typeof data?.error === "string") return data.error;
  if (data?.errors && typeof data.errors === "object") {
    return Object.values(data.errors).flat().join(", ");
  }
  return fallback;
};

const login = async () => {
  const generation = tokenGeneration;
  const { email, password, baseUrl } = await getConfig();
  const response = await fetch(`${baseUrl}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
    signal: AbortSignal.timeout(15000),
  });
  const data = await readResponse(response);

  if (!response.ok || !data.token) {
    throw new ShiprocketError(
      getErrorMessage(data, "Shiprocket authentication failed"),
      response.status === 401 || response.status === 422 ? 502 : 503,
      data,
    );
  }

  if (generation === tokenGeneration) {
    cachedToken = data.token;
    tokenExpiresAt = Date.now() + TOKEN_LIFETIME_MS;
  }
  return data.token;
};

const getToken = async (forceRefresh = false) => {
  if (!forceRefresh && cachedToken && Date.now() < tokenExpiresAt) {
    return cachedToken;
  }

  if (!pendingLogin) {
    // Cleared only if it is still THIS attempt: after resetShiprocketToken() a newer
    // login may own the slot, and an older one finishing must not clear it.
    const attempt = login().finally(() => {
      if (pendingLogin === attempt) pendingLogin = null;
    });
    pendingLogin = attempt;
  }
  return pendingLogin;
};

const request = async (path, { method = "GET", body, query } = {}, retry = true) => {
  // Configuration and login both happen before THIS request is sent, so a failure in
  // either — missing credentials, a rejected password, even an unreachable auth
  // endpoint — means the call itself never reached Shiprocket. Tagged so a create
  // caller can tell that apart from a request that may have landed.
  let url;
  let token;
  try {
    const { baseUrl } = await getConfig();
    url = new URL(`${baseUrl}${path}`);
    for (const [key, value] of Object.entries(query || {})) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }
    token = await getToken();
  } catch (error) {
    throw asPreRequest(error);
  }

  let response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
  } catch (error) {
    throw new ShiprocketError(`Shiprocket is unreachable: ${error.message}`, 503, null, {
      phase: "transport",
    });
  }

  if (response.status === 401 && retry) {
    cachedToken = null;
    tokenExpiresAt = 0;
    // A 401 means the first attempt was refused outright, so a failed re-login still
    // leaves nothing created.
    await getToken(true).catch((error) => {
      throw asPreRequest(error);
    });
    return request(path, { method, body, query }, false);
  }

  let data;
  try {
    data = await readResponse(response);
  } catch (error) {
    // The body stream failed mid-read: Shiprocket answered, so whatever was asked may
    // well have happened.
    throw new ShiprocketError(`Shiprocket response could not be read: ${error.message}`, 502, null, {
      phase: "response",
      httpStatus: response.status,
    });
  }
  if (!response.ok) {
    throw new ShiprocketError(
      getErrorMessage(data, `Shiprocket request failed with status ${response.status}`),
      response.status === 429 ? 503 : 502,
      data,
      { phase: "response", httpStatus: response.status },
    );
  }

  // Some Shiprocket endpoints return HTTP 200 even when their JSON payload
  // represents a validation failure (for example: { status: 400, message: ... }).
  const embeddedStatus = Number(data?.status);
  const embeddedStatusCode = Number(data?.status_code);
  const logicalErrorCode =
    (Number.isFinite(embeddedStatus) && embeddedStatus >= 400 && embeddedStatus) ||
    (Number.isFinite(embeddedStatusCode) &&
      embeddedStatusCode >= 400 &&
      embeddedStatusCode) ||
    null;
  if (data?.success === false || logicalErrorCode) {
    throw new ShiprocketError(
      getErrorMessage(data, "Shiprocket rejected the request"),
      logicalErrorCode >= 400 && logicalErrorCode < 500 ? 400 : 502,
      data,
      { phase: "response", httpStatus: response.status, providerStatus: logicalErrorCode },
    );
  }

  return data;
};

const positiveNumber = (value, fallback, field) => {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new ShiprocketError(`${field} must be a positive number`, 400);
  }
  return parsed;
};

export const resolvePackage = async (overrides = {}) => {
  const defaults = await getShiprocketCredentials();
  return {
    length: positiveNumber(overrides.length, defaults.defaultLengthCm, "length"),
    breadth: positiveNumber(overrides.breadth, defaults.defaultBreadthCm, "breadth"),
    height: positiveNumber(overrides.height, defaults.defaultHeightCm, "height"),
    weight: positiveNumber(overrides.weight, defaults.defaultWeightKg, "weight"),
  };
};

/** Grams / tenths of a millimetre are the useful precision; the rest is float noise. */
const round3 = (value) => Math.round(value * 1000) / 1000;

/** The industry-standard divisor. ARAMEX uses 6000, FedEx Surface 4500. */
export const VOLUMETRIC_DIVISOR = 5000;

/**
 * Volumetric (dimensional) weight of a box, in kg.
 *
 * Couriers bill on APPLIED weight — the greater of what a parcel actually weighs
 * and what its size says it should weigh — so a light book in an oversized box is
 * charged as though it were heavy. Shiprocket applies this itself from the
 * dimensions we send it, which is why the fix for accurate billing is accurate
 * measurements rather than any adjustment on our side. This is exported so the
 * admin panel can SHOW what a product's box will be billed as, instead of an
 * admin discovering it in a passbook entry a week later.
 */
export const volumetricWeightKg = ({ length, breadth, height } = {}, divisor = VOLUMETRIC_DIVISOR) => {
  const l = Number(length);
  const b = Number(breadth);
  const h = Number(height);
  const d = Number(divisor);
  if (![l, b, h, d].every((n) => Number.isFinite(n) && n > 0)) return 0;
  return round3((l * b * h) / d);
};

/** What the courier will actually charge for: the greater of the two. */
export const appliedWeightKg = (packageDetails = {}, divisor = VOLUMETRIC_DIVISOR) =>
  Math.max(Number(packageDetails.weight) || 0, volumetricWeightKg(packageDetails, divisor));

/** Units of a line still to ship: ordered minus cancelled, never negative. */
const remainingUnits = (item) =>
  Math.max(0, (Number(item?.quantity) || 0) - (Number(item?.cancelledQuantity) || 0));

/** Money in integer paise, so every split below is exact rather than float-approximate. */
const toPaise = (value) => Math.round((Number(value) || 0) * 100);
const fromPaise = (paise) => paise / 100;

/**
 * What the forward shipment actually carries, and what it is worth.
 *
 * One function for the three places that must agree on it: the Shiprocket payload, the
 * parcel measurement (computeOrderPackage uses the same remaining-units rule) and the
 * COD amount check after creation. The payload used to be assembled inline, and it
 * disagreed with the order in two ways that cost money:
 *
 *   1. It shipped `quantity`, ignoring `cancelledQuantity` — so a COD order created
 *      after a partial cancellation asked the courier to collect for goods that were
 *      no longer in the box.
 *   2. It sent `total_discount: order.discount` alongside a `sub_total` that was ALREADY
 *      net of that discount. Whether Shiprocket subtracts total_discount from sub_total
 *      again is not documented, and the two readings differ by exactly the discount on
 *      every discounted COD order.
 *
 * The fix removes the ambiguity rather than guessing: the order-level discount (coupon +
 * wallet, both already inside `order.discount`) is spread onto the item lines, and
 * `total_discount` is always 0. Then the lines, `sub_total` and the amount we expect
 * collected all say the same number however Shiprocket combines them.
 *
 * ── The money ────────────────────────────────────────────────────────────────
 *   netTotal  = totalAmount − Σ cancellations[].refundAmount
 *   subTotal  = netTotal − shippingCharge            (goods still shipping, net of discount)
 *   COD collectable = netTotal                        (what the courier must collect)
 *
 * `cancellations[].refundAmount` is what each partial cancellation valued the removed
 * units at (proportionalRefundAmount — net of discount, shipping excluded), and
 * totalAmount is never lowered by a partial cancel, so subtracting it is what leaves
 * exactly the remaining goods. It is subtracted for COD even though no refund is paid
 * on an unpaid COD order: the cancellation still removed those goods from the bill.
 *
 * ── `discount` is a PER-UNIT figure ─────────────────────────────────────────
 * Shiprocket's `selling_price` is per unit and `units` multiplies it; reading `discount`
 * on the same basis is the consistent interpretation, and it is the one that agrees
 * with Shiprocket's own order form. It is NOT verified against their API, which is
 * precisely why the COD amount check reads the order back after creation — a wrong
 * reading here shows up as a `mismatch` and blocks the AWB, rather than as a courier
 * collecting the wrong cash. Each line's total is therefore
 *
 *   units × (selling_price − discount)
 *
 * and those totals sum to `sub_total` EXACTLY, to the paise. Per-unit is the harder
 * contract to keep exact: a line's discount must divide by its units. Leftover paise are
 * moved onto lines that can absorb them (units = 1 absorbs anything), and if none can,
 * one unit of the largest line is split onto its own line (same name and SKU) to carry
 * them. Splitting is rare — it needs every line to have 2+ units and an odd-paise
 * discount — and it is the only way to be exact without misstating a price.
 *
 * Pure. Throws a 409 ShiprocketError when the order cannot be represented honestly
 * (nothing left to ship, or a total that exceeds the goods) — sending a wrong amount
 * to a courier who will collect it is worse than refusing.
 *
 * @returns {{orderItems: object[], subTotal: number, totalDiscount: 0, shippingCharges: number, codCollectable: number, declaredTotal: number, grossTotal: number}}
 */
export const computeShipmentLines = (order = {}) => {
  const lines = (order.items || [])
    .map((item) => ({
      item,
      units: remainingUnits(item),
      unitPrice: toPaise(item?.price),
    }))
    .filter((line) => line.units > 0);

  if (lines.length === 0) {
    throw new ShiprocketError("Nothing is left to ship on this order — every unit has been cancelled", 409);
  }
  if (lines.some((line) => line.unitPrice < 0)) {
    throw new ShiprocketError("An item on this order has a negative price, so it cannot be shipped", 409);
  }

  const shipping = toPaise(order.shippingCharge);
  const cancelledValue = (order.cancellations || []).reduce(
    (sum, entry) => sum + Math.max(0, toPaise(entry?.refundAmount)),
    0,
  );
  const netTotal = toPaise(order.totalAmount) - cancelledValue;
  const subTotal = netTotal - shipping;
  const gross = lines.reduce((sum, line) => sum + line.unitPrice * line.units, 0);
  const discount = gross - subTotal;

  if (subTotal < 0) {
    throw new ShiprocketError(
      `This order's remaining value (₹${fromPaise(netTotal)}) is less than its shipping charge (₹${fromPaise(shipping)}), so the shipment amount cannot be stated. Check the order's cancellations before shipping.`,
      409,
    );
  }
  if (discount < 0) {
    // The goods would have to be declared ABOVE their listed prices to reach the total.
    // Only possible with a charge this function does not know about (tax, today always
    // 0); refusing is safer than inventing a line for it.
    throw new ShiprocketError(
      `This order's remaining value (₹${fromPaise(subTotal)} of goods) exceeds the listed price of the items still shipping (₹${fromPaise(gross)}), so it cannot be expressed as item lines.`,
      409,
    );
  }

  // 1. Spread the discount across lines by value, flooring each share; the rounding
  //    remainder goes to the largest line, which can carry it with the least distortion.
  let allocated = 0;
  let largest = 0;
  lines.forEach((line, index) => {
    const value = line.unitPrice * line.units;
    line.lineDiscount = gross > 0 ? Math.floor((discount * value) / gross) : 0;
    allocated += line.lineDiscount;
    if (value > lines[largest].unitPrice * lines[largest].units) largest = index;
  });
  lines[largest].lineDiscount += discount - allocated;

  // 2. Convert to per-unit discounts. What does not divide evenly is gathered…
  let leftover = 0;
  for (const line of lines) {
    line.unitDiscount = Math.floor(line.lineDiscount / line.units);
    leftover += line.lineDiscount - line.unitDiscount * line.units;
  }
  // …and handed to lines that can take it whole, fewest units first (a single-unit line
  // takes any amount), never pushing a unit's discount past its price.
  for (const line of [...lines].sort((a, b) => a.units - b.units)) {
    if (leftover <= 0) break;
    const steps = Math.min(Math.floor(leftover / line.units), line.unitPrice - line.unitDiscount);
    if (steps > 0) {
      line.unitDiscount += steps;
      leftover -= steps * line.units;
    }
  }
  // 3. Still some paise over: split one unit of the largest multi-unit line onto its own
  //    line, which can then carry them.
  if (leftover > 0) {
    const donor = lines
      .filter((line) => line.units > 1 && line.unitPrice - line.unitDiscount >= leftover)
      .sort((a, b) => b.unitPrice * b.units - a.unitPrice * a.units)[0];
    if (!donor) {
      throw new ShiprocketError(
        "The order discount cannot be spread across its items exactly, so the shipment amount cannot be stated.",
        409,
      );
    }
    donor.units -= 1;
    lines.splice(lines.indexOf(donor) + 1, 0, {
      item: donor.item,
      units: 1,
      unitPrice: donor.unitPrice,
      unitDiscount: donor.unitDiscount + leftover,
    });
    leftover = 0;
  }

  const orderItems = lines.map((line) => ({
    name: line.item.name,
    sku: String(line.item.product?._id || line.item.product),
    units: line.units,
    selling_price: fromPaise(line.unitPrice),
    discount: fromPaise(line.unitDiscount),
    tax: 0,
    hsn: "",
  }));

  const cod = order.paymentMethod === "COD";
  return {
    orderItems,
    subTotal: fromPaise(subTotal),
    totalDiscount: 0,
    shippingCharges: fromPaise(shipping),
    // Nothing is collected at the door on a prepaid order.
    codCollectable: cod ? fromPaise(netTotal) : 0,
    // What Shiprocket should hold as the order's value, COD or not: the goods plus
    // freight. Equal to codCollectable for COD; recorded for prepaid too, so a payload
    // misreading is visible on every order rather than only the cash ones.
    declaredTotal: fromPaise(netTotal),
    grossTotal: fromPaise(gross),
  };
};

// Auto-computed from the products actually in the order (weight/length/
// breadth/height set on Product.model.js).
//
// `defaults` is the admin/env-configured package, and it now stands in PER UNIT
// for any product with no measurement of its own. The substitution used to be
// all-or-nothing: a field was omitted only when NO item in the order carried
// data, leaving resolvePackage() to supply the default. So in a mixed order —
// one book measured, one not — the total was returned as-is and the unmeasured
// book contributed NOTHING. A two-book parcel shipped declared at one book's
// weight. Shiprocket weighs it at pickup, bills the heavier slab and raises an
// excess-weight charge, and the declaration being ours is what loses the
// dispute. Under-declaring costs money on every shipment it touches, so
// substituting the store default for the missing unit is the safe direction.
//
// Dimensions aren't truly additive (that's a 3D bin-packing problem), so this
// uses a simple, deliberately conservative approximation: the widest single
// item's footprint (length/breadth), with items assumed stacked on top of
// each other for height. Good enough for courier booking; not exact packing.
export const computeOrderPackage = (order, defaults = {}) => {
  const substitute = {
    weight: Math.max(Number(defaults.defaultWeightKg) || 0, 0),
    length: Math.max(Number(defaults.defaultLengthCm) || 0, 0),
    breadth: Math.max(Number(defaults.defaultBreadthCm) || 0, 0),
    height: Math.max(Number(defaults.defaultHeightCm) || 0, 0),
  };
  // A product's own figure when it has one, the store default when it does not.
  const measure = (value, fallback) => (Number(value) > 0 ? Number(value) : fallback);

  let totalWeight = 0;
  let maxLength = 0;
  let maxBreadth = 0;
  let totalHeight = 0;
  let units = 0;
  let unmeasuredUnits = 0;

  for (const item of order.items || []) {
    const product = item.product;
    // REMAINING units, not ordered units: a partially cancelled line no longer ships
    // its cancelled units, and declaring them would over-state the parcel. The same
    // arithmetic as computeShipmentLines(), so the box and the invoice describe the
    // same goods.
    const quantity = remainingUnits(item);
    if (quantity <= 0) continue;
    units += quantity;
    if (!(Number(product?.weight) > 0)) unmeasuredUnits += quantity;

    totalWeight += measure(product?.weight, substitute.weight) * quantity;
    totalHeight += measure(product?.height, substitute.height) * quantity;
    maxLength = Math.max(maxLength, measure(product?.length, substitute.length));
    maxBreadth = Math.max(maxBreadth, measure(product?.breadth, substitute.breadth));
  }

  // No items to measure at all: return nothing and let resolvePackage() apply the
  // configured default parcel whole, exactly as before.
  if (units === 0) return {};

  return {
    ...(totalWeight > 0 ? { weight: round3(totalWeight) } : {}),
    ...(maxLength > 0 ? { length: round3(maxLength) } : {}),
    ...(maxBreadth > 0 ? { breadth: round3(maxBreadth) } : {}),
    ...(totalHeight > 0 ? { height: round3(totalHeight) } : {}),
    // Not a package field — resolvePackage() reads only the four above and drops
    // this. It is here so a caller can say how much of the parcel was guessed.
    unmeasuredUnits,
  };
};

/**
 * A shipment is only real once Shiprocket has given it both ids.
 *
 * Extracted because three calls now create shipments — forward, return pickup and
 * replacement — and a response that carries no ids must be an error for all three. Storing
 * a shipment with a missing id would leave a parcel we cannot cancel, label or track.
 */
const readShipmentIds = (data, fallbackMessage) => {
  const shiprocketOrderId = Number(data?.order_id);
  const shipmentId = Number(data?.shipment_id);
  if (
    !Number.isFinite(shiprocketOrderId) ||
    shiprocketOrderId <= 0 ||
    !Number.isFinite(shipmentId) ||
    shipmentId <= 0
  ) {
    // Phase "response": Shiprocket answered 200, and a 200 without ids is exactly the
    // reply that may still have created an order we cannot see.
    throw new ShiprocketError(getErrorMessage(data, fallbackMessage), 502, data, {
      phase: "response",
      httpStatus: 200,
    });
  }
  return { data, shiprocketOrderId, shipmentId };
};

const formatOrderDate = (date) => {
  const value = date instanceof Date ? date : new Date(date);
  const pad = (number) => String(number).padStart(2, "0");
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ${pad(
    value.getHours(),
  )}:${pad(value.getMinutes())}`;
};

const splitName = (fullName) => {
  const parts = String(fullName || "Customer").trim().split(/\s+/);
  return {
    firstName: parts.shift() || "Customer",
    lastName: parts.join(" "),
  };
};

// Shiprocket prints address and address_2 on separate label lines. Orders
// placed before addresses were structured only carry the joined `address`.
export const splitAddressLines = (address = {}) => {
  if (!String(address.addressLine1 || "").trim()) {
    return { line1: address.address, line2: "" };
  }
  const landmark = String(address.landmark || "").trim();
  return {
    line1: address.addressLine1.trim(),
    line2: [String(address.addressLine2 || "").trim(), landmark && `Near ${landmark}`]
      .filter(Boolean)
      .join(", "),
  };
};

export const createShiprocketOrder = async (order, packageOverrides = {}) => {
  // Everything up to the request is preparation: a failure here means nothing was sent,
  // and the caller may safely mark the attempt failed and let it be retried. Tagged as
  // such so it is never confused with a request that may have reached Shiprocket.
  let payload;
  let packageDetails;
  let lines;
  try {
    ({ payload, packageDetails, lines } = await buildForwardPayload(order, packageOverrides));
  } catch (error) {
    throw asPreRequest(error);
  }

  const data = await request("/orders/create/adhoc", {
    method: "POST",
    body: payload,
  });

  return {
    ...readShipmentIds(data, "Shiprocket did not return an order ID and shipment ID"),
    packageDetails,
    // Returned so the caller's amount check compares against the SAME figures that
    // were sent, not a second computation that could drift from them.
    lines,
  };
};

const buildForwardPayload = async (order, packageOverrides = {}) => {
  const credentials = await getShiprocketCredentials();
  const computedPackage = computeOrderPackage(order, credentials);
  // Precedence: an explicit per-request override wins, then the per-order
  // total computed from actual product data, then the admin/env default.
  const packageDetails = await resolvePackage({ ...computedPackage, ...packageOverrides });
  const address = order.shippingAddress;
  const customer = splitName(address.fullName);
  const addressLines = splitAddressLines(address);
  const email = order.user?.email;

  if (!email) {
    throw new ShiprocketError("Customer email is required to create a Shiprocket order", 400);
  }

  const lines = computeShipmentLines(order);

  const payload = {
    order_id: String(order._id),
    order_date: formatOrderDate(order.createdAt),
    pickup_location: credentials.pickupLocation,
    billing_customer_name: customer.firstName,
    billing_last_name: customer.lastName,
    billing_address: addressLines.line1,
    billing_address_2: addressLines.line2,
    billing_city: address.city,
    billing_pincode: address.pincode,
    billing_state: address.state,
    billing_country: address.country || "India",
    billing_email: email,
    billing_phone: address.phone,
    shipping_is_billing: true,
    // Remaining units only, with the order discount already inside each line — see
    // computeShipmentLines for why total_discount is always 0.
    order_items: lines.orderItems,
    payment_method: order.paymentMethod === "COD" ? "COD" : "Prepaid",
    shipping_charges: lines.shippingCharges,
    giftwrap_charges: 0,
    transaction_charges: 0,
    total_discount: lines.totalDiscount,
    sub_total: lines.subTotal,
    ...packageDetails,
  };

  return { payload, packageDetails, lines };
};

/**
 * The full address of the configured pickup location.
 *
 * A return needs BOTH ends: the customer's address to collect from and the warehouse
 * address to deliver to. Only the location's NAME is configured locally, so the address is
 * resolved from Shiprocket's own list — which means it can never disagree with what they
 * have registered, and it makes the Phase A pickup-location check load-bearing rather than
 * advisory: a name that isn't registered has no address, so no reverse shipment is booked.
 *
 * @returns {Promise<{ok: boolean, reason?: string, address?: object}>}
 */
export const resolveWarehouseAddress = async () => {
  const { pickupLocation } = await getShiprocketCredentials();
  const name = String(pickupLocation || "").trim();
  if (!name) return { ok: false, reason: "no_pickup_location_configured" };

  const list = await listPickupLocations();
  if (!list.ok) return { ok: false, reason: `pickup_list_unavailable:${list.reason}` };

  const match = list.locations.find((entry) => entry.name === name);
  if (!match) return { ok: false, reason: "pickup_location_not_registered" };
  if (!match.address || !match.city || !match.state || !match.pincode) {
    return { ok: false, reason: "pickup_location_incomplete" };
  }
  return { ok: true, address: match };
};

/**
 * Books a courier to COLLECT a return from the customer.
 *
 * The direction is reversed relative to a normal shipment, and getting it backwards would
 * send a courier to the warehouse to collect from itself: for a return, `pickup_*` is the
 * CUSTOMER and `shipping_*` is the warehouse.
 *
 * `order_id` is the return number rather than the order id — Shiprocket requires it to be
 * unique per shipment, and the order id is already spoken for by the forward parcel.
 * Identity for webhook purposes comes from the AWB, not from this field.
 */
export const createReturnPickup = async ({ returnRequest, order, warehouse, packageOverrides = {} }) => {
  const address = order.shippingAddress;
  const customer = splitName(address.fullName);
  const addressLines = splitAddressLines(address);
  const email = order.user?.email;
  if (!email) {
    throw new ShiprocketError("Customer email is required to book a return pickup", 400);
  }

  const packageDetails = await resolvePackage(packageOverrides);
  const payload = {
    order_id: String(returnRequest.returnNumber),
    order_date: formatOrderDate(returnRequest.createdAt),

    // FROM the customer.
    pickup_customer_name: customer.firstName,
    pickup_last_name: customer.lastName,
    pickup_address: addressLines.line1,
    pickup_address_2: addressLines.line2,
    pickup_city: address.city,
    pickup_state: address.state,
    pickup_country: address.country || "India",
    pickup_pincode: address.pincode,
    pickup_email: email,
    pickup_phone: address.phone,

    // TO the warehouse.
    shipping_customer_name: warehouse.name,
    shipping_address: warehouse.address,
    shipping_city: warehouse.city,
    shipping_state: warehouse.state,
    shipping_country: "India",
    shipping_pincode: warehouse.pincode,
    shipping_email: email,
    shipping_phone: address.phone,

    order_items: [
      {
        name: returnRequest.productSnapshot?.name || "Returned item",
        sku: String(returnRequest.product),
        units: returnRequest.quantity,
        selling_price: returnRequest.productSnapshot?.price || 0,
        discount: 0,
        tax: 0,
        hsn: "",
      },
    ],
    // Never COD. A collection takes nothing from the customer, and asking a courier to
    // collect cash on a return would take money for goods being sent back.
    payment_method: "Prepaid",
    sub_total: (returnRequest.productSnapshot?.price || 0) * returnRequest.quantity,
    ...packageDetails,
  };

  const data = await request("/orders/create/return", { method: "POST", body: payload });
  return readShipmentIds(data, "Shiprocket did not return an order ID and shipment ID for the return pickup");
};

/**
 * Books the OUTBOUND replacement parcel.
 *
 * A normal forward shipment, but for one line rather than the whole order, and always
 * Prepaid: the customer has already paid for the original (or it is a free replacement),
 * so a COD replacement would charge them a second time for goods they are owed.
 */
export const createReplacementShipment = async ({ returnRequest, order, packageOverrides = {} }) => {
  const address = order.shippingAddress;
  const customer = splitName(address.fullName);
  const addressLines = splitAddressLines(address);
  const email = order.user?.email;
  if (!email) {
    throw new ShiprocketError("Customer email is required to dispatch a replacement", 400);
  }

  const packageDetails = await resolvePackage(packageOverrides);
  const credentials = await getShiprocketCredentials();
  const payload = {
    // Suffixed so it cannot collide with the return pickup booked under the same
    // return number.
    order_id: `${returnRequest.returnNumber}-REP`,
    order_date: formatOrderDate(new Date()),
    pickup_location: credentials.pickupLocation,
    billing_customer_name: customer.firstName,
    billing_last_name: customer.lastName,
    billing_address: addressLines.line1,
    billing_address_2: addressLines.line2,
    billing_city: address.city,
    billing_pincode: address.pincode,
    billing_state: address.state,
    billing_country: address.country || "India",
    billing_email: email,
    billing_phone: address.phone,
    shipping_is_billing: true,
    order_items: [
      {
        name: returnRequest.productSnapshot?.name || "Replacement item",
        sku: String(returnRequest.product),
        units: returnRequest.quantity,
        selling_price: returnRequest.productSnapshot?.price || 0,
        discount: 0,
        tax: 0,
        hsn: "",
      },
    ],
    payment_method: "Prepaid",
    shipping_charges: 0,
    giftwrap_charges: 0,
    transaction_charges: 0,
    total_discount: 0,
    sub_total: (returnRequest.productSnapshot?.price || 0) * returnRequest.quantity,
    ...packageDetails,
  };

  const data = await request("/orders/create/adhoc", { method: "POST", body: payload });
  return readShipmentIds(data, "Shiprocket did not return an order ID and shipment ID for the replacement");
};

export const checkServiceability = async (params) => {
  const credentials = await getShiprocketCredentials();
  const query = {
    pickup_postcode: params.pickupPostcode || credentials.pickupPostcode,
    delivery_postcode: params.deliveryPostcode,
    cod: params.cod ? 1 : 0,
    weight: params.weight,
    length: params.length,
    breadth: params.breadth,
    height: params.height,
    declared_value: params.declaredValue,
    mode: params.mode,
  };

  // Deliberately NOT cached.
  //
  // A 60s memo was tried here, to spare the second call a COD checkout makes once live
  // rates are on (the COD gate and the rate lookup ask serviceability the same question).
  // It was removed: the COD gate is a business restriction, and a cache means it answers
  // from a stale snapshot of courier availability — trading the correctness of a gate for
  // one HTTP request is the wrong way round. The duplicate call is the price of both
  // features being on, and only then.
  return request("/courier/serviceability/", { query });
};

/** No-op kept so callers that defensively clear a cache here still work. */
export const clearServiceabilityMemo = () => {};

/**
 * What the cheapest courier would charge to carry THIS parcel to THIS pincode.
 *
 * Fails SOFT, unlike the COD pincode gate, and the asymmetry is deliberate. A COD
 * restriction that cannot be evaluated must refuse, because letting it through defeats the
 * restriction. A shipping RATE that cannot be fetched must not block checkout — the store
 * currently ships free, so falling back to free is both the safe answer and the existing
 * behaviour. Refusing the order instead would turn a courier API blip into lost sales.
 *
 * @returns {Promise<{ok: boolean, amount: number, courierName?: string, reason?: string}>}
 */
export const getCheapestShippingRate = async ({ deliveryPostcode, cod = false, packageDetails, declaredValue } = {}) => {
  if (!(await isShiprocketConfigured())) {
    return { ok: false, amount: 0, reason: "shiprocket_not_configured" };
  }
  try {
    const parcel = packageDetails || (await resolvePackage({}));
    const data = await checkServiceability({ ...parcel, deliveryPostcode, cod, declaredValue });
    const couriers = data?.data?.available_courier_companies ?? data?.available_courier_companies;
    if (!Array.isArray(couriers) || couriers.length === 0) {
      return { ok: false, amount: 0, reason: "no_courier_rates" };
    }
    const cheapest = couriers
      .map((entry) => {
        // Coerced only after ruling out the empty cases, because Number(null) and Number("")
        // are both 0 — a null rate would otherwise pass a Number.isFinite check and become
        // the cheapest courier at no charge, which is the one wrong answer that costs money
        // on every order it touches.
        const raw = entry?.rate;
        const rate = raw === null || raw === undefined || raw === "" ? Number.NaN : Number(raw);
        return { name: String(entry?.courier_name ?? "").trim(), rate };
      })
      // A missing or non-numeric rate is UNKNOWN, not free.
      .filter((entry) => Number.isFinite(entry.rate) && entry.rate >= 0)
      .sort((a, b) => a.rate - b.rate)[0];
    if (!cheapest) return { ok: false, amount: 0, reason: "no_usable_rate" };
    // Rounded up to the rupee: charging less than the courier will bill is a loss on every
    // order, and Indian pricing is not shown in paise.
    return { ok: true, amount: Math.ceil(cheapest.rate), courierName: cheapest.name };
  } catch (error) {
    return { ok: false, amount: 0, reason: error?.message || "request_failed" };
  }
};

/**
 * Can this pincode take a Cash-on-Delivery parcel?
 *
 * Deliberately TRI-STATE. "No courier will carry COD here" and "we could not ask"
 * are different facts, and collapsing them into a boolean is what lets a business
 * restriction fail open — an outage would read as "serviceable" and the restriction
 * would silently stop applying exactly when it is least verifiable.
 *
 * `cod: true` makes Shiprocket filter to couriers that actually support COD for that
 * destination, so a non-empty list is the positive answer and an empty list is a real
 * negative. Anything else — no credentials, a timeout, a transport error, a response
 * that is not the documented shape — is `unverified`, and the caller decides what to
 * do about it. `request()` already carries a 20s AbortSignal timeout, so a hung
 * carrier surfaces here as an error rather than hanging checkout.
 *
 * The failure `reason` is for logs only. It can carry API text and must never be
 * shown to a customer.
 *
 * @returns {Promise<{serviceable: boolean, unverified?: boolean, reason?: string, courierCount?: number}>}
 */
export const checkCodServiceability = async ({ deliveryPostcode, packageDetails } = {}) => {
  const pincode = String(deliveryPostcode ?? "").trim();
  if (!pincode) return { serviceable: false, unverified: true, reason: "no_pincode" };

  if (!(await isShiprocketConfigured())) {
    return { serviceable: false, unverified: true, reason: "shiprocket_not_configured" };
  }

  try {
    const parcel = packageDetails || (await resolvePackage({}));
    const data = await checkServiceability({
      ...parcel,
      deliveryPostcode: pincode,
      cod: true,
    });

    // Shiprocket nests the payload one level down; tolerate both shapes rather than
    // assuming, because an unexpected shape must NOT read as serviceable.
    const couriers =
      data?.data?.available_courier_companies ?? data?.available_courier_companies;
    if (!Array.isArray(couriers)) {
      return { serviceable: false, unverified: true, reason: "unexpected_response_shape" };
    }

    return { serviceable: couriers.length > 0, courierCount: couriers.length };
  } catch (error) {
    return { serviceable: false, unverified: true, reason: error?.message || "request_failed" };
  }
};

/**
 * Does this account's Shiprocket login actually work, right now?
 *
 * There was no way to find this out: a wrong password produced no signal at save time
 * and only surfaced later as a failed shipment, so diagnosing it meant a developer
 * reading server logs. This makes it an admin-visible answer.
 *
 * Forces a fresh login on purpose. Asking through the cached token would report "works"
 * for up to nine days after the password was changed under us — the one situation the
 * check exists for. The trade-off is that each check is a real auth call, so the UI must
 * not poll it; it is a button, not a heartbeat.
 *
 * Never throws and never returns the credentials — only whether they worked, and what
 * Shiprocket said if they did not.
 *
 * @returns {Promise<{ok: boolean, reason: string, detail?: string}>}
 */
export const verifyShiprocketConnection = async () => {
  if (!(await isShiprocketConfigured())) {
    return { ok: false, reason: "not_configured" };
  }
  try {
    const token = await getToken(true);
    return token
      ? { ok: true, reason: "authenticated" }
      : { ok: false, reason: "no_token", detail: "Shiprocket accepted the login but returned no token." };
  } catch (error) {
    // ShiprocketError carries the API's own message, which is the useful part for an
    // admin ("invalid email or password" vs a 503 outage). Safe to show: it describes
    // the attempt, never the secret.
    return {
      ok: false,
      reason: error?.statusCode === 502 ? "rejected" : "unreachable",
      detail: error?.message || "Shiprocket could not be reached.",
    };
  }
};

/**
 * The pickup locations registered on this Shiprocket account.
 *
 * Exists to kill the single most common post-setup failure: `pickupLocation` is a free
 * text field that must match a name in Shiprocket's dashboard EXACTLY, and a typo makes
 * every shipment rejected with an error that names neither the field nor the typo. With
 * this the admin picks from the real list instead of retyping it.
 *
 * Returns an empty list rather than throwing when the account has none, so the UI can
 * say "none registered" — which is itself the answer to why shipments fail.
 *
 * @returns {Promise<{ok: boolean, locations: Array<{name: string, address: string, city: string, state: string, pincode: string}>, reason?: string, detail?: string}>}
 */
/**
 * Drops the cached pickup-location list.
 *
 * Not a test hook — it fixes a real staleness bug. The cache is keyed on nothing but
 * time, so after the admin changes the Shiprocket email/password the cached list still
 * describes the PREVIOUS account, and System Health would go on validating the pickup
 * name against locations that no longer apply. Credentials changing invalidates it.
 */
export const clearPickupLocationCache = () => {
  cachedPickupLocations = null;
  pickupCachedAt = 0;
};

/**
 * Forgets the cached auth token (and any login in flight).
 *
 * Same staleness bug as the pickup cache, with a longer tail: the token is cached for
 * nine days, so after an admin changed the Shiprocket email/password every call kept
 * running as the PREVIOUS account until the token happened to expire — shipments booked
 * on an account the store had just moved away from. Called wherever the credentials
 * change, so the next request logs in with what is saved now.
 *
 * Clearing `pendingLogin` only stops NEW callers joining a login started with the old
 * credentials; one already awaiting it still resolves for that caller, but the
 * generation bump stops it writing the old account's token back into the cache.
 */
export const resetShiprocketToken = () => {
  tokenGeneration += 1;
  cachedToken = null;
  tokenExpiresAt = 0;
  pendingLogin = null;
};

export const listPickupLocations = async ({ forceRefresh = false } = {}) => {
  if (!(await isShiprocketConfigured())) {
    return { ok: false, locations: [], reason: "not_configured" };
  }
  // Only successful results are cached. Caching a failure would make one transient
  // outage suppress the check for five minutes, which is the opposite of useful.
  if (!forceRefresh && cachedPickupLocations && Date.now() - pickupCachedAt < PICKUP_CACHE_TTL_MS) {
    return { ...cachedPickupLocations, cached: true };
  }
  try {
    const data = await request("/settings/company/pickup");
    // Documented shape is data.shipping_address[]; tolerate the bare array too rather
    // than assuming, because an unexpected shape must read as "could not list", never
    // as "this account has no pickup locations".
    const container = data?.data ?? data;
    // Verified against a live account: one with NO pickup address registered answers
    // `{data: {shipping_address: null, recent_addresses: [], …}}`. That is a real
    // answer — "none registered" — not an unreadable response, and reporting it as the
    // latter hid the actual fix (register an address in Shiprocket) behind a vague warning.
    const raw =
      container && "shipping_address" in container && container.shipping_address === null
        ? []
        : data?.data?.shipping_address ?? data?.shipping_address;
    if (!Array.isArray(raw)) {
      return { ok: false, locations: [], reason: "unexpected_response_shape" };
    }
    const result = {
      ok: true,
      locations: raw.map((entry) => ({
        name: String(entry?.pickup_location ?? "").trim(),
        address: String(entry?.address ?? "").trim(),
        city: String(entry?.city ?? "").trim(),
        state: String(entry?.state ?? "").trim(),
        pincode: String(entry?.pin_code ?? entry?.pincode ?? "").trim(),
      })).filter((entry) => entry.name),
    };
    cachedPickupLocations = result;
    pickupCachedAt = Date.now();
    return result;
  } catch (error) {
    return { ok: false, locations: [], reason: "request_failed", detail: error?.message };
  }
};

/**
 * The pickup handover document for a shipment.
 *
 * Same shape as generateLabel/generateInvoice deliberately — it is the third document in
 * the same operational step, and couriers refuse handover without it. Kept as a thin
 * call so the URL, not the PDF, is what gets stored (mirroring `shiprocket.labelUrl`).
 */
export const generateManifest = (shipmentId) =>
  request("/manifests/generate", {
    method: "POST",
    body: { shipment_id: [Number(shipmentId)] },
  });

// `isReturn` marks a reverse (return) shipment. The flag name is not contractually
// documented to us, which is why its only caller sits behind reverseAutoAwbEnabled.
export const assignAwb = (shipmentId, courierId, { isReturn = false } = {}) =>
  request("/courier/assign/awb", {
    method: "POST",
    body: {
      shipment_id: shipmentId,
      ...(courierId ? { courier_id: Number(courierId) } : {}),
      ...(isReturn ? { is_return: 1 } : {}),
    },
  });

export const schedulePickup = (shipmentId, pickupDate) =>
  request("/courier/generate/pickup", {
    method: "POST",
    body: {
      shipment_id: [Number(shipmentId)],
      ...(pickupDate ? { pickup_date: [pickupDate] } : {}),
    },
  });

export const generateLabel = (shipmentId) =>
  request("/courier/generate/label", {
    method: "POST",
    body: { shipment_id: [Number(shipmentId)] },
  });

export const generateInvoice = (shiprocketOrderId) =>
  request("/orders/print/invoice", {
    method: "POST",
    body: { ids: [Number(shiprocketOrderId)] },
  });

/**
 * Tells the courier what to do about a failed delivery.
 *
 * NDR events already arrive on the webhook and are stored, but there was no way to
 * RESPOND — every failed delivery had to be resolved in Shiprocket's own dashboard, so
 * the admin worked in two systems and this one silently drifted.
 *
 * Deliberately thin, and deliberately the only place the NDR request shape lives, so if
 * Shiprocket's contract differs from this there is exactly one line to correct. The
 * caller treats any failure as "the courier did not accept it" and leaves the order
 * where it was, which is the safe way to be wrong about an external contract.
 *
 * @param {string} awbCode the shipment's AWB — NDR is addressed per parcel, not per order
 * @param {"re-attempt"|"return"} action re-attempt delivery, or send it back
 */
export const actOnNdr = (awbCode, { action, comment = "" } = {}) =>
  request(`/ndr/${encodeURIComponent(awbCode)}/action`, {
    method: "POST",
    body: { action, comments: comment },
  });

/**
 * Shiprocket's own record of an order we created — documented as GET /orders/show/{id}.
 * Used to read back what Shiprocket will collect, rather than trusting that it
 * interpreted our payload the way we meant it.
 */
export const getShiprocketOrder = (shiprocketOrderId) =>
  request(`/orders/show/${encodeURIComponent(Number(shiprocketOrderId))}`);

const REPORTED_TOTAL_FIELDS = ["net_total", "total", "order_total", "cod_amount"];

/**
 * The order total Shiprocket reports, or null when it cannot be found.
 *
 * ⚠ UNVERIFIED FIELD NAME. The endpoint is documented; which field holds the
 * collectable total is not, so this tries the plausible names in a fixed order and
 * accepts numbers or numeric strings ("1,234.50" included). Anything else is null —
 * and null makes the amount check `unverified` (a warning), never `ok`. An unexpected
 * shape must not read as "the amounts agree".
 *
 * Correct this list (one line) once a sandbox response confirms the real field.
 */
export const readReportedOrderTotal = (data) => {
  const record = data?.data ?? data;
  if (!record || typeof record !== "object") return null;
  for (const field of REPORTED_TOTAL_FIELDS) {
    const raw = record[field];
    // Number("") and Number(null) are 0 — a blank field must not read as "₹0 total".
    if (typeof raw === "number") {
      if (Number.isFinite(raw)) return raw;
      continue;
    }
    if (typeof raw !== "string" || !raw.trim()) continue;
    const value = Number(raw.replace(/,/g, "").trim());
    if (Number.isFinite(value)) return value;
  }
  return null;
};

export const trackAwb = (awbCode) =>
  request(`/courier/track/awb/${encodeURIComponent(awbCode)}`);

/**
 * One shipment as Shiprocket holds it (`GET /shipments/{id}`, documented in their API
 * helpsheet). Used to recover the AWB of a return pickup or replacement parcel: booking
 * those returns only order and shipment ids, and the AWB is assigned later — in
 * Shiprocket's dashboard or by their auto-assignment — so this is how it reaches us.
 */
export const getShipment = (shipmentId) => request(`/shipments/${Number(shipmentId)}`);

/**
 * The AWB and courier from a getShipment response, or nulls.
 *
 * The response's exact field names are not contractually documented to us, so this
 * reads the plausible spellings and returns null rather than guessing — an AWB stored
 * wrongly would resolve courier events to the wrong parcel.
 *
 * @returns {{awbCode: string|null, courierName: string|null}}
 */
export const readShipmentAwb = (data) => {
  const root = data?.data && typeof data.data === "object" ? data.data : data || {};
  const awb = String(root.awb ?? root.awb_code ?? root.awbCode ?? "").trim();
  const courier = String(root.courier ?? root.courier_name ?? root.sr_courier_name ?? "").trim();
  return {
    // An AWB is an opaque courier identifier, but never contains whitespace and is never
    // a bare zero (Shiprocket's "not assigned" placeholder in some responses).
    awbCode: awb && !/\s/.test(awb) && awb !== "0" ? awb : null,
    courierName: courier || null,
  };
};

export const cancelShiprocketOrder = (shiprocketOrderId) =>
  request("/orders/cancel", {
    method: "POST",
    body: { ids: [Number(shiprocketOrderId)] },
  });
