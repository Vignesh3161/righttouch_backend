import ProductBooking from "../Schemas/ProductBooking.js";

// Create A new ProductBooking
export const productBooking = async (req, res) => {
  try {
    const { userId, productId, status, amount } = req.body;

    // ✅ Validation
    if (!userId || !productId || !status || amount === undefined) {
      return res.status(400).json({
        success: false,
        message: "All fields are required",
        result: "Missing required fields",
      });
    }

    const productData = await ProductBooking.create({
      userId,
      ProductId: productId, // 👈 match schema field name
      status,
      amount,
    });

    res.status(201).json({
      success: true,
      message: "Product booking created successfully",
      result: productData,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Server error",
      result: error.message,
    });
  }
};

export const getAllProductBooking = async (req, res) => {
  try {
    const getAllBooking = await ProductBooking.find()
      .populate("userId", "firstName lastName email")
      .populate("ProductId", "productName price");

    if (getAllBooking.length === 0) {
      return res.status(404).json({
        success: false,
        message: "No product booking data found",
        result: "No product bookings exist",
      });
    }

    res.status(200).json({
      success: true,
      message: "Data fetched successfully",
      result: getAllBooking,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Error fetching product bookings",
      result: error.message,
    });
  }
};


export const productBookingUpdate = async (req, res) => {
  try {
    const { userId, productId, status, amount } = req.body;

    if (!userId || !productId || !status || amount === undefined) {
      return res.status(400).json({
        success: false,
        message: "All fields are required",
        result: "Missing required fields",
      });
    }

    const updateBooking = await ProductBooking.findByIdAndUpdate(
      req.params.id,
      {
        userId,
        ProductId: productId, // 👈 match schema
        status,
        amount,
      },
      { new: true, runValidators: true }
    );

    if (!updateBooking) {
      return res.status(404).json({
        success: false,
        message: "Booking not found",
        result: "No booking exists with this ID",
      });
    }

    res.status(200).json({
      success: true,
      message: "Booking updated successfully",
      result: updateBooking,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Server error",
      result: error.message,
    });
  }
};

export const productBookingCancel = async (req, res) => {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({
        success: false,
        message: "Booking ID is required",
        result: "Missing booking ID"
      });
    }

    const cancelBooking = await ProductBooking.findByIdAndUpdate(
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
