import TechnicianProfile from "../Schemas/TechnicianProfile.js";
import CityZone from "../Schemas/CityZone.js";
import OperationalCity from "../Schemas/OperationalCity.js";
import TechnicianDistrictPermission from "../Schemas/TechnicianDistrictPermission.js";
import TechnicianZonePermissionAudit from "../Schemas/TechnicianZonePermissionAudit.js";

/**
 * 🏙 ADMIN TECHNICIAN CITY ZONE PERMISSION CONTROLLER
 * Grants and revokes granular city zone work permissions for technicians.
 */

/**
 * 1. GET /api/admin/technicians/:technicianId/city-zones
 * Returns primary district, enabled districts, and enabled city zones for a technician.
 */
export const getTechnicianZonePermissions = async (req, res) => {
  try {
    const { technicianId } = req.params;
    if (!technicianId) {
      return res.status(400).json({ success: false, message: "Technician ID is required" });
    }

    const tech = await TechnicianProfile.findById(technicianId)
      .populate("primaryDistrictId", "name code city")
      .populate("primaryCityId", "name code city")
      .populate("enabledDistrictIds", "name code city")
      .populate("allowedCityIds", "name code city")
      .populate("enabledCityZoneIds", "name zoneCode operationalCityId")
      .lean();

    if (!tech) {
      return res.status(404).json({ success: false, message: "Technician profile not found" });
    }

    // Resolve primary district
    const primaryDistrictObj = tech.primaryDistrictId || tech.primaryCityId || null;
    const primaryDistrict = primaryDistrictObj
      ? { id: String(primaryDistrictObj._id), name: primaryDistrictObj.name || primaryDistrictObj.city }
      : null;

    // Resolve explicit district permissions from TechnicianDistrictPermission model
    const dbDistrictPerms = await TechnicianDistrictPermission.find({
      technicianId,
      isEnabled: true,
    })
      .populate("districtId", "name code city")
      .lean();

    const enabledDistrictMap = new Map();

    // Include primary district if present
    if (primaryDistrictObj?._id) {
      enabledDistrictMap.set(String(primaryDistrictObj._id), {
        id: String(primaryDistrictObj._id),
        name: primaryDistrictObj.name || primaryDistrictObj.city,
        isPrimary: true,
      });
    }

    // Include enabledDistrictIds / allowedCityIds array entries
    const profileDistricts = [...(tech.enabledDistrictIds || []), ...(tech.allowedCityIds || [])];
    for (const d of profileDistricts) {
      if (d?._id) {
        enabledDistrictMap.set(String(d._id), {
          id: String(d._id),
          name: d.name || d.city,
          isPrimary: String(d._id) === String(primaryDistrictObj?._id),
        });
      }
    }

    // Include TechnicianDistrictPermission model rows
    for (const perm of dbDistrictPerms) {
      if (perm.districtId?._id) {
        enabledDistrictMap.set(String(perm.districtId._id), {
          id: String(perm.districtId._id),
          name: perm.districtId.name || perm.districtId.city,
          isPrimary: perm.permissionType === "PRIMARY",
        });
      }
    }

    const enabledDistricts = Array.from(enabledDistrictMap.values());

    // Resolve enabled city zones
    const enabledCityZones = (tech.enabledCityZoneIds || []).map((z) => ({
      id: String(z._id || z),
      name: z.name || "Zone",
      zoneCode: z.zoneCode || "",
      districtId: z.operationalCityId ? String(z.operationalCityId) : null,
    }));

    // Fetch all active operational districts and their active zones for UI grouping
    const allDistricts = await OperationalCity.find({ active: true }).select("_id name city").lean();
    const allZones = await CityZone.find({ active: true }).select("_id name zoneCode operationalCityId").lean();

    const groupedZonesByDistrict = {};
    for (const d of allDistricts) {
      const dId = String(d._id);
      const districtZones = allZones.filter((z) => String(z.operationalCityId) === dId);
      groupedZonesByDistrict[dId] = {
        districtId: dId,
        districtName: d.name || d.city,
        hasDistrictPermission: enabledDistrictMap.has(dId),
        zones: districtZones.map((z) => ({
          id: String(z._id),
          name: z.name,
          zoneCode: z.zoneCode,
          isEnabled: enabledCityZones.some((ez) => ez.id === String(z._id)),
        })),
      };
    }

    return res.status(200).json({
      success: true,
      technicianId: String(tech._id),
      primaryDistrict,
      enabledDistricts,
      enabledCityZones,
      groupedZonesByDistrict,
    });
  } catch (error) {
    console.error("❌ getTechnicianZonePermissions error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * 2. POST /api/admin/technicians/:technicianId/city-zones
 * Enables a specific city zone for a technician. Validates that the zone's parent
 * district is enabled for the technician first.
 */
export const enableTechnicianZonePermission = async (req, res) => {
  try {
    const { technicianId } = req.params;
    const { cityZoneId, reason } = req.body;

    if (!technicianId || !cityZoneId) {
      return res.status(400).json({ success: false, message: "technicianId and cityZoneId are required" });
    }

    // 1. Find CityZone and its operational district
    const zone = await CityZone.findById(cityZoneId).lean();
    if (!zone) {
      return res.status(404).json({ success: false, message: "City zone not found" });
    }

    const districtId = zone.operationalCityId;
    if (!districtId) {
      return res.status(400).json({ success: false, message: "City zone does not belong to an operational district" });
    }

    const district = await OperationalCity.findById(districtId).select("name city").lean();
    const districtName = district?.name || district?.city || "Unknown District";

    // 2. Validate Technician District Permission
    const tech = await TechnicianProfile.findById(technicianId).lean();
    if (!tech) {
      return res.status(404).json({ success: false, message: "Technician profile not found" });
    }

    const allowedDistrictIds = [
      tech.primaryDistrictId ? String(tech.primaryDistrictId) : null,
      tech.primaryCityId ? String(tech.primaryCityId) : null,
      ...(tech.enabledDistrictIds || []).map((id) => String(id._id || id)),
      ...(tech.allowedCityIds || []).map((id) => String(id._id || id)),
    ].filter(Boolean);

    // Also check TechnicianDistrictPermission collection
    const activeDistPerm = await TechnicianDistrictPermission.findOne({
      technicianId,
      districtId,
      isEnabled: true,
    }).lean();

    const hasDistrictAccess = allowedDistrictIds.includes(String(districtId)) || Boolean(activeDistPerm);

    if (!hasDistrictAccess) {
      return res.status(400).json({
        success: false,
        message: `Cannot enable zone "${zone.name}". Technician does not have permission for the parent district "${districtName}".`,
      });
    }

    // 3. Enable Zone Permission (addToSet)
    await TechnicianProfile.updateOne(
      { _id: technicianId },
      {
        $addToSet: {
          enabledCityZoneIds: cityZoneId,
        },
      }
    );

    // 4. Record Audit Log
    await TechnicianZonePermissionAudit.create({
      technicianId,
      cityZoneId,
      action: "enabled",
      changedBy: req.user._id,
      reason: reason || "Admin granted zone work permission",
    });

    console.log(`✅ Granted zone ${zone.name} (${cityZoneId}) permission for tech ${technicianId}`);
    return getTechnicianZonePermissions(req, res);
  } catch (error) {
    console.error("❌ enableTechnicianZonePermission error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * 3. DELETE /api/admin/technicians/:technicianId/city-zones/:zoneId
 * Revokes a city zone permission for a technician.
 */
export const disableTechnicianZonePermission = async (req, res) => {
  try {
    const { technicianId, zoneId } = req.params;
    const { reason } = req.body || {};

    if (!technicianId || !zoneId) {
      return res.status(400).json({ success: false, message: "technicianId and zoneId are required" });
    }

    // 1. Pull zone from enabledCityZoneIds
    await TechnicianProfile.updateOne(
      { _id: technicianId },
      {
        $pull: {
          enabledCityZoneIds: zoneId,
        },
      }
    );

    // 2. Record Audit Log
    await TechnicianZonePermissionAudit.create({
      technicianId,
      cityZoneId: zoneId,
      action: "disabled",
      changedBy: req.user._id,
      reason: reason || "Admin revoked zone work permission",
    });

    console.log(`🚫 Revoked zone ${zoneId} permission for tech ${technicianId}`);
    return getTechnicianZonePermissions(req, res);
  } catch (error) {
    console.error("❌ disableTechnicianZonePermission error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

export default {
  getTechnicianZonePermissions,
  enableTechnicianZonePermission,
  disableTechnicianZonePermission,
};
