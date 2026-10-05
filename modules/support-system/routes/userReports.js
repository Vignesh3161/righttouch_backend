import express from "express";
import { Auth } from "../../../shared/middleware/Auth.js";
import { customerCreateReport, customerGetMyReports, customerWithdrawComplaint, listReportCategories } from "../controllers/complaintController.js";

const router = express.Router();

router.post("/", Auth, customerCreateReport);
router.get("/mine", Auth, customerGetMyReports);
router.get("/categories", Auth, listReportCategories);
router.post("/:id/withdraw", Auth, customerWithdrawComplaint);

export default router;
