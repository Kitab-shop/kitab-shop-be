import assert from "node:assert/strict";
import test from "node:test";
import {
  ShiprocketError,
  computeOrderPackage,
  classifyReportedAmount,
  computeShipmentLines,
  readReportedAmounts,
  readReportedOrderTotal,
} from "../../src/modules/shipping/shiprocket.service.js";

// Paise arithmetic, so the assertions themselves are not float-approximate.
const paise = (value) => Math.round(value * 100);
/** Σ units × (selling_price − discount): what the lines say the goods are worth. */
const linesTotal = (items) =>
  items.reduce((sum, item) => sum + item.units * (paise(item.selling_price) - paise(item.discount)), 0);

const line = (product, price, quantity, cancelledQuantity = 0) => ({
  product,
  name: `Book ${product}`,
  price,
  quantity,
  cancelledQuantity,
});

test("a full, undiscounted order ships every unit at list price", () => {
  const result = computeShipmentLines({
    paymentMethod: "COD",
    items: [line("a", 200, 2), line("b", 150, 1)],
    subtotal: 550,
    shippingCharge: 50,
    discount: 0,
    totalAmount: 600,
  });
  assert.deepEqual(
    result.orderItems.map((item) => [item.sku, item.units, item.selling_price, item.discount]),
    [
      ["a", 2, 200, 0],
      ["b", 1, 150, 0],
    ],
  );
  assert.equal(result.subTotal, 550);
  assert.equal(result.totalDiscount, 0);
  assert.equal(result.shippingCharges, 50);
  assert.equal(result.codCollectable, 600);
  assert.equal(linesTotal(result.orderItems), paise(result.subTotal));
});

test("the order discount is spread onto lines, so Σ lines == sub_total and total_discount is 0", () => {
  // ₹100 coupon + ₹50 wallet on ₹1000 of goods.
  const result = computeShipmentLines({
    paymentMethod: "COD",
    items: [line("a", 300, 2), line("b", 400, 1)],
    subtotal: 1000,
    shippingCharge: 40,
    discount: 150,
    totalAmount: 890,
  });
  assert.equal(result.totalDiscount, 0);
  assert.equal(result.subTotal, 850);
  assert.equal(linesTotal(result.orderItems), paise(850));
  // Proportional: a is 60% of the goods, b 40%.
  const [a, b] = result.orderItems;
  assert.equal(a.units * a.discount, 90);
  assert.equal(b.units * b.discount, 60);
  assert.equal(result.codCollectable, 890);
  assert.equal(result.codCollectable - result.shippingCharges, result.subTotal);
});

test("a partially cancelled line ships its remaining units, and COD excludes the cancelled value", () => {
  const result = computeShipmentLines({
    paymentMethod: "COD",
    items: [line("a", 200, 3, 1), line("b", 100, 2, 2), line("c", 50, 1)],
    subtotal: 850,
    shippingCharge: 30,
    discount: 0,
    totalAmount: 880,
    cancellations: [
      { product: "a", quantity: 1, refundAmount: 200 },
      { product: "b", quantity: 2, refundAmount: 200 },
    ],
  });
  assert.deepEqual(
    result.orderItems.map((item) => [item.sku, item.units]),
    [
      ["a", 2],
      ["c", 1],
    ],
    "a fully cancelled line is dropped, a partly cancelled one ships what is left",
  );
  assert.equal(result.codCollectable, 480);
  assert.equal(result.subTotal, 450);
  assert.equal(linesTotal(result.orderItems), paise(450));
});

test("prepaid orders collect nothing at the door but still declare their value", () => {
  const result = computeShipmentLines({
    paymentMethod: "RAZORPAY",
    items: [line("a", 500, 1)],
    subtotal: 500,
    shippingCharge: 0,
    discount: 100,
    totalAmount: 400,
  });
  assert.equal(result.codCollectable, 0);
  assert.equal(result.declaredTotal, 400);
  assert.equal(result.subTotal, 400);
  assert.equal(result.orderItems[0].discount, 100);
});

test("rounding: odd-paise discounts stay exact, with the remainder on the largest line", () => {
  // ₹10.01 across three equal-value single-unit lines cannot split evenly.
  const result = computeShipmentLines({
    paymentMethod: "COD",
    items: [line("a", 100, 1), line("b", 100, 1), line("c", 101, 1)],
    subtotal: 301,
    shippingCharge: 0,
    discount: 10.01,
    totalAmount: 290.99,
  });
  assert.equal(linesTotal(result.orderItems), paise(290.99));
  const discounts = result.orderItems.map((item) => paise(item.discount));
  assert.equal(discounts.reduce((sum, value) => sum + value, 0), 1001);
  // Every value is whole paise — never 3.3366…
  assert.ok(result.orderItems.every((item) => Math.abs(item.discount * 100 - paise(item.discount)) < 1e-9));
  assert.equal(Math.max(...discounts), discounts[2], "the largest line carries the remainder");
});

test("rounding: a per-unit discount that cannot divide its units is still exact", () => {
  // One line of 2 units with a 1-paise-odd discount: impossible as 2 × d, so one unit is
  // split onto its own line.
  const result = computeShipmentLines({
    paymentMethod: "COD",
    items: [line("a", 100, 2)],
    subtotal: 200,
    shippingCharge: 0,
    discount: 15.01,
    totalAmount: 184.99,
  });
  assert.equal(linesTotal(result.orderItems), paise(184.99));
  assert.equal(
    result.orderItems.reduce((sum, item) => sum + item.units, 0),
    2,
    "no unit is lost or invented by the split",
  );
  assert.ok(result.orderItems.every((item) => item.sku === "a"));
});

test("leftover paise go to a single-unit line before any split", () => {
  const result = computeShipmentLines({
    paymentMethod: "COD",
    items: [line("a", 100, 3), line("b", 100, 1)],
    subtotal: 400,
    shippingCharge: 0,
    discount: 0.05,
    totalAmount: 399.95,
  });
  assert.equal(result.orderItems.length, 2, "no split needed");
  assert.equal(linesTotal(result.orderItems), paise(399.95));
});

test("unrepresentable orders are refused with a 409, never sent with a wrong amount", () => {
  const refuse = (order) => {
    try {
      computeShipmentLines(order);
      return null;
    } catch (error) {
      return error;
    }
  };
  const allCancelled = refuse({
    paymentMethod: "COD",
    items: [line("a", 100, 1, 1)],
    totalAmount: 100,
  });
  assert.ok(allCancelled instanceof ShiprocketError);
  assert.equal(allCancelled.statusCode, 409);

  const totalAboveGoods = refuse({
    paymentMethod: "COD",
    items: [line("a", 100, 1)],
    shippingCharge: 0,
    totalAmount: 150,
  });
  assert.equal(totalAboveGoods?.statusCode, 409);

  const negative = refuse({
    paymentMethod: "COD",
    items: [line("a", 100, 1)],
    shippingCharge: 50,
    totalAmount: 100,
    cancellations: [{ refundAmount: 80 }],
  });
  assert.equal(negative?.statusCode, 409);
});

test("computeOrderPackage measures remaining units only", () => {
  const product = { weight: 0.4, length: 20, breadth: 15, height: 3 };
  const pkg = computeOrderPackage(
    { items: [{ product, quantity: 3, cancelledQuantity: 1 }, { product, quantity: 1, cancelledQuantity: 1 }] },
    {},
  );
  assert.equal(pkg.weight, 0.8);
  assert.equal(pkg.height, 6);
});

test("readReportedOrderTotal is tolerant but never guesses", () => {
  assert.equal(readReportedOrderTotal({ data: { net_total: "1,234.50" } }), 1234.5);
  assert.equal(readReportedOrderTotal({ total: 99 }), 99);
  assert.equal(readReportedOrderTotal({ data: { cod_amount: 10 } }), 10);
  assert.equal(readReportedOrderTotal({ data: { net_total: "", total: null } }), null);
  assert.equal(readReportedOrderTotal({ data: { something: 5 } }), null);
  assert.equal(readReportedOrderTotal(null), null);
});

test("readReportedAmounts collects every amount field, and only numeric ones", () => {
  assert.deepEqual(
    readReportedAmounts({ data: { net_total: "429.00", total: 528, sub_total: "429", shipping_charges: "99", id: 7, cod_amount: "" } }),
    { net_total: 429, total: 528, sub_total: 429, shipping_charges: 99 },
  );
  assert.deepEqual(readReportedAmounts({ data: { products: [] } }), {});
  assert.deepEqual(readReportedAmounts(null), {});
});

test("classifyReportedAmount: a field holding goods + shipping is ok, whichever it is", () => {
  const verdict = classifyReportedAmount({ amounts: { net_total: 429, total: 528 }, expected: 528, goodsTotal: 429 });
  assert.deepEqual(verdict, { status: "ok", reported: 528, matchedField: "total", reason: null });
});

test("classifyReportedAmount: a goods-only figure (no shipping) warns instead of blocking", () => {
  // The live order that raised a false mismatch: ₹429 books + ₹99 shipping.
  const verdict = classifyReportedAmount({ amounts: { net_total: 429 }, expected: 528, goodsTotal: 429 });
  assert.deepEqual(verdict, { status: "unverified", reported: 429, matchedField: "net_total", reason: "goods_only_total" });
});

test("classifyReportedAmount: a figure matching neither is still a mismatch", () => {
  const verdict = classifyReportedAmount({ amounts: { net_total: 1040 }, expected: 890, goodsTotal: 850 });
  assert.deepEqual(verdict, { status: "mismatch", reported: 1040, matchedField: "net_total", reason: null });
});

test("classifyReportedAmount: without a shipping charge there is no goods-only escape", () => {
  const verdict = classifyReportedAmount({ amounts: { net_total: 250 }, expected: 300, goodsTotal: 300 });
  assert.equal(verdict.status, "mismatch");
});

test("classifyReportedAmount: on a COD order, cod_amount decides alone when present", () => {
  assert.deepEqual(
    classifyReportedAmount({ amounts: { total: 528, cod_amount: 429 }, expected: 528, goodsTotal: 429, cod: true }),
    { status: "mismatch", reported: 429, matchedField: "cod_amount", reason: null },
  );
  assert.deepEqual(
    classifyReportedAmount({ amounts: { net_total: 429, cod_amount: 528 }, expected: 528, goodsTotal: 429, cod: true }),
    { status: "ok", reported: 528, matchedField: "cod_amount", reason: null },
  );
  // Prepaid: cod_amount is just another total field.
  assert.equal(
    classifyReportedAmount({ amounts: { total: 528, cod_amount: 429 }, expected: 528, goodsTotal: 429 }).status,
    "ok",
  );
});

test("classifyReportedAmount: nothing readable, or nothing to compare with, is unverified", () => {
  assert.deepEqual(classifyReportedAmount({ amounts: { sub_total: 429 }, expected: 528, goodsTotal: 429 }), {
    status: "unverified",
    reported: null,
    matchedField: null,
    reason: "total_not_found_in_response",
  });
  assert.equal(classifyReportedAmount({ amounts: { net_total: 528 }, expected: NaN }).status, "unverified");
  assert.equal(classifyReportedAmount({ amounts: { net_total: 528.4 }, expected: 528, goodsTotal: 429 }).status, "ok");
});
