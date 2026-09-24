import mongoose from "mongoose";
import Service from "../Schemas/Service.js";
import Category from "../Schemas/Category.js";

const SERVICE_TYPES = ["Repair", "Installation", "Maintenance", "Inspection"];
const PRICING_TYPES = ["fixed", "after_inspection", "per_unit"];
const HIDE_FIELDS = ""; // Removed hiding fields
// const HIDE_FIELDS = "-duration -siteVisitRequired -serviceWarranty";

const toNumber = value => {
  const num = Number(value);
  return Number.isNaN(num) ? NaN : num;
};


// CREATE SERVICE (NO IMAGE)
export const createService = async (req, res) => {
  try {
    const {
      categoryId,
      serviceName,
      description,
      serviceType,
      pricingType,
      serviceCost,
      minimumVisitCharge, // Added
      commissionPercentage,
      serviceDiscountPercentage,
      whatIncluded,
      whatNotIncluded,
      serviceHighlights,
      cancellationPolicy,
      // New fields
      frequentlyAskedQuestions,
      supportedBrands,
      rectifyMethod,
      faultReasons,
      toolsEquipments,
      serviceChecklist,
      requiresSpareParts,
      duration,
      siteVisitRequired,
      serviceWarranty,
      isPopular,
      isRecommended
    } = req.body;

    if (!categoryId || !serviceName || !description || serviceCost === undefined) {
      return res.status(400).json({
        success: false,
        message: "Required fields are missing",
        result: {},
      });
    }

    if (!mongoose.Types.ObjectId.isValid(categoryId)) {
      return res.status(400).json({ success: false, message: "Invalid categoryId", result: {} });
    }

    const category = await Category.findById(categoryId);
    if (!category || category.categoryType !== "service") {
      return res.status(400).json({ success: false, message: "Category must exist and be of type service", result: {} });
    }

    const normalizedServiceType = serviceType || "Repair";
    if (!SERVICE_TYPES.includes(normalizedServiceType)) {
      return res.status(400).json({ success: false, message: "Invalid serviceType", result: {} });
    }

    const normalizedPricingType = pricingType || "fixed";
    if (!PRICING_TYPES.includes(normalizedPricingType)) {
      return res.status(400).json({ success: false, message: "Invalid pricingType", result: {} });
    }

    const serviceCostNum = toNumber(serviceCost);
    if (Number.isNaN(serviceCostNum) || serviceCostNum < 0) {
      return res.status(400).json({ success: false, message: "serviceCost must be a non-negative number", result: {} });
    }

    // Validate percentages
    const commPct = commissionPercentage !== undefined ? toNumber(commissionPercentage) : 0;
    const discPct = serviceDiscountPercentage !== undefined ? toNumber(serviceDiscountPercentage) : 0;
    const minVisitCharge = minimumVisitCharge !== undefined ? toNumber(minimumVisitCharge) : 0;

    if (Number.isNaN(commPct) || commPct < 0 || commPct > 50) {
      return res.status(400).json({ success: false, message: "commissionPercentage must be between 0 and 50", result: {} });
    }
    if (Number.isNaN(discPct) || discPct < 0 || discPct > 100) {
      return res.status(400).json({ success: false, message: "serviceDiscountPercentage must be between 0 and 100", result: {} });
    }
    if (Number.isNaN(minVisitCharge) || minVisitCharge < 0) {
      return res.status(400).json({ success: false, message: "minimumVisitCharge must be a non-negative number", result: {} });
    }

    const existing = await Service.findOne({
      serviceName: { $regex: `^${serviceName}$`, $options: "i" },
      categoryId,
    });

    if (existing) {
      return res.status(409).json({
        success: false,
        message: "Service already exists",
        result: {},
      });
    }

    const service = await Service.create({
      categoryId,
      serviceName,
      description,
      serviceType: normalizedServiceType,
      pricingType: normalizedPricingType,
      serviceCost: serviceCostNum,
      minimumVisitCharge: minVisitCharge, // Added
      commissionPercentage: commPct,
      serviceDiscountPercentage: discPct,
      whatIncluded,
      whatNotIncluded,
      serviceHighlights,
      cancellationPolicy,
      // New fields mapping
      frequentlyAskedQuestions,
      supportedBrands,
      rectifyMethod,
      faultReasons,
      toolsEquipments,
      serviceChecklist,
      requiresSpareParts,
      duration,
      siteVisitRequired,
      serviceWarranty,
      isPopular: isPopular || false,
      isRecommended: isRecommended || false
    });

    // Re-fetch with hidden fields and populated category for response
    const responseDoc = await Service.findById(service._id)

      .populate("categoryId", "category categoryType description");

    return res.status(201).json({
      success: true,
      message: "Service created successfully",
      result: responseDoc,
    });
  } catch (error) {
    if (res.headersSent) return;
    return res.status(500).json({
      success: false,
      message: "Server error",
      result: { error: error.message },
    });
  }
};

// UPLOAD SERVICE IMAGES (ADD)
export const uploadServiceImages = async (req, res) => {
  try {
    const { serviceId } = req.body;

    if (!serviceId) {
      return res.status(400).json({
        success: false,
        message: "Service ID is required",
        result: {},
      });
    }

    if (!mongoose.Types.ObjectId.isValid(serviceId)) {
      return res.status(400).json({ success: false, message: "Invalid serviceId", result: {} });
    }

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Service images are required",
        result: {},
      });
    }

    const service = await Service.findById(serviceId);
    if (!service) {
      return res.status(404).json({
        success: false,
        message: "Service not found",
        result: {},
      });
    }

    const images = req.files.map(file => file.path);
    service.serviceImages.push(...images);
    await service.save();

    // Re-fetch with hidden fields and populated category for response
    const responseDoc = await Service.findById(service._id)

      .populate("categoryId", "category categoryType description");

    return res.status(200).json({
      success: true,
      message: "Service images uploaded successfully",
      result: responseDoc,
    });
  } catch (error) {
    if (res.headersSent) return;
    return res.status(500).json({
      success: false,
      message: "Server error",
      result: { error: error.message },
    });
  }
};

// REMOVE SERVICE IMAGE
export const removeServiceImage = async (req, res) => {
  try {
    const { serviceId, imageUrl } = req.body;

    if (!serviceId || !imageUrl) {
      return res.status(400).json({
        success: false,
        message: "Service ID and image URL are required",
        result: {},
      });
    }

    if (!mongoose.Types.ObjectId.isValid(serviceId)) {
      return res.status(400).json({ success: false, message: "Invalid serviceId", result: {} });
    }

    const service = await Service.findById(serviceId);
    if (!service) {
      return res.status(404).json({
        success: false,
        message: "Service not found",
        result: {},
      });
    }

    const imageIndex = service.serviceImages.indexOf(imageUrl);
    if (imageIndex === -1) {
      return res.status(404).json({
        success: false,
        message: "Image not found in service",
        result: {},
      });
    }

    service.serviceImages.splice(imageIndex, 1);
    await service.save();

    const responseDoc = await Service.findById(service._id)

      .populate("categoryId", "category categoryType description");

    return res.status(200).json({
      success: true,
      message: "Service image removed successfully",
      result: responseDoc,
    });
  } catch (error) {
    if (res.headersSent) return;
    return res.status(500).json({
      success: false,
      message: "Server error",
      result: { error: error.message },
    });
  }
};

// REPLACE ALL SERVICE IMAGES
export const replaceServiceImages = async (req, res) => {
  try {
    const { serviceId } = req.body;

    if (!serviceId) {
      return res.status(400).json({
        success: false,
        message: "Service ID is required",
        result: {},
      });
    }

    if (!mongoose.Types.ObjectId.isValid(serviceId)) {
      return res.status(400).json({ success: false, message: "Invalid serviceId", result: {} });
    }

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Service images are required",
        result: {},
      });
    }

    const service = await Service.findById(serviceId);
    if (!service) {
      return res.status(404).json({
        success: false,
        message: "Service not found",
        result: {},
      });
    }

    const images = req.files.map(file => file.path);
    service.serviceImages = images;
    await service.save();

    const responseDoc = await Service.findById(service._id)

      .populate("categoryId", "category categoryType description");

    return res.status(200).json({
      success: true,
      message: "Service images replaced successfully",
      result: responseDoc,
    });
  } catch (error) {
    if (res.headersSent) return;
    return res.status(500).json({
      success: false,
      message: "Server error",
      result: { error: error.message },
    });
  }
};

export const getAllServices = async (req, res) => {
  try {
    const { search, categoryId, latitude, longitude, zoneId, districtId, cityId } = req.query;

    // Required architecture: NO customer API change.
    // Explicit query location (admin/testing/selected address) wins; otherwise
    // resolve the authenticated CUSTOMER's DEFAULT address server-side.
    // TECHNICIAN HAS NO DEFAULT ADDRESS (by design): technicians never resolve
    // Address({ customerId, isDefault }) — their location model is
    // registration (primaryDistrictId/cityZoneId) + live GPS
    // (currentDistrictId/currentCityZoneId/location) + Admin-approved
    // enabledCityZoneIds. Job eligibility is GPS + permissions, never a saved
    // default address. So the lookup below runs for Customer context only
    // (anonymous browse or Customer role); Technician/Admin/Owner with no
    // explicit location fall straight through to the full-catalog browse path.
    let effLat = latitude != null ? Number(latitude) : null;
    let effLng = longitude != null ? Number(longitude) : null;
    let knownZoneId = zoneId || cityId || null;
    let resolvedDistrictId = districtId || null;
    // Explicit caller-supplied location (selected address / map pin / admin filter).
    // Used to distinguish "explicit location that resolved to nothing → empty"
    // from "no location at all → browse full catalog".
    const hasExplicitLocation =
      latitude != null || longitude != null || Boolean(zoneId || cityId || districtId);
    let locationSource = "query";
    let defaultAddressId = null;

    if ((!Number.isFinite(effLat) || !Number.isFinite(effLng)) && !knownZoneId && !resolvedDistrictId) {
      // Customer-only: technicians have no default address — skip Address lookup.
      const callerRole = req.user?.role;
      const isCustomerContext = !callerRole || callerRole === "Customer";
      const customerUserId = isCustomerContext ? req.user?.userId : null;
      if (customerUserId && mongoose.Types.ObjectId.isValid(String(customerUserId))) {
        try {
          const { default: Address } = await import("../Schemas/Address.js");
          const defAddr =
            (await Address.findOne({ customerId: customerUserId, isDefault: true }).select("_id latitude longitude").lean()) ||
            null;
          if (defAddr && Number.isFinite(Number(defAddr.latitude)) && Number.isFinite(Number(defAddr.longitude))) {
            effLat = Number(defAddr.latitude);
            effLng = Number(defAddr.longitude);
            defaultAddressId = String(defAddr._id);
            locationSource = "default_address";
          } else {
            locationSource = "no_default_address";
          }
        } catch (e) {
          locationSource = "address_lookup_failed";
        }
      }
    }
    const hasCoords = Number.isFinite(effLat) && Number.isFinite(effLng);

    let query = { isActive: true };

    // Category filter
    if (categoryId) {
      if (!mongoose.Types.ObjectId.isValid(categoryId)) {
        return res.status(400).json({
          success: false,
          message: "Invalid categoryId",
          result: {},
        });
      }
      query.categoryId = categoryId;
    }

    // Search filter
    if (search) {
      query.$or = [
        { serviceName: { $regex: search, $options: "i" } },
        { description: { $regex: search, $options: "i" } },
      ];
    }

    // Required architecture: resolve zone/district from effective location
    // (explicit query OR customer default address), INCLUDING inactive zones
    // so a deactivated zone can BLOCK instead of falling back to district.
    if (knownZoneId && !mongoose.Types.ObjectId.isValid(String(knownZoneId))) {
      return res.status(400).json({ success: false, message: "Invalid zoneId", result: {} });
    }
    let zoneDocForGate = null;
    if (!knownZoneId && hasCoords) {
      const { resolveZoneFromCoordinates } = await import("../Utils/resolveZoneFromCoordinates.js");
      const { zone } = await resolveZoneFromCoordinates(effLat, effLng, { includeInactive: true });
      if (zone?._id) {
        knownZoneId = String(zone._id);
        zoneDocForGate = zone;
      }
    }
    if (knownZoneId && !zoneDocForGate) {
      const { default: CityZone } = await import("../Schemas/CityZone.js");
      zoneDocForGate = await CityZone.findById(knownZoneId).select("_id active operationalCityId").lean();
    }

    // Zone deactivation is STRICT: address inside inactive zone → no services.
    if (zoneDocForGate && zoneDocForGate.active === false) {
      return res.status(200).json({
        success: true,
        message: "Services are currently unavailable in this area",
        availabilityPrompt: null,
        locationContext: {
          source: locationSource,
          zoneId: String(zoneDocForGate._id),
          zoneActive: false,
          districtId: resolvedDistrictId || String(zoneDocForGate.operationalCityId || "") || null,
          defaultAddressId,
        },
        result: [],
      });
    }

    // INVALID ZONE: explicit zoneId that does not resolve to any zone → no services.
    if (knownZoneId && !zoneDocForGate) {
      return res.status(200).json({
        success: true,
        message: "Services are currently unavailable in this area",
        availabilityPrompt: null,
        locationContext: {
          source: locationSource,
          zoneId: String(knownZoneId),
          districtId: resolvedDistrictId || null,
          defaultAddressId,
        },
        result: [],
      });
    }

    if (!resolvedDistrictId) {
      if (zoneDocForGate?.operationalCityId) {
        resolvedDistrictId = String(zoneDocForGate.operationalCityId);
      } else if (hasCoords) {
        const { resolveOperationalCityFromCoordinates } = await import("../Utils/technicianMatching.js");
        const resolvedCity = await resolveOperationalCityFromCoordinates(effLat, effLng);
        if (resolvedCity?._id) resolvedDistrictId = String(resolvedCity._id);
      }
    }

    // PRE-ADDRESS CATALOG RULE:
    // No location context (no explicit query location + no usable CUSTOMER
    // default address, e.g. logged-out browsing, or Technician/Admin/Owner
    // with no explicit location — technicians have no default address by
    // design) → show ALL active services so the caller can browse the
    // complete catalog. Address-based filtering only applies once an
    // address/location context exists. Booking restrictions are unchanged
    // and still enforced at booking time. Technician job eligibility never
    // uses this path — it is GPS (TechnicianProfile.location) +
    // Admin-approved enabledCityZoneIds via fetchTechnicianJobsInternal.
    if (!knownZoneId && !resolvedDistrictId) {
      // Explicit location was supplied but resolved to nothing (outside all
      // polygons / unsupported area) → empty, NOT the full catalog.
      if (hasExplicitLocation) {
        return res.status(200).json({
          success: true,
          message: "No services available in your area",
          availabilityPrompt: null,
          locationContext: {
            source: locationSource,
            zoneId: null,
            districtId: null,
            defaultAddressId,
          },
          result: [],
        });
      }

      // STRICT DEFAULT-ADDRESS RULE: an authenticated Customer with no
      // explicit location and no usable default address sees NO services.
      // Availability is derived from the default address only.
      if (
        req.user?.role === "Customer" &&
        !hasExplicitLocation &&
        (locationSource === "no_default_address" || locationSource === "address_lookup_failed")
      ) {
        return res.status(200).json({
          success: true,
          message: "Service unavailable in this area",
          availabilityPrompt: "Add a default address to check service availability.",
          locationContext: {
            source: locationSource,
            zoneId: null,
            districtId: null,
            defaultAddressId,
          },
          result: [],
        });
      }

      let services = await Service.find(query)
        .populate("categoryId", "category categoryType description")
        .sort({ createdAt: -1 })
        .lean();

      // Hide pricing fields for technicians (same as filtered path)
      if (req.user?.role === "Technician") {
        services = services.map(
          ({
            serviceCost,
            commissionPercentage,
            commissionAmount,
            serviceDiscountPercentage,
            discountAmount,
            discountedPrice,
            minimumVisitCharge,
            ...service
          }) => ({
            ...service,
            technicianAmount: service.technicianAmount || 0,
          })
        );
      }

      return res.status(200).json({
        success: true,
        message: "Services fetched successfully",
        availabilityPrompt: "Select an address to check exact service availability.",
        locationContext: {
          source: locationSource,
          zoneId: null,
          districtId: null,
          defaultAddressId,
        },
        result: services,
      });
    }

    // POST-ADDRESS RULE: address must resolve to BOTH valid District AND valid Zone.
    // District-only (gap outside all zone polygons) or outside supported area
    // → no services. No district fallback for listing.
    if (!knownZoneId || !resolvedDistrictId) {
      return res.status(200).json({
        success: true,
        message: "No services available in your area",
        availabilityPrompt: null,
        locationContext: {
          source: locationSource,
          zoneId: knownZoneId || null,
          districtId: resolvedDistrictId || null,
          defaultAddressId,
        },
        result: [],
      });
    }

    const services = await Service.find(query)
      .populate("categoryId", "category categoryType description")
      .sort({ createdAt: -1 })
      .lean();

    const { resolveServiceAvailability } = await import("../Services/serviceAvailabilityService.js");

    // FINAL RULE: every returned service passed
    // isActive + district active + zone active + enabled-for-zone.
    let filteredServices = [];
    for (const s of services) {
      const avail = await resolveServiceAvailability({
        serviceId: s._id,
        districtId: resolvedDistrictId,
        cityId: cityId || knownZoneId,
        cityZoneId: knownZoneId || cityId,
      });
      if (avail.available) {
        filteredServices.push({
          ...s,
          availabilityMetadata: avail,
        });
      }
    }

    // Hide pricing fields for technicians
    if (req.user?.role === "Technician") {
      filteredServices = filteredServices.map(
        ({
          serviceCost,
          commissionPercentage,
          commissionAmount,
          serviceDiscountPercentage,
          discountAmount,
          discountedPrice,
          minimumVisitCharge,
          ...service
        }) => ({
          ...service,
          technicianAmount: service.technicianAmount || 0,
        })
      );
    }

    return res.status(200).json({
      success: true,
      message: "Services fetched successfully",
      availabilityPrompt: resolvedDistrictId ? null : "Select an address to check exact service availability.",
      locationContext: {
        source: locationSource,
        zoneId: knownZoneId || null,
        districtId: resolvedDistrictId || null,
        defaultAddressId,
      },
      result: filteredServices,
    });

  } catch (error) {
    if (res.headersSent) return;
    return res.status(500).json({
      success: false,
      message: "Server error",
      result: { error: error.message },
    });
  }
};

export const getServiceById = async (req, res) => {
  try {
    const { id } = req.params;

    // 🔒 Validate ObjectId
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid service ID format",
        result: {},
      });
    }

    const service = await Service.findById(id)

      .populate(
        "categoryId",
        "category categoryType description"
      );

    if (!service) {
      return res.status(404).json({
        success: false,
        message: "Service not found",
        result: {},
      });
    }

    return res.status(200).json({
      success: true,
      message: "Service fetched successfully",
      result: service,
    });
  } catch (error) {
    if (res.headersSent) return;
    return res.status(500).json({
      success: false,
      message: "Server error",
      result: { error: error.message },
    });
  }
};

/**
 * 🎯 TOGGLE ZONE RESTRICTION (Admin/Owner)
 * When ON, the service is only visible/bookable in zones with an active
 * ZoneServiceMapping. When OFF, the service is available everywhere.
 * ZoneServiceMapping rows are managed via the existing adminZones routes.
 */
export const toggleZoneRestriction = async (req, res) => {
  try {
    const { id } = req.params;
    const { zoneRestricted } = req.body;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid service ID format", result: {} });
    }
    if (typeof zoneRestricted !== "boolean") {
      return res.status(400).json({ success: false, message: "zoneRestricted must be a boolean", result: {} });
    }

    const service = await Service.findByIdAndUpdate(
      id,
      { $set: { zoneRestricted } },
      { new: true }
    ).select("_id serviceName zoneRestricted isActive");

    if (!service) {
      return res.status(404).json({ success: false, message: "Service not found", result: {} });
    }

    return res.status(200).json({
      success: true,
      message: zoneRestricted
        ? `"${service.serviceName}" is now zone-restricted (visible only in mapped zones).`
        : `"${service.serviceName}" is now available in all zones.`,
      result: service,
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message, result: { error: error.message } });
  }
};

export const updateService = async (req, res) => {
  try {
    const { id } = req.params;
    const updateData = req.body;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid service ID format",
        result: {},
      });
    }

    const service = await Service.findById(id);
    if (!service) {
      return res.status(404).json({
        success: false,
        message: "Service not found",
        result: {},
      });
    }

    // Handle Category Validation
    if (updateData.categoryId) {
      if (!mongoose.Types.ObjectId.isValid(updateData.categoryId)) {
        return res.status(400).json({ success: false, message: "Invalid categoryId", result: {} });
      }
      const category = await Category.findById(updateData.categoryId);
      if (!category || category.categoryType !== "service") {
        return res.status(400).json({ success: false, message: "Category must exist and be of type service", result: {} });
      }
    }

    // Handle Enums
    if (updateData.serviceType && !SERVICE_TYPES.includes(updateData.serviceType)) {
      return res.status(400).json({ success: false, message: "Invalid serviceType", result: {} });
    }
    if (updateData.pricingType && !PRICING_TYPES.includes(updateData.pricingType)) {
      return res.status(400).json({ success: false, message: "Invalid pricingType", result: {} });
    }

    // Handle Numeric Fields
    if (updateData.serviceCost !== undefined) {
      const costNum = toNumber(updateData.serviceCost);
      if (Number.isNaN(costNum) || costNum < 0) {
        return res.status(400).json({ success: false, message: "serviceCost must be a non-negative number", result: {} });
      }
      service.serviceCost = costNum;
    }

    if (updateData.commissionPercentage !== undefined) {
      const commissionNum = toNumber(updateData.commissionPercentage);
      if (Number.isNaN(commissionNum) || commissionNum < 0 || commissionNum > 50) {
        return res.status(400).json({ success: false, message: "commissionPercentage must be between 0 and 50", result: {} });
      }
      service.commissionPercentage = commissionNum;
    }

    if (updateData.serviceDiscountPercentage !== undefined) {
      const discountNum = toNumber(updateData.serviceDiscountPercentage);
      if (Number.isNaN(discountNum) || discountNum < 0 || discountNum > 100) {
        return res.status(400).json({ success: false, message: "serviceDiscountPercentage must be between 0 and 100", result: {} });
      }
      service.serviceDiscountPercentage = discountNum;
    }

    // Handle other fields (arrays, strings, bools)
    const allowedUpdates = [
      "categoryId", "serviceName", "description", "serviceType", "pricingType",
      "whatIncluded", "whatNotIncluded", "serviceHighlights", "cancellationPolicy",
      "frequentlyAskedQuestions", "supportedBrands", "rectifyMethod", "faultReasons",
      "toolsEquipments", "serviceChecklist", "requiresSpareParts", "duration",
      "siteVisitRequired", "serviceWarranty", "isPopular", "isRecommended", "isActive",
      "minimumVisitCharge"
    ];

    allowedUpdates.forEach((field) => {
      if (updateData[field] !== undefined) {
        service[field] = updateData[field];
      }
    });

    // Save triggers the pre-save hook for auto-calculations
    const updated = await service.save();

    // Re-fetch with populated category for response
    const responseDoc = await Service.findById(updated._id)
      .populate("categoryId", "category categoryType description");

    return res.status(200).json({
      success: true,
      message: "Service updated successfully",
      result: responseDoc,
    });
  } catch (error) {
    if (res.headersSent) return;
    return res.status(500).json({
      success: false,
      message: "Server error",
      result: { error: error.message },
    });
  }
};

export const deleteService = async (req, res) => {
  try {
    const { id } = req.params;

    // 🔒 Validate ObjectId
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid service ID format",
        result: {},
      });
    }

    const deleted = await Service.findByIdAndDelete(id);

    if (!deleted) {
      return res.status(404).json({
        success: false,
        message: "Service not found",
        result: {},
      });
    }

    return res.status(200).json({
      success: true,
      message: "Service deleted successfully",
      result: {},
    });
  } catch (error) {
    if (res.headersSent) return;
    return res.status(500).json({
      success: false,
      message: "Server error",
      result: { error: error.message },
    });
  }
};


/* =====================================================
   SERVICE COVERAGE POLYGON (Admin/Owner, audited)
   Polygon = area where the service can be booked AND
   where technicians are matched for its jobs.
===================================================== */
import { writeAuditLog } from "../Utils/audit.js";
import { validateGeoJsonPolygon } from "../Utils/servicePolygon.js";

const isOwnerOrAdmin = (req) => ["Owner", "Admin"].includes(req.user?.role);

// GET service coverage polygon
export const getServicePolygon = async (req, res) => {
  try {
    if (!isOwnerOrAdmin(req)) {
      return res.status(403).json({ success: false, message: "Owner/Admin access only", result: {} });
    }
    const service = await Service.findById(req.params.id).select("serviceName coveragePolygon").lean();
    if (!service) {
      return res.status(404).json({ success: false, message: "Service not found", result: {} });
    }
    return res.status(200).json({
      success: true,
      result: { serviceId: service._id, serviceName: service.serviceName, coveragePolygon: service.coveragePolygon || null },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message, result: {} });
  }
};

// SET / UPDATE service coverage polygon
export const setServicePolygon = async (req, res) => {
  try {
    if (!isOwnerOrAdmin(req)) {
      return res.status(403).json({ success: false, message: "Owner/Admin access only", result: {} });
    }
    const polygon = req.body.polygon;
    const polygonError = validateGeoJsonPolygon(polygon);
    if (polygonError) {
      return res.status(400).json({ success: false, message: polygonError, result: {} });
    }

    const service = await Service.findByIdAndUpdate(
      req.params.id,
      { $set: { coveragePolygon: polygon } },
      { new: true, runValidators: true }
    ).select("serviceName coveragePolygon");
    if (!service) {
      return res.status(404).json({ success: false, message: "Service not found", result: {} });
    }

    await writeAuditLog({
      actor: req.user.userId,
      actorRole: req.user.role,
      action: "SERVICE_POLYGON_SET",
      targetType: "Service",
      targetId: service._id,
      after: { serviceName: service.serviceName, coveragePolygon: service.coveragePolygon },
    });

    return res.status(200).json({
      success: true,
      message: "Service coverage polygon set. Customers outside it cannot book; only technicians inside it get these jobs.",
      result: { serviceId: service._id, serviceName: service.serviceName, coveragePolygon: service.coveragePolygon },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message, result: {} });
  }
};

// REMOVE service coverage polygon (unrestrict)
export const removeServicePolygon = async (req, res) => {
  try {
    if (!isOwnerOrAdmin(req)) {
      return res.status(403).json({ success: false, message: "Owner/Admin access only", result: {} });
    }
    const service = await Service.findById(req.params.id);
    if (!service) {
      return res.status(404).json({ success: false, message: "Service not found", result: {} });
    }
    const hadPolygon = Boolean(service.coveragePolygon);
    service.coveragePolygon = undefined;
    await service.save();

    await writeAuditLog({
      actor: req.user.userId,
      actorRole: req.user.role,
      action: "SERVICE_POLYGON_REMOVED",
      targetType: "Service",
      targetId: service._id,
      before: { hadPolygon },
    });

    return res.status(200).json({
      success: true,
      message: "Service coverage polygon removed. Service is bookable everywhere.",
      result: { serviceId: service._id, serviceName: service.serviceName, coveragePolygon: null },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message, result: {} });
  }
};
