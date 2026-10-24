import { boundedString, looseBody, objectId, z } from "../../middleware/validate.middleware.js";
import { FEEDBACK_CATEGORIES, FEEDBACK_STATUSES } from "./Feedback.model.js";

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
    subject: boundedString({ label: "Subject", min: 3, max: 120 }),
    message: boundedString({ label: "Message", min: 5, max: 3000 }),
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
