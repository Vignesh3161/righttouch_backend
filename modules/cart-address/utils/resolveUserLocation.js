import Address from "../models/Address.js";
import User from "../../identity/models/User.js";
import mongoose from "mongoose";

/**
 * Resolve user location from either:
 * 1. Saved Address (addressId) - Preferred
 * 2. GPS coordinates (latitude, longitude)
 * 3. Address line + City/State/Pincode - Fallback
 */
export const resolveUserLocation = async ({
  locationType = "ADDRESS", // ADDRESS or GPS
  addressId = null,
  latitude = null,
  longitude = null,
  userId = null,
} = {}) => {
  try {
    // Priority 1: Use saved address if addressId provided
    if (addressId && mongoose.Types.ObjectId.isValid(addressId)) {
      const address = await Address.findOne({
        _id: addressId,
        customerId: userId, // 🔒 SECURITY: Verify ownership
      });
      if (address) {
        return {
          success: true,
          locationType: "saved",
          addressId: address._id.toString(),
          latitude: address.latitude || null,
          longitude: address.longitude || null,
          addressSnapshot: {
            label: address.label || "address",
            name: address.name || "",
            phone: address.phone || "",
            addressLine: address.addressLine || "",
            city: address.city || "",
            state: address.state || "",
            pincode: address.pincode || "",
            latitude: address.latitude || null,
            longitude: address.longitude || null,
            isDefault: address.isDefault || false,
          },
        };
      }
    }

    // Priority 2: Use GPS coordinates if provided
    const lat = latitude !== null && latitude !== undefined ? Number(latitude) : null;
    const lng = longitude !== null && longitude !== undefined ? Number(longitude) : null;

    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      // Fetch user details for name/phone if available
      let userName = "";
      let userPhone = "";

      if (userId && mongoose.Types.ObjectId.isValid(userId)) {
        const user = await User.findById(userId).select("fname lname mobileNumber");
        if (user) {
          userName = [user.fname, user.lname].filter(Boolean).join(" ");
          userPhone = user.mobileNumber || "";
        }
      }

      return {
        success: true,
        locationType: "gps",
        addressId: null,
        latitude: lat,
        longitude: lng,
        addressSnapshot: {
          label: "current_location",
          name: userName,
          phone: userPhone,
          addressLine: "Pinned Location",
          city: "",
          state: "",
          pincode: "",
          latitude: lat,
          longitude: lng,
          isDefault: false,
        },
      };
    }

    // No valid location found - throw error to prevent booking with invalid location
    const error = new Error("No valid address or GPS coordinates provided");
    error.statusCode = 400;
    throw error;
  } catch (error) {
    console.error("resolveUserLocation Error:", error);
    // Rethrow the error so checkout can catch it properly
    if (error.statusCode) {
      throw error;
    }
    const err = new Error(error.message || "Location resolution failed");
    err.statusCode = 500;
    throw err;
  }
};

