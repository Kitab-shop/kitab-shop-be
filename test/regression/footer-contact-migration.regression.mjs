/**
 * The stored footer still held the old Kitab Shop contact block, which the site and
 * every bill of supply read. migrateLegacyFooterContact replaces only fields that
 * still hold those old values, once, and never an admin's own.
 *
 * FooterSetting is a singleton, so this suite runs in its OWN throwaway database and
 * drops it afterwards — the developer's footer is never touched.
 *
 * Run with `npm run test:footer-contact-migration` (or `npm test`).
 */
import "./helpers.mjs";
import mongoose from "mongoose";
import { createSuite, isLoopbackMongoUri, mongoUri } from "./helpers.mjs";

const { ok, section, finish } = createSuite("footer-contact-migration");

const base = mongoUri();
if (!base || !isLoopbackMongoUri(base)) throw new Error("This suite only runs against a local MongoDB.");
const DB = `footer-migration-${process.pid}`;
await mongoose.connect(base.replace(/\/([^/?]*)(\?|$)/, `/${DB}$2`));
if (mongoose.connection.name !== DB) throw new Error(`refusing: connected to ${mongoose.connection.name}`);

const FooterSetting = (await import("../../src/modules/footer/FooterSetting.model.js")).default;
const { sellerSnapshot } = await import("../../src/modules/orders/bill-number.service.js");
const { migrateLegacyFooterContact } = await import("../../src/modules/footer/footer-contact-migration.js");

// Exactly what production served on 2026-10-28.
const LIVE_LEGACY = {
  phone: "+91 98XXX XXXXX",
  email: "support@kitabshop.com",
  address: "Kitab Shop Commerce Pvt. Ltd.\nIDPL, Rishikesh,\nUttarakhand 249201",
  mapUrl: "https://www.google.com/maps/search/?api=1&query=IDPL+Rishikesh+Uttarakhand",
};

try {
  section("1 — the live Kitab Shop record is corrected");
  {
    await FooterSetting.collection.insertOne({ contact: { ...LIVE_LEGACY }, newsletterEnabled: true });
    const replaced = await migrateLegacyFooterContact();
    const after = (await FooterSetting.findOne().lean()).contact;
    ok("email, address and map link are all replaced", replaced.sort().join() === "address,email,mapUrl", replaced.join());
    ok("email is support@rivermossbooks.com", after.email === "support@rivermossbooks.com", after.email);
    ok("address is the New Delhi one", after.address.includes("143, 3rd Floor, Hari Nagar Ashram") && after.address.includes("New Delhi 110014"), after.address);
    ok("map link points at New Delhi", after.mapUrl.includes("New+Delhi"), after.mapUrl);
    ok("the phone is left alone (it is not an address detail)", after.phone === LIVE_LEGACY.phone);
    const seller = await sellerSnapshot();
    ok("a bill issued now carries the New Delhi seller details", JSON.stringify(seller).includes("New Delhi 110014") && !JSON.stringify(seller).includes("Rishikesh"), JSON.stringify(seller));
  }

  section("2 — it is safe to run on every start");
  {
    const before = await FooterSetting.findOne().lean();
    const replaced = await migrateLegacyFooterContact();
    const after = await FooterSetting.findOne().lean();
    ok("a second run changes nothing", replaced.length === 0 && JSON.stringify(before.contact) === JSON.stringify(after.contact));
  }

  section("3 — an admin's own details are never overwritten");
  {
    await FooterSetting.updateOne({}, { $set: { "contact.email": "orders@rivermossbooks.com", "contact.address": "Rivermoss Books\nSome other street" } });
    const replaced = await migrateLegacyFooterContact();
    const after = (await FooterSetting.findOne().lean()).contact;
    ok("nothing is replaced", replaced.length === 0);
    ok("the admin's email stays", after.email === "orders@rivermossbooks.com");
    ok("the admin's address stays", after.address === "Rivermoss Books\nSome other street");
  }

  section("4 — no footer record at all is fine");
  {
    await FooterSetting.deleteMany({});
    ok("it does nothing and does not throw", (await migrateLegacyFooterContact()).length === 0);
  }
} finally {
  await mongoose.connection.db.dropDatabase();
  const { failed } = finish();
  await mongoose.disconnect();
  process.exit(failed ? 1 : 0);
}
