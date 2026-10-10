import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeShippingAddress,
  orderError,
} from "../../src/modules/orders/order-pricing.service.js";

test("normalizeShippingAddress accepts checkout aliases without losing fields", () => {
  const address = normalizeShippingAddress({
    name: "Aditya",
    mobile: "9876543210",
    line: "MG Road",
    city: "Delhi",
    state: "Delhi",
    pincode: "110001",
  });

  assert.deepEqual(address, {
    fullName: "Aditya",
    phone: "9876543210",
    address: "MG Road",
    addressLine1: "MG Road",
    addressLine2: "",
    landmark: "",
    district: "",
    city: "Delhi",
    state: "Delhi",
    pincode: "110001",
    country: "India",
  });
});

test("normalizeShippingAddress joins structured parts into the courier address line", () => {
  const address = normalizeShippingAddress({
    fullName: "Aditya",
    phone: "9876543210",
    addressLine1: " Flat 4B, Lotus Apartments ",
    addressLine2: "Gachibowli",
    landmark: "DLF Cyber City",
    district: "Ranga Reddy",
    city: "Hyderabad",
    state: "Telangana",
    pincode: "500032",
  });

  assert.equal(address.address, "Flat 4B, Lotus Apartments, Gachibowli, Near DLF Cyber City");
  assert.equal(address.addressLine1, "Flat 4B, Lotus Apartments");
  assert.equal(address.district, "Ranga Reddy");
});

test("orderError carries an HTTP status code", () => {
  const error = orderError("Stock unavailable", 409);
  assert.equal(error.message, "Stock unavailable");
  assert.equal(error.statusCode, 409);
});
