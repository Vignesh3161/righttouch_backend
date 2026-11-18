import Address from "../Schemas/Address.js";
import User from "../Schemas/User.js";
import mongoose from "mongoose";

/**
 * Resolve user location from either:
 * 1. Saved Address (addressId) - Preferred
 * 2. GPS coordinates (latitude, longitude)
 *
 * locationType "saved" requires a valid, owned addressId. Whenever an
 * addressId is supplied it is authoritative and never silently falls back to
 * GPS. Empty coordinate strings are treated as missing, never as 0.
 */
const validationError = (message, code) => {
  const error = new Error(message);
  error.statusCode = 400;
  error.code = code;
  return error;
};

const hasValue = (value) =>
  value !== null && value !== undefined && String(value).trim() !== "";

const normalizeCoordinate = (value) => {
  if (!hasValue(value)) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const isSavedLocation = (locationType) =>
  typeof locationType === "string" && locationType.trim().toLowerCase() === "saved";

export const resolveUserLocation = async ({
  locationType = "ADDRESS",
  addressId = null,
  latitude = null,
  longitude = null,
  userId = null,
} = {}) => {
  try {
    if (hasValue(addressId)) {
      const rawAddressId = String(addressId).trim();
      if (!mongoose.Types.ObjectId.isValid(rawAddressId)) {
        throw validationError("Invalid addressId", "INVALID_ADDRESS");
      }

      const address = await Address.findOne({
        _id: rawAddressId,
        customerId: userId,
      });
      if (!address) {
        throw validationError(
          "Selected address was not found for this customer",
          "ADDRESS_NOT_FOUND"
        );
      }

      const addressLat = normalizeCoordinate(address.latitude);
      const addressLng = normalizeCoordinate(address.longitude);
      if (addressLat === null || addressLng === null) {
        throw validationError(
          "Selected address is missing latitude/longitude coordinates",
          "ADDRESS_LOCATION_REQUIRED"
        );
      }

      return {
        success: true,
        locationType: "saved",
        addressId: address._id.toString(),
        latitude: addressLat,
        longitude: addressLng,
        addressSnapshot: {
          label: address.label || "address",
          name: address.name || "",
          phone: address.phone || "",
          addressLine: address.addressLine || "",
          city: address.city || "",
          state: address.state || "",
          pincode: address.pincode || "",
          latitude: addressLat,
          longitude: addressLng,
          isDefault: address.isDefault || false,
        },
      };
    }

    if (isSavedLocation(locationType)) {
      throw validationError(
        "addressId is required when locationType is saved",
        "ADDRESS_REQUIRED"
      );
    }

    const hasLat = hasValue(latitude);
    const hasLng = hasValue(longitude);
    const lat = normalizeCoordinate(latitude);
    const lng = normalizeCoordinate(longitude);

    if (hasLat !== hasLng || (hasLat && (lat === null || lng === null))) {
      throw validationError(
        "Both valid latitude and longitude are required",
        "INVALID_COORDINATES"
      );
    }

    if (lat !== null && lng !== null) {
      if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
        throw validationError(
          "Latitude or longitude is out of range",
          "INVALID_COORDINATES"
        );
      }

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

    throw validationError(
      "No valid address or GPS coordinates provided",
      "LOCATION_REQUIRED"
    );
  } catch (error) {
    if (!error.statusCode || error.statusCode >= 500) {
      console.error("resolveUserLocation Error:", error);
    }
    if (error.statusCode) {
      throw error;
    }
    const err = new Error(error.message || "Location resolution failed");
    err.statusCode = 500;
    throw err;
  }
};
