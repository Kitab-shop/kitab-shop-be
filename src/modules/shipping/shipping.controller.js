import crypto from "node:crypto";
import mongoose from "mongoose";
import OrderModel from "../orders/Order.model.js";
import ReturnModel from "../returns/return.model.js";
import {
  logLifecycleError,
  logLifecycleEvent,
} from "../../utils/lifecycle-logger.service.js";
import { notifyShipmentUpdated } from "../notifications/notification.service.js";
import {
  ShiprocketError,
  actOnNdr,
  assignAwb,
  checkServiceability,
  computeOrderPackage,
  createShiprocketOrder,
  generateInvoice,
  generateLabel,
  generateManifest,
  getShippingCapabilities,
  getShiprocketCredentials,
  resolvePackage,
  schedulePickup,
  trackAwb,
} from "./shiprocket.service.js";
import { ADMIN_PERMISSIONS } from "../../config/admin-permissions.config.js";
import { adminHasPermission } from "../../config/admin-access.service.js";
import {
  canTransitionOrderStatus,
  isFulfillableStatus,
} from "../orders/order-status.rules.js";
import {
  MONEY_COLLECTED_PAYMENT_STATUSES,
  recordRefundObligation,
  sumRefunded,
} from "../payments/return-refund.service.js";

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

const readAwbData = (response) => response?.response?.data || response?.data || response || {};

/**
 * Copies the provider-neutral facts out of a Shiprocket result.
 *
 * Shiprocket remains the source of truth for its own shipments — this writes a
 * mirror, never the other way round, and touches no `shiprocket.*` field. Its only
 * job is that a customer looking at a Shiprocket-carried parcel and a customer
 * looking at a hand-carried one read the same two fields.
 *
 * `status` mirrors the ORDER's status rather than Shiprocket's own vocabulary,
 * because that is the one status machine this system has; `mapOrderStatus` is what
 * normalises courier events into it, and it already exists.
 *
 * Blank values are skipped rather than written: Shiprocket sends partial payloads,
 * and a status-only event must not blank a courier name established earlier — the
 * same trap the webhook's conditional $set already avoids for `shiprocket.*`.
 */
const syncShipmentMirror = (order, { provider, carrierName, trackingNumber }) => {
  order.shipment.provider = provider;
  if (carrierName) order.shipment.carrierName = carrierName;
  if (trackingNumber) order.shipment.trackingNumber = trackingNumber;
  order.shipment.status = order.orderStatus;
  order.shipment.updatedAt = new Date();
};

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

    const {
      data,
      packageDetails,
      shiprocketOrderId,
      shipmentId,
    } = await createShiprocketOrder(order, req.body?.package);
    order.shiprocket = {
      ...order.shiprocket?.toObject?.(),
      orderId: shiprocketOrderId,
      shipmentId,
      status: data.status || "NEW",
      statusCode: Number(data.status_code) || null,
      awbCode: data.awb_code || null,
      courierId: Number(data.courier_company_id) || null,
      courierName: data.courier_name || null,
      syncStatus: data.awb_code ? "awb_assigned" : "created",
      package: packageDetails,
      lastError: null,
      lastSyncedAt: new Date(),
    };
    // Mirror the provider-neutral facts. Additive: nothing above changes, and the
    // AWB is usually still absent at creation — AssignAwb fills it in.
    syncShipmentMirror(order, {
      provider: "SHIPROCKET",
      carrierName: order.shiprocket.courierName,
      trackingNumber: order.shiprocket.awbCode,
    });
    await order.save();

    return res.status(201).json({
      success: true,
      message: "Order created in Shiprocket",
      order,
    });
  } catch (error) {
    if (req.params.orderId) {
      await OrderModel.findByIdAndUpdate(req.params.orderId, {
        "shiprocket.syncStatus": "failed",
        "shiprocket.lastError": error.message,
        "shiprocket.lastSyncedAt": new Date(),
      }).catch(() => {});
    }
    return errorResponse(res, error);
  }
};

export const CheckServiceability = async (req, res) => {
  try {
    await ensureShiprocketEnabled();

    const deliveryPostcode = String(req.query.deliveryPostcode || "").trim();
    if (!/^\d{6}$/.test(deliveryPostcode)) {
      return res.status(400).json({ success: false, message: "A valid deliveryPostcode is required" });
    }

    const packageDetails = await resolvePackage(req.query);
    const data = await checkServiceability({
      ...packageDetails,
      deliveryPostcode,
      pickupPostcode: req.query.pickupPostcode,
      cod: ["1", "true", "cod"].includes(String(req.query.cod).toLowerCase()),
      declaredValue: req.query.declaredValue,
      mode: req.query.mode,
    });
    return res.status(200).json({ success: true, data });
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
    if (!order.shiprocket?.shipmentId) {
      return res.status(409).json({ success: false, message: "Create the Shiprocket order first" });
    }

    // Reassignment is the same call, but it must be held to a stricter standard than a
    // first assignment: the order already HAS a working AWB, so a response that does not
    // carry a new one must not be reported as success. The `||` fallbacks below are
    // correct for a first assignment (nothing to lose) and were quietly wrong for a
    // reassign — they left the old AWB in place while answering "AWB assigned", so the
    // admin believed the courier had changed and the parcel was still with the old one.
    const previousAwb = String(order.shiprocket?.awbCode || "").trim();
    const isReassignment = Boolean(previousAwb);

    const response = await assignAwb(order.shiprocket.shipmentId, req.body?.courierId);
    const data = readAwbData(response);
    const newAwb = String(data.awb_code || "").trim();

    if (isReassignment && (!newAwb || newAwb === previousAwb)) {
      logLifecycleEvent("shipping", "shiprocket_awb_reassign_no_change", {
        orderId: order._id,
        previousAwb,
        requestedCourierId: req.body?.courierId ?? null,
      });
      return res.status(409).json({
        success: false,
        message:
          "Shiprocket did not issue a new AWB, so the courier has not changed. The parcel is still with the original courier.",
      });
    }

    order.shiprocket.awbCode = newAwb || order.shiprocket.awbCode;
    order.shiprocket.courierId =
      Number(data.courier_company_id || data.courier_id) || order.shiprocket.courierId;
    order.shiprocket.courierName = data.courier_name || order.shiprocket.courierName;
    order.shiprocket.syncStatus = "awb_assigned";
    order.shiprocket.lastError = null;
    order.shiprocket.lastSyncedAt = new Date();
    // The point at which a Shiprocket parcel actually acquires a tracking number,
    // so it is the point the provider-neutral record becomes meaningful.
    syncShipmentMirror(order, {
      provider: "SHIPROCKET",
      carrierName: order.shiprocket.courierName,
      trackingNumber: order.shiprocket.awbCode,
    });

    try {
      await order.save();
    } catch (error) {
      // E11000 means this AWB already belongs to a DIFFERENT order — the unique partial
      // index from H2-01 refusing an identity collision. Without this it surfaced as a
      // raw 500 and the admin had no idea the assignment had been rejected rather than
      // failed. Refuse loudly; the order keeps its previous AWB untouched.
      if (error?.code === 11000) {
        logLifecycleError("shipping", "shiprocket_awb_identity_conflict", error, {
          orderId: order._id,
          previousAwb,
          conflictingAwb: newAwb,
        });
        return res.status(409).json({
          success: false,
          message: `AWB ${newAwb} is already recorded against another order. This order still has its previous AWB.`,
        });
      }
      throw error;
    }

    if (isReassignment) {
      logLifecycleEvent("shipping", "shiprocket_awb_reassigned", {
        orderId: order._id,
        previousAwb,
        newAwb: order.shiprocket.awbCode,
        courierName: order.shiprocket.courierName,
      });
    }

    return res.status(200).json({
      success: true,
      message: isReassignment ? "Courier reassigned" : "AWB assigned",
      previousAwb: isReassignment ? previousAwb : null,
      order,
      data: response,
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
    if (!order.shiprocket?.awbCode) {
      return res.status(409).json({ success: false, message: "Tracking is not available yet" });
    }

    const data = await trackAwb(order.shiprocket.awbCode);
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

/**
 * Shiprocket's numeric shipment status codes, grouped by what each family means
 * for an order here.
 *
 * Every courier event carries `status_code`. The human string beside it is
 * written by the courier and varies, so matching on text alone loses events:
 * Shiprocket calls a failed delivery "UNDELIVERED" (code 21), which contains
 * neither "ndr" nor "non-delivery". No event ever produced the "NDR" status, and
 * ResolveNdr refuses any order not already at NDR — so the re-attempt and
 * send-it-back actions were unreachable from the automatic path entirely.
 *
 * Codes are therefore matched first, with the text kept as a fallback for
 * couriers whose numeric code differs from the published list.
 */
const RTO_RECEIVED_CODES = [10]; // RTO DELIVERED — the parcel is physically back
const RTO_CODES = [9, 14, 40, 41, 46]; // initiated, acknowledged, RTO NDR / OFD / in transit
const NDR_CODES = [21]; // UNDELIVERED — a delivery attempt failed
const DELIVERED_CODES = [7];
const OUT_FOR_DELIVERY_CODES = [17];
const SHIPPED_CODES = [6, 18, 19, 27, 38, 42];

/**
 * Codes that mean the parcel's journey went wrong in a way no status of ours
 * expresses.
 *
 * Deliberately NOT mapped to an order status. "Cancelled" carries restock and
 * refund compensation that a bare status write does not perform — which is why
 * ORDER_STATUS_TRANSITIONS documents the webhook as never mapping to it — and
 * there is no status at all for goods lost or destroyed in transit. What was
 * wrong before was the SILENCE: these fell through to null, so the order simply
 * stopped moving and nothing said why. Each one is now recorded against the
 * order it belongs to, for an operator to act on.
 */
export const SHIPMENT_EXCEPTIONS = {
  8: "cancelled at Shiprocket",
  12: "lost in transit",
  23: "partially delivered",
  24: "destroyed",
  25: "damaged",
  39: "misrouted",
  45: "cancelled before dispatch",
  76: "untraceable",
};

/**
 * True only once the RTO parcel is physically back with the seller.
 *
 * mapOrderStatus collapses the whole RTO sequence ("RTO Initiated", "RTO In
 * Transit", "RTO Delivered") into the single order status "RTO", which is right
 * for what the customer sees but useless for inventory: restocking on
 * "RTO Initiated" would put units on sale while they are still on a truck.
 *
 * The code checked here used to be 43 — which is SELF FULFILLED in Shiprocket's
 * list, not RTO Delivered (that is 10). One wrong number caused two failures in
 * opposite directions: a genuine RTO arrival was recognised only when the courier
 * happened to send readable text, and a self-fulfilled shipment, had one ever
 * reported, was treated as a returned parcel — recording a refund liability
 * against an order that had actually been delivered and paid for.
 */
export const isRtoReceived = (statusCode, currentStatus) =>
  RTO_RECEIVED_CODES.includes(statusCode) ||
  /rto[\s_-]*(delivered|received)/i.test(currentStatus || "");

/**
 * Records what a returned-to-origin parcel means for the customer's money.
 *
 * The whole point of branching here explicitly: an RTO is NOT a customer return.
 * The customer did not ask for anything and, on COD, never paid — so issuing them
 * a refund would be handing money to someone who owes it. On a prepaid order the
 * opposite is true: they paid for goods they never received, so a refund is owed
 * the moment the parcel is confirmed back with us.
 *
 * Recorded as `owed`, not pushed to the gateway, because this runs unattended from
 * a courier feed. What it guarantees is that the liability is never invisible.
 */
const recordRtoRefundObligation = async (order) => {
  // COD: nothing was collected, so nothing is owed. Explicit and final.
  //
  // Reads the shared set rather than restating it. The hand-written version here was
  // {Paid, Partially Refunded}, two states short of the invariant recordRefundObligation
  // enforces — so a prepaid order whose earlier partial refund had not settled yet,
  // which leaves it at "Refund Pending", was told "no payment was ever collected" and
  // its RTO liability was never recorded. The customer had paid in full, received
  // nothing, and only the earlier partial amount was owed back.
  const moneyCollected = MONEY_COLLECTED_PAYMENT_STATUSES.includes(order.paymentStatus);
  if (!moneyCollected) return { owed: 0, reason: "no payment was ever collected" };

  const outstanding =
    Math.round((Number(order.totalAmount) - sumRefunded(order)) * 100) / 100;
  if (outstanding <= 0) return { owed: 0, reason: "already fully refunded" };

  const fresh = await OrderModel.findById(order._id);
  if (!fresh) return { owed: 0, reason: "order no longer exists" };

  const { refund, created } = await recordRefundObligation({
    order: fresh,
    amount: outstanding,
    reason: "Parcel returned to origin undelivered",
    // Stable key = idempotency. A retried courier event finds this row and stops.
    dedupeKey: `RTO ${fresh._id}`,
    confirmationMethod: "gateway",
  });

  return { owed: created ? refund?.amount || 0 : 0, alreadyRecorded: !created };
};

export const mapOrderStatus = (statusCode, currentStatus) => {
  const text = currentStatus || "";
  // Checked BEFORE the generic RTO test, which would otherwise swallow it — the
  // arrival event's text also contains "RTO".
  if (isRtoReceived(statusCode, text)) return "RTO Received";
  if (RTO_CODES.includes(statusCode) || /rto|return to origin/i.test(text)) return "RTO";
  // "undelivered" is Shiprocket's own wording for a failed attempt and has to be
  // matched explicitly: it contains neither "ndr" nor "non-delivery".
  if (NDR_CODES.includes(statusCode) || /ndr|non[- ]delivery|undelivered/i.test(text)) {
    return "NDR";
  }
  if (DELIVERED_CODES.includes(statusCode)) return "Delivered";
  if (OUT_FOR_DELIVERY_CODES.includes(statusCode)) return "Out For Delivery";
  if (SHIPPED_CODES.includes(statusCode)) return "Shipped";
  if (/packed|ready to ship/i.test(text)) return "Packed";
  // Includes every SHIPMENT_EXCEPTIONS code. Returning null is the point: the
  // caller logs them instead of writing a status the compensation logic never ran.
  return null;
};

/**
 * Resolves a courier event to EXACTLY ONE order, or refuses.
 *
 * This replaced a first-match cascade:
 *
 *   sourceOrderId ? {_id} : srOrderId ? {"shiprocket.orderId"} : awb ? {"shiprocket.awbCode"} : null
 *
 * with `findOne`/`findOneAndUpdate` on the result. Two things were wrong with it,
 * and both end in money:
 *
 *   1. `shiprocket.orderId` and `shiprocket.awbCode` carried plain, NON-UNIQUE
 *      indexes, so the query could legitimately match several orders and the
 *      driver returned an arbitrary one. A `Delivered` event (status_id 7) applied
 *      to the wrong order stamps `deliveredAt` — opening a return window on
 *      something never delivered — and flips a COD order Pending → Paid, booking
 *      revenue for cash nobody collected.
 *   2. The handler then WROTE the payload's identifiers onto whatever order it had
 *      resolved. Resolve by AWB while the event names a different `sr_order_id`
 *      and it overwrote that order's identity, manufacturing the duplicate that
 *      makes the next event ambiguous too.
 *
 * The rule now: every identifier the event actually carries must agree, and must
 * name exactly one order.
 *
 *   - an identifier matching MORE than one order  → ambiguous, refuse
 *   - identifiers naming DIFFERENT orders         → conflict, refuse
 *   - an identifier matching NOTHING is tolerated, because it is normal: the
 *     first AWB event arrives while our stored `awbCode` is still null.
 *
 * Unique partial indexes on both fields now make ambiguity structurally
 * impossible, so this check is defence in depth — for rows written before the
 * indexes existed, and for the window while they build.
 *
 * @returns {{orderId?: mongoose.Types.ObjectId, reason?: string, identifiers: object}}
 */
const resolveWebhookOrder = async ({ sourceOrderId, shiprocketOrderId, awbCode }) => {
  const identifiers = { sourceOrderId, shiprocketOrderId, awbCode };
  const lookups = [];

  // Our own _id, when the payload echoes back something that could be one. An
  // unparseable value is NOT treated as "no identifier": it means the event names
  // an order we cannot interpret, so it must not fall through to a fuzzier match.
  if (sourceOrderId) {
    if (!mongoose.Types.ObjectId.isValid(sourceOrderId)) {
      return { reason: "unparseable_order_id", identifiers };
    }
    lookups.push({ field: "order_id", filter: { _id: sourceOrderId } });
  }
  if (shiprocketOrderId) {
    lookups.push({ field: "sr_order_id", filter: { "shiprocket.orderId": shiprocketOrderId } });
  }
  if (awbCode) {
    lookups.push({ field: "awb", filter: { "shiprocket.awbCode": awbCode } });
  }

  if (lookups.length === 0) return { reason: "no_identifiers", identifiers };

  const matchedIds = new Set();
  for (const lookup of lookups) {
    // find(), not findOne(): the whole point is to SEE a second match rather than
    // silently take the first. Limited to 2 — one is enough to prove ambiguity.
    const matches = await OrderModel.find(lookup.filter).select("_id").limit(2).lean();
    if (matches.length > 1) {
      return { reason: `ambiguous_${lookup.field}`, identifiers };
    }
    if (matches.length === 1) matchedIds.add(String(matches[0]._id));
  }

  if (matchedIds.size === 0) return { reason: "no_match", identifiers };
  if (matchedIds.size > 1) return { reason: "conflicting_identifiers", identifiers };

  return { orderId: [...matchedIds][0], identifiers };
};

/**
 * Resolves a courier event to one leg of one RETURN, or refuses.
 *
 * Reverse shipments were create-only: `resolveWebhookOrder` knows about orders alone, so a
 * return-pickup or replacement AWB matched nothing and the event was dropped as
 * `no_match`. You could book a collection and never learn it happened.
 *
 * Resolved by AWB ONLY, deliberately. One return can have a collection travelling in and a
 * replacement travelling out simultaneously, so its `_id` identifies the return but not
 * which parcel an event is about — and guessing between them is exactly what the H2-01
 * resolver exists to refuse. The AWB is unique per leg (enforced by
 * `return_pickupAwb_unique` / `return_replacementAwb_unique`), so it is the only
 * identifier that answers the question being asked.
 *
 * @returns {Promise<{returnId?: string, leg?: "pickup"|"replacement", reason?: string}>}
 */
const resolveWebhookReturn = async (awbCode) => {
  if (!awbCode) return { reason: "no_awb" };

  const [pickupMatches, replacementMatches] = await Promise.all([
    // find(), not findOne(): seeing a second match is the point. The unique indexes make
    // that impossible for new data, but an older document written before them could still
    // collide, and taking an arbitrary one is how a courier event lands on the wrong return.
    ReturnModel.find({ pickupAwb: awbCode }).select("_id").limit(2).lean(),
    ReturnModel.find({ replacementAwb: awbCode }).select("_id").limit(2).lean(),
  ]);

  if (pickupMatches.length > 1) return { reason: "ambiguous_return_pickup_awb" };
  if (replacementMatches.length > 1) return { reason: "ambiguous_return_replacement_awb" };
  // The same AWB on both legs cannot be disambiguated by anything in the payload.
  if (pickupMatches.length === 1 && replacementMatches.length === 1) {
    return { reason: "awb_on_both_return_legs" };
  }

  if (pickupMatches.length === 1) return { returnId: String(pickupMatches[0]._id), leg: "pickup" };
  if (replacementMatches.length === 1) {
    return { returnId: String(replacementMatches[0]._id), leg: "replacement" };
  }
  return { reason: "no_return_match" };
};

/**
 * Records where a return's parcel has got to. Deliberately does NOT change return status.
 *
 * A parcel arriving at the warehouse is not the same event as someone having opened and
 * inspected it, and `received` is the QC step that gates refunds and restocking. Letting a
 * courier event drive it would refund on the courier's word rather than on inspection. So
 * the courier's status is recorded, the operator still decides.
 *
 * The one exception is `replacementDeliveredAt`, a timestamp of fact — the customer has the
 * replacement. Even there the STATUS transition stays with the admin's
 * ConfirmReplacementDelivery, so nothing is closed out on a courier event alone.
 */
const recordReturnCourierEvent = async ({ returnId, leg, currentStatus, mappedStatus, awbCode }) => {
  const now = new Date();
  const update =
    leg === "pickup"
      ? { pickupCourierStatus: currentStatus || mappedStatus || "", pickupCourierUpdatedAt: now }
      : { replacementCourierStatus: currentStatus || mappedStatus || "", replacementCourierUpdatedAt: now };

  // First delivery wins, matching the order path's guard: re-stamping on a replayed event
  // would move the replacement's own reference point.
  const claimed = await ReturnModel.findOneAndUpdate(
    leg === "replacement" && mappedStatus === "Delivered"
      ? { _id: returnId, replacementDeliveredAt: null }
      : { _id: returnId },
    leg === "replacement" && mappedStatus === "Delivered"
      ? { $set: { ...update, replacementDeliveredAt: now } }
      : { $set: update },
    { returnDocument: "after" },
  );

  // The stamp was already set by an earlier event; the status fields still deserve the
  // update, so apply them without the claim.
  if (!claimed) {
    await ReturnModel.updateOne({ _id: returnId }, { $set: update });
  }

  logLifecycleEvent("shipping", "return_courier_event_recorded", {
    returnId,
    leg,
    awbCode,
    courierStatus: currentStatus || mappedStatus || null,
    statusUnchanged: true,
  });
};

export const ShippingWebhook = async (req, res) => {
  // 200, not 4xx: a disabled webhook is a local choice, not a Shiprocket error, and a
  // failure code would just make them retry it forever. Reads the capability so an
  // admin who moved the store to manual fulfilment stops having their orders advanced
  // by courier events they are no longer managing through us.
  const capabilities = await getShippingCapabilities();
  if (!capabilities.deliveryWebhook) {
    return res.status(200).json({ success: true, message: "Shiprocket webhook disabled" });
  }

  const { webhookToken: expectedToken } = await getShiprocketCredentials();
  if (!expectedToken || !safeTokenMatch(req.get("x-api-key"), expectedToken)) {
    return res.status(401).json({ success: false, message: "Invalid webhook token" });
  }

  try {
    const sourceOrderId = String(req.body?.order_id || "").trim();
    const shiprocketOrderId = Number(req.body?.sr_order_id) || null;
    const awbCode = String(req.body?.awb || "").trim();
    const statusCode = Number(req.body?.shipment_status_id || req.body?.current_status_id) || null;
    const currentStatus = req.body?.shipment_status || req.body?.current_status || null;

    // ── IDENTITY, RESOLVED ONCE ──────────────────────────────────────────────
    // Everything below operates on `query = {_id}` only. Re-querying by
    // shiprocket.orderId/awbCode after this point would reintroduce the
    // arbitrary-match problem on the very write that changes order state.
    const resolution = await resolveWebhookOrder({
      sourceOrderId,
      shiprocketOrderId,
      awbCode,
    });

    // Before treating this as a miss, try the RETURN legs. A reverse pickup or a
    // replacement parcel is a real shipment with a real AWB, and it belongs to a return
    // rather than to an order — so it can never match above. Only attempted when no order
    // matched, so an order event can never be re-attributed to a return.
    if (!resolution.orderId) {
      const returnResolution = await resolveWebhookReturn(awbCode);
      if (returnResolution.returnId) {
        await recordReturnCourierEvent({
          returnId: returnResolution.returnId,
          leg: returnResolution.leg,
          currentStatus,
          mappedStatus: mapOrderStatus(statusCode, currentStatus),
          awbCode,
        });
        return res.status(200).json({
          success: true,
          scope: "return",
          leg: returnResolution.leg,
          // Said out loud: the return's own status is not advanced by courier events.
          statusUnchanged: true,
        });
      }
      // An ambiguity among returns is the same integrity problem as among orders, and
      // must be just as loud rather than folding into a routine miss.
      if (returnResolution.reason && returnResolution.reason.startsWith("ambiguous_")) {
        logLifecycleError(
          "shipping",
          "shiprocket_webhook_return_identity_unresolved",
          new Error(`Courier event could not be resolved to one return leg: ${returnResolution.reason}`),
          { reason: returnResolution.reason, awbCode, statusCode, currentStatus },
        );
        return res
          .status(200)
          .json({ success: true, ignored: true, reason: returnResolution.reason });
      }
      if (returnResolution.reason === "awb_on_both_return_legs") {
        logLifecycleError(
          "shipping",
          "shiprocket_webhook_return_identity_unresolved",
          new Error("One AWB is recorded on both the pickup and replacement legs of a return"),
          { awbCode, statusCode, currentStatus },
        );
        return res
          .status(200)
          .json({ success: true, ignored: true, reason: returnResolution.reason });
      }
    }

    if (!resolution.orderId) {
      // No order is touched. Logged loudly for the ambiguous and conflicting
      // cases, because those mean two orders share a courier identifier — a data
      // integrity problem an operator has to resolve, not a routine miss.
      const isIntegrityProblem =
        resolution.reason.startsWith("ambiguous_") ||
        resolution.reason === "conflicting_identifiers";
      const details = {
        reason: resolution.reason,
        ...resolution.identifiers,
        statusCode,
        currentStatus,
      };
      if (isIntegrityProblem) {
        logLifecycleError(
          "shipping",
          "shiprocket_webhook_identity_unresolved",
          new Error(`Courier event could not be resolved to one order: ${resolution.reason}`),
          details,
        );
      } else {
        logLifecycleEvent("shipping", "shiprocket_webhook_ignored", details);
      }
      // 200 per the existing contract with Shiprocket: retrying will not resolve
      // an ambiguity, and a 5xx would have them redeliver forever.
      return res.status(200).json({ success: true, ignored: true, reason: resolution.reason });
    }

    const query = { _id: resolution.orderId };

    // Only fields the payload actually carries are written. Shiprocket sends
    // partial bodies (a status-only event omits the AWB), and unconditionally
    // $set-ting them wrote null over the stored orderId and awbCode — which broke
    // tracking for the customer and made every later shipment call fail, because
    // those ids are what identify the shipment.
    const update = {
      "shiprocket.status": currentStatus,
      "shiprocket.statusCode": statusCode,
      "shiprocket.lastError": null,
      "shiprocket.lastSyncedAt": new Date(),
    };
    if (shiprocketOrderId) update["shiprocket.orderId"] = shiprocketOrderId;
    if (awbCode) update["shiprocket.awbCode"] = awbCode;
    if (req.body?.courier_name) update["shiprocket.courierName"] = req.body.courier_name;
    // Reasons are only meaningful on the event that reports them; a later status
    // event should not blank out why a delivery failed.
    const ndrReason = req.body?.ndr_reason || req.body?.reason || "";
    if (ndrReason) update["shiprocket.ndrReason"] = ndrReason;
    if (req.body?.rto_reason) update["shiprocket.rtoReason"] = req.body.rto_reason;
    // The status is only applied if it's a LEGAL move from where the order
    // actually is. Previously this blindly $set whatever the mapper produced,
    // so a replayed or out-of-order courier event could regress
    // Delivered → Shipped (locking the customer out of returns while their
    // window kept expiring) or resurrect Cancelled → Delivered (oversell +
    // phantom COD revenue on an order already restocked and refunded).
    const mappedStatus = mapOrderStatus(statusCode, currentStatus);
    const existing = await OrderModel.findOne(query).select(
      "orderStatus deliveredAt shipment.provider",
    );
    if (!existing) return res.status(200).json({ success: true });

    // An exception code changes no status (see SHIPMENT_EXCEPTIONS) but must not
    // pass unnoticed — a lost or destroyed parcel is exactly the event an operator
    // needs to see, and it is the one an order silently stalling looks like.
    const exceptionMeaning = SHIPMENT_EXCEPTIONS[statusCode];
    if (exceptionMeaning) {
      logLifecycleEvent("shipping", "shiprocket_shipment_exception", {
        orderId: String(resolution.orderId),
        orderStatus: existing.orderStatus,
        statusCode,
        currentStatus,
        meaning: exceptionMeaning,
        awbCode: awbCode || null,
      });
    }

    // ── PROVIDER-NEUTRAL MIRROR ─────────────────────────────────────────────
    // Skipped entirely for an order recorded as MANUAL. A courier feed must not
    // relabel a parcel the seller carried themselves: the resolver can reach an
    // order by our own `_id` from the payload's `order_id`, which is a path that
    // does not require the order to have any Shiprocket identity at all. Writing
    // `provider: SHIPROCKET` there would silently replace a hand-entered courier
    // and tracking number with a claim about an integration that never shipped it.
    //
    // Only the fields the event actually carries are mirrored, matching the
    // conditional $set above — a status-only event must not blank the courier name.
    if (existing.shipment?.provider !== "MANUAL") {
      update["shipment.provider"] = "SHIPROCKET";
      update["shipment.updatedAt"] = new Date();
      if (awbCode) update["shipment.trackingNumber"] = awbCode;
      if (req.body?.courier_name) update["shipment.carrierName"] = req.body.courier_name;
    }

    const transition = mappedStatus
      ? canTransitionOrderStatus(existing.orderStatus, mappedStatus)
      : { ok: false };
    const applyStatus = Boolean(mappedStatus) && transition.ok && existing.orderStatus !== mappedStatus;

    if (applyStatus) {
      update.orderStatus = mappedStatus;
      // Mirrors the order, and only when the order itself actually moved — the
      // shipment record must never claim a status the transition rules refused.
      if (existing.shipment?.provider !== "MANUAL") update["shipment.status"] = mappedStatus;
      update.$push = {
        statusHistory: {
          from: existing.orderStatus,
          to: mappedStatus,
          changedBy: null,
          source: "shiprocket_webhook",
          changedAt: new Date(),
        },
      };
      if (mappedStatus === "NDR") update["shiprocket.syncStatus"] = "ndr";
      if (mappedStatus === "RTO") update["shiprocket.syncStatus"] = "rto";
      // First Delivered wins. Re-stamping on every replay silently re-opened an
      // expired return window, so this now matches the admin path's guard.
      if (mappedStatus === "Delivered" && !existing.deliveredAt) {
        update.deliveredAt = new Date();
      }
    }

    const push = update.$push;
    delete update.$push;
    let order;
    try {
      order = await OrderModel.findOneAndUpdate(
        query,
        push ? { $set: update, $push: push } : { $set: update },
        { returnDocument: "after" },
      );
    } catch (error) {
      // E11000 here means the identifier this event carries already belongs to a
      // DIFFERENT order — the unique partial indexes rejecting an identity
      // collision. Refuse the event rather than corrupt either order.
      if (error?.code === 11000) {
        logLifecycleError("shipping", "shiprocket_webhook_identifier_conflict", error, {
          orderId: resolution.orderId,
          ...resolution.identifiers,
        });
        return res
          .status(200)
          .json({ success: true, ignored: true, reason: "identifier_belongs_to_another_order" });
      }
      throw error;
    }

    // Gated on applyStatus, not on mappedStatus: if the transition was rejected
    // (e.g. a stale Delivered event for an order the customer already
    // cancelled) the order did NOT become Delivered, so booking COD cash here
    // would be phantom revenue for money never collected.
    if (order && applyStatus && mappedStatus === "Delivered") {
      await OrderModel.updateOne(
        { _id: order._id, paymentMethod: "COD", paymentStatus: "Pending" },
        { $set: { paymentStatus: "Paid" } },
      );
    }

    // ── RTO ARRIVAL ─────────────────────────────────────────────────────────
    // The parcel is physically back. Two consequences, and they are deliberately
    // NOT the same thing:
    //
    //   Money — a prepaid customer is owed a refund and a COD customer is owed
    //           nothing, because they never paid. Recorded as an `owed` ledger
    //           entry rather than pushed to the gateway here: this is an unattended
    //           webhook, and an automatic irreversible refund triggered by a
    //           courier feed is not something to do without a human. The entry is
    //           what makes the liability visible and actionable.
    //
    //   Stock — deliberately NOT restocked here. The goods have not been inspected
    //           yet; a courier can damage a box in either direction. An operator
    //           records the disposition (see RecordRtoDisposition) and the restock
    //           happens then. This path used to restock every unit blind.
    //
    // Not gated on applyStatus: an order already at "RTO Received" from an earlier
    // delivery of this event produces no transition, and recordRefundObligation is
    // idempotent on its dedupe key, so retries record one liability.
    if (order && isRtoReceived(statusCode, currentStatus)) {
      await recordRtoRefundObligation(order).catch((error) => {
        console.error(`RTO refund obligation failed for ${order._id}:`, error?.message);
      });
    }

    // Likewise, don't tell the customer their parcel was delivered when we
    // refused to record that status.
    if (order && applyStatus) {
      await notifyShipmentUpdated({ orderId: order._id, status: mappedStatus });
    }
    return res.status(200).json({ success: true });
  } catch (error) {
    // Still 200 — Shiprocket expects it, and failed events can be reconciled
    // through live tracking. But it is now LOGGED: this used to be a bare
    // `catch {}` that swallowed everything, so a malformed identifier or a
    // transient database error vanished without trace and the shipment silently
    // stopped tracking.
    logLifecycleError("shipping", "shiprocket_webhook_failed", error, {
      orderIdentifier: req.body?.order_id ?? null,
      srOrderId: req.body?.sr_order_id ?? null,
      awb: req.body?.awb ?? null,
    });
    return res.status(200).json({ success: true });
  }
};
