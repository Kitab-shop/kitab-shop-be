import ShiprocketSetting from "./ShiprocketSetting.model.js";
import { getFeatures, isShippingEnabled } from "../../config/features.config.js";

const DEFAULT_BASE_URL = "https://apiv2.shiprocket.in/v1/external";
const TOKEN_LIFETIME_MS = 9 * 24 * 60 * 60 * 1000;

let cachedToken = null;
let tokenExpiresAt = 0;
let pendingLogin = null;

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


export class ShiprocketError extends Error {
  constructor(message, statusCode = 502, details = null) {
    super(message);
    this.name = "ShiprocketError";
    this.statusCode = statusCode;
    this.details = details;
  }
}

// Admin-panel settings win when set; falling back to .env lets an existing
// deployment keep working before anyone touches the new admin panel.
const resolved = (dbValue, envName, fallback = "") => {
  const fromDb = String(dbValue ?? "").trim();
  if (fromDb) return fromDb;
  const fromEnv = String(process.env[envName] ?? "").trim();
  return fromEnv || fallback;
};

export const getShiprocketCredentials = async () => {
  const settings = await ShiprocketSetting.getSettings();
  return {
    email: resolved(settings.email, "SHIPROCKET_EMAIL"),
    password: resolved(settings.password, "SHIPROCKET_PASSWORD"),
    pickupLocation: resolved(settings.pickupLocation, "SHIPROCKET_PICKUP_LOCATION", "Primary"),
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
 * @returns {Promise<{permitted: boolean, configured: boolean, shipments: boolean, autoPush: boolean, deliveryWebhook: boolean}>}
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
  return {
    permitted,
    configured: await isShiprocketConfigured(),
    shipments,
    // Both nested under shipments: auto-pushing or receiving status for shipments the
    // store does not create through Shiprocket is meaningless.
    autoPush: shipments && shipping.autoCreateOrder && chosen(settings.autoPushEnabled),
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

  cachedToken = data.token;
  tokenExpiresAt = Date.now() + TOKEN_LIFETIME_MS;
  return cachedToken;
};

const getToken = async (forceRefresh = false) => {
  if (!forceRefresh && cachedToken && Date.now() < tokenExpiresAt) {
    return cachedToken;
  }

  if (!pendingLogin) {
    pendingLogin = login().finally(() => {
      pendingLogin = null;
    });
  }
  return pendingLogin;
};

const request = async (path, { method = "GET", body, query } = {}, retry = true) => {
  const { baseUrl } = await getConfig();
  const url = new URL(`${baseUrl}${path}`);
  for (const [key, value] of Object.entries(query || {})) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  const token = await getToken();
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
    throw new ShiprocketError(`Shiprocket is unreachable: ${error.message}`, 503);
  }

  if (response.status === 401 && retry) {
    cachedToken = null;
    tokenExpiresAt = 0;
    await getToken(true);
    return request(path, { method, body, query }, false);
  }

  const data = await readResponse(response);
  if (!response.ok) {
    throw new ShiprocketError(
      getErrorMessage(data, `Shiprocket request failed with status ${response.status}`),
      response.status === 429 ? 503 : 502,
      data,
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
    const quantity = Number(item.quantity) || 0;
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
    throw new ShiprocketError(getErrorMessage(data, fallbackMessage), 502, data);
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

export const createShiprocketOrder = async (order, packageOverrides = {}) => {
  const credentials = await getShiprocketCredentials();
  const computedPackage = computeOrderPackage(order, credentials);
  // Precedence: an explicit per-request override wins, then the per-order
  // total computed from actual product data, then the admin/env default.
  const packageDetails = await resolvePackage({ ...computedPackage, ...packageOverrides });
  const address = order.shippingAddress;
  const customer = splitName(address.fullName);
  const email = order.user?.email;

  if (!email) {
    throw new ShiprocketError("Customer email is required to create a Shiprocket order", 400);
  }

  const payload = {
    order_id: String(order._id),
    order_date: formatOrderDate(order.createdAt),
    pickup_location: credentials.pickupLocation,
    billing_customer_name: customer.firstName,
    billing_last_name: customer.lastName,
    billing_address: address.address,
    billing_city: address.city,
    billing_pincode: address.pincode,
    billing_state: address.state,
    billing_country: address.country || "India",
    billing_email: email,
    billing_phone: address.phone,
    shipping_is_billing: true,
    order_items: order.items.map((item) => ({
      name: item.name,
      sku: String(item.product?._id || item.product),
      units: item.quantity,
      selling_price: item.price,
      discount: 0,
      tax: 0,
      hsn: "",
    })),
    payment_method: order.paymentMethod === "COD" ? "COD" : "Prepaid",
    shipping_charges: order.shippingCharge || 0,
    giftwrap_charges: 0,
    transaction_charges: 0,
    total_discount: order.discount || 0,
    sub_total: Math.max(0, order.totalAmount - (order.shippingCharge || 0)),
    ...packageDetails,
  };

  const data = await request("/orders/create/adhoc", {
    method: "POST",
    body: payload,
  });

  return { ...readShipmentIds(data, "Shiprocket did not return an order ID and shipment ID"), packageDetails };
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
    pickup_address: address.address,
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
    billing_address: address.address,
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
    const raw = data?.data?.shipping_address ?? data?.shipping_address;
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

export const assignAwb = (shipmentId, courierId) =>
  request("/courier/assign/awb", {
    method: "POST",
    body: {
      shipment_id: shipmentId,
      ...(courierId ? { courier_id: Number(courierId) } : {}),
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

export const trackAwb = (awbCode) =>
  request(`/courier/track/awb/${encodeURIComponent(awbCode)}`);

export const cancelShiprocketOrder = (shiprocketOrderId) =>
  request("/orders/cancel", {
    method: "POST",
    body: { ids: [Number(shiprocketOrderId)] },
  });
