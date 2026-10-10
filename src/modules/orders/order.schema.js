import {
  boundedString,
  looseBody,
  objectId,
  z,
} from "../../middleware/validate.middleware.js";
import {
  INDIAN_MOBILE_REGEX,
  INDIAN_PINCODE_REGEX,
  INDIAN_STATES,
} from "../../config/india-geo.config.js";

const MAX_ORDER_ITEMS = 100;

// Mirrors the controller's own check so a bad key is rejected before any
// database lookup happens.
const idempotencyKey = z
  .string({ error: "A valid checkout idempotency key is required" })
  .regex(/^[A-Za-z0-9_-]{16,100}$/, "A valid checkout idempotency key is required");

// A sanity ceiling against fat-finger/bot quantities, mirroring
// cart.schema.js — the real per-product limit is live stock, enforced in
// order-pricing.service.js against Product.stock at order time.
const MAX_ITEM_QUANTITY = 999;

const orderItem = looseBody({
  productId: objectId("Product id").optional(),
  product: objectId("Product id").optional(),
  quantity: z.coerce
    .number({ error: "Quantity must be a number" })
    .int("Quantity must be a whole number")
    .min(1, "Quantity must be at least 1")
    .max(MAX_ITEM_QUANTITY, `Quantity cannot exceed ${MAX_ITEM_QUANTITY}`)
    .optional(),
}).refine((item) => Boolean(item.productId || item.product), {
  message: "Product id is required for every item",
  path: ["productId"],
});

const shippingAddress = looseBody({
  name: boundedString({ label: "Name", max: 120 }).optional(),
  fullName: boundedString({ label: "Name", max: 120 }).optional(),
  phone: z
    .string()
    .trim()
    .regex(INDIAN_MOBILE_REGEX, "Enter a valid 10-digit mobile number starting 6-9")
    .optional(),
  addressLine1: boundedString({ label: "Address", max: 250 }).optional(),
  addressLine2: z.string().trim().max(250).optional(),
  // Legacy single-line form of addressLine1, still sent by older clients.
  address: boundedString({ label: "Address", max: 600 }).optional(),
  landmark: z.string().trim().max(120).optional(),
  district: z.string().trim().max(100).optional(),
  city: boundedString({ label: "City", max: 100 }).optional(),
  state: z.enum(INDIAN_STATES, { error: "Select a valid Indian state or union territory" }).optional(),
  pincode: z
    .string()
    .trim()
    .regex(INDIAN_PINCODE_REGEX, "Enter a valid 6-digit PIN code")
    .optional(),
  country: z.string().trim().max(100).optional(),
});

export const placeOrderSchema = {
  body: looseBody({
    idempotencyKey,
    items: z
      .array(orderItem)
      .max(MAX_ORDER_ITEMS, `An order cannot contain more than ${MAX_ORDER_ITEMS} items`)
      .optional(),
    // Left permissive: the controller only accepts "cod" here and returns a
    // clearer domain message than a schema rejection would.
    paymentMethod: z.string().trim().max(40).optional(),
    shippingAddress: shippingAddress.optional(),
    coupon: z.unknown().optional(),
    useWallet: z.coerce.boolean().optional(),
  }),
};

export const orderPricingPreviewSchema = {
  body: looseBody({
    items: z
      .array(orderItem)
      .max(MAX_ORDER_ITEMS, `An order cannot contain more than ${MAX_ORDER_ITEMS} items`)
      .optional(),
    shippingAddress: shippingAddress.optional(),
    coupon: z.unknown().optional(),
    useWallet: z.coerce.boolean().optional(),
    // Only decides which shipping rate is quoted. Not trusted for anything else —
    // PlaceOrder establishes the real payment method itself.
    paymentMethod: z.string().max(20).optional(),
  }),
};

export const orderIdParamSchema = {
  params: looseBody({
    orderId: objectId("Order id"),
  }),
};

export const updateOrderStatusSchema = {
  params: looseBody({ orderId: objectId("Order id") }),
  body: looseBody({
    orderStatus: boundedString({ label: "Order status", max: 60 }),
  }),
};

export const addOrderNoteSchema = {
  params: looseBody({ orderId: objectId("Order id") }),
  body: looseBody({
    note: boundedString({ label: "Note", max: 2000 }),
  }),
};

export const partialCancelSchema = {
  params: looseBody({ orderId: objectId("Order id") }),
  body: looseBody({
    productId: objectId("Product id"),
    quantity: z.coerce
      .number({ error: "Quantity must be a number" })
      .int("Quantity must be a whole number")
      .min(1, "Quantity must be at least 1")
      .max(100, "Quantity cannot exceed 100"),
    reason: z.string().trim().max(500).optional(),
  }),
};

export const splitShipmentSchema = {
  params: looseBody({ orderId: objectId("Order id") }),
  body: looseBody({
    items: z.array(z.unknown()).min(1, "At least one item is required"),
  }),
};

/**
 * Recording a hand-shipped parcel: who carried it, under what tracking number.
 *
 * `provider` is constrained to MANUAL here rather than to the full enum, because
 * this endpoint cannot produce anything else. Turning an order into a SHIPROCKET
 * shipment means calling Shiprocket and receiving real identifiers back; letting
 * a request simply declare `provider: "SHIPROCKET"` would record a courier
 * integration that was never contacted, with no order id, no shipment id and no
 * AWB behind it. Omitting it is allowed and means MANUAL.
 *
 * Both fields are REQUIRED and non-empty. A tracking number with no carrier is
 * untrackable — the customer needs to know whose website to type it into — and a
 * carrier with no number is not a shipment record at all.
 */
export const manualShipmentSchema = {
  params: looseBody({ orderId: objectId("Order id") }),
  body: looseBody({
    provider: z.literal("MANUAL", { error: "Only MANUAL shipments can be recorded here" }).optional(),
    carrierName: boundedString({ label: "Carrier name", max: 120 }),
    trackingNumber: boundedString({ label: "Tracking number", max: 100 }),
  }),
};
