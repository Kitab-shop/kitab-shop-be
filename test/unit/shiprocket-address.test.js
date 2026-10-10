import assert from "node:assert/strict";
import test from "node:test";
import { splitAddressLines } from "../../src/modules/shipping/shiprocket.service.js";

test("splitAddressLines puts locality and landmark on the second label line", () => {
  assert.deepEqual(
    splitAddressLines({
      address: "Flat 4B, Gachibowli, Near DLF",
      addressLine1: "Flat 4B",
      addressLine2: "Gachibowli",
      landmark: "DLF",
    }),
    { line1: "Flat 4B", line2: "Gachibowli, Near DLF" },
  );
});

test("splitAddressLines falls back to the joined address for older orders", () => {
  assert.deepEqual(splitAddressLines({ address: "12 MG Road" }), { line1: "12 MG Road", line2: "" });
});
