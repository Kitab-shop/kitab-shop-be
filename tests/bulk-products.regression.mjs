/**
 * Bulk product import and update had to enforce the same rules the single-product
 * endpoints do, and had to stop dropping a column the UI said it supported.
 *
 * Four separate failures, all invisible from the admin panel:
 *
 * 1. authorBio was listed in the bulk template AND in the on-screen field guide,
 *    but normalizeBulkProduct never read it. Every imported bio was discarded
 *    while the UI claimed the column worked.
 * 2. price > mrp was refused by CreateProduct and by UpdateProduct, but not by
 *    either bulk path — so bulk import was an open door to exactly the bad data
 *    the price-mrp suite exists to keep out.
 * 3. Bulk update took price and mrp as independent numbers, so a row that raised
 *    price without mentioning mrp sailed past a comparison of "the two values in
 *    the request" — the one-sided update, which is the case that actually happens.
 * 4. Imported products got no slug, because only CreateProduct called
 *    buildSeoFields.
 *
 * Run with `npm run test:bulk-products` (or `npm test` for everything).
 */
process.env.NOTIFICATIONS_ENABLED = "false";
process.env.SHIPROCKET_ENABLED = "false";

import mongoose from "mongoose";
import { connect, createSuite, marker } from "./helpers.mjs";

const { ok, section, finish } = createSuite("bulk-products");
await connect();

const ProductModel = (await import("../src/modules/products/Product.model.js")).default;
const CategoryModel = (await import("../src/modules/categories/Category.model.js")).default;
const { BulkImportProducts, BulkUpdateProducts } = await import(
  "../src/modules/admin/admin.controller.js"
);

const MARKER = marker("bulkprod");
const trash = [];
const adminId = new mongoose.Types.ObjectId();

const call = async (handler, body) => {
  let statusCode = 200;
  let payload;
  const res = {
    status(code) { statusCode = code; return this; },
    json(data) { payload = data; return this; },
  };
  await handler({ body, params: {}, query: {}, headers: {}, user: { id: adminId } }, res);
  return { statusCode, body: payload };
};

const row = (overrides = {}) => ({
  name: `${MARKER} Row`,
  description: "bulk fixture",
  price: 400,
  mrp: 600,
  brand: "Fixture Press",
  stock: 5,
  producthightlight: "fixture",
  image: "https://example.test/cover.jpg",
  ...overrides,
});

let category;
try {
  category = await CategoryModel.create({
    name: `${MARKER} Category`,
    tagline: "bulk fixture",
    image: "fixture.png",
  });

  // ═══ authorBio ════════════════════════════════════════════════════════════
  section("An imported authorBio is stored, not silently dropped");

  const BIO = "Anita Rao lives in Pune and writes about rivers.";
  let out = await call(BulkImportProducts, {
    products: [row({ name: `${MARKER} With Bio`, category_id: String(category._id), authorBio: BIO })],
  });
  ok("import succeeds", out.statusCode === 201, `${out.statusCode}: ${out.body?.message}`);
  const withBio = await ProductModel.findOne({ name: `${MARKER} With Bio` }).lean();
  if (withBio) trash.push(withBio._id);
  ok("authorBio round-trips into the document", withBio?.authorBio === BIO, withBio?.authorBio);

  section("Imported products get the slug a created one would");
  ok("slug derived from the name", Boolean(withBio?.slug), withBio?.slug);

  // ═══ price > mrp on import ════════════════════════════════════════════════
  section("Import refuses a selling price above MRP, naming the spreadsheet row");

  out = await call(BulkImportProducts, {
    products: [
      row({ name: `${MARKER} Good`, category_id: String(category._id) }),
      row({ name: `${MARKER} Overpriced`, category_id: String(category._id), price: 900, mrp: 500 }),
    ],
  });
  ok("the upload is refused", out.statusCode === 400, out.statusCode);
  ok("exactly one row is reported", out.body?.errors?.length === 1, out.body?.errors);
  // +2 because row 1 is the header and spreadsheets are 1-indexed.
  ok("the row number matches the spreadsheet", out.body?.errors?.[0]?.row === 3, out.body?.errors?.[0]?.row);
  ok(
    "the message says why",
    /above mrp/i.test(out.body?.errors?.[0]?.message || ""),
    out.body?.errors?.[0]?.message,
  );
  const leaked = await ProductModel.countDocuments({ name: `${MARKER} Good` });
  ok("nothing is imported when any row fails — it is all or nothing", leaked === 0, leaked);

  // ═══ one-sided bulk update ════════════════════════════════════════════════
  section("Bulk update compares what the product will be SAVED with");

  const target = await ProductModel.create({
    category_id: category._id,
    name: `${MARKER} Update Target`,
    description: "bulk fixture",
    image: "fixture.png",
    brand: "Fixture Press",
    producthightlight: "fixture",
    price: 300,
    mrp: 500,
    stock: 4,
  });
  trash.push(target._id);

  // Raises price past the STORED mrp without mentioning mrp at all. Comparing
  // only the numbers present in the row would let this through.
  out = await call(BulkUpdateProducts, {
    updates: [{ productId: String(target._id), price: 900, bestseller: true }],
  });
  const afterOneSided = await ProductModel.findById(target._id).lean();
  ok("the price is refused", afterOneSided.price === 300, afterOneSided.price);
  ok("and reported back, not dropped in silence", (out.body?.priceRejected || []).length === 1, out.body?.priceRejected);
  ok(
    "every other field in the same row still applies",
    afterOneSided.bestseller === true,
    afterOneSided.bestseller,
  );

  section("A legitimate bulk price change still goes through");
  out = await call(BulkUpdateProducts, {
    updates: [{ productId: String(target._id), price: 450 }],
  });
  const afterValid = await ProductModel.findById(target._id).lean();
  ok("price at or below MRP is applied", afterValid.price === 450, afterValid.price);
  ok("no rejection is reported", out.body?.priceRejected === undefined, out.body?.priceRejected);

  section("Lowering MRP below the stored price is refused too");
  out = await call(BulkUpdateProducts, {
    updates: [{ productId: String(target._id), mrp: 100 }],
  });
  const afterMrpDrop = await ProductModel.findById(target._id).lean();
  ok("the MRP is unchanged", afterMrpDrop.mrp === 500, afterMrpDrop.mrp);
  ok("the whole request is reported as applying nothing", out.statusCode === 400, out.statusCode);
} finally {
  if (trash.length > 0) await ProductModel.deleteMany({ _id: { $in: trash } });
  await ProductModel.deleteMany({ name: new RegExp(MARKER) });
  if (category) await CategoryModel.deleteOne({ _id: category._id });
  await mongoose.disconnect();
}

const { failed } = finish();
process.exit(failed > 0 ? 1 : 0);
