import FooterSetting from "./FooterSetting.model.js";
import { createAuditLog } from "../audit/audit-log.js";

const defaultFooterSettings = {
  trustBadges: [
    { label: "Certified Products", icon: "shield", position: 1, enabled: true },
    { label: "Free Delivery", icon: "truck", position: 2, enabled: true },
    { label: "7 Day Returns", icon: "return", position: 3, enabled: true },
    { label: "Genuine Editions", icon: "verified", position: 4, enabled: true },
  ],
  sections: [
    {
      key: "about",
      title: "ABOUT",
      position: 1,
      enabled: true,
      links: [
        { label: "Contact Us", to: "/contact", position: 1, enabled: true },
        { label: "About Us", to: "/info/about", position: 2, enabled: true },
        { label: "Careers", to: "/info/careers", position: 3, enabled: true },
        { label: "Press", to: "/info/press", position: 4, enabled: true },
      ],
    },
    {
      key: "help",
      title: "HELP",
      position: 2,
      enabled: true,
      links: [
        { label: "Payments", to: "/info/payments", position: 1, enabled: true },
        { label: "Shipping", to: "/info/shipping", position: 2, enabled: true },
        { label: "Cancellation & Returns", to: "/info/returns", position: 3, enabled: true },
        { label: "FAQ", to: "/info/faq", position: 4, enabled: true },
      ],
    },
    {
      key: "policy",
      title: "POLICY",
      position: 3,
      enabled: true,
      links: [],
    },
  ],
  contact: {
    phone: "+91 98XXX XXXXX",
    email: "support@rivermossbooks.com",
    address: "Rivermoss Books\n143, 3rd Floor, Hari Nagar Ashram,\nNear Khatu Shyam Mandir,\nNew Delhi 110014",
    mapUrl: "https://www.google.com/maps/search/?api=1&query=Hari+Nagar+Ashram+New+Delhi+110014",
  },
  newsletterEnabled: true,
};

const sendServerError = (res, error) =>
  res.status(500).json({
    success: false,
    message: error.message,
  });

const sortByPosition = (items = []) =>
  [...items].sort((a, b) => (Number(a.position) || 0) - (Number(b.position) || 0));

const sanitizeLink = (link = {}, index) => ({
  label: String(link.label || "").trim(),
  to: String(link.to || "").trim(),
  position: Number(link.position) || index + 1,
  enabled: link.enabled !== false,
});

const sanitizeSection = (section = {}, index) => ({
  key: String(section.key || section.title || `section-${index + 1}`)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, ""),
  title: String(section.title || "").trim(),
  position: Number(section.position) || index + 1,
  enabled: section.enabled !== false,
  links: (section.links || [])
    .map(sanitizeLink)
    .filter((link) => link.label && link.to),
});

const sanitizeBadge = (badge = {}, index) => ({
  label: String(badge.label || "").trim(),
  icon: ["shield", "truck", "return", "verified"].includes(badge.icon) ? badge.icon : "shield",
  position: Number(badge.position) || index + 1,
  enabled: badge.enabled !== false,
});

const normalizeFooterSettings = (settings) => {
  const value = settings?.toObject ? settings.toObject() : settings || defaultFooterSettings;

  return {
    id: value._id || value.id || "default",
    sections: sortByPosition(value.sections || []).map((section) => ({
      id: section._id || section.id,
      key: section.key,
      title: section.title,
      position: section.position,
      enabled: section.enabled !== false,
      links: sortByPosition(section.links || []).map((link) => ({
        id: link._id || link.id,
        label: link.label,
        to: link.to,
        position: link.position,
        enabled: link.enabled !== false,
      })),
    })),
    trustBadges: sortByPosition(value.trustBadges || []).map((badge) => ({
      id: badge._id || badge.id,
      label: badge.label,
      icon: badge.icon,
      position: badge.position,
      enabled: badge.enabled !== false,
    })),
    contact: {
      phone: value.contact?.phone || "",
      email: value.contact?.email || "",
      address: value.contact?.address || "",
      mapUrl: value.contact?.mapUrl || "",
    },
    newsletterEnabled: value.newsletterEnabled !== false,
    updatedAt: value.updatedAt,
  };
};

const getOrCreateFooterSettings = async () => {
  let settings = await FooterSetting.findOne();
  if (!settings) {
    settings = await FooterSetting.create(defaultFooterSettings);
  }
  return settings;
};

export const GetFooterSettings = async (req, res) => {
  try {
    const settings = await getOrCreateFooterSettings();

    return res.status(200).json({
      success: true,
      message: "Footer settings fetched successfully",
      data: normalizeFooterSettings(settings),
    });
  } catch (error) {
    return sendServerError(res, error);
  }
};

export const UpdateFooterSettings = async (req, res) => {
  try {
    const settings = await getOrCreateFooterSettings();
    const { sections, trustBadges, contact, newsletterEnabled } = req.body;

    if (sections !== undefined) {
      settings.sections = sections.map(sanitizeSection).filter((section) => section.key && section.title);
    }

    if (trustBadges !== undefined) {
      settings.trustBadges = trustBadges.map(sanitizeBadge).filter((badge) => badge.label);
    }

    if (contact !== undefined) {
      settings.contact = {
        phone: String(contact.phone || "").trim(),
        email: String(contact.email || "").trim(),
        address: String(contact.address || "").trim(),
        mapUrl: String(contact.mapUrl || "").trim(),
      };
    }

    if (newsletterEnabled !== undefined) {
      settings.newsletterEnabled = Boolean(newsletterEnabled);
    }

    settings.lastEditedByAdminId = req.user?.id;
    await settings.save();

    await createAuditLog({
      admin: req.user?.id,
      action: "UPDATE_FOOTER",
      module: "Footer",
      targetId: settings._id,
      targetName: "Store Footer",
      description: "Updated footer settings",
      req,
    });

    return res.status(200).json({
      success: true,
      message: "Footer settings updated successfully",
      data: normalizeFooterSettings(settings),
    });
  } catch (error) {
    console.error("UpdateFooterSettings Error:", error);
    return sendServerError(res, error);
  }
};
