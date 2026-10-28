import mongoose from "mongoose";
import OperationalCity from "../Schemas/OperationalCity.js";
import TechnicianProfile from "../Schemas/TechnicianProfile.js";
import TechnicianDistrictPermission from "../Schemas/TechnicianDistrictPermission.js";
import { writeAuditLog } from "../Utils/audit.js";
import { invalidateOperationalPolygonCache } from "../Utils/technicianMatching.js";
import {
  sanitizePolygon,
  recordPolygonVersion,
  withZoneWriteTransaction,
  assertDistrictPlacement,
  assertDistrictContainsZones,
  deleteDistrictCascade,
} from "../Services/zoneWriteService.js";

const isOwnerOrAdmin = (req) => ["Owner", "Admin"].includes(req.user?.role);
const isValidObjectId = (v) => mongoose.Types.ObjectId.isValid(v);

const parseBoolean = (value) => {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "y", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "n", "off"].includes(normalized)) return false;
  }
  return Boolean(value);
};

/* =====================================================
   LIST OPERATIONAL CITIES / DISTRICTS
===================================================== */
export const listOperationalCities = async (req, res) => {
  try {
    const isAdmin = isOwnerOrAdmin(req);
    const { active, isRegistrationEnabled, isJobEnabled } = req.query;
    const filter = {};

    if (isAdmin) {
      if (active !== undefined && active !== "") {
        filter.active = active === "true";
      }
      if (isRegistrationEnabled !== undefined && isRegistrationEnabled !== "") {
        filter.isRegistrationEnabled = isRegistrationEnabled === "true";
      }
      if (isJobEnabled !== undefined && isJobEnabled !== "") {
        filter.isJobEnabled = isJobEnabled === "true";
      }
    } else {
      // Non-admin (Technicians, Public, Customers) only see active operational districts
      filter.active = true;
      if (isRegistrationEnabled !== undefined && isRegistrationEnabled !== "") {
        filter.isRegistrationEnabled = isRegistrationEnabled === "true";
      }
    }

    const cities = await OperationalCity.find(filter).sort({ name: 1, updatedAt: -1 }).lean();
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
    const { id } = req.params;
    if (!isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: "Invalid district ID", result: {} });
    }

    const city = await OperationalCity.findById(id).lean();
    if (!city) {
      return res.status(404).json({ success: false, message: "District not found", result: {} });
    }

    if (!isOwnerOrAdmin(req) && !city.active) {
      return res.status(404).json({ success: false, message: "District not active", result: {} });
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

    // B-05 canonical geometry validation (same sanitizer as the geofence path).
    const validation = sanitizePolygon(polygon);
    if (!validation.valid) {
      return res.status(400).json({ success: false, message: "Invalid GeoJSON Polygon", errors: validation.errors, result: {} });
    }

    const finalActive = isActive !== undefined ? parseBoolean(isActive) : parseBoolean(active);

    const placement = await assertDistrictPlacement({
      sanitizedPolygon: validation.sanitizedPolygon,
    });
    if (!placement.ok) {
      return res.status(placement.status).json({
        success: false,
        code: placement.code,
        message: placement.message,
        result: {},
      });
    }

    // B-05: district + v1 history commit atomically.
    const actorId = req.user?.userId || null;
    const { result: cityDoc } = await withZoneWriteTransaction(async (session) => {
      const opts = session ? { session } : {};
      const docs = await OperationalCity.create(
        [
          {
            name: trimmedName,
            city: city ? String(city).trim() : null,
            state: state ? String(state).trim() : null,
            country: country ? String(country).trim() : "India",
            code: code ? String(code).trim().toUpperCase() : null,
            cityId: cityId || null,
            polygon: validation.sanitizedPolygon,
            active: finalActive,
            isRegistrationEnabled: parseBoolean(isRegistrationEnabled),
            isJobEnabled: parseBoolean(isJobEnabled),
            createdBy: actorId,
            updatedBy: actorId,
            version: 1,
          },
        ],
        opts
      );
      const created = Array.isArray(docs) ? docs[0] : docs;
      await recordPolygonVersion(
        {
          entityType: "DISTRICT",
          entityId: created._id,
          polygon: validation.sanitizedPolygon,
          changedBy: actorId,
          changeReason: "Initial District Creation",
        },
        session
      );
      return created;
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
    if (req.body.active !== undefined) update.active = parseBoolean(req.body.active);
    if (req.body.isActive !== undefined) update.active = parseBoolean(req.body.isActive);
    if (req.body.isRegistrationEnabled !== undefined) update.isRegistrationEnabled = parseBoolean(req.body.isRegistrationEnabled);
    if (req.body.isJobEnabled !== undefined) update.isJobEnabled = parseBoolean(req.body.isJobEnabled);

    let sanitizedPolygon = null;
    if (req.body.polygon !== undefined) {
      // B-05 canonical geometry validation (same sanitizer as the geofence path).
      const validation = sanitizePolygon(req.body.polygon);
      if (!validation.valid) {
        return res.status(400).json({ success: false, message: "Invalid GeoJSON Polygon", errors: validation.errors, result: {} });
      }
      sanitizedPolygon = validation.sanitizedPolygon;

      const placement = await assertDistrictPlacement({
        sanitizedPolygon,
        excludeDistrictId: id,
      });
      if (!placement.ok) {
        return res.status(placement.status).json({
          success: false,
          code: placement.code,
          message: placement.message,
          result: {},
        });
      }

      const childZones = await assertDistrictContainsZones({
        districtId: id,
        sanitizedPolygon,
      });
      if (!childZones.ok) {
        return res.status(childZones.status).json({
          success: false,
          code: childZones.code,
          message: childZones.message,
          result: {},
        });
      }

      update.polygon = sanitizedPolygon;
    }

    if (update.active === true && existing.active !== true && !sanitizedPolygon) {
      const placement = await assertDistrictPlacement({
        sanitizedPolygon: existing.polygon,
        excludeDistrictId: id,
      });
      if (!placement.ok) {
        return res.status(placement.status).json({
          success: false,
          code: placement.code,
          message: placement.message,
          result: {},
        });
      }
    }

    // B-05: district save + history row commit atomically on geometry change.
    const actorId = req.user?.userId || null;
    const { result: cityDoc } = await withZoneWriteTransaction(async (session) => {
      const opts = { new: true, runValidators: true, ...(session ? { session } : {}) };
      const updated = await OperationalCity.findByIdAndUpdate(id, update, opts);
      if (sanitizedPolygon && updated) {
        const bumped = (updated.version || 1) + 1;
        const saveOpts = session ? { session } : {};
        await OperationalCity.updateOne({ _id: id }, { $set: { version: bumped } }, saveOpts);
        updated.version = bumped;
        await recordPolygonVersion(
          {
            entityType: "DISTRICT",
            entityId: id,
            polygon: sanitizedPolygon,
            changedBy: actorId,
            changeReason: "District Boundary Update",
          },
          session
        );
      }
      return updated;
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

    if (
      sanitizedPolygon ||
      update.active !== undefined ||
      update.isJobEnabled !== undefined
    ) {
      const { revalidateTechniciansForService, backfillBroadcastsForScope } = await import(
        "../Utils/technicianLocation.js"
      );
      await revalidateTechniciansForService(null, cityDoc._id, null, req.io).catch((e) =>
        console.warn("district update revalidation warning:", e.message)
      );
      if (cityDoc.active !== false && cityDoc.isJobEnabled !== false) {
        await backfillBroadcastsForScope({ districtId: cityDoc._id, io: req.io }).catch((e) =>
          console.warn("district update backfill warning:", e.message)
        );
      }
    }

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

    const targetActive = active !== undefined ? parseBoolean(active) : parseBoolean(isActive);

    if (targetActive) {
      const existing = await OperationalCity.findById(id).select("polygon active").lean();
      if (!existing) {
        return res.status(404).json({ success: false, message: "District not found", result: {} });
      }
      if (existing.active !== true) {
        const placement = await assertDistrictPlacement({
          sanitizedPolygon: existing.polygon,
          excludeDistrictId: id,
        });
        if (!placement.ok) {
          return res.status(placement.status).json({
            success: false,
            code: placement.code,
            message: placement.message,
            result: {},
          });
        }
      }
    }

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
    // B-12: district activation gates dispatch — deactivate expires stale
    // broadcasts district-wide, re-activate backfills (bounded, idempotent).
    if (targetActive) {
      const { backfillBroadcastsForScope } = await import("../Utils/technicianLocation.js");
      await backfillBroadcastsForScope({ districtId: cityDoc._id, io: req.io })
        .catch((e) => console.warn("district activate backfill warning:", e.message));
    } else {
      const { revalidateTechniciansForService } = await import("../Utils/technicianLocation.js");
      await revalidateTechniciansForService(null, cityDoc._id, null, req.io)
        .catch((e) => console.warn("district deactivate revalidation warning:", e.message));
    }
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
      { isRegistrationEnabled: parseBoolean(isRegistrationEnabled), updatedBy: req.user?.userId || null },
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
      { isJobEnabled: parseBoolean(isJobEnabled), updatedBy: req.user?.userId || null },
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

    // B-12: jobs gate feeds the resolver directly — keep broadcasts in sync.
    if (cityDoc.isJobEnabled) {
      const { backfillBroadcastsForScope } = await import("../Utils/technicianLocation.js");
      await backfillBroadcastsForScope({ districtId: cityDoc._id, io: req.io })
        .catch((e) => console.warn("district jobs-enable backfill warning:", e.message));
    } else {
      const { revalidateTechniciansForService } = await import("../Utils/technicianLocation.js");
      await revalidateTechniciansForService(null, cityDoc._id, null, req.io)
        .catch((e) => console.warn("district jobs-disable revalidation warning:", e.message));
    }
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

    const previouslyActive = await OperationalCity.find({
      _id: { $ne: id },
      active: true,
    })
      .select("_id")
      .lean();

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

      if (previouslyActive.length) {
        const { revalidateTechniciansForService } = await import("../Utils/technicianLocation.js");
        await Promise.all(
          previouslyActive.map((district) =>
            revalidateTechniciansForService(null, district._id, null, req.io).catch((e) =>
              console.warn("district deactivate revalidation warning:", e.message)
            )
          )
        );
      }

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
    const result = await deleteDistrictCascade({
      districtId: id,
      actorId: req.user?.userId || null,
      io: req.io,
    });
    if (!result) {
      return res.status(404).json({ success: false, message: "Operational city not found", result: {} });
    }

    await writeAuditLog({
      actor: req.user.userId,
      actorRole: req.user.role,
      action: "OPERATIONAL_CITY_DELETED",
      targetType: "OperationalCity",
      targetId: id,
      before: {
        name: result.district.name,
        active: result.district.active,
        zoneCount: result.zoneCount,
      },
    });

    invalidateOperationalPolygonCache();

    return res.status(200).json({
      success: true,
      message: "Operational city deleted",
      result: { deletedZones: result.zoneCount },
    });
  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({
        success: false,
        code: err.code,
        message: err.message,
        details: err.details || undefined,
        result: {},
      });
    }
    return res.status(500).json({ success: false, message: err.message, result: {} });
  }
};