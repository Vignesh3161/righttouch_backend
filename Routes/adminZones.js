import express from "express";
import { Auth, authorizeRoles } from "../Middleware/Auth.js";
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
} from "../Controllers/cityZoneController.js";

const router = express.Router();

router.use(Auth, authorizeRoles("Admin", "Owner"));

/* ================= CITY ZONES (Admin/Owner) ================= */

// List all zones (?operationalCityId=...&active=true|false)
router.get("/zones", listCityZones);

// Get single zone
router.get("/zones/:id", getCityZone);

// Create zone
router.post("/zones", createCityZone);

// Update zone
router.put("/zones/:id", updateCityZone);

// Delete zone
router.delete("/zones/:id", deleteCityZone);

/* ================= ZONE-SERVICE MAPPINGS (Admin/Owner) ================= */

// List mappings (?zoneId=...&serviceId=...)
router.get("/zone-mappings", listZoneServiceMappings);

// Create/upsert mappings (bulk)
router.post("/zone-mappings", createZoneServiceMappings);

// Delete a single mapping
router.delete("/zone-mappings/:zoneId/:serviceId", deleteZoneServiceMapping);

// Bulk toggle all services in a zone
router.put("/zones/:zoneId/services/toggle", toggleZoneServices);

// Technician candidates inside zone polygon but not yet approved (registration ≠ approval)
router.get("/zones/:zoneId/technician-candidates", listZoneTechnicianCandidates);

export default router;
