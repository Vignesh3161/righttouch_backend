import express from "express";
import { Auth } from "../Middleware/Auth.js";
import isTechnician from "../Middleware/isTechnician.js";
import { technicianGetMyRefunds, listReportCategories } from "../Controllers/complaintController.js";

const router = express.Router();

router.get("/refunds", Auth, isTechnician, technicianGetMyRefunds);
router.get("/reports/categories", Auth, isTechnician, listReportCategories);

export default router;
