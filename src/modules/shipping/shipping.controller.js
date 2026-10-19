import crypto from "node:crypto";
import OrderModel from "../orders/Order.model.js";
import {
  logLifecycleError,
  logLifecycleEvent,
} from "../../utils/lifecycle-logger.service.js";
import {
  ShiprocketError,
  actOnNdr,
  checkCodServiceability,
  checkServiceability,
  computeOrderPackage,
  generateInvoice,
  generateLabel,
  generateManifest,
  getShippingCapabilities,
  getShiprocketCredentials,
  resolvePackage,
  schedulePickup,
  trackAwb,
} from "./shiprocket.service.js";
import {
  acknowledgeAmountMismatch,
  assignOrderAwb,
  confirmShipmentNotCreated,
  createForwardShipment,
  linkExistingShipment,
} from "../orders/order-shipping.service.js";
import { createAuditLog } from "../audit/audit-log.js";
import { ADMIN_PERMISSIONS } from "../../config/admin-permissions.config.js";
import { adminHasPermission } from "../../config/admin-access.service.js";
import {
  canTransitionOrderStatus,
  isFulfillableStatus,
} from "../orders/order-status.rules.js";
import { applyCourierEvent, courierEventFromWebhook } from "./courier-event.service.js";
import { extractCourierEventTime } from "./courier-event-time.js";
import { normalizeTracking, toCustomerTracking } from "./tracking-normalize.js";

const errorResponse = (res, error) =>
  res.status(error.statusCode || 500).json({
    success: false,
    message: error.message,
    ...(process.env.NODE_ENV !== "production" && error.details
      ? { details: error.details }
      : {}),
  });

const findOrder = (orderId) =>
  OrderModel.findById(orderId)
    .populate("user", "email")
    .populate("items.product", "_id weight length breadth height");

// The provider-neutral mirror (`shipment.*`) is written by buildShipmentMirrorSet in
// order-shipping.service.js, as $set paths folded into each caller's own filtered update.
// It replaced a helper here that mutated a loaded document for a whole-document save().

// Async now, because "how much of Shiprocket do we use" is an admin choice stored in
// the database, not just an env flag. The two refusals are worded differently on
// purpose: one is a deployment fact a developer must change, the other is a setting the
// admin can change themselves — telling them apart is the difference between a support
// ticket and a click.
const ensureShiprocketEnabled = async () => {
  const capabilities = await getShippingCapabilities();
  if (!capabilities.permitted) {
    throw new ShiprocketError("Shiprocket is disabled for this environment", 503);
  }
  if (!capabilities.shipments) {
    throw new ShiprocketError(
      "This store is set to manual fulfilment. Switch Shiprocket shipments back on under Operations → Shipping, or record the shipment manually on the order.",
      409,
    );
  }
  // Checked here rather than left to getConfig() deep inside the request. The message that
  // surfaced was "Shiprocket credentials are not configured" — accurate, but it reads as a
  // server fault when it is a setting the admin owns and can fix in a minute.
  if (!capabilities.configured) {
    throw new ShiprocketError(
      "No Shiprocket account is connected. Add your Shiprocket email and password under Operations → Shipping, then try again.",
      409,
    );
  }
};

/**
 * Refuses any fulfilment action on an order that is no longer meant to ship.
 *
 * CreateShipment already had this check; AssignAwb, SchedulePickup, GenerateLabel
 * and GenerateInvoice did not — so a cancelled order (quite possibly already
 * refunded) could still be given an AWB, have a courier pickup booked, and get a
 * shipping label printed. The parcel then physically leaves with the money
 * already returned. RTO is included because an order coming back from a failed
 * delivery must not be re-dispatched by another click on the same buttons.
 */
const ensureFulfillable = (order, action) => {
  if (isFulfillableStatus(order.orderStatus)) return;

  if (order.orderStatus === "Cancelled") {
    throw new ShiprocketError(`Cancelled orders cannot ${action}`, 409);
  }
  // Every RTO state, not just "RTO". The check used to compare against "RTO"
  // alone, so an order at "RTO Received" — the parcel physically back on the
  // seller's shelf — could still be given an AWB, have a courier pickup booked and
  // get a label printed, and the parcel would leave again. "Closed" is included for
  // the same reason: it is finished.
  throw new ShiprocketError(
    `This order is being returned to origin (${order.orderStatus}) and cannot ${action}`,
    409,
  );
};

export const CreateShipment = async (req, res) => {
  try {
    await ensureShiprocketEnabled();

    const order = await findOrder(req.params.orderId);
    if (!order) {
      return res.status(404).json({ success: false, message: "Order not found" });
    }
    ensureFulfillable(order, "be shipped");
    if (order.shiprocket?.orderId) {
      return res.status(200).json({
        success: true,
        message: "Order is already synced with Shiprocket",
        order,
      });
    }

    // The read above is a fast path for the common refusals, NOT the decision. The
    // decision is the atomic claim inside createForwardShipment, which is what makes a
    // double click, a second admin and an auto-push racing this request all end in one
    // Shiprocket order. It also owns failure recording — this handler used to mark any
    // error "failed", which made a timed-out request (whose shipment may exist) look
    // safe to retry.
    const result = await createForwardShipment(order._id, {
      packageOverrides: req.body?.package,
      source: "admin",
      actorId: req.user?.id ?? null,
    });

    if (result.outcome === "created") {
      return res.status(201).json({
        success: true,
        message:
          result.order?.orderStatus === "Cancelled"
            ? "The order was cancelled while its shipment was being created, so the new Shiprocket shipment was cancelled too"
            : "Order created in Shiprocket",
        order: await findOrder(order._id),
        amountCheck: result.amountCheck ?? null,
      });
    }
    if (result.outcome === "already_created") {
      return res.status(200).json({
        success: true,
        message: "Order is already synced with Shiprocket",
        order: await findOrder(order._id),
      });
    }
    return res.status(result.statusCode || 500).json({
      success: false,
      message: result.message,
      ...(result.code ? { code: result.code } : {}),
      ...(process.env.NODE_ENV !== "production" && result.error?.details
        ? { details: result.error.details }
        : {}),
    });
  } catch (error) {
    return errorResponse(res, error);
  }
};

/**
 * Resolves a stuck creation: "the shipment exists — here are its ids".
 *
 * A create request that timed out (or whose answer was lost) leaves the order in
 * "creating" with the claim held, deliberately not retried. An admin who finds the
 * shipment in Shiprocket's dashboard records it here; it is stored by the same
 * write-back a successful create uses, and the amount is read back and checked.
 *
 * Only valid while "creating". Audited, because it asserts a fact about money and
 * couriers that the system could not establish itself.
 */
export const LinkShipment = async (req, res) => {
  try {
    const { shiprocketOrderId, shipmentId } = req.body;
    const result = await linkExistingShipment(req.params.orderId, { shiprocketOrderId, shipmentId });

    if (result.outcome === "not_found") {
      return res.status(404).json({ success: false, message: "Order not found" });
    }
    if (result.outcome === "not_creating") {
      return res.status(409).json({
        success: false,
        code: "SHIPMENT_NOT_CREATING",
        message: "Only a shipment whose creation is still unresolved can be linked.",
      });
    }
    if (result.outcome === "conflict") {
      return res.status(409).json({
        success: false,
        code: "SHIPMENT_ID_CONFLICT",
        message: `Shiprocket order ${shiprocketOrderId} is already recorded against another order.`,
      });
    }

    await createAuditLog({
      admin: req.user?.id,
      action: "LINK_SHIPMENT",
      module: "ORDER",
      targetId: result.order._id,
      targetName: String(result.order._id),
      description: `Linked existing Shiprocket order ${shiprocketOrderId} / shipment ${shipmentId} after an unresolved creation attempt`,
      req,
    });
    return res.status(200).json({
      success: true,
      message: "Shipment linked",
      order: await findOrder(result.order._id),
      amountCheck: result.amountCheck ?? null,
    });
  } catch (error) {
    return errorResponse(res, error);
  }
};

/**
 * Resolves a stuck creation the other way: "no shipment exists in Shiprocket".
 * Moves the order to "failed", which makes Create Shipment available again.
 */
export const ConfirmShipmentNotCreated = async (req, res) => {
  try {
    const result = await confirmShipmentNotCreated(req.params.orderId);

    if (result.outcome === "not_found") {
      return res.status(404).json({ success: false, message: "Order not found" });
    }
    if (result.outcome === "not_creating") {
      return res.status(409).json({
        success: false,
        code: "SHIPMENT_NOT_CREATING",
        message: "Only a shipment whose creation is still unresolved can be confirmed as not created.",
      });
    }

    await createAuditLog({
      admin: req.user?.id,
      action: "CONFIRM_SHIPMENT_NOT_CREATED",
      module: "ORDER",
      targetId: result.order._id,
      targetName: String(result.order._id),
      description: "Confirmed that an unresolved shipment creation did not create a Shiprocket order; creation may be retried",
      req,
    });
    return res.status(200).json({
      success: true,
      message: "Marked as not created. You can create the shipment again.",
      order: await findOrder(result.order._id),
    });
  } catch (error) {
    return errorResponse(res, error);
  }
};

/**
 * "I have seen the amount mismatch and accept it."
 *
 * The COD amount check blocks AWB assignment when Shiprocket's recorded total differs
 * from what the order says should be collected. Sometimes that is right (the admin has
 * corrected the amount in Shiprocket's dashboard, which this system cannot see), so a
 * person can release the block — on the record.
 */
export const AcknowledgeAmountMismatch = async (req, res) => {
  try {
    const result = await acknowledgeAmountMismatch(req.params.orderId, req.user?.id);

    if (result.outcome === "not_found") {
      return res.status(404).json({ success: false, message: "Order not found" });
    }
    if (result.outcome === "not_mismatch") {
      return res.status(409).json({
        success: false,
        code: "AMOUNT_CHECK_NOT_MISMATCH",
        message: "There is no amount mismatch on this order to acknowledge.",
      });
    }
    if (result.outcome === "not_cod") {
      return res.status(409).json({
        success: false,
        code: "AMOUNT_ACK_NOT_COD",
        message: "Only a COD order's amount can be acknowledged. Nothing is collected on delivery for this order.",
      });
    }
    if (result.outcome === "acknowledged") {
      const check = result.order.shiprocket?.amountCheck || {};
      await createAuditLog({
        admin: req.user?.id,
        action: "ACK_COD_AMOUNT",
        module: "ORDER",
        targetId: result.order._id,
        targetName: String(result.order._id),
        description: `Acknowledged Shiprocket amount mismatch: expected ₹${check.expected}, Shiprocket reported ₹${check.reported}`,
        req,
      });
    }
    return res.status(200).json({
      success: true,
      message:
        result.outcome === "already_acknowledged"
          ? "This mismatch was already acknowledged"
          : "Amount mismatch acknowledged. An AWB can now be assigned.",
      order: await findOrder(result.order._id),
    });
  } catch (error) {
    return errorResponse(res, error);
  }
};

/**
 * "Can Cash on Delivery reach this PIN code?" — for the checkout screen.
 *
 * Answers with exactly the decision order placement will make, by calling the SAME
 * function the COD gate in PlaceOrder uses (checkCodServiceability, via
 * evaluateCodPincodeRestriction). It used to return Shiprocket's raw serviceability
 * response — every courier's rates and the store's pickup PIN — to any logged-in
 * customer, accepted pickup and parcel overrides from the query string (so it doubled as
 * a free rate calculator on the store's account), and was gated on a different
 * capability from the order path, so checkout could hide COD that the server would have
 * accepted. Now: two booleans, no overrides, rate-limited, same gate as the decision.
 *
 * Fails CLOSED like the decision it predicts: an answer we could not get is a 503, which
 * the checkout treats as "COD unavailable".
 */
export const CheckServiceability = async (req, res) => {
  try {
    const deliveryPostcode = String(req.query.deliveryPostcode || "").trim();
    if (!/^\d{6}$/.test(deliveryPostcode)) {
      return res.status(400).json({ success: false, message: "A valid deliveryPostcode is required" });
    }

    const result = await checkCodServiceability({ deliveryPostcode });
    if (result.unverified) {
      return res.status(503).json({
        success: false,
        message: "Cash on Delivery availability could not be checked right now.",
      });
    }
    return res.status(200).json({
      success: true,
      data: { serviceable: result.serviceable, codAvailable: result.serviceable },
    });
  } catch (error) {
    return errorResponse(res, error);
  }
};

/**
 * The couriers that will actually carry THIS order, with their real rates and ETDs.
 *
 * `AssignAwb` takes a `courierId`, and until now nothing told an admin what to put
 * there — the same "type an exact external value or everything fails" problem the pickup
 * location had. This turns it into a list to pick from.
 *
 * No new Shiprocket endpoint: serviceability already returns the courier list for a
 * route, and it is already integrated. The difference is that the route comes from the
 * ORDER (its real delivery pincode, its real package, its real payment method) instead of
 * query parameters an admin has to assemble by hand.
 *
 * `cod` is derived from the order, not requested: asking for prepaid couriers on a COD
 * order would offer couriers that cannot collect the cash.
 */
export const GetCourierOptions = async (req, res) => {
  try {
    await ensureShiprocketEnabled();

    const order = await findOrder(req.params.orderId);
    if (!order) return res.status(404).json({ success: false, message: "Order not found" });
    ensureFulfillable(order, "have couriers listed");

    const deliveryPostcode = String(order.shippingAddress?.pincode || "").trim();
    if (!/^\d{6}$/.test(deliveryPostcode)) {
      return res.status(409).json({
        success: false,
        message: "This order has no valid 6-digit delivery PIN code, so couriers cannot be listed.",
      });
    }

    // Same defaults the shipment itself will use, so the rates quoted here are for
    // the parcel that actually ships rather than a differently-measured one.
    const packageDefaults = await getShiprocketCredentials();
    const packageDetails = await resolvePackage(computeOrderPackage(order, packageDefaults));
    const data = await checkServiceability({
      ...packageDetails,
      deliveryPostcode,
      cod: order.paymentMethod === "COD",
      declaredValue: order.totalAmount,
    });

    const raw = data?.data?.available_courier_companies ?? data?.available_courier_companies;
    if (!Array.isArray(raw)) {
      return res.status(502).json({
        success: false,
        message: "Shiprocket did not return a courier list for this order.",
      });
    }

    // Allow-listed, and sorted cheapest first — an admin picking a courier is making a
    // cost decision, so the number they are deciding on has to be visible.
    const couriers = raw
      .map((entry) => ({
        courierId: Number(entry?.courier_company_id) || null,
        name: String(entry?.courier_name ?? "").trim(),
        rate: Number(entry?.rate) || 0,
        estimatedDays: Number(entry?.estimated_delivery_days ?? entry?.etd_hours / 24) || null,
        etd: String(entry?.etd ?? "").trim(),
        codAvailable: entry?.cod === 1 || entry?.cod === true,
        rating: Number(entry?.rating) || null,
        // So the UI can mark the one already carrying this parcel rather than
        // presenting it as a fresh choice.
        current: Number(entry?.courier_company_id) === Number(order.shiprocket?.courierId),
      }))
      .filter((entry) => entry.courierId && entry.name)
      .sort((a, b) => a.rate - b.rate);

    return res.status(200).json({
      success: true,
      couriers,
      currentCourierId: order.shiprocket?.courierId || null,
      currentAwb: order.shiprocket?.awbCode || null,
      codRequired: order.paymentMethod === "COD",
    });
  } catch (error) {
    return errorResponse(res, error);
  }
};

export const AssignAwb = async (req, res) => {
  try {
    await ensureShiprocketEnabled();

    const order = await OrderModel.findById(req.params.orderId);
    if (!order) return res.status(404).json({ success: false, message: "Order not found" });
    ensureFulfillable(order, "be assigned an AWB");

    // The same function the automatic assignment after an auto-push uses, so the COD
    // amount gate, the reassignment rules and the AWB identity check cannot drift apart.
    const result = await assignOrderAwb(order, {
      courierId: req.body?.courierId,
      source: "admin",
    });
    if (result.outcome !== "assigned") {
      return res.status(result.statusCode).json({
        success: false,
        message: result.message,
        ...(result.code ? { code: result.code } : {}),
        ...(result.outcome === "cod_mismatch"
          ? { expected: result.expected, reported: result.reported }
          : {}),
      });
    }

    return res.status(200).json({
      success: true,
      message: result.isReassignment ? "Courier reassigned" : "AWB assigned",
      previousAwb: result.previousAwb,
      order: result.order,
      data: result.response,
    });
  } catch (error) {
    return errorResponse(res, error);
  }
};

// What an admin can decide about a failed delivery, and where each decision leaves the
// order. Both targets are legal moves from NDR in order-status.rules.js; keeping the map
// here rather than accepting a status from the client means the client cannot ask for a
// transition the rules would refuse.
const NDR_ACTIONS = {
  reattempt: { shiprocketAction: "re-attempt", orderStatus: "Out For Delivery" },
  return: { shiprocketAction: "return", orderStatus: "RTO" },
};

/**
 * Acts on a failed delivery attempt.
 *
 * Ordering is the whole design: Shiprocket is asked FIRST, and the order only moves once
 * the courier has accepted. Moving first would let the admin see "re-attempt requested"
 * for a re-attempt that never happened — the order would claim something the courier
 * never agreed to, which is the same class of lie as a status claiming money that never
 * moved.
 *
 * No money moves here. "return" sends the parcel back, but the refund obligation is
 * recorded when the parcel ARRIVES (RTO Received, from the webhook), not when it starts
 * travelling — so this cannot create a refund for goods still in transit.
 */
export const ResolveNdr = async (req, res) => {
  try {
    await ensureShiprocketEnabled();

    const order = await OrderModel.findById(req.params.orderId);
    if (!order) return res.status(404).json({ success: false, message: "Order not found" });

    const choice = NDR_ACTIONS[String(req.body?.action || "").trim().toLowerCase()];
    if (!choice) {
      return res.status(400).json({
        success: false,
        message: `action must be one of: ${Object.keys(NDR_ACTIONS).join(", ")}`,
      });
    }

    // Only from NDR. From anywhere else there is no failed attempt to resolve, and
    // allowing it would turn this into a general-purpose status override.
    if (order.orderStatus !== "NDR") {
      return res.status(409).json({
        success: false,
        message: `Only an order with a failed delivery (NDR) can be resolved this way — this one is ${order.orderStatus}.`,
      });
    }
    if (!order.shiprocket?.awbCode) {
      return res.status(409).json({
        success: false,
        message: "This order has no AWB, so there is no parcel for the courier to act on.",
      });
    }

    // Checked before the courier call, not after: refusing early costs nothing, and
    // asking the courier to do something we then could not record is the case worth
    // avoiding entirely.
    const transition = canTransitionOrderStatus(order.orderStatus, choice.orderStatus);
    if (!transition.ok) {
      return res.status(409).json({
        success: false,
        message: transition.reason || `Cannot move this order to ${choice.orderStatus}.`,
      });
    }

    const data = await actOnNdr(order.shiprocket.awbCode, {
      action: choice.shiprocketAction,
      comment: String(req.body?.comment || "").slice(0, 500),
    });

    // Claim-in-filter: `orderStatus: "NDR"` is the precondition, so two admins clicking
    // at once produce one move and one 409 rather than two history entries.
    const claimed = await OrderModel.findOneAndUpdate(
      { _id: order._id, orderStatus: "NDR" },
      {
        $set: {
          orderStatus: choice.orderStatus,
          "shiprocket.status": choice.orderStatus,
          "shiprocket.syncStatus": choice.orderStatus === "RTO" ? "rto" : "awb_assigned",
          "shiprocket.lastError": null,
          "shiprocket.lastSyncedAt": new Date(),
          ...(order.shipment?.provider !== "MANUAL" ? { "shipment.status": choice.orderStatus } : {}),
        },
        $push: {
          statusHistory: {
            from: "NDR",
            to: choice.orderStatus,
            changedBy: req.user?.id || null,
            source: "ndr_action",
            changedAt: new Date(),
          },
        },
      },
      { returnDocument: "after" },
    );

    if (!claimed) {
      // The courier HAS accepted, but something else moved the order first. Recorded
      // loudly rather than retried: the webhook is the reconciler for courier state, and
      // forcing our status now would overwrite whatever that concurrent change was.
      logLifecycleError(
        "shipping",
        "ndr_action_accepted_but_order_moved",
        new Error("Shiprocket accepted the NDR action but the order was no longer at NDR"),
        { orderId: order._id, action: choice.shiprocketAction, awbCode: order.shiprocket.awbCode },
      );
      return res.status(409).json({
        success: false,
        message:
          "The courier accepted the request, but this order had already moved on. Refresh to see its current status.",
      });
    }

    logLifecycleEvent("shipping", "ndr_action_recorded", {
      orderId: claimed._id,
      action: choice.shiprocketAction,
      to: choice.orderStatus,
      awbCode: claimed.shiprocket?.awbCode,
    });

    return res.status(200).json({
      success: true,
      message:
        choice.orderStatus === "RTO"
          ? "The courier will return this parcel to you."
          : "The courier will attempt delivery again.",
      order: claimed,
      data,
    });
  } catch (error) {
    return errorResponse(res, error);
  }
};

export const SchedulePickup = async (req, res) => {
  try {
    await ensureShiprocketEnabled();

    const order = await OrderModel.findById(req.params.orderId);
    if (!order) return res.status(404).json({ success: false, message: "Order not found" });
    ensureFulfillable(order, "have a pickup scheduled");
    if (!order.shiprocket?.shipmentId || !order.shiprocket?.awbCode) {
      return res.status(409).json({ success: false, message: "Assign an AWB before scheduling pickup" });
    }

    const pickupDate = req.body?.pickupDate;
    if (pickupDate && !/^\d{4}-\d{2}-\d{2}$/.test(pickupDate)) {
      return res.status(400).json({ success: false, message: "pickupDate must use YYYY-MM-DD" });
    }
    const data = await schedulePickup(order.shiprocket.shipmentId, pickupDate);
    order.shiprocket.syncStatus = "pickup_scheduled";
    order.shiprocket.lastError = null;
    order.shiprocket.lastSyncedAt = new Date();
    await order.save();

    return res.status(200).json({ success: true, message: "Pickup scheduled", order, data });
  } catch (error) {
    return errorResponse(res, error);
  }
};

export const GenerateLabel = async (req, res) => {
  try {
    await ensureShiprocketEnabled();

    const order = await OrderModel.findById(req.params.orderId);
    if (!order) return res.status(404).json({ success: false, message: "Order not found" });
    ensureFulfillable(order, "have a shipping label generated");
    if (!order.shiprocket?.shipmentId || !order.shiprocket?.awbCode) {
      return res.status(409).json({ success: false, message: "Assign an AWB before generating a label" });
    }

    const data = await generateLabel(order.shiprocket.shipmentId);
    order.shiprocket.labelUrl = data.label_url || order.shiprocket.labelUrl;
    order.shiprocket.lastSyncedAt = new Date();
    await order.save();
    return res.status(200).json({ success: true, labelUrl: order.shiprocket.labelUrl, data });
  } catch (error) {
    return errorResponse(res, error);
  }
};

export const GenerateManifest = async (req, res) => {
  try {
    await ensureShiprocketEnabled();

    const order = await OrderModel.findById(req.params.orderId);
    if (!order) return res.status(404).json({ success: false, message: "Order not found" });
    ensureFulfillable(order, "have a manifest generated");
    // Same precondition as the label: a manifest lists the AWBs being handed over, so
    // there is nothing to hand over before one has been assigned.
    if (!order.shiprocket?.shipmentId || !order.shiprocket?.awbCode) {
      return res.status(409).json({
        success: false,
        message: "Assign an AWB before generating a manifest",
      });
    }

    const data = await generateManifest(order.shiprocket.shipmentId);
    order.shiprocket.manifestUrl =
      data?.manifest_url || data?.data?.manifest_url || order.shiprocket.manifestUrl;
    order.shiprocket.lastSyncedAt = new Date();
    await order.save();
    return res
      .status(200)
      .json({ success: true, manifestUrl: order.shiprocket.manifestUrl, data });
  } catch (error) {
    return errorResponse(res, error);
  }
};

export const GenerateInvoice = async (req, res) => {
  try {
    await ensureShiprocketEnabled();

    const order = await OrderModel.findById(req.params.orderId);
    if (!order) return res.status(404).json({ success: false, message: "Order not found" });
    ensureFulfillable(order, "have an invoice generated");
    if (!order.shiprocket?.orderId) {
      return res.status(409).json({
        success: false,
        message: "Create the Shiprocket order before generating its invoice",
      });
    }

    const data = await generateInvoice(order.shiprocket.orderId);
    if (!data.invoice_url) {
      throw new ShiprocketError(
        data?.not_created?.length
          ? `Shiprocket did not create the invoice: ${JSON.stringify(data.not_created)}`
          : "Shiprocket did not return an invoice URL",
        502,
        data,
      );
    }

    order.shiprocket.invoiceUrl = data.invoice_url;
    order.shiprocket.lastError = null;
    order.shiprocket.lastSyncedAt = new Date();
    await order.save();

    return res.status(200).json({
      success: true,
      message: "Invoice generated",
      invoiceUrl: order.shiprocket.invoiceUrl,
    });
  } catch (error) {
    return errorResponse(res, error);
  }
};

export const GetInvoice = async (req, res) => {
  try {
    const order = await OrderModel.findById(req.params.orderId);
    if (!order) return res.status(404).json({ success: false, message: "Order not found" });

    const isOwner = String(order.user) === req.user.id;
    // orders:manage for a non-owner: the invoice and the tracking feed both
    // expose the customer's address and phone to whoever asks.
    const isAdmin =
      !isOwner && (await adminHasPermission(req.user, ADMIN_PERMISSIONS.ORDERS_MANAGE));
    if (!isOwner && !isAdmin) {
      return res.status(403).json({ success: false, message: "Unauthorized" });
    }
    if (!order.shiprocket?.invoiceUrl) {
      return res.status(404).json({
        success: false,
        message: "Invoice has not been generated yet",
      });
    }

    return res.status(200).json({
      success: true,
      invoiceUrl: order.shiprocket.invoiceUrl,
    });
  } catch (error) {
    return errorResponse(res, error);
  }
};

// Tracking answers, briefly. The customer's order page polls every minute per open tab,
// and every poll used to be a live Shiprocket call; courier scans change on the scale of
// hours. Bounded so a long-running process cannot grow it without limit.
const TRACKING_CACHE_TTL_MS = 5 * 60 * 1000;
const TRACKING_CACHE_MAX = 500;
const trackingCache = new Map();

const readTrackingCache = (awbCode) => {
  const entry = trackingCache.get(awbCode);
  if (!entry) return null;
  if (Date.now() - entry.at > TRACKING_CACHE_TTL_MS) {
    trackingCache.delete(awbCode);
    return null;
  }
  return entry.data;
};

const writeTrackingCache = (awbCode, data) => {
  if (trackingCache.size >= TRACKING_CACHE_MAX) {
    // Maps iterate in insertion order, so the first key is the oldest entry.
    trackingCache.delete(trackingCache.keys().next().value);
  }
  trackingCache.set(awbCode, { at: Date.now(), data });
};

/** Test hook: drop cached tracking answers. */
export const clearTrackingCache = () => trackingCache.clear();

export const TrackShipment = async (req, res) => {
  try {
    await ensureShiprocketEnabled();

    const order = await OrderModel.findById(req.params.orderId);
    if (!order) return res.status(404).json({ success: false, message: "Order not found" });

    const isOwner = String(order.user) === req.user.id;
    // orders:manage for a non-owner: the invoice and the tracking feed both
    // expose the customer's address and phone to whoever asks.
    const isAdmin =
      !isOwner && (await adminHasPermission(req.user, ADMIN_PERMISSIONS.ORDERS_MANAGE));
    if (!isOwner && !isAdmin) {
      return res.status(403).json({ success: false, message: "Unauthorized" });
    }
    const awbCode = order.shiprocket?.awbCode;
    if (!awbCode) {
      return res.status(409).json({ success: false, message: "Tracking is not available yet" });
    }

    // A timeline, not the raw payload: Shiprocket's response carries the consignee's
    // name and address, which this endpoint used to hand to the page verbatim.
    let data = readTrackingCache(awbCode);
    if (!data) {
      data = toCustomerTracking(normalizeTracking(await trackAwb(awbCode), { awbCode }));
      writeTrackingCache(awbCode, data);
    }
    return res.status(200).json({ success: true, data });
  } catch (error) {
    return errorResponse(res, error);
  }
};

const safeTokenMatch = (received, expected) => {
  const left = Buffer.from(String(received || ""));
  const right = Buffer.from(String(expected || ""));
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
};

// The code table, the RTO-arrival test and the status mapper now live in
// shipment-status-map.js, shared by the webhook and the reconciler through the
// courier-event pipeline. Re-exported here so existing importers keep working.
export { SHIPMENT_EXCEPTIONS, isRtoReceived, mapOrderStatus } from "./shipment-status-map.js";

/**
 * Shiprocket's status webhook.
 *
 * Thin by design: authenticate, parse, hand the event to the courier-event pipeline
 * (courier-event.service.js), answer 200. Every rule about what a courier event may
 * do to an order — identity, transition legality, catch-up over a missed event,
 * ordering by courier time, exceptions, money side effects — lives in the pipeline,
 * so the reconciler that polls tracking applies exactly the same rules.
 *
 * Always 200 once authenticated. Shiprocket requires it, and a failure code would only
 * make them redeliver an event that a retry cannot fix; the reconciler re-reads courier
 * state for any order the webhook goes quiet on, which is the recovery path for an
 * event lost here.
 */
export const ShippingWebhook = async (req, res) => {
  // 200, not 4xx: a disabled webhook is a local choice, not a Shiprocket error. Reads
  // the capability so an admin who moved the store to manual fulfilment stops having
  // their orders advanced by courier events they are no longer managing through us.
  const capabilities = await getShippingCapabilities();
  if (!capabilities.deliveryWebhook) {
    return res.status(200).json({ success: true, message: "Shiprocket webhook disabled" });
  }

  const { webhookToken: expectedToken } = await getShiprocketCredentials();
  if (!expectedToken || !safeTokenMatch(req.get("x-api-key"), expectedToken)) {
    return res.status(401).json({ success: false, message: "Invalid webhook token" });
  }

  try {
    const event = courierEventFromWebhook(req.body, extractCourierEventTime(req.body));
    const result = await applyCourierEvent(event, { source: "webhook" });
    if (result.scope === "ignored") {
      return res.status(200).json({ success: true, ignored: true, reason: result.reason });
    }
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    // Still 200 — Shiprocket expects it — but LOGGED, with the identifiers needed to
    // find the order, so a failed event is visible rather than silently dropped.
    logLifecycleError("shipping", "shiprocket_webhook_failed", error, {
      orderIdentifier: req.body?.order_id ?? null,
      srOrderId: req.body?.sr_order_id ?? null,
      awb: req.body?.awb ?? null,
    });
    return res.status(200).json({ success: true });
  }
};
