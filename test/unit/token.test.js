import assert from "node:assert/strict";
import test from "node:test";
import jwt from "jsonwebtoken";
import {
  generateAccessToken,
  generateRefreshToken,
} from "../../src/modules/auth/token.js";

test("tokens include user id, primary role, and roles array", () => {
  process.env.acess_token = "test-access-secret";
  process.env.refresh_token = "test-refresh-secret";

  const accessToken = generateAccessToken("user-1", "productManager", [
    "productManager",
    "salesManager",
  ]);
  const refreshToken = generateRefreshToken("user-1", "productManager", [
    "productManager",
    "salesManager",
  ]);

  const accessPayload = jwt.verify(accessToken, process.env.acess_token);
  const refreshPayload = jwt.verify(refreshToken, process.env.refresh_token);

  assert.equal(accessPayload.id, "user-1");
  assert.equal(accessPayload.role, "productManager");
  assert.deepEqual(accessPayload.roles, ["productManager", "salesManager"]);
  assert.equal(refreshPayload.id, "user-1");
  assert.equal(refreshPayload.role, "productManager");
  assert.deepEqual(refreshPayload.roles, ["productManager", "salesManager"]);
});
