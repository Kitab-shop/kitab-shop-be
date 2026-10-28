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

  section("5b — guests and the footer form");
  {
    const guest = await callController(controller.CreateFeedback, {
      user: undefined,
      body: {
        category: "bug",
        message: `${MARKER} the search box on mobile hides the first result behind the keyboard`,
        name: "Ravi",
        email: "Ravi@Example.com",
        source: "footer",
        pagePath: "/search/tagore",
      },
    });
    const guestId = guest.body?.feedback?.id;
    if (guestId) created.push(guestId);
    ok("a guest can send feedback", guest.statusCode === 201, JSON.stringify(guest.body?.message));
    const stored = await Feedback.findById(guestId).lean();
    ok("it has no account", stored?.user === null);
    ok("it keeps the guest's name and lower-cased email", stored?.guestName === "Ravi" && stored?.guestEmail === "ravi@example.com");
    ok("it records the footer and the page", stored?.source === "footer" && stored?.pagePath === "/search/tagore");
    ok(
      "a missing subject is taken from the message's opening words",
      stored?.subject.startsWith(`${MARKER} the search box`) && stored.subject.length <= 61,
      stored?.subject,
    );

    const signedIn = await callController(controller.CreateFeedback, {
      user: customer,
      body: { category: "feedback", message: "Lovely packaging and quick delivery, thank you!", name: "Not Me", email: "spoof@example.com", source: "footer" },
    });
    if (signedIn.body?.feedback?.id) created.push(signedIn.body.feedback.id);
    const signedInStored = await Feedback.findById(signedIn.body?.feedback?.id).lean();
    ok(
      "a signed-in customer's own account is used, not body-supplied guest details",
      String(signedInStored?.user) === customer.id && signedInStored?.guestEmail === "" && signedInStored?.guestName === "",
    );

    const before = await Feedback.countDocuments();
    const bot = await callController(controller.CreateFeedback, {
      user: undefined,
      body: { category: "other", message: "Buy cheap watches at an amazing price today", website: "http://spam.example" },
    });
    ok("a filled bot-trap field gets an ordinary-looking success", bot.statusCode === 201);
    ok("but nothing is stored", (await Feedback.countDocuments()) === before);

    const admin = { id: String(new mongoose.Types.ObjectId()), roles: ["admin"] };
    const guestsOnly = await callController(controller.GetAdminFeedback, {
      user: admin,
      query: { from: "guest", search: MARKER },
    });
    const row = guestsOnly.body?.feedback?.[0];
    ok("admins can filter to guest feedback", guestsOnly.body?.feedback?.length === 1);
    ok("admins see the guest's details and page", row?.isGuest && row?.guestEmail === "ravi@example.com" && row?.pagePath === "/search/tagore");
    ok(
      "admin search also matches a guest's email",
      (await callController(controller.GetAdminFeedback, { user: admin, query: { search: "ravi@example" } })).body?.feedback?.length >= 1,
    );

    const parse = (body) => createFeedbackSchema.body.safeParse({ category: "feedback", ...body });
    const long = "This message is comfortably longer than twenty characters.";
    ok("a 19-character message is refused", !parse({ message: "x".repeat(19) }).success);
    ok("a 20-character message is accepted", parse({ message: "x".repeat(20) }).success);
    ok("a bad guest email is refused", !parse({ message: long, email: "not-an-email" }).success);
    ok("an empty guest email is fine", parse({ message: long, email: "" }).success);
    ok("an off-site page URL is refused", !parse({ message: long, pagePath: "https://evil.example/x" }).success);
    ok("a protocol-relative page URL is refused", !parse({ message: long, pagePath: "//evil.example/x" }).success);
    ok("an unknown source is refused", !parse({ message: long, source: "api" }).success);
    // Each of these resolves OFF-SITE when rendered as an href on the admin page.
    ok("a backslash-host page path is refused", !parse({ message: long, pagePath: "/\\evil.example/login" }).success);
    ok("a tab-host page path is refused", !parse({ message: long, pagePath: "/\t/evil.example" }).success);
    ok("a page path with a query string is refused (reset tokens live there)", !parse({ message: long, pagePath: "/reset-password?token=abc" }).success);
    ok("a plain on-site page path is accepted", parse({ message: long, pagePath: "/product/abc-123" }).success);
    ok("an email carrying mailto parameters is refused", !parse({ message: long, email: "a@b.co?cc=x%40evil.com" }).success);
  }

  section("5c — the real route: optional login");
  {
    const express = (await import("express")).default;
    const routes = (await import("../../src/modules/feedback/feedback.routes.js")).default;
    const app = express();
    app.use(express.json());
    app.use("/feedback", routes);
    const server = app.listen(0);
    const base = `http://127.0.0.1:${server.address().port}/feedback`;
    const post = (body, headers = {}) =>
      fetch(base, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
    try {
      const guestRes = await post({ category: "suggestion", message: `${MARKER} please add a gift-card option at checkout` });
      const guestBody = await guestRes.json();
      if (guestBody?.feedback?.id) created.push(guestBody.feedback.id);
      ok("a guest with no token is accepted over HTTP", guestRes.status === 201, String(guestRes.status));
      const badToken = await post(
        { category: "suggestion", message: "This should never be stored at all, ever." },
        { Authorization: "Bearer not-a-real-token" },
      );
      ok("a forged or expired token is refused, not treated as a guest", badToken.status === 401, String(badToken.status));
      const short = await post({ category: "suggestion", message: "too short" });
      ok("a short message is refused by validation (400)", short.status === 400, String(short.status));
    } finally {
      server.close();
    }
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
