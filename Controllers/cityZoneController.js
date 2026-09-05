import mongoose from "mongoose";
import CityZone from "../Schemas/CityZone.js";
import ZoneServiceMapping from "../Schemas/ZoneServiceMapping.js";
import OperationalCity from "../Schemas/OperationalCity.js";
import { writeAuditLog } from "../Utils/audit.js";
import { validateGeoJsonPolygon } from "../Utils/servicePolygon.js";

const isOwnerOrAdmin = (req) => ["Owner", "Admin"].includes(req.user?.role);
const isValidObjectId = (v) => mongoose.Types.ObjectId.isValid(v);

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
    if (operationalCityId) filter.operationalCityId = operationalCityId;
    if (active !== undefined && active !== "") filter.active = active === "true";

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
      active,
      description: description || null,
    });

    await writeAuditLog({
      actor: req.user.userId,
      actorRole: req.user.role,
      action: "CITY_ZONE_CREATED",
      targetType: "CityZone",
      targetId: zone._id,
      after: { name: zone.name, zoneCode: zone.zoneCode, active: zone.active },
    });

    return res.status(201).json({ success: true, message: "City zone created", result: zone });
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
    if (req.body.zoneCode !== undefined) update.zoneCode = String(req.body.zoneCode).trim().toUpperCase();
    if (req.body.active !== undefined) update.active = Boolean(req.body.active);
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

    // Clean up zone-service mappings for this zone
    await ZoneServiceMapping.deleteMany({ zoneId: id });

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
    const { zoneId, serviceId } = req.query;
    const filter = {};
    if (zoneId) filter.zoneId = zoneId;
    if (serviceId) filter.serviceId = serviceId;

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
    if (typeof active !== "boolean") {
      return res.status(400).json({ success: false, message: "active must be a boolean", result: {} });
    }

    const result = await ZoneServiceMapping.updateMany(
      { zoneId },
      { $set: { active } }
    );

    return res.status(200).json({
      success: true,
      message: `${active ? "Enabled" : "Disabled"} ${result.modifiedCount} service mappings`,
      result: { modifiedCount: result.modifiedCount },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};
