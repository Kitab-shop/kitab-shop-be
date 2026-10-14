import { getCourierDeliveryDays, getShippingCapabilities } from "../shipping/shiprocket.service.js";
import { getDeliveryRange } from "./product-query.service.js";

// Courier quotes are counted from pickup, not from the order: the parcel still has to be
// packed and handed over. One day covers that.
export const DISPATCH_BUFFER_DAYS = 1;

const TTL_MS = 30 * 60 * 1000;
const MAX_ENTRIES = 5000;
const cache = new Map();

/** Test hook: drop every remembered courier quote. */
export const clearDeliveryRangeCache = () => cache.clear();

const fromCourierQuotes = async (pincode) => {
  const cached = cache.get(pincode);
  if (cached && cached.expiresAt > Date.now()) return cached.range;

  const quote = await getCourierDeliveryDays({ deliveryPostcode: pincode });
  if (!quote.ok) return null;

  const minDays = quote.fastestDays + DISPATCH_BUFFER_DAYS;
  const range = { minDays, maxDays: Math.max(minDays, quote.expectedDays + DISPATCH_BUFFER_DAYS) };
  if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value);
  cache.set(pincode, { range, expiresAt: Date.now() + TTL_MS });
  return range;
};

/**
 * Delivery days for the product page's PIN check.
 *
 * Courier quotes from Shiprocket when the store actually ships through it; the PIN-prefix
 * table otherwise. "Otherwise" covers Shiprocket being off or set to manual fulfilment
 * (its couriers are not the ones carrying the parcel), no credentials, an outage, and a
 * PIN no courier serves — such an order can still be shipped by hand, and the table is
 * the honest guess for that. Only real quotes are cached, so a blip is retried next time.
 *
 * Anonymous and public, hence the cache: without it every click would spend the store's
 * Shiprocket API quota.
 *
 * @returns {Promise<{minDays: number, maxDays: number, source: "courier" | "estimate"}>}
 */
export const getDeliveryDaysForPincode = async (pincode) => {
  try {
    const { shipments } = await getShippingCapabilities();
    if (shipments) {
      const range = await fromCourierQuotes(pincode);
      if (range) return { ...range, source: "courier" };
    }
  } catch {
    // Fall through: a lookup failure must never cost the customer an estimate.
  }
  return { ...getDeliveryRange(pincode), source: "estimate" };
};
