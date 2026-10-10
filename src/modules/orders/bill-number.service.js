/**
 * Bill-of-supply numbering.
 *
 * "Bill of supply" and not "tax invoice", deliberately: printed books are nil-rated
 * (HSN 4901) and this seller is not GST-registered, so there is no tax line and no
 * GSTIN to print. What a bill of supply still needs is a serial that identifies one
 * document for the rest of its life — quotable in a refund, a payment dispute or an
 * audit — which an order's ObjectId is not.
 *
 * The contract this module provides:
 *
 *   1. A number is assigned exactly once per order, on delivery, and never changes.
 *   2. Numbers within a financial year are strictly increasing and never reused.
 *   3. The seller's identity is snapshotted at issue time, so editing the footer
 *      later cannot rewrite what an already-issued bill says.
 *
 * Note what is NOT promised: gaps. See allocate().
 */
import { Types } from "mongoose";
import BillCounter from "./BillCounter.model.js";
import OrderModel from "./Order.model.js";
import FooterSetting from "../footer/FooterSetting.model.js";
import { logLifecycleEvent, logLifecycleError } from "../../utils/lifecycle-logger.service.js";

export const BILL_NUMBER_PREFIX = "RB";

/** How many times to retry a lost race before giving up. */
const MAX_ATTEMPTS = 3;

/**
 * The Indian financial year (1 Apr - 31 Mar) containing `date`, as "2026-27".
 *
 * Computed in IST, and that is the single most important line in this file. The
 * server runs in UTC, and 2027-03-31T22:30:00Z IS 2027-04-01 05:00 IST — UTC month
 * arithmetic files it under 2026-27 while Indian law puts it in 2027-28. A bill
 * number is immutable once issued, so getting this wrong is not a bug you can fix
 * afterwards; you would have real bills sitting in the wrong series forever.
 *
 * Intl with an explicit timeZone rather than a manual +5:30 offset because it is
 * self-documenting, and IST observes no DST so the result is deterministic.
 */
export const financialYear = (date = new Date()) => {
  const [year, month] = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
  })
    .format(date)
    .split("-")
    .map(Number);

  const startYear = month >= 4 ? year : year - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`;
};

/**
 * "RB/2026-27/0001".
 *
 * Padded to four digits for legibility, but never truncated — the 10000th bill of a
 * year renders as RB/2026-27/10000. Sorting cosmetics are not worth a collision.
 */
export const formatBillNumber = (fy, seq) =>
  `${BILL_NUMBER_PREFIX}/${fy}/${String(seq).padStart(4, "0")}`;

/**
 * Hand out the next sequence for a financial year.
 *
 * findOneAndUpdate + $inc, which is atomic on a single document: twenty concurrent
 * deliveries get twenty distinct numbers because MongoDB serialises the increments.
 * It must NEVER be rewritten as findOne-then-save — that reintroduces exactly the
 * read-modify-write window this avoids.
 *
 * The one genuine race is the FIRST mint of a new financial year, where two callers
 * both find no document and both take the upsert branch. The unique index on
 * financialYear makes one of them lose with E11000; the retry then finds the
 * winner's document and $incs it normally.
 *
 * GAPS ARE ACCEPTED, DELIBERATELY. If the order write below fails after this
 * increment, the number is burned and never issued to anyone. Closing that hole
 * would need a distributed lock, or the counter inside the order's transaction —
 * and the latter is actively worse here, because session.withTransaction re-runs
 * its callback on WriteConflict (see order.controller.js) so a retry would burn a
 * number anyway, while serialising every concurrent delivery on one document. A
 * gapped, strictly-increasing, never-reused series is defensible in a book of
 * account; a reused number is not. The burn is logged so it is at least visible.
 */
const allocate = async (fy) => {
  let lastError = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      const counter = await BillCounter.findOneAndUpdate(
        { financialYear: fy },
        { $inc: { seq: 1 } },
        { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
      );
      return counter.seq;
    } catch (error) {
      // Two concurrent first-ever upserts for this year. Loop round: the winner's
      // document now exists, so the next pass takes the plain $inc path.
      if (error?.code !== 11000) throw error;
      lastError = error;
    }
  }

  throw lastError ?? new Error(`Could not allocate a bill number for ${fy}`);
};

/**
 * The seller block, snapshotted onto the bill at issue time.
 *
 * Read from FooterSetting.contact, which is the only place in the backend that
 * stores a postal address for the business.
 *
 * NOTE there is no separate name field there: the legal entity is the FIRST LINE of
 * contact.address ("Kitab Shop Commerce Pvt. Ltd.\nIDPL, Rishikesh,\n..."), so it is
 * split off here. That is worth knowing before editing the footer — an admin who
 * rewrites that block without a company line on top will start producing bills with
 * no seller name, and nothing will complain.
 *
 * Never throws: a missing or unreadable footer must not be able to block a delivery.
 */
export const sellerSnapshot = async () => {
  const empty = { name: "", address: "", phone: "", email: "" };

  try {
    const footer = await FooterSetting.findOne().lean();
    const contact = footer?.contact;
    if (!contact) return empty;

    const [name = "", ...rest] = String(contact.address || "").split("\n");
    return {
      name: name.trim(),
      address: rest.join("\n").trim(),
      phone: String(contact.phone || "").trim(),
      email: String(contact.email || "").trim(),
    };
  } catch (error) {
    logLifecycleError("orders", "bill_seller_snapshot_failed", error);
    return empty;
  }
};

/**
 * Assign this order its bill-of-supply number, if it does not have one.
 *
 * Idempotent by construction: the write is a compare-and-swap on
 * `{ _id, "bill.number": null }`, the same claim-in-filter shape the Closed
 * transition uses in order.controller.js. Re-delivering an order, a replayed
 * Shiprocket webhook, and an admin clicking Delivered twice are therefore all
 * no-ops AT THE DATABASE rather than in application logic — which is the only
 * place that holds under concurrency.
 *
 * @param {string|import("mongoose").Types.ObjectId} orderId
 * @param {{ now?: Date, source?: "delivery" | "backfill" }} [options]
 *   `now` is injectable so tests can drive a synthetic financial year instead of
 *   incrementing the live series.
 * @returns {Promise<{ number: string|null, minted: boolean, order?: object }>}
 */
export const ensureBillNumber = async (orderId, options = {}) => {
  const { now = new Date(), source = "delivery" } = options;

  // Fast path so the overwhelmingly common case — a replayed webhook on an
  // already-billed order — does not burn a sequence number. This is an
  // optimisation, NOT the guard; the CAS below is the guard.
  const existing = await OrderModel.findById(orderId).select("bill.number").lean();
  if (existing?.bill?.number) {
    return { number: existing.bill.number, minted: false };
  }
  if (!existing) {
    return { number: null, minted: false };
  }

  const seller = await sellerSnapshot();
  const fy = financialYear(now);

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const sequence = await allocate(fy);
    const number = formatBillNumber(fy, sequence);

    try {
      const claimed = await OrderModel.findOneAndUpdate(
        { _id: orderId, "bill.number": null },
        {
          $set: {
            bill: { number, financialYear: fy, sequence, issuedAt: now, source, seller },
          },
        },
        { returnDocument: "after" },
      );

      if (claimed) {
        logLifecycleEvent("orders", "bill_number_issued", {
          orderId: String(orderId),
          number,
          financialYear: fy,
        });
        return { number, minted: true, order: claimed };
      }

      // Someone else claimed this order between the fast path and here. Their
      // number stands; ours is burned.
      logLifecycleEvent("orders", "bill_number_burned", {
        orderId: String(orderId),
        financialYear: fy,
        sequence,
        reason: "order_already_claimed",
      });
      const winner = await OrderModel.findById(orderId).select("bill.number").lean();
      return { number: winner?.bill?.number ?? null, minted: false };
    } catch (error) {
      // The unique index fired: this number reached another order first. Take a
      // fresh one rather than retrying the same value.
      if (error?.code !== 11000) throw error;
      logLifecycleEvent("orders", "bill_number_burned", {
        orderId: String(orderId),
        financialYear: fy,
        sequence,
        reason: "duplicate_number",
      });
    }
  }

  throw new Error(`Could not assign a bill number to order ${orderId}`);
};

/**
 * Raise a year's counter to at least `sequence`.
 *
 * $max, never $set: the backfill script calls this after numbering historical rows,
 * and $max cannot rewind a counter that a concurrent live mint has already pushed
 * higher. $set could, and would then hand out a number that is already in use.
 */
export const seedBillCounter = async (fy, sequence) =>
  BillCounter.updateOne(
    { financialYear: fy },
    { $max: { seq: sequence } },
    { upsert: true },
  );

/** Narrow helper so callers can validate an id before hitting the database. */
export const isValidOrderId = (value) => Types.ObjectId.isValid(value);
