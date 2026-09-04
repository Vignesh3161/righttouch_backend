import express from "express";
import {
  getAllTechnicianKyc,
  getTechnicianKyc,
  getTechnicianKycFull,
  verifyTechnicianKyc,
  verifyBankDetails,
  deleteTechnicianKyc,
  getOrphanedKyc,
  deleteOrphanedKyc,
  deleteAllOrphanedKyc,
  adminUpdateTechnicianKycDetails,
  adminUpdateTechnicianBankDetails,
} from "../Controllers/technicianKycController.js";

const router = express.Router();

/* ================= ADMIN KYC / BANK MANAGEMENT ================= */
// These are admin/owner-only operations, mounted under /api/admin so they
// are clearly separated from the technician self-service KYC routes and
// surface in the Admin Postman collection.

// List + lookup
router.get("/kyc", getAllTechnicianKyc);
router.get("/kyc/orphaned/list", getOrphanedKyc);
router.get("/kyc/:technicianId/full", getTechnicianKycFull);
router.get("/kyc/:technicianId", getTechnicianKyc);

// Admin edits technician KYC identity + bank details directly
router.put("/kyc/:technicianId", adminUpdateTechnicianKycDetails);
router.put("/bank/:technicianId", adminUpdateTechnicianBankDetails);

// Admin verify / reject KYC + bank details
router.put("/kyc/:technicianId/verify", verifyTechnicianKyc);
router.put("/bank/:technicianId/verify", verifyBankDetails);

// Cleanup
router.delete("/kyc/orphaned/cleanup/all", deleteAllOrphanedKyc);
router.delete("/kyc/orphaned/:kycId", deleteOrphanedKyc);
router.delete("/kyc/:technicianId", deleteTechnicianKyc);

export default router;
