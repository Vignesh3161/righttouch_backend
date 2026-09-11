import mongoose from "mongoose";
import Report from "../Schemas/Report.js";
import ServiceBooking from "../Schemas/ServiceBooking.js";
import ProductBooking from "../Schemas/ProductBooking.js";
import Refund from "../Schemas/Refund.js";
import ReserveHold from "../Schemas/ReserveHold.js";
import { freezeForComplaint, releaseOnResolution } from "../Utils/complaintFreeze.js";
import { getRefundPolicy, withinComplaintWindow } from "../Utils/refundPolicy.js";
import { getReportCategories, isValidCategory } from "../Utils/reportCategories.js";
import { writeAuditLog } from "../Utils/audit.js";
import { notify } from "./notificationService.js";
import { broadcastAdminUnreadCounts } from "../Controllers/adminNotificationController.js";
import { getIo } from "../Utils/ioAccess.js";

/**
 * Internal Complaint & Report Service
 * Reuses central complaint lifecycle logic for both new complaint API and legacy report API.
 * Solves the legacy "resolved" enum status issue by mapping legacy resolutions to schema-compliant
 * terminal states (resolved_refunded / resolved_no_refund) and releasing reserve holds atomically.
 */

const TERMINAL_STATUSES = ["resolved_refunded", "resolved_no_refund", "withdrawn", "expired"];

/**
 * Creates a complaint (report) with booking ownership check, complaint window check,
 * duplicate check, reserve freeze, notifications, and audit logging.
 */
export const createComplaintInternal = async ({
  customerId,
  bookingId,
  bookingType = "service",
  complaint,
  image,
  category = "quality_dispute",
  technicianId: explicitTechId,
  serviceId: explicitServiceId,
  productId: explicitProductId,
}) => {
  if (!bookingId || !complaint) {
    const err = new Error("bookingId and complaint are required");
    err.statusCode = 400;
    throw err;
  }
  if (!["service", "product"].includes(bookingType)) {
    const err = new Error("Invalid bookingType");
    err.statusCode = 400;
    throw err;
  }
  if (category && !isValidCategory(category)) {
    const err = new Error("Invalid category");
    err.statusCode = 400;
    throw err;
  }

  const BookingModel = bookingType === "product" ? ProductBooking : ServiceBooking;
  const booking = await BookingModel.findById(bookingId).lean();
  if (!booking) {
    const err = new Error("Booking not found");
    err.statusCode = 404;
    throw err;
  }

  const bookingOwnerId = bookingType === "product" ? (booking.customerId || booking.userId) : (booking.customerId || booking.userId);
  if (String(bookingOwnerId) !== String(customerId)) {
    const err = new Error("This booking does not belong to you");
    err.statusCode = 403;
    throw err;
  }

  if (bookingType === "service" && booking.status === "completed") {
    const policy = await getRefundPolicy();
    if (!withinComplaintWindow(booking.completedAt, policy)) {
      const err = new Error("COMPLAINT_WINDOW_CLOSED");
      err.statusCode = 409;
      throw err;
    }
  }

  const existingOpen = await Report.findOne({ bookingId, status: "open" }).lean();
  if (existingOpen) {
    const err = new Error("An open complaint already exists for this booking");
    err.statusCode = 409;
    throw err;
  }

  const technicianId = explicitTechId || booking.technicianId || null;
  const serviceId = explicitServiceId || (bookingType === "service" ? booking.serviceId : undefined);
  const productId = explicitProductId || (bookingType === "product" ? booking.productId : undefined);

  const report = await Report.create({
    bookingId,
    bookingType,
    productId,
    serviceId,
    technicianId,
    customerId,
    complaint,
    image: image || null,
    category: category || "quality_dispute",
    status: "open",
    slaDeadline: new Date(Date.now() + 24 * 3600 * 1000),
  });

  try {
    const freeze = await freezeForComplaint({
      bookingId,
      technicianId,
      reportId: report._id,
    });
    report.frozeReserve = freeze.frozeReserve;
    report.payoutBlocked = freeze.payoutBlocked;
    await report.save();
  } catch (freezeErr) {
    console.error("Complaint freeze error (non-fatal):", freezeErr.message);
  }

  // Safe notification dispatches
  try {
    await notify({
      eventType: "COMPLAINT_RECEIVED",
      recipientId: customerId,
      recipientType: "customer",
      data: { reportId: String(report._id), bookingId: String(bookingId) },
      source: { type: "report", id: String(report._id) },
      correlationId: String(report._id),
      idempotencyKey: `complaint:${report._id}:received:customer:${customerId}`,
    });

    if (technicianId) {
      await notify({
        eventType: "COMPLAINT_FILED_AGAINST_YOU",
        recipientId: technicianId,
        recipientType: "technician",
        data: { reportId: String(report._id), bookingId: String(bookingId) },
        source: { type: "report", id: String(report._id) },
        correlationId: String(report._id),
        idempotencyKey: `complaint:${report._id}:filed:technician:${technicianId}`,
      });
    }
  } catch (notifErr) {
    console.error("Notification dispatch error:", notifErr.message);
  }

  try {
    await writeAuditLog({
      action: "COMPLAINT_FILED",
      targetType: "Report",
      targetId: report._id,
      actor: customerId,
      actorRole: "Customer",
      after: { bookingId, category, frozeReserve: report.frozeReserve },
    });
  } catch (auditErr) {
    console.error("Audit log error:", auditErr.message);
  }

  // Broadcast real-time admin unread notification badge update
  broadcastAdminUnreadCounts(getIo());

  return report;
};

/**
 * Gets report categories.
 */
export const listReportCategoriesInternal = async () => {
  return getReportCategories();
};

/**
 * Gets complaints filed by customer.
 */
export const getMyReportsInternal = async (customerId) => {
  return Report.find({ customerId })
    .populate("serviceId", "serviceName")
    .populate("productId", "productName")
    .populate({
      path: "technicianId",
      populate: { path: "userId", select: "fname lname mobileNumber" },
    })
    .populate("refundId")
    .sort({ createdAt: -1 })
    .lean();
};

/**
 * Admin list complaints with optional status filter.
 */
export const adminListComplaintsInternal = async ({ status = "open", search }) => {
  const query = status === "all" ? {} : { status };
  if (search) {
    query.$or = [{ complaint: { $regex: search, $options: "i" } }];
  }
  return Report.find(query)
    .populate("serviceId", "serviceName")
    .populate("productId", "productName")
    .populate("customerId", "fname lname email mobileNumber")
    .populate({
      path: "technicianId",
      populate: { path: "userId", select: "fname lname mobileNumber" },
    })
    .sort({ slaDeadline: 1, createdAt: -1 })
    .lean();
};

/**
 * Admin get complaint detail by ID with financial defaults & payment context.
 */
export const adminGetComplaintInternal = async (reportId) => {
  const report = await Report.findById(reportId)
    .populate("serviceId", "serviceName")
    .populate("productId", "productName")
    .populate("customerId", "fname lname email mobileNumber")
    .populate({
      path: "technicianId",
      populate: { path: "userId", select: "fname lname mobileNumber" },
    })
    .populate("refundId")
    .lean();

  if (!report) {
    const err = new Error("Complaint not found");
    err.statusCode = 404;
    throw err;
  }

  const BookingModel = report.bookingType === "product" ? ProductBooking : ServiceBooking;
  const booking = await BookingModel.findById(report.bookingId).lean();
  const holds = await ReserveHold.find({ bookingId: report.bookingId }).lean();
  const payment = await Payment.findOne({
    $or: [{ bookingId: report.bookingId }, { providerOrderId: booking?.providerOrderId || "" }]
  }).lean();

  // Compute recommended default refund and penalty amounts (in INR)
  let defaultRefundAmount = 0;
  if (payment) {
    const capturedPaise = payment.capturedAmountPaise ?? payment.totalAmountPaise ?? 0;
    const refundedPaise = payment.amountRefundedPaise ?? 0;
    defaultRefundAmount = Math.max(0, (capturedPaise - refundedPaise) / 100);
  } else if (booking) {
    defaultRefundAmount = booking.totalAmount || booking.totalPrice || booking.amount || booking.price || 0;
  }

  let defaultPenaltyAmount = 0;
  if (holds && holds.length > 0) {
    const totalHoldPaise = holds.reduce((acc, h) => acc + (h.amountPaise || 0), 0);
    defaultPenaltyAmount = totalHoldPaise / 100;
  } else {
    defaultPenaltyAmount = defaultRefundAmount;
  }

  return {
    report,
    booking,
    payment,
    reserveHolds: holds,
    defaults: {
      refundAmount: report.refundAmount > 0 ? report.refundAmount : defaultRefundAmount,
      penaltyAmount: report.penaltyAmount > 0 ? report.penaltyAmount : defaultPenaltyAmount,
      faultParty: report.faultParty || "technician",
    },
  };
};

/**
 * Admin updates complaint status with terminal transition release, custom refund/penalty amounts, notifications, and audit log.
 */
export const adminUpdateComplaintStatusInternal = async ({
  reportId,
  status,
  resolutionNote,
  refundId,
  refundAmount,
  penaltyAmount,
  faultParty,
  adminUser,
}) => {
  const ALLOWED = ["open", "under_review", "resolved_refunded", "resolved_no_refund", "withdrawn", "expired"];
  if (!ALLOWED.includes(status)) {
    const err = new Error("Invalid status");
    err.statusCode = 400;
    throw err;
  }

  const report = await Report.findById(reportId);
  if (!report) {
    const err = new Error("Complaint not found");
    err.statusCode = 404;
    throw err;
  }

  if (TERMINAL_STATUSES.includes(report.status) && report.status !== status) {
    const err = new Error("Complaint already resolved");
    err.statusCode = 409;
    throw err;
  }

  if (report.status === status) {
    return { report, noChange: true };
  }

  const prev = report.status;
  report.status = status;
  if (resolutionNote) report.resolutionNote = resolutionNote;
  if (refundId && mongoose.Types.ObjectId.isValid(refundId)) report.refundId = refundId;
  
  if (refundAmount !== undefined && refundAmount !== null) {
    report.refundAmount = Number(refundAmount) || 0;
  }
  if (penaltyAmount !== undefined && penaltyAmount !== null) {
    report.penaltyAmount = Number(penaltyAmount) || 0;
  }
  if (faultParty) {
    report.faultParty = faultParty;
  }

  if (status === "under_review") {
    await report.save();
    try {
      await notify({
        eventType: "COMPLAINT_UNDER_REVIEW",
        recipientId: report.customerId,
        recipientType: "customer",
        data: { reportId: String(report._id), status },
        source: { type: "report", id: String(report._id) },
        correlationId: String(report._id),
        idempotencyKey: `complaint:${report._id}:under_review:customer:${report.customerId}`,
      });
      await writeAuditLog({
        action: "COMPLAINT_UNDER_REVIEW",
        targetType: "Report",
        targetId: report._id,
        actor: adminUser?.userId || null,
        actorRole: adminUser?.role || "Admin",
        before: { status: prev },
        after: { status },
      });
    } catch (e) {
      console.error("Status update notification/audit error:", e.message);
    }
    return { report, noChange: false };
  }

  // If status is resolved_refunded and no refundId was provided, auto-trigger refund if payment exists
  if (status === "resolved_refunded" && !report.refundId) {
    try {
      const payment = await Payment.findOne({ bookingId: report.bookingId }).lean();
      if (payment) {
        const requestedPaise = (report.refundAmount > 0 ? report.refundAmount : ((payment.capturedAmountPaise ?? payment.totalAmountPaise) / 100)) * 100;
        const refundObj = await createRefund({
          paymentId: payment._id,
          requestedPaise,
          reason: resolutionNote || "Complaint resolved in customer favor",
          faultParty: faultParty || "technician",
          reportId: report._id,
          initiatedBy: adminUser?.userId,
        });
        if (refundObj && refundObj._id) {
          report.refundId = refundObj._id;
        }
      }
    } catch (autoRefundErr) {
      console.error("Auto refund creation error during complaint resolution:", autoRefundErr.message);
    }
  }

  // Terminal transition: release reserve hold & payout block
  report.reviewedBy = adminUser?.userId || null;
  report.reviewedAt = new Date();
  await report.save();

  try {
    await releaseOnResolution({ bookingId: report.bookingId, reportId: report._id });
  } catch (relErr) {
    console.error("Release on resolution error:", relErr.message);
  }

  const inFavour = status === "resolved_refunded";
  const resolvedEvent = inFavour ? "COMPLAINT_RESOLVED_IN_FAVOUR" : "COMPLAINT_REJECTED";

  try {
    await notify({
      eventType: resolvedEvent,
      recipientId: report.customerId,
      recipientType: "customer",
      data: { reportId: String(report._id), status, resolutionNote: report.resolutionNote, refundAmount: report.refundAmount },
      source: { type: "report", id: String(report._id) },
      correlationId: String(report._id),
      idempotencyKey: `complaint:${report._id}:resolved:customer:${report.customerId}`,
    });

    if (report.technicianId) {
      await notify({
        eventType: resolvedEvent,
        recipientId: report.technicianId,
        recipientType: "technician",
        data: { reportId: String(report._id), status, penaltyAmount: report.penaltyAmount },
        source: { type: "report", id: String(report._id) },
        correlationId: String(report._id),
        idempotencyKey: `complaint:${report._id}:resolved:technician:${report.technicianId}`,
      });
    }

    await writeAuditLog({
      action: "COMPLAINT_STATUS_UPDATED",
      targetType: "Report",
      targetId: report._id,
      actor: adminUser?.userId || null,
      actorRole: adminUser?.role || "Admin",
      before: { status: prev },
      after: {
        status,
        resolutionNote: report.resolutionNote,
        refundId: report.refundId,
        refundAmount: report.refundAmount,
        penaltyAmount: report.penaltyAmount,
        faultParty: report.faultParty,
      },
    });
  } catch (e) {
    console.error("Terminal resolution notify/audit error:", e.message);
  }

  return { report, noChange: false };
};

/**
 * Resolves legacy report (fixing the legacy "resolved" enum error by mapping to valid terminal enum).
 */
export const resolveLegacyReportInternal = async ({ reportId, inputStatus, resolutionNote, refundId, adminUser }) => {
  const report = await Report.findById(reportId);
  if (!report) {
    const err = new Error("Report not found");
    err.statusCode = 404;
    throw err;
  }

  // Map legacy "resolved" to schema-valid enum
  let targetStatus = "resolved_no_refund";
  if (inputStatus === "resolved_refunded" || refundId) {
    targetStatus = "resolved_refunded";
  } else if (inputStatus && inputStatus !== "resolved" && TERMINAL_STATUSES.includes(inputStatus)) {
    targetStatus = inputStatus;
  }

  const prev = report.status;
  report.status = targetStatus;
  if (resolutionNote) report.resolutionNote = resolutionNote;
  if (refundId && mongoose.Types.ObjectId.isValid(refundId)) report.refundId = refundId;
  if (adminUser?.userId) {
    report.reviewedBy = adminUser.userId;
    report.reviewedAt = new Date();
  }

  await report.save();

  try {
    await releaseOnResolution({ bookingId: report.bookingId, reportId: report._id });
  } catch (relErr) {
    console.error("Release reserve error on legacy resolve:", relErr.message);
  }

  try {
    await writeAuditLog({
      action: "COMPLAINT_STATUS_UPDATED",
      targetType: "Report",
      targetId: report._id,
      actor: adminUser?.userId || null,
      actorRole: adminUser?.role || "Admin",
      before: { status: prev },
      after: { status: targetStatus, resolutionNote: report.resolutionNote },
    });
  } catch (e) {
    console.error("Legacy resolve audit error:", e.message);
  }

  return report;
};

/**
 * Admin rejects a complaint.
 */
export const adminRejectComplaintInternal = async ({ reportId, reason, adminUser }) => {
  if (!reason) {
    const err = new Error("A rejection reason is required");
    err.statusCode = 400;
    throw err;
  }

  const report = await Report.findById(reportId);
  if (!report) {
    const err = new Error("Complaint not found");
    err.statusCode = 404;
    throw err;
  }

  if (report.status !== "open" && report.status !== "under_review") {
    const err = new Error("Complaint already resolved");
    err.statusCode = 409;
    throw err;
  }

  report.status = "resolved_no_refund";
  report.reviewedBy = adminUser.userId;
  report.reviewedAt = new Date();
  report.resolutionNote = reason;
  await report.save();

  try {
    await releaseOnResolution({ bookingId: report.bookingId, reportId: report._id });
  } catch (relErr) {
    console.error("Release reserve error:", relErr.message);
  }

  try {
    await notify({
      eventType: "COMPLAINT_REJECTED",
      recipientId: report.customerId,
      recipientType: "customer",
      data: { reportId: String(report._id), resolutionNote: reason },
      source: { type: "report", id: String(report._id) },
      correlationId: String(report._id),
      idempotencyKey: `complaint:${report._id}:reject:customer:${report.customerId}`,
    });

    if (report.technicianId) {
      await notify({
        eventType: "COMPLAINT_RESOLVED_IN_FAVOUR",
        recipientId: report.technicianId,
        recipientType: "technician",
        data: { reportId: String(report._id) },
        source: { type: "report", id: String(report._id) },
        correlationId: String(report._id),
        idempotencyKey: `complaint:${report._id}:reject:technician:${report.technicianId}`,
      });
    }

    await writeAuditLog({
      action: "COMPLAINT_REJECTED",
      targetType: "Report",
      targetId: report._id,
      actor: adminUser.userId,
      actorRole: adminUser.role,
      after: { reason },
    });
  } catch (e) {
    console.error("Reject complaint notify/audit error:", e.message);
  }

  return report;
};

/**
 * Customer withdraws an active complaint (open/under_review).
 * Terminal complaints (resolved/withdrawn/expired) CANNOT be withdrawn.
 */
export const customerWithdrawComplaintInternal = async ({ customerId, reportId, reason }) => {
  const report = await Report.findById(reportId);
  if (!report) {
    const err = new Error("Complaint not found");
    err.statusCode = 404;
    throw err;
  }

  if (String(report.customerId) !== String(customerId)) {
    const err = new Error("This complaint does not belong to you");
    err.statusCode = 403;
    throw err;
  }

  if (TERMINAL_STATUSES.includes(report.status)) {
    const err = new Error(`Cannot withdraw complaint in terminal state (${report.status})`);
    err.statusCode = 409;
    throw err;
  }

  const prevStatus = report.status;
  report.status = "withdrawn";
  report.withdrawnAt = new Date();
  report.withdrawalReason = reason || "Customer withdrew complaint";
  await report.save();

  // 🔒 Multi-complaint guarded release of financial hold
  try {
    await releaseOnResolution({ bookingId: report.bookingId, reportId: report._id });
  } catch (relErr) {
    console.error("Release reserve error on withdrawal:", relErr.message);
  }

  try {
    if (report.technicianId) {
      await notify({
        eventType: "COMPLAINT_WITHDRAWN",
        recipientId: report.technicianId,
        recipientType: "technician",
        data: { reportId: String(report._id), bookingId: String(report.bookingId) },
        source: { type: "report", id: String(report._id) },
        correlationId: String(report._id),
        idempotencyKey: `complaint:${report._id}:withdrawn:technician:${report.technicianId}`,
      });
    }

    await writeAuditLog({
      action: "COMPLAINT_WITHDRAWN",
      targetType: "Report",
      targetId: report._id,
      actor: customerId,
      actorRole: "Customer",
      before: { status: prevStatus },
      after: { status: "withdrawn", withdrawalReason: report.withdrawalReason },
    });
  } catch (e) {
    console.error("Withdrawal notify/audit error:", e.message);
  }

  broadcastAdminUnreadCounts(getIo());

  return report;
};

/**
 * Technician lists complaints filed against them.
 */
export const technicianListMyComplaintsInternal = async (technicianProfileId) => {
  if (!technicianProfileId) return [];
  return Report.find({ technicianId: technicianProfileId })
    .populate("serviceId", "serviceName")
    .populate("productId", "productName")
    .populate("customerId", "fname lname mobileNumber")
    .sort({ createdAt: -1 })
    .lean();
};

/**
 * Technician gets detailed complaint dossier filed against them.
 */
export const technicianGetComplaintDetailInternal = async ({ technicianProfileId, reportId }) => {
  const report = await Report.findById(reportId)
    .populate("serviceId", "serviceName")
    .populate("productId", "productName")
    .populate("customerId", "fname lname mobileNumber")
    .lean();

  if (!report) {
    const err = new Error("Complaint not found");
    err.statusCode = 404;
    throw err;
  }

  if (String(report.technicianId) !== String(technicianProfileId)) {
    const err = new Error("Access denied — this complaint is not associated with your profile");
    err.statusCode = 403;
    throw err;
  }

  const BookingModel = report.bookingType === "product" ? ProductBooking : ServiceBooking;
  const booking = await BookingModel.findById(report.bookingId).lean();
  return { report, booking };
};

/**
 * Technician submits response/explanation & evidence images for a complaint.
 */
export const technicianRespondToComplaintInternal = async ({ technicianProfileId, reportId, response, images = [] }) => {
  if (!response || !response.trim()) {
    const err = new Error("A written explanation is required");
    err.statusCode = 400;
    throw err;
  }

  const report = await Report.findById(reportId);
  if (!report) {
    const err = new Error("Complaint not found");
    err.statusCode = 404;
    throw err;
  }

  if (String(report.technicianId) !== String(technicianProfileId)) {
    const err = new Error("Access denied — this complaint is not associated with your profile");
    err.statusCode = 403;
    throw err;
  }

  if (TERMINAL_STATUSES.includes(report.status)) {
    const err = new Error("Cannot submit response for a resolved or closed complaint");
    err.statusCode = 409;
    throw err;
  }

  report.technicianResponse = response.trim();
  if (Array.isArray(images) && images.length > 0) {
    report.technicianImages = images;
  }
  report.technicianRespondedAt = new Date();
  await report.save();

  try {
    await notify({
      eventType: "TECHNICIAN_RESPONSE_RECEIVED",
      recipientId: report.customerId,
      recipientType: "customer",
      data: { reportId: String(report._id), bookingId: String(report.bookingId) },
      source: { type: "report", id: String(report._id) },
      correlationId: String(report._id),
      idempotencyKey: `complaint:${report._id}:tech_responded:customer:${report.customerId}`,
    });

    await writeAuditLog({
      action: "COMPLAINT_TECHNICIAN_RESPONDED",
      targetType: "Report",
      targetId: report._id,
      actor: technicianProfileId,
      actorRole: "Technician",
      after: { technicianResponse: report.technicianResponse, imageCount: report.technicianImages?.length || 0 },
    });
  } catch (e) {
    console.error("Technician response notify/audit error:", e.message);
  }

  broadcastAdminUnreadCounts(getIo());

  return report;
};

/**
 * Technician get refund history.
 */
export const technicianGetMyRefundsInternal = async (technicianProfileId) => {
  return Refund.find({ technicianId: technicianProfileId })
    .sort({ createdAt: -1 })
    .select("netRefundPaise clawbackAppliedPaise clawbackFromReservePaise clawbackToDuesPaise status reason faultParty createdAt")
    .lean();
};
