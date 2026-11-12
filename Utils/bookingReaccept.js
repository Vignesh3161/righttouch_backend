export const TECHNICIAN_REACCEPT_WINDOW_MINUTES = Math.max(
  1,
  Number(process.env.TECHNICIAN_REACCEPT_WINDOW_MINUTES) || 15
);

const reject = (reason) => ({ eligible: false, reason });

export const evaluateReacceptEligibility = ({
  booking,
  now = new Date(),
  windowMinutes = TECHNICIAN_REACCEPT_WINDOW_MINUTES,
} = {}) => {
  if (!booking) return reject("booking_not_found");
  if (booking.status !== "cancelled") return reject("not_cancelled");
  if (booking.cancelledBy !== "technician") return reject("not_technician_cancelled");

  const legacyEligible =
    booking.reacceptEligible == null &&
    booking.cancellationStatus === "technician_cancelled";
  if (booking.reacceptEligible !== true && !legacyEligible) {
    return reject("reaccept_disabled");
  }

  const cancelledAt = booking.cancelledAt || booking.updatedAt;
  const cancelledAtMs = cancelledAt ? new Date(cancelledAt).getTime() : NaN;
  if (!Number.isFinite(cancelledAtMs)) return reject("missing_cancellation_time");
  if (now.getTime() - cancelledAtMs > windowMinutes * 60 * 1000) {
    return reject("reaccept_window_expired");
  }

  if (booking.bookingType === "schedule") {
    const scheduledAtMs = booking.scheduledAt ? new Date(booking.scheduledAt).getTime() : NaN;
    if (!Number.isFinite(scheduledAtMs)) return reject("missing_scheduled_at");
    if (scheduledAtMs <= now.getTime()) return reject("scheduled_time_passed");
  }

  return { eligible: true, reason: null };
};
