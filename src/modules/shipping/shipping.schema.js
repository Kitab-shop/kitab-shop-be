import { looseBody, objectId, z } from "../../middleware/validate.middleware.js";

// Shiprocket's own ids are positive integers. Coerced so a value typed into a text
// box ("123456") is accepted, but never a fraction, zero or a negative.
const shiprocketId = (label) =>
  z.coerce
    .number({ error: `${label} must be a number` })
    .int(`${label} must be a whole number`)
    .positive(`${label} must be a positive number`);

const orderIdParams = looseBody({ orderId: objectId("Order id") });

/** POST /:orderId/shipment/link — record the Shiprocket shipment that does exist. */
export const linkShipmentSchema = {
  params: orderIdParams,
  body: looseBody({
    shiprocketOrderId: shiprocketId("Shiprocket order id"),
    shipmentId: shiprocketId("Shipment id"),
  }),
};

/** POST /:orderId/shipment/confirm-not-created and /:orderId/shipment/amount-ack. */
export const shipmentOrderParamSchema = {
  params: orderIdParams,
};
