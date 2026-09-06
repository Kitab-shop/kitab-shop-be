/**
 * The catalogue list and the search ranking both had to hold a few thousand books.
 *
 * Two separate problems, both invisible at the 170-product catalogue they were
 * written against:
 *
 * 1. GET /all-product was an unbounded find().populate(), and the storefront
 *    dispatches it on app boot — so every visitor rebuilt and re-serialised the
 *    entire catalogue. At a few thousand products that is megabytes of JSON per
 *    first page load, on a single vCPU. It is now built once and handed out by
 *    ETag until a product changes.
 *
 * 2. Both search ranking paths scored in JavaScript over whole documents, so
 *    they capped their candidate sets (1000 for relevance, 300 for fuzzy). The
 *    caps were silent: past them the results and the reported `total` were both
 *    wrong, so page numbers lied. Ranking now runs on a projection over the full
 *    match set, and only the returned page is hydrated.
 *
 * What is worth asserting is (a) that the cache actually caches and actually
 * invalidates, and (b) that hydrating a ranked page still returns COMPLETE
 * documents in the RANKED order — the reorder is hand-rolled because $in does
 * not preserve the order it is given.
 *
 * Run with `npm run test:catalogue-scale` (or `npm test` for everything).
 */
process.env.NOTIFICATIONS_ENABLED = "false";
process.env.SHIPROCKET_ENABLED = "false";

import mongoose from "mongoose";
import { connect, createSuite, marker, productFixture } from "./helpers.mjs";

const { ok, section, finish } = createSuite("catalogue-scale");
await connect();

const ProductModel = (await import("../src/modules/products/Product.model.js")).default;
// Registers the Category schema on the connection: every read here populates
// category_id, and mongoose resolves that by model name at query time.
await import("../src/modules/categories/Category.model.js");
const { GetAllProduct, SearchProducts, invalidateCatalogueCache } = await import(
  "../src/modules/products/product.controller.js"
);

const MARKER = marker("catscale");
const trash = [];

/** Captures everything GetAllProduct can send, not just res.json(). */
const callController = async (handler, { query = {}, headers = {} } = {}) => {
  let statusCode = 200;
  let payload;
  let raw;
  const responseHeaders = {};
  const res = {
    status(code) { statusCode = code; return this; },
    json(data) { payload = data; return this; },
    set(name, value) { responseHeaders[name.toLowerCase()] = value; return this; },
    type() { return this; },
    send(body) { raw = body; return this; },
    end() { return this; },
  };
  await handler({ query, headers, params: {}, body: {} }, res);
  return { statusCode, body: payload, raw, headers: responseHeaders };
};

const makeProduct = (name, overrides = {}) =>
  ProductModel.create(productFixture(name, overrides)).then((product) => {
    trash.push(product._id);
    return product;
  });

try {
  // ---------------------------------------------------------------------------
  section("GET /all-product is served from one build, not rebuilt per visitor");

  invalidateCatalogueCache();
  const seeded = await makeProduct(`${MARKER} Cached Catalogue Title`);

  const first = await callController(GetAllProduct);
  ok("first call answers 200 with a serialised body", first.statusCode === 200 && typeof first.raw === "string");
  ok("first call sets an ETag", Boolean(first.headers.etag));
  ok(
    "first call sets Cache-Control: no-cache so a CDN revalidates",
    first.headers["cache-control"] === "no-cache",
  );
  ok(
    "the seeded product is in the payload",
    (first.raw || "").includes(`${MARKER} Cached Catalogue Title`),
  );

  // Rename behind the controller's back. A rebuild would pick this up; the cache
  // must not, or it was never a cache.
  await ProductModel.updateOne(
    { _id: seeded._id },
    { $set: { name: `${MARKER} Renamed Behind The Cache` } },
  );

  const second = await callController(GetAllProduct);
  ok("a second call returns the identical body (no re-query, no re-serialise)", second.raw === first.raw);
  ok("the ETag is unchanged", second.headers.etag === first.headers.etag);
  ok(
    "the out-of-band rename is NOT visible while cached",
    !(second.raw || "").includes("Renamed Behind The Cache"),
  );

  section("A matching If-None-Match costs a 304 instead of the whole catalogue");

  const conditional = await callController(GetAllProduct, {
    headers: { "if-none-match": first.headers.etag },
  });
  ok("conditional request answers 304", conditional.statusCode === 304);
  ok("conditional request sends no body", conditional.raw === undefined);

  const staleConditional = await callController(GetAllProduct, {
    headers: { "if-none-match": 'W/"not-the-current-etag"' },
  });
  ok("a stale If-None-Match still gets the full body", staleConditional.statusCode === 200);

  section("Invalidation makes an edit visible immediately");

  invalidateCatalogueCache();
  const rebuilt = await callController(GetAllProduct);
  ok(
    "after invalidation the rename appears",
    (rebuilt.raw || "").includes("Renamed Behind The Cache"),
  );
  ok("the rebuilt payload carries a different ETag", rebuilt.headers.etag !== first.headers.etag);

  // ---------------------------------------------------------------------------
  section("Relevance ranking reports an exact total and paginates honestly");

  // Distinct enough that nothing in the real catalogue can match it.
  const TERM = `zzq${MARKER}`;
  // Ranking tiers: an exact name match must beat a prefix match, which must beat
  // a word-boundary match, which must beat a brand-only match.
  await makeProduct(TERM);
  await makeProduct(`${TERM} Prefixed Edition`);
  await makeProduct(`A Book About ${TERM} Itself`);
  await makeProduct("Unrelated Title", { brand: TERM });

  const page1 = await callController(SearchProducts, { query: { q: TERM, limit: "2" } });
  ok("search answers 200", page1.statusCode === 200);
  ok(
    "total counts every match, not a capped candidate set",
    page1.body?.pagination?.total === 4,
    `got ${page1.body?.pagination?.total}`,
  );
  ok("totalPages is derived from the real total", page1.body?.pagination?.totalPages === 2);
  ok("page 1 honours the limit", page1.body?.data?.length === 2);
  ok(
    "the exact name match ranks first",
    page1.body?.data?.[0]?.name === TERM,
    `got ${page1.body?.data?.[0]?.name}`,
  );
  ok(
    "the prefix match ranks second",
    page1.body?.data?.[1]?.name === `${TERM} Prefixed Edition`,
    `got ${page1.body?.data?.[1]?.name}`,
  );

  const page2 = await callController(SearchProducts, {
    query: { q: TERM, limit: "2", page: "2" },
  });
  ok("page 2 returns the remaining matches", page2.body?.data?.length === 2);
  const page1Ids = (page1.body?.data || []).map((product) => String(product._id));
  const page2Ids = (page2.body?.data || []).map((product) => String(product._id));
  ok(
    "the two pages are disjoint",
    page2Ids.every((id) => !page1Ids.includes(id)),
  );
  ok(
    "the brand-only match ranks last, on the final page",
    page2.body?.data?.[1]?.brand === TERM && page2.body?.data?.[1]?.name === "Unrelated Title",
  );

  section("A ranked page is hydrated into COMPLETE documents");

  // The ranking projection carries only the scored text fields. If the hydration
  // step regressed, search results would quietly lose everything else — the
  // images and prices the storefront renders from.
  const hydrated = page1.body?.data?.[0];
  ok("hydrated result carries its image", hydrated?.image === "fixture.png");
  ok("hydrated result carries its price", hydrated?.price === 500);
  ok("hydrated result carries its stock", hydrated?.stock === 10);
  ok(
    "hydrated result carries fields absent from the ranking projection",
    Object.hasOwn(hydrated ?? {}, "variants"),
  );

  // ---------------------------------------------------------------------------
  section("Fuzzy fallback still resolves a typo, and hydrates it too");

  // Deliberately hyphen-free: fuzzyScore splits candidate names on "-" before
  // scoring, so a name carrying the "catscale-<pid>" marker would be compared as
  // two short words and the distance below would not be the one under test.
  const fuzzyName = `Qwyxlbrn${process.pid}`;
  await makeProduct(fuzzyName);
  // A single transposition — Levenshtein distance 2, inside fuzzyScore's
  // threshold — and no substring a regex could match, so only the fuzzy path
  // can find it.
  const typo = `Qwyxlbnr${process.pid}`;

  const fuzzy = await callController(SearchProducts, { query: { q: typo } });
  ok("the typo is reported as having used the fuzzy path", fuzzy.body?.meta?.usedFuzzy === true);
  ok(
    "the fuzzy match is found",
    (fuzzy.body?.data || []).some((product) => product.name === fuzzyName),
    `got ${(fuzzy.body?.data || []).map((p) => p.name).join(", ") || "nothing"}`,
  );
  const fuzzyHit = (fuzzy.body?.data || []).find((product) => product.name === fuzzyName);
  ok("the fuzzy match is a complete document, not a projection", fuzzyHit?.image === "fixture.png");
} finally {
  if (trash.length > 0) await ProductModel.deleteMany({ _id: { $in: trash } });
  invalidateCatalogueCache();
  await mongoose.disconnect();
}

const { failed } = finish();
process.exit(failed > 0 ? 1 : 0);
