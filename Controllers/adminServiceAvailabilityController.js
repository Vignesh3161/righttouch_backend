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

    // Check for conflicting configuration
    const existing = await ServiceAvailability.findOne({
      serviceId,
      districtId,
      cityId: finalCityId,
      scope: finalScope,
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

    return res.status(201).json({
      success: true,
      message: `Service availability created (${finalScope} - ${config.status})`,
      result: config,
    });
  } catch (error) {
    console.error("createServiceAvailability error:", error);
    return res.status(500).json({ success: false, message: error.message });
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
      if (scope === "DISTRICT") existing.cityId = null;
    }
    if (cityId !== undefined) {
      existing.cityId = existing.scope === "CITY" ? cityId : null;
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

    return res.status(200).json({
      success: true,
      message: "Service availability updated successfully",
      result: existing,
    });
  } catch (error) {
    console.error("updateServiceAvailability error:", error);
    return res.status(500).json({ success: false, message: error.message });
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
    if (serviceId) filter.serviceId = serviceId;
    if (districtId) filter.districtId = districtId;
    if (cityId) filter.cityId = cityId;
    if (scope && scope !== "ALL") filter.scope = scope;
    if (status && status !== "ALL") filter.status = status;

    if (search) {
      const searchRegex = new RegExp(search.trim(), "i");
      filter.$or = [
        { cityName: searchRegex },
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
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * 🛠 ADMIN: DELETE SERVICE AVAILABILITY
 */
export const deleteServiceAvailability = async (req, res) => {
  try {
    const { id } = req.params;
    const adminId = req.user?.userId;

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

    return res.status(200).json({
      success: true,
      message: "Service availability configuration deleted successfully",
    });
  } catch (error) {
    console.error("deleteServiceAvailability error:", error);
    return res.status(500).json({ success: false, message: error.message });
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

    const eligibility = await checkTechnicianEligibility({
      technician: tech,
      serviceId: serviceId || booking?.serviceId,
      jobLatitude: latitude || booking?.location?.coordinates?.[1] || booking?.addressSnapshot?.latitude,
      jobLongitude: longitude || booking?.location?.coordinates?.[0] || booking?.addressSnapshot?.longitude,
      jobDistrictId: districtId || booking?.districtId,
      jobCityId: cityId || booking?.cityZoneId,
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
    return res.status(500).json({ success: false, message: error.message });
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
      serviceFilter.serviceName = new RegExp(search.trim(), "i");
    }

    const services = await Service.find(serviceFilter)
      .populate("categoryId", "category name categoryName")
      .sort({ categoryId: 1, serviceName: 1 })
      .lean();

    const districts = await OperationalCity.find().lean();
    const cityZones = await CityZone.find().lean();
    const availabilities = await ServiceAvailability.find().lean();

    const availMap = new Map();
    availabilities.forEach((a) => {
      const key = `${a.serviceId}_${a.districtId}_${a.cityZoneId || a.cityId || "DISTRICT"}`;
      availMap.set(key, a.status);
    });

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
            const key = `${srv._id}_${distId}_${z._id}`;
            const distKey = `${srv._id}_${distId}_DISTRICT`;
            const zoneStat = availMap.get(key) || availMap.get(distKey) || (srv.isActive ? "ENABLED" : "DISABLED");

            if (zoneStat === "ENABLED") {
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
    return res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * 🛠 ADMIN: GET SERVICE ZONE DETAIL FOR MANAGE MODAL
 * Returns detailed district & sub-zone matrix for a specific service.
 */
export const getServiceZoneDetail = async (req, res) => {
  try {
    const { serviceId } = req.params;

    const service = await Service.findById(serviceId)
      .populate("categoryId", "category name categoryName")
      .lean();

    if (!service) {
      return res.status(404).json({ success: false, message: "Service not found" });
    }

    const districts = await OperationalCity.find().sort({ name: 1 }).lean();
    const cityZones = await CityZone.find().sort({ name: 1 }).lean();
    const availabilities = await ServiceAvailability.find({ serviceId }).lean();

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
        const status = availMap.get(zoneKey) || (isDistrictEnabled && z.active ? "ENABLED" : "DISABLED");

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
    return res.status(500).json({ success: false, message: error.message });
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

    const finalStatus = status === "DISABLED" ? "DISABLED" : "ENABLED";
    const isDistrictScope = !cityZoneId || cityZoneId === "DISTRICT" || !mongoose.Types.ObjectId.isValid(cityZoneId);

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

    await AuditLog.create({
      targetType: "ServiceAvailability",
      targetId: config._id,
      actor: adminId || null,
      actorRole: req.user?.role || "Admin",
      action: finalStatus === "ENABLED" ? "SERVICE_ZONE_ENABLED" : "SERVICE_ZONE_DISABLED",
      after: config.toObject(),
      reason: `Admin set ${targetScope} availability (zone: ${cityZoneId || "DISTRICT"}) for service ${serviceId} to ${finalStatus}`,
    }).catch((e) => console.warn("AuditLog error:", e.message));

    return res.status(200).json({
      success: true,
      message: `${targetScope} availability set to ${finalStatus}`,
      result: config,
    });
  } catch (error) {
    console.error("toggleZoneAvailability error:", error);
    return res.status(500).json({ success: false, message: error.message });
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

    const finalStatus = status === "DISABLED" ? "DISABLED" : "ENABLED";

    const operations = cityZoneIds.map((zoneId) => {
      const isDistrictScope = !zoneId || zoneId === "DISTRICT" || !mongoose.Types.ObjectId.isValid(zoneId);
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

    await AuditLog.create({
      targetType: "ServiceAvailability",
      targetId: serviceId,
      actor: adminId || null,
      actorRole: req.user?.role || "Admin",
      action: "SERVICE_ZONE_BULK_UPDATE",
      reason: `Admin bulk updated ${cityZoneIds.length} zones for service ${serviceId} to ${finalStatus}`,
    }).catch((e) => console.warn("AuditLog error:", e.message));

    return res.status(200).json({
      success: true,
      message: `${cityZoneIds.length} zones updated to ${finalStatus}`,
    });
  } catch (error) {
    console.error("bulkToggleZoneAvailability error:", error);
    return res.status(500).json({ success: false, message: error.message });
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

    return res.status(200).json({
      success: true,
      message: `Cleared all zones in district for service`,
    });
  } catch (error) {
    console.error("clearDistrictZoneAvailability error:", error);
    return res.status(500).json({ success: false, message: error.message });
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

    return res.status(200).json({
      success: true,
      message: `Service status updated to ${isActive ? "ACTIVE" : "INACTIVE"}`,
      result: service,
    });
  } catch (error) {
    console.error("toggleServiceStatus error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};
