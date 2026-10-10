const TRUE_VALUES = new Set(["1", "true", "yes", "on", "enabled"]);

const readBool = (name, fallback = false) => {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === "") return fallback;
  return TRUE_VALUES.has(String(raw).trim().toLowerCase());
};

const readString = (name, fallback = "") => {
  const value = String(process.env[name] ?? "").trim();
  return value || fallback;
};

const readNumber = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
};

export const getFeatures = () => ({
  payments: {
    enabled: readBool("PAYMENTS_ENABLED", false),
    provider: readString("PAYMENT_PROVIDER", "razorpay").toLowerCase(),
    razorpayWebhookEnabled: readBool("RAZORPAY_WEBHOOK_ENABLED", false),
  },
  shipping: {
    enabled: readBool("SHIPROCKET_ENABLED", false),
    provider: readString("SHIPPING_PROVIDER", "shiprocket").toLowerCase(),
    autoCreateOrder: readBool("SHIPROCKET_AUTO_CREATE_ORDER", false),
    webhookEnabled: readBool("SHIPROCKET_WEBHOOK_ENABLED", false),
  },
  inventory: {
    enforceStock: readBool("INVENTORY_ENFORCE_STOCK", true),
    reserveDuringPayment: readBool("INVENTORY_RESERVE_DURING_PAYMENT", true),
    lowStockThreshold: readNumber("LOW_STOCK_THRESHOLD", 5),
  },
  authSecurity: {
    enabled: readBool("AUTH_SECURITY_ENABLED", false),
    refreshCookieEnabled: readBool("REFRESH_TOKEN_COOKIE_ENABLED", true),
    rateLimitStore: readString("RATE_LIMIT_STORE", "memory"),
    rateLimitEnabled: readBool("RATE_LIMIT_ENABLED", true),
  },
  http: {
    securityHeadersEnabled: readBool("SECURITY_HEADERS_ENABLED", true),
    compressionEnabled: readBool("COMPRESSION_ENABLED", true),
    jsonBodyLimit: readString("JSON_BODY_LIMIT", "1mb"),
  },
  notifications: {
    enabled: readBool("NOTIFICATIONS_ENABLED", false),
    sms: readBool("NOTIFY_SMS_ENABLED", false),
    whatsapp: readBool("NOTIFY_WHATSAPP_ENABLED", false),
    phone: readBool("NOTIFY_PHONE_ENABLED", false),
  },
});

export const isPaymentEnabled = () => {
  const { payments } = getFeatures();
  return payments.enabled && payments.provider === "razorpay";
};

export const isShippingEnabled = () => {
  const { shipping } = getFeatures();
  return shipping.enabled && shipping.provider === "shiprocket";
};

export const isShippingWebhookEnabled = () => {
  const { shipping } = getFeatures();
  return isShippingEnabled() && shipping.webhookEnabled;
};

export const isStockEnforced = () => getFeatures().inventory.enforceStock;

export const isAuthSecurityEnabled = () => getFeatures().authSecurity.enabled;

export const isRateLimitEnabled = () => getFeatures().authSecurity.rateLimitEnabled;

export const getHttpConfig = () => getFeatures().http;
