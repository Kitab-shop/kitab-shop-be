import express from "express";
import {
  AddOrderNote,
  AdminCancelOrder,
  CancelOrder,
  GetAllOrders,
  GetMyOrders,
  GetSingleOrder,
  PartialCancelOrder,
  ReconcileOrderRefund,
  RetryShipmentCancellation,
  PlaceOrder,
  PreviewOrderPricing,
  RecordRtoDisposition,
  UpdateOrderStatus,
} from "./order.controller.js";
import {
  AssignAwb,
  CheckServiceability,
  CreateShipment,
  GenerateInvoice,
  GenerateLabel,
  GenerateManifest,
  GetCourierOptions,
  ResolveNdr,
  GetInvoice,
  SchedulePickup,
  ShippingWebhook,
  TrackShipment,
} from "../shipping/shipping.controller.js";
import { RecordManualShipment } from "../shipping/manual-shipment.controller.js";
import { SendCodOtp, VerifyCodOtp } from "./cod-verification.controller.js";
import { TokenVerify } from "../../middleware/auth.middleware.js";
import { adminOrderActionRateLimit, orderActionRateLimit, refundRateLimit } from "../../middleware/rate-limit.middleware.js";
import { requirePermission } from "../../middleware/require-permission.middleware.js";
import { validate } from "../../middleware/validate.middleware.js";
import {
  addOrderNoteSchema,
  orderIdParamSchema,
  orderPricingPreviewSchema,
  partialCancelSchema,
  placeOrderSchema,
  manualShipmentSchema,
  updateOrderStatusSchema,
} from "./order.schema.js";
import { ADMIN_PERMISSIONS } from "../../config/admin-permissions.config.js";

const routes = express.Router();

// Every route below used to be gated by "is any admin role" only, which let
// roles with no orders:manage permission at all (e.g. themeEditor) view every
// customer's orders/PII and mutate order/shipment state via a direct API
// call — the admin UI hid the links, but the API never checked the permission.
const canManageOrders = requirePermission(ADMIN_PERMISSIONS.ORDERS_MANAGE);

// Login required — no guest checkout, so every order is traceable to a
// real account.
routes.post("/pricing-preview", TokenVerify, validate(orderPricingPreviewSchema), PreviewOrderPricing);
routes.post("/create", TokenVerify, validate(placeOrderSchema), PlaceOrder);
routes.post("/place-order", TokenVerify, validate(placeOrderSchema), PlaceOrder);
routes.post("/shipping/webhook", ShippingWebhook);
routes.get("/shipping/serviceability", TokenVerify, CheckServiceability);
routes.post("/cod/send-otp", TokenVerify, SendCodOtp);
routes.post("/cod/verify-otp", TokenVerify, VerifyCodOtp);
routes.get("/my-orders", TokenVerify, GetMyOrders);
routes.get("/all", TokenVerify, canManageOrders, GetAllOrders);
routes.post("/:orderId/shipment", TokenVerify, canManageOrders, CreateShipment);
routes.get("/:orderId/shipment/couriers", TokenVerify, canManageOrders, GetCourierOptions);
routes.post("/:orderId/shipment/awb", TokenVerify, canManageOrders, AssignAwb);
// PUT, not POST: recording a hand-shipped parcel is create-or-correct, and sending
// the same carrier and number twice must be a no-op rather than a second shipment.
// Same permission as every other shipment action — orders:manage.
routes.put(
  "/:orderId/shipment/manual",
  TokenVerify,
  canManageOrders,
  validate(manualShipmentSchema),
  RecordManualShipment,
);
routes.post("/:orderId/shipment/pickup", TokenVerify, canManageOrders, SchedulePickup);
routes.post("/:orderId/shipment/label", TokenVerify, canManageOrders, GenerateLabel);
routes.post("/:orderId/shipment/manifest", TokenVerify, canManageOrders, GenerateManifest);
routes.post("/:orderId/shipment/ndr", TokenVerify, canManageOrders, ResolveNdr);
routes.post("/:orderId/shipment/invoice", TokenVerify, canManageOrders, GenerateInvoice);
routes.get("/:orderId/shipment/invoice", TokenVerify, GetInvoice);
routes.get("/:orderId/shipment/tracking", TokenVerify, TrackShipment);
routes.get("/:orderId", TokenVerify, validate(orderIdParamSchema), GetSingleOrder);
routes.patch("/:orderId/status", TokenVerify, canManageOrders, validate(updateOrderStatusSchema), UpdateOrderStatus);
routes.post("/:orderId/notes", TokenVerify, canManageOrders, validate(addOrderNoteSchema), AddOrderNote);
// RTO inspection: the courier feed says a parcel arrived, but only a person
// opening it can say whether the contents are sellable.
routes.patch(
  "/:orderId/rto-disposition",
  TokenVerify,
  canManageOrders,
  validate(orderIdParamSchema),
  RecordRtoDisposition,
);
routes.patch("/:orderId/partial-cancel", TokenVerify, canManageOrders, validate(partialCancelSchema), PartialCancelOrder);
// Recovery for a refund whose gateway response was lost. Rate-limited like the
// refund endpoint because it can end in a real gateway call — though only after
// Razorpay has confirmed no earlier refund exists.
routes.post("/:orderId/refunds/:refundId/reconcile", refundRateLimit, TokenVerify, canManageOrders, ReconcileOrderRefund);
// Recovery for a shipment left awaiting cancellation at the courier (Shiprocket
// timed out, was unreachable, or the process died after the local commit). Only
// ever cancels, and only for an order already cancelled locally.
routes.post("/:orderId/shipment/cancel", TokenVerify, canManageOrders, RetryShipmentCancellation);
routes.patch("/:orderId/cancel", orderActionRateLimit, TokenVerify, validate(orderIdParamSchema), CancelOrder);
// Full cancellation on the customer's behalf. Skips the owner and window
// checks (that's the point — past-window cancellations hand off to support),
// keeps the Pending/Confirmed gate, and shares CancelOrder's entire core.
routes.patch("/:orderId/admin-cancel", adminOrderActionRateLimit, TokenVerify, canManageOrders, validate(orderIdParamSchema), AdminCancelOrder);

export default routes;
