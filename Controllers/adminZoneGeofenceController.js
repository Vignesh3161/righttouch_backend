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
import { validateAndSanitizePolygon, isPointInPolygonRing } from "../Utils/geoValidation.js";
import { checkTechnicianEligibility } from "../Services/technicianEligibilityService.js";
import { resolveServiceAvailability } from "../Services/serviceAvailabilityService.js";
import { haversineMeters } from "../Utils/feasibility.js";

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

    const district = await OperationalCity.create({
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
    });

    // P — Save Polygon Version 1
    await PolygonVersion.create({
      entityType: "DISTRICT",
      entityId: district._id,
      version: 1,
      polygon: validation.sanitizedPolygon,
      changedBy: req.user._id,
      changeReason: "Initial District Creation",
    });

    return res.status(201).json({
      success: true,
      message: "Operational District created successfully",
      result: district,
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const updateDistrict = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, state, code, polygon, status, statusReason, reason } = req.body;

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

    if (versionIncremented) {
      district.version = (district.version || 1) + 1;
      district.polygon = updatedPolygon;

      // P — Save Polygon Version
      await PolygonVersion.create({
        entityType: "DISTRICT",
        entityId: district._id,
        version: district.version,
        polygon: updatedPolygon,
        changedBy: req.user._id,
        changeReason: reason || "District Boundary Update",
      });
    }

    await district.save();

    return res.status(200).json({
      success: true,
      message: "District updated successfully",
      result: district,
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const listDistricts = async (req, res) => {
  try {
    const { search, status, page = 1, limit = 20 } = req.query;
    const query = {};

    if (search) {
      query.$or = [
        { name: { $regex: search, $options: "i" } },
        { code: { $regex: search, $options: "i" } },
        { state: { $regex: search, $options: "i" } },
      ];
    }

    if (status) query.status = status;

    const skip = (Number(page) - 1) * Number(limit);
    const [districts, total] = await Promise.all([
      OperationalCity.find(query).sort({ name: 1 }).skip(skip).limit(Number(limit)).lean(),
      OperationalCity.countDocuments(query),
    ]);

    return res.status(200).json({
      success: true,
      result: districts,
      pagination: { total, page: Number(page), limit: Number(limit), pages: Math.ceil(total / Number(limit)) },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

/* =========================================================================
   C: CITY ZONE MANAGEMENT
   ========================================================================= */

export const createCityZone = async (req, res) => {
  try {
    const { operationalCityId, zoneName, state, polygon } = req.body;

    if (!operationalCityId || !zoneName || !polygon) {
      return res.status(400).json({ success: false, message: "operationalCityId, zoneName, and polygon are required." });
    }

    const parentDistrict = await OperationalCity.findById(operationalCityId);
    if (!parentDistrict) return res.status(404).json({ success: false, message: "Parent Operational District not found." });

    const validation = validateAndSanitizePolygon(polygon);
    if (!validation.valid) {
      return res.status(400).json({ success: false, message: "Invalid GeoJSON Polygon", errors: validation.errors });
    }

    const zone = await CityZone.create({
      operationalCityId,
      zoneName,
      state: state || parentDistrict.state,
      polygon: validation.sanitizedPolygon,
      active: true,
      createdBy: req.user._id,
      updatedBy: req.user._id,
    });

    await PolygonVersion.create({
      entityType: "CITY_ZONE",
      entityId: zone._id,
      version: 1,
      polygon: validation.sanitizedPolygon,
      changedBy: req.user._id,
      changeReason: "Initial CityZone Creation",
    });

    return res.status(201).json({ success: true, message: "CityZone created successfully", result: zone });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const listCityZones = async (req, res) => {
  try {
    const { districtId, search } = req.query;
    const query = {};
    if (districtId) query.operationalCityId = districtId;
    if (search) query.zoneName = { $regex: search, $options: "i" };

    const zones = await CityZone.find(query).populate("operationalCityId", "name code state").sort({ zoneName: 1 }).lean();
    return res.status(200).json({ success: true, result: zones });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

/* =========================================================================
   D & T: TECHNICIAN DISTRICT PERMISSION MANAGEMENT (STRICTLY DISTRICT ONLY)
   ========================================================================= */

export const grantDistrictPermission = async (req, res) => {
  try {
    const { technicianId, districtId, reason } = req.body;

    if (!technicianId || !districtId || !reason) {
      return res.status(400).json({ success: false, message: "technicianId, districtId, and reason are required." });
    }

    const [tech, district] = await Promise.all([
      TechnicianProfile.findById(technicianId),
      OperationalCity.findById(districtId),
    ]);

    if (!tech) return res.status(404).json({ success: false, message: "Technician not found" });
    if (!district) return res.status(404).json({ success: false, message: "District not found" });

    // Set primary district if none present
    if (!tech.primaryDistrictId) {
      tech.primaryDistrictId = districtId;
    }

    // Add to enabled districts
    const enabledStr = (tech.enabledDistrictIds || []).map((id) => id.toString());
    if (!enabledStr.includes(String(districtId))) {
      tech.enabledDistrictIds.push(districtId);
    }

    await tech.save();

    // Log Permission Audit
    await DistrictPermissionHistory.create({
      technicianId,
      districtId,
      action: "GRANT",
      adminId: req.user._id,
      reason,
    });

    return res.status(200).json({
      success: true,
      message: `District permission granted for ${district.name}`,
      result: {
        primaryDistrictId: tech.primaryDistrictId,
        enabledDistrictIds: tech.enabledDistrictIds,
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const revokeDistrictPermission = async (req, res) => {
  try {
    const { technicianId, districtId, reason } = req.body;

    if (!technicianId || !districtId || !reason) {
      return res.status(400).json({ success: false, message: "technicianId, districtId, and reason are required." });
    }

    const tech = await TechnicianProfile.findById(technicianId);
    if (!tech) return res.status(404).json({ success: false, message: "Technician not found" });

    // Remove from enabled districts
    tech.enabledDistrictIds = (tech.enabledDistrictIds || []).filter(
      (id) => id.toString() !== String(districtId)
    );

    // If primary district revoked, re-assign primary to first remaining enabled district or null
    if (String(tech.primaryDistrictId) === String(districtId)) {
      tech.primaryDistrictId = tech.enabledDistrictIds[0] || null;
    }

    await tech.save();

    await DistrictPermissionHistory.create({
      technicianId,
      districtId,
      action: "REVOKE",
      adminId: req.user._id,
      reason,
    });

    return res.status(200).json({
      success: true,
      message: "District permission revoked successfully",
      result: {
        primaryDistrictId: tech.primaryDistrictId,
        enabledDistrictIds: tech.enabledDistrictIds,
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

/* =========================================================================
   E: IMPACT ANALYSIS & ADMIN TOGGLE
   ========================================================================= */

export const getImpactAnalysis = async (req, res) => {
  try {
    const { type, id } = req.query;
    if (!type || !id) return res.status(400).json({ success: false, message: "type and id are required" });

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
    return res.status(500).json({ success: false, message: error.message });
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
          zoneName: z.zoneName,
          active: z.active,
        })),
    }));

    return res.status(200).json({ success: true, result: tree });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const getDistrictDashboardDetails = async (req, res) => {
  try {
    const { id } = req.params;
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
    return res.status(500).json({ success: false, message: error.message });
  }
};

/* =========================================================================
   J & K & L & U: JOB / TECHNICIAN LOCATION INSPECTION & DIAGNOSTICS
   ========================================================================= */

export const inspectJobLocation = async (req, res) => {
  try {
    const { bookingId } = req.params;
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
    return res.status(500).json({ success: false, message: error.message });
  }
};

/* =========================================================================
   P & Q & Z: POLYGON ROLLBACK, MULTI-ENTITY SEARCH & ZONE HEALTH DASHBOARD
   ========================================================================= */

export const rollbackPolygonVersion = async (req, res) => {
  try {
    const { entityType, entityId, targetVersion } = req.body;

    const versionDoc = await PolygonVersion.findOne({
      entityType,
      entityId,
      version: targetVersion,
    });

    if (!versionDoc) {
      return res.status(404).json({ success: false, message: `Polygon version ${targetVersion} not found.` });
    }

    if (entityType === "DISTRICT") {
      await OperationalCity.updateOne(
        { _id: entityId },
        { $set: { polygon: versionDoc.polygon, version: targetVersion, updatedBy: req.user._id } }
      );
    } else if (entityType === "CITY_ZONE") {
      await CityZone.updateOne(
        { _id: entityId },
        { $set: { polygon: versionDoc.polygon, updatedBy: req.user._id } }
      );
    }

    return res.status(200).json({
      success: true,
      message: `Successfully rolled back ${entityType} polygon to version ${targetVersion}`,
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
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
    return res.status(500).json({ success: false, message: error.message });
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
      targetBooking = await ServiceBooking.findById(bookingId).lean();
      if (targetBooking?.location?.coordinates) {
        targetJobLng = targetBooking.location.coordinates[0];
        targetJobLat = targetBooking.location.coordinates[1];
      }
    }

    const techQuery = {};

    if (districtId) {
      techQuery.$or = [{ primaryDistrictId: districtId }, { enabledDistrictIds: districtId }];
    }

    if (accountStatus && accountStatus !== "All") {
      techQuery.workStatus = accountStatus.toLowerCase();
    }

    if (verificationStatus && verificationStatus !== "All") {
      if (verificationStatus.toLowerCase() === "verified") techQuery.workStatus = "approved";
      else if (verificationStatus.toLowerCase() === "pending") techQuery.workStatus = "submitted";
      else if (verificationStatus.toLowerCase() === "rejected") techQuery.workStatus = "rejected";
    }

    if (onlineStatus && onlineStatus !== "All") {
      techQuery["availability.isOnline"] = onlineStatus.toLowerCase() === "online";
    }

    if (serviceId) {
      techQuery["skills.serviceId"] = serviceId;
    }

    const technicians = await TechnicianProfile.find(techQuery)
      .populate("userId", "fname lname email mobileNumber status")
      .populate("primaryDistrictId", "name code")
      .populate("enabledDistrictIds", "name code")
      .lean();

    const now = Date.now();
    const formattedList = [];

    for (const tech of technicians) {
      const name = `${tech.userId?.fname || ""} ${tech.userId?.lname || ""}`.trim() || "Technician";
      const techIdStr = tech.technicianId || String(tech._id).slice(-6).toUpperCase();
      const mobile = tech.userId?.mobileNumber || "";
      const email = tech.userId?.email || "";

      // 🔍 Search text matching across name, ID, phone, email
      if (search) {
        const q = search.toLowerCase();
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

      const isGpsFresh = ageSeconds <= 90;

      // Filter by GPS Status if specified
      if (gpsStatus && gpsStatus !== "All") {
        if (gpsStatus === "GPS Fresh" && !isGpsFresh) continue;
        if (gpsStatus === "GPS Stale" && isGpsFresh) continue;
        if (gpsStatus === "GPS Missing" && tech.location?.coordinates) continue;
      }

      // Filter by GPS Freshness range if specified
      if (gpsFreshness) {
        if (gpsFreshness === "< 30 sec" && ageSeconds >= 30) continue;
        if (gpsFreshness === "> 90 sec" && ageSeconds <= 90) continue;
      }

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

      formattedList.push({
        _id: tech._id,
        technicianId: techIdStr,
        name,
        mobile,
        email,
        district: tech.primaryDistrictId?.name || "Unassigned",
        primaryDistrictId: tech.primaryDistrictId,
        enabledDistricts: (tech.enabledDistrictIds || []).map((d) => d.name),
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

    const skip = (Number(page) - 1) * Number(limit);
    const paginatedResult = formattedList.slice(skip, skip + Number(limit));

    return res.status(200).json({
      success: true,
      result: paginatedResult,
      pagination: {
        total: formattedList.length,
        page: Number(page),
        limit: Number(limit),
        pages: Math.ceil(formattedList.length / Number(limit)),
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const getAdminTechnicianDetails = async (req, res) => {
  try {
    const { id } = req.params;

    const [tech, permHistory] = await Promise.all([
      TechnicianProfile.findById(id)
        .populate("userId", "fname lname email mobileNumber status createdAt")
        .populate("primaryDistrictId", "name code state")
        .populate("enabledDistrictIds", "name code state")
        .populate("skills.serviceId", "serviceName serviceType")
        .lean(),
      DistrictPermissionHistory.find({ technicianId: id })
        .populate("districtId", "name code")
        .populate("adminId", "fname lname email")
        .sort({ createdAt: -1 })
        .lean(),
    ]);

    if (!tech) return res.status(404).json({ success: false, message: "Technician not found" });

    const lastUpdate = tech.locationUpdatedAt ? new Date(tech.locationUpdatedAt).getTime() : 0;
    const ageSeconds = lastUpdate > 0 ? Math.floor((Date.now() - lastUpdate) / 1000) : 9999;

    return res.status(200).json({
      success: true,
      result: {
        profile: {
          technicianId: tech._id,
          name: `${tech.userId?.fname || ""} ${tech.userId?.lname || ""}`.trim(),
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
          primaryDistrict: tech.primaryDistrictId,
          enabledDistricts: tech.enabledDistrictIds,
          permissionHistory: permHistory,
        },
        skills: tech.skills || [],
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const updateTechnicianVerification = async (req, res) => {
  try {
    const { id } = req.params;
    const { action, reason } = req.body; // action: "APPROVE", "REJECT", "SUSPEND", "REACTIVATE"

    const tech = await TechnicianProfile.findById(id);
    if (!tech) return res.status(404).json({ success: false, message: "Technician profile not found" });

    if (action === "APPROVE") tech.workStatus = "approved";
    else if (action === "REJECT") tech.workStatus = "rejected";
    else if (action === "SUSPEND") tech.workStatus = "suspended";
    else if (action === "REACTIVATE") tech.workStatus = "approved";
    else return res.status(400).json({ success: false, message: "Invalid action. Allowed: APPROVE, REJECT, SUSPEND, REACTIVATE" });

    await tech.save();

    return res.status(200).json({
      success: true,
      message: `Technician status updated to ${tech.workStatus}`,
      result: { workStatus: tech.workStatus, reason },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const getJobBroadcastAudit = async (req, res) => {
  try {
    const { bookingId } = req.params;
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
    return res.status(500).json({ success: false, message: error.message });
  }
};

