import assert from "node:assert/strict";
import test from "node:test";

import { validate, looseBody, objectId, boundedString } from "../../src/middleware/validate.middleware.js";
import { applyCouponSchema } from "../../src/modules/coupons/coupon.schema.js";
import { signupSchema, loginSchema } from "../../src/modules/auth/auth.schema.js";
import { placeOrderSchema } from "../../src/modules/orders/order.schema.js";
import { addSingleItemSchema } from "../../src/modules/cart/cart.schema.js";

const runMiddleware = (middleware, req) => {
  let nextCalled = false;
  let statusCode = null;
  let payload = null;

  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(body) {
      payload = body;
      return this;
    },
    setHeader() {},
  };

  middleware(req, res, () => {
    nextCalled = true;
  });

  return { nextCalled, statusCode, payload, req };
};

const makeReq = ({ body = {}, params = {}, query = {} } = {}) => ({ body, params, query });

test("validate() calls next and leaves valid bodies intact", () => {
  const middleware = validate(loginSchema);
  const result = runMiddleware(middleware, makeReq({ body: { Email: "USER@Example.com ", Password: "secret" } }));

  assert.equal(result.nextCalled, true);
  assert.equal(result.statusCode, null);
  assert.equal(result.req.body.Email, "user@example.com", "email is trimmed and lowercased");
});

test("validate() returns 400 with a per-field error map", () => {
  const middleware = validate(loginSchema);
  const result = runMiddleware(middleware, makeReq({ body: {} }));

  assert.equal(result.nextCalled, false);
  assert.equal(result.statusCode, 400);
  assert.equal(result.payload.success, false);
  assert.deepEqual(Object.keys(result.payload.errors).sort(), ["Email", "Password"]);
});

test("signup rejects a malformed email address", () => {
  const middleware = validate(signupSchema);
  const result = runMiddleware(middleware, makeReq({ body: { Email: "not-an-email", Password: "secret123" } }));

  assert.equal(result.statusCode, 400);
  assert.equal(result.payload.errors.Email, "Enter a valid email address");
});

test("login does not enforce email format, so legacy accounts can still sign in", () => {
  const middleware = validate(loginSchema);
  const result = runMiddleware(middleware, makeReq({ body: { Email: "legacy-admin", Password: "secret" } }));

  assert.equal(result.nextCalled, true, "a non-RFC email must not block login");
});

test("unknown keys survive validation so controller aliases keep working", () => {
  const middleware = validate(addSingleItemSchema);
  const result = runMiddleware(
    middleware,
    makeReq({ body: { productId: "a".repeat(24), qty: 3, somethingElse: "kept" } }),
  );

  assert.equal(result.nextCalled, true);
  assert.equal(result.req.body.qty, 3, "the qty alias is preserved");
  assert.equal(result.req.body.somethingElse, "kept", "unrecognised keys are not stripped");
});

test("cart line requires either productId or product", () => {
  const middleware = validate(addSingleItemSchema);
  const missing = runMiddleware(middleware, makeReq({ body: { quantity: 1 } }));
  assert.equal(missing.statusCode, 400);

  const aliasOnly = runMiddleware(middleware, makeReq({ body: { product: "b".repeat(24), quantity: 1 } }));
  assert.equal(aliasOnly.nextCalled, true, "the `product` alias satisfies the requirement");
});

test("cart quantity is coerced from its string form and bounded", () => {
  const middleware = validate(addSingleItemSchema);
  const coerced = runMiddleware(middleware, makeReq({ body: { productId: "c".repeat(24), quantity: "4" } }));
  assert.equal(coerced.req.body.quantity, 4);

  const tooMany = runMiddleware(middleware, makeReq({ body: { productId: "c".repeat(24), quantity: 5000 } }));
  assert.equal(tooMany.statusCode, 400);

  const zero = runMiddleware(middleware, makeReq({ body: { productId: "c".repeat(24), quantity: 0 } }));
  assert.equal(zero.statusCode, 400);
});

test("place order rejects a missing or malformed idempotency key", () => {
  const middleware = validate(placeOrderSchema);

  assert.equal(runMiddleware(middleware, makeReq({ body: {} })).statusCode, 400);
  assert.equal(runMiddleware(middleware, makeReq({ body: { idempotencyKey: "short" } })).statusCode, 400);
  assert.equal(
    runMiddleware(middleware, makeReq({ body: { idempotencyKey: "a".repeat(20) } })).nextCalled,
    true,
  );
});

test("coupon code is treated as a code, not a Mongo id", () => {
  const middleware = validate(applyCouponSchema);
  const result = runMiddleware(middleware, makeReq({ body: { couponId: "DIWALI50", items: [{ productId: "x" }] } }));

  assert.equal(result.nextCalled, true, "a human-readable coupon code must be accepted");
});

test("coupon apply requires at least one cart item", () => {
  const middleware = validate(applyCouponSchema);
  const result = runMiddleware(middleware, makeReq({ body: { couponId: "DIWALI50", items: [] } }));

  assert.equal(result.statusCode, 400);
  assert.equal(result.payload.errors.items, "Cart items are required");
});

test("objectId helper accepts 24-char hex and rejects anything else", () => {
  const schema = looseBody({ id: objectId("Order id") });

  assert.equal(schema.safeParse({ id: "5f".repeat(12) }).success, true);
  assert.equal(schema.safeParse({ id: "nope" }).success, false);
  assert.equal(schema.safeParse({ id: "z".repeat(24) }).success, false);
});

test("boundedString trims and enforces its ceiling", () => {
  const schema = looseBody({ note: boundedString({ label: "Note", max: 10 }) });

  assert.equal(schema.safeParse({ note: "  hi  " }).data.note, "hi");
  assert.equal(schema.safeParse({ note: "x".repeat(11) }).success, false);
  assert.equal(schema.safeParse({ note: "   " }).success, false, "whitespace only is empty");
});

test("params validation runs before body validation", () => {
  const middleware = validate({
    params: looseBody({ orderId: objectId("Order id") }),
    body: looseBody({ note: boundedString({ label: "Note" }) }),
  });

  const result = runMiddleware(middleware, makeReq({ params: { orderId: "bad" }, body: {} }));

  assert.equal(result.payload.errors["orderId"], "Order id must be a valid id");
  assert.equal(result.payload.errors.note, undefined, "body errors are not reported yet");
});
