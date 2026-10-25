/**
 * 📦 SOCKET DTO PROJECTIONS
 * Single source of truth for every event payload sent over Socket.IO.
 * Guarantees: (a) no raw Mongoose documents ever leave the server,
 * (b) every consumer gets the same stable field set (see test/socket.contract.test.js).
 */

export const toBookingCreatedDTO = (booking) => ({
  bookingId: booking?._id ? booking._id.toString() : booking?.bookingId,
  status: booking?.status || "pending",
  scheduledAt: booking?.scheduledAt || null,
  baseAmount: booking?.baseAmount ?? null,
});

export const toBookingCancelledDTO = (booking, reason) => ({
  bookingId: booking?._id ? booking._id.toString() : booking?.bookingId,
  status: "cancelled",
  reason,
});

/**
 * job:new payload. Keeps the existing client-facing fields (documented in
 * Modules/08-Job-Matching-Broadcast.md) and adds broadcastId + version so a
 * client can distinguish a re-delivered alert from a genuinely new one.
 *
 * @param {Object} jobData - booking + service fields (bookingId, serviceId,
 *   serviceName, serviceType, description, duration, customerName, baseAmount,
 *   address, scheduledAt)
 * @param {Object} [broadcast] - JobBroadcast doc (broadcastId, version)
 */
export const toJobNewDTO = (jobData, broadcast) => {
  const distanceMeters =
    jobData?.distanceMeters ??
    (jobData?.distanceAtOffer != null ? Math.round(jobData.distanceAtOffer) : null);
  const distanceKm =
    jobData?.distanceKm != null
      ? Number(jobData.distanceKm)
      : distanceMeters != null
        ? Number((distanceMeters / 1000).toFixed(2))
        : null;
  const distanceStr =
    jobData?.distanceStr ||
    (distanceMeters != null
      ? `${(distanceMeters / 1000).toFixed(1)} km`
      : distanceKm != null
        ? `${distanceKm.toFixed(1)} km`
        : null);
  const maxAllowedMeters =
    jobData?.maxAllowedMeters != null
      ? Number(jobData.maxAllowedMeters)
      : jobData?.maxRadiusKm != null
        ? Number(jobData.maxRadiusKm) * 1000
        : 10000;
  const jobRadiusKm =
    jobData?.jobRadiusKm != null
      ? Number(jobData.jobRadiusKm)
      : Number((maxAllowedMeters / 1000).toFixed(2));

  return {
    bookingId: jobData?.bookingId ? jobData.bookingId.toString() : null,
    broadcastId: broadcast?._id ? broadcast._id.toString() : null,
    version: broadcast?.version || 1,
    serviceId: jobData?.serviceId ? jobData.serviceId.toString() : null,
    serviceName: jobData?.serviceName || "New Service",
    serviceType: jobData?.serviceType,
    description: jobData?.description,
    duration: jobData?.duration,
    customerName: jobData?.customerName || "Customer",
    baseAmount: jobData?.baseAmount ?? null,
    address: jobData?.address || "Location unavailable",
    scheduledAt: jobData?.scheduledAt || null,
    latitude: jobData?.latitude ?? null,
    longitude: jobData?.longitude ?? null,
    distanceMeters,
    distanceKm,
    distanceStr,
    jobRadiusKm,
    maxRadiusKm: jobRadiusKm,
    maxAllowedMeters,
  };
};