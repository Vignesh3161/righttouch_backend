import {
  createComplaintInternal,
  listReportCategoriesInternal,
  getMyReportsInternal,
  customerWithdrawComplaintInternal,
  adminListComplaintsInternal,
  adminGetComplaintInternal,
  adminUpdateComplaintStatusInternal,
  adminRejectComplaintInternal,
  technicianListMyComplaintsInternal,
  technicianGetComplaintDetailInternal,
  technicianRespondToComplaintInternal,
  technicianGetMyRefundsInternal,
} from "../Services/complaintService.js";

const ok = (res, status, message, result = {}) => res.status(status).json({ success: true, message, result });
const fail = (res, status, message, result = {}) => res.status(status).json({ success: false, message, result });

export const customerCreateReport = async (req, res) => {
  try {
    const customerId = req.user.userId;
    const { bookingId, bookingType, complaint, image, category } = req.body;

    const report = await createComplaintInternal({
      customerId,
      bookingId,
      bookingType,
      complaint,
      image,
      category,
    });

    return ok(res, 201, "Complaint filed", { report });
  } catch (e) {
    return fail(res, e.statusCode || 500, e.message);
  }
};

export const customerWithdrawComplaint = async (req, res) => {
  try {
    const customerId = req.user.userId;
    const reportId = req.params.id;
    const { reason } = req.body || {};

    const report = await customerWithdrawComplaintInternal({
      customerId,
      reportId,
      reason,
    });

    return ok(res, 200, "Complaint withdrawn", { report });
  } catch (e) {
    return fail(res, e.statusCode || 500, e.message);
  }
};

export const listReportCategories = async (req, res) => {
  try {
    const categories = await listReportCategoriesInternal();
    return ok(res, 200, "Report categories", { categories });
  } catch (e) {
    return fail(res, 500, e.message);
  }
};

export const customerGetMyReports = async (req, res) => {
  try {
    const reports = await getMyReportsInternal(req.user.userId);
    return ok(res, 200, "Reports", { reports });
  } catch (e) {
    return fail(res, 500, e.message);
  }
};

export const adminListComplaints = async (req, res) => {
  try {
    const { status = "open", search } = req.query;
    const reports = await adminListComplaintsInternal({ status, search });
    return ok(res, 200, "Complaints", { reports });
  } catch (e) {
    return fail(res, 500, e.message);
  }
};

export const adminGetComplaint = async (req, res) => {
  try {
    const { report, booking, reserveHolds } = await adminGetComplaintInternal(req.params.id);
    return ok(res, 200, "Complaint detail", { report, booking, reserveHolds });
  } catch (e) {
    return fail(res, e.statusCode || 500, e.message);
  }
};

export const adminUpdateComplaintStatus = async (req, res) => {
  try {
    const { status, resolutionNote, refundId } = req.body;
    const { report, noChange } = await adminUpdateComplaintStatusInternal({
      reportId: req.params.id,
      status,
      resolutionNote,
      refundId,
      adminUser: req.user,
    });

    if (noChange) {
      return ok(res, 200, "No change", { report });
    }

    const message = status === "under_review" ? "Marked under review" : "Complaint status updated";
    return ok(res, 200, message, { report });
  } catch (e) {
    return fail(res, e.statusCode || 500, e.message);
  }
};

export const adminRejectComplaint = async (req, res) => {
  try {
    const { reason } = req.body;
    const report = await adminRejectComplaintInternal({
      reportId: req.params.id,
      reason,
      adminUser: req.user,
    });
    return ok(res, 200, "Complaint rejected", { report });
  } catch (e) {
    return fail(res, e.statusCode || 500, e.message);
  }
};

export const technicianListMyComplaints = async (req, res) => {
  try {
    const techId = req.user.technicianProfileId;
    const reports = await technicianListMyComplaintsInternal(techId);
    return ok(res, 200, "Complaints filed against you", { reports });
  } catch (e) {
    return fail(res, 500, e.message);
  }
};

export const technicianGetComplaintDetail = async (req, res) => {
  try {
    const techId = req.user.technicianProfileId;
    const { report, booking } = await technicianGetComplaintDetailInternal({
      technicianProfileId: techId,
      reportId: req.params.id,
    });
    return ok(res, 200, "Complaint detail", { report, booking });
  } catch (e) {
    return fail(res, e.statusCode || 500, e.message);
  }
};

export const technicianRespondToComplaint = async (req, res) => {
  try {
    const techId = req.user.technicianProfileId;
    const { response, images } = req.body || {};

    let uploadedImages = [];
    if (Array.isArray(images)) {
      uploadedImages = images;
    } else if (req.files && Array.isArray(req.files)) {
      uploadedImages = req.files.map((f) => f.path || f.secure_url || f.location);
    }

    const report = await technicianRespondToComplaintInternal({
      technicianProfileId: techId,
      reportId: req.params.id,
      response,
      images: uploadedImages,
    });

    return ok(res, 200, "Response submitted successfully", { report });
  } catch (e) {
    return fail(res, e.statusCode || 500, e.message);
  }
};

export const technicianGetMyRefunds = async (req, res) => {
  try {
    const techId = req.user.technicianProfileId;
    const refunds = await technicianGetMyRefundsInternal(techId);
    return ok(res, 200, "Your refund/clawback history", { refunds });
  } catch (e) {
    return fail(res, 500, e.message);
  }
};
