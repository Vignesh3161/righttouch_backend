import express from "express";
import { Auth, authorizeRoles } from "../Middleware/Auth.js";
import {
  getProductDashboardSummaryController,
  getSalesReportController,
  getProductAuditLogsController,
  getAuditLogByIdController
} from "../Controllers/productDashboardController.js";

const router = express.Router();
const adminOnly = authorizeRoles("Admin", "Owner");

// GET /api/admin/product-dashboard
router.get("/product-dashboard", Auth, adminOnly, getProductDashboardSummaryController);

// GET /api/admin/product-reports/sales
router.get("/product-reports/sales", Auth, adminOnly, getSalesReportController);

// GET /api/admin/product-audit-logs
router.get("/product-audit-logs", Auth, adminOnly, getProductAuditLogsController);

// GET /api/admin/product-audit-logs/:id
router.get("/product-audit-logs/:id", Auth, adminOnly, getAuditLogByIdController);

export default router;
