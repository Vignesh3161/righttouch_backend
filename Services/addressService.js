import mongoose from "mongoose";
import axios from "axios";
import Address from "../Schemas/Address.js";
import User from "../Schemas/User.js";
import { normalizeIndianMobile } from "../Utils/phoneValidation.js";

/**
 * Internal Address Service
 * Manages customer addresses with strict cap enforcement (max 3 addresses per customer),
 * single default address guarantees, and LocationIQ geocoding integration.
 */

const ADDRESS_CAP = 3;

const AddressCounter =
  mongoose.models.AddressCounter ||
  mongoose.model(
    "AddressCounter",
    new mongoose.Schema(
      {
        customerId: { type: mongoose.Schema.Types.ObjectId, required: true, unique: true },
        seq: { type: Number, default: 0 },
      },
      { versionKey: false }
    )
  );

/**
 * Searches address using LocationIQ text search.
 */
export const searchAddressInternal = async (queryText) => {
  const apiKey = process.env.GEOCODING_API_KEY;
  const url = `https://us1.locationiq.com/v1/search.php?key=${apiKey}&q=${encodeURIComponent(queryText)}&format=json&addressdetails=1&limit=1`;
  const response = await axios.get(url, { headers: { "User-Agent": "MappBackendNodeJS/1.0" } });

  if (!response.data || response.data.length === 0) {
    const err = new Error("Address fetch failed, no results");
    err.statusCode = 404;
    throw err;
  }

  const result = response.data[0];
  return {
    addressLine: result.display_name,
    city: result.address?.city || result.address?.town || result.address?.county,
    state: result.address?.state,
    pincode: result.address?.postcode,
    latitude: parseFloat(result.lat),
    longitude: parseFloat(result.lon),
  };
};

/**
 * Reverse geocodes latitude/longitude using LocationIQ.
 */
export const reverseAddressInternal = async (lat, lng) => {
  const apiKey = process.env.GEOCODING_API_KEY;
  const url = `https://us1.locationiq.com/v1/reverse.php?key=${apiKey}&lat=${lat}&lon=${lng}&format=json`;
  const response = await axios.get(url, { headers: { "User-Agent": "MappBackendNodeJS/1.0" } });
  const result = response.data;

  if (result.error) {
    const err = new Error(result.error);
    err.statusCode = 400;
    throw err;
  }

  return {
    addressLine: result.display_name,
    city: result.address?.city || result.address?.town || result.address?.county,
    state: result.address?.state,
    pincode: result.address?.postcode,
    latitude: parseFloat(lat),
    longitude: parseFloat(lng),
  };
};

/**
 * Creates a new address for a customer with atomic 3-address cap enforcement.
 */
export const createAddressInternal = async ({ customerId, label, name, phone, addressLine, city, state, pincode, latitude, longitude, isDefault }) => {
  const cleanAddressLine = typeof addressLine === "string" ? addressLine.trim() : "";

  let cleanLat = undefined;
  let cleanLng = undefined;
  if (latitude !== undefined && latitude !== null && latitude !== "") {
    const latNum = Number(latitude);
    cleanLat = Number.isFinite(latNum) ? latNum : undefined;
  }
  if (longitude !== undefined && longitude !== null && longitude !== "") {
    const lngNum = Number(longitude);
    cleanLng = Number.isFinite(lngNum) ? lngNum : undefined;
  }

  if (!cleanAddressLine && (cleanLat === undefined || cleanLng === undefined)) {
    const err = new Error("Address line OR location coordinates are required");
    err.statusCode = 400;
    throw err;
  }

  const finalAddressLine = cleanAddressLine || "Pinned Location";

  // Atomic reservation of address slot
  const slot = await AddressCounter.findOneAndUpdate(
    { customerId, seq: { $lt: ADDRESS_CAP } },
    { $inc: { seq: 1 } },
    { upsert: true, new: true }
  );

  if (!slot) {
    const err = new Error(`You can save at most ${ADDRESS_CAP} addresses. Delete an existing address to add a new one.`);
    err.statusCode = 409;
    throw err;
  }

  if (isDefault) {
    await Address.updateMany({ customerId }, { isDefault: false });
  }

  const customer = await User.findById(customerId).select("fname lname mobileNumber email");
  if (!customer) {
    await AddressCounter.updateOne({ customerId }, { $inc: { seq: -1 } }).catch(() => {});
    const err = new Error("Customer profile not found");
    err.statusCode = 404;
    throw err;
  }

  const profileName = [customer.fname, customer.lname].filter(Boolean).join(" ").trim();
  const profilePhone = customer.mobileNumber;

  if (!profileName || !profilePhone) {
    await AddressCounter.updateOne({ customerId }, { $inc: { seq: -1 } }).catch(() => {});
    const err = new Error("Please complete your profile (fname, mobileNumber) before adding an address");
    err.statusCode = 400;
    throw err;
  }

  let finalName = (name && name.trim()) || profileName;
  let finalPhone = (phone && phone.trim()) || profilePhone;

  if (finalPhone) {
    const normalizedPhone = normalizeIndianMobile(finalPhone);
    if (!normalizedPhone) {
      await AddressCounter.updateOne({ customerId }, { $inc: { seq: -1 } }).catch(() => {});
      const err = new Error("Phone must be 10 digits (optional +91 prefix)");
      err.statusCode = 400;
      throw err;
    }
    finalPhone = normalizedPhone;
  }

  if ((cleanLat !== undefined || cleanLng !== undefined) && (cleanLat === undefined || cleanLng === undefined)) {
    await AddressCounter.updateOne({ customerId }, { $inc: { seq: -1 } }).catch(() => {});
    const err = new Error("Both latitude and longitude must be provided together");
    err.statusCode = 400;
    throw err;
  }

  try {
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
    return address;
  } catch (createErr) {
    await AddressCounter.updateOne({ customerId }, { $inc: { seq: -1 } }).catch(() => {});
    throw createErr;
  }
};

/**
 * Gets all addresses for customer.
 */
export const getMyAddressesInternal = async (customerId) => {
  return Address.find({ customerId })
    .populate("customerId", "fname lname mobileNumber email")
    .sort({ isDefault: -1, createdAt: -1 });
};

/**
 * Gets single address by ID with ownership verification.
 */
export const getAddressByIdInternal = async (customerId, addressId) => {
  if (!addressId || !mongoose.Types.ObjectId.isValid(addressId)) {
    const err = new Error("Invalid address id");
    err.statusCode = 400;
    throw err;
  }

  const address = await Address.findOne({ _id: addressId, customerId }).populate(
    "customerId",
    "fname lname mobileNumber email"
  );
  if (!address) {
    const err = new Error("Address not found");
    err.statusCode = 404;
    throw err;
  }

  return address;
};

/**
 * Updates address with ownership verification and single default guarantee.
 */
export const updateAddressInternal = async ({ customerId, addressId, body }) => {
  if (!addressId || !mongoose.Types.ObjectId.isValid(addressId)) {
    const err = new Error("Invalid address id");
    err.statusCode = 400;
    throw err;
  }

  const address = await Address.findOne({ _id: addressId, customerId });
  if (!address) {
    const err = new Error("Address not found");
    err.statusCode = 404;
    throw err;
  }

  if (body.isDefault) {
    await Address.updateMany({ customerId, _id: { $ne: addressId } }, { isDefault: false });
  }

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
    if (body[key] !== undefined) {
      if (key === "phone" && body[key]) {
        const normalizedPhone = normalizeIndianMobile(body[key]);
        if (!normalizedPhone) {
          const err = new Error("Phone must be 10 digits (optional +91 prefix)");
          err.statusCode = 400;
          throw err;
        }
        address[key] = normalizedPhone;
      } else if (key === "latitude" || key === "longitude") {
        if (body[key] !== null && body[key] !== "") {
          const coordNum = Number(body[key]);
          address[key] = Number.isFinite(coordNum) ? coordNum : undefined;
        } else {
          address[key] = body[key];
        }
      } else {
        address[key] = body[key];
      }
    }
  }

  await address.save();
  return address;
};

/**
 * Deletes address with ownership verification and counter slot release.
 */
export const deleteAddressInternal = async ({ customerId, addressId }) => {
  if (!addressId || !mongoose.Types.ObjectId.isValid(addressId)) {
    const err = new Error("Invalid address id");
    err.statusCode = 400;
    throw err;
  }

  const address = await Address.findOneAndDelete({ _id: addressId, customerId });
  if (!address) {
    const err = new Error("Address not found");
    err.statusCode = 404;
    throw err;
  }

  await AddressCounter.updateOne(
    { customerId, seq: { $gt: 0 } },
    { $inc: { seq: -1 } }
  ).catch(() => {});

  return true;
};

/**
 * Sets address as default.
 */
export const setDefaultAddressInternal = async ({ customerId, addressId }) => {
  if (!addressId || !mongoose.Types.ObjectId.isValid(addressId)) {
    const err = new Error("Invalid address id");
    err.statusCode = 400;
    throw err;
  }

  const address = await Address.findOne({ _id: addressId, customerId });
  if (!address) {
    const err = new Error("Address not found");
    err.statusCode = 404;
    throw err;
  }

  await Address.updateMany({ customerId, _id: { $ne: addressId } }, { isDefault: false });
  const updatedAddress = await Address.findByIdAndUpdate(addressId, { isDefault: true }, { new: true });
  return updatedAddress;
};

/**
 * Gets default address for customer.
 */
export const getDefaultAddressInternal = async (customerId) => {
  const address = await Address.findOne({ customerId, isDefault: true }).populate(
    "customerId",
    "fname lname mobileNumber email"
  );
  return address;
};

/**
 * Admin get all addresses.
 */
export const adminGetAllAddressesInternal = async () => {
  return Address.find()
    .populate("customerId", "fname lname mobileNumber email")
    .sort({ createdAt: -1 });
};

/**
 * Admin get address by ID.
 */
export const adminGetAddressByIdInternal = async (id) => {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    const err = new Error("Invalid address id");
    err.statusCode = 400;
    throw err;
  }

  const address = await Address.findById(id).populate("customerId", "fname lname mobileNumber email");
  if (!address) {
    const err = new Error("Address not found");
    err.statusCode = 404;
    throw err;
  }
  return address;
};
