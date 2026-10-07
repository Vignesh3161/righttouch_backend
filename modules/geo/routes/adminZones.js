import express from "express";
import { Auth, authorizeRoles } from "../../../shared/middleware/Auth.js";
import {
  listCityZones,
  getCityZone,
  createCityZone,
  updateCityZone,
  deleteCityZone,
  listZoneServiceMappings,
  createZoneServiceMappings,
  deleteZoneServiceMapping,
  toggleZoneServices,
  listZoneTechnicianCandidates,
} from "../controllers/cityZoneController.js";

const router = express.Router();

/* ================= CITY ZONES (Admin/Owner) ================= */

// List all zones (?operationalCityId=...&active=true|false)
router.get("/zones", Auth, authorizeRoles("Admin", "Owner"), listCityZones);

// Get single zone
router.get("/zones/:id", Auth, authorizeRoles("Admin", "Owner"), getCityZone);

// Create zone
router.post("/zones", Auth, authorizeRoles("Admin", "Owner"), createCityZone);

// Update zone
router.put("/zones/:id", Auth, authorizeRoles("Admin", "Owner"), updateCityZone);

// Delete zone
router.delete("/zones/:id", Auth, authorizeRoles("Admin", "Owner"), deleteCityZone);

/* ================= ZONE-SERVICE MAPPINGS (Admin/Owner) ================= */

// List mappings (?zoneId=...&serviceId=...)
router.get("/zone-mappings", Auth, authorizeRoles("Admin", "Owner"), listZoneServiceMappings);

// Create/upsert mappings (bulk)
router.post("/zone-mappings", Auth, authorizeRoles("Admin", "Owner"), createZoneServiceMappings);

// Delete a single mapping
router.delete("/zone-mappings/:zoneId/:serviceId", Auth, authorizeRoles("Admin", "Owner"), deleteZoneServiceMapping);

// Bulk toggle all services in a zone
router.put("/zones/:zoneId/services/toggle", Auth, authorizeRoles("Admin", "Owner"), toggleZoneServices);

// Technician candidates inside zone polygon but not yet approved (registration ≠ approval)
router.get("/zones/:zoneId/technician-candidates", Auth, authorizeRoles("Admin", "Owner"), listZoneTechnicianCandidates);

export default router;
