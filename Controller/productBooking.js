import ProductBooking from "../Schemas/ProductBooking.js";

// Create A new ProductBooking
export const productBooking = async (req, res) => {
  try {
    const { userId, productId, status } = req.body;

    if (!userId || !productId || !status) {
      return res.status(400).json({
        message: "All fields are required",
      });
    }

    const productData = await ProductBooking.create({
      userId,
      productId,
      status,
    });

    res.status(201).json({
      message: "product booking created successfully",
      data: productData,
    });
  } catch (error) {
    res.status(500).json({
      message: "Server error",
      error: error.message,
    });
  }
};

export const getAllProductBooking = async (req, res) => {
  try {
    const getAllBooking = await ProductBooking.find()
      .populate("userId", "firstName lastName email")

    if (getAllBooking.length === 0) {
      return res.status(404).json({
        message: "No product booking data found",
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

export const productBookingUpdate = async (req, res) => {
  try {
    const { userId, productId, status } = req.body;

    if ( !userId || !productId || !status) {
      return res.status(400).json({
        message: "All fields are required",
      });
    }

    const updateBooking = await ProductBooking.findByIdAndUpdate(
      req.params.id,
      { userId, productId, status },
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

export const productBookingCancel = async (req, res) => {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({
        message: "Booking ID is required",
      });
    }

    const cancelBooking = await ProductBooking.findByIdAndUpdate(
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
