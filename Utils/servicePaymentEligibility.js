import { normalizeBookingStatus } from "./bookingStatus.js";

const PRE_COMPLETION_PAYABLE_STATUSES = [
  "accepted",
  "on_the_way",
  "reached",
  "in_progress",
];

export const isServicePaymentEligible = (booking) => {
  if (!booking) return false;
  if (booking.paymentStatus === "paid") return false;

  const status = normalizeBookingStatus(booking.status);
  if (status === "completed") return true;
  if (!PRE_COMPLETION_PAYABLE_STATUSES.includes(status)) return false;

  return Boolean(booking.completionOtpRequestedAt);
};

export const isSuccessfulServicePayment = (payment) => {
  if (!payment || payment.status !== "success") return false;
  if (payment.itemType && payment.itemType !== "service") return false;

  const provider = String(payment.provider || "").toLowerCase();
  const mode = String(payment.mode || "").toLowerCase();
  if (provider !== "razorpay") return false;
  if (["offline", "cash", "bank_transfer", "upi_direct", "cheque", "other"].includes(mode)) {
    return false;
  }
  return true;
};
