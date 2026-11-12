import ServiceBooking from "../Schemas/ServiceBooking.js";

export const expireUnassignedBooking = async (bookingId, owner, now = new Date()) => {
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
        cancelReason: "no_technician_accept",
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
