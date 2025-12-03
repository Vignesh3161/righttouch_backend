import ServiceBook from "../Schemas/ServiceBooking.js";

// Create A new Services
export const serviceBook = async (req, res) => {
  try {
    const { technicianId, userId, categoryId, serviceId } = req.body;

    if (!technicianId || !userId || !categoryId || !serviceId) {
      return res.status(400).json({
        message: "All fields are required",
      });
    }

    const serviceData = await ServiceBook.create({
      technicianId,
      userId,
      categoryId,
      serviceId,
    });

    res.status(201).json({
      message: "Service booking created successfully",
      data: serviceData,
    });
  } catch (error) {
    res.status(500).json({
      message: "Server error",
      error: error.message,
    });
  }
};

export const getAllServiceBooking = async (req, res) => {
  try {
    const getAllBooking = await ServiceBook.find()
      .populate("userId", "firstName lastName email")
      .populate("serviceId", "serviceName")
      .populate({
        path: "technicianId",
        populate: {
          path: "userId",
          select: "username email",
        },
      });;

    if (getAllBooking.length === 0) {
      return res.status(404).json({
        message: "No service booking data found",
      });
    }

    res.status(200).json({
      message: "Data fetched successfully",
      data: getAllBooking,
    });
  } catch (error) {
    res.status(500).json({
      message: "Error fetching service bookings",
      error: error.message,
    });
  }
};


export const serviceBookUpdate = async (req, res) => {
  try {
    const { technicianId, userId, categoryId, serviceId } = req.body;

    if (!technicianId || !userId || !categoryId || !serviceId) {
      return res.status(400).json({
        message: "All fields are required",
      });
    }

    const updateBooking = await ServiceBook.findByIdAndUpdate(
      req.params.id,
      { technicianId, userId, categoryId, serviceId },
      { new: true, runValidators: true }
    );

    if (!updateBooking) {
      return res.status(404).json({ message: "Booking not found" });
    }

    res.status(200).json({
      message: "Booking updated successfully",
      data: updateBooking,
    });
  } catch (error) {
    res.status(500).json({
      message: "Server error",
      error: error.message,
    });
  }
};

export const serviceBookingCancel = async (req, res) => {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({
        message: "Booking ID is required",
      });
    }

    const cancelBooking = await ServiceBook.findByIdAndUpdate(
      id,
      { status: "cancelled" },
      { new: true }
    );

    if (!cancelBooking) {
      return res.status(404).json({
        message: "Your booking was not found",
      });
    }

    res.status(200).json({
      message: "Your booking has been cancelled successfully",
      data: cancelBooking,
    });
  } catch (error) {
    res.status(500).json({
      message: "Server error",
      error: error.message,
    });
  }
};
