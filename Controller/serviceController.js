import Service from "../Schemas/Service.js";

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
      commissionPercentage,
      serviceDiscountPercentage,
      duration,
      siteVisitRequired,
      whatIncluded,
      whatNotIncluded,
      serviceHighlights,
      serviceWarranty,
      cancellationPolicy,
    } = req.body;

    if (
      !categoryId ||
      !serviceName ||
      !description ||
      !serviceType ||
      !serviceCost
    ) {
      return res.status(400).json({
        success: false,
        message: "Required fields are missing",
      });
    }

    const existing = await Service.findOne({
      serviceName: { $regex: `^${serviceName}$`, $options: "i" },
      categoryId,
    });

    if (existing) {
      return res.status(409).json({
        success: false,
        message: "Service already exists",
      });
    }

    const service = await Service.create({
      categoryId,
      serviceName,
      description,
      serviceType,
      pricingType,
      serviceCost,
      commissionPercentage,
      serviceDiscountPercentage,
      duration,
      siteVisitRequired,
      whatIncluded,
      whatNotIncluded,
      serviceHighlights,
      serviceWarranty,
      cancellationPolicy,
    });

    return res.status(201).json({
      success: true,
      message: "Service created successfully",
      result: service,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Server error",
      result: error.message,
    });
  }
};


// UPLOAD SERVICE IMAGES
export const uploadServiceImages = async (req, res) => {
  try {
    const { serviceId } = req.body;

    if (!serviceId) {
      return res.status(400).json({
        success: false,
        message: "Service ID is required",
      });
    }

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Service images are required",
      });
    }

    const service = await Service.findById(serviceId);
    if (!service) {
      return res.status(404).json({
        success: false,
        message: "Service not found",
      });
    }

    const images = req.files.map(file => file.path);
    service.serviceImages.push(...images);
    await service.save();

    return res.status(200).json({
      success: true,
      message: "Service images uploaded successfully",
      result: service,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Server error",
      result: error.message,
    });
  }
};
export const getAllServices = async (req, res) => {
  try {
    const { search } = req.query;
    let query = { isActive: true };

    if (search) {
      query.$or = [
        { serviceName: { $regex: search, $options: "i" } },
        { description: { $regex: search, $options: "i" } },
      ];
    }

    const services = await Service.find(query).populate(
      "categoryId",
      "category description"
    );

    return res.status(200).json({
      success: true,
      message: "Services fetched successfully",
      result: services,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Server error",
      result: error.message,
    });
  }
};

export const getServiceById = async (req, res) => {
  try {
    const service = await Service.findById(req.params.id).populate(
      "categoryId",
      "category description"
    );

    if (!service) {
      return res.status(404).json({
        success: false,
        message: "Service not found",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Service fetched successfully",
      result: service,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Server error",
      result: error.message,
    });
  }
};

export const updateService = async (req, res) => {
  try {
    const updated = await Service.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true, runValidators: true }
    );

    if (!updated) {
      return res.status(404).json({
        success: false,
        message: "Service not found",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Service updated successfully",
      result: updated,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Server error",
      result: error.message,
    });
  }
};

export const deleteService = async (req, res) => {
  try {
    const deleted = await Service.findByIdAndDelete(req.params.id);

    if (!deleted) {
      return res.status(404).json({
        success: false,
        message: "Service not found",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Service deleted successfully",
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Server error",
      result: error.message,
    });
  }
};
