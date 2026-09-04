import mongoose from "mongoose";
import TechnicianProfile from "../Schemas/TechnicianProfile.js";
import OperationalCity from "../Schemas/OperationalCity.js";
import TechnicianDistrictPermission from "../Schemas/TechnicianDistrictPermission.js";
import { writeAuditLog } from "../Utils/audit.js";

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * 🗺 TECHNICIAN DISTRICT SERVICE
 * Business logic layer for technician district permissions and authorization.
 */

/**
 * Syncs TechnicianProfile.allowedCityIds with enabled TechnicianDistrictPermission records.
 */
export const syncAllowedCityIds = async (technicianProfileId) => {
  const profile = await TechnicianProfile.findById(technicianProfileId).select("primaryCityId allowedCityIds").lean();
  if (!profile) return [];

  const permissions = await TechnicianDistrictPermission.find({
    technicianId: technicianProfileId,
    isEnabled: true,
  })
    .select("districtId permissionType")
    .lean();

  const additionalDistrictIds = permissions
    .filter((p) => p.permissionType === "ADDITIONAL")
    .map((p) => p.districtId);

  await TechnicianProfile.updateOne(
    { _id: technicianProfileId },
    { $set: { allowedCityIds: additionalDistrictIds } }
  );

  return additionalDistrictIds;
};

/**
 * Returns all authorized district IDs (primaryCityId + enabled allowedCityIds) for a technician profile.
 * Auto-heals legacy profiles without primaryCityId.
 */
export const getAllowedDistrictsForTechnician = async (techProfile) => {
  if (!techProfile) return [];

  let profileDoc = techProfile;
  if (typeof techProfile === "string" || techProfile instanceof mongoose.Types.ObjectId) {
    profileDoc = await TechnicianProfile.findById(techProfile).select("_id primaryCityId allowedCityIds cityZoneId city").lean();
  }

  if (!profileDoc) return [];

  let primaryId = profileDoc.primaryCityId;

  // Auto-heal legacy profile if primaryCityId is null
  if (!primaryId) {
    if (profileDoc.city) {
      const matchedCity = await OperationalCity.findOne({
        name: new RegExp(`^${escapeRegExp(String(profileDoc.city).trim())}$`, "i"),
        active: true,
      })
        .select("_id")
        .lean();

      if (matchedCity?._id) {
        primaryId = matchedCity._id;
        await TechnicianProfile.updateOne({ _id: profileDoc._id }, { $set: { primaryCityId: primaryId } }).catch(() => {});
        // Also seed primary permission row if missing
        await TechnicianDistrictPermission.updateOne(
          { technicianId: profileDoc._id, districtId: primaryId },
          { $setOnInsert: { permissionType: "PRIMARY", isEnabled: true, enabledAt: new Date() } },
          { upsert: true }
        ).catch(() => {});
      }
    }
  }

  // Load active additional district permissions from DB
  const permissions = await TechnicianDistrictPermission.find({
    technicianId: profileDoc._id,
    isEnabled: true,
  })
    .select("districtId")
    .lean();

  const additionalIdsFromDb = permissions.map((p) => String(p.districtId));
  const additionalIdsFromProfile = Array.isArray(profileDoc.allowedCityIds)
    ? profileDoc.allowedCityIds.map((id) => String(id))
    : [];

  const allIds = [primaryId ? String(primaryId) : null, ...additionalIdsFromDb, ...additionalIdsFromProfile]
    .filter(Boolean);

  return Array.from(new Set(allIds));
};

/**
 * Evaluates whether a technician is authorized to work in a specific district.
 * Checks district status, job enablement, primary district, and additional permissions.
 */
export const isTechnicianAllowedInDistrict = async (technicianId, districtId) => {
  if (!technicianId || !districtId) return false;

  const district = await OperationalCity.findById(districtId).select("active isJobEnabled").lean();
  if (!district || district.active === false || district.isJobEnabled === false) {
    return false;
  }

  const allowedDistrictIds = await getAllowedDistrictsForTechnician(technicianId);
  return allowedDistrictIds.includes(String(districtId));
};

/**
 * Admin action: Adds an additional district permission to a technician.
 */
export const addDistrictPermission = async ({ technicianId, districtId, adminUserId, adminRole }) => {
  const profile = await TechnicianProfile.findById(technicianId);
  if (!profile || profile.workStatus === "deleted" || profile.workStatus === "suspended") {
    throw new Error("Technician does not exist or is not active");
  }

  const district = await OperationalCity.findById(districtId);
  if (!district || district.active === false || district.isActive === false) {
    throw new Error("District does not exist or is inactive");
  }

  if (district.isJobEnabled === false) {
    throw new Error("District job assignment is currently disabled");
  }

  if (profile.primaryCityId && String(profile.primaryCityId) === String(districtId)) {
    throw new Error("District is already technician's primary district");
  }

  const existing = await TechnicianDistrictPermission.findOne({
    technicianId,
    districtId,
  });

  if (existing) {
    if (existing.isEnabled) {
      throw new Error("District permission already granted for this technician");
    }
    existing.isEnabled = true;
    existing.enabledBy = adminUserId;
    existing.enabledAt = new Date();
    existing.disabledBy = null;
    existing.disabledAt = null;
    await existing.save();
  } else {
    await TechnicianDistrictPermission.create({
      technicianId,
      districtId,
      permissionType: "ADDITIONAL",
      isEnabled: true,
      enabledBy: adminUserId,
      enabledAt: new Date(),
    });
  }

  await syncAllowedCityIds(technicianId);

  await writeAuditLog({
    actor: adminUserId,
    actorRole: adminRole || "Admin",
    action: "DISTRICT_ADDED",
    targetType: "TechnicianProfile",
    targetId: technicianId,
    after: { districtId, isEnabled: true },
  });

  return { success: true, message: "District permission added successfully" };
};

/**
 * Admin action: Enables or disables an additional district permission for a technician.
 */
export const toggleDistrictPermission = async ({ technicianId, districtId, isEnabled, adminUserId, adminRole }) => {
  const profile = await TechnicianProfile.findById(technicianId);
  if (!profile) {
    throw new Error("Technician not found");
  }

  if (profile.primaryCityId && String(profile.primaryCityId) === String(districtId)) {
    throw new Error("Cannot disable technician's primary district permission via additional permissions");
  }

  const permission = await TechnicianDistrictPermission.findOne({ technicianId, districtId });
  if (!permission) {
    throw new Error("District permission record not found");
  }

  if (isEnabled) {
    const district = await OperationalCity.findById(districtId);
    if (!district || district.active === false || district.isActive === false) {
      throw new Error("Cannot enable permission: District does not exist or is inactive");
    }
    if (district.isJobEnabled === false) {
      throw new Error("Cannot enable permission: District job assignment is disabled");
    }
    permission.isEnabled = true;
    permission.enabledBy = adminUserId;
    permission.enabledAt = new Date();
  } else {
    permission.isEnabled = false;
    permission.disabledBy = adminUserId;
    permission.disabledAt = new Date();
  }

  await permission.save();
  await syncAllowedCityIds(technicianId);

  await writeAuditLog({
    actor: adminUserId,
    actorRole: adminRole || "Admin",
    action: isEnabled ? "DISTRICT_ENABLED" : "DISTRICT_DISABLED",
    targetType: "TechnicianProfile",
    targetId: technicianId,
    after: { districtId, isEnabled },
  });

  return { success: true, message: `District permission ${isEnabled ? "enabled" : "disabled"} successfully` };
};

/**
 * Admin action: Removes an additional district permission.
 */
export const removeDistrictPermission = async ({ technicianId, districtId, adminUserId, adminRole }) => {
  const profile = await TechnicianProfile.findById(technicianId);
  if (profile && profile.primaryCityId && String(profile.primaryCityId) === String(districtId)) {
    throw new Error("Cannot remove primary district permission");
  }

  const res = await TechnicianDistrictPermission.findOneAndDelete({ technicianId, districtId });
  if (!res) {
    throw new Error("District permission record not found");
  }

  await syncAllowedCityIds(technicianId);

  await writeAuditLog({
    actor: adminUserId,
    actorRole: adminRole || "Admin",
    action: "DISTRICT_REMOVED",
    targetType: "TechnicianProfile",
    targetId: technicianId,
    before: { districtId },
  });

  return { success: true, message: "District permission removed successfully" };
};

export default {
  syncAllowedCityIds,
  getAllowedDistrictsForTechnician,
  isTechnicianAllowedInDistrict,
  addDistrictPermission,
  toggleDistrictPermission,
  removeDistrictPermission,
};
