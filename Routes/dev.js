import express from "express";
import { Auth } from "../Middleware/Auth.js";
import { findEligibleTechniciansForService } from "../Utils/technicianMatching.js";
import { SOCKET_EVENTS } from "../Utils/socketConstants.js";
import { toJobNewDTO } from "../Utils/socketDTO.js";

const router = express.Router();

// 🔒 Dev-only socket routes — locked behind a DEDICATED opt-in flag
// (Socket Analysis B1.6: NODE_ENV alone is not a safe gate — a single
// misconfigured deployment exposes these). Defaults to CLOSED.
const devSocketRoutesEnabled = process.env.ENABLE_DEV_SOCKET_ROUTES === "true";

if (devSocketRoutesEnabled) {

  // @route   POST /api/dev/test-notification
  // @desc    Test 2-Layer Notification (Persistent Mongo + Socket.IO / Redis Adapter)
  // @access  Private (Auth required)
  router.post("/test-notification", Auth, async (req, res) => {
    try {
      const { userId, recipientType, event, title, message, bookingId, metadata } = req.body;
      const targetUserId = userId || req.user?.userId;

      if (!targetUserId) {
        return res.status(400).json({ success: false, message: "userId is required" });
      }

      const { sendAppNotification } = await import("../Services/unifiedNotificationService.js");

      const result = await sendAppNotification({
        userId: targetUserId,
        recipientType: recipientType || (req.user?.role?.toLowerCase() || "customer"),
        technicianProfileId: req.user?.technicianProfileId || null,
        type: event || "TEST_NOTIFICATION",
        title: title || "Test Notification",
        message: message || "Hello from RightTouch 2-Layer Notification System!",
        bookingId: bookingId || `dev-booking-${Date.now()}`,
        metadata: {
          socketEvent: event || "notification:new",
          ...(typeof metadata === "object" ? metadata : {}),
        },
        sendPush: false, // Dev test focuses on Socket + Mongo
        io: req.io,
      });

      return res.status(200).json({
        success: true,
        message: "2-Layer Notification dispatched successfully",
        diagnostic: {
          targetUserId,
          room: `user:${targetUserId}`,
          event: event || "notification:new",
          socketEmitted: result.socketEmitted,
          notification: result.notification,
        },
      });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  // @route   POST /api/dev/test-redis
  // @desc    Test Socket Broadcast (Targets YOU based on your token)
  // @access  Private (Auth required)
  router.post("/test-redis", Auth, (req, res) => {
    try {
        const { event, message } = req.body;

        if (!req.io) {
            return res.status(500).json({ success: false, message: "Socket.io not initialized" });
        }

        // 🔒 SAFETY CHECK: Ensure the user is a technician
        if (req.user?.role !== "Technician" || !req.user?.technicianProfileId) {
            return res.status(403).json({
                success: false,
                message: "Access Denied: This test endpoint is only for logged-in Technicians."
            });
        }

        // ROOM is derived ONLY from the login token
        const targetRoom = `technician_${req.user.technicianProfileId}`;
        const targetEvent = event || SOCKET_EVENTS.JOB_NEW;

        // Build payload through the SAME DTO used by production emitters
        // (Fix #4: dev emits must match the real job:new contract)
        const payload = toJobNewDTO(
            {
                ...(typeof message === "object" && message ? message : {}),
                bookingId: message?.bookingId || "dev-test-booking",
                serviceName: message?.serviceName || "Live Test Notification",
            },
            { _id: `dev-${Date.now()}`, version: 1 }
        );

        // Emit via Socket.io
        req.io.to(targetRoom).emit(targetEvent, payload);
        req.io.to(`user:${req.user.userId}`).emit(targetEvent, payload);

        return res.status(200).json({
            success: true,
            message: "Socket test event emitted",
            details: { room: targetRoom, userRoom: `user:${req.user.userId}`, event: targetEvent, payload }
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
  });

  // @route   POST /api/dev/find-techs
  // @desc    Find Eligible Techs for Service & Broadcast
  // @access  Private
  router.post("/find-techs", Auth, async (req, res) => {
    try {
        const { serviceId, message } = req.body;

        if (!serviceId) {
            return res.status(400).json({ success: false, message: "serviceId is required" });
        }

        // 1. Find matches (Live check: Online + Skills + KYC)
        const technicians = await findEligibleTechniciansForService({
            serviceId,
            enableGeo: false
        });

        const technicianIds = technicians.map(t => t._id.toString());

        // 2. Broadcast to them (Fix #4: same DTO + same eligibility path as prod)
        if (req.io && technicianIds.length > 0) {
            const { broadcastJobToTechnicians } = await import("../Utils/sendNotification.js");
            await broadcastJobToTechnicians(req.io, technicianIds, {
                bookingId: message?.bookingId || `dev-${Date.now()}`,
                serviceId,
                serviceName: message?.serviceName || "Dev Test Job",
                description: message?.description || "",
                duration: message?.duration || 60,
                customerName: message?.customerName || "Dev Customer",
                baseAmount: message?.baseAmount || 0,
                address: message?.address || "",
                scheduledAt: message?.scheduledAt || null,
            });
        }

        return res.status(200).json({
            success: true,
            count: technicianIds.length,
            technicians: technicianIds,
            message: `Broadcasted to ${technicianIds.length} technicians`
        });

    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
  });

  // @route   GET /api/dev/samples
  // @desc    Get sample real IDs from DB for quick developer testing
  router.get("/samples", async (req, res) => {
    try {
      const mongoose = (await import("mongoose")).default;
      const { default: User } = await import("../Schemas/User.js");
      const { default: TechnicianProfile } = await import("../Schemas/TechnicianProfile.js");
      const { default: ServiceBooking } = await import("../Schemas/ServiceBooking.js");

      const [sampleTech, sampleCustomer, sampleBooking] = await Promise.all([
        TechnicianProfile.findOne({ "location.coordinates": { $exists: true } }).select("_id userId").lean(),
        User.findOne({ role: "Customer" }).select("_id").lean(),
        ServiceBooking.findOne().select("_id status").lean(),
      ]);

      const productBookingsColl = mongoose.connection.db.collection("productbookings");
      const sampleProductBooking = await productBookingsColl.findOne({}, { projection: { _id: 1, paymentId: 1 } });

      return res.status(200).json({
        success: true,
        samples: {
          technicianProfileId: sampleTech?._id || null,
          technicianUserId: sampleTech?.userId || null,
          customerId: sampleCustomer?._id || null,
          serviceBookingId: sampleBooking?._id || null,
          paymentId: "6aa11339af5ec26ba44e5fa1",
          productBookingId: sampleProductBooking?._id || "6aa110fd436dd18bc7c6e6db",
        }
      });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  // @route   GET /api/dev/inspect/:id
  // @desc    Universal A-to-Z Inspector for any ID (Technician, Customer, Booking, Payment)
  router.get("/inspect/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const mongoose = (await import("mongoose")).default;

      if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({ success: false, message: "Invalid MongoDB ObjectId format" });
      }

      const objId = new mongoose.Types.ObjectId(id);
      const { default: User } = await import("../Schemas/User.js");
      const { default: TechnicianProfile } = await import("../Schemas/TechnicianProfile.js");
      const { default: ServiceBooking } = await import("../Schemas/ServiceBooking.js");
      const { default: Payment } = await import("../Schemas/Payment.js");
      const { default: TechnicianKYC } = await import("../Schemas/TechnicianKYC.js");
      const { default: Notification } = await import("../Schemas/Notification.js");
      const { default: DeviceToken } = await import("../Schemas/DeviceToken.js");
      const { default: Service } = await import("../Schemas/Service.js");
      const { default: CityZone } = await import("../Schemas/CityZone.js");
      const { default: OperationalCity } = await import("../Schemas/OperationalCity.js");

      const db = mongoose.connection.db;
      const productBookingsColl = db.collection("productbookings");
      const productsColl = db.collection("products");

      // Parallel probe across collections
      const [
        techById,
        techByUserId,
        userDoc,
        serviceBookingDoc,
        productBookingDoc,
        paymentDoc
      ] = await Promise.all([
        TechnicianProfile.findById(objId)
          .populate("primaryDistrictId", "name city")
          .populate("enabledDistrictIds", "name city")
          .populate("enabledCityZoneIds", "name zoneCode")
          .lean(),
        TechnicianProfile.findOne({ userId: objId })
          .populate("primaryDistrictId", "name city")
          .populate("enabledDistrictIds", "name city")
          .populate("enabledCityZoneIds", "name zoneCode")
          .lean(),
        User.findById(objId).lean(),
        ServiceBooking.findById(objId)
          .populate("serviceId", "serviceName serviceType category duration")
          .populate("districtId", "name city")
          .populate("cityZoneId", "name zoneCode")
          .lean(),
        productBookingsColl.findOne({ _id: objId }),
        Payment.findById(objId).lean(),
      ]);

      // 1. TECHNICIAN MATCH
      const resolvedTech = techById || techByUserId;
      if (resolvedTech) {
        const techUserId = resolvedTech.userId;
        const [linkedUser, linkedKyc, activeBookings, recentBookings, notifications, deviceTokens] = await Promise.all([
          User.findById(techUserId).lean(),
          TechnicianKYC.findOne({ technicianId: resolvedTech._id }).lean(),
          ServiceBooking.find({
            technicianId: resolvedTech._id,
            status: { $in: ["accepted", "on_the_way", "reached", "in_progress"] }
          }).populate("serviceId", "serviceName").lean(),
          ServiceBooking.find({ technicianId: resolvedTech._id })
            .sort({ createdAt: -1 })
            .limit(10)
            .populate("serviceId", "serviceName")
            .lean(),
          Notification.find({
            $or: [
              { recipientId: resolvedTech._id },
              { recipientId: techUserId }
            ]
          }).sort({ createdAt: -1 }).limit(10).lean(),
          DeviceToken.find({
            userId: { $in: [String(resolvedTech._id), String(techUserId)] }
          }).lean(),
        ]);

        const [lng, lat] = resolvedTech.location?.coordinates || [null, null];

        return res.status(200).json({
          success: true,
          entityType: "technician",
          id: String(resolvedTech._id),
          summary: {
            name: `${linkedUser?.fname || ""} ${linkedUser?.lname || ""}`.trim() || "Unnamed Technician",
            phone: linkedUser?.mobileNumber || "N/A",
            email: linkedUser?.email || "N/A",
            role: "Technician",
            workStatus: resolvedTech.workStatus,
            isOnline: resolvedTech.availability?.isOnline || false,
            activeJobsCount: activeBookings.length,
            walletBalance: resolvedTech.walletBalance || 0,
            hasLocation: Boolean(lat && lng),
            latitude: lat,
            longitude: lng,
            locationUpdatedAt: resolvedTech.locationUpdatedAt || null,
          },
          technicianProfile: resolvedTech,
          userAccount: linkedUser,
          kycDetails: linkedKyc,
          activeBookings,
          recentBookings,
          notifications,
          deviceTokens,
        });
      }

      // 2. SERVICE BOOKING MATCH
      if (serviceBookingDoc) {
        const [customer, tech, payment, refund] = await Promise.all([
          User.findById(serviceBookingDoc.customerId).lean(),
          serviceBookingDoc.technicianId
            ? TechnicianProfile.findById(serviceBookingDoc.technicianId).populate("userId", "fname lname mobileNumber").lean()
            : null,
          Payment.findOne({ bookingId: serviceBookingDoc._id }).lean(),
          db.collection("refunds").findOne({ bookingId: serviceBookingDoc._id }),
        ]);

        return res.status(200).json({
          success: true,
          entityType: "service_booking",
          id: String(serviceBookingDoc._id),
          summary: {
            bookingType: "Service Booking",
            status: serviceBookingDoc.status,
            serviceName: serviceBookingDoc.serviceId?.serviceName || "N/A",
            customerName: serviceBookingDoc.addressSnapshot?.name || `${customer?.fname || ""} ${customer?.lname || ""}`.trim(),
            customerPhone: serviceBookingDoc.addressSnapshot?.phone || customer?.mobileNumber,
            technicianName: tech?.userId ? `${tech.userId.fname || ""} ${tech.userId.lname || ""}`.trim() : (serviceBookingDoc.technicianSnapshot?.name || "Unassigned"),
            totalAmount: serviceBookingDoc.totalAmount || serviceBookingDoc.baseAmount || 0,
            paymentStatus: serviceBookingDoc.paymentStatus || "pending",
            scheduledAt: serviceBookingDoc.scheduledAt,
            address: serviceBookingDoc.address || serviceBookingDoc.addressSnapshot?.addressLine,
          },
          booking: serviceBookingDoc,
          customer,
          technician: tech,
          payment,
          refund,
        });
      }

      // 3. PRODUCT BOOKING MATCH
      if (productBookingDoc) {
        const [product, customerUser, payment] = await Promise.all([
          productsColl.findOne({ _id: productBookingDoc.productId }),
          User.findById(productBookingDoc.customerId).lean(),
          Payment.findById(productBookingDoc.paymentId).lean(),
        ]);

        return res.status(200).json({
          success: true,
          entityType: "product_booking",
          id: String(productBookingDoc._id),
          summary: {
            bookingType: "Product Booking",
            status: productBookingDoc.status,
            productName: product?.productName || product?.name || "Testing Purpose",
            category: product?.category || product?.productType || "Hardware",
            customerName: productBookingDoc.addressSnapshot?.name || `${customerUser?.fname || ""} ${customerUser?.lname || ""}`.trim() || "VIGNESH S",
            customerPhone: productBookingDoc.addressSnapshot?.phone || customerUser?.mobileNumber || "6379498390",
            totalAmount: productBookingDoc.amount || 0,
            paymentStatus: productBookingDoc.paymentStatus || "paid",
            address: productBookingDoc.addressSnapshot?.addressLine || "",
          },
          productBooking: productBookingDoc,
          product,
          customer: customerUser,
          payment,
        });
      }

      // 4. PAYMENT RECORD MATCH
      if (paymentDoc) {
        const [serviceBooking, productBooking] = await Promise.all([
          paymentDoc.bookingId ? ServiceBooking.findById(paymentDoc.bookingId).lean() : null,
          paymentDoc.bookingId ? productBookingsColl.findOne({ _id: paymentDoc.bookingId }) : null,
        ]);

        let relatedBooking = serviceBooking || productBooking;
        let customer = null;
        let product = null;

        if (productBooking) {
          product = await productsColl.findOne({ _id: productBooking.productId });
          customer = productBooking.addressSnapshot || (await User.findById(productBooking.customerId).lean());
        } else if (serviceBooking) {
          customer = await User.findById(serviceBooking.customerId).lean();
        }

        return res.status(200).json({
          success: true,
          entityType: "payment",
          id: String(paymentDoc._id),
          summary: {
            paymentId: String(paymentDoc._id),
            status: paymentDoc.status,
            itemType: paymentDoc.itemType || "product",
            amount: paymentDoc.totalAmount || paymentDoc.totalAmountPaise / 100 || 0,
            mode: paymentDoc.mode,
            bookingId: paymentDoc.bookingId,
            customerName: customer?.name || `${customer?.fname || ""} ${customer?.lname || ""}`.trim() || "VIGNESH S",
            customerPhone: customer?.phone || customer?.mobileNumber || "6379498390",
            bookingTitle: product?.productName || product?.name || "Product / Service",
            createdAt: paymentDoc.createdAt,
          },
          payment: paymentDoc,
          relatedBooking,
          customer,
          product,
        });
      }

      // 5. CUSTOMER / USER MATCH
      if (userDoc) {
        const [bookings, addresses, notifications, deviceTokens] = await Promise.all([
          ServiceBooking.find({ customerId: userDoc._id }).sort({ createdAt: -1 }).limit(10).lean(),
          db.collection("addresses").find({ userId: userDoc._id }).toArray(),
          Notification.find({ recipientId: userDoc._id }).sort({ createdAt: -1 }).limit(10).lean(),
          DeviceToken.find({ userId: String(userDoc._id) }).lean(),
        ]);

        return res.status(200).json({
          success: true,
          entityType: "customer",
          id: String(userDoc._id),
          summary: {
            name: `${userDoc.fname || ""} ${userDoc.lname || ""}`.trim() || "Unnamed Customer",
            phone: userDoc.mobileNumber || "N/A",
            email: userDoc.email || "N/A",
            role: userDoc.role,
            status: userDoc.status,
            bookingsCount: bookings.length,
            addressesCount: addresses.length,
          },
          userAccount: userDoc,
          bookings,
          addresses,
          notifications,
          deviceTokens,
        });
      }

      return res.status(404).json({
        success: false,
        message: `No record found across Technicians, Customers, Bookings, or Payments for ID "${id}"`
      });

    } catch (err) {
      console.error("Inspect error:", err);
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  // @route   POST /api/dev/generate-token
  // @desc    Generate a valid non-expiring JWT token for any user/technician
  router.post("/generate-token", async (req, res) => {
    try {
      const { userId, role } = req.body;
      if (!userId) {
        return res.status(400).json({ success: false, message: "userId is required" });
      }

      const { signToken } = await import("../Utils/token.js");
      const token = signToken({
        userId,
        role: role || "Customer",
        email: "dev@righttouch.local"
      });

      return res.status(200).json({
        success: true,
        token,
        userId,
        role: role || "Customer",
        message: "Non-expiring JWT generated for testing"
      });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  });
}

export default router;