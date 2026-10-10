/**
 * Manual replacement fulfilment (audit H2-06, Tier 1).
 *
 *   received ──▶ replacement_dispatched ──▶ replacement_delivered
 *
 * A replacement used to be closed out in one click ("replaced"), which stamped a
 * timestamp and restocked the returned unit while the replacement parcel had not
 * been packed. Two consequences:
 *
 *   1. the operator believed the case was finished and the customer had nothing
 *      to track — the UI even claimed the parcel had been dispatched;
 *   2. NOTHING deducted the outbound unit. `decrementStock` was only ever called
 *      at checkout, on reservation and at payment capture, so every completed
 *      replacement inflated sellable stock by its own quantity — in BOTH
 *      dispositions.
 *
 * Run with `npm run test:replacement-fulfilment` (or `npm test` for everything).
 *
 * Tier 1 is manual fulfilment only: no Shiprocket, no webhook, no shipment entity.
 * Those are H2-07 and are deliberately absent here.
 */
process.env.INVENTORY_ENFORCE_STOCK = "true";
process.env.NOTIFICATIONS_ENABLED = "false";
process.env.PAYMENTS_ENABLED = "false";
process.env.SHIPROCKET_ENABLED = "false";

import mongoose from "mongoose";
import { readFile } from "node:fs/promises";
import { connect, createSuite, marker, productFixture, addressFixture } from "./helpers.mjs";

const { ok, section, finish } = createSuite("replacement-fulfilment");
await connect();

const OrderModel = (await import("../../src/modules/orders/Order.model.js")).default;
const ProductModel = (await import("../../src/modules/products/Product.model.js")).default;
const ReturnModel = (await import("../../src/modules/returns/return.model.js")).default;
const {
  OPEN_RETURN_STATUSES,
  QUANTITY_CONSUMING_RETURN_STATUSES,
  RETURN_STATUSES,
} = await import("../../src/modules/returns/return.model.js");
await import("../../src/modules/categories/Category.model.js");
const returnController = await import("../../src/modules/returns/return.controller.js");
const { deductReplacementStock } = await import("../../src/modules/inventory/restock.service.js");

// The partial unique index's filter is built from OPEN_RETURN_STATUSES, and adding a
// status changes its spec under the same name — which MongoDB refuses to redefine.
// Mirrors scripts/migrate-return-open-index.js so the suite runs post-migration.
const applyOpenReturnIndex = async () => {
  await ReturnModel.createIndexes().catch(() => {});
  const name = "one_open_return_per_order_line";
  const expected = JSON.stringify({ status: { $in: OPEN_RETURN_STATUSES } });
  const existing = (await ReturnModel.collection.indexes()).find((i) => i.name === name);
  if (existing && JSON.stringify(existing.partialFilterExpression) !== expected) {
    await ReturnModel.collection.dropIndex(name).catch(() => {});
  }
  await ReturnModel.collection
    .createIndex(
      { order: 1, product: 1, user: 1 },
      { name, unique: true, partialFilterExpression: { status: { $in: OPEN_RETURN_STATUSES } } },
    )
    .catch(() => {});
};
await applyOpenReturnIndex();

const MARKER = marker("replfulfil");
const trash = { orders: [], products: [], returns: [] };
let seq = 0;

const makeProduct = async (label, { kind = "replacement", stock = 50 } = {}) => {
  const product = await ProductModel.create(
    productFixture(`${MARKER}-${label}`, { stock, returnPolicy: { kind, windowDays: 90 } }),
  );
  trash.products.push(product._id);
  return product;
};

const makeDeliveredOrder = async ({ product, units, userId = new mongoose.Types.ObjectId() }) => {
  seq += 1;
  const subtotal = product.price * units;
  const order = await OrderModel.create({
    user: userId,
    items: [
      { product: product._id, name: product.name, image: "x.png", price: product.price, quantity: units },
    ],
    shippingAddress: addressFixture(),
    paymentMethod: "RAZORPAY",
    paymentStatus: "Paid",
    orderStatus: "Delivered",
    deliveredAt: new Date(),
    subtotal,
    totalAmount: subtotal,
    razorpayPaymentId: `pay_${MARKER}_${seq}`,
    shiprocket: { orderId: 970000 + seq, shipmentId: 870000 + seq, awbCode: `AWB-${MARKER}-${seq}`, syncStatus: "awb_assigned", status: "DELIVERED" },
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

const createReturn = async ({ order, product, quantity = 1 }) => {
  const response = await callController(returnController.CreateReturnRequest, {
    body: { orderId: String(order._id), productId: String(product._id), quantity, reason: "Faulty" },
    user: { id: String(order.user), roles: [] },
  });
  if (response.body?.data?._id) trash.returns.push(response.body.data._id);
  return response;
};

/** Walks a fresh return to "received" through the real admin endpoint. */
const advanceToReceived = async (returnId) => {
  for (const status of ["approved", "pickup_scheduled", "received"]) {
    const response = await callController(returnController.AdminUpdateReturnStatus, {
      params: { id: String(returnId) },
      body: { status },
      user: admin(),
    });
    if (response.statusCode !== 200) return response;
  }
  return { statusCode: 200 };
};

const dispatchReplacement = (returnId, body = {}) =>
  callController(returnController.DispatchReplacement, {
    params: { id: String(returnId) },
    body: { courier: "Delhivery", awb: `AWB-R-${MARKER}-${returnId}`, disposition: "resellable", ...body },
    user: admin(),
  });

const confirmDelivery = (returnId, body = {}) =>
  callController(returnController.ConfirmReplacementDelivery, {
    params: { id: String(returnId) },
    body,
    user: admin(),
  });

const stockOf = async (productId) => (await ProductModel.findById(productId)).stock;
const freshReturn = (id) => ReturnModel.findById(id);
const freshOrder = (id) => OrderModel.findById(id);

/** A replacement return sitting at "received", ready to dispatch. */
const readyReplacement = async ({ label, units = 1, stock = 50 }) => {
  const product = await makeProduct(label, { stock });
  const order = await makeDeliveredOrder({ product, units });
  const created = await createReturn({ order, product, quantity: units });
  if (created.statusCode !== 201) throw new Error(`fixture failed: ${created.body?.message}`);
  const advanced = await advanceToReceived(created.body.data._id);
  if (advanced.statusCode !== 200) throw new Error(`fixture advance failed: ${advanced.body?.message}`);
  return { product, order, returnId: created.body.data._id, units };
};

try {
  // ═══════════════════════════════════════════════════════════════════════════
  section("the state machine");

  {
    ok('"replacement_dispatched" is a real status', RETURN_STATUSES.includes("replacement_dispatched"));
    ok('"replacement_delivered" is a real status', RETURN_STATUSES.includes("replacement_delivered"));
    ok('the legacy "replaced" status is retained', RETURN_STATUSES.includes("replaced"));
    ok(
      "a dispatched replacement is OPEN — the order line stays occupied",
      OPEN_RETURN_STATUSES.includes("replacement_dispatched"),
    );
    ok(
      "a delivered replacement is NOT open — the case is finished",
      !OPEN_RETURN_STATUSES.includes("replacement_delivered"),
    );
    ok(
      "both consume return quantity (only `rejected` does not)",
      QUANTITY_CONSUMING_RETURN_STATUSES.includes("replacement_dispatched") &&
        QUANTITY_CONSUMING_RETURN_STATUSES.includes("replacement_delivered"),
    );
  }

  section("1 — the happy path");

  {
    const { product, returnId, order } = await readyReplacement({ label: "happy", units: 1, stock: 50 });
    const before = await stockOf(product._id);
    ok("stock before dispatch is 50", before === 50, String(before));

    const dispatched = await dispatchReplacement(returnId);
    ok("dispatch succeeds", dispatched.statusCode === 200, `${dispatched.statusCode} ${dispatched.body?.message || ""}`);

    let ret = await freshReturn(returnId);
    ok("status is replacement_dispatched", ret.status === "replacement_dispatched", ret.status);
    ok("the courier is recorded", ret.replacementCourier === "Delhivery", ret.replacementCourier);
    ok("the AWB is recorded", Boolean(ret.replacementAwb), "missing");
    ok("dispatchedAt is stamped", Boolean(ret.replacementDispatchedAt));
    ok("the stock deduction claim is stamped", Boolean(ret.replacementStockDeductedAt));
    ok(
      "history records the dispatch",
      ret.statusHistory.at(-1).status === "replacement_dispatched",
      ret.statusHistory.at(-1).status,
    );

    const delivered = await confirmDelivery(returnId);
    ok("delivery confirmation succeeds", delivered.statusCode === 200, `${delivered.statusCode} ${delivered.body?.message || ""}`);
    ret = await freshReturn(returnId);
    ok("status is replacement_delivered", ret.status === "replacement_delivered", ret.status);
    ok("deliveredAt is stamped", Boolean(ret.replacementDeliveredAt));
    ok(
      "history records the delivery",
      ret.statusHistory.at(-1).status === "replacement_delivered",
      ret.statusHistory.at(-1).status,
    );

    // 14 — the original order's shipment must be untouched throughout.
    const o = await freshOrder(order._id);
    ok(
      "the original order's Shiprocket shipment is untouched",
      o.shiprocket.awbCode === `AWB-${MARKER}-${seq}` || String(o.shiprocket.awbCode).startsWith("AWB-"),
      String(o.shiprocket.awbCode),
    );
    ok("its syncStatus is unchanged", o.shiprocket.syncStatus === "awb_assigned", o.shiprocket.syncStatus);
    ok("the order status is still Delivered", o.orderStatus === "Delivered", o.orderStatus);
  }

  section("2 — invalid transitions");

  {
    const { returnId } = await readyReplacement({ label: "invalid" });

    // Delivery before dispatch.
    const early = await confirmDelivery(returnId);
    ok("delivery cannot be confirmed before dispatch", early.statusCode === 409, String(early.statusCode));
    ok("with REPLACEMENT_NOT_DISPATCHED", early.body?.code === "REPLACEMENT_NOT_DISPATCHED", early.body?.code);

    // The status endpoint must refuse both replacement states. From "received" the
    // dispatch transition IS legal, so the dedicated-endpoint guard is what refuses
    // it; the delivered transition is not legal from here, so the transition check
    // refuses it first. Both are correct refusals — assert each for what it is.
    const viaStatusDispatch = await callController(returnController.AdminUpdateReturnStatus, {
      params: { id: String(returnId) },
      body: { status: "replacement_dispatched", disposition: "resellable" },
      user: admin(),
    });
    ok(
      "the status endpoint refuses replacement_dispatched with USE_REPLACEMENT_ENDPOINT",
      viaStatusDispatch.statusCode === 400 &&
        viaStatusDispatch.body?.code === "USE_REPLACEMENT_ENDPOINT",
      `${viaStatusDispatch.statusCode} ${viaStatusDispatch.body?.code}`,
    );

    const viaStatusDelivered = await callController(returnController.AdminUpdateReturnStatus, {
      params: { id: String(returnId) },
      body: { status: "replacement_delivered", disposition: "resellable" },
      user: admin(),
    });
    ok(
      "and refuses replacement_delivered from received — not a legal transition",
      viaStatusDelivered.statusCode === 400,
      `${viaStatusDelivered.statusCode} ${viaStatusDelivered.body?.message || ""}`,
    );

    // From a genuinely dispatched return the transition IS legal, so the guard is
    // what has to stop it there too.
    const dispatchedFixture = await readyReplacement({ label: "guard-dispatched" });
    await dispatchReplacement(dispatchedFixture.returnId);
    const guarded = await callController(returnController.AdminUpdateReturnStatus, {
      params: { id: String(dispatchedFixture.returnId) },
      body: { status: "replacement_delivered" },
      user: admin(),
    });
    ok(
      "the status endpoint refuses replacement_delivered even where it is a legal move",
      guarded.statusCode === 400 && guarded.body?.code === "USE_REPLACEMENT_ENDPOINT",
      `${guarded.statusCode} ${guarded.body?.code}`,
    );

    // The old one-click close-out is no longer reachable.
    const legacyShortcut = await callController(returnController.AdminUpdateReturnStatus, {
      params: { id: String(returnId) },
      body: { status: "replaced", disposition: "resellable" },
      user: admin(),
    });
    ok(
      'received → "replaced" is no longer allowed (the shortcut that skipped stock)',
      legacyShortcut.statusCode === 400,
      `${legacyShortcut.statusCode} ${legacyShortcut.body?.message || ""}`,
    );

    // Dispatch is only valid from "received".
    await ReturnModel.updateOne({ _id: returnId }, { $set: { status: "pending" } });
    const tooEarly = await dispatchReplacement(returnId);
    ok("dispatch is refused before the item is received", tooEarly.statusCode === 409, String(tooEarly.statusCode));
    ok("with RETURN_NOT_RECEIVED", tooEarly.body?.code === "RETURN_NOT_RECEIVED", tooEarly.body?.code);
  }

  {
    // A refund-typed return must not enter the replacement lifecycle.
    const product = await makeProduct("refundtype", { kind: "return" });
    const order = await makeDeliveredOrder({ product, units: 1 });
    const created = await createReturn({ order, product, quantity: 1 });
    ok("a refund return is created", created.statusCode === 201, String(created.statusCode));
    await advanceToReceived(created.body.data._id);

    const response = await dispatchReplacement(created.body.data._id);
    ok("a refund return cannot be dispatched as a replacement", response.statusCode === 400, String(response.statusCode));
    ok("with NOT_A_REPLACEMENT", response.body?.code === "NOT_A_REPLACEMENT", response.body?.code);
  }

  section("3/4 — dispatch requires courier, AWB and a disposition");

  {
    const { returnId, product } = await readyReplacement({ label: "requirements" });
    const stockBefore = await stockOf(product._id);

    for (const [label, body] of [
      ["no courier", { courier: "" }],
      ["no AWB", { awb: "" }],
      ["neither", { courier: "", awb: "" }],
    ]) {
      const response = await dispatchReplacement(returnId, body);
      ok(`dispatch refused with ${label}`, response.statusCode === 400, String(response.statusCode));
      ok(
        "  with REPLACEMENT_TRACKING_REQUIRED",
        response.body?.code === "REPLACEMENT_TRACKING_REQUIRED",
        response.body?.code,
      );
    }

    const noDisposition = await dispatchReplacement(returnId, { disposition: "" });
    ok("dispatch refused without a disposition", noDisposition.statusCode === 400, String(noDisposition.statusCode));
    ok("with DISPOSITION_REQUIRED", noDisposition.body?.code === "DISPOSITION_REQUIRED", noDisposition.body?.code);

    ok(
      "and none of those refusals moved the status",
      (await freshReturn(returnId)).status === "received",
      (await freshReturn(returnId)).status,
    );
    ok("nor any stock", (await stockOf(product._id)) === stockBefore, String(await stockOf(product._id)));
  }

  section("5/6 — stock is deducted exactly once");

  {
    const { product, returnId } = await readyReplacement({ label: "deduct-once", units: 2, stock: 50 });
    await dispatchReplacement(returnId);

    // resellable: +2 inbound restock, −2 outbound deduction = net zero.
    ok(
      "a resellable replacement nets ZERO stock movement (50 → 50)",
      (await stockOf(product._id)) === 50,
      String(await stockOf(product._id)),
    );
    const ret = await freshReturn(returnId);
    ok("the inbound restock happened", Boolean(ret.restockedAt));
    ok("and the outbound deduction happened", Boolean(ret.replacementStockDeductedAt));

    // A repeat dispatch loses the status claim, so nothing moves.
    const repeat = await dispatchReplacement(returnId);
    ok("a repeat dispatch is refused", repeat.statusCode === 409, String(repeat.statusCode));
    ok(
      "and deducts nothing further",
      (await stockOf(product._id)) === 50,
      String(await stockOf(product._id)),
    );

    // Even calling the deduction directly again must be a no-op.
    const again = await deductReplacementStock({ returnRequest: await freshReturn(returnId) });
    ok("the deduction itself is idempotent", again.deducted === false && again.reason === "already_deducted", JSON.stringify(again));
    ok("stock still 50", (await stockOf(product._id)) === 50, String(await stockOf(product._id)));
  }

  {
    // Concurrency: five simultaneous dispatches.
    const { product, returnId } = await readyReplacement({ label: "concurrent", units: 1, stock: 50 });
    const results = await Promise.all(Array.from({ length: 5 }, () => dispatchReplacement(returnId)));

    ok(
      "exactly one concurrent dispatch succeeds",
      results.filter((r) => r.statusCode === 200).length === 1,
      JSON.stringify(results.map((r) => r.statusCode)),
    );
    ok(
      "the rest are refused 409",
      results.filter((r) => r.statusCode === 409).length === 4,
      String(results.filter((r) => r.statusCode === 409).length),
    );
    ok(
      "and stock moved once only — net zero for a resellable return",
      (await stockOf(product._id)) === 50,
      String(await stockOf(product._id)),
    );
    const ret = await freshReturn(returnId);
    ok(
      "one dispatch history entry",
      ret.statusHistory.filter((e) => e.status === "replacement_dispatched").length === 1,
      JSON.stringify(ret.statusHistory.map((e) => e.status)),
    );
  }

  section("7 — insufficient stock refuses the dispatch");

  {
    const { product, returnId } = await readyReplacement({ label: "nostock", units: 3, stock: 50 });
    // Drop stock below the replacement quantity.
    await ProductModel.updateOne({ _id: product._id }, { $set: { stock: 2 } });

    const response = await dispatchReplacement(returnId);
    ok("dispatch is refused", response.statusCode === 409, `${response.statusCode} ${response.body?.message || ""}`);
    ok(
      "with INSUFFICIENT_REPLACEMENT_STOCK",
      response.body?.code === "INSUFFICIENT_REPLACEMENT_STOCK",
      response.body?.code,
    );

    const ret = await freshReturn(returnId);
    ok("the status is rolled back to received", ret.status === "received", ret.status);
    ok("no dispatch timestamp", !ret.replacementDispatchedAt);
    ok(
      "the deduction claim was RELEASED so a later dispatch can still work",
      !ret.replacementStockDeductedAt,
      String(ret.replacementStockDeductedAt),
    );
    ok("no courier or AWB stored", !ret.replacementCourier && !ret.replacementAwb);
    ok("and stock is untouched at 2", (await stockOf(product._id)) === 2, String(await stockOf(product._id)));
    ok("no inbound restock happened either", !ret.restockedAt);

    // Restock and it goes through.
    await ProductModel.updateOne({ _id: product._id }, { $set: { stock: 10 } });
    const retry = await dispatchReplacement(returnId);
    ok("once restocked, the dispatch succeeds", retry.statusCode === 200, `${retry.statusCode} ${retry.body?.message || ""}`);
    ok(
      "net zero again: 10 + 3 inbound − 3 outbound = 10",
      (await stockOf(product._id)) === 10,
      String(await stockOf(product._id)),
    );
  }

  section("8 — damaged vs resellable inbound behaviour");

  {
    const { product, returnId } = await readyReplacement({ label: "damaged", units: 2, stock: 50 });
    const response = await dispatchReplacement(returnId, { disposition: "damaged" });
    ok("a damaged-inbound dispatch succeeds", response.statusCode === 200, `${response.statusCode} ${response.body?.message || ""}`);

    const ret = await freshReturn(returnId);
    ok("the disposition is recorded as damaged", ret.disposition === "damaged", ret.disposition);
    ok("nothing was restocked inbound", !ret.restockedAt, String(ret.restockedAt));
    ok("but the outbound unit WAS deducted", Boolean(ret.replacementStockDeductedAt));
    ok(
      "so a damaged replacement nets MINUS the replacement quantity (50 → 48)",
      (await stockOf(product._id)) === 48,
      String(await stockOf(product._id)),
    );
  }

  {
    // The resellable counterpart, stated as the invariant.
    const { product, returnId } = await readyReplacement({ label: "resellable", units: 2, stock: 30 });
    await dispatchReplacement(returnId, { disposition: "resellable" });
    ok(
      "returned resellable unit restocked + replacement deducted = net zero (30 → 30)",
      (await stockOf(product._id)) === 30,
      String(await stockOf(product._id)),
    );
  }

  section("9/10 — money is untouched at every stage");

  {
    const { product, order, returnId } = await readyReplacement({ label: "money", units: 1 });
    const before = await freshOrder(order._id);
    ok("no refund rows before", (before.refunds || []).length === 0);
    ok("paymentStatus is Paid", before.paymentStatus === "Paid", before.paymentStatus);

    await dispatchReplacement(returnId);
    let o = await freshOrder(order._id);
    ok("dispatch creates NO refund row", (o.refunds || []).length === 0, String((o.refunds || []).length));
    ok("and does not change paymentStatus", o.paymentStatus === "Paid", o.paymentStatus);

    await confirmDelivery(returnId);
    o = await freshOrder(order._id);
    ok("delivery creates NO refund row", (o.refunds || []).length === 0, String((o.refunds || []).length));
    ok("and does not change paymentStatus", o.paymentStatus === "Paid", o.paymentStatus);
    ok("nor the order status", o.orderStatus === "Delivered", o.orderStatus);

    const ret = await freshReturn(returnId);
    ok("no refundedAt on a replacement", !ret.refundedAt);
    ok(
      "the legacy refundAmount field is left as-is (never paid, per the audit)",
      typeof ret.refundAmount === "number",
      String(ret.refundAmount),
    );
    void product;
  }

  section("11 — H2-02 cumulative quantity is preserved");

  {
    const product = await makeProduct("h202", { stock: 100 });
    const order = await makeDeliveredOrder({ product, units: 3 });

    const first = await createReturn({ order, product, quantity: 1 });
    ok("a 1-unit replacement return is created", first.statusCode === 201, String(first.statusCode));

    // While OPEN (pending) the line is occupied.
    const whileOpen = await createReturn({ order, product, quantity: 1 });
    ok("a second return is refused while the first is open", whileOpen.statusCode === 409, String(whileOpen.statusCode));

    await advanceToReceived(first.body.data._id);
    await dispatchReplacement(first.body.data._id);

    // STILL open while dispatched — this is the assertion that would break if
    // replacement_dispatched were left out of OPEN_RETURN_STATUSES or the index.
    const whileDispatched = await createReturn({ order, product, quantity: 1 });
    ok(
      "a second return is STILL refused while the replacement is in flight",
      whileDispatched.statusCode === 409,
      `${whileDispatched.statusCode} ${whileDispatched.body?.code}`,
    );
    ok("with OPEN_RETURN_EXISTS", whileDispatched.body?.code === "OPEN_RETURN_EXISTS", whileDispatched.body?.code);

    await confirmDelivery(first.body.data._id);

    // Terminal now, so the remaining 2 units become returnable.
    const after = await createReturn({ order, product, quantity: 2 });
    ok(
      "once delivered, the remaining 2 units are returnable",
      after.statusCode === 201,
      `${after.statusCode} ${after.body?.message || ""}`,
    );

    // But not more than remain: 1 + 2 = 3 of 3 consumed.
    await advanceToReceived(after.body.data._id);
    await dispatchReplacement(after.body.data._id);
    await confirmDelivery(after.body.data._id);
    const overflow = await createReturn({ order, product, quantity: 1 });
    ok(
      "and the line is then exhausted — a delivered replacement still consumes its units",
      overflow.statusCode === 400 && overflow.body?.code === "NOTHING_LEFT_TO_RETURN",
      `${overflow.statusCode} ${overflow.body?.code}`,
    );
  }

  {
    // The index filter must actually cover the new open status in the database.
    const indexes = await ReturnModel.collection.indexes();
    const partial = indexes.find((i) => i.name === "one_open_return_per_order_line");
    ok(
      "the partial unique index covers replacement_dispatched",
      (partial?.partialFilterExpression?.status?.$in || []).includes("replacement_dispatched"),
      JSON.stringify(partial?.partialFilterExpression),
    );
  }

  section("12 — a legacy `replaced` record remains valid");

  {
    const product = await makeProduct("legacy", { stock: 20 });
    const order = await makeDeliveredOrder({ product, units: 1 });
    // Written the old way: terminal "replaced", no replacement fields at all.
    const inserted = await ReturnModel.collection.insertOne({
      returnNumber: `RET-LEGACY-${MARKER}`,
      order: order._id,
      product: product._id,
      user: order.user,
      productSnapshot: { name: product.name, image: "", price: product.price },
      quantity: 1,
      reason: "legacy replacement",
      refundAmount: product.price,
      resolutionType: "replacement",
      status: "replaced",
      replacedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    trash.returns.push(inserted.insertedId);

    const legacy = await ReturnModel.findById(inserted.insertedId);
    ok("it loads without a validation error", Boolean(legacy), "did not load");
    ok('its status is still "replaced"', legacy.status === "replaced", legacy.status);
    ok(
      "the new fields default safely",
      legacy.replacementCourier === "" &&
        legacy.replacementDispatchedAt === null &&
        legacy.replacementDeliveredAt === null &&
        legacy.replacementStockDeductedAt === null,
      JSON.stringify({
        courier: legacy.replacementCourier,
        dispatched: legacy.replacementDispatchedAt,
      }),
    );
    // replacementAwb is checked separately because it is deliberately ABSENT rather than
    // "": both reverse legs carry a unique partial index on $type:"string", and MongoDB
    // rejects $ne inside a partialFilterExpression — so an empty string would enter the
    // index and every AWB-less return would collide with every other one.
    ok(
      "an unset replacement AWB is absent, not an empty string",
      legacy.replacementAwb === undefined,
      JSON.stringify({ awb: legacy.replacementAwb }),
    );
    ok(
      "which is what lets many AWB-less returns coexist under the unique index",
      (await ReturnModel.collection.indexes()).some(
        (index) =>
          index.name === "return_replacementAwb_unique" &&
          JSON.stringify(index.partialFilterExpression).includes('"$type":"string"'),
      ),
      "the partial unique index on replacementAwb is missing or not $type-filtered",
    );
    ok("it still validates on save", Boolean(await legacy.save()), "save failed");
    ok(
      '"replaced" is terminal, so nothing can be done to it',
      (await callController(returnController.AdminUpdateReturnStatus, {
        params: { id: String(inserted.insertedId) },
        body: { status: "replacement_dispatched", disposition: "resellable" },
        user: admin(),
      })).statusCode === 400,
    );
    ok(
      "and it consumes its unit, so the line is exhausted",
      (await createReturn({ order, product, quantity: 1 })).body?.code === "NOTHING_LEFT_TO_RETURN",
    );
  }

  section("13 — FE/BE consistency, and Tier 2 stays out");

  {
    const helpers = await readFile(
      new URL("../../../kitab-shop-fe/src/features/order-detail/orderDetail.helpers.js", import.meta.url),
      "utf8",
    );
    ok("the FE knows replacement_dispatched", helpers.includes("replacement_dispatched"));
    ok("and replacement_delivered", helpers.includes("replacement_delivered"));
    ok(
      "the misleading copy is gone — nothing claims a dispatch that has not happened",
      !/replaced:[\s\S]{0,120}has been dispatched/.test(helpers),
      "the old 'has been dispatched' copy for `replaced` is still present",
    );

    const returnDetail = await readFile(
      new URL("../../../kitab-shop-fe/src/pages/account/ReturnDetail.jsx", import.meta.url),
      "utf8",
    );
    // The step model moved to the shared returns module (used by both the
    // return page and the order page's extended timeline) — the contract is
    // that the page renders steps from it and the module has both new steps.
    const returnStatusModule = await readFile(
      new URL("../../../kitab-shop-fe/src/features/returns/returnStatus.js", import.meta.url),
      "utf8",
    );
    ok(
      "the customer timeline has both new steps",
      returnStatusModule.includes('key: "replacement_dispatched"') &&
        returnStatusModule.includes('key: "replacement_delivered"') &&
        returnDetail.includes("buildReturnSteps"),
    );
    ok("and displays the recorded courier + AWB", returnDetail.includes("replacementAwb") && returnDetail.includes("replacementCourier"));

    const adminReturns = await readFile(
      new URL("../../../kitab-shop-fe/src/pages/admin/AdminReturns.jsx", import.meta.url),
      "utf8",
    );
    ok("the admin screen offers both statuses", adminReturns.includes("replacement_dispatched") && adminReturns.includes("replacement_delivered"));
    ok(
      "and calls the dedicated endpoints rather than the status endpoint",
      adminReturns.includes("/replacement/dispatch") && adminReturns.includes("/replacement/delivered"),
    );

    // Tier 2 must NOT have leaked in.
    const controller = await readFile(
      new URL("../../src/modules/returns/return.controller.js", import.meta.url),
      "utf8",
    );
    // This used to assert the return controller contained NO Shiprocket reference at all,
    // which encoded the H2-07 Tier-2 decision that replacements were shipped by hand.
    // Phase C1/C2 deliberately reversed that: a return can now book a real collection and a
    // real replacement parcel. Bumping the assertion to "allow Shiprocket" would have
    // deleted the protection, so it is restated as the thing H2-07 was really guarding —
    // that reverse logistics must not write to the ORDER's single shipment record.
    ok(
      "reverse logistics never writes to the order's shipment record (H2-07 boundary)",
      !/order\.shipment\b/.test(controller) && !/order\.shipments\b/.test(controller),
      "the return controller wrote to the order's shipment record",
    );
    ok(
      "and never mutates the order's shiprocket subdocument",
      !/order\.shiprocket/.test(controller) && !/"shiprocket\./.test(controller),
      "the return controller mutated order.shiprocket",
    );
    ok(
      "reverse shipment identity lives on the return, keyed per leg",
      Boolean(ReturnModel.schema.paths.pickupAwb) &&
        Boolean(ReturnModel.schema.paths.replacementAwb) &&
        !Object.keys(OrderModel.schema.paths).some((path) => /pickupAwb|replacementAwb/.test(path)),
      "reverse identity leaked onto the order",
    );
  }
} catch (error) {
  console.error(`\nSUITE ABORTED: ${error?.stack || error}`);
  ok("suite ran to completion", false, error?.message);
} finally {
  await ReturnModel.deleteMany({ order: { $in: trash.orders } });
  await ReturnModel.deleteMany({ _id: { $in: trash.returns } });
  await OrderModel.deleteMany({ _id: { $in: trash.orders } });
  await ProductModel.deleteMany({ _id: { $in: trash.products } });
  const { failed } = finish();
  await mongoose.disconnect();
  process.exit(failed ? 1 : 0);
}
