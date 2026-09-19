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

    const radiusVal = tech.coverageRadiusKm || tech.serviceRadius || tech.radius || 10;

    return res.status(200).json({
      success: true,
      technicianId: String(tech._id),
      primaryDistrict,
      enabledDistricts,
      allowedDistricts: enabledDistricts,
      enabledCityZones,
      groupedZonesByDistrict,
      coverageRadiusKm: radiusVal,
      serviceRadius: radiusVal,
      radius: radiusVal,
    });
  } catch (error) {
    console.error("❌ getTechnicianZonePermissions error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * 2. POST /api/admin/technicians/:technicianId/city-zones
 * Enables one or multiple city zones for a technician. Validates that all zones'
 * parent districts are authorized for the technician first.
 * Supports: { cityZoneId } OR { cityZoneIds: [...] } / { zoneIds: [...] }
 */
export const enableTechnicianZonePermission = async (req, res) => {
  try {
    const { technicianId } = req.params;
    const { cityZoneId, zoneId, cityZoneIds, zoneIds, reason } = req.body || {};

    const rawIds = cityZoneIds || zoneIds || (cityZoneId ? [cityZoneId] : zoneId ? [zoneId] : []);
    const targetZoneIds = [...new Set(rawIds.map((id) => String(id?._id || id)))].filter(Boolean);

    if (!technicianId || targetZoneIds.length === 0) {
      return res.status(400).json({ success: false, message: "technicianId and cityZoneId(s) are required" });
    }

    // 1. Fetch Technician to check authorized parent districts
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

    const activeDistPerms = await TechnicianDistrictPermission.find({
      technicianId,
      isEnabled: true,
    }).select("districtId").lean();

    activeDistPerms.forEach((p) => {
      if (p.districtId) allowedDistrictIds.push(String(p.districtId));
    });

    // 2. Fetch requested zones
    const zones = await CityZone.find({ _id: { $in: targetZoneIds } }).lean();
    if (!zones.length) {
      return res.status(404).json({ success: false, message: "No valid city zones found" });
    }

    const unauthorized = [];
    const validZoneIds = [];

    for (const z of zones) {
      const dId = String(z.operationalCityId || "");
      if (!allowedDistrictIds.includes(dId)) {
        unauthorized.push(z.name);
      } else {
        validZoneIds.push(z._id);
      }
    }

    if (unauthorized.length > 0) {
      return res.status(400).json({
        success: false,
        message: `Cannot enable zone(s) [${unauthorized.join(", ")}]: technician does not have permission for the parent district.`,
      });
    }

    // 3. Enable Zone Permissions via $addToSet
    await TechnicianProfile.updateOne(
      { _id: technicianId },
      {
        $addToSet: {
          enabledCityZoneIds: { $each: validZoneIds },
        },
      }
    );

    // 4. Record Audit Log
    const auditDocs = validZoneIds.map((zid) => ({
      technicianId,
      cityZoneId: zid,
      action: "enabled",
      changedBy: req.user?._id || req.user?.userId,
      reason: reason || "Admin granted zone work permission",
    }));
    await TechnicianZonePermissionAudit.insertMany(auditDocs).catch(() => {});

    // 🔄 Revalidate active broadcasts for this technician (zone permission enabled)
    const { revalidateActiveBroadcasts } = await import("../Utils/technicianLocation.js");
    const techProfile = await TechnicianProfile.findById(technicianId).select("location").lean();
    if (techProfile?.location?.coordinates) {
      const [lng, lat] = techProfile.location.coordinates;
      await revalidateActiveBroadcasts(technicianId, lat, lng, req.io)
        .catch(err => console.error("Zone permission enable revalidation error:", err));
    }

    console.log(`✅ Granted ${validZoneIds.length} zone(s) permission for tech ${technicianId}`);
    return getTechnicianZonePermissions(req, res);
  } catch (error) {
    console.error("❌ enableTechnicianZonePermission error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * 3. DELETE /api/admin/technicians/:technicianId/city-zones/:zoneId (single)
 *    DELETE /api/admin/technicians/:technicianId/city-zones (bulk in body)
 * Revokes one or multiple city zone permissions for a technician.
 */
export const disableTechnicianZonePermission = async (req, res) => {
  try {
    const { technicianId, zoneId } = req.params;
    const { cityZoneId, cityZoneIds, zoneIds, reason } = req.body || {};

    const rawIds = cityZoneIds || zoneIds || (zoneId ? [zoneId] : cityZoneId ? [cityZoneId] : []);
    const targetZoneIds = [...new Set(rawIds.map((id) => String(id?._id || id)))].filter(Boolean);

    if (!technicianId || targetZoneIds.length === 0) {
      return res.status(400).json({ success: false, message: "technicianId and zoneId(s) are required" });
    }

    // 1. Pull zones from enabledCityZoneIds
    await TechnicianProfile.updateOne(
      { _id: technicianId },
      {
        $pull: {
          enabledCityZoneIds: { $in: targetZoneIds },
        },
      }
    );

    // 2. Record Audit Log
    const auditDocs = targetZoneIds.map((zid) => ({
      technicianId,
      cityZoneId: zid,
      action: "disabled",
      changedBy: req.user?._id || req.user?.userId,
      reason: reason || "Admin revoked zone work permission",
    }));
    await TechnicianZonePermissionAudit.insertMany(auditDocs).catch(() => {});

    // 🔄 Revalidate active broadcasts for this technician (zone permission disabled)
    const { revalidateActiveBroadcasts } = await import("../Utils/technicianLocation.js");
    const tech = await TechnicianProfile.findById(technicianId).select("location").lean();
    if (tech?.location?.coordinates) {
      const [lng, lat] = tech.location.coordinates;
      await revalidateActiveBroadcasts(technicianId, lat, lng, req.io)
        .catch(err => console.error("Zone permission disable revalidation error:", err));
    }

    console.log(`🚫 Revoked ${targetZoneIds.length} zone(s) permission for tech ${technicianId}`);
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
