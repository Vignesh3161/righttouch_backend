import Cart from "../Schemas/Cart.js";
import Service from "../Schemas/Service.js";
import ServiceBooking from "../Schemas/ServiceBooking.js";
import Address from "../Schemas/Address.js";
import User from "../Schemas/User.js";
import JobBroadcast from "../Schemas/TechnicianBroadcast.js";
import TechnicianProfile from "../Schemas/TechnicianProfile.js";
import mongoose from "mongoose";
import { matchAndBroadcastBooking } from "../Utils/technicianMatching.js";
import { resolveUserLocation } from "../Utils/resolveUserLocation.js";
import { ensureCustomer } from "../Utils/ensureCustomer.js";
import { resolveDistrictAndZoneFromCoordinates } from "../Utils/resolveZoneFromCoordinates.js";
import ZoneServiceMapping from "../Schemas/ZoneServiceMapping.js";
import { paiseToRupees, toPaise, isPayableTotalPaise } from "../Utils/money.js";
import {
  resolveScheduleInput,
  buildServiceBookingDoc,
  createBookingAndOutbox,
  resolveBookingIdempotencyKey,
  isDuplicateKeyError,
} from "../Utils/bookingService.js";
import { prepareScheduledBooking } from "../Services/slotCapacityService.js";
import { resolveCartItemSchedule } from "../Utils/scheduleIntent.js";
import {
  validateScheduledAtUtc,
  validateSlot,
  scheduleBookingWindow,
  BUSINESS_TIMEZONE,
  formatInBusinessTimezone,
  localDateInBusinessTimezone,
  generateScheduleDays,
  generateTimeSlots,
} from "../Utils/slots.js";




const toFiniteNumber = (v) => {
    if (v === null || v === undefined) return null;
    if (typeof v === "string" && v.trim() === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
};


const normalizeAddressId = (v) => {
    if (typeof v !== "string") return null;
    const trimmed = v.trim();
    return trimmed === "" || trimmed === "null" || trimmed === "undefined" ? null : trimmed;
};

const buildCheckoutReplay = async (res, bookings) => {
    const services = await Service.find({ _id: { $in: bookings.map((b) => b.serviceId) } })
        .select("serviceName")
        .lean();
    const serviceNameById = new Map(services.map((s) => [String(s._id), s.serviceName]));
    const serviceBookings = bookings.map((b) => ({
        bookingId: b._id,
        serviceId: b.serviceId,
        serviceName: serviceNameById.get(String(b.serviceId)) || null,
        quantity: 1,
        baseAmount: b.baseAmount,
        status: b.status,
    }));
    const totalAmountPaise = bookings.reduce(
        (sum, b) => sum + toPaise(b.financialSnapshot?.totalAmountPaise),
        0
    );
    const firstId = serviceBookings[0]?.bookingId;
    return res.status(200).json({
        success: true,
        message: "Service booking confirmed successfully",
        result: {
            serviceBookings,
            totalAmountPaise,
            totalAmount: totalAmountPaise / 100,
            _id: firstId,
            bookingId: firstId,
            deduped: true,
        },
    });
};

const getErrorMessage = (error) => {
    if (error.code === 11000) {
        return "Item already exists in cart with same ID";
    }
    // Handle Mongoose Validation Errors specifically to show which field failed
    if (error.name === "ValidationError") {
        return Object.values(error.errors)
            .map((err) => err.message)
            .join(", ");
    }
    if (error.statusCode) {
        return error.message;
    }
    // Return the actual error message if possible, for better debugging
    return error.message || "An error occurred. Please try again.";
};

/* ================= ADD TO CART ================= */
export const addToCart = async (req, res) => {
    try {
        ensureCustomer(req);
        const { itemId, itemType, quantity = 1 } = req.body;

        let customerId;
        let targetItemId;
        try {
            customerId = new mongoose.Types.ObjectId(req.user.userId);
            targetItemId = new mongoose.Types.ObjectId(itemId);
        } catch (castError) {
            return res.status(400).json({
                success: false,
                message: "Invalid ID format",
                result: { reason: castError.message },
            });
        }

        if (!itemId || !itemType) {
            return res.status(400).json({
                success: false,
                message: "Item ID and item type are required",
                result: {},
            });
        }

        if (itemType === "product") {
            return res.status(400).json({
                success: false,
                code: "PRODUCT_CART_DISABLED",
                message: "Products are quotation-only. Request a product quote instead of adding it to the cart.",
                result: {},
            });
        }

        if (itemType !== "service") {
            return res.status(400).json({
                success: false,
                message: "Invalid item type. Cart supports services only.",
                result: {},
            });
        }

        if (!Number.isInteger(quantity) || quantity <= 0) {
            return res.status(400).json({
                success: false,
                message: "Quantity must be a positive integer",
                result: {},
            });
        }

        // 🚀 OPTIMIZED: One-step add/update with detailed population
        const cartItem = await Cart.findOneAndUpdate(
            { customerId, itemType, itemId: targetItemId },
            { $inc: { quantity } },
            {
                new: true,
                runValidators: true,
                upsert: true,
                setDefaultsOnInsert: true
            }
        ).populate({
            path: "itemId",
            model: "Service",
        });

        if (!cartItem) {
            return res.status(500).json({
                success: false,
                message: "Failed to save cart item",
                result: {},
            });
        }

        // Return in the same shape as getMyCart for consistency
        const obj = cartItem.toObject();
        const isPopulated = obj.itemId && typeof obj.itemId === "object" && obj.itemId._id;
        res.status(200).json({
            success: true,
            message: `${itemType} added to cart`,
            result: {
                ...obj,
                itemId: isPopulated ? obj.itemId._id : obj.itemId,
                item: isPopulated ? obj.itemId : null,
            },
        });
    } catch (error) {
        if (res.headersSent) return;
        console.error("Add to cart error:", error);
        const statusCode = error.code === 11000 ? 400 : (error.statusCode || 500);
        res.status(statusCode).json({
            success: false,
            message: "Failed to add item to cart",
            result: { reason: getErrorMessage(error) },
        });
    }
};

/* ================= GET MY CART ================= */
export const getMyCart = async (req, res) => {
    try {
        ensureCustomer(req);
        const customerId = req.user.userId;

        // Product carts are disabled: the cart is service-only.
        const cartItems = await Cart.find({ customerId, itemType: "service" }).lean();
        if (!cartItems.length) {
            return res.status(200).json({
                success: true,
                message: "Cart is empty",
                result: [],
            });
        }

        const serviceIds = cartItems.map((item) => item.itemId);
        const services = await Service.find({ _id: { $in: serviceIds } }).lean();
        const itemMap = Object.fromEntries(services.map((service) => [service._id.toString(), service]));

        const result = cartItems.map((cartItem) => ({
            ...cartItem,
            item: itemMap[cartItem.itemId.toString()] || null,
        }));

        res.status(200).json({
            success: true,
            message: "Cart fetched successfully",
            result: result,
        });
    } catch (error) {
        if (res.headersSent) return;
        console.error("Get my cart error:", error);
        res.status(error.statusCode || 500).json({
            success: false,
            message: "Failed to fetch cart",
            result: { reason: getErrorMessage(error) },
        });
    }
};

/* ================= UPDATE CART ITEM ================= */
export const updateCartItem = async (req, res) => {
    try {
        ensureCustomer(req);
        const { itemId, itemType, quantity } = req.body;
        const customerId = req.user.userId;

        if (!itemId || !itemType || quantity === undefined) {
            return res.status(400).json({ success: false, message: "Missing required fields" });
        }

        if (itemType === "product" && quantity > 0) {
            return res.status(400).json({
                success: false,
                code: "PRODUCT_CART_DISABLED",
                message: "Products are quotation-only and cannot be updated in the cart.",
                result: {},
            });
        }

        if (quantity <= 0) {
            await Cart.findOneAndDelete({ customerId, itemType, itemId });
            return res.status(200).json({ success: true, message: "Item removed", result: { deleted: true, itemId } });
        }

        // 🚀 ATOMIC & POPULATED: Return full details for instant UI update
        const cartItem = await Cart.findOneAndUpdate(
            { customerId, itemType, itemId },
            { quantity },
            { new: true, runValidators: true }
        ).populate({
            path: "itemId",
            model: "Service",
        }).lean();

        if (!cartItem) {
            return res.status(404).json({ success: false, message: "Cart item not found" });
        }

        res.status(200).json({
            success: true,
            message: "Cart item updated",
            result: {
                ...cartItem,
                item: cartItem.itemId,
                itemId: cartItem.itemId?._id || cartItem.itemId
            },
        });
    } catch (error) {
        if (res.headersSent) return;
        console.error("Update cart item error:", error);
        res.status(500).json({ success: false, message: "Update failed" });
    }
};

/* ================= GET CART BY ID ================= */
export const getCartById = async (req, res) => {
    try {
        ensureCustomer(req);
        const { id } = req.params;
        const customerId = req.user.userId;

        const cartItem = await Cart.findOne({ _id: id, customerId });

        if (!cartItem) {
            return res.status(404).json({
                success: false,
                message: "Cart item not found",
                result: {},
            });
        }

        if (cartItem.itemType === "product") {
            return res.status(400).json({
                success: false,
                code: "PRODUCT_CART_DISABLED",
                message: "Products are quotation-only and are not available in the cart.",
                result: {},
            });
        }

        // Populate the item (uses populate; keeps response shape the same)
        await cartItem.populate({ path: "itemId", model: "Service" });

        const obj = cartItem.toObject();
        const isPopulated = obj.itemId && typeof obj.itemId === "object" && obj.itemId._id;
        const item = isPopulated ? obj.itemId : null;

        res.status(200).json({
            success: true,
            message: "Cart item fetched",
            result: {
                ...obj,
                itemId: isPopulated ? obj.itemId._id : obj.itemId,
                item,
            },
        });
    } catch (error) {
        if (res.headersSent) return;
        console.error("Get cart by id error:", error);
        res.status(error.statusCode || 500).json({
            success: false,
            message: "Failed to fetch cart item",
            result: { reason: getErrorMessage(error) },
        });
    }
};

/* ================= GET CART BY ID (UNRESTRICTED) ================= */
export const getCartByIdUnrestricted = async (req, res) => {
    try {
        const { id } = req.params;

        const cartItem = await Cart.findById(id);

        if (!cartItem) {
            return res.status(404).json({
                success: false,
                message: "Cart item not found",
                result: {},
            });
        }

        // 🔒 Ownership — a user may only read their OWN cart item
        if (
            req.user?.userId &&
            cartItem.customerId &&
            String(cartItem.customerId) !== String(req.user.userId)
        ) {
            return res.status(403).json({
                success: false,
                message: "Access denied",
                result: {},
            });
        }

        if (cartItem.itemType === "product") {
            return res.status(400).json({
                success: false,
                code: "PRODUCT_CART_DISABLED",
                message: "Products are quotation-only and are not available in the cart.",
                result: {},
            });
        }

        // Populate the item (uses populate; keeps response shape the same)
        await cartItem.populate({ path: "itemId", model: "Service" });

        const obj = cartItem.toObject();
        const isPopulated = obj.itemId && typeof obj.itemId === "object" && obj.itemId._id;
        const item = isPopulated ? obj.itemId : null;

        res.status(200).json({
            success: true,
            message: "Cart item fetched",
            result: {
                ...obj,
                itemId: isPopulated ? obj.itemId._id : obj.itemId,
                item,
            },
        });
    } catch (error) {
        if (res.headersSent) return;
        console.error("Get cart by id unrestricted error:", error);
        res.status(error.statusCode || 500).json({
            success: false,
            message: "Failed to fetch cart item",
            result: { reason: getErrorMessage(error) },
        });
    }
};

/* ================= UPDATE CART BY ID ================= */
export const updateCartById = async (req, res) => {
    try {
        ensureCustomer(req);
        const { id } = req.params;
        const { quantity } = req.body;
        const customerId = req.user.userId;

        if (quantity == null) {
            return res.status(400).json({
                success: false,
                message: "Quantity is required",
                result: {},
            });
        }

        if (!Number.isInteger(quantity)) {
            return res.status(400).json({
                success: false,
                message: "Quantity must be an integer",
                result: {},
            });
        }

        if (quantity <= 0) {
            // Remove the item
            const deletedItem = await Cart.findOneAndDelete({ _id: id, customerId });
            if (!deletedItem) {
                return res.status(404).json({
                    success: false,
                    message: "Cart item not found",
                    result: {},
                });
            }
            return res.status(200).json({
                success: true,
                message: "Cart item removed",
                result: {},
            });
        }

        const existing = await Cart.findOne({ _id: id, customerId }).select("itemType").lean();
        if (!existing) {
            return res.status(404).json({ success: false, message: "Cart item not found" });
        }
        if (existing.itemType === "product") {
            return res.status(400).json({
                success: false,
                code: "PRODUCT_CART_DISABLED",
                message: "Products are quotation-only and cannot be updated in the cart.",
                result: {},
            });
        }

        // 🚀 SCALABILITY: Populate and return lean object for speed
        const cartItem = await Cart.findOneAndUpdate(
            { _id: id, customerId },
            { quantity },
            { new: true, runValidators: true }
        ).populate({ path: "itemId", model: "Service" });

        if (!cartItem) {
            return res.status(404).json({ success: false, message: "Cart item not found" });
        }

        const obj = cartItem.toObject();
        res.status(200).json({
            success: true,
            message: "Cart item updated",
            result: {
                ...obj,
                item: obj.itemId,
                itemId: obj.itemId?._id || obj.itemId
            },
        });
    } catch (error) {
        if (res.headersSent) return;
        console.error("Update cart by id error:", error);
        res.status(500).json({ success: false, message: "Update failed" });
    }
};

/* ================= SET CART ITEM SCHEDULE ================= */
// Helper to parse timeSlot range ("02:00 PM - 03:00 PM") or time string ("14:00", "02:00 PM") into HH:MM
const parseTimeString = (timeInput) => {
    if (!timeInput || typeof timeInput !== "string") return null;
    let str = timeInput.trim();

    if (str.includes("-")) {
        str = str.split("-")[0].trim();
    }

    const match12 = str.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
    if (match12) {
        let hours = parseInt(match12[1], 10);
        const minutes = match12[2];
        const ampm = match12[3].toUpperCase();
        if (ampm === "PM" && hours < 12) hours += 12;
        if (ampm === "AM" && hours === 12) hours = 0;
        const hh = hours < 10 ? `0${hours}` : `${hours}`;
        return `${hh}:${minutes}`;
    }

    const match24 = str.match(/^(\d{1,2}):(\d{2})$/);
    if (match24) {
        const hours = parseInt(match24[1], 10);
        const minutes = match24[2];
        const hh = hours < 10 ? `0${hours}` : `${hours}`;
        return `${hh}:${minutes}`;
    }

    return null;
};

/**
 * @route   GET /api/user/cart/schedule-slots
 * @desc    Get allowed schedule dates (Tomorrow & Day After Tomorrow) and formatted time slots
 * @access  Private (Auth) / Public
 */
export const getCartScheduleSlots = async (req, res) => {
    try {
        const days = generateScheduleDays();
        const timeSlots = generateTimeSlots().map((slot) => ({
            timeSlot: slot.label,
            startTime: slot.value,
            endTime: slot.endTime,
            label: slot.label,
        }));

        const allowedDates = days.map((day) => ({
            label: day.label,
            date: day.date,
            month: day.month,
            dayName: day.dayName,
            bookingDate: day.fullDate,
        }));

        return res.status(200).json({
            success: true,
            message: "Cart schedule slots retrieved successfully (next five days)",
            result: {
                allowedDates,
                timeSlots,
                samplePayloadFormat: {
                    itemId: "SAMPLE_ITEM_ID",
                    bookingDate: allowedDates[0]?.bookingDate,
                    timeSlot: timeSlots[0]?.label,
                    faultProblem: "Optional description of issue"
                }
            }
        });
    } catch (error) {
        console.error("❌ getCartScheduleSlots Error:", error);
        return res.status(500).json({
            success: false,
            message: error.message || "Failed to retrieve schedule slots",
            result: { error: error.message }
        });
    }
};

export const setCartItemSchedule = async (req, res) => {
    try {
        ensureCustomer(req);
        const { itemId, scheduledDate, bookingDate, scheduledTime, timeSlot, scheduledAt, faultProblem } = req.body;
        const itemType = req.body.itemType || "service"; // Default to service
        const customerId = req.user.userId;

        if (!itemId) {
            return res.status(400).json({
                success: false,
                message: "itemId is required",
                result: {},
            });
        }

        if (itemType === "product") {
            return res.status(400).json({
                success: false,
                code: "PRODUCT_CART_DISABLED",
                message: "Products are quotation-only and cannot be scheduled in the cart.",
                result: {},
            });
        }

        const effectiveDate = scheduledDate || bookingDate;
        const rawTime = scheduledTime || timeSlot;
        const parsedTime = parseTimeString(rawTime);

        // ─── Resolve Time (timezone-safe, same utility as GET /slots) ──────
        let finalScheduledAt = null;
        let scheduledDateLocal = null;
        let scheduledTimeLocal = null;
        let timezone = null;
        if (effectiveDate && parsedTime) {
            const validation = validateSlot(effectiveDate, parsedTime);
            if (!validation.valid) {
                const { from, to } = scheduleBookingWindow();
                return res.status(400).json({
                    success: false,
                    message: validation.error,
                    result: {
                        providedDate: effectiveDate,
                        allowed: [from.toISOString().split("T")[0], to.toISOString().split("T")[0]],
                    },
                });
            }
            finalScheduledAt = validation.scheduledAt;
            timezone = BUSINESS_TIMEZONE;
            const local = formatInBusinessTimezone(finalScheduledAt);
            scheduledDateLocal = localDateInBusinessTimezone(finalScheduledAt);
            scheduledTimeLocal = `${local.hours}:${local.minutes}`;
        } else if (scheduledAt) {
            finalScheduledAt = new Date(scheduledAt);
        }

        // If neither time provided, and we're not just clearing it, error
        if (!finalScheduledAt && (effectiveDate || rawTime || scheduledAt)) {
            return res.status(400).json({ success: false, message: "Invalid date/time format provided", result: {} });
        }


        const updateData = {};
        if (finalScheduledAt) {
            updateData.scheduledAt = finalScheduledAt;
            updateData.scheduledDate = scheduledDateLocal || effectiveDate;
            updateData.scheduledTime = scheduledTimeLocal || parsedTime;
            updateData.timezone = timezone;
        }
        if (faultProblem !== undefined) updateData.faultProblem = faultProblem;

        if (Object.keys(updateData).length === 0) {
            return res.status(400).json({
                success: false,
                message: "No schedule or fault data provided",
                result: {},
            });
        }

        const cartItem = await Cart.findOneAndUpdate(
            { customerId, itemType, itemId },
            updateData,
            { new: true, runValidators: true }
        ).populate({
            path: "itemId",
            model: "Service",
        }).lean();

        if (!cartItem) {
            return res.status(404).json({
                success: false,
                message: "Cart item not found. Add to cart first.",
                result: {},
            });
        }

        res.status(200).json({
            success: true,
            message: "Schedule updated",
            result: {
                ...cartItem,
                item: cartItem.itemId,
                itemId: cartItem.itemId?._id || cartItem.itemId
            },
        });
    } catch (error) {
        if (res.headersSent) return;
        console.error("Set cart item schedule error:", error);
        res.status(500).json({ success: false, message: "Scheduling failed" });
    }
};

/* ================= REMOVE FROM CART ================= */
export const removeFromCart = async (req, res) => {
    try {
        ensureCustomer(req);
        const { id } = req.params;
        const customerId = req.user.userId;

        const cartItem = await Cart.findOneAndDelete({ _id: id, customerId });

        if (!cartItem) {
            return res.status(404).json({
                success: false,
                message: "Cart item not found",
                result: {},
            });
        }

        res.status(200).json({
            success: true,
            message: "Item removed from cart",
            result: {},
        });
    } catch (error) {
        if (res.headersSent) return;
        console.error("Remove from cart error:", error);
        res.status(error.statusCode || 500).json({
            success: false,
            message: "Failed to remove item from cart",
            result: { reason: getErrorMessage(error) },
        });
    }
};

/* ================= REMOVE FROM CART (UNRESTRICTED) ================= */
export const removeFromCartUnrestricted = async (req, res) => {
    try {
        const { id } = req.params;

        const cartItem = await Cart.findById(id);

        if (!cartItem) {
            return res.status(404).json({
                success: false,
                message: "Cart item not found",
                result: {},
            });
        }

        // 🔒 Ownership — a user may only delete their OWN cart item
        if (
            req.user?.userId &&
            cartItem.customerId &&
            String(cartItem.customerId) !== String(req.user.userId)
        ) {
            return res.status(403).json({
                success: false,
                message: "Access denied",
                result: {},
            });
        }

        await Cart.findByIdAndDelete(id);

        res.status(200).json({
            success: true,
            message: "Item removed from cart",
            result: {},
        });
    } catch (error) {
        if (res.headersSent) return;
        console.error("Remove from cart unrestricted error:", error);
        res.status(error.statusCode || 500).json({
            success: false,
            message: "Failed to remove item from cart",
            result: { reason: getErrorMessage(error) },
        });
    }
};

/* ================= CHECKOUT (WITH TRANSACTION & VALIDATION) ================= */
export const checkout = async (req, res) => {
    const session = await mongoose.startSession();
    session.startTransaction();
    const checkoutKeys = [];
    let preparedBookings = [];

    try {
        ensureCustomer(req);
        const customerId = req.user.userId;

        // Optional safety: ensure user still exists
        if (!req.user) {
            await session.abortTransaction();
            return res.status(404).json({
                success: false,
                message: "User not found",
                result: {},
            });
        }
        // Check for required user fields - REMOVED to allow ad-hoc checkout with provided name/phone
        // Logical validation happens later with derivedName/derivedPhone

        const productCartItem = await Cart.findOne({ customerId, itemType: "product" })
            .select("_id itemId")
            .session(session)
            .lean();
        if (productCartItem) {
            await session.abortTransaction();
            return res.status(400).json({
                success: false,
                code: "PRODUCT_CART_DISABLED",
                message: "Products are quotation-only. Remove product items from your cart and request a quote instead.",
                result: { cartItemId: productCartItem._id, itemId: productCartItem.itemId },
            });
        }

        const addressId = normalizeAddressId(req.body?.addressId);

        // Check for nested address object (Frontend sends this)
        const addressPayload = req.body?.address || req.body || {};

        const addressLineInput = typeof addressPayload.addressLine === "string" ? addressPayload.addressLine.trim() : "";
        const cityInput = typeof addressPayload.city === "string" ? addressPayload.city.trim() : undefined;
        const stateInput = typeof addressPayload.state === "string" ? addressPayload.state.trim() : undefined;
        const pincodeInput = typeof addressPayload.pincode === "string" ? addressPayload.pincode.trim() : undefined;

        // Support both top-level lat/lng and nested location { latitude, longitude } and address.latitude
        const latInput =
            toFiniteNumber(addressPayload.latitude) ??
            toFiniteNumber(addressPayload.location?.latitude) ??
            toFiniteNumber(req.body?.latitude);

        const lngInput =
            toFiniteNumber(addressPayload.longitude) ??
            toFiniteNumber(addressPayload.location?.longitude) ??
            toFiniteNumber(req.body?.longitude);

        // Validate address provided
        const hasCoords = latInput !== null && lngInput !== null;
        const hasAnyAddressInput = Boolean(addressId) || Boolean(addressLineInput) || hasCoords;
        if (!hasAnyAddressInput) {
            await session.abortTransaction();
            return res.status(400).json({
                success: false,
                message: "Provide either addressId or addressLine or latitude/longitude",
                result: {},
            });
        }

        // ─── Resolve checkout timing ───────────────────────────────
        const now = new Date();

        // 🔁 Decision Logic: Address ID vs Current Location (Automated locationType)
        let resolvedLocation;
        try {
            // Automatically determine locationType if not provided
            let locType = req.body.locationType;
            if (addressId) {
                locType = "saved";
            } else if (latInput !== null && lngInput !== null) {
                locType = "gps";
            }

            resolvedLocation = await resolveUserLocation({
                locationType: locType || "gps",
                addressId: addressId,
                latitude: latInput,
                longitude: lngInput,
                userId: customerId,
            });
        } catch (locErr) {
            await session.abortTransaction();
            return res.status(400).json({
                success: false,
                message: locErr.message,
                result: {},
            });
        }

        // 🏘 ZONE & DISTRICT RESOLUTION — strict: include inactive zones so a
        // deactivated zone BLOCKS checkout instead of falling back to district.
        let resolvedZoneId = null;
        let resolvedDistrictId = null;
        let resolvedZoneActive = null;
        if (resolvedLocation.latitude && resolvedLocation.longitude) {
            const { district, zone } = await resolveDistrictAndZoneFromCoordinates(
                resolvedLocation.latitude,
                resolvedLocation.longitude,
                { includeInactiveZone: true }
            );
            if (zone) {
                resolvedZoneId = zone._id;
                resolvedZoneActive = zone.active !== false;
                if (resolvedZoneActive === false) {
                    await session.abortTransaction();
                    return res.status(400).json({
                        success: false,
                        code: "SERVICE_NOT_AVAILABLE",
                        message: "Services are currently unavailable in your area (zone deactivated)",
                        result: { zoneId: zone._id, reason: "ZONE_INACTIVE" },
                    });
                }
            }
            if (district?._id) resolvedDistrictId = district._id;
            // FINAL RULE: booking address must resolve to BOTH District AND Zone.
            // No zone (outside all zone polygons) → block, no district fallback.
            if (!resolvedZoneId || !resolvedDistrictId) {
                await session.abortTransaction();
                return res.status(400).json({
                    success: false,
                    code: "SERVICE_NOT_AVAILABLE",
                    message: "Service unavailable in this area. This service is currently not available at the selected address.",
                    result: { reason: !resolvedZoneId ? "ZONE_REQUIRED" : "DISTRICT_REQUIRED" },
                });
            }
            // Parent-link guard: zone must belong to the geo district.
            if (zone && district && String(zone.operationalCityId) !== String(district._id)) {
                await session.abortTransaction();
                return res.status(400).json({
                    success: false,
                    code: "SERVICE_NOT_AVAILABLE",
                    message: "Service unavailable in this area. This service is currently not available at the selected address.",
                    result: { reason: "ZONE_DISTRICT_MISMATCH" },
                });
            }
        } else {
            // STRICT: booking requires a resolvable address location.
            // Saved addresses without coordinates cannot be zone-resolved,
            // so block instead of bypassing geo restrictions.
            await session.abortTransaction();
            return res.status(400).json({
                success: false,
                code: "SERVICE_NOT_AVAILABLE",
                message: "Service unavailable in this area. This service is currently not available at the selected address.",
                result: { reason: "LOCATION_REQUIRED" },
            });
        }

        // Address Snapshot for both Products and Services
        const addressSnapshot = resolvedLocation.addressSnapshot;

        // Legacy support: ensure some address text exists
        if (!addressSnapshot.addressLine) {
            addressSnapshot.addressLine = "Pinned Location";
        }

        // Validate that name and phone exist (required for booking)
        if (!addressSnapshot.name || !addressSnapshot.phone) {
            // Fetch user profile as fallback if name/phone still missing
            const userProfile = await User.findById(customerId).select("fname lname mobileNumber").session(session);

            if (!addressSnapshot.name && userProfile) {
                addressSnapshot.name = [userProfile.fname, userProfile.lname].filter(Boolean).join(" ").trim();
            }

            if (!addressSnapshot.phone && userProfile?.mobileNumber) {
                addressSnapshot.phone = userProfile.mobileNumber;
            }

            // Final validation: name and phone MUST exist for booking
            if (!addressSnapshot.name || !addressSnapshot.phone) {
                const error = new Error("Complete profile with name and phone required for booking");
                error.statusCode = 400;
                throw error;
            }
        }

        // Get all service cart items for the user (product carts are disabled)
        const cartItems = await Cart.find({ customerId, itemType: "service" }).session(session);

        if (cartItems.length === 0) {
            await session.abortTransaction();
            return res.status(400).json({
                success: false,
                message: "Cart is empty",
                result: {},
            });
        }

        // 🔒 VALIDATE: Remove deleted/inactive items and check for price changes/invalid schedules
        const validServiceItems = [];
        const removedItems = [];
        const invalidSchedules = [];

        for (const cartItem of cartItems) {
            if (cartItem.itemType === "service") {
                const service = await Service.findById(cartItem.itemId).session(session);
                if (!service || !service.isActive) {
                    await Cart.findOneAndDelete({ _id: cartItem._id, customerId }).session(session);
                    removedItems.push({ id: cartItem.itemId, name: service?.serviceName || "Unknown Service", type: "service", reason: "not found or inactive" });
                } else {
                    // Check if schedule is in the past or invalid window (timezone-safe)
                    if (cartItem.scheduledAt) {
                        const itemCheck = validateScheduledAtUtc(new Date(cartItem.scheduledAt), { now });
                        if (!itemCheck.valid) {
                            invalidSchedules.push({
                                id: cartItem.itemId,
                                name: service.serviceName,
                                currentSchedule: new Date(cartItem.scheduledAt).toLocaleString("en-IN", {
                                    day: "2-digit", month: "short", year: "numeric",
                                    hour: "2-digit", minute: "2-digit", hour12: true
                                })
                            });
                        }
                    }
                    validServiceItems.push(cartItem);
                }
            }
        }

        // 🔒 Block checkout if items were removed or have invalid schedules
        if (removedItems.length > 0 || invalidSchedules.length > 0) {
            await session.abortTransaction();
            return res.status(400).json({
                success: false,
                message: invalidSchedules.length > 0
                    ? "Some items in your cart have outdated schedules. Please refresh your selected date/time."
                    : "Some items in your cart are no longer available.",
                result: { removedItems, invalidSchedules },
            });
        }

        if (validServiceItems.length === 0) {
            await session.abortTransaction();
            return res.status(400).json({
                success: false,
                message: "No valid items in cart",
                result: {},
            });
        }

        // Resolve top-level schedule intent once. Per-item schedules stay
        // authoritative; a valid top-level schedule fills only items that do
        // not have their own date/time. This keeps older clients from
        // silently creating instant bookings for a scheduled checkout.
        const topLevelSchedule = resolveScheduleInput(req.body, { now });
        const requestedSchedule =
            topLevelSchedule.scheduleIntent === true ||
            topLevelSchedule.bookingType === "schedule";

        const itemHasSchedule = (item) =>
            Boolean(item.scheduledAt || (item.scheduledDate && item.scheduledTime));

        const unscheduledItems = validServiceItems.filter((item) => !itemHasSchedule(item));
        const fallbackSchedule =
            topLevelSchedule.bookingType === "schedule" && !topLevelSchedule.error
                ? topLevelSchedule
                : null;

        if (requestedSchedule && unscheduledItems.length > 0 && !fallbackSchedule) {
            await session.abortTransaction();
            return res.status(400).json({
                success: false,
                code: topLevelSchedule.errorCode || "SCHEDULE_SELECTION_REQUIRED",
                message:
                    topLevelSchedule.error ||
                    "Select a valid date and time for this service before scheduling checkout.",
                result: {
                    unscheduledItems: unscheduledItems.map((item) => ({
                        cartItemId: item._id,
                        itemId: item.itemId,
                    })),
                },
            });
        }

        const effectiveScheduleFor = (cartItem) =>
            resolveCartItemSchedule(cartItem, { now, fallbackSchedule });

        for (const cartItem of validServiceItems) {
            const effectiveSchedule = effectiveScheduleFor(cartItem);
            if (effectiveSchedule.error) {
                await session.abortTransaction();
                return res.status(400).json({
                    success: false,
                    code: "INVALID_SCHEDULE",
                    message: effectiveSchedule.error,
                    result: {},
                });
            }
            checkoutKeys.push(
                resolveBookingIdempotencyKey({
                    req,
                    scope: "cart-checkout",
                    customerId: String(customerId),
                    suffix: String(cartItem._id),
                    fingerprint: {
                        serviceId: String(cartItem.itemId),
                        bookingType: effectiveSchedule.bookingType,
                        scheduledAt: effectiveSchedule.scheduledAt
                            ? new Date(effectiveSchedule.scheduledAt).toISOString()
                            : null,
                        slotKey: effectiveSchedule.slotKey || null,
                        scheduledDate:
                            cartItem.scheduledDate || effectiveSchedule.scheduledDateLocal || null,
                        scheduledTime:
                            cartItem.scheduledTime || effectiveSchedule.scheduledTimeLocal || null,
                        quantity: cartItem.quantity || 1,
                        tipAmount: Math.max(toFiniteNumber(cartItem?.tipAmount) || 0, 0),
                        addressId: resolvedLocation.addressId
                            ? String(resolvedLocation.addressId)
                            : null,
                        latitude: resolvedLocation.latitude,
                        longitude: resolvedLocation.longitude,
                    },
                })
            );
        }

        const existingBookings = await ServiceBooking.find({
            idempotencyKey: { $in: checkoutKeys },
        }).session(session);
        const existingByKey = new Map(
            existingBookings.map((booking) => [booking.idempotencyKey, booking])
        );

        if (existingBookings.length === checkoutKeys.length) {
            await Cart.deleteMany({ customerId }).session(session);
            await session.commitTransaction();
            return buildCheckoutReplay(res, existingBookings);
        }

        const bookingResults = {
            address: {
                _id: addressSnapshot._id,
                name: addressSnapshot.name,
                phone: addressSnapshot.phone,
                addressLine: addressSnapshot.addressLine,
                city: addressSnapshot.city,
                state: addressSnapshot.state,
                pincode: addressSnapshot.pincode,
                latitude: addressSnapshot.latitude,
                longitude: addressSnapshot.longitude,
            },
            serviceBookings: [],
            totalAmount: 0,
            totalAmountPaise: 0,
        };

        const serviceBroadcastTasks = [];
        preparedBookings = [];
        const cartGroupId = `cart_${customerId}_${Date.now()}`;

        // Create Service Bookings
        for (let index = 0; index < validServiceItems.length; index += 1) {
            const cartItem = validServiceItems[index];
            const idempotencyKey = checkoutKeys[index];
            const service = await Service.findById(cartItem.itemId).session(session);

            if (!service || !service.isActive) {
                await session.abortTransaction();
                return res.status(400).json({
                    success: false,
                    message: "Service is not active",
                    result: {},
                });
            }

            // 🏘 SERVICE AVAILABILITY CHECK (Zone & District)
            const { resolveServiceAvailability } = await import("../Services/serviceAvailabilityService.js");
            const avail = await resolveServiceAvailability({
                serviceId: cartItem.itemId,
                districtId: resolvedDistrictId,
                cityZoneId: resolvedZoneId,
            });
            if (!avail.available) {
                await session.abortTransaction();
                return res.status(400).json({
                    success: false,
                    message: "Service unavailable in this area. This service is currently not available at the selected address.",
                    code: "SERVICE_NOT_AVAILABLE",
                    result: { reason: avail.reason || "SERVICE_NOT_AVAILABLE" },
                });
            }

            // ─── Resolve effective schedule per item (per-item first) ───
            const schedule = effectiveScheduleFor(cartItem);

            if (schedule.error) {
                await session.abortTransaction();
                return res.status(400).json({
                    success: false,
                    code: "INVALID_SCHEDULE",
                    message: schedule.error,
                    result: {},
                });
            }

            // 💰 SERVER-SIDE SPLIT — canonical financial snapshot per cart item.
            const doc = await buildServiceBookingDoc({
                service,
                resolvedLocation,
                schedule,
                tipAmountRupees: Math.max(toFiniteNumber(cartItem?.tipAmount) || 0, 0),
                customerId,
                quantity: cartItem.quantity || 1,
                cityZoneId: resolvedZoneId,
                districtId: resolvedDistrictId,
            });

            // 💸 Fail fast: online payments require a total of ₹0 (free) or at least ₹1.
            const docTotalPaise = toPaise(doc.financialSnapshot?.totalAmountPaise);
            if (!isPayableTotalPaise(docTotalPaise)) {
                await session.abortTransaction();
                return res.status(400).json({
                    success: false,
                    message: `Minimum payable amount is ₹1 (booking total is ₹${(docTotalPaise / 100).toFixed(2)})`,
                    result: {},
                });
            }

            const existingBooking = existingByKey.get(idempotencyKey);
            if (existingBooking) {
                bookingResults.serviceBookings.push({
                    bookingId: existingBooking._id,
                    serviceId: cartItem.itemId,
                    serviceName: service.serviceName,
                    quantity: cartItem.quantity,
                    baseAmount: existingBooking.baseAmount,
                    status: existingBooking.status,
                });
                bookingResults.totalAmountPaise += toPaise(existingBooking.financialSnapshot?.totalAmountPaise);
                continue;
            }

            doc.idempotencyKey = idempotencyKey;
            doc.cartGroupId = cartGroupId;

            let booking;
            if (doc.bookingType === "schedule") {
                const prepared = await prepareScheduledBooking({
                    doc,
                    session,
                    latitude: resolvedLocation.latitude,
                    longitude: resolvedLocation.longitude,
                    cartGroupId,
                });
                preparedBookings.push(prepared);
                booking = prepared.booking;
            } else {
                const created = await createBookingAndOutbox({ doc, session });
                booking = created.booking;
            }

            // Always broadcast immediately for both Instant and Scheduled in new flow
            serviceBroadcastTasks.push({ bookingId: booking._id });

            bookingResults.serviceBookings.push({
                bookingId: booking._id,
                serviceId: cartItem.itemId,
                serviceName: service.serviceName,
                quantity: cartItem.quantity,
                baseAmount: doc.baseAmount,
                status: "pending",
            });

            // Accumulate the GST-inclusive, paise-based total from the canonical
            // financial snapshot (base + GST + tip) — NOT the ex-GST baseAmount,
            // so service and product lines reconcile to the same definition.
            bookingResults.totalAmountPaise += toPaise(doc.financialSnapshot?.totalAmountPaise);
        }

        // Clear the cart only after all items are processed successfully
        await Cart.deleteMany({ customerId }).session(session);

        await session.commitTransaction();

        // 7️⃣ Post-Transaction: Broadcast Jobs (Safe & Smart)
        if (serviceBroadcastTasks.length > 0) {
            (async () => {
                for (const task of serviceBroadcastTasks) {
                    await matchAndBroadcastBooking(task.bookingId, req.io);
                }
            })();
        }

        const hasScheduled = bookingResults.serviceBookings.length > 0 && preparedBookings.length > 0;
        const responseMessage = hasScheduled
            ? "Booking placed. Scheduled services are awaiting technician confirmation."
            : "Service booking confirmed successfully";

        const firstId = bookingResults.serviceBookings?.[0]?.bookingId;

        bookingResults.totalAmount = bookingResults.totalAmountPaise / 100;

        return res.status(200).json({
            success: true,
            message: responseMessage,
            result: {
                ...bookingResults,
                _id: firstId,
                bookingId: firstId,
            },
        });
    } catch (error) {
        await session.abortTransaction();
        for (const prepared of preparedBookings || []) {
            if (prepared?.releaseCapacity) await prepared.releaseCapacity();
        }
        console.error("Checkout error:", error);

        if (isDuplicateKeyError(error) && checkoutKeys.length > 0) {
            const existing = await ServiceBooking.find({
                idempotencyKey: { $in: checkoutKeys },
            }).lean();
            if (existing.length === checkoutKeys.length) {
                return buildCheckoutReplay(res, existing);
            }
        }

        const isWriteConflict =
            error?.code === 112 ||
            /WriteConflict|TransientTransactionError/i.test(String(error?.message || ""));
        const statusCode =
            isDuplicateKeyError(error) || isWriteConflict
                ? 409
                : (error?.statusCode || 500);
        res.status(statusCode).json({
            success: false,
            message: isWriteConflict
                ? "Checkout already in progress. Please retry."
                : "Checkout failed",
            result: { reason: getErrorMessage(error) },
        });
    } finally {
        session.endSession();
    }
};
