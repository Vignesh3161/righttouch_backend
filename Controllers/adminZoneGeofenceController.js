import { SOCKET_ROOMS, SOCKET_EVENTS } from "../Utils/socketConstants.js";
import { sendPushNotification } from "../Utils/sendNotification.js";
import Notification from "../Schemas/Notification.js";
import mongoose from "mongoose";
import OperationalCity from "../Schemas/OperationalCity.js";
import CityZone from "../Schemas/CityZone.js";
import ServiceAvailability from "../Schemas/ServiceAvailability.js";
import Service from "../Schemas/Service.js";
import TechnicianProfile from "../Schemas/TechnicianProfile.js";
import ServiceBooking from "../Schemas/ServiceBooking.js";
import User from "../Schemas/User.js";
import DistrictPermissionHistory from "../Schemas/DistrictPermissionHistory.js";
import PolygonVersion from "../Schemas/PolygonVersion.js";
import { validateAndSanitizePolygon } from "../Utils/geoValidation.js";
import { checkTechnicianEligibility } from "../Services/technicianEligibilityService.js";
import { resolveServiceAvailability } from "../Services/serviceAvailabilityService.js";
import { haversineMeters } from "../Utils/feasibility.js";
import { isValidObjectId, exactRegex, containsRegex, clampLimit, clampPage, internalError } from "../Utils/safeQuery.js";
import { seedZoneDisabledServices, recordPolygonVersion, withZoneWriteTransaction, invalidateDistrictPolygonCache } from "../Services/zoneWriteService.js";
import { writeAuditLog } from "../Utils/audit.js";

/* =========================================================================
   A & B: DISTRICT / OPERATIONAL CITY MANAGEMENT
   ========================================================================= */

export const createDistrict = async (req, res) => {
  try {
    const { name, state, country = "India", code, polygon, isRegistrationEnabled = true, isJobEnabled = true } = req.body;

    if (!name || !polygon) {
      return res.status(400).json({ success: false, message: "District name and GeoJSON polygon are required." });
    }

    // G — GeoJSON Validation
    const validation = validateAndSanitizePolygon(polygon);
    if (!validation.valid) {
      return res.status(400).json({
        success: false,
        message: "Invalid GeoJSON Polygon definition",
        errors: validation.errors,
      });
    }

    // B-05: district + v1 history commit atomically; polygon cache cleared.
    const { result: district } = await withZoneWriteTransaction(async (session) => {
      const opts = session ? { session } : {};
      const docs = await OperationalCity.create(
        [
          {
            name,
            state,
            country,
            code: code ? String(code).toUpperCase() : null,
            polygon: validation.sanitizedPolygon,
            active: true,
            status: "ACTIVE",
            isRegistrationEnabled,
            isJobEnabled,
            createdBy: req.user._id,
            updatedBy: req.user._id,
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
          changedBy: req.user._id,
          changeReason: "Initial District Creation",
        },
        session
      );
      return created;
    });
    invalidateDistrictPolygonCache();

    return res.status(201).json({
      success: true,
      message: "Operational District created successfully",
      result: district,
    });
  } catch (error) {
    return internalError(res, error);
  }
};

export const updateDistrict = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, state, code, polygon, status, statusReason, reason } = req.body;

    if (!isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: "Invalid district id", code: "INVALID_ID" });
    }
    const district = await OperationalCity.findById(id);
    if (!district) return res.status(404).json({ success: false, message: "District not found" });

    let updatedPolygon = district.polygon;
    let versionIncremented = false;

    if (polygon) {
      const validation = validateAndSanitizePolygon(polygon);
      if (!validation.valid) {
        return res.status(400).json({
          success: false,
          message: "Invalid GeoJSON Polygon definition",
          errors: validation.errors,
        });
      }
      updatedPolygon = validation.sanitizedPolygon;
      versionIncremented = true;
    }

    if (name) district.name = name;
    if (state) district.state = state;
    if (code) district.code = String(code).toUpperCase();
    if (status) {
      district.status = status;
      district.active = status === "ACTIVE";
    }
    if (statusReason) district.statusReason = statusReason;
    district.updatedBy = req.user._id;

    // B-05: version bump + history row commit atomically with the district
    // save; polygon cache is invalidated so matching sees new geometry.
    await withZoneWriteTransaction(async (session) => {
      if (versionIncremented) {
        district.version = (district.version || 1) + 1;
        district.polygon = updatedPolygon;
      }
      await district.save(session ? { session } : {});
      if (versionIncremented) {
        await recordPolygonVersion(
          {
            entityType: "DISTRICT",
            entityId: district._id,
            polygon: updatedPolygon,
            changedBy: req.user._id,
            changeReason: reason || "District Boundary Update",
          },
          session
        );
      }
    });
    if (versionIncremented) invalidateDistrictPolygonCache(String(district._id));

    // B-12: a status flip through the geofence path changes dispatch
    // eligibility the same way the standard status toggle does.
    if (status) {
      if (district.active) {
        const { backfillBroadcastsForScope } = await import("../Utils/technicianLocation.js");
        await backfillBroadcastsForScope({ districtId: district._id, io: req.io })
          .catch((e) => console.warn("geofence status backfill warning:", e.message));
      } else {
        const { revalidateTechniciansForService } = await import("../Utils/technicianLocation.js");
        await revalidateTechniciansForService(null, district._id, null, req.io)
          .catch((e) => console.warn("geofence status revalidation warning:", e.message));
      }
    }

    return res.status(200).json({
      success: true,
      message: "District updated successfully",
      result: district,
    });
  } catch (error) {
    return internalError(res, error);
  }
};

export const listDistricts = async (req, res) => {
  try {
    const { search, status, page = 1, limit = 20 } = req.query;
    const query = {};

    if (search) {
      const rx = containsRegex(search);
      query.$or = [
        { name: { $regex: rx } },
        { code: { $regex: rx } },
        { state: { $regex: rx } },
      ];
    }

    if (status) query.status = status;

    const safePage = clampPage(page);
    const safeLimit = clampLimit(limit);
    const skip = (safePage - 1) * safeLimit;
    const [districts, total] = await Promise.all([
      OperationalCity.find(query).sort({ name: 1 }).skip(skip).limit(safeLimit).lean(),
      OperationalCity.countDocuments(query),
    ]);

    return res.status(200).json({
      success: true,
      result: districts,
      pagination: { total, page: safePage, limit: safeLimit, pages: Math.ceil(total / safeLimit) },
    });
  } catch (error) {
    return internalError(res, error);
  }
};

/* =========================================================================
   C: CITY ZONE MANAGEMENT
   ========================================================================= */

export const createCityZone = async (req, res) => {
  try {
    // Accept both canonical (name/zoneCode/description/active) and legacy
    // (zoneName/state) payloads so older admin UIs keep working.
    const { operationalCityId, districtId } = req.body;
    const parentId = operationalCityId || districtId;
    const zoneName = req.body.name || req.body.zoneName;
    const zoneCode = req.body.zoneCode || req.body.code;
    const { polygon, description, active = true } = req.body;

    if (!parentId || !zoneName || !polygon) {
      return res.status(400).json({ success: false, message: "operationalCityId, zoneName (name), and polygon are required." });
    }
    if (!mongoose.Types.ObjectId.isValid(parentId)) {
      return res.status(400).json({ success: false, message: "Invalid operationalCityId." });
    }
    if (!zoneCode || !String(zoneCode).trim()) {
      return res.status(400).json({ success: false, message: "zoneCode is required (e.g. ND-NORTH-01)." });
    }

    const parentDistrict = await OperationalCity.findById(parentId);
    if (!parentDistrict) return res.status(404).json({ success: false, message: "Parent Operational District not found." });

    const validation = validateAndSanitizePolygon(polygon);
    if (!validation.valid) {
      return res.status(400).json({ success: false, message: "Invalid GeoJSON Polygon", errors: validation.errors });
    }

    // B-05/B-07 canonical placement: same containment + overlap rules as the
    // standard CRUD path (assertZonePlacement), so the two writers agree.
    const { assertZonePlacement } = await import("../Services/zoneWriteService.js");
    const placement = await assertZonePlacement({
      sanitizedPolygon: validation.sanitizedPolygon,
      districtId: parentId,
    });
    if (!placement.ok) {
      return res.status(placement.status).json({
        success: false,
        code: placement.code,
        message: placement.message,
      });
    }

    // B-05: same invariants as the standard CRUD path — caller-supplied
    // `active` is honored (was hardcoded true), every active service is
    // seeded DISABLED, and zone + seed + version commit atomically.
    const activeFlag = active === undefined ? true : active === true || String(active).toLowerCase() === "true";
    const actorId = req.user?._id || req.user?.userId || null;
    let zone;
    let seededCount = 0;
    try {
      const out = await withZoneWriteTransaction(async (session) => {
        const createOpts = session ? { session } : {};
        const docs = await CityZone.create(
          [
            {
              operationalCityId: parentId,
              name: String(zoneName).trim(),
              zoneCode: String(zoneCode).trim().toUpperCase(),
              polygon: validation.sanitizedPolygon,
              active: activeFlag,
              description: description || null,
            },
          ],
          createOpts
        );
        const created = Array.isArray(docs) ? docs[0] : docs;
        const seeded = await seedZoneDisabledServices({ zone: created, actorId, session });
        await recordPolygonVersion(
          {
            entityType: "CITY_ZONE",
            entityId: created._id,
            polygon: validation.sanitizedPolygon,
            changedBy: actorId,
            changeReason: "Initial CityZone Creation",
          },
          session
        );
        return { created, seeded };
      });
      zone = out.result.created;
      seededCount = out.result.seeded;
    } catch (e) {
      if (e.code === 11000) {
        return res.status(409).json({ success: false, code: "ZONE_CODE_EXISTS", message: "Zone code already exists. Use a unique zoneCode." });
      }
      throw e;
    }

    return res.status(201).json({ success: true, message: "CityZone created successfully", result: { ...zone.toObject(), seededDisabledServices: seededCount } });
  } catch (error) {
    return internalError(res, error);
  }
};

export const listCityZones = async (req, res) => {
  try {
    const { districtId, operationalCityId, search } = req.query;
    const query = {};
    const parentFilter = districtId || operationalCityId;
    if (parentFilter) {
      if (!mongoose.Types.ObjectId.isValid(parentFilter)) {
        return res.status(400).json({ success: false, message: "Invalid districtId" });
      }
      query.operationalCityId = parentFilter;
    }
    if (search) query.name = { $regex: containsRegex(search) };

    const zones = await CityZone.find(query).populate("operationalCityId", "name code state").sort({ name: 1 }).lean();
    return res.status(200).json({ success: true, result: zones });
  } catch (error) {
    return internalError(res, error);
  }
};

/* =========================================================================
   D & T: TECHNICIAN DISTRICT PERMISSION MANAGEMENT (STRICTLY DISTRICT ONLY)
   ========================================================================= */

export const grantDistrictPermission = async (req, res) => {
  // B-13: thin delegate to the canonical district-permission service (single
  // writer for rows + derived arrays + history). Response contract preserved.
  try {
    const { technicianId, districtId, reason } = req.body;

    if (!technicianId || !districtId || !reason) {
      return res.status(400).json({ success: false, message: "technicianId, districtId, and reason are required." });
    }
    if (!isValidObjectId(technicianId)) {
      return res.status(400).json({ success: false, message: "Invalid technicianId", code: "INVALID_ID" });
    }
    if (!isValidObjectId(districtId)) {
      return res.status(400).json({ success: false, message: "Invalid districtId", code: "INVALID_ID" });
    }

    const { addDistrictPermission } = await import("../Services/technicianDistrictService.js");
    try {
      await addDistrictPermission({
        technicianId,
        districtId,
        adminUserId: req.user._id || req.user?.userId,
        adminRole: req.user?.role,
        reason,
      });
    } catch (svcErr) {
      // Preserve the original 404 contract for unknown technician/district.
      if (svcErr.code === "TECHNICIAN_INACTIVE" || svcErr.code === "DISTRICT_INACTIVE") {
        const isTech = svcErr.code === "TECHNICIAN_INACTIVE";
        return res.status(404).json({
          success: false,
          message: isTech ? "Technician not found" : "District not found",
          code: svcErr.code,
        });
      }
      return res
        .status(svcErr.statusCode || 400)
        .json({ success: false, message: svcErr.message, code: svcErr.code });
    }

    const tech = await TechnicianProfile.findById(technicianId)
      .select("primaryDistrictId enabledDistrictIds location")
      .lean();
    const district = await OperationalCity.findById(districtId).select("name").lean();

    // 🔄 Revalidate active broadcasts for this technician (district permission changed)
    const { revalidateActiveBroadcasts } = await import("../Utils/technicianLocation.js");
    if (tech?.location?.coordinates) {
      const [lng, lat] = tech.location.coordinates;
      await revalidateActiveBroadcasts(technicianId, lat, lng, req.io)
        .catch(err => console.error("District permission grant revalidation error:", err));
    }

    return res.status(200).json({
      success: true,
      message: `District permission granted for ${district?.name || "district"}`,
      result: {
        primaryDistrictId: tech?.primaryDistrictId || null,
        enabledDistrictIds: tech?.enabledDistrictIds || [],
      },
    });
  } catch (error) {
    return internalError(res, error);
  }
};

export const revokeDistrictPermission = async (req, res) => {
  try {
    const { technicianId, districtId, reason } = req.body;

    if (!technicianId || !districtId || !reason) {
      return res.status(400).json({ success: false, message: "technicianId, districtId, and reason are required." });
    }
    if (!isValidObjectId(technicianId)) {
      return res.status(400).json({ success: false, message: "Invalid technicianId", code: "INVALID_ID" });
    }
    if (!isValidObjectId(districtId)) {
      return res.status(400).json({ success: false, message: "Invalid districtId", code: "INVALID_ID" });
    }

    // B-13: delegate to the canonical service. Primary-district revocation
    // is now PROTECTED (400) instead of silently re-pointing primary.
    const { removeDistrictPermission } = await import("../Services/technicianDistrictService.js");
    try {
      await removeDistrictPermission({
        technicianId,
        districtId,
        adminUserId: req.user._id || req.user?.userId,
        adminRole: req.user?.role,
        reason,
      });
    } catch (svcErr) {
      if (svcErr.code === "TECHNICIAN_NOT_FOUND") {
        return res.status(404).json({ success: false, message: "Technician not found", code: svcErr.code });
      }
      return res
        .status(svcErr.statusCode || 400)
        .json({ success: false, message: svcErr.message, code: svcErr.code });
    }

    const tech = await TechnicianProfile.findById(technicianId)
      .select("primaryDistrictId enabledDistrictIds location")
      .lean();

    // 🔄 Revalidate active broadcasts for this technician (district permission revoked)
    const { revalidateActiveBroadcasts } = await import("../Utils/technicianLocation.js");
    if (tech?.location?.coordinates) {
      const [lng, lat] = tech.location.coordinates;
      await revalidateActiveBroadcasts(technicianId, lat, lng, req.io)
        .catch(err => console.error("District permission revoke revalidation error:", err));
    }

    return res.status(200).json({
      success: true,
      message: "District permission revoked successfully",
      result: {
        primaryDistrictId: tech.primaryDistrictId,
        enabledDistrictIds: tech.enabledDistrictIds,
      },
    });
  } catch (error) {
    return internalError(res, error);
  }
};

/* =========================================================================
   E: IMPACT ANALYSIS & ADMIN TOGGLE
   ========================================================================= */

export const getImpactAnalysis = async (req, res) => {
  try {
    const { type, id } = req.query;
    if (!type || !id) return res.status(400).json({ success: false, message: "type and id are required" });
    if (!["district", "service"].includes(type)) {
      return res.status(400).json({ success: false, message: "Invalid type", code: "INVALID_ID" });
    }
    if (!isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: "Invalid id", code: "INVALID_ID" });
    }

    let affectedTechnicians = 0;
    let affectedServices = 0;
    let activeJobsCount = 0;
    let targetName = "";

    if (type === "district") {
      const district = await OperationalCity.findById(id);
      if (!district) return res.status(404).json({ success: false, message: "District not found" });
      targetName = district.name;

      [affectedTechnicians, affectedServices, activeJobsCount] = await Promise.all([
        TechnicianProfile.countDocuments({
          $or: [{ primaryDistrictId: id }, { enabledDistrictIds: id }],
        }),
        ServiceAvailability.countDocuments({ districtId: id, status: "ENABLED" }),
        ServiceBooking.countDocuments({
          status: { $in: ["pending", "broadcasted", "accepted", "on_the_way", "reached", "in_progress"] },
        }),
      ]);
    } else if (type === "service") {
      const service = await Service.findById(id);
      if (!service) return res.status(404).json({ success: false, message: "Service not found" });
      targetName = service.serviceName;

      [affectedTechnicians, affectedServices, activeJobsCount] = await Promise.all([
        TechnicianProfile.countDocuments({ "skills.serviceId": id }),
        ServiceAvailability.countDocuments({ serviceId: id, status: "ENABLED" }),
        ServiceBooking.countDocuments({
          serviceId: id,
          status: { $in: ["pending", "broadcasted", "accepted", "on_the_way", "reached", "in_progress"] },
        }),
      ]);
    }

    return res.status(200).json({
      success: true,
      result: {
        type,
        id,
        targetName,
        impactSummary: {
          affectedTechnicians,
          affectedServices,
          activeJobsCount,
        },
        warningMessage: `Disabling ${targetName} will impact ${affectedTechnicians} technicians, ${affectedServices} availability rules, and ${activeJobsCount} active dispatches/jobs.`,
      },
    });
  } catch (error) {
    return internalError(res, error);
  }
};

/* =========================================================================
   H & I: HIERARCHY TREE VIEW & DISTRICT DASHBOARD
   ========================================================================= */

export const getSpatialHierarchy = async (req, res) => {
  try {
    const districts = await OperationalCity.find({ active: true }).lean();
    const districtIds = districts.map((d) => d._id);

    const zones = await CityZone.find({ operationalCityId: { $in: districtIds } }).lean();

    const tree = districts.map((d) => ({
      districtId: d._id,
      districtName: d.name,
      state: d.state,
      country: d.country || "India",
      code: d.code,
      status: d.status,
      cityZones: zones
        .filter((z) => String(z.operationalCityId) === String(d._id))
        .map((z) => ({
          zoneId: z._id,
          zoneName: z.name,
          name: z.name,
          zoneCode: z.zoneCode,
          active: z.active,
        })),
    }));

    return res.status(200).json({ success: true, result: tree });
  } catch (error) {
    return internalError(res, error);
  }
};

export const getDistrictDashboardDetails = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: "Invalid district id", code: "INVALID_ID" });
    }
    const district = await OperationalCity.findById(id).lean();
    if (!district) return res.status(404).json({ success: false, message: "District not found" });

    const [cityZonesCount, techniciansCount, servicesCount, activeJobsCount] = await Promise.all([
      CityZone.countDocuments({ operationalCityId: id, active: true }),
      TechnicianProfile.countDocuments({
        $or: [{ primaryDistrictId: id }, { enabledDistrictIds: id }],
      }),
      ServiceAvailability.countDocuments({ districtId: id, status: "ENABLED" }),
      ServiceBooking.countDocuments({
        status: { $in: ["pending", "broadcasted", "accepted", "on_the_way", "reached", "in_progress"] },
      }),
    ]);

    return res.status(200).json({
      success: true,
      result: {
        district,
        metrics: {
          cityZonesCount,
          techniciansCount,
          servicesCount,
          activeJobsCount,
          healthStatus: district.status === "ACTIVE" ? "HEALTHY" : "ATTENTION_REQUIRED",
        },
      },
    });
  } catch (error) {
    return internalError(res, error);
  }
};

/* =========================================================================
   J & K & L & U: JOB / TECHNICIAN LOCATION INSPECTION & DIAGNOSTICS
   ========================================================================= */

export const inspectJobLocation = async (req, res) => {
  try {
    const { bookingId } = req.params;
    if (!isValidObjectId(bookingId)) {
      return res.status(400).json({ success: false, message: "Invalid bookingId", code: "INVALID_ID" });
    }
    const booking = await ServiceBooking.findById(bookingId)
      .populate("serviceId", "serviceName serviceCost")
      .populate("customerId", "fname lname mobileNumber")
      .lean();

    if (!booking) return res.status(404).json({ success: false, message: "Booking not found" });

    const [jobLng, jobLat] = booking.location?.coordinates || [0, 0];

    // Find nearby technicians within 15 KM for inspection
    const nearbyTechs = await TechnicianProfile.find({
      "location.coordinates": {
        $nearSphere: {
          $geometry: { type: "Point", coordinates: [jobLng, jobLat] },
          $maxDistance: 15000,
        },
      },
    })
      .select("userId location locationUpdatedAt availability primaryDistrictId enabledDistrictIds skills workStatus")
      .populate("userId", "fname lname mobileNumber")
      .limit(10)
      .lean();

    const techMarkers = [];
    for (const tech of nearbyTechs) {
      const eligibility = await checkTechnicianEligibility({
        technician: tech._id,
        booking,
      });

      const distMeters = haversineMeters(
        { latitude: jobLat, longitude: jobLng },
        { latitude: tech.location.coordinates[1], longitude: tech.location.coordinates[0] }
      );

      let statusBadge = "🟢 ELIGIBLE";
      if (!eligibility.eligible) {
        if (eligibility.reasons.includes("OUTSIDE_RADIUS")) statusBadge = "🔴 OUTSIDE_10KM_BOUNDARY";
        else if (eligibility.reasons.includes("GPS_STALE")) statusBadge = "⚫ GPS_STALE";
        else statusBadge = "🟠 WARNING";
      }

      techMarkers.push({
        technicianId: tech._id,
        name: `${tech.userId?.fname || ""} ${tech.userId?.lname || ""}`.trim(),
        mobile: tech.userId?.mobileNumber,
        coordinates: tech.location?.coordinates,
        distanceKm: Number((distMeters / 1000).toFixed(2)),
        statusBadge,
        eligible: eligibility.eligible,
        reasons: eligibility.reasons,
      });
    }

    return res.status(200).json({
      success: true,
      result: {
        bookingId: booking._id,
        serviceName: booking.serviceId?.serviceName,
        customerName: `${booking.customerId?.fname || ""} ${booking.customerId?.lname || ""}`.trim(),
        customerLocation: {
          latitude: jobLat,
          longitude: jobLng,
        },
        techMarkers,
      },
    });
  } catch (error) {
    return internalError(res, error);
  }
};

/* =========================================================================
   P & Q & Z: POLYGON ROLLBACK, MULTI-ENTITY SEARCH & ZONE HEALTH DASHBOARD
   ========================================================================= */

export const rollbackPolygonVersion = async (req, res) => {
  try {
    // B-16: baseVersion is an optional optimistic-concurrency guard — when
    // supplied, the live version must match it or the rollback is rejected,
    // so a concurrent polygon edit cannot be silently clobbered.
    const { entityType, entityId, targetVersion, baseVersion, reason } = req.body;

    if (!["DISTRICT", "CITY_ZONE"].includes(entityType)) {
      return res.status(400).json({ success: false, message: "Invalid entityType", code: "INVALID_ID" });
    }
    if (!isValidObjectId(entityId)) {
      return res.status(400).json({ success: false, message: "Invalid entityId", code: "INVALID_ID" });
    }
    const versionDoc = await PolygonVersion.findOne({
      entityType,
      entityId,
      version: targetVersion,
    });

    if (!versionDoc) {
      return res.status(404).json({ success: false, message: `Polygon version ${targetVersion} not found.` });
    }

    // B-05: restored geometry is re-validated (explicit 400 if a historic
    // version no longer satisfies current rules) and the rollback itself is
    // recorded as a NEW history row so the audit trail stays append-only.
    const restored = validateAndSanitizePolygon(versionDoc.polygon);
    if (!restored.valid) {
      return res.status(400).json({
        success: false,
        code: "ROLLBACK_GEOMETRY_INVALID",
        message: `Stored version ${targetVersion} no longer satisfies polygon validation and cannot be restored.`,
        errors: restored.errors,
      });
    }

    // B-16: placement recheck against CURRENT neighbors. A zone rollback
    // must not overlap sibling zones or escape its district; a district
    // rollback must not strand its active zones outside the restored shape.
    const { assertZonePlacement } = await import("../Services/zoneWriteService.js");
    const { validateZoneInsideDistrict } = await import("../Utils/geoValidation.js");
    let rollbackDistrictId = entityType === "DISTRICT" ? entityId : null;
    if (entityType === "CITY_ZONE") {
      const zoneDoc = await CityZone.findById(entityId).select("operationalCityId").lean();
      if (!zoneDoc) return res.status(404).json({ success: false, message: "City zone not found." });
      rollbackDistrictId = zoneDoc.operationalCityId;
      const placement = await assertZonePlacement({
        sanitizedPolygon: restored.sanitizedPolygon,
        districtId: zoneDoc.operationalCityId,
        excludeZoneId: entityId,
      });
      if (!placement.ok) {
        return res.status(placement.status).json({
          success: false, code: placement.code,
          message: `Rollback to version ${targetVersion} rejected: ${placement.message}`,
        });
      }
    } else {
      const districtDoc = await OperationalCity.findById(entityId).select("version").lean();
      if (!districtDoc) return res.status(404).json({ success: false, message: "District not found." });
      // Optimistic concurrency: live version must match the caller's base.
      if (baseVersion !== undefined && baseVersion !== null && Number(baseVersion) !== Number(districtDoc.version)) {
        return res.status(409).json({
          success: false, code: "ROLLBACK_VERSION_CONFLICT",
          message: `District geometry changed since version ${baseVersion} was read (live: v${districtDoc.version}). Re-check and retry.`,
        });
      }
      const childZones = await CityZone.find({ operationalCityId: entityId, active: true }).select("name polygon").lean();
      for (const z of childZones) {
        if (!z.polygon) continue;
        const containment = validateZoneInsideDistrict(z.polygon, restored.sanitizedPolygon);
        if (!containment.valid) {
          return res.status(409).json({
            success: false, code: "ROLLBACK_STRANDS_ZONES",
            message: `Rollback to version ${targetVersion} rejected: active zone "${z.name}" would fall outside the restored district boundary.`,
          });
        }
      }
    }

    await withZoneWriteTransaction(async (session) => {
      const opts = session ? { session } : {};
      const created = await recordPolygonVersion(
        {
          entityType,
          entityId,
          polygon: versionDoc.polygon,
          changedBy: req.user._id,
          changeReason: reason || `Rollback to version ${targetVersion}`,
        },
        session
      );
      if (entityType === "DISTRICT") {
        // Conditional write: abort if geometry moved since the pre-check.
        const applied = await OperationalCity.updateOne(
          baseVersion !== undefined && baseVersion !== null
            ? { _id: entityId, version: Number(baseVersion) }
            : { _id: entityId },
          { $set: { polygon: versionDoc.polygon, version: created.version, updatedBy: req.user._id } },
          opts
        );
        if (applied.matchedCount === 0) {
          throw Object.assign(new Error("District geometry changed concurrently; rollback aborted."), {
            code: "ROLLBACK_VERSION_CONFLICT",
            statusCode: 409,
          });
        }
      } else if (entityType === "CITY_ZONE") {
        await CityZone.updateOne(
          { _id: entityId },
          { $set: { polygon: versionDoc.polygon, updatedBy: req.user._id } },
          opts
        );
      }
    });
    if (entityType === "DISTRICT") invalidateDistrictPolygonCache(String(entityId));

    // B-16: audit trail (actor, target, source version, reason) + broadcast
    // revalidation against the restored shape. Post-commit hooks: failures
    // are logged, never fail the committed rollback.
    await writeAuditLog({
      actor: req.user._id,
      actorRole: req.user?.role || "Admin",
      action: "POLYGON_ROLLBACK",
      targetType: entityType === "DISTRICT" ? "OperationalCity" : "CityZone",
      targetId: entityId,
      after: { restoredVersion: targetVersion, reason: reason || `Rollback to version ${targetVersion}` },
    }).catch((e) => console.warn("Rollback audit warning:", e.message));

    const { revalidateTechniciansForService } = await import("../Utils/technicianLocation.js");
    if (entityType === "DISTRICT") {
      await revalidateTechniciansForService(null, entityId, null, req.io)
        .catch((e) => console.warn("Rollback revalidation warning:", e.message));
    } else {
      await revalidateTechniciansForService(null, rollbackDistrictId, entityId, req.io)
        .catch((e) => console.warn("Rollback revalidation warning:", e.message));
    }

    return res.status(200).json({
      success: true,
      message: `Successfully rolled back ${entityType} polygon to version ${targetVersion}`,
    });
  } catch (error) {
    if (error?.statusCode) {
      return res.status(error.statusCode).json({ success: false, message: error.message, code: error.code });
    }
    return internalError(res, error);
  }
};

/**
 * POST /api/admin/zone-geofence/validate-polygon
 * Read-only pre-write validation for admin-drawn polygons (GeoJSON tool).
 * Body: { polygon, districtId?, excludeZoneId? }
 * - Always runs the canonical geometry validator.
 * - With districtId: also checks district containment + overlap against
 *   sibling zones (excluding excludeZoneId), using the same rules as create.
 * Never writes. Admin/Owner only (router guard).
 */
export const validatePolygonPreview = async (req, res) => {
  try {
    const { polygon, districtId, excludeZoneId } = req.body || {};
    const validation = validateAndSanitizePolygon(polygon);
    const vertexCount = Array.isArray(polygon?.coordinates?.[0]) ? polygon.coordinates[0].length : 0;

    const result = {
      isValid: validation.valid,
      errors: validation.errors,
      sanitizedPolygon: validation.sanitizedPolygon,
      vertexCount,
      codeOrder: "Counter-Clockwise (Standard)",
      containment: null,
      overlap: null,
    };

    if (validation.valid && districtId) {
      if (!isValidObjectId(districtId)) {
        return res.status(400).json({ success: false, message: "Invalid districtId", code: "INVALID_ID" });
      }
      if (excludeZoneId && !isValidObjectId(excludeZoneId)) {
        return res.status(400).json({ success: false, message: "Invalid excludeZoneId", code: "INVALID_ID" });
      }
      const { assertZonePlacement } = await import("../Services/zoneWriteService.js");
      const placement = await assertZonePlacement({
        sanitizedPolygon: validation.sanitizedPolygon,
        districtId,
        excludeZoneId: excludeZoneId || null,
      });
      if (placement.status === 404) {
        return res.status(404).json({ success: false, message: placement.message, code: placement.code });
      }
      const outside = placement.code === "ZONE_OUTSIDE_PARENT_DISTRICT";
      result.containment = {
        checked: true,
        // Render-compatible keys (both spellings).
        isFullyContained: placement.ok || !outside,
        isContained: placement.ok || !outside,
        message: placement.ok ? "Polygon completely contained within district limits." : placement.message,
        reason: placement.ok ? null : placement.message,
      };
      const overlap = !placement.ok && placement.code === "ZONE_OVERLAP_DETECTED";
      result.overlap = {
        checked: true,
        hasOverlap: overlap,
        overlappingZone: overlap ? placement.message : null,
        message: overlap ? placement.message : "No overlap with sibling zones detected.",
      };
      result.isValid = placement.ok;
      if (!placement.ok) result.errors = [...validation.errors, placement.message];
    }

    return res.status(200).json({ success: true, result });
  } catch (error) {
    return internalError(res, error);
  }
};

export const getZoneHealthDashboard = async (req, res) => {
  try {
    const cutoffStale = new Date(Date.now() - 90 * 1000); // 90 second freshness gate

    const [
      activeDistricts,
      inactiveDistricts,
      invalidDistricts,
      staleTechsCount,
      totalServicesCount,
      disabledServicesCount,
    ] = await Promise.all([
      OperationalCity.countDocuments({ status: "ACTIVE" }),
      OperationalCity.countDocuments({ status: "INACTIVE" }),
      OperationalCity.countDocuments({ status: "INVALID" }),
      TechnicianProfile.countDocuments({
        "availability.isOnline": true,
        $or: [{ locationUpdatedAt: { $lt: cutoffStale } }, { locationUpdatedAt: null }],
      }),
      Service.countDocuments({ isActive: true }),
      ServiceAvailability.countDocuments({ status: "DISABLED" }),
    ]);

    return res.status(200).json({
      success: true,
      result: {
        districtHealth: {
          activeDistricts,
          inactiveDistricts,
          invalidDistricts,
          reviewRequiredDistricts: 0,
        },
        systemHealth: {
          staleGpsTechnicians: staleTechsCount,
          totalActiveServices: totalServicesCount,
          disabledServiceRules: disabledServicesCount,
          redisStatus: "CONNECTED",
          mongoSpatialStatus: "OPERATIONAL",
        },
      },
    });
  } catch (error) {
    return internalError(res, error);
  }
};

/* =========================================================================
   1, 2, 8, 12, 13: ADVANCED TECHNICIAN ZONE/GEOFENCE LISTING & DETAILS
   ========================================================================= */

export const listAdminTechnicians = async (req, res) => {
  try {
    const {
      search,
      districtId,
      serviceId,
      accountStatus,
      verificationStatus,
      onlineStatus,
      gpsStatus,
      gpsFreshness,
      jobLat,
      jobLng,
      bookingId,
      page = 1,
      limit = 20,
    } = req.query;

    let targetJobLat = jobLat ? Number(jobLat) : null;
    let targetJobLng = jobLng ? Number(jobLng) : null;
    let targetBooking = null;

    if (bookingId) {
      if (!isValidObjectId(bookingId)) {
        return res.status(400).json({ success: false, message: "Invalid bookingId", code: "INVALID_ID" });
      }
      targetBooking = await ServiceBooking.findById(bookingId).lean();
      if (targetBooking?.location?.coordinates) {
        targetJobLng = targetBooking.location.coordinates[0];
        targetJobLat = targetBooking.location.coordinates[1];
      }
    }

    const techQuery = {};

    if (districtId && districtId !== "all" && districtId !== "All" && districtId !== "undefined" && districtId !== "null" && String(districtId).trim() !== "") {
      const dStr = String(districtId).trim();
      const districtConditions = [];

      if (mongoose.Types.ObjectId.isValid(dStr)) {
        const dObjId = new mongoose.Types.ObjectId(dStr);
        districtConditions.push(
          { primaryDistrictId: dObjId },
          { primaryCityId: dObjId },
          { enabledDistrictIds: dObjId },
          { allowedCityIds: dObjId }
        );
      }

      // Also match by district name if passed as text or code (literal-escaped).
      const exact = exactRegex(dStr);
      const contains = containsRegex(dStr);
      const matchingDistricts = await OperationalCity.find({
        $or: [
          { name: exact },
          { city: exact },
          { code: exact },
          { name: { $regex: contains } }
        ]
      }).select("_id").lean().catch(() => []);

      if (matchingDistricts.length > 0) {
        const matchingIds = matchingDistricts.map(d => d._id);
        districtConditions.push(
          { primaryDistrictId: { $in: matchingIds } },
          { primaryCityId: { $in: matchingIds } },
          { enabledDistrictIds: { $in: matchingIds } },
          { allowedCityIds: { $in: matchingIds } }
        );
      }

      // Match legacy text string in city
      districtConditions.push({ city: exact });

      if (districtConditions.length > 0) {
        techQuery.$or = districtConditions;
      }
    }

    if (accountStatus && accountStatus !== "All") {
      techQuery.workStatus = accountStatus.toLowerCase();
    }

    if (verificationStatus && verificationStatus !== "All") {
      if (verificationStatus.toLowerCase() === "verified") techQuery.workStatus = "approved";
      else if (verificationStatus.toLowerCase() === "pending") techQuery.workStatus = "pending";
      else if (verificationStatus.toLowerCase() === "rejected") techQuery.workStatus = "rejected";
    }

    if (onlineStatus && onlineStatus !== "All") {
      techQuery["availability.isOnline"] = onlineStatus.toLowerCase() === "online";
    }

    if (serviceId) {
      // B-17: malformed service ids fail closed instead of CastError 500.
      if (!isValidObjectId(serviceId)) {
        return res.status(400).json({ success: false, message: "Invalid serviceId", code: "INVALID_ID" });
      }
      techQuery["skills.serviceId"] = serviceId;
    }

    // B-08: GPS buckets as DB predicates (identical bucket semantics to the
    // old in-memory filters: missing timestamps count as stale; missing
    // coordinates count as missing).
    const now = Date.now();
    const freshCutoff = new Date(now - 90 * 1000);
    const fresh30Cutoff = new Date(now - 30 * 1000);
    const andClauses = [];
    if (gpsStatus && gpsStatus !== "All") {
      if (gpsStatus === "GPS Fresh") andClauses.push({ locationUpdatedAt: { $gte: freshCutoff } });
      else if (gpsStatus === "GPS Stale") {
        andClauses.push({
          $or: [{ locationUpdatedAt: { $lt: freshCutoff } }, { locationUpdatedAt: null }],
        });
      } else if (gpsStatus === "GPS Missing") {
        andClauses.push({ $or: [{ location: null }, { "location.coordinates": null }] });
      }
    }
    if (gpsFreshness === "< 30 sec") andClauses.push({ locationUpdatedAt: { $gte: fresh30Cutoff } });
    else if (gpsFreshness === "> 90 sec") {
      andClauses.push({
        $or: [{ locationUpdatedAt: { $lt: freshCutoff } }, { locationUpdatedAt: null }],
      });
    }

    // B-08: search at the DB layer via the Users collection (one query) plus
    // profile text fields, instead of loading every technician. The exact
    // name/id/phone/email predicate is still applied to page items below.
    let searchTruncated = false;
    if (search && String(search).trim() !== "") {
      const rx = containsRegex(search);
      const matchingUsers = await User.find({
        $or: [{ fname: rx }, { lname: rx }, { mobileNumber: rx }, { email: rx }],
      })
        .select("_id")
        .limit(500)
        .lean()
        .catch(() => []);
      if (matchingUsers.length >= 500) searchTruncated = true;
      andClauses.push({
        $or: [
          { userId: { $in: matchingUsers.map((u) => u._id) } },
          { city: rx },
          { locality: rx },
        ],
      });
    }

    // Merge district $or with search/gps $and clauses (all filters AND).
    let finalQuery = techQuery;
    if (andClauses.length) {
      const base = techQuery.$or ? [{ $or: techQuery.$or }] : [];
      const rest = { ...techQuery };
      delete rest.$or;
      finalQuery = { $and: [...base, rest, ...andClauses] };
    }

    // B-08: bounded at the database layer — count + stable-sorted page fetch
    // BEFORE any per-technician work. Eligibility below is annotation-only
    // (it never filtered totals), so page-scoped evaluation preserves
    // semantics exactly while bounding N+1 by page size.
    const boundedPage = clampPage(page);
    const boundedLimit = clampLimit(limit);
    const boundedSkip = (boundedPage - 1) * boundedLimit;
    const [total, technicians] = await Promise.all([
      TechnicianProfile.countDocuments(finalQuery),
      TechnicianProfile.find(finalQuery)
        .sort({ _id: 1 })
        .skip(boundedSkip)
        .limit(boundedLimit)
        .populate("userId", "fname lname email mobileNumber")
        .populate("primaryDistrictId", "name code city")
        .populate("primaryCityId", "name code city")
        .populate("enabledDistrictIds", "name code city")
        .populate("allowedCityIds", "name code city")
        .lean(),
    ]);

    const formattedList = [];

    for (const tech of technicians) {
      const name = `${tech.userId?.fname || ""} ${tech.userId?.lname || ""}`.trim() || "Technician";
      const techIdStr = tech.technicianId || String(tech._id).slice(-6).toUpperCase();
      const mobile = tech.userId?.mobileNumber || "";
      const email = tech.userId?.email || "";

      // 🔍 Exact search predicate on page items (name, derived ID, phone, email).
      if (search && String(search).trim() !== "") {
        const q = String(search).toLowerCase();
        const matchesName = name.toLowerCase().includes(q);
        const matchesId = techIdStr.toLowerCase().includes(q);
        const matchesMobile = mobile.includes(q);
        const matchesEmail = email.toLowerCase().includes(q);

        if (!matchesName && !matchesId && !matchesMobile && !matchesEmail) {
          continue;
        }
      }

      // ⏱ GPS Freshness Calculation
      const lastUpdate = tech.locationUpdatedAt ? new Date(tech.locationUpdatedAt).getTime() : 0;
      const ageSeconds = lastUpdate > 0 ? Math.floor((now - lastUpdate) / 1000) : 9999;

      let freshnessBadge = "STALE (>90s)";
      if (ageSeconds < 30) freshnessBadge = "< 30s (Fresh)";
      else if (ageSeconds <= 60) freshnessBadge = "30-60s";
      else if (ageSeconds <= 90) freshnessBadge = "60-90s";

      // NOTE (B-08): GPS-status/freshness filtering now happens in the DB
      // query above with identical bucket semantics; badges below are
      // display-only.

      // 📏 Distance calculation if job location present
      let distanceKm = null;
      if (targetJobLat !== null && targetJobLng !== null && tech.location?.coordinates) {
        const distMeters = haversineMeters(
          { latitude: targetJobLat, longitude: targetJobLng },
          { latitude: tech.location.coordinates[1], longitude: tech.location.coordinates[0] }
        );
        distanceKm = Number((distMeters / 1000).toFixed(2));
      }

      // 🎯 Eligibility check if target job/booking is present
      let eligibility = { eligible: true, reasons: [], details: {} };
      if (targetBooking) {
        eligibility = await checkTechnicianEligibility({
          technician: tech._id,
          booking: targetBooking,
        });
      }

      let eligibilityStatus = "ELIGIBLE";
      let failureReason = null;
      if (!eligibility.eligible) {
        eligibilityStatus = "NOT_ELIGIBLE";
        failureReason = eligibility.reasons[0] || "INELIGIBLE";
      }

      const primaryDistrictDoc = tech.primaryDistrictId || tech.primaryCityId;
      const primaryDistrictName = primaryDistrictDoc?.name || primaryDistrictDoc?.city || tech.city || "Unassigned";
      const radiusVal = tech.coverageRadiusKm || tech.serviceRadius || tech.radius || 10;

      formattedList.push({
        _id: tech._id,
        id: tech._id,
        technicianId: techIdStr,
        name,
        technician: name,
        technicianName: name,
        mobile,
        phone: mobile,
        mobileNumber: mobile,
        email,
        primaryDistrict: primaryDistrictName,
        district: primaryDistrictName,
        primaryDistrictId: primaryDistrictDoc?._id || null,
        enabledDistricts: [
          ...(tech.enabledDistrictIds || []),
          ...(tech.allowedCityIds || [])
        ].map((d) => d?.name || d?.city || String(d)).filter(Boolean),
        serviceRadius: `${radiusVal} KM`,
        coverageRadiusKm: radiusVal,
        radius: radiusVal,
        geofenceStatus: tech.zoneMismatch ? "Outside Zone" : (tech.location?.coordinates ? "GPS Defined" : "No GPS"),
        status: tech.workStatus || "pending",
        online: tech.availability?.isOnline ? "🟢 Online" : "🔴 Offline",
        isOnline: tech.availability?.isOnline || false,
        gpsFreshness: freshnessBadge,
        gpsAgeSeconds: ageSeconds,
        location: tech.location?.coordinates || null,
        distanceKm: distanceKm !== null ? `${distanceKm} KM` : "N/A",
        rawDistanceKm: distanceKm,
        eligibility: eligibilityStatus,
        failureReason,
        workStatus: tech.workStatus || "pending",
      });
    }

    // B-08: DB-bounded pagination. `total` is the database-filtered count
    // (eligibility is annotation-only and never affected totals, so page
    // scoping preserves semantics). Stable _id ordering across pages.
    return res.status(200).json({
      success: true,
      result: formattedList,
      pagination: {
        total,
        page: boundedPage,
        limit: boundedLimit,
        pages: Math.ceil(total / boundedLimit) || 1,
        searchTruncated,
      },
    });
  } catch (error) {
    return internalError(res, error);
  }
};

export const getAdminTechnicianDetails = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: "Invalid technician id", code: "INVALID_ID" });
    }

    const [tech, permHistory] = await Promise.all([
      TechnicianProfile.findById(id)
        .populate("userId", "fname lname email mobileNumber status createdAt")
        .populate("primaryDistrictId", "name code state city")
        .populate("primaryCityId", "name code state city")
        .populate("enabledDistrictIds", "name code state city")
        .populate("allowedCityIds", "name code state city")
        .populate("skills.serviceId", "serviceName serviceType")
        .lean(),
      DistrictPermissionHistory.find({ technicianId: id })
        .populate("districtId", "name code city")
        .populate("adminId", "fname lname email")
        .sort({ createdAt: -1 })
        .lean(),
    ]);

    if (!tech) return res.status(404).json({ success: false, message: "Technician not found" });

    const lastUpdate = tech.locationUpdatedAt ? new Date(tech.locationUpdatedAt).getTime() : 0;
    const ageSeconds = lastUpdate > 0 ? Math.floor((Date.now() - lastUpdate) / 1000) : 9999;
    const primaryDistrictDoc = tech.primaryDistrictId || tech.primaryCityId;
    const radiusVal = tech.coverageRadiusKm || tech.serviceRadius || tech.radius || 10;

    return res.status(200).json({
      success: true,
      result: {
        profile: {
          technicianId: tech._id,
          name: `${tech.userId?.fname || ""} ${tech.userId?.lname || ""}`.trim() || "Technician",
          email: tech.userId?.email,
          mobile: tech.userId?.mobileNumber,
          accountStatus: tech.userId?.status || "Active",
          workStatus: tech.workStatus || "pending",
        },
        verification: {
          workStatus: tech.workStatus,
          profileComplete: tech.profileComplete,
          trainingCompleted: tech.trainingCompleted,
        },
        location: {
          coordinates: tech.location?.coordinates || null,
          locationUpdatedAt: tech.locationUpdatedAt,
          ageSeconds,
          isFresh: ageSeconds <= 90,
          freshnessBadge: ageSeconds <= 90 ? "Fresh (<=90s)" : "Stale (>90s)",
        },
        permissions: {
          primaryDistrict: primaryDistrictDoc || { name: tech.city || "Unassigned" },
          enabledDistricts: [
            ...(tech.enabledDistrictIds || []),
            ...(tech.allowedCityIds || [])
          ],
          permissionHistory: permHistory,
        },
        coverageRadiusKm: radiusVal,
        serviceRadius: radiusVal,
        radius: radiusVal,
        skills: tech.skills || [],
      },
    });
  } catch (error) {
    return internalError(res, error);
  }
};

export const updateTechnicianVerification = async (req, res) => {
  try {
    const { id } = req.params;
    const { action, reason } = req.body; // action: "APPROVE", "REJECT", "SUSPEND", "REACTIVATE"

    if (!isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: "Invalid technician id", code: "INVALID_ID" });
    }
    const tech = await TechnicianProfile.findById(id);
    if (!tech) return res.status(404).json({ success: false, message: "Technician profile not found" });

    if (action === "APPROVE") tech.workStatus = "approved";
    else if (action === "REJECT") tech.workStatus = "rejected";
    else if (action === "SUSPEND") tech.workStatus = "suspended";
    else if (action === "REACTIVATE") tech.workStatus = "approved";
    else return res.status(400).json({ success: false, message: "Invalid action. Allowed: APPROVE, REJECT, SUSPEND, REACTIVATE" });

    await tech.save();

    try {
      const io = req.app?.get("io") || req.io;
      if (io) {
        io.to(SOCKET_ROOMS.TECHNICIAN(id)).emit(SOCKET_EVENTS.PERMISSION_STATUS_CHANGED, {
          permissionType: "Geofence / Location Validation",
          status: tech.workStatus,
          action,
          reason,
          timestamp: new Date(),
        });
      }
      await sendPushNotification(
        id,
        {
          title: "Geofence Verification Status Updated",
          body: `Your GPS location verification status is now ${tech.workStatus.toUpperCase()}.`,
          data: {
            type: "permission_status_changed",
            permissionType: "Geofence",
            status: tech.workStatus,
            action,
          },
        },
        { recipientType: "technician" }
      );
      await Notification.create({
        recipientId: id,
        recipientType: "technician",
        eventType: "PERMISSION_STATUS_CHANGED",
        title: "Geofence Verification Status Updated",
        body: `Your GPS location verification status is now ${tech.workStatus.toUpperCase()}.`,
        data: { permissionType: "Geofence", status: tech.workStatus, action, reason },
        category: "system",
      }).catch(() => {});
    } catch (notifErr) {
      console.warn("Geofence verification notification error:", notifErr.message);
    }

    return res.status(200).json({
      success: true,
      message: `Technician status updated to ${tech.workStatus}`,
      result: { workStatus: tech.workStatus, reason },
    });
  } catch (error) {
    return internalError(res, error);
  }
};

export const getJobBroadcastAudit = async (req, res) => {
  try {
    const { bookingId } = req.params;
    if (!isValidObjectId(bookingId)) {
      return res.status(400).json({ success: false, message: "Invalid bookingId", code: "INVALID_ID" });
    }
    const booking = await ServiceBooking.findById(bookingId).lean();
    if (!booking) return res.status(404).json({ success: false, message: "Booking not found" });

    const attempts = Array.isArray(booking.assignmentAttempts) ? booking.assignmentAttempts : [];

    return res.status(200).json({
      success: true,
      result: {
        bookingId: booking._id,
        status: booking.status,
        activeBroadcastVersion: booking.activeBroadcastVersion || 1,
        assignedTechnicianId: booking.technicianId,
        broadcastAudit: attempts,
      },
    });
  } catch (error) {
    return internalError(res, error);
  }
};

