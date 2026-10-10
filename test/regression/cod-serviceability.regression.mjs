/**
 * COD pincode serviceability restriction (security: business-rule bypass).
 *
 * The bypass being closed: the admin panel has always offered "COD will now be
 * restricted by Shiprocket pincode serviceability", and `codServiceabilityCheckEnabled`
 * was stored and read back — but no order path ever consulted it. A customer could
 * select Cash on Delivery for any pincode in India and the order was created, whatever
 * the admin had configured. system-health.service.js even said so out loud ("currently
 * doing nothing") and nothing enforced it anyway.
 *
 * Two properties matter more than the happy path, and most of this suite is about them:
 *
 *   FAIL CLOSED — a restriction that cannot be evaluated must refuse. If it failed open,
 *   a Shiprocket outage, an expired token or wrong credentials would silently disable
 *   the restriction, and the only symptom would be COD orders quietly reaching pincodes
 *   the business had ruled out.
 *
 *   NO SIDE EFFECT BEFORE THE DECISION — the refusal has to land before anything
 *   irreversible. The gate sits immediately before `session.withTransaction`, so a
 *   refused order must leave stock, wallet, coupon, cart and the single-use COD OTP
 *   exactly as they were.
 *
 * Run with `npm run test:cod-serviceability` (or `npm test` for everything).
 *
 * Shiprocket is never contacted: `globalThis.fetch` is stubbed at the transport
 * boundary, which is also what lets the response shape be made hostile on purpose.
 * `CheckoutSetting.getSettings` and `ShiprocketSetting.getSettings` are stubbed on the
 * model rather than written to, because both are singleton documents shared with the
 * running dev store — this suite must not leave the admin's real toggles altered.
 */
process.env.PAYMENTS_ENABLED = "false";
// Stock enforcement ON: "a refused COD order decrements nothing" is one of the
// claims under test, and it is only meaningful if the decrement would have happened.
process.env.INVENTORY_ENFORCE_STOCK = "true";
process.env.INVENTORY_RESERVE_DURING_PAYMENT = "false";
process.env.NOTIFICATIONS_ENABLED = "false";
// Post-order shipment automation off. The COD restriction is a CHECKOUT rule owned by
// the admin checkout toggle, deliberately not coupled to shipment automation — see the
// "restriction is independent of SHIPROCKET_ENABLED" assertion below.
process.env.SHIPROCKET_ENABLED = "false";

import mongoose from "mongoose";
import { connect, createSuite, marker, productFixture, addressFixture } from "./helpers.mjs";

const { ok, section, finish } = createSuite("cod-serviceability");
await connect();

const OrderModel = (await import("../../src/modules/orders/Order.model.js")).default;
const ProductModel = (await import("../../src/modules/products/Product.model.js")).default;
const CheckoutSetting = (await import("../../src/modules/orders/CheckoutSetting.model.js")).default;
const ShiprocketSetting = (await import("../../src/modules/shipping/ShiprocketSetting.model.js")).default;
const CodVerification = (await import("../../src/modules/orders/CodVerification.model.js")).default;
const CouponModel = (await import("../../src/modules/coupons/coupon.model.js")).default;
const CouponRedemption = (await import("../../src/modules/coupons/coupon-redemption.model.js")).default;
const UserProfile = (await import("../../src/modules/profiles/UserProfile.model.js")).default;
const cartModel = (await import("../../src/modules/cart/cart.model.js")).default;

const orderController = await import("../../src/modules/orders/order.controller.js");
const { evaluateCodPincodeRestriction } = await import(
  "../../src/modules/orders/order-shipping.service.js"
);
const { checkCodServiceability } = await import("../../src/modules/shipping/shiprocket.service.js");

await OrderModel.init();
await ProductModel.init();

const MARKER = marker("codserv");
const trash = { orders: [], products: [], verifications: [], coupons: [], profiles: [], carts: [] };
let seq = 0;

// ---------------------------------------------------------------- boundary stubs

const realFetch = globalThis.fetch;
const realCheckoutGetSettings = CheckoutSetting.getSettings;
const realShiprocketGetSettings = ShiprocketSetting.getSettings;

/** Every fetch the code under test attempted, so call counts can be asserted. */
let calls = [];
/** What the serviceability endpoint should do on the next call. */
let serviceabilityResponder = () => ({ status: 200, body: { data: { available_courier_companies: [] } } });

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

const serviceabilityCalls = () => calls.filter((c) => c.href.includes("/courier/serviceability/"));
const resetCalls = () => {
  calls = [];
};

/** Credentials present by default, so `isShiprocketConfigured()` is true. */
let credentials = {
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
ShiprocketSetting.getSettings = async () => ({ ...credentials });

/** Checkout settings the controller will read. COD on, no min/max, restriction off. */
let checkoutSettings = {
  codEnabled: true,
  codServiceabilityCheckEnabled: false,
  codMinOrderAmount: 0,
  codMaxOrderAmount: 0,
  cancellationWindowHours: 0,
};
// Returns a document-like object whose save() lands in the in-memory settings above.
// That lets the REAL UpdateCheckoutSettings controller run its own validation and
// assignment logic without ever writing to the singleton the dev store shares.
CheckoutSetting.getSettings = async () => {
  const doc = { ...checkoutSettings };
  doc.save = async () => {
    checkoutSettings = {
      codEnabled: doc.codEnabled,
      codServiceabilityCheckEnabled: doc.codServiceabilityCheckEnabled,
      codMinOrderAmount: doc.codMinOrderAmount,
      codMaxOrderAmount: doc.codMaxOrderAmount,
      cancellationWindowHours: doc.cancellationWindowHours,
    };
    return doc;
  };
  return doc;
};

const restore = () => {
  globalThis.fetch = realFetch;
  CheckoutSetting.getSettings = realCheckoutGetSettings;
  ShiprocketSetting.getSettings = realShiprocketGetSettings;
};

// ---------------------------------------------------------------- fixtures

const SERVICEABLE = { status: 200, body: { data: { available_courier_companies: [{ courier_name: "Stub Express", cod: 1 }] } } };
const NOT_SERVICEABLE = { status: 200, body: { data: { available_courier_companies: [] } } };

const makeProduct = async (label, overrides = {}) => {
  const product = await ProductModel.create(
    productFixture(`${MARKER}-${label}`, { stock: 10, price: 500, ...overrides }),
  );
  trash.products.push(product._id);
  return product;
};

/** A verified, unconsumed COD OTP — PlaceOrder refuses without one. */
const makeVerification = async (userId) => {
  const doc = await CodVerification.create({
    userId,
    email: `${MARKER}-${seq}@example.test`,
    channel: "email",
    otpHash: "stub-hash-not-used-by-placeorder",
    isVerified: true,
    verifiedAt: new Date(),
  });
  trash.verifications.push(doc._id);
  return doc;
};

const callController = async (handler, { body = {}, user }) => {
  let statusCode = 200;
  let payload;
  const res = {
    status(code) { statusCode = code; return this; },
    json(data) { payload = data; return this; },
  };
  await handler({ params: {}, body, user, query: {} }, res);
  return { statusCode, body: payload };
};

/** Drives the real PlaceOrder handler. Extra body keys are the bypass attempts. */
const placeOrder = async (product, { userId, pincode = "411001", extraBody = {}, coupon } = {}) => {
  seq += 1;
  const user = { id: String(userId), roles: [] };
  const result = await callController(orderController.PlaceOrder, {
    user,
    body: {
      items: [{ product: String(product._id), quantity: 1 }],
      shippingAddress: { ...addressFixture(), pincode },
      paymentMethod: "cod",
      idempotencyKey: `${MARKER}-key-${seq}-aaaaaaaaaaaaaaaa`,
      ...(coupon ? { coupon } : {}),
      ...extraBody,
    },
  });
  if (result.body?.order?._id) trash.orders.push(result.body.order._id);
  return result;
};

// ================================================================ UNIT
// The decision function in isolation: no DB writes, no order, one awaited call.

section("unit — the decision function");

{
  checkoutSettings.codServiceabilityCheckEnabled = true;
  resetCalls();
  const verdict = await evaluateCodPincodeRestriction({
    paymentMethod: "RAZORPAY",
    restrictionEnabled: true,
    pincode: "999999",
  });
  ok(
    "prepaid order is allowed and never consults the courier",
    verdict.allowed === true && verdict.reason === "not_cod" && serviceabilityCalls().length === 0,
    JSON.stringify({ verdict, calls: serviceabilityCalls().length }),
  );
}

{
  resetCalls();
  const verdict = await evaluateCodPincodeRestriction({
    paymentMethod: "COD",
    restrictionEnabled: false,
    pincode: "411001",
  });
  ok(
    "restriction disabled is allowed and never consults the courier",
    verdict.allowed === true &&
      verdict.reason === "restriction_disabled" &&
      serviceabilityCalls().length === 0,
    JSON.stringify({ verdict, calls: serviceabilityCalls().length }),
  );
}

{
  resetCalls();
  serviceabilityResponder = () => SERVICEABLE;
  const verdict = await evaluateCodPincodeRestriction({
    paymentMethod: "COD",
    restrictionEnabled: true,
    pincode: "411001",
  });
  ok(
    "a courier that carries COD there is allowed",
    verdict.allowed === true && verdict.reason === "serviceable",
    JSON.stringify(verdict),
  );
  ok(
    "exactly one serviceability call per decision — no duplicate",
    serviceabilityCalls().length === 1,
    `calls=${serviceabilityCalls().length}`,
  );
  ok(
    "the courier is asked specifically about COD (cod=1)",
    serviceabilityCalls()[0]?.href.includes("cod=1"),
    serviceabilityCalls()[0]?.href,
  );
  ok(
    "the delivery pincode under test is the one sent",
    serviceabilityCalls()[0]?.href.includes("delivery_postcode=411001"),
    serviceabilityCalls()[0]?.href,
  );
}

{
  serviceabilityResponder = () => NOT_SERVICEABLE;
  const verdict = await evaluateCodPincodeRestriction({
    paymentMethod: "COD",
    restrictionEnabled: true,
    pincode: "411001",
  });
  ok(
    "no courier carries COD there — refused as NOT_SERVICEABLE",
    verdict.allowed === false && verdict.code === "COD_PINCODE_NOT_SERVICEABLE",
    JSON.stringify(verdict),
  );
}

// Every way the check can fail to produce an answer must refuse, not allow.
const unverifiableCases = [
  ["carrier is unreachable", () => new Error("network down")],
  ["carrier times out", () => Object.assign(new Error("The operation was aborted"), { name: "TimeoutError" })],
  ["carrier returns HTTP 500", () => ({ status: 500, body: { message: "server error" } })],
  ["carrier returns HTTP 429", () => ({ status: 429, body: { message: "rate limited" } })],
  ["response has no courier list at all", () => ({ status: 200, body: {} })],
  ["courier list is not an array", () => ({ status: 200, body: { data: { available_courier_companies: "yes" } } })],
  ["courier list is null", () => ({ status: 200, body: { data: { available_courier_companies: null } } })],
  ["HTTP 200 carrying an embedded error status", () => ({ status: 200, body: { status: 422, message: "bad postcode" } })],
  ["HTTP 200 carrying success:false", () => ({ status: 200, body: { success: false, message: "nope" } })],
  ["response body is not JSON at all", () => ({ status: 200, body: "<html>maintenance</html>" })],
];

for (const [label, responder] of unverifiableCases) {
  serviceabilityResponder = responder;
  const verdict = await evaluateCodPincodeRestriction({
    paymentMethod: "COD",
    restrictionEnabled: true,
    pincode: "411001",
  });
  ok(
    `fails closed: ${label}`,
    verdict.allowed === false && verdict.code === "COD_SERVICEABILITY_UNVERIFIED",
    JSON.stringify(verdict),
  );
}

{
  // Credentials absent is the outage case an operator is most likely to create by
  // switching the restriction on before wiring Shiprocket up. It must still refuse.
  const saved = credentials;
  credentials = { ...credentials, email: "", password: "" };
  const savedEmail = process.env.SHIPROCKET_EMAIL;
  const savedPassword = process.env.SHIPROCKET_PASSWORD;
  delete process.env.SHIPROCKET_EMAIL;
  delete process.env.SHIPROCKET_PASSWORD;
  resetCalls();

  const verdict = await evaluateCodPincodeRestriction({
    paymentMethod: "COD",
    restrictionEnabled: true,
    pincode: "411001",
  });
  ok(
    "fails closed: Shiprocket credentials are missing",
    verdict.allowed === false && verdict.code === "COD_SERVICEABILITY_UNVERIFIED",
    JSON.stringify(verdict),
  );
  ok(
    "missing credentials are detected without attempting any HTTP call",
    calls.length === 0,
    `calls=${calls.length}`,
  );

  const direct = await checkCodServiceability({ deliveryPostcode: "411001" });
  ok(
    "the boundary reports WHY it could not verify, for operators",
    direct.unverified === true && direct.reason === "shiprocket_not_configured",
    JSON.stringify(direct),
  );

  credentials = saved;
  if (savedEmail !== undefined) process.env.SHIPROCKET_EMAIL = savedEmail;
  if (savedPassword !== undefined) process.env.SHIPROCKET_PASSWORD = savedPassword;
}

{
  for (const bad of ["", "   ", "41100", "4110011", "011001", "abcdef", "41 1001", null, undefined]) {
    const verdict = await evaluateCodPincodeRestriction({
      paymentMethod: "COD",
      restrictionEnabled: true,
      pincode: bad,
    });
    ok(
      `fails closed: unusable pincode ${JSON.stringify(bad)}`,
      verdict.allowed === false && verdict.code === "COD_PINCODE_INVALID",
      JSON.stringify(verdict),
    );
  }
}

{
  // The refusal reaches the customer. Carrier text in it would leak internals and,
  // worse, tell an attacker which failure mode they induced.
  serviceabilityResponder = () => ({
    status: 500,
    body: { message: "Shiprocket internal: token xyz invalid for account 4471" },
  });
  const verdict = await evaluateCodPincodeRestriction({
    paymentMethod: "COD",
    restrictionEnabled: true,
    pincode: "411001",
  });
  ok(
    "the customer message carries no carrier internals",
    !/token|xyz|4471|Shiprocket|internal/i.test(verdict.message),
    verdict.message,
  );
  serviceabilityResponder = () => NOT_SERVICEABLE;
  const policyVerdict = await evaluateCodPincodeRestriction({
    paymentMethod: "COD",
    restrictionEnabled: true,
    pincode: "411001",
  });
  ok(
    "an outage and a policy refusal are indistinguishable to the customer",
    verdict.message === policyVerdict.message && verdict.code !== policyVerdict.code,
    JSON.stringify({ outage: verdict.code, policy: policyVerdict.code }),
  );
}

// ================================================================ INTEGRATION
// The real PlaceOrder handler, real database, real order/stock/wallet/cart/OTP.

section("integration — PlaceOrder");

{
  checkoutSettings.codServiceabilityCheckEnabled = true;
  serviceabilityResponder = () => SERVICEABLE;
  const userId = new mongoose.Types.ObjectId();
  const product = await makeProduct("happy");
  await makeVerification(userId);
  resetCalls();

  const result = await placeOrder(product, { userId });
  const after = await ProductModel.findById(product._id).select("stock");
  ok(
    "COD to a serviceable pincode is placed",
    result.statusCode === 201 || result.statusCode === 200,
    `${result.statusCode} ${JSON.stringify(result.body?.message)}`,
  );
  ok("the order exists and is COD", Boolean(result.body?.order?._id), JSON.stringify(result.body?.order?.paymentMethod));
  ok("stock was decremented for the placed order", after.stock === 9, `stock=${after.stock}`);
  ok(
    "one serviceability call for the whole checkout",
    serviceabilityCalls().length === 1,
    `calls=${serviceabilityCalls().length}`,
  );
}

{
  checkoutSettings.codServiceabilityCheckEnabled = true;
  serviceabilityResponder = () => NOT_SERVICEABLE;
  const userId = new mongoose.Types.ObjectId();
  const product = await makeProduct("refused");
  const verification = await makeVerification(userId);

  // A coupon, a wallet balance and a cart, so "nothing irreversible happened" is a
  // claim about real state rather than about the absence of an order document.
  const coupon = await CouponModel.create({
    couponId: `${MARKER}-CPN`.toUpperCase().slice(0, 24),
    targetType: "all",
    discountType: "fixed",
    discountValue: 50,
    startDate: new Date(Date.now() - 86400000),
    expireDate: new Date(Date.now() + 86400000),
    maxLimit: 10,
    minPurchaseAmount: 0,
    maxPurchaseAmount: 0,
    isActive: true,
  });
  trash.coupons.push(coupon._id);

  const profile = await UserProfile.create({ userid: userId, walletBalance: 200 });
  trash.profiles.push(profile._id);

  const cart = await cartModel.create({
    user: userId,
    items: [{ product: product._id, quantity: 1, variantKey: "", selectedVariants: {}, price: 500, mrp: 500 }],
  });
  trash.carts.push(cart._id);

  const result = await placeOrder(product, { userId, coupon: coupon.couponId });

  const productAfter = await ProductModel.findById(product._id).select("stock");
  const couponAfter = await CouponModel.findById(coupon._id).select("usage");
  const redemptionsAfter = await CouponRedemption.countDocuments({ coupon: coupon.couponId });
  const profileAfter = await UserProfile.findById(profile._id).select("walletBalance");
  const cartAfter = await cartModel.findById(cart._id).select("items");
  const verificationAfter = await CodVerification.findById(verification._id).select("isVerified");
  const orderCount = await OrderModel.countDocuments({ user: userId });

  ok(
    "COD to an unserviceable pincode is refused with 403",
    result.statusCode === 403 && result.body?.code === "COD_PINCODE_NOT_SERVICEABLE",
    `${result.statusCode} ${JSON.stringify(result.body)}`,
  );
  ok("no order was created", orderCount === 0, `orders=${orderCount}`);
  ok("no stock was decremented", productAfter.stock === 10, `stock=${productAfter.stock}`);
  ok("no coupon redemption was recorded", redemptionsAfter === 0 && (couponAfter.usage || 0) === 0, JSON.stringify({ redemptions: redemptionsAfter, usage: couponAfter.usage }));
  ok("no wallet was debited", profileAfter.walletBalance === 200, `balance=${profileAfter.walletBalance}`);
  ok("the cart was not cleared", (cartAfter.items?.length || 0) === 1, `items=${cartAfter.items?.length}`);
  ok(
    "the single-use COD OTP was not consumed",
    Boolean(verificationAfter) && verificationAfter.isVerified === true,
    JSON.stringify(verificationAfter),
  );
}

{
  checkoutSettings.codServiceabilityCheckEnabled = true;
  serviceabilityResponder = () => new Error("connect ECONNREFUSED");
  const userId = new mongoose.Types.ObjectId();
  const product = await makeProduct("outage");
  await makeVerification(userId);

  const result = await placeOrder(product, { userId });
  const after = await ProductModel.findById(product._id).select("stock");
  const orderCount = await OrderModel.countDocuments({ user: userId });

  ok(
    "restriction on + carrier down = COD refused, not silently allowed",
    result.statusCode === 403 && result.body?.code === "COD_SERVICEABILITY_UNVERIFIED",
    `${result.statusCode} ${JSON.stringify(result.body)}`,
  );
  ok("the failed-closed refusal created no order", orderCount === 0, `orders=${orderCount}`);
  ok("the failed-closed refusal decremented no stock", after.stock === 10, `stock=${after.stock}`);
}

{
  // The toggle is what turns this on. With it off, behaviour is byte-for-byte the
  // pre-fix behaviour — this is the regression guard for existing COD stores.
  checkoutSettings.codServiceabilityCheckEnabled = false;
  serviceabilityResponder = () => {
    throw new Error("serviceability must not be consulted when the restriction is off");
  };
  const userId = new mongoose.Types.ObjectId();
  const product = await makeProduct("toggleoff");
  await makeVerification(userId);
  resetCalls();

  const result = await placeOrder(product, { userId, pincode: "744303" });
  ok(
    "restriction off: COD is placed for any valid pincode, as before",
    result.statusCode === 201 || result.statusCode === 200,
    `${result.statusCode} ${JSON.stringify(result.body?.message)}`,
  );
  ok(
    "restriction off: the courier is never called",
    serviceabilityCalls().length === 0,
    `calls=${serviceabilityCalls().length}`,
  );
}

// ================================================================ BYPASS
// Each of these is a way a client could try to talk its way past the restriction.

section("bypass attempts");

{
  checkoutSettings.codServiceabilityCheckEnabled = true;
  serviceabilityResponder = () => NOT_SERVICEABLE;
  const userId = new mongoose.Types.ObjectId();
  const product = await makeProduct("clientflags");
  await makeVerification(userId);

  const result = await placeOrder(product, {
    userId,
    extraBody: {
      // Every shape of "trust me" a tampered client could send.
      codServiceable: true,
      codServiceabilityCheckEnabled: false,
      serviceable: true,
      skipServiceabilityCheck: true,
      codPincodeVerified: true,
      checkoutSettings: { codServiceabilityCheckEnabled: false },
      available_courier_companies: [{ courier_name: "Fake", cod: 1 }],
    },
  });
  const orderCount = await OrderModel.countDocuments({ user: userId });
  ok(
    "client-supplied serviceability flags are ignored",
    result.statusCode === 403 && result.body?.code === "COD_PINCODE_NOT_SERVICEABLE",
    `${result.statusCode} ${JSON.stringify(result.body)}`,
  );
  ok("no order slipped through on a client flag", orderCount === 0, `orders=${orderCount}`);
}

{
  // The pincode the courier is asked about must be the pincode that will be
  // delivered to. A second pincode field anywhere in the body must not be the one
  // that gets checked.
  checkoutSettings.codServiceabilityCheckEnabled = true;
  const asked = [];
  serviceabilityResponder = (href) => {
    asked.push(new URL(href).searchParams.get("delivery_postcode"));
    return NOT_SERVICEABLE;
  };
  const userId = new mongoose.Types.ObjectId();
  const product = await makeProduct("pincodeswap");
  await makeVerification(userId);

  const result = await placeOrder(product, {
    userId,
    pincode: "744303",
    extraBody: { pincode: "411001", deliveryPincode: "411001", codPincode: "411001" },
  });
  ok(
    "the courier is asked about the delivery address pincode, not a decoy",
    asked.length === 1 && asked[0] === "744303",
    JSON.stringify(asked),
  );
  ok(
    "the decoy pincode did not win",
    result.statusCode === 403,
    `${result.statusCode} ${JSON.stringify(result.body)}`,
  );
}

{
  // Idempotency replay: a refused attempt must not be reusable as a "already placed"
  // hit later, and re-sending the same key must be refused again rather than pass.
  checkoutSettings.codServiceabilityCheckEnabled = true;
  serviceabilityResponder = () => NOT_SERVICEABLE;
  const userId = new mongoose.Types.ObjectId();
  const product = await makeProduct("replay");
  await makeVerification(userId);

  const first = await placeOrder(product, { userId });
  const second = await placeOrder(product, { userId });
  const orderCount = await OrderModel.countDocuments({ user: userId });
  ok(
    "a refused COD order stays refused on retry",
    first.statusCode === 403 && second.statusCode === 403,
    `${first.statusCode}/${second.statusCode}`,
  );
  ok("retrying a refused order created nothing", orderCount === 0, `orders=${orderCount}`);
}

{
  // Razorpay must be entirely unaffected: this endpoint refuses non-COD before the
  // gate, and no prepaid creation path consults the restriction at all.
  checkoutSettings.codServiceabilityCheckEnabled = true;
  serviceabilityResponder = () => {
    throw new Error("prepaid checkout must never consult COD serviceability");
  };
  const userId = new mongoose.Types.ObjectId();
  const product = await makeProduct("prepaid");
  resetCalls();

  const result = await placeOrder(product, {
    userId,
    pincode: "744303",
    extraBody: { paymentMethod: "razorpay" },
  });
  ok(
    "prepaid is rejected by this endpoint before any COD gate runs",
    result.statusCode === 400,
    `${result.statusCode} ${JSON.stringify(result.body?.message)}`,
  );
  ok(
    "prepaid checkout triggers no serviceability call",
    serviceabilityCalls().length === 0,
    `calls=${serviceabilityCalls().length}`,
  );
}

{
  // Structural: the prepaid order-creation paths do not import the restriction, so
  // there is no route by which a Razorpay order could ever be blocked by it.
  const { readFile } = await import("node:fs/promises");
  const prepaidSources = [
    "src/modules/payments/payment.controller.js",
    "src/modules/payments/payment-order.service.js",
  ];
  const contaminated = [];
  for (const file of prepaidSources) {
    const src = await readFile(new URL(`../../${file}`, import.meta.url), "utf8");
    if (src.includes("evaluateCodPincodeRestriction") || src.includes("checkCodServiceability")) {
      contaminated.push(file);
    }
  }
  ok(
    "no prepaid creation path references the COD restriction",
    contaminated.length === 0,
    contaminated.join(", "),
  );
}

{
  // The gate must be positioned before the transaction, not merely present. Source
  // order is the only way to assert placement, and placement is the whole safety
  // argument for "no side effect before the decision".
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(
    new URL("../../src/modules/orders/order.controller.js", import.meta.url),
    "utf8",
  );
  const gateAt = src.indexOf("evaluateCodPincodeRestriction({");
  const txnAt = src.indexOf("session = await OrderModel.startSession()");
  const maxAt = src.indexOf('code: "COD_ABOVE_MAX"');
  ok(
    "the gate sits after the COD min/max checks and before the transaction opens",
    gateAt > 0 && maxAt > 0 && txnAt > 0 && maxAt < gateAt && gateAt < txnAt,
    JSON.stringify({ maxAt, gateAt, txnAt }),
  );
}

{
  // The admin toggle itself must survive this change — the fix enforces the setting,
  // it does not remove or rename it.
  const paths = CheckoutSetting.schema.paths;
  ok(
    "the admin toggle still exists on the schema",
    Object.prototype.hasOwnProperty.call(paths, "codServiceabilityCheckEnabled"),
    Object.keys(paths).join(","),
  );
  ok(
    "the toggle still defaults to off, so existing stores are unchanged on deploy",
    paths.codServiceabilityCheckEnabled?.options?.default === false,
    String(paths.codServiceabilityCheckEnabled?.options?.default),
  );
}

{
  // The admin health page used to state the opposite of the truth ("fails open ...
  // currently doing nothing"). With enforcement in place that sentence would send an
  // operator looking for the wrong problem while every COD order was being refused.
  const { buildSystemHealth } = await import("../../src/modules/admin/system-health.service.js");
  const findCheck = (health) =>
    (health?.groups || []).flatMap((group) => group.checks || []).find((c) => c?.id === "checkout.codPincode");

  checkoutSettings.codEnabled = true;
  checkoutSettings.codServiceabilityCheckEnabled = true;

  const savedCredentials = credentials;
  const savedEmail = process.env.SHIPROCKET_EMAIL;
  const savedPassword = process.env.SHIPROCKET_PASSWORD;
  credentials = { ...credentials, email: "", password: "" };
  delete process.env.SHIPROCKET_EMAIL;
  delete process.env.SHIPROCKET_PASSWORD;

  const brokenHealth = findCheck(await buildSystemHealth());
  ok(
    "health: restriction on with no credentials is reported as critical",
    brokenHealth?.status === "critical",
    JSON.stringify(brokenHealth),
  );
  ok(
    "health: it says COD is being refused, not that the check does nothing",
    /fails CLOSED/i.test(`${brokenHealth?.detail} ${brokenHealth?.action}`) &&
      !/fails open|doing nothing/i.test(`${brokenHealth?.detail} ${brokenHealth?.action}`),
    JSON.stringify(brokenHealth),
  );

  credentials = savedCredentials;
  if (savedEmail !== undefined) process.env.SHIPROCKET_EMAIL = savedEmail;
  if (savedPassword !== undefined) process.env.SHIPROCKET_PASSWORD = savedPassword;

  const readyHealth = findCheck(await buildSystemHealth());
  ok(
    "health: restriction on with credentials present is reported as ok",
    readyHealth?.status === "ok",
    JSON.stringify(readyHealth),
  );
}

section("admin coverage mode governs checkout");

{
  // The admin panel offers two modes, stored as the one boolean. What matters is that
  // picking a mode actually changes what checkout does — the setting was previously
  // stored and read and changed nothing at all, which is the bug this suite exists for.
  const settingsController = await import("../../src/modules/orders/checkout-settings.controller.js");

  const setCoverageMode = (restricted) =>
    callController(settingsController.UpdateCheckoutSettings, {
      body: { codServiceabilityCheckEnabled: restricted },
      user: { id: String(new mongoose.Types.ObjectId()), roles: ["admin"] },
    });

  const shiprocketMode = await setCoverageMode(true);
  ok(
    'admin picking "Follow Shiprocket serviceability" is stored',
    shiprocketMode.statusCode === 200 &&
      shiprocketMode.body?.settings?.codServiceabilityCheckEnabled === true,
    JSON.stringify(shiprocketMode.body?.settings),
  );

  serviceabilityResponder = () => NOT_SERVICEABLE;
  const userA = new mongoose.Types.ObjectId();
  const productA = await makeProduct("modeon");
  await makeVerification(userA);
  const refused = await placeOrder(productA, { userId: userA, pincode: "744303" });
  ok(
    "in Shiprocket mode an unserviceable pincode is refused",
    refused.statusCode === 403 && refused.body?.code === "COD_PINCODE_NOT_SERVICEABLE",
    `${refused.statusCode} ${JSON.stringify(refused.body?.code)}`,
  );

  const everywhereMode = await setCoverageMode(false);
  ok(
    'admin picking "Deliver COD everywhere" is stored',
    everywhereMode.statusCode === 200 &&
      everywhereMode.body?.settings?.codServiceabilityCheckEnabled === false,
    JSON.stringify(everywhereMode.body?.settings),
  );

  serviceabilityResponder = () => {
    throw new Error("COD-everywhere mode must not consult the courier");
  };
  const userB = new mongoose.Types.ObjectId();
  const productB = await makeProduct("modeoff");
  await makeVerification(userB);
  resetCalls();
  const allowed = await placeOrder(productB, { userId: userB, pincode: "744303" });
  ok(
    "in COD-everywhere mode the same pincode is accepted",
    allowed.statusCode === 201 || allowed.statusCode === 200,
    `${allowed.statusCode} ${JSON.stringify(allowed.body?.message)}`,
  );
  ok(
    "in COD-everywhere mode the courier is never contacted",
    serviceabilityCalls().length === 0,
    `calls=${serviceabilityCalls().length}`,
  );

  // Switching the restriction ON without a Shiprocket account would set the store to refuse
  // every COD order, since the check fails closed. Refused at the endpoint, not just disabled
  // in the panel — the PATCH is callable directly.
  {
    const savedCredentials = credentials;
    credentials = { ...credentials, email: "", password: "" };
    const savedEmail = process.env.SHIPROCKET_EMAIL;
    const savedPassword = process.env.SHIPROCKET_PASSWORD;
    delete process.env.SHIPROCKET_EMAIL;
    delete process.env.SHIPROCKET_PASSWORD;

    await setCoverageMode(false);
    const refused = await setCoverageMode(true);
    ok(
      "turning the restriction ON with no Shiprocket account is refused",
      refused.statusCode === 409 && refused.body?.code === "SHIPROCKET_NOT_CONFIGURED",
      `${refused.statusCode} ${JSON.stringify(refused.body?.code)}`,
    );
    ok(
      "and the message tells the admin where to connect it",
      /Operations → Shipping/.test(refused.body?.message || ""),
      refused.body?.message,
    );
    ok(
      "the stored mode is unchanged by the refusal",
      checkoutSettings.codServiceabilityCheckEnabled === false,
      JSON.stringify(checkoutSettings.codServiceabilityCheckEnabled),
    );

    // The escape route. A store already refusing every COD order must be able to switch back
    // WITHOUT first fixing Shiprocket — otherwise the fail-closed design becomes a trap.
    checkoutSettings = { ...checkoutSettings, codServiceabilityCheckEnabled: true };
    const escaped = await setCoverageMode(false);
    ok(
      "turning it OFF is always allowed, even with no Shiprocket account",
      escaped.statusCode === 200 &&
        escaped.body?.settings?.codServiceabilityCheckEnabled === false,
      `${escaped.statusCode} ${JSON.stringify(escaped.body?.settings?.codServiceabilityCheckEnabled)}`,
    );

    credentials = savedCredentials;
    if (savedEmail !== undefined) process.env.SHIPROCKET_EMAIL = savedEmail;
    if (savedPassword !== undefined) process.env.SHIPROCKET_PASSWORD = savedPassword;
  }

  // The mode is a boolean on purpose: the controller assigns it only for a real
  // boolean, so a junk payload leaves the admin's choice intact rather than
  // coercing "false"/0/null into a mode switch.
  await setCoverageMode(true);
  for (const junk of ["false", 0, null, "", "off", {}]) {
    await callController(settingsController.UpdateCheckoutSettings, {
      body: { codServiceabilityCheckEnabled: junk },
      user: { id: String(new mongoose.Types.ObjectId()), roles: ["admin"] },
    });
  }
  ok(
    "non-boolean payloads cannot flip the coverage mode",
    checkoutSettings.codServiceabilityCheckEnabled === true,
    JSON.stringify(checkoutSettings.codServiceabilityCheckEnabled),
  );
}

// ---------------------------------------------------------------- cleanup

restore();

await Promise.all([
  OrderModel.deleteMany({ _id: { $in: trash.orders } }),
  ProductModel.deleteMany({ _id: { $in: trash.products } }),
  CodVerification.deleteMany({ _id: { $in: trash.verifications } }),
  CouponModel.deleteMany({ _id: { $in: trash.coupons } }),
  UserProfile.deleteMany({ _id: { $in: trash.profiles } }),
  cartModel.deleteMany({ _id: { $in: trash.carts } }),
]);

const leftovers = await OrderModel.countDocuments({ idempotencyKey: new RegExp(MARKER) });
ok("every fixture this suite created is gone", leftovers === 0, `leftovers=${leftovers}`);

const summary = finish();
await mongoose.disconnect();
process.exit(summary.failed > 0 ? 1 : 0);
