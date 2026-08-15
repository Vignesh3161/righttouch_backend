import mongoose from "mongoose";
import OperationalCity from "../Schemas/OperationalCity.js";
import { writeAuditLog } from "../Utils/audit.js";
import { invalidateOperationalPolygonCache } from "../Utils/technicianMatching.js";
import { validateGeoJsonPolygon } from "../Utils/servicePolygon.js";

const isOwnerOrAdmin = (req) => ["Owner", "Admin"].includes(req.user?.role);

const isValidObjectId = (v) => mongoose.Types.ObjectId.isValid(v);

/* =====================================================
   LIST OPERATIONAL CITIES
===================================================== */
export const listOperationalCities = async (req, res) => {
  try {
    if (!isOwnerOrAdmin(req)) {
      return res.status(403).json({ success: false, message: "Owner/Admin access only" });
    }
    const { active } = req.query;
    const filter = {};
    if (active !== undefined && active !== "") {
      filter.active = active === "true";
    }
    const cities = await OperationalCity.find(filter).sort({ updatedAt: -1 }).lean();
    return res.status(200).json({
      success: true,
      message: "Operational cities fetched",
      result: cities,
      meta: { count: cities.length },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

/* =====================================================
   GET ACTIVE OPERATIONAL CITY (with polygon)
===================================================== */
export const getActiveOperationalCity = async (req, res) => {
  try {
    if (!isOwnerOrAdmin(req)) {
      return res.status(403).json({ success: false, message: "Owner/Admin access only" });
    }
    const city = await OperationalCity.findOne({ active: true })
      .sort({ updatedAt: -1 })
      .lean();
    if (!city) {
      return res.status(404).json({
        success: false,
        message: "No active operational city configured. Matching runs without a polygon.",
        result: null,
      });
    }
    return res.status(200).json({ success: true, result: city });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

/* =====================================================
   GET ALL ACTIVE POLYGONS (used by matching / tech app)
===================================================== */
export const getActivePolygons = async (req, res) => {
  try {
    const cities = await OperationalCity.find({ active: true })
      .select("name polygon cityId updatedAt")
      .sort({ updatedAt: -1 })
      .lean();
    return res.status(200).json({
      success: true,
      result: cities.map((c) => ({ name: c.name, cityId: c.cityId, polygon: c.polygon })),
      meta: { count: cities.length },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

/* =====================================================
   CREATE OPERATIONAL CITY
===================================================== */
export const createOperationalCity = async (req, res) => {
  try {
    if (!isOwnerOrAdmin(req)) {
      return res.status(403).json({ success: false, message: "Owner/Admin access only" });
    }
    const { name, cityId, active = true } = req.body;
    const polygon = req.body.polygon;

    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: "name is required", result: {} });
    }
    const polygonError = validateGeoJsonPolygon(polygon);
    if (polygonError) {
      return res.status(400).json({ success: false, message: polygonError, result: {} });
    }

    const city = await OperationalCity.create({ name: name.trim(), cityId, polygon, active });

    await writeAuditLog({
      actor: req.user.userId,
      actorRole: req.user.role,
      action: "OPERATIONAL_CITY_CREATED",
      targetType: "OperationalCity",
      targetId: city._id,
      after: { name: city.name, active: city.active },
    });

    invalidateOperationalPolygonCache();

    return res.status(201).json({ success: true, message: "Operational city created", result: city });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message, result: {} });
  }
};

/* =====================================================
   UPDATE OPERATIONAL CITY
===================================================== */
export const updateOperationalCity = async (req, res) => {
  try {
    if (!isOwnerOrAdmin(req)) {
      return res.status(403).json({ success: false, message: "Owner/Admin access only" });
    }
    const { id } = req.params;
    if (!isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: "Invalid city ID", result: {} });
    }

    const existing = await OperationalCity.findById(id);
    if (!existing) {
      return res.status(404).json({ success: false, message: "Operational city not found", result: {} });
    }

    const update = {};
    if (req.body.name !== undefined) {
      if (!String(req.body.name).trim()) {
        return res.status(400).json({ success: false, message: "name cannot be empty", result: {} });
      }
      update.name = String(req.body.name).trim();
    }
    if (req.body.cityId !== undefined) update.cityId = req.body.cityId;
    if (req.body.active !== undefined) update.active = Boolean(req.body.active);
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

    const city = await OperationalCity.findByIdAndUpdate(id, update, {
      new: true,
      runValidators: true,
    });

    await writeAuditLog({
      actor: req.user.userId,
      actorRole: req.user.role,
      action: "OPERATIONAL_CITY_UPDATED",
      targetType: "OperationalCity",
      targetId: city._id,
      before: { name: existing.name, active: existing.active },
      after: { name: city.name, active: city.active },
    });

    invalidateOperationalPolygonCache();

    return res.status(200).json({ success: true, message: "Operational city updated", result: city });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message, result: {} });
  }
};

/* =====================================================
   SET ACTIVE CITY (deactivates the rest)
===================================================== */
export const activateOperationalCity = async (req, res) => {
  try {
    if (!isOwnerOrAdmin(req)) {
      return res.status(403).json({ success: false, message: "Owner/Admin access only" });
    }
    const { id } = req.params;
    if (!isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: "Invalid city ID", result: {} });
    }

    const session = await mongoose.startSession();
    session.startTransaction();
    try {
      await OperationalCity.updateMany({ _id: { $ne: id } }, { $set: { active: false } }, { session });
      const city = await OperationalCity.findByIdAndUpdate(id, { $set: { active: true } }, {
        new: true,
        session: session,
      });
      if (!city) {
        await session.abortTransaction();
        return res.status(404).json({ success: false, message: "Operational city not found", result: {} });
      }
      await session.commitTransaction();

      await writeAuditLog({
        actor: req.user.userId,
        actorRole: req.user.role,
        action: "OPERATIONAL_CITY_ACTIVATED",
        targetType: "OperationalCity",
        targetId: city._id,
        after: { name: city.name, active: true },
      });

      invalidateOperationalPolygonCache();
      return res.status(200).json({ success: true, message: "Operational city activated", result: city });
    } catch (err) {
      await session.abortTransaction();
      throw err;
    } finally {
      session.endSession();
    }
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message, result: {} });
  }
};

/* =====================================================
   DELETE OPERATIONAL CITY
===================================================== */
export const deleteOperationalCity = async (req, res) => {
  try {
    if (!isOwnerOrAdmin(req)) {
      return res.status(403).json({ success: false, message: "Owner/Admin access only" });
    }
    const { id } = req.params;
    if (!isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: "Invalid city ID", result: {} });
    }
    const city = await OperationalCity.findByIdAndDelete(id);
    if (!city) {
      return res.status(404).json({ success: false, message: "Operational city not found", result: {} });
    }

    await writeAuditLog({
      actor: req.user.userId,
      actorRole: req.user.role,
      action: "OPERATIONAL_CITY_DELETED",
      targetType: "OperationalCity",
      targetId: id,
      before: { name: city.name, active: city.active },
    });

    invalidateOperationalPolygonCache();

    return res.status(200).json({ success: true, message: "Operational city deleted", result: {} });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message, result: {} });
  }
};