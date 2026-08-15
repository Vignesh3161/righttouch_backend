import mongoose from "mongoose";
import CityZone from "../Schemas/CityZone.js";
import ZoneServiceMapping from "../Schemas/ZoneServiceMapping.js";
import Service from "../Schemas/Service.js";
import { resolveZoneFromCoordinates } from "../Utils/resolveZoneFromCoordinates.js";

/* =====================================================
   RESOLVE ZONE FROM CUSTOMER LOCATION
   ===================================================== */
export const resolveCustomerZone = async (req, res) => {
  try {
    const { latitude, longitude } = req.body;
    const lat = Number(latitude);
    const lng = Number(longitude);

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({
        success: false,
        message: "Valid latitude and longitude are required",
        result: {},
      });
    }

    const { zone, error } = await resolveZoneFromCoordinates(lat, lng);

    if (error) {
      return res.status(400).json({ success: false, message: error, result: {} });
    }

    if (!zone) {
      return res.status(200).json({
        success: true,
        message: "No service zone found for this location",
        result: { zone: null, availableServices: [] },
      });
    }

    // Get available services in this zone
    const mappings = await ZoneServiceMapping.find({
      zoneId: zone._id,
      active: true,
    })
      .populate({
        path: "serviceId",
        select: "serviceName serviceType serviceCost duration coveragePolygon isActive",
      })
      .lean();

    const availableServices = mappings
      .filter((m) => m.serviceId && m.serviceId.isActive !== false)
      .map((m) => m.serviceId);

    return res.status(200).json({
      success: true,
      message: "Zone resolved",
      result: {
        zone: {
          _id: zone._id,
          name: zone.name,
          zoneCode: zone.zoneCode,
          operationalCityId: zone.operationalCityId,
        },
        availableServices,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

/* =====================================================
   CHECK SERVICE AVAILABILITY IN ZONE
   ===================================================== */
export const checkServiceAvailability = async (req, res) => {
  try {
    const { latitude, longitude, serviceId } = req.body;

    if (!serviceId || !mongoose.Types.ObjectId.isValid(serviceId)) {
      return res.status(400).json({ success: false, message: "Valid serviceId is required", result: {} });
    }

    const lat = Number(latitude);
    const lng = Number(longitude);

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({
        success: false,
        message: "Valid latitude and longitude are required",
        result: {},
      });
    }

    const { zone } = await resolveZoneFromCoordinates(lat, lng);

    if (!zone) {
      return res.status(200).json({
        success: true,
        result: {
          available: false,
          reason: "location_outside_service_area",
          message: "This service is not available in your location",
        },
      });
    }

    // Check if the service is approved in this zone
    const mapping = await ZoneServiceMapping.findOne({
      zoneId: zone._id,
      serviceId,
      active: true,
    }).lean();

    if (!mapping) {
      return res.status(200).json({
        success: true,
        result: {
          available: false,
          reason: "service_not_in_zone",
          message: "This service is not available in your zone",
          zone: { _id: zone._id, name: zone.name },
        },
      });
    }

    return res.status(200).json({
      success: true,
      result: {
        available: true,
        zone: { _id: zone._id, name: zone.name, zoneCode: zone.zoneCode },
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

/* =====================================================
   GET ZONE INFO FOR TECHNICIAN (from token)
   ===================================================== */
export const getMyZone = async (req, res) => {
  try {
    const technicianProfileId = req.user?.technicianProfileId;
    if (!technicianProfileId) {
      return res.status(401).json({ success: false, message: "Unauthorized", result: {} });
    }

    const TechnicianProfile = mongoose.model("TechnicianProfile");
    const profile = await TechnicianProfile.findById(technicianProfileId)
      .select("cityZoneId zoneMismatch zoneMismatchSince location")
      .lean();

    if (!profile) {
      return res.status(404).json({ success: false, message: "Technician profile not found", result: {} });
    }

    if (!profile.cityZoneId) {
      return res.status(200).json({
        success: true,
        result: {
          zone: null,
          mismatch: false,
          message: "No zone assigned. Please update your location to register for a zone.",
        },
      });
    }

    const zone = await CityZone.findById(profile.cityZoneId)
      .populate("operationalCityId", "name")
      .lean();

    return res.status(200).json({
      success: true,
      result: {
        zone: zone
          ? { _id: zone._id, name: zone.name, zoneCode: zone.zoneCode, operationalCity: zone.operationalCityId }
          : null,
        mismatch: profile.zoneMismatch,
        mismatchSince: profile.zoneMismatchSince,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

/* =====================================================
   GET SERVICES AVAILABLE IN MY ZONE (technician)
   ===================================================== */
export const getServicesInMyZone = async (req, res) => {
  try {
    const technicianProfileId = req.user?.technicianProfileId;
    if (!technicianProfileId) {
      return res.status(401).json({ success: false, message: "Unauthorized", result: {} });
    }

    const TechnicianProfile = mongoose.model("TechnicianProfile");
    const profile = await TechnicianProfile.findById(technicianProfileId)
      .select("cityZoneId")
      .lean();

    if (!profile?.cityZoneId) {
      return res.status(200).json({
        success: true,
        result: [],
        message: "No zone assigned",
      });
    }

    const mappings = await ZoneServiceMapping.find({
      zoneId: profile.cityZoneId,
      active: true,
    })
      .populate({
        path: "serviceId",
        select: "serviceName serviceType serviceCost duration",
      })
      .lean();

    const services = mappings
      .filter((m) => m.serviceId)
      .map((m) => m.serviceId);

    return res.status(200).json({
      success: true,
      result: services,
      meta: { count: services.length },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};
