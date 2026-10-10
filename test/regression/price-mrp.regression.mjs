/**
 * A selling price must never exceed the product's MRP.
 *
 * MRP is the *maximum* retail price. Nothing enforced the relationship, so a product could be
 * saved at ₹500 against an MRP of ₹300 — and one in the live catalogue was. The storefront
 * derives its discount badge as (mrp - price) / mrp, which then goes negative; every display
 * surface happens to guard against that (ProductCard hides the badge when mrp <= price, the
 * cart clamps savings with Math.max), so the visible symptom was a silently missing discount
 * rather than an obviously wrong one. The data was still wrong either way.
 *
 * The case worth the most care is a ONE-SIDED update: raising the price without mentioning
 * MRP, or lowering MRP without mentioning price. Comparing only the two numbers in the request
 * lets both through, because one of them isn't there. The gate therefore compares the values
 * the product will actually be saved with.
 *
 * Run with `npm run test:price-mrp` (or `npm test` for everything).
 */
process.env.NOTIFICATIONS_ENABLED = "false";
process.env.SHIPROCKET_ENABLED = "false";

import mongoose from "mongoose";
import { connect, createSuite, marker, productFixture } from "./helpers.mjs";

const { ok, section, finish } = createSuite("price-mrp");
await connect();

const ProductModel = (await import("../../src/modules/products/Product.model.js")).default;
const { findUnsupportedVariantFormat } = await import(
  "../../src/modules/products/product-query.service.js"
);
const productController = await import("../../src/modules/products/product.controller.js");

const MARKER = marker("pricemrp");
const trash = [];
let seq = 0;

const callController = async (handler, { body = {}, params = {}, user, file } = {}) => {
  let statusCode = 200;
  let payload;
  const res = {
    status(code) { statusCode = code; return this; },
    json(data) { payload = data; return this; },
  };
  await handler({ body, params, query: {}, user, file }, res);
  return { statusCode, body: payload };
};

const makeProduct = async (price, mrp) => {
  seq += 1;
  const product = await ProductModel.create(
    productFixture(`${MARKER}-${seq}`, { stock: 10, price, mrp }),
  );
  trash.push(product._id);
  return product;
};

const update = (id, body) =>
  callController(productController.UpdateProduct, {
    params: { id: String(id) },
    user: { id: String(new mongoose.Types.ObjectId()), role: "admin" },
    body,
  });

// ================================================================

section("a price above MRP is refused on update");

{
  const product = await makeProduct(300, 500);
  const result = await update(product._id, { price: "900", mrp: "500" });
  ok(
    "₹900 against an MRP of ₹500 is refused with PRICE_ABOVE_MRP",
    result.statusCode === 400 && result.body?.code === "PRICE_ABOVE_MRP",
    `${result.statusCode} ${JSON.stringify(result.body?.code)}`,
  );
  ok(
    "the message names both numbers so the admin can see which to change",
    /900/.test(result.body?.message || "") && /500/.test(result.body?.message || ""),
    result.body?.message,
  );
  const stored = await ProductModel.findById(product._id).lean();
  ok(
    "and nothing was written — the refusal happens before save",
    stored.price === 300 && stored.mrp === 500,
    `price=${stored.price} mrp=${stored.mrp}`,
  );
}

section("a ONE-SIDED update cannot sneak past the check");

{
  // Only the price is sent. The request contains no MRP to compare against, so a check that
  // looked at the incoming pair alone would see nothing wrong.
  const product = await makeProduct(300, 500);
  const result = await update(product._id, { price: "800" });
  ok(
    "raising only the price is compared against the STORED MRP",
    result.statusCode === 400 && result.body?.code === "PRICE_ABOVE_MRP",
    `${result.statusCode} ${JSON.stringify(result.body?.code)}`,
  );
  const stored = await ProductModel.findById(product._id).lean();
  ok("the stored price is unchanged", stored.price === 300, String(stored.price));
}

{
  // The mirror image: drop the MRP below a price that is not mentioned.
  const product = await makeProduct(400, 500);
  const result = await update(product._id, { mrp: "200" });
  ok(
    "lowering only the MRP is compared against the STORED price",
    result.statusCode === 400 && result.body?.code === "PRICE_ABOVE_MRP",
    `${result.statusCode} ${JSON.stringify(result.body?.code)}`,
  );
  const stored = await ProductModel.findById(product._id).lean();
  ok("the stored MRP is unchanged", stored.mrp === 500, String(stored.mrp));
}

section("legitimate pricing still saves");

{
  const product = await makeProduct(500, 500);
  const discounted = await update(product._id, { price: "399", mrp: "500" });
  ok("a genuine discount is accepted", discounted.statusCode === 200, String(discounted.statusCode));

  const atMrp = await update(product._id, { price: "500", mrp: "500" });
  ok(
    "price EQUAL to MRP is allowed — that is simply no discount",
    atMrp.statusCode === 200,
    String(atMrp.statusCode),
  );
  const stored = await ProductModel.findById(product._id).lean();
  ok("the accepted values were persisted", stored.price === 500 && stored.mrp === 500,
    `price=${stored.price} mrp=${stored.mrp}`);
}

{
  // An edit that never mentions pricing must not be held hostage by it. This matters because
  // one product in the live catalogue already violates the rule: refusing every unrelated
  // edit to such a row would make it unfixable through anything but a pricing change.
  const product = await makeProduct(300, 500);
  const result = await update(product._id, { description: "A description edit only." });
  ok(
    "an edit that touches neither price nor MRP is not asked about pricing",
    result.statusCode === 200,
    `${result.statusCode} ${JSON.stringify(result.body?.message)}`,
  );
}

section("per-variant pricing obeys the same rule");

{
  const optionGroup = [
    { name: "Size", options: [{ name: "M", price: 900, mrp: 500, stock: 3 }] },
  ];
  const problem = findUnsupportedVariantFormat(optionGroup);
  ok(
    "an option priced above its own MRP is refused",
    typeof problem === "string" && /above its MRP/.test(problem),
    String(problem),
  );
  ok("the message names the offending option", /"M"/.test(problem || ""), String(problem));
}

{
  const canonical = [
    { name: "M", attributes: { Size: "M" }, price: 900, mrp: 500, stock: 3 },
  ];
  ok(
    "the per-combination payload shape is checked too, not just option groups",
    /above its MRP/.test(String(findUnsupportedVariantFormat(canonical))),
    String(findUnsupportedVariantFormat(canonical)),
  );
}

{
  ok(
    "a variant at or below its MRP is fine",
    findUnsupportedVariantFormat([
      { name: "Size", options: [{ name: "M", price: 400, mrp: 500, stock: 3 }] },
    ]) === null,
  );
}

section("a variant with no MRP of its own is checked against the PRODUCT's MRP");

{
  // The hole this closes. A blank variant MRP does not mean "unchecked": the product page
  // displays such a size against the product's MRP —
  //   const displayMrp = selectedSizeOpt?.mrp ? selectedSizeOpt.mrp : product.mrp
  // — so a ₹900 size under a ₹500 product MRP is shown as ₹900 against ₹500, which is the
  // very thing the product-level gate exists to prevent, reached by another route.
  const sizeWithNoMrp = (price) => [
    { name: "Size", options: [{ name: "M", price, mrp: "", stock: 3 }] },
  ];

  const refused = findUnsupportedVariantFormat(sizeWithNoMrp(900), 500);
  ok(
    "₹900 with no variant MRP under a ₹500 product MRP is refused",
    typeof refused === "string" && /above the product's MRP/.test(refused),
    String(refused),
  );
  ok(
    "and the message says it is the PRODUCT's MRP, not the variant's",
    /product's MRP \(₹500\)/.test(refused || ""),
    String(refused),
  );
  ok(
    "the same size at ₹400 is accepted — inheriting the MRP is still allowed",
    findUnsupportedVariantFormat(sizeWithNoMrp(400), 500) === null,
    String(findUnsupportedVariantFormat(sizeWithNoMrp(400), 500)),
  );
  ok(
    "equal to the product's MRP is allowed",
    findUnsupportedVariantFormat(sizeWithNoMrp(500), 500) === null,
  );
  // Callers that genuinely have no product MRP to offer must not start failing.
  ok(
    "with no product MRP known, a variant lacking its own MRP is not refused",
    findUnsupportedVariantFormat(sizeWithNoMrp(900), undefined) === null,
  );
  // A variant's OWN mrp still wins over the product's, in both directions.
  ok(
    "an explicit variant MRP takes precedence over the product's",
    findUnsupportedVariantFormat(
      [{ name: "Size", options: [{ name: "M", price: 700, mrp: 900, stock: 3 }] }],
      500,
    ) === null,
  );
}

section("the update endpoint applies the product's MRP to variants");

{
  const product = await makeProduct(300, 500);
  const result = await update(product._id, {
    variants: JSON.stringify([
      { name: "Size", options: [{ name: "M", price: 900, mrp: "", stock: 3 }] },
    ]),
  });
  ok(
    "a size priced above the STORED product MRP is refused on update",
    result.statusCode === 400 && result.body?.code === "UNSUPPORTED_VARIANT_FORMAT",
    `${result.statusCode} ${JSON.stringify(result.body?.message)}`,
  );
  const stored = await ProductModel.findById(product._id).lean();
  ok("and no variant was written", (stored.variants || []).length === 0,
    String((stored.variants || []).length));
}

{
  // Raising the product's MRP in the SAME request must be what the variant is judged against,
  // otherwise "sell this size for ₹900 and raise the MRP to ₹1000" would be refused wrongly.
  const product = await makeProduct(300, 500);
  const result = await update(product._id, {
    mrp: "1000",
    variants: JSON.stringify([
      { name: "Size", options: [{ name: "M", price: 900, mrp: "", stock: 3 }] },
    ]),
  });
  ok(
    "an MRP raised in the same request is the one applied",
    result.statusCode === 200,
    `${result.statusCode} ${JSON.stringify(result.body?.message)}`,
  );
  const stored = await ProductModel.findById(product._id).lean();
  ok("the variant was stored", (stored.variants || []).length === 1,
    String((stored.variants || []).length));
}

// ---------------------------------------------------------------- cleanup

await ProductModel.deleteMany({ _id: { $in: trash } });
const leftovers = await ProductModel.countDocuments({ name: new RegExp(MARKER) });
ok("every fixture this suite created is gone", leftovers === 0, `leftovers=${leftovers}`);

const summary = finish();
await mongoose.disconnect();
process.exit(summary.failed > 0 ? 1 : 0);
