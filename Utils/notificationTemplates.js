/**
 * Notification templates. Each event may have multiple languages; the render
 * function receives `data` and returns { title, body }. Only the events used
 * by the migrated flows are templated; everything else falls back to the
 * caller-supplied title/body.
 */
const TEMPLATES = {
  COMPLAINT_RECEIVED: {
    en: ({ reportId } = {}) => ({
      title: "Complaint received",
      body: "We have received your complaint and will review it shortly.",
    }),
  },
  COMPLAINT_FILED_AGAINST_YOU: {
    en: ({ bookingId, reportId } = {}) => ({
      title: "Complaint filed",
      body: "A complaint was filed on a booking. Applicable earnings are held pending review.",
    }),
  },
  COMPLAINT_UNDER_REVIEW: {
    en: () => ({
      title: "Complaint update",
      body: "Your complaint is now under review.",
    }),
  },
  COMPLAINT_REJECTED: {
    en: ({ resolutionNote } = {}) => ({
      title: "Complaint update",
      body: resolutionNote || "Your complaint was reviewed and no refund will be issued.",
    }),
  },
  COMPLAINT_RESOLVED_IN_FAVOUR: {
    en: ({ resolutionNote } = {}) => ({
      title: "Complaint resolved",
      body: resolutionNote || "Your complaint was resolved in your favour.",
    }),
  },
  COMPLAINT_STATUS_UPDATED: {
    en: ({ status } = {}) => ({
      title: "Complaint status updated",
      body: `Complaint status changed to ${status}.`,
    }),
  },
  REFUND_INITIATED: {
    en: ({ bookingCode } = {}) => ({
      title: "Refund initiated",
      body: "We have started processing your refund.",
    }),
  },
  REFUND_PROCESSED: {
    en: ({ bookingCode } = {}) => ({
      title: "Refund processed",
      body: `Your refund for booking ${bookingCode || ""} has been processed.`.trim(),
    }),
  },
  REFUND_FAILED: {
    en: ({ bookingCode } = {}) => ({
      title: "Refund failed",
      body: "We could not process your refund. Our team will review it manually.",
    }),
  },
  HOLD_RELEASED: {
    en: ({ bookingId } = {}) => ({
      title: "Hold released",
      body: "The earnings hold on a booking has been released.",
    }),
  },
  CLAWBACK_APPLIED: {
    en: ({ bookingId, amountPaise } = {}) => ({
      title: "Clawback applied",
      body: "An amount was clawed back from your earnings for a resolved complaint.",
    }),
  },
};

export const renderTemplate = (eventType, language = "en", data = {}) => {
  const byLang = TEMPLATES[eventType];
  if (!byLang) return null;
  const fn = byLang[language] || byLang.en;
  if (typeof fn !== "function") return null;
  try {
    return fn(data);
  } catch {
    return null;
  }
};
