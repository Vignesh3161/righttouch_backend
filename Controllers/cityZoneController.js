import mongoose from "mongoose";
import CityZone from "../Schemas/CityZone.js";
import ZoneServiceMapping from "../Schemas/ZoneServiceMapping.js";
import OperationalCity from "../Schemas/OperationalCity.js";
import { writeAuditLog } from "../Utils/audit.js";
import { validateGeoJsonPolygon } from "../Utils/servicePolygon.js";

const isOwnerOrAdmin = (req) => ["Owner", "Admin"].includes(req.user?.role);
const isValidObjectId = (v) => mongoose.Types.ObjectId.isValid(v);

// Strict boolean parsing — Boolean("false") === true is a classic bug,
// so string query/body values must be parsed explicitly.
const parseBoolean = (v) => {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (["true", "1", "yes", "y", "on"].includes(s)) return true;
    if (["false", "0", "no", "n", "off"].includes(s)) return false;
  }
  return Boolean(v);
};

/* =====================================================
   LIST CITY ZONES
   ===================================================== */
export const listCityZones = async (req, res) => {
  try {
    if (!isOwnerOrAdmin(req)) {
      return res.status(403).json({ success: false, message: "Owner/Admin access only" });
    }
    const { operationalCityId, active } = req.query;
    const filter = {};
    if (operationalCityId) {
      if (!isValidObjectId(operationalCityId)) {
        return res.status(400).json({ success: false, message: "Invalid operationalCityId", result: [] });
      }
      filter.operationalCityId = operationalCityId;
    }
    if (active !== undefined && active !== "") filter.active = parseBoolean(active);

    const zones = await CityZone.find(filter)
      .populate("operationalCityId", "name")
      .sort({ updatedAt: -1 })
      .lean();

    return res.status(200).json({
      success: true,
      message: "City zones fetched",
      result: zones,
      meta: { count: zones.length },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

/* =====================================================
   GET SINGLE CITY ZONE
   ===================================================== */
export const getCityZone = async (req, res) => {
  try {
    if (!isOwnerOrAdmin(req)) {
      return res.status(403).json({ success: false, message: "Owner/Admin access only" });
    }
    const { id } = req.params;
    if (!isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: "Invalid zone ID", result: {} });
    }

    const zone = await CityZone.findById(id)
      .populate("operationalCityId", "name")
      .lean();

    if (!zone) {
      return res.status(404).json({ success: false, message: "City zone not found", result: {} });
    }

    return res.status(200).json({ success: true, result: zone });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

/* =====================================================
   CREATE CITY ZONE
   ===================================================== */
export const createCityZone = async (req, res) => {
  try {
    if (!isOwnerOrAdmin(req)) {
      return res.status(403).json({ success: false, message: "Owner/Admin access only" });
    }

    const { operationalCityId, name, zoneCode, active = true, description } = req.body;
    const polygon = req.body.polygon;

    if (!operationalCityId || !isValidObjectId(operationalCityId)) {
      return res.status(400).json({ success: false, message: "Valid operationalCityId is required", result: {} });
    }
    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: "name is required", result: {} });
    }
    if (!zoneCode || !zoneCode.trim()) {
      return res.status(400).json({ success: false, message: "zoneCode is required", result: {} });
    }

    const polygonError = validateGeoJsonPolygon(polygon);
    if (polygonError) {
      return res.status(400).json({ success: false, message: polygonError, result: {} });
    }

    // Ensure the operational city exists
    const opCity = await OperationalCity.findById(operationalCityId).lean();
    if (!opCity) {
      return res.status(404).json({ success: false, message: "Operational city not found", result: {} });
    }

    const zone = await CityZone.create({
      operationalCityId,
      name: name.trim(),
      zoneCode: zoneCode.trim().toUpperCase(),
      polygon,
      active: parseBoolean(active),
      description: description || null,
    });

    // Required architecture: new zones default every service to DISABLED.
    // Pre-create inactive ZoneServiceMapping rows (and matching ZONE DISABLED
    // ServiceAvailability overrides) for all active services so "no mapping"
    // can never be misread as available and the admin screen lists every
    // service as DISABLED until explicitly enabled.
    let seededCount = 0;
    try {
      const Service = mongoose.model("Service");
      const activeServices = await Service.find({ isActive: true }).select("_id").lean();
      if (activeServices.length) {
        const mapOps = activeServices.map((s) => ({
          updateOne: {
            filter: { zoneId: zone._id, serviceId: s._id },
            update: {
              $setOnInsert: {
                zoneId: zone._id,
                serviceId: s._id,
                approvedBy: req.user?.userId || null,
                approvedAt: new Date(),
              },
              $set: { active: false },
            },
            upsert: true,
          },
        }));
        const mapRes = await ZoneServiceMapping.bulkWrite(mapOps, { ordered: false });
        seededCount = mapRes.upsertedCount ?? activeServices.length;
        try {
          const ServiceAvailability = mongoose.model("ServiceAvailability");
          const availOps = activeServices.map((s) => ({
            updateOne: {
              filter: {
                serviceId: s._id,
                districtId: zone.operationalCityId,
                cityZoneId: zone._id,
                scope: "ZONE",
              },
              update: {
                $set: {
                  serviceId: s._id,
                  districtId: zone.operationalCityId,
                  cityZoneId: zone._id,
                  scope: "ZONE",
                  status: "DISABLED",
                  updatedBy: req.user?.userId || null,
                },
              },
              upsert: true,
            },
          }));
          await ServiceAvailability.bulkWrite(availOps, { ordered: false });
        } catch (e) {
          console.warn("zone-create availability seed warning:", e.message);
        }
      }
    } catch (e) {
      console.warn("zone-create mapping seed warning:", e.message);
    }

    await writeAuditLog({
      actor: req.user.userId,
      actorRole: req.user.role,
      action: "CITY_ZONE_CREATED",
      targetType: "CityZone",
      targetId: zone._id,
      after: { name: zone.name, zoneCode: zone.zoneCode, active: zone.active, seededDisabledServices: seededCount },
    });

    return res.status(201).json({
      success: true,
      message: `City zone created (${seededCount} services defaulted to DISABLED)`,
      result: { ...zone.toObject(), seededDisabledServices: seededCount },
    });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ success: false, message: "Zone code already exists", result: {} });
    }
    return res.status(500).json({ success: false, message: err.message });
  }
};

/* =====================================================
   UPDATE CITY ZONE
   ===================================================== */
export const updateCityZone = async (req, res) => {
  try {
    if (!isOwnerOrAdmin(req)) {
      return res.status(403).json({ success: false, message: "Owner/Admin access only" });
    }
    const { id } = req.params;
    if (!isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: "Invalid zone ID", result: {} });
    }

    const existing = await CityZone.findById(id);
    if (!existing) {
      return res.status(404).json({ success: false, message: "City zone not found", result: {} });
    }

    const update = {};
    if (req.body.name !== undefined) {
      if (!String(req.body.name).trim()) {
        return res.status(400).json({ success: false, message: "name cannot be empty", result: {} });
      }
      update.name = String(req.body.name).trim();
    }
    if (req.body.zoneCode !== undefined) {
      if (!String(req.body.zoneCode).trim()) {
        return res.status(400).json({ success: false, message: "zoneCode cannot be empty", result: {} });
      }
      update.zoneCode = String(req.body.zoneCode).trim().toUpperCase();
    }
    if (req.body.active !== undefined) update.active = parseBoolean(req.body.active);
    if (req.body.description !== undefined) update.description = req.body.description || null;
    if (req.body.polygon !== undefined) {
      const polygonError = validateGeoJsonPolygon(req.body.polygon);
      if (polygonError) {
        return res.status(400).json({ success: false, message: polygonError, result: {} });
      }
      update.polygon = req.body.polygon;
    }

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ success: false, message: "Nothing to update", result: {} });
    }

    const zone = await CityZone.findByIdAndUpdate(id, update, {
      new: true,
      runValidators: true,
    });

    await writeAuditLog({
      actor: req.user.userId,
      actorRole: req.user.role,
      action: "CITY_ZONE_UPDATED",
      targetType: "CityZone",
      targetId: zone._id,
      before: { name: existing.name, zoneCode: existing.zoneCode, active: existing.active },
      after: { name: zone.name, zoneCode: zone.zoneCode, active: zone.active },
    });

    return res.status(200).json({ success: true, message: "City zone updated", result: zone });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ success: false, message: "Zone code already exists", result: {} });
    }
    return res.status(500).json({ success: false, message: err.message });
  }
};

/* =====================================================
   DELETE CITY ZONE
   ===================================================== */
export const deleteCityZone = async (req, res) => {
  try {
    if (!isOwnerOrAdmin(req)) {
      return res.status(403).json({ success: false, message: "Owner/Admin access only" });
    }
    const { id } = req.params;
    if (!isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: "Invalid zone ID", result: {} });
    }

    const zone = await CityZone.findByIdAndDelete(id);
    if (!zone) {
      return res.status(404).json({ success: false, message: "City zone not found", result: {} });
    }

    // Clean up all zone references — mappings, per-zone availability overrides,
    // technician permissions/registrations pointing at the deleted zone.
    const zoneObjId = new mongoose.Types.ObjectId(id);
    await Promise.all([
      ZoneServiceMapping.deleteMany({ zoneId: zoneObjId }),
      mongoose.model("ServiceAvailability").deleteMany({
        $or: [{ cityZoneId: zoneObjId }, { cityId: zoneObjId }],
      }).catch(() => null),
      mongoose.model("TechnicianProfile").updateMany(
        { enabledCityZoneIds: zoneObjId },
        { $pull: { enabledCityZoneIds: zoneObjId } }
      ).catch(() => null),
      mongoose.model("TechnicianProfile").updateMany(
        { cityZoneId: zoneObjId },
        { $set: { cityZoneId: null } }
      ).catch(() => null),
      mongoose.model("TechnicianProfile").updateMany(
        { currentCityZoneId: zoneObjId },
        { $set: { currentCityZoneId: null } }
      ).catch(() => null),
    ]);

    await writeAuditLog({
      actor: req.user.userId,
      actorRole: req.user.role,
      action: "CITY_ZONE_DELETED",
      targetType: "CityZone",
      targetId: id,
      before: { name: zone.name, zoneCode: zone.zoneCode },
    });

    return res.status(200).json({ success: true, message: "City zone deleted", result: {} });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

/* =====================================================
   ZONE-SERVICE MAPPING — LIST
   ===================================================== */
export const listZoneServiceMappings = async (req, res) => {
  try {
    if (!isOwnerOrAdmin(req)) {
      return res.status(403).json({ success: false, message: "Owner/Admin access only" });
    }
    const { zoneId, serviceId, active } = req.query;
    const filter = {};
    if (zoneId) {
      if (!isValidObjectId(zoneId)) {
        return res.status(400).json({ success: false, message: "Invalid zoneId", result: [] });
      }
      filter.zoneId = zoneId;
    }
    if (serviceId) {
      if (!isValidObjectId(serviceId)) {
        return res.status(400).json({ success: false, message: "Invalid serviceId", result: [] });
      }
      filter.serviceId = serviceId;
    }
    if (active !== undefined && active !== "") filter.active = parseBoolean(active);

    const mappings = await ZoneServiceMapping.find(filter)
      .populate("zoneId", "name zoneCode")
      .populate("serviceId", "serviceName")
      .sort({ updatedAt: -1 })
      .lean();

    return res.status(200).json({
      success: true,
      result: mappings,
      meta: { count: mappings.length },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

/* =====================================================
   ZONE-SERVICE MAPPING — CREATE (BULK)
   ===================================================== */
export const createZoneServiceMappings = async (req, res) => {
  try {
    if (!isOwnerOrAdmin(req)) {
      return res.status(403).json({ success: false, message: "Owner/Admin access only" });
    }

    const { zoneId, serviceIds } = req.body;
    if (!zoneId || !isValidObjectId(zoneId)) {
      return res.status(400).json({ success: false, message: "Valid zoneId is required", result: {} });
    }
    if (!Array.isArray(serviceIds) || serviceIds.length === 0) {
      return res.status(400).json({ success: false, message: "serviceIds array is required", result: {} });
    }

    const zone = await CityZone.findById(zoneId).lean();
    if (!zone) {
      return res.status(404).json({ success: false, message: "City zone not found", result: {} });
    }

    const validServiceIds = serviceIds.filter((id) => isValidObjectId(id));
    if (validServiceIds.length === 0) {
      return res.status(400).json({ success: false, message: "No valid serviceIds provided", result: {} });
    }

    const bulkOps = validServiceIds.map((serviceId) => ({
      updateOne: {
        filter: { zoneId, serviceId },
        update: {
          $setOnInsert: {
            zoneId,
            serviceId,
            approvedBy: req.user.userId,
            approvedAt: new Date(),
          },
          $set: { active: true },
        },
        upsert: true,
      },
    }));

    const result = await ZoneServiceMapping.bulkWrite(bulkOps, { ordered: false });

    // Keep ServiceAvailability ZONE overrides in sync (same as
    // toggleZoneServices / toggleZoneAvailability) so the unified resolver
    // sees ENABLED for these services instead of a stale DISABLED row.
    try {
      const ServiceAvailability = mongoose.model("ServiceAvailability");
      const availOps = validServiceIds.map((serviceId) => ({
        updateOne: {
          filter: {
            serviceId: new mongoose.Types.ObjectId(serviceId),
            districtId: zone.operationalCityId,
            cityZoneId: zone._id,
            scope: "ZONE",
          },
          update: {
            $set: {
              serviceId: new mongoose.Types.ObjectId(serviceId),
              districtId: zone.operationalCityId,
              cityZoneId: zone._id,
              scope: "ZONE",
              status: "ENABLED",
              updatedBy: req.user?.userId || null,
            },
          },
          upsert: true,
        },
      }));
      await ServiceAvailability.bulkWrite(availOps, { ordered: false });
    } catch (e) {
      console.warn("zone-mapping availability sync warning:", e.message);
    }

    await writeAuditLog({
      actor: req.user.userId,
      actorRole: req.user.role,
      action: "ZONE_SERVICE_MAPPINGS_CREATED",
      targetType: "ZoneServiceMapping",
      targetId: zoneId,
      after: { zoneCode: zone.zoneCode, serviceCount: validServiceIds.length },
    });

    return res.status(201).json({
      success: true,
      message: "Zone-service mappings created",
      result: {
        upsertedCount: result.upsertedCount,
        modifiedCount: result.modifiedCount,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

/* =====================================================
   ZONE-SERVICE MAPPING — DELETE
   ===================================================== */
export const deleteZoneServiceMapping = async (req, res) => {
  try {
    if (!isOwnerOrAdmin(req)) {
      return res.status(403).json({ success: false, message: "Owner/Admin access only" });
    }

    const { zoneId, serviceId } = req.params;
    if (!isValidObjectId(zoneId) || !isValidObjectId(serviceId)) {
      return res.status(400).json({ success: false, message: "Invalid zoneId or serviceId", result: {} });
    }

    const mapping = await ZoneServiceMapping.findOneAndDelete({ zoneId, serviceId });
    if (!mapping) {
      return res.status(404).json({ success: false, message: "Mapping not found", result: {} });
    }

    // Keep the ZONE override in sync so a stale ENABLED row cannot
    // resurrect the service via the district-fallback path. Resolver gates
    // on the mapping first, but sync keeps both admin UIs consistent.
    try {
      const ServiceAvailability = mongoose.model("ServiceAvailability");
      const zone = await CityZone.findById(zoneId).select("operationalCityId").lean();
      if (zone?.operationalCityId) {
        await ServiceAvailability.updateOne(
          {
            serviceId: new mongoose.Types.ObjectId(serviceId),
            districtId: zone.operationalCityId,
            cityZoneId: new mongoose.Types.ObjectId(zoneId),
            scope: "ZONE",
          },
          {
            $set: {
              serviceId: new mongoose.Types.ObjectId(serviceId),
              districtId: zone.operationalCityId,
              cityZoneId: new mongoose.Types.ObjectId(zoneId),
              scope: "ZONE",
              status: "DISABLED",
              updatedBy: req.user?.userId || null,
            },
          },
          { upsert: true }
        );
      }
    } catch (e) {
      console.warn("zone-mapping delete sync warning:", e.message);
    }

    return res.status(200).json({ success: true, message: "Zone-service mapping deleted", result: {} });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

/* =====================================================
   BULK TOGGLE — enable/disable all services in a zone
   ===================================================== */
export const toggleZoneServices = async (req, res) => {
  try {
    if (!isOwnerOrAdmin(req)) {
      return res.status(403).json({ success: false, message: "Owner/Admin access only" });
    }

    const { zoneId } = req.params;
    const { active } = req.body;

    if (!isValidObjectId(zoneId)) {
      return res.status(400).json({ success: false, message: "Invalid zone ID", result: {} });
    }
    if (typeof active === "string") {
      // Accept "true"/"false" strings from form/query clients
      const parsed = parseBoolean(active);
      req.body.active = parsed;
    }
    const targetActive = req.body.active;
    if (typeof targetActive !== "boolean") {
      return res.status(400).json({ success: false, message: "active must be a boolean", result: {} });
    }

    const zone = await CityZone.findById(zoneId).select("_id operationalCityId").lean();
    if (!zone) {
      return res.status(404).json({ success: false, message: "City zone not found", result: {} });
    }

    const result = await ZoneServiceMapping.updateMany(
      { zoneId },
      { $set: { active: targetActive } }
    );

    // Keep the ServiceAvailability ZONE overrides in sync so the unified
    // resolver (ZoneServiceMapping + ServiceAvailability) stays consistent
    // for both zoneRestricted and non-restricted services.
    try {
      const ServiceAvailability = mongoose.model("ServiceAvailability");
      const mappings = await ZoneServiceMapping.find({ zoneId }).select("serviceId").lean();
      if (mappings.length) {
        const ops = mappings.map((m) => ({
          updateOne: {
            filter: {
              serviceId: m.serviceId,
              districtId: zone.operationalCityId,
              cityZoneId: new mongoose.Types.ObjectId(zoneId),
              scope: "ZONE",
            },
            update: {
              $set: {
                serviceId: m.serviceId,
                districtId: zone.operationalCityId,
                cityZoneId: new mongoose.Types.ObjectId(zoneId),
                scope: "ZONE",
                status: targetActive ? "ENABLED" : "DISABLED",
                updatedBy: req.user?.userId || null,
              },
            },
            upsert: true,
          },
        }));
        await ServiceAvailability.bulkWrite(ops, { ordered: false });
      }
    } catch (e) {
      console.warn("toggleZoneServices sync warning:", e.message);
    }

    return res.status(200).json({
      success: true,
      message: `${targetActive ? "Enabled" : "Disabled"} ${result.modifiedCount} service mappings`,
      result: { modifiedCount: result.modifiedCount },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

/* =====================================================
   ZONE TECHNICIAN CANDIDATES — techs physically inside the zone
   polygon but NOT yet Admin-approved (required architecture:
   registration ≠ approval; admin approves via
   POST /api/admin/technicians/:technicianId/city-zones)
   ===================================================== */
export const listZoneTechnicianCandidates = async (req, res) => {
  try {
    if (!isOwnerOrAdmin(req)) {
      return res.status(403).json({ success: false, message: "Owner/Admin access only" });
    }
    const { zoneId } = req.params;
    if (!isValidObjectId(zoneId)) {
      return res.status(400).json({ success: false, message: "Invalid zone ID", result: [] });
    }
    const zone = await CityZone.findById(zoneId).select("_id name zoneCode polygon active").lean();
    if (!zone) {
      return res.status(404).json({ success: false, message: "City zone not found", result: [] });
    }
    if (!zone.polygon) {
      return res.status(400).json({ success: false, message: "Zone has no polygon", result: [] });
    }
    const TechnicianProfile = mongoose.model("TechnicianProfile");
    const zoneObjId = new mongoose.Types.ObjectId(zoneId);
    // Techs whose live GPS is inside the zone but who lack approval
    const candidates = await TechnicianProfile.find({
      location: { $geoIntersects: { $geometry: zone.polygon } },
      enabledCityZoneIds: { $ne: zoneObjId },
    })
      .select("_id userId location cityZoneId currentCityZoneId enabledCityZoneIds workStatus availability")
      .populate("userId", "fname lname mobileNumber")
      .limit(100)
      .lean();
    const approvedCount = await TechnicianProfile.countDocuments({ enabledCityZoneIds: zoneObjId });
    return res.status(200).json({
      success: true,
      message: "Zone technician candidates fetched (registration ≠ approval)",
      result: candidates,
      meta: { candidateCount: candidates.length, approvedCount, zoneActive: zone.active },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};
