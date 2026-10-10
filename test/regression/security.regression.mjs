/**
 * Security and lifecycle regression: permission gates, blocked accounts, order
 * status transitions, and the fulfilment guards.
 *
 * Covers audit items C-07, C-08, H-05, H-06, H-13.
 * Run with `npm run test:security` (or `npm test` for everything).
 */
import mongoose from "mongoose";
import { readFile } from "node:fs/promises";
import { connect, createSuite, marker } from "./helpers.mjs";

const { ok, section, finish } = createSuite("security");
await connect();

const UserModel = (await import("../../src/model/User.model.js")).default;
const { adminHasPermission } = await import("../../src/config/admin-access.service.js");
const { ADMIN_PERMISSIONS } = await import("../../src/config/admin-permissions.config.js");
const { ShiprocketError } = await import("../../src/modules/shipping/shiprocket.service.js");
const { ORDER_STATUS_TRANSITIONS, canTransitionOrderStatus } = await import(
  "../../src/modules/orders/order-status.rules.js"
);

const MARKER = marker("sec");
const users = [];

const makeUser = async (roles) => {
  const user = await UserModel.create({
    name: `${MARKER} user`,
    email: `${MARKER}-${users.length}@test.local`,
    password: "x".repeat(60),
    roles,
  });
  users.push(user._id);
  return user;
};

try {
  // ═══ H-05: a role tier is not a permission ═════════════════════════════════
  section("Non-owner reads need a real permission, not just an admin role (H-05)");

  const themeEditor = await makeUser(["themeEditor"]);
  const orderAdmin = await makeUser(["admin"]);
  const customer = await makeUser(["user"]);
  const asCaller = (user) => ({ id: String(user._id), roles: user.roles });

  ok(
    "themeEditor is refused returns:manage — it can no longer read customer bank details",
    (await adminHasPermission(asCaller(themeEditor), ADMIN_PERMISSIONS.RETURNS_MANAGE)) === false,
  );
  ok(
    "themeEditor is refused orders:manage",
    (await adminHasPermission(asCaller(themeEditor), ADMIN_PERMISSIONS.ORDERS_MANAGE)) === false,
  );
  ok(
    "themeEditor keeps the permissions it legitimately holds",
    (await adminHasPermission(asCaller(themeEditor), ADMIN_PERMISSIONS.THEME_MANAGE)) === true,
  );
  ok(
    "an orders admin is allowed orders:manage",
    (await adminHasPermission(asCaller(orderAdmin), ADMIN_PERMISSIONS.ORDERS_MANAGE)) === true,
  );
  ok(
    "a plain customer is refused outright",
    (await adminHasPermission(asCaller(customer), ADMIN_PERMISSIONS.ORDERS_MANAGE)) === false,
  );
  ok(
    "a forged token claiming admin roles is refused — the database is the authority",
    (await adminHasPermission(
      { id: String(themeEditor._id), roles: ["admin", "superAdmin"] },
      ADMIN_PERMISSIONS.RETURNS_MANAGE,
    )) === false,
  );
  ok("a caller with no id is refused", (await adminHasPermission({}, ADMIN_PERMISSIONS.ORDERS_MANAGE)) === false);
  ok("a null caller is refused", (await adminHasPermission(null, ADMIN_PERMISSIONS.ORDERS_MANAGE)) === false);

  await UserModel.updateOne({ _id: orderAdmin._id }, { $set: { isBlocked: true } });
  ok(
    "blocking an admin revokes access immediately, not at token expiry",
    (await adminHasPermission(asCaller(orderAdmin), ADMIN_PERMISSIONS.ORDERS_MANAGE)) === false,
  );
  await UserModel.updateOne({ _id: orderAdmin._id }, { $set: { isBlocked: false, isActive: false } });
  ok(
    "deactivating an admin revokes access immediately",
    (await adminHasPermission(asCaller(orderAdmin), ADMIN_PERMISSIONS.ORDERS_MANAGE)) === false,
  );

  const returnSource = await readFile("src/modules/returns/return.controller.js", "utf8");
  const orderSource = await readFile("src/modules/orders/order.controller.js", "utf8");
  const shippingSource = await readFile("src/modules/shipping/shipping.controller.js", "utf8");

  const getReturnById = returnSource.slice(
    returnSource.indexOf("export const GetReturnById"),
    returnSource.indexOf("export const AdminGetReturns"),
  );
  ok(
    "GetReturnById gates non-owners on returns:manage",
    getReturnById.includes("adminHasPermission") && getReturnById.includes("RETURNS_MANAGE"),
  );
  ok("GetReturnById no longer uses a bare hasAdminRole", !/hasAdminRole\(req\.user\)/.test(getReturnById));
  ok("GetReturnById masks the bank account number for the owner", getReturnById.includes("redactRefundDestination"));
  ok(
    "GetOrderById gates non-owners on orders:manage",
    /!isOwner && \(await adminHasPermission\(req\.user, ADMIN_PERMISSIONS\.ORDERS_MANAGE\)\)/.test(orderSource),
  );
  ok(
    "both shipping reads (invoice + tracking) gate on orders:manage",
    (shippingSource.match(/adminHasPermission\(req\.user, ADMIN_PERMISSIONS\.ORDERS_MANAGE\)/g) || []).length === 2,
  );
  ok("no bare hasAdminRole(req.user) remains in the shipping controller", !shippingSource.includes("hasAdminRole(req.user)"));

  // ═══ H-06: isAdmin honours isBlocked ═══════════════════════════════════════
  section("A blocked admin loses admin routes too (H-06)");
  const isAdminSource = await readFile("src/middleware/is-admin.middleware.js", "utf8");
  ok("isAdmin selects isBlocked", /select\(\s*\n?\s*"roles isActive isBlocked"/.test(isAdminSource));
  ok("isAdmin rejects on isBlocked", /\|\| user\.isBlocked\b/.test(isAdminSource));
  ok("isAdmin still rejects on isActive === false", isAdminSource.includes("user.isActive === false"));

  // ═══ C-08: order status transitions ════════════════════════════════════════
  section("Order status can only move forwards through legal states (C-08)");

  // Delivered's only outgoing move is the admin's success sign-off — a
  // no-money, no-stock transition. Everything money-bearing stays refused.
  ok(
    "Delivered can only move to Completed",
    JSON.stringify(ORDER_STATUS_TRANSITIONS.Delivered) === JSON.stringify(["Completed"]),
  );
  ok("Completed is terminal", ORDER_STATUS_TRANSITIONS.Completed.length === 0);
  ok("Cancelled is terminal", ORDER_STATUS_TRANSITIONS.Cancelled.length === 0);
  ok("Delivered → Shipped is refused", canTransitionOrderStatus("Delivered", "Shipped").ok === false);
  ok("Cancelled → Delivered is refused", canTransitionOrderStatus("Cancelled", "Delivered").ok === false);
  ok("Delivered → Cancelled is refused (use a return instead)", canTransitionOrderStatus("Delivered", "Cancelled").ok === false);
  ok("Pending → Confirmed is allowed", canTransitionOrderStatus("Pending", "Confirmed").ok === true);
  ok("Shipped → Delivered is allowed", canTransitionOrderStatus("Shipped", "Delivered").ok === true);
  ok("Shipped → NDR is allowed", canTransitionOrderStatus("Shipped", "NDR").ok === true);
  ok("NDR → Out For Delivery is allowed (reattempt)", canTransitionOrderStatus("NDR", "Out For Delivery").ok === true);
  ok("Shipped → RTO is allowed", canTransitionOrderStatus("Shipped", "RTO").ok === true);
  ok("Confirmed → Cancelled is allowed", canTransitionOrderStatus("Confirmed", "Cancelled").ok === true);
  ok("Shipped → Cancelled is refused (it is already with the courier)", canTransitionOrderStatus("Shipped", "Cancelled").ok === false);
  ok("the same status is a legal no-op", canTransitionOrderStatus("Shipped", "Shipped").ok === true);
  ok("a refusal explains itself", typeof canTransitionOrderStatus("Delivered", "Shipped").reason === "string");
  ok(
    "the admin UI mirrors the backend table exactly",
    await (async () => {
      const feSource = await readFile(
        "../kitab-shop-fe/src/features/admin-orders/orderStatus.rules.js",
        "utf8",
      ).catch(() => "");
      if (!feSource) return false;
      // Scoped to the transitions object rather than searched across the whole file. This
      // used to do indexOf(`"${from}"`) over the entire source, so any other quoted status
      // name anywhere in the file could win — adding an unrelated
      // CUSTOMER_CANCELLABLE_STATUSES = ["Pending", "Confirmed"] at the bottom made it slice
      // from there and compare against nothing. It also sliced to END of file, so a later
      // key's values could satisfy an earlier key.
      const start = feSource.indexOf("export const ORDER_STATUS_TRANSITIONS = {");
      const end = feSource.indexOf("\n};", start);
      if (start < 0 || end < 0) return false;
      const table = feSource.slice(start, end);
      return Object.entries(ORDER_STATUS_TRANSITIONS).every(([from, tos]) => {
        const keyAt =
          table.indexOf(`"${from}":`) >= 0 ? table.indexOf(`"${from}":`) : table.indexOf(`${from}:`);
        if (keyAt < 0) return false;
        const arrayEnd = table.indexOf("]", keyAt);
        const block = table.slice(keyAt, arrayEnd < 0 ? undefined : arrayEnd);
        return tos.every((to) => block.includes(to));
      });
    })(),
  );

  // ═══ C-07: a cancelled order must not stay cancellable ════════════════════
  section("Cancellation is claimed atomically (C-07)");
  ok(
    "CancelOrder claims the order with a status-filtered update, not a read-then-write",
    /findOneAndUpdate\([\s\S]{0,80}_id: orderId,\s*orderStatus: \{ \$in: allowedStatuses \}/.test(
      orderSource,
    ) && /allowedStatuses = \["Pending", "Confirmed"\]/.test(orderSource),
  );
  ok(
    "and answers 409 when the claim is lost",
    /statusCode = 409/.test(orderSource) && /no longer cancellable/i.test(orderSource),
  );
  ok(
    "restocking on cancel excludes units already cancelled",
    /cancelledQuantity/.test(orderSource) && /Math\.max\(0,/.test(orderSource),
  );

  // ═══ H-13: no fulfilment action on a dead order ═══════════════════════════
  section("A cancelled or returning order cannot be shipped (H-13)");

  // Derived, not a magic number. This used to assert `=== 5`, so adding a legitimate
  // sixth fulfilment handler (GenerateManifest) failed the suite for doing the right
  // thing, and the tempting fix — bump 5 to 6 — is exactly how such an assertion stops
  // protecting anything. The real invariant is that EVERY handler which acts on a
  // shipment runs the guard, so the handler list is what drives the count.
  const guardCalls = shippingSource.match(/ensureFulfillable\(order, "/g) || [];
  const fulfilmentHandlers = [
    "CreateShipment",
    "AssignAwb",
    "SchedulePickup",
    "GenerateLabel",
    "GenerateManifest",
    "GenerateInvoice",
    // Read-only, but still guarded: offering a courier choice for a cancelled or
    // returning order invites a click that can only be refused downstream.
    "GetCourierOptions",
  ];
  const exported = fulfilmentHandlers.filter((name) =>
    new RegExp(`export const ${name} = async`).test(shippingSource),
  );
  ok(
    "every fulfilment handler in the shipping controller is accounted for",
    exported.length === fulfilmentHandlers.length,
    `missing: ${fulfilmentHandlers.filter((n) => !exported.includes(n)).join(", ")}`,
  );
  ok(
    "and each one runs the dead-order guard",
    guardCalls.length === exported.length,
    `guards=${guardCalls.length} handlers=${exported.length}`,
  );
  // A handler added later without a guard is the actual risk, so assert the shape
  // directly too: no exported shipment handler may reach a Shiprocket call without it.
  const unguarded = fulfilmentHandlers.filter((name) => {
    const body = shippingSource.split(`export const ${name} = async`)[1]?.split("\nexport const ")[0] || "";
    return body && !/ensureFulfillable\(order, "/.test(body);
  });
  ok(
    "no fulfilment handler is missing the guard",
    unguarded.length === 0,
    `unguarded: ${unguarded.join(", ")}`,
  );

  // ResolveNdr deliberately does NOT use ensureFulfillable — it requires the order to be
  // at NDR specifically, which is strictly narrower than "fulfillable". Asserted so the
  // difference is a recorded decision rather than a handler that looks like it was missed.
  const ndrBody = shippingSource.split("export const ResolveNdr = async")[1]?.split("\nexport const ")[0] || "";
  ok(
    "ResolveNdr restricts itself to NDR orders instead of the broader fulfilment guard",
    /orderStatus !== "NDR"/.test(ndrBody) && !/ensureFulfillable/.test(ndrBody),
    "ResolveNdr guard shape changed",
  );
  ok(
    "and asks the courier before moving the order, never after",
    ndrBody.indexOf("await actOnNdr(") > 0 &&
      ndrBody.indexOf("await actOnNdr(") < ndrBody.indexOf("findOneAndUpdate("),
    "the NDR action must precede the local status claim",
  );
  ok(
    "and claims the move with the NDR precondition in the filter",
    /findOneAndUpdate\(\s*\{ _id: order\._id, orderStatus: "NDR" \}/.test(ndrBody),
    "claim-in-filter missing from ResolveNdr",
  );

  for (const handler of ["AssignAwb", "SchedulePickup", "GenerateLabel", "GenerateInvoice"]) {
    const start = shippingSource.indexOf(`export const ${handler} =`);
    const body = shippingSource.slice(start, start + 1000);
    const guardAt = body.indexOf("ensureFulfillable");
    const gatewayAt = Math.min(
      ...["assignAwb(", "schedulePickup(", "generateLabel(", "generateInvoice("]
        .map((fn) => body.indexOf(`await ${fn}`))
        .filter((i) => i > -1)
        .concat([Number.MAX_SAFE_INTEGER]),
    );
    ok(`${handler} runs the guard before calling Shiprocket`, guardAt > -1 && guardAt < gatewayAt);
  }

  const guardSource = shippingSource.slice(
    shippingSource.indexOf("const ensureFulfillable"),
    shippingSource.indexOf("export const CreateShipment"),
  );
  const { isFulfillableStatus } = await import("../../src/modules/orders/order-status.rules.js");
  const ensureFulfillable = new Function(
    "ShiprocketError",
    "isFulfillableStatus",
    `${guardSource.replace("const ensureFulfillable", "const fn")}; return fn;`,
  )(ShiprocketError, isFulfillableStatus);

  const attempt = (status) => {
    try {
      ensureFulfillable({ orderStatus: status }, "be shipped");
      return null;
    } catch (error) {
      return error;
    }
  };
  ok("Cancelled → 409", attempt("Cancelled")?.statusCode === 409);
  ok("RTO → 409 (a parcel coming back must not be re-dispatched)", attempt("RTO")?.statusCode === 409);
  // The guard compared against "RTO" alone, so a parcel already back on the
  // seller's shelf could still be given an AWB, a pickup and a label.
  ok("RTO Received → 409 (the parcel is already back)", attempt("RTO Received")?.statusCode === 409);
  ok("Closed → 409 (the RTO is finished)", attempt("Closed")?.statusCode === 409);
  ok("Confirmed → allowed", attempt("Confirmed") === null);
  ok("Packed → allowed", attempt("Packed") === null);
  ok("Shipped → allowed", attempt("Shipped") === null);
  ok("the refusal names the blocked action", attempt("Cancelled")?.message.includes("be shipped"));
} finally {
  await UserModel.deleteMany({ _id: { $in: users } });
  await mongoose.disconnect();
}

const { failed } = finish();
process.exit(failed > 0 ? 1 : 0);
