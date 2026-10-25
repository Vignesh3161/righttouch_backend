const finiteNumber = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

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

export default { buildJobDispatchPayload };
