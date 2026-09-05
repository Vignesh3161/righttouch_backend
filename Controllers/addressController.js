import { ensureCustomer } from "../Utils/ensureCustomer.js";
import {
  searchAddressInternal,
  reverseAddressInternal,
  createAddressInternal,
  getMyAddressesInternal,
  getAddressByIdInternal,
  updateAddressInternal,
  deleteAddressInternal,
  setDefaultAddressInternal,
  getDefaultAddressInternal,
  adminGetAllAddressesInternal,
  adminGetAddressByIdInternal,
} from "../Services/addressService.js";

const getAddressIdFromReq = (req) => req.params?.id || req.body?.addressId || req.body?.id;

/* ================= SEARCH ADDRESS DETAILS ================= */
export const searchAddress = async (req, res) => {
  try {
    const { q } = req.query;
    const result = await searchAddressInternal(q);
    res.json({ success: true, result });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, message: error.message || "Address fetch failed" });
  }
};

/* ================= REVERSE GEOCODE (LAT/LNG -> DETAILS) ================= */
export const reverseAddress = async (req, res) => {
  try {
    const { lat, lng } = req.query;
    const result = await reverseAddressInternal(lat, lng);
    res.json({ success: true, result });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, message: error.message || "Reverse geocode failed" });
  }
};

/* ================= CREATE ADDRESS ================= */
export const createAddress = async (req, res) => {
  try {
    ensureCustomer(req);
    const customerId = req.user.userId;

    const address = await createAddressInternal({
      customerId,
      ...req.body,
    });

    return res.status(201).json({
      success: true,
      message: "Address created successfully",
      result: address,
    });
  } catch (error) {
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
    const addresses = await getMyAddressesInternal(req.user.userId);

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

    const address = await getAddressByIdInternal(req.user.userId, addressId);
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

    const address = await updateAddressInternal({
      customerId: req.user.userId,
      addressId: id,
      body: req.body,
    });

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

    await deleteAddressInternal({
      customerId: req.user.userId,
      addressId: id,
    });

    res.status(200).json({
      success: true,
      message: "Address deleted successfully",
      result: {},
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || "Failed to delete address",
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

    const updatedAddress = await setDefaultAddressInternal({
      customerId: req.user.userId,
      addressId: id,
    });

    res.status(200).json({
      success: true,
      message: "Default address updated",
      result: updatedAddress,
    });
  } catch (error) {
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
    const address = await getDefaultAddressInternal(req.user.userId);

    if (!address) {
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
    const addresses = await adminGetAllAddressesInternal();
    res.json({ success: true, result: addresses });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message, result: {} });
  }
};

/* ================= ADMIN: GET ADDRESS BY ID ================= */
export const adminGetAddressById = async (req, res) => {
  try {
    const { id } = req.params;
    const address = await adminGetAddressByIdInternal(id);
    res.json({ success: true, result: address });
  } catch (err) {
    res.status(err.statusCode || 500).json({ success: false, message: err.message, result: {} });
  }
};
