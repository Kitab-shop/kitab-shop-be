import assert from "node:assert/strict";
import test from "node:test";

import { createRateLimit } from "../../src/middleware/rate-limit.middleware.js";

const callLimiter = async (limiter, ip = "1.2.3.4", path = "/login") => {
  let nextCalled = false;
  let statusCode = null;
  let payload = null;
  const headers = {};

  const req = { ip, path, headers: {}, socket: {} };
  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(body) {
      payload = body;
      return this;
    },
    setHeader(name, value) {
      headers[name] = value;
    },
  };

  await limiter(req, res, () => {
    nextCalled = true;
  });

  return { nextCalled, statusCode, payload, headers };
};

test("requests below the ceiling pass through", async () => {
  const limiter = createRateLimit({
    name: `test-under-${process.hrtime.bigint()}`,
    windowMs: 60_000,
    max: 3,
    isEnabled: () => true,
  });

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const result = await callLimiter(limiter);
    assert.equal(result.nextCalled, true, `attempt ${attempt} should pass`);
  }
});

test("the request past the ceiling gets a 429 and a Retry-After header", async () => {
  const limiter = createRateLimit({
    name: `test-over-${process.hrtime.bigint()}`,
    windowMs: 60_000,
    max: 2,
    isEnabled: () => true,
  });

  await callLimiter(limiter);
  await callLimiter(limiter);
  const blocked = await callLimiter(limiter);

  assert.equal(blocked.nextCalled, false);
  assert.equal(blocked.statusCode, 429);
  assert.equal(blocked.payload.success, false);
  assert.ok(Number(blocked.headers["Retry-After"]) >= 1, "Retry-After is set in seconds");
});

test("buckets are per client, so one abuser cannot lock out everyone", async () => {
  const limiter = createRateLimit({
    name: `test-per-client-${process.hrtime.bigint()}`,
    windowMs: 60_000,
    max: 1,
    isEnabled: () => true,
  });

  await callLimiter(limiter, "10.0.0.1");
  const sameClient = await callLimiter(limiter, "10.0.0.1");
  const otherClient = await callLimiter(limiter, "10.0.0.2");

  assert.equal(sameClient.statusCode, 429);
  assert.equal(otherClient.nextCalled, true, "a different IP has its own bucket");
});

test("perPath keeps unrelated endpoints from sharing a counter", async () => {
  const limiter = createRateLimit({
    name: `test-per-path-${process.hrtime.bigint()}`,
    windowMs: 60_000,
    max: 1,
    perPath: true,
    isEnabled: () => true,
  });

  await callLimiter(limiter, "10.0.0.3", "/login");
  const sameRoute = await callLimiter(limiter, "10.0.0.3", "/login");
  const otherRoute = await callLimiter(limiter, "10.0.0.3", "/forgot-password");

  assert.equal(sameRoute.statusCode, 429);
  assert.equal(otherRoute.nextCalled, true, "a different path has its own bucket");
});

test("a disabled limiter is a pass-through", async () => {
  const limiter = createRateLimit({
    name: `test-disabled-${process.hrtime.bigint()}`,
    windowMs: 60_000,
    max: 1,
    isEnabled: () => false,
  });

  await callLimiter(limiter, "10.0.0.4");
  const second = await callLimiter(limiter, "10.0.0.4");

  assert.equal(second.nextCalled, true);
  assert.equal(second.statusCode, null);
});

test("RateLimit-Remaining counts down and floors at zero", async () => {
  const limiter = createRateLimit({
    name: `test-headers-${process.hrtime.bigint()}`,
    windowMs: 60_000,
    max: 2,
    isEnabled: () => true,
  });

  const first = await callLimiter(limiter, "10.0.0.5");
  assert.equal(first.headers["RateLimit-Limit"], 2);
  assert.equal(first.headers["RateLimit-Remaining"], 1);

  const second = await callLimiter(limiter, "10.0.0.5");
  assert.equal(second.headers["RateLimit-Remaining"], 0);

  const third = await callLimiter(limiter, "10.0.0.5");
  assert.equal(third.headers["RateLimit-Remaining"], 0, "never goes negative");
});
