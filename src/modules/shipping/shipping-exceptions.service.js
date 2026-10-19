import OrderModel from "../orders/Order.model.js";
import ReturnModel from "../returns/return.model.js";
import ShiprocketSetting from "./ShiprocketSetting.model.js";
import { SHIPMENT_CANCELLATION_PENDING } from "../orders/order-shipping.service.js";

/**
 * Everything in fulfilment that is waiting on a person, in one list.
 *
 * Each failure mode below already had a safe, recorded state — that was the point of
 * making creation claim-guarded, cancellation retryable and courier exceptions
 * persistent — but a recorded state nobody looks at is just a slower way to lose
 * money. This turns them into a queue an operator can work through, with what happened,
 * since when, and what to do.
 *
 * DERIVED, not stored: every category is a query over fields the workflows already
 * maintain. A separate "exceptions" collection would be one more copy of the truth,
 * free to say an order needs attention after it has been fixed (or the reverse). Here
 * the item disappears the moment the underlying state is resolved, by whatever path.
 *
 * Uses find().limit() rather than counts, and reports `capped` when a category has more
 * than it shows — a truncated list that looks complete is how a queue under-reports.
 */

const LIMIT = 50;
const STALE_CLAIM_MS = 10 * 60 * 1000;
const STALE_SHIPMENT_MS = 3 * 24 * 60 * 60 * 1000;
const IN_TRANSIT = ["Shipped", "Out For Delivery", "NDR", "RTO"];
const FINISHED = ["Delivered", "Completed", "Closed", "Cancelled"];

const ORDER_FIELDS =
  "_id orderStatus paymentMethod paymentStatus totalAmount createdAt updatedAt shiprocket.orderId shiprocket.awbCode shiprocket.syncStatus shiprocket.lastError shiprocket.claimedAt shiprocket.cancelAttempts shiprocket.amountCheck shiprocket.exception shiprocket.lastSyncedAt shiprocket.ndrReason shipment.trackingNumber shipment.carrierName";

const orderItem = (order, detail, since) => ({
  kind: "order",
  orderId: String(order._id),
  orderStatus: order.orderStatus,
  paymentMethod: order.paymentMethod,
  paymentStatus: order.paymentStatus,
  totalAmount: order.totalAmount,
  awbCode: order.shiprocket?.awbCode || order.shipment?.trackingNumber || null,
  shiprocketOrderId: order.shiprocket?.orderId || null,
  detail: detail || null,
  since: since || order.updatedAt || order.createdAt || null,
});

const returnItem = (ret, leg, detail, since) => ({
  kind: "return",
  returnId: String(ret._id),
  returnNumber: ret.returnNumber,
  orderId: ret.order ? String(ret.order) : null,
  returnStatus: ret.status,
  leg,
  detail: detail || null,
  since: since || ret.updatedAt || ret.createdAt || null,
});

const findLimited = async (model, filter, select, sort = { updatedAt: 1 }) => {
  const rows = await model.find(filter).select(select).sort(sort).limit(LIMIT + 1).lean();
  return { rows: rows.slice(0, LIMIT), capped: rows.length > LIMIT };
};

/**
 * @returns {Promise<{generatedAt: Date, total: number, categories: Array<object>}>}
 */
export const buildShippingExceptions = async ({ now = Date.now() } = {}) => {
  const settings = await ShiprocketSetting.getSettings();
  const maxRetryAttempts = Number(settings.maxRetryAttempts) || 5;

  const definitions = [
    {
      key: "creation_unknown",
      label: "Shipment creation outcome unknown",
      severity: "critical",
      action:
        "Search Shiprocket for the order id. If the shipment exists, link it on the order page; if not, confirm it was not created, then create it again.",
      load: async () => {
        const { rows, capped } = await findLimited(
          OrderModel,
          {
            "shiprocket.syncStatus": "creating",
            "shiprocket.claimedAt": { $lt: new Date(now - STALE_CLAIM_MS) },
          },
          ORDER_FIELDS,
        );
        return {
          capped,
          items: rows.map((o) => orderItem(o, o.shiprocket?.lastError, o.shiprocket?.claimedAt)),
        };
      },
    },
    {
      key: "amount_mismatch",
      label: "COD amount at Shiprocket differs from the order",
      severity: "critical",
      action:
        "Compare the amounts. Fix the order in Shiprocket (or cancel and re-create it), then acknowledge on the order page. AWB assignment is blocked until then.",
      load: async () => {
        const { rows, capped } = await findLimited(
          OrderModel,
          {
            // Only COD needs action: nothing is collected on a prepaid order, and its
            // mismatch does not block the AWB.
            paymentMethod: "COD",
            "shiprocket.amountCheck.status": "mismatch",
            "shiprocket.amountCheck.acknowledgedAt": null,
            orderStatus: { $nin: FINISHED },
          },
          ORDER_FIELDS,
        );
        return {
          capped,
          items: rows.map((o) =>
            orderItem(
              o,
              `Expected ₹${o.shiprocket?.amountCheck?.expected}, Shiprocket holds ₹${o.shiprocket?.amountCheck?.reported}`,
              o.shiprocket?.amountCheck?.checkedAt,
            ),
          ),
        };
      },
    },
    {
      key: "cod_amount_unconfirmed",
      label: "COD amount at Shiprocket not confirmed",
      severity: "high",
      action:
        "Shiprocket's figure leaves out shipping. Check the COD amount in Shiprocket, then assign the AWB from the order page. Automatic AWB assignment is held until then.",
      load: async () => {
        const { rows, capped } = await findLimited(
          OrderModel,
          {
            paymentMethod: "COD",
            "shiprocket.amountCheck.status": "unverified",
            "shiprocket.amountCheck.reason": "goods_only_total",
            "shiprocket.awbCode": { $in: [null, ""] },
            orderStatus: { $nin: FINISHED },
          },
          ORDER_FIELDS,
        );
        return {
          capped,
          items: rows.map((o) =>
            orderItem(
              o,
              `Shiprocket shows ₹${o.shiprocket?.amountCheck?.reported}, expected ₹${o.shiprocket?.amountCheck?.expected}`,
              o.shiprocket?.amountCheck?.checkedAt,
            ),
          ),
        };
      },
    },
    {
      key: "cancel_pending",
      label: "Cancelled here, still live at the courier",
      severity: "high",
      action:
        "Retry the courier cancellation from the order page. If retries are exhausted, cancel it in Shiprocket's dashboard, then retry here to record it.",
      load: async () => {
        const { rows, capped } = await findLimited(OrderModel, SHIPMENT_CANCELLATION_PENDING, ORDER_FIELDS);
        return {
          capped,
          items: rows.map((o) => {
            const attempts = Number(o.shiprocket?.cancelAttempts || 0);
            return orderItem(
              o,
              attempts >= maxRetryAttempts
                ? `Automatic retries exhausted (${attempts}). ${o.shiprocket?.lastError || ""}`.trim()
                : o.shiprocket?.lastError || `Pending courier cancellation (${attempts} automatic attempt(s) so far)`,
            );
          }),
        };
      },
    },
    {
      key: "creation_failed",
      label: "Shipment creation failed",
      severity: "high",
      action: "Read the error, fix the cause (address, pickup location, credentials), then create the shipment again.",
      load: async () => {
        const { rows, capped } = await findLimited(
          OrderModel,
          { "shiprocket.syncStatus": "failed", orderStatus: { $in: ["Confirmed", "Packed"] } },
          ORDER_FIELDS,
        );
        return { capped, items: rows.map((o) => orderItem(o, o.shiprocket?.lastError, o.shiprocket?.lastSyncedAt)) };
      },
    },
    {
      key: "courier_exception",
      label: "Courier reported a problem",
      severity: "high",
      action:
        "Check the parcel in Shiprocket. Lost, damaged or destroyed parcels need a claim with the courier and a decision on the customer's order.",
      load: async () => {
        const { rows, capped } = await findLimited(
          OrderModel,
          { "shiprocket.exception.meaning": { $type: "string" }, orderStatus: { $nin: FINISHED } },
          ORDER_FIELDS,
        );
        return {
          capped,
          items: rows.map((o) =>
            orderItem(
              o,
              `${o.shiprocket.exception.meaning}${o.shiprocket.exception.code ? ` (code ${o.shiprocket.exception.code})` : ""}`,
              o.shiprocket.exception.at,
            ),
          ),
        };
      },
    },
    {
      key: "ndr_open",
      label: "Failed delivery awaiting a decision",
      severity: "medium",
      action: "Ask the courier to re-attempt or return the parcel, from the order page.",
      load: async () => {
        const { rows, capped } = await findLimited(OrderModel, { orderStatus: "NDR" }, ORDER_FIELDS);
        return { capped, items: rows.map((o) => orderItem(o, o.shiprocket?.ndrReason)) };
      },
    },
    {
      key: "rto_awaiting_disposition",
      label: "Returned parcel awaiting inspection",
      severity: "medium",
      action: "Open the parcel, record its condition, settle any refund owed, then close the order.",
      load: async () => {
        const { rows, capped } = await findLimited(
          OrderModel,
          { orderStatus: "RTO Received", rtoDisposition: { $in: [null, ""] } },
          ORDER_FIELDS,
        );
        return { capped, items: rows.map((o) => orderItem(o)) };
      },
    },
    {
      key: "stale_shipment",
      label: "No courier update for 3+ days",
      severity: "medium",
      action:
        "Check tracking in Shiprocket. The reconciler polls these automatically; one that stays here may have a wrong AWB.",
      load: async () => {
        const { rows, capped } = await findLimited(
          OrderModel,
          {
            orderStatus: { $in: IN_TRANSIT },
            "shiprocket.awbCode": { $type: "string" },
            "shiprocket.lastSyncedAt": { $lt: new Date(now - STALE_SHIPMENT_MS) },
          },
          ORDER_FIELDS,
          { "shiprocket.lastSyncedAt": 1 },
        );
        return { capped, items: rows.map((o) => orderItem(o, null, o.shiprocket?.lastSyncedAt)) };
      },
    },
    {
      key: "return_booking_unknown",
      label: "Return courier booking outcome unknown",
      severity: "high",
      action:
        "Search Shiprocket for the return reference. If a booking exists, record its AWB; if not, allow rebooking from the Returns page.",
      load: async () => {
        const [pickups, replacements] = await Promise.all([
          findLimited(
            ReturnModel,
            {
              pickupBookingClaimedAt: { $ne: null, $lt: new Date(now - STALE_CLAIM_MS) },
              pickupShipmentId: null,
            },
            "_id returnNumber order status pickupBookingClaimedAt pickupBookingError updatedAt createdAt",
          ),
          findLimited(
            ReturnModel,
            {
              replacementBookingClaimedAt: { $ne: null, $lt: new Date(now - STALE_CLAIM_MS) },
              replacementShipmentId: null,
            },
            "_id returnNumber order status replacementBookingClaimedAt replacementBookingError updatedAt createdAt",
          ),
        ]);
        return {
          capped: pickups.capped || replacements.capped,
          items: [
            ...pickups.rows.map((r) => returnItem(r, "pickup", r.pickupBookingError, r.pickupBookingClaimedAt)),
            ...replacements.rows.map((r) =>
              returnItem(r, "replacement", r.replacementBookingError, r.replacementBookingClaimedAt),
            ),
          ],
        };
      },
    },
    {
      key: "return_awaiting_awb",
      label: "Return parcel booked without an AWB",
      severity: "medium",
      action:
        "The reconciler fetches AWBs automatically once Shiprocket assigns one. If it has been assigned in Shiprocket, record or sync it from the Returns page.",
      load: async () => {
        const [pickups, replacements] = await Promise.all([
          findLimited(
            ReturnModel,
            { status: "pickup_scheduled", pickupShipmentId: { $type: "number" }, pickupAwb: { $in: [null, ""] } },
            "_id returnNumber order status pickupShipmentId updatedAt createdAt",
          ),
          findLimited(
            ReturnModel,
            {
              status: "received",
              replacementShipmentId: { $type: "number" },
              replacementAwb: { $in: [null, ""] },
            },
            "_id returnNumber order status replacementShipmentId updatedAt createdAt",
          ),
        ]);
        return {
          capped: pickups.capped || replacements.capped,
          items: [
            ...pickups.rows.map((r) => returnItem(r, "pickup", `Shiprocket shipment ${r.pickupShipmentId}`)),
            ...replacements.rows.map((r) =>
              returnItem(r, "replacement", `Shiprocket shipment ${r.replacementShipmentId}`),
            ),
          ],
        };
      },
    },
  ];

  const categories = await Promise.all(
    definitions.map(async ({ load, ...meta }) => {
      const { items, capped } = await load();
      return { ...meta, count: items.length, capped, items };
    }),
  );

  return {
    generatedAt: new Date(now),
    total: categories.reduce((sum, category) => sum + category.count, 0),
    categories,
  };
};
