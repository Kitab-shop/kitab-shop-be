/**
 * A variant's own price must be the price the customer is CHARGED.
 *
 * `variants[].price` and `variants[].mrp` were stored, validated and displayed, but
 * never charged. The product page picks the variant's price —
 *
 *     const displayPrice = selectedSizeOpt?.price ? selectedSizeOpt.price : product.price;
 *
 * — and `optionPriceAboveMrp` exists purely to stop a variant being priced above the
 * MRP it will be shown against. Yet `prepareOrderData`, both cart write paths and the
 * coupon subtotal all read `product.price` unconditionally. A ₹999 hardcover variant
 * of a ₹299 paperback was therefore quoted at ₹999 and SOLD at ₹299, and a variant
 * priced BELOW the base overcharged the customer. Variant stock was honoured
 * correctly throughout; only price was missed, which is why neither money audit
 * caught it — `totalAmount` was internally consistent, its input was wrong.
 *
 * The fallback is the other half of the contract: `variants[].price` defaults to
 * `null`, so every product that prices at product level must be unaffected.
 *
 * Run with `node test/regression/variant-pricing.regression.mjs` (or `npm test` for everything).
 */
process.env.NOTIFICATIONS_ENABLED = "false";
process.env.SHIPROCKET_ENABLED = "false";

import mongoose from "mongoose";
import { addressFixture, connect, createSuite, marker, productFixture } from "./helpers.mjs";

const { ok, section, finish } = createSuite("variant-pricing");
await connect();

const ProductModel = (await import("../../src/modules/products/Product.model.js")).default;
const { effectiveUnitPrice, effectiveUnitMrp, unitPricingFor, variantKeyOf } = await import(
  "../../src/modules/inventory/variant.service.js"
);
const { prepareOrderData } = await import("../../src/modules/orders/order-pricing.service.js");

const MARKER = marker("variantprice");
const trash = [];
let seq = 0;

/** Base ₹299 paperback with a dearer hardcover and a cheaper e-book. */
const makeProduct = async (variants) => {
  seq += 1;
  const product = await ProductModel.create(
    productFixture(`${MARKER}-${seq}`, {
      price: 299,
      mrp: 350,
      // The total across variants, as the model requires.
      stock: variants.reduce((total, v) => total + (v.stock || 0), 0) || 10,
      variants,
    }),
  );
  trash.push(product._id);
  return product;
};

const variant = (name, overrides = {}) => ({
  name,
  attributes: { format: name },
  stock: 5,
  active: true,
  ...overrides,
});

const priceOrder = async (product, variantName, quantity = 1) =>
  prepareOrderData({
    items: [
      {
        product: String(product._id),
        quantity,
        ...(variantName ? { selectedVariants: { format: variantName } } : {}),
      },
    ],
    rawShippingAddress: addressFixture(),
    userId: new mongoose.Types.ObjectId(),
  });

// ================================================================

section("the variant's price is the price charged");

{
  const product = await makeProduct([
    variant("Hardcover", { price: 999, mrp: 1200 }),
    variant("Paperback"),
  ]);
  const priced = await priceOrder(product, "Hardcover");
  ok(
    "a dearer variant is charged at its own price, not the base product's",
    priced.subtotal === 999,
    `subtotal=${priced.subtotal} (expected 999, base price is 299)`,
  );
  ok(
    "the order line snapshots the variant price",
    priced.orderItems[0].price === 999,
    `line price=${priced.orderItems[0].price}`,
  );
  ok(
    "quantity multiplies the variant price",
    (await priceOrder(product, "Hardcover", 3)).subtotal === 2997,
    String((await priceOrder(product, "Hardcover", 3)).subtotal),
  );
}

{
  // The direction that overcharges, which is the one a customer complains about.
  const product = await makeProduct([variant("Ebook", { price: 99, mrp: 150 })]);
  const priced = await priceOrder(product, "Ebook");
  ok(
    "a cheaper variant is charged at its own price, not the dearer base",
    priced.subtotal === 99,
    `subtotal=${priced.subtotal} (expected 99, base price is 299)`,
  );
}

section("product-level pricing is untouched");

{
  const product = await makeProduct([variant("Paperback"), variant("Large Print")]);
  const priced = await priceOrder(product, "Paperback");
  ok(
    "a variant with no price of its own falls back to the product price",
    priced.subtotal === 299,
    `subtotal=${priced.subtotal}`,
  );
}

{
  seq += 1;
  const plain = await ProductModel.create(
    productFixture(`${MARKER}-${seq}`, { price: 299, mrp: 350, stock: 10 }),
  );
  trash.push(plain._id);
  const priced = await priceOrder(plain, null);
  ok(
    "a product with no variants at all prices exactly as before",
    priced.subtotal === 299,
    `subtotal=${priced.subtotal}`,
  );
}

section("the price/mrp pair always describes ONE variant");

{
  const product = await makeProduct([variant("Hardcover", { price: 999, mrp: 1200 })]);
  const key = variantKeyOf(product.variants[0]);
  const { price, mrp } = unitPricingFor(product, key);
  ok("price and mrp both come from the variant", price === 999 && mrp === 1200, `${price}/${mrp}`);
  ok(
    "the discount derived from the pair is not negative",
    mrp >= price,
    `mrp=${mrp} price=${price}`,
  );

  // The exact rule ProductDetail.jsx uses, replicated: the number the shopper is
  // shown must be the number prepareOrderData charges.
  const displayPrice = product.variants[0].price ? product.variants[0].price : product.price;
  const charged = (await priceOrder(product, "Hardcover")).orderItems[0].price;
  ok(
    "the storefront's displayed price equals the charged price",
    displayPrice === charged,
    `displayed=${displayPrice} charged=${charged}`,
  );
}

section("a variant price of 0 or null falls back rather than giving the book away");

{
  const product = await makeProduct([
    variant("Unpriced", { price: null }),
    variant("Zeroed", { price: 0 }),
  ]);
  ok(
    "price null falls back to the product price",
    (await priceOrder(product, "Unpriced")).subtotal === 299,
    String((await priceOrder(product, "Unpriced")).subtotal),
  );
  ok(
    "price 0 falls back rather than selling for nothing",
    (await priceOrder(product, "Zeroed")).subtotal === 299,
    String((await priceOrder(product, "Zeroed")).subtotal),
  );
}

section("the helpers themselves");

{
  ok("effectiveUnitPrice prefers the variant", effectiveUnitPrice({ price: 10 }, { price: 20 }) === 20);
  ok("effectiveUnitPrice falls back on null", effectiveUnitPrice({ price: 10 }, { price: null }) === 10);
  ok("effectiveUnitPrice falls back with no variant", effectiveUnitPrice({ price: 10 }, null) === 10);
  ok("effectiveUnitPrice falls back on a negative", effectiveUnitPrice({ price: 10 }, { price: -5 }) === 10);
  ok("effectiveUnitPrice falls back on NaN", effectiveUnitPrice({ price: 10 }, { price: "abc" }) === 10);
  ok("effectiveUnitMrp prefers the variant", effectiveUnitMrp({ mrp: 10 }, { mrp: 20 }) === 20);
  ok("effectiveUnitMrp falls back on null", effectiveUnitMrp({ mrp: 10 }, { mrp: null }) === 10);
}

// ---------------------------------------------------------------- cleanup

await ProductModel.deleteMany({ _id: { $in: trash } });
const leftovers = await ProductModel.countDocuments({ name: new RegExp(MARKER) });
ok("every fixture this suite created is gone", leftovers === 0, `leftovers=${leftovers}`);

const summary = finish();
await mongoose.disconnect();
process.exit(summary.failed > 0 ? 1 : 0);
