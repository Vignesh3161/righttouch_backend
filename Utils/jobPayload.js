const finiteNumber = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

export const resolveBookingJobLocation = (booking = {}) => {
  const snapshot = booking?.addressSnapshot || {};
  const coordinates = booking?.location?.coordinates;
  const latitude = finiteNumber(snapshot.latitude) ?? finiteNumber(coordinates?.[1]);
  const longitude = finiteNumber(snapshot.longitude) ?? finiteNumber(coordinates?.[0]);

  return {
    address: snapshot.addressLine || booking?.address || "Location unavailable",
    city: snapshot.city || "",
    state: snapshot.state || "",
    pincode: snapshot.pincode || "",
    customerName: snapshot.name || "Customer",
    customerMobile: snapshot.phone || "",
    latitude,
    longitude,
  };
};

export const buildJobScheduleFields = (booking = {}) => ({
  bookingType: booking?.bookingType === "schedule" ? "schedule" : "instant",
  scheduledAt: booking?.scheduledAt || null,
  slotKey: booking?.slotKey || null,
  slotValue: booking?.slotValue || null,
  slotLabel: booking?.slotLabel || null,
  slotStartAt: booking?.slotStartAt || null,
  slotEndAt: booking?.slotEndAt || null,
  scheduledDateLocal: booking?.scheduledDateLocal || null,
  scheduledTimeLocal: booking?.scheduledTimeLocal || null,
});

export const buildJobDispatchPayload = (base, geo = {}) => {
  const latitude = finiteNumber(geo.latitude);
  const longitude = finiteNumber(geo.longitude);
  const distanceMeters = finiteNumber(geo.distanceMeters);
  const effectiveRadiusMeters = finiteNumber(geo.effectiveRadiusMeters) ?? 10000;
  const distanceKm =
    distanceMeters != null ? Number((distanceMeters / 1000).toFixed(2)) : null;
  const distanceStr =
    distanceMeters != null ? `${(distanceMeters / 1000).toFixed(1)} km` : null;
  const radiusKm = Number((effectiveRadiusMeters / 1000).toFixed(2));

  return {
    ...base,
    latitude,
    longitude,
    distanceMeters: distanceMeters != null ? Math.round(distanceMeters) : null,
    distanceKm,
    distanceStr,
    jobRadiusKm: radiusKm,
    maxRadiusKm: radiusKm,
    maxAllowedMeters: effectiveRadiusMeters,
  };
};

export default { buildJobDispatchPayload, buildJobScheduleFields, resolveBookingJobLocation };
