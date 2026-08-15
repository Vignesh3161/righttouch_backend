import mongoose from "mongoose";
import ProductBooking from "../Schemas/ProductBooking.js";
import Product from "../Schemas/Product.js";

const PAYMENT_STATUSES = ["pending", "paid", "refunded", "completed"];
const BOOKING_STATUSES = ["active", "completed", "cancelled"];

const toNumber = value => {
  const num = Number(value);
  return Number.isNaN(num) ? NaN : num;
};


const ensureCustomer = (req) => {
  if (!req.user || req.user.role !== "Customer") {
    const err = new Error("Customer access only");
    err.statusCode = 403;
    throw err;
  }
  if (!req.user.userId || !mongoose.Types.ObjectId.isValid(req.user.userId)) {
    const err = new Error("Invalid token: userId missing");
    err.statusCode = 401;
    throw err;
  }
};

// Create A new ProductBooking
export const productBooking = async (req, res) => {
  try {
    ensureCustomer(req);
    const customerId = req.user.userId; // Ensure customerId is used consistently

    const { productId, amount, quantity = 1 } = req.body;

    if (!productId || amount === undefined) {
      return res.status(400).json({
        success: false,
        message: "productId and amount are required",
        result: {},
      });
    }

    if (!mongoose.Types.ObjectId.isValid(productId)) {
      return res.status(400).json({ success: false, message: "Invalid productId", result: {} });
    }

    const product = await Product.findById(productId);
    if (!product || !product.isActive) {
      return res.status(404).json({ success: false, message: "Product not found or inactive", result: {} });
    }

    const amountNum = toNumber(amount);
    const quantityNum = toNumber(quantity);

    if (Number.isNaN(amountNum) || amountNum < 0) {
      return res.status(400).json({ success: false, message: "amount must be a non-negative number", result: {} });
    }

    if (!Number.isInteger(quantityNum) || quantityNum < 1) {
      return res.status(400).json({ success: false, message: "quantity must be an integer >= 1", result: {} });
    }

    // 🔒 SECURITY FIX: paymentStatus is NEVER accepted from the client —
    // it starts "pending" and can only move via the verified payment
    // pipeline (Razorpay order → webhook/verify). No more payment bypass.
    const productData = await ProductBooking.create({
      customerId,
      productId,
      status: "active",
      amount: amountNum,
      quantity: quantityNum,
      paymentStatus: "pending",
    });

    res.status(201).json({
      success: true,
      message: "Product booking created successfully",
      result: productData,
    });
  } catch (error) {
    res.status(error?.statusCode || 500).json({
      success: false,
      message: "Server error",
      result: { error: error.message },
    });
  }
};

export const getAllProductBooking = async (req, res) => {
  try {
    const role = req.user?.role?.toLowerCase();
    const { status } = req.query;

    let filter = {};
    if (role !== "admin") {
      filter.customerId = req.user.userId;
    }

    if (status) {
      const statusArray = status.split(",").map(s => s.trim()).filter(s => s.length > 0);
      if (statusArray.length > 0) {
        filter.status = { $in: statusArray };
      }
    }

    const getAllBooking = await ProductBooking.find(filter)
      .populate("customerId", "fname lname gender mobileNumber")
      .populate("productId", "productName pricingModel estimatedPriceFrom estimatedPriceTo")
      .sort({ createdAt: -1 });

    res.status(200).json({
      success: true,
      message: "Data fetched successfully",
      result: getAllBooking,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Error fetching product bookings",
      result: { error: error.message },
    });
  }
};


export const productBookingUpdate = async (req, res) => {
  try {
    ensureCustomer(req);
    const customerId = req.user.userId;

    const { id } = req.params;
    const { amount, paymentStatus, status, quantity } = req.body;

    // 🔒 Validate ObjectId
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid booking ID format",
        result: {},
      });
    }

    const update = {};

    if (amount !== undefined) {
      const amountNum = toNumber(amount);
      if (Number.isNaN(amountNum) || amountNum < 0) {
        return res.status(400).json({ success: false, message: "amount must be a non-negative number", result: {} });
      }
      update.amount = amountNum;
    }

    if (quantity !== undefined) {
      const quantityNum = toNumber(quantity);
      if (!Number.isInteger(quantityNum) || quantityNum < 1) {
        return res.status(400).json({ success: false, message: "quantity must be an integer >= 1", result: {} });
      }
      update.quantity = quantityNum;
    }

    if (paymentStatus !== undefined) {
      if (!PAYMENT_STATUSES.includes(paymentStatus)) {
        return res.status(400).json({ success: false, message: "Invalid paymentStatus", result: {} });
      }
      update.paymentStatus = paymentStatus;
    }

    if (status !== undefined) {
      if (!BOOKING_STATUSES.includes(status)) {
        return res.status(400).json({ success: false, message: "Invalid status", result: {} });
      }
      update.status = status;
    }

    const updateBooking = await ProductBooking.findOneAndUpdate(
      { _id: id, customerId },
      update,
      { new: true, runValidators: true, context: "query" }
    );

    if (!updateBooking) {
      return res.status(404).json({
        success: false,
        message: "Booking not found",
        result: {},
      });
    }

    res.status(200).json({
      success: true,
      message: "Booking updated successfully",
      result: updateBooking,
    });
  } catch (error) {
    res.status(error?.statusCode || 500).json({
      success: false,
      message: "Server error",
      result: { error: error.message },
    });
  }
};

export const productBookingCancel = async (req, res) => {
  try {
    ensureCustomer(req);
    const customerId = req.user.userId;

    const { id } = req.params;

    if (!id) {
      return res.status(400).json({
        success: false,
        message: "Booking ID is required",
        result: {}
      });
    }

    // 🔒 Validate ObjectId
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid booking ID format",
        result: {},
      });
    }

    const cancelBooking = await ProductBooking.findOneAndUpdate(
      { _id: id, customerId },
      { status: "cancelled" },
      { new: true }
    );

    if (!cancelBooking) {
      return res.status(404).json({
        success: false,
        message: "Your booking was not found",
        result: {}
      });
    }

    res.status(200).json({
      success: true,
      message: "Your booking has been cancelled successfully",
      result: cancelBooking
    });
  } catch (error) {
    res.status(error?.statusCode || 500).json({
      success: false,
      message: "Server error",
      result: { error: error.message }
    });
  }
};
