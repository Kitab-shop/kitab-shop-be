import { createAuditLog } from "../audit/audit-log.js";
import { logLifecycleError } from "../../utils/lifecycle-logger.service.js";
import { bulkConfirmOrders } from "./order-confirmation.service.js";

/**
 * POST /order/bulk-confirm — approve many Pending orders at once.
 *
 * Every order is validated by its own compare-and-swap (see confirmOrder), so the
 * response is a per-order account rather than a single pass/fail: which were
 * confirmed, which were skipped and why (already confirmed, cancelled, payment not
 * captured, not found), and — for the filtered scope — how many matching orders are
 * still waiting because the request hit the batch cap.
 */
export const BulkConfirmOrders = async (req, res) => {
  try {
    const { scope, orderIds, filters = {}, listedAt } = req.body;
    const result = await bulkConfirmOrders({
      orderIds: scope === "selected" ? orderIds : undefined,
      filters,
      listedAt,
      actorId: req.user?.id || null,
    });

    // One entry for the action. Each order's own statusHistory records who
    // confirmed it, with source "admin_bulk_confirm".
    if (result.confirmed.length > 0) {
      const ids = result.confirmed.map((row) => row.orderId);
      await createAuditLog({
        admin: req.user?.id,
        action: "BULK_CONFIRM_ORDERS",
        module: "ORDER",
        targetName: `${ids.length} orders`,
        description: `Confirmed ${ids.length} order(s) (${scope}): ${ids.slice(0, 50).join(", ")}${ids.length > 50 ? ", …" : ""}`,
        req,
      }).catch(() => null);
    }

    const confirmedCount = result.confirmed.length;
    const skippedCount = result.skipped.length;
    return res.status(200).json({
      success: true,
      message:
        confirmedCount === 0
          ? "No orders were confirmed."
          : `Confirmed ${confirmedCount} order${confirmedCount === 1 ? "" : "s"}${
              skippedCount ? `, skipped ${skippedCount}` : ""
            }.`,
      confirmedCount,
      skippedCount,
      ...result,
    });
  } catch (error) {
    if (error.statusCode === 400) {
      return res.status(400).json({ success: false, message: error.message });
    }
    logLifecycleError("orders", "bulk_confirm_failed", error, { userId: req.user?.id });
    return res.status(500).json({
      success: false,
      message: "Could not confirm the orders just now. Please try again.",
    });
  }
};
