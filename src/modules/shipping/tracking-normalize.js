import { parseCourierTimestamp } from "./courier-event-time.js";

/**
 * Turns a Shiprocket tracking response into the two things this system needs from it:
 * a courier EVENT the status pipeline can apply (for the reconciler), and a customer
 * TIMELINE (for the order page, which used to print the raw JSON).
 *
 * The response shape is not contractually documented to us, so this reads it
 * defensively and never invents a status:
 *
 *   - `/courier/track/awb/{awb}` has been seen both bare (`{tracking_data: …}`) and
 *     keyed by AWB (`{"<awb>": {tracking_data: …}}`); both are accepted.
 *   - The numeric `shipment_status` is the status code the webhook also carries
 *     (`shipment_status_id`), so the reconciler and the webhook map through the same
 *     table. The current-status TEXT comes from `shipment_track[0].current_status`.
 *   - `track_status: 0` means Shiprocket has no tracking yet; that is "nothing to
 *     apply", not an error and not a status.
 *
 * Every field the caller cannot rely on comes back null rather than defaulted.
 */

const firstObject = (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : null);

const unwrapTrackingData = (response, awbCode) => {
  const root = firstObject(response);
  if (!root) return null;
  if (firstObject(root.tracking_data)) return root.tracking_data;
  if (awbCode && firstObject(root[awbCode]?.tracking_data)) return root[awbCode].tracking_data;
  // A single-key object wrapping one AWB we were not told about.
  const keys = Object.keys(root);
  if (keys.length === 1 && firstObject(root[keys[0]]?.tracking_data)) return root[keys[0]].tracking_data;
  return null;
};

const toCode = (value) => {
  const code = Number(value);
  return Number.isInteger(code) && code > 0 ? code : null;
};

const text = (value) => {
  const result = String(value ?? "").trim();
  return result || null;
};

/**
 * @returns {{
 *   hasTracking: boolean,
 *   awbCode: string|null,
 *   courierName: string|null,
 *   statusCode: number|null,
 *   currentStatus: string|null,
 *   etd: string|null,
 *   eventAt: Date|null,
 *   activities: Array<{at: string|null, activity: string|null, location: string|null, status: string|null}>,
 * }}
 */
export const normalizeTracking = (response, { awbCode = null, now } = {}) => {
  const tracking = unwrapTrackingData(response, awbCode);
  const empty = {
    hasTracking: false,
    awbCode: awbCode || null,
    courierName: null,
    statusCode: null,
    currentStatus: null,
    etd: null,
    eventAt: null,
    activities: [],
  };
  if (!tracking) return empty;

  const track = Array.isArray(tracking.shipment_track) ? firstObject(tracking.shipment_track[0]) : null;
  const rawActivities = Array.isArray(tracking.shipment_track_activities)
    ? tracking.shipment_track_activities
    : [];

  let eventAt = null;
  const activities = rawActivities
    .map((entry) => {
      const at = parseCourierTimestamp(entry?.date, now === undefined ? undefined : { now });
      if (at && (!eventAt || at > eventAt)) eventAt = at;
      return {
        at: at ? at.toISOString() : null,
        activity: text(entry?.activity),
        location: text(entry?.location),
        status: text(entry?.["sr-status-label"] ?? entry?.status),
      };
    })
    // Newest first, undated entries last — the order a customer reads a timeline in.
    .sort((a, b) => (b.at || "").localeCompare(a.at || ""));

  const statusCode = toCode(tracking.shipment_status);
  const currentStatus = text(track?.current_status);
  const hasTracking = Number(tracking.track_status) === 1 || Boolean(statusCode || currentStatus);

  return {
    hasTracking,
    awbCode: text(track?.awb_code) || awbCode || null,
    courierName: text(track?.courier_name),
    statusCode,
    currentStatus,
    etd: text(tracking.etd ?? track?.edd),
    eventAt,
    activities,
  };
};

/**
 * The customer-facing subset. Deliberately excludes anything Shiprocket returns about
 * the consignee (addresses, phone numbers) — the raw payload used to be printed whole.
 */
export const toCustomerTracking = (normalized) => ({
  currentStatus: normalized.currentStatus,
  courierName: normalized.courierName,
  etd: normalized.etd,
  activities: normalized.activities.slice(0, 50),
});
