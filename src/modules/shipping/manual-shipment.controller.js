/**
 * Recording a parcel the seller shipped by hand.
 *
 * This file imports NOTHING from shiprocket.service.js, and that is structural
 * rather than incidental: the guarantee "recording a manual shipment makes zero
 * Shiprocket calls" is then provable by reading the imports instead of by auditing
 * every branch, and a regression test asserts it stays that way.
 *
 * It is also not a generic courier adapter. There is exactly one operation here —
 * write down who carried the parcel and under what number — because that is the
 * whole of what manual shipping needs. Shiprocket's own flows are untouched.
 */
import OrderModel from "../orders/Order.model.js";
import {
  canTransitionOrderStatus,
  isFulfillableStatus,
} from "../orders/order-status.rules.js";
import { EXCLUDE_AWAITING_PAYMENT, isAwaitingPayment } from "../orders/order-visibility.js";
import { logLifecycleEvent } from "../../utils/lifecycle-logger.service.js";

/**
 * PUT /api/v1/order/:orderId/shipment/manual
 *
 * Creates or corrects the provider-neutral shipment record for an order shipped
 * outside any courier integration. Idempotent in effect: re-sending the same
 * carrier and number changes nothing, and correcting a mistyped number is the same
 * operation as recording it.
 */
export const RecordManualShipment = async (req, res) => {
  try {
    const carrierName = String(req.body?.carrierName || "").trim();
    const trackingNumber = String(req.body?.trackingNumber || "").trim();

    // The route validator already enforces both, and rejects any provider other
    // than MANUAL. Repeated here because the controller is also reachable directly
    // from tests, and a shipment record missing either half is useless.
    if (!carrierName || !trackingNumber) {
      return res.status(400).json({
        success: false,
        message: "Both a carrier name and a tracking number are required",
        code: "MANUAL_SHIPMENT_INCOMPLETE",
      });
    }
    const provider = req.body?.provider ?? "MANUAL";
    if (provider !== "MANUAL") {
      return res.status(400).json({
        success: false,
        message:
          "Only MANUAL shipments can be recorded here. A Shiprocket shipment is created through Shiprocket, which issues its own order, shipment and AWB identifiers.",
        code: "PROVIDER_NOT_MANUAL",
      });
    }

    const order = await OrderModel.findById(req.params.orderId);
    if (!order) {
      return res.status(404).json({ success: false, message: "Order not found" });
    }

    // The same rule the Shiprocket fulfilment endpoints use, for the same reason:
    // a cancelled order may already have been refunded, and an order coming back
    // from a failed delivery must not be recorded as freshly dispatched. Reused
    // rather than restated so there is one definition of "may still ship".
    if (!isFulfillableStatus(order.orderStatus)) {
      return res.status(409).json({
        success: false,
        message: `An order at "${order.orderStatus}" cannot be recorded as shipped`,
        code: "ORDER_NOT_FULFILLABLE",
        currentStatus: order.orderStatus,
      });
    }

    // A prepaid checkout whose payment was never captured is not an order yet, and
    // writing a carrier and tracking number onto one records goods as handed to a
    // courier for an order nobody paid for. The transition gate below would not
    // stop it — Pending cannot advance to Shipped, so the call would silently land
    // as a "correction" and stamp the shipment record anyway. Refused outright,
    // and asserted again in the write filter so a status read a moment ago cannot
    // be relied on.
    if (isAwaitingPayment(order)) {
      return res.status(409).json({
        success: false,
        message:
          "This prepaid order has not been paid for yet, so it cannot be recorded as shipped.",
        code: "PAYMENT_NOT_CAPTURED",
        currentStatus: order.orderStatus,
      });
    }

    // A live Shiprocket shipment is not something this endpoint may relabel. The
    // courier identifiers behind it — orderId, shipmentId, and whatever the webhook
    // resolves against — remain real, so calling the parcel MANUAL would describe
    // an integration that is still running. Correcting a Shiprocket AWB is
    // AssignAwb's job, not this one.
    if (order.shiprocket?.orderId) {
      return res.status(409).json({
        success: false,
        message:
          "This order already has a Shiprocket shipment. Its courier details come from Shiprocket.",
        code: "SHIPROCKET_SHIPMENT_EXISTS",
        shiprocketOrderId: order.shiprocket.orderId,
      });
    }

    // Recording a dispatch means the parcel has gone out, so the order moves with
    // it — through the EXISTING transition gate, never around it. Leaving the order
    // at "Confirmed" while its shipment record says "Shipped" would be two answers
    // to one question, which is the failure this phase exists to avoid.
    //
    // When the move is not legal the order is simply left alone: an order already
    // at "Out For Delivery" or "Delivered" is further along than dispatch, and this
    // call is then a correction to the tracking number rather than a dispatch.
    // The `orderStatus !== "Shipped"` half is load-bearing, not defensive:
    // canTransitionOrderStatus returns ok for from === to, so correcting a tracking
    // number on an already-shipped order would otherwise count as a fresh move and
    // push a second identical entry into statusHistory every time. UpdateOrderStatus
    // handles the same case with its own "status unchanged" branch.
    const advance =
      order.orderStatus !== "Shipped" && canTransitionOrderStatus(order.orderStatus, "Shipped").ok;
    const shipmentStatus = advance ? "Shipped" : order.orderStatus;

    const update = {
      "shipment.provider": "MANUAL",
      "shipment.carrierName": carrierName,
      "shipment.trackingNumber": trackingNumber,
      "shipment.status": shipmentStatus,
      "shipment.updatedAt": new Date(),
      "shipment.updatedBy": req.user?.id || null,
    };
    if (advance) update.orderStatus = "Shipped";

    // The status we validated against goes in the FILTER when we are advancing:
    // two admins recording a dispatch at once would otherwise both push a history
    // entry for the same move. Nothing here moves money or stock, so a lost race
    // just asks the caller to look again.
    const filter = advance
      ? { _id: order._id, orderStatus: order.orderStatus, ...EXCLUDE_AWAITING_PAYMENT }
      : { _id: order._id, ...EXCLUDE_AWAITING_PAYMENT };

    const updated = await OrderModel.findOneAndUpdate(
      filter,
      advance
        ? {
            $set: update,
            $push: {
              statusHistory: {
                from: order.orderStatus,
                to: "Shipped",
                changedBy: req.user?.id || null,
                source: "manual_shipment",
                changedAt: new Date(),
              },
            },
          }
        : { $set: update },
      { returnDocument: "after" },
    );

    if (!updated) {
      return res.status(409).json({
        success: false,
        message: "This order changed while the shipment was being recorded. Reload and try again.",
        code: "ORDER_CHANGED",
      });
    }

    logLifecycleEvent("shipping", "manual_shipment_recorded", {
      orderId: String(updated._id),
      carrierName,
      trackingNumber,
      orderStatus: updated.orderStatus,
      advanced: advance,
      recordedBy: req.user?.id || null,
    });

    return res.status(200).json({
      success: true,
      message: advance
        ? "Manual shipment recorded and the order marked shipped"
        : "Manual shipment details updated",
      order: updated,
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};
