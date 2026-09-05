import mongoose from "mongoose";
import OperationalCity from "../Schemas/OperationalCity.js";
import TechnicianProfile from "../Schemas/TechnicianProfile.js";
import TechnicianDistrictPermission from "../Schemas/TechnicianDistrictPermission.js";
import { writeAuditLog } from "../Utils/audit.js";
import { invalidateOperationalPolygonCache } from "../Utils/technicianMatching.js";
import { validateGeoJsonPolygon } from "../Utils/servicePolygon.js";

const isOwnerOrAdmin = (req) => ["Owner", "Admin"].includes(req.user?.role);
const isValidObjectId = (v) => mongoose.Types.ObjectId.isValid(v);

/* =====================================================
   LIST OPERATIONAL CITIES / DISTRICTS
===================================================== */
export const listOperationalCities = async (req, res) => {
  try {
    if (!isOwnerOrAdmin(req)) {
      return res.status(403).json({ success: false, message: "Owner/Admin access only" });
    }
    const { active, isRegistrationEnabled, isJobEnabled } = req.query;
    const filter = {};
    if (active !== undefined && active !== "") {
      filter.active = active === "true";
    }
    if (isRegistrationEnabled !== undefined && isRegistrationEnabled !== "") {
      filter.isRegistrationEnabled = isRegistrationEnabled === "true";
    }
    if (isJobEnabled !== undefined && isJobEnabled !== "") {
      filter.isJobEnabled = isJobEnabled === "true";
    }

    const cities = await OperationalCity.find(filter).sort({ updatedAt: -1 }).lean();
    return res.status(200).json({
      success: true,
      message: "Operational cities/districts fetched",
      result: cities,
      meta: { count: cities.length },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

/* =====================================================
   GET OPERATIONAL CITY / DISTRICT BY ID
===================================================== */
export const getOperationalCityById = async (req, res) => {
  try {
    if (!isOwnerOrAdmin(req)) {
      return res.status(403).json({ success: false, message: "Owner/Admin access only" });
    }
    const { id } = req.params;
    if (!isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: "Invalid district ID", result: {} });
    }

    const city = await OperationalCity.findById(id).lean();
    if (!city) {
      return res.status(404).json({ success: false, message: "District not found", result: {} });
    }

    return res.status(200).json({ success: true, result: city });
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
   CREATE OPERATIONAL CITY / DISTRICT
===================================================== */
export const createOperationalCity = async (req, res) => {
  try {
    if (!isOwnerOrAdmin(req)) {
      return res.status(403).json({ success: false, message: "Owner/Admin access only" });
    }
    const { name, city, state, country, code, cityId, active = true, isActive, isRegistrationEnabled = true, isJobEnabled = true } = req.body;
    const polygon = req.body.polygon;

    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: "District name is required", result: {} });
    }

    const trimmedName = name.trim();
    // Check duplicate district name
    const existingName = await OperationalCity.findOne({ name: new RegExp(`^${trimmedName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i") });
    if (existingName) {
      return res.status(400).json({ success: false, message: `District record with name "${trimmedName}" already exists`, result: {} });
    }

    const polygonError = validateGeoJsonPolygon(polygon);
    if (polygonError) {
      return res.status(400).json({ success: false, message: polygonError, result: {} });
    }

    const finalActive = isActive !== undefined ? Boolean(isActive) : Boolean(active);

    const cityDoc = await OperationalCity.create({
      name: trimmedName,
      city: city ? String(city).trim() : null,
      state: state ? String(state).trim() : null,
      country: country ? String(country).trim() : "India",
      code: code ? String(code).trim().toUpperCase() : null,
      cityId: cityId || null,
      polygon,
      active: finalActive,
      isRegistrationEnabled: Boolean(isRegistrationEnabled),
      isJobEnabled: Boolean(isJobEnabled),
      createdBy: req.user?.userId || null,
      updatedBy: req.user?.userId || null,
    });

    await writeAuditLog({
      actor: req.user.userId,
      actorRole: req.user.role,
      action: "OPERATIONAL_CITY_CREATED",
      targetType: "OperationalCity",
      targetId: cityDoc._id,
      after: { name: cityDoc.name, active: cityDoc.active, isRegistrationEnabled: cityDoc.isRegistrationEnabled, isJobEnabled: cityDoc.isJobEnabled },
    });

    invalidateOperationalPolygonCache();

    return res.status(201).json({ success: true, message: "District created successfully", result: cityDoc });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message, result: {} });
  }
};

/* =====================================================
   UPDATE OPERATIONAL CITY / DISTRICT
===================================================== */
export const updateOperationalCity = async (req, res) => {
  try {
    if (!isOwnerOrAdmin(req)) {
      return res.status(403).json({ success: false, message: "Owner/Admin access only" });
    }
    const { id } = req.params;
    if (!isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: "Invalid district ID", result: {} });
    }

    const existing = await OperationalCity.findById(id);
    if (!existing) {
      return res.status(404).json({ success: false, message: "District not found", result: {} });
    }

    const update = { updatedBy: req.user?.userId || null };

    if (req.body.name !== undefined) {
      if (!String(req.body.name).trim()) {
        return res.status(400).json({ success: false, message: "name cannot be empty", result: {} });
      }
      update.name = String(req.body.name).trim();
    }
    if (req.body.city !== undefined) update.city = req.body.city ? String(req.body.city).trim() : null;
    if (req.body.state !== undefined) update.state = req.body.state ? String(req.body.state).trim() : null;
    if (req.body.country !== undefined) update.country = req.body.country ? String(req.body.country).trim() : "India";
    if (req.body.code !== undefined) update.code = req.body.code ? String(req.body.code).trim().toUpperCase() : null;
    if (req.body.cityId !== undefined) update.cityId = req.body.cityId;
    if (req.body.active !== undefined) update.active = Boolean(req.body.active);
    if (req.body.isActive !== undefined) update.active = Boolean(req.body.isActive);
    if (req.body.isRegistrationEnabled !== undefined) update.isRegistrationEnabled = Boolean(req.body.isRegistrationEnabled);
    if (req.body.isJobEnabled !== undefined) update.isJobEnabled = Boolean(req.body.isJobEnabled);

    if (req.body.polygon !== undefined) {
      const polygonError = validateGeoJsonPolygon(req.body.polygon);
      if (polygonError) {
        return res.status(400).json({ success: false, message: polygonError, result: {} });
      }
      update.polygon = req.body.polygon;
    }

    const cityDoc = await OperationalCity.findByIdAndUpdate(id, update, {
      new: true,
      runValidators: true,
    });

    await writeAuditLog({
      actor: req.user.userId,
      actorRole: req.user.role,
      action: "OPERATIONAL_CITY_UPDATED",
      targetType: "OperationalCity",
      targetId: cityDoc._id,
      before: { name: existing.name, active: existing.active },
      after: { name: cityDoc.name, active: cityDoc.active, isRegistrationEnabled: cityDoc.isRegistrationEnabled, isJobEnabled: cityDoc.isJobEnabled },
    });

    invalidateOperationalPolygonCache();

    return res.status(200).json({ success: true, message: "District updated successfully", result: cityDoc });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message, result: {} });
  }
};

/* =====================================================
   PATCH DISTRICT STATUS (Active / Inactive)
===================================================== */
export const updateDistrictStatus = async (req, res) => {
  try {
    if (!isOwnerOrAdmin(req)) {
      return res.status(403).json({ success: false, message: "Owner/Admin access only" });
    }
    const { id } = req.params;
    const { active, isActive } = req.body;

    if (!isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: "Invalid district ID", result: {} });
    }

    const targetActive = active !== undefined ? Boolean(active) : Boolean(isActive);

    const cityDoc = await OperationalCity.findByIdAndUpdate(
      id,
      { active: targetActive, updatedBy: req.user?.userId || null },
      { new: true }
    );

    if (!cityDoc) {
      return res.status(404).json({ success: false, message: "District not found", result: {} });
    }

    await writeAuditLog({
      actor: req.user.userId,
      actorRole: req.user.role,
      action: targetActive ? "DISTRICT_ACTIVATED" : "DISTRICT_DEACTIVATED",
      targetType: "OperationalCity",
      targetId: cityDoc._id,
      after: { active: cityDoc.active },
    });

    invalidateOperationalPolygonCache();
    return res.status(200).json({ success: true, message: `District ${targetActive ? "activated" : "deactivated"} successfully`, result: cityDoc });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message, result: {} });
  }
};

/* =====================================================
   PATCH DISTRICT REGISTRATION STATUS (Enabled / Disabled)
===================================================== */
export const updateDistrictRegistration = async (req, res) => {
  try {
    if (!isOwnerOrAdmin(req)) {
      return res.status(403).json({ success: false, message: "Owner/Admin access only" });
    }
    const { id } = req.params;
    const { isRegistrationEnabled } = req.body;

    if (!isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: "Invalid district ID", result: {} });
    }
    if (isRegistrationEnabled === undefined) {
      return res.status(400).json({ success: false, message: "isRegistrationEnabled is required", result: {} });
    }

    const cityDoc = await OperationalCity.findByIdAndUpdate(
      id,
      { isRegistrationEnabled: Boolean(isRegistrationEnabled), updatedBy: req.user?.userId || null },
      { new: true }
    );

    if (!cityDoc) {
      return res.status(404).json({ success: false, message: "District not found", result: {} });
    }

    await writeAuditLog({
      actor: req.user.userId,
      actorRole: req.user.role,
      action: "DISTRICT_REGISTRATION_TOGGLED",
      targetType: "OperationalCity",
      targetId: cityDoc._id,
      after: { isRegistrationEnabled: cityDoc.isRegistrationEnabled },
    });

    return res.status(200).json({ success: true, message: `District registration ${cityDoc.isRegistrationEnabled ? "enabled" : "disabled"} successfully`, result: cityDoc });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message, result: {} });
  }
};

/* =====================================================
   PATCH DISTRICT JOB ASSIGNMENT STATUS (Enabled / Disabled)
===================================================== */
export const updateDistrictJobs = async (req, res) => {
  try {
    if (!isOwnerOrAdmin(req)) {
      return res.status(403).json({ success: false, message: "Owner/Admin access only" });
    }
    const { id } = req.params;
    const { isJobEnabled } = req.body;

    if (!isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: "Invalid district ID", result: {} });
    }
    if (isJobEnabled === undefined) {
      return res.status(400).json({ success: false, message: "isJobEnabled is required", result: {} });
    }

    const cityDoc = await OperationalCity.findByIdAndUpdate(
      id,
      { isJobEnabled: Boolean(isJobEnabled), updatedBy: req.user?.userId || null },
      { new: true }
    );

    if (!cityDoc) {
      return res.status(404).json({ success: false, message: "District not found", result: {} });
    }

    await writeAuditLog({
      actor: req.user.userId,
      actorRole: req.user.role,
      action: "DISTRICT_JOBS_TOGGLED",
      targetType: "OperationalCity",
      targetId: cityDoc._id,
      after: { isJobEnabled: cityDoc.isJobEnabled },
    });

    return res.status(200).json({ success: true, message: `District job assignment ${cityDoc.isJobEnabled ? "enabled" : "disabled"} successfully`, result: cityDoc });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message, result: {} });
  }
};

/* =====================================================
   GET TECHNICIANS IN A DISTRICT
===================================================== */
export const getDistrictTechnicians = async (req, res) => {
  try {
    if (!isOwnerOrAdmin(req)) {
      return res.status(403).json({ success: false, message: "Owner/Admin access only" });
    }
    const { id } = req.params;
    if (!isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: "Invalid district ID", result: {} });
    }

    const districtObjId = new mongoose.Types.ObjectId(id);

    // Primary technicians
    const primaryTechs = await TechnicianProfile.find({ primaryCityId: districtObjId })
      .populate("userId", "name phone email role")
      .lean();

    // Additional permissions
    const permissions = await TechnicianDistrictPermission.find({ districtId: districtObjId, isEnabled: true })
      .populate({
        path: "technicianId",
        populate: { path: "userId", select: "name phone email role" },
      })
      .lean();

    return res.status(200).json({
      success: true,
      result: {
        districtId: id,
        primaryTechnicians: primaryTechs,
        additionalTechnicians: permissions.map((p) => p.technicianId).filter(Boolean),
        meta: {
          primaryCount: primaryTechs.length,
          additionalCount: permissions.length,
          total: primaryTechs.length + permissions.length,
        },
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
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