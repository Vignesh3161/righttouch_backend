import express from "express";
import { Auth, authorizeRoles } from "../Middleware/Auth.js";
import {
  createServiceAvailability,
  updateServiceAvailability,
  getServiceAvailability,
  deleteServiceAvailability,
  dispatchDiagnostics,
  getServiceZoneMatrix,
  getServiceZoneDetail,
  toggleZoneAvailability,
  bulkToggleZoneAvailability,
  clearDistrictZoneAvailability,
  toggleServiceStatus,
} from "../Controllers/adminServiceAvailabilityController.js";

const router = express.Router();

// Service-Zone Matrix & Checklist APIs (Defined BEFORE generic /:id parameter route)
router.get(
  "/service-availability/matrix",
  Auth,
  authorizeRoles("Admin", "Owner"),
  getServiceZoneMatrix
);

router.get(
  "/service-availability/service/:serviceId/detail",
  Auth,
  authorizeRoles("Admin", "Owner"),
  getServiceZoneDetail
);

router.post(
  "/service-availability/toggle-zone",
  Auth,
  authorizeRoles("Admin", "Owner"),
  toggleZoneAvailability
);

router.post(
  "/service-availability/bulk-toggle-zones",
  Auth,
  authorizeRoles("Admin", "Owner"),
  bulkToggleZoneAvailability
);

router.post(
  "/service-availability/clear-district-zones",
  Auth,
  authorizeRoles("Admin", "Owner"),
  clearDistrictZoneAvailability
);

router.post(
  "/service-availability/toggle-service-status",
  Auth,
  authorizeRoles("Admin", "Owner"),
  toggleServiceStatus
);

// Admin Service Availability CRUD
router.post(
  "/service-availability",
  Auth,
  authorizeRoles("Admin", "Owner"),
  createServiceAvailability
);

router.get(
  "/service-availability",
  Auth,
  authorizeRoles("Admin", "Owner"),
  getServiceAvailability
);

router.put(
  "/service-availability/:id",
  Auth,
  authorizeRoles("Admin", "Owner"),
  updateServiceAvailability
);

router.delete(
  "/service-availability/:id",
  Auth,
  authorizeRoles("Admin", "Owner"),
  deleteServiceAvailability
);

// Diagnostic Health Screen Endpoint
router.get(
  "/dispatch-debug",
  Auth,
  authorizeRoles("Admin", "Owner"),
  dispatchDiagnostics
);

export default router;
