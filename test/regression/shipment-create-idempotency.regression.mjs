/**
 * Forward shipment creation happens at most once (S3).
 *
 * Nothing used to stop two creations racing. A double click on Create Shipment, a second
 * admin, or the payment-verify path and the payment webhook each auto-pushing the same
 * order all read "no shiprocket.orderId" and all called Shiprocket — two courier orders
 * for one parcel. And the winner then `save()`d the whole `shiprocket` subdocument from
 * the snapshot it had loaded, wiping anything a courier webhook wrote meanwhile.
 *
 * createForwardShipment now claims the order atomically (syncStatus "creating" + a claim
 * token), builds the payload from the claimed document, and writes back only named paths
 * filtered on the token. This suite proves:
 *
 *   1. 5 concurrent CreateShipment calls + 1 auto-push → exactly ONE adhoc call, one id.
 *   2. A webhook write landing while the create request is in flight survives.
 *   3. A timeout leaves the order "creating" and nothing retries it.
 *   4. A definite 4xx marks it "failed", and a retry then succeeds.
 *   5. An order cancelled while the request is in flight gets its shipment cancelled.
 *   6. The stale-claim resolutions (link / confirm-not-created) work and are audited.
 *   7. An unpaid prepaid order is refused without contacting Shiprocket.
 *
 * Run with `npm run test:shipment-create-idempotency` (or `npm test`).
 *
 * `globalThis.fetch` is stubbed at the HTTP boundary, so the whole path runs for real:
 * controller → service → shiprocket.service → auth → HTTP. Unknown URLs throw.
 */
process.env.SHIPROCKET_ENABLED = "true";
process.env.SHIPROCKET_AUTO_CREATE_ORDER = "true";
process.env.SHIPROCKET_EMAIL = "stub@example.test";
process.env.SHIPROCKET_PASSWORD = "stub-password";
process.env.SHIPROCKET_BASE_URL = "https://shiprocket.invalid/v1/external";
process.env.NOTIFICATIONS_ENABLED = "false";
process.env.PAYMENTS_ENABLED = "false";

import mongoose from "mongoose";
import {
  addressFixture,
  connect,
  createSuite,
  marker,
  pinShiprocketCapabilities,
  productFixture,
} from "./helpers.mjs";

const { ok, section, finish } = createSuite("shipment-create-idempotency");
await connect();
const restoreCapabilities = await pinShiprocketCapabilities();

const OrderModel = (await import("../../src/modules/orders/Order.model.js")).default;
const ProductModel = (await import("../../src/modules/products/Product.model.js")).default;
const UserModel = (await import("../../src/model/User.model.js")).default;
const AuditLog = (await import("../../src/modules/audit/AuditLog.model.js")).default;
await import("../../src/modules/categories/Category.model.js");
const shippingController = await import("../../src/modules/shipping/shipping.controller.js");
const { syncOrderToShiprocketIfEnabled } = await import(
  "../../src/modules/orders/order-shipping.service.js"
);

// ── Shiprocket stub ─────────────────────────────────────────────────────────
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// Shiprocket ids are unique across the collection (shiprocket_orderId_unique), so they
// are namespaced per process to never collide with leftovers or a parallel run.
const ID_BASE = 700_000_000 + (process.pid % 100_000) * 100;
let idSeq = 0;
const nextIds = () => {
  idSeq += 1;
  return { order_id: ID_BASE + idSeq, shipment_id: ID_BASE + 50 + idSeq };
};

const sr = {
  adhocCalls: [],
  cancelCalls: [],
  showCalls: 0,
  // Replaced per scenario. Receives the parsed payload.
  adhoc: async () => jsonResponse({ ...nextIds(), status: "NEW", status_code: 1 }),
};

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = String(input instanceof URL ? input.href : input);
  if (url.includes("/auth/login")) return jsonResponse({ token: "stub-token" });
  if (url.includes("/orders/create/adhoc")) {
    const payload = JSON.parse(init.body || "{}");
    sr.adhocCalls.push(payload);
    return sr.adhoc(payload);
  }
  if (url.includes("/orders/cancel")) {
    sr.cancelCalls.push(JSON.parse(init.body || "{}").ids || []);
    return jsonResponse({ status: 200, message: "Order cancelled successfully" });
  }
  if (url.includes("/orders/show/")) {
    sr.showCalls += 1;
    // Not this suite's subject (cod-amount-guard covers it): an unrecognised shape,
    // which records `unverified` and blocks nothing.
    return jsonResponse({ data: { id: 1 } });
  }
  throw new Error(`Unexpected Shiprocket call in tests: ${url}`);
};

const resetStubs = () => {
  sr.adhocCalls = [];
  sr.cancelCalls = [];
  sr.showCalls = 0;
  sr.adhoc = async () => jsonResponse({ ...nextIds(), status: "NEW", status_code: 1 });
};

// ── Fixtures ────────────────────────────────────────────────────────────────
const MARKER = marker("shipcreate");
const trash = { orders: [], products: [], users: [] };

const customer = await UserModel.create({
  name: `${MARKER} customer`,
  email: `${MARKER}@test.local`,
  password: "x".repeat(60),
  roles: ["user"],
});
trash.users.push(customer._id);
const product = await ProductModel.create(
  productFixture(`${MARKER}-book`, { weight: 0.4, length: 20, breadth: 15, height: 3 }),
);
trash.products.push(product._id);

const makeOrder = async ({
  paymentMethod = "COD",
  paymentStatus = "Pending",
  orderStatus = "Confirmed",
  user = customer._id,
  ...fields
} = {}) => {
  const order = await OrderModel.create({
    user,
    items: [{ product: product._id, name: product.name, image: "x.png", price: 250, quantity: 2 }],
    shippingAddress: addressFixture(),
    paymentMethod,
    paymentStatus,
    orderStatus,
    subtotal: 500,
    shippingCharge: 40,
    totalAmount: 540,
    ...fields,
  });
  trash.orders.push(order._id);
  return order;
};

const admin = () => ({ id: String(new mongoose.Types.ObjectId()), roles: ["admin"] });

const callController = async (handler, { params = {}, body = {}, user = admin() } = {}) => {
  let statusCode = 200;
  let payload;
  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(data) {
      payload = data;
      return this;
    },
  };
  await handler({ params, body, user, query: {}, headers: {}, ip: "127.0.0.1" }, res);
  return { statusCode, body: payload };
};

const create = (order, extra = {}) =>
  callController(shippingController.CreateShipment, { params: { orderId: String(order._id) }, ...extra });

const fresh = (order) => OrderModel.findById(order._id).lean();

const waitFor = async (predicate, label, timeoutMs = 5000) => {
  const started = Date.now();
  while (!(await predicate())) {
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

try {
  // ═══ 1 + 2. Concurrency, and a webhook write during the request ═══════════
  section("1. Five concurrent clicks and an auto-push create ONE shipment");
  {
    resetStubs();
    const order = await makeOrder();
    const entered = deferred();
    const release = deferred();
    let ids;
    sr.adhoc = async () => {
      ids = nextIds();
      entered.resolve();
      await release.promise;
      return jsonResponse({ ...ids, status: "NEW", status_code: 1 });
    };

    let settled = 0;
    const track = (promise) =>
      promise.finally(() => {
        settled += 1;
      });
    const clicks = Array.from({ length: 5 }, () => track(create(order)));
    const autoPush = track(syncOrderToShiprocketIfEnabled(order).then(() => "auto-push"));

    await entered.promise;
    // Every caller except the winner must have been answered while the winner's request
    // is still in flight — that is what "they were refused, not queued" means.
    await waitFor(async () => settled >= 5, "the five losing callers");

    // A courier webhook lands between Shiprocket creating the order and our write-back.
    await OrderModel.updateOne(
      { _id: order._id },
      { $set: { "shiprocket.status": "PICKUP SCHEDULED", "shiprocket.statusCode": 42 } },
    );
    const midFlight = await fresh(order);
    ok(
      "while in flight the order reads \"creating\" with a claim held",
      midFlight.shiprocket.syncStatus === "creating" && Boolean(midFlight.shiprocket.claimToken),
      JSON.stringify({ sync: midFlight.shiprocket.syncStatus, token: midFlight.shiprocket.claimToken }),
    );

    release.resolve();
    const results = await Promise.all(clicks);
    await autoPush;

    ok("exactly ONE adhoc call reached Shiprocket", sr.adhocCalls.length === 1, `${sr.adhocCalls.length} calls`);
    const created = results.filter((r) => r.statusCode === 201);
    const refused = results.filter(
      (r) => r.statusCode === 409 && r.body?.code === "SHIPMENT_CREATION_IN_PROGRESS",
    );
    ok(
      "every other click was refused as already in progress (one of the six won)",
      created.length + refused.length === 5 && created.length <= 1,
      JSON.stringify(results.map((r) => [r.statusCode, r.body?.code])),
    );

    const after = await fresh(order);
    ok(
      "one Shiprocket order id is stored, the one Shiprocket returned",
      after.shiprocket.orderId === ids.order_id && after.shiprocket.shipmentId === ids.shipment_id,
      JSON.stringify({ orderId: after.shiprocket.orderId, shipmentId: after.shiprocket.shipmentId }),
    );
    ok(
      "the payload named this order",
      sr.adhocCalls[0]?.order_id === String(order._id),
      sr.adhocCalls[0]?.order_id,
    );
    ok("syncStatus moved from creating to created", after.shiprocket.syncStatus === "created", after.shiprocket.syncStatus);
    ok(
      "the claim was released",
      !after.shiprocket.claimToken && !after.shiprocket.claimedAt,
      JSON.stringify({ token: after.shiprocket.claimToken, at: after.shiprocket.claimedAt }),
    );
    ok("exactly one attempt was counted", after.shiprocket.attempts === 1, String(after.shiprocket.attempts));

    section("2. A webhook write during creation survives the write-back");
    ok(
      "the webhook's status is kept, not overwritten with the create response's NEW",
      after.shiprocket.status === "PICKUP SCHEDULED" && after.shiprocket.statusCode === 42,
      JSON.stringify({ status: after.shiprocket.status, code: after.shiprocket.statusCode }),
    );
    ok(
      "the provider-neutral mirror is written, its status taken from the order",
      after.shipment?.provider === "SHIPROCKET" && after.shipment?.status === "Confirmed",
      JSON.stringify(after.shipment),
    );

    // A click after success is the old "already synced" answer.
    const again = await create(order);
    ok(
      "a later click is answered 200 already-synced, with no new call",
      again.statusCode === 200 && /already synced/i.test(again.body?.message || "") && sr.adhocCalls.length === 1,
      `${again.statusCode} ${again.body?.message} calls=${sr.adhocCalls.length}`,
    );
  }

  // ═══ 3. Timeout / transport error ═════════════════════════════════════════
  section("3. A timeout stays \"creating\" and is never retried automatically");
  let stuckOrder;
  {
    resetStubs();
    stuckOrder = await makeOrder();
    sr.adhoc = async () => {
      throw new Error("The operation was aborted due to timeout");
    };
    const result = await create(stuckOrder);
    ok(
      "the admin is told the outcome is uncertain",
      result.statusCode === 503 && result.body?.code === "SHIPMENT_CREATE_UNCERTAIN",
      `${result.statusCode} ${result.body?.code}`,
    );
    const after = await fresh(stuckOrder);
    ok(
      "the order stays creating, claim held",
      after.shiprocket.syncStatus === "creating" && Boolean(after.shiprocket.claimToken),
      after.shiprocket.syncStatus,
    );
    ok("the reason is recorded", /timeout/i.test(after.shiprocket.lastError || ""), after.shiprocket.lastError);

    sr.adhoc = async () => jsonResponse({ ...nextIds(), status: "NEW" });
    const retry = await create(stuckOrder);
    await syncOrderToShiprocketIfEnabled(stuckOrder);
    ok(
      "a second click is refused as in progress",
      retry.statusCode === 409 && retry.body?.code === "SHIPMENT_CREATION_IN_PROGRESS",
      `${retry.statusCode} ${retry.body?.code}`,
    );
    ok("and neither it nor an auto-push called Shiprocket again", sr.adhocCalls.length === 1, `${sr.adhocCalls.length} calls`);
  }
  {
    resetStubs();
    const order = await makeOrder();
    sr.adhoc = async () => jsonResponse({ message: "Internal Server Error" }, 500);
    const result = await create(order);
    const after = await fresh(order);
    ok(
      "a 5xx is treated the same way — the order may exist",
      result.body?.code === "SHIPMENT_CREATE_UNCERTAIN" && after.shiprocket.syncStatus === "creating",
      `${result.statusCode} ${result.body?.code} ${after.shiprocket.syncStatus}`,
    );
  }
  {
    resetStubs();
    const order = await makeOrder();
    // 200 with no ids: Shiprocket answered, so something may have been created.
    sr.adhoc = async () => jsonResponse({ message: "queued" });
    await create(order);
    const after = await fresh(order);
    ok(
      "a 200 without ids is uncertain too, never \"failed\"",
      after.shiprocket.syncStatus === "creating",
      after.shiprocket.syncStatus,
    );
  }

  // ═══ 4. Definite rejection ════════════════════════════════════════════════
  section("4. A definite 4xx marks it failed, and a retry succeeds");
  {
    resetStubs();
    const order = await makeOrder();
    sr.adhoc = async () => jsonResponse({ message: "Invalid delivery pincode" }, 422);
    const result = await create(order);
    let after = await fresh(order);
    ok(
      "the refusal is reported as a failure",
      result.body?.code === "SHIPMENT_CREATE_FAILED" && /pincode/i.test(result.body?.message || ""),
      `${result.statusCode} ${result.body?.code} ${result.body?.message}`,
    );
    ok(
      "syncStatus is failed and the claim is released",
      after.shiprocket.syncStatus === "failed" && !after.shiprocket.claimToken,
      JSON.stringify({ sync: after.shiprocket.syncStatus, token: after.shiprocket.claimToken }),
    );

    sr.adhoc = async () => jsonResponse({ ...nextIds(), status: "NEW" });
    const retry = await create(order);
    after = await fresh(order);
    ok("the retry is accepted", retry.statusCode === 201, `${retry.statusCode} ${retry.body?.message}`);
    ok(
      "and creates the shipment on the second attempt",
      after.shiprocket.syncStatus === "created" && after.shiprocket.attempts === 2 && sr.adhocCalls.length === 2,
      JSON.stringify({ sync: after.shiprocket.syncStatus, attempts: after.shiprocket.attempts, calls: sr.adhocCalls.length }),
    );
    ok("lastError is cleared", after.shiprocket.lastError === null, after.shiprocket.lastError);
  }
  {
    // Failing before the request is sent is as safe to retry as a 4xx.
    resetStubs();
    const emailless = await UserModel.create({
      name: `${MARKER} no-email`,
      email: `${MARKER}-noemail@test.local`,
      password: "x".repeat(60),
      roles: ["user"],
    });
    trash.users.push(emailless._id);
    const order = await makeOrder({ user: emailless._id });
    await UserModel.deleteOne({ _id: emailless._id });
    const result = await create(order);
    const after = await fresh(order);
    ok(
      "a missing customer email fails before any request, as \"failed\"",
      sr.adhocCalls.length === 0 && after.shiprocket.syncStatus === "failed" && result.statusCode === 400,
      `${result.statusCode} ${after.shiprocket.syncStatus} calls=${sr.adhocCalls.length}`,
    );
  }

  // ═══ 5. Cancelled while in flight ═════════════════════════════════════════
  section("5. An order cancelled during creation has its new shipment cancelled");
  {
    resetStubs();
    const order = await makeOrder();
    const entered = deferred();
    const release = deferred();
    let ids;
    sr.adhoc = async () => {
      ids = nextIds();
      entered.resolve();
      await release.promise;
      return jsonResponse({ ...ids, status: "NEW" });
    };
    const pending = create(order);
    await entered.promise;
    // The cancellation commits while Shiprocket is creating the order; it found no
    // shipment to cancel, because none was recorded yet.
    await OrderModel.updateOne({ _id: order._id }, { $set: { orderStatus: "Cancelled" } });
    release.resolve();
    await pending;

    const after = await fresh(order);
    ok("the shipment was still recorded", after.shiprocket.orderId === ids.order_id, String(after.shiprocket.orderId));
    ok(
      "and immediately cancelled at Shiprocket",
      sr.cancelCalls.length === 1 && sr.cancelCalls[0][0] === ids.order_id,
      JSON.stringify(sr.cancelCalls),
    );
    ok("syncStatus reads cancelled", after.shiprocket.syncStatus === "cancelled", after.shiprocket.syncStatus);
  }

  // ═══ 6. Stale-claim resolution ════════════════════════════════════════════
  section("6. Link existing / confirm not created");
  {
    resetStubs();
    const link = (order, body, user) =>
      callController(shippingController.LinkShipment, { params: { orderId: String(order._id) }, body, user });
    const actor = admin();
    const ids = nextIds();
    const linked = await link(stuckOrder, { shiprocketOrderId: ids.order_id, shipmentId: ids.shipment_id }, actor);
    const after = await fresh(stuckOrder);
    ok("linking a stuck creation succeeds", linked.statusCode === 200, `${linked.statusCode} ${linked.body?.message}`);
    ok(
      "the ids are stored by the same write-back as a create",
      after.shiprocket.orderId === ids.order_id &&
        after.shiprocket.shipmentId === ids.shipment_id &&
        after.shiprocket.syncStatus === "created" &&
        after.shiprocket.status === "NEW" &&
        !after.shiprocket.claimToken &&
        after.shiprocket.lastError === null,
      JSON.stringify(after.shiprocket),
    );
    ok("no shipment was created to link it", sr.adhocCalls.length === 0, `${sr.adhocCalls.length} calls`);
    const audit = await AuditLog.findOne({ targetId: stuckOrder._id, action: "LINK_SHIPMENT" }).lean();
    ok(
      "the link is audited against the admin",
      audit && String(audit.admin) === actor.id && audit.description.includes(String(ids.order_id)),
      JSON.stringify(audit),
    );

    const twice = await link(stuckOrder, { shiprocketOrderId: ids.order_id + 1, shipmentId: ids.shipment_id + 1 });
    ok(
      "a shipment that is no longer creating cannot be linked over",
      twice.statusCode === 409 && twice.body?.code === "SHIPMENT_NOT_CREATING",
      `${twice.statusCode} ${twice.body?.code}`,
    );

    // A second stuck order, linked to ids already taken by the first.
    sr.adhoc = async () => {
      throw new Error("socket hang up");
    };
    const other = await makeOrder();
    await create(other);
    const conflict = await link(other, { shiprocketOrderId: ids.order_id, shipmentId: 1 });
    ok(
      "ids already belonging to another order are refused as a conflict",
      conflict.statusCode === 409 && conflict.body?.code === "SHIPMENT_ID_CONFLICT",
      `${conflict.statusCode} ${conflict.body?.code}`,
    );
    ok(
      "and the stuck order is left untouched",
      (await fresh(other)).shiprocket.syncStatus === "creating",
    );

    const confirm = (order, user) =>
      callController(shippingController.ConfirmShipmentNotCreated, { params: { orderId: String(order._id) }, user });
    const confirmed = await confirm(other, actor);
    const afterConfirm = await fresh(other);
    ok("confirming not-created succeeds", confirmed.statusCode === 200, `${confirmed.statusCode} ${confirmed.body?.message}`);
    ok(
      "it moves to failed and releases the claim",
      afterConfirm.shiprocket.syncStatus === "failed" && !afterConfirm.shiprocket.claimToken,
      JSON.stringify({ sync: afterConfirm.shiprocket.syncStatus, token: afterConfirm.shiprocket.claimToken }),
    );
    ok(
      "and is audited",
      Boolean(await AuditLog.exists({ targetId: other._id, action: "CONFIRM_SHIPMENT_NOT_CREATED" })),
    );
    const again = await confirm(other);
    ok(
      "a second confirmation is refused — it is no longer creating",
      again.statusCode === 409 && again.body?.code === "SHIPMENT_NOT_CREATING",
      `${again.statusCode} ${again.body?.code}`,
    );

    sr.adhoc = async () => jsonResponse({ ...nextIds(), status: "NEW" });
    const before = sr.adhocCalls.length;
    const retried = await create(other);
    ok(
      "after confirmation the shipment can be created again",
      retried.statusCode === 201 && sr.adhocCalls.length === before + 1,
      `${retried.statusCode} calls=${sr.adhocCalls.length - before}`,
    );
  }

  // ═══ 7. Unpaid prepaid order ══════════════════════════════════════════════
  section("7. An order awaiting payment is never sent to Shiprocket");
  {
    resetStubs();
    const unpaid = await makeOrder({ paymentMethod: "RAZORPAY", paymentStatus: "Pending", orderStatus: "Pending" });
    const result = await create(unpaid);
    ok(
      "refused with PAYMENT_NOT_CAPTURED",
      result.statusCode === 409 && result.body?.code === "PAYMENT_NOT_CAPTURED",
      `${result.statusCode} ${result.body?.code}`,
    );
    // Even if its order status were (wrongly) promoted, an unpaid order stays unshippable.
    const promoted = await makeOrder({ paymentMethod: "RAZORPAY", paymentStatus: "Pending", orderStatus: "Confirmed" });
    const second = await create(promoted);
    await syncOrderToShiprocketIfEnabled(promoted);
    ok(
      "the payment check does not depend on the order status",
      second.statusCode === 409 && second.body?.code === "PAYMENT_NOT_CAPTURED",
      `${second.statusCode} ${second.body?.code}`,
    );
    ok("and Shiprocket was never contacted", sr.adhocCalls.length === 0, `${sr.adhocCalls.length} calls`);
    const untouched = await fresh(promoted);
    ok(
      "the order is left as it was, not marked failed",
      untouched.shiprocket.syncStatus === "not_created" && !untouched.shiprocket.attempts,
      JSON.stringify({ sync: untouched.shiprocket.syncStatus, attempts: untouched.shiprocket.attempts }),
    );
  }
} catch (error) {
  console.error(`\nSUITE ABORTED: ${error?.stack || error}`);
  ok("suite ran to completion", false, error?.message);
} finally {
  globalThis.fetch = realFetch;
  await AuditLog.deleteMany({ targetId: { $in: trash.orders } });
  await OrderModel.deleteMany({ _id: { $in: trash.orders } });
  await ProductModel.deleteMany({ _id: { $in: trash.products } });
  await UserModel.deleteMany({ _id: { $in: trash.users } });
  restoreCapabilities();
  const { failed } = finish();
  await mongoose.disconnect();
  process.exit(failed ? 1 : 0);
}
