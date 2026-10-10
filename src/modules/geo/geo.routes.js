import express from "express";
import { TokenVerify } from "../../middleware/auth.middleware.js";
import { searchRateLimit } from "../../middleware/rate-limit.middleware.js";
import { validate } from "../../middleware/validate.middleware.js";
import { GetPincodeDetails } from "./geo.controller.js";
import { pincodeParamSchema } from "./geo.schema.js";

const routes = express.Router();

// Address forms (checkout, address book) are behind login, so the lookup is too.
routes.get("/pincode/:pincode", TokenVerify, searchRateLimit, validate(pincodeParamSchema), GetPincodeDetails);

export default routes;
