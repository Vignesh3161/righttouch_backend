import express from "express";
import { Auth, authorizeRoles } from "../../../shared/middleware/Auth.js";
import {
  createAddress,
  getMyAddresses,
  updateAddress,
  deleteAddress,
  setDefaultAddress,
  getDefaultAddress,
  adminGetAllAddresses,
  adminGetAddressById,
  searchAddress,
  reverseAddress,
} from "../controllers/addressController.js";

const router = express.Router();

/* ================= ADMIN ONLY ================= */
router.get("/admin/all", Auth, authorizeRoles("Admin", "Owner"), adminGetAllAddresses);
router.get("/admin/:id", Auth, authorizeRoles("Admin", "Owner"), adminGetAddressById);

// Search address (LocationIQ)
router.get("/search", Auth, searchAddress);

// Reverse geocode (LocationIQ)
router.get("/reverse", Auth, reverseAddress);

// Create address
router.post("/", Auth, createAddress);

// Get all addresses for user
router.get("/", Auth, getMyAddresses);

// Get default address
router.get("/default", Auth, getDefaultAddress);

// Update address (customer) - pass addressId in body
router.put("/", Auth, updateAddress);

// Set as default address (customer) - pass addressId in body
router.put("/default", Auth, setDefaultAddress);

// Delete address (customer) - pass addressId in body
router.delete("/", Auth, deleteAddress);

export default router;
