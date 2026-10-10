import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSeoFields,
  normalizeMetaKeywords,
  slugify,
} from "../../src/modules/products/product-seo.service.js";

test("keywords accept the comma-separated string the admin form sends", () => {
  assert.deepEqual(normalizeMetaKeywords("gemstone, rudraksha , yantra"), [
    "gemstone",
    "rudraksha",
    "yantra",
  ]);
});

test("keywords accept an array from the API or a bulk import", () => {
  assert.deepEqual(normalizeMetaKeywords(["gemstone", " yantra "]), ["gemstone", "yantra"]);
});

test("keywords drop blanks and de-duplicate case-insensitively", () => {
  assert.deepEqual(normalizeMetaKeywords("Gem, , gem,  GEM , coral"), ["Gem", "coral"]);
});

test("keywords are empty for every falsy input shape", () => {
  for (const input of [undefined, null, "", []]) {
    assert.deepEqual(normalizeMetaKeywords(input), [], `failed for ${JSON.stringify(input)}`);
  }
});

test("slugify produces a URL-safe segment", () => {
  assert.equal(slugify("Pure Red Coral (Moonga) 7ct"), "pure-red-coral-moonga-7ct");
  assert.equal(slugify("  Multiple   Spaces  "), "multiple-spaces");
  assert.equal(slugify("!!!"), "");
});

test("only the keys present in the request are returned", () => {
  const fields = buildSeoFields({ metaTitle: "Buy Coral" });

  assert.deepEqual(Object.keys(fields), ["metaTitle"]);
  assert.equal(fields.metaTitle, "Buy Coral");
});

test("an update that omits the SEO block does not blank existing metadata", () => {
  assert.deepEqual(buildSeoFields({}), {});
  assert.deepEqual(buildSeoFields(), {});
});

test("meta title and description are trimmed and length-capped", () => {
  const fields = buildSeoFields({
    metaTitle: `  ${"t".repeat(200)}  `,
    metaDescription: "line one\n\n   line two",
  });

  assert.equal(fields.metaTitle.length, 160);
  assert.equal(fields.metaDescription, "line one line two", "whitespace is collapsed");
});

test("an explicitly emptied field is stored as empty, not skipped", () => {
  const fields = buildSeoFields({ metaTitle: "", metaKeywords: "" });

  assert.equal(fields.metaTitle, "");
  assert.deepEqual(fields.metaKeywords, []);
});

test("slug falls back to the name on create", () => {
  const fields = buildSeoFields({ name: "Red Coral Ring" });

  assert.equal(fields.slug, "red-coral-ring");
});

test("an explicit slug wins over the name", () => {
  const fields = buildSeoFields({ name: "Red Coral Ring", slug: "Coral-SPECIAL Edition" });

  assert.equal(fields.slug, "coral-special-edition");
});

test("updating without a name or slug leaves the stored slug alone", () => {
  const fields = buildSeoFields({ metaTitle: "New title" });

  assert.equal("slug" in fields, false);
});
