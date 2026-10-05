import express from "express";
import { Auth, authorizeRoles } from "../../../shared/middleware/Auth.js";
import {
  listTechnicianSkillRequests,
  reviewTechnicianSkillRequest,
} from "../controllers/technicianSkillRequestController.js";

const router = express.Router();

// Enforce authentication and Admin/Owner role
router.use(Auth, authorizeRoles("Admin", "Owner"));

// List all technician skill / new service addition requests
router.get("/technician-skill-requests", listTechnicianSkillRequests);

// Review (approve or reject) a specific technician skill request
router.put("/technician-skill-requests/:requestId/review", reviewTechnicianSkillRequest);

export default router;
