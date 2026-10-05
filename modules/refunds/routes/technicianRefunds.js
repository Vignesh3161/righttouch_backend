import express from "express";
import { Auth } from "../../../shared/middleware/Auth.js";
import isTechnician from "../../../shared/middleware/isTechnician.js";
import { technicianGetMyRefunds, listReportCategories } from "../../support-system/controllers/complaintController.js";

const router = express.Router();

router.get("/refunds", Auth, isTechnician, technicianGetMyRefunds);
router.get("/reports/categories", Auth, isTechnician, listReportCategories);

export default router;
