import FooterSetting from "./FooterSetting.model.js";
import { logLifecycleError, logLifecycleEvent } from "../../utils/lifecycle-logger.service.js";

/**
 * Replaces the old Kitab Shop contact details still stored in the footer record.
 *
 * The store moved to New Delhi under the Rivermoss name, and the code defaults were
 * updated — but the live footer reads the FooterSetting document, which was created
 * from the OLD defaults and kept them. Every page showed "support@kitabshop.com …
 * IDPL, Rishikesh", and every bill of supply copied the same block as the seller
 * (bill-number.service.js sellerSnapshot reads this document).
 *
 * Runs once per API start, after the database connects. Each field is replaced only
 * while it still holds the old Kitab Shop value, matched in the update FILTER, so a
 * detail an admin has set since is never overwritten, and a second run changes
 * nothing. Never throws: a footer must not be able to stop the API from starting.
 */
const NEW_CONTACT = {
  email: "support@rivermossbooks.com",
  address: "Rivermoss Books\n143, 3rd Floor, Hari Nagar Ashram,\nNear Khatu Shyam Mandir,\nNew Delhi 110014",
  mapUrl: "https://www.google.com/maps/search/?api=1&query=Hari+Nagar+Ashram+New+Delhi+110014",
};

const LEGACY = {
  email: /kitabshop\.com/i,
  address: /Kitab Shop Commerce|IDPL,?\s*Rishikesh/i,
  mapUrl: /IDPL\+?Rishikesh|Rishikesh/i,
};

export const migrateLegacyFooterContact = async () => {
  try {
    const replaced = [];
    for (const field of Object.keys(NEW_CONTACT)) {
      const result = await FooterSetting.updateMany(
        { [`contact.${field}`]: LEGACY[field] },
        { $set: { [`contact.${field}`]: NEW_CONTACT[field] } },
      );
      if (result.modifiedCount > 0) replaced.push(field);
    }
    if (replaced.length > 0) {
      logLifecycleEvent("footer", "legacy_contact_replaced", { fields: replaced });
    }
    return replaced;
  } catch (error) {
    logLifecycleError("footer", "legacy_contact_migration_failed", error);
    return [];
  }
};
