import assert from "node:assert/strict";
import test from "node:test";
import { lookupPincode } from "../../src/modules/geo/pincode.service.js";

test("lookupPincode resolves district, state and localities", () => {
  const details = lookupPincode("110001");
  assert.equal(details.district, "New Delhi");
  assert.equal(details.state, "Delhi");
  assert.equal(details.city, "New Delhi");
  assert.ok(details.localities.includes("Connaught Place"));
});

test("lookupPincode suggests a city where the district name is not one", () => {
  assert.equal(lookupPincode("560001").city, "Bengaluru");
  assert.equal(lookupPincode("110017").city, "Delhi");
});

test("lookupPincode maps renamed UTs onto the canonical state list", () => {
  assert.equal(lookupPincode("396210").state, "Dadra and Nagar Haveli and Daman and Diu");
});

test("lookupPincode returns null for malformed or unknown PIN codes", () => {
  assert.equal(lookupPincode("012345"), null);
  assert.equal(lookupPincode("11000"), null);
  assert.equal(lookupPincode("999999"), null);
});
