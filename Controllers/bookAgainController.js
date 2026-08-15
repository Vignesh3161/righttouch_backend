import mongoose from "mongoose";
import ServiceBooking from "../Schemas/ServiceBooking.js";
import Service from "../Schemas/Service.js";
import { resolveUserLocation } from "../Utils/resolveUserLocation.js";
import { resolveCommissionSnapshot } from "../Utils/commission.js";
import { paiseToRupees } from "../Utils/money.js";
import { matchAndBroadcastBooking } from "../Utils/technicianMatching.js";
import { toBookingCreatedDTO } from "../Utils/socketDTO.js";
import {
  resolveScheduleInput,
  resolveServiceZoneAvailability,
  buildServiceBookingDoc,
  createBookingAndOutbox,
  broadcastCreatedBooking,
} from "../Utils/bookingService.js";
import { validateScheduledAtUtc } from "../Utils/slots.js";

const toFiniteNumber = (val) => {
  if (val === null || val === undefined || val === "") return null;
  const num = Number(val);
  return Number.isFinite(num) ? num : null;
};

/**
 * @route   GET /api/user/booking/completed-services
 * @desc    Get all previously completed & paid services for customer, with optional grouping
 * @access  Private (Customer only)
 */
export const getCompletedServices = async (req, res) => {
  try {
    if (req.user?.role !== "Customer") {
      return res.status(403).json({
        success: false,
        message: "Customer access only",
        result: {},
      });
    }

    if (!req.user.userId || !mongoose.Types.ObjectId.isValid(req.user.userId)) {
      return res.status(401).json({
        success: false,
        message: "Invalid token user",
        result: {},
      });
    }

    const customerId = new mongoose.Types.ObjectId(req.user.userId);

    // Query parameters
    const groupBy = (req.query.groupBy || "service").toLowerCase();
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 20));
    const skip = (page - 1) * limit;

    const matchQuery = {
      customerId: customerId,
      status: "completed",
      paymentStatus: "paid",
    };

    if (groupBy === "service" || groupBy === "true") {
      // 📊 Grouped Aggregation Pipeline: Group repeated bookings by serviceId
      const aggregationPipeline = [
        { $match: matchQuery },
        { $sort: { createdAt: -1 } },
        {
          $group: {
            _id: "$serviceId",
            totalBookingsCount: { $sum: 1 },
            lastBookedAt: { $first: "$createdAt" },
            lastBookingId: { $first: "$_id" },
            lastBaseAmount: { $first: "$baseAmount" },
            lastAddressSnapshot: { $first: "$addressSnapshot" },
            lastBookingType: { $first: "$bookingType" },
          },
        },
        {
          $lookup: {
            from: "services",
            localField: "_id",
            foreignField: "_id",
            as: "serviceDetails",
          },
        },
        { $unwind: { path: "$serviceDetails", preserveNullAndEmptyArrays: true } },
        {
          $lookup: {
            from: "categories",
            localField: "serviceDetails.categoryId",
            foreignField: "_id",
            as: "categoryDetails",
          },
        },
        { $unwind: { path: "$categoryDetails", preserveNullAndEmptyArrays: true } },
        {
          $project: {
            _id: 0,
            serviceId: "$_id",
            serviceName: { $ifNull: ["$serviceDetails.serviceName", "Unknown Service"] },
            serviceImages: { $ifNull: ["$serviceDetails.serviceImages", []] },
            serviceType: { $ifNull: ["$serviceDetails.serviceType", "Repair"] },
            description: { $ifNull: ["$serviceDetails.description", ""] },
            currentPrice: {
              $cond: {
                if: {
                  $and: [
                    { $ne: ["$serviceDetails.discountedPrice", null] },
                    { $gt: ["$serviceDetails.discountedPrice", 0] },
                  ],
                },
                then: "$serviceDetails.discountedPrice",
                else: { $ifNull: ["$serviceDetails.serviceCost", "$lastBaseAmount"] },
              },
            },
            originalPrice: { $ifNull: ["$serviceDetails.serviceCost", 0] },
            discountPercentage: { $ifNull: ["$serviceDetails.serviceDiscountPercentage", 0] },
            isAvailable: { $ifNull: ["$serviceDetails.isActive", false] },
            category: {
              categoryId: "$categoryDetails._id",
              categoryName: "$categoryDetails.categoryName",
              categoryImage: "$categoryDetails.image",
            },
            totalBookingsCount: 1,
            lastBookedAt: 1,
            lastBookingId: 1,
            lastBaseAmount: 1,
            lastAddressSnapshot: 1,
            lastBookingType: 1,
          },
        },
        { $sort: { lastBookedAt: -1 } },
        {
          $facet: {
            metadata: [{ $count: "total" }],
            data: [{ $skip: skip }, { $limit: limit }],
          },
        },
      ];

      const aggregationResult = await ServiceBooking.aggregate(aggregationPipeline);
      const metadata = aggregationResult[0]?.metadata[0] || { total: 0 };
      const servicesData = aggregationResult[0]?.data || [];

      return res.status(200).json({
        success: true,
        message: "Completed services retrieved successfully",
        result: {
          grouped: true,
          totalUniqueServices: metadata.total,
          page,
          limit,
          totalPages: Math.ceil(metadata.total / limit) || 1,
          services: servicesData,
        },
      });
    } else {
      // 📋 Non-grouped option: List individual past completed bookings with live service details
      const totalBookings = await ServiceBooking.countDocuments(matchQuery);
      const bookings = await ServiceBooking.find(matchQuery)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate({
          path: "serviceId",
          select: "serviceName serviceImages serviceCost discountedPrice serviceDiscountPercentage isActive categoryId",
          populate: { path: "categoryId", select: "categoryName image" },
        })
        .lean();

      const formattedBookings = bookings.map((b) => {
        const service = b.serviceId || {};
        const currentPrice =
          service.discountedPrice && service.discountedPrice > 0
            ? service.discountedPrice
            : service.serviceCost || b.baseAmount;

        return {
          bookingId: b._id,
          serviceId: service._id || b.serviceId,
          serviceName: service.serviceName || "Unknown Service",
          serviceImages: service.serviceImages || [],
          currentPrice,
          previousPrice: b.baseAmount,
          isAvailable: service.isActive ?? false,
          category: service.categoryId
            ? {
                categoryId: service.categoryId._id,
                categoryName: service.categoryId.categoryName,
                categoryImage: service.categoryId.image,
              }
            : null,
          bookedAt: b.createdAt,
          bookingType: b.bookingType,
          addressSnapshot: b.addressSnapshot,
        };
      });

      return res.status(200).json({
        success: true,
        message: "Completed bookings retrieved successfully",
        result: {
          grouped: false,
          totalBookings,
          page,
          limit,
          totalPages: Math.ceil(totalBookings / limit) || 1,
          bookings: formattedBookings,
        },
      });
    }
  } catch (error) {
    console.error("❌ getCompletedServices Error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to retrieve completed services",
      result: { error: error.message },
    });
  }
};

/**
 * @route   POST /api/user/booking/book-again
 * @desc    Recreate a booking from a previous completed booking with latest pricing & availability
 * @access  Private (Customer only)
 */
export const rebookService = async (req, res) => {
  try {
    // 🔒 Security Check 1: Role Verification
    if (req.user?.role !== "Customer") {
      return res.status(403).json({
        success: false,
        message: "Customer access only",
        result: {},
      });
    }

    if (!req.user.userId || !mongoose.Types.ObjectId.isValid(req.user.userId)) {
      return res.status(401).json({
        success: false,
        message: "Invalid token user",
        result: {},
      });
    }

    const customerId = req.user.userId;
    const { previousBookingId } = req.body;

    // 🔒 Input Validation
    if (!previousBookingId || !mongoose.Types.ObjectId.isValid(previousBookingId)) {
      return res.status(400).json({
        success: false,
        message: "Valid previousBookingId is required",
        result: {},
      });
    }

    // 🔒 Security Check 2: Fetch & verify ownership of previous booking
    const previousBooking = await ServiceBooking.findById(previousBookingId);

    if (!previousBooking) {
      return res.status(404).json({
        success: false,
        message: "Previous booking record not found",
        result: {},
      });
    }

    if (previousBooking.customerId.toString() !== customerId.toString()) {
      return res.status(403).json({
        success: false,
        message: "Access denied: You can only rebook from your own previous bookings",
        result: {},
      });
    }

    if (previousBooking.status !== "completed" || previousBooking.paymentStatus !== "paid") {
      return res.status(400).json({
        success: false,
        message: "Only completed and paid bookings can be rebooked",
        result: {
          status: previousBooking.status,
          paymentStatus: previousBooking.paymentStatus,
        },
      });
    }

    // 🔍 Revalidate Service & Live Pricing
    const service = await Service.findById(previousBooking.serviceId);
    if (!service || !service.isActive) {
      return res.status(400).json({
        success: false,
        message: "This service is currently unavailable or inactive for rebooking",
        result: {},
      });
    }

    // Calculate Latest Price & Commission Structure
    const latestBaseAmount =
      service.discountedPrice && service.discountedPrice > 0
        ? service.discountedPrice
        : service.serviceCost;

    if (typeof latestBaseAmount !== "number" || Number.isNaN(latestBaseAmount) || latestBaseAmount < 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid live service price",
        result: {},
      });
    }

        // 💰 SERVER-SIDE SPLIT — commission on service amount only; GST separate;
    // tip (optional) passes through 100% to the technician.
    const snapshot = await resolveCommissionSnapshot({
      booking: { baseAmount: latestBaseAmount, itemType: "service" },
      service,
      tipAmountRupees: toFiniteNumber(req.body?.tipAmount) || 0,
    });
    const commissionPct = snapshot.commissionPercentage;
    const commissionAmt = paiseToRupees(snapshot.commissionAmountPaise);
    const techAmt = paiseToRupees(snapshot.technicianAmountPaise);

    // ⏰ Determine Booking Type & Schedule Timing (timezone-safe, shared utility)
    const bookingTypeInput = req.body?.bookingType || previousBooking.bookingType;
    const isScheduled = bookingTypeInput === "scheduled" || bookingTypeInput === "schedule";

    let schedule;
    if (isScheduled) {
      const { scheduledDate, scheduledTime, scheduledAt } = req.body;

      if (scheduledDate && scheduledTime) {
        schedule = resolveScheduleInput({ bookingType: "scheduled", scheduledDate, scheduledTime });
      } else if (scheduledAt) {
        const check = validateScheduledAtUtc(new Date(scheduledAt));
        schedule = check.valid
          ? {
              bookingType: "schedule",
              scheduledAt: check.scheduledAt,
              timezone: check.timezone,
              scheduledDateLocal: check.scheduledDateLocal,
              scheduledTimeLocal: check.scheduledTimeLocal,
            }
          : { bookingType: "schedule", error: check.error };
      } else {
        return res.status(400).json({
          success: false,
          message: "scheduledDate (YYYY-MM-DD) and scheduledTime (HH:MM) are required for scheduled rebooking",
          result: {},
        });
      }

      if (schedule.error) {
        return res.status(400).json({
          success: false,
          message: schedule.error,
          result: {},
        });
      }
    } else {
      schedule = { bookingType: "instant", scheduledAt: null, timezone: null, scheduledDateLocal: null, scheduledTimeLocal: null };
    }

    // 📍 Location Resolution (Use body overrides if provided, else fallback to previous booking address)
    const overrideAddressId = typeof req.body?.addressId === "string" ? req.body.addressId.trim() : req.body?.addressId;
    const overrideLat = req.body?.latitude !== undefined ? toFiniteNumber(req.body.latitude) : toFiniteNumber(req.body?.location?.latitude);
    const overrideLng = req.body?.longitude !== undefined ? toFiniteNumber(req.body.longitude) : toFiniteNumber(req.body?.location?.longitude);

    let resolvedLocation;

    if (overrideAddressId || (overrideLat !== null && overrideLng !== null)) {
      resolvedLocation = await resolveUserLocation({
        locationType: req.body.locationType || (overrideAddressId ? "ADDRESS" : "GPS"),
        addressId: overrideAddressId,
        latitude: overrideLat,
        longitude: overrideLng,
        userId: customerId,
      });
    } else if (previousBooking.addressId) {
      resolvedLocation = await resolveUserLocation({
        locationType: "ADDRESS",
        addressId: previousBooking.addressId.toString(),
        userId: customerId,
      });
    } else if (previousBooking.addressSnapshot?.latitude && previousBooking.addressSnapshot?.longitude) {
      resolvedLocation = await resolveUserLocation({
        locationType: "GPS",
        latitude: previousBooking.addressSnapshot.latitude,
        longitude: previousBooking.addressSnapshot.longitude,
        userId: customerId,
      });
    } else {
      return res.status(400).json({
        success: false,
        message: "No valid address or location coordinates found for rebooking",
        result: {},
      });
    }

    if (!resolvedLocation?.success) {
      return res.status(resolvedLocation?.statusCode || 400).json({
        success: false,
        message: resolvedLocation?.message || "Location resolution failed",
        result: {},
      });
    }

    // 🏘 ZONE AVAILABILITY — zone-restricted services need an active mapping
    const zoneCheck = await resolveServiceZoneAvailability({
      service,
      latitude: resolvedLocation.latitude,
      longitude: resolvedLocation.longitude,
    });
    if (!zoneCheck.ok) {
      return res.status(400).json({ success: false, message: zoneCheck.error, result: {} });
    }

    const radiusInput = toFiniteNumber(req.body?.radius) ?? previousBooking.radius ?? 500;
    const faultProblemInput = typeof req.body?.faultProblem === "string" ? req.body.faultProblem.trim() : previousBooking.faultProblem || null;

    // 🆕 Build brand-new booking via the SHARED creation pipeline
    // (immutable snapshot, server-side pricing, outbox row, canonical statuses)
    const doc = await buildServiceBookingDoc({
      service,
      resolvedLocation,
      schedule,
      tipAmountRupees: toFiniteNumber(req.body?.tipAmount) || 0,
      customerId,
      faultProblem: faultProblemInput,
      cityZoneId: zoneCheck.zoneId,
    });
    doc.radius = radiusInput;

    const session = await mongoose.startSession();
    let newBooking;
    try {
      session.startTransaction();
      const created = await createBookingAndOutbox({ doc, session });
      newBooking = created.booking;
      await session.commitTransaction();
    } catch (txError) {
      await session.abortTransaction();
      throw txError;
    } finally {
      session.endSession();
    }

    // 🚀 Socket.IO Emission — room-scoped DTO ONLY (Socket Analysis B1.1).
    if (req.io) {
      req.io.to("admin_dashboard").emit("new_booking", toBookingCreatedDTO(newBooking));
    }

    // 🚀 Technician Broadcast Trigger (only after commit; outbox retries)
    const broadcastResult = await broadcastCreatedBooking(newBooking._id, req.io);

    const message = isScheduled
      ? `Rebooked successfully! Scheduled for ${schedule.scheduledAt.toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: true })}`
      : (broadcastResult.count > 0 ? "Booking recreated & broadcasted to nearby technicians" : "Booking recreated (no technicians available in range)");

    return res.status(201).json({
      success: true,
      message,
      result: {
        newBooking,
        previousBookingId,
        broadcastCount: broadcastResult.count ?? 0,
        pricingSummary: {
          originalBaseAmount: previousBooking.baseAmount,
          newBaseAmount: latestBaseAmount,
          priceChanged: previousBooking.baseAmount !== latestBaseAmount,
        },
      },
    });
  } catch (error) {
    console.error("❌ rebookService Error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to rebook service",
      result: { error: error.message },
    });
  }
};
