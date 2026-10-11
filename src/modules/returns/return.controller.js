import mongoose from "mongoose";
import OrderModel from "../orders/Order.model.js";
import ProductModel from "../products/Product.model.js";
import ReturnModel, {
  OPEN_RETURN_STATUSES,
  QUANTITY_CONSUMING_RETURN_STATUSES,
  RETURN_STATUSES,
} from "./return.model.js";
import UserModel from "../../model/User.model.js";
import { createAuditLog } from "../audit/audit-log.js";
import { notifyRefundProcessed, notifyReturnUpdated } from "../notifications/notification.service.js";
import { ADMIN_PERMISSIONS } from "../../config/admin-permissions.config.js";
import {
  proportionalRefundAmount,
  proportionalWalletRefund,
  refundReturnRequest,
} from "../payments/return-refund.service.js";
import { adminHasPermission } from "../../config/admin-access.service.js";
import { logLifecycleEvent, logLifecycleError } from "../../utils/lifecycle-logger.service.js";
import { syncReturnLegAwb } from "../shipping/shipping-reconciliation.service.js";
import ShiprocketSetting from "../shipping/ShiprocketSetting.model.js";
import {
  assignAwb,
  createReplacementShipment,
  createReturnPickup,
  getShippingCapabilities,
  resolveWarehouseAddress,
  ShiprocketError,
} from "../shipping/shiprocket.service.js";
import {
  deductReplacementStock,
  restockReturnedItems,
} from "../inventory/restock.service.js";
const STATUS_TRANSITIONS = {
  pending: ["approved", "rejected"],
  approved: ["pickup_scheduled", "rejected"],
  pickup_scheduled: ["received"],
  // Which of refunded/replaced a given request may reach is further narrowed by
  // its own resolutionType in AdminUpdateReturnStatus — a replacement-policy
  // return can never be marked "refunded" and vice versa.
  //
  // "rejected" is reachable here too: this is the QC step. Without it the admin
  // was forced to refund or replace whatever came back in the box, even if it
  // was damaged, used, or the wrong item entirely.
  // "replaced" is deliberately NOT reachable from here any more. It was the old
  // single-step close-out that declared a replacement finished before the parcel
  // was packed and never deducted the outbound unit. Replacements now go through
  // DispatchReplacement, so that shortcut cannot be taken again. The state itself
  // is retained below so historical documents stay valid.
  received: ["refunded", "replacement_dispatched", "rejected"],
  refunded: [],
  replaced: [],
  // Manual replacement fulfilment. Only delivery follows dispatch; there is
  // deliberately no failed/lost/backordered state, because nothing in the system
  // supports one today.
  replacement_dispatched: ["replacement_delivered"],
  replacement_delivered: [],
  rejected: [],
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const escapeRegex = (value = "") =>
  String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const populateReturn = (query) =>
  query
    .populate("user", "email roles")
    .populate("product", "name image brand")
    // razorpayPaymentId is what decides whether the refund can go back through
    // the gateway automatically or has to be settled manually (COD), so the
    // admin UI needs it to know which flow to present.
    .populate(
      "order",
      "orderStatus paymentMethod paymentStatus totalAmount createdAt deliveredAt razorpayPaymentId",
    );

const populateReturnLean = (query) => populateReturn(query).lean();

/**
 * Masks the stored bank account number before a return goes out over the wire.
 *
 * The owner supplied it, so they get the last four digits back as confirmation —
 * enough to recognise the account, not enough to leak if the response is logged,
 * cached, or read over someone's shoulder. Only an operator who actually has to
 * push the money (returns:manage) receives the full number, and the UPI id and
 * IFSC are left intact because neither is usable on its own.
 */
const redactRefundDestination = (returnRequest, { isOwner }) => {
  const destination = returnRequest?.refundDestination;
  if (!isOwner || !destination?.accountNumber) return returnRequest;

  const accountNumber = String(destination.accountNumber);
  return {
    ...returnRequest,
    refundDestination: {
      ...destination,
      accountNumber:
        accountNumber.length > 4
          ? `${"•".repeat(accountNumber.length - 4)}${accountNumber.slice(-4)}`
          : accountNumber,
    },
  };
};

export const CreateReturnRequest = async (req, res) => {
  try {
    const { orderId, productId, quantity = 1, reason, details = "", proofImages = [] } =
      req.body || {};

    if (!mongoose.Types.ObjectId.isValid(orderId)) {
      return res.status(400).json({ success: false, message: "Invalid order id" });
    }
    if (!mongoose.Types.ObjectId.isValid(productId)) {
      return res.status(400).json({ success: false, message: "Invalid product id" });
    }
    if (!String(reason || "").trim()) {
      return res.status(400).json({ success: false, message: "Return reason is required" });
    }
    if (!Array.isArray(proofImages)) {
      return res.status(400).json({ success: false, message: "Proof images must be an array" });
    }

    // subtotal/totalAmount are needed to value the refund against what the
    // customer actually paid; walletDiscount splits that value into the cash
    // half and the prepaid half; paymentMethod decides whether we must collect a
    // payout destination from them.
    // shippingCharge is needed because it is the one component a return does NOT
    // give back — see proportionalRefundAmount (audit H2-03).
    const order = await OrderModel.findById(orderId).select(
      "user orderStatus items deliveredAt subtotal totalAmount shippingCharge walletDiscount paymentMethod paymentStatus",
    );
    if (!order) {
      return res.status(404).json({ success: false, message: "Order not found" });
    }
    if (String(order.user) !== String(req.user.id)) {
      return res.status(403).json({ success: false, message: "You cannot return this order" });
    }
    if (order.orderStatus !== "Delivered") {
      return res.status(400).json({
        success: false,
        message: "A return can be requested only after the order is delivered",
      });
    }

    const orderItem = order.items.find(
      (item) => String(item.product) === String(productId),
    );
    if (!orderItem) {
      return res.status(404).json({
        success: false,
        message: "Product was not found in this order",
      });
    }

    // Products created before returnPolicy existed may have it missing or
    // partially stored, so each piece falls back independently rather than
    // only substituting when the whole object is absent.
    const product = await ProductModel.findById(productId).select("returnPolicy");
    const policyKind = product?.returnPolicy?.kind || "return";
    const policyWindowDays = Number(product?.returnPolicy?.windowDays) || 7;

    if (policyKind === "none") {
      return res.status(400).json({
        success: false,
        message: "This product is not eligible for return or replacement",
      });
    }

    // Orders delivered before deliveredAt existed have no timestamp to count
    // from — skip the window check for those rather than blocking them.
    if (order.deliveredAt) {
      const daysSinceDelivery = (Date.now() - order.deliveredAt.getTime()) / MS_PER_DAY;
      if (daysSinceDelivery > policyWindowDays) {
        return res.status(400).json({
          success: false,
          message: `The ${policyKind} window for this product (${policyWindowDays} days from delivery) has passed`,
        });
      }
    }

    const resolutionType = policyKind === "replacement" ? "replacement" : "refund";

    // ── HOW MANY UNITS OF THIS LINE ARE STILL RETURNABLE ─────────────────────
    // Three things consume a line: cancellation, and any return that is not
    // rejected. Cancelled units were restocked and refunded at cancellation time,
    // and returned units were restocked and refunded (or replaced) at resolution
    // time — counting either again pays for the same unit twice.
    //
    // The already-returned half of this is new, and it is REQUIRED by the index
    // change below rather than an extra. While only one return could ever exist
    // per line, "ordered − cancelled" was a complete answer; now that a second
    // return is possible once the first resolves, a line of 5 could otherwise be
    // returned 5 units at a time, without limit. The refund ledger would cap the
    // MONEY at the order total, but restockReturnedItems restocks
    // `returnRequest.quantity` per return, so the stock would inflate with every
    // repeat.
    //
    // Rejected returns are excluded: those goods went back to the customer.
    const consumedByReturns = await ReturnModel.aggregate([
      {
        $match: {
          order: order._id,
          product: orderItem.product,
          user: new mongoose.Types.ObjectId(String(req.user.id)),
          status: { $in: QUANTITY_CONSUMING_RETURN_STATUSES },
        },
      },
      { $group: { _id: null, quantity: { $sum: "$quantity" } } },
    ]);
    const alreadyReturned = Number(consumedByReturns[0]?.quantity) || 0;

    const returnableQuantity = Math.max(
      0,
      (Number(orderItem.quantity) || 0) -
        (Number(orderItem.cancelledQuantity) || 0) -
        alreadyReturned,
    );
    if (returnableQuantity === 0) {
      return res.status(400).json({
        success: false,
        message: alreadyReturned
          ? "Every unit of this item has already been cancelled or returned"
          : "Every unit of this item was already cancelled and refunded",
        code: "NOTHING_LEFT_TO_RETURN",
      });
    }

    const returnQuantity = Number.parseInt(quantity, 10);
    if (
      !Number.isInteger(returnQuantity) ||
      returnQuantity < 1 ||
      returnQuantity > returnableQuantity
    ) {
      return res.status(400).json({
        success: false,
        message: `Return quantity must be between 1 and ${returnableQuantity}`,
        code: "RETURN_QUANTITY_UNAVAILABLE",
      });
    }

    // Refused at CREATION, not after pickup. This block previously landed only
    // when the admin tried to settle the refund — by which point a courier had
    // been booked and the customer's goods collected for a return that could
    // never be paid.
    if (resolutionType === "refund" && order.paymentStatus === "Refunded") {
      return res.status(400).json({
        success: false,
        message:
          "This order has already been fully refunded, so there is nothing left to refund on a return.",
        code: "ORDER_ALREADY_REFUNDED",
      });
    }

    // Only an OPEN return blocks a new one. This used to match ANY return
    // regardless of status, which permanently barred the line: `rejected` is
    // terminal with no reopen endpoint, so a mistaken QC rejection left the
    // customer with no route at all, and a resolved partial return exhausted the
    // remaining units.
    //
    // A friendly pre-check, not the guard — two simultaneous requests can both
    // pass it. The partial unique index is what actually decides, and the E11000
    // handler below turns the loser into the same 409.
    const openReturn = await ReturnModel.findOne({
      order: order._id,
      product: orderItem.product,
      user: req.user.id,
      status: { $in: OPEN_RETURN_STATUSES },
    }).select("returnNumber status");
    if (openReturn) {
      return res.status(409).json({
        success: false,
        message: `A return request for this product is already in progress (${openReturn.returnNumber}). Wait for it to be resolved before raising another.`,
        code: "OPEN_RETURN_EXISTS",
      });
    }

    // A COD order has no payment to reverse, so the customer has to tell us
    // where to send the money. Only required for refunds — a replacement needs
    // no payout — and validated here so the request can't be created in a state
    // the admin later can't act on.
    const needsDestination = resolutionType === "refund" && order.paymentMethod !== "RAZORPAY";
    let refundDestination;
    if (needsDestination) {
      const destination = req.body?.refundDestination || {};
      const method = String(destination.method || "").toLowerCase();

      if (method === "upi") {
        const upiId = String(destination.upiId || "").trim();
        if (!/^[\w.\-]{2,}@[a-zA-Z]{2,}$/.test(upiId)) {
          return res.status(400).json({
            success: false,
            message: "Enter a valid UPI ID (for example name@bank) to receive your refund",
            code: "REFUND_DESTINATION_REQUIRED",
          });
        }
        refundDestination = { method: "upi", upiId };
      } else if (method === "bank_transfer") {
        const accountName = String(destination.accountName || "").trim();
        const accountNumber = String(destination.accountNumber || "").replace(/\s/g, "");
        const ifsc = String(destination.ifsc || "").trim().toUpperCase();

        if (!accountName || !/^\d{9,18}$/.test(accountNumber) || !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc)) {
          return res.status(400).json({
            success: false,
            message:
              "Enter the account holder name, a valid account number and a valid IFSC code to receive your refund",
            code: "REFUND_DESTINATION_REQUIRED",
          });
        }
        refundDestination = { method: "bank_transfer", accountName, accountNumber, ifsc };
      } else {
        return res.status(400).json({
          success: false,
          message:
            "This order was paid by Cash on Delivery, so tell us where to send your refund — choose UPI or bank transfer",
          code: "REFUND_DESTINATION_REQUIRED",
        });
      }
    }

    const returnRequest = await ReturnModel.create({
      order: order._id,
      user: req.user.id,
      product: orderItem.product,
      productSnapshot: {
        name: orderItem.name,
        image: orderItem.image,
        price: orderItem.price,
      },
      quantity: returnQuantity,
      reason: String(reason).trim(),
      details: String(details || "").trim(),
      proofImages: proofImages.slice(0, 5),
      // Valued against what was actually paid, not the pre-discount list price.
      refundAmount: proportionalRefundAmount({
        unitPrice: orderItem.price,
        quantity: returnQuantity,
        orderSubtotal: order.subtotal,
        orderTotal: order.totalAmount,
        // Excluded from the refund: the parcel was shipped and the courier paid.
        orderShippingCharge: order.shippingCharge,
      }),
      // The prepaid half. Split out at request time so the customer is quoted the
      // whole amount they are owed, not just the card portion.
      walletRefundAmount: proportionalWalletRefund({
        unitPrice: orderItem.price,
        quantity: returnQuantity,
        orderSubtotal: order.subtotal,
        walletDiscount: order.walletDiscount,
      }),
      resolutionType,
      ...(refundDestination ? { refundDestination } : {}),
    });

    await notifyReturnUpdated({
      orderId: order._id,
      userId: req.user.id,
      status: returnRequest.status,
    });

    return res.status(201).json({
      success: true,
      message: "Return request submitted successfully",
      data: returnRequest,
    });
  } catch (error) {
    // The partial unique index rejecting a concurrent duplicate. This is the
    // authoritative guard — the pre-check above is a read-then-act pair that two
    // simultaneous requests can both pass — so it answers with the same 409.
    if (error?.code === 11000) {
      return res.status(409).json({
        success: false,
        message:
          "A return request for this product is already in progress. Wait for it to be resolved before raising another.",
        code: "OPEN_RETURN_EXISTS",
      });
    }
    return res.status(500).json({ success: false, message: error.message });
  }
};

// Booking claims and their error text are operator state: the raw Shiprocket message
// ("Shiprocket is unreachable: …") means nothing to a customer and says more about our
// integration than it should. Stripped from every customer-facing return response.
const OPERATOR_ONLY_RETURN_FIELDS = [
  "pickupBookingClaimedAt",
  "pickupBookingError",
  "replacementBookingClaimedAt",
  "replacementBookingError",
];

const withoutOperatorFields = (returnRequest) => {
  if (!returnRequest) return returnRequest;
  const copy = { ...returnRequest };
  for (const field of OPERATOR_ONLY_RETURN_FIELDS) delete copy[field];
  return copy;
};

export const GetMyReturns = async (req, res) => {
  try {
    const returns = await populateReturn(
      ReturnModel.find({ user: req.user.id }).sort({ createdAt: -1 }),
    ).lean();

    return res.status(200).json({
      success: true,
      total: returns.length,
      data: returns.map(withoutOperatorFields),
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const GetReturnById = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid return id" });
    }

    const returnRequest = await populateReturnLean(ReturnModel.findById(req.params.id));
    if (!returnRequest) {
      return res.status(404).json({ success: false, message: "Return not found" });
    }

    const isOwner = String(returnRequest.user?._id || returnRequest.user) === String(req.user.id);
    // A non-owner needs returns:manage, not merely an admin-tier role. This
    // record carries refundDestination — UPI id, account number, IFSC — so the
    // old hasAdminRole() check let a themeEditor read customer bank details.
    const canManageReturns =
      !isOwner && (await adminHasPermission(req.user, ADMIN_PERMISSIONS.RETURNS_MANAGE));
    if (!isOwner && !canManageReturns) {
      return res.status(403).json({ success: false, message: "Unauthorized" });
    }

    const visible = redactRefundDestination(returnRequest, { isOwner });
    return res
      .status(200)
      .json({ success: true, data: isOwner ? withoutOperatorFields(visible) : visible });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const AdminGetReturns = async (req, res) => {
  try {
    const page = Math.max(Number.parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 10, 1), 100);
    const status = String(req.query.status || "all");
    const search = String(req.query.search || "").trim();
    const order = String(req.query.order || "").trim();
    const filter = {};

    if (status !== "all" && RETURN_STATUSES.includes(status)) filter.status = status;

    // Explicit order filter (used by the admin order page's Returns card and
    // the ?order= deep link) — separate from `search`, which only matches an
    // order id incidentally.
    if (order) {
      if (!mongoose.Types.ObjectId.isValid(order)) {
        return res.status(400).json({
          success: false,
          code: "INVALID_ORDER_ID",
          message: "order must be a valid order id",
        });
      }
      filter.order = order;
    }

    if (search) {
      const regex = new RegExp(escapeRegex(search), "i");
      const [users, products] = await Promise.all([
        UserModel.find({ email: regex }).distinct("_id"),
        ProductModel.find({ name: regex }).distinct("_id"),
      ]);
      filter.$or = [
        { returnNumber: regex },
        { reason: regex },
        { details: regex },
        { "productSnapshot.name": regex },
        { user: { $in: users } },
        { product: { $in: products } },
      ];
      if (mongoose.Types.ObjectId.isValid(search)) {
        filter.$or.push({ _id: search }, { order: search });
      }
    }

    const [returns, total] = await Promise.all([
      populateReturn(
        ReturnModel.find(filter)
          .sort({ createdAt: -1 })
          .skip((page - 1) * limit)
          .limit(limit),
      ).lean(),
      ReturnModel.countDocuments(filter),
    ]);

    return res.status(200).json({
      success: true,
      data: returns,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(Math.ceil(total / limit), 1),
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const AdminUpdateReturnStatus = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid return id" });
    }

    const status = String(req.body?.status || "");
    const adminNote = String(req.body?.adminNote || "").trim();
    const disposition = String(req.body?.disposition || "").trim().toLowerCase();
    const dispositionNote = String(req.body?.dispositionNote || "").trim();
    if (!RETURN_STATUSES.includes(status)) {
      return res.status(400).json({ success: false, message: "Invalid return status" });
    }

    // `let`, not `const`: the atomic claim below replaces this document with the
    // post-claim one. It was declared `const` while line ~582 assigned to it, so
    // EVERY call that got as far as the claim threw "Assignment to constant
    // variable" and the outer catch turned it into a 500 — no return could be
    // approved, received, refunded or rejected at all. Nothing caught it because no
    // test drove this endpoint; see replacement-fulfilment.regression.mjs.
    let returnRequest = await ReturnModel.findById(req.params.id);
    if (!returnRequest) {
      return res.status(404).json({ success: false, message: "Return not found" });
    }

    const allowedNextStatuses = STATUS_TRANSITIONS[returnRequest.status] || [];
    if (!allowedNextStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        message: `Return cannot move from ${returnRequest.status} to ${status}`,
      });
    }

    // "received" can move to either refunded or replaced in the abstract,
    // but a given request is only ever eligible for the one matching its
    // own resolutionType (decided at request time from the product's policy).
    if (status === "refunded" && returnRequest.resolutionType !== "refund") {
      return res.status(400).json({
        success: false,
        message: "This return is a replacement, not a refund — use the replaced status instead",
      });
    }
    if (status === "replaced" && returnRequest.resolutionType !== "replacement") {
      return res.status(400).json({
        success: false,
        message: "This return is a refund, not a replacement — use the refunded status instead",
      });
    }

    // The replacement states carry side effects this endpoint does not perform —
    // recording the courier and AWB, and deducting the outbound unit from stock —
    // so they have their own endpoints. Same convention as UpdateOrderStatus
    // refusing "Cancelled" and pointing at the cancel endpoint.
    if (status === "replacement_dispatched" || status === "replacement_delivered") {
      return res.status(400).json({
        success: false,
        message:
          status === "replacement_dispatched"
            ? "Use the dispatch-replacement endpoint — it records the courier and AWB and takes the replacement unit out of stock."
            : "Use the confirm-replacement-delivery endpoint.",
        code: "USE_REPLACEMENT_ENDPOINT",
      });
    }

    // ── INVENTORY DISPOSITION ────────────────────────────────────────────────
    // Whether the customer gets their money and whether the goods can be resold
    // are INDEPENDENT decisions. Resolving a return therefore requires an explicit
    // disposition, and there is deliberately no default: silently assuming
    // "resellable" is what put refunded-but-faulty units back on sale, and
    // silently assuming "damaged" would quietly write off good stock.
    if ((status === "refunded" || status === "replaced") && !["resellable", "damaged"].includes(disposition)) {
      return res.status(400).json({
        success: false,
        message:
          "Record the condition of the returned goods: \"resellable\" puts them back into stock, \"damaged\" writes them off. The customer is refunded or replaced either way.",
        code: "DISPOSITION_REQUIRED",
      });
    }

    // Rejecting an item the customer has already shipped back is a QC failure,
    // and the customer is owed an explanation they can dispute. Requiring the
    // note here means "rejected after receipt" is never an unexplained decision.
    if (status === "rejected" && returnRequest.status === "received" && !adminNote) {
      return res.status(400).json({
        success: false,
        message:
          "Add a note explaining why the returned item failed inspection — the customer is shown this reason",
        code: "QC_REJECTION_REASON_REQUIRED",
      });
    }

    // Money moves BEFORE the status flips. Marking a return "refunded" used to
    // be a status change only, so the customer was told "refund processed" while
    // their money was still with the store until an admin separately remembered
    // to raise a Razorpay refund by hand. If this throws, the return stays at
    // "received" and nothing is claimed to the customer.
    // ─── ATOMIC CLAIM ───────────────────────────────────────────────────────
    // Everything above validated against a document read at the top of this
    // handler, so two concurrent PATCHes could both pass and both reach the
    // gateway — refunding the customer twice for one return. Claiming the
    // transition here, with the expected current status in the FILTER, means
    // exactly one request proceeds. This runs BEFORE any money moves.
    const previousStatus = returnRequest.status;
    const claimed = await ReturnModel.findOneAndUpdate(
      { _id: returnRequest._id, status: previousStatus },
      { $set: { status } },
      { returnDocument: "after" },
    );

    if (!claimed) {
      return res.status(409).json({
        success: false,
        message:
          "This return was updated by someone else a moment ago. Reload it and try again.",
        code: "RETURN_STATUS_CONFLICT",
      });
    }
    returnRequest = claimed;

    let refundResult;
    if (status === "refunded") {
      const order = await OrderModel.findById(returnRequest.order);
      if (!order) {
        // Put the status back — nothing was settled.
        await ReturnModel.updateOne({ _id: returnRequest._id }, { $set: { status: previousStatus } });
        return res.status(404).json({
          success: false,
          message: "The order for this return no longer exists",
        });
      }

      try {
        refundResult = await refundReturnRequest({
          order,
          returnRequest,
          adminId: req.user.id,
          manual: { method: req.body?.refundMethod, reference: req.body?.refundReference },
        });
      } catch (error) {
        // The claim moved the status to "refunded" before the money was
        // attempted, so it has to be released again — otherwise the return
        // would read as refunded with nothing settled, which is the precise
        // failure this module exists to prevent.
        await ReturnModel.updateOne({ _id: returnRequest._id }, { $set: { status: previousStatus } });
        return res.status(error.statusCode || 502).json({
          success: false,
          message: error.message,
          code: error.code,
        });
      }
    }

    if (adminNote) returnRequest.adminNote = adminNote;
    if (status === "pickup_scheduled") {
      const pickupDate = req.body?.pickupScheduledAt
        ? new Date(req.body.pickupScheduledAt)
        : new Date();
      returnRequest.pickupScheduledAt = Number.isNaN(pickupDate.getTime())
        ? new Date()
        : pickupDate;
    }
    if (status === "received") returnRequest.receivedAt = new Date();
    if (status === "refunded") returnRequest.refundedAt = new Date();
    if (status === "replaced") returnRequest.replacedAt = new Date();
    if (disposition) {
      returnRequest.disposition = disposition;
      returnRequest.dispositionNote = dispositionNote;
    }

    // Restock follows the DISPOSITION, not the resolution. restockReturnedItems
    // itself refuses anything that is not explicitly "resellable", so a damaged
    // return is refunded to the customer and written off the shelf — which is the
    // whole point of separating the two decisions. "rejected" never restocks
    // either: the goods go back to the customer.
    let restockedQuantity = 0;
    if (status === "refunded" || status === "replaced") {
      restockedQuantity = await restockReturnedItems({ returnRequest });
    }

    returnRequest.statusHistory.push({
      status,
      changedBy: req.user.id,
      note: adminNote,
    });
    await returnRequest.save();
    await notifyReturnUpdated({
      orderId: returnRequest.order,
      userId: returnRequest.user,
      status,
    });
    if (status === "refunded") {
      await notifyRefundProcessed({
        orderId: returnRequest.order,
        paymentId: refundResult?.refund?.providerRefundId || null,
      });
    }

    await createAuditLog({
      admin: req.user.id,
      action: "UPDATE_RETURN_STATUS",
      module: "RETURN",
      targetId: returnRequest._id,
      targetName: returnRequest.returnNumber,
      description: `Updated ${returnRequest.returnNumber} from ${
        returnRequest.statusHistory.at(-2)?.status || "pending"
      } to ${status}`,
      req,
    });

    const populatedReturn = await populateReturnLean(ReturnModel.findById(returnRequest._id));
    // Both side effects are reported back, so the operator knows the wallet share
    // was already handled and does not pay it out a second time by hand.
    const notes = [
      restockedQuantity > 0 ? `${restockedQuantity} unit(s) returned to stock` : "",
      // Stated out loud: a write-off is a real inventory loss and should never be
      // something the operator has to infer from the absence of a message.
      returnRequest.disposition === "damaged"
        ? `${returnRequest.quantity} unit(s) written off as damaged — NOT returned to stock`
        : "",
      refundResult?.walletCredited > 0
        ? `₹${refundResult.walletCredited} of wallet credit returned`
        : "",
    ].filter(Boolean);
    return res.status(200).json({
      success: true,
      message: notes.length
        ? `Return status updated successfully. ${notes.join("; ")}.`
        : "Return status updated successfully",
      data: populatedReturn,
      restockedQuantity,
      walletCredited: refundResult?.walletCredited || 0,
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * Shared preamble for both booking endpoints: capability, credentials, the return, and
 * the order behind it. Returns an error shape rather than throwing, so each caller keeps
 * its own status codes.
 */
const prepareReverseBooking = async (returnId) => {
  const capabilities = await getShippingCapabilities();
  if (!capabilities.permitted) {
    return { error: { status: 503, body: { success: false, message: "Shiprocket is disabled for this environment" } } };
  }
  if (!capabilities.shipments) {
    return { error: { status: 409, body: { success: false, message: "This store is set to manual fulfilment. Switch Shiprocket shipments on under Operations → Shipping." } } };
  }
  if (!capabilities.reverseShipments) {
    return {
      error: {
        status: 409,
        body: {
          success: false,
          message:
            "Booking return pickups and replacement parcels through Shiprocket is switched off. Enable it under Operations → Shipping, or record the courier and AWB by hand.",
          code: "REVERSE_SHIPMENTS_DISABLED",
        },
      },
    };
  }
  if (!capabilities.configured) {
    return { error: { status: 503, body: { success: false, message: "Shiprocket credentials are not saved" } } };
  }

  if (!mongoose.Types.ObjectId.isValid(returnId)) {
    return { error: { status: 400, body: { success: false, message: "Invalid return id" } } };
  }
  const returnRequest = await ReturnModel.findById(returnId);
  if (!returnRequest) {
    return { error: { status: 404, body: { success: false, message: "Return not found" } } };
  }
  // populate the customer email, which every Shiprocket shipment payload requires
  const order = await OrderModel.findById(returnRequest.order).populate("user", "email");
  if (!order) {
    return { error: { status: 404, body: { success: false, message: "The order behind this return no longer exists" } } };
  }
  return { returnRequest, order };
};

// ─── BOOKING CLAIMS ──────────────────────────────────────────────────────────
//
// Both reverse legs used to book like this: read the return, check "nothing booked yet",
// call Shiprocket, then write the result. Two clicks a moment apart both passed the read
// and both booked a courier. Worse, the "nothing booked yet" check looked at the AWB, and
// booking never sets an AWB (Shiprocket assigns it later) — so even a second click long
// after a successful booking booked a second courier to the same customer.
//
// Now each leg is claimed atomically BEFORE Shiprocket is contacted, with the source
// status and "no shipment yet" in the filter, so of N concurrent clicks exactly one
// reaches Shiprocket. The claim is cleared in the same write that stores the shipment
// ids. What happens to it on failure is the important part:
//
//   DEFINITE REFUSAL (Shiprocket answered 4xx, or we failed before sending anything) —
//     nothing was booked, so the claim is released and the admin can simply retry.
//   ANYTHING ELSE (timeout, transport error, 5xx, a 200 with no ids, an unexpected
//     throw) — Shiprocket may well have created the shipment. The claim is KEPT, and a
//     human checks Shiprocket before releasing it through the release-claim endpoint.
//     An automatic retry here is precisely how a customer gets two couriers.
const BOOKING_LEGS = {
  pickup: {
    label: "return pickup",
    event: "return_pickup",
    claimField: "pickupBookingClaimedAt",
    errorField: "pickupBookingError",
    shipmentField: "pickupShipmentId",
    shiprocketOrderField: "pickupShiprocketOrderId",
    awbField: "pickupAwb",
    courierField: "pickupCourier",
    // Shiprocket references the collection by the bare return number.
    reference: (returnRequest) => String(returnRequest.returnNumber),
  },
  replacement: {
    label: "replacement parcel",
    event: "replacement_shipment",
    claimField: "replacementBookingClaimedAt",
    errorField: "replacementBookingError",
    shipmentField: "replacementShipmentId",
    shiprocketOrderField: "replacementShiprocketOrderId",
    awbField: "replacementAwb",
    courierField: "replacementCourier",
    // Matches the order_id createReplacementShipment sends.
    reference: (returnRequest) => `${returnRequest.returnNumber}-REP`,
  },
};

// A claim younger than this with no recorded error is most likely a booking still in
// flight (Shiprocket's login + create timeouts add up to ~35s). Releasing it then would
// let a second booking start alongside the first, so the release endpoint refuses.
const BOOKING_CLAIM_MIN_AGE_MS = 2 * 60 * 1000;

const MAX_BOOKING_ERROR_LENGTH = 500;
const bookingErrorText = (error) =>
  String(error?.message || error || "Unknown error").slice(0, MAX_BOOKING_ERROR_LENGTH);

/**
 * True only when we can be sure Shiprocket did NOT create a shipment.
 *
 * Deliberately narrow and defensive about the error's shape. `ShiprocketError.statusCode`
 * is OUR mapping, not Shiprocket's status: an upstream 4xx validation failure becomes 400,
 * but an auth failure becomes 502 and an unreachable API 503 — and a bare upstream 4xx
 * currently maps to 502 as well, so it is treated as unknown unless the error also carries
 * the upstream `httpStatus`. `phase === "pre_request"` marks a failure before anything
 * was sent. Anything we cannot classify is treated as "may have been booked".
 */
const isDefiniteBookingRefusal = (error) => {
  if (!(error instanceof ShiprocketError) && error?.name !== "ShiprocketError") return false;
  if (error.phase === "pre_request") return true;
  if (error.statusCode === 400 || error.statusCode === 409) return true;
  const upstream = Number(error.httpStatus);
  // 408 and 429 say nothing about whether the create went through.
  return Number.isFinite(upstream) && upstream >= 400 && upstream < 500 && upstream !== 408 && upstream !== 429;
};

/**
 * Optionally asks Shiprocket to assign the AWB of a leg just booked.
 *
 * Behind `reverseAutoAwbEnabled` (off by default): the return flavour of assign-AWB
 * (`is_return: 1`) is not contractually documented to us. With the switch off nothing
 * here runs and AWBs arrive through the reconciler's sync or are entered by hand.
 *
 * Never throws and never fails the booking — the parcel IS booked by now. The AWB is
 * stored only if the leg still has none, so it can never overwrite one an admin or the
 * reconciler recorded meanwhile.
 *
 * @returns {Promise<object|null>} the updated return when an AWB was stored, else null
 */
const autoAssignLegAwb = async (leg, returnId, shipmentId) => {
  try {
    const settings = await ShiprocketSetting.getSettings();
    if (settings.reverseAutoAwbEnabled !== true) return null;
    const response = await assignAwb(shipmentId, null, { isReturn: leg === BOOKING_LEGS.pickup });
    const data = response?.response?.data || response?.data || response || {};
    const awb = String(data.awb_code || "").trim();
    if (!awb) return null;
    const courier = String(data.courier_name || "").trim();
    return await ReturnModel.findOneAndUpdate(
      { _id: returnId, [leg.awbField]: { $in: [null, ""] } },
      { $set: { [leg.awbField]: awb, ...(courier ? { [leg.courierField]: courier } : {}) } },
      { returnDocument: "after" },
    );
  } catch (error) {
    logLifecycleEvent("returns", "return_auto_awb_failed", {
      returnId: String(returnId),
      leg: leg.event,
      reason: error?.message || "unknown",
    });
    return null;
  }
};

const alreadyBookedBody = (leg, returnRequest) => ({
  success: true,
  message: `A ${leg.label} is already booked for this return.`,
  alreadyBooked: true,
  [leg.shipmentField]: returnRequest[leg.shipmentField] ?? null,
  [leg.awbField]: returnRequest[leg.awbField] || "",
  [leg.courierField]: returnRequest[leg.courierField] || "",
});

const isLegBooked = (leg, returnRequest) =>
  Boolean(returnRequest?.[leg.shipmentField]) || Boolean(returnRequest?.[leg.awbField]);

/**
 * The refusal for a leg whose claim is held by someone else.
 *
 * Two different situations share the claim: a booking genuinely in flight (no error yet),
 * and one whose outcome is unknown (an error was recorded and the claim kept). The second
 * needs a human to look in Shiprocket, so it says so.
 */
const claimHeldBody = (leg, returnRequest) => {
  const error = returnRequest[leg.errorField];
  if (error) {
    return {
      success: false,
      code: "BOOKING_OUTCOME_UNKNOWN",
      message: `An earlier ${leg.label} booking failed in a way that does not tell us whether Shiprocket created it (${error}). Check Shiprocket for an order with reference ${leg.reference(returnRequest)} before trying again. If there is none, use "allow rebooking" on this return.`,
      claimedAt: returnRequest[leg.claimField],
      bookingError: error,
    };
  }
  return {
    success: false,
    code: "BOOKING_IN_PROGRESS",
    message: `A ${leg.label} booking for this return is already in progress. Reload in a moment.`,
    claimedAt: returnRequest[leg.claimField],
  };
};

/**
 * Takes the leg's booking claim, or explains why it could not.
 *
 * `extraFilter` carries the leg's own preconditions (status, resolution type), so the
 * claim is only granted while they still hold — a read a moment earlier is not enough.
 */
const claimBooking = async (leg, returnRequest, extraFilter) => {
  const claimedAt = new Date();
  const claimed = await ReturnModel.findOneAndUpdate(
    {
      _id: returnRequest._id,
      ...extraFilter,
      [leg.shipmentField]: null,
      [leg.awbField]: { $in: [null, ""] },
      [leg.claimField]: null,
    },
    { $set: { [leg.claimField]: claimedAt } },
    { returnDocument: "after" },
  );
  if (claimed) return { claimedAt };

  // Lost the race (or the state moved). Re-read to say which, so the second click of a
  // double click gets "already booked" rather than a confusing conflict.
  const current = await ReturnModel.findById(returnRequest._id);
  if (current && isLegBooked(leg, current)) {
    return { response: { status: 200, body: alreadyBookedBody(leg, current) } };
  }
  if (current?.[leg.claimField]) {
    return { response: { status: 409, body: claimHeldBody(leg, current) } };
  }
  return {
    response: {
      status: 409,
      body: {
        success: false,
        message: "This return was updated by someone else a moment ago. Reload it and try again.",
        code: "RETURN_STATUS_CONFLICT",
      },
    },
  };
};

/**
 * Settles the claim after Shiprocket threw, and builds the response.
 *
 * Every write is filtered on OUR claim timestamp, so a claim that was released and
 * re-taken by someone else in the meantime is never touched.
 */
const settleFailedBooking = async (leg, returnRequest, claimedAt, error) => {
  const errorText = bookingErrorText(error);
  if (isDefiniteBookingRefusal(error)) {
    await ReturnModel.updateOne(
      { _id: returnRequest._id, [leg.claimField]: claimedAt },
      { $set: { [leg.claimField]: null, [leg.errorField]: errorText } },
    );
    return {
      status: error.statusCode && error.statusCode < 500 ? error.statusCode : 400,
      body: {
        success: false,
        code: "BOOKING_REFUSED",
        message: `Shiprocket refused the ${leg.label}: ${errorText}. Nothing was booked — fix the problem and try again.`,
      },
    };
  }

  await ReturnModel.updateOne(
    { _id: returnRequest._id, [leg.claimField]: claimedAt },
    { $set: { [leg.errorField]: errorText } },
  );
  logLifecycleError("returns", `${leg.event}_booking_outcome_unknown`, error, {
    returnId: String(returnRequest._id),
    reference: leg.reference(returnRequest),
  });
  return {
    status: Number(error?.statusCode) >= 500 ? error.statusCode : 502,
    body: {
      success: false,
      code: "BOOKING_OUTCOME_UNKNOWN",
      message: `We could not confirm whether Shiprocket booked the ${leg.label} (${errorText}). It may exist. Check Shiprocket for an order with reference ${leg.reference(returnRequest)} before trying again. If there is none, use "allow rebooking" on this return.`,
      bookingError: errorText,
    },
  };
};

/**
 * Records a booking whose own write-back missed because the return moved (or its claim
 * was released) while Shiprocket was working.
 *
 * The shipment exists either way, so its ids are recorded if the leg has none yet — an
 * unrecorded shipment is exactly what lets the next click book a second courier. The
 * return's status is left alone: overwriting whatever the concurrent change was would be
 * worse, and the shipment id is in the log so an operator can cancel it in Shiprocket.
 */
const recordOrphanBooking = async (leg, returnRequest, booking, event) => {
  await ReturnModel.updateOne(
    { _id: returnRequest._id, [leg.shipmentField]: null },
    {
      $set: {
        [leg.shipmentField]: booking.shipmentId,
        [leg.shiprocketOrderField]: booking.shiprocketOrderId,
        [leg.claimField]: null,
        [leg.errorField]: "",
      },
    },
  );
  logLifecycleError(
    "returns",
    event,
    new Error(`Shiprocket booked the ${leg.label} but the return had moved on`),
    { returnId: String(returnRequest._id), shipmentId: booking.shipmentId },
  );
  return {
    success: false,
    message: `The ${leg.label} was booked, but this return had already moved on. Reload it — and cancel the duplicate shipment in Shiprocket if needed.`,
    shipmentId: booking.shipmentId,
  };
};

/**
 * Books a courier to collect the returned goods from the customer.
 *
 * Shiprocket is asked FIRST and the return only moves to `pickup_scheduled` once the
 * booking exists — the same ordering as the NDR action. Moving first would show
 * "pickup scheduled" for a collection no courier ever agreed to. The booking itself is
 * claim-first; see BOOKING CLAIMS above.
 */
export const BookReturnPickup = async (req, res) => {
  const leg = BOOKING_LEGS.pickup;
  try {
    const prepared = await prepareReverseBooking(req.params.id);
    if (prepared.error) return res.status(prepared.error.status).json(prepared.error.body);
    const { returnRequest, order } = prepared;

    // Idempotent on the SHIPMENT ID. This used to check only pickupAwb, which booking
    // never writes, so a second click after a successful booking booked again.
    if (isLegBooked(leg, returnRequest)) {
      return res.status(200).json(alreadyBookedBody(leg, returnRequest));
    }
    if (returnRequest.status !== "approved") {
      return res.status(409).json({
        success: false,
        message: `A pickup can only be booked for an approved return. This one is ${returnRequest.status}.`,
        code: "RETURN_NOT_APPROVED",
      });
    }
    if (returnRequest[leg.claimField]) {
      return res.status(409).json(claimHeldBody(leg, returnRequest));
    }

    // The warehouse end of the journey. Resolved from Shiprocket's own pickup-location
    // list, so a name that is not registered there simply has no address and no pickup is
    // booked — the Phase A validation doing real work rather than only warning. A
    // read-only lookup, so it runs BEFORE the claim: there is nothing to release if it
    // fails, and a concurrent click repeating it costs nothing.
    const warehouse = await resolveWarehouseAddress();
    if (!warehouse.ok) {
      return res.status(409).json({
        success: false,
        message:
          "Your pickup location could not be resolved from Shiprocket, so there is no warehouse address to return the parcel to. Check Operations → Shipping.",
        code: "WAREHOUSE_ADDRESS_UNRESOLVED",
        reason: warehouse.reason,
      });
    }

    const claim = await claimBooking(leg, returnRequest, { status: "approved" });
    if (claim.response) return res.status(claim.response.status).json(claim.response.body);

    let booking;
    try {
      booking = await createReturnPickup({ returnRequest, order, warehouse: warehouse.address });
    } catch (error) {
      const failure = await settleFailedBooking(leg, returnRequest, claim.claimedAt, error);
      return res.status(failure.status).json(failure.body);
    }

    // ONE write: the ids, the status move and the claim release together, filtered on
    // both the source status and OUR claim. There is no moment where the shipment exists
    // in our records but the claim is free, or the claim is free but the ids are missing.
    const claimed = await ReturnModel.findOneAndUpdate(
      { _id: returnRequest._id, status: "approved", [leg.claimField]: claim.claimedAt },
      {
        $set: {
          status: "pickup_scheduled",
          pickupScheduledAt: new Date(),
          pickupShiprocketOrderId: booking.shiprocketOrderId,
          pickupShipmentId: booking.shipmentId,
          [leg.claimField]: null,
          [leg.errorField]: "",
        },
        $push: {
          statusHistory: {
            status: "pickup_scheduled",
            changedBy: req.user?.id || null,
            note: `Return pickup booked with Shiprocket (shipment ${booking.shipmentId})`,
          },
        },
      },
      { returnDocument: "after" },
    );

    if (!claimed) {
      const body = await recordOrphanBooking(
        leg,
        returnRequest,
        booking,
        "return_pickup_booked_but_status_moved",
      );
      return res.status(409).json(body);
    }

    logLifecycleEvent("returns", "return_pickup_booked", {
      returnId: String(claimed._id),
      shipmentId: booking.shipmentId,
    });
    const withAwb = await autoAssignLegAwb(leg, claimed._id, booking.shipmentId);
    return res.status(200).json({
      success: true,
      message: withAwb
        ? `Return pickup booked with AWB ${withAwb.pickupAwb}.`
        : "Return pickup booked. Its AWB will be fetched from Shiprocket once assigned, or you can enter it here.",
      returnRequest: withAwb || claimed,
    });
  } catch (error) {
    return res
      .status(error.statusCode || 500)
      .json({ success: false, message: error.message });
  }
};

/**
 * Books the outbound replacement parcel, WITHOUT dispatching the return.
 *
 * Deliberately separate from DispatchReplacement. That handler claims the status, deducts
 * outbound stock and rolls back if stock is short; adding an external booking inside it
 * would mean a Shiprocket failure had to unwind a stock movement too. Keeping them apart
 * means each step is independently retryable: book here, then dispatch with the AWB
 * Shiprocket assigns. Claim-first like the pickup — see BOOKING CLAIMS above. This leg
 * was the one most exposed: its "already booked" check also looked only at the AWB, and
 * its write-back filtered on the AWB being absent, so a double click booked two parcels
 * and BOTH writes succeeded, the second silently overwriting the first's ids.
 */
export const BookReplacementShipment = async (req, res) => {
  const leg = BOOKING_LEGS.replacement;
  try {
    const prepared = await prepareReverseBooking(req.params.id);
    if (prepared.error) return res.status(prepared.error.status).json(prepared.error.body);
    const { returnRequest, order } = prepared;

    if (isLegBooked(leg, returnRequest)) {
      return res.status(200).json(alreadyBookedBody(leg, returnRequest));
    }
    if (returnRequest.resolutionType !== "replacement") {
      return res.status(400).json({
        success: false,
        message: "This return is a refund, not a replacement",
        code: "NOT_A_REPLACEMENT",
      });
    }
    if (returnRequest.status !== "received") {
      return res.status(409).json({
        success: false,
        message: `A replacement parcel can only be booked once the returned item is marked "received". This return is ${returnRequest.status}.`,
        code: "RETURN_NOT_RECEIVED",
      });
    }
    if (returnRequest[leg.claimField]) {
      return res.status(409).json(claimHeldBody(leg, returnRequest));
    }

    const claim = await claimBooking(leg, returnRequest, {
      status: "received",
      resolutionType: "replacement",
    });
    if (claim.response) return res.status(claim.response.status).json(claim.response.body);

    let booking;
    try {
      booking = await createReplacementShipment({ returnRequest, order });
    } catch (error) {
      const failure = await settleFailedBooking(leg, returnRequest, claim.claimedAt, error);
      return res.status(failure.status).json(failure.body);
    }

    // No status change here — booking is not dispatching. The parcel is recorded so the
    // admin can see it is booked, and stock is still deducted at dispatch.
    const updated = await ReturnModel.findOneAndUpdate(
      { _id: returnRequest._id, status: "received", [leg.claimField]: claim.claimedAt },
      {
        $set: {
          replacementShiprocketOrderId: booking.shiprocketOrderId,
          replacementShipmentId: booking.shipmentId,
          [leg.claimField]: null,
          [leg.errorField]: "",
        },
      },
      { returnDocument: "after" },
    );
    if (!updated) {
      const body = await recordOrphanBooking(
        leg,
        returnRequest,
        booking,
        "replacement_booked_but_return_moved",
      );
      return res.status(409).json(body);
    }

    logLifecycleEvent("returns", "replacement_shipment_booked", {
      returnId: String(updated._id),
      shipmentId: booking.shipmentId,
    });
    const withAwb = await autoAssignLegAwb(leg, updated._id, booking.shipmentId);
    return res.status(200).json({
      success: true,
      message: withAwb
        ? `Replacement parcel booked with AWB ${withAwb.replacementAwb}. Dispatch it to deduct stock and notify the customer.`
        : "Replacement parcel booked. Its AWB will be fetched from Shiprocket once assigned (or enter it here); then dispatch the replacement to deduct stock and notify the customer.",
      returnRequest: withAwb || updated,
    });
  } catch (error) {
    return res
      .status(error.statusCode || 500)
      .json({ success: false, message: error.message });
  }
};

/**
 * Releases a booking claim that was KEPT because its outcome was unknown.
 *
 * This is the human decision the claim exists to force. Only an operator who has looked
 * in Shiprocket can say whether the timed-out booking exists; calling this asserts that it
 * does not, and re-opens the leg for booking. Refused when a shipment id or AWB is already
 * recorded (there is nothing to release — the leg is booked), and when a claim is young
 * and has no recorded error (a booking is most likely still in flight).
 *
 * Audited, and noted in the return's own history, because getting this wrong books a
 * second courier and the trail is how that gets traced back.
 */
const releaseBookingClaim = (leg) => async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid return id" });
    }
    const returnRequest = await ReturnModel.findById(req.params.id);
    if (!returnRequest) {
      return res.status(404).json({ success: false, message: "Return not found" });
    }
    if (isLegBooked(leg, returnRequest)) {
      return res.status(409).json({
        success: false,
        message: `This ${leg.label} is already booked (a shipment is recorded), so there is no claim to release.`,
        code: "ALREADY_BOOKED",
      });
    }
    const claimedAt = returnRequest[leg.claimField];
    if (!claimedAt) {
      return res.status(409).json({
        success: false,
        message: `No ${leg.label} booking is held for this return. You can book it normally.`,
        code: "NO_BOOKING_CLAIM",
      });
    }
    const lastError = returnRequest[leg.errorField];
    if (!lastError && Date.now() - new Date(claimedAt).getTime() < BOOKING_CLAIM_MIN_AGE_MS) {
      return res.status(409).json({
        success: false,
        message: `A ${leg.label} booking started moments ago and may still be in progress. Wait a couple of minutes, check Shiprocket, then try again.`,
        code: "BOOKING_IN_PROGRESS",
      });
    }

    // Filtered on the exact claim we just read, and on the leg still being unbooked, so a
    // booking that completes between the read and this write is never un-claimed.
    const note = `Admin checked Shiprocket and released the ${leg.label} booking claim, allowing rebooking` +
      (lastError ? ` (last error: ${lastError})` : "");
    const released = await ReturnModel.findOneAndUpdate(
      {
        _id: returnRequest._id,
        [leg.claimField]: claimedAt,
        [leg.shipmentField]: null,
        [leg.awbField]: { $in: [null, ""] },
      },
      {
        $set: { [leg.claimField]: null, [leg.errorField]: "" },
        $push: {
          statusHistory: {
            status: returnRequest.status,
            changedBy: req.user?.id || null,
            note,
          },
        },
      },
      { returnDocument: "after" },
    );
    if (!released) {
      return res.status(409).json({
        success: false,
        message: "This return was updated by someone else a moment ago. Reload it and try again.",
        code: "RETURN_STATUS_CONFLICT",
      });
    }

    await createAuditLog({
      admin: req.user?.id,
      action: "RELEASE_RETURN_BOOKING_CLAIM",
      module: "RETURN",
      targetId: released._id,
      targetName: released.returnNumber,
      description: note,
      req,
    });
    logLifecycleEvent("returns", "return_booking_claim_released", {
      returnId: String(released._id),
      leg: leg.event,
    });

    return res.status(200).json({
      success: true,
      message: `The ${leg.label} can be booked again.`,
      data: await populateReturnLean(ReturnModel.findById(released._id)),
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const ReleaseReturnPickupClaim = releaseBookingClaim(BOOKING_LEGS.pickup);
export const ReleaseReplacementBookingClaim = releaseBookingClaim(BOOKING_LEGS.replacement);

// The return statuses during which each leg's parcel is travelling and its AWB is the
// thing courier events will be matched by.
const AWB_LEG_STATUSES = { pickup: ["pickup_scheduled"], replacement: ["received"] };
const AWB_PATTERN = /^[A-Za-z0-9-]{4,64}$/;

/**
 * Records a return leg's AWB by hand.
 *
 * Booking a collection or replacement through Shiprocket stores only its order and
 * shipment ids; the AWB is assigned afterwards (in Shiprocket's dashboard, or by their
 * auto-assignment). Until it is recorded here no courier event can be matched to the
 * return — the webhook resolves return legs by AWB alone. The reconciler fetches it
 * automatically; this is the manual path for when an admin already has it in hand.
 *
 * Never overwrites a different AWB (that would re-point courier events to another
 * parcel); re-sending the same one is a no-op. Uniqueness across returns is enforced by
 * the existing unique partial indexes and reported as AWB_IN_USE.
 */
const recordReturnLegAwb = (leg, legName) => async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid return id" });
    }
    const awb = String(req.body?.awb ?? "").trim();
    const courier = String(req.body?.courier ?? "").trim().slice(0, 80);
    if (!AWB_PATTERN.test(awb)) {
      return res.status(400).json({
        success: false,
        code: "AWB_REQUIRED",
        message: "Enter the AWB exactly as the courier issued it (letters, digits and dashes, 4–64 characters).",
      });
    }

    const current = await ReturnModel.findById(req.params.id).lean();
    if (!current) return res.status(404).json({ success: false, message: "Return not found" });
    if (!AWB_LEG_STATUSES[legName].includes(current.status)) {
      return res.status(409).json({
        success: false,
        code: "RETURN_LEG_NOT_BOOKED",
        message: `An AWB for the ${leg.label} can only be recorded while the return is ${AWB_LEG_STATUSES[legName].join(" or ")} (this one is ${current.status}).`,
      });
    }
    if (current[leg.awbField]) {
      if (current[leg.awbField] === awb) {
        return res.status(200).json({
          success: true,
          message: "That AWB is already recorded.",
          data: await populateReturnLean(ReturnModel.findById(current._id)),
        });
      }
      return res.status(409).json({
        success: false,
        code: "AWB_ALREADY_RECORDED",
        message: `This ${leg.label} already has AWB ${current[leg.awbField]}. It is not replaced, because courier updates are matched by it.`,
      });
    }

    let updated;
    try {
      updated = await ReturnModel.findOneAndUpdate(
        { _id: current._id, status: current.status, [leg.awbField]: { $in: [null, ""] } },
        {
          $set: { [leg.awbField]: awb, ...(courier ? { [leg.courierField]: courier } : {}) },
          $push: {
            statusHistory: {
              status: current.status,
              changedBy: req.user?.id || null,
              note: `${leg.label[0].toUpperCase()}${leg.label.slice(1)} AWB ${awb} recorded${courier ? ` (${courier})` : ""}`,
            },
          },
        },
        { returnDocument: "after" },
      );
    } catch (error) {
      if (error?.code === 11000) {
        return res.status(409).json({
          success: false,
          code: "AWB_IN_USE",
          message: `AWB ${awb} is already recorded against another return.`,
        });
      }
      throw error;
    }
    if (!updated) {
      return res.status(409).json({
        success: false,
        code: "RETURN_STATUS_CONFLICT",
        message: "This return changed while you were editing it. Reload and try again.",
      });
    }

    await createAuditLog({
      admin: req.user?.id,
      action: "RECORD_RETURN_AWB",
      module: "RETURN",
      targetId: updated._id,
      targetName: updated.returnNumber,
      description: `Recorded ${leg.label} AWB ${awb}${courier ? ` (${courier})` : ""}`,
      req,
    });

    return res.status(200).json({
      success: true,
      message: `AWB recorded. Courier updates for this ${leg.label} will now be tracked.`,
      data: await populateReturnLean(ReturnModel.findById(updated._id)),
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

/** Fetches a booked leg's AWB from Shiprocket now, rather than waiting for the reconciler. */
const syncReturnLegAwbNow = (leg, legName) => async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid return id" });
    }
    const capabilities = await getShippingCapabilities();
    if (!capabilities.shipments || !capabilities.configured) {
      return res.status(409).json({
        success: false,
        code: "SHIPROCKET_NOT_IN_USE",
        message: "Shiprocket shipments are off or not connected, so the AWB cannot be fetched. Enter it manually instead.",
      });
    }
    const result = await syncReturnLegAwb(req.params.id, legName);
    if (!result.ok && result.reason === "not_found") {
      return res.status(404).json({ success: false, message: "Return not found" });
    }
    if (!result.ok && result.reason === "not_booked") {
      return res.status(409).json({
        success: false,
        code: "RETURN_LEG_NOT_BOOKED",
        message: `This ${leg.label} was not booked through Shiprocket, so there is no AWB to fetch.`,
      });
    }
    if (!result.ok && result.reason === "awb_belongs_to_another_shipment") {
      return res.status(409).json({
        success: false,
        code: "AWB_IN_USE",
        message: "Shiprocket returned an AWB that is already recorded against another return. Check the booking in Shiprocket.",
      });
    }
    const data = await populateReturnLean(ReturnModel.findById(req.params.id));
    if (!result.ok) {
      return res.status(200).json({
        success: true,
        synced: false,
        message: "Shiprocket has not assigned an AWB to this parcel yet. Assign one in Shiprocket, or try again later.",
        data,
      });
    }
    return res.status(200).json({
      success: true,
      synced: !result.alreadyRecorded,
      message: result.alreadyRecorded ? "The AWB was already recorded." : `AWB ${result.awbCode} fetched from Shiprocket.`,
      data,
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
};

export const RecordReturnPickupAwb = recordReturnLegAwb(BOOKING_LEGS.pickup, "pickup");
export const RecordReplacementAwb = recordReturnLegAwb(BOOKING_LEGS.replacement, "replacement");
export const SyncReturnPickupAwb = syncReturnLegAwbNow(BOOKING_LEGS.pickup, "pickup");
export const SyncReplacementAwb = syncReturnLegAwbNow(BOOKING_LEGS.replacement, "replacement");

/**
 * Records that the replacement parcel has physically gone out.
 *
 * This is the step that did not exist. A replacement used to be closed out in one
 * click ("replaced"), which stamped a timestamp and restocked the returned unit
 * while the replacement parcel had not been packed — the operator believed the case
 * was finished, the customer had nothing to track, and the outbound unit was never
 * taken off the shelf.
 *
 * Order of operations, and each step is deliberate:
 *
 *   1. validate, and require a courier + AWB — without them the customer has
 *      nothing to track, which is the whole point of the state
 *   2. CLAIM the status transition (received → replacement_dispatched) with the
 *      expected status in the FILTER, so of two concurrent dispatches exactly one
 *      proceeds. Same primitive AdminUpdateReturnStatus uses.
 *   3. deduct the OUTBOUND unit, itself claim-first on replacementStockDeductedAt
 *   4. restock the INBOUND unit if its condition was resellable — unchanged
 *      behaviour, just moved to the moment the replacement actually ships
 *
 * If the deduction fails for want of stock, the status claim is RELEASED and the
 * dispatch is refused: a replacement must never read as dispatched when no unit was
 * available to send. Money is untouched throughout — no refund row, no gateway
 * call, no change to the order's paymentStatus, and no change to the original
 * order's shipment.
 */
export const DispatchReplacement = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid return id" });
    }

    // Falls back to a courier/AWB already stored on the return, so an admin does not have
    // to retype details that are already recorded. Typing them by hand still works and
    // still wins — manual dispatch is unchanged.
    //
    // Note BookReplacementShipment does NOT store an AWB: Shiprocket assigns one later,
    // and syncing it back is Phase 4. So a parcel booked through Shiprocket arrives here
    // with a shipment id and no AWB, and the admin must type the AWB Shiprocket assigned.
    const booked = await ReturnModel.findById(req.params.id).select(
      "replacementCourier replacementAwb replacementShipmentId replacementBookingClaimedAt replacementBookingError",
    );
    const courier = String(req.body?.courier || booked?.replacementCourier || "").trim();
    const awb = String(req.body?.awb || booked?.replacementAwb || "").trim();
    const disposition = String(req.body?.disposition || "").trim().toLowerCase();
    const dispositionNote = String(req.body?.dispositionNote || "").trim();
    const adminNote = String(req.body?.adminNote || "").trim();

    // A booking still held by its claim may have created a Shiprocket parcel we have no
    // record of. Dispatching by hand on top of it would send the customer two units, so
    // the claim has to be resolved first (booked, refused, or released after a check).
    if (booked && !booked.replacementShipmentId && booked.replacementBookingClaimedAt) {
      return res.status(409).json({
        success: false,
        message: booked.replacementBookingError
          ? `A replacement booking with Shiprocket has an unknown outcome (${booked.replacementBookingError}). Check Shiprocket, then use "allow rebooking" on this return: if the parcel exists there, dispatch with its AWB; if not, book it again or dispatch by hand.`
          : "A replacement booking with Shiprocket is in progress for this return. Reload in a moment.",
        code: booked.replacementBookingError ? "BOOKING_OUTCOME_UNKNOWN" : "BOOKING_IN_PROGRESS",
      });
    }
    if (!awb && booked?.replacementShipmentId) {
      return res.status(400).json({
        success: false,
        message: `This replacement is booked in Shiprocket (shipment ${booked.replacementShipmentId}) but no AWB has been recorded yet. Assign the AWB in Shiprocket, then enter the courier and that AWB here to dispatch.`,
        code: "REPLACEMENT_AWB_NOT_ASSIGNED",
        replacementShipmentId: booked.replacementShipmentId,
      });
    }

    if (!courier || !awb) {
      return res.status(400).json({
        success: false,
        message:
          "Record the courier and the tracking (AWB) number for the replacement parcel — the customer is shown both.",
        code: "REPLACEMENT_TRACKING_REQUIRED",
      });
    }

    const returnRequest = await ReturnModel.findById(req.params.id);
    if (!returnRequest) {
      return res.status(404).json({ success: false, message: "Return not found" });
    }
    if (returnRequest.resolutionType !== "replacement") {
      return res.status(400).json({
        success: false,
        message: "This return is a refund, not a replacement",
        code: "NOT_A_REPLACEMENT",
      });
    }
    if (returnRequest.status !== "received") {
      return res.status(409).json({
        success: false,
        message: `A replacement can only be dispatched once the returned item is marked "received". This return is ${returnRequest.status}.`,
        code: "RETURN_NOT_RECEIVED",
        currentStatus: returnRequest.status,
      });
    }
    // The inbound condition is still an independent decision from the customer's
    // resolution, and it still has no default — the same gate AdminUpdateReturnStatus
    // applies when resolving a refund.
    if (!["resellable", "damaged"].includes(disposition)) {
      return res.status(400).json({
        success: false,
        message:
          'Record the condition of the returned goods: "resellable" puts them back into stock, "damaged" writes them off. The customer gets their replacement either way.',
        code: "DISPOSITION_REQUIRED",
      });
    }

    // ─── CLAIM ───────────────────────────────────────────────────────────────
    // Everything above was validated against a document read a moment ago, so two
    // concurrent dispatches could both pass it. The expected status in the filter
    // means exactly one wins and only one can reach the stock movement below.
    const claimed = await ReturnModel.findOneAndUpdate(
      { _id: returnRequest._id, status: "received" },
      { $set: { status: "replacement_dispatched" } },
      { returnDocument: "after" },
    );
    if (!claimed) {
      return res.status(409).json({
        success: false,
        message: "This return was updated by someone else a moment ago. Reload it and try again.",
        code: "RETURN_STATUS_CONFLICT",
      });
    }

    // ─── OUTBOUND STOCK ──────────────────────────────────────────────────────
    const deduction = await deductReplacementStock({ returnRequest: claimed });
    if (deduction.reason === "insufficient_stock") {
      // Release the claim. A dispatched replacement with no unit behind it would be
      // the same class of lie as a refund that never moved money.
      await ReturnModel.updateOne(
        { _id: claimed._id },
        { $set: { status: "received" } },
      );
      return res.status(409).json({
        success: false,
        message: `There is not enough stock to send ${deduction.quantity} replacement unit(s). Restock before dispatching.`,
        code: "INSUFFICIENT_REPLACEMENT_STOCK",
      });
    }

    claimed.replacementCourier = courier;
    claimed.replacementAwb = awb;
    claimed.replacementDispatchedAt = new Date();
    claimed.disposition = disposition;
    claimed.dispositionNote = dispositionNote;
    if (adminNote) claimed.adminNote = adminNote;
    claimed.statusHistory.push({
      status: "replacement_dispatched",
      changedBy: req.user.id,
      note: adminNote || `Dispatched via ${courier} (${awb})`,
    });
    await claimed.save();

    // ─── INBOUND STOCK ───────────────────────────────────────────────────────
    // Unchanged behaviour: restockReturnedItems refuses anything not explicitly
    // "resellable", and is claim-first on restockedAt. Together with the deduction
    // above, a resellable replacement nets zero stock movement and a damaged one
    // nets minus one.
    const restockedQuantity = await restockReturnedItems({ returnRequest: claimed });

    await notifyReturnUpdated({
      orderId: claimed.order,
      userId: claimed.user,
      status: "replacement_dispatched",
    });
    await createAuditLog({
      admin: req.user.id,
      action: "DISPATCH_REPLACEMENT",
      module: "RETURN",
      targetId: claimed._id,
      targetName: claimed.returnNumber,
      description:
        `Replacement dispatched via ${courier} (${awb}) — ${deduction.quantity || claimed.quantity} unit(s) out of stock` +
        (restockedQuantity > 0
          ? `, ${restockedQuantity} returned unit(s) back into stock`
          : `, returned goods written off as ${disposition}`),
      req,
    });

    return res.status(200).json({
      success: true,
      message: `Replacement dispatched via ${courier}. Tracking: ${awb}.`,
      data: await populateReturnLean(ReturnModel.findById(claimed._id)),
      stockDeducted: deduction.deducted ? deduction.quantity : 0,
      restockedQuantity,
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
};

/**
 * Confirms the customer has received the replacement, closing the case.
 *
 * Records only a timestamp — no stock moves (the unit left the shelf at dispatch)
 * and no money moves (a replacement never involves any). Repeat confirmations lose
 * the status claim and get the same 409 the rest of the module uses.
 */
export const ConfirmReplacementDelivery = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid return id" });
    }

    const returnRequest = await ReturnModel.findById(req.params.id);
    if (!returnRequest) {
      return res.status(404).json({ success: false, message: "Return not found" });
    }
    if (returnRequest.status !== "replacement_dispatched") {
      return res.status(409).json({
        success: false,
        message: `A replacement delivery can only be confirmed after it has been dispatched. This return is ${returnRequest.status}.`,
        code: "REPLACEMENT_NOT_DISPATCHED",
        currentStatus: returnRequest.status,
      });
    }

    const claimed = await ReturnModel.findOneAndUpdate(
      { _id: returnRequest._id, status: "replacement_dispatched" },
      { $set: { status: "replacement_delivered", replacementDeliveredAt: new Date() } },
      { returnDocument: "after" },
    );
    if (!claimed) {
      return res.status(409).json({
        success: false,
        message: "This return was updated by someone else a moment ago. Reload it and try again.",
        code: "RETURN_STATUS_CONFLICT",
      });
    }

    const adminNote = String(req.body?.adminNote || "").trim();
    if (adminNote) claimed.adminNote = adminNote;
    claimed.statusHistory.push({
      status: "replacement_delivered",
      changedBy: req.user.id,
      note: adminNote,
    });
    await claimed.save();

    await notifyReturnUpdated({
      orderId: claimed.order,
      userId: claimed.user,
      status: "replacement_delivered",
    });
    await createAuditLog({
      admin: req.user.id,
      action: "CONFIRM_REPLACEMENT_DELIVERY",
      module: "RETURN",
      targetId: claimed._id,
      targetName: claimed.returnNumber,
      description: `Replacement confirmed delivered${claimed.replacementAwb ? ` (${claimed.replacementAwb})` : ""}`,
      req,
    });

    return res.status(200).json({
      success: true,
      message: "Replacement marked as delivered.",
      data: await populateReturnLean(ReturnModel.findById(claimed._id)),
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
};
