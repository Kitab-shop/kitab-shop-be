import mongoose from "mongoose";

const referralSettingSchema = new mongoose.Schema(
  {
    signupDiscountType: {
      type: String,
      enum: ['fixed', 'percentage'],
      default: 'fixed'
    },
    signupDiscountAmount: {
      type: Number,
      required: true,
      default: 150,
      min: 0,
    },
    referrerRewardAmount: {
      type: Number,
      required: true,
      default: 100,
      min: 0,
    },
    singletonId: {
      type: String,
      default: "default",
      unique: true,
      index: true,
    }
  },
  {
    timestamps: true,
  }
);

// upsert, not findOne-then-create: the latter races if two requests hit this
// concurrently before the singleton exists yet (e.g. React StrictMode's
// double-invoked mount effect), and the loser's create() throws E11000.
referralSettingSchema.statics.getSettings = async function() {
  return this.findOneAndUpdate(
    { singletonId: "default" },
    { $setOnInsert: { singletonId: "default" } },
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
  );
};

export default mongoose.model("ReferralSetting", referralSettingSchema);
