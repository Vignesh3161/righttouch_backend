import express from "express";
import { Auth } from "../Middleware/Auth.js";
import {
  listOperationalCities,
  getOperationalCityById,
  getActiveOperationalCity,
  getActivePolygons,
  createOperationalCity,
  updateOperationalCity,
  updateDistrictStatus,
  updateDistrictRegistration,
  updateDistrictJobs,
  getDistrictTechnicians,
  activateOperationalCity,
  deleteOperationalCity,
} from "../Controllers/operationalCityController.js";

const router = express.Router();

/* ================= OPERATIONAL CITY / DISTRICT MASTER ROUTES (Admin/Owner) ================= */

// List all operational cities / districts (?active=true|false)
router.get("/districts", Auth, listOperationalCities);
router.get("/operational-cities", Auth, listOperationalCities);
router.get("/admin/districts", Auth, listOperationalCities);

// The single active operational city (with polygon)
router.get("/operational-cities/active", Auth, getActiveOperationalCity);

// All active polygons (public-for-tech-app shape; Auth for safety)
router.get("/operational-cities/polygons", Auth, getActivePolygons);

// Get single district by ID
router.get("/districts/:id", Auth, getOperationalCityById);
router.get("/operational-cities/:id", Auth, getOperationalCityById);
router.get("/admin/districts/:id", Auth, getOperationalCityById);

// Create city / district + polygon
router.post("/districts", Auth, createOperationalCity);
router.post("/operational-cities", Auth, createOperationalCity);
router.post("/admin/districts", Auth, createOperationalCity);

// Update city / district / polygon
router.put("/districts/:id", Auth, updateOperationalCity);
router.put("/operational-cities/:id", Auth, updateOperationalCity);
router.put("/admin/districts/:id", Auth, updateOperationalCity);

// District status / registration / jobs toggles
router.patch("/districts/:id/status", Auth, updateDistrictStatus);
router.patch("/districts/:id/registration", Auth, updateDistrictRegistration);
router.patch("/districts/:id/jobs", Auth, updateDistrictJobs);
router.get("/districts/:id/technicians", Auth, getDistrictTechnicians);
router.patch("/admin/districts/:id/status", Auth, updateDistrictStatus);
router.patch("/admin/districts/:id/registration", Auth, updateDistrictRegistration);
router.patch("/admin/districts/:id/jobs", Auth, updateDistrictJobs);
router.get("/admin/districts/:id/technicians", Auth, getDistrictTechnicians);

// Set this city as active (deactivates others if single-city mode)
router.post("/operational-cities/:id/activate", Auth, activateOperationalCity);

// Delete
router.delete("/districts/:id", Auth, deleteOperationalCity);
router.delete("/operational-cities/:id", Auth, deleteOperationalCity);
router.delete("/admin/districts/:id", Auth, deleteOperationalCity);

export default router;