import { isAuthSecurityEnabled, isRateLimitEnabled } from "../config/features.config.js";
import { incrementRateLimit } from "../utils/redis-rate-limit.service.js";

const buckets = new Map();

// Memory buckets are only swept when the map grows past this size, so a long
// running process with many distinct client keys does not leak indefinitely.
const MEMORY_BUCKET_SWEEP_THRESHOLD = 5000;

const getClientKey = (req) =>
  req.ip || req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown";

const sweepExpiredMemoryBuckets = (now) => {
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
};

const incrementMemoryBucket = ({ key, windowMs }) => {
  const now = Date.now();

  if (buckets.size > MEMORY_BUCKET_SWEEP_THRESHOLD) sweepExpiredMemoryBuckets(now);

  const bucket = buckets.get(key) || { count: 0, resetAt: now + windowMs };

  if (bucket.resetAt <= now) {
    bucket.count = 0;
    bucket.resetAt = now + windowMs;
  }

  bucket.count += 1;
  buckets.set(key, bucket);

  return bucket;
};

/**
 * Builds a rate limit middleware.
 *
 * Uses Redis when `RATE_LIMIT_STORE=redis` and falls back to an in-process
 * bucket, so a Redis outage degrades to per-instance limiting instead of
 * dropping the limit entirely.
 *
 * @param {object} options
 * @param {string} options.name Bucket namespace, keeps unrelated routes from sharing a counter.
 * @param {number} options.windowMs Window length in milliseconds.
 * @param {number} options.max Requests allowed per window.
 * @param {string} [options.message] Response message on limit.
 * @param {boolean} [options.perPath] Count each path separately within the namespace.
 * @param {() => boolean} [options.isEnabled] Override the default enablement check.
 */
export const createRateLimit = ({
  name,
  windowMs,
  max,
  message = "Too many requests. Please try again later.",
  perPath = false,
  isEnabled = isRateLimitEnabled,
}) => {
  return async (req, res, next) => {
    if (!isEnabled()) return next();

    const scope = perPath ? `${name}:${req.path}` : name;
    const key = `${scope}:${getClientKey(req)}`;
    const bucket =
      (await incrementRateLimit({ key, windowMs }).catch(() => null)) ||
      incrementMemoryBucket({ key, windowMs });

    const remaining = Math.max(0, max - bucket.count);
    res.setHeader("RateLimit-Limit", max);
    res.setHeader("RateLimit-Remaining", remaining);
    res.setHeader("RateLimit-Reset", Math.max(0, Math.ceil((bucket.resetAt - Date.now()) / 1000)));

    if (bucket.count > max) {
      res.setHeader("Retry-After", Math.max(1, Math.ceil((bucket.resetAt - Date.now()) / 1000)));
      return res.status(429).json({
        success: false,
        message,
      });
    }

    return next();
  };
};

const MINUTE = 60 * 1000;

/**
 * Credential endpoints: login, signup, password reset, OTP/2FA.
 * Stays on whenever either the rate limit or the auth security toggle is on, so
 * existing deployments that only set `AUTH_SECURITY_ENABLED` keep their limits.
 */
export const authRateLimit = createRateLimit({
  name: "auth",
  windowMs: 15 * MINUTE,
  max: 30,
  message: "Too many attempts. Please try again later.",
  perPath: true,
  isEnabled: () => isRateLimitEnabled() || isAuthSecurityEnabled(),
});

/** Write endpoints that create user content and are cheap to abuse. */
export const contentWriteRateLimit = createRateLimit({
  name: "content-write",
  windowMs: 10 * MINUTE,
  max: 20,
  message: "Too many submissions. Please slow down and try again shortly.",
});

/**
 * The feedback form, which accepts guests: the one unauthenticated write besides
 * contact, so it gets its own, tighter budget rather than sharing content-write's.
 */
export const feedbackRateLimit = createRateLimit({
  name: "feedback",
  windowMs: 10 * MINUTE,
  max: 5,
  message: "You have sent a lot of feedback in a short time. Please try again in a few minutes.",
});

/** Read endpoints that hit the database on every keystroke. */
export const searchRateLimit = createRateLimit({
  name: "search",
  windowMs: MINUTE,
  max: 120,
  message: "Too many search requests. Please slow down.",
});

/** Coupon validation, guarding against brute-force code discovery. */
export const couponRateLimit = createRateLimit({
  name: "coupon",
  windowMs: 10 * MINUTE,
  max: 25,
  message: "Too many coupon attempts. Please try again later.",
});

/** Payment intent creation and verification. */
export const paymentRateLimit = createRateLimit({
  name: "payment",
  windowMs: 10 * MINUTE,
  max: 40,
  message: "Too many payment attempts. Please try again in a few minutes.",
});

/**
 * Admin refund actions, which move real money irreversibly.
 *
 * Tighter than the customer-facing payment limit because the failure mode is
 * worse and the legitimate rate is far lower: no operator refunds more than a
 * handful of orders a minute by hand. The refund endpoint had NO limit at all
 * while every other payment route had one, which is what made a duplicate-refund
 * race cheap to trigger by simply clicking twice.
 *
 * This is a backstop, not the guard — the real protection is the atomic claim in
 * return-refund.service.js. Two layers on purpose: the limit caps how fast the
 * race can be attempted, the claim decides who wins it.
 */
export const refundRateLimit = createRateLimit({
  name: "refund",
  windowMs: MINUTE,
  max: 10,
  message: "Too many refund attempts. Please wait a moment and check the order before retrying.",
});

/**
 * Customer-initiated order actions: cancellation and return requests.
 *
 * Both are compare-and-swap protected now, but an unlimited endpoint is what made
 * those races cheap to drive in the first place — and a return request creates a
 * record an operator has to triage, so it is worth a ceiling on its own.
 */
export const orderActionRateLimit = createRateLimit({
  name: "order-action",
  windowMs: 10 * MINUTE,
  max: 20,
  message: "Too many cancellation or return attempts. Please try again in a few minutes.",
});

/**
 * Admin batch work is legitimate at volumes a customer's cancel never reaches —
 * an operator cancelling twenty orders after a supplier failure was hitting the
 * shared 20/10-min bucket above and reading the 429 as "cancellation is broken".
 * Separate bucket, higher ceiling; the endpoint behind it is still permission-
 * gated (orders:manage) and protected by an atomic status claim.
 */
export const adminOrderActionRateLimit = createRateLimit({
  name: "admin-order-action",
  windowMs: 10 * MINUTE,
  max: 100,
  message: "Too many order actions in a short time. Please pause briefly and try again.",
});

// "Run reconciliation now" makes a bounded batch of live Shiprocket calls per click.
// The scheduled pass already runs every few minutes, so a human needs this rarely; the
// limit stops a stuck mouse or a script turning it into a hammer on the courier API.
export const shippingReconcileRateLimit = createRateLimit({
  name: "shipping-reconcile",
  windowMs: 10 * MINUTE,
  max: 6,
  message: "Reconciliation was run several times just now. Wait a few minutes before running it again.",
});

// Checkout's COD pre-check: one live Shiprocket call per request. Generous enough for a
// customer editing their address a few times, low enough that the endpoint cannot be
// used to sweep PIN codes on the store's courier account.
export const serviceabilityRateLimit = createRateLimit({
  name: "serviceability",
  windowMs: 10 * MINUTE,
  max: 40,
  message: "Too many delivery checks in a short time. Please wait a moment and try again.",
});

// Product page PIN check. Anonymous, and an uncached PIN costs one live Shiprocket call
// (the COD hint), so it is capped like checkout's pre-check — higher, since browsing
// several books and re-checking is normal.
export const deliveryEstimateRateLimit = createRateLimit({
  name: "delivery-estimate",
  windowMs: 10 * MINUTE,
  max: 60,
  message: "Too many delivery checks in a short time. Please wait a moment and try again.",
});
