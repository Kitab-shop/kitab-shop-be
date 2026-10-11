import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeTracking,
  toCustomerTracking,
} from "../../src/modules/shipping/tracking-normalize.js";

const NOW = Date.UTC(2026, 9, 10, 12, 0, 0);

const trackingData = {
  track_status: 1,
  shipment_status: 7,
  shipment_track: [
    {
      awb_code: "AWB123",
      courier_name: "Delhivery",
      current_status: "Delivered",
      consignee_name: "Private Person",
      destination: "Pune",
    },
  ],
  shipment_track_activities: [
    { date: "2026-10-01 10:00:00", activity: "Picked up", location: "Delhi", "sr-status-label": "PICKED UP" },
    { date: "2026-10-03 18:30:00", activity: "Delivered", location: "Pune", "sr-status-label": "DELIVERED" },
    { date: "garbage", activity: "Manifested", location: "", status: "MANIFESTED" },
  ],
  etd: "2026-10-04 00:00:00",
};

test("bare tracking_data is normalised", () => {
  const result = normalizeTracking({ tracking_data: trackingData }, { awbCode: "AWB123", now: NOW });
  assert.equal(result.hasTracking, true);
  assert.equal(result.statusCode, 7);
  assert.equal(result.currentStatus, "Delivered");
  assert.equal(result.courierName, "Delhivery");
  assert.equal(result.eventAt.toISOString(), "2026-10-03T13:00:00.000Z");
  assert.equal(result.activities[0].activity, "Delivered", "newest first");
  assert.equal(result.activities.at(-1).at, null, "undated last");
  assert.equal(result.activities.at(-1).location, null, "blank becomes null");
});

test("AWB-keyed responses are unwrapped", () => {
  const keyed = normalizeTracking({ AWB123: { tracking_data: trackingData } }, { awbCode: "AWB123", now: NOW });
  assert.equal(keyed.statusCode, 7);
  const unknownKey = normalizeTracking({ OTHER: { tracking_data: trackingData } }, { now: NOW });
  assert.equal(unknownKey.statusCode, 7);
});

test("no tracking yet is empty, never a status", () => {
  const result = normalizeTracking({ tracking_data: { track_status: 0, shipment_status: 0 } }, { now: NOW });
  assert.equal(result.hasTracking, false);
  assert.equal(result.statusCode, null);
  assert.equal(result.currentStatus, null);
});

test("unrecognised shapes are empty", () => {
  for (const response of [null, "error", [], { message: "Invalid AWB" }, { a: 1, b: 2 }]) {
    const result = normalizeTracking(response, { now: NOW });
    assert.equal(result.hasTracking, false);
    assert.deepEqual(result.activities, []);
  }
});

test("the customer view carries no consignee details", () => {
  const view = toCustomerTracking(normalizeTracking({ tracking_data: trackingData }, { now: NOW }));
  assert.deepEqual(Object.keys(view).sort(), ["activities", "courierName", "currentStatus", "etd"]);
  assert.ok(!JSON.stringify(view).includes("Private Person"));
});
