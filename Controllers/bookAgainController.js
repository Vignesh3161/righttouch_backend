import mongoose from "mongoose";
import ServiceBooking from "../Schemas/ServiceBooking.js";
import Service from "../Schemas/Service.js";
import { resolveUserLocation } from "../Utils/resolveUserLocation.js";
import { matchAndBroadcastBooking } from "../Utils/technicianMatching.js";

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

    const commissionPct = typeof service.commissionPercentage === "number" ? service.commissionPercentage : 0;
    const commissionAmt = Math.round((latestBaseAmount * commissionPct) / 100);
    const techAmt = latestBaseAmount - commissionAmt;

    // ⏰ Determine Booking Type & Schedule Timing
    const bookingTypeInput = req.body?.bookingType || previousBooking.bookingType;
    const isScheduled = bookingTypeInput === "scheduled" || bookingTypeInput === "schedule";
    const bookingType = isScheduled ? "schedule" : "instant";

    let finalScheduledAt = null;

    if (isScheduled) {
      const { scheduledDate, scheduledTime, scheduledAt } = req.body;

      if (scheduledDate && scheduledTime) {
        finalScheduledAt = new Date(`${scheduledDate}T${scheduledTime}:00`);
      } else if (scheduledAt) {
        finalScheduledAt = new Date(scheduledAt);
      } else {
        return res.status(400).json({
          success: false,
          message: "scheduledDate (YYYY-MM-DD) and scheduledTime (HH:MM) are required for scheduled rebooking",
          result: {},
        });
      }

      if (isNaN(finalScheduledAt.getTime())) {
        return res.status(400).json({
          success: false,
          message: "Invalid scheduled date or time format",
          result: {},
        });
      }

      // Schedule window check (minimum 30 mins in future, window: Tomorrow or Day After Tomorrow)
      const now = new Date();
      const minFuture = new Date(now.getTime() + 30 * 60 * 1000);
      if (finalScheduledAt < minFuture) {
        return res.status(400).json({
          success: false,
          message: "Scheduled time must be at least 30 minutes in the future",
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
          message: "Scheduled bookings are only allowed for Tomorrow or Day after Tomorrow",
          result: {
            tomorrow: tomorrowStart.toISOString().split("T")[0],
            dayAfter: dayAfterEnd.toISOString().split("T")[0],
          },
        });
      }
    } else {
      finalScheduledAt = req.body?.scheduledAt ? new Date(req.body.scheduledAt) : null;
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

    // 🕒 Auto-Cancellation Window setup
    const now = new Date();
    const autoCancelAt = isScheduled
      ? new Date(now.getTime() + 5 * 60 * 60 * 1000)
      : new Date(now.getTime() + 1 * 60 * 60 * 1000);

    const radiusInput = toFiniteNumber(req.body?.radius) ?? previousBooking.radius ?? 500;
    const faultProblemInput = typeof req.body?.faultProblem === "string" ? req.body.faultProblem.trim() : previousBooking.faultProblem || null;

    // 🆕 Create Brand-New Booking Document (No old payment data carried over)
    const newBookingDoc = {
      customerId,
      serviceId: service._id,
      bookingType,
      baseAmount: latestBaseAmount,
      commissionPercentage: commissionPct,
      commissionAmount: commissionAmt,
      technicianAmount: techAmt,
      locationType: resolvedLocation.locationType,
      addressSnapshot: resolvedLocation.addressSnapshot,
      address: resolvedLocation.addressSnapshot.addressLine || previousBooking.address || "Pinned Location",
      addressId: resolvedLocation.addressId || null,
      scheduledAt: finalScheduledAt,
      status: "pending",
      paymentStatus: "pending",
      paidAmount: 0,
      paymentOrderId: null,
      paymentProviderPaymentId: null,
      paymentId: null,
      settlementStatus: "pending",
      settledAt: null,
      technicianId: null,
      technicianSnapshot: { name: null, mobile: null, deleted: false },
      radius: radiusInput,
      faultProblem: faultProblemInput,
      location: {
        type: "Point",
        coordinates: [resolvedLocation.longitude, resolvedLocation.latitude],
      },
      broadcastStartedAt: now,
      autoCancelAt,
      retryCount: 0,
      technicianRejectCount: 0,
    };

    const newBooking = await ServiceBooking.create(newBookingDoc);

    // 🚀 Socket.IO Emission
    req.io.emit("new_booking", newBooking);

    // 🚀 Technician Broadcast Trigger
    const broadcastResult = await matchAndBroadcastBooking(newBooking._id, req.io);

    const message = isScheduled
      ? `Rebooked successfully! Scheduled for ${finalScheduledAt.toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: true })}`
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
