import mongoose from "mongoose";
import Report from "../Schemas/Report.js";
import ServiceBooking from "../Schemas/ServiceBooking.js";
import ProductBooking from "../Schemas/ProductBooking.js";

// ✅ Create Report (Secure & Schema Compliant)
export const userReport = async (req, res) => {
  try {
    const customerId = req.user?.userId;
    if (!customerId) {
      return res.status(401).json({ success: false, message: "Unauthorized", result: {} });
    }

    const {
      bookingId,
      bookingType,
      technicianId,
      serviceId,
      productId,
      complaint,
      image
    } = req.body;

    // 1️⃣ Basic Validation
    if (!bookingId || !bookingType || !complaint) {
      return res.status(400).json({
        success: false,
        message: "bookingId, bookingType, and complaint are required",
        result: {}
      });
    }

    // 2️⃣ Verify Booking Ownership & Fetch context
    let booking;
    if (bookingType === "service") {
      booking = await ServiceBooking.findOne({ _id: bookingId, customerId });
      if (!booking) return res.status(404).json({ success: false, message: "Service booking not found", result: {} });
    } else if (bookingType === "product") {
      booking = await ProductBooking.findOne({ _id: bookingId, customerId });
      if (!booking) return res.status(404).json({ success: false, message: "Product booking not found", result: {} });
    } else {
      return res.status(400).json({ success: false, message: "Invalid bookingType", result: {} });
    }

    // 3️⃣ Create Report
    const reportData = await Report.create({
      bookingId,
      bookingType,
      technicianId: technicianId || booking.technicianId || null,
      serviceId: serviceId || booking.serviceId || null,
      productId: productId || booking.productId || null,
      customerId,
      complaint,
      image,
    });

    res.status(201).json({
      success: true,
      message: "Report sent successfully. Our team will look into it.",
      result: reportData
    });
  } catch (error) {
    console.error("userReport Error:", error);
    res.status(500).json({ success: false, message: "Server error", result: { error: error.message } });
  }
};

// ✅ Get My Reports (For Customers)
export const getMyReports = async (req, res) => {
  try {
    const customerId = req.user?.userId;
    if (!customerId) return res.status(401).json({ success: false, message: "Unauthorized" });

    const reports = await Report.find({ customerId })
      .populate("serviceId", "serviceName")
      .populate("productId", "productName")
      .populate({
        path: "technicianId",
        populate: { path: "userId", select: "fname lname mobileNumber" },
      })
      .sort({ createdAt: -1 });

    res.status(200).json({ success: true, result: reports });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ✅ Resolve Report (For Admin)
export const resolveReport = async (req, res) => {
  try {
    const { id } = req.params;
    const report = await Report.findByIdAndUpdate(
      id,
      { status: "resolved" },
      { new: true }
    );

    if (!report) return res.status(404).json({ success: false, message: "Report not found" });

    res.status(200).json({ success: true, message: "Report marked as resolved", result: report });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// ✅ Get All Reports (For Admin)
export const getAllReports = async (req, res) => {
  try {
    const { search, status } = req.query;
    let query = {};
    if (status) query.status = status;

    if (search) {
      query.$or = [{ complaint: { $regex: search, $options: "i" } }];
    }

    const reports = await Report.find(query)
      .populate("serviceId", "serviceName")
      .populate("productId", "productName")
      .populate("customerId", "fname lname email mobileNumber")
      .populate({
        path: "technicianId",
        populate: { path: "userId", select: "fname lname mobileNumber" },
      })
      .sort({ createdAt: -1 });

    return res.status(200).json({
      success: true,
      result: reports
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ✅ Get Report by ID
export const getReportById = async (req, res) => {
  try {
    const { id } = req.params;
    const report = await Report.findById(id)
      .populate("serviceId", "serviceName")
      .populate("productId", "productName")
      .populate("customerId", "fname lname email mobileNumber")
      .populate({
        path: "technicianId",
        populate: { path: "userId", select: "fname lname mobileNumber" },
      });

    if (!report) return res.status(404).json({ success: false, message: "Report not found" });

    return res.status(200).json({ success: true, result: report });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
