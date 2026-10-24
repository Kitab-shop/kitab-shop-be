/**
 * Customer suggestions & feedback, and the admin review of them.
 *
 * Proves, through the real handlers and database:
 *   - a submission is tied to the authenticated account, whatever the body claims;
 *   - the customer's own list never carries the admin-only internal note;
 *   - an admin response is visible to the customer, and responding to a "new" item
 *     moves it to "in_review" unless a status is given;
 *   - the admin list filters by status/category and reports per-status counts;
 *   - the request schemas refuse malformed input.
 *
 * Run with `npm run test:feedback` (or `npm test` for everything).
 */
process.env.NOTIFICATIONS_ENABLED = "false";

import mongoose from "mongoose";
import { connect, createSuite, marker } from "./helpers.mjs";

const { ok, section, finish } = createSuite("feedback");
await connect();

const Feedback = (await import("../../src/modules/feedback/Feedback.model.js")).default;
const controller = await import("../../src/modules/feedback/feedback.controller.js");
const { createFeedbackSchema, updateFeedbackSchema } = await import(
  "../../src/modules/feedback/feedback.schema.js"
);

await Feedback.init();

const MARKER = marker("feedback");
const created = [];

const callController = async (handler, { params = {}, body = {}, user, query = {} }) => {
  let statusCode = 200;
  let payload;
  const res = {
    status(code) { statusCode = code; return this; },
    json(data) { payload = data; return this; },
  };
  await handler({ params, body, user, query, headers: {} }, res);
  return { statusCode, body: payload };
};

const customer = { id: String(new mongoose.Types.ObjectId()), roles: ["user"] };
const someoneElse = String(new mongoose.Types.ObjectId());
const admin = { id: String(new mongoose.Types.ObjectId()), roles: ["admin"] };

try {
  section("1 — submission");
  let feedbackId;
  {
    const response = await callController(controller.CreateFeedback, {
      user: customer,
      body: {
        category: "suggestion",
        rating: 4,
        subject: `${MARKER} gift wrapping`,
        message: "Please add gift wrapping at checkout.",
        user: someoneElse,
      },
    });
    feedbackId = response.body?.feedback?.id;
    if (feedbackId) created.push(feedbackId);
    ok("it is created", response.statusCode === 201, JSON.stringify(response.body?.message));
    const stored = await Feedback.findById(feedbackId).lean();
    ok("it belongs to the authenticated account, not the body's claim", String(stored?.user) === customer.id);
    ok("it starts as new", stored?.status === "new");
  }

  section("2 — admin review");
  {
    const response = await callController(controller.UpdateFeedback, {
      user: admin,
      params: { feedbackId: String(feedbackId) },
      body: { adminResponse: "Thanks — we are looking into it.", internalNote: "ask the packing team" },
    });
    ok("the update succeeds", response.statusCode === 200, JSON.stringify(response.body?.message));
    ok("responding to a new item moves it to in_review", response.body?.feedback?.status === "in_review");
    ok("the admin sees the internal note", response.body?.feedback?.internalNote === "ask the packing team");

    const planned = await callController(controller.UpdateFeedback, {
      user: admin,
      params: { feedbackId: String(feedbackId) },
      body: { status: "planned" },
    });
    ok("an explicit status is applied", planned.body?.feedback?.status === "planned");

    const missing = await callController(controller.UpdateFeedback, {
      user: admin,
      params: { feedbackId: String(new mongoose.Types.ObjectId()) },
      body: { status: "resolved" },
    });
    ok("an unknown id is a 404", missing.statusCode === 404);
  }

  section("3 — what the customer sees");
  {
    const response = await callController(controller.GetMyFeedback, { user: customer });
    const mine = response.body?.feedback?.find((item) => String(item.id) === String(feedbackId));
    ok("their submission is listed", Boolean(mine));
    ok("with the store's response", mine?.adminResponse?.message === "Thanks — we are looking into it.");
    ok("and its current status", mine?.status === "planned");
    ok("but never the internal note", mine && !("internalNote" in mine));
  }

  section("4 — admin list");
  {
    const filtered = await callController(controller.GetAdminFeedback, {
      user: admin,
      query: { status: "planned", category: "suggestion", search: MARKER },
    });
    ok("filters by status, category and search", filtered.body?.feedback?.length === 1, JSON.stringify(filtered.body?.total));
    ok("reports per-status counts", Number(filtered.body?.counts?.planned) >= 1);
    const none = await callController(controller.GetAdminFeedback, {
      user: admin,
      query: { status: "dismissed", search: MARKER },
    });
    ok("a non-matching status returns nothing", none.body?.feedback?.length === 0);
  }

  section("5 — validation");
  {
    const create = (body) => createFeedbackSchema.body.safeParse(body);
    const update = (body) => updateFeedbackSchema.body.safeParse(body);
    ok("an unknown category is refused", !create({ category: "spam", subject: "Hello", message: "Hello there" }).success);
    ok("a rating of 6 is refused", !create({ category: "feedback", rating: 6, subject: "Hello", message: "Hello there" }).success);
    ok("a too-short message is refused", !create({ category: "feedback", subject: "Hello", message: "hi" }).success);
    ok("a well-formed submission is accepted", create({ category: "bug", subject: "Search", message: "Search returns nothing." }).success);
    ok("an empty update is refused", !update({}).success);
    ok("an unknown status is refused", !update({ status: "archived" }).success);
  }

  section("6 — deletion");
  {
    const response = await callController(controller.DeleteFeedback, {
      user: admin,
      params: { feedbackId: String(feedbackId) },
    });
    ok("an admin can delete it", response.statusCode === 200);
    ok("it is gone", (await Feedback.findById(feedbackId)) === null);
  }
} finally {
  await Feedback.deleteMany({ _id: { $in: created } });
  const { failed } = finish();
  await mongoose.disconnect();
  process.exit(failed ? 1 : 0);
}
