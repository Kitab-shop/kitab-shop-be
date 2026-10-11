import { buildShippingExceptions } from "./shipping-exceptions.service.js";

/** GET /api/v1/admin/shipping/exceptions — the fulfilment work queue (orders:manage). */
export const GetShippingExceptions = async (req, res) => {
  try {
    const result = await buildShippingExceptions();
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};
