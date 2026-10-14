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
 * And the export → edit → re-import round trip the admin guide describes:
 *
 * 5. Export wrote bestseller as the text "false" and import read it with
 *    Boolean(), so every re-imported product became a bestseller.
 * 6. Import ignored the id column and always created, so re-importing an export
 *    duplicated the catalogue. A row with an id now updates that product, and a
 *    blank cell in it means "leave as it is".
 * 7. Export had no authorBio column, so a round trip lost every bio.
 * 8. Pictures are uploaded as files before the import; a dry run validates the
 *    sheet first so a bad file never leaves orphaned pictures behind.
 *
 * Run with `npm run test:bulk-products` (or `npm test` for everything).
 */
process.env.NOTIFICATIONS_ENABLED = "false";
process.env.SHIPROCKET_ENABLED = "false";

import { existsSync } from "node:fs";
import mongoose from "mongoose";
import sharp from "sharp";
import { connect, createSuite, marker } from "./helpers.mjs";

const { ok, section, finish } = createSuite("bulk-products");
await connect();

const ProductModel = (await import("../../src/modules/products/Product.model.js")).default;
const CategoryModel = (await import("../../src/modules/categories/Category.model.js")).default;
const { BulkImportProducts, BulkUpdateProducts, ExportProducts, UploadBulkProductImages } = await import(
  "../../src/modules/admin/admin.controller.js"
);
const { deleteImageAsset } = await import("../../src/utils/image-upload.js");
const { resolveStoragePath } = await import("../../src/config/storage.config.js");

const MARKER = marker("bulkprod");
const trash = [];
const trashImages = [];
const adminId = new mongoose.Types.ObjectId();

const call = async (handler, body, extra = {}) => {
  let statusCode = 200;
  let payload;
  let sent;
  const res = {
    status(code) { statusCode = code; return this; },
    json(data) { payload = data; return this; },
    setHeader() {},
    send(data) { sent = data; return this; },
  };
  await handler({ body, params: {}, query: {}, headers: {}, user: { id: adminId }, ...extra }, res);
  return { statusCode, body: payload, sent };
};

// Minimal CSV reader for the export (quoted fields, embedded commas/newlines) —
// the same rules as the admin page's parseCsv.
const parseCsv = (text) => {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { cell += '"'; i += 1; }
      else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") { row.push(cell); cell = ""; }
    else if (char === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += char;
  }
  row.push(cell);
  rows.push(row);
  const [headers, ...body] = rows;
  return body.map((cells) => Object.fromEntries(headers.map((h, i) => [h, cells[i] ?? ""])));
};

const exportedRowFor = async (name) => {
  const out = await call(ExportProducts, {});
  return parseCsv(out.sent).find((r) => r.name === name);
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

  // ═══ bestseller text ══════════════════════════════════════════════════════
  section('A bestseller cell of "false" stays false');
  out = await call(BulkImportProducts, {
    products: [row({ name: `${MARKER} Not Best`, category_id: String(category._id), bestseller: "false" })],
  });
  const notBest = await ProductModel.findOne({ name: `${MARKER} Not Best` }).lean();
  ok("imported", out.statusCode === 201, `${out.statusCode}: ${out.body?.message}`);
  ok("bestseller is false", notBest?.bestseller === false, notBest?.bestseller);

  // ═══ image links ══════════════════════════════════════════════════════════
  section("Only https:// picture links (or our own /uploads paths) are accepted");
  out = await call(BulkImportProducts, {
    products: [row({ name: `${MARKER} Http`, category_id: String(category._id), image: "http://example.test/c.jpg" })],
  });
  ok("an http:// link is refused", out.statusCode === 400 && out.body?.errors?.[0]?.fields?.includes("image"), out.body?.errors);
  out = await call(BulkImportProducts, {
    products: [row({ name: `${MARKER} Bare Name`, category_id: String(category._id), image: "cover.jpg" })],
  });
  ok("a bare file name is refused outside a dry run", out.statusCode === 400, out.statusCode);

  // ═══ export → re-import round trip ════════════════════════════════════════
  section("Export → edit → re-import updates in place instead of duplicating");
  const roundTrip = await ProductModel.create({
    category_id: category._id,
    name: `${MARKER} Round Trip`,
    description: "line one\nline two, with a comma",
    image: "https://example.test/rt.jpg",
    brand: "Fixture Press",
    producthightlight: "fixture",
    authorBio: "A bio that must survive",
    price: 300,
    mrp: 500,
    stock: 4,
    bestseller: false,
  });
  trash.push(roundTrip._id);

  const exported = await exportedRowFor(`${MARKER} Round Trip`);
  ok("export carries an authorBio column", exported?.authorBio === "A bio that must survive", exported?.authorBio);
  ok("export carries the id", exported?.id === String(roundTrip._id), exported?.id);

  out = await call(BulkImportProducts, { products: [{ ...exported, price: "350" }] });
  ok("re-import succeeds", out.statusCode === 200 && out.body?.success, `${out.statusCode}: ${out.body?.message}`);
  ok("reported as one update, nothing created", out.body?.updated === 1 && out.body?.created === 0, out.body);
  const copies = await ProductModel.find({ name: `${MARKER} Round Trip` }).lean();
  ok("still exactly one product", copies.length === 1, copies.length);
  ok("the edited price applied", copies[0]?.price === 350, copies[0]?.price);
  ok("bestseller still false", copies[0]?.bestseller === false, copies[0]?.bestseller);
  ok("bio kept", copies[0]?.authorBio === "A bio that must survive", copies[0]?.authorBio);
  ok("multi-line description kept", copies[0]?.description === roundTrip.description);

  // A fresh export, so the row matches what is stored now.
  out = await call(BulkImportProducts, { products: [await exportedRowFor(`${MARKER} Round Trip`)] });
  ok(
    "re-importing an unedited row changes nothing",
    out.body?.updated === 0 && out.body?.unchanged === 1,
    JSON.stringify({ updated: out.body?.updated, unchanged: out.body?.unchanged }),
  );

  section("In an update row, a blank cell leaves the field as it is");
  out = await call(BulkImportProducts, {
    products: [{ id: String(roundTrip._id), name: "", description: "", price: "", stock: "9", authorBio: "" }],
  });
  const afterSparse = await ProductModel.findById(roundTrip._id).lean();
  ok("the filled cell applied", afterSparse.stock === 9, afterSparse.stock);
  ok("blank name kept", afterSparse.name === `${MARKER} Round Trip`, afterSparse.name);
  ok("blank price kept", afterSparse.price === 350, afterSparse.price);
  ok("blank bio kept", afterSparse.authorBio === "A bio that must survive", afterSparse.authorBio);

  section("An update row is held to the same price/MRP rule");
  out = await call(BulkImportProducts, { products: [{ id: String(roundTrip._id), price: "900" }] });
  ok("price above the stored MRP is refused", out.statusCode === 400, out.statusCode);
  ok("with a reason", /above mrp/i.test(out.body?.errors?.[0]?.message || ""), out.body?.errors);

  section("Bad ids are refused and nothing is written");
  const ghost = new mongoose.Types.ObjectId();
  out = await call(BulkImportProducts, {
    products: [
      row({ name: `${MARKER} Alongside Ghost`, category_id: String(category._id) }),
      { id: String(ghost), price: "10" },
      { id: String(roundTrip._id), price: "320" },
      { id: String(roundTrip._id), price: "330" },
    ],
  });
  ok("the file is refused", out.statusCode === 400, out.statusCode);
  ok("unknown id reported on its row", out.body?.errors?.some((e) => e.row === 3 && /does not match/.test(e.message)), out.body?.errors);
  ok("duplicate id reported on its row", out.body?.errors?.some((e) => e.row === 5 && /more than once/.test(e.message)), out.body?.errors);
  ok("the valid new row was not created", (await ProductModel.countDocuments({ name: `${MARKER} Alongside Ghost` })) === 0);
  ok("the valid update was not applied", (await ProductModel.findById(roundTrip._id).lean()).price === 350);

  // ═══ variant-stocked products ═════════════════════════════════════════════
  section("Variant-stocked products: the exported total round-trips, a new total is refused");
  const variantProduct = await ProductModel.create({
    category_id: category._id,
    name: `${MARKER} Variants`,
    description: "bulk fixture",
    image: "https://example.test/v.jpg",
    brand: "Fixture Press",
    producthightlight: "fixture",
    price: 100,
    mrp: 200,
    stock: 7,
    variants: [
      { name: "Paperback", attributes: { format: "Paperback" }, stock: 5, active: true },
      { name: "Hardcover", attributes: { format: "Hardcover" }, stock: 2, active: true },
    ],
  });
  trash.push(variantProduct._id);
  const variantRow = await exportedRowFor(`${MARKER} Variants`);
  out = await call(BulkImportProducts, { products: [variantRow] });
  ok("the same total is accepted", out.statusCode === 200, `${out.statusCode}: ${out.body?.message}`);
  out = await call(BulkImportProducts, { products: [{ ...variantRow, stock: "50" }] });
  ok("a different total is refused", out.statusCode === 400 && /variant/i.test(out.body?.errors?.[0]?.message || ""), out.body?.errors);

  // ═══ dry run + picture upload ═════════════════════════════════════════════
  section("A dry run validates the sheet and writes nothing");
  const dryRows = [
    row({ name: `${MARKER} Dry New`, category_id: String(category._id), image: "Dry-Cover.JPG" }),
    { id: String(roundTrip._id), price: "360" },
  ];
  out = await call(BulkImportProducts, { products: dryRows, dryRun: true, uploadNames: ["dry-cover.jpg"] });
  ok("passes, matching the picture name case-insensitively", out.statusCode === 200 && out.body?.dryRun, `${out.statusCode}: ${out.body?.message}`);
  ok("reports what it would do", out.body?.toCreate === 1 && out.body?.toUpdate === 1, out.body);
  ok("nothing created", (await ProductModel.countDocuments({ name: `${MARKER} Dry New` })) === 0);
  ok("nothing updated", (await ProductModel.findById(roundTrip._id).lean()).price === 350);
  out = await call(BulkImportProducts, { products: dryRows, dryRun: true, uploadNames: ["other.jpg"] });
  ok("a picture that was not selected fails the dry run", out.statusCode === 400 && out.body?.errors?.[0]?.fields?.includes("image"), out.body?.errors);

  section("Uploaded pictures are stored like a single-product upload");
  const png = await sharp({ create: { width: 40, height: 60, channels: 3, background: "#884422" } }).png().toBuffer();
  out = await call(UploadBulkProductImages, {}, {
    files: [{ originalname: "Dry-Cover.JPG", mimetype: "image/png", buffer: png, size: png.length }],
  });
  const uploaded = out.body?.images?.[0];
  if (uploaded?.image) trashImages.push(uploaded.image);
  ok("upload succeeds", out.statusCode === 201, `${out.statusCode}: ${out.body?.message}`);
  ok("returns a /uploads/products path", /^\/uploads\/products\/.+\.webp$/.test(uploaded?.image || ""), uploaded?.image);
  ok("the file exists on disk", Boolean(uploaded?.image) && existsSync(resolveStoragePath(uploaded.image)));
  out = await call(UploadBulkProductImages, {}, {
    files: [{ originalname: "broken.jpg", mimetype: "image/jpeg", buffer: Buffer.from("not a picture"), size: 13 }],
  });
  ok("an unreadable picture gets a plain message", out.statusCode === 400 && /could not be read/.test(out.body?.message || ""), out.body?.message);

  section("The real import then uses the stored paths");
  out = await call(BulkImportProducts, {
    products: [{ ...dryRows[0], image: uploaded?.image }, { id: String(roundTrip._id), image: uploaded?.image }],
  });
  ok("import succeeds", out.statusCode === 201, `${out.statusCode}: ${out.body?.message}`);
  const dryNew = await ProductModel.findOne({ name: `${MARKER} Dry New` }).lean();
  ok("new product has the picture", dryNew?.image === uploaded?.image, dryNew?.image);
  const recovered = await ProductModel.findById(roundTrip._id).lean();
  ok("updated product's cover replaced", recovered.image === uploaded?.image, recovered.image);
  ok("and it leads the gallery", recovered.images?.[0] === uploaded?.image, recovered.images);
} finally {
  for (const stored of trashImages) await deleteImageAsset(stored);
  if (trash.length > 0) await ProductModel.deleteMany({ _id: { $in: trash } });
  await ProductModel.deleteMany({ name: new RegExp(MARKER) });
  if (category) await CategoryModel.deleteOne({ _id: category._id });
  await mongoose.disconnect();
}

const { failed } = finish();
process.exit(failed > 0 ? 1 : 0);
