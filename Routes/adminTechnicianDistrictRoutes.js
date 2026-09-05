import express from "express";
import { Auth } from "../Middleware/Auth.js";
import {
  getTechnicianDistricts,
  addTechnicianDistrictPermission,
  toggleTechnicianDistrictPermission,
  removeTechnicianDistrictPermission,
} from "../Controllers/adminTechnicianDistrictController.js";
import {
  getTechnicianZonePermissions,
  enableTechnicianZonePermission,
  disableTechnicianZonePermission,
} from "../Controllers/adminTechnicianZoneController.js";

const router = express.Router();

/* ================= ADMIN TECHNICIAN DISTRICT PERMISSIONS ================= */

// View technician primary + additional district permissions
router.get("/technicians/:technicianId/districts", Auth, getTechnicianDistricts);

// Add an additional district permission
router.post("/technicians/:technicianId/districts", Auth, addTechnicianDistrictPermission);

// Enable or disable an additional district permission
router.patch("/technicians/:technicianId/districts/:districtId", Auth, toggleTechnicianDistrictPermission);

// Remove an additional district permission
router.delete("/technicians/:technicianId/districts/:districtId", Auth, removeTechnicianDistrictPermission);

/* ================= ADMIN TECHNICIAN CITY ZONE PERMISSIONS ================= */

// View technician city zone permissions
router.get("/technicians/:technicianId/city-zones", Auth, getTechnicianZonePermissions);
router.get("/technicians/:technicianId/zones", Auth, getTechnicianZonePermissions);

// Enable a city zone permission for technician
router.post("/technicians/:technicianId/city-zones", Auth, enableTechnicianZonePermission);
router.post("/technicians/:technicianId/zones/:zoneId/enable", Auth, enableTechnicianZonePermission);

// Revoke a city zone permission for technician
router.delete("/technicians/:technicianId/city-zones/:zoneId", Auth, disableTechnicianZonePermission);
router.post("/technicians/:technicianId/zones/:zoneId/disable", Auth, disableTechnicianZonePermission);

export default router;
