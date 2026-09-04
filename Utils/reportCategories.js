import GlobalSetting from "../Schemas/GlobalSetting.js";

/**
 * 📋 COMPLAINT CATEGORIES
 * Canonical registry of report/complaint categories. Used by:
 *  - the "get all categories" API (customer/admin/technician)
 *  - server-side validation of `category` on complaint creation
 *
 * Overridable via GlobalSetting key `report.categories` (same precedence
 * pattern as refund policy). Falls back to the static list below.
 */

export const STATIC_REPORT_CATEGORIES = [
  {
    key: "quality_dispute",
    label: "Quality Dispute",
    description: "Work did not meet agreed quality standards.",
    bookingTypes: ["service", "product"],
    defaultFaultParty: "technician",
  },
  {
    key: "damage",
    label: "Damage",
    description: "Property or item was damaged during the service.",
    bookingTypes: ["service", "product"],
    defaultFaultParty: "technician",
  },
  {
    key: "incomplete_work",
    label: "Incomplete Work",
    description: "Service was left unfinished or not as described.",
    bookingTypes: ["service"],
    defaultFaultParty: "technician",
  },
  {
    key: "technician_misconduct",
    label: "Technician Misconduct",
    description: "Unprofessional or inappropriate behaviour by the technician.",
    bookingTypes: ["service"],
    defaultFaultParty: "technician",
  },
  {
    key: "goodwill",
    label: "Goodwill / Courtesy",
    description: "Customer goodwill adjustment, no fault assigned.",
    bookingTypes: ["service", "product"],
    defaultFaultParty: "platform",
  },
  {
    key: "product_issue",
    label: "Product Issue",
    description: "Defective, wrong, or damaged product delivered.",
    bookingTypes: ["product"],
    defaultFaultParty: "platform",
  },
  {
    key: "other",
    label: "Other",
    description: "Any other complaint not covered above.",
    bookingTypes: ["service", "product"],
    defaultFaultParty: "platform",
  },
];

export const REPORT_CATEGORY_KEYS = STATIC_REPORT_CATEGORIES.map((c) => c.key);

const KEY = "report.categories";

export const getReportCategories = async () => {
  try {
    const doc = await GlobalSetting.findOne({ key: KEY }).lean();
    const stored = doc?.value && Array.isArray(doc.value) ? doc.value : null;
    return stored && stored.length ? stored : STATIC_REPORT_CATEGORIES;
  } catch {
    return STATIC_REPORT_CATEGORIES;
  }
};

export const isValidCategory = (category) =>
  typeof category === "string" && REPORT_CATEGORY_KEYS.includes(category);
