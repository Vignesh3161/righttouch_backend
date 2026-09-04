import express from "express";
import { Auth, authorizeRoles } from "../Middleware/Auth.js";
import {
  createDistrict,
  updateDistrict,
  listDistricts,
  createCityZone,
  listCityZones,
  grantDistrictPermission,
  revokeDistrictPermission,
  getImpactAnalysis,
  getSpatialHierarchy,
  getDistrictDashboardDetails,
  inspectJobLocation,
  rollbackPolygonVersion,
  getZoneHealthDashboard,
  listAdminTechnicians,
  getAdminTechnicianDetails,
  updateTechnicianVerification,
  getJobBroadcastAudit,
} from "../Controllers/adminZoneGeofenceController.js";

const router = express.Router();

// Protect all routes with Auth and Admin/Owner role check
router.use(Auth, authorizeRoles("Admin", "Owner"));

/* ================= DISTRICT ROUTES ================= */
router.post("/districts", createDistrict);
router.put("/districts/:id", updateDistrict);
router.get("/districts", listDistricts);
router.get("/districts/:id/dashboard", getDistrictDashboardDetails);

/* ================= CITY ZONE ROUTES ================= */
router.post("/city-zones", createCityZone);
router.get("/city-zones", listCityZones);

/* ================= TECHNICIAN ZONE/GEOFENCE ROUTES ================= */
router.get("/technicians", listAdminTechnicians);
router.get("/technicians/:id/details", getAdminTechnicianDetails);
router.post("/technicians/:id/verification", updateTechnicianVerification);
router.post("/technicians/grant-district", grantDistrictPermission);
router.post("/technicians/revoke-district", revokeDistrictPermission);

/* ================= HIERARCHY, BROADCAST AUDIT & DIAGNOSTICS ================= */
router.get("/spatial-hierarchy", getSpatialHierarchy);
router.get("/impact-analysis", getImpactAnalysis);
router.get("/jobs/:bookingId/location-inspect", inspectJobLocation);
router.get("/jobs/:bookingId/broadcast-audit", getJobBroadcastAudit);
router.get("/zone-health-dashboard", getZoneHealthDashboard);
router.get("/health-dashboard", getZoneHealthDashboard);
router.get("/live-monitor", listDistricts);
router.post("/polygons/rollback", rollbackPolygonVersion);

export default router;
