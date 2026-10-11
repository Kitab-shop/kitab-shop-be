/**
 * Booking claims on the two reverse legs (S6) — one courier per click, however many clicks.
 *
 * Both BookReturnPickup and BookReplacementShipment used to read the return, check that
 * nothing was booked, call Shiprocket, then write the result. Two things were wrong:
 *
 *   THE IDEMPOTENCY CHECK KEYED ON THE AWB, which booking never writes (Shiprocket assigns
 *   it later). So a second click long after a successful booking booked a second courier,
 *   and the replacement write-back — filtered on the AWB being absent — accepted both,
 *   the second silently overwriting the first's shipment ids.
 *
 *   NOTHING SERIALISED CONCURRENT CLICKS. Both passed the read and both called Shiprocket.
 *
 * Each leg now takes an atomic claim before Shiprocket is contacted. The claim is released
 * only on a DEFINITE refusal; after a timeout or transport error Shiprocket may have created
 * the shipment, so the claim is kept until an operator checks and releases it by hand.
 *
 * Run with `npm run test:return-booking-claims` (or `npm test` for everything).
 */
process.env.PAYMENTS_ENABLED = "false";
process.env.INVENTORY_ENFORCE_STOCK = "false";
process.env.INVENTORY_RESERVE_DURING_PAYMENT = "false";
process.env.NOTIFICATIONS_ENABLED = "false";
process.env.SHIPROCKET_BASE_URL = "https://shiprocket.invalid/v1/external";

import mongoose from "mongoose";
import {
  connect,
  createSuite,
  marker,
  productFixture,
  addressFixture,
  pinShiprocketCapabilities,
} from "./helpers.mjs";

const { ok, section, finish } = createSuite("return-booking-claims");
await connect();

const OrderModel = (await import("../../src/modules/orders/Order.model.js")).default;
const ProductModel = (await import("../../src/modules/products/Product.model.js")).default;
const ReturnModel = (await import("../../src/modules/returns/return.model.js")).default;
const UserModel = (await import("../../src/model/User.model.js")).default;
const AuditLog = (await import("../../src/modules/audit/AuditLog.model.js")).default;
const returnController = await import("../../src/modules/returns/return.controller.js");
const { clearPickupLocationCache } = await import("../../src/modules/shipping/shiprocket.service.js");

await OrderModel.init();
await ReturnModel.init();

const MARKER = marker("rbclaim");
const trash = { orders: [], products: [], returns: [], users: [] };
let seq = 0;

// ---------------------------------------------------------------- boundary stubs

const savedEnv = {
  SHIPROCKET_ENABLED: process.env.SHIPROCKET_ENABLED,
  SHIPROCKET_AUTO_CREATE_ORDER: process.env.SHIPROCKET_AUTO_CREATE_ORDER,
  SHIPROCKET_WEBHOOK_ENABLED: process.env.SHIPROCKET_WEBHOOK_ENABLED,
};
process.env.SHIPROCKET_ENABLED = "true";
process.env.SHIPROCKET_AUTO_CREATE_ORDER = "true";
process.env.SHIPROCKET_WEBHOOK_ENABLED = "true";

// Reverse shipments are the one capability pinned OFF by default; this suite opts in.
const restoreCapabilities = await pinShiprocketCapabilities({ reverseShipmentsEnabled: true });
clearPickupLocationCache();

const realFetch = globalThis.fetch;
let calls = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const pickupListResponder = () => ({
  status: 200,
  body: {
    data: {
      shipping_address: [
        {
          pickup_location: "Primary",
          address: "1 Warehouse Road",
          city: "Pune",
          state: "Maharashtra",
          pin_code: "411001",
        },
      ],
    },
  },
});
let nextShipmentId = 9100;
const bookingOk = () => {
  nextShipmentId += 1;
  return { status: 200, body: { order_id: nextShipmentId + 50000, shipment_id: nextShipmentId } };
};
let returnCreateResponder = bookingOk;
let adhocResponder = bookingOk;
// Every create waits a little, so concurrent clicks genuinely overlap inside the handler
// rather than running one after another on a fast stub.
const CREATE_DELAY_MS = 40;

const jsonResponse = ({ status = 200, body = {} }) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
});

globalThis.fetch = async (url, options) => {
  const href = String(url);
  calls.push({ href, method: options?.method || "GET", body: options?.body });
  if (!href.startsWith("https://shiprocket.invalid/")) {
    throw new Error(`unexpected non-Shiprocket call in test: ${href}`);
  }
  if (href.includes("/auth/login")) return jsonResponse({ status: 200, body: { token: "stub" } });
  let route = null;
  if (href.includes("/settings/company/pickup")) route = pickupListResponder;
  else if (href.includes("/orders/create/return")) route = returnCreateResponder;
  else if (href.includes("/orders/create/adhoc")) route = adhocResponder;
  if (!route) throw new Error(`unexpected Shiprocket call in test: ${href}`);
  if (route !== pickupListResponder) await sleep(CREATE_DELAY_MS);
  const outcome = await route(href, options);
  if (outcome instanceof Error) throw outcome;
  return jsonResponse(outcome);
};

const resetCalls = () => {
  calls = [];
};
const callsTo = (fragment) => calls.filter((c) => c.href.includes(fragment));

const restore = () => {
  globalThis.fetch = realFetch;
  restoreCapabilities();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
};

const callController = async (handler, { params = {}, body = {}, user } = {}) => {
  let statusCode = 200;
  let payload;
  const res = {
    status(code) { statusCode = code; return this; },
    json(data) { payload = data; return this; },
  };
  await handler({ params, body, user, query: {}, headers: {}, get: () => undefined }, res);
  return { statusCode, body: payload };
};

const adminUser = () => ({ id: String(new mongoose.Types.ObjectId()), roles: ["admin"] });

const makeReturn = async ({ status = "approved", resolutionType = "replacement", withEmail = true } = {}) => {
  seq += 1;
  const product = await ProductModel.create(productFixture(`${MARKER}-${seq}`, { stock: 20 }));
  trash.products.push(product._id);
  // populate("user", "email") needs a real user document for the payload's email.
  let userId = new mongoose.Types.ObjectId();
  if (withEmail) {
    const user = await UserModel.create({
      name: `${MARKER}-user-${seq}`,
      email: `${MARKER}-${seq}@example.test`,
      password: "x".repeat(20),
    });
    trash.users.push(user._id);
    userId = user._id;
  }
  const order = await OrderModel.create({
    user: userId,
    guestEmail: `${MARKER}-${seq}@example.test`,
    idempotencyKey: `${MARKER}-key-${seq}-aaaaaaaaaaaaaaaa`,
    items: [{ product: product._id, name: product.name, image: "x.png", price: 500, quantity: 2 }],
    shippingAddress: addressFixture(),
    paymentMethod: "COD",
    paymentStatus: "Paid",
    orderStatus: "Delivered",
    deliveredAt: new Date(),
    subtotal: 1000,
    totalAmount: 1000,
  });
  trash.orders.push(order._id);

  const returnRequest = await ReturnModel.create({
    order: order._id,
    user: userId,
    product: product._id,
    productSnapshot: { name: product.name, image: "x.png", price: 500 },
    quantity: 1,
    reason: "damaged on arrival",
    refundAmount: 500,
    resolutionType,
    status,
    returnNumber: `${MARKER}-RET-${seq}`,
  });
  trash.returns.push(returnRequest._id);
  return { returnRequest, order };
};

const bookPickup = (returnRequest) =>
  callController(returnController.BookReturnPickup, {
    params: { id: String(returnRequest._id) },
    user: adminUser(),
  });
const bookReplacement = (returnRequest) =>
  callController(returnController.BookReplacementShipment, {
    params: { id: String(returnRequest._id) },
    user: adminUser(),
  });
const releasePickup = (returnRequest) =>
  callController(returnController.ReleaseReturnPickupClaim, {
    params: { id: String(returnRequest._id) },
    user: adminUser(),
  });
const releaseReplacement = (returnRequest) =>
  callController(returnController.ReleaseReplacementBookingClaim, {
    params: { id: String(returnRequest._id) },
    user: adminUser(),
  });

// Shiprocket's habit of answering HTTP 200 with a validation failure in the body. The
// service maps it to a 400 — a definite "nothing was created".
const embeddedRefusal = () => ({ status: 200, body: { status: 422, message: "Invalid pincode" } });
// The request never got an answer: the shipment may or may not exist.
const transportFailure = () => new Error("socket hang up");

// Ages a claim past the in-flight window, as if the operator came back later.
const ageClaim = (returnRequest, field) =>
  ReturnModel.updateOne(
    { _id: returnRequest._id },
    { $set: { [field]: new Date(Date.now() - 10 * 60 * 1000) } },
  );

// ================================================================ PICKUP

section("return pickup — concurrent clicks book one courier");

{
  const { returnRequest } = await makeReturn({ status: "approved", resolutionType: "refund" });
  resetCalls();
  const results = await Promise.all(Array.from({ length: 5 }, () => bookPickup(returnRequest)));
  const after = await ReturnModel.findById(returnRequest._id).lean();

  ok(
    "five simultaneous clicks make exactly ONE Shiprocket return booking",
    callsTo("/orders/create/return").length === 1,
    `calls=${callsTo("/orders/create/return").length}`,
  );
  const winners = results.filter((r) => r.statusCode === 200 && !r.body?.alreadyBooked);
  ok("exactly one click reports the booking", winners.length === 1, JSON.stringify(results.map((r) => [r.statusCode, r.body?.code, r.body?.alreadyBooked])));
  ok(
    "the others are told it is already booked or in progress — never an error the admin retries",
    results
      .filter((r) => !winners.includes(r))
      .every((r) => (r.statusCode === 200 && r.body?.alreadyBooked) || r.body?.code === "BOOKING_IN_PROGRESS"),
    JSON.stringify(results.map((r) => [r.statusCode, r.body?.code])),
  );
  ok(
    "the return is scheduled with the one shipment, and the claim is cleared in the same write",
    after.status === "pickup_scheduled" && Boolean(after.pickupShipmentId) && after.pickupBookingClaimedAt === null,
    JSON.stringify({ s: after.status, id: after.pickupShipmentId, c: after.pickupBookingClaimedAt }),
  );
  ok(
    "and one history entry records it",
    after.statusHistory.filter((h) => h.status === "pickup_scheduled").length === 1,
    String(after.statusHistory.length),
  );

  // The original bug: idempotency keyed on pickupAwb, which booking never sets.
  resetCalls();
  const again = await bookPickup(returnRequest);
  ok(
    "a second click AFTER success, with no AWB yet, is alreadyBooked and contacts nobody",
    again.statusCode === 200 && again.body?.alreadyBooked === true && callsTo("/orders/create/return").length === 0,
    `${again.statusCode} ${JSON.stringify(again.body)}`,
  );
  ok(
    "and reports the shipment it found",
    again.body?.pickupShipmentId === after.pickupShipmentId,
    JSON.stringify(again.body),
  );
}

section("return pickup — a definite refusal releases the claim");

{
  const { returnRequest } = await makeReturn({ status: "approved", resolutionType: "refund" });
  returnCreateResponder = embeddedRefusal;
  resetCalls();
  const refused = await bookPickup(returnRequest);
  const after = await ReturnModel.findById(returnRequest._id).lean();
  ok(
    "Shiprocket's validation refusal is reported as BOOKING_REFUSED",
    refused.statusCode === 400 && refused.body?.code === "BOOKING_REFUSED",
    `${refused.statusCode} ${JSON.stringify(refused.body)}`,
  );
  ok(
    "the claim is released and the reason kept for the admin page",
    after.pickupBookingClaimedAt === null && /Invalid pincode/.test(after.pickupBookingError) && after.status === "approved",
    JSON.stringify({ c: after.pickupBookingClaimedAt, e: after.pickupBookingError, s: after.status }),
  );

  returnCreateResponder = bookingOk;
  resetCalls();
  const retry = await bookPickup(returnRequest);
  const booked = await ReturnModel.findById(returnRequest._id).lean();
  ok(
    "so a plain retry books",
    retry.statusCode === 200 && booked.status === "pickup_scheduled" && callsTo("/orders/create/return").length === 1,
    `${retry.statusCode} ${booked.status} calls=${callsTo("/orders/create/return").length}`,
  );
  ok("and the stale error is cleared by the success", booked.pickupBookingError === "", booked.pickupBookingError);
}

{
  // A failure before any request leaves (no customer email) is just as definite.
  const { returnRequest } = await makeReturn({ status: "approved", resolutionType: "refund", withEmail: false });
  resetCalls();
  const refused = await bookPickup(returnRequest);
  const after = await ReturnModel.findById(returnRequest._id).lean();
  ok(
    "a failure before Shiprocket is contacted also releases the claim",
    refused.statusCode === 400 &&
      after.pickupBookingClaimedAt === null &&
      callsTo("/orders/create/return").length === 0,
    `${refused.statusCode} ${JSON.stringify({ c: after.pickupBookingClaimedAt })}`,
  );
}

section("return pickup — an unknown outcome keeps the claim until a human checks");

{
  const { returnRequest } = await makeReturn({ status: "approved", resolutionType: "refund" });
  returnCreateResponder = transportFailure;
  resetCalls();
  const first = await bookPickup(returnRequest);
  const after = await ReturnModel.findById(returnRequest._id).lean();
  ok(
    "a transport error is BOOKING_OUTCOME_UNKNOWN, not a plain failure",
    first.statusCode >= 500 && first.body?.code === "BOOKING_OUTCOME_UNKNOWN",
    `${first.statusCode} ${JSON.stringify(first.body)}`,
  );
  ok(
    "and the message tells the admin to check Shiprocket before retrying",
    /Check Shiprocket/.test(first.body?.message || "") && first.body.message.includes(returnRequest.returnNumber),
    first.body?.message,
  );
  ok(
    "the claim is KEPT, with the error recorded",
    Boolean(after.pickupBookingClaimedAt) && /socket hang up/.test(after.pickupBookingError) && after.status === "approved",
    JSON.stringify({ c: after.pickupBookingClaimedAt, e: after.pickupBookingError }),
  );

  returnCreateResponder = bookingOk;
  resetCalls();
  const retry = await bookPickup(returnRequest);
  ok(
    "a retry is refused without contacting Shiprocket",
    retry.statusCode === 409 &&
      retry.body?.code === "BOOKING_OUTCOME_UNKNOWN" &&
      callsTo("/orders/create/return").length === 0,
    `${retry.statusCode} ${JSON.stringify(retry.body?.code)}`,
  );

  const released = await releasePickup(returnRequest);
  const afterRelease = await ReturnModel.findById(returnRequest._id).lean();
  ok(
    "release-claim frees the leg once the operator has checked",
    released.statusCode === 200 && afterRelease.pickupBookingClaimedAt === null && afterRelease.pickupBookingError === "",
    `${released.statusCode} ${JSON.stringify(released.body?.message)}`,
  );
  ok(
    "and leaves a note in the return's own history",
    afterRelease.statusHistory.some((h) => /released the return pickup booking claim/.test(h.note) && /socket hang up/.test(h.note)),
    JSON.stringify(afterRelease.statusHistory.map((h) => h.note)),
  );
  ok(
    "and an audit entry",
    (await AuditLog.countDocuments({ targetId: returnRequest._id, action: "RELEASE_RETURN_BOOKING_CLAIM" })) === 1,
    "no audit entry",
  );

  resetCalls();
  const rebook = await bookPickup(returnRequest);
  ok(
    "after which booking goes through once",
    rebook.statusCode === 200 && callsTo("/orders/create/return").length === 1,
    `${rebook.statusCode} calls=${callsTo("/orders/create/return").length}`,
  );

  const releaseBooked = await releasePickup(returnRequest);
  ok(
    "a booked leg has no claim to release",
    releaseBooked.statusCode === 409 && releaseBooked.body?.code === "ALREADY_BOOKED",
    `${releaseBooked.statusCode} ${JSON.stringify(releaseBooked.body?.code)}`,
  );
}

{
  const { returnRequest } = await makeReturn({ status: "approved", resolutionType: "refund" });
  const nothing = await releasePickup(returnRequest);
  ok(
    "release with no claim held is refused",
    nothing.statusCode === 409 && nothing.body?.code === "NO_BOOKING_CLAIM",
    `${nothing.statusCode} ${JSON.stringify(nothing.body?.code)}`,
  );

  // A young claim with no error is a booking most likely still in flight.
  await ReturnModel.updateOne({ _id: returnRequest._id }, { $set: { pickupBookingClaimedAt: new Date() } });
  const young = await releasePickup(returnRequest);
  const still = await ReturnModel.findById(returnRequest._id).lean();
  ok(
    "a fresh claim with no recorded error cannot be released — it is probably still booking",
    young.statusCode === 409 && young.body?.code === "BOOKING_IN_PROGRESS" && Boolean(still.pickupBookingClaimedAt),
    `${young.statusCode} ${JSON.stringify(young.body?.code)}`,
  );
  resetCalls();
  const blocked = await bookPickup(returnRequest);
  ok(
    "and booking while it is held is BOOKING_IN_PROGRESS with no Shiprocket call",
    blocked.statusCode === 409 && blocked.body?.code === "BOOKING_IN_PROGRESS" && callsTo("/orders/create/return").length === 0,
    `${blocked.statusCode} ${JSON.stringify(blocked.body?.code)}`,
  );
  await ageClaim(returnRequest, "pickupBookingClaimedAt");
  const old = await releasePickup(returnRequest);
  ok("an old abandoned claim can be released", old.statusCode === 200, `${old.statusCode} ${JSON.stringify(old.body)}`);
}

{
  // The return moves on while Shiprocket is booking. The shipment exists regardless, so
  // its ids are recorded — an unrecorded shipment is what lets the next click book again.
  const { returnRequest } = await makeReturn({ status: "approved", resolutionType: "refund" });
  returnCreateResponder = async () => {
    await ReturnModel.updateOne({ _id: returnRequest._id }, { $set: { status: "rejected" } });
    return bookingOk();
  };
  const result = await bookPickup(returnRequest);
  const after = await ReturnModel.findById(returnRequest._id).lean();
  returnCreateResponder = bookingOk;
  ok(
    "a booking that lands after the return moved is reported, not forced",
    result.statusCode === 409 && after.status === "rejected",
    `${result.statusCode} ${after.status}`,
  );
  ok(
    "but its shipment id is recorded and the claim cleared",
    after.pickupShipmentId === result.body?.shipmentId && after.pickupBookingClaimedAt === null,
    JSON.stringify({ id: after.pickupShipmentId, reported: result.body?.shipmentId, c: after.pickupBookingClaimedAt }),
  );
}

// ================================================================ REPLACEMENT

section("replacement parcel — concurrent clicks book one parcel");

{
  const { returnRequest } = await makeReturn({ status: "received", resolutionType: "replacement" });
  resetCalls();
  const results = await Promise.all(Array.from({ length: 5 }, () => bookReplacement(returnRequest)));
  const after = await ReturnModel.findById(returnRequest._id).lean();
  ok(
    "five simultaneous clicks make exactly ONE adhoc booking",
    callsTo("/orders/create/adhoc").length === 1,
    `calls=${callsTo("/orders/create/adhoc").length}`,
  );
  ok(
    "one click reports the booking",
    results.filter((r) => r.statusCode === 200 && !r.body?.alreadyBooked).length === 1,
    JSON.stringify(results.map((r) => [r.statusCode, r.body?.code, r.body?.alreadyBooked])),
  );
  ok(
    "the parcel is stored, the claim cleared, the status untouched",
    Boolean(after.replacementShipmentId) && after.replacementBookingClaimedAt === null && after.status === "received",
    JSON.stringify({ id: after.replacementShipmentId, c: after.replacementBookingClaimedAt, s: after.status }),
  );

  resetCalls();
  const again = await bookReplacement(returnRequest);
  ok(
    "a second click after success is alreadyBooked with no Shiprocket call",
    again.statusCode === 200 && again.body?.alreadyBooked === true && callsTo("/orders/create/adhoc").length === 0,
    `${again.statusCode} ${JSON.stringify(again.body)}`,
  );

  // Booked through Shiprocket, but the AWB is only assigned there later.
  const noAwb = await callController(returnController.DispatchReplacement, {
    params: { id: String(returnRequest._id) },
    body: { disposition: "resellable" },
    user: adminUser(),
  });
  ok(
    "dispatching a booked parcel with no AWB says the AWB must be entered",
    noAwb.statusCode === 400 && noAwb.body?.code === "REPLACEMENT_AWB_NOT_ASSIGNED" && /AWB/.test(noAwb.body?.message || ""),
    `${noAwb.statusCode} ${JSON.stringify(noAwb.body)}`,
  );
  const typed = await callController(returnController.DispatchReplacement, {
    params: { id: String(returnRequest._id) },
    body: { courier: "Delhivery", awb: `${MARKER}-rep-awb`, disposition: "resellable" },
    user: adminUser(),
  });
  const dispatched = await ReturnModel.findById(returnRequest._id).lean();
  ok(
    "typing the courier and AWB dispatches it",
    typed.statusCode === 200 && dispatched.status === "replacement_dispatched" && dispatched.replacementAwb === `${MARKER}-rep-awb`,
    `${typed.statusCode} ${dispatched.status} ${JSON.stringify(typed.body?.message)}`,
  );
}

section("replacement parcel — refusal releases, unknown keeps");

{
  const { returnRequest } = await makeReturn({ status: "received", resolutionType: "replacement" });
  adhocResponder = embeddedRefusal;
  const refused = await bookReplacement(returnRequest);
  const after = await ReturnModel.findById(returnRequest._id).lean();
  ok(
    "a definite refusal is BOOKING_REFUSED and releases the claim",
    refused.body?.code === "BOOKING_REFUSED" && after.replacementBookingClaimedAt === null && /Invalid pincode/.test(after.replacementBookingError),
    `${refused.statusCode} ${JSON.stringify({ code: refused.body?.code, c: after.replacementBookingClaimedAt })}`,
  );
  adhocResponder = bookingOk;
  resetCalls();
  const retry = await bookReplacement(returnRequest);
  ok(
    "and a retry books",
    retry.statusCode === 200 && callsTo("/orders/create/adhoc").length === 1,
    `${retry.statusCode} calls=${callsTo("/orders/create/adhoc").length}`,
  );
}

{
  const { returnRequest } = await makeReturn({ status: "received", resolutionType: "replacement" });
  adhocResponder = transportFailure;
  const first = await bookReplacement(returnRequest);
  const after = await ReturnModel.findById(returnRequest._id).lean();
  ok(
    "a transport error keeps the claim as BOOKING_OUTCOME_UNKNOWN",
    first.body?.code === "BOOKING_OUTCOME_UNKNOWN" && Boolean(after.replacementBookingClaimedAt),
    `${first.statusCode} ${JSON.stringify(first.body?.code)}`,
  );

  adhocResponder = bookingOk;
  resetCalls();
  const retry = await bookReplacement(returnRequest);
  ok(
    "a retry is refused with no Shiprocket call",
    retry.statusCode === 409 && retry.body?.code === "BOOKING_OUTCOME_UNKNOWN" && callsTo("/orders/create/adhoc").length === 0,
    `${retry.statusCode} ${JSON.stringify(retry.body?.code)}`,
  );

  // A hand dispatch on top of a parcel that may exist would send two units.
  const dispatch = await callController(returnController.DispatchReplacement, {
    params: { id: String(returnRequest._id) },
    body: { courier: "Hand", awb: `${MARKER}-hand`, disposition: "resellable" },
    user: adminUser(),
  });
  ok(
    "manual dispatch is refused while the booking outcome is unknown",
    dispatch.statusCode === 409 && dispatch.body?.code === "BOOKING_OUTCOME_UNKNOWN",
    `${dispatch.statusCode} ${JSON.stringify(dispatch.body?.code)}`,
  );

  const released = await releaseReplacement(returnRequest);
  ok("release-claim frees the replacement leg", released.statusCode === 200, `${released.statusCode} ${JSON.stringify(released.body)}`);
  resetCalls();
  const rebook = await bookReplacement(returnRequest);
  ok(
    "after which it books once",
    rebook.statusCode === 200 && callsTo("/orders/create/adhoc").length === 1,
    `${rebook.statusCode} calls=${callsTo("/orders/create/adhoc").length}`,
  );
}

{
  // The claim filter carries the leg's own preconditions.
  const { returnRequest } = await makeReturn({ status: "received", resolutionType: "refund" });
  resetCalls();
  const result = await bookReplacement(returnRequest);
  const after = await ReturnModel.findById(returnRequest._id).lean();
  ok(
    "a refund return is still refused, and takes no claim",
    result.body?.code === "NOT_A_REPLACEMENT" && after.replacementBookingClaimedAt === null && callsTo("/orders/create/adhoc").length === 0,
    `${result.statusCode} ${JSON.stringify(result.body?.code)}`,
  );
}

// ---------------------------------------------------------------- cleanup

restore();

await Promise.all([
  OrderModel.deleteMany({ _id: { $in: trash.orders } }),
  ProductModel.deleteMany({ _id: { $in: trash.products } }),
  ReturnModel.deleteMany({ _id: { $in: trash.returns } }),
  UserModel.deleteMany({ _id: { $in: trash.users } }),
  AuditLog.deleteMany({ targetId: { $in: trash.returns } }),
]);

const leftovers =
  (await OrderModel.countDocuments({ idempotencyKey: new RegExp(MARKER) })) +
  (await ProductModel.countDocuments({ name: new RegExp(MARKER) })) +
  (await ReturnModel.countDocuments({ returnNumber: new RegExp(MARKER) })) +
  (await UserModel.countDocuments({ name: new RegExp(MARKER) })) +
  (await AuditLog.countDocuments({ targetId: { $in: trash.returns } }));
ok("every fixture this suite created is gone", leftovers === 0, `leftovers=${leftovers}`);

const summary = finish();
await mongoose.disconnect();
process.exit(summary.failed > 0 ? 1 : 0);
