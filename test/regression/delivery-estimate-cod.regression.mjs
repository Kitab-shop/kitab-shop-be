/**
 * Product page PIN check: courier-quoted delivery days, and the "Cash on Delivery isn't
 * available here" hint.
 *
 * The delivery box used to answer from a PIN-prefix table alone, so it told customers in
 * PINs no COD courier reaches nothing at all — they found out at checkout. It now reports
 * `codAvailable`, predicting the checkout COD gate (evaluateCodPincodeRestriction).
 *
 * What matters, and what this suite pins:
 *
 *   AGREES WITH CHECKOUT — `false` only when checkout would actually refuse COD: COD on,
 *   the pincode restriction on, and Shiprocket reporting no COD courier. With either
 *   toggle off it says nothing (null), and makes no Shiprocket call.
 *
 *   FAILS OPEN — unlike the gate. An outage or missing credentials must not tell a
 *   customer COD is unavailable, and must never cost them the delivery estimate.
 *
 *   CACHED — the endpoint is anonymous; a repeat check for the same PIN must not reach
 *   Shiprocket again. Unknown answers are not cached.
 *
 *   COURIER DAYS ONLY WHEN SHIPROCKET SHIPS — the range comes from Shiprocket's courier
 *   quotes (plus a dispatch day) only while the store fulfils through Shiprocket. Off,
 *   manual fulfilment, no courier, junk quotes or an outage all fall back to the
 *   PIN-prefix table, which is what the page showed before.
 *
 * Shiprocket is never contacted: `globalThis.fetch` is stubbed. Both settings singletons
 * are stubbed on the model, never written, so the dev store's real toggles are untouched.
 */
process.env.SHIPROCKET_ENABLED = "false";

import mongoose from "mongoose";
import { connect, createSuite, marker, productFixture } from "./helpers.mjs";

const { ok, section, finish } = createSuite("delivery-estimate-cod");
await connect();

const ProductModel = (await import("../../src/modules/products/Product.model.js")).default;
const CheckoutSetting = (await import("../../src/modules/orders/CheckoutSetting.model.js")).default;
const ShiprocketSetting = (await import("../../src/modules/shipping/ShiprocketSetting.model.js")).default;
const { GetDeliveryEstimate } = await import("../../src/modules/products/product.controller.js");
const { clearCodAvailabilityHintCache } = await import(
  "../../src/modules/orders/order-shipping.service.js"
);
const { clearDeliveryRangeCache, DISPATCH_BUFFER_DAYS } = await import(
  "../../src/modules/products/delivery-estimate.service.js"
);

await ProductModel.init();

const MARKER = marker("pdpcod");
const trash = { products: [] };

// ---------------------------------------------------------------- boundary stubs

const realFetch = globalThis.fetch;
const realCheckoutGetSettings = CheckoutSetting.getSettings;
const realShiprocketGetSettings = ShiprocketSetting.getSettings;

let calls = [];
let serviceabilityResponder = () => NOT_SERVICEABLE;

const jsonResponse = ({ status = 200, body = {} }) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify(body),
});

globalThis.fetch = async (url, options) => {
  const href = String(url);
  calls.push({ href, method: options?.method || "GET" });
  if (href.includes("/auth/login")) {
    return jsonResponse({ status: 200, body: { token: `stub-token-${MARKER}` } });
  }
  if (href.includes("/courier/serviceability/")) {
    const outcome = serviceabilityResponder(href);
    if (outcome instanceof Error) throw outcome;
    return jsonResponse(outcome);
  }
  throw new Error(`unexpected Shiprocket call in test: ${href}`);
};

const serviceabilityCalls = () => calls.filter((c) => c.href.includes("/courier/serviceability/")).length;
/** Courier-days lookups ask with cod=0; the COD hint asks with cod=1. */
const quoteCalls = () =>
  calls.filter((c) => c.href.includes("/courier/serviceability/") && c.href.includes("cod=0")).length;

const CONFIGURED = {
  email: "stub@example.com",
  password: "stub-password",
  pickupLocation: "Primary",
  pickupPostcode: "411001",
  webhookToken: "",
  defaultLengthCm: 10,
  defaultBreadthCm: 10,
  defaultHeightCm: 10,
  defaultWeightKg: 0.5,
};
let credentials = { ...CONFIGURED };
ShiprocketSetting.getSettings = async () => ({ ...credentials });

let checkoutSettings = { codEnabled: true, codServiceabilityCheckEnabled: true };
CheckoutSetting.getSettings = async () => ({ ...checkoutSettings });

const restore = () => {
  globalThis.fetch = realFetch;
  CheckoutSetting.getSettings = realCheckoutGetSettings;
  ShiprocketSetting.getSettings = realShiprocketGetSettings;
};

const SERVICEABLE = { status: 200, body: { data: { available_courier_companies: [{ courier_name: "Stub Express", cod: 1 }] } } };
const NOT_SERVICEABLE = { status: 200, body: { data: { available_courier_companies: [] } } };

// ---------------------------------------------------------------- helpers

const product = await ProductModel.create(productFixture(`${MARKER}-book`, { stock: 10 }));
trash.products.push(product._id);

const checkPin = async (pincode) => {
  let statusCode = 200;
  let payload;
  const res = {
    status(code) { statusCode = code; return this; },
    json(data) { payload = data; return this; },
  };
  await GetDeliveryEstimate({ params: { id: String(product._id) }, query: { pincode } }, res);
  return { statusCode, body: payload };
};

/** Fresh state per scenario: no remembered answers, no counted calls. */
const reset = ({ settings, responder = () => NOT_SERVICEABLE, creds = CONFIGURED, shiprocketShips = false } = {}) => {
  clearCodAvailabilityHintCache();
  clearDeliveryRangeCache();
  process.env.SHIPROCKET_ENABLED = shiprocketShips ? "true" : "false";
  process.env.SHIPPING_PROVIDER = "shiprocket";
  calls = [];
  checkoutSettings = { codEnabled: true, codServiceabilityCheckEnabled: true, ...settings };
  serviceabilityResponder = responder;
  credentials = { ...creds };
};

// ---------------------------------------------------------------- scenarios

section("agrees with checkout");
{
  reset({ responder: () => NOT_SERVICEABLE });
  const result = await checkPin("283114");
  ok("no COD courier → codAvailable is false", result.body?.data?.codAvailable === false, JSON.stringify(result.body));
  ok("the delivery estimate is still returned", result.statusCode === 200 && result.body?.data?.minDays > 0);

  reset({ responder: () => SERVICEABLE });
  const served = await checkPin("411001");
  ok("a COD courier → codAvailable is true", served.body?.data?.codAvailable === true, JSON.stringify(served.body));
  ok("the serviceability call asked about COD", calls.some((c) => c.href.includes("cod=1")));
}

section("says nothing when checkout would not refuse");
{
  reset({ settings: { codEnabled: false } });
  const codOff = await checkPin("283114");
  ok("COD off store-wide → null", codOff.body?.data?.codAvailable === null, JSON.stringify(codOff.body));
  ok("… and Shiprocket is not asked", serviceabilityCalls() === 0, `calls=${serviceabilityCalls()}`);

  reset({ settings: { codServiceabilityCheckEnabled: false } });
  const restrictionOff = await checkPin("283114");
  ok(
    "pincode restriction off → null (checkout accepts COD anywhere)",
    restrictionOff.body?.data?.codAvailable === null,
    JSON.stringify(restrictionOff.body),
  );
  ok("… and Shiprocket is not asked", serviceabilityCalls() === 0, `calls=${serviceabilityCalls()}`);
}

section("fails open");
{
  reset({ responder: () => new Error("network down") });
  const outage = await checkPin("283114");
  ok("Shiprocket unreachable → null, not false", outage.body?.data?.codAvailable === null, JSON.stringify(outage.body));
  ok("… and the estimate still arrives", outage.statusCode === 200 && outage.body?.success === true);

  reset({ responder: () => ({ status: 200, body: { unexpected: true } }) });
  const hostile = await checkPin("283114");
  ok("unexpected response shape → null", hostile.body?.data?.codAvailable === null, JSON.stringify(hostile.body));

  reset({ creds: { ...CONFIGURED, email: "", password: "" } });
  const savedEmail = process.env.SHIPROCKET_EMAIL;
  const savedPassword = process.env.SHIPROCKET_PASSWORD;
  delete process.env.SHIPROCKET_EMAIL;
  delete process.env.SHIPROCKET_PASSWORD;
  try {
    const unconfigured = await checkPin("283114");
    ok("no credentials → null", unconfigured.body?.data?.codAvailable === null, JSON.stringify(unconfigured.body));
    ok("… with no Shiprocket call", serviceabilityCalls() === 0, `calls=${serviceabilityCalls()}`);
  } finally {
    if (savedEmail !== undefined) process.env.SHIPROCKET_EMAIL = savedEmail;
    if (savedPassword !== undefined) process.env.SHIPROCKET_PASSWORD = savedPassword;
  }
}

section("cached per pincode");
{
  reset({ responder: () => NOT_SERVICEABLE });
  await checkPin("283114");
  const second = await checkPin("283114");
  ok("a repeat check is answered from cache", serviceabilityCalls() === 1, `calls=${serviceabilityCalls()}`);
  ok("… with the same answer", second.body?.data?.codAvailable === false);

  await checkPin("560001");
  ok("a different pincode is asked separately", serviceabilityCalls() === 2, `calls=${serviceabilityCalls()}`);

  let attempt = 0;
  reset({ responder: () => (attempt++ === 0 ? new Error("blip") : SERVICEABLE) });
  await checkPin("110001");
  const retried = await checkPin("110001");
  ok("an unknown answer is not cached", serviceabilityCalls() === 2, `calls=${serviceabilityCalls()}`);
  ok("… so the next check gets the real answer", retried.body?.data?.codAvailable === true);
}

section("delivery days from courier quotes");
{
  const B = DISPATCH_BUFFER_DAYS;
  const quotes = (couriers, recommended) => ({
    status: 200,
    body: { data: { available_courier_companies: couriers, recommended_courier_company_id: recommended } },
  });
  const COURIERS = [
    { courier_company_id: 43, courier_name: "Fast", estimated_delivery_days: "4", cod: 1 },
    { courier_company_id: 225, courier_name: "Slow", estimated_delivery_days: "8", cod: 1 },
    { courier_company_id: 19, courier_name: "Middle", estimated_delivery_days: "6", cod: 1 },
  ];
  // A PIN whose prefix falls in the table's default band: 3–6 days.
  const isTableEstimate = (r) => r.body?.data?.source === "estimate" && r.body.data.minDays === 3 && r.body.data.maxDays === 6;

  reset({ shiprocketShips: true, responder: () => quotes(COURIERS, 19) });
  const quoted = await checkPin("283114");
  ok(
    "fastest courier + dispatch day → minDays; recommended courier + dispatch day → maxDays",
    quoted.body?.data?.source === "courier" && quoted.body.data.minDays === 4 + B && quoted.body.data.maxDays === 6 + B,
    JSON.stringify(quoted.body?.data),
  );
  ok("dates follow the quoted range", new Date(quoted.body?.data?.latestDate) > new Date(quoted.body?.data?.earliestDate));
  ok("the quote asked for all couriers, not COD-only", quoteCalls() === 1, `quoteCalls=${quoteCalls()}`);

  await checkPin("283114");
  ok("a repeat check is answered from cache", quoteCalls() === 1, `quoteCalls=${quoteCalls()}`);

  reset({ shiprocketShips: true, responder: () => quotes(COURIERS, 999) });
  const unmatched = await checkPin("283114");
  ok(
    "no matching recommendation → slowest quote is the upper bound",
    unmatched.body?.data?.maxDays === 8 + B,
    JSON.stringify(unmatched.body?.data),
  );

  reset({
    shiprocketShips: true,
    responder: () =>
      quotes(
        [
          { courier_company_id: 1, estimated_delivery_days: null },
          { courier_company_id: 2, estimated_delivery_days: "" },
          { courier_company_id: 3, estimated_delivery_days: "soon" },
          { courier_company_id: 4, estimated_delivery_days: "0" },
          { courier_company_id: 5, estimated_delivery_days: "45" },
          { courier_company_id: 6, estimated_delivery_days: "5" },
        ],
        1,
      ),
  });
  const junk = await checkPin("283114");
  ok(
    "missing, zero, non-numeric and absurd quotes are ignored",
    junk.body?.data?.source === "courier" && junk.body.data.minDays === 5 + B && junk.body.data.maxDays === 5 + B,
    JSON.stringify(junk.body?.data),
  );

  reset({ shiprocketShips: true, responder: () => quotes([{ courier_company_id: 1, estimated_delivery_days: null }], 1) });
  ok("only unusable quotes → table estimate", isTableEstimate(await checkPin("283114")));

  reset({ shiprocketShips: true, responder: () => quotes([], null) });
  ok("no courier serves the PIN → table estimate", isTableEstimate(await checkPin("283114")));

  // Only the courier-days call (cod=0) fails: the COD hint runs alongside it, in either order.
  let quoteAttempt = 0;
  reset({
    shiprocketShips: true,
    responder: (href) =>
      href.includes("cod=0") && quoteAttempt++ === 0 ? new Error("blip") : quotes(COURIERS, 19),
  });
  const outage = await checkPin("283114");
  ok("Shiprocket unreachable → table estimate, still 200", outage.statusCode === 200 && isTableEstimate(outage));
  const recovered = await checkPin("283114");
  ok("… and the failure is not cached", recovered.body?.data?.source === "courier", JSON.stringify(recovered.body?.data));

  reset({ shiprocketShips: false, responder: () => quotes(COURIERS, 19) });
  ok("Shiprocket off → table estimate", isTableEstimate(await checkPin("283114")));
  ok("… and no courier quote is requested", quoteCalls() === 0, `quoteCalls=${quoteCalls()}`);

  reset({ shiprocketShips: true, creds: { ...CONFIGURED, shipmentsEnabled: false }, responder: () => quotes(COURIERS, 19) });
  ok("admin chose manual fulfilment → table estimate", isTableEstimate(await checkPin("283114")));
  ok("… and no courier quote is requested", quoteCalls() === 0, `quoteCalls=${quoteCalls()}`);
}

// ---------------------------------------------------------------- cleanup

restore();
await ProductModel.deleteMany({ _id: { $in: trash.products } });

const summary = finish();
await mongoose.disconnect();
process.exit(summary.failed > 0 ? 1 : 0);
