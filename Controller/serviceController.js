import Service from "../Schemas/Service.js";

// ******** Create Service **************
export const service = async (req, res) => {
  try {
    const {
      categoryId,
      serviceName,
      description,
      serviceCost,
      commissionPercentage,
      serviceDiscountPercentage,
      quantity,
      active,
      status,
      duration,
    } = req.body;

    if (
      !categoryId ||
      !serviceName ||
      !description ||
      !serviceCost ||
      !commissionPercentage ||
      !quantity ||
      status === undefined ||
      active === undefined
    ) {
      return res.status(400).json({
        success: false,
        message: "All fields are required",
        result: "Missing required fields"
      });
    }

    const matchService = await Service.findOne({ serviceName });
    if (matchService) {
      return res.status(409).json({
        success: false,
        message: "Service name already registered",
        result: "Duplicate service found"
      });
    }

    const serviceData = await Service.create({
      categoryId,
      serviceName,
      description,
      serviceCost,
      commissionPercentage,
      serviceDiscountPercentage,
      quantity,
      active,
      status,
      duration,
    });

    res.status(201).json({
      success: true,
      message: "Service created successfully",
      result: serviceData
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Server error",
      result: error.message
    });
  }
};

// ******** Get All Services **************
export const getAllServices = async (req, res) => {
  try {
    const { search } = req.query;

    let query = {};

    if (search) {
      query.$or = [
        { serviceName: { $regex: search, $options: "i" } },
        { description: { $regex: search, $options: "i" } },
        { status: { $regex: search, $options: "i" } },
      ];
    }

    const services = await Service.find(query).populate(
      "categoryId",
      "category description"
    );

    if (services.length === 0) {
      return res.status(404).json({
        success: false,
        message: "No service data found",
        result: "No services match the search criteria"
      });
    }

    return res.status(200).json({ success: true, message: "Services fetched successfully", result: services });
  } catch (error) {
    return res.status(400).json({ success: false, message: "Server error", result: error.message });
  }
};

// ******** Get Service by ID **************

// ✅ Get Service by ID
export const getServiceById = async (req, res) => {
  try {
    const { id } = req.params;
    const service = await Service.findById(id).populate(
      "categoryId",
      "category description"
    );

    if (service.length === 0) {
      return res.status(404).json({
        success: false,
        message: "No service data found",
        result: "No service exists with this ID"
      });
    }
    if (!service) return res.status(404).json({ success: false, message: "Service not found", result: "No service exists with this ID" });
    return res.status(200).json({ success: true, message: "Service fetched successfully", result: service });
  } catch (error) {
    return res.status(400).json({ success: false, message: "Server error", result: error.message });
  }
};

// ******** Update Service **************
export const updateService = async (req, res) => {
  try {
    const { id } = req.params;

    const updatedService = await Service.findByIdAndUpdate(
      id,
      { $set: req.body },
      { new: true, runValidators: true }
    );

    if (!updatedService) {
      return res.status(404).json({ success: false, message: "Service not found", result: "No service exists with this ID" });
    }

    return res.status(200).json({
      success: true,
      message: "Service updated successfully",
      result: updatedService
    });
  } catch (error) {
    return res.status(400).json({ success: false, message: "Server error", result: error.message });
  }
};

// ******** Delete Service **************
export const deleteService = async (req, res) => {
  try {
    const { id } = req.params;
    const service = await Service.findByIdAndDelete(id);
    if (!service) {
      return res.status(404).json({ success: false, message: "Service not found", result: "No service exists with this ID" });
    }

    return res.status(200).json({ success: true, message: "Service deleted successfully", result: "Service has been deleted" });
  } catch (error) {
    return res.status(400).json({ success: false, message: "Server error", result: error.message });
  }
};
