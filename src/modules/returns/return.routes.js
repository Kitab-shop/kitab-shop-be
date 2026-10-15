import express from "express";
import {
  CancelMyReturn,
  CreateReturnRequest,
  GetMyReturns,
  GetReturnById,
} from "./return.controller.js";
import { TokenVerify } from "../../middleware/auth.middleware.js";
import { orderActionRateLimit } from "../../middleware/rate-limit.middleware.js";

const router = express.Router();

router.post("/", orderActionRateLimit, TokenVerify, CreateReturnRequest);
router.get("/my", TokenVerify, GetMyReturns);
router.get("/:id", TokenVerify, GetReturnById);
// The customer withdraws their own request while no pickup is booked or underway.
router.post("/:id/cancel", orderActionRateLimit, TokenVerify, CancelMyReturn);

export default router;
