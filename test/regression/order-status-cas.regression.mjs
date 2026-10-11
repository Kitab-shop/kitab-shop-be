/**
 * UpdateOrderStatus's generic path is a compare-and-swap (plan S4, order-status rule 1).
 *
 * It used to be read → mutate → `order.save()`, and `orderStatus` carries no version
 * guard, so the save made no claim about what the status was when it landed. An admin
 * who chose "Out For Delivery" from a page opened a minute earlier overwrote the
 * courier's "Delivered" that arrived in between — moving a delivered order backwards
 * and pushing a history entry for a move nobody made. Two identical moves at once each
 * pushed their own history entry, since Mongoose does not version-guard a $push into a
 * subdocument array.
 *
 * Now the write is one findOneAndUpdate filtered on the status the move was validated
 * from. These scenarios prove:
 *
 *   - a stale admin write loses to the concurrent change (409 ORDER_CHANGED) and runs
 *     none of its side effects;
 *   - of two different concurrent moves exactly one applies;
 *   - of two IDENTICAL concurrent moves one applies and the other is told "unchanged",
 *     with one history entry, one COD promotion and one bill number between them;
 *   - the provider-neutral `shipment.status` mirror follows the status when a shipment
 *     provider is recorded, and is left alone when none is;
 *   - the Closed and unpaid-prepaid gates still answer exactly as before.
 *
 * The races are made DETERMINISTIC with a read barrier on OrderModel.findById: both
 * requests are held after their initial read until both have read, so both validate
 * from the same snapshot and the only thing deciding the winner is the write itself.
 * Without the barrier, Promise.all could serialise them and the test would prove
 * nothing.
 *
 * Run with `npm run test:order-status-cas` (or `npm test` for everything).
 */
process.env.SHIPROCKET_ENABLED = "false";
process.env.SHIPROCKET_WEBHOOK_ENABLED = "false";
process.env.INVENTORY_ENFORCE_STOCK = "true";
process.env.NOTIFICATIONS_ENABLED = "false";
process.env.PAYMENTS_ENABLED = "false";

import mongoose from "mongoose";
import { readFile } from "node:fs/promises";
import { addressFixture, connect, createSuite, marker, productFixture } from "./helpers.mjs";

const { ok, section, finish } = createSuite("order-status-cas");
await connect();

const OrderModel = (await import("../../src/modules/orders/Order.model.js")).default;
const BillCounter = (await import("../../src/modules/orders/BillCounter.model.js")).default;
const ProductModel = (await import("../../src/modules/products/Product.model.js")).default;
await import("../../src/modules/categories/Category.model.js");
const orderController = await import("../../src/modules/orders/order.controller.js");
const { financialYear } = await import("../../src/modules/orders/bill-number.service.js");

await OrderModel.init();

// Delivered moves here go through the REAL controller, which mints into the LIVE
// financial year. Captured so the finally block can give those numbers back — the
// same rewind bill-number.regression.mjs does, for the same reason.
const LIVE_FY = financialYear();
const liveCounterBefore = (await BillCounter.findOne({ financialYear: LIVE_FY }).lean())?.seq ?? null;

const MARKER = marker("statuscas");
const trash = { orders: [], products: [] };
let seq = 0;

// Nothing here should reach a courier or a gateway. Fail loudly if it tries.
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input) => {
  throw new Error(`Unexpected network call: ${String(input instanceof URL ? input.href : input)}`);
};

const realFindById = OrderModel.findById;

const makeProduct = async () => {
  const product = await ProductModel.create(
    productFixture(`${MARKER}-${(seq += 1)}`, { stock: 50 }),
  );
  trash.products.push(product._id);
  return product;
};

const makeOrder = async ({
  orderStatus = "Shipped",
  paymentMethod = "COD",
  paymentStatus = paymentMethod === "COD" ? "Pending" : "Paid",
  provider = "SHIPROCKET",
  ...fields
} = {}) => {
  const product = await makeProduct();
  seq += 1;
  const order = await OrderModel.create({
    user: new mongoose.Types.ObjectId(),
    items: [
      { product: product._id, name: product.name, image: "x.png", price: product.price, quantity: 1 },
    ],
    shippingAddress: addressFixture(),
    paymentMethod,
    paymentStatus,
    orderStatus,
    subtotal: product.price,
    totalAmount: product.price,
    ...(paymentMethod === "RAZORPAY" ? { razorpayPaymentId: `pay_${MARKER}_${seq}` } : {}),
    ...(provider
      ? {
          shipment: {
            provider,
            carrierName: "Fixture Courier",
            trackingNumber: `TRK-${MARKER}-${seq}`,
            status: orderStatus,
          },
        }
      : {}),
    ...fields,
  });
  trash.orders.push(order._id);
  return order;
};

const callController = async (handler, { params = {}, body = {}, user, query = {} }) => {
  let statusCode = 200;
  let payload;
  const res = {
    status(code) { statusCode = code; return this; },
    json(data) { payload = data; return this; },
  };
  await handler({ params, body, user, query }, res);
  return { statusCode, body: payload };
};

const admin = () => ({ id: String(new mongoose.Types.ObjectId()), roles: ["admin"] });

const setStatus = (orderId, orderStatus) =>
  callController(orderController.UpdateOrderStatus, {
    params: { orderId: String(orderId) },
    body: { orderStatus },
    user: admin(),
  });

/**
 * Holds the first `n` OrderModel.findById reads until all `n` have completed, so every
 * concurrent request validates from the SAME snapshot. Later reads (the CAS-miss re-read,
 * the bill mint) pass straight through. Always restored, even if `fn` throws.
 */
const withReadBarrier = async (n, fn) => {
  let arrived = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  OrderModel.findById = function heldFindById(...args) {
    if (arrived >= n) return realFindById.apply(this, args);
    arrived += 1;
    const read = realFindById.apply(this, args).exec();
    if (arrived === n) release();
    return read.then(async (doc) => {
      await gate;
      return doc;
    });
  };
  try {
    return await fn();
  } finally {
    OrderModel.findById = realFindById;
  }
};

/**
 * Makes the controller's FIRST read return `snapshot` — the order as an admin's open
 * page last saw it — while the database already holds something newer. Exactly the
 * window the old read-then-save lost: the move is validated against the snapshot and
 * only the write can notice the difference.
 */
const withStaleRead = async (snapshot, fn) => {
  let served = false;
  OrderModel.findById = function staleFindById(...args) {
    if (served) return realFindById.apply(this, args);
    served = true;
    return Promise.resolve(snapshot);
  };
  try {
    return await fn();
  } finally {
    OrderModel.findById = realFindById;
  }
};

const state = async (id) => {
  const order = await OrderModel.findById(id).lean();
  return {
    orderStatus: order.orderStatus,
    paymentStatus: order.paymentStatus,
    deliveredAt: order.deliveredAt || null,
    history: (order.statusHistory || []).map((entry) => `${entry.from}→${entry.to}`),
    shipmentStatus: order.shipment?.status ?? null,
    shipmentProvider: order.shipment?.provider ?? null,
    billNumber: order.bill?.number || null,
    refunds: order.refunds || [],
  };
};

try {
  // ═══════════════════════════════════════════════════════════════════════════
  section("1. a stale admin write loses to the courier's concurrent move");

  {
    // The scenario from the plan: the admin's page shows Shipped and they choose
    // "Out For Delivery"; meanwhile the courier webhook has already set Delivered.
    const order = await makeOrder({ orderStatus: "Shipped" });
    const snapshot = await realFindById.call(OrderModel, order._id);
    await OrderModel.updateOne(
      { _id: order._id },
      {
        $set: { orderStatus: "Delivered", deliveredAt: new Date(), "shipment.status": "Delivered" },
        $push: { statusHistory: { from: "Shipped", to: "Delivered", changedAt: new Date() } },
      },
    );
    const before = await state(order._id);

    const response = await withStaleRead(snapshot, () => setStatus(order._id, "Out For Delivery"));
    ok(
      "the stale move is refused with 409 ORDER_CHANGED",
      response.statusCode === 409 && response.body?.code === "ORDER_CHANGED",
      `${response.statusCode} ${response.body?.code} ${response.body?.message || ""}`,
    );
    ok("  success is false", response.body?.success === false);
    ok(
      "  currentStatus reports what the order is NOW",
      response.body?.currentStatus === "Delivered",
      String(response.body?.currentStatus),
    );
    ok(
      "  and the message names it",
      response.body?.message ===
        "This order changed while you were editing it (it is now Delivered). Reload and try again.",
      response.body?.message,
    );

    const after = await state(order._id);
    ok("the courier's Delivered survives", after.orderStatus === "Delivered", after.orderStatus);
    ok(
      "no history entry was pushed for the move that lost",
      JSON.stringify(after.history) === JSON.stringify(before.history),
      JSON.stringify(after.history),
    );
    ok("the shipment mirror still says Delivered", after.shipmentStatus === "Delivered", String(after.shipmentStatus));
  }

  {
    // The losing side must run NONE of its side effects. A stale "Delivered" over a
    // courier RTO would otherwise stamp deliveredAt, flip COD to Paid (cash that was
    // never collected — the parcel is going back) and burn a bill number.
    const order = await makeOrder({ orderStatus: "Shipped", paymentMethod: "COD" });
    const snapshot = await realFindById.call(OrderModel, order._id);
    await OrderModel.updateOne(
      { _id: order._id },
      { $set: { orderStatus: "RTO", "shipment.status": "RTO" } },
    );

    const response = await withStaleRead(snapshot, () => setStatus(order._id, "Delivered"));
    ok(
      "a stale Delivered over a courier RTO is refused (409 ORDER_CHANGED)",
      response.statusCode === 409 && response.body?.code === "ORDER_CHANGED" &&
        response.body?.currentStatus === "RTO",
      `${response.statusCode} ${response.body?.code} ${response.body?.currentStatus}`,
    );
    const after = await state(order._id);
    ok("  the order stays at RTO", after.orderStatus === "RTO", after.orderStatus);
    ok("  deliveredAt was NOT stamped", after.deliveredAt === null);
    ok("  COD was NOT promoted to Paid", after.paymentStatus === "Pending", after.paymentStatus);
    ok("  no bill number was minted", after.billNumber === null, String(after.billNumber));
    ok("  and no history entry was pushed", after.history.length === 0, JSON.stringify(after.history));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("2. two different concurrent moves: exactly one applies");

  {
    const order = await makeOrder({ orderStatus: "Shipped", paymentMethod: "RAZORPAY" });
    const [delivered, outForDelivery] = await withReadBarrier(2, () =>
      Promise.all([setStatus(order._id, "Delivered"), setStatus(order._id, "Out For Delivery")]),
    );
    const responses = [
      { target: "Delivered", ...delivered },
      { target: "Out For Delivery", ...outForDelivery },
    ];
    const winners = responses.filter(
      (r) => r.statusCode === 200 && r.body?.message === "Order status updated",
    );
    const losers = responses.filter((r) => r.statusCode === 409 && r.body?.code === "ORDER_CHANGED");
    ok(
      "exactly one request applied its move",
      winners.length === 1,
      responses.map((r) => `${r.target}: ${r.statusCode} ${r.body?.code || r.body?.message}`).join("; "),
    );
    ok(
      "the other got 409 ORDER_CHANGED",
      losers.length === 1,
      responses.map((r) => `${r.target}: ${r.statusCode} ${r.body?.code || r.body?.message}`).join("; "),
    );

    const after = await state(order._id);
    const winner = winners[0]?.target;
    ok("the final status is the winner's", after.orderStatus === winner, `${after.orderStatus} vs ${winner}`);
    ok(
      "the loser's currentStatus is the winner's status",
      losers[0]?.body?.currentStatus === winner,
      String(losers[0]?.body?.currentStatus),
    );
    ok(
      "statusHistory gained exactly one entry, from Shipped",
      after.history.length === 1 && after.history[0] === `Shipped→${winner}`,
      JSON.stringify(after.history),
    );
    ok("the shipment mirror matches the winner", after.shipmentStatus === winner, String(after.shipmentStatus));
    ok(
      "deliveredAt is set only if Delivered won",
      winner === "Delivered" ? after.deliveredAt !== null : after.deliveredAt === null,
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("3. two IDENTICAL concurrent moves (a double-click): one applies");

  {
    const order = await makeOrder({ orderStatus: "Shipped", paymentMethod: "COD" });
    const responses = await withReadBarrier(2, () =>
      Promise.all([setStatus(order._id, "Delivered"), setStatus(order._id, "Delivered")]),
    );
    const applied = responses.filter(
      (r) => r.statusCode === 200 && r.body?.message === "Order status updated",
    );
    const other = responses.find((r) => !applied.includes(r));
    ok(
      "exactly one request applied the move",
      applied.length === 1,
      responses.map((r) => `${r.statusCode} ${r.body?.code || r.body?.message}`).join("; "),
    );
    ok(
      "the other is told 'unchanged' (200) or ORDER_CHANGED (409), never a second apply",
      (other?.statusCode === 200 && other?.body?.message === "Order status unchanged") ||
        (other?.statusCode === 409 && other?.body?.code === "ORDER_CHANGED"),
      `${other?.statusCode} ${other?.body?.code || other?.body?.message}`,
    );

    const after = await state(order._id);
    ok("the order is Delivered", after.orderStatus === "Delivered", after.orderStatus);
    ok(
      "statusHistory has exactly ONE Delivered entry",
      after.history.filter((h) => h.endsWith("→Delivered")).length === 1,
      JSON.stringify(after.history),
    );
    ok("COD was promoted to Paid", after.paymentStatus === "Paid", after.paymentStatus);
    ok("a bill number was minted", Boolean(after.billNumber), String(after.billNumber));
    ok(
      "the applied response carries the promoted payment and the bill",
      applied[0]?.body?.order?.paymentStatus === "Paid" &&
        applied[0]?.body?.order?.bill?.number === after.billNumber,
      `${applied[0]?.body?.order?.paymentStatus} ${applied[0]?.body?.order?.bill?.number}`,
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("4. Delivered via the admin: deliveredAt, COD, bill and the mirror");

  {
    const order = await makeOrder({ orderStatus: "Out For Delivery", paymentMethod: "COD", provider: "SHIPROCKET" });
    const response = await setStatus(order._id, "Delivered");
    ok("the move succeeds (200 'Order status updated')",
      response.statusCode === 200 && response.body?.success === true &&
        response.body?.message === "Order status updated",
      `${response.statusCode} ${response.body?.message}`);

    const after = await state(order._id);
    ok("deliveredAt is stamped", after.deliveredAt !== null);
    ok("COD flips Pending → Paid", after.paymentStatus === "Paid", after.paymentStatus);
    ok("a bill number is minted", Boolean(after.billNumber));
    ok("shipment.status mirrors Delivered (SHIPROCKET provider)", after.shipmentStatus === "Delivered", String(after.shipmentStatus));
    ok("the history records the move once",
      JSON.stringify(after.history) === JSON.stringify(["Out For Delivery→Delivered"]),
      JSON.stringify(after.history));
    ok("the response is the updated order",
      response.body?.order?.orderStatus === "Delivered" &&
        response.body?.order?.shipment?.status === "Delivered" &&
        response.body?.order?.bill?.number === after.billNumber,
      JSON.stringify({ s: response.body?.order?.orderStatus, b: response.body?.order?.bill?.number }));

    // Re-submitting the same status: the existing "unchanged" branch, untouched.
    const again = await setStatus(order._id, "Delivered");
    ok("re-submitting Delivered answers 200 'Order status unchanged'",
      again.statusCode === 200 && again.body?.message === "Order status unchanged",
      `${again.statusCode} ${again.body?.message}`);

    // Delivered → Completed must not move the return window or the bill.
    const completed = await setStatus(order._id, "Completed");
    const final = await state(order._id);
    ok("Delivered → Completed succeeds", completed.statusCode === 200, `${completed.statusCode} ${completed.body?.message}`);
    ok("  deliveredAt was stamped ONCE — Completed did not move it",
      final.deliveredAt?.getTime() === after.deliveredAt?.getTime());
    ok("  the bill number is unchanged", final.billNumber === after.billNumber);
    ok("  COD stays Paid", final.paymentStatus === "Paid");
    ok("  the mirror follows to Completed", final.shipmentStatus === "Completed", String(final.shipmentStatus));
    ok("  history is Out For Delivery→Delivered, Delivered→Completed",
      JSON.stringify(final.history) ===
        JSON.stringify(["Out For Delivery→Delivered", "Delivered→Completed"]),
      JSON.stringify(final.history));
  }

  {
    const order = await makeOrder({ orderStatus: "Shipped", paymentMethod: "COD", provider: "MANUAL" });
    await setStatus(order._id, "Delivered");
    const after = await state(order._id);
    ok("a MANUAL shipment's mirror is written too", after.shipmentStatus === "Delivered", String(after.shipmentStatus));
    ok("  and its provider is untouched", after.shipmentProvider === "MANUAL");
  }

  {
    const order = await makeOrder({ orderStatus: "Shipped", paymentMethod: "COD", provider: null });
    const response = await setStatus(order._id, "Delivered");
    const after = await state(order._id);
    ok("an order with no shipment provider still moves", response.statusCode === 200 && after.orderStatus === "Delivered");
    ok("  but shipment.status is NOT written", after.shipmentStatus === null, String(after.shipmentStatus));
    ok("  and no provider is invented", after.shipmentProvider === null, String(after.shipmentProvider));
  }

  {
    // An order that was delivered once before keeps its original delivery date.
    const firstDelivery = new Date("2020-01-02T03:04:05Z");
    const order = await makeOrder({ orderStatus: "NDR", paymentMethod: "RAZORPAY", deliveredAt: firstDelivery });
    await setStatus(order._id, "Delivered");
    const after = await state(order._id);
    ok("an existing deliveredAt is not overwritten",
      after.deliveredAt?.getTime() === firstDelivery.getTime(), String(after.deliveredAt));
    ok("a prepaid order's payment status is left alone", after.paymentStatus === "Paid", after.paymentStatus);
  }

  {
    // The COD promotion keeps its own payment precondition: a COD order whose payment
    // has already moved on (refunded, say) is not flipped back to Paid.
    const order = await makeOrder({ orderStatus: "Shipped", paymentMethod: "COD", paymentStatus: "Refunded" });
    await setStatus(order._id, "Delivered");
    const after = await state(order._id);
    ok("a COD order not at Pending is not promoted", after.paymentStatus === "Refunded", after.paymentStatus);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("5. the other gates answer exactly as before");

  {
    const order = await makeOrder({ orderStatus: "Shipped" });
    const cancel = await setStatus(order._id, "Cancelled");
    ok("Cancelled → 400 USE_CANCEL_ENDPOINT",
      cancel.statusCode === 400 && cancel.body?.code === "USE_CANCEL_ENDPOINT" && cancel.body?.currentStatus === "Shipped",
      `${cancel.statusCode} ${cancel.body?.code}`);
    const illegal = await setStatus(order._id, "Pending");
    ok("Shipped → Pending → 400 INVALID_STATUS_TRANSITION",
      illegal.statusCode === 400 && illegal.body?.code === "INVALID_STATUS_TRANSITION" &&
        illegal.body?.currentStatus === "Shipped",
      `${illegal.statusCode} ${illegal.body?.code}`);
    const missing = await setStatus(new mongoose.Types.ObjectId(), "Delivered");
    ok("an unknown order → 404", missing.statusCode === 404 && missing.body?.message === "Order not found");
  }

  {
    const order = await makeOrder({
      orderStatus: "Pending",
      paymentMethod: "RAZORPAY",
      paymentStatus: "Pending",
      provider: null,
    });
    const response = await setStatus(order._id, "Confirmed");
    ok("an unpaid prepaid Pending → Confirmed → 409 PAYMENT_NOT_CAPTURED",
      response.statusCode === 409 && response.body?.code === "PAYMENT_NOT_CAPTURED",
      `${response.statusCode} ${response.body?.code}`);
    ok("  and the order stays Pending", (await state(order._id)).orderStatus === "Pending");
  }

  {
    const order = await makeOrder({ orderStatus: "RTO Received", paymentMethod: "COD", provider: null });
    const response = await setStatus(order._id, "Closed");
    ok("closing without a disposition → 409 RTO_DISPOSITION_REQUIRED",
      response.statusCode === 409 && response.body?.code === "RTO_DISPOSITION_REQUIRED",
      `${response.statusCode} ${response.body?.code}`);
  }

  {
    // A prepaid order moved to RTO Received BY HAND still records the refund owed
    // (the G3 obligation now runs off the CAS result), and Closed is then refused
    // until it is paid.
    const order = await makeOrder({ orderStatus: "RTO", paymentMethod: "RAZORPAY", provider: "SHIPROCKET" });
    const received = await setStatus(order._id, "RTO Received");
    const afterReceive = await state(order._id);
    ok("a manual RTO → RTO Received succeeds", received.statusCode === 200, `${received.statusCode} ${received.body?.message}`);
    ok("  the prepaid refund obligation is recorded",
      afterReceive.refunds.filter((r) => r.status === "owed").length === 1,
      JSON.stringify(afterReceive.refunds.map((r) => r.status)));
    ok("  and the response shows it", (received.body?.order?.refunds || []).some((r) => r.status === "owed"));
    ok("  the mirror follows to RTO Received", afterReceive.shipmentStatus === "RTO Received");

    await OrderModel.updateOne({ _id: order._id }, { $set: { rtoDisposition: "damaged" } });
    const close = await setStatus(order._id, "Closed");
    ok("closing with the refund still owed → 409 RTO_REFUND_OUTSTANDING",
      close.statusCode === 409 && close.body?.code === "RTO_REFUND_OUTSTANDING" &&
        close.body?.outstandingRefundAmount === order.totalAmount,
      `${close.statusCode} ${close.body?.code} ${close.body?.outstandingRefundAmount}`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("6. the shape cannot quietly regress");

  {
    const source = await readFile(
      new URL("../../src/modules/orders/order.controller.js", import.meta.url),
      "utf8",
    );
    const body = source.slice(
      source.indexOf("export const UpdateOrderStatus"),
      source.indexOf("export const AddOrderNote"),
    );
    ok("UpdateOrderStatus no longer calls order.save()", !/await order\.save\(\)/.test(body));
    ok("its generic write filters on the status it validated from",
      /\{\s*_id:\s*order\._id,\s*orderStatus:\s*previousStatus\s*\}/.test(body));
  }
} catch (error) {
  console.error(`\nSUITE ABORTED: ${error?.stack || error}`);
  ok("suite ran to completion", false, error?.message);
} finally {
  OrderModel.findById = realFindById;
  globalThis.fetch = originalFetch;
  await OrderModel.deleteMany({ _id: { $in: trash.orders } });
  await ProductModel.deleteMany({ _id: { $in: trash.products } });

  // Give back the live bill numbers this suite consumed, unless something that
  // survived the cleanup holds a higher one (see bill-number.regression.mjs).
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
