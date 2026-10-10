import ProductModel from "../products/Product.model.js";

/**
 * The canonical string form of a variant selection: attributes sorted by name and
 * joined, so `{size: "L", colour: "Red"}` and `{colour: "Red", size: "L"}` produce
 * the same key. Lives here rather than in inventory-reservation.service.js so the
 * dependency runs one way (reservation → variant → model) instead of in a cycle.
 */
export const getVariantKey = (selectedVariants = {}) => {
  if (!selectedVariants || typeof selectedVariants !== "object") return "";
  return Object.keys(selectedVariants)
    .sort()
    .map((key) => `${key}:${selectedVariants[key]}`)
    .join("|");
};

/**
 * Drops attributes with no value and coerces the rest to strings.
 *
 * An unselected attribute must not become part of the identity: `{color: "red",
 * size: ""}` is a red item whose size was never chosen, and it has to key the same
 * as `{color: "red"}` or the cart and the order disagree about which line they are
 * talking about. This normalisation previously existed only inside
 * cart.controller.js, so the cart dropped empty values and the order path did
 * not — the same selection produced `color:red` on one side and `color:red|size:`
 * on the other, and cart cleanup then failed to match the line it had just sold.
 */
export const normalizeSelectedVariants = (selectedVariants = {}) => {
  if (!selectedVariants || typeof selectedVariants !== "object") return {};

  // A Mongoose Map (or a lean read of one) arrives here too.
  const plain =
    typeof selectedVariants.entries === "function" && !Array.isArray(selectedVariants)
      ? Object.fromEntries(selectedVariants.entries())
      : selectedVariants;

  return Object.entries(plain).reduce((accumulator, [attribute, value]) => {
    if (value !== undefined && value !== null && String(value) !== "") {
      accumulator[attribute] = String(value);
    }
    return accumulator;
  }, {});
};

/**
 * THE canonical variant key: normalise, then derive.
 *
 * Every producer of a variantKey should go through this — cart lines, order
 * pricing, inventory and cart cleanup all compare these strings to each other, so
 * a second implementation anywhere is a silent mismatch waiting to happen. There
 * were two before this (`buildVariantKey` in the cart, `getVariantKey` here) and
 * they normalised differently.
 */
export const variantKeyFrom = (selectedVariants = {}) =>
  getVariantKey(normalizeSelectedVariants(selectedVariants));

/**
 * Bridges the two different shapes a variant is described in.
 *
 * An order line stores the customer's choice as `selectedVariants` (a Map of
 * attribute → value) reduced to a sorted `variantKey` string like
 * `"colour:Red|size:Large"`. A product stores its variants as subdocuments with
 * an `attributes` Map. Nothing connected the two, which is why
 * `variants[].stock` was never read or written by any order path: the code had a
 * key on one side and a Map on the other, and no way to match them.
 *
 * Matching on the derived key rather than on array position or SKU is
 * deliberate — positions shift when a variant is deleted, and `sku` is optional
 * and frequently blank in this catalogue.
 */
export const variantKeyOf = (variant) => {
  const attributes = variant?.attributes;
  if (!attributes) return "";

  // Mongoose gives a Map here; a `.lean()` read gives a plain object.
  const plain =
    typeof attributes.entries === "function" && !Array.isArray(attributes)
      ? Object.fromEntries(attributes.entries())
      : attributes;

  return getVariantKey(plain);
};

/**
 * The variant a given order line refers to, or null.
 *
 * Returns null (rather than throwing) when the product has no variants at all,
 * so every caller can treat "no variant" and "variant not found" the same way:
 * fall back to product-level stock, which is how the whole catalogue currently
 * behaves.
 */
export const findVariant = (product, variantKey) => {
  const variants = product?.variants;
  if (!Array.isArray(variants) || variants.length === 0) return null;
  if (!variantKey) return null;

  return (
    variants.find((variant) => variantKeyOf(variant) === variantKey) ||
    // Fall back to the SKU, so a caller that has a SKU rather than an attribute
    // key still resolves.
    variants.find((variant) => variant?.sku && variant.sku === variantKey) ||
    null
  );
};

/**
 * Whether a product's stock is tracked per variant.
 *
 * A product with an empty `variants[]` is tracked at product level only, which is
 * every product in the catalogue today. This check is what keeps the variant
 * enforcement below inert until someone actually creates a variant.
 */
/**
 * Why an absolute product-level stock write is refused on a variant-bearing product.
 *
 * `product.stock` is the TOTAL across variants. Setting the total says nothing about
 * how it splits between them, and there is no honest way to infer the split — so the
 * write is refused rather than applied to the total alone (which desynchronises it
 * from the variants it is supposed to sum) or silently ignored.
 */
export const VARIANT_MANAGED_STOCK_MESSAGE =
  "This product is stocked per variant, so its total is the sum of them and cannot be set directly. Edit the per-variant quantities instead.";

export const hasVariantStock = (product) =>
  Array.isArray(product?.variants) && product.variants.length > 0;

/**
 * How many units of a line are actually sellable.
 *
 * The variant's own stock is the binding limit when the line names one, because
 * `product.stock` is the total across all variants — a product with 10 in stock
 * split 10 Red / 0 Blue would happily sell a Blue without this.
 */
export const availableStockFor = (product, variantKey) => {
  const variant = findVariant(product, variantKey);
  if (variant) return Number(variant.stock) || 0;
  return Number(product?.stock) || 0;
};

/**
 * What a single unit of a line actually costs — the variant's price when it has
 * one, the product's otherwise.
 *
 * The exact counterpart of `availableStockFor`, and it exists for the same reason:
 * `variants[].price` was stored, validated and DISPLAYED, but never charged. The
 * product page shows the variant's price —
 *
 *     const displayPrice = selectedSizeOpt?.price ? selectedSizeOpt.price : product.price;
 *
 * — and `optionPriceAboveMrp` in product-query.service.js exists solely to stop a
 * variant being priced above the MRP it will be shown against. Yet both the cart
 * and `prepareOrderData` read `product.price` unconditionally, so a ₹999 hardcover
 * variant of a ₹299 paperback was quoted at ₹999 and SOLD at ₹299 — and a variant
 * priced below the base overcharged the customer. Variant stock was honoured
 * correctly throughout; only price was missed.
 *
 * The fallback is load-bearing, not defensive: `variants[].price` defaults to
 * `null`, and every product in the catalogue that prices at product level relies on
 * it to keep behaving exactly as before.
 *
 * `> 0` as well as finite, because a variant stored with price 0 is far more likely
 * to be an unfilled form field than a deliberate giveaway — and the failure modes
 * are not symmetric: falling back charges the known product price, while trusting
 * it ships the book for free.
 */
export const effectiveUnitPrice = (product, variant) => {
  const variantPrice = Number(variant?.price);
  if (Number.isFinite(variantPrice) && variantPrice > 0) return variantPrice;
  return Number(product?.price) || 0;
};

/**
 * The "was" price to show a unit against — the variant's MRP when it has one.
 *
 * Moves together with `effectiveUnitPrice` and must keep doing so: the storefront
 * derives its discount badge from the pair, so a variant-aware price against a
 * product-level MRP shows a ₹999 hardcover as a discount off the ₹350 paperback
 * MRP — a negative discount. `optionPriceAboveMrp` guards the same pairing on the
 * write side, and falls back to the product's MRP in exactly this way.
 */
export const effectiveUnitMrp = (product, variant) => {
  const variantMrp = Number(variant?.mrp);
  if (Number.isFinite(variantMrp) && variantMrp > 0) return variantMrp;
  return Number(product?.mrp) || 0;
};

/**
 * `effectiveUnitPrice` / `effectiveUnitMrp` for callers holding a variantKey rather
 * than the variant — the shape the cart and the order pricing path both work in.
 * Resolves the variant once for both, so the two can never disagree about which
 * variant they described.
 */
export const unitPricingFor = (product, variantKey) => {
  const variant = findVariant(product, variantKey);
  return {
    price: effectiveUnitPrice(product, variant),
    mrp: effectiveUnitMrp(product, variant),
  };
};

/**
 * How many units a shopper can actually buy right now — stock AND sellability.
 *
 * Wraps `availableStockFor` rather than replacing it, and adds the one further
 * rule checkout already applies: a deactivated variant is unsellable at any stock
 * level. Both halves matter, and the cart previously applied neither — it read
 * `product.stock`, which is the total across variants, so a sold-out or
 * deactivated variant of an in-stock product looked freely available.
 *
 * Advisory by design. This tells the shopper what is true now; the authority
 * remains the conditional `decrementStock` at checkout, which constrains the
 * product total and the variant in one atomic filter. A product can still sell out
 * between viewing the cart and paying, and that is expected.
 *
 * @returns {{available: number, tracksVariant: boolean, variantFound: boolean, isActive: boolean}}
 */
export const lineAvailability = (product, variantKey) => {
  const tracksVariant = hasVariantStock(product);
  const variant = findVariant(product, variantKey);
  const isActive = variant ? variant.active !== false : true;

  return {
    available: isActive ? availableStockFor(product, variantKey) : 0,
    tracksVariant,
    // False when the line names a variant the product no longer has — a variant
    // deleted from the catalogue since it was added to the cart. Stock then falls
    // back to the product pool, matching how the order path treats it.
    variantFound: Boolean(variant),
    isActive,
  };
};

/**
 * The one honest auto-heal for a line that names no variant: when the product
 * has exactly ONE active variant, there is exactly one thing the customer can
 * have meant. Returns that variant, or null when the answer is ambiguous
 * (zero or several variants, or the only one is deactivated) — ambiguity is
 * for the VARIANT_REQUIRED guard, never a guess.
 */
export const resolveSoleVariant = (product) => {
  const variants = Array.isArray(product?.variants) ? product.variants : [];
  if (variants.length !== 1) return null;
  const sole = variants[0];
  if (sole.active === false) return null;
  return sole;
};

/**
 * Resolves an order line's variantKey to the variant's `_id`.
 *
 * The `_id` is what makes the stock update atomic: it can go in the update FILTER
 * (via $elemMatch) so the positional `$` operator targets exactly that variant.
 * A derived attribute key cannot be matched by the database, and an array index
 * would silently point at a different variant if the admin reorders them.
 *
 * Null means "track this line at product level" — no variants, no selection, or a
 * selection naming a variant that no longer exists.
 */
export const resolveVariantId = async (productId, variantKey) => {
  if (!variantKey) return null;
  const product = await ProductModel.findById(productId).select("variants").lean();
  const variant = findVariant(product, variantKey);
  return variant?._id || null;
};

/**
 * Takes `quantity` off a product's stock — and off the chosen variant's stock —
 * in one conditional update.
 *
 * Both counters are constrained in the FILTER, so the update is a
 * compare-and-swap: it applies only if BOTH have enough, and applies to both
 * atomically or to neither. Returns false when there wasn't enough, which every
 * caller must treat as "do not sell this".
 *
 * Variant stock was previously never read or written by any order path, so a
 * product with 10 units split 10 Red / 0 Blue would happily sell a Blue.
 */
export const decrementStock = async ({
  productId,
  quantity,
  variantId = null,
  session = null,
}) => {
  const qty = Number(quantity) || 0;
  if (qty <= 0) return true;
  const options = session ? { session } : {};

  const filter = variantId
    ? {
        _id: productId,
        stock: { $gte: qty },
        variants: { $elemMatch: { _id: variantId, stock: { $gte: qty } } },
      }
    : {
        _id: productId,
        stock: { $gte: qty },
        // A variantless decrement must not touch a variant-managed product:
        // decrementing only the total leaves the per-variant counters stale,
        // and the next variant-bearing save derives the total from them —
        // silently resurrecting the sold units. The guard lives in the same
        // filter as the CAS, so refusing is atomic too: no match → false →
        // the caller's "not enough stock" path, never a corrupted counter.
        variants: { $not: { $elemMatch: { stock: { $type: "number" } } } },
      };

  const update = variantId
    ? { $inc: { stock: -qty, "variants.$.stock": -qty } }
    : { $inc: { stock: -qty } };

  const result = await ProductModel.updateOne(filter, update, options);
  return result.modifiedCount === 1;
};

/** The mirror of decrementStock, for cancellations, releases and restocks. */
export const incrementStock = async ({
  productId,
  quantity,
  variantId = null,
  session = null,
}) => {
  const qty = Number(quantity) || 0;
  if (qty <= 0) return;
  const options = session ? { session } : {};

  if (variantId) {
    const result = await ProductModel.updateOne(
      { _id: productId, "variants._id": variantId },
      { $inc: { stock: qty, "variants.$.stock": qty } },
      options,
    );
    if (result.modifiedCount === 1) return;
    // No match: the variant was deleted from the catalogue after the sale. The
    // units still physically exist, so they fall through to the product-level
    // pool below rather than being written off. This is the one deliberate
    // divergence (total > variant sum) — a restock on a money path must not
    // fail because an admin deleted a variant; the reconcile report flags it.
    await ProductModel.updateOne({ _id: productId }, { $inc: { stock: qty } }, options);
    return;
  }

  // Variantless restore. Unlike the decrement, this is NOT guarded against
  // variant-managed products: a legacy variantless order line (placed before
  // the sale-side guard existed) can still be cancelled, and refusing the
  // restore would silently lose the units — worse than the divergence it
  // avoids. The resulting total-above-sum shows up in the reconcile report
  // (delta > 0) for an admin to assign to a variant.
  await ProductModel.updateOne({ _id: productId }, { $inc: { stock: qty } }, options);
};
