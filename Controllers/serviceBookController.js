import ServiceBooking from "../Schemas/ServiceBooking.js";
import JobBroadcast from "../Schemas/TechnicianBroadcast.js";
import ProductBooking from "../Schemas/ProductBooking.js";
import TechnicianProfile from "../Schemas/TechnicianProfile.js";
import TechnicianBookingOffer from "../Schemas/TechnicianBookingOffer.js";
import WalletTransaction from "../Schemas/WalletTransaction.js";
import Service from "../Schemas/Service.js";
import Address from "../Schemas/Address.js";
import mongoose from "mongoose";
import { broadcastJobToTechnicians } from "../Utils/sendNotification.js";
import { notifyCustomerJobAccepted } from "../Utils/sendNotification.js";
import { broadcastPendingJobsToTechnician, findEligibleTechniciansForService } from "../Utils/technicianMatching.js";
import { findNearbyTechnicians } from "../Utils/findNearbyTechnicians.js";
import { settleBookingEarningsIfEligible } from "../Utils/settlement.js";
import { matchAndBroadcastBooking } from "../Utils/technicianMatching.js";
import { resolveUserLocation } from "../Utils/resolveUserLocation.js";
import { resolveZoneFromCoordinates } from "../Utils/resolveZoneFromCoordinates.js";
import ZoneServiceMapping from "../Schemas/ZoneServiceMapping.js";
import BookingOutbox from "../Schemas/BookingOutbox.js";
import DispatchOutbox from "../Schemas/DispatchOutbox.js";
import { checkTechnicianActivation } from "../Utils/technicianActivation.js";
import { canTransition, normalizeBookingStatus } from "../Utils/bookingStatus.js";
import { resolveCommissionSnapshot } from "../Utils/commission.js";
import { paiseToRupees, percentageOf, toPaise, isPayableTotalPaise } from "../Utils/money.js";
import { toBookingCreatedDTO, toBookingCancelledDTO } from "../Utils/socketDTO.js";
import { notifyCustomerOfRebroadcast } from "../Utils/sendReminder.js";
import {
  resolveScheduleInput,
  resolveServiceZoneAvailability,
  buildServiceBookingDoc,
  createBookingAndOutbox,
  broadcastCreatedBooking,
} from "../Utils/bookingService.js";
import { getBookingSchedulePayload } from "../Utils/slots.js";
import { getReacceptPenaltyPercent } from "./adminSettingsController.js";

const toNumber = value => {
  const num = Number(value);
  return Number.isNaN(num) ? NaN : num;
};


const toFiniteNumber = (v) => {
  if (v === null || v === undefined) return null;
  if (typeof v === "string" && v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export const createBooking = async (req, res) => {
  try {
    if (req.user?.role !== "Customer") {
      return res.status(403).json({ success: false, message: "Customer access only", result: {} });
    }
    if (!req.user.userId || !mongoose.Types.ObjectId.isValid(req.user.userId)) {
      return res.status(401).json({ success: false, message: "Invalid token user", result: {} });
    }
    const customerId = req.user.userId;

    const { serviceId, baseAmount } = req.body;
    const radiusInput = toFiniteNumber(req.body?.radius);
    const addressId = typeof req.body?.addressId === "string" ? req.body.addressId.trim() : req.body?.addressId;
    const addressLineInput = typeof req.body?.addressLine === "string" ? req.body.addressLine.trim() : "";

    const latInput =
      req.body?.latitude !== undefined
        ? toFiniteNumber(req.body.latitude)
        : toFiniteNumber(req.body?.location?.latitude);
    const lngInput =
      req.body?.longitude !== undefined
        ? toFiniteNumber(req.body.longitude)
        : toFiniteNumber(req.body?.location?.longitude);
    const hasCoords = latInput !== null && lngInput !== null;

    // ─── Booking type & scheduled time ───────────────────────────────
    const bookingType = req.body?.bookingType === "scheduled" ? "scheduled" : "instant";

    let finalScheduledAt = null;

    if (bookingType === "scheduled") {
      // Must provide scheduledDate (YYYY-MM-DD) + scheduledTime (HH:MM)
      const { scheduledDate, scheduledTime } = req.body;
      if (!scheduledDate || !scheduledTime) {
        return res.status(400).json({
          success: false,
          message: "scheduledDate (YYYY-MM-DD) and scheduledTime (HH:MM) are required for scheduled bookings",
          result: {},
        });
      }

      // Combine → ISO datetime
      const combined = new Date(`${scheduledDate}T${scheduledTime}:00`);
      if (isNaN(combined.getTime())) {
        return res.status(400).json({
          success: false,
          message: "Invalid scheduledDate or scheduledTime format",
          result: {},
        });
      }

      // Must be at least 30 minutes in the future
      const minFuture = new Date(Date.now() + 30 * 60 * 1000);
      if (combined <= minFuture) {
        return res.status(400).json({
          success: false,
          message: "Scheduled time must be at least 30 minutes in the future",
          result: {},
        });
      }

      finalScheduledAt = combined;
    } else {
      // Instant: use provided scheduledAt OR null
      finalScheduledAt = req.body?.scheduledAt ? new Date(req.body.scheduledAt) : null;
    }

    // ─── VALIDATE SCHEDULE WINDOW (TOMORROW/DAY AFTER ONLY) ──────────
    if (bookingType === "scheduled" && finalScheduledAt) {
      const now = new Date();
      const minFuture = new Date(now.getTime() + 5 * 60 * 1000); // 5 mins grace

      if (finalScheduledAt < minFuture) {
        return res.status(400).json({
          success: false,
          message: "Selected time has passed. Please refresh the schedule and try again.",
          result: {},
        });
      }

      const tomorrowStart = new Date(now);
      tomorrowStart.setDate(tomorrowStart.getDate() + 1);
      tomorrowStart.setHours(0, 0, 0, 0);

      const dayAfterEnd = new Date(now);
      dayAfterEnd.setDate(dayAfterEnd.getDate() + 2);
      dayAfterEnd.setHours(23, 59, 59, 999);

      if (finalScheduledAt < tomorrowStart || finalScheduledAt > dayAfterEnd) {
        return res.status(400).json({
          success: false,
          message: "Scheduled bookings are only allowed for Tomorrow or Day after Tomorrow. Please refresh slots.",
          result: {
            tomorrow: tomorrowStart.toISOString().split("T")[0],
            dayAfter: dayAfterEnd.toISOString().split("T")[0]
          },
        });
      }
    }
    // ─────────────────────────────────────────────────────────────────

    if (!serviceId || baseAmount == null || (!req.body?.address && !addressId && !addressLineInput && !hasCoords)) {
      return res.status(400).json({
        success: false,
        message: "All fields required",
        result: {},
      });
    }

    if (!mongoose.Types.ObjectId.isValid(serviceId)) {
      return res.status(400).json({ success: false, message: "Invalid serviceId format", result: {} });
    }

    const baseAmountNum = toNumber(baseAmount);
    if (Number.isNaN(baseAmountNum) || baseAmountNum < 0) {
      return res.status(400).json({ success: false, message: "baseAmount must be a non-negative number", result: {} });
    }

    const service = await Service.findById(serviceId);
    if (!service || !service.isActive) {
      return res.status(404).json({ success: false, message: "Service not found or inactive", result: {} });
    }

    const resolvedLocation = await resolveUserLocation({
      locationType: req.body.locationType,
      addressId: req.body.addressId,
      latitude: req.body.latitude,
      longitude: req.body.longitude,
      userId: customerId,
    });

    if (!resolvedLocation.success) {
      return res.status(resolvedLocation.statusCode).json({
        success: false,
        message: resolvedLocation.message,
        result: {},
      });
    }

    // 🏘 ZONE RESOLUTION — resolve zone from customer coordinates and check service availability.
    let resolvedZoneId = null;
    if (resolvedLocation.latitude && resolvedLocation.longitude) {
      const { zone } = await resolveZoneFromCoordinates(
        resolvedLocation.latitude,
        resolvedLocation.longitude
      );
      if (zone) {
        resolvedZoneId = zone._id;
        // Check if service is approved in this zone
        const mapping = await ZoneServiceMapping.findOne({
          zoneId: zone._id,
          serviceId,
          active: true,
        }).lean();
        if (!mapping) {
          return res.status(400).json({
            success: false,
            message: "This service is not available in your area",
            result: {},
          });
        }
      }
    }

    // 💰 SERVER-SIDE SPLIT — commission on service amount only; GST separate;
    // tip (optional) passes through 100% to the technician.
    // The client can NEVER influence money fields: we take baseAmount/tip only
    // as hints and compute the canonical financial snapshot server-side.
    const snapshot = await resolveCommissionSnapshot({
      booking: { baseAmount: baseAmountNum, itemType: "service" },
      service,
      tipAmountRupees: toFiniteNumber(req.body?.tipAmount) || 0,
    });
    const commissionPct = snapshot.commissionPercentage;
    const commissionAmt = paiseToRupees(snapshot.commissionAmountPaise);
    const techAmt = paiseToRupees(snapshot.technicianAmountPaise);

    // 💸 Fail fast: online payments require a total of ₹0 (free) or at least ₹1.
    const snapshotTotalPaise = toPaise(snapshot.totalAmountPaise);
    if (!isPayableTotalPaise(snapshotTotalPaise)) {
      return res.status(400).json({
        success: false,
        message: `Minimum payable amount is ₹1 (booking total is ₹${(snapshotTotalPaise / 100).toFixed(2)})`,
        result: {},
      });
    }

    // Determine initial status (Production Atomic Flow)
    const now = new Date();
    let autoCancelAt = null;

    if (bookingType === "scheduled" && finalScheduledAt) {
      // Scheduled: Expire 5 hours BEFORE the slot (not after creation)
      autoCancelAt = new Date(finalScheduledAt.getTime() - 5 * 60 * 60 * 1000);
      // Safety: if the slot is less than 5h from now, expire immediately
      if (autoCancelAt <= now) autoCancelAt = new Date(now.getTime() + 5 * 60 * 1000);
    } else {
      // Instant: Expire 1 hour after creation
      autoCancelAt = new Date(now.getTime() + 1 * 60 * 60 * 1000);
    }

    const initialStatus = "pending";

    const bookingDoc = {
      customerId,
      serviceId,
      bookingType: bookingType === "scheduled" ? "schedule" : "instant", // Align with schema enum
      baseAmount: baseAmountNum,
      financialSnapshot: snapshot,
      locationType: resolvedLocation.locationType,
      addressSnapshot: resolvedLocation.addressSnapshot,
      address: resolvedLocation.addressSnapshot.addressLine || "Pinned Location",
      commissionPercentage: commissionPct,
      commissionAmount: commissionAmt,
      technicianAmount: techAmt,
      gstPercentage: snapshot.gstPercentage,
      gstAmount: paiseToRupees(snapshot.gstAmountPaise),
      tipAmount: paiseToRupees(snapshot.tipAmountPaise),
      scheduledAt: finalScheduledAt,
      status: initialStatus,
      radius: radiusInput ?? 500,
      faultProblem: typeof req.body?.faultProblem === "string" ? req.body.faultProblem.trim() : null,
      location: {
        type: "Point",
        coordinates: [resolvedLocation.longitude, resolvedLocation.latitude],
      },
      broadcastStartedAt: now,
      autoCancelAt: autoCancelAt,
      retryCount: 0,
      technicianRejectCount: 0,
      cityZoneId: resolvedZoneId,
    };

    if (resolvedLocation.addressId) {
      bookingDoc.addressId = resolvedLocation.addressId;
    }

    const booking = await ServiceBooking.create(bookingDoc);

    // 🚀 Socket.IO Emission — room-scoped DTO ONLY (Socket Analysis B1.1).
    // The raw booking doc must NEVER be broadcast globally: it contains
    // customer PII (phone, exact address, amounts).
    if (req.io) {
      req.io.to("admin_dashboard").emit("new_booking", toBookingCreatedDTO(booking));
    }

    // 🚀 Immediate Broadcast for searching status
    const broadcastResult = await matchAndBroadcastBooking(booking._id, req.io);

    const schedMsg = bookingType === "scheduled"
      ? `Booking scheduled for ${finalScheduledAt.toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: true })}`
      : (broadcastResult.count > 0 ? "Booking created & broadcasted" : "Booking created (no technicians available yet)");

    return res.status(201).json({
      success: true,
      message: schedMsg,
      result: {
        booking,
        broadcastCount: broadcastResult.count ?? 0,
        status: initialStatus,
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message,
      result: { error: error.message },
    });
  }
};

/* ================= STORE BOOKING SCHEDULE (DEDICATED) ================= */
export const storeBookingSchedule = async (req, res) => {
  try {
    if (req.user?.role !== "Customer") {
      return res.status(403).json({ success: false, message: "Customer access only", result: {} });
    }

    const { serviceId, faultProblem, addressId, locationType, latitude, longitude } = req.body;

    // ─── Schedule resolution (timezone-safe, same utility as GET /slots) ──
    const schedule = resolveScheduleInput(req.body);
    if (schedule.error) {
      return res.status(400).json({ success: false, message: schedule.error, result: {} });
    }

    if (!serviceId) {
      return res.status(400).json({ success: false, message: "serviceId is required", result: {} });
    }

    if (!mongoose.Types.ObjectId.isValid(serviceId)) {
      return res.status(400).json({ success: false, message: "Invalid serviceId", result: {} });
    }

    const service = await Service.findById(serviceId);
    if (!service) {
      return res.status(404).json({ success: false, message: "Service not found", result: {} });
    }
    if (!service.isActive) {
      return res.status(400).json({ success: false, message: "Service is not active", result: {} });
    }

    const resolvedLocation = await resolveUserLocation({
      locationType: locationType || (addressId ? "saved" : "gps"),
      addressId: addressId,
      latitude: latitude,
      longitude: longitude,
      userId: req.user.userId,
    });

    if (!resolvedLocation.success) {
      return res.status(resolvedLocation.statusCode).json({
        success: false,
        message: resolvedLocation.message,
        result: {},
      });
    }

    // ─── Zone availability (zone-restricted services need an active mapping) ─
    const zoneCheck = await resolveServiceZoneAvailability({
      service,
      latitude: resolvedLocation.latitude,
      longitude: resolvedLocation.longitude,
    });
    if (!zoneCheck.ok) {
      return res.status(400).json({ success: false, message: zoneCheck.error, result: {} });
    }

    // ─── Build immutable financial snapshot + booking doc (server-side) ────
    const doc = await buildServiceBookingDoc({
      service,
      resolvedLocation,
      schedule,
      tipAmountRupees: toFiniteNumber(req.body?.tipAmount) || 0,
      customerId: req.user.userId,
      faultProblem: faultProblem || null,
      cityZoneId: zoneCheck.zoneId,
    });

    // 💸 Fail fast: online payments require a total of ₹0 (free) or at least ₹1.
    const docTotalPaise = toPaise(doc.financialSnapshot?.totalAmountPaise);
    if (!isPayableTotalPaise(docTotalPaise)) {
      return res.status(400).json({
        success: false,
        message: `Minimum payable amount is ₹1 (booking total is ₹${(docTotalPaise / 100).toFixed(2)})`,
        result: {},
      });
    }

    // ─── Booking + outbox in one transaction ──────────────────────────────
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      const { booking } = await createBookingAndOutbox({ doc, session });
      await session.commitTransaction();

      // Broadcast ONLY after commit (inline fast path; outbox worker retries)
      const broadcastResult = await broadcastCreatedBooking(booking._id, req.io);

      const dispDate = schedule.scheduledAt
        ? schedule.scheduledAt.toLocaleString("en-IN", {
            day: "2-digit", month: "short", year: "numeric",
            hour: "2-digit", minute: "2-digit", hour12: true,
          })
        : null;

      return res.status(201).json({
        success: true,
        message: schedule.bookingType === "schedule"
          ? `Booking scheduled for ${dispDate}. We're finding you a technician now.`
          : "Booking created and broadcasted successfully",
        result: {
          bookingId: booking._id,
          bookingType: schedule.bookingType === "schedule" ? "scheduled" : "instant",
          status: "pending",
          scheduledAt: booking.scheduledAt,
          scheduledDateLocal: booking.scheduledDateLocal,
          scheduledTimeLocal: booking.scheduledTimeLocal,
          timezone: booking.timezone,
          broadcastCount: broadcastResult.count ?? 0,
        },
      });
    } catch (txError) {
      await session.abortTransaction();
      throw txError;
    } finally {
      session.endSession();
    }

  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message,
      result: { error: error.message },
    });
  }
};



/* ================= GET BOOKING SCHEDULE ================= */
export const getBookingSchedule = async (req, res) => {
  try {
    return res.status(200).json({
      success: true,
      message: "Booking schedule options",
      result: getBookingSchedulePayload(),
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message,
      result: { error: error.message },
    });
  }
};


/* =====================================================
   GET BOOKINGS (ROLE BASED)
===================================================== */

// Customers must NEVER see the platform margin or technician earnings.
// Strip commission/technician-amount fields from a booking before it goes
// to a Customer (technicians & admins legitimately need them).
const stripSensitiveFinancials = (booking) => {
  const o = booking.toObject ? booking.toObject() : { ...booking };
  if (o.financialSnapshot) {
    delete o.financialSnapshot.commissionAmountPaise;
    delete o.financialSnapshot.commissionPercentage;
    delete o.financialSnapshot.commissionRuleSource;
    delete o.financialSnapshot.commissionRuleId;
    delete o.financialSnapshot.commissionOverridden;
  }
  delete o.technicianAmount;
  delete o.technicianAmountPaise;
  delete o.commissionAmount;
  delete o.commissionPercentage;
  delete o.commissionOverridden;
  return o;
};

export const getBookings = async (req, res) => {
  try {
    let filter = {};

    if (req.user.role === "Customer") {
      if (!req.user.userId || !mongoose.Types.ObjectId.isValid(req.user.userId)) {
        return res.status(401).json({ success: false, message: "Invalid token user", result: {} });
      }
      filter.customerId = req.user.userId;
    }

    if (req.user.role === "Technician") {
      const technicianProfileId = req.user?.technicianProfileId;
      if (!technicianProfileId || !mongoose.Types.ObjectId.isValid(technicianProfileId)) {
        return res.status(401).json({ success: false, message: "Invalid token profile", result: {} });
      }
      filter.technicianId = technicianProfileId;
    }

    // For Admin/Owner: no filter, shows all bookings (intended — admins see all).
    // For Customer/Technician: filtered by their ID (data isolation).

    const bookings = await ServiceBooking.find(filter)
      .populate("customerId", "fname lname mobileNumber email")
      .populate("serviceId", "serviceName serviceType serviceCost")
      .populate({
        path: "technicianId",
        select: "userId profileImage workStatus",
        populate: {
          path: "userId",
          select: "fname lname mobileNumber"
        }
      })
      .sort({ createdAt: -1 });

    const result =
      req.user.role === "Customer"
        ? bookings.map(stripSensitiveFinancials)
        : bookings;

    return res.status(200).json({
      success: true,
      message: "Bookings fetched successfully",
      result,
    });
  } catch (error) {
    console.error("getBookings:", error);
    return res.status(500).json({
      success: false,
      message: error.message,
      result: { error: error.message },
    });
  }
};

/* =====================================================
   GET BOOKING FOR (CUSTOMER)
===================================================== */

export const getCustomerBookings = async (req, res) => {
  // 📦 STABLE RESPONSE CONTRACT — every path returns the exact same shape:
  //   { success: bool, message: string, result: array, meta: {totalCount, page, limit, filtersApplied} }
  // `result` is ALWAYS an array (empty on error) — never {} / {error} / null,
  // so client model parsing can never break.
  const envelope = (success, message, bookings = [], meta = {}) =>
    res.status(200).json({
      success,
      message,
      result: bookings,
      meta: {
        totalCount: meta.totalCount ?? 0,
        page: meta.page ?? 1,
        limit: meta.limit ?? 20,
        filtersApplied: meta.filtersApplied ?? {
          filter: "all",
          status: "all",
          paymentStatus: "all",
          bookingType: "all",
          search: null,
        },
      },
    });

  try {
    if (req.user?.role !== "Customer") {
      return envelope(false, "Customer access only");
    }
    if (!req.user.userId || !mongoose.Types.ObjectId.isValid(req.user.userId)) {
      return envelope(false, "Invalid token user");
    }

    const { status, paymentStatus, bookingType, search, page, limit, filter: filterParam } = req.query;
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.max(1, Math.min(100, parseInt(limit, 10) || 20));
    const filtersApplied = {
      filter: filterParam || "all",
      status: status || "all",
      paymentStatus: paymentStatus || "all",
      bookingType: bookingType || "all",
      search: search || null,
    };
    const filter = { customerId: req.user.userId };

    // 1️⃣ Filter by Booking Status ("completed", "pending", "accepted", "in_progress", "cancelled", "active", "expired")
    if (status && typeof status === "string" && status.trim() !== "") {
      const trimmedStatus = status.trim().toLowerCase();
      if (trimmedStatus === "active") {
        filter.status = { $in: ["pending", "accepted", "on_the_way", "reached", "in_progress", "broadcasted"] };
      } else {
        filter.status = trimmedStatus;
      }
    }

    // 2️⃣ Filter by Payment Status ("paid", "unpaid", "pending", "refunded")
    if (paymentStatus && typeof paymentStatus === "string" && paymentStatus.trim() !== "") {
      const pStatus = paymentStatus.trim().toLowerCase();
      if (pStatus === "unpaid") {
        filter.paymentStatus = "pending";
      } else {
        filter.paymentStatus = pStatus;
      }
    }

    // 3️⃣ Filter by Booking Type ("instant", "schedule", "scheduled")
    if (bookingType && typeof bookingType === "string" && bookingType.trim() !== "") {
      const bType = bookingType.trim().toLowerCase();
      filter.bookingType = bType === "scheduled" ? "schedule" : bType;
    }

    // 3️⃣.5️⃣ Filter Tabs — friendly one-param filters for the "My Bookings" UI.
    // Takes precedence over status/paymentStatus above. Tab → query mapping:
    //   all              → no status filter
    //   completed_unpaid → status=completed + paymentStatus=pending
    //   paid             → paymentStatus=paid
    //   accepted         → accepted/on_the_way/reached/in_progress
    //   broadcasting     → pending/broadcasted (no tech yet)
    //   expired          → status=expired
    //   active           → any in-flight status + completed-but-unpaid
    const FILTER_TABS = {
      all: {},
      completed_unpaid: { status: "completed", paymentStatus: "pending" },
      paid: { paymentStatus: "paid" },
      accepted: {
        status: { $in: ["accepted", "on_the_way", "reached", "in_progress"] },
      },
      broadcasting: {
        status: { $in: ["pending", "broadcasted"] },
      },
      expired: { status: "expired" },
      active: {
        $or: [
          { status: { $in: ["pending", "broadcasted", "accepted", "on_the_way", "reached", "in_progress"] } },
          { status: "completed", paymentStatus: "pending" },
        ],
      },
    };

    if (filterParam && typeof filterParam === "string" && FILTER_TABS[filterParam.trim().toLowerCase()]) {
      const tab = FILTER_TABS[filterParam.trim().toLowerCase()];
      delete filter.status;
      delete filter.paymentStatus;
      if (tab.$or) {
        filter.$or = filter.$or ? [...filter.$or, ...tab.$or] : [...tab.$or];
      } else {
        Object.assign(filter, tab);
      }
    }

    // 4️⃣ Search Query (Searches address, fault notes, payment order ID, or booking ID)
    if (search && typeof search === "string" && search.trim().length >= 2) {
      const searchTerm = search.trim();
      const searchRegex = new RegExp(searchTerm, "i");
      const searchClauses = [
        { address: searchRegex },
        { faultProblem: searchRegex },
        { paymentOrderId: searchRegex },
      ];
      if (mongoose.Types.ObjectId.isValid(searchTerm)) {
        searchClauses.push({ _id: new mongoose.Types.ObjectId(searchTerm) });
      }
      // Merge with any $or already applied (e.g. the "active" tab)
      filter.$or = filter.$or ? [...filter.$or, ...searchClauses] : searchClauses;
    }

    // 5️⃣ Query Execution & Pagination
    const bookings = await ServiceBooking.find(filter)
      .populate("serviceId", "serviceName serviceType serviceCost serviceImages description discountedPrice")
      .populate({
        path: "technicianId",
        select: "userId profileImage workStatus ratingSummary",
        populate: {
          path: "userId",
          select: "fname lname mobileNumber"
        }
      })
      .sort({ createdAt: -1 })
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum);

    const totalCount = await ServiceBooking.countDocuments(filter);

    // Never expose platform commission / technician earnings to the customer.
    const safeBookings = bookings.map(stripSensitiveFinancials);

    return envelope(true, totalCount > 0 ? "Customer booking history" : "No bookings found", safeBookings, {
      totalCount,
      page: pageNum,
      limit: limitNum,
      filtersApplied,
    });
  } catch (err) {
    console.error("getCustomerBookings Error:", err);
    // Never break the client — same envelope, empty result, message only.
    return envelope(false, "Failed to fetch bookings. Please try again.");
  }
};

/* =====================================================
   GET JOB FOR (TECHNICIAN)
===================================================== */

export const getTechnicianJobHistory = async (req, res) => {
  try {
    if (req.user?.role !== "Technician") {
      return res.status(403).json({
        success: false,
        message: "Access denied",
        result: {},
      });
    }

    const technicianProfileId = req.user?.technicianProfileId;
    if (!technicianProfileId) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
        result: {},
      });
    }

    const technicianId = req.technician._id;
    const userId = req.technician.userId;
    // Check technician activation status
    const activation = await checkTechnicianActivation(technicianProfileId);
    if (!activation.isActive) {
      return res.status(200).json({
        success: true,
        message: activation.message,
        result: [],
      });
    }

    const jobs = await ServiceBooking.find({
      technicianId: { $in: [technicianId, userId] },
      status: { $in: ["completed", "cancelled"] },
    })
      .populate("customerId", "fname lname mobileNumber email")
      .populate({
        path: "serviceId",
        populate: { path: "categoryId" }
      })
      .sort({ updatedAt: -1 });

    // Remove baseAmount and add technicianAmount from service
    const filteredJobs = jobs.map(job => {
      const jobData = job.toObject ? job.toObject() : job;
      const { baseAmount, ...jobWithoutBaseAmount } = jobData;
      // Ensure technicianAmount is from service
      return {
        ...jobWithoutBaseAmount,
        technicianAmount: jobData.serviceId?.technicianAmount || jobData.technicianAmount || 0,
      };
    });

    return res.status(200).json({
      success: true,
      message: "Job history fetched",
      result: filteredJobs,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message,
      result: { error: err.message },
    });
  }
};


/* =====================================================
   GET CURRENT JOBS (TECHNICIAN & OWNER)
===================================================== */
export const getTechnicianCurrentJobs = async (req, res) => {
  try {
    const userRole = req.user?.role;

    // Validate role access
    if (userRole !== "Technician" && userRole !== "Owner") {
      return res.status(403).json({
        success: false,
        message: "Access denied. Technician or Owner access only.",
        result: {},
      });
    }


    const query = {};

    // For Technician, we get profileId from token. For Owner, we return all current jobs.
    if (userRole === "Technician") {
      // Technician: Only their own jobs
      const technicianProfileId = req.user?.technicianProfileId;
      if (!technicianProfileId) {
        return res.status(401).json({
          success: false,
          message: "Unauthorized. Technician profile not found.",
          result: {},
        });
      }

      // Check technician activation status
      const activation = await checkTechnicianActivation(technicianProfileId);
      if (!activation.isActive) {
        return res.status(200).json({
          success: true,
          message: activation.message,
          result: [],
        });
      }

      query.technicianId = technicianProfileId;
    }
    // If role is Owner: no additional filter, get all current jobs

    const jobs = await ServiceBooking.find({
      ...query,
      status: { $in: ["accepted", "ACCEPTED", "on_the_way", "reached", "in_progress"] },
    })
      .populate({
        path: "customerId",
        select: "fname lname mobileNumber email",
      })
      .populate({
        path: "technicianId",
        populate: {
          path: "userId",
          select: "fname lname mobileNumber email",
        },
        select: "userId profileImage locality workStatus",
      })
      .populate({
        path: "addressId",
        select: "name phone addressLine city state pincode latitude longitude",
      })
      .populate({
        path: "serviceId",
        populate: { path: "categoryId" }
      })
      .sort({ createdAt: -1 });

    // Format response for better readability
    const formattedJobs = jobs.map((job) => {
      const jobObj = job.toObject();

      // Format customer details
      const customer = jobObj.customerId
        ? {
          fname: jobObj.customerId.fname || "",
          lname: jobObj.customerId.lname || "",
          mobileNumber: jobObj.customerId.mobileNumber || "",
          email: jobObj.customerId.email || "",
        }
        : null;

      // Format technician details
      const technician = jobObj.technicianId
        ? {
          fname: jobObj.technicianId.userId?.fname || "",
          lname: jobObj.technicianId.userId?.lname || "",
          mobileNumber: jobObj.technicianId.userId?.mobileNumber || "",
          email: jobObj.technicianId.userId?.email || "",
          profileImage: jobObj.technicianId.profileImage || null,
          locality: jobObj.technicianId.locality || "",
          workStatus: jobObj.technicianId.workStatus || "",
        }
        : null;

      // Format service details
      const service = jobObj.serviceId || null;

      // Format address details
      let address = null;
      if (jobObj.addressId) {
        address = {
          name: jobObj.addressId.name || "",
          phone: jobObj.addressId.phone || "",
          addressLine: jobObj.addressId.addressLine || "",
          city: jobObj.addressId.city || "",
          state: jobObj.addressId.state || "",
          pincode: jobObj.addressId.pincode || "",
          //sk
          latitude: jobObj.addressId.latitude,
          longitude: jobObj.addressId.longitude,
        };
      } else if (jobObj.addressSnapshot) {
        address = {
          name: jobObj.addressSnapshot.name || "",
          phone: jobObj.addressSnapshot.phone || "",
          addressLine: jobObj.addressSnapshot.addressLine || "",
          city: jobObj.addressSnapshot.city || "",
          state: jobObj.addressSnapshot.state || "",
          pincode: jobObj.addressSnapshot.pincode || "",
          latitude: jobObj.addressSnapshot.latitude,
          longitude: jobObj.addressSnapshot.longitude,
        };
      }

      // Fallback to GeoJSON if needed
      if (address && (!address.latitude || !address.longitude) && jobObj.location?.coordinates) {
        address.longitude = jobObj.location.coordinates[0];
        address.latitude = jobObj.location.coordinates[1];
      }

      const responseData = {
        jobId: jobObj._id,
        status: normalizeBookingStatus(jobObj.status),
        customer,
        technician,
        service,
        address,
        scheduledAt: jobObj.scheduledAt,
        createdAt: jobObj.createdAt,
        acceptedAt: jobObj.assignedAt,
        paymentStatus: jobObj.paymentStatus,
      };

      // Only include baseAmount for Owner role
      if (userRole !== "Technician") {
        responseData.baseAmount = jobObj.baseAmount;
      } else {
        responseData.technicianAmount = jobObj.serviceId?.technicianAmount || jobObj.technicianAmount || 0;
      }

      return responseData;
    });

    return res.status(200).json({
      success: true,
      message: `Active jobs fetched for ${userRole}`,
      result: formattedJobs,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message,
      result: { error: err.message },
    });
  }
};


/* =====================================================
   GET ALL ACCEPTED JOBS (TECHNICIAN & OWNER)
   Status: accepted → in_progress, newest first.
   Technician → own jobs. Owner/Admin → all jobs (optional technicianId).
===================================================== */
export const getAllAcceptedJobs = async (req, res) => {
  try {
    const userRole = req.user?.role;
    if (userRole !== "Technician" && userRole !== "Owner" && userRole !== "Admin") {
      return res.status(403).json({
        success: false,
        message: "Access denied. Technician/Owner/Admin access only.",
        result: {},
      });
    }

    const query = { status: { $in: ["accepted", "on_the_way", "reached", "in_progress"] } };

    if (userRole === "Technician") {
      const technicianProfileId = req.user?.technicianProfileId;
      if (!technicianProfileId) {
        return res.status(401).json({
          success: false,
          message: "Unauthorized. Technician profile not found.",
          result: {},
        });
      }
      query.technicianId = technicianProfileId;
    } else if (req.query.technicianId) {
      if (!mongoose.Types.ObjectId.isValid(req.query.technicianId)) {
        return res.status(400).json({ success: false, message: "Invalid technician ID", result: {} });
      }
      query.technicianId = req.query.technicianId;
    }

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 20));

    const [jobs, totalCount] = await Promise.all([
      ServiceBooking.find(query)
        .populate({ path: "customerId", select: "fname lname mobileNumber email" })
        .populate({
          path: "technicianId",
          populate: { path: "userId", select: "fname lname mobileNumber email" },
          select: "userId profileImage locality workStatus",
        })
        .populate({ path: "serviceId", populate: { path: "categoryId" } })
        .populate({ path: "addressId", select: "name phone addressLine city state pincode latitude longitude" })
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      ServiceBooking.countDocuments(query),
    ]);

    const formattedJobs = jobs.map((job) => {
      const jobObj = job.toObject();
      const customer = jobObj.customerId
        ? { fname: jobObj.customerId.fname || "", lname: jobObj.customerId.lname || "", mobileNumber: jobObj.customerId.mobileNumber || "", email: jobObj.customerId.email || "" }
        : null;
      const technician = jobObj.technicianId
        ? { fname: jobObj.technicianId.userId?.fname || "", lname: jobObj.technicianId.userId?.lname || "", mobileNumber: jobObj.technicianId.userId?.mobileNumber || "", email: jobObj.technicianId.userId?.email || "", profileImage: jobObj.technicianId.profileImage || null, locality: jobObj.technicianId.locality || "" }
        : null;
      const address = jobObj.addressId
        ? { name: jobObj.addressId.name || "", phone: jobObj.addressId.phone || "", addressLine: jobObj.addressId.addressLine || "", city: jobObj.addressId.city || "", state: jobObj.addressId.state || "", pincode: jobObj.addressId.pincode || "", latitude: jobObj.addressId.latitude, longitude: jobObj.addressId.longitude }
        : (jobObj.addressSnapshot || null);

      const responseData = {
        jobId: jobObj._id,
        bookingType: jobObj.bookingType,
        status: normalizeBookingStatus(jobObj.status),
        customer,
        technician,
        service: jobObj.serviceId || null,
        address,
        scheduledAt: jobObj.scheduledAt,
        createdAt: jobObj.createdAt,
        acceptedAt: jobObj.assignedAt,
        paymentStatus: jobObj.paymentStatus,
      };
      if (userRole !== "Technician") {
        responseData.baseAmount = jobObj.baseAmount;
        responseData.technicianAmount = jobObj.serviceId?.technicianAmount || jobObj.technicianAmount || 0;
      }
      return responseData;
    });

    return res.status(200).json({
      success: true,
      message: formattedJobs.length > 0 ? "Accepted jobs fetched" : "No accepted jobs found",
      result: formattedJobs,
      pagination: { page, limit, totalCount },
    });
  } catch (err) {
    console.error("getAllAcceptedJobs Error:", err);
    return res.status(500).json({ success: false, message: err.message, result: { error: err.message } });
  }
};

/* =====================================================
   GET ACCEPTED SCHEDULED JOBS (TECHNICIAN & OWNER)
   Status: accepted → in_progress, bookingType: schedule.
   Technician → own jobs. Owner/Admin → all jobs (optional technicianId).
===================================================== */
export const getAcceptedScheduledJobs = async (req, res) => {
  try {
    const userRole = req.user?.role;
    if (userRole !== "Technician" && userRole !== "Owner" && userRole !== "Admin") {
      return res.status(403).json({
        success: false,
        message: "Access denied. Technician/Owner/Admin access only.",
        result: {},
      });
    }

    const query = {
      bookingType: "schedule",
      status: { $in: ["accepted", "on_the_way", "reached", "in_progress"] },
    };

    if (userRole === "Technician") {
      const technicianProfileId = req.user?.technicianProfileId;
      if (!technicianProfileId) {
        return res.status(401).json({
          success: false,
          message: "Unauthorized. Technician profile not found.",
          result: {},
        });
      }
      query.technicianId = technicianProfileId;
    } else if (req.query.technicianId) {
      if (!mongoose.Types.ObjectId.isValid(req.query.technicianId)) {
        return res.status(400).json({ success: false, message: "Invalid technician ID", result: {} });
      }
      query.technicianId = req.query.technicianId;
    }

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 20));

    const [jobs, totalCount] = await Promise.all([
      ServiceBooking.find(query)
        .populate({ path: "customerId", select: "fname lname mobileNumber email" })
        .populate({
          path: "technicianId",
          populate: { path: "userId", select: "fname lname mobileNumber email" },
          select: "userId profileImage locality workStatus",
        })
        .populate({ path: "serviceId", populate: { path: "categoryId" } })
        .populate({ path: "addressId", select: "name phone addressLine city state pincode latitude longitude" })
        .sort({ scheduledAt: 1 })
        .skip((page - 1) * limit)
        .limit(limit),
      ServiceBooking.countDocuments(query),
    ]);

    const formattedJobs = jobs.map((job) => {
      const jobObj = job.toObject();
      const customer = jobObj.customerId
        ? { fname: jobObj.customerId.fname || "", lname: jobObj.customerId.lname || "", mobileNumber: jobObj.customerId.mobileNumber || "", email: jobObj.customerId.email || "" }
        : null;
      const technician = jobObj.technicianId
        ? { fname: jobObj.technicianId.userId?.fname || "", lname: jobObj.technicianId.userId?.lname || "", mobileNumber: jobObj.technicianId.userId?.mobileNumber || "", email: jobObj.technicianId.userId?.email || "", profileImage: jobObj.technicianId.profileImage || null, locality: jobObj.technicianId.locality || "" }
        : null;
      const address = jobObj.addressId
        ? { name: jobObj.addressId.name || "", phone: jobObj.addressId.phone || "", addressLine: jobObj.addressId.addressLine || "", city: jobObj.addressId.city || "", state: jobObj.addressId.state || "", pincode: jobObj.addressId.pincode || "", latitude: jobObj.addressId.latitude, longitude: jobObj.addressId.longitude }
        : (jobObj.addressSnapshot || null);

      const responseData = {
        jobId: jobObj._id,
        bookingType: jobObj.bookingType,
        status: normalizeBookingStatus(jobObj.status),
        customer,
        technician,
        service: jobObj.serviceId || null,
        address,
        scheduledAt: jobObj.scheduledAt,
        createdAt: jobObj.createdAt,
        acceptedAt: jobObj.assignedAt,
        paymentStatus: jobObj.paymentStatus,
      };
      if (userRole !== "Technician") {
        responseData.baseAmount = jobObj.baseAmount;
        responseData.technicianAmount = jobObj.serviceId?.technicianAmount || jobObj.technicianAmount || 0;
      }
      return responseData;
    });

    return res.status(200).json({
      success: true,
      message: formattedJobs.length > 0 ? "Accepted scheduled jobs fetched" : "No accepted scheduled jobs found",
      result: formattedJobs,
      pagination: { page, limit, totalCount },
    });
  } catch (err) {
    console.error("getAcceptedScheduledJobs Error:", err);
    return res.status(500).json({ success: false, message: err.message, result: { error: err.message } });
  }
};

/* =====================================================
   UPDATE BOOKING STATUS (TECHNICIAN)
===================================================== */
export const updateBookingStatus = async (req, res) => {
  try {
    const userRole = req.user?.role;

    const bookingId = req.params.id;
    const { status } = req.body;

    // 🔒 Validate ObjectId
    if (!mongoose.Types.ObjectId.isValid(bookingId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid booking ID format",
        result: {},
      });
    }

    const allowedStatus = [
      "on_the_way",
      "reached",
      "in_progress",
      "completed",
    ];

    if (!bookingId || !allowedStatus.includes(status)) {
      return res.status(400).json({
        success: false,
        message: "Invalid status",
        result: {},
      });
    }

    const technicianProfileId = req.user?.technicianProfileId;
    let booking = await ServiceBooking.findById(bookingId);
    if (!booking) {
      return res.status(404).json({
        success: false,
        message: "Booking not found",
        result: {},
      });
    }
    if (userRole !== "Technician") {
      return res.status(403).json({ success: false, message: "Only technician can update status", result: {} });
    }
    if (!technicianProfileId || !booking.technicianId || booking.technicianId.toString() !== technicianProfileId.toString()) {
      return res.status(403).json({ success: false, message: "Access denied for this booking", result: {} });
    }
    // 🔒 Explicit transition table — the booking must be in a state that
    // allows moving to `status` (canonical state machine only).
    if (!canTransition(booking.status, status)) {
      return res.status(409).json({
        success: false,
        message: `Cannot move booking from "${booking.status}" to "${status}"`,
        result: {},
      });
    }
    // Idempotent completion — already completed bookings return OK.
    if (status === "completed" && booking.status === "completed") {
      return res.status(200).json({ success: true, message: "Booking already completed", result: booking });
    }
    // Check technician approval status
    const technician = await TechnicianProfile.findById(technicianProfileId);
    if (!technician) {
      return res.status(404).json({
        success: false,
        message: "Technician profile not found",
        result: {},
      });
    }
    if (!technician.profileComplete) {
      return res.status(403).json({
        success: false,
        message: "Please complete your profile first",
        result: { profileComplete: false },
      });
    }

    // Check technician activation status (KYC + Bank + Training)
    const activation = await checkTechnicianActivation(technicianProfileId);
    if (!activation.isActive) {
      return res.status(403).json({
        success: false,
        message: activation.message,
        result: {},
      });
    }

    // Check workStatus
    if (technician.workStatus !== "approved") {
      return res.status(403).json({
        success: false,
        message: "Your account must be approved by owner before working. Status: " + technician.workStatus,
        result: { workStatus: technician.workStatus },
      });
    }
    if (status === "completed") {
      const beforeImage = booking.workImages?.beforeImage || null;
      const afterImage = booking.workImages?.afterImage || null;
      if (!beforeImage || !afterImage) {
        return res.status(400).json({
          success: false,
          message: "Before and after work images are required before completion",
          result: {},
        });
      }
    }

    // 🔒 Optimistic concurrency: bump version atomically and key the update on
    // the version we loaded. A concurrent status write changes the version and
    // makes this a no-op (modifiedCount 0) instead of silently overwriting a
    // newer state. The caller must reload and retry.
    // Legacy documents created before the `version` field existed have no
    // version — we match those via $exists:false so the update still works
    // (best-effort; fully safe only for versioned documents).
    const statusSet = { status };
    if (status === "on_the_way") {
      statusSet.autoCancelAt = null; // Disable auto-cancel once technician starts moving
    }
    if (status === "completed") {
      statusSet.completedAt = new Date();
      statusSet.assignmentStatus = "released";
    }
    const versionPredicate = booking.version == null
      ? { _id: booking._id, version: { $exists: false } }
      : { _id: booking._id, version: booking.version };
    const statusUpdate = await ServiceBooking.updateOne(versionPredicate, {
      $set: statusSet,
      $inc: { version: 1 },
    });
    if (statusUpdate.modifiedCount !== 1) {
      return res.status(409).json({
        success: false,
        message: "Booking was updated by another request. Please reload and retry.",
        result: {},
      });
    }
    if (status === "completed") {
      // If payment is already verified, credit technician wallet (idempotent)
      await settleBookingEarningsIfEligible(booking._id);

      // Notify customer — service is complete, payment is now due
      if (booking.customerId) {
        try {
          const { sendPushNotification } = await import("../Utils/sendNotification.js");
          await sendPushNotification(booking.customerId.toString(), {
            title: "Service Completed",
            body: "Your service is complete. Please complete the payment for your booking.",
            data: { bookingId: booking._id.toString(), type: "BOOKING_COMPLETED" },
          }, { recipientType: "customer" });
        } catch (notifyErr) {
          console.error("notifyCustomerCompleted error:", notifyErr.message);
        }
        if (req.io) {
          req.io.to(`customer_${booking.customerId}`).emit("booking_completed", {
            bookingId: booking._id,
            message: "Service completed — payment is now due",
            type: "PAYMENT_DUE",
          });
        }
      }

      // Re-broadcast pending jobs to this technician only
      const busyStartTime = booking.assignedAt || booking.createdAt || null;
      await broadcastPendingJobsToTechnician(technicianProfileId, req.io, busyStartTime);
    }

    // Re-fetch booking with service details to include technicianAmount
    const updatedBooking = await ServiceBooking.findById(booking._id)
      .populate("serviceId", "serviceName serviceType technicianAmount");

    // Remove baseAmount and include technicianAmount from service
    const bookingData = updatedBooking.toObject ? updatedBooking.toObject() : updatedBooking;
    const { baseAmount, ...bookingWithoutBaseAmount } = bookingData;
    bookingWithoutBaseAmount.technicianAmount = bookingData.serviceId?.technicianAmount || bookingData.technicianAmount || 0;

    return res.status(200).json({
      success: true,
      message: "Status updated",
      result: bookingWithoutBaseAmount,
    });
  } catch (error) {
    console.error("updateBookingStatus:", error);
    return res.status(500).json({
      success: false,
      message: error.message,
      result: { error: error.message },
    });
  }
};

/* =====================================================
   UPLOAD WORK IMAGES (TECHNICIAN)
===================================================== */
export const uploadWorkImages = async (req, res) => {
  try {
    if (req.user?.role !== "Technician") {
      return res.status(403).json({ success: false, message: "Technician access only", result: {} });
    }

    const bookingId = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(bookingId)) {
      return res.status(400).json({ success: false, message: "Invalid booking ID format", result: {} });
    }

    const technicianProfileId = req.user?.technicianProfileId;
    if (!technicianProfileId || !mongoose.Types.ObjectId.isValid(technicianProfileId)) {
      return res.status(401).json({ success: false, message: "Unauthorized", result: {} });
    }

    if (!req.files || Object.keys(req.files).length === 0) {
      return res.status(400).json({ success: false, message: "Work images are required", result: {} });
    }

    const booking = await ServiceBooking.findById(bookingId);
    if (!booking) {
      return res.status(404).json({ success: false, message: "Booking not found", result: {} });
    }

    if (!booking.technicianId || booking.technicianId.toString() !== technicianProfileId.toString()) {
      return res.status(403).json({ success: false, message: "Access denied for this booking", result: {} });
    }

    if (booking.status === "completed") {
      return res.status(400).json({ success: false, message: "Completed booking cannot be updated", result: {} });
    }

    const nextImages = booking.workImages ? { ...booking.workImages } : { beforeImage: null, afterImage: null };
    if (req.files.beforeImage?.[0]?.path) {
      nextImages.beforeImage = req.files.beforeImage[0].path;
    }
    if (req.files.afterImage?.[0]?.path) {
      nextImages.afterImage = req.files.afterImage[0].path;
    }

    if (!nextImages.beforeImage && !nextImages.afterImage) {
      return res.status(400).json({ success: false, message: "Work images are required", result: {} });
    }

    booking.workImages = nextImages;
    await booking.save();

    // Re-fetch booking with service details to include technicianAmount
    const updatedBooking = await ServiceBooking.findById(booking._id)
      .populate("serviceId", "serviceName serviceType technicianAmount");

    // Remove baseAmount and include technicianAmount from service
    const bookingData = updatedBooking.toObject ? updatedBooking.toObject() : updatedBooking;
    const { baseAmount, ...bookingWithoutBaseAmount } = bookingData;
    bookingWithoutBaseAmount.technicianAmount = bookingData.serviceId?.technicianAmount || bookingData.technicianAmount || 0;

    return res.status(200).json({
      success: true,
      message: "Work images uploaded successfully",
      result: bookingWithoutBaseAmount,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message,
      result: { error: error.message },
    });
  }
};


/* =====================================================
   CANCEL BOOKING (CUSTOMER)
===================================================== */
export const cancelBooking = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid booking ID format" });
    }

    const booking = await ServiceBooking.findById(id);
    if (!booking) return res.status(404).json({ success: false, message: "Booking not found" });

    if (req.user.role !== "Customer" || booking.customerId.toString() !== req.user.userId.toString()) {
      return res.status(403).json({ success: false, message: "Access denied" });
    }

    if (booking.status === "cancelled" || booking.status === "completed") {
      return res.status(400).json({ success: false, message: "Booking cannot be cancelled in current status" });
    }

    const now = new Date();
    let fee = 0;
    const isLate = booking.assignedAt && (now - new Date(booking.assignedAt)) > 20 * 60 * 1000 && ["accepted"].includes(booking.status);
    const isScheduledLate = booking.scheduledAt && now > new Date(booking.scheduledAt.getTime() + 15 * 60 * 1000) && ["accepted", "on_the_way"].includes(booking.status);

    // 🏆 RULE 3: Free cancellation if technician is late > 15-20 mins
    if (isLate || isScheduledLate) {
      fee = 0;
    } else {
      if (booking.bookingType === "schedule") {
        const timeToSlot = (new Date(booking.scheduledAt) - now) / (1000 * 60 * 60);

        if (booking.status === "reached") {
          fee = 120; // At-Door Cancellation
        } else if (timeToSlot < 2) {
          fee = 100; // Late Cancellation (< 2 hours)
        } else if (timeToSlot < 3) {
          fee = 50; // Intermediate (implied between 3 and 2) or custom rule
        } else {
          fee = 0; // Free Cancellation (> 3 hours)
        }
      } else {
        // Instant Booking
        if (["accepted", "on_the_way"].includes(booking.status)) {
          fee = 50;
        } else if (booking.status === "reached") {
          fee = 120;
        } else {
          fee = 0; // Still pending
        }
      }
    }

    // 🎯 ATOMIC CANCEL CLAIM — only one cancellation can win. Status must be
    // cancellable per the canonical transition table and not already cancelled.
    const cancellableStatuses = ["pending", "broadcasted", "accepted", "on_the_way", "reached"];
    const cancelled = await ServiceBooking.findOneAndUpdate(
      {
        _id: id,
        status: { $in: cancellableStatuses },
        cancellationStatus: "active",
        technicianId: booking.technicianId,
      },
      {
        $set: {
          status: "cancelled",
          cancelledBy: "customer",
          cancelReason: reason || "customer_cancel",
          cancellationStatus: "customer_cancelled",
          cancellationFee: fee,
          cancellationFeePaise: Math.round(fee * 100),
          // Recorded fees are NOT collected revenue until a real collection
          // mechanism exists — flag it explicitly for reports.
          cancellationFeeStatus: fee > 0 ? "not_collected" : "waived",
          assignmentStatus: "released",
          autoCancelAt: null,
        },
        $inc: { version: 1 },
      },
      { new: true }
    );

    if (!cancelled) {
      return res.status(409).json({ success: false, message: "Booking cannot be cancelled in its current state" });
    }

    // Release the technician's assignment history + expire pending offers
    if (cancelled.technicianId) {
      await ServiceBooking.updateOne(
        { _id: id },
        {
          $push: {
            assignmentAttempts: {
              technicianId: cancelled.technicianId,
              attemptNumber: (cancelled.assignmentAttempts?.length || 0) + 1,
              status: "released",
              acceptedAt: cancelled.assignedAt || null,
              releasedAt: now,
              releaseReason: "customer_cancel",
            },
          },
        }
      );
    }
    await JobBroadcast.updateMany(
      { bookingId: id, status: "sent" },
      { $set: { status: "expired" } }
    );
    await TechnicianBookingOffer.updateMany(
      { bookingId: id, decision: "offered" },
      { $set: { decision: "superseded" } }
    );

    // Notify the assigned technician (if any) that the job was cancelled
    if (cancelled.technicianId && req.io) {
      req.io.to(`technician_${cancelled.technicianId}`).emit("job_cancelled_by_customer", {
        bookingId: id,
        message: "This job was cancelled by the customer.",
        type: "BOOKING_CANCELLED",
      });
    }

    // NOTE: Customer cancellation fee is recorded for audit but not collected
    // until a customer wallet system is implemented. Do NOT claim the fee will
    // be charged until the deduction logic exists.
    // TODO: Implement customer wallet hold/deduction when wallet system is added.

    return res.status(200).json({
      success: true,
      message: fee > 0
        ? `Booking cancelled. A cancellation fee of ₹${fee} has been noted on your account.`
        : "Booking cancelled successfully.",
      result: {
        bookingId: cancelled._id,
        cancellationFee: fee,
        cancellationFeeStatus: cancelled.cancellationFeeStatus,
        status: "cancelled"
      }
    });
  } catch (error) {
    console.error("cancelBooking Error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

/* =====================================================
   TECHNICIAN CANCEL BOOKING (PENALTY ₹200 + RE-DISPATCH)
===================================================== */
export const technicianCancelBooking = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { id } = req.params;
    const { reason } = req.body;
    const techId = req.user.technicianProfileId;

    const booking = await ServiceBooking.findById(id).session(session);
    if (!booking) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: "Booking not found" });
    }

    if (booking.technicianId?.toString() !== techId?.toString()) {
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: "Not authorized to cancel this booking" });
    }

    // ✅ Cancellable states only (canonical transition table)
    if (!["accepted", "on_the_way", "reached", "in_progress"].includes(booking.status) ||
        booking.cancellationStatus !== "active") {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: "Booking cannot be cancelled in current status" });
    }

    // 💰 PENALTY — paise-based, policy-configurable. This is a recorded
    // liability on the technician wallet, NOT platform revenue.
    const PENALTY_PAISE = Number(process.env.TECHNICIAN_CANCEL_PENALTY_PAISE) || 20000; // ₹200
    const penaltyPaise = PENALTY_PAISE;
    const eventId = crypto.randomUUID();
    const idempotencyKey = `penalty:${id}:${techId}:${eventId}`;
    const now = new Date();

    // 1. Atomic wallet debit (only if sufficient funds); shortfall tracked
    //    as an outstanding receivable on the booking for reconciliation.
    let debitedPaise = 0;
    const technician = await TechnicianProfile.findById(techId).session(session);
    if (technician) {
      const wallet = technician;
      const available = wallet.availableBalancePaise || 0;
      debitedPaise = Math.min(available, penaltyPaise);
      if (debitedPaise > 0) {
        const debitResult = await TechnicianProfile.findOneAndUpdate(
          { _id: techId, availableBalancePaise: { $gte: debitedPaise } },
          { $inc: { availableBalancePaise: -debitedPaise } },
          { new: true, session }
        );
        if (!debitResult) {
          await session.abortTransaction();
          return res.status(409).json({ success: false, message: "Wallet changed concurrently, please retry" });
        }
      }

      // 2. Penalty transaction — idempotency key makes double-processing
      //    impossible even if this request is retried.
      const [penaltyTxn] = await WalletTransaction.create([{
        technicianId: techId,
        bookingId: id,
        amountPaise: debitedPaise,
        amount: debitedPaise / 100,
        type: "debit",
        source: "penalty",
        idempotencyKey,
        note: `Penalty for cancelling job after acceptance: ${reason || "No reason provided"}`,
      }], { session });

      // 3. Increment rejection count ONCE (guarded by the atomic claim below)
      await TechnicianProfile.updateOne(
        { _id: techId },
        { $inc: { jobRejectCount: 1 } }
      ).session(session);

      // 4. Atomically claim the cancellation (rejects concurrent duplicates)
      const claimed = await ServiceBooking.findOneAndUpdate(
        {
          _id: id,
          technicianId: techId,
          status: { $in: ["accepted", "on_the_way", "reached", "in_progress"] },
          cancellationStatus: "active",
        },
        {
          $set: {
            cancellationStatus: "technician_cancelled",
            technicianPenaltyPaise: penaltyPaise,
            technicianPenaltyDebitedPaise: debitedPaise,
          },
          $inc: { version: 1 },
        },
        { new: false, session }
      );
      if (!claimed) {
        await session.abortTransaction();
        return res.status(409).json({ success: false, message: "Booking was already processed" });
      }

      // 5. Record the release in assignment-attempt history (preserved for
      //    re-dispatch and disputes — never overwrite the first technician).
      await ServiceBooking.updateOne(
        { _id: id },
        {
          $push: {
            assignmentAttempts: {
              technicianId: techId,
              attemptNumber: (booking.assignmentAttempts?.length || 0) + 1,
              status: "released",
              acceptedAt: booking.assignedAt || null,
              releasedAt: now,
              releaseReason: "technician_cancel",
              penaltyTransactionId: penaltyTxn._id,
            },
          },
        }
      ).session(session);
    }

    // 6. Expire the old broadcasts and offers for this booking (in transaction)
    await JobBroadcast.updateMany(
      { bookingId: id, status: { $in: ["sent", "accepted"] } },
      { status: "expired" },
      { session }
    );
    await TechnicianBookingOffer.updateMany(
      { bookingId: id, decision: { $in: ["offered", "accepted"] } },
      { $set: { decision: "expired" } },
      { session }
    );

    // 7. Reset booking to pending for re-dispatch (instead of leaving it cancelled)
    const isSlotStillFuture = booking.bookingType === "schedule" && booking.scheduledAt && booking.scheduledAt > now;

    if (isSlotStillFuture) {
      // Scheduled booking with future slot: reset to pending for re-broadcast
      booking.status = "pending";
      booking.assignmentStatus = "unassigned";
      booking.technicianId = null;
      booking.technicianSnapshot = null;
      booking.assignedAt = null;
      booking.autoCancelAt = new Date(booking.scheduledAt.getTime() - 5 * 60 * 60 * 1000);
      if (booking.autoCancelAt <= now) booking.autoCancelAt = new Date(now.getTime() + 5 * 60 * 1000);
      booking.cancelReason = null;
      booking.cancelledBy = null;
      booking.technicianPenalty = penaltyPaise / 100;
      booking.technicianRejectCount = (booking.technicianRejectCount || 0) + 1;
      await booking.save({ session });
    } else {
      // Instant booking or past slot: cancel permanently
      booking.status = "cancelled";
      booking.cancelledBy = "technician";
      booking.cancelReason = reason || "technician_cancel";
      booking.technicianPenalty = penaltyPaise / 100;
      booking.assignmentStatus = "released";
      booking.autoCancelAt = null;
      await booking.save({ session });
    }

    await session.commitTransaction();

    // 8. Notify customer + re-dispatch (outside transaction for socket/perf)
    if (req.io) {
      if (isSlotStillFuture) {
        // Re-broadcast to find a replacement
        notifyCustomerOfRebroadcast(booking, req.io).catch(() => {});
        matchAndBroadcastBooking(booking._id, req.io).catch((err) =>
          console.error("Re-broadcast after tech-cancel failed:", err.message)
        );
      } else {
        req.io.to(`customer_${booking.customerId}`).emit("booking_cancelled", {
          ...toBookingCancelledDTO(booking, "technician_cancel"),
          message: "Your technician had to cancel. The booking has been cancelled."
        });
      }
    }

    return res.status(200).json({
      success: true,
      message: isSlotStillFuture
        ? `Booking cancelled. A penalty of ₹${(penaltyPaise / 100)} has been debited. We are searching for a replacement technician.`
        : `Booking cancelled. A penalty of ₹${(penaltyPaise / 100)} has been debited from your wallet.`,
      result: {
        penaltyPaise,
        penaltyDebitedPaise: debitedPaise,
        penaltyOutstandingPaise: penaltyPaise - debitedPaise,
        walletBalance: (technician?.availableBalancePaise || 0) / 100,
        redisplay: isSlotStillFuture,
      }
    });
  } catch (error) {
    if (session.inTransaction()) await session.abortTransaction();
    console.error("technicianCancelBooking Error:", error);
    return res.status(500).json({ success: false, message: error.message });
  } finally {
    session.endSession();
  }
};

/* =====================================================
   TECHNICIAN RE-ACCEPT CANCELLED JOB
   (OPTIONAL PENALTY — % OF BOOKING TOTAL, ADMIN-CONFIGURED)
   Body: { withPenalty: true|false }
   Penalty percent is a global admin setting:
     "technician.reacceptPenaltyPercent" (0–100), managed via
     GET/PUT /api/admin/settings/reaccept-penalty.
===================================================== */
export const acceptCancelledJob = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { id } = req.params;
    const { withPenalty = false } = req.body || {};
    const techId = req.user.technicianProfileId;

    if (!techId) {
      await session.abortTransaction();
      return res.status(401).json({ success: false, message: "Unauthorized. Technician profile not found." });
    }

    // 🛡 Activation gate — suspended/unapproved/KYC-incomplete technicians
    // must not re-accept jobs.
    const activation = await checkTechnicianActivation(techId);
    if (!activation.isActive) {
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: activation.message });
    }

    const booking = await ServiceBooking.findById(id)
      .session(session)
      .populate("customerId", "fname lname mobileNumber email")
      .populate({ path: "serviceId", populate: { path: "categoryId" } });
    if (!booking) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: "Booking not found" });
    }

    // ✅ Only a CANCELLED job that was assigned to this technician can be re-accepted.
    if (booking.status !== "cancelled") {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: "Only cancelled jobs can be re-accepted" });
    }
    if (booking.technicianId?.toString() !== techId?.toString()) {
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: "This job was not assigned to you" });
    }

    // ⚔️ One active job at a time — same guard as a fresh accept.
    const activeJob = await ServiceBooking.findOne({
      technicianId: techId,
      $or: [
        { status: { $in: ["on_the_way", "reached", "in_progress"] } },
        { status: { $in: ["accepted", "ACCEPTED"] }, bookingType: "instant" },
      ],
    })
      .session(session)
      .select("_id status bookingType");
    if (activeJob) {
      await session.abortTransaction();
      return res.status(409).json({
        success: false,
        message:
          activeJob.status === "accepted" || activeJob.status === "ACCEPTED"
            ? "Please start travel for your current job before re-accepting."
            : "You are already on a job. Complete it before re-accepting another.",
      });
    }

    const now = new Date();

    // 💰 OPTIONAL PENALTY — admin-configured % of the booking total (paise).
    let penaltyPaise = 0;
    let debitedPaise = 0;
    let penaltyTxnId = null;
    let technician = null;

    if (withPenalty) {
      const percent = await getReacceptPenaltyPercent();
      const totalAmountPaise = booking.financialSnapshot?.totalAmountPaise || 0;
      penaltyPaise = percentageOf(totalAmountPaise, percent);
      if (penaltyPaise > 0) {
        const eventId = crypto.randomUUID();
        const idempotencyKey = `reaccept-penalty:${id}:${techId}:${eventId}`;

        technician = await TechnicianProfile.findById(techId).session(session);
        const available = technician?.availableBalancePaise || 0;
        debitedPaise = Math.min(available, penaltyPaise);

        if (debitedPaise > 0) {
          const debitResult = await TechnicianProfile.findOneAndUpdate(
            { _id: techId, availableBalancePaise: { $gte: debitedPaise } },
            { $inc: { availableBalancePaise: -debitedPaise } },
            { new: true, session }
          );
          if (!debitResult) {
            await session.abortTransaction();
            return res.status(409).json({ success: false, message: "Wallet changed concurrently, please retry" });
          }
        }

        const [penaltyTxn] = await WalletTransaction.create(
          [
            {
              technicianId: techId,
              bookingId: id,
              amountPaise: debitedPaise,
              amount: debitedPaise / 100,
              type: "debit",
              source: "penalty",
              idempotencyKey,
              note: `Penalty (${percent}% of booking total) for re-accepting a cancelled job`,
            },
          ],
          { session }
        );
        penaltyTxnId = penaltyTxn._id;
      }
    }

    // 🎯 Re-accept — atomically revive the booking. Guards against a
    // concurrent re-process (e.g. double-tap) via the status predicate.
    const technicianProfile = await TechnicianProfile.findById(techId)
      .session(session)
      .select("userId");
    const technicianUser = await User.findById(technicianProfile?.userId)
      .session(session)
      .select("fname lname mobileNumber");
    const technicianSnapshot = {
      name: `${technicianUser?.fname || ""} ${technicianUser?.lname || ""}`.trim() || "Unknown",
      mobile: technicianUser?.mobileNumber || "",
      deleted: false,
    };

    const reaccepted = await ServiceBooking.findOneAndUpdate(
      {
        _id: id,
        status: "cancelled",
        technicianId: techId,
      },
      {
        $set: {
          status: "accepted",
          assignmentStatus: "assigned",
          technicianId: techId,
          technicianSnapshot,
          assignedAt: now,
          cancellationStatus: "active",
          cancelledBy: null,
          cancelReason: null,
          autoCancelAt: booking.bookingType === "instant" ? new Date(now.getTime() + 30 * 60 * 1000) : null,
          ...(penaltyPaise > 0
            ? {
                technicianPenaltyPaise: penaltyPaise,
                technicianPenaltyDebitedPaise: debitedPaise,
                technicianPenalty: penaltyPaise / 100,
              }
            : {}),
        },
        $push: {
          assignmentAttempts: {
            technicianId: techId,
            attemptNumber: (booking.assignmentAttempts?.length || 0) + 1,
            status: "assigned",
            acceptedAt: now,
            releaseReason: null,
            note: "Re-accepted after cancellation",
            penaltyTransactionId: penaltyTxnId,
          },
        },
        $inc: { version: 1 },
      },
      { new: true, session }
    );

    if (!reaccepted) {
      await session.abortTransaction();
      return res.status(409).json({ success: false, message: "Booking was already processed" });
    }

    // Mark this technician's broadcast row accepted (if one still exists).
    await JobBroadcast.updateOne(
      { bookingId: id, technicianId: techId, status: "expired" },
      { $set: { status: "accepted" } },
      { session }
    );

    await session.commitTransaction();

    // 🔔 Notify customer (outside transaction)
    if (req.io && reaccepted.customerId) {
      notifyCustomerJobAccepted(req.io, reaccepted.customerId._id, {
        bookingId: reaccepted._id,
        technicianId: techId,
        status: "accepted",
      }).catch(() => {});
    }

    const bookingData = reaccepted.toObject ? reaccepted.toObject() : reaccepted;
    const { baseAmount, ...bookingWithoutBaseAmount } = bookingData;
    bookingWithoutBaseAmount.technicianAmount =
      bookingData.serviceId?.technicianAmount || bookingData.technicianAmount || 0;

    return res.status(200).json({
      success: true,
      message: penaltyPaise > 0
        ? `Job re-accepted. A penalty of ₹${(penaltyPaise / 100).toFixed(2)} (${await getReacceptPenaltyPercent()}% of booking total) has been debited from your wallet.`
        : "Job re-accepted successfully without penalty",
      result: {
        ...bookingWithoutBaseAmount,
        penalty: {
          applied: penaltyPaise > 0,
          penaltyPaise,
          penaltyDebitedPaise: debitedPaise,
          penaltyOutstandingPaise: penaltyPaise - debitedPaise,
          walletBalance: (technician?.availableBalancePaise || 0) / 100,
        },
      },
    });
  } catch (error) {
    if (session.inTransaction()) await session.abortTransaction();
    console.error("acceptCancelledJob Error:", error);
    return res.status(500).json({ success: false, message: error.message });
  } finally {
    session.endSession();
  }
};

/* =====================================================
   GET ADMIN JOB HISTORY (WITH TECHNICIAN SNAPSHOT FALLBACK)
===================================================== */
export const getAdminJobHistory = async (req, res) => {
  try {
    const userRole = req.user?.role;

    // Only Owner/Admin can access
    if (userRole !== "Owner" && userRole !== "Admin") {
      return res.status(403).json({
        success: false,
        message: "Access denied. Owner/Admin only.",
        result: {},
      });
    }

    const { technicianId, status } = req.query;

    // Build query
    const query = {};
    if (technicianId) {
      if (!mongoose.Types.ObjectId.isValid(technicianId)) {
        return res.status(400).json({
          success: false,
          message: "Invalid technician ID",
          result: {},
        });
      }
      query.technicianId = technicianId;
    }

    if (status) {
      const allowedStatuses = [
        "pending", "broadcasted", "accepted", "on_the_way",
        "reached", "in_progress", "completed", "cancelled", "expired"
      ];
      if (!allowedStatuses.includes(status)) {
        return res.status(400).json({
          success: false,
          message: "Invalid status",
          result: {},
        });
      }
      query.status = status;
    }

    // Fetch jobs with population
    const jobs = await ServiceBooking.find(query)
      .populate("customerId", "fname lname mobileNumber email")
      .populate("serviceId", "serviceName serviceType serviceCost")
      .populate("technicianId", "userId profileImage rating totalJobsCompleted")
      .sort({ createdAt: -1 })
      .lean();

    // Enrich with technician snapshot if profile deleted
    const enrichedJobs = jobs.map(job => {
      if (!job.technicianId && job.technicianSnapshot?.deleted) {
        // Technician deleted, show snapshot
        job.technicianInfo = {
          deleted: true,
          name: job.technicianSnapshot.name,
          mobile: job.technicianSnapshot.mobile,
        };
      } else if (job.technicianId) {
        // Technician exists, show live data
        job.technicianInfo = {
          deleted: false,
          id: job.technicianId._id,
          userId: job.technicianId.userId,
          profileImage: job.technicianId.profileImage,
          rating: job.technicianId.rating,
          totalJobsCompleted: job.technicianId.totalJobsCompleted,
        };
      } else {
        // No technician assigned yet
        job.technicianInfo = null;
      }
      return job;
    });

    return res.status(200).json({
      success: true,
      message: "Job history fetched successfully",
      result: enrichedJobs,
    });
  } catch (error) {
    console.error("getAdminJobHistory:", error);
    return res.status(500).json({
      success: false,
      message: error.message,
      result: { error: error.message },
    });
  }
};

/* =====================================================
   GET ALL BOOKINGS & CUSTOMERS (PUBLIC/MANAGEMENT)
   Filters: status, customerMobile, technicianMobile
===================================================== */
export const getOwnerAllBookings = async (req, res) => {
  try {
    const { status, customerMobile, technicianMobile, limit = 50, skip = 0 } = req.query;

    // 1. Build Query
    let query = {};

    // 🔗 Filter by Customer Mobile
    const User = mongoose.model("User");
    if (customerMobile) {
      const customer = await User.findOne({ mobileNumber: customerMobile, role: "Customer" });
      if (customer) {
        query.customerId = customer._id;
      } else {
        // If mobile provided but not found, return empty (or continue with search that will yield empty)
        query.customerId = new mongoose.Types.ObjectId(); // Non-existent ID
      }
    }

    // 🔗 Filter by Technician Mobile
    if (technicianMobile) {
      const techUser = await User.findOne({ mobileNumber: technicianMobile, role: "Technician" });
      if (techUser) {
        const TechnicianProfile = mongoose.model("TechnicianProfile");
        const profile = await TechnicianProfile.findOne({ userId: techUser._id });
        if (profile) {
          query.technicianId = profile._id;
        } else {
          query.technicianId = new mongoose.Types.ObjectId();
        }
      } else {
        query.technicianId = new mongoose.Types.ObjectId();
      }
    }

    // 📌 Filter by Status
    if (status) {
      if (status === "expired") {
        const JobBroadcast = mongoose.model("JobBroadcast");
        const expiredBroadcasts = await JobBroadcast.find({ status: "expired" }).select("bookingId");
        const expiredBookingIds = expiredBroadcasts.map(b => b.bookingId);
        query = {
          ...query,
          $or: [
            { _id: { $in: expiredBookingIds } },
            { status: "expired" }
          ]
        };
      } else {
        // Support any other status (accepted, completed, in_progress, etc.)
        query.status = status;
      }
    }

    const bookings = await ServiceBooking.find(query)
      .populate("customerId", "fname lname mobileNumber email")
      .populate("serviceId", "serviceName serviceType serviceCost")
      .populate({
        path: "technicianId",
        select: "userId profileImage",
        populate: {
          path: "userId",
          select: "mobileNumber fname lname"
        }
      })
      .sort({ createdAt: -1 })
      .limit(parseInt(limit))
      .skip(parseInt(skip));

    // 2. Fetch All Customers as requested
    const customers = await User.find({ role: "Customer" })
      .select("fname lname mobileNumber email status profileComplete")
      .sort({ createdAt: -1 });

    return res.status(200).json({
      success: true,
      message: "Bookings and Customers fetched successfully",
      result: {
        bookings,
        customers,
        totalBookings: bookings.length,
        totalCustomers: customers.length
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

/* =====================================================
   GET BOOKING BY ID (PUBLIC/MANAGEMENT)
===================================================== */
export const getOwnerBookingById = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid booking ID" });
    }

    const booking = await ServiceBooking.findById(id)
      .populate("customerId", "fname lname mobileNumber email")
      .populate("serviceId", "serviceName serviceType description serviceCost technicianAmount")
      .populate({
        path: "technicianId",
        populate: { path: "userId", select: "fname lname mobileNumber" }
      })
      .populate("addressId");

    if (!booking) {
      return res.status(404).json({ success: false, message: "Booking not found" });
    }

    return res.status(200).json({
      success: true,
      message: "Booking details fetched successfully",
      result: booking,
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

/* =====================================================
   GET CANCELLATION REASONS (ALL ROLES)
===================================================== */
export const getCancellationReasons = async (req, res) => {
  const customerReasons = [
    { id: "change_of_plans", label: "Change of plans" },
    { id: "booked_by_mistake", label: "Booked by mistake" },
    { id: "technician_late", label: "Technician is late" },
    { id: "found_better_price", label: "Found better price elsewhere" },
    { id: "work_already_done", label: "Work already done" },
    { id: "other", label: "Other" }
  ];

  const technicianReasons = [
    { id: "traffic_heavy", label: "Heavy traffic / Distance too far" },
    { id: "vehicle_breakdown", label: "Vehicle breakdown" },
    { id: "personal_emergency", label: "Personal emergency" },
    { id: "wrong_service_selected", label: "Incorrect service selected by customer" },
    { id: "parts_unavailable", label: "Required parts unavailable" },
    { id: "other", label: "Other" }
  ];

  return res.status(200).json({
    success: true,
    result: {
      customer: customerReasons,
      technician: technicianReasons
    }
  });
};

/* =====================================================
   DELETE ALL CUSTOMER BOOKINGS (CLEANUP)
===================================================== */
export const deleteAllCustomerBookings = async (req, res) => {
  try {
    if (req.user?.role !== "Customer") {
      return res.status(403).json({ success: false, message: "Customer access only", result: {} });
    }

    const { userId } = req.user;

    const session = await mongoose.startSession();
    await session.withTransaction(async () => {
      // 1. Delete all Service Bookings for this customer
      const serviceBookings = await ServiceBooking.find({ customerId: userId }).select("_id").session(session);
      const bookingIds = serviceBookings.map(b => b._id);

      await ServiceBooking.deleteMany({ customerId: userId }).session(session);

      // 2. Delete associated Job Broadcasts
      await JobBroadcast.deleteMany({ bookingId: { $in: bookingIds } }).session(session);

      // 3. Delete all Product Bookings for this customer
      await ProductBooking.deleteMany({ customerId: userId }).session(session);
    });
    session.endSession();

    console.log(`🗑️ Customer ${userId} wiped their entire booking history.`);

    return res.status(200).json({
      success: true,
      message: "All service and product bookings deleted successfully",
      result: {},
    });
  } catch (error) {
    console.error("deleteAllCustomerBookings Error:", error);
    return res.status(500).json({
      success: false,
      message: "Server error during cleanup",
      result: { error: error.message },
    });
  }
};

// 🔄 Re-export Book Again endpoints for modular accessibility
export { getCompletedServices, rebookService } from "./bookAgainController.js";

/* =====================================================
   DELETE A SINGLE SERVICE BOOKING (CUSTOMER)
   - Customer can only delete their own booking.
   - Deletion is blocked once money is involved (paid) or a
     technician is engaged/completed to protect financial integrity
     and audit trail. Allowed states: pending / broadcasted /
     cancelled / expired (i.e. technicianId === null and not paid).
   - Cascades to the booking's broadcast / offer / outbox rows.
   ===================================================== */
const DELETABLE_BOOKING_STATUSES = ["pending", "broadcasted", "cancelled", "expired"];

export const deleteServiceBooking = async (req, res) => {
  try {
    if (req.user?.role !== "Customer") {
      return res.status(403).json({ success: false, message: "Customer access only", result: {} });
    }

    const { id } = req.params;
    if (!id) {
      return res.status(400).json({ success: false, message: "Booking id is required", result: {} });
    }

    const booking = await ServiceBooking.findOne({ _id: id, customerId: req.user.userId });
    if (!booking) {
      return res.status(404).json({ success: false, message: "Booking not found", result: {} });
    }

    // 🔒 Guard: protect paid / in-progress / technician-engaged bookings
    if (booking.paymentStatus === "paid") {
      return res.status(409).json({
        success: false,
        message: "Cannot delete a booking that has been paid. Cancel it instead.",
        result: {},
      });
    }
    if (booking.technicianId) {
      return res.status(409).json({
        success: false,
        message: "Cannot delete a booking assigned to a technician. Cancel it instead.",
        result: {},
      });
    }
    if (!DELETABLE_BOOKING_STATUSES.includes(booking.status)) {
      return res.status(409).json({
        success: false,
        message: `Cannot delete a booking in '${booking.status}' state. Cancel it instead.`,
        result: {},
      });
    }

    const session = await mongoose.startSession();
    await session.withTransaction(async () => {
      await ServiceBooking.deleteOne({ _id: booking._id }).session(session);
      await JobBroadcast.deleteMany({ bookingId: booking._id }).session(session);
      await TechnicianBookingOffer.deleteMany({ bookingId: booking._id }).session(session);
      await BookingOutbox.deleteMany({ bookingId: booking._id }).session(session);
      await DispatchOutbox.deleteMany({ bookingId: booking._id }).session(session);
    });
    session.endSession();

    console.log(`🗑️ Customer ${req.user.userId} deleted booking ${booking._id}`);

    return res.status(200).json({
      success: true,
      message: "Booking deleted successfully",
      result: { deletedBookingId: String(booking._id) },
    });
  } catch (error) {
    console.error("deleteServiceBooking Error:", error);
    return res.status(500).json({
      success: false,
      message: "Server error while deleting booking",
      result: { error: error.message },
    });
  }
};

/* =====================================================
   DELETE A SERVICE BOOKING (ADMIN / OWNER)
   - Privileged hard delete of ANY booking by id, with full
     cascade cleanup. Use with care — this erases the record.
   ===================================================== */
export const deleteBookingAsAdmin = async (req, res) => {
  try {
    const { id } = req.params;
    if (!id) {
      return res.status(400).json({ success: false, message: "Booking id is required", result: {} });
    }

    const booking = await ServiceBooking.findById(id);
    if (!booking) {
      return res.status(404).json({ success: false, message: "Booking not found", result: {} });
    }

    const session = await mongoose.startSession();
    await session.withTransaction(async () => {
      await ServiceBooking.deleteOne({ _id: booking._id }).session(session);
      await JobBroadcast.deleteMany({ bookingId: booking._id }).session(session);
      await TechnicianBookingOffer.deleteMany({ bookingId: booking._id }).session(session);
      await BookingOutbox.deleteMany({ bookingId: booking._id }).session(session);
      await DispatchOutbox.deleteMany({ bookingId: booking._id }).session(session);
    });
    session.endSession();

    console.log(`🗑️ Admin ${req.user?.userId} deleted booking ${booking._id}`);

    return res.status(200).json({
      success: true,
      message: "Booking deleted successfully (admin)",
      result: { deletedBookingId: String(booking._id) },
    });
  } catch (error) {
    console.error("deleteBookingAsAdmin Error:", error);
    return res.status(500).json({
      success: false,
      message: "Server error while deleting booking",
      result: { error: error.message },
    });
  }
};

