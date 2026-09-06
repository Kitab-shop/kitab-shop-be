import mango from "mongoose";
const productSchema = new mango.Schema(
  {
    category_id: {
      type: mango.Schema.Types.ObjectId,
      ref: "Category",
      required: true,
      index: true,
    },

    name: {
      type: String,
      required: true,
    },

    description: {
      type: String,
      required: true,
    },

    price: {
      type: Number,
      required: true,
      min: 0,
    },

    mrp: {
      type: Number,
      default: function () {
        return this.price;
      },
      min: 0,
    },

    size: {
      type: String,
      default: "Standard",
    },

    producthightlight: {
      type: String,
      required: true,
    },

    styles: {
      name: {
        fontFamily: { type: String, enum: ["default", "serif", "sans", "mono"], default: "default" },
        fontSize: { type: Number, default: 14, min: 1, max: 96 },
        fontWeight: { type: String, enum: ["normal", "medium", "semibold", "bold"], default: "normal" },
        fontStyle: { type: String, enum: ["normal", "italic"], default: "normal" },
        textColor: { type: String, default: "#1F2937" },
      },
      brand: {
        fontFamily: { type: String, enum: ["default", "serif", "sans", "mono"], default: "default" },
        fontSize: { type: Number, default: 12, min: 1, max: 64 },
        fontWeight: { type: String, enum: ["normal", "medium", "semibold", "bold"], default: "normal" },
        fontStyle: { type: String, enum: ["normal", "italic"], default: "normal" },
        textColor: { type: String, default: "#6B7280" },
      },
      price: {
        fontFamily: { type: String, enum: ["default", "serif", "sans", "mono"], default: "default" },
        fontSize: { type: Number, default: 18, min: 1, max: 96 },
        fontWeight: { type: String, enum: ["normal", "medium", "semibold", "bold"], default: "bold" },
        fontStyle: { type: String, enum: ["normal", "italic"], default: "normal" },
        textColor: { type: String, default: "#111827" },
      },
      highlights: {
        fontFamily: { type: String, enum: ["default", "serif", "sans", "mono"], default: "default" },
        fontSize: { type: Number, default: 14, min: 1, max: 64 },
        fontWeight: { type: String, enum: ["normal", "medium", "semibold", "bold"], default: "normal" },
        fontStyle: { type: String, enum: ["normal", "italic"], default: "normal" },
        textColor: { type: String, default: "#4B5563" },
      },
      description: {
        fontFamily: { type: String, enum: ["default", "serif", "sans", "mono"], default: "default" },
        fontSize: { type: Number, default: 14, min: 1, max: 64 },
        fontWeight: { type: String, enum: ["normal", "medium", "semibold", "bold"], default: "normal" },
        fontStyle: { type: String, enum: ["normal", "italic"], default: "normal" },
        textColor: { type: String, default: "#4B5563" },
      },
    },

    stock: {
      type: Number,
      default: 0,
      min: 0,
    },

    variants: {
      type: [
        {
          name: { type: String, required: true, trim: true },
          sku: { type: String, trim: true, default: "" },
          attributes: {
            type: Map,
            of: String,
            default: {},
          },
          price: { type: Number, min: 0, default: null },
          mrp: { type: Number, min: 0, default: null },
          stock: { type: Number, min: 0, default: 0 },
          reservedStock: { type: Number, min: 0, default: 0 },
          active: { type: Boolean, default: true },
        },
      ],
      default: [],
    },

    viewCount: {
      type: Number,
      default: 0,
    },

    bestseller: {
      type: Boolean,
      default: false,
    },

    brand: {
      type: String,
      required: true,
    },

    // Book catalogue fields. All optional so pre-existing generic products
    // stay valid; `brand` remains the required canonical "maker" field and is
    // auto-filled from `publisher` (see the pre-validate hook below) so
    // everything keyed on brand — text index, search, CSV import, fixtures —
    // keeps working unchanged.
    author: {
      type: String,
      trim: true,
      default: "",
    },

    // Free-text biography shown under "About the author" on the product page.
    // Uncapped on purpose: a publisher-supplied bio runs anywhere from one line
    // to several paragraphs, and a maxlength here would reject the long ones
    // with a validation error the admin cannot act on. The storefront clamps it
    // visually instead.
    authorBio: {
      type: String,
      trim: true,
      default: "",
    },

    publisher: {
      type: String,
      trim: true,
      default: "",
    },

    // Product-level ISBN of the default/lead format. Per-format ISBNs live in
    // each variant's `sku`.
    isbn: {
      type: String,
      trim: true,
      default: "",
    },

    language: {
      type: String,
      trim: true,
      default: "English",
    },

    pages: {
      type: Number,
      default: 0,
      min: 0,
    },

    edition: {
      type: String,
      trim: true,
      default: "",
    },

    publicationYear: {
      type: Number,
      default: null,
    },

    image: {
      type: String,
      required: true,
    },

    images: {
      type: [String],
      default: [],
    },

    public_id: {
      type: String,
    },

    // SEO fields. The admin product form and the storefront product page both
    // already read and write these; they had no schema here, so Mongoose was
    // silently dropping whatever the admin typed.
    metaTitle: {
      type: String,
      trim: true,
      default: "",
      maxlength: 160,
    },

    metaDescription: {
      type: String,
      trim: true,
      default: "",
      maxlength: 320,
    },

    metaKeywords: {
      type: [String],
      default: [],
    },

    // Optional human-readable URL segment, stored for sitemap and future
    // slug-based routing. Indexed but deliberately not unique: the storefront
    // still routes products by id, and a unique index would turn two products
    // sharing a name into a failed create rather than a cosmetic duplicate.
    // Promote this to a unique index at the same time as slug routing.
    slug: {
      type: String,
      trim: true,
      lowercase: true,
      default: "",
    },

    // Matches an id from the season/festival catalogue (built-in or
    // admin-created) — assigned from the Season & Festival admin page.
    season: {
      type: String,
      trim: true,
      default: "",
    },

    festival: {
      type: String,
      trim: true,
      default: "",
    },

    // Shipping package attributes for this product as a single unit (i.e.
    // one item, quantity 1). Used to compute a per-order package size/weight
    // when creating a Shiprocket shipment (see order-shipping-package.js) —
    // 0 means "not set," in which case that computation falls back to the
    // SHIPROCKET_DEFAULT_* env values instead of treating it as a real zero.
    weight: {
      type: Number,
      default: 0,
      min: 0,
    },

    length: {
      type: Number,
      default: 0,
      min: 0,
    },

    breadth: {
      type: Number,
      default: 0,
      min: 0,
    },

    height: {
      type: Number,
      default: 0,
      min: 0,
    },

    // Per-product post-delivery policy, shown to shoppers on the product page
    // and enforced server-side when a return is requested (return.controller.js).
    // `kind` is nested (not a top-level `type` key) specifically to avoid
    // Mongoose's special-cased `type` keyword, which would otherwise treat
    // this whole object as "returnPolicy is of type X" instead of a
    // sub-document with its own fields.
    returnPolicy: {
      kind: {
        type: String,
        enum: ["none", "return", "replacement"],
        default: "return",
      },
      windowDays: {
        type: Number,
        default: 7,
        min: 0,
      },
    },
  },
  {
    timestamps: true,
  },
);

// `brand` is required, but book-shaped payloads send `publisher` instead —
// mirror it so validation passes and brand-based search/filtering keeps
// returning book results by publisher.
productSchema.pre("validate", function () {
  if (!this.brand && this.publisher) this.brand = this.publisher;
});

productSchema.index({ bestseller: 1, category_id: 1 });
// Matches the sort patterns actually used in product.controller.js — without
// these, both the default "relevance" search sort and the autocomplete /
// fuzzy-fallback candidate sort fall back to an in-memory sort after a full
// collection scan, even when the query itself has no filter at all.
productSchema.index({ bestseller: -1, viewCount: -1, createdAt: -1 });
productSchema.index({ viewCount: -1, createdAt: -1 });
// NOTE: adding a field to a text index does not alter an existing index in
// place — on a database that predates `author` here, drop the old text index
// once so Mongoose can recreate it (the fresh book-commerce DB builds it clean).
productSchema.index({ name: "text", brand: "text", author: "text", producthightlight: "text", description: "text" });

export default mango.model("ProductModel", productSchema, "products");
