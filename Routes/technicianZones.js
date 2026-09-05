import express from "express";
import { Auth } from "../Middleware/Auth.js";
import isTechnician from "../Middleware/isTechnician.js";
import {
  getMyZone,
  getServicesInMyZone,
} from "../Controllers/zoneAvailabilityController.js";

const router = express.Router();

/* ================= TECHNICIAN ZONE ENDPOINTS ================= */

// Get my zone info (which zone I'm registered in, mismatch status)
router.get("/zone/me", Auth, isTechnician, getMyZone);

// Get services available in my zone
router.get("/zone/services", Auth, isTechnician, getServicesInMyZone);

export default router;
