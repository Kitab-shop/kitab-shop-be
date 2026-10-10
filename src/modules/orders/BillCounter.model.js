import mongoose from "mongoose";

/**
 * The allocator behind bill-of-supply numbers — one document per Indian financial
 * year, holding the highest sequence issued in it.
 *
 * This is the first true identifier counter in the codebase; everything else that
 * needed a unique string (return numbers, Razorpay receipts) uses timestamp +
 * random, which is fine for a correlation id and wrong for a book of account. A
 * bill series has to be strictly increasing and never reused, which only a counter
 * can give you.
 *
 * One document per year rather than one global document, because the sequence
 * restarts at 1 each April and because a per-year key means the rollover needs no
 * scheduled job — the first mint of the new year simply upserts a new document.
 *
 * `unique: true` on financialYear is LOAD-BEARING, not decorative. Two concurrent
 * first-ever mints of a year both take the upsert branch; without the unique index
 * they would create two counter documents for one year and hand out the same number
 * twice. With it, one loses on E11000 and retries into the winner's document. See
 * allocate() in bill-number.service.js.
 */
const billCounterSchema = new mongoose.Schema(
  {
    // "2026-27" — the Indian FY running 1 Apr 2026 to 31 Mar 2027.
    financialYear: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },

    // Highest sequence handed out so far this year. Moves only through $inc (live
    // mints) and $max (the backfill script seeding it), never $set — see
    // scripts/migrate-bill-numbers.js for why that distinction matters.
    seq: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  { timestamps: true },
);

export default mongoose.model("BillCounter", billCounterSchema);
