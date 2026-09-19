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

/**
 * @openapi
 * components:
 *   schemas:
 *     TechnicianDistrictPermission:
 *       type: object
 *       properties:
 *         technicianId:
 *           type: string
 *           example: "65f123456789abcdef012345"
 *         districtId:
 *           type: string
 *           example: "65f987654321fedcba543210"
 *         permissionType:
 *           type: string
 *           enum: [PRIMARY, ADDITIONAL]
 *           example: "ADDITIONAL"
 *         isEnabled:
 *           type: boolean
 *           example: true
 *         enabledAt:
 *           type: string
 *           format: date-time
 *     CityZonePermission:
 *       type: object
 *       properties:
 *         id:
 *           type: string
 *           example: "65f444456789abcdef012399"
 *         name:
 *           type: string
 *           example: "North Zone"
 *         zoneCode:
 *           type: string
 *           example: "Z-001"
 *         districtId:
 *           type: string
 *           example: "65f987654321fedcba543210"
 */

/* ================= ADMIN TECHNICIAN DISTRICT PERMISSIONS ================= */

/**
 * @openapi
 * /admin/technicians/{technicianId}/districts:
 *   get:
 *     summary: Get technician primary and additional district permissions
 *     tags:
 *       - Admin - Technician District Permissions
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: technicianId
 *         required: true
 *         schema:
 *           type: string
 *         description: Technician Profile ID
 *     responses:
 *       200:
 *         description: Technician district permissions retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: "Technician district permissions fetched"
 *                 result:
 *                   type: object
 *                   properties:
 *                     technicianId:
 *                       type: string
 *                     primaryDistrict:
 *                       type: object
 *                     additionalPermissions:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/TechnicianDistrictPermission'
 *                     allowedDistrictIds:
 *                       type: array
 *                       items:
 *                         type: string
 *       400:
 *         description: Invalid Technician ID
 *       403:
 *         description: Owner/Admin access only
 *       404:
 *         description: Technician profile not found
 *   post:
 *     summary: Add an additional district permission to a technician
 *     tags:
 *       - Admin - Technician District Permissions
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: technicianId
 *         required: true
 *         schema:
 *           type: string
 *         description: Technician Profile ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - districtId
 *             properties:
 *               districtId:
 *                 type: string
 *                 example: "65f987654321fedcba543210"
 *     responses:
 *       200:
 *         description: District permission added successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: "District permission added successfully"
 *       400:
 *         description: Invalid request or district not found
 *       403:
 *         description: Owner/Admin access only
 */
router.get("/technicians/:technicianId/districts", Auth, getTechnicianDistricts);
router.post("/technicians/:technicianId/districts", Auth, addTechnicianDistrictPermission);

/**
 * @openapi
 * /admin/technicians/{technicianId}/districts/{districtId}:
 *   patch:
 *     summary: Enable or disable an additional district permission
 *     tags:
 *       - Admin - Technician District Permissions
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: technicianId
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: districtId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - isEnabled
 *             properties:
 *               isEnabled:
 *                 type: boolean
 *                 example: true
 *     responses:
 *       200:
 *         description: District permission status updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *       400:
 *         description: Invalid technician/district ID or missing isEnabled
 *       403:
 *         description: Owner/Admin access only
 *   delete:
 *     summary: Remove an additional district permission
 *     tags:
 *       - Admin - Technician District Permissions
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: technicianId
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: districtId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: District permission removed successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *       400:
 *         description: Invalid technician/district ID
 *       403:
 *         description: Owner/Admin access only
 */
router.patch("/technicians/:technicianId/districts/:districtId", Auth, toggleTechnicianDistrictPermission);
router.delete("/technicians/:technicianId/districts/:districtId", Auth, removeTechnicianDistrictPermission);

/* ================= ADMIN TECHNICIAN CITY ZONE PERMISSIONS ================= */

/**
 * @openapi
 * /admin/technicians/{technicianId}/city-zones:
 *   get:
 *     summary: Get technician city zone permissions grouped by district
 *     tags:
 *       - Admin - Technician Zone Permissions
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: technicianId
 *         required: true
 *         schema:
 *           type: string
 *         description: Technician Profile ID
 *     responses:
 *       200:
 *         description: Technician zone permissions retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 technicianId:
 *                   type: string
 *                 primaryDistrict:
 *                   type: object
 *                 enabledDistricts:
 *                   type: array
 *                   items:
 *                     type: object
 *                 enabledCityZones:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/CityZonePermission'
 *                 groupedZonesByDistrict:
 *                   type: object
 *                 coverageRadiusKm:
 *                   type: number
 *                   example: 10
 *       400:
 *         description: Technician ID required
 *       404:
 *         description: Technician profile not found
 *   post:
 *     summary: Enable city zone permission(s) for a technician
 *     description: Enables single or multiple city zones. Validates that the technician has permission for the parent district first.
 *     tags:
 *       - Admin - Technician Zone Permissions
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: technicianId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               cityZoneId:
 *                 type: string
 *                 example: "65f444456789abcdef012399"
 *               cityZoneIds:
 *                 type: array
 *                 items:
 *                   type: string
 *                 example: ["65f444456789abcdef012399", "65f444456789abcdef012398"]
 *               reason:
 *                 type: string
 *                 example: "Assigned coverage for North Cluster"
 *     responses:
 *       200:
 *         description: Zone permission(s) enabled successfully
 *       400:
 *         description: Technician lacks district authorization or invalid parameters
 *       404:
 *         description: Technician or City Zones not found
 *   delete:
 *     summary: Bulk revoke city zone permission(s) for a technician
 *     tags:
 *       - Admin - Technician Zone Permissions
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: technicianId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               cityZoneIds:
 *                 type: array
 *                 items:
 *                   type: string
 *                 example: ["65f444456789abcdef012399"]
 *               reason:
 *                 type: string
 *                 example: "Coverage area updated"
 *     responses:
 *       200:
 *         description: Zone permission(s) revoked successfully
 *       400:
 *         description: Missing technicianId or zoneIds
 */
router.get("/technicians/:technicianId/city-zones", Auth, getTechnicianZonePermissions);
router.get("/technicians/:technicianId/zones", Auth, getTechnicianZonePermissions);

router.post("/technicians/:technicianId/city-zones", Auth, enableTechnicianZonePermission);
router.post("/technicians/:technicianId/zones/:zoneId/enable", Auth, enableTechnicianZonePermission);

/**
 * @openapi
 * /admin/technicians/{technicianId}/city-zones/{zoneId}:
 *   delete:
 *     summary: Revoke a single city zone permission for a technician
 *     tags:
 *       - Admin - Technician Zone Permissions
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: technicianId
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: zoneId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Zone permission revoked successfully
 *       400:
 *         description: Missing technicianId or zoneId
 */
router.delete("/technicians/:technicianId/city-zones/:zoneId", Auth, disableTechnicianZonePermission);
router.delete("/technicians/:technicianId/city-zones", Auth, disableTechnicianZonePermission);
router.post("/technicians/:technicianId/city-zones/remove", Auth, disableTechnicianZonePermission);
router.post("/technicians/:technicianId/zones/:zoneId/disable", Auth, disableTechnicianZonePermission);

export default router;

