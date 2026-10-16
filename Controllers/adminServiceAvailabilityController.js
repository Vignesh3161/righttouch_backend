import mongoose from "mongoose";
import ServiceAvailability from "../Schemas/ServiceAvailability.js";
import Service from "../Schemas/Service.js";
import OperationalCity from "../Schemas/OperationalCity.js";
import CityZone from "../Schemas/CityZone.js";
import Category from "../Schemas/Category.js";
import ServiceBooking from "../Schemas/ServiceBooking.js";
import TechnicianProfile from "../Schemas/TechnicianProfile.js";
import AuditLog from "../Schemas/AuditLog.js";
import { checkTechnicianEligibility } from "../Services/technicianEligibilityService.js";
import { resolveServiceAvailability } from "../Services/serviceAvailabilityService.js";
import { isValidObjectId, containsRegex, internalError } from "../Utils/safeQuery.js";

/**
 * 🛠 ADMIN: CREATE SERVICE AVAILABILITY CONFIGURATION
 */
export const createServiceAvailability = async (req, res) => {
  try {
    const { serviceId, districtId, cityId, cityName, scope, status } = req.body;
    const adminId = req.user?.userId;

    if (!serviceId || !districtId) {
      return res.status(400).json({
        success: false,
        message: "serviceId and districtId are required",
      });
    }
    if (!isValidObjectId(serviceId)) {
      return res.status(400).json({ success: false, message: "Invalid serviceId", code: "INVALID_ID" });
    }
    if (!isValidObjectId(districtId)) {
      return res.status(400).json({ success: false, message: "Invalid districtId", code: "INVALID_ID" });
    }
    if (cityId && !isValidObjectId(cityId)) {
      return res.status(400).json({ success: false, message: "Invalid cityId", code: "INVALID_ID" });
    }

    const service = await Service.findById(serviceId).lean();
    if (!service) {
      return res.status(404).json({ success: false, message: "Service not found" });
    }

    const district = await OperationalCity.findById(districtId).lean();
    if (!district) {
      return res.status(404).json({ success: false, message: "District not found" });
    }

    const finalScope = scope === "CITY" ? "CITY" : "DISTRICT";
    const finalCityId = finalScope === "CITY" && cityId ? cityId : null;
    // B-10: dual-write the canonical cityZoneId mirror so legacy CITY rows
    // remain readable after a future cityId retirement (scope stays CITY to
    // preserve CITY_* response reasons; the resolver prefers canonical ZONE
    // rows deterministically on conflict).

    // Check for conflicting configuration. Legacy rows may carry only one
    // of the two mirrored identifiers, so match on either.
    const existing = await ServiceAvailability.findOne({
      serviceId,
      districtId,
      scope: finalScope,
      $or: [{ cityId: finalCityId }, { cityZoneId: finalCityId }],
    });

    if (existing) {
      return res.status(409).json({
        success: false,
        message: "A service availability configuration already exists for this service, district, and scope.",
        existingId: existing._id,
      });
    }

    const config = await ServiceAvailability.create({
      serviceId,
      districtId,
      cityId: finalCityId,
      cityZoneId: finalCityId,
      cityName: cityName || null,
      scope: finalScope,
      status: status === "DISABLED" ? "DISABLED" : "ENABLED",
      createdBy: adminId || null,
      updatedBy: adminId || null,
    });

    // Audit Event
    await AuditLog.create({
      adminId: adminId || null,
      action: config.status === "ENABLED" ? "SERVICE_ENABLED" : "SERVICE_DISABLED",
      entityType: "ServiceAvailability",
      entityId: config._id,
      newValue: config.toObject(),
      reason: `Admin created ${finalScope} level service availability for ${service.serviceName} in ${district.name}`,
    }).catch(() => {});

    // 🔄 Revalidate technicians affected by this service availability change
    const { revalidateTechniciansForService } = await import("../Utils/technicianLocation.js");
    await revalidateTechniciansForService(config.serviceId, config.districtId, config.cityId, req.io)
      .catch(err => console.error("Service availability create revalidation error:", err));

    return res.status(201).json({
      success: true,
      message: `Service availability created (${finalScope} - ${config.status})`,
      result: config,
    });
  } catch (error) {
    console.error("createServiceAvailability error:", error);
    return internalError(res, error);
  }
};

/**
 * 🛠 ADMIN: UPDATE SERVICE AVAILABILITY CONFIGURATION
 */
export const updateServiceAvailability = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, scope, cityId, cityName } = req.body;
    const adminId = req.user?.userId;

    if (!isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: "Invalid configuration id", code: "INVALID_ID" });
    }
    if (cityId !== undefined && cityId !== null && !isValidObjectId(cityId)) {
      return res.status(400).json({ success: false, message: "Invalid cityId", code: "INVALID_ID" });
    }
    const existing = await ServiceAvailability.findById(id);
    if (!existing) {
      return res.status(404).json({ success: false, message: "Configuration not found" });
    }

    const oldValue = existing.toObject();

    if (status && ["ENABLED", "DISABLED"].includes(status)) {
      existing.status = status;
    }
    if (scope && ["DISTRICT", "CITY"].includes(scope)) {
      existing.scope = scope;
      if (scope === "DISTRICT") {
        existing.cityId = null;
        existing.cityZoneId = null;
      }
    }
    if (cityId !== undefined) {
      // B-10: keep the canonical cityZoneId mirror in sync with legacy cityId.
      const mirrored = existing.scope === "CITY" ? cityId : null;
      existing.cityId = mirrored;
      existing.cityZoneId = mirrored;
    }
    if (cityName !== undefined) {
      existing.cityName = cityName;
    }

    existing.updatedBy = adminId || null;
    await existing.save();

    // Audit Event
    await AuditLog.create({
      adminId: adminId || null,
      action: existing.status === "ENABLED" ? "SERVICE_ENABLED" : "SERVICE_DISABLED",
      entityType: "ServiceAvailability",
      entityId: existing._id,
      oldValue,
      newValue: existing.toObject(),
      reason: `Admin updated service availability status to ${existing.status}`,
    }).catch(() => {});

    // 🔄 Revalidate technicians affected by this service availability change
    // Trigger on ANY status change (ENABLED or DISABLED) or scope change
    const { revalidateTechniciansForService } = await import("../Utils/technicianLocation.js");
    await revalidateTechniciansForService(existing.serviceId, existing.districtId, existing.cityId, req.io)
      .catch(err => console.error("Service availability update revalidation error:", err));

    return res.status(200).json({
      success: true,
      message: "Service availability updated successfully",
      result: existing,
    });
  } catch (error) {
    console.error("updateServiceAvailability error:", error);
    return internalError(res, error);
  }
};

/**
 * 🛠 ADMIN: GET ALL SERVICE AVAILABILITIES WITH FILTERS & PAGINATION
 */
export const getServiceAvailability = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const skip = (page - 1) * limit;

    const { serviceId, districtId, cityId, scope, status, search } = req.query;

    const filter = {};
    for (const [key, val] of [["serviceId", serviceId], ["districtId", districtId], ["cityId", cityId]]) {
      if (val) {
        if (!isValidObjectId(val)) {
          return res.status(400).json({ success: false, message: `Invalid ${key}`, code: "INVALID_ID" });
        }
        filter[key] = val;
      }
    }
    if (scope && scope !== "ALL") filter.scope = scope;
    if (status && status !== "ALL") filter.status = status;

    if (search) {
      filter.$or = [
        { cityName: containsRegex(search) },
      ];
    }

    const [data, total] = await Promise.all([
      ServiceAvailability.find(filter)
        .populate("serviceId", "serviceName serviceType categoryId")
        .populate("districtId", "name state code")
        .sort({ updatedAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      ServiceAvailability.countDocuments(filter),
    ]);

    const totalPages = Math.ceil(total / limit) || 1;

    return res.status(200).json({
      success: true,
      result: data,
      pagination: {
        page,
        limit,
        total,
        totalPages,
        hasNext: page < totalPages,
        hasPrevious: page > 1,
      },
    });
  } catch (error) {
    console.error("getServiceAvailability error:", error);
    return internalError(res, error);
  }
};

/**
 * 🛠 ADMIN: DELETE SERVICE AVAILABILITY
 */
export const deleteServiceAvailability = async (req, res) => {
  try {
    const { id } = req.params;
    const adminId = req.user?.userId;

    if (!isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: "Invalid configuration id", code: "INVALID_ID" });
    }
    const existing = await ServiceAvailability.findByIdAndDelete(id);
    if (!existing) {
      return res.status(404).json({ success: false, message: "Configuration not found" });
    }

    await AuditLog.create({
      adminId: adminId || null,
      action: "SERVICE_UPDATED",
      entityType: "ServiceAvailability",
      entityId: id,
      oldValue: existing.toObject(),
      reason: "Admin deleted service availability configuration",
    }).catch(() => {});

    // 🔄 Revalidate technicians affected by this service availability deletion
    const { revalidateTechniciansForService } = await import("../Utils/technicianLocation.js");
    await revalidateTechniciansForService(existing.serviceId, existing.districtId, existing.cityId, req.io)
      .catch(err => console.error("Service availability delete revalidation error:", err));

    return res.status(200).json({
      success: true,
      message: "Service availability configuration deleted successfully",
    });
  } catch (error) {
    console.error("deleteServiceAvailability error:", error);
    return internalError(res, error);
  }
};

/**
 * 🩺 ADMIN DIAGNOSTIC / ZONE HEALTH SCREEN API
 * Returns machine-readable breakdown of dispatch eligibility for a technician & job.
 */
export const dispatchDiagnostics = async (req, res) => {
  try {
    const { technicianId, bookingId, serviceId, latitude, longitude, districtId, cityId } = req.query;

    if (!technicianId) {
      return res.status(400).json({ success: false, message: "technicianId is required for diagnostics" });
    }
    if (!isValidObjectId(technicianId)) {
      return res.status(400).json({ success: false, message: "Invalid technicianId", code: "INVALID_ID" });
    }
    for (const [key, val] of [["bookingId", bookingId], ["serviceId", serviceId], ["districtId", districtId], ["cityId", cityId]]) {
      if (val && !isValidObjectId(val)) {
        return res.status(400).json({ success: false, message: `Invalid ${key}`, code: "INVALID_ID" });
      }
    }

    let booking = null;
    if (bookingId) {
      booking = await ServiceBooking.findById(bookingId).lean();
    }

    const tech = await TechnicianProfile.findById(technicianId)
      .populate("primaryDistrictId", "name code")
      .populate("enabledDistrictIds", "name code")
      .lean();

    if (!tech) {
      return res.status(404).json({ success: false, message: "Technician profile not found" });
    }

    // Build a synthetic booking when only adhoc coords/service are supplied —
    // evaluateTechnicianEligibility requires a booking-shaped object.
    if (!booking) {
      if (!serviceId && (!latitude || !longitude)) {
        return res.status(400).json({ success: false, message: "bookingId OR (serviceId + latitude/longitude) is required" });
      }
      const jobLat = latitude != null ? Number(latitude) : null;
      const jobLng = longitude != null ? Number(longitude) : null;
      booking = {
        _id: null,
        serviceId: serviceId || null,
        districtId: districtId || null,
        cityZoneId: cityId || null,
        location: Number.isFinite(jobLat) && Number.isFinite(jobLng)
          ? { type: "Point", coordinates: [jobLng, jobLat] }
          : undefined,
        technicianId: null,
      };
    }

    const eligibility = await checkTechnicianEligibility({
      technician: tech,
      booking,
    });

    return res.status(200).json({
      success: true,
      diagnostic: {
        technician: {
          id: tech._id,
          workStatus: tech.workStatus,
          isOnline: tech.availability?.isOnline,
          primaryDistrict: tech.primaryDistrictId?.name || null,
          enabledDistricts: (tech.enabledDistrictIds || []).map((d) => d.name || d._id),
          currentGps: tech.location?.coordinates || null,
          locationUpdatedAt: tech.locationUpdatedAt,
        },
        eligibility,
      },
    });
  } catch (error) {
    console.error("dispatchDiagnostics error:", error);
    return internalError(res, error);
  }
};

/**
 * 🛠 ADMIN: GET ALL SERVICE-TO-ZONE MAPPINGS (TREE / TABLE MATRIX VIEW)
 * Hierarchy: Category -> Service -> District -> Zone -> Active/Inactive
 */
export const getServiceZoneMatrix = async (req, res) => {
  try {
    const { search, categoryId, districtId, zoneStatus, serviceStatus } = req.query;

    const serviceFilter = {};
    if (categoryId && categoryId !== "ALL") serviceFilter.categoryId = categoryId;
    if (serviceStatus === "ACTIVE") serviceFilter.isActive = true;
    if (serviceStatus === "INACTIVE") serviceFilter.isActive = false;

    if (search) {
      serviceFilter.serviceName = containsRegex(search);
    }

    const services = await Service.find(serviceFilter)
      .populate("categoryId", "category name categoryName")
      .sort({ categoryId: 1, serviceName: 1 })
      .lean();

    const districts = await OperationalCity.find().lean();
    const cityZones = await CityZone.find().lean();
    const availabilities = await ServiceAvailability.find().lean();
    const ZoneServiceMapping = (await import("../Schemas/ZoneServiceMapping.js")).default;
    const mappings = await ZoneServiceMapping.find({ active: true }).select("zoneId serviceId").lean();
    const mappedSet = new Set(mappings.map((m) => `${String(m.serviceId)}_${String(m.zoneId)}`));

    const availMap = new Map();
    availabilities.forEach((a) => {
      const key = `${a.serviceId}_${a.districtId}_${a.cityZoneId || a.cityId || "DISTRICT"}`;
      availMap.set(key, a.status);
    });

    const isZoneEffectivelyEnabled = (srv, distId, zone) => {
      const key = `${srv._id}_${distId}_${zone._id}`;
      const distKey = `${srv._id}_${distId}_DISTRICT`;
      // Explicit ServiceAvailability override wins first
      const override = availMap.get(key) || availMap.get(distKey);
      if (override) return override === "ENABLED";
      // No override → zoneRestricted services need an active mapping; others follow isActive + zone/district flags
      if (srv.zoneRestricted) return mappedSet.has(`${String(srv._id)}_${String(zone._id)}`);
      if (!srv.isActive || zone.active === false) return false;
      return true;
    };

    const result = services.map((srv) => {
      let activeZonesCount = 0;
      let inactiveZonesCount = 0;
      const districtSet = new Set();

      districts.forEach((d) => {
        const distId = String(d._id);
        if (districtId && districtId !== "ALL" && distId !== String(districtId)) {
          return;
        }

        const distZones = cityZones.filter((z) => {
          const zid = z.operationalCityId?._id ? String(z.operationalCityId._id) : String(z.operationalCityId);
          return zid === distId;
        });

        if (distZones.length > 0) {
          distZones.forEach((z) => {
            const enabled = isZoneEffectivelyEnabled(srv, distId, z);

            if (enabled) {
              activeZonesCount++;
              districtSet.add(distId);
            } else {
              inactiveZonesCount++;
            }
          });
        } else {
          // District-level fallback when no sub-zones exist for this district
          const distKey = `${srv._id}_${distId}_DISTRICT`;
          const stat = availMap.get(distKey) || (srv.isActive ? "ENABLED" : "DISABLED");
          if (stat === "ENABLED") {
            activeZonesCount++;
            districtSet.add(distId);
          } else {
            inactiveZonesCount++;
          }
        }
      });

      return {
        serviceId: srv._id,
        serviceName: srv.serviceName,
        categoryName: srv.categoryId?.category || srv.categoryId?.name || srv.categoryId?.categoryName || "Uncategorized",
        categoryId: srv.categoryId?._id || srv.categoryId,
        districtsCount: districtSet.size,
        activeZonesCount,
        inactiveZonesCount,
        isActive: srv.isActive,
        status: srv.isActive ? "ACTIVE" : "INACTIVE",
      };
    });

    let filteredResult = result;
    if (zoneStatus === "ACTIVE") {
      filteredResult = result.filter((item) => item.activeZonesCount > 0);
    } else if (zoneStatus === "INACTIVE") {
      filteredResult = result.filter((item) => item.activeZonesCount === 0 || item.inactiveZonesCount > 0);
    }

    return res.status(200).json({
      success: true,
      result: filteredResult,
      totalCount: filteredResult.length,
    });
  } catch (error) {
    console.error("getServiceZoneMatrix error:", error);
    return internalError(res, error);
  }
};

/**
 * 🛠 ADMIN: GET SERVICE ZONE DETAIL FOR MANAGE MODAL
 * Returns detailed district & sub-zone matrix for a specific service.
 */
export const getServiceZoneDetail = async (req, res) => {
  try {
    const { serviceId } = req.params;
    if (!isValidObjectId(serviceId)) {
      return res.status(400).json({ success: false, message: "Invalid serviceId", code: "INVALID_ID" });
    }

    const service = await Service.findById(serviceId)
      .populate("categoryId", "category name categoryName")
      .lean();

    if (!service) {
      return res.status(404).json({ success: false, message: "Service not found" });
    }

    const districts = await OperationalCity.find().sort({ name: 1 }).lean();
    const cityZones = await CityZone.find().sort({ name: 1 }).lean();
    const availabilities = await ServiceAvailability.find({ serviceId }).lean();
    const ZoneServiceMapping = (await import("../Schemas/ZoneServiceMapping.js")).default;
    const zoneMappings = await ZoneServiceMapping.find({ serviceId }).select("zoneId active").lean();
    const mappingByZone = new Map(zoneMappings.map((m) => [String(m.zoneId), m.active]));

    const availMap = new Map();
    availabilities.forEach((a) => {
      const key = `${a.districtId}_${a.cityZoneId || a.cityId || "DISTRICT"}`;
      availMap.set(key, a.status);
    });

    const districtDetails = districts.map((dist) => {
      const distKey = `${dist._id}_DISTRICT`;
      const isDistrictEnabled = availMap.get(distKey) !== "DISABLED";

      const zonesInDistrict = cityZones.filter((z) => {
        const zid = z.operationalCityId?._id ? String(z.operationalCityId._id) : String(z.operationalCityId);
        return zid === String(dist._id);
      });

      let activeZonesCount = 0;
      let inactiveZonesCount = 0;

      const formattedZones = zonesInDistrict.map((z) => {
        const zoneKey = `${dist._id}_${z._id}`;
        const override = availMap.get(zoneKey);
        // Effective status: explicit override wins; otherwise zoneRestricted
        // services follow the mapping, others follow district+zone active flags.
        let status;
        if (override) {
          status = override;
        } else if (service.zoneRestricted) {
          status = mappingByZone.get(String(z._id)) === true ? "ENABLED" : "DISABLED";
        } else {
          status = isDistrictEnabled && z.active ? "ENABLED" : "DISABLED";
        }

        if (status === "ENABLED") {
          activeZonesCount++;
        } else {
          inactiveZonesCount++;
        }

        return {
          zoneId: z._id,
          name: z.name,
          zoneCode: z.zoneCode,
          isDistrictActive: dist.active !== false && dist.isJobEnabled !== false,
          isZoneActive: z.active !== false,
          isMapped: mappingByZone.has(String(z._id)),
          isMappingActive: mappingByZone.get(String(z._id)) === true,
          status, // "ENABLED" or "DISABLED"
        };
      });

      if (zonesInDistrict.length === 0) {
        if (isDistrictEnabled && dist.active !== false && dist.isJobEnabled !== false) {
          activeZonesCount = 1;
          inactiveZonesCount = 0;
        } else {
          activeZonesCount = 0;
          inactiveZonesCount = 1;
        }
      }

      return {
        districtId: dist._id,
        name: dist.name,
        code: dist.code,
        active: dist.active,
        isJobEnabled: dist.isJobEnabled,
        isDistrictEnabled,
        activeZonesCount,
        inactiveZonesCount,
        zones: formattedZones,
      };
    });

    return res.status(200).json({
      success: true,
      service: {
        serviceId: service._id,
        serviceName: service.serviceName,
        categoryName: service.categoryId?.category || service.categoryId?.name || service.categoryId?.categoryName || "Uncategorized",
        isActive: service.isActive,
      },
      districts: districtDetails,
    });
  } catch (error) {
    console.error("getServiceZoneDetail error:", error);
    return internalError(res, error);
  }
};

/**
 * 🛠 ADMIN: TOGGLE SINGLE SUB-ZONE AVAILABILITY FOR SERVICE
 */
export const toggleZoneAvailability = async (req, res) => {
  try {
    const { serviceId, districtId, cityZoneId, status } = req.body;
    const adminId = req.user?.userId;

    if (!serviceId || !districtId) {
      return res.status(400).json({ success: false, message: "serviceId and districtId are required" });
    }
    if (!isValidObjectId(serviceId)) {
      return res.status(400).json({ success: false, message: "Invalid serviceId", code: "INVALID_ID" });
    }
    if (!isValidObjectId(districtId)) {
      return res.status(400).json({ success: false, message: "Invalid districtId", code: "INVALID_ID" });
    }
    if (cityZoneId && cityZoneId !== "DISTRICT" && !isValidObjectId(cityZoneId)) {
      return res.status(400).json({ success: false, message: "Invalid cityZoneId", code: "INVALID_ID" });
    }

    const finalStatus = status === "DISABLED" ? "DISABLED" : "ENABLED";
    const isDistrictScope = !cityZoneId || cityZoneId === "DISTRICT";

    const targetScope = isDistrictScope ? "DISTRICT" : "ZONE";
    const targetZoneId = isDistrictScope ? null : cityZoneId;

    const config = await ServiceAvailability.findOneAndUpdate(
      { serviceId, districtId, cityZoneId: targetZoneId, scope: targetScope },
      {
        $set: {
          serviceId,
          districtId,
          cityZoneId: targetZoneId,
          scope: targetScope,
          status: finalStatus,
          updatedBy: adminId || null,
        },
      },
      { upsert: true, new: true }
    );

    // Keep ZoneServiceMapping in sync for ZONE scope so both admin UIs
    // (zone-mappings + availability matrix) reflect the same state.
    if (!isDistrictScope) {
      try {
        const ZoneServiceMapping = (await import("../Schemas/ZoneServiceMapping.js")).default;
        await ZoneServiceMapping.updateOne(
          { zoneId: targetZoneId, serviceId },
          {
            $set: { active: finalStatus === "ENABLED" },
            $setOnInsert: { zoneId: targetZoneId, serviceId, approvedBy: adminId || null, approvedAt: new Date() },
          },
          { upsert: true }
        );
      } catch (e) {
        console.warn("ZoneServiceMapping sync warning:", e.message);
      }
    }

    await AuditLog.create({
      targetType: "ServiceAvailability",
      targetId: config._id,
      actor: adminId || null,
      actorRole: req.user?.role || "Admin",
      action: finalStatus === "ENABLED" ? "SERVICE_ZONE_ENABLED" : "SERVICE_ZONE_DISABLED",
      after: config.toObject(),
      reason: `Admin set ${targetScope} availability (zone: ${cityZoneId || "DISTRICT"}) for service ${serviceId} to ${finalStatus}`,
    }).catch((e) => console.warn("AuditLog error:", e.message));

    // B-12: DISABLED expires stale broadcasts; ENABLED backfills offers to
    // newly eligible technicians (bounded, idempotent — never duplicates).
    // Post-commit hooks: revalidation failure never fails the admin mutation.
    if (finalStatus === "DISABLED") {
      const { revalidateTechniciansForService } = await import("../Utils/technicianLocation.js");
      await revalidateTechniciansForService(serviceId, districtId, targetZoneId, req.io)
        .catch(err => console.error("Zone disable revalidation error:", err));
    } else {
      const { backfillBroadcastsForScope } = await import("../Utils/technicianLocation.js");
      await backfillBroadcastsForScope({ serviceId, districtId, cityZoneId: targetZoneId, io: req.io })
        .catch(err => console.error("Zone enable backfill error:", err));
    }

    return res.status(200).json({
      success: true,
      message: `${targetScope} availability set to ${finalStatus}`,
      result: config,
    });
  } catch (error) {
    console.error("toggleZoneAvailability error:", error);
    return internalError(res, error);
  }
};

/**
 * 🛠 ADMIN: BULK TOGGLE ZONES FOR SERVICE IN A DISTRICT
 */
export const bulkToggleZoneAvailability = async (req, res) => {
  try {
    const { serviceId, districtId, cityZoneIds, status } = req.body;
    const adminId = req.user?.userId;

    if (!serviceId || !districtId || !Array.isArray(cityZoneIds)) {
      return res.status(400).json({ success: false, message: "serviceId, districtId, and cityZoneIds array are required" });
    }
    if (!isValidObjectId(serviceId)) {
      return res.status(400).json({ success: false, message: "Invalid serviceId", code: "INVALID_ID" });
    }
    if (!isValidObjectId(districtId)) {
      return res.status(400).json({ success: false, message: "Invalid districtId", code: "INVALID_ID" });
    }
    const malformedBulk = cityZoneIds.filter((z) => z && z !== "DISTRICT" && !isValidObjectId(z));
    if (malformedBulk.length) {
      return res.status(400).json({ success: false, message: "One or more zone IDs are invalid", code: "INVALID_ID" });
    }

    const finalStatus = status === "DISABLED" ? "DISABLED" : "ENABLED";

    const operations = cityZoneIds.map((zoneId) => {
      const isDistrictScope = !zoneId || zoneId === "DISTRICT";
      const targetScope = isDistrictScope ? "DISTRICT" : "ZONE";
      const targetZoneId = isDistrictScope ? null : zoneId;

      return {
        updateOne: {
          filter: { serviceId, districtId, cityZoneId: targetZoneId, scope: targetScope },
          update: {
            $set: {
              serviceId,
              districtId,
              cityZoneId: targetZoneId,
              scope: targetScope,
              status: finalStatus,
              updatedBy: adminId || null,
            },
          },
          upsert: true,
        },
      };
    });

    if (operations.length > 0) {
      await ServiceAvailability.bulkWrite(operations);
    }

    // Sync ZoneServiceMapping rows for zone-scope entries
    try {
      const ZoneServiceMapping = (await import("../Schemas/ZoneServiceMapping.js")).default;
      const zoneIds = cityZoneIds.filter((z) => z && z !== "DISTRICT" && mongoose.Types.ObjectId.isValid(z));
      if (zoneIds.length) {
        const mapOps = zoneIds.map((zoneId) => ({
          updateOne: {
            filter: { zoneId, serviceId },
            update: {
              $set: { active: finalStatus === "ENABLED" },
              $setOnInsert: { zoneId, serviceId, approvedBy: adminId || null, approvedAt: new Date() },
            },
            upsert: true,
          },
        }));
        await ZoneServiceMapping.bulkWrite(mapOps, { ordered: false });
      }
    } catch (e) {
      console.warn("Bulk ZoneServiceMapping sync warning:", e.message);
    }

    await AuditLog.create({
      targetType: "ServiceAvailability",
      targetId: serviceId,
      actor: adminId || null,
      actorRole: req.user?.role || "Admin",
      action: "SERVICE_ZONE_BULK_UPDATE",
      reason: `Admin bulk updated ${cityZoneIds.length} zones for service ${serviceId} to ${finalStatus}`,
    }).catch((e) => console.warn("AuditLog error:", e.message));

    // B-12: DISABLED expires stale broadcasts per zone; ENABLED backfills.
    if (finalStatus === "DISABLED") {
      const { revalidateTechniciansForService } = await import("../Utils/technicianLocation.js");
      for (const zoneId of cityZoneIds) {
        await revalidateTechniciansForService(serviceId, districtId, zoneId, req.io)
          .catch(err => console.error("Bulk zone disable revalidation error:", err));
      }
    } else {
      const { backfillBroadcastsForScope } = await import("../Utils/technicianLocation.js");
      await backfillBroadcastsForScope({ serviceId, districtId, io: req.io })
        .catch(err => console.error("Bulk zone enable backfill error:", err));
    }

    return res.status(200).json({
      success: true,
      message: `${cityZoneIds.length} zones updated to ${finalStatus}`,
    });
  } catch (error) {
    console.error("bulkToggleZoneAvailability error:", error);
    return internalError(res, error);
  }
};

/**
 * 🛠 ADMIN: CLEAR ALL ZONES FOR SERVICE IN A DISTRICT
 */
export const clearDistrictZoneAvailability = async (req, res) => {
  try {
    const { serviceId, districtId } = req.body;
    const adminId = req.user?.userId;

    if (!serviceId || !districtId) {
      return res.status(400).json({ success: false, message: "serviceId and districtId are required" });
    }
    if (!isValidObjectId(serviceId)) {
      return res.status(400).json({ success: false, message: "Invalid serviceId", code: "INVALID_ID" });
    }
    if (!isValidObjectId(districtId)) {
      return res.status(400).json({ success: false, message: "Invalid districtId", code: "INVALID_ID" });
    }

    await ServiceAvailability.updateMany(
      { serviceId, districtId },
      {
        $set: {
          status: "DISABLED",
          updatedBy: adminId || null,
        },
      }
    );

    await AuditLog.create({
      targetType: "ServiceAvailability",
      targetId: serviceId,
      actor: adminId || null,
      actorRole: req.user?.role || "Admin",
      action: "SERVICE_ZONE_CLEARED",
      reason: `Admin cleared all zone availability for service ${serviceId} in district ${districtId}`,
    }).catch((e) => console.warn("AuditLog error:", e.message));

    // B-12: clearing is a district-wide disable — expire stale broadcasts.
    const { revalidateTechniciansForService: revalidateAfterClear } = await import("../Utils/technicianLocation.js");
    await revalidateAfterClear(serviceId, districtId, null, req.io)
      .catch((e) => console.error("Clear revalidation error:", e.message));

    return res.status(200).json({
      success: true,
      message: `Cleared all zones in district for service`,
    });
  } catch (error) {
    console.error("clearDistrictZoneAvailability error:", error);
    return internalError(res, error);
  }
};

/**
 * 🛠 ADMIN: TOGGLE GLOBAL SERVICE ACTIVE STATUS
 */
export const toggleServiceStatus = async (req, res) => {
  try {
    const { serviceId, isActive } = req.body;
    const adminId = req.user?.userId;

    if (!serviceId || typeof isActive !== "boolean") {
      return res.status(400).json({ success: false, message: "serviceId and boolean isActive are required" });
    }
    if (!isValidObjectId(serviceId)) {
      return res.status(400).json({ success: false, message: "Invalid serviceId", code: "INVALID_ID" });
    }

    const service = await Service.findByIdAndUpdate(
      serviceId,
      { $set: { isActive } },
      { new: true }
    );

    if (!service) {
      return res.status(404).json({ success: false, message: "Service not found" });
    }

    await AuditLog.create({
      adminId: adminId || null,
      action: isActive ? "SERVICE_ACTIVATED" : "SERVICE_DEACTIVATED",
      entityType: "Service",
      entityId: serviceId,
      reason: `Admin toggled service ${service.serviceName} status to ${isActive ? "ACTIVE" : "INACTIVE"}`,
    }).catch(() => {});

    // B-12: global kill-switch changes revalidate without GPS movement.
    // DISABLED expires stale broadcasts service-wide; ENABLED backfills.
    if (isActive) {
      const { backfillBroadcastsForScope } = await import("../Utils/technicianLocation.js");
      await backfillBroadcastsForScope({ serviceId, io: req.io })
        .catch((e) => console.error("Service activate backfill error:", e.message));
    } else {
      const { revalidateTechniciansForService: revalidateAfterToggle } = await import("../Utils/technicianLocation.js");
      await revalidateAfterToggle(serviceId, null, null, req.io)
        .catch((e) => console.error("Service deactivate revalidation error:", e.message));
    }

    return res.status(200).json({
      success: true,
      message: `Service status updated to ${isActive ? "ACTIVE" : "INACTIVE"}`,
      result: service,
    });
  } catch (error) {
    console.error("toggleServiceStatus error:", error);
    return internalError(res, error);
  }
};
