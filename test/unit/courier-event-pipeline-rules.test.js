import test from "node:test";
import assert from "node:assert/strict";
import {
  canTransitionOrderStatus,
  resolveCourierPath,
} from "../../src/modules/orders/order-status.rules.js";
import {
  extractCourierEventTime,
  parseCourierTimestamp,
} from "../../src/modules/shipping/courier-event-time.js";

const NOW = Date.UTC(2026, 9, 10, 12, 0, 0);
const hopsOf = (from, to) => resolveCourierPath(from, to)?.map((hop) => hop.to) ?? null;

test("a direct legal move is a single hop", () => {
  assert.deepEqual(hopsOf("Shipped", "Delivered"), ["Delivered"]);
  assert.deepEqual(hopsOf("Confirmed", "Shipped"), ["Shipped"]);
  assert.deepEqual(hopsOf("NDR", "Out For Delivery"), ["Out For Delivery"]);
});

test("already there is an empty path, not a refusal", () => {
  assert.deepEqual(resolveCourierPath("Delivered", "Delivered"), []);
});

test("a missed Shipped event is bridged, and only through Shipped", () => {
  assert.deepEqual(hopsOf("Confirmed", "Delivered"), ["Shipped", "Delivered"]);
  assert.deepEqual(hopsOf("Packed", "Out For Delivery"), ["Shipped", "Out For Delivery"]);
  assert.deepEqual(hopsOf("Packed", "NDR"), ["Shipped", "NDR"]);
});

test("RTO Received is reached only through RTO", () => {
  assert.deepEqual(hopsOf("Shipped", "RTO Received"), ["RTO", "RTO Received"]);
  assert.deepEqual(hopsOf("NDR", "RTO Received"), ["RTO", "RTO Received"]);
  assert.deepEqual(hopsOf("Packed", "RTO Received"), ["Shipped", "RTO", "RTO Received"]);
  assert.deepEqual(hopsOf("RTO", "RTO Received"), ["RTO Received"]);
});

test("every hop of every bridged path is individually legal", () => {
  const sources = ["Confirmed", "Packed", "Shipped", "Out For Delivery", "NDR", "RTO"];
  const targets = ["Shipped", "Out For Delivery", "Delivered", "NDR", "RTO", "RTO Received"];
  for (const from of sources) {
    for (const to of targets) {
      const path = resolveCourierPath(from, to);
      if (!path) continue;
      let current = from;
      for (const hop of path) {
        assert.equal(hop.from, current, `${from}→${to} is contiguous`);
        assert.ok(canTransitionOrderStatus(hop.from, hop.to).ok, `${hop.from}→${hop.to} is legal`);
        current = hop.to;
      }
      if (path.length) assert.equal(current, to);
    }
  }
});

test("a courier can never move an unpaid, delivered or finished order", () => {
  assert.equal(resolveCourierPath("Pending", "Shipped"), null);
  assert.equal(resolveCourierPath("Pending", "Packed"), null);
  assert.equal(resolveCourierPath("Delivered", "RTO"), null);
  assert.equal(resolveCourierPath("Delivered", "RTO Received"), null);
  for (const terminal of ["Cancelled", "Closed", "Completed"]) {
    assert.equal(resolveCourierPath(terminal, "Delivered"), null, terminal);
  }
});

test("nothing walks backwards", () => {
  assert.equal(resolveCourierPath("Out For Delivery", "Shipped"), null);
  assert.equal(resolveCourierPath("Shipped", "Packed"), null);
  assert.equal(resolveCourierPath("RTO", "Delivered"), null);
  assert.equal(resolveCourierPath("RTO", "Shipped"), null);
});

test("Shiprocket's day-first webhook timestamp is read as IST", () => {
  const at = parseCourierTimestamp("23 05 2025 11:43:52", { now: NOW });
  assert.equal(at.toISOString(), "2025-05-23T06:13:52.000Z");
});

test("scan dates are read as IST, seconds optional", () => {
  assert.equal(
    parseCourierTimestamp("2025-05-23 11:43:52", { now: NOW }).toISOString(),
    "2025-05-23T06:13:52.000Z",
  );
  assert.equal(
    parseCourierTimestamp("2025-05-23T11:43", { now: NOW }).toISOString(),
    "2025-05-23T06:13:00.000Z",
  );
});

test("ISO is accepted only with an explicit zone", () => {
  assert.equal(
    parseCourierTimestamp("2025-05-23T06:13:52Z", { now: NOW }).toISOString(),
    "2025-05-23T06:13:52.000Z",
  );
  assert.equal(
    parseCourierTimestamp("2025-05-23T11:43:52+05:30", { now: NOW }).toISOString(),
    "2025-05-23T06:13:52.000Z",
  );
});

test("junk, impossible dates and implausible times are refused, never guessed", () => {
  for (const value of [
    "",
    null,
    undefined,
    "yesterday",
    "05 06 2024",
    "May 6 2024 10:00",
    "31 02 2025 10:00:00",
    "2025-13-01 10:00:00",
    "2019-12-31 23:00:00",
    "2026-10-11 12:00:00",
  ]) {
    assert.equal(parseCourierTimestamp(value, { now: NOW }), null, String(value));
  }
});

test("the latest scan wins over current_timestamp", () => {
  const at = extractCourierEventTime(
    {
      current_timestamp: "01 01 2025 10:00:00",
      scans: [
        { date: "2025-01-02 09:00:00" },
        { date: "2025-01-03 08:00:00" },
        { date: "not a date" },
      ],
    },
    { now: NOW },
  );
  assert.equal(at.toISOString(), "2025-01-03T02:30:00.000Z");
});

test("with no usable scan, current_timestamp is used; with neither, null", () => {
  assert.equal(
    extractCourierEventTime({ current_timestamp: "01 01 2025 10:00:00", scans: [] }, { now: NOW })
      .toISOString(),
    "2025-01-01T04:30:00.000Z",
  );
  assert.equal(extractCourierEventTime({}, { now: NOW }), null);
});
