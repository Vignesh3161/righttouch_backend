import { Router } from "express";
import { Auth, authorizeRoles } from "../Middleware/Auth.js";
import {
  getFinanceSummary,
  getFinanceBreakdown,
  getPaymentsLedger,
  getTechnicianFinanceDetail,
  getMyEarnings,
} from "../Controllers/financeController.js";

/**
 * 💹 Finance tracking routes.
 * Admin/Owner: /api/admin/finance/*
 * Technician:  /api/technician/finance/earnings
 */

export const adminFinanceRoutes = Router();

adminFinanceRoutes.get("/finance/summary", Auth, authorizeRoles("Admin", "Owner"), getFinanceSummary);
adminFinanceRoutes.get("/finance/breakdown", Auth, authorizeRoles("Admin", "Owner"), getFinanceBreakdown);
adminFinanceRoutes.get("/finance/payments", Auth, authorizeRoles("Admin", "Owner"), getPaymentsLedger);
adminFinanceRoutes.get("/finance/technician/:technicianId", Auth, authorizeRoles("Admin", "Owner"), getTechnicianFinanceDetail);

export const technicianFinanceRoutes = Router();

technicianFinanceRoutes.get("/finance/earnings", Auth, authorizeRoles("Technician"), getMyEarnings);