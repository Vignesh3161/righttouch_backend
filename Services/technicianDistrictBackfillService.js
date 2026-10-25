const idString = (value) => {
  if (!value) return null;
  return String(value._id || value);
};

export const getBackfillDistrictId = (profile) => {
  if (!profile) return null;
  const direct = idString(profile.primaryDistrictId || profile.primaryCityId);
  if (direct) return direct;
  const legacy = [
    ...(profile.enabledDistrictIds || []),
    ...(profile.allowedCityIds || []),
  ].map(idString).find(Boolean);
  return legacy || null;
};

export const inspectBackfillCandidate = ({
  profile,
  district = null,
  activeZoneCount = 0,
  enabledPermissionCount = 0,
  zoneDistrictId = null,
}) => {
  const districtId = getBackfillDistrictId(profile) || idString(zoneDistrictId);
  const hasDistrictCache = (profile?.enabledDistrictIds || []).length > 0;
  const hasZoneCache = (profile?.enabledCityZoneIds || []).length > 0;
  const hasPermissionRows = enabledPermissionCount > 0;
  const needed = !hasDistrictCache || !hasZoneCache || !hasPermissionRows;

  if (!needed) {
    return {
      needed: false,
      eligible: true,
      reason: "PERMISSIONS_PRESENT",
      districtId,
    };
  }

  if (!districtId) {
    return {
      needed: true,
      eligible: false,
      reason: "PRIMARY_DISTRICT_REQUIRED",
      districtId: null,
    };
  }

  if (!district) {
    return {
      needed: true,
      eligible: false,
      reason: "DISTRICT_NOT_FOUND",
      districtId,
    };
  }

  if (district.active === false || district.isActive === false) {
    return {
      needed: true,
      eligible: false,
      reason: "DISTRICT_INACTIVE",
      districtId,
    };
  }

  if (district.isJobEnabled === false) {
    return {
      needed: true,
      eligible: false,
      reason: "DISTRICT_JOBS_DISABLED",
      districtId,
    };
  }

  if (activeZoneCount <= 0) {
    return {
      needed: true,
      eligible: false,
      reason: "NO_ACTIVE_ZONES",
      districtId,
    };
  }

  return {
    needed: true,
    eligible: true,
    reason: "MISSING_PERMISSIONS",
    districtId,
  };
};

export default {
  getBackfillDistrictId,
  inspectBackfillCandidate,
};
