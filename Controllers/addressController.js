import mongoose from "mongoose";
import axios from "axios";

import Address from "../Schemas/Address.js";
import User from "../Schemas/User.js";
import { ensureCustomer } from "../Utils/ensureCustomer.js";
import { normalizeIndianMobile } from "../Utils/phoneValidation.js";

const getAddressIdFromReq = (req) => req.params?.id || req.body?.addressId || req.body?.id;

/* ================= SEARCH ADDRESS DETAILS ================= */
export const searchAddress = async (req, res) => {
    try {
        const { q } = req.query;
        const apiKey = process.env.GEOCODING_API_KEY;

        const url = `https://us1.locationiq.com/v1/search.php?key=${apiKey}&q=${encodeURIComponent(q)}&format=json&addressdetails=1&limit=1`;

        // Pass User-Agent as required by some providers
        const response = await axios.get(url, { headers: { 'User-Agent': 'MappBackendNodeJS/1.0' } });

        if (!response.data || response.data.length === 0) {
            return res.status(404).json({ success: false, message: "Address fetch failed, no results" });
        }

        const result = response.data[0];

        res.json({
            success: true,
            result: {
                addressLine: result.display_name,
                city: result.address?.city || result.address?.town || result.address?.county,
                state: result.address?.state,
                pincode: result.address?.postcode,
                latitude: parseFloat(result.lat),
                longitude: parseFloat(result.lon)
            }
        });
    } catch (error) {
        console.error("Search Address Error", error);
        res.status(500).json({ success: false, message: "Address fetch failed" });
    }
};

/* ================= REVERSE GEOCODE (LAT/LNG -> DETAILS) ================= */
export const reverseAddress = async (req, res) => {
    try {
        const { lat, lng } = req.query;
        const apiKey = process.env.GEOCODING_API_KEY;

        const url = `https://us1.locationiq.com/v1/reverse.php?key=${apiKey}&lat=${lat}&lon=${lng}&format=json`;

        const response = await axios.get(url, { headers: { 'User-Agent': 'MappBackendNodeJS/1.0' } });
        const result = response.data;

        if (result.error) {
            return res.status(400).json({ success: false, message: result.error });
        }

        res.json({
            success: true,
            result: {
                addressLine: result.display_name,
                city: result.address?.city || result.address?.town || result.address?.county,
                state: result.address?.state,
                pincode: result.address?.postcode,
                latitude: parseFloat(lat),
                longitude: parseFloat(lng)
            }
        });
    } catch (error) {
        console.error("Reverse Geocode Error", error);
        res.status(500).json({ success: false, message: "Reverse geocode failed" });
    }
};


/* ================= CREATE ADDRESS ================= */

export const createAddress = async (req, res) => {
    try {
        ensureCustomer(req);
        const customerId = req.user.userId;

        const {
            label,
            name,
            phone,
            addressLine,
            city,
            state,
            pincode,
            latitude,
            longitude,
            isDefault,
        } = req.body;

        console.log(req.body);

        // Clean inputs
        const cleanAddressLine = typeof addressLine === 'string' ? addressLine.trim() : "";

        // Convert latitude and longitude from string to number
        let cleanLat = undefined;
        let cleanLng = undefined;

        if (latitude !== undefined && latitude !== null && latitude !== '') {
            const latNum = Number(latitude);
            cleanLat = Number.isFinite(latNum) ? latNum : undefined;
        }

        if (longitude !== undefined && longitude !== null && longitude !== '') {
            const lngNum = Number(longitude);
            cleanLng = Number.isFinite(lngNum) ? lngNum : undefined;
        }

        if (!cleanAddressLine && (cleanLat === undefined || cleanLng === undefined)) {
            return res.status(400).json({
                success: false,
                message: "Address line OR location coordinates are required",
                result: {},
            });
        }

        const finalAddressLine = cleanAddressLine || "Pinned Location";

        // 🔒 FIFO Address Limit (Max 3)
        const existingAddresses = await Address.find({ customerId }).sort({ createdAt: 1 });
        if (existingAddresses.length >= 3) {
            // If we have 3 or more, delete the oldest ones so only 2 remain
            const toDeleteCount = (existingAddresses.length - 3) + 1;
            const idsToDelete = existingAddresses.slice(0, toDeleteCount).map(a => a._id);
            await Address.deleteMany({ _id: { $in: idsToDelete } });
            console.log(`🧹 FIFO: Deleted ${toDeleteCount} old address(es) for user ${customerId} to maintain limit of 3.`);
        }

        // 🔒 Ensure single default address
        if (isDefault) {
            await Address.updateMany(
                { customerId },
                { isDefault: false }
            );
        }

        // ✅ Get user profile for fallback name and phone
        const customer = await User.findById(customerId).select(
            "fname lname mobileNumber email"
        );

        if (!customer) {
            return res.status(404).json({
                success: false,
                message: "Customer profile not found",
                result: {},
            });
        }

        // Derive name and phone from user profile if not complete
        const profileName = [customer.fname, customer.lname]
            .filter(Boolean)
            .join(" ")
            .trim();

        const profilePhone = customer.mobileNumber;

        // Check if profile is complete
        if (!profileName || !profilePhone) {
            return res.status(400).json({
                success: false,
                message: "Please complete your profile (fname, mobileNumber) before adding an address",
                result: {},
            });
        }

        // Use provided name/phone or fallback to profile data
        let finalName = (name && name.trim()) || profileName;
        let finalPhone = (phone && phone.trim()) || profilePhone;

        // Validate phone format if provided (+91 prefix optional)
        if (finalPhone) {
            const normalizedPhone = normalizeIndianMobile(finalPhone);
            if (!normalizedPhone) {
                return res.status(400).json({
                    success: false,
                    message: "Phone must be 10 digits (optional +91 prefix)",
                    result: {},
                });
            }
            finalPhone = normalizedPhone;
        }

        // Validate coordinates if provided
        if ((cleanLat !== undefined || cleanLng !== undefined) && (cleanLat === undefined || cleanLng === undefined)) {
            return res.status(400).json({
                success: false,
                message: "Both latitude and longitude must be provided together",
                result: {},
            });
        }

        const address = await Address.create({
            customerId,
            label: label || "home",
            name: finalName,
            phone: finalPhone,
            addressLine: finalAddressLine,
            city,
            state,
            pincode,
            latitude: cleanLat,
            longitude: cleanLng,
            isDefault: Boolean(isDefault),
        });

        return res.status(201).json({
            success: true,
            message: "Address created successfully",
            result: address,
        });
    } catch (error) {
        console.error("Create address error:", error);
        return res.status(error?.statusCode || 500).json({
            success: false,
            message: error.message || "Failed to create address",
            result: {},
        });
    }
};


/* ================= GET ALL ADDRESSES ================= */
export const getMyAddresses = async (req, res) => {
    try {
        ensureCustomer(req);

        const addresses = await Address.find({
            customerId: req.user.userId,
        })
            .populate("customerId", "fname lname mobileNumber email")
            .sort({ isDefault: -1, createdAt: -1 });

        res.json({
            success: true,
            result: addresses,
        });
    } catch (err) {
        res.status(err?.statusCode || 500).json({
            success: false,
            message: err.message,
            result: {},
        });
    }
};


/* ================= GET SINGLE ADDRESS ================= */
export const getAddressById = async (req, res) => {
    try {
        ensureCustomer(req);

        const addressId = getAddressIdFromReq(req);
        if (!addressId) {
            return res.status(400).json({
                success: false,
                message: "addressId is required",
                result: {},
            });
        }

        if (!mongoose.Types.ObjectId.isValid(addressId)) {
            return res.status(400).json({
                success: false,
                message: "Invalid address id",
                result: {},
            });
        }

        const address = await Address.findOne({
            _id: addressId,
            customerId: req.user.userId,
        }).populate("customerId", "fname lname mobileNumber email");

        if (!address) {
            return res.status(404).json({
                success: false,
                message: "Address not found",
                result: {},
            });
        }

        res.json({ success: true, result: address });
    } catch (err) {
        res.status(err?.statusCode || 500).json({
            success: false,
            message: err.message,
            result: {},
        });
    }
};

/* ================= UPDATE ADDRESS ================= */
export const updateAddress = async (req, res) => {
    try {
        ensureCustomer(req);

        const id = getAddressIdFromReq(req);
        if (!id) {
            return res.status(400).json({
                success: false,
                message: "addressId is required",
                result: {},
            });
        }

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({
                success: false,
                message: "Invalid address id",
                result: {},
            });
        }

        const address = await Address.findOne({
            _id: id,
            customerId: req.user.userId,
        });

        if (!address) {
            return res.status(404).json({
                success: false,
                message: "Address not found",
                result: {},
            });
        }

        if (req.body.isDefault) {
            await Address.updateMany(
                { customerId: req.user.userId, _id: { $ne: id } },
                { isDefault: false }
            );
        }

        // Only allow safe updates
        const allowed = [
            "label",
            "name",
            "phone",
            "addressLine",
            "city",
            "state",
            "pincode",
            "latitude",
            "longitude",
            "isDefault",
        ];

        for (const key of allowed) {
            if (req.body[key] !== undefined) {
                // Validate phone format if being updated (+91 prefix optional)
                if (key === "phone" && req.body[key]) {
                    const normalizedPhone = normalizeIndianMobile(req.body[key]);
                    if (!normalizedPhone) {
                        return res.status(400).json({
                            success: false,
                            message: "Phone must be 10 digits (optional +91 prefix)",
                            result: {},
                        });
                    }
                    address[key] = normalizedPhone;
                } else if (key === "latitude" || key === "longitude") {
                    // Convert latitude/longitude to number if provided as string
                    if (req.body[key] !== null && req.body[key] !== '') {
                        const coordNum = Number(req.body[key]);
                        address[key] = Number.isFinite(coordNum) ? coordNum : undefined;
                    } else {
                        address[key] = req.body[key];
                    }
                } else {
                    address[key] = req.body[key];
                }
            }
        }

        await address.save();

        res.json({ success: true, result: address });
    } catch (err) {
        res.status(err?.statusCode || 500).json({
            success: false,
            message: err.message,
            result: {},
        });
    }
};


/* ================= DELETE ADDRESS ================= */
export const deleteAddress = async (req, res) => {
    try {
        ensureCustomer(req);

        const id = getAddressIdFromReq(req);
        if (!id) {
            return res.status(400).json({
                success: false,
                message: "addressId is required",
                result: {},
            });
        }

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({
                success: false,
                message: "Invalid address id",
                result: {},
            });
        }

        const address = await Address.findOneAndDelete({
            _id: id,
            customerId: req.user.userId,
        });

        if (!address) {
            return res.status(404).json({
                success: false,
                message: "Address not found",
                result: {},
            });
        }

        res.status(200).json({
            success: true,
            message: "Address deleted successfully",
            result: {},
        });
    } catch (error) {
        console.error("Delete address error:", error);
        res.status(500).json({
            success: false,
            message: "Failed to delete address",
            result: { reason: error.message || "An error occurred" },
        });
    }
};

/* ================= SET DEFAULT ADDRESS ================= */
export const setDefaultAddress = async (req, res) => {
    try {
        ensureCustomer(req);

        const id = getAddressIdFromReq(req);
        if (!id) {
            return res.status(400).json({
                success: false,
                message: "addressId is required",
                result: {},
            });
        }

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({
                success: false,
                message: "Invalid address id",
                result: {},
            });
        }

        // Check if address exists and belongs to customer
        const address = await Address.findOne({
            _id: id,
            customerId: req.user.userId,
        });

        if (!address) {
            return res.status(404).json({
                success: false,
                message: "Address not found",
                result: {},
            });
        }

        // Unset all other defaults
        await Address.updateMany(
            { customerId: req.user.userId, _id: { $ne: id } },
            { isDefault: false }
        );

        // Set this as default
        const updatedAddress = await Address.findByIdAndUpdate(
            id,
            { isDefault: true },
            { new: true }
        );

        res.status(200).json({
            success: true,
            message: "Default address updated",
            result: updatedAddress,
        });
    } catch (error) {
        console.error("Set default address error:", error);
        res.status(error?.statusCode || 500).json({
            success: false,
            message: error.message || "Failed to set default address",
            result: { reason: error.message || "An error occurred" },
        });
    }
};

/* ================= GET DEFAULT ADDRESS ================= */
export const getDefaultAddress = async (req, res) => {
    try {
        ensureCustomer(req);

        const address = await Address.findOne({
            customerId: req.user.userId,
            isDefault: true,
        }).populate("customerId", "fname lname mobileNumber email");

        if (!address) {
            //sk
            return res.status(200).json({
                success: true,
                message: "No default address set",
                result: null,
            });
        }

        res.status(200).json({
            success: true,
            message: "Default address fetched successfully",
            result: address,
        });
    } catch (error) {
        console.error("Get default address error:", error);
        res.status(error?.statusCode || 500).json({
            success: false,
            message: error.message || "Failed to fetch default address",
            result: { reason: error.message || "An error occurred" },
        });
    }
};

/* ================= ADMIN: GET ALL ADDRESSES ================= */
export const adminGetAllAddresses = async (req, res) => {
    try {
        const addresses = await Address.find()
            .populate("customerId", "fname lname mobileNumber email")
            .sort({ createdAt: -1 });
        res.json({ success: true, result: addresses });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message, result: {} });
    }
};

/* ================= ADMIN: GET ADDRESS BY ID ================= */
export const adminGetAddressById = async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ success: false, message: "Invalid address id", result: {} });
        }

        const address = await Address.findById(id).populate(
            "customerId",
            "fname lname mobileNumber email"
        );
        if (!address) {
            return res.status(404).json({ success: false, message: "Address not found", result: {} });
        }

        res.json({ success: true, result: address });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message, result: {} });
    }
};
