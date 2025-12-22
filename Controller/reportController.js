import Report from "../Schemas/Report.js";

// Create Report
export const userReport = async (req, res) => {
  try {
    const { technicianId, customerId, serviceId, complaint, image } = req.body;

    if (!technicianId || !customerId || !serviceId || !complaint || !image) {
      return res.status(400).json({
        success: false,
        message: "All fields are required",
        result: "Missing required fields"
      });
    }

    const reportData = await Report.create({
      technicianId,
      customerId,
      serviceId,
      complaint,
      image,
    });

    res.status(201).json({
      success: true,
      message: "Report sent successfully",
      result: reportData
    });
  } catch (error) {
    res.status(500).json({ success: false, message: "Server error", result: error.message });
  }
};

// Get All Reports
export const getAllReports = async (req, res) => {
  try {
    const { search } = req.query;

    let query = {};

    // 🔍 Search filter
    if (search) {
      query.$or = [
        { complaint: { $regex: search, $options: "i" } }, // search inside complaint
        { status: { $regex: search, $options: "i" } }, // search by status
      ];
    }

    // 📦 Fetch with relations
    const reports = await Report.find(query)
      .populate("serviceId", "serviceName")
      .populate("customerId", "email name")
      .populate({
        path: "technicianId",
        populate: { path: "userId", select: "username email" },
      });

    if (reports.length === 0) {
      return res.status(404).json({
        success: false,
        message: "No reports found",
        result: "No reports match the search criteria"
      });
    }

    return res.status(200).json({
      success: true,
      message: "Reports fetched successfully",
      result: reports
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Server error",
      result: error.message
    });
  }
};

// ✅ Get Report by ID
export const getReportById = async (req, res) => {
  try {
    const { id } = req.params;
    const report = await Report.findById(id)
      .populate("serviceId", "serviceName")
      .populate("customerId", "email")
      .populate({
        path: "technicianId",
        populate: { path: "userId", select: "username email" },
      });

      if (report.length === 0) {
      return res.status(404).json({
        success: false,
        message: "No report data found",
        result: "No report exists with this ID"
      });
    }

    if (!report)
      return res
        .status(404)
        .json({ success: false, message: "Report not found", result: "No report exists with this ID" });

    return res.status(200).json({ success: true, message: "Report fetched successfully", result: report });
  } catch (error) {
    res.status(500).json({ success: false, message: "Server error", result: error.message });
  }
};
