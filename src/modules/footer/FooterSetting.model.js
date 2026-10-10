import mongoose from "mongoose";

const FooterLinkSchema = new mongoose.Schema(
  {
    label: {
      type: String,
      required: true,
      trim: true,
    },
    to: {
      type: String,
      required: true,
      trim: true,
    },
    position: {
      type: Number,
      default: 0,
    },
    enabled: {
      type: Boolean,
      default: true,
    },
  },
  { _id: true },
);

const FooterSectionSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
    },
    position: {
      type: Number,
      default: 0,
    },
    enabled: {
      type: Boolean,
      default: true,
    },
    links: {
      type: [FooterLinkSchema],
      default: [],
    },
  },
  { _id: true },
);

const FooterTrustBadgeSchema = new mongoose.Schema(
  {
    label: {
      type: String,
      required: true,
      trim: true,
    },
    icon: {
      type: String,
      enum: ["shield", "truck", "return", "verified"],
      default: "shield",
    },
    position: {
      type: Number,
      default: 0,
    },
    enabled: {
      type: Boolean,
      default: true,
    },
  },
  { _id: true },
);

const FooterSettingSchema = new mongoose.Schema(
  {
    sections: {
      type: [FooterSectionSchema],
      default: [],
    },
    trustBadges: {
      type: [FooterTrustBadgeSchema],
      default: [],
    },
    contact: {
      phone: {
        type: String,
        default: "+91 98XXX XXXXX",
        trim: true,
      },
      email: {
        type: String,
        default: "support@rivermossbooks.com",
        trim: true,
      },
      address: {
        type: String,
        default: "Rivermoss Books\nIDPL, Rishikesh,\nUttarakhand 249201",
        trim: true,
      },
      mapUrl: {
        type: String,
        default: "https://www.google.com/maps/search/?api=1&query=IDPL+Rishikesh+Uttarakhand",
        trim: true,
      },
    },
    newsletterEnabled: {
      type: Boolean,
      default: true,
    },
    lastEditedByAdminId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "UserAuthenticationModel",
    },
  },
  { timestamps: true },
);

export default mongoose.model("FooterSetting", FooterSettingSchema);
