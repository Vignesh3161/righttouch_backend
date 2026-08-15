import express from "express";
import { Auth } from "../Middleware/Auth.js";
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
} from "../Controllers/cityZoneController.js";

const router = express.Router();

/* ================= CITY ZONES (Admin/Owner) ================= */

// List all zones (?operationalCityId=...&active=true|false)
router.get("/zones", Auth, listCityZones);

// Get single zone
router.get("/zones/:id", Auth, getCityZone);

// Create zone
router.post("/zones", Auth, createCityZone);

// Update zone
router.put("/zones/:id", Auth, updateCityZone);

// Delete zone
router.delete("/zones/:id", Auth, deleteCityZone);

/* ================= ZONE-SERVICE MAPPINGS (Admin/Owner) ================= */

// List mappings (?zoneId=...&serviceId=...)
router.get("/zone-mappings", Auth, listZoneServiceMappings);

// Create/upsert mappings (bulk)
router.post("/zone-mappings", Auth, createZoneServiceMappings);

// Delete a single mapping
router.delete("/zone-mappings/:zoneId/:serviceId", Auth, deleteZoneServiceMapping);

// Bulk toggle all services in a zone
router.put("/zones/:zoneId/services/toggle", Auth, toggleZoneServices);

export default router;
