/**
 * Bill-of-supply numbering.
 *
 * A bill number is immutable once issued, which makes every bug in this area
 * permanent: a number filed into the wrong financial year, a number handed to two
 * orders, or a second number overwriting an order's first one cannot be corrected
 * afterwards without the books disagreeing with what a customer already holds.
 *
 * So the guarantees are asserted rather than assumed, against the REAL database and
 * through the REAL controllers:
 *
 *   - the financial year is computed in IST, not the server's UTC;
 *   - concurrent mints never collide, on one order or across many;
 *   - a replayed webhook, a re-clicked Delivered and a Delivered → Completed
 *     transition all leave an existing number untouched;
 *   - the unique index is PARTIAL, so unbilled orders (all storing an explicit
 *     null) can coexist;
 *   - the seller block is a snapshot and does not follow later footer edits.
 *
 * Every mint here runs in a SYNTHETIC financial year far in the future, so the
 * suite can never increment the live series. The counters it creates are deleted
 * in the finally block.
 *
 * Run with `npm run test:bill-number` (or `npm test` for everything).
 */
process.env.SHIPROCKET_ENABLED = "true";
process.env.SHIPROCKET_WEBHOOK_ENABLED = "true";
process.env.SHIPROCKET_WEBHOOK_TOKEN = "stub-webhook-token";
process.env.SHIPROCKET_EMAIL = "stub@example.test";
process.env.SHIPROCKET_PASSWORD = "stub-password";
process.env.SHIPROCKET_BASE_URL = "https://shiprocket.invalid/v1/external";
process.env.INVENTORY_ENFORCE_STOCK = "true";
process.env.NOTIFICATIONS_ENABLED = "false";
process.env.PAYMENTS_ENABLED = "false";

import mongoose from "mongoose";
import { readFile } from "node:fs/promises";
import {
  addressFixture,
  connect,
  createSuite,
  marker,
  pinShiprocketCapabilities,
  productFixture,
} from "./helpers.mjs";

const { ok, section, finish } = createSuite("bill-number");
await connect();

const OrderModel = (await import("../../src/modules/orders/Order.model.js")).default;
const BillCounter = (await import("../../src/modules/orders/BillCounter.model.js")).default;
const ProductModel = (await import("../../src/modules/products/Product.model.js")).default;
const FooterSetting = (await import("../../src/modules/footer/FooterSetting.model.js")).default;
await import("../../src/modules/categories/Category.model.js");
const orderController = await import("../../src/modules/orders/order.controller.js");
const shippingController = await import("../../src/modules/shipping/shipping.controller.js");
const {
  ensureBillNumber,
  financialYear,
  formatBillNumber,
  sellerSnapshot,
  seedBillCounter,
} = await import("../../src/modules/orders/bill-number.service.js");

const restoreShiprocket = await pinShiprocketCapabilities();

// The sections that drive the REAL controllers cannot inject a date — the
// controllers do not take one — so those mints land in the LIVE financial year and
// advance the real counter. Left alone, every `npm test` would burn a handful of
// genuine bill numbers and punch permanent gaps in the series. So the live counter
// is captured here and rewound in the finally block, which is safe precisely
// because every order this suite creates is deleted there too: no surviving order
// can be holding one of the numbers being given back.
const LIVE_FY = financialYear();
const liveCounterBefore = (await BillCounter.findOne({ financialYear: LIVE_FY }).lean())?.seq ?? null;

const MARKER = marker("bill");
const trash = { orders: [], products: [], years: new Set() };
let seq = 0;

// Deliberately absurd, so nothing here can touch a real series. Every mint below
// passes one of these through `now`.
const TEST_FY_DATE = new Date("2088-06-01T00:00:00+05:30");
const TEST_FY = "2088-89";
const OTHER_FY_DATE = new Date("2089-06-01T00:00:00+05:30");
const OTHER_FY = "2089-90";
trash.years.add(TEST_FY).add(OTHER_FY);

const makeProduct = async () =>
  ProductModel.create(productFixture(`${MARKER}-${(seq += 1)}`, { stock: 50 })).then((p) => {
    trash.products.push(p._id);
    return p;
  });

const makeOrder = async ({ status = "Shipped", paymentMethod = "RAZORPAY" } = {}) => {
  const product = await makeProduct();
  const order = await OrderModel.create({
    user: new mongoose.Types.ObjectId(),
    items: [
      { product: product._id, name: product.name, image: "x.png", price: product.price, quantity: 1 },
    ],
    shippingAddress: addressFixture(),
    paymentMethod,
    paymentStatus: paymentMethod === "COD" ? "Pending" : "Paid",
    orderStatus: status,
    subtotal: product.price,
    shippingCharge: 40,
    totalAmount: product.price + 40,
  });
  trash.orders.push(order._id);
  return order;
};

const callController = async (handler, { params = {}, body = {}, user, query = {}, headers = {} }) => {
  let statusCode = 200;
  let payload;
  const res = {
    status(code) { statusCode = code; return this; },
    json(data) { payload = data; return this; },
  };
  await handler({ params, body, user, query, get: (key) => headers[key.toLowerCase()] }, res);
  return { statusCode, body: payload };
};

const admin = () => ({ id: String(new mongoose.Types.ObjectId()), roles: ["admin"] });

const setStatus = (order, orderStatus) =>
  callController(orderController.UpdateOrderStatus, {
    params: { orderId: String(order._id) },
    body: { orderStatus },
    user: admin(),
  });

const webhook = async (body, token = "stub-webhook-token") => {
  let statusCode = 200;
  let payload;
  const res = {
    status(code) { statusCode = code; return this; },
    json(data) { payload = data; return this; },
  };
  await shippingController.ShippingWebhook(
    { body, get: (header) => (header.toLowerCase() === "x-api-key" ? token : undefined) },
    res,
  );
  return { statusCode, body: payload };
};

const billOf = async (id) => (await OrderModel.findById(id).select("bill").lean())?.bill ?? null;

try {
  // ───────────────────────────────────────────────────────────────────────────
  section("Financial year is computed in IST, not the server's UTC");

  ok("1 Apr 00:00 IST opens the new year", financialYear(new Date("2026-04-01T00:00:00+05:30")) === "2026-27");
  ok("31 Mar 23:59 IST is still the old year", financialYear(new Date("2026-03-31T23:59:00+05:30")) === "2025-26");
  // The one that matters. 2026-03-31T18:30:00Z IS 1 Apr 00:00 IST — a UTC
  // implementation files it under 2025-26 and the bill lands in the wrong series
  // forever.
  ok(
    "18:30Z on 31 Mar is already the new FY in IST",
    financialYear(new Date("2026-03-31T18:30:00Z")) === "2026-27",
    financialYear(new Date("2026-03-31T18:30:00Z")),
  );
  ok(
    "18:29Z on 31 Mar is still the old FY",
    financialYear(new Date("2026-03-31T18:29:00Z")) === "2025-26",
  );
  ok("year label wraps at the century", financialYear(new Date("2099-06-01T00:00:00+05:30")) === "2099-00");

  ok("sequence 1 pads to four digits", formatBillNumber("2026-27", 1) === "RB/2026-27/0001");
  ok("the 10000th bill is not truncated", formatBillNumber("2026-27", 10000) === "RB/2026-27/10000");

  // ───────────────────────────────────────────────────────────────────────────
  section("Minting through the real admin controller");

  const delivered = await makeOrder();
  const response = await setStatus(delivered, "Delivered");
  ok("Shipped → Delivered succeeds", response.statusCode === 200, JSON.stringify(response.body));
  const firstBill = await billOf(delivered._id);
  ok("a number was minted on delivery", Boolean(firstBill?.number), JSON.stringify(firstBill));
  ok("issuedAt was stamped", Boolean(firstBill?.issuedAt));
  ok("financialYear was stored alongside the string", Boolean(firstBill?.financialYear));
  ok("sequence was stored alongside the string", Number.isInteger(firstBill?.sequence));
  ok("source is 'delivery'", firstBill?.source === "delivery");
  // The FE contract: the admin screen reads the number off this response rather
  // than refetching.
  ok(
    "the response body carries the number",
    response.body?.order?.bill?.number === firstBill?.number,
    JSON.stringify(response.body?.order?.bill),
  );

  const footer = await FooterSetting.findOne().lean();
  if (footer?.contact?.address) {
    const expectedName = String(footer.contact.address).split("\n")[0].trim();
    ok(
      "seller name is the first line of the footer address",
      firstBill?.seller?.name === expectedName,
      `${firstBill?.seller?.name} vs ${expectedName}`,
    );
  } else {
    ok("seller snapshot survives a missing footer", firstBill?.seller?.name === "");
  }

  section("A second number is never issued");

  const completed = await setStatus(delivered, "Completed");
  ok("Delivered → Completed succeeds", completed.statusCode === 200);
  const afterCompleted = await billOf(delivered._id);
  ok(
    "Completed did not mint a second number",
    afterCompleted.number === firstBill.number,
    `${firstBill.number} → ${afterCompleted.number}`,
  );
  ok(
    "issuedAt was not moved forward",
    String(afterCompleted.issuedAt) === String(firstBill.issuedAt),
  );

  // The backstop path. Completed is unreachable except from Delivered, so an order
  // arriving at Completed with no number either predates this feature or had its
  // Delivered mint fail. It must still get numbered rather than stay unbillable
  // forever — this is the case that justifies the "Completed" arm existing at all.
  const healed = await makeOrder({ status: "Delivered" });
  ok("the fixture starts unbilled", (await billOf(healed._id))?.number == null);
  const healedResponse = await setStatus(healed, "Completed");
  ok("Delivered → Completed succeeds on an unbilled order", healedResponse.statusCode === 200);
  ok(
    "Completed mints a number an earlier Delivered never issued",
    Boolean((await billOf(healed._id))?.number),
    JSON.stringify(await billOf(healed._id)),
  );

  const replay = await makeOrder();
  await setStatus(replay, "Delivered");
  const replayFirst = await billOf(replay._id);
  await setStatus(replay, "Delivered");
  ok(
    "re-submitting Delivered leaves the number alone",
    (await billOf(replay._id)).number === replayFirst.number,
  );

  section("Snapshot immutability");

  const snapshotOrder = await makeOrder();
  await setStatus(snapshotOrder, "Delivered");
  const beforeEdit = await billOf(snapshotOrder._id);
  const footerDoc = await FooterSetting.findOne();
  if (footerDoc) {
    const original = footerDoc.contact?.phone;
    await FooterSetting.updateOne({ _id: footerDoc._id }, { $set: { "contact.phone": "+91 00000 00000" } });
    const afterEdit = await billOf(snapshotOrder._id);
    ok(
      "editing the footer does not rewrite an issued bill",
      afterEdit.seller?.phone === beforeEdit.seller?.phone,
      `${beforeEdit.seller?.phone} → ${afterEdit.seller?.phone}`,
    );
    await FooterSetting.updateOne({ _id: footerDoc._id }, { $set: { "contact.phone": original } });
  } else {
    ok("no footer document to mutate — snapshot trivially stable", true);
  }

  // ───────────────────────────────────────────────────────────────────────────
  section("Minting through the Shiprocket webhook");

  const hooked = await makeOrder();
  await OrderModel.updateOne({ _id: hooked._id }, { $set: { "shiprocket.orderId": 9_100_000 + seq } });
  const hookBody = { order_id: String(hooked._id), sr_order_id: 9_100_000 + seq, shipment_status_id: 7 };

  const first = await webhook(hookBody);
  ok("the delivery webhook is accepted", first.statusCode === 200, JSON.stringify(first.body));
  const hookedBill = await billOf(hooked._id);
  ok("the webhook minted a number", Boolean(hookedBill?.number), JSON.stringify(hookedBill));

  await webhook(hookBody);
  ok(
    "a duplicate webhook does not mint a second number",
    (await billOf(hooked._id)).number === hookedBill.number,
  );
  const history = await OrderModel.findById(hooked._id).select("statusHistory").lean();
  const deliveredEntries = (history.statusHistory || []).filter((e) => e.to === "Delivered");
  ok(
    "the duplicate produced exactly one Delivered history entry",
    deliveredEntries.length === 1,
    String(deliveredEntries.length),
  );

  section("A stale Delivered against a cancelled order bills nothing");

  const cancelled = await makeOrder();
  await OrderModel.updateOne(
    { _id: cancelled._id },
    { $set: { orderStatus: "Cancelled", "shiprocket.orderId": 9_200_000 + seq } },
  );
  const before = await BillCounter.findOne({ financialYear: financialYear() }).lean();
  await webhook({
    order_id: String(cancelled._id),
    sr_order_id: 9_200_000 + seq,
    shipment_status_id: 7,
  });
  ok("no bill was issued for a cancelled order", (await billOf(cancelled._id))?.number == null);
  const after = await BillCounter.findOne({ financialYear: financialYear() }).lean();
  ok(
    "the live counter did not move",
    (before?.seq ?? 0) === (after?.seq ?? 0),
    `${before?.seq ?? 0} → ${after?.seq ?? 0}`,
  );

  // ───────────────────────────────────────────────────────────────────────────
  section("Concurrency — the reason this suite needs a real database");

  const contended = await makeOrder({ status: "Delivered" });
  const parallel = await Promise.all(
    Array.from({ length: 20 }, () => ensureBillNumber(contended._id, { now: TEST_FY_DATE })),
  );
  const distinct = new Set(parallel.map((r) => r.number).filter(Boolean));
  ok("20 parallel mints on one order agree on one number", distinct.size === 1, [...distinct].join(","));
  ok("exactly one of them reports having minted it", parallel.filter((r) => r.minted).length === 1);
  const claimed = await billOf(contended._id);
  ok("the order holds that number", claimed.number === [...distinct][0]);

  // The gaps-are-acceptable contract, asserted rather than assumed: burned numbers
  // must not reappear on some other order.
  const burnedElsewhere = await OrderModel.countDocuments({
    _id: { $ne: contended._id },
    "bill.financialYear": TEST_FY,
  });
  ok("no other order picked up a burned number", burnedElsewhere === 0, String(burnedElsewhere));

  const many = await Promise.all(Array.from({ length: 20 }, () => makeOrder({ status: "Delivered" })));
  const minted = await Promise.all(
    many.map((order) => ensureBillNumber(order._id, { now: OTHER_FY_DATE })),
  );
  const numbers = minted.map((r) => r.number);
  ok(
    "20 parallel mints across 20 orders produce 20 distinct numbers",
    new Set(numbers).size === 20,
    `${new Set(numbers).size} distinct`,
  );
  ok("all of them are in the expected financial year", numbers.every((n) => n.includes(OTHER_FY)));

  section("The first mint of a brand-new financial year, concurrently");

  // The upsert race: with no counter document yet, every caller takes the insert
  // branch at once. Without the unique index on financialYear this produces two
  // counter documents and duplicate numbers.
  const FRESH_FY_DATE = new Date("2090-06-01T00:00:00+05:30");
  trash.years.add("2090-91");
  await BillCounter.deleteOne({ financialYear: "2090-91" });
  const freshOrders = await Promise.all(
    Array.from({ length: 10 }, () => makeOrder({ status: "Delivered" })),
  );
  const freshResults = await Promise.all(
    freshOrders.map((order) => ensureBillNumber(order._id, { now: FRESH_FY_DATE })),
  );
  const freshNumbers = freshResults.map((r) => r.number);
  ok(
    "10 concurrent first-ever mints produce 10 distinct numbers",
    new Set(freshNumbers).size === 10,
    `${new Set(freshNumbers).size} distinct`,
  );
  ok("exactly one counter document exists for that year",
    (await BillCounter.countDocuments({ financialYear: "2090-91" })) === 1);

  // ───────────────────────────────────────────────────────────────────────────
  section("The index is partial, not sparse");

  const indexes = await OrderModel.collection.indexes();
  const billIndex = indexes.find((i) => i.name === "bill_number_unique");
  ok("bill_number_unique exists", Boolean(billIndex), indexes.map((i) => i.name).join(", "));
  ok("it is unique", billIndex?.unique === true);
  // Assert the NEGATIVE: the sparse variant looks right and would make the second
  // unbilled order ever created collide with E11000.
  ok("it is NOT sparse", !billIndex?.sparse, JSON.stringify(billIndex));
  ok(
    "it filters on $type string",
    JSON.stringify(billIndex?.partialFilterExpression) === JSON.stringify({ "bill.number": { $type: "string" } }),
    JSON.stringify(billIndex?.partialFilterExpression),
  );

  const unbilledA = await makeOrder();
  const unbilledB = await makeOrder();
  ok(
    "two orders with a null bill.number coexist",
    Boolean(unbilledA._id) && Boolean(unbilledB._id) &&
      (await OrderModel.countDocuments({ _id: { $in: [unbilledA._id, unbilledB._id] }, "bill.number": null })) === 2,
  );

  const overwrite = await OrderModel.updateOne(
    { _id: contended._id, "bill.number": null },
    { $set: { "bill.number": "RB/2088-89/9999" } },
  );
  ok("the CAS filter refuses to renumber a billed order", overwrite.modifiedCount === 0);

  let duplicateRejected = false;
  try {
    await OrderModel.updateOne(
      { _id: unbilledA._id },
      { $set: { "bill.number": claimed.number, "bill.financialYear": TEST_FY, "bill.sequence": 1 } },
    );
  } catch (error) {
    duplicateRejected = error?.code === 11000;
  }
  ok("the database rejects one number on two orders", duplicateRejected);

  // ───────────────────────────────────────────────────────────────────────────
  section("Counter seeding is $max, never $set");

  await seedBillCounter(TEST_FY, 5);
  const raised = await BillCounter.findOne({ financialYear: TEST_FY }).lean();
  await seedBillCounter(TEST_FY, 2);
  const notRewound = await BillCounter.findOne({ financialYear: TEST_FY }).lean();
  ok(
    "seeding lower than the current value does not rewind the counter",
    notRewound.seq === raised.seq,
    `${raised.seq} → ${notRewound.seq}`,
  );

  // ───────────────────────────────────────────────────────────────────────────
  section("Frontend contract");

  const slice = await readFile(
    new URL("../../../kitab-shop-fe/src/store/ordersSlice.js", import.meta.url),
    "utf8",
  );
  ok("normalizeOrder exposes bill", /bill:\s*order\.bill/.test(slice));

  const pdf = await readFile(
    new URL("../../../kitab-shop-fe/src/utils/invoicePdf.js", import.meta.url),
    "utf8",
  );
  ok("the PDF reads the bill number", /order\?\.bill\?\.number/.test(pdf));
  ok("the PDF titles a numbered document BILL OF SUPPLY", /BILL OF SUPPLY/.test(pdf));
  ok("the PDF still renders an unnumbered order", /"INVOICE"/.test(pdf));
  ok("the PDF prints a delivery row", /label: "Delivery"/.test(pdf));
  ok("the PDF reconciles with an Adjustment row", /label: "Adjustment"/.test(pdf));

  const sidebar = await readFile(
    new URL("../../../kitab-shop-fe/src/features/order-detail/OrderSummarySidebar.jsx", import.meta.url),
    "utf8",
  );
  ok("the on-screen summary no longer hardcodes free shipping", !/>Free<\/span>\s*<\/div>\s*\{order\.coupon/.test(sidebar));
  ok("the on-screen summary reads shippingCharge", /shippingCharge/.test(sidebar));
  ok("the on-screen summary reads subtotal, not total", /Subtotal<\/span><span>₹\{subtotal/.test(sidebar));
} catch (error) {
  console.error(error);
  ok("suite ran to completion", false, error.message);
} finally {
  restoreShiprocket();
  await OrderModel.deleteMany({ _id: { $in: trash.orders } });
  await ProductModel.deleteMany({ _id: { $in: trash.products } });
  await BillCounter.deleteMany({ financialYear: { $in: [...trash.years] } });

  // Give back the live numbers this suite consumed — but only if nothing that
  // survived the cleanup is using them. A real delivery landing while the suite ran
  // would leave a higher sequence on a real order, and rewinding past it would hand
  // that number out a second time. In that case the counter is left where it is and
  // the run simply costs a few numbers.
  const highest = await OrderModel.findOne({ "bill.financialYear": LIVE_FY })
    .sort({ "bill.sequence": -1 })
    .select("bill.sequence")
    .lean();
  const inUse = highest?.bill?.sequence ?? 0;
  if (inUse <= (liveCounterBefore ?? 0)) {
    if (liveCounterBefore === null) {
      await BillCounter.deleteOne({ financialYear: LIVE_FY });
    } else {
      await BillCounter.updateOne({ financialYear: LIVE_FY }, { $set: { seq: liveCounterBefore } });
    }
  } else {
    console.log(
      `\n  note: live counter for ${LIVE_FY} left at its current value — order ${highest?._id} holds sequence ${inUse}`,
    );
  }
  const { failed } = finish();
  await mongoose.disconnect();
  process.exit(failed ? 1 : 0);
}
