import mongoose from "mongoose";

// Admin-editable inventory settings. Previously LOW_STOCK_THRESHOLD lived
// only in .env, so changing it needed a developer to edit the server config
// and restart — this lets an admin adjust it directly from the panel.
const inventorySettingSchema = new mongoose.Schema(
  {
    lowStockThreshold: { type: Number, default: 5, min: 0 },
    singletonId: {
      type: String,
      default: "default",
      unique: true,
      index: true,
    },
  },
  {
    timestamps: true,
  },
);

// upsert, not findOne-then-create: the latter races if two requests hit this
// concurrently before the singleton exists yet (e.g. React StrictMode's
// double-invoked mount effect), and the loser's create() throws E11000.
inventorySettingSchema.statics.getSettings = async function () {
  // Seed the very first document from .env if it's set, so an existing
  // deployment's configured value carries over instead of silently
  // resetting to the schema default the moment this collection is created.
  const envValue = Number(process.env.LOW_STOCK_THRESHOLD);
  const seed = Number.isFinite(envValue) && envValue >= 0 ? { lowStockThreshold: envValue } : {};

  return this.findOneAndUpdate(
    { singletonId: "default" },
    { $setOnInsert: { singletonId: "default", ...seed } },
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
  );
};

export default mongoose.model("InventorySetting", inventorySettingSchema);
