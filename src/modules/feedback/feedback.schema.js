import { boundedString, looseBody, objectId, z } from "../../middleware/validate.middleware.js";
import {
  FEEDBACK_CATEGORIES,
  FEEDBACK_MESSAGE_MAX,
  FEEDBACK_MESSAGE_MIN,
  FEEDBACK_SOURCES,
  FEEDBACK_STATUSES,
} from "./Feedback.model.js";

const optionalText = (max, message) => z.string().trim().max(max, message).optional();

export const createFeedbackSchema = {
  body: looseBody({
    category: z.enum(FEEDBACK_CATEGORIES, { error: "Choose a valid feedback type" }),
    rating: z.coerce
      .number({ error: "Rating must be a number" })
      .int("Rating must be a whole number")
      .min(1, "Rating must be between 1 and 5")
      .max(5, "Rating must be between 1 and 5")
      .nullable()
      .optional(),
    // Optional: the footer form asks only for the message, and the controller
    // titles it from the message's opening words.
    subject: z
      .string()
      .trim()
      .max(120, "Subject must be 120 characters or fewer")
      .refine((value) => value === "" || value.length >= 3, "Subject must be at least 3 characters")
      .optional(),
    message: boundedString({ label: "Message", min: FEEDBACK_MESSAGE_MIN, max: FEEDBACK_MESSAGE_MAX }),
    // Guest contact details. Ignored for a signed-in customer, whose account is used.
    name: optionalText(120, "Name must be 120 characters or fewer"),
    email: z
      .string()
      .trim()
      .max(254, "Email is too long")
      .refine((value) => value === "" || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value), "Enter a valid email address")
      .optional(),
    source: z.enum(FEEDBACK_SOURCES).optional(),
    // A storefront path only ("/product/x"), so no off-site URL is ever stored.
    pagePath: z
      .string()
      .trim()
      .max(300)
      .refine((value) => value === "" || (value.startsWith("/") && !value.startsWith("//")), "Invalid page")
      .optional(),
    // Bot trap: a visually hidden field people never fill. Checked in the controller,
    // which answers a filled one with a normal-looking success and stores nothing.
    website: z.string().max(500).optional(),
  }),
};

export const updateFeedbackSchema = {
  params: looseBody({ feedbackId: objectId("Feedback id") }),
  body: looseBody({
    status: z.enum(FEEDBACK_STATUSES, { error: "Choose a valid status" }).optional(),
    // "" clears a response; the customer then sees none.
    adminResponse: z.string().trim().max(2000, "Response must be 2000 characters or fewer").optional(),
    internalNote: z.string().trim().max(2000, "Note must be 2000 characters or fewer").optional(),
  }).refine(
    (body) => body.status !== undefined || body.adminResponse !== undefined || body.internalNote !== undefined,
    { message: "Nothing to update", path: ["_"] },
  ),
};

export const feedbackIdParamSchema = {
  params: looseBody({ feedbackId: objectId("Feedback id") }),
};
