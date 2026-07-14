import ServiceBooking from "../Schemas/ServiceBooking.js";
import JobBroadcast from "../Schemas/TechnicianBroadcast.js";
import TechnicianProfile from "../Schemas/TechnicianProfile.js";
import TechnicianKyc from "../Schemas/TechnicianKYC.js";
import Service from "../Schemas/Service.js";
import Address from "../Schemas/Address.js";
import mongoose from "mongoose";
import { broadcastJobToTechnicians } from "../Utils/sendNotification.js";
import { broadcastPendingJobsToTechnician, findEligibleTechniciansForService } from "../Utils/technicianMatching.js";
import { findNearbyTechnicians } from "../Utils/findNearbyTechnicians.js";
import { settleBookingEarningsIfEligible } from "../Utils/settlement.js";
import { matchAndBroadcastBooking } from "../Utils/technicianMatching.js";
import { resolveUserLocation } from "../Utils/resolveUserLocation.js";

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

/* ================= TECHNICIAN ACTIVATION CHECK ================= */
const checkTechnicianActivation = async (technicianProfileId) => {
  try {
    // ✅ Real verification gates (NO BYPASS)
    const technician = await TechnicianProfile.findById(technicianProfileId).lean();

    if (!technician) {
      return {
        isActive: false,
        message: "Technician profile not found",
      };
    }

    // Gate 1: Profile must be complete
    if (!technician.profileComplete) {
      return {
        isActive: false,
        message: "Complete your profile first",
      };
    }

    // Gate 2: Work status must be approved by owner
    if (technician.workStatus !== "approved") {
      return {
        isActive: false,
        message: `Account not approved. Status: ${technician.workStatus}`,
      };
    }

    // Gate 3: KYC must be approved
    const kyc = await TechnicianKyc.findOne({ technicianId: technicianProfileId })
      .select("verificationStatus kycVerified bankVerified")
      .lean();
    if (!kyc || (kyc.verificationStatus !== "approved" && kyc.kycVerified !== true)) {
      return {
        isActive: false,
        message: "KYC verification required",
      };
    }

    // Gate 4: Bank account must be verified
    if (!kyc.bankVerified) {
      return {
        isActive: false,
        message: "Bank account not verified",
      };
    }

    // Gate 5: Training must be completed
    if (!technician.trainingCompleted) {
      return {
        isActive: false,
        message: "Training completion required",
      };
    }

    // ✅ All gates passed
    return {
      isActive: true,
      message: "Technician account is active and verified",
    };
  } catch (error) {
    return {
      isActive: false,
      message: `Activation check failed: ${error.message}`,
    };
  }
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

    const commissionPct = typeof service.commissionPercentage === "number" ? service.commissionPercentage : 0;
    const commissionAmt = Math.round((baseAmountNum * commissionPct) / 100);
    const techAmt = baseAmountNum - commissionAmt;

    // Determine initial status (Production Atomic Flow)
    const now = new Date();
    let autoCancelAt = null;

    if (bookingType === "scheduled" && finalScheduledAt) {
      // Scheduled: Expire 5 hours after creation
      autoCancelAt = new Date(now.getTime() + 5 * 60 * 60 * 1000);
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
      locationType: resolvedLocation.locationType,
      addressSnapshot: resolvedLocation.addressSnapshot,
      address: resolvedLocation.addressSnapshot.addressLine || "Pinned Location",
      commissionPercentage: commissionPct,
      commissionAmount: commissionAmt,
      technicianAmount: techAmt,
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
    };

    if (resolvedLocation.addressId) {
      bookingDoc.addressId = resolvedLocation.addressId;
    }

    const booking = await ServiceBooking.create(bookingDoc);

    // 🚀 Socket.IO Emission
    req.io.emit("new_booking", booking);

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

    // ─── Scheduled time resolution ────────────────────────────────────
    // Accept either:
    //   A) scheduledDate (YYYY-MM-DD) + scheduledTime (HH:MM)  [recommended for Flutter]
    //   B) scheduledAt (ISO string)                             [legacy]
    let finalScheduledAt;
    const bookingType = req.body?.bookingType === "scheduled" ? "scheduled" : "instant";

    if (req.body?.scheduledDate && req.body?.scheduledTime) {
      const combined = new Date(`${req.body.scheduledDate}T${req.body.scheduledTime}:00`);
      if (isNaN(combined.getTime())) {
        return res.status(400).json({
          success: false,
          message: "Invalid scheduledDate or scheduledTime format",
          result: {},
        });
      }
      const minFuture = new Date(Date.now() + 30 * 60 * 1000);
      if (combined <= minFuture) {
        return res.status(400).json({
          success: false,
          message: "Scheduled time must be at least 30 minutes in the future",
          result: {},
        });
      }
      finalScheduledAt = combined;
    } else if (req.body?.scheduledAt) {
      finalScheduledAt = new Date(req.body.scheduledAt);
    } else {
      return res.status(400).json({
        success: false,
        message: "Provide scheduledDate+scheduledTime or scheduledAt",
        result: {},
      });
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

    if (!serviceId) {
      return res.status(400).json({ success: false, message: "serviceId is required", result: {} });
    }

    const service = await Service.findById(serviceId);
    if (!service) {
      return res.status(404).json({ success: false, message: "Service not found", result: {} });
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

    const baseAmountNum = service.serviceCost || 0;
    const commissionPct = typeof service.commissionPercentage === "number" ? service.commissionPercentage : 0;
    const commissionAmt = Math.round((baseAmountNum * commissionPct) / 100);
    const techAmt = baseAmountNum - commissionAmt;

    // Determine status (Production Atomic Flow)
    const now = new Date();
    let autoCancelAt = null;
    if (bookingType === "scheduled" && finalScheduledAt) {
      // Scheduled: Expire 5 hours after creation
      autoCancelAt = new Date(now.getTime() + 5 * 60 * 60 * 1000);
    } else {
      // Instant: Expire 1 hour after creation
      autoCancelAt = new Date(now.getTime() + 1 * 60 * 60 * 1000);
    }
    const initialStatus = "pending";

    const booking = await ServiceBooking.create({
      customerId: req.user.userId,
      serviceId,
      bookingType: bookingType === "scheduled" ? "schedule" : "instant", // Align with schema
      baseAmount: baseAmountNum,
      scheduledAt: finalScheduledAt,
      faultProblem: faultProblem || null,
      locationType: resolvedLocation.locationType,
      addressSnapshot: resolvedLocation.addressSnapshot,
      address: resolvedLocation.addressSnapshot.addressLine || "Pinned Location",
      addressId: resolvedLocation.addressId || null,
      commissionPercentage: commissionPct,
      commissionAmount: commissionAmt,
      technicianAmount: techAmt,
      status: initialStatus,
      broadcastStartedAt: now,
      autoCancelAt: autoCancelAt,
      retryCount: 0,
      technicianRejectCount: 0,
      location: {
        type: "Point",
        coordinates: [resolvedLocation.longitude, resolvedLocation.latitude],
      },
    });

    // 🚀 Immediate Broadcast for searching status
    const broadcastResult = await matchAndBroadcastBooking(booking._id, req.io);

    const dispDate = finalScheduledAt.toLocaleString("en-IN", {
      day: "2-digit", month: "short", year: "numeric",
      hour: "2-digit", minute: "2-digit", hour12: true,
    });

    return res.status(201).json({
      success: true,
      message: bookingType === "scheduled"
        ? `Booking scheduled for ${dispDate}. Technician will be assigned closer to the time.`
        : "Booking created and broadcasted successfully",
      result: {
        bookingId: booking._id,
        bookingType,
        status: initialStatus,
        scheduledAt: booking.scheduledAt,
        broadcastCount: broadcastResult.count ?? 0,
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



/* ================= GET BOOKING SCHEDULE ================= */
export const getBookingSchedule = async (req, res) => {
  try {
    const now = new Date();

    // 1️⃣ Calculate "Instant" Window (30 mins offset)
    const instantArrival = new Date(now.getTime() + 30 * 60000);

    // 2️⃣ Generate "Tomorrow" and "Day after Tomorrow"
    const days = [];
    for (let i = 1; i <= 2; i++) {
      const d = new Date();
      d.setDate(d.getDate() + i);
      const dayName = d.toLocaleDateString("en-US", { weekday: "short" });
      const dateNum = d.getDate();
      const month = d.toLocaleDateString("en-US", { month: "short" });
      const fullDate = d.toISOString().split("T")[0];

      days.push({
        label: i === 1 ? "Tomorrow" : "Day after Tomorrow",
        date: dateNum,
        month: month,
        fullDate: fullDate,
        dayName: dayName
      });
    }

    // 3️⃣ Generate Time Slots (9:00 AM to 9:00 PM)
    const timeSlots = [];
    const startHour = 9;
    const endHour = 21;

    for (let h = startHour; h <= endHour; h++) {
      for (let m of [0, 30]) {
        if (h === endHour && m === 30) break; // Stop at 9:00 PM sharp

        const period = h < 12 ? "AM" : "PM";
        const displayHour = h % 12 === 0 ? 12 : h % 12;
        const displayMin = m === 0 ? "00" : "30";

        const slotLabel = `${displayHour < 10 ? "0" + displayHour : displayHour}:${displayMin} ${period}`;
        const militaryTime = `${h < 10 ? "0" + h : h}:${displayMin}`;

        timeSlots.push({
          label: slotLabel,
          value: militaryTime
        });
      }
    }

    return res.status(200).json({
      success: true,
      message: "Booking schedule options",
      result: {
        instant: {
          label: "Instant",
          arrivalTime: instantArrival,
          displayValue: "In 30 mins"
        },
        schedule: {
          days,
          timeSlots
        }
      }
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

    // For Admin: no filter, shows all bookings
    // For Customer/Technician: filtered by their ID

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

    return res.status(200).json({
      success: true,
      message: "Bookings fetched successfully",
      result: bookings,
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
  try {
    if (req.user?.role !== "Customer") {
      return res.status(403).json({ success: false, message: "Customer access only", result: {} });
    }
    if (!req.user.userId || !mongoose.Types.ObjectId.isValid(req.user.userId)) {
      return res.status(401).json({ success: false, message: "Invalid token user", result: {} });
    }
    const bookings = await ServiceBooking.find({
      customerId: req.user.userId,
    })
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

    return res.status(200).json({
      success: true,
      message: "Customer booking history",
      result: bookings,
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
        status: jobObj.status,
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

    booking.status = status;
    if (status === "on_the_way") {
      booking.autoCancelAt = null; // Disable auto-cancel once technician starts moving
    }
    await booking.save();
    if (status === "completed") {
      // If payment is already verified, credit technician wallet (idempotent)
      await settleBookingEarningsIfEligible(booking._id);
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
    const isLate = booking.assignedAt && (now - new Date(booking.assignedAt)) > 20 * 60 * 1000 && ["accepted", "ACCEPTED"].includes(booking.status);
    const isScheduledLate = booking.scheduledAt && now > new Date(booking.scheduledAt.getTime() + 15 * 60 * 1000) && ["accepted", "ACCEPTED", "on_the_way"].includes(booking.status);

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
        if (["accepted", "ACCEPTED", "on_the_way"].includes(booking.status)) {
          fee = 50;
        } else if (booking.status === "reached") {
          fee = 120;
        } else {
          fee = 0; // Still pending
        }
      }
    }

    booking.status = "cancelled";
    booking.cancelledBy = "customer";
    booking.cancelReason = reason || "customer_cancel";
    booking.cancellationFee = fee;
    await booking.save();

    // If there was a fee, we might need to handle payment/wallet logic here
    // For now, we record it in the booking record.

    return res.status(200).json({
      success: true,
      message: fee > 0 ? `Booking cancelled. A cancellation fee of ₹${fee} applies.` : "Booking cancelled successfully.",
      result: { bookingId: booking._id, cancellationFee: fee, status: "cancelled" }
    });
  } catch (error) {
    console.error("cancelBooking Error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

/* =====================================================
   TECHNICIAN CANCEL BOOKING (PENALTY ₹200)
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

    if (["completed", "cancelled"].includes(booking.status)) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: "Cannot cancel finished booking" });
    }

    const penaltyAmount = 200;

    // 1. Update Booking
    booking.status = "cancelled";
    booking.cancelledBy = "technician";
    booking.cancelReason = reason || "technician_cancel";
    booking.technicianPenalty = penaltyAmount;
    await booking.save({ session });

    // 2. Penalty from Wallet
    const technician = await TechnicianProfile.findById(techId).session(session);
    if (technician) {
      technician.walletBalance -= penaltyAmount;
      technician.jobRejectCount += 1;
      await technician.save({ session });

      await WalletTransaction.create([{
        technicianId: techId,
        bookingId: id,
        amount: penaltyAmount,
        type: "debit",
        source: "penalty",
        note: `Penalty for cancelling job after acceptance: ${reason || "No reason provided"}`
      }], { session });
    }

    await session.commitTransaction();

    // 3. Notify Customer
    if (req.io) {
      req.io.to(`customer_${booking.customerId}`).emit("booking_cancelled", {
        bookingId: id,
        reason: "technician_cancel",
        message: "Your technician had to cancel. We are searching for a replacement."
      });

      // If instant, maybe re-broadcast?
      if (booking.bookingType === "instant") {
        // We'll let the user decide if they want second chance or full cancel.
        // For now, it stays cancelled as per normal flow.
      }
    }

    return res.status(200).json({
      success: true,
      message: `Booking cancelled. A penalty of ₹${penaltyAmount} has been debited from your wallet.`,
      result: { penalty: penaltyAmount, walletBalance: technician?.walletBalance }
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
        "SEARCHING", "ACCEPTED", "on_the_way",
        "reached", "in_progress", "completed", "cancelled"
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
