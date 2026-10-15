/**
 * Customer return cancellation, and the manual pickup AWB rule.
 *
 *   CANCEL. A customer can withdraw their own return while nothing physical has
 *   happened: it is pending or approved, no courier is booked (pickupShipmentId), no
 *   booking is in flight (pickupBookingClaimedAt) and no pickup AWB is recorded. All of
 *   that sits in one compare-and-swap. `cancelled` is terminal, not an open status and
 *   not quantity-consuming, so the order line can be requested again straight away.
 *
 *   MANUAL PICKUP. Moving a return to pickup_scheduled by hand (no Shiprocket booking)
 *   used to record nothing about the parcel, so no courier event could be matched to it.
 *   It now needs a pickup AWB (unique across returns), or `selfShip: true`.
 *
 * Run with `node test/regression/return-cancel.regression.mjs`.
 */
process.env.PAYMENTS_ENABLED = "false";
process.env.INVENTORY_ENFORCE_STOCK = "false";
process.env.NOTIFICATIONS_ENABLED = "false";
process.env.SHIPROCKET_ENABLED = "false";

import mongoose from "mongoose";
import { readFile } from "node:fs/promises";
import { connect, createSuite, marker, productFixture, addressFixture } from "./helpers.mjs";

const { ok, section, finish } = createSuite("return-cancel");
await connect();

const OrderModel = (await import("../../src/modules/orders/Order.model.js")).default;
const ProductModel = (await import("../../src/modules/products/Product.model.js")).default;
const ReturnModel = (await import("../../src/modules/returns/return.model.js")).default;
const { OPEN_RETURN_STATUSES, QUANTITY_CONSUMING_RETURN_STATUSES, RETURN_STATUSES } = await import(
  "../../src/modules/returns/return.model.js"
);
const NotificationEvent = (await import("../../src/model/NotificationEvent.model.js")).default;
const returnController = await import("../../src/modules/returns/return.controller.js");
const returnRouter = (await import("../../src/modules/returns/return.routes.js")).default;
const { applyCourierEvent } = await import("../../src/modules/shipping/courier-event.service.js");

await ReturnModel.init().catch(() => {});

const MARKER = marker("retcancel");
const trash = { orders: [], products: [], returns: [] };
let seq = 0;

const call = async (handler, { params = {}, body = {}, user, query = {} } = {}) => {
  let statusCode = 200;
  let payload;
  const res = {
    status(code) { statusCode = code; return this; },
    json(data) { payload = data; return this; },
  };
  await handler({ params, body, user, query, get: () => undefined }, res);
  return { statusCode, body: payload };
};

const admin = () => ({ id: String(new mongoose.Types.ObjectId()), roles: ["admin"] });

const makeOrder = async ({ units = 2 } = {}) => {
  seq += 1;
  const product = await ProductModel.create(
    productFixture(`${MARKER}-${seq}`, { stock: 50, returnPolicy: { kind: "return", windowDays: 30 } }),
  );
  trash.products.push(product._id);
  const userId = new mongoose.Types.ObjectId();
  const order = await OrderModel.create({
    user: userId,
    items: [{ product: product._id, name: product.name, image: "x.png", price: product.price, quantity: units }],
    shippingAddress: addressFixture(),
    paymentMethod: "RAZORPAY",
    paymentStatus: "Paid",
    orderStatus: "Delivered",
    deliveredAt: new Date(),
    subtotal: product.price * units,
    totalAmount: product.price * units,
    razorpayPaymentId: `pay_${MARKER}_${seq}`,
  });
  trash.orders.push(order._id);
  return { order, product, owner: { id: String(userId), roles: [] } };
};

/** Through the real endpoint, so quantity accounting and the open-return index apply. */
const requestReturn = async ({ order, product, owner, quantity = 1 }) => {
  const response = await call(returnController.CreateReturnRequest, {
    body: { orderId: String(order._id), productId: String(product._id), quantity, reason: "Not as described" },
    user: owner,
  });
  if (response.body?.data?._id) trash.returns.push(response.body.data._id);
  return response;
};

const fixture = async (setup = {}) => {
  const ctx = await makeOrder();
  const created = await requestReturn(ctx);
  if (created.statusCode !== 201) throw new Error(`fixture failed: ${JSON.stringify(created.body)}`);
  const returnId = created.body.data._id;
  if (Object.keys(setup).length) await ReturnModel.updateOne({ _id: returnId }, { $set: setup });
  return { ...ctx, returnId };
};

const cancel = (returnId, user) =>
  call(returnController.CancelMyReturn, { params: { id: String(returnId) }, user });

const patchStatus = (returnId, body) =>
  call(returnController.AdminUpdateReturnStatus, { params: { id: String(returnId) }, body, user: admin() });

const fresh = (id) => ReturnModel.findById(id).lean();

try {
  // ═══════════════════════════════════════════════════════════════════════════
  section("1 — the status itself");
  ok('"cancelled" is a return status', RETURN_STATUSES.includes("cancelled"));
  ok("it is not an open status (the line is free again)", !OPEN_RETURN_STATUSES.includes("cancelled"));
  ok(
    "it consumes no quantity, and neither does rejected",
    !QUANTITY_CONSUMING_RETURN_STATUSES.includes("cancelled") && !QUANTITY_CONSUMING_RETURN_STATUSES.includes("rejected"),
  );
  ok("the model has cancelledAt", Boolean(ReturnModel.schema.paths.cancelledAt));
  {
    const routes = returnRouter.stack
      .filter((layer) => layer.route)
      .map((layer) => `${Object.keys(layer.route.methods).join(",")} ${layer.route.path}`);
    ok("POST /:id/cancel is routed", routes.includes("post /:id/cancel"), JSON.stringify(routes));
    const routeSource = await readFile(new URL("../../src/modules/returns/return.routes.js", import.meta.url), "utf8");
    ok(
      "behind the rate limit and TokenVerify",
      /router\.post\("\/:id\/cancel", orderActionRateLimit, TokenVerify, CancelMyReturn\)/.test(routeSource),
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("2 — the owner cancels a pending or approved return");
  for (const status of ["pending", "approved"]) {
    const { returnId, owner, order } = await fixture(status === "pending" ? {} : { status });
    const before = await NotificationEvent.countDocuments({ event: "return.updated", order: order._id });
    const res = await cancel(returnId, owner);
    const after = await fresh(returnId);
    ok(`${status}: 200`, res.statusCode === 200 && res.body?.success === true, `${res.statusCode} ${JSON.stringify(res.body)}`);
    ok(`${status}: now cancelled, with cancelledAt`, after.status === "cancelled" && Boolean(after.cancelledAt), after.status);
    ok(
      `${status}: history records the customer did it`,
      after.statusHistory.at(-1)?.status === "cancelled" &&
        after.statusHistory.at(-1)?.note === "Cancelled by customer" &&
        String(after.statusHistory.at(-1)?.changedBy) === owner.id,
      JSON.stringify(after.statusHistory.at(-1)),
    );
    ok(
      `${status}: the customer is notified`,
      (await NotificationEvent.countDocuments({ event: "return.updated", order: order._id })) === before + 1,
    );
    ok(
      `${status}: the response carries no operator-only fields`,
      res.body?.data && !("pickupBookingClaimedAt" in res.body.data) && res.body.data.status === "cancelled",
      JSON.stringify(Object.keys(res.body?.data || {})),
    );
  }

  {
    const { returnId, owner } = await fixture();
    const first = await cancel(returnId, owner);
    const second = await cancel(returnId, owner);
    const after = await fresh(returnId);
    ok(
      "a second cancel is an idempotent 200, not a second write",
      first.statusCode === 200 && second.statusCode === 200 && second.body?.alreadyCancelled === true &&
        after.statusHistory.filter((h) => h.status === "cancelled").length === 1,
      `${second.statusCode} ${JSON.stringify(second.body)}`,
    );
  }

  {
    const { returnId, owner } = await fixture();
    const [a, b] = await Promise.all([cancel(returnId, owner), cancel(returnId, owner)]);
    const after = await fresh(returnId);
    ok(
      "two concurrent cancels write once",
      a.statusCode === 200 && b.statusCode === 200 &&
        after.statusHistory.filter((h) => h.status === "cancelled").length === 1,
      JSON.stringify([a.statusCode, b.statusCode]),
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("3 — refused");
  {
    const { returnId } = await fixture();
    const stranger = { id: String(new mongoose.Types.ObjectId()), roles: [] };
    const res = await cancel(returnId, stranger);
    ok("a non-owner gets 403", res.statusCode === 403, `${res.statusCode}`);
    ok("and the return is untouched", (await fresh(returnId)).status === "pending");

    const adminRes = await cancel(returnId, admin());
    ok("an admin cannot use the customer endpoint either", adminRes.statusCode === 403, `${adminRes.statusCode}`);

    const missing = await cancel(new mongoose.Types.ObjectId(), stranger);
    ok("an unknown return is 404", missing.statusCode === 404, `${missing.statusCode}`);
    const invalid = await cancel("not-an-id", stranger);
    ok("an invalid id is 400", invalid.statusCode === 400, `${invalid.statusCode}`);
  }

  const refusals = [
    ["pickup_scheduled", { status: "pickup_scheduled" }],
    ["received", { status: "received" }],
    ["rejected", { status: "rejected" }],
    ["approved with a held booking claim", { status: "approved", pickupBookingClaimedAt: new Date() }],
    ["approved with a booked shipment", { status: "approved", pickupShipmentId: 991000 + (process.pid % 1000) }],
    ["approved with a pickup AWB", { status: "approved", pickupAwb: `${MARKER}-held-awb` }],
  ];
  for (const [label, setup] of refusals) {
    const { returnId, owner } = await fixture(setup);
    const res = await cancel(returnId, owner);
    const after = await fresh(returnId);
    ok(
      `${label}: 409 RETURN_NOT_CANCELLABLE`,
      res.statusCode === 409 && res.body?.code === "RETURN_NOT_CANCELLABLE",
      `${res.statusCode} ${JSON.stringify(res.body)}`,
    );
    ok(`${label}: nothing changed`, after.status === setup.status && !after.cancelledAt, after.status);
  }

  {
    const { returnId } = await fixture();
    const res = await patchStatus(returnId, { status: "cancelled" });
    ok("an admin cannot move a return into cancelled", res.statusCode === 400, `${res.statusCode} ${res.body?.message}`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("4 — the line can be requested again");
  {
    const ctx = await makeOrder({ units: 2 });
    const first = await requestReturn({ ...ctx, quantity: 1 });
    ok("first request for one of two units", first.statusCode === 201, `${first.statusCode} ${first.body?.message}`);
    const blocked = await requestReturn({ ...ctx, quantity: 1 });
    ok("a second request is refused while it is open", blocked.statusCode === 409, `${blocked.statusCode}`);
    await cancel(first.body.data._id, ctx.owner);
    const again = await requestReturn({ ...ctx, quantity: 2 });
    ok(
      "after cancelling, the same line (all units) can be requested again",
      again.statusCode === 201 && again.body?.data?.quantity === 2,
      `${again.statusCode} ${again.body?.message}`,
    );

    const list = await call(returnController.AdminGetReturns, {
      query: { status: "cancelled", order: String(ctx.order._id) },
      user: admin(),
    });
    ok(
      "the admin list filters on status=cancelled",
      list.statusCode === 200 && list.body?.data?.length === 1 && list.body.data[0].status === "cancelled",
      `${list.statusCode} ${list.body?.data?.length}`,
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  section("5 — a manual pickup needs an AWB or self-ship");
  {
    const { returnId } = await fixture({ status: "approved" });
    const res = await patchStatus(returnId, { status: "pickup_scheduled" });
    ok("no AWB and no selfShip: 400 AWB_REQUIRED", res.statusCode === 400 && res.body?.code === "AWB_REQUIRED",
      `${res.statusCode} ${JSON.stringify(res.body)}`);
    ok("and the return stays approved", (await fresh(returnId)).status === "approved");

    const bad = await patchStatus(returnId, { status: "pickup_scheduled", pickupAwb: "a b" });
    ok("a malformed AWB: 400 AWB_REQUIRED", bad.statusCode === 400 && bad.body?.code === "AWB_REQUIRED",
      `${bad.statusCode} ${bad.body?.code}`);
  }

  const manualAwb = `${MARKER}-MANUAL-1`;
  let manualReturnId;
  {
    const { returnId } = await fixture({ status: "approved" });
    manualReturnId = returnId;
    const res = await patchStatus(returnId, {
      status: "pickup_scheduled",
      pickupAwb: ` ${manualAwb} `,
      pickupCourier: "Delhivery",
    });
    const after = await fresh(returnId);
    ok("with an AWB: 200", res.statusCode === 200, `${res.statusCode} ${JSON.stringify(res.body?.message)}`);
    ok(
      "the AWB and courier land with the status",
      after.status === "pickup_scheduled" && after.pickupAwb === manualAwb && after.pickupCourier === "Delhivery" &&
        Boolean(after.pickupScheduledAt) && after.pickupSelfShip === false,
      JSON.stringify({ s: after.status, a: after.pickupAwb, c: after.pickupCourier }),
    );
    ok(
      "and the history says so",
      (after.statusHistory.at(-1)?.note || "").includes(manualAwb),
      JSON.stringify(after.statusHistory.at(-1)),
    );
  }

  {
    const { returnId } = await fixture({ status: "approved" });
    const res = await patchStatus(returnId, { status: "pickup_scheduled", pickupAwb: manualAwb });
    const after = await fresh(returnId);
    ok("a duplicate AWB: 409 AWB_IN_USE", res.statusCode === 409 && res.body?.code === "AWB_IN_USE",
      `${res.statusCode} ${JSON.stringify(res.body)}`);
    ok("and the return stays approved with no AWB", after.status === "approved" && !after.pickupAwb, after.status);
  }

  {
    const { returnId } = await fixture({ status: "approved" });
    const res = await patchStatus(returnId, { status: "pickup_scheduled", selfShip: true });
    const after = await fresh(returnId);
    ok("selfShip: 200", res.statusCode === 200, `${res.statusCode} ${JSON.stringify(res.body)}`);
    ok(
      "selfShip is recorded, with no AWB",
      after.status === "pickup_scheduled" && after.pickupSelfShip === true && !after.pickupAwb,
      JSON.stringify({ s: after.status, self: after.pickupSelfShip }),
    );
  }

  {
    const { returnId } = await fixture({ status: "approved", pickupBookingClaimedAt: new Date() });
    const res = await patchStatus(returnId, { status: "pickup_scheduled", selfShip: true });
    ok(
      "a Shiprocket booking in flight blocks the manual move",
      res.statusCode === 409 && res.body?.code === "BOOKING_IN_PROGRESS" && (await fresh(returnId)).status === "approved",
      `${res.statusCode} ${res.body?.code}`,
    );
  }

  {
    // A booking recorded while the return was not at approved (recordOrphanBooking): the
    // courier exists, so there is nothing more to ask for.
    const { returnId } = await fixture({ status: "approved", pickupShipmentId: 992000 + (process.pid % 1000) });
    const res = await patchStatus(returnId, { status: "pickup_scheduled" });
    ok("a return with a booked shipment needs no AWB", res.statusCode === 200, `${res.statusCode} ${res.body?.code}`);
  }

  {
    // The point of recording the AWB: the courier's Delivered event can now find the return.
    const result = await applyCourierEvent(
      { awbCode: manualAwb, statusCode: 7, currentStatus: "DELIVERED" },
      { source: "webhook" },
    );
    const after = await fresh(manualReturnId);
    ok(
      "a courier Delivered on the manual AWB marks the return received",
      result.scope === "return" && result.statusUnchanged === false && after.status === "received",
      JSON.stringify({ result, status: after.status }),
    );
  }
} catch (error) {
  console.error(`\nSUITE ABORTED: ${error?.stack || error}`);
  ok("suite ran to completion", false, error?.message);
} finally {
  await ReturnModel.deleteMany({ order: { $in: trash.orders } });
  await ReturnModel.deleteMany({ _id: { $in: trash.returns } });
  await NotificationEvent.deleteMany({ order: { $in: trash.orders } });
  await OrderModel.deleteMany({ _id: { $in: trash.orders } });
  await ProductModel.deleteMany({ _id: { $in: trash.products } });
  const { failed } = finish();
  await mongoose.disconnect();
  process.exit(failed ? 1 : 0);
}
