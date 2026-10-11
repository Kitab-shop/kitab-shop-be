/**
 * When did the courier say this happened?
 *
 * The answer drives the out-of-order guard: an event older than the newest one
 * already applied must not move the order's status. That guard is only as good as
 * this parser, so it is deliberately strict:
 *
 *   - Shiprocket's webhook `current_timestamp` arrives as "DD MM YYYY HH:mm:ss" and its
 *     scan / tracking-activity dates as "YYYY-MM-DD HH:mm:ss". Neither carries a zone.
 *     Both are courier-local, i.e. India Standard Time, and are read as +05:30 — NOT as
 *     the server's zone, which would shift every event by however far the VPS clock's
 *     zone is from IST.
 *   - An ISO string is accepted only with an explicit `Z` or offset.
 *   - There is NO fallback to `new Date(string)`. V8 accepts a great deal of junk and
 *     reads "05 06 2024" as May 6th; a guessed time is worse than none, because a wrong
 *     time can make a genuine newer event look stale and silently stop it applying.
 *   - Times in the future (beyond a few minutes of clock skew) or before 2020 are
 *     rejected as implausible.
 *
 * Anything unparseable returns null, and the caller then skips the ordering guard for
 * that event rather than inventing a time — in particular it never substitutes the
 * time WE received the event, since mixing server-receipt time with courier time is
 * exactly how a later real event ends up looking older than a stamped one.
 */

const IST_OFFSET_MINUTES = 5 * 60 + 30;
const EARLIEST_PLAUSIBLE = Date.UTC(2020, 0, 1);
const FUTURE_SKEW_MS = 10 * 60 * 1000;

const fromIstParts = (year, month, day, hour, minute, second) => {
  const values = [year, month, day, hour, minute, second].map(Number);
  if (!values.every(Number.isInteger)) return null;
  const [y, mo, d, h, mi, s] = values;
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  const utcMs = Date.UTC(y, mo - 1, d, h, mi, s) - IST_OFFSET_MINUTES * 60 * 1000;
  const date = new Date(utcMs);
  // Date.UTC rolls 31 February into March; a rolled date is not the date we were given.
  const check = new Date(utcMs + IST_OFFSET_MINUTES * 60 * 1000);
  if (check.getUTCDate() !== d || check.getUTCMonth() !== mo - 1) return null;
  return date;
};

// "23 05 2023 11:43:52" — day first, space/dash/slash separated.
const DAY_FIRST = /^(\d{2})[ \-/](\d{2})[ \-/](\d{4})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/;
// "2023-05-23 11:43:52" / "2023-05-23T11:43" — no zone.
const YEAR_FIRST = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/;
// ISO with an explicit zone only.
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/;

/**
 * @param {unknown} value
 * @param {{now?: number}} [options] `now` is injectable for tests.
 * @returns {Date|null}
 */
export const parseCourierTimestamp = (value, { now = Date.now() } = {}) => {
  if (value instanceof Date) return plausible(value, now);
  const text = String(value ?? "").trim();
  if (!text) return null;

  let date = null;
  let match = DAY_FIRST.exec(text);
  if (match) {
    date = fromIstParts(match[3], match[2], match[1], match[4], match[5], match[6] ?? 0);
  } else if ((match = YEAR_FIRST.exec(text))) {
    date = fromIstParts(match[1], match[2], match[3], match[4], match[5], match[6] ?? 0);
  } else if (ISO_WITH_ZONE.test(text)) {
    const ms = Date.parse(text);
    date = Number.isFinite(ms) ? new Date(ms) : null;
  }
  return date ? plausible(date, now) : null;
};

const plausible = (date, now) => {
  const ms = date.getTime();
  if (!Number.isFinite(ms) || ms < EARLIEST_PLAUSIBLE || ms > now + FUTURE_SKEW_MS) return null;
  return date;
};

/**
 * The event time of a Shiprocket webhook payload.
 *
 * The latest scan wins when scans are present, because `scans[].date` is the same
 * field family the tracking API's activity dates come from — so a webhook event and a
 * reconciler poll describing the same courier scan agree on its time. The top-level
 * `current_timestamp` is the fallback.
 *
 * @returns {Date|null}
 */
export const extractCourierEventTime = (payload = {}, options) => {
  const scans = Array.isArray(payload?.scans) ? payload.scans : [];
  let latest = null;
  for (const scan of scans) {
    const at = parseCourierTimestamp(scan?.date, options);
    if (at && (!latest || at > latest)) latest = at;
  }
  return latest || parseCourierTimestamp(payload?.current_timestamp, options);
};
