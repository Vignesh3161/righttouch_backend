/**
 * Notification templates. Each event may have multiple languages; the render
 * function receives `data` and returns { title, body }.
 */
const TEMPLATES = {
  // 👑 ADMIN TEMPLATES
  NEW_BOOKING: {
    en: ({ bookingCode, serviceName, customerName, totalAmount } = {}) => ({
      title: "🆕 New Booking Created",
      body: `Booking ${bookingCode || ""} for ${serviceName || "Service"} by ${customerName || "Customer"} (₹${totalAmount || 0})`.trim(),
    }),
  },
  BOOKING_AT_RISK: {
    en: ({ bookingCode, scheduledAt, delayMinutes } = {}) => ({
      title: "⚠️ Booking at Risk",
      body: `Booking ${bookingCode || ""} scheduled for ${scheduledAt || "soon"} is at risk of delay (${delayMinutes || 25} min remaining).`.trim(),
    }),
  },
  COMPLAINT_SLA_BREACH: {
    en: ({ reportId, elapsedHours } = {}) => ({
      title: "🚨 Complaint SLA Breached",
      body: `Complaint #${reportId || ""} has exceeded SLA response time (${elapsedHours || 24}h).`.trim(),
    }),
  },
  REFUND_MANUAL_REVIEW: {
    en: ({ refundId, bookingCode, amountRupees } = {}) => ({
      title: "⚠️ Manual Refund Required",
      body: `Refund for booking ${bookingCode || ""} (₹${amountRupees || 0}) requires manual admin review.`.trim(),
    }),
  },

  // 🔧 TECHNICIAN TEMPLATES
  JOB_NEW: {
    en: ({ serviceName, locality, payoutRupees } = {}) => ({
      title: "🆕 New Job Available",
      body: `New ${serviceName || "service"} job available in ${locality || "your area"}${payoutRupees ? " (Earn ₹" + payoutRupees + ")" : ""}.`.trim(),
    }),
  },
  JOB_BROADCAST: {
    en: ({ serviceName, locality, payoutRupees } = {}) => ({
      title: "⚡ Urgent Job Broadcast",
      body: `New ${serviceName || "service"} broadcast in ${locality || "your zone"}${payoutRupees ? " (₹" + payoutRupees + ")" : ""}. Accept now!`.trim(),
    }),
  },
  JOB_EXPIRED: {
    en: ({ serviceName } = {}) => ({
      title: "Job Expired",
      body: `The ${serviceName || "service"} job is no longer available.`.trim(),
    }),
  },
  JOB_CANCELLED_BY_CUSTOMER: {
    en: ({ bookingCode, reason } = {}) => ({
      title: "Booking Cancelled",
      body: `Booking ${bookingCode || ""} was cancelled by the customer${reason ? ": " + reason : "."}`.trim(),
    }),
  },
  TRAVEL_REMINDER: {
    en: ({ timeRemaining, bookingCode } = {}) => ({
      title: "🕒 Travel Reminder",
      body: `Your job ${bookingCode || ""} starts in ${timeRemaining || "35 mins"}. Please start travel now.`.trim(),
    }),
  },
  PAYMENT_RECEIVED: {
    en: ({ amountRupees, bookingCode } = {}) => ({
      title: "💰 Payment Received",
      body: `Payment of ₹${amountRupees || 0} received for booking ${bookingCode || ""}.`.trim(),
    }),
  },
  AUTO_PAYOUT_PAID: {
    en: ({ amountRupees, utrNumber } = {}) => ({
      title: "💸 Payout Successful",
      body: `₹${amountRupees || 0} credited to your bank account${utrNumber ? " (UTR: " + utrNumber + ")" : ""}.`.trim(),
    }),
  },
  WITHDRAWAL_FAILED: {
    en: ({ amountRupees, reason } = {}) => ({
      title: "❌ Payout Failed",
      body: `Payout of ₹${amountRupees || 0} failed: ${reason || "Please check your bank details"}.`.trim(),
    }),
  },
  COMPLAINT_FILED_AGAINST_YOU: {
    en: ({ bookingCode } = {}) => ({
      title: "⚠️ Complaint Filed",
      body: `A complaint was filed on booking ${bookingCode || ""}. Applicable earnings are held pending review.`.trim(),
    }),
  },
  CLAWBACK_APPLIED: {
    en: ({ amountRupees, bookingCode } = {}) => ({
      title: "Clawback Applied",
      body: `₹${amountRupees || 0} was deducted from your earnings for booking ${bookingCode || ""}.`.trim(),
    }),
  },
  HOLD_RELEASED: {
    en: ({ bookingCode } = {}) => ({
      title: "✅ Earnings Hold Released",
      body: `The earnings hold on booking ${bookingCode || ""} has been released.`.trim(),
    }),
  },
  PERMISSION_STATUS_CHANGED: {
    en: ({ permissionType, status } = {}) => ({
      title: "Verification Status Updated",
      body: `Your ${permissionType || "account"} validation status is now ${status || "UPDATED"}.`.trim(),
    }),
  },

  // 👤 CUSTOMER TEMPLATES
  OTP: {
    en: ({ otp } = {}) => ({
      title: "RightTouch Verification OTP",
      body: `Your RightTouch OTP is ${otp || ""}. Valid for 5 minutes. Do not share with anyone.`.trim(),
    }),
  },
  BOOKING_ACCEPTED: {
    en: ({ technicianName, serviceName } = {}) => ({
      title: "Technician Assigned!",
      body: `${technicianName || "A technician"} has accepted your booking for ${serviceName || "Service"}.`.trim(),
    }),
  },
  TECHNICIAN_TRAVEL_STARTED: {
    en: ({ technicianName, etaMinutes } = {}) => ({
      title: "Technician on the way 🛵",
      body: `${technicianName || "Technician"} is traveling to your location${etaMinutes ? " (ETA: " + etaMinutes + " mins)" : ""}.`.trim(),
    }),
  },
  TECHNICIAN_ARRIVED: {
    en: ({ technicianName } = {}) => ({
      title: "Technician Arrived 🚪",
      body: `${technicianName || "Technician"} has arrived at your doorstep.`.trim(),
    }),
  },
  BOOKING_COMPLETED: {
    en: ({ serviceName, bookingCode } = {}) => ({
      title: "Service Completed 🎉",
      body: `Your ${serviceName || "service"} (${bookingCode || ""}) is complete! Please rate your technician.`.trim(),
    }),
  },
  BOOKING_CANCELLED: {
    en: ({ bookingCode, reason } = {}) => ({
      title: "Booking Cancelled",
      body: `Your booking ${bookingCode || ""} has been cancelled${reason ? ": " + reason : "."}`.trim(),
    }),
  },
  PAYMENT_SUCCESS: {
    en: ({ amountRupees, bookingCode } = {}) => ({
      title: "Payment Successful ✅",
      body: `Payment of ₹${amountRupees || 0} for booking ${bookingCode || ""} was successful.`.trim(),
    }),
  },
  REFUND_INITIATED: {
    en: ({ amountRupees, bookingCode } = {}) => ({
      title: "Refund Initiated 💳",
      body: `Refund of ₹${amountRupees || 0} for booking ${bookingCode || ""} has been initiated.`.trim(),
    }),
  },
  REFUND_PROCESSED: {
    en: ({ amountRupees, bookingCode } = {}) => ({
      title: "Refund Processed ✅",
      body: `Refund of ₹${amountRupees || 0} for booking ${bookingCode || ""} has been processed to your payment method.`.trim(),
    }),
  },
  REFUND_FAILED: {
    en: ({ bookingCode } = {}) => ({
      title: "Refund Failed",
      body: `We could not process your refund for booking ${bookingCode || ""}. Our support team is reviewing it.`.trim(),
    }),
  },
  QUOTATION_SENT: {
    en: ({ quotationNumber, totalAmount, validUntil } = {}) => ({
      title: "Quotation Ready 📄",
      body: `Quotation ${quotationNumber || ""} for ₹${totalAmount || 0} is ready${validUntil ? " (Valid until " + validUntil + ")" : ""}.`.trim(),
    }),
  },
  COMPLAINT_RECEIVED: {
    en: ({ reportId } = {}) => ({
      title: "Complaint Received",
      body: "We have received your complaint and our support team will review it shortly.",
    }),
  },
  COMPLAINT_UNDER_REVIEW: {
    en: () => ({
      title: "Complaint Under Review",
      body: "Your complaint is currently under review by our operations team.",
    }),
  },
  COMPLAINT_REJECTED: {
    en: ({ resolutionNote } = {}) => ({
      title: "Complaint Update",
      body: resolutionNote || "Your complaint was reviewed and closed.",
    }),
  },
  COMPLAINT_RESOLVED_IN_FAVOUR: {
    en: ({ resolutionNote } = {}) => ({
      title: "Complaint Resolved ✅",
      body: resolutionNote || "Your complaint was resolved in your favour.",
    }),
  },
  COMPLAINT_STATUS_UPDATED: {
    en: ({ status } = {}) => ({
      title: "Complaint Status Updated",
      body: `Complaint status changed to ${status || "UPDATED"}.`.trim(),
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
