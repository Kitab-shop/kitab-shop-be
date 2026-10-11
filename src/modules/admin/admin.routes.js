import express from "express";
import {
  BlockUser,
  BulkImportProducts,
  BulkUpdateProducts,
  ExportProducts,
  GetAdminPermissions,
  GetSystemHealth,
  GetAllUsers,
  GetDashboard,
  GetCodReconciliation,
  GetSalesReport,
  GetTodayUsers,
  UnBlockUser,
  UpdateUserPermissions,
} from "./admin.controller.js";
import { ExportAuditLogs, GetAuditLogs } from "../audit/audit.controller.js";
import {
  AdminCreateCoupon,
  AdminDeleteCoupon,
  AdminGetCoupons,
  AdminUpdateCoupon,
  AdminCouponUsageReport,
  ExportCouponUsageReport,
} from "../coupons/coupon.controller.js";
import { isAdmin } from "../../middleware/is-admin.middleware.js";
import { requirePermission } from "../../middleware/require-permission.middleware.js";
import { ADMIN_PERMISSIONS } from "../../config/admin-permissions.config.js";
import { GetLoginActivities } from "../login-activity/login-activity.controller.js";
import {
  AdminGetReturns,
  AdminUpdateReturnStatus,
  ConfirmReplacementDelivery,
  BookReplacementShipment,
  BookReturnPickup,
  DispatchReplacement,
  ReleaseReplacementBookingClaim,
  RecordReturnPickupAwb,
  RecordReplacementAwb,
  SyncReturnPickupAwb,
  SyncReplacementAwb,
  ReleaseReturnPickupClaim,
} from "../returns/return.controller.js";
import { AdminGetOwedRefunds, AdminSettleOwedRefundManually } from "../payments/owed-refund.controller.js";
import {
  GetShippingReconciliationStatus,
  RunShippingReconciliation,
} from "../shipping/shipping-ops.controller.js";
import { shippingReconcileRateLimit } from "../../middleware/rate-limit.middleware.js";
import { GetShippingExceptions } from "../shipping/shipping-exceptions.controller.js";
import { GetHomepageReviewOptions, UpdateHomepageSettings } from "../homepage/homepage.controller.js";
import {
  AdminCreateCmsBlock,
  AdminDeleteCmsBlock,
  AdminGetCmsBlocks,
  AdminUpdateCmsBlock,
} from "../cms/cms.controller.js";

const router = express.Router();

router.get("/dashboard", isAdmin, requirePermission(ADMIN_PERMISSIONS.DASHBOARD_READ), GetDashboard);
router.get("/permissions", isAdmin, GetAdminPermissions);
router.get("/system-health", isAdmin, requirePermission(ADMIN_PERMISSIONS.DASHBOARD_READ), GetSystemHealth);
router.patch("/users/:id/permissions", isAdmin, requirePermission(ADMIN_PERMISSIONS.USERS_MANAGE), UpdateUserPermissions);
router.get("/audit-logs", isAdmin, requirePermission(ADMIN_PERMISSIONS.AUDIT_READ), GetAuditLogs);
router.get("/audit-logs/export", isAdmin, requirePermission(ADMIN_PERMISSIONS.AUDIT_READ), ExportAuditLogs);
router.get("/login-activities", isAdmin, GetLoginActivities);
router.get("/returns", isAdmin, requirePermission(ADMIN_PERMISSIONS.RETURNS_MANAGE), AdminGetReturns);
// Read-only liability queue. orders:manage, matching the manual refund endpoint it
// hands the operator off to — seeing what is owed and paying it are the same job,
// and there is no separate refunds permission in this codebase.
router.get("/refunds/owed", isAdmin, requirePermission(ADMIN_PERMISSIONS.ORDERS_MANAGE), AdminGetOwedRefunds);
// Settles an owed refund that no gateway can pay (COD and other offline money).
// Gateway-payable rows are refused and routed to the Razorpay refund endpoint.
router.post("/refunds/:orderId/:refundId/settle-manual", isAdmin, requirePermission(ADMIN_PERMISSIONS.ORDERS_MANAGE), AdminSettleOwedRefundManually);
router.patch("/returns/:id/status", isAdmin, requirePermission(ADMIN_PERMISSIONS.RETURNS_MANAGE), AdminUpdateReturnStatus);
// Manual replacement fulfilment. Separate from the status endpoint because dispatch
// records the courier/AWB and takes the outbound unit out of stock — side effects a
// bare status change must not perform.
// Booking is separate from dispatching on purpose: it has an external side effect and no
// stock movement, so each is independently retryable.
router.post("/returns/:id/pickup/book", isAdmin, requirePermission(ADMIN_PERMISSIONS.RETURNS_MANAGE), BookReturnPickup);
router.post("/returns/:id/replacement/book", isAdmin, requirePermission(ADMIN_PERMISSIONS.RETURNS_MANAGE), BookReplacementShipment);
// Clears a booking claim kept after a timeout/5xx, once an operator has checked Shiprocket.
router.post("/returns/:id/pickup/release-claim", isAdmin, requirePermission(ADMIN_PERMISSIONS.RETURNS_MANAGE), ReleaseReturnPickupClaim);
router.post("/returns/:id/replacement/release-claim", isAdmin, requirePermission(ADMIN_PERMISSIONS.RETURNS_MANAGE), ReleaseReplacementBookingClaim);
// Return-leg AWBs: record by hand, or fetch from Shiprocket now.
router.patch("/returns/:id/pickup/awb", isAdmin, requirePermission(ADMIN_PERMISSIONS.RETURNS_MANAGE), RecordReturnPickupAwb);
router.patch("/returns/:id/replacement/awb", isAdmin, requirePermission(ADMIN_PERMISSIONS.RETURNS_MANAGE), RecordReplacementAwb);
router.post("/returns/:id/pickup/sync-awb", isAdmin, requirePermission(ADMIN_PERMISSIONS.RETURNS_MANAGE), SyncReturnPickupAwb);
router.post("/returns/:id/replacement/sync-awb", isAdmin, requirePermission(ADMIN_PERMISSIONS.RETURNS_MANAGE), SyncReplacementAwb);
router.post("/returns/:id/replacement/dispatch", isAdmin, requirePermission(ADMIN_PERMISSIONS.RETURNS_MANAGE), DispatchReplacement);
router.post("/returns/:id/replacement/delivered", isAdmin, requirePermission(ADMIN_PERMISSIONS.RETURNS_MANAGE), ConfirmReplacementDelivery);
router.get("/all-users", isAdmin, requirePermission(ADMIN_PERMISSIONS.USERS_MANAGE), GetAllUsers);
router.get("/users/today", isAdmin, requirePermission(ADMIN_PERMISSIONS.USERS_MANAGE), GetTodayUsers);
router.put("/block/:id", isAdmin, requirePermission(ADMIN_PERMISSIONS.USERS_MANAGE), BlockUser);
router.put("/unblock/:id", isAdmin, requirePermission(ADMIN_PERMISSIONS.USERS_MANAGE), UnBlockUser);
router.get("/coupons", isAdmin, requirePermission(ADMIN_PERMISSIONS.COUPONS_MANAGE), AdminGetCoupons);
router.get("/coupons/report", isAdmin, requirePermission(ADMIN_PERMISSIONS.COUPONS_REPORTS), AdminCouponUsageReport);
router.get("/coupons/report/export", isAdmin, requirePermission(ADMIN_PERMISSIONS.COUPONS_REPORTS), ExportCouponUsageReport);
router.post("/coupons", isAdmin, requirePermission(ADMIN_PERMISSIONS.COUPONS_MANAGE), AdminCreateCoupon);
router.put("/coupons/:id", isAdmin, requirePermission(ADMIN_PERMISSIONS.COUPONS_MANAGE), AdminUpdateCoupon);
router.delete("/coupons/:id", isAdmin, requirePermission(ADMIN_PERMISSIONS.COUPONS_MANAGE), AdminDeleteCoupon);
router.post("/products/bulk-import", isAdmin, requirePermission(ADMIN_PERMISSIONS.PRODUCTS_BULK), BulkImportProducts);
router.patch("/products/bulk-update", isAdmin, requirePermission(ADMIN_PERMISSIONS.PRODUCTS_BULK), BulkUpdateProducts);
router.get("/products/export", isAdmin, requirePermission(ADMIN_PERMISSIONS.PRODUCTS_BULK), ExportProducts);
router.get("/reports/sales", isAdmin, requirePermission(ADMIN_PERMISSIONS.REPORTS_READ), GetSalesReport);
// Read-only. Same permission as other financial reporting; nothing here mutates an order.
router.get("/reports/cod-reconciliation", isAdmin, requirePermission(ADMIN_PERMISSIONS.REPORTS_READ), GetCodReconciliation);
// Everything in fulfilment waiting on a person, derived from the workflows' own state.
router.get("/shipping/exceptions", isAdmin, requirePermission(ADMIN_PERMISSIONS.ORDERS_MANAGE), GetShippingExceptions);
// Courier reconciliation: status of the last pass, and a rate-limited "run now".
router.get("/shipping/reconciliation", isAdmin, requirePermission(ADMIN_PERMISSIONS.ORDERS_MANAGE), GetShippingReconciliationStatus);
router.post(
  "/shipping/reconciliation/run",
  shippingReconcileRateLimit,
  isAdmin,
  requirePermission(ADMIN_PERMISSIONS.ORDERS_MANAGE),
  RunShippingReconciliation,
);
router.put("/homepage/settings", isAdmin, requirePermission(ADMIN_PERMISSIONS.CMS_MANAGE), UpdateHomepageSettings);
router.get("/homepage/reviews", isAdmin, requirePermission(ADMIN_PERMISSIONS.CMS_MANAGE), GetHomepageReviewOptions);
router.get("/cms/blocks", isAdmin, requirePermission(ADMIN_PERMISSIONS.CMS_MANAGE), AdminGetCmsBlocks);
router.post("/cms/blocks", isAdmin, requirePermission(ADMIN_PERMISSIONS.CMS_MANAGE), AdminCreateCmsBlock);
router.put("/cms/blocks/:id", isAdmin, requirePermission(ADMIN_PERMISSIONS.CMS_MANAGE), AdminUpdateCmsBlock);
router.delete("/cms/blocks/:id", isAdmin, requirePermission(ADMIN_PERMISSIONS.CMS_MANAGE), AdminDeleteCmsBlock);

export default router;
