/**
 * Minimal harness for the money/inventory regression suites.
 *
 * These tests run against the REAL database rather than mocks, because every bug
 * they cover was an atomicity or concurrency bug — a unique index race, a
 * compare-and-swap filter, a transaction retry. A mock would have happily passed
 * the broken code. Everything created is namespaced per-process and deleted in a
 * finally block.
 */
import "dotenv/config";
import mongoose from "mongoose";

export const mongoUri = () =>
  process.env.mango_url ||
  process.env.mongo_url ||
  process.env.MONGO_URI ||
  process.env.MONGODB_URI ||
  process.env.MONGO_URL;

export const connect = async () => {
  const uri = mongoUri();
  if (!uri) throw new Error("No MongoDB connection string in the environment");
  await mongoose.connect(uri);
  return mongoose;
};

export const createSuite = (title) => {
  let passed = 0;
  const failures = [];

  const section = (name) => console.log(`\n${name}`);

  const ok = (label, condition, detail = "") => {
    if (condition) {
      passed += 1;
      console.log(`  ok   ${label}`);
    } else {
      failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
      console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
    }
  };

  const finish = () => {
    console.log(`\n${title}: ${passed} passed, ${failures.length} failed`);
    failures.forEach((f) => console.log(`  - ${f}`));
    return { passed, failed: failures.length };
  };

  return { ok, section, finish };
};

/** Per-process namespace, so parallel runs and leftovers never collide. */
export const marker = (prefix) => `${prefix}-${process.pid}`;

export const addressFixture = () => ({
  fullName: "Regression Test",
  phone: "9999999999",
  address: "1 Test Street",
  city: "Pune",
  state: "Maharashtra",
  pincode: "411001",
  country: "India",
});

/** A product that satisfies every required field in ProductModel. */
export const productFixture = (name, overrides = {}) => ({
  category_id: new mongoose.Types.ObjectId(),
  name,
  description: "regression fixture",
  image: "fixture.png",
  brand: "Fixture",
  producthightlight: "fixture",
  price: 500,
  stock: 10,
  ...overrides,
});

/**
 * Pins Shiprocket capabilities for the duration of a suite.
 *
 * `getShippingCapabilities()` reads the ShiprocketSetting singleton, which is a document a
 * real admin edits from the panel. Any suite that drives a shipment path and does NOT pin
 * this inherits whatever the store happens to be configured as — so choosing "Shiprocket
 * basics" in the admin UI made three suites fail, correctly reporting that shipments were
 * no longer being auto-pushed. The tests were wrong to depend on it, not the admin.
 *
 * Stubs the model's static rather than writing to the document, so a suite can never alter
 * the running store's configuration. Returns a restore function.
 */
export const pinShiprocketCapabilities = async (overrides = {}) => {
  const ShiprocketSetting = (await import("../../src/modules/shipping/ShiprocketSetting.model.js"))
    .default;
  const real = ShiprocketSetting.getSettings;
  const pinned = {
    email: "pinned@example.test",
    password: "pinned-password",
    pickupLocation: "Primary",
    pickupPostcode: "411001",
    webhookToken: process.env.SHIPROCKET_WEBHOOK_TOKEN || "stub-webhook-token",
    shipmentsEnabled: true,
    autoPushEnabled: true,
    deliveryWebhookEnabled: true,
    // The one capability that defaults off: pinned off too, so a suite must opt in
    // explicitly rather than inherit courier bookings it never asked for.
    reverseShipmentsEnabled: false,
    defaultLengthCm: 10,
    defaultBreadthCm: 10,
    defaultHeightCm: 10,
    defaultWeightKg: 0.5,
    ...overrides,
  };
  ShiprocketSetting.getSettings = async () => ({ ...pinned });
  return () => {
    ShiprocketSetting.getSettings = real;
  };
};
