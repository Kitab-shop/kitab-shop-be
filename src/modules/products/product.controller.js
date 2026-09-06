import { createHash } from "node:crypto";

import Product from "./Product.model.js";
import productModel from "./Product.model.js";
import { deleteImageAsset, saveImageAsset } from "../../utils/image-upload.js";
import {
  addDeliveryDays,
  attachReviewSummary,
  computeRelevanceScore,
  escapeRegex,
  findUnsupportedVariantFormat,
  fuzzyScore,
  getDeliveryRange,
  normalizeProductStyles,
  resolveVariantPayload,
  toBoolean,
  trackSearch,
} from "./product-query.service.js";
import { buildSeoFields } from "./product-seo.service.js";
import {
  VARIANT_MANAGED_STOCK_MESSAGE,
  hasVariantStock,
} from "../inventory/variant.service.js";

/** A variant-bearing product's stock is the sum of its variants, by definition. */
const sumVariantStock = (variants = []) =>
  variants.reduce((total, variant) => total + (Number(variant.stock) || 0), 0);

const parseImageList = (value) => {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.map(String).map((item) => item.trim()).filter(Boolean)
      : [];
  } catch {
    return value.split(",").map((item) => item.trim()).filter(Boolean);
  }
};

const mergePrimaryImage = (images, primaryImage) => {
  const cleanImages = parseImageList(images);
  const rest = cleanImages.slice(1).filter((image) => image !== primaryImage);
  return [primaryImage, ...rest].filter(Boolean);
};

export const CreateProduct = async (req, res) => {
  try {
    const {
      name,
      description,
      price,
      mrp,
      category_id,
      size,
      brand,
      stock,
      producthightlight,
      bestseller,
      styles,
      variants,
      metaTitle,
      metaDescription,
      metaKeywords,
      slug,
      weight,
      length,
      breadth,
      height,
      returnPolicyKind,
      returnPolicyWindowDays,
      author,
      authorBio,
      publisher,
      isbn,
      language,
      pages,
      edition,
      publicationYear,
      images,
    } = req.body;

    const missingFields = [];
    if (!name?.trim()) missingFields.push("name");
    if (!description?.trim()) missingFields.push("description");
    if (!price) missingFields.push("price");
    if (!category_id) missingFields.push("category");
    // Book payloads send `publisher` instead of `brand`; the model's
    // pre-validate hook mirrors publisher into brand, so either satisfies it.
    if (!brand?.trim() && !publisher?.trim()) missingFields.push("brand");
    if (!producthightlight?.trim()) missingFields.push("product highlights");
    if (stock === undefined || stock === "") missingFields.push("stock");

    if (missingFields.length > 0) {
      return res.status(400).json({
        message: `Missing required fields: ${missingFields.join(", ")}`,
      });
    }

    const productPrice = Number(price);
    const productMrp = mrp === undefined || mrp === "" ? productPrice : Number(mrp);
    const productStock = Number(stock);

    if (!Number.isFinite(productPrice) || productPrice < 0) {
      return res.status(400).json({ message: "Price cannot be negative" });
    }
    if (!Number.isFinite(productMrp) || productMrp < 0) {
      return res.status(400).json({ message: "MRP cannot be negative" });
    }
    // MRP is the *maximum* retail price, so the selling price can never exceed it. Nothing
    // enforced this, and the storefront computes its discount badge as (mrp - price) / mrp —
    // which goes negative. Every display surface happens to guard against that today
    // (ProductCard hides the badge, the cart clamps with Math.max), so the symptom was a
    // silently missing discount rather than a visible "-67% off". The data was still wrong,
    // and in India selling above the printed MRP is not merely a presentation problem.
    // Equal is allowed: that is simply a product sold at MRP with no discount.
    if (productPrice > productMrp) {
      return res.status(400).json({
        message: `Price (₹${productPrice}) cannot be greater than MRP (₹${productMrp}). MRP is the maximum retail price, so the selling price must be equal to or below it.`,
        code: "PRICE_ABOVE_MRP",
      });
    }
    if (!Number.isInteger(productStock) || productStock < 0) {
      return res.status(400).json({
        message: "Stock must be a non-negative whole number",
      });
    }

    // Package attributes for shipping — optional; 0 means "not set" and
    // falls back to the SHIPROCKET_DEFAULT_* env values at shipment time.
    const productWeight = Math.max(0, Number(weight) || 0);
    const productLength = Math.max(0, Number(length) || 0);
    const productBreadth = Math.max(0, Number(breadth) || 0);
    const productHeight = Math.max(0, Number(height) || 0);

    const RETURN_POLICY_KINDS = ["none", "return", "replacement"];
    const productReturnPolicyKind = RETURN_POLICY_KINDS.includes(returnPolicyKind)
      ? returnPolicyKind
      : "return";
    const productReturnPolicyWindowDays = Math.max(0, Number(returnPolicyWindowDays) || 0) || 7;

    console.log(req.body);

    if (!req.file) {
      return res.status(400).json({
        message: "Image is required",
      });
    }

    // Refuse a variant payload the schema cannot hold, BEFORE anything is written.
    // normalizeVariants silently drops what it does not recognise, so the admin
    // form's option-group shape used to be accepted and stored stripped of every
    // option, price and stock value — with a 201.
    const variantProblem = findUnsupportedVariantFormat(variants, productMrp);
    if (variantProblem) {
      return res.status(400).json({
        message: variantProblem,
        code: "UNSUPPORTED_VARIANT_FORMAT",
      });
    }
    const resolvedVariants = resolveVariantPayload(variants) || [];

    const imageResult = await saveImageAsset({
      file: req.file,
      folder: "products",
      name,
      width: 500,
      height: 500,
      quality: 80,
    });

    const product = await Product.create({
      name,
      description,
      price: productPrice,
      mrp: Number.isNaN(productMrp) ? productPrice : productMrp,
      category_id,
      size,
      brand,
      producthightlight,
      styles: normalizeProductStyles(styles),
      variants: resolvedVariants,
      // Derived, not taken from the form, when the product has variants: each
      // variant is stocked separately, so the product counter is their sum. Keeping
      // them independent is what let a manual product-stock edit drift away from the
      // variants it is supposed to total. decrementStock moves both together
      // afterwards, so the relationship holds once established here.
      stock: resolvedVariants.length > 0 ? sumVariantStock(resolvedVariants) : productStock,
      bestseller: toBoolean(bestseller),
      weight: productWeight,
      length: productLength,
      breadth: productBreadth,
      height: productHeight,
      returnPolicy: {
        kind: productReturnPolicyKind,
        windowDays: productReturnPolicyWindowDays,
      },

      author: typeof author === "string" ? author.trim() : "",
      authorBio: typeof authorBio === "string" ? authorBio.trim() : "",
      publisher: typeof publisher === "string" ? publisher.trim() : "",
      isbn: typeof isbn === "string" ? isbn.trim() : "",
      language: typeof language === "string" && language.trim() ? language.trim() : "English",
      pages: Math.max(0, Number(pages) || 0),
      edition: typeof edition === "string" ? edition.trim() : "",
      publicationYear: Number.isFinite(Number(publicationYear)) && publicationYear !== "" && publicationYear !== null && publicationYear !== undefined
        ? Number(publicationYear)
        : null,

      image: imageResult.image,
      images: mergePrimaryImage(images, imageResult.image),
      public_id: imageResult.public_id,

      ...buildSeoFields({ metaTitle, metaDescription, metaKeywords, slug, name }),
    });

    // product.save();

    if (!product) {
      return res.status(400).json({
        message: "Product not created",
      });
    }

    invalidateCatalogueCache();
    return res.status(200).json({
      message: "Product created successfully",
      data: product,
    });
  } catch (ex) {
    console.log(ex);
    return res.status(500).json({
      message: ex.message,
    });
    s;
  }
};

/**
 * The whole catalogue, byte-identical for every caller: the route carries no
 * auth middleware and the storefront fetches it unauthenticated on app boot.
 * Rebuilding it per visitor was the entire cost — a few thousand products is a
 * multi-megabyte payload plus a review aggregate, serialised on one vCPU, for
 * every first page load. So build it once and hand out the same bytes until a
 * product changes.
 *
 * Coherent because this API is deliberately a single process (see the systemd
 * unit in provision-vps.sh). Add workers and each keeps its own copy — the same
 * caveat that already applies to RATE_LIMIT_STORE=memory.
 */
let catalogueCache = null;

/**
 * Backstop for the writes this controller never sees: order placement
 * decrements stock, GetProductById bumps viewCount. Both appear in this
 * payload and neither is worth invalidating on — a view counter would clear
 * the cache every time a product page opened. Slightly stale stock in the
 * *list* is safe; the product page and checkout both re-read live.
 */
const CATALOGUE_CACHE_TTL_MS = 60_000;

export const invalidateCatalogueCache = () => {
  catalogueCache = null;
};

export const GetAllProduct = async (req, res) => {
  try {
    const expired =
      catalogueCache && Date.now() - catalogueCache.builtAt > CATALOGUE_CACHE_TTL_MS;

    if (!catalogueCache || expired) {
      const product = await productModel
        .find()
        .sort({ createdAt: -1 })
        .populate("category_id")
        .lean();
      const body = JSON.stringify({
        message: "Product found successfully",
        data: await attachReviewSummary(product),
      });
      catalogueCache = {
        body,
        etag: `W/"${createHash("sha1").update(body).digest("base64url")}"`,
        builtAt: Date.now(),
      };
    }

    // no-cache means "revalidate", not "do not store": a conditional request
    // still reaches here, but an unchanged catalogue answers with a 304 instead
    // of megabytes. Anything longer-lived would serve a stale catalogue past an
    // admin edit, which is what invalidateCatalogueCache() exists to prevent.
    res.set("Cache-Control", "no-cache");
    res.set("ETag", catalogueCache.etag);

    if (req.headers?.["if-none-match"] === catalogueCache.etag) {
      return res.status(304).end();
    }

    // Already serialised — res.json() would stringify the same object again.
    return res.status(200).type("application/json").send(catalogueCache.body);
  } catch (ex) {
    console.log(ex);
    return res.status(500).json({
      message: ex.message,
    });
  }
};

/**
 * Both ranking paths below score in JavaScript, which used to mean fetching
 * whole documents — images, variants, reviews and all — for every candidate.
 * That is what forced the old row caps (1000 for relevance, 300 for fuzzy), and
 * those caps were silent: past them the results *and* the reported total were
 * simply wrong, so page numbers lied. Scoring only reads a handful of short
 * text fields, so rank on a projection across the full match set and hydrate
 * only the page actually being returned.
 */
const RELEVANCE_RANKING_FIELDS =
  "name brand author producthightlight description bestseller viewCount createdAt";
const FUZZY_RANKING_FIELDS = "name brand author producthightlight viewCount category_id";

/** Re-reads a ranked page of products in full, preserving the ranked order. */
const hydrateRankedPage = async (rankedIds) => {
  if (rankedIds.length === 0) return [];
  const documents = await productModel
    .find({ _id: { $in: rankedIds } })
    .populate("category_id")
    .lean();
  const byId = new Map(documents.map((document) => [String(document._id), document]));
  // $in does not return documents in the order it was given, and here that
  // order is the ranking — so reorder rather than trusting the driver.
  return rankedIds.map((id) => byId.get(String(id))).filter(Boolean);
};

export const SearchProducts = async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    const page = Math.max(Number.parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 20, 1), 100);
    const filter = {};

    if (q) {
      const regex = new RegExp(escapeRegex(q), "i");
      filter.$or = [
        { name: regex },
        { brand: regex },
        { author: regex },
        { producthightlight: regex },
        { description: regex },
      ];
    }
    if (req.query.categoryId) filter.category_id = req.query.categoryId;
    if (req.query.brand) filter.brand = new RegExp(`^${escapeRegex(req.query.brand)}$`, "i");
    if (req.query.author) filter.author = new RegExp(`^${escapeRegex(req.query.author)}$`, "i");
    if (req.query.language) filter.language = new RegExp(`^${escapeRegex(req.query.language)}$`, "i");
    // Only ACTIVE variants count: an inactive format (e.g. the seeded E-book
    // placeholders) must never let shoppers filter into an unbuyable set.
    if (req.query.format) {
      filter.variants = {
        $elemMatch: {
          "attributes.Format": new RegExp(`^${escapeRegex(req.query.format)}$`, "i"),
          active: true,
        },
      };
    }
    if (req.query.inStock === "true") filter.stock = { ...(filter.stock || {}), $gt: 0 };
    if (req.query.minPrice || req.query.maxPrice) {
      filter.price = {};
      if (req.query.minPrice) filter.price.$gte = Number(req.query.minPrice);
      if (req.query.maxPrice) filter.price.$lte = Number(req.query.maxPrice);
    }

    const sortMode = String(req.query.sort || "relevance");
    const sort =
      sortMode === "newest"
        ? { createdAt: -1 }
        : sortMode === "price_asc"
          ? { price: 1 }
          : sortMode === "price_desc"
            ? { price: -1 }
            : sortMode === "popularity"
              ? { viewCount: -1, createdAt: -1 }
              : { bestseller: -1, viewCount: -1, createdAt: -1 };

    let products;
    let total;
    if (sortMode === "relevance" && q) {
      // A plain DB sort can't express "how well does this match what was
      // typed" — only popularity/recency. So for the default "relevance"
      // search-with-a-query case, rank matches by text relevance first
      // (exact/prefix/word-match on name beats a weaker brand-only match),
      // falling back to popularity only to break ties within the same
      // relevance tier.
      const candidates = await productModel
        .find(filter)
        .select(RELEVANCE_RANKING_FIELDS)
        .lean();
      candidates.sort((a, b) => {
        const relevanceDiff = computeRelevanceScore(q, a) - computeRelevanceScore(q, b);
        if (relevanceDiff !== 0) return relevanceDiff;
        if (Boolean(b.bestseller) !== Boolean(a.bestseller)) {
          return (b.bestseller ? 1 : 0) - (a.bestseller ? 1 : 0);
        }
        if ((b.viewCount || 0) !== (a.viewCount || 0)) return (b.viewCount || 0) - (a.viewCount || 0);
        return new Date(b.createdAt) - new Date(a.createdAt);
      });
      total = candidates.length;
      products = await hydrateRankedPage(
        candidates.slice((page - 1) * limit, page * limit).map((candidate) => candidate._id),
      );
    } else {
      [products, total] = await Promise.all([
        productModel
          .find(filter)
          .populate("category_id")
          .sort(sort)
          .skip((page - 1) * limit)
          .limit(limit)
          .lean(),
        productModel.countDocuments(filter),
      ]);
    }

    let usedFuzzy = false;
    if (q && products.length < 3) {
      // Typo tolerance cannot be index-backed, so this scores the whole
      // catalogue — cheap on a projection, and the only way a misspelling finds
      // a book that is not already among the most-viewed. The DB sort stays
      // because Array.sort is stable: it is what breaks ties between equal
      // score and view count.
      const candidates = await productModel
        .find({})
        .select(FUZZY_RANKING_FIELDS)
        .populate("category_id", "name")
        .sort({ viewCount: -1, createdAt: -1 })
        .lean();
      const fuzzyMatches = candidates
        .map((product) => ({ product, score: fuzzyScore(q, product) }))
        .filter(({ score }) => score <= 2)
        .sort((a, b) => a.score - b.score || (b.product.viewCount || 0) - (a.product.viewCount || 0))
        .map(({ product }) => product);
      if (fuzzyMatches.length > products.length) {
        total = fuzzyMatches.length;
        products = await hydrateRankedPage(
          fuzzyMatches.slice((page - 1) * limit, page * limit).map((match) => match._id),
        );
        usedFuzzy = true;
      }
    }

    let data = await attachReviewSummary(products);
    const minRating = Number(req.query.minRating);
    if (Number.isFinite(minRating) && minRating > 0) {
      data = data.filter((product) => Number(product.rating || 0) >= minRating);
    }

    // Fire-and-forget: trackSearch already swallows its own errors, so
    // awaiting it only adds an extra DB round-trip to the response latency.
    trackSearch({ req, query: q, resultCount: data.length, source: "search_page" });

    return res.status(200).json({
      success: true,
      data,
      meta: {
        query: q,
        usedFuzzy,
      },
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(Math.ceil(total / limit), 1),
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const AutocompleteProducts = async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    if (q.length < 2) {
      return res.status(200).json({ success: true, data: [] });
    }

    const regex = new RegExp(escapeRegex(q), "i");
    // Pull a wider pool than the 10 we'll actually show, so a highly
    // relevant match (e.g. name starts with the query) can't get crowded
    // out by more-viewed-but-weaker matches before relevance gets a say.
    let products = await productModel
      .find({ $or: [{ name: regex }, { brand: regex }, { author: regex }] })
      .select("name brand author publisher image price stock viewCount")
      .limit(50)
      .lean();
    products.sort((a, b) => {
      const relevanceDiff = computeRelevanceScore(q, a) - computeRelevanceScore(q, b);
      if (relevanceDiff !== 0) return relevanceDiff;
      return (b.viewCount || 0) - (a.viewCount || 0);
    });
    products = products.slice(0, 10);

    let usedFuzzy = false;
    if (products.length < 4) {
      const candidates = await productModel
        .find({})
        .select("name brand author publisher image price stock viewCount createdAt")
        .sort({ viewCount: -1, createdAt: -1 })
        .limit(200)
        .lean();
      const fuzzyMatches = candidates
        .map((product) => ({ product, score: fuzzyScore(q, product) }))
        .filter(({ score }) => score <= 2)
        .sort((a, b) => a.score - b.score || (b.product.viewCount || 0) - (a.product.viewCount || 0))
        .map(({ product }) => product);
      if (fuzzyMatches.length > products.length) {
        products = fuzzyMatches.slice(0, 10);
        usedFuzzy = true;
      }
    }

    // Fire-and-forget — this runs on every debounced keystroke, so awaiting
    // an analytics write here directly adds to perceived typing latency.
    trackSearch({ req, query: q, resultCount: products.length, source: "autocomplete" });

    return res.status(200).json({
      success: true,
      meta: { query: q, usedFuzzy },
      data: products.map((product) => ({
        id: product._id,
        name: product.name,
        brand: product.brand,
        author: product.author || "",
        publisher: product.publisher || "",
        image: product.image,
        price: product.price,
        inStock: product.stock > 0,
      })),
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const TrackSearchClick = async (req, res) => {
  try {
    const query = String(req.body?.query || "").trim();
    const productId = req.body?.productId;
    if (!query || !productId) {
      return res.status(400).json({
        success: false,
        message: "query and productId are required",
      });
    }

    await trackSearch({
      req,
      query,
      resultCount: 1,
      source: "suggestion_click",
      clickedProduct: productId,
    });

    return res.status(200).json({ success: true });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const GetProductById = async (req, res) => {
  try {
    const product = await productModel
      .findById(req.params.id)
      .populate("category_id")
      .lean();
    if (!product) {
      return res.status(400).json({
        message: "Product not found",
      });
    }

    product.viewCount = (product.viewCount || 0) + 1;
    await productModel.updateOne(
      { _id: req.params.id },
      { $inc: { viewCount: 1 } },
    );
    return res.status(200).json({
      message: "Product found successfully",
      data: await attachReviewSummary(product),
    });
  } catch (ex) {
    console.log(ex);
    return res.status(500).json({
      message: ex.message,
    });
  }
};

export const GetProductsByCategory = async (req, res) => {
  try {
    const { categoryId } = req.params;
    const products = await Product.find({ category_id: categoryId })
      .populate("category_id")
      .lean();
    const enrichedProducts = await attachReviewSummary(products);

    return res.status(200).json({
      success: true,
      count: enrichedProducts.length,
      products: enrichedProducts,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

export const GetDeliveryEstimate = async (req, res) => {
  try {
    const pincode = String(req.query.pincode || "").trim();

    if (!/^[1-9][0-9]{5}$/.test(pincode)) {
      return res.status(400).json({
        success: false,
        message: "Enter a valid 6-digit Indian PIN code",
      });
    }

    const product = await Product.findById(req.params.id).select("stock");
    if (!product) {
      return res.status(404).json({
        success: false,
        message: "Product not found",
      });
    }

    if (product.stock <= 0) {
      return res.status(409).json({
        success: false,
        serviceable: false,
        message: "This product is currently out of stock",
      });
    }

    const { minDays, maxDays } = getDeliveryRange(pincode);
    const now = new Date();

    return res.status(200).json({
      success: true,
      serviceable: true,
      data: {
        pincode,
        minDays,
        maxDays,
        earliestDate: addDeliveryDays(now, minDays).toISOString(),
        latestDate: addDeliveryDays(now, maxDays).toISOString(),
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

// delete

export const DeleteProduct = async (req, res) => {
  try {
    const product = await productModel.findByIdAndDelete(req.params.id);
    if (!product) {
      return res.status(400).json({
        message: "Product not found",
      });
    }

    await deleteImageAsset(product.public_id);

    invalidateCatalogueCache();
    return res.status(200).json({
      message: "Product deleted successfully",
      data: product,
    });
  } catch (ex) {
    console.log(ex);
    return res.status(500).json({
      message: ex.message,
    });
  }
};

// update
export const UpdateProduct = async (req, res) => {
  try {
    const {
      name,
      description,
      price,
      mrp,
      category_id,
      size,
      brand,
      stock,
      producthightlight,
      bestseller,
      styles,
      variants,
      metaTitle,
      metaDescription,
      metaKeywords,
      slug,
      season,
      festival,
      weight,
      length,
      breadth,
      height,
      returnPolicyKind,
      returnPolicyWindowDays,
      expectedStock,
      expectedVariantStocks,
      author,
      authorBio,
      publisher,
      isbn,
      language,
      pages,
      edition,
      publicationYear,
      images,
    } = req.body;

    const product = await productModel.findById(req.params.id);
    if (!product) {
      return res.status(400).json({
        message: "Product not found",
      });
    }

    // ── Optimistic-concurrency guard on stock ────────────────────────────────
    // Stock is written as an ABSOLUTE value, but customers decrement it
    // concurrently ($inc at order placement). An admin form seeded minutes ago
    // could silently restore sold units. Clients that display a stock value
    // send it back as `expectedStock` (and `expectedVariantStocks` for
    // per-variant numbers); a mismatch means the admin decided from a stale
    // number, so the write is refused with the current truth. Both fields are
    // opt-in — requests without them (bulk CSV, older clients) behave as
    // before. Checked before ANY field assignment so a refusal changes nothing.
    if (
      expectedStock !== undefined &&
      expectedStock !== "" &&
      stock !== undefined &&
      stock !== ""
    ) {
      const baseline = Number(expectedStock);
      if (Number.isFinite(baseline) && baseline !== Number(product.stock)) {
        return res.status(409).json({
          message: `Stock changed while you were editing — it is now ${product.stock} (a customer may have purchased). The value was not saved; re-check and try again.`,
          code: "STOCK_CHANGED_SINCE_LOAD",
          currentStock: product.stock,
        });
      }
    }

    if (expectedVariantStocks !== undefined && variants !== undefined) {
      let expectedMap = expectedVariantStocks;
      if (typeof expectedMap === "string") {
        try {
          expectedMap = JSON.parse(expectedMap);
        } catch {
          expectedMap = null;
        }
      }
      if (expectedMap && typeof expectedMap === "object") {
        // Stored variants are a flat option list ({name, stock, …}) — match by
        // option name, the same identity resolveVariantPayload works with.
        const storedStocks = new Map(
          (product.variants || []).map((option) => [String(option.name), Number(option.stock) || 0]),
        );
        const changed = {};
        for (const [name, value] of Object.entries(expectedMap)) {
          const current = storedStocks.get(String(name));
          if (current !== undefined && Number(value) !== current) {
            changed[name] = current;
          }
        }
        if (Object.keys(changed).length > 0) {
          return res.status(409).json({
            message:
              "Variant stock changed while you were editing (a customer may have purchased). The save was refused — re-check the per-size numbers and try again.",
            code: "STOCK_CHANGED_SINCE_LOAD",
            currentVariantStocks: changed,
          });
        }
      }
    }

    // Checked here, before the field assignments below and well before save(), so a
    // rejected variant payload leaves the product exactly as it was. On this path a
    // malformed value was doubly destructive: an unparseable string made
    // normalizeVariants return [], wiping variants the product already had.
    // The MRP a variant will actually be displayed against: the incoming value when this
    // request changes it, otherwise the stored one. Passing only the incoming value would
    // stop checking variants on every request that leaves MRP alone.
    const effectiveMrp = mrp !== undefined && mrp !== "" ? Number(mrp) : Number(product.mrp);
    const variantProblem = findUnsupportedVariantFormat(variants, effectiveMrp);
    if (variantProblem) {
      return res.status(400).json({
        message: variantProblem,
        code: "UNSUPPORTED_VARIANT_FORMAT",
      });
    }

    if (req.file) {
      const imageResult = await saveImageAsset({
        file: req.file,
        folder: "products",
        name: name || product.name,
        width: 500,
        height: 500,
        quality: 80,
      });

      await deleteImageAsset(product.public_id);

      product.image = imageResult.image;
      product.images = mergePrimaryImage(images ?? product.images, imageResult.image);
      product.public_id = imageResult.public_id;
    }
    if (images !== undefined && !req.file) {
      const nextImages = parseImageList(images);
      product.images = nextImages.length > 0 ? nextImages : [product.image].filter(Boolean);
      if (nextImages[0]) product.image = nextImages[0];
    }

    if (name !== undefined) product.name = name;
    if (size !== undefined) product.size = size;
    if (brand !== undefined) product.brand = brand;
    if (producthightlight !== undefined) product.producthightlight = producthightlight;
    if (styles !== undefined) product.styles = normalizeProductStyles(styles);
    if (variants !== undefined) product.variants = resolveVariantPayload(variants) || [];
    if (description !== undefined) product.description = description;
    // Empty string clears the assignment (e.g. the bulk "no change" option
    // resolving to ""), so this checks for undefined, not truthiness.
    if (season !== undefined) product.season = season;
    if (festival !== undefined) product.festival = festival;
    if (author !== undefined) product.author = String(author).trim();
    if (authorBio !== undefined) product.authorBio = String(authorBio).trim();
    if (publisher !== undefined) product.publisher = String(publisher).trim();
    if (isbn !== undefined) product.isbn = String(isbn).trim();
    if (language !== undefined) product.language = String(language).trim() || "English";
    if (pages !== undefined) product.pages = Math.max(0, Number(pages) || 0);
    if (edition !== undefined) product.edition = String(edition).trim();
    if (publicationYear !== undefined) {
      const year = Number(publicationYear);
      product.publicationYear = publicationYear === "" || !Number.isFinite(year) ? null : year;
    }
    if (weight !== undefined) product.weight = Math.max(0, Number(weight) || 0);
    if (length !== undefined) product.length = Math.max(0, Number(length) || 0);
    if (breadth !== undefined) product.breadth = Math.max(0, Number(breadth) || 0);
    if (height !== undefined) product.height = Math.max(0, Number(height) || 0);
    // Products created before returnPolicy existed have no such subdocument
    // stored, so build the object rather than assigning into it.
    if (returnPolicyKind !== undefined || returnPolicyWindowDays !== undefined) {
      const nextKind = ["none", "return", "replacement"].includes(returnPolicyKind)
        ? returnPolicyKind
        : product.returnPolicy?.kind || "return";
      const nextWindow =
        returnPolicyWindowDays !== undefined && returnPolicyWindowDays !== ""
          ? Math.max(0, Number(returnPolicyWindowDays) || 0) || 7
          : product.returnPolicy?.windowDays || 7;
      product.returnPolicy = { kind: nextKind, windowDays: nextWindow };
    }

    // Only assigns keys the request actually sent, so an update that omits the
    // SEO block leaves existing metadata alone. `slug` is passed explicitly so
    // renaming a product does not silently rewrite a hand-picked slug.
    Object.assign(
      product,
      buildSeoFields({ metaTitle, metaDescription, metaKeywords, slug }),
    );

    if (price !== undefined && price !== "") {
      const nextPrice = Number(price);
      if (!Number.isFinite(nextPrice) || nextPrice < 0) {
        return res.status(400).json({ message: "Price cannot be negative" });
      }
      product.price = nextPrice;
    }
    if (mrp !== undefined && mrp !== "") {
      const nextMrp = Number(mrp);
      if (!Number.isFinite(nextMrp) || nextMrp < 0) {
        return res.status(400).json({ message: "MRP cannot be negative" });
      }
      product.mrp = nextMrp;
    }
    if ((product.mrp === undefined || product.mrp === null) && product.price !== undefined) {
      product.mrp = product.price;
    }
    // Compared AFTER both assignments above, against the values the product will actually be
    // saved with. That is what makes a one-sided edit safe: sending only a new price checks it
    // against the STORED mrp, and sending only a new mrp checks it against the stored price.
    // Comparing just the incoming pair would let "raise the price, leave MRP alone" through.
    //
    // Only checked when this request actually touches one of the two. A caller editing a
    // description is not asked to fix pricing it never mentioned — the same reasoning the
    // stock and variants fields already use. The admin form does send both, so in practice
    // any save from the UI is validated.
    const touchesPricing =
      (price !== undefined && price !== "") || (mrp !== undefined && mrp !== "");
    if (touchesPricing && Number(product.price) > Number(product.mrp)) {
      return res.status(400).json({
        message: `Price (₹${product.price}) cannot be greater than MRP (₹${product.mrp}). MRP is the maximum retail price, so the selling price must be equal to or below it.`,
        code: "PRICE_ABOVE_MRP",
      });
    }
    if (category_id !== undefined && category_id !== "") product.category_id = category_id;
    if (stock !== undefined && stock !== "") {
      const nextStock = Number(stock);
      if (!Number.isInteger(nextStock) || nextStock < 0) {
        return res.status(400).json({
          message: "Stock must be a non-negative whole number",
        });
      }
      // Refused, not silently overridden by the derived sum below. A caller that
      // asks to set the total on a variant-stocked product has misunderstood which
      // number it is editing, and answering 200 while ignoring the value is how the
      // admin Inventory page appeared to save changes that never applied.
      //
      // Allowed when the same request also replaces the variants: the product form
      // sends both, and the sum is then derived from the variants it just supplied.
      if (variants === undefined && hasVariantStock(product)) {
        return res.status(409).json({
          message: VARIANT_MANAGED_STOCK_MESSAGE,
          code: "STOCK_IS_VARIANT_MANAGED",
        });
      }
      product.stock = nextStock;
    }
    // Last word on stock for a variant-bearing product: its counter is the sum of
    // its variants, whatever the form sent. Applied after the explicit assignment
    // above so an edit that supplies both cannot leave the two disagreeing — the
    // asymmetry that made a manual stock edit silently desynchronise a variant
    // product from its own variants.
    if (product.variants.length > 0) {
      product.stock = sumVariantStock(product.variants);
    }
    if (bestseller !== undefined) product.bestseller = toBoolean(bestseller);
    await product.save();
    invalidateCatalogueCache();
    return res.status(200).json({
      message: "Product updated successfully",
      data: product,
    });
  } catch (ex) {
    console.log(ex);
    return res.status(500).json({
      message: ex.message,
    });
  }
};
