import {
  createComplaintInternal,
  listReportCategoriesInternal,
  getMyReportsInternal,
  adminListComplaintsInternal,
  adminGetComplaintInternal,
  adminUpdateComplaintStatusInternal,
  adminRejectComplaintInternal,
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

export const technicianGetMyRefunds = async (req, res) => {
  try {
    const techId = req.user.technicianProfileId;
    const refunds = await technicianGetMyRefundsInternal(techId);
    return ok(res, 200, "Your refund/clawback history", { refunds });
  } catch (e) {
    return fail(res, 500, e.message);
  }
};
