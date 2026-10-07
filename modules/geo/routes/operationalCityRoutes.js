import express from "express";
import { Auth, authorizeRoles } from "../../../shared/middleware/Auth.js";
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
} from "../controllers/operationalCityController.js";

const router = express.Router();

/**
 * @openapi
 * components:
 *   schemas:
 *     OperationalDistrict:
 *       type: object
 *       properties:
 *         _id:
 *           type: string
 *           example: "65f987654321fedcba543210"
 *         name:
 *           type: string
 *           example: "Madurai District"
 *         city:
 *           type: string
 *           example: "Madurai"
 *         state:
 *           type: string
 *           example: "Tamil Nadu"
 *         country:
 *           type: string
 *           example: "India"
 *         active:
 *           type: boolean
 *           example: true
 *         isRegistrationEnabled:
 *           type: boolean
 *           example: true
 *         isJobEnabled:
 *           type: boolean
 *           example: true
 *         polygon:
 *           type: object
 *           properties:
 *             type:
 *               type: string
 *               example: "Polygon"
 *             coordinates:
 *               type: array
 *               items:
 *                 type: array
 *                 items:
 *                   type: array
 *                   items:
 *                     type: number
 */

/* ================= OPERATIONAL CITY / DISTRICT MASTER ROUTES (Admin/Owner) ================= */

/**
 * @openapi
 * /admin/districts:
 *   get:
 *     summary: List all operational districts / cities
 *     tags:
 *       - Admin - Operational Districts
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: active
 *         schema:
 *           type: boolean
 *         description: Filter by active status
 *     responses:
 *       200:
 *         description: List of districts retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 districts:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/OperationalDistrict'
 *   post:
 *     summary: Create a new operational district / city with boundary polygon
 *     tags:
 *       - Admin - Operational Districts
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *             properties:
 *               name:
 *                 type: string
 *                 example: "Madurai District"
 *               city:
 *                 type: string
 *                 example: "Madurai"
 *               state:
 *                 type: string
 *                 example: "Tamil Nadu"
 *               country:
 *                 type: string
 *                 example: "India"
 *               polygon:
 *                 type: object
 *                 description: GeoJSON Polygon definition
 *     responses:
 *       201:
 *         description: Operational district created successfully
 *       400:
 *         description: Validation failed
 */
router.get("/districts", Auth, authorizeRoles("Admin", "Owner"), listOperationalCities);
router.get("/operational-cities", Auth, authorizeRoles("Admin", "Owner"), listOperationalCities);
router.get("/admin/districts", Auth, authorizeRoles("Admin", "Owner"), listOperationalCities);

/**
 * @openapi
 * /admin/operational-cities/active:
 *   get:
 *     summary: Get single active operational city / district
 *     tags:
 *       - Admin - Operational Districts
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Active city returned
 */
router.get("/operational-cities/active", Auth, authorizeRoles("Admin", "Owner"), getActiveOperationalCity);

/**
 * @openapi
 * /admin/operational-cities/polygons:
 *   get:
 *     summary: Get all active polygons for operational districts
 *     tags:
 *       - Admin - Operational Districts
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Active polygons list returned
 */
router.get("/operational-cities/polygons", Auth, authorizeRoles("Admin", "Owner"), getActivePolygons);

/**
 * @openapi
 * /admin/districts/{id}:
 *   get:
 *     summary: Get single operational district by ID
 *     tags:
 *       - Admin - Operational Districts
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Operational district found
 *       404:
 *         description: District not found
 *   put:
 *     summary: Update an operational district
 *     tags:
 *       - Admin - Operational Districts
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *     responses:
 *       200:
 *         description: District updated successfully
 *   delete:
 *     summary: Delete an operational district
 *     tags:
 *       - Admin - Operational Districts
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: District deleted successfully
 */
router.get("/districts/:id", Auth, authorizeRoles("Admin", "Owner"), getOperationalCityById);
router.get("/operational-cities/:id", Auth, authorizeRoles("Admin", "Owner"), getOperationalCityById);
router.get("/admin/districts/:id", Auth, authorizeRoles("Admin", "Owner"), getOperationalCityById);

router.post("/districts", Auth, authorizeRoles("Admin", "Owner"), createOperationalCity);
router.post("/operational-cities", Auth, authorizeRoles("Admin", "Owner"), createOperationalCity);
router.post("/admin/districts", Auth, authorizeRoles("Admin", "Owner"), createOperationalCity);

router.put("/districts/:id", Auth, authorizeRoles("Admin", "Owner"), updateOperationalCity);
router.put("/operational-cities/:id", Auth, authorizeRoles("Admin", "Owner"), updateOperationalCity);
router.put("/admin/districts/:id", Auth, authorizeRoles("Admin", "Owner"), updateOperationalCity);

/**
 * @openapi
 * /admin/districts/{id}/status:
 *   patch:
 *     summary: Toggle district operational active/inactive status
 *     tags:
 *       - Admin - Operational Districts
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
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
 *               active:
 *                 type: boolean
 *                 example: true
 *     responses:
 *       200:
 *         description: Status updated
 * /admin/districts/{id}/registration:
 *   patch:
 *     summary: Toggle technician registration flag for a district
 *     tags:
 *       - Admin - Operational Districts
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
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
 *               isRegistrationEnabled:
 *                 type: boolean
 *                 example: true
 *     responses:
 *       200:
 *         description: Registration status updated
 * /admin/districts/{id}/jobs:
 *   patch:
 *     summary: Toggle job dispatch/booking flag for a district
 *     tags:
 *       - Admin - Operational Districts
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
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
 *               isJobEnabled:
 *                 type: boolean
 *                 example: true
 *     responses:
 *       200:
 *         description: Jobs status updated
 * /admin/districts/{id}/technicians:
 *   get:
 *     summary: Get all technicians belonging or assigned to a district
 *     tags:
 *       - Admin - Operational Districts
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Technicians list returned
 */
router.patch("/districts/:id/status", Auth, authorizeRoles("Admin", "Owner"), updateDistrictStatus);
router.patch("/districts/:id/registration", Auth, authorizeRoles("Admin", "Owner"), updateDistrictRegistration);
router.patch("/districts/:id/jobs", Auth, authorizeRoles("Admin", "Owner"), updateDistrictJobs);
router.get("/districts/:id/technicians", Auth, authorizeRoles("Admin", "Owner"), getDistrictTechnicians);
router.patch("/admin/districts/:id/status", Auth, authorizeRoles("Admin", "Owner"), updateDistrictStatus);
router.patch("/admin/districts/:id/registration", Auth, authorizeRoles("Admin", "Owner"), updateDistrictRegistration);
router.patch("/admin/districts/:id/jobs", Auth, authorizeRoles("Admin", "Owner"), updateDistrictJobs);
router.get("/admin/districts/:id/technicians", Auth, authorizeRoles("Admin", "Owner"), getDistrictTechnicians);

/**
 * @openapi
 * /admin/operational-cities/{id}/activate:
 *   post:
 *     summary: Set a district as active
 *     tags:
 *       - Admin - Operational Districts
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: City activated
 */
router.post("/operational-cities/:id/activate", Auth, authorizeRoles("Admin", "Owner"), activateOperationalCity);

router.delete("/districts/:id", Auth, authorizeRoles("Admin", "Owner"), deleteOperationalCity);
router.delete("/operational-cities/:id", Auth, authorizeRoles("Admin", "Owner"), deleteOperationalCity);
router.delete("/admin/districts/:id", Auth, authorizeRoles("Admin", "Owner"), deleteOperationalCity);

export default router;