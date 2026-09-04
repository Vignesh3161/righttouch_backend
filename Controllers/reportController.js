import {
  createComplaintInternal,
  getMyReportsInternal,
  resolveLegacyReportInternal,
  adminListComplaintsInternal,
  adminGetComplaintInternal,
} from "../Services/complaintService.js";

// ✅ Create Report (Legacy endpoint `/api/report`, backwards-compatible contract)
export const userReport = async (req, res) => {
  try {
    const customerId = req.user?.userId;
    if (!customerId) {
      return res.status(401).json({ success: false, message: "Unauthorized", result: {} });
    }

    const {
      bookingId,
      bookingType = "service",
      technicianId,
      serviceId,
      productId,
      complaint,
      image,
      category,
    } = req.body || {};

    const reportData = await createComplaintInternal({
      customerId,
      bookingId,
      bookingType,
      complaint,
      image,
      category,
      technicianId,
      serviceId,
      productId,
    });

    return res.status(201).json({
      success: true,
      message: "Report sent successfully. Our team will look into it.",
      result: reportData,
    });
  } catch (error) {
    const status = error.statusCode || 500;
    return res.status(status).json({
      success: false,
      message: error.message || "Server error",
      result: {},
    });
  }
};

// ✅ Get My Reports (Legacy endpoint `/api/get-my-reports`)
export const getMyReports = async (req, res) => {
  try {
    const customerId = req.user?.userId;
    if (!customerId) return res.status(401).json({ success: false, message: "Unauthorized" });

    const reports = await getMyReportsInternal(customerId);
    return res.status(200).json({ success: true, result: reports });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
};

// ✅ Resolve Report (Legacy endpoint `/api/report/resolve/:id`, fixes "resolved" enum bug)
export const resolveReport = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, resolutionNote, refundId } = req.body || {};

    const report = await resolveLegacyReportInternal({
      reportId: id,
      inputStatus: status,
      resolutionNote,
      refundId,
      adminUser: req.user,
    });

    return res.status(200).json({
      success: true,
      message: "Report marked as resolved",
      result: report,
    });
  } catch (error) {
    const status = error.statusCode || 500;
    return res.status(status).json({ success: false, message: error.message });
  }
};

// ✅ Get All Reports (Legacy endpoint `/api/getAllReports`)
export const getAllReports = async (req, res) => {
  try {
    const { search, status } = req.query;
    const reports = await adminListComplaintsInternal({ status, search });

    return res.status(200).json({
      success: true,
      result: reports,
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ✅ Get Report by ID (Legacy endpoint `/api/getReportById/:id`)
export const getReportById = async (req, res) => {
  try {
    const { id } = req.params;
    const { report } = await adminGetComplaintInternal(id);

    return res.status(200).json({ success: true, result: report });
  } catch (error) {
    const status = error.statusCode || 500;
    return res.status(status).json({ success: false, message: error.message });
  }
};
