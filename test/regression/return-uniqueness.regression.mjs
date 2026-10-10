/**
 * Return uniqueness and cumulative return quantity (audit H2-02).
 *
 * `returnrequests` carried an unconditional unique index on
 * `{order, product, user}`, so exactly ONE return document per order line was
 * possible for all time. That is stricter than the lifecycle the model implements
 * and produced two dead ends: a QC rejection (terminal, with no reopen endpoint)
 * permanently barred the customer, and a partial return of 1 of 5 units exhausted
 * the line so the other 4 could never be returned.
 *
 * Run with `npm run test:return-uniqueness` (or `npm test` for everything).
 *
 * Creation is driven through the REAL `CreateReturnRequest` controller, because
 * H2-02 is about what may be created. Terminal states are set directly where the
 * point is the CONSEQUENCE of that state rather than the transition into it — the
 * transition machinery is already covered by returns.regression.mjs. Nothing here
 * touches money: no gateway is contacted and no refund is settled.
 */
process.env.INVENTORY_ENFORCE_STOCK = "true";
process.env.NOTIFICATIONS_ENABLED = "false";
process.env.PAYMENTS_ENABLED = "false";

import mongoose from "mongoose";
import { connect, createSuite, marker, productFixture, addressFixture } from "./helpers.mjs";

const { ok, section, finish } = createSuite("return-uniqueness");
await connect();

const OrderModel = (await import("../../src/modules/orders/Order.model.js")).default;
const ProductModel = (await import("../../src/modules/products/Product.model.js")).default;
const ReturnModel = (await import("../../src/modules/returns/return.model.js")).default;
const { OPEN_RETURN_STATUSES, QUANTITY_CONSUMING_RETURN_STATUSES, RETURN_STATUSES } =
  await import("../../src/modules/returns/return.model.js");
await import("../../src/modules/categories/Category.model.js");
const returnController = await import("../../src/modules/returns/return.controller.js");

/**
 * The partial unique index is named explicitly so it coexists with the old
 * auto-named one; the old one is dropped by
 * scripts/migrate-return-open-index.js. Mirrored here so the suite runs against the
 * post-migration shape.
 */
const applyReturnIndexes = async () => {
  await ReturnModel.createIndexes().catch(() => {});
  await ReturnModel.collection.dropIndex("order_1_product_1_user_1").catch(() => {});
};
await applyReturnIndexes();

const MARKER = marker("retuniq");
const trash = { orders: [], products: [], returns: [] };
let seq = 0;

const makeProduct = async (label, { kind = "return", windowDays = 30, stock = 50 } = {}) => {
  const product = await ProductModel.create(
    productFixture(`${MARKER}-${label}`, { stock, returnPolicy: { kind, windowDays } }),
  );
  trash.products.push(product._id);
  return product;
};

/** A delivered order, which is the only state a return may be requested from. */
const makeDeliveredOrder = async ({ lines, userId = new mongoose.Types.ObjectId(), ...fields }) => {
  seq += 1;
  const items = lines.map((line) => ({
    product: line.product._id,
    name: line.product.name,
    image: "x.png",
    price: line.product.price,
    quantity: line.quantity,
    ...(line.cancelledQuantity ? { cancelledQuantity: line.cancelledQuantity } : {}),
  }));
  const subtotal = items.reduce((total, item) => total + item.price * item.quantity, 0);
  const order = await OrderModel.create({
    user: userId,
    items,
    shippingAddress: addressFixture(),
    paymentMethod: "RAZORPAY",
    paymentStatus: "Paid",
    orderStatus: "Delivered",
    deliveredAt: new Date(),
    subtotal,
    totalAmount: subtotal,
    razorpayPaymentId: `pay_${MARKER}_${seq}`,
    ...fields,
  });
  trash.orders.push(order._id);
  return order;
};

const createReturn = async ({ order, product, quantity = 1, userId, reason = "Damaged on arrival" }) => {
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
  await returnController.CreateReturnRequest(
    {
      body: { orderId: String(order._id), productId: String(product._id), quantity, reason },
      user: { id: String(userId || order.user), roles: [] },
      params: {},
      query: {},
    },
    res,
  );
  if (payload?.data?._id) trash.returns.push(payload.data._id);
  return { statusCode, body: payload };
};

/** Forces a terminal state; the transitions themselves are covered elsewhere. */
const setStatus = (returnId, status) =>
  ReturnModel.updateOne({ _id: returnId }, { $set: { status } });

const returnsFor = (order, product) =>
  ReturnModel.find({ order: order._id, product: product._id }).select("status quantity").lean();

try {
  // ═══════════════════════════════════════════════════════════════════════════
  section("status sets — the invariant's definitions");

  {
    // The invariant is "one OPEN return per line", so the open set must be exactly
    // the statuses a return can still move OUT of. Stated as the complement of the
    // terminal set rather than as a fixed list of four: extending the lifecycle with
    // a new in-flight status (as the replacement flow does with
    // replacement_dispatched) must occupy the line automatically, while a new
    // TERMINAL status has to be declared here deliberately — that is the direction
    // where forgetting is dangerous, because a line would stay locked forever.
    const TERMINAL_STATUSES = ["refunded", "replaced", "replacement_delivered", "rejected"];
    ok(
      "every status is either open or terminal — none is unaccounted for",
      RETURN_STATUSES.every(
        (status) =>
          OPEN_RETURN_STATUSES.includes(status) !== TERMINAL_STATUSES.includes(status),
      ),
      JSON.stringify({ open: OPEN_RETURN_STATUSES, terminal: TERMINAL_STATUSES }),
    );
    ok(
      "the open set is exactly the in-flight statuses",
      OPEN_RETURN_STATUSES.length === RETURN_STATUSES.length - TERMINAL_STATUSES.length,
      JSON.stringify(OPEN_RETURN_STATUSES),
    );
    ok(
      "the terminal statuses are excluded from the open set",
      TERMINAL_STATUSES.every((status) => !OPEN_RETURN_STATUSES.includes(status)),
    );
    ok(
      "quantity-consuming statuses are everything EXCEPT rejected",
      !QUANTITY_CONSUMING_RETURN_STATUSES.includes("rejected") &&
        QUANTITY_CONSUMING_RETURN_STATUSES.length === RETURN_STATUSES.length - 1,
      JSON.stringify(QUANTITY_CONSUMING_RETURN_STATUSES),
    );
    ok(
      "refunded and replaced DO consume units",
      ["refunded", "replaced"].every((status) =>
        QUANTITY_CONSUMING_RETURN_STATUSES.includes(status),
      ),
    );
  }

  section("indexes");

  {
    const indexes = await ReturnModel.collection.indexes();
    const partial = indexes.find((index) => index.name === "one_open_return_per_order_line");
    ok("the named partial index exists", Boolean(partial));
    ok("it is unique", partial?.unique === true, JSON.stringify(partial?.unique));
    ok(
      "filtered to the open statuses only",
      JSON.stringify(partial?.partialFilterExpression) ===
        JSON.stringify({ status: { $in: OPEN_RETURN_STATUSES } }),
      JSON.stringify(partial?.partialFilterExpression),
    );
    ok(
      "the old all-time unique index is gone",
      !indexes.some((index) => index.name === "order_1_product_1_user_1"),
      "order_1_product_1_user_1 still present",
    );
    ok(
      "returnNumber is still uniquely indexed",
      indexes.some((index) => index.name === "returnNumber_1" && index.unique),
    );
  }

  section("1 — a normal return");

  {
    const product = await makeProduct("normal");
    const order = await makeDeliveredOrder({ lines: [{ product, quantity: 1 }] });
    const response = await createReturn({ order, product });

    ok("the return is created", response.statusCode === 201, `${response.statusCode} ${response.body?.message || ""}`);
    ok("it starts pending", response.body?.data?.status === "pending", response.body?.data?.status);
    ok("with the requested quantity", response.body?.data?.quantity === 1);
    ok("and a returnNumber", Boolean(response.body?.data?.returnNumber));
    ok(
      "resolutionType comes from the product policy, not the customer",
      response.body?.data?.resolutionType === "refund",
      response.body?.data?.resolutionType,
    );
  }

  section("2 — a duplicate while one is open");

  {
    const product = await makeProduct("duplicate");
    const order = await makeDeliveredOrder({ lines: [{ product, quantity: 3 }] });
    const first = await createReturn({ order, product, quantity: 1 });
    ok("the first is created", first.statusCode === 201, String(first.statusCode));

    const second = await createReturn({ order, product, quantity: 1 });
    ok("a second while the first is open is refused", second.statusCode === 409, String(second.statusCode));
    ok("with OPEN_RETURN_EXISTS", second.body?.code === "OPEN_RETURN_EXISTS", second.body?.code);
    ok(
      "the message names the open return",
      /RET-/.test(second.body?.message || ""),
      second.body?.message,
    );
    ok("only one return exists", (await returnsFor(order, product)).length === 1);

    // Still refused at every open stage, not just pending.
    const openReturn = (await returnsFor(order, product))[0];
    for (const status of ["approved", "pickup_scheduled", "received"]) {
      await ReturnModel.updateOne({ order: order._id, product: product._id }, { $set: { status } });
      const attempt = await createReturn({ order, product, quantity: 1 });
      ok(
        `refused while the open return is "${status}"`,
        attempt.statusCode === 409,
        `${attempt.statusCode} at ${status}`,
      );
    }
    ok("still only one return", (await returnsFor(order, product)).length === 1, String(openReturn?.status));
  }

  section("3 — concurrent duplicates");

  {
    const product = await makeProduct("concurrent");
    const order = await makeDeliveredOrder({ lines: [{ product, quantity: 5 }] });

    const results = await Promise.all(
      Array.from({ length: 5 }, () => createReturn({ order, product, quantity: 1 })),
    );
    const created = results.filter((r) => r.statusCode === 201);
    const refused = results.filter((r) => r.statusCode === 409);

    ok("exactly ONE concurrent request creates a return", created.length === 1, JSON.stringify(results.map((r) => r.statusCode)));
    ok("the other four are refused with 409", refused.length === 4, `${refused.length}`);
    ok(
      "every refusal carries OPEN_RETURN_EXISTS",
      refused.every((r) => r.body?.code === "OPEN_RETURN_EXISTS"),
      JSON.stringify(refused.map((r) => r.body?.code)),
    );
    ok(
      "exactly one return document exists",
      (await returnsFor(order, product)).length === 1,
      String((await returnsFor(order, product)).length),
    );
  }

  section("4 — different products in one order");

  {
    const productA = await makeProduct("multi-a");
    const productB = await makeProduct("multi-b");
    const order = await makeDeliveredOrder({
      lines: [
        { product: productA, quantity: 1 },
        { product: productB, quantity: 1 },
      ],
    });

    const a = await createReturn({ order, product: productA });
    const b = await createReturn({ order, product: productB });
    ok("product A can be returned", a.statusCode === 201, String(a.statusCode));
    ok("product B can be returned in the same order", b.statusCode === 201, String(b.statusCode));
    ok(
      "two returns exist for the order",
      (await ReturnModel.countDocuments({ order: order._id })) === 2,
    );
  }

  section("5 — partial quantities across several returns");

  {
    const product = await makeProduct("partial");
    const order = await makeDeliveredOrder({ lines: [{ product, quantity: 5 }] });

    const first = await createReturn({ order, product, quantity: 2 });
    ok("2 of 5 can be returned", first.statusCode === 201, `${first.statusCode} ${first.body?.message || ""}`);
    await setStatus(first.body.data._id, "refunded");

    // THE case the old index made impossible.
    const second = await createReturn({ order, product, quantity: 2 });
    ok(
      "another 2 can be returned once the first resolved",
      second.statusCode === 201,
      `${second.statusCode} ${second.body?.message || ""}`,
    );
    await setStatus(second.body.data._id, "refunded");

    const third = await createReturn({ order, product, quantity: 1 });
    ok("and the final 1", third.statusCode === 201, `${third.statusCode} ${third.body?.message || ""}`);
    await setStatus(third.body.data._id, "refunded");

    // 5 of 5 consumed — the line is now exhausted.
    const overflow = await createReturn({ order, product, quantity: 1 });
    ok(
      "a sixth unit is refused — cumulative quantity is capped",
      overflow.statusCode === 400,
      `${overflow.statusCode} ${overflow.body?.message || ""}`,
    );
    ok(
      "with NOTHING_LEFT_TO_RETURN",
      overflow.body?.code === "NOTHING_LEFT_TO_RETURN",
      overflow.body?.code,
    );

    const all = await returnsFor(order, product);
    ok("three returns exist", all.length === 3, String(all.length));
    ok(
      "their quantities sum to exactly the ordered 5",
      all.reduce((total, entry) => total + entry.quantity, 0) === 5,
      String(all.reduce((total, entry) => total + entry.quantity, 0)),
    );
  }

  {
    // ordered 5, returned 4, asking for 2 → must be refused, not clamped to 6.
    const product = await makeProduct("overflow");
    const order = await makeDeliveredOrder({ lines: [{ product, quantity: 5 }] });
    const first = await createReturn({ order, product, quantity: 4 });
    await setStatus(first.body.data._id, "refunded");

    const tooMany = await createReturn({ order, product, quantity: 2 });
    ok("returning 2 more of 5 when 4 are gone is refused", tooMany.statusCode === 400, String(tooMany.statusCode));
    ok(
      "the error quotes the 1 remaining unit",
      /between 1 and 1/.test(tooMany.body?.message || ""),
      tooMany.body?.message,
    );
    ok(
      "with RETURN_QUANTITY_UNAVAILABLE",
      tooMany.body?.code === "RETURN_QUANTITY_UNAVAILABLE",
      tooMany.body?.code,
    );

    const exact = await createReturn({ order, product, quantity: 1 });
    ok("the remaining 1 is accepted", exact.statusCode === 201, String(exact.statusCode));
    const total = (await returnsFor(order, product)).reduce((sum, r) => sum + r.quantity, 0);
    ok("cumulative returned never exceeds ordered", total === 5, String(total));
  }

  {
    // Cancelled units must still be excluded, alongside returned ones.
    const product = await makeProduct("cancelled-mix");
    const order = await makeDeliveredOrder({
      lines: [{ product, quantity: 5, cancelledQuantity: 2 }],
    });
    const first = await createReturn({ order, product, quantity: 3 });
    ok("3 returnable after 2 were cancelled", first.statusCode === 201, `${first.statusCode} ${first.body?.message || ""}`);
    await setStatus(first.body.data._id, "refunded");

    const overflow = await createReturn({ order, product, quantity: 1 });
    ok(
      "cancelled + returned together exhaust the line",
      overflow.statusCode === 400 && overflow.body?.code === "NOTHING_LEFT_TO_RETURN",
      `${overflow.statusCode} ${overflow.body?.code}`,
    );
  }

  section("6 — after a rejection");

  {
    const product = await makeProduct("rejected");
    const order = await makeDeliveredOrder({ lines: [{ product, quantity: 2 }] });

    const first = await createReturn({ order, product, quantity: 2 });
    ok("the first return is created", first.statusCode === 201, String(first.statusCode));
    await setStatus(first.body.data._id, "rejected");

    // THE dead end the old index created: rejected is terminal with no reopen
    // endpoint, so the customer previously had no route at all.
    const second = await createReturn({ order, product, quantity: 2 });
    ok(
      "a new return IS allowed after a rejection",
      second.statusCode === 201,
      `${second.statusCode} ${second.body?.message || ""}`,
    );
    ok(
      "and the full quantity is available again — a rejection consumes no units",
      second.body?.data?.quantity === 2,
      String(second.body?.data?.quantity),
    );
    ok("both records are kept", (await returnsFor(order, product)).length === 2);

    // Still refused while the second is open. Here the OPEN return already claims
    // both units, so the cumulative-quantity cap is what fires — it sits earlier in
    // the handler than the open-return check. Either refusal is correct; what
    // matters is that nothing is created.
    const third = await createReturn({ order, product, quantity: 1 });
    ok(
      "a third while the second is open is refused",
      third.statusCode === 400 || third.statusCode === 409,
      String(third.statusCode),
    );
    ok(
      "and it is the quantity cap that catches it, the open return holding both units",
      third.body?.code === "NOTHING_LEFT_TO_RETURN",
      `${third.statusCode} ${third.body?.code}`,
    );
    ok("still only two returns exist", (await returnsFor(order, product)).length === 2);
  }

  {
    // The 409 path proper: an open return that leaves units spare must still block
    // a second concurrent request for the line.
    const product = await makeProduct("open-with-spare");
    const order = await makeDeliveredOrder({ lines: [{ product, quantity: 5 }] });
    const first = await createReturn({ order, product, quantity: 1 });
    ok("an open return for 1 of 5 exists", first.statusCode === 201, String(first.statusCode));

    const second = await createReturn({ order, product, quantity: 1 });
    ok(
      "a second is refused even though 4 units are spare",
      second.statusCode === 409,
      `${second.statusCode} ${second.body?.code}`,
    );
    ok("with OPEN_RETURN_EXISTS", second.body?.code === "OPEN_RETURN_EXISTS", second.body?.code);
    ok("one return only", (await returnsFor(order, product)).length === 1);

    // Once it resolves, the spare units are available again.
    await setStatus(first.body.data._id, "refunded");
    const third = await createReturn({ order, product, quantity: 4 });
    ok("and the remaining 4 become returnable", third.statusCode === 201, `${third.statusCode} ${third.body?.message || ""}`);
  }

  section("7 — replacements");

  {
    const product = await makeProduct("replacement", { kind: "replacement" });
    const order = await makeDeliveredOrder({ lines: [{ product, quantity: 2 }] });

    const first = await createReturn({ order, product, quantity: 1 });
    ok("a replacement-policy return is created", first.statusCode === 201, String(first.statusCode));
    ok(
      "with resolutionType replacement",
      first.body?.data?.resolutionType === "replacement",
      first.body?.data?.resolutionType,
    );
    ok(
      "and no payout destination is demanded",
      !first.body?.data?.refundDestination?.method,
      JSON.stringify(first.body?.data?.refundDestination),
    );

    const blocked = await createReturn({ order, product, quantity: 1 });
    ok("a second is blocked while it is open", blocked.statusCode === 409, String(blocked.statusCode));

    await setStatus(first.body.data._id, "replaced");
    const second = await createReturn({ order, product, quantity: 1 });
    ok(
      "the remaining unit can be returned after the replacement resolved",
      second.statusCode === 201,
      `${second.statusCode} ${second.body?.message || ""}`,
    );
    ok(
      "a replaced return consumed its unit",
      (await returnsFor(order, product)).reduce((sum, r) => sum + r.quantity, 0) === 2,
    );

    await setStatus(second.body.data._id, "replaced");
    const overflow = await createReturn({ order, product, quantity: 1 });
    ok(
      "and the line is then exhausted",
      overflow.statusCode === 400 && overflow.body?.code === "NOTHING_LEFT_TO_RETURN",
      `${overflow.statusCode} ${overflow.body?.code}`,
    );
  }

  section("8 — another user's order");

  {
    const product = await makeProduct("ownership");
    const order = await makeDeliveredOrder({ lines: [{ product, quantity: 1 }] });
    const stranger = new mongoose.Types.ObjectId();

    const response = await createReturn({ order, product, userId: stranger });
    ok("a stranger cannot return someone else's order", response.statusCode === 403, String(response.statusCode));
    ok("and no return is created", (await returnsFor(order, product)).length === 0);

    // The owner still can.
    const owner = await createReturn({ order, product });
    ok("the owner can", owner.statusCode === 201, String(owner.statusCode));
  }

  section("9 — terminal returns are not reprocessed");

  {
    const product = await makeProduct("terminal");
    const order = await makeDeliveredOrder({ lines: [{ product, quantity: 1 }] });
    const first = await createReturn({ order, product, quantity: 1 });
    await setStatus(first.body.data._id, "refunded");

    const again = await createReturn({ order, product, quantity: 1 });
    ok(
      "a fully-returned line cannot be returned again",
      again.statusCode === 400 && again.body?.code === "NOTHING_LEFT_TO_RETURN",
      `${again.statusCode} ${again.body?.code}`,
    );

    const settled = await ReturnModel.findById(first.body.data._id);
    ok("the settled return is untouched", settled.status === "refunded", settled.status);
    ok("its quantity is unchanged", settled.quantity === 1, String(settled.quantity));
  }

  {
    // Eligibility gates that must keep working unchanged.
    const product = await makeProduct("gates");
    const undelivered = await makeDeliveredOrder({
      lines: [{ product, quantity: 1 }],
      orderStatus: "Shipped",
      deliveredAt: null,
    });
    const notDelivered = await createReturn({ order: undelivered, product });
    ok("an undelivered order cannot be returned", notDelivered.statusCode === 400, String(notDelivered.statusCode));

    const noPolicy = await makeProduct("nopolicy", { kind: "none" });
    const order = await makeDeliveredOrder({ lines: [{ product: noPolicy, quantity: 1 }] });
    const ineligible = await createReturn({ order, product: noPolicy });
    ok("a policy of `none` refuses the return", ineligible.statusCode === 400, String(ineligible.statusCode));

    const expiredProduct = await makeProduct("expired", { windowDays: 1 });
    const expiredOrder = await makeDeliveredOrder({
      lines: [{ product: expiredProduct, quantity: 1 }],
      deliveredAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
    });
    const expired = await createReturn({ order: expiredOrder, product: expiredProduct });
    ok("a passed window refuses the return", expired.statusCode === 400, String(expired.statusCode));

    const fullyRefunded = await makeProduct("fullyrefunded");
    const refundedOrder = await makeDeliveredOrder({
      lines: [{ product: fullyRefunded, quantity: 1 }],
      paymentStatus: "Refunded",
    });
    const already = await createReturn({ order: refundedOrder, product: fullyRefunded });
    ok(
      "an already fully-refunded order refuses a refund return",
      already.statusCode === 400 && already.body?.code === "ORDER_ALREADY_REFUNDED",
      `${already.statusCode} ${already.body?.code}`,
    );
  }

  section("10 — legacy record shapes");

  {
    // Live data contains returns written before `resolutionType` existed, and a
    // terminal `rejected` row. The new index must tolerate both.
    const product = await makeProduct("legacy");
    const order = await makeDeliveredOrder({ lines: [{ product, quantity: 3 }] });
    const userId = order.user;

    const legacy = await ReturnModel.collection.insertMany([
      {
        returnNumber: `RET-LEGACY-${MARKER}-1`,
        order: order._id,
        product: product._id,
        user: userId,
        productSnapshot: { name: product.name, image: "", price: product.price },
        quantity: 1,
        reason: "legacy",
        refundAmount: product.price,
        status: "refunded",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        returnNumber: `RET-LEGACY-${MARKER}-2`,
        order: order._id,
        product: product._id,
        user: userId,
        productSnapshot: { name: product.name, image: "", price: product.price },
        quantity: 1,
        reason: "legacy",
        refundAmount: product.price,
        status: "rejected",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    trash.returns.push(...Object.values(legacy.insertedIds));

    ok(
      "two terminal legacy rows coexist on one line (impossible before)",
      (await returnsFor(order, product)).length === 2,
    );

    // 1 refunded consumes a unit, the rejected one does not → 2 of 3 remain.
    const next = await createReturn({ order, product, quantity: 2 });
    ok(
      "the remaining 2 units are returnable alongside legacy rows",
      next.statusCode === 201,
      `${next.statusCode} ${next.body?.message || ""}`,
    );

    const overflow = await createReturn({ order, product, quantity: 1 });
    ok(
      "and the line is then exhausted (rejected legacy row consumed nothing)",
      overflow.statusCode === 409 || overflow.body?.code === "NOTHING_LEFT_TO_RETURN",
      `${overflow.statusCode} ${overflow.body?.code}`,
    );
  }

  section("money and inventory are untouched by this phase");

  {
    const product = await makeProduct("nosideeffects", { stock: 40 });
    const order = await makeDeliveredOrder({ lines: [{ product, quantity: 2 }] });
    const stockBefore = (await ProductModel.findById(product._id)).stock;

    const response = await createReturn({ order, product, quantity: 1 });
    ok("the return is created", response.statusCode === 201, String(response.statusCode));

    const freshOrder = await OrderModel.findById(order._id);
    ok("no refund row was created by requesting a return", (freshOrder.refunds || []).length === 0);
    ok("paymentStatus is unchanged", freshOrder.paymentStatus === "Paid", freshOrder.paymentStatus);
    ok(
      "stock is unchanged — restock happens at resolution, not request",
      (await ProductModel.findById(product._id)).stock === stockBefore,
      String((await ProductModel.findById(product._id)).stock),
    );
    ok("the order status is still Delivered", freshOrder.orderStatus === "Delivered");
    ok(
      "a refund amount was quoted on the return itself",
      response.body?.data?.refundAmount > 0,
      String(response.body?.data?.refundAmount),
    );
  }
} catch (error) {
  console.error(`\nSUITE ABORTED: ${error?.stack || error}`);
  ok("suite ran to completion", false, error?.message);
} finally {
  await ReturnModel.deleteMany({ order: { $in: trash.orders } });
  await OrderModel.deleteMany({ _id: { $in: trash.orders } });
  await ProductModel.deleteMany({ _id: { $in: trash.products } });
  const { failed } = finish();
  await mongoose.disconnect();
  process.exit(failed ? 1 : 0);
}
