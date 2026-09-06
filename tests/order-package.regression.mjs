/**
 * Parcel weight and dimensions sent to Shiprocket.
 *
 * Pure logic, no database: computeOrderPackage is a function of the order and the
 * store's configured default package, and the bug it exists to prevent was in the
 * arithmetic rather than in anything persisted.
 *
 * The bug: the fallback to the store default was ALL-OR-NOTHING. A field was
 * omitted — leaving resolvePackage() to substitute the default — only when NO item
 * in the order carried data. The moment one product had a weight and another did
 * not, the sum was returned as-is and the unmeasured product contributed nothing.
 * A two-book parcel was declared at one book's weight.
 *
 * That is the expensive direction. Shiprocket weighs the parcel at pickup and bills
 * the applied weight it finds; the gap comes back as an excess-weight charge, and
 * the under-declaration being ours is what loses the dispute. Books make it worse
 * than most catalogues would: they are dense, so a missing item is a large relative
 * error, not a rounding one.
 *
 * Run with `npm run test:order-package` (or `npm test` for everything).
 */
import { createSuite } from "./helpers.mjs";

const { ok, section, finish } = createSuite("order-package");

const { computeOrderPackage, volumetricWeightKg, appliedWeightKg, VOLUMETRIC_DIVISOR } =
  await import("../src/modules/shipping/shiprocket.service.js");

// The store-wide default, as an admin would have it in Operations → Shipping.
const DEFAULTS = {
  defaultWeightKg: 0.5,
  defaultLengthCm: 10,
  defaultBreadthCm: 10,
  defaultHeightCm: 10,
};

const book = (overrides = {}) => ({
  weight: 0.4,
  length: 20,
  breadth: 13,
  height: 2,
  ...overrides,
});
const order = (...items) => ({ items });
const item = (product, quantity = 1) => ({ product, quantity });

// ─────────────────────────────────────────────────────────────────────────────
section("1 — a fully measured order is exact");

{
  const pkg = computeOrderPackage(order(item(book())), DEFAULTS);
  ok("one book weighs what the book weighs", pkg.weight === 0.4, JSON.stringify(pkg));
  ok("and takes the book's own footprint", pkg.length === 20 && pkg.breadth === 13, JSON.stringify(pkg));
  ok("with the book's height", pkg.height === 2, String(pkg.height));
  ok("nothing was guessed", pkg.unmeasuredUnits === 0, String(pkg.unmeasuredUnits));
}

{
  const pkg = computeOrderPackage(order(item(book(), 3)), DEFAULTS);
  ok("quantity multiplies weight", pkg.weight === 1.2, String(pkg.weight));
  ok("and stacks height", pkg.height === 6, String(pkg.height));
  ok("but not the footprint — they sit on top of each other", pkg.length === 20 && pkg.breadth === 13);
}

// ─────────────────────────────────────────────────────────────────────────────
section("2 — THE BUG: a partly measured order must not under-declare");

{
  const pkg = computeOrderPackage(
    order(item(book()), item(book({ weight: 0, length: 0, breadth: 0, height: 0 }))),
    DEFAULTS,
  );
  ok(
    "the unmeasured book contributes the store default, not zero",
    pkg.weight === 0.9,
    `expected 0.4 + 0.5 = 0.9, got ${pkg.weight}`,
  );
  ok(
    "it is never declared at only the measured book's weight",
    pkg.weight !== 0.4,
    "0.4 for a two-book parcel is the excess-weight charge this suite exists to stop",
  );
  ok("its height is stacked too", pkg.height === 12, `expected 2 + 10, got ${pkg.height}`);
  ok(
    "and the default footprint widens the box if it is wider",
    pkg.length === 20 && pkg.breadth === 13,
    JSON.stringify(pkg),
  );
  ok("the guessed units are reported", pkg.unmeasuredUnits === 1, String(pkg.unmeasuredUnits));
}

{
  // Quantity applies to the substitute exactly as it does to a real measurement.
  const pkg = computeOrderPackage(
    order(item(book()), item(book({ weight: 0 }), 4)),
    DEFAULTS,
  );
  ok("four unmeasured units are four defaults", pkg.weight === 2.4, `expected 0.4 + 4×0.5, got ${pkg.weight}`);
  ok("counted as four guessed units", pkg.unmeasuredUnits === 4, String(pkg.unmeasuredUnits));
}

// ─────────────────────────────────────────────────────────────────────────────
section("3 — an entirely unmeasured order scales with quantity");

{
  const bare = { weight: 0, length: 0, breadth: 0, height: 0 };
  const pkg = computeOrderPackage(order(item(bare, 3)), DEFAULTS);
  ok(
    "three unmeasured books are three default units, not one default parcel",
    pkg.weight === 1.5,
    String(pkg.weight),
  );
  ok("every unit is reported as guessed", pkg.unmeasuredUnits === 3, String(pkg.unmeasuredUnits));
}

{
  // A product reference that was never populated must behave as unmeasured rather
  // than as a zero-weight item — this used to be skipped by a `!product` guard.
  const pkg = computeOrderPackage(order(item(null, 2)), DEFAULTS);
  ok("an unpopulated product still gets a default per unit", pkg.weight === 1, String(pkg.weight));
}

// ─────────────────────────────────────────────────────────────────────────────
section("4 — nothing to measure stays out of the way");

ok("an empty order returns no fields", Object.keys(computeOrderPackage(order(), DEFAULTS)).length === 0);
ok("so does an order of zero-quantity lines", Object.keys(computeOrderPackage(order(item(book(), 0)), DEFAULTS)).length === 0);
ok(
  "with no defaults configured it cannot invent a weight",
  computeOrderPackage(order(item({ weight: 0 })), {}).weight === undefined,
);

// ─────────────────────────────────────────────────────────────────────────────
section("5 — volumetric weight, which is what actually gets billed");

ok("the standard divisor is 5000", VOLUMETRIC_DIVISOR === 5000);
ok(
  "a 30×25×15 box is 2.25kg volumetric",
  volumetricWeightKg({ length: 30, breadth: 25, height: 15 }) === 2.25,
  String(volumetricWeightKg({ length: 30, breadth: 25, height: 15 })),
);
ok(
  "a 500g book in that box is BILLED at 2.25kg, not 0.5kg",
  appliedWeightKg({ weight: 0.5, length: 30, breadth: 25, height: 15 }) === 2.25,
);
ok(
  "a snug box bills at the real weight instead",
  appliedWeightKg({ weight: 0.4, length: 20, breadth: 13, height: 2 }) === 0.4,
  String(appliedWeightKg({ weight: 0.4, length: 20, breadth: 13, height: 2 })),
);
ok("ARAMEX's 6000 divisor is cheaper", volumetricWeightKg({ length: 30, breadth: 25, height: 15 }, 6000) === 1.875);
ok("a missing dimension is 0, never NaN", volumetricWeightKg({ length: 30, breadth: 25 }) === 0);
ok("so is an empty box", volumetricWeightKg() === 0 && volumetricWeightKg({}) === 0);

// ─────────────────────────────────────────────────────────────────────────────
section("6 — float noise never reaches the courier");

{
  const pkg = computeOrderPackage(order(item(book({ weight: 0.1 })), item(book({ weight: 0.2 }))), DEFAULTS);
  ok("0.1 + 0.2 is declared as 0.3", pkg.weight === 0.3, String(pkg.weight));
}

const summary = finish();
process.exit(summary.failed > 0 ? 1 : 0);
