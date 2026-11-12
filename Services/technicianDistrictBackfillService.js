const idString = (value) => {
  if (!value) return null;
  return String(value._id || value);
};

export const getBackfillDistrictId = (profile) => {
  if (!profile) return null;
  return idString(profile.primaryDistrictId || profile.primaryCityId);
};

/**
 * Backfill only repairs missing primary-district registration metadata.
 * District/zone coverage is never auto-granted here — admins grant it
 * explicitly through TechnicianDistrictPermission rows.
 */
export const inspectBackfillCandidate = ({
  profile,
  district = null,
  activeZoneCount = 0,
  zoneDistrictId = null,
}) => {
  const primaryDistrictId = getBackfillDistrictId(profile);
  const districtId = primaryDistrictId || idString(zoneDistrictId);

  if (primaryDistrictId) {
    return {
      needed: false,
      eligible: true,
      reason: "PRIMARY_METADATA_PRESENT",
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
    reason: "MISSING_PRIMARY_METADATA",
    districtId,
  };
};

export default {
  getBackfillDistrictId,
  inspectBackfillCandidate,
};
