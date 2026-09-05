import express from "express";
import { Auth } from "../Middleware/Auth.js";
import {
  resolveCustomerZone,
  checkServiceAvailability,
} from "../Controllers/zoneAvailabilityController.js";

const router = express.Router();

/* ================= CUSTOMER ZONE ENDPOINTS ================= */

// Resolve zone from customer location + get available services
router.post("/zones/resolve", Auth, resolveCustomerZone);

// Check if a specific service is available at a location
router.post("/zones/check-service", Auth, checkServiceAvailability);

export default router;
