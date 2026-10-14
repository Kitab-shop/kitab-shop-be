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
    // Empty by default so SHIPROCKET_PICKUP_LOCATION applies; "Primary" is the final
    // fallback in getShiprocketCredentials. (It used to default to "Primary" here, which
    // stored the default as if chosen and hid the .env value.)
    pickupLocation: { type: String, trim: true, default: "" },
    pickupPostcode: { type: String, trim: true, default: "" },
    webhookToken: { type: String, default: "" },
    // Use Shiprocket for shipments at all: create shipment, assign AWB, book pickup,
    // print label/invoice. Off = manual fulfilment via the order page's own "Record
    // shipment" flow, even where SHIPROCKET_ENABLED is true.
    shipmentsEnabled: { type: Boolean, default: true },
    // Create the Shiprocket shipment automatically once an order is confirmed, rather
    // than waiting for an admin to click Create Shipment.
    autoPushEnabled: { type: Boolean, default: true },
    // Once an auto-pushed shipment is created, also assign its AWB (courier) straight
    // away, so the customer has a tracking number without waiting for an admin click.
    //
    // Defaults to FALSE for the same reason as reverseShipmentsEnabled: assigning an AWB
    // books a courier and Shiprocket deducts the freight from the wallet at that moment,
    // so an existing deployment must not start doing it on deploy.
    autoAwbEnabled: { type: Boolean, default: false },
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
    // After booking a return pickup / replacement, also ask Shiprocket to assign its AWB
    // (`/courier/assign/awb` with `is_return: 1`). OFF by default and labelled
    // experimental: the `is_return` flag is not contractually documented to us, and a
    // wrong assumption here would fail quietly. With it off, AWBs arrive through the
    // reconciler's sync or are recorded by hand — both of which are verified paths.
    reverseAutoAwbEnabled: { type: Boolean, default: false },
    defaultLengthCm: { type: Number, default: 10, min: 0 },
    defaultBreadthCm: { type: Number, default: 10, min: 0 },
    defaultHeightCm: { type: Number, default: 10, min: 0 },
    defaultWeightKg: { type: Number, default: 0.5, min: 0 },
    // ── Reconciliation (shipping-reconciliation.service.js) ────────────────────
    // The webhook is the primary source of courier truth; the reconciler is the
    // safety net for what it misses — a stalled order, a courier cancellation that
    // timed out, an auto-push that failed. On by default because it only ever reads
    // tracking and retries operations already deemed safe to retry; it never books a
    // courier the store did not already ask for. Bounds are enforced on save so a
    // typo cannot turn the poller into a hammer on Shiprocket's API.
    reconciliationEnabled: { type: Boolean, default: true },
    reconcileIntervalMinutes: { type: Number, default: 15, min: 5, max: 1440 },
    // An order with no courier update for this long gets its tracking polled.
    trackingStaleMinutes: { type: Number, default: 360, min: 30, max: 10080 },
    // Courier cancellation and auto-push retries stop here and become exceptions.
    maxRetryAttempts: { type: Number, default: 5, min: 1, max: 20 },
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
