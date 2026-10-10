import mongoose from "mongoose";

const cartSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "UserAuthenticationModel",
      required: true,
      unique: true, // One cart per user
    },
    items: [
      {
        product: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "ProductModel",
          required: true,
        },
        quantity: {
          type: Number,
          default: 1,
          min: 1,
        },
        selectedVariants: {
          type: Map,
          of: String,
          default: {},
        },
        variantKey: {
          type: String,
          default: "",
        },
        price: {
          type: Number,
          min: 0,
        },
        mrp: {
          type: Number,
          min: 0,
        },
      },
    ],
  },
  {
    timestamps: true,
  },
);

// AdminGetAbandonedCarts filters a RANGE on updatedAt and sorts on the same field. With
// no index that is a collection scan plus a blocking in-memory sort, and only then the
// .limit(100) — the limit bounded what came back, not what was read. Indexed, the scan
// walks in sort order and stops at 100.
cartSchema.index({ updatedAt: 1 });

export default mongoose.model("Cart", cartSchema);
