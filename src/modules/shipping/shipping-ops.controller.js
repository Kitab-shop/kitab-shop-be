import {
  getReconciliationStatus,
  runReconciliationPass,
} from "./shipping-reconciliation.service.js";
import { createAuditLog } from "../audit/audit-log.js";

/**
 * Admin operations on the courier integration as a whole (not on one order).
 *
 * "Run now" exists for the moment an operator has just fixed something — re-enabled
 * Shiprocket, corrected credentials, cancelled a stuck parcel in Shiprocket's dashboard —
 * and wants the system to catch up without waiting for the next scheduled pass. It shares
 * the scheduler's in-process guard, so it can never overlap a pass already running.
 */
const REASON_MESSAGES = {
  already_running: "A reconciliation pass is already running. Its results will appear when it finishes.",
  disabled_by_env: "Reconciliation is switched off for this environment (SHIPPING_RECONCILE_ENABLED=false).",
  disabled_in_settings: "Reconciliation is switched off under Operations → Shipping.",
  shiprocket_not_in_use: "Shiprocket shipments are off or not connected, so there is nothing to reconcile.",
  error: "The reconciliation pass failed. Check the server logs for shipping/reconcile_pass_failed.",
};

export const RunShippingReconciliation = async (req, res) => {
  try {
    const result = await runReconciliationPass({ reason: "admin" });
    if (!result.ran) {
      return res.status(result.reason === "already_running" ? 409 : 200).json({
        success: result.reason !== "error",
        ran: false,
        reason: result.reason,
        message: REASON_MESSAGES[result.reason] || "Reconciliation did not run.",
      });
    }
    await createAuditLog({
      admin: req.user?.id,
      action: "RUN_SHIPPING_RECONCILIATION",
      module: "Shipping",
      targetName: "Shipping reconciliation",
      description: result.halted
        ? `Manual reconciliation pass (halted early: ${result.halted})`
        : "Manual reconciliation pass",
      req,
    }).catch(() => null);
    return res.status(200).json({
      success: true,
      ran: true,
      halted: result.halted || null,
      message: result.halted
        ? "Reconciliation stopped early because Shiprocket asked us to slow down or was unreachable. The rest will be picked up on the next pass."
        : "Reconciliation finished.",
      summary: result.summary,
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const GetShippingReconciliationStatus = async (req, res) => {
  try {
    return res.status(200).json({ success: true, ...getReconciliationStatus() });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};
