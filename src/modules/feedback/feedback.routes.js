import express from "express";
import {
  CreateFeedback,
  DeleteFeedback,
  GetAdminFeedback,
  GetMyFeedback,
  UpdateFeedback,
} from "./feedback.controller.js";
import { TokenVerify } from "../../middleware/auth.middleware.js";
import { isAdmin } from "../../middleware/is-admin.middleware.js";
import { requirePermission } from "../../middleware/require-permission.middleware.js";
import { ADMIN_PERMISSIONS } from "../../config/admin-permissions.config.js";
import { feedbackRateLimit } from "../../middleware/rate-limit.middleware.js";
import { validate } from "../../middleware/validate.middleware.js";
import {
  createFeedbackSchema,
  feedbackIdParamSchema,
  updateFeedbackSchema,
} from "./feedback.schema.js";

const routes = express.Router();

// Guests may send feedback, so the token is optional — but one that IS sent must be
// valid: an expired or forged token is refused rather than quietly treated as a
// guest, so a submission is never filed under the wrong person.
const optionalTokenVerify = (req, res, next) =>
  req.headers.authorization ? TokenVerify(req, res, next) : next();

// Same permission as the contact inbox: both are customers writing to the store,
// and the roles that read one are the roles that should read the other.
const canManageFeedback = requirePermission(ADMIN_PERMISSIONS.CONTACT_MANAGE);

routes.post("/", feedbackRateLimit, optionalTokenVerify, validate(createFeedbackSchema), CreateFeedback);
routes.get("/my", TokenVerify, GetMyFeedback);
routes.get("/admin/all", isAdmin, canManageFeedback, GetAdminFeedback);
routes.patch("/admin/:feedbackId", isAdmin, canManageFeedback, validate(updateFeedbackSchema), UpdateFeedback);
routes.delete("/admin/:feedbackId", isAdmin, canManageFeedback, validate(feedbackIdParamSchema), DeleteFeedback);

export default routes;
