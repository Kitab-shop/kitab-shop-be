/**
 * Live courier shipping rates (Phase D2).
 *
 * Shipping was hardcoded free: `shippingCharge = 0` in order-pricing.service.js. So this
 * feature is not "swap a flat rate for a live one" — it is the difference between charging
 * a customer nothing and charging them something, which is why every property below is
 * about not doing that by accident.
 *
 *   OFF BY DEFAULT, and the default is load-bearing. A deploy must not start charging.
 *
 *   FAILS SOFT — the deliberate opposite of the COD pincode gate. That gate refuses when it
 *   cannot be evaluated, because letting COD through would defeat the restriction. A rate
 *   that cannot be fetched must NOT block checkout: the store already ships free, so
 *   falling back to free is both the safe answer and the existing behaviour. Turning a
 *   courier API blip into a lost sale would be the worse failure.
 *
 *   NEVER SILENTLY CHEAPER. A missing or non-numeric rate is unknown, not zero. Treating it
 *   as zero would quietly hand the customer the best possible answer and eat the cost.
 *
 *   NOT CACHED, ON PURPOSE. A 60s memo on serviceability was tried, to spare the second
 *   call a COD checkout makes once rates are on. It was removed: the COD pincode gate reads
 *   the same endpoint, and caching made that business restriction answer from a stale
 *   snapshot of courier availability. Trading the correctness of a gate for one HTTP request
 *   is the wrong way round, so the duplicate call stands — and only when both are on.
 *
 * Run with `npm run test:shipping-rates` (or `npm test` for everything).
 */
process.env.PAYMENTS_ENABLED = "false";
process.env.INVENTORY_ENFORCE_STOCK = "false";
process.env.INVENTORY_RESERVE_DURING_PAYMENT = "false";
process.env.NOTIFICATIONS_ENABLED = "false";
process.env.SHIPROCKET_ENABLED = "true";

import mongoose from "mongoose";
import { connect, createSuite, marker, productFixture, addressFixture } from "./helpers.mjs";

const { ok, section, finish } = createSuite("shipping-rates");
await connect();

const OrderModel = (await import("../../src/modules/orders/Order.model.js")).default;
const ProductModel = (await import("../../src/modules/products/Product.model.js")).default;
const CheckoutSetting = (await import("../../src/modules/orders/CheckoutSetting.model.js")).default;
const ShiprocketSetting = (await import("../../src/modules/shipping/ShiprocketSetting.model.js")).default;
const { prepareOrderData } = await import("../../src/modules/orders/order-pricing.service.js");
const { getCheapestShippingRate, clearServiceabilityMemo, checkCodServiceability } = await import(
  "../../src/modules/shipping/shiprocket.service.js"
);

const MARKER = marker("shiprate");
const trash = { products: [] };
let seq = 0;

// ---------------------------------------------------------------- boundary stubs

const realFetch = globalThis.fetch;
const realCheckout = CheckoutSetting.getSettings;
const realShiprocket = ShiprocketSetting.getSettings;

let calls = [];
let rateResponder = () => ({
  status: 200,
  body: {
    data: {
      available_courier_companies: [
        { courier_company_id: 1, courier_name: "Pricey", rate: 120, cod: 1 },
        { courier_company_id: 2, courier_name: "Cheap", rate: 47.2, cod: 1 },
      ],
    },
  },
});

const jsonResponse = ({ status = 200, body = {} }) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
});

globalThis.fetch = async (url, options) => {
  const href = String(url);
  calls.push({ href, method: options?.method || "GET" });
  if (href.includes("/auth/login")) return jsonResponse({ status: 200, body: { token: "stub" } });
  if (href.includes("/courier/serviceability/")) {
    const outcome = rateResponder(href);
    if (outcome instanceof Error) throw outcome;
    return jsonResponse(outcome);
  }
  throw new Error(`unexpected Shiprocket call in test: ${href}`);
};

const resetCalls = () => {
  calls = [];
  clearServiceabilityMemo();
};
const rateCalls = () => calls.filter((c) => c.href.includes("/courier/serviceability/"));

let checkout = {
  codEnabled: true,
  codServiceabilityCheckEnabled: false,
  shippingRatesEnabled: false,
  codMinOrderAmount: 0,
  codMaxOrderAmount: 0,
  cancellationWindowHours: 0,
};
CheckoutSetting.getSettings = async () => ({ ...checkout });

ShiprocketSetting.getSettings = async () => ({
  email: "stub@example.com",
  password: "stub-password",
  pickupLocation: "Primary",
  pickupPostcode: "411001",
  webhookToken: "stub",
  shipmentsEnabled: true,
  autoPushEnabled: true,
  deliveryWebhookEnabled: true,
  reverseShipmentsEnabled: false,
  defaultLengthCm: 10,
  defaultBreadthCm: 10,
  defaultHeightCm: 10,
  defaultWeightKg: 0.5,
});

const restore = () => {
  globalThis.fetch = realFetch;
  CheckoutSetting.getSettings = realCheckout;
  ShiprocketSetting.getSettings = realShiprocket;
};

const makeProduct = async () => {
  seq += 1;
  const product = await ProductModel.create(
    productFixture(`${MARKER}-${seq}`, { stock: 50, price: 500 }),
  );
  trash.products.push(product._id);
  return product;
};

const priceOrder = async (product, paymentMethod) =>
  prepareOrderData({
    items: [{ product: String(product._id), quantity: 2 }],
    rawShippingAddress: addressFixture(),
    userId: new mongoose.Types.ObjectId(),
    redeemCoupon: false,
    useWallet: false,
    ...(paymentMethod ? { paymentMethod } : {}),
  });

// ================================================================ DEFAULT

section("shipping stays free until an admin chooses otherwise");

{
  ok(
    "the setting defaults to off on the schema",
    CheckoutSetting.schema.paths.shippingRatesEnabled?.options?.default === false,
    String(CheckoutSetting.schema.paths.shippingRatesEnabled?.options?.default),
  );
}

{
  checkout = { ...checkout, shippingRatesEnabled: false };
  const product = await makeProduct();
  resetCalls();
  const priced = await priceOrder(product);
  ok(
    "with it off, shipping is free — unchanged from before this feature existed",
    priced.shippingCharge === 0 && priced.totalAmount === 1000,
    JSON.stringify({ shipping: priced.shippingCharge, total: priced.totalAmount }),
  );
  ok(
    "and no rate is ever requested, so checkout is not slowed for stores that don't use it",
    rateCalls().length === 0,
    `calls=${rateCalls().length}`,
  );
}

{
  // The upgrade case: a settings document written before the field existed.
  const saved = checkout;
  checkout = { ...checkout };
  delete checkout.shippingRatesEnabled;
  const product = await makeProduct();
  resetCalls();
  const priced = await priceOrder(product);
  ok(
    "an older settings document also ships free rather than starting to charge",
    priced.shippingCharge === 0 && rateCalls().length === 0,
    JSON.stringify({ shipping: priced.shippingCharge, calls: rateCalls().length }),
  );
  checkout = saved;
}

// ================================================================ CHARGING

section("with it on, the cheapest courier sets the charge");

{
  checkout = { ...checkout, shippingRatesEnabled: true };
  const product = await makeProduct();
  resetCalls();
  const priced = await priceOrder(product);
  ok(
    "the cheapest rate becomes the shipping charge, rounded up to the rupee",
    priced.shippingCharge === 48,
    `shipping=${priced.shippingCharge}`,
  );
  ok(
    "rounding is UP — charging less than the courier bills is a loss on every order",
    priced.shippingCharge === Math.ceil(47.2),
    `shipping=${priced.shippingCharge}`,
  );
  ok(
    "and it reaches the total the customer pays",
    priced.totalAmount === 1048,
    `total=${priced.totalAmount}`,
  );
  ok(
    "the rate is for this order's own pincode",
    rateCalls()[0] && new URL(rateCalls()[0].href).searchParams.get("delivery_postcode") === "411001",
    rateCalls()[0]?.href,
  );
}

{
  const direct = await getCheapestShippingRate({ deliveryPostcode: "411001" });
  ok(
    "the lookup reports which courier the price came from",
    direct.ok === true && direct.courierName === "Cheap" && direct.amount === 48,
    JSON.stringify(direct),
  );
}

// ================================================================ FAILING SOFT

section("a rate that cannot be fetched must not cost a sale");

const softFailures = [
  ["carrier unreachable", () => new Error("socket hang up")],
  ["HTTP 500", () => ({ status: 500, body: { message: "server error" } })],
  ["no courier list", () => ({ status: 200, body: {} })],
  ["empty courier list", () => ({ status: 200, body: { data: { available_courier_companies: [] } } })],
  ["HTTP 200 with an embedded error", () => ({ status: 200, body: { status: 422, message: "bad" } })],
  ["body is not JSON", () => ({ status: 200, body: "<html>down</html>" })],
];

for (const [label, responder] of softFailures) {
  checkout = { ...checkout, shippingRatesEnabled: true };
  rateResponder = responder;
  const product = await makeProduct();
  resetCalls();
  const priced = await priceOrder(product);
  ok(
    `checkout still completes and ships free: ${label}`,
    priced.shippingCharge === 0 && priced.totalAmount === 1000,
    JSON.stringify({ shipping: priced.shippingCharge, total: priced.totalAmount }),
  );
}

{
  // The asymmetry, asserted side by side: the same broken response refuses COD and permits
  // checkout. Both are deliberate, and confusing them would either block every sale or
  // silently drop the COD restriction.
  rateResponder = () => new Error("socket hang up");
  resetCalls();
  const rate = await getCheapestShippingRate({ deliveryPostcode: "411001" });
  const cod = await checkCodServiceability({ deliveryPostcode: "411001" });
  ok(
    "an unfetchable rate falls back to free, while unverifiable COD is refused",
    rate.ok === false && rate.amount === 0 && cod.serviceable === false && cod.unverified === true,
    JSON.stringify({ rate, cod }),
  );
}

{
  // A rate we cannot read is unknown, not free. Treating it as 0 would pick the cheapest
  // possible answer for the customer and eat the cost on every such order.
  rateResponder = () => ({
    status: 200,
    body: {
      data: {
        available_courier_companies: [
          { courier_company_id: 1, courier_name: "NoRate" },
          { courier_company_id: 2, courier_name: "BadRate", rate: "ask us" },
          { courier_company_id: 3, courier_name: "Real", rate: 90 },
        ],
      },
    },
  });
  resetCalls();
  const rate = await getCheapestShippingRate({ deliveryPostcode: "411001" });
  ok(
    "couriers with no usable rate are skipped rather than treated as free",
    rate.ok === true && rate.amount === 90 && rate.courierName === "Real",
    JSON.stringify(rate),
  );
}

{
  rateResponder = () => ({
    status: 200,
    body: { data: { available_courier_companies: [{ courier_company_id: 1, courier_name: "OnlyBad", rate: null }] } },
  });
  resetCalls();
  const rate = await getCheapestShippingRate({ deliveryPostcode: "411001" });
  ok(
    "and when NO courier has a usable rate, the answer is unknown, not zero-charged",
    rate.ok === false && rate.amount === 0 && rate.reason === "no_usable_rate",
    JSON.stringify(rate),
  );
}

// ================================================================ ONE CALL

section("serviceability is never cached");

{
  rateResponder = () => ({
    status: 200,
    body: { data: { available_courier_companies: [{ courier_company_id: 1, courier_name: "Cheap", rate: 47.2, cod: 1 }] } },
  });
  resetCalls();
  await getCheapestShippingRate({ deliveryPostcode: "411001" });
  await getCheapestShippingRate({ deliveryPostcode: "411001" });
  ok(
    "every lookup asks the courier — no stale snapshot of availability",
    rateCalls().length === 2,
    `calls=${rateCalls().length}`,
  );
}

{
  // The reason the memo had to go: a cached answer would have made the COD gate below read
  // the FIRST response for a full minute, so a genuine change in courier availability — the
  // one thing the gate exists to notice — would be invisible to it.
  resetCalls();
  rateResponder = () => ({
    status: 200,
    body: { data: { available_courier_companies: [{ courier_company_id: 1, courier_name: "Cheap", rate: 47.2, cod: 1 }] } },
  });
  const first = await checkCodServiceability({ deliveryPostcode: "411001" });
  rateResponder = () => ({ status: 200, body: { data: { available_courier_companies: [] } } });
  const second = await checkCodServiceability({ deliveryPostcode: "411001" });
  ok(
    "the COD gate sees courier availability change immediately, not a minute later",
    first.serviceable === true && second.serviceable === false,
    JSON.stringify({ first: first.serviceable, second: second.serviceable }),
  );
}

// ================================================================ REFUND MATH

section("the refund maths still excludes shipping");

{
  // proportionalRefundAmount refunds (totalAmount − shippingCharge). Now that shipping can
  // be non-zero, that subtraction is load-bearing rather than a no-op: without it a
  // returned item would refund the courier fee too, which was never the customer's to
  // reclaim on a partial return.
  const { proportionalRefundAmount } = await import("../../src/modules/payments/return-refund.service.js");

  // Same goods, same line, priced with and without a courier charge. `orderShippingCharge`
  // is what tells the function how much of the excess over subtotal is freight rather than
  // tax — omitting it is a documented conservative fallback, so it is passed explicitly.
  const withShipping = proportionalRefundAmount({
    unitPrice: 500,
    quantity: 1,
    orderSubtotal: 1000,
    orderTotal: 1048,
    orderShippingCharge: 48,
  });
  const withoutShipping = proportionalRefundAmount({
    unitPrice: 500,
    quantity: 1,
    orderSubtotal: 1000,
    orderTotal: 1000,
    orderShippingCharge: 0,
  });

  ok(
    "a returned unit refunds its share of the goods, not the courier fee",
    withShipping === 500,
    `refund=${withShipping}`,
  );
  ok(
    "so a live shipping charge does not change what a return pays back",
    withShipping === withoutShipping,
    JSON.stringify({ withShipping, withoutShipping }),
  );
}

// ================================================================ COD RATE

section("a COD order is quoted at the COD rate, not the prepaid one");

{
  // The `cod` flag was hardcoded false here, so a cash order was quoted — and
  // charged — the prepaid rate, silently absorbing the courier's COD handling fee on
  // every one. Inert while rates are off, which is exactly why it was worth closing
  // before anyone switches them on.
  checkout = { ...checkout, shippingRatesEnabled: true };
  const codParam = () => {
    const call = rateCalls()[0];
    return call ? new URL(call.href).searchParams.get("cod") : null;
  };

  const product = await makeProduct();
  resetCalls();
  await priceOrder(product, "COD");
  ok("a COD order asks the courier for the COD rate", codParam() === "1", String(codParam()));

  resetCalls();
  await priceOrder(product, "RAZORPAY");
  ok("a prepaid order asks for the prepaid rate", codParam() === "0", String(codParam()));

  resetCalls();
  await priceOrder(product, "cod");
  ok("the method is matched case-insensitively", codParam() === "1", String(codParam()));

  resetCalls();
  await priceOrder(product);
  ok(
    "an unspecified method defaults to prepaid, as before",
    codParam() === "0",
    String(codParam()),
  );
}

// ================================================================ GUARD

section("pricing refuses to redeem a coupon");

{
  // prepareOrderData has no session to pass, so a redemption started here would
  // commit on its own and survive a failed checkout — spending the customer's
  // allowance and a slot of the coupon's global budget on an order that never
  // existed. Redemption belongs to the two transactional call sites.
  const product = await makeProduct();
  let refusal = null;
  try {
    await prepareOrderData({
      items: [{ product: String(product._id), quantity: 1 }],
      rawShippingAddress: addressFixture(),
      userId: new mongoose.Types.ObjectId(),
      redeemCoupon: true,
    });
  } catch (error) {
    refusal = error;
  }
  ok("redeemCoupon: true is refused outright", Boolean(refusal), refusal?.message);
  ok(
    "and says why",
    /redemption cannot be performed during pricing/i.test(refusal?.message || ""),
    refusal?.message,
  );
}

// ---------------------------------------------------------------- cleanup

restore();

await ProductModel.deleteMany({ _id: { $in: trash.products } });
const leftovers = await ProductModel.countDocuments({ name: new RegExp(MARKER) });
ok("every fixture this suite created is gone", leftovers === 0, `leftovers=${leftovers}`);

const summary = finish();
await mongoose.disconnect();
process.exit(summary.failed > 0 ? 1 : 0);
