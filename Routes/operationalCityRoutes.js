import express from "express";
import { Auth } from "../Middleware/Auth.js";
import {
  listOperationalCities,
  getActiveOperationalCity,
  getActivePolygons,
  createOperationalCity,
  updateOperationalCity,
  activateOperationalCity,
  deleteOperationalCity,
} from "../Controllers/operationalCityController.js";

const router = express.Router();

/* ================= OPERATIONAL CITY / SERVICE POLYGON (Admin/Owner) ================= */

// List all operational cities (?active=true|false)
router.get("/operational-cities", Auth, listOperationalCities);

// The single active operational city (with polygon)
router.get("/operational-cities/active", Auth, getActiveOperationalCity);

// All active polygons (public-for-tech-app shape; Auth for safety)
router.get("/operational-cities/polygons", Auth, getActivePolygons);

// Create city + polygon
router.post("/operational-cities", Auth, createOperationalCity);

// Update city / polygon
router.put("/operational-cities/:id", Auth, updateOperationalCity);

// Set this city as THE active one (deactivates others)
router.post("/operational-cities/:id/activate", Auth, activateOperationalCity);

// Delete
router.delete("/operational-cities/:id", Auth, deleteOperationalCity);

export default router;