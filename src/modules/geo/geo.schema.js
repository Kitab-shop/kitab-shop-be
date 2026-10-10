import { INDIAN_PINCODE_REGEX } from "../../config/india-geo.config.js";
import { looseBody, z } from "../../middleware/validate.middleware.js";

export const pincodeParamSchema = {
  params: looseBody({
    pincode: z.string().trim().regex(INDIAN_PINCODE_REGEX, "Enter a valid 6-digit PIN code"),
  }),
};
