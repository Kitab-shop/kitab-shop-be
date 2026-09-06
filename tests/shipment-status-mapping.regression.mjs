/**
 * Shiprocket status-code → order-status mapping.
 *
 * Pure logic, no database: mapOrderStatus is a total function of the courier
 * event, and the two bugs this suite exists to prevent were both in that
 * function rather than in anything it wrote.
 *
 *   NDR was unreachable. A failed delivery attempt is code 21, and Shiprocket
 *   words it "UNDELIVERED" — a string containing neither "ndr" nor
 *   "non-delivery", which were the only two things matched. So no courier event
 *   ever produced the "NDR" status, and ResolveNdr refuses any order that is not
 *   already at NDR: the re-attempt and send-it-back actions were dead from the
 *   automatic path, with a UI that offered them.
 *
 *   RTO arrival was keyed to the wrong number. The code checked was 43, which is
 *   SELF FULFILLED; RTO DELIVERED is 10. It appeared to work only because every
 *   test and most couriers also send readable text — and in the other direction a
 *   self-fulfilled shipment would have been booked as a returned parcel, recording
 *   a refund liability against an order that was delivered and paid for.
 *
 * The through-line for both: a numeric code is the reliable half of the payload
 * and the text is the fallback, not the other way round. Each case below is
 * asserted TWICE — once on the code with no text at all, and once on the text with
 * no code — so neither half can silently start carrying the mapping alone again.
 *
 * Run with `npm run test:shipment-status-mapping` (or `npm test` for everything).
 */
import { createSuite } from "./helpers.mjs";

const { ok, section, finish } = createSuite("shipment-status-mapping");

const { mapOrderStatus, isRtoReceived, SHIPMENT_EXCEPTIONS } = await import(
  "../src/modules/shipping/shipping.controller.js"
);

// ─────────────────────────────────────────────────────────────────────────────
section("1 — a failed delivery reaches NDR");

ok("code 21 alone maps to NDR", mapOrderStatus(21, "") === "NDR", String(mapOrderStatus(21, "")));
ok(
  'Shiprocket\'s own wording "UNDELIVERED" maps to NDR with no code',
  mapOrderStatus(null, "UNDELIVERED") === "NDR",
  String(mapOrderStatus(null, "UNDELIVERED")),
);
ok(
  "the code wins even when the text is one a courier invented",
  mapOrderStatus(21, "Delivery attempt failed") === "NDR",
);
ok('the older "NDR" text still maps', mapOrderStatus(null, "NDR") === "NDR");
ok('"Non-Delivery Report" still maps', mapOrderStatus(null, "Non-Delivery Report") === "NDR");

// ─────────────────────────────────────────────────────────────────────────────
section("2 — RTO arrival is code 10, and 43 is not an RTO at all");

ok("code 10 alone is an RTO arrival", isRtoReceived(10, ""), String(mapOrderStatus(10, "")));
ok("code 10 maps to RTO Received", mapOrderStatus(10, "") === "RTO Received");
ok(
  "43 (SELF FULFILLED) is NOT an RTO arrival",
  !isRtoReceived(43, ""),
  "43 must never book a refund liability against a delivered order",
);
ok("43 with no RTO text maps to nothing", mapOrderStatus(43, "") === null, String(mapOrderStatus(43, "")));
ok(
  "text still carries it for couriers whose code differs",
  isRtoReceived(null, "RTO DELIVERED") && mapOrderStatus(null, "RTO_RECEIVED") === "RTO Received",
);

// ─────────────────────────────────────────────────────────────────────────────
section("3 — the RTO journey before arrival stays at RTO");

for (const [code, label] of [
  [9, "RTO INITIATED"],
  [14, "RTO ACKNOWLEDGED"],
  [40, "RTO NDR"],
  [41, "RTO OFD"],
  [46, "RTO IN TRANSIT"],
]) {
  ok(
    `code ${code} (${label}) maps to RTO, not RTO Received`,
    mapOrderStatus(code, "") === "RTO",
    String(mapOrderStatus(code, "")),
  );
}
ok(
  "an in-transit RTO never restocks or refunds — only arrival does",
  ![9, 14, 40, 41, 46].some((code) => isRtoReceived(code, "")),
);

// ─────────────────────────────────────────────────────────────────────────────
section("4 — the forward journey is unchanged");

ok("7 is Delivered", mapOrderStatus(7, "") === "Delivered");
ok("17 is Out For Delivery", mapOrderStatus(17, "") === "Out For Delivery");
for (const code of [6, 18, 19, 27, 38, 42]) {
  ok(`${code} is Shipped`, mapOrderStatus(code, "") === "Shipped", String(mapOrderStatus(code, "")));
}
ok('"Ready To Ship" text is Packed', mapOrderStatus(null, "Ready To Ship") === "Packed");

// ─────────────────────────────────────────────────────────────────────────────
section("5 — exception codes map to no status, deliberately");

for (const [code, meaning] of Object.entries(SHIPMENT_EXCEPTIONS)) {
  ok(
    `${code} (${meaning}) writes no status`,
    mapOrderStatus(Number(code), "") === null,
    String(mapOrderStatus(Number(code), "")),
  );
}
ok(
  "8 and 45 in particular never become Cancelled — that carries restock and refund work",
  mapOrderStatus(8, "") === null && mapOrderStatus(45, "") === null,
);
ok(
  "but they are named, so the log can say what happened",
  Boolean(SHIPMENT_EXCEPTIONS[8] && SHIPMENT_EXCEPTIONS[12] && SHIPMENT_EXCEPTIONS[45]),
);

// ─────────────────────────────────────────────────────────────────────────────
section("6 — an unknown event is inert, not an error");

ok("an unmapped code returns null", mapOrderStatus(9999, "") === null);
ok("a missing payload returns null", mapOrderStatus(null, null) === null);
ok("an empty event returns null", mapOrderStatus(undefined, undefined) === null);

const summary = finish();
process.exit(summary.failed > 0 ? 1 : 0);
