import ServiceBooking from "../Schemas/ServiceBooking.js";

export const resolveExpiryCancelReason = (booking) => {
  const attempts = Array.isArray(booking?.assignmentAttempts)
    ? booking.assignmentAttempts
    : [];
  const hadAssignment = attempts.some((attempt) =>
    ["assigned", "released"].includes(attempt?.status)
  );
  return hadAssignment ? "technician_no_action" : "no_technician_accept";
};

export const expireUnassignedBooking = async (
  bookingId,
  owner,
  now = new Date(),
  { cancelReason = "no_technician_accept" } = {}
) => {
  if (!owner || typeof owner !== "string" || !owner.trim()) {
    throw Object.assign(new Error("expireUnassignedBooking requires a non-empty owner"), { statusCode: 400 });
  }

  return ServiceBooking.findOneAndUpdate(
    {
      _id: bookingId,
      status: { $in: ["pending", "broadcasted"] },
      technicianId: null,
      autoCancelAt: { $lte: now },
      leaseOwner: owner,
    },
    {
      $set: {
        status: "expired",
        cancelReason,
        cancelledBy: "system",
        cancelledAt: now,
        cancellationStatus: "system_cancelled",
        assignmentStatus: "released",
        matchingLeaseUntil: null,
        matchingLeaseOwner: null,
        completionPinnedAt: null,
        completionOtpRequestedAt: null,
        reacceptEligible: false,
      },
      $inc: { version: 1 },
    },
    { new: false }
  );
};
