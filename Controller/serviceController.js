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
        message: "All fields are required",
      });
    }

    const matchService = await Service.findOne({ serviceName });
    if (matchService) {
      return res.status(409).json({
        message: "Service name already registered",
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
      message: "Service created successfully",
      data: serviceData,
    });
  } catch (error) {
    res.status(500).json({
      message: "Server error",
      error: error.message,
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
        message: "No service data found",
      });
    }

    return res.status(200).json(services);
  } catch (error) {
    return res.status(400).json({ message: error.message });
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
        message: "No service data found",
      });
    }
    if (!service) return res.status(404).json({ message: "Service not found" });
    return res.status(200).json(service);
  } catch (error) {
    return res.status(400).json({ message: error.message });
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
      return res.status(404).json({ message: "Service not found" });
    }

    return res.status(200).json({
      message: "Service updated successfully",
      updatedService,
    });
  } catch (error) {
    return res.status(400).json({ message: error.message });
  }
};

// ******** Delete Service **************
export const deleteService = async (req, res) => {
  try {
    const { id } = req.params;
    const service = await Service.findByIdAndDelete(id);
    if (!service) {
      return res.status(404).json({ message: "Service not found" });
    }

    return res.status(200).json({ message: "Service deleted successfully" });
  } catch (error) {
    return res.status(400).json({ message: error.message });
  }
};
