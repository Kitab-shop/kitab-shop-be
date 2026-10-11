/**
 * Shiprocket's numeric shipment status codes, grouped by what each family means
 * for an order here.
 *
 * Moved out of shipping.controller.js unchanged in spirit so the courier-event
 * pipeline (webhook AND reconciler) and the controller share one table without a
 * circular import. shipping.controller.js re-exports every name below, so existing
 * importers are unaffected.
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
export const RTO_RECEIVED_CODES = [10]; // RTO DELIVERED — the parcel is physically back
export const RTO_CODES = [9, 14, 40, 41, 46]; // initiated, acknowledged, RTO NDR / OFD / in transit
export const NDR_CODES = [21]; // UNDELIVERED — a delivery attempt failed
export const DELIVERED_CODES = [7];
export const OUT_FOR_DELIVERY_CODES = [17];
// 19 ("Out For Pickup") and 27 ("Pickup Booked") used to sit here. Both describe a
// parcel still at the seller's door, and mapping them to Shipped did real harm: an
// order moved to Shipped can no longer be cancelled by an admin, so a courier merely
// being ON ITS WAY to collect locked the order. They now change no status — the raw
// status is still recorded — and the next genuine movement (18 in transit, 42 picked
// up, 6 shipped) advances the order. That is correct whichever way Shiprocket's
// published meaning of the two codes is finally confirmed, which is why it was the
// change to make while their exact labels remain unverified (docs/003).
export const SHIPPED_CODES = [6, 18, 38, 42];
// Pickup-stage codes: recorded, deliberately never a status.
export const PICKUP_STAGE_CODES = [19, 27];

/**
 * Codes that mean the parcel's journey went wrong in a way no status of ours
 * expresses.
 *
 * Deliberately NOT mapped to an order status. "Cancelled" carries restock and
 * refund compensation that a bare status write does not perform — which is why
 * ORDER_STATUS_TRANSITIONS documents the webhook as never mapping to it — and
 * there is no status at all for goods lost or destroyed in transit. They are
 * persisted against the order (`shiprocket.exception`) and listed in the admin's
 * shipping-exceptions queue, rather than only logged.
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

/** Exception codes that, on an order WE already cancelled, confirm the courier did too. */
export const COURIER_CANCELLED_CODES = [8, 45];

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

export const mapOrderStatus = (statusCode, currentStatus) => {
  const text = currentStatus || "";
  // Checked BEFORE the generic RTO test, which would otherwise swallow it — the
  // arrival event's text also contains "RTO".
  if (isRtoReceived(statusCode, text)) return "RTO Received";
  // A pickup-stage code is authoritative even when its text would match below:
  // "Pickup Booked" must never be read as anything a parcel in transit does.
  if (PICKUP_STAGE_CODES.includes(statusCode)) return null;
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
  // caller records them instead of writing a status the compensation logic never ran.
  return null;
};
