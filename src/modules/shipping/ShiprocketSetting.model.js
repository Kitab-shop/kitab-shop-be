import mongoose from "mongoose";

// Admin-editable Shiprocket configuration — credentials, pickup details, and
// default package dimensions. Lets an admin configure/rotate these from the
// admin panel instead of a developer editing .env and restarting the server.
//
// The three capability flags below decide HOW MUCH of Shiprocket the store uses. They
// do not replace the .env switches — they narrow them. Effective capability is
// `env AND db`: .env still decides whether Shiprocket is permitted in this environment
// at all (the ops kill switch, unchanged), and these decide which parts of it the
// business actually wants day to day. Each defaults to true, so effective behaviour
// equals the old env-only behaviour until an admin deliberately narrows it — adding
// these fields changes nothing about an existing deployment.
const shiprocketSettingSchema = new mongoose.Schema(
  {
    email: { type: String, trim: true, default: "" },
    password: { type: String, default: "" },
    pickupLocation: { type: String, trim: true, default: "Primary" },
    pickupPostcode: { type: String, trim: true, default: "" },
    webhookToken: { type: String, default: "" },
    // Use Shiprocket for shipments at all: create shipment, assign AWB, book pickup,
    // print label/invoice. Off = manual fulfilment via the order page's own "Record
    // shipment" flow, even where SHIPROCKET_ENABLED is true.
    shipmentsEnabled: { type: Boolean, default: true },
    // Create the Shiprocket shipment automatically once an order is confirmed, rather
    // than waiting for an admin to click Create Shipment.
    autoPushEnabled: { type: Boolean, default: true },
    // Accept Shiprocket's status webhook. This is what advances orders to
    // Shipped/Delivered/RTO on its own and, for COD, records cash collection.
    deliveryWebhookEnabled: { type: Boolean, default: true },
    // Book return pickups and replacement parcels through Shiprocket.
    //
    // Defaults to FALSE, unlike the three above. Those describe behaviour that already
    // existed, so defaulting them true kept existing deployments identical. This one is
    // new and books REAL courier collections at customer addresses — auto-enabling it on
    // deploy would start dispatching couriers nobody asked for.
    reverseShipmentsEnabled: { type: Boolean, default: false },
    defaultLengthCm: { type: Number, default: 10, min: 0 },
    defaultBreadthCm: { type: Number, default: 10, min: 0 },
    defaultHeightCm: { type: Number, default: 10, min: 0 },
    defaultWeightKg: { type: Number, default: 0.5, min: 0 },
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

// findOne-then-create races when two requests hit this before the singleton
// exists yet (confirmed live: React 18 StrictMode double-invokes the
// fetch-on-mount effect, firing two concurrent GETs the very first time the
// Shipping settings tab is opened, and the second create() throws E11000).
// upsert is atomic per document, so only one of them ever actually inserts.
shiprocketSettingSchema.statics.getSettings = async function () {
  return this.findOneAndUpdate(
    { singletonId: "default" },
    { $setOnInsert: { singletonId: "default" } },
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
  );
};

export default mongoose.model("ShiprocketSetting", shiprocketSettingSchema);
