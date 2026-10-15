import CheckoutSetting from "./CheckoutSetting.model.js";
import { isShiprocketConfigured } from "../shipping/shiprocket.service.js";

const presentSettings = (settings) => ({
  codEnabled: settings.codEnabled,
  codServiceabilityCheckEnabled: settings.codServiceabilityCheckEnabled,
  shippingRatesEnabled: settings.shippingRatesEnabled,
  freeShippingThreshold: settings.freeShippingThreshold ?? 0,
  codMinOrderAmount: settings.codMinOrderAmount,
  codMaxOrderAmount: settings.codMaxOrderAmount,
  cancellationWindowHours: settings.cancellationWindowHours,
  invoiceDeliveryDisplay: settings.invoiceDeliveryDisplay || "always",
});

const INVOICE_DELIVERY_DISPLAYS = ["always", "when_charged", "merged"];

// Public: the storefront checkout page needs this before login to know
// which payment methods to offer at all.
export const GetCheckoutSettings = async (req, res) => {
  try {
    const settings = await CheckoutSetting.getSettings();
    return res.status(200).json({
      success: true,
      settings: presentSettings(settings),
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const UpdateCheckoutSettings = async (req, res) => {
  try {
    const settings = await CheckoutSetting.getSettings();
    const body = req.body || {};

    if (typeof body.codEnabled === "boolean") {
      settings.codEnabled = body.codEnabled;
    }
    if (typeof body.codServiceabilityCheckEnabled === "boolean") {
      // Turning it ON needs a Shiprocket account. The check fails closed, so switching it on
      // without credentials puts the store into refusing EVERY Cash on Delivery order, and the
      // only symptom is customers unable to pay COD. Refused here as well as disabled in the
      // panel, because this endpoint is callable directly.
      //
      // Credentials only, deliberately matching what checkCodServiceability itself requires
      // (isShiprocketConfigured, NOT isShippingEnabled) — a store fulfilling manually can still
      // ask Shiprocket about a PIN code.
      //
      // Turning it OFF is always allowed: it needs nothing, and it is the way out of a store
      // that is already refusing COD.
      if (body.codServiceabilityCheckEnabled && !(await isShiprocketConfigured())) {
        return res.status(409).json({
          success: false,
          message:
            "Connect a Shiprocket account first — without one this setting would refuse every Cash on Delivery order, because it has no way to check a PIN code. Add your Shiprocket email and password under Operations → Shipping.",
          code: "SHIPROCKET_NOT_CONFIGURED",
        });
      }
      settings.codServiceabilityCheckEnabled = body.codServiceabilityCheckEnabled;
    }
    // Booleans only, same discipline as the COD coverage mode: a junk value must leave the
    // admin's pricing decision alone rather than being coerced into changing what customers
    // are charged.
    if (typeof body.shippingRatesEnabled === "boolean") {
      settings.shippingRatesEnabled = body.shippingRatesEnabled;
    }

    if (body.freeShippingThreshold !== undefined) {
      const nextThreshold = Number(body.freeShippingThreshold);
      // Number(null) and Number("") are 0, which here means "no free delivery" — a change to
      // what customers pay. Only a real number (or numeric string) may make that change.
      if (
        body.freeShippingThreshold === null ||
        body.freeShippingThreshold === "" ||
        !Number.isFinite(nextThreshold) ||
        nextThreshold < 0
      ) {
        return res.status(400).json({
          success: false,
          message: "The free delivery amount must be zero or a positive number.",
        });
      }
      settings.freeShippingThreshold = nextThreshold;
    }

    const nextMin = body.codMinOrderAmount === undefined ? settings.codMinOrderAmount : Number(body.codMinOrderAmount);
    const nextMax = body.codMaxOrderAmount === undefined ? settings.codMaxOrderAmount : Number(body.codMaxOrderAmount);

    if (!Number.isFinite(nextMin) || nextMin < 0 || !Number.isFinite(nextMax) || nextMax < 0) {
      return res.status(400).json({ success: false, message: "COD amount thresholds must be zero or a positive number." });
    }
    if (nextMax > 0 && nextMin > 0 && nextMin > nextMax) {
      return res.status(400).json({ success: false, message: "The minimum COD amount cannot be greater than the maximum." });
    }

    settings.codMinOrderAmount = nextMin;
    settings.codMaxOrderAmount = nextMax;

    if (body.cancellationWindowHours !== undefined) {
      const nextWindow = Number(body.cancellationWindowHours);
      if (!Number.isFinite(nextWindow) || nextWindow < 0) {
        return res.status(400).json({
          success: false,
          message: "The cancellation window must be zero or a positive number of hours.",
        });
      }
      settings.cancellationWindowHours = nextWindow;
    }

    if (body.invoiceDeliveryDisplay !== undefined) {
      if (!INVOICE_DELIVERY_DISPLAYS.includes(body.invoiceDeliveryDisplay)) {
        return res.status(400).json({
          success: false,
          message: `Delivery on the bill must be one of: ${INVOICE_DELIVERY_DISPLAYS.join(", ")}.`,
        });
      }
      settings.invoiceDeliveryDisplay = body.invoiceDeliveryDisplay;
    }

    await settings.save();
    return res.status(200).json({
      success: true,
      settings: presentSettings(settings),
      message: "Checkout settings updated successfully",
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};
