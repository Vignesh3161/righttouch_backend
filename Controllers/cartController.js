import Cart from "../Schemas/Cart.js";
import Product from "../Schemas/Product.js";
import Service from "../Schemas/Service.js";
import ServiceBooking from "../Schemas/ServiceBooking.js";
import ProductBooking from "../Schemas/ProductBooking.js";
import Address from "../Schemas/Address.js";
import User from "../Schemas/User.js";
import JobBroadcast from "../Schemas/TechnicianBroadcast.js";
import TechnicianProfile from "../Schemas/TechnicianProfile.js";
import mongoose from "mongoose";
import { matchAndBroadcastBooking } from "../Utils/technicianMatching.js";
import { resolveUserLocation } from "../Utils/resolveUserLocation.js";
import { ensureCustomer } from "../Utils/ensureCustomer.js";
import {
    SERVICE_BOOKING_STATUS,
    PRODUCT_BOOKING_STATUS,
    PAYMENT_STATUS,
} from "../Utils/constants.js";




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

        if (!["product", "service"].includes(itemType)) {
            return res.status(400).json({
                success: false,
                message: "Invalid item type. Must be 'product' or 'service'",
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
            model: itemType === "product" ? "Product" : "Service"
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

        // 🚀 SCALABILITY: Lean query for performance
        const cartItems = await Cart.find({ customerId }).lean();
        if (!cartItems.length) {
            return res.status(200).json({
                success: true,
                message: "Cart is empty",
                result: [],
            });
        }

        // 🚀 BULK POPULATION: Group by type to minimize DB hits (3 queries total)
        const productIds = [];
        const serviceIds = [];
        cartItems.forEach(item => {
            if (item.itemType === "product") productIds.push(item.itemId);
            else if (item.itemType === "service") serviceIds.push(item.itemId);
        });

        const [products, services] = await Promise.all([
            Product.find({ _id: { $in: productIds } }).lean(),
            Service.find({ _id: { $in: serviceIds } }).lean()
        ]);

        const itemMap = {
            product: Object.fromEntries(products.map(p => [p._id.toString(), p])),
            service: Object.fromEntries(services.map(s => [s._id.toString(), s]))
        };

        const result = cartItems.map((cartItem) => {
            const item = itemMap[cartItem.itemType][cartItem.itemId.toString()];
            return {
                ...cartItem,
                item: item || null,
            };
        });

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
            model: itemType === "product" ? "Product" : "Service"
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

        // Populate the item (uses populate; keeps response shape the same)
        const model = cartItem.itemType === "product" ? "Product" : "Service";
        await cartItem.populate({ path: "itemId", model });

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

        // Populate the item (uses populate; keeps response shape the same)
        const model = cartItem.itemType === "product" ? "Product" : "Service";
        await cartItem.populate({ path: "itemId", model });

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

        // 🚀 SCALABILITY: Populate and return lean object for speed
        const cartItem = await Cart.findOneAndUpdate(
            { _id: id, customerId },
            { quantity },
            { new: true, runValidators: true }
        ).populate({
            path: "itemId",
            model: "will_be_resolved_by_refPath_if_configured_but_here_we_manual"
        });

        if (!cartItem) {
            return res.status(404).json({ success: false, message: "Cart item not found" });
        }

        // Manual populate if needed, but safer to use the type
        const model = cartItem.itemType === "product" ? "Product" : "Service";
        await cartItem.populate({ path: "itemId", model });

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
        const now = new Date();

        const allowedDates = [];
        for (let i = 1; i <= 2; i++) {
            const d = new Date(now);
            d.setDate(d.getDate() + i);
            const dayName = d.toLocaleDateString("en-US", { weekday: "short" });
            const month = d.toLocaleDateString("en-US", { month: "short" });
            const fullDate = d.toISOString().split("T")[0];

            allowedDates.push({
                label: i === 1 ? "Tomorrow" : "Day after Tomorrow",
                date: d.getDate(),
                month,
                dayName,
                bookingDate: fullDate,
            });
        }

        const timeSlots = [];
        const startHour = 9;
        const endHour = 20;

        for (let h = startHour; h <= endHour; h++) {
            const nextH = h + 1;

            const formatHour = (hour) => {
                const period = hour < 12 || hour === 24 ? "AM" : "PM";
                const display = hour % 12 === 0 ? 12 : hour % 12;
                return `${display < 10 ? "0" + display : display}:00 ${period}`;
            };

            const startLabel = formatHour(h);
            const endLabel = formatHour(nextH);
            const slotRange = `${startLabel} - ${endLabel}`;
            const militaryTime = `${h < 10 ? "0" + h : h}:00`;

            timeSlots.push({
                timeSlot: slotRange,
                startTime: militaryTime,
                label: slotRange
            });
        }

        return res.status(200).json({
            success: true,
            message: "Cart schedule slots retrieved successfully (Tomorrow and Day After Tomorrow only)",
            result: {
                allowedDates,
                timeSlots,
                samplePayloadFormat: {
                    itemId: "SAMPLE_ITEM_ID",
                    bookingDate: allowedDates[0].bookingDate,
                    timeSlot: timeSlots[0].timeSlot,
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

        const effectiveDate = scheduledDate || bookingDate;
        const rawTime = scheduledTime || timeSlot;
        const parsedTime = parseTimeString(rawTime);

        // ─── Resolve Time ────────────────────────────────────────────────
        let finalScheduledAt = null;
        if (effectiveDate && parsedTime) {
            // Enforce Tomorrow or Day after Tomorrow
            const now = new Date();

            const tomorrow = new Date(now);
            tomorrow.setDate(tomorrow.getDate() + 1);
            const tomorrowStr = tomorrow.toISOString().split("T")[0];

            const dayAfter = new Date(now);
            dayAfter.setDate(dayAfter.getDate() + 2);
            const dayAfterStr = dayAfter.toISOString().split("T")[0];

            if (effectiveDate !== tomorrowStr && effectiveDate !== dayAfterStr) {
                return res.status(400).json({
                    success: false,
                    message: "Scheduling is only allowed for Tomorrow or Day after Tomorrow. Please refresh slots.",
                    result: { providedDate: effectiveDate, allowed: [tomorrowStr, dayAfterStr] },
                });
            }

            const combined = new Date(`${effectiveDate}T${parsedTime}:00`);
            if (isNaN(combined.getTime())) {
                return res.status(400).json({ success: false, message: "Invalid date or time format", result: {} });
            }
            // Must be 30 min in future
            if (combined <= new Date(Date.now() + 30 * 60 * 1000)) {
                return res.status(400).json({ success: false, message: "Schedule must be at least 30 min in future", result: {} });
            }
            finalScheduledAt = combined;
        } else if (scheduledAt) {
            finalScheduledAt = new Date(scheduledAt);
        }

        // If neither time provided, and we're not just clearing it, error
        if (!finalScheduledAt && (effectiveDate || rawTime || scheduledAt)) {
            return res.status(400).json({ success: false, message: "Invalid date/time format provided", result: {} });
        }


        const updateData = {};
        if (finalScheduledAt) updateData.scheduledAt = finalScheduledAt;
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
            model: itemType === "product" ? "Product" : "Service"
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

        const cartItem = await Cart.findByIdAndDelete(id);

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

        const addressId = normalizeAddressId(req.body?.addressId);
        const scheduledAt = req.body?.scheduledAt;

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

        // ─── Resolve Time ────────────────────────────────────────────────
        const now = new Date();
        const tomorrowStart = new Date(now);
        tomorrowStart.setDate(tomorrowStart.getDate() + 1);
        tomorrowStart.setHours(0, 0, 0, 0);

        const dayAfterEnd = new Date(now);
        dayAfterEnd.setDate(dayAfterEnd.getDate() + 2);
        dayAfterEnd.setHours(23, 59, 59, 999);

        // Use scheduledAt if provided, otherwise null (Instant)
        const finalScheduledAt = scheduledAt ? new Date(scheduledAt) : null;

        // 🛡️ PRODUCTION VALIDATION: Scheduled bookings must be Tomorrow or Day after Tomorrow
        if (finalScheduledAt) {
            if (finalScheduledAt < tomorrowStart || finalScheduledAt > dayAfterEnd) {
                await session.abortTransaction();
                return res.status(400).json({
                    success: false,
                    message: "Scheduled bookings are only allowed for Tomorrow or Day after Tomorrow",
                    result: {
                        tomorrow: tomorrowStart.toISOString().split("T")[0],
                        dayAfter: dayAfterEnd.toISOString().split("T")[0]
                    },
                });
            }
        }

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

        // Get all cart items for the user
        const cartItems = await Cart.find({ customerId }).session(session);

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
        const validProductItems = [];
        const removedItems = [];
        const invalidSchedules = [];

        for (const cartItem of cartItems) {
            if (cartItem.itemType === "service") {
                const service = await Service.findById(cartItem.itemId).session(session);
                if (!service || !service.isActive) {
                    await Cart.findOneAndDelete({ _id: cartItem._id, customerId }).session(session);
                    removedItems.push({ id: cartItem.itemId, name: service?.serviceName || "Unknown Service", type: "service", reason: "not found or inactive" });
                } else {
                    // Check if schedule is in the past or invalid window
                    if (cartItem.scheduledAt) {
                        const itemScheduledAt = new Date(cartItem.scheduledAt);
                        if (itemScheduledAt < tomorrowStart || itemScheduledAt > dayAfterEnd) {
                            invalidSchedules.push({
                                id: cartItem.itemId,
                                name: service.serviceName,
                                currentSchedule: itemScheduledAt.toLocaleString("en-IN", {
                                    day: "2-digit", month: "short", year: "numeric",
                                    hour: "2-digit", minute: "2-digit", hour12: true
                                })
                            });
                        }
                    }
                    validServiceItems.push(cartItem);
                }
            } else if (cartItem.itemType === "product") {
                const product = await Product.findById(cartItem.itemId).session(session);
                if (!product || !product.isActive) {
                    await Cart.findOneAndDelete({ _id: cartItem._id, customerId }).session(session);
                    removedItems.push({ id: cartItem.itemId, type: "product", reason: "not found or inactive" });
                } else {
                    validProductItems.push(cartItem);
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

        if (validServiceItems.length === 0 && validProductItems.length === 0) {
            await session.abortTransaction();
            return res.status(400).json({
                success: false,
                message: "No valid items in cart",
                result: {},
            });
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
            productBookings: [],
            totalAmount: 0,
        };

        const serviceBroadcastTasks = [];

        // Create Service Bookings
        for (const cartItem of validServiceItems) {
            const service = await Service.findById(cartItem.itemId).session(session);

            // Calculate amount (using fallback to 0 to avoid NaN)
            const baseAmount = (service.serviceCost || 0) * cartItem.quantity;

            // ─── Detect scheduled vs instant per cart item ───────────────────
            let itemScheduledAt = cartItem.scheduledAt || finalScheduledAt || null;
            let itemBookingType = "instant";

            // Classify as scheduled if > 30 min in the future
            const minFuture = new Date(Date.now() + 30 * 60 * 1000);
            if (itemScheduledAt && itemScheduledAt > minFuture) {
                itemBookingType = "scheduled";
            }

            // 🕒 PRODUCTION TIMEOUT LOGIC
            const now = new Date();
            let autoCancelAt = null;
            if (itemBookingType === "instant") {
                autoCancelAt = new Date(now.getTime() + 1 * 60 * 60 * 1000); // 1 hour for instant
            } else if (itemScheduledAt) {
                autoCancelAt = new Date(now.getTime() + 5 * 60 * 60 * 1000); // 5 hours after creation
            }

            const initialStatus = "pending"; // Atomic pending Status
            // ─────────────────────────────────────────────────────────────────

            const serviceBookingDoc = {
                customerId,
                serviceId: cartItem.itemId,
                bookingType: itemBookingType === "scheduled" ? "schedule" : "instant",
                baseAmount,
                address: addressSnapshot.addressLine,
                addressId: resolvedLocation.addressId || null,
                scheduledAt: itemScheduledAt,
                faultProblem: cartItem.faultProblem || req.body.faultProblem || null,
                status: initialStatus,
                broadcastStartedAt: now,
                autoCancelAt: autoCancelAt,

                locationType: resolvedLocation.locationType,
                addressSnapshot: addressSnapshot,
            };

            // Only add location if coordinates are valid numbers to avoid schema validation errors
            if (resolvedLocation.longitude !== null && resolvedLocation.latitude !== null) {
                serviceBookingDoc.location = {
                    type: "Point",
                    coordinates: [resolvedLocation.longitude, resolvedLocation.latitude],
                };
            }

            const serviceBooking = await ServiceBooking.create([serviceBookingDoc], { session });

            // Always broadcast immediately for both Instant and Scheduled in new flow
            serviceBroadcastTasks.push({ bookingId: serviceBooking[0]._id });

            bookingResults.serviceBookings.push({
                bookingId: serviceBooking[0]._id,
                serviceId: cartItem.itemId,
                serviceName: service.serviceName,
                quantity: cartItem.quantity,
                baseAmount,
                status: initialStatus,
            });

            bookingResults.totalAmount += baseAmount;
        }

        // Create Product Bookings
        for (const cartItem of validProductItems) {
            const product = await Product.findById(cartItem.itemId).session(session);

            // Calculate amount with discount and GST
            // Use estimatedPriceFrom or productPrice as fallback (Product schema has no productPrice)
            const basePrice = (product.productPrice || product.estimatedPriceFrom || 0) * cartItem.quantity;
            const discountAmount =
                (basePrice * (product.productDiscountPercentage || 0)) / 100;
            const discountedPrice = basePrice - discountAmount;
            const gstAmount = (discountedPrice * (product.productGst || 0)) / 100;
            const finalAmount = discountedPrice + gstAmount;

            const productBookingDoc = {
                productId: cartItem.itemId,
                customerId, // Field renamed in schema to match consistency
                amount: isNaN(finalAmount) ? 0 : finalAmount,
                quantity: cartItem.quantity,
                paymentStatus: PAYMENT_STATUS.PENDING,
                status: PRODUCT_BOOKING_STATUS.ACTIVE,

                locationType: resolvedLocation.locationType,
                addressSnapshot: addressSnapshot,
            };

            // Only add location if coordinates are valid numbers
            if (resolvedLocation.longitude !== null && resolvedLocation.latitude !== null) {
                productBookingDoc.location = {
                    type: "Point",
                    coordinates: [resolvedLocation.longitude, resolvedLocation.latitude],
                };
            }

            const productBooking = await ProductBooking.create([productBookingDoc], { session });

            bookingResults.productBookings.push({
                bookingId: productBooking[0]._id,
                productId: cartItem.itemId,
                productName: product.productName,
                quantity: cartItem.quantity,
                basePrice,
                discount: discountAmount,
                gst: gstAmount,
                finalAmount: isNaN(finalAmount) ? 0 : finalAmount,
                paymentStatus: PAYMENT_STATUS.PENDING,
            });

            bookingResults.totalAmount += (isNaN(finalAmount) ? 0 : finalAmount);
        }

        // Clear the cart only after all bookings are created successfully
        await Cart.deleteMany({ customerId }).session(session);

        await session.commitTransaction();

        // 7️⃣ Post-Transaction: Broadcast Jobs (Safe & Smart)
        // We do this OUTSIDE the transaction because it involves heavy logic/sockets
        if (serviceBroadcastTasks.length > 0) {
            // Run in background (fire & forget) or await if you want to report status
            (async () => {
                for (const task of serviceBroadcastTasks) {
                    await matchAndBroadcastBooking(task.bookingId, req.io);
                }
            })();
        }

        const firstBookingId =
            bookingResults.serviceBookings?.[0]?.bookingId ||
            bookingResults.productBookings?.[0]?.bookingId;

        return res.status(200).json({
            success: true,
            message: "Order placed successfully",
            result: {
                ...bookingResults,
                _id: firstBookingId, // 👈 For frontend compatibility
                bookingId: firstBookingId,
            },
        });
    } catch (error) {
        await session.abortTransaction();
        console.error("Checkout error:", error);
        const statusCode = error.code === 11000 ? 400 : (error?.statusCode || 500);
        res.status(statusCode).json({
            success: false,
            message: "Checkout failed",
            result: { reason: getErrorMessage(error) },
        });
    } finally {
        session.endSession();
    }
};
