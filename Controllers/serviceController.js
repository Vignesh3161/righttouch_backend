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
    const { search, categoryId } = req.query;

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

    const services = await Service.find(query)
      .populate("categoryId", "category categoryType description")
      .sort({ createdAt: -1 })
      .lean();

    let filteredServices = services;

    // Hide pricing fields for technicians
    if (req.user?.role === "Technician") {
      filteredServices = services.map(
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

