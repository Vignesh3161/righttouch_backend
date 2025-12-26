import ServiceBook from "../Schemas/ServiceBooking.js";


// Create A new Service Booking
export const serviceBook = async (req, res) => {
  try {
    const { technicianId, userId, serviceId, amount } = req.body;

    if (!technicianId || !userId || !serviceId || amount === undefined) {
      return res.status(400).json({
        success: false,
        message: "All fields are required",
        result: "Missing required fields",
      });
    }

    const serviceData = await ServiceBook.create({
      technicianId,
      userId,
      serviceId,
      amount,
    });

    res.status(201).json({
      success: true,
      message: "Service booking created successfully",
      result: serviceData,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Server error",
      result: error.message,
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
      });

    if (getAllBooking.length === 0) {
      return res.status(404).json({
        success: false,
        message: "No service booking data found",
        result: "No service bookings exist"
      });
    }

    res.status(200).json({
      success: true,
      message: "Data fetched successfully",
      result: getAllBooking
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Error fetching service bookings",
      result: error.message
    });
  }
};


export const serviceBookUpdate = async (req, res) => {
  try {
    const { technicianId, userId, categoryId, serviceId } = req.body;

    if (!technicianId || !userId || !categoryId || !serviceId) {
      return res.status(400).json({
        success: false,
        message: "All fields are required",
        result: "Missing required fields"
      });
    }

    const updateBooking = await ServiceBook.findByIdAndUpdate(
      req.params.id,
      { technicianId, userId, categoryId, serviceId },
      { new: true, runValidators: true }
    );

    if (!updateBooking) {
      return res.status(404).json({ success: false, message: "Booking not found", result: "No booking exists with this ID" });
    }

    res.status(200).json({
      success: true,
      message: "Booking updated successfully",
      result: updateBooking
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Server error",
      result: error.message
    });
  }
};

export const serviceBookingCancel = async (req, res) => {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({
        success: false,
        message: "Booking ID is required",
        result: "Missing booking ID"
      });
    }

    const cancelBooking = await ServiceBook.findByIdAndUpdate(
      id,
      { status: "cancelled" },
      { new: true }
    );

    if (!cancelBooking) {
      return res.status(404).json({
        success: false,
        message: "Your booking was not found",
        result: "No booking exists with this ID"
      });
    }

    res.status(200).json({
      success: true,
      message: "Your booking has been cancelled successfully",
      result: cancelBooking
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Server error",
      result: error.message
    });
  }
};
