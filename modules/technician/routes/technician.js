import express from "express";
import { Auth, authorizeRoles } from "../../../shared/middleware/Auth.js";
import isTechnician from "../../../shared/middleware/isTechnician.js";
import { upload, kycUpload } from "../../../shared/utils/cloudinaryUpload.js";
import {
  updateTechnicianLocation,
  createTechnician,
  getAllTechnicians,
  getTechnicianById,
  getMyTechnician,
  updateTechnician,
  addTechnicianSkills,
  removeTechnicianSkills,
  updateTechnicianStatus,
  deleteTechnician,
  updateTechnicianTraining,
  uploadProfileImage,
  registerTechnicianFcmToken,
  getRegistrationDistricts,
  getRegistrationZones,
  validateRegistrationLocation,
  getZoneServicesForTechnician,
  submitTechnicianSkillRequest,
  getMyTechnicianSkillRequests,
} from "../controllers/technician.js";
import { technicianLogin, verifyTechnicianOtp } from "../../identity/controllers/User.js";
import { respondToJob, getMyJobs } from "../../booking/controllers/technicianBroadcastController.js";
import {
  submitTechnicianKyc,
  submitTechnicianBankDetails,
  uploadTechnicianKycDocuments,
  getTechnicianKyc,
  getTechnicianKycFull,
  getMyTechnicianKyc,
  getAllTechnicianKyc,
  verifyTechnicianKyc,
  verifyBankDetails,
  deleteTechnicianKyc,
  getOrphanedKyc,
  deleteOrphanedKyc,
  deleteAllOrphanedKyc,
} from "../controllers/technicianKycController.js";
import { updateBookingStatus, getTechnicianJobHistory, getTechnicianCurrentJobs, uploadWorkImages, getAdminJobHistory, technicianCancelBooking, getAllAcceptedJobs, getAcceptedScheduledJobs, acceptCancelledJob } from "../../booking/controllers/serviceBookController.js";
import { createWalletTransaction, getWalletTransactions, requestWithdrawal, getMyWithdrawalRequests, cancelMyWithdrawal } from "../../payouts/controllers/technicianWalletController.js";
import { getMyZone, getServicesInMyZone } from "../../geo/controllers/zoneAvailabilityController.js";
import { technicianListMyComplaints, technicianGetComplaintDetail, technicianRespondToComplaint } from "../../support-system/controllers/complaintController.js";




const router = express.Router();


/* ================= TECHNICIAN SIGNUP (TERMS REQUIRED) ================= */
// Technician signup route - requires termsAccepted
import { signupAndSendOtp, verifyOtp } from "../../identity/controllers/User.js";
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';

const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  message: {
    success: false,
    message: "Too many attempts, please try again after 1 minute",
    result: {},
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// 📍 Location-ping limiter — mirrors the socket cap (1 per 5s = 12/min).
// PUT /api/technician/location used to bypass ALL socket limits; an app
// could hammer the HTTP path. Keyed per technician (falls back to IP).
const locationLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 12,
  message: {
    success: false,
    message: "Location updates too frequent",
    result: {},
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, res) => req.user?.technicianProfileId || ipKeyGenerator(req, res),
  validate: { ip: false, trustProxy: false },
});

router.post("/signup/technician", authLimiter, async (req, res, next) => {
  req.body = req.body || {};
  req.body.role = "Technician";
  // termsAccepted must be sent in body
  return signupAndSendOtp(req, res, next);
});

// Technician: verify OTP after signup
// P2: server-trusted OTP scope — Technician SIGNUP OTPs only.
router.post("/signup/technician/verify-otp", authLimiter, (req, res, next) => {
  req.otpScope = { role: "Technician", purpose: "SIGNUP" };
  return verifyOtp(req, res, next);
});

/* ================= TECHNICIAN REGISTRATION FLOW & ZONE-SERVICE ================= */
// Step 1: Get active districts where registration is enabled
router.get("/registration/districts", getRegistrationDistricts);
router.get("/districts", getRegistrationDistricts);

// Step 2: Get active zones for selected district
router.get("/registration/zones", getRegistrationZones);
router.get("/zones", getRegistrationZones);

// Step 3 & 4: Authoritative GPS location & Zone mismatch validation
router.post("/registration/validate-location", validateRegistrationLocation);

// Step 5: Get services available in zone (from ZoneServiceMapping)
router.get("/registration/zone-services", getZoneServicesForTechnician);
router.get("/zone-services", Auth, isTechnician, getZoneServicesForTechnician);

// Step 6: Technician Skill Requests (Requesting unapproved/new skills)
router.post("/skill-requests", Auth, isTechnician, submitTechnicianSkillRequest);
router.get("/skill-requests", Auth, isTechnician, getMyTechnicianSkillRequests);

/* ================= TECHNICIAN AUTH ================= */
// P0: route-level limiter added (same express-rate-limit mechanism and the
// project's existing {success:false,message,result:{}} denial shape as the
// identity authLimiter; success contract unchanged).
const techLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // mirrors identity authLimiter
  message: {
    success: false,
    message: "Too many attempts, please try again after 15 minutes",
    result: {},
  },
  standardHeaders: true,
  legacyHeaders: false,
});

router.post("/login/technician", techLoginLimiter, technicianLogin);
// P2: server-trusted OTP scope — Technician LOGIN OTPs only.
router.post("/login/technician/verify-otp", techLoginLimiter, (req, res, next) => {
  req.otpScope = { role: "Technician", purpose: "LOGIN" };
  return verifyTechnicianOtp(req, res, next);
});
router.put("/location", Auth, isTechnician, locationLimiter, updateTechnicianLocation);
router.put("/fcm-token", Auth, isTechnician, registerTechnicianFcmToken);
router.post("/technicianData", Auth, createTechnician);
// P1 (BREAKING-2 fix): administrative technician reads expose technician
// PII (names, mobile numbers, login times) to ANY authenticated caller.
// Route-level guard mirrors the privileged policy; in-controller checks (if
// any) remain as defense-in-depth. Non-privileged 200s become 403s by design.
router.get("/technicianAll", Auth, authorizeRoles("Admin", "Owner"), getAllTechnicians);
router.get("/technicianById/:id", Auth, authorizeRoles("Admin", "Owner"), getTechnicianById);
router.get("/technician/me", Auth, getMyTechnician);
router.put("/updateTechnician", Auth, updateTechnician);
router.put("/technician/skills/add", Auth, isTechnician, addTechnicianSkills);
router.put("/technician/skills/remove", Auth, isTechnician, removeTechnicianSkills);
router.put("/technician/status", Auth, updateTechnicianStatus);
router.put("/:technicianId/training", Auth, updateTechnicianTraining);
router.post("/technician/profile-image", Auth, isTechnician, upload.single("profileImage"), uploadProfileImage);
router.delete("/technicianDelete/:id", Auth, deleteTechnician);

/* ================= TECHNICIAN KYC ================= */

router.post("/kyc", Auth, isTechnician, submitTechnicianKyc);
router.post("/technician/kyc", Auth, isTechnician, submitTechnicianKyc);

router.post("/banks", Auth, isTechnician, submitTechnicianBankDetails);
router.post("/technician/banks", Auth, isTechnician, submitTechnicianBankDetails);
router.post("/kyc/bank-details", Auth, isTechnician, submitTechnicianBankDetails);
router.post("/technician/kyc/bank-details", Auth, isTechnician, submitTechnicianBankDetails);

router.post(
  "/kyc/upload",
  Auth,
  isTechnician,
  kycUpload.fields([
    { name: "aadhaarImage", maxCount: 2 },
    { name: "panImage", maxCount: 2 },
    { name: "dlImage", maxCount: 2 },
  ]),
  uploadTechnicianKycDocuments
);
router.post(
  "/technician/kyc/upload",
  Auth,
  isTechnician,
  kycUpload.fields([
    { name: "aadhaarImage", maxCount: 2 },
    { name: "panImage", maxCount: 2 },
    { name: "dlImage", maxCount: 2 },
  ]),
  uploadTechnicianKycDocuments
);

// IMPORTANT: define '/me' BEFORE '/:technicianId' so 'me' doesn't get treated as an id.
router.get("/kyc/me", Auth, isTechnician, getMyTechnicianKyc);
router.get("/technician/kyc/me", Auth, isTechnician, getMyTechnicianKyc);

// P1 (BREAKING-2 fix): these duplicated admin/KYC routes previously relied
// only on in-controller checks under bare Auth. Route-level
// authorizeRoles("Admin","Owner") now mirrors the canonical /api/admin twins
// (adminKycRoutes: router.use(Auth, authorizeRoles("Admin","Owner"))).
// In-controller isOwnerOrAdmin checks stay as defense-in-depth.
router.get("/kyc", Auth, authorizeRoles("Admin", "Owner"), getAllTechnicianKyc);
router.get("/technician/kyc", Auth, authorizeRoles("Admin", "Owner"), getAllTechnicianKyc);

// 🔏 Full unmasked PII — audited access, Owner/Admin only. Define BEFORE
// the generic /:technicianId route (explicit match wins by order).
router.get("/kyc/:technicianId/full", Auth, authorizeRoles("Admin", "Owner"), getTechnicianKycFull);
router.get("/technician/kyc/:technicianId/full", Auth, authorizeRoles("Admin", "Owner"), getTechnicianKycFull);

router.get("/kyc/:technicianId", Auth, authorizeRoles("Admin", "Owner"), getTechnicianKyc);
router.get("/technician/kyc/:technicianId", Auth, authorizeRoles("Admin", "Owner"), getTechnicianKyc);

// 🔒 Rate-limited admin decisions — every approval/rejection is audited
const kycAdminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 120, // admin review bursts
  message: {
    success: false,
    message: "Too many KYC decisions, please try again later",
    result: {},
  },
  standardHeaders: true,
  legacyHeaders: false,
});

router.put("/kyc/verify", Auth, authorizeRoles("Admin", "Owner"), kycAdminLimiter, verifyTechnicianKyc);
router.put("/technician/kyc/verify", Auth, authorizeRoles("Admin", "Owner"), kycAdminLimiter, verifyTechnicianKyc);

router.put("/kyc/bank/verify", Auth, authorizeRoles("Admin", "Owner"), kycAdminLimiter, verifyBankDetails);
router.put("/technician/kyc/bank/verify", Auth, authorizeRoles("Admin", "Owner"), kycAdminLimiter, verifyBankDetails);

router.delete("/deletekyc/:technicianId", Auth, authorizeRoles("Admin", "Owner"), deleteTechnicianKyc);
router.delete("/technician/deletekyc/:technicianId", Auth, authorizeRoles("Admin", "Owner"), deleteTechnicianKyc);

router.get("/kyc/orphaned/list", Auth, authorizeRoles("Admin", "Owner"), getOrphanedKyc);
router.get("/technician/kyc/orphaned/list", Auth, authorizeRoles("Admin", "Owner"), getOrphanedKyc);

router.delete("/kyc/orphaned/cleanup/all", Auth, authorizeRoles("Admin", "Owner"), deleteAllOrphanedKyc);
router.delete("/technician/kyc/orphaned/cleanup/all", Auth, authorizeRoles("Admin", "Owner"), deleteAllOrphanedKyc);

router.delete("/kyc/orphaned/:kycId", Auth, authorizeRoles("Admin", "Owner"), deleteOrphanedKyc);
router.delete("/technician/kyc/orphaned/:kycId", Auth, authorizeRoles("Admin", "Owner"), deleteOrphanedKyc);

/* ================= JOB BROADCAST ================= */

router.get("/job-broadcast/my-jobs", Auth, isTechnician, getMyJobs);

router.put("/job-broadcast/respond/:id", Auth, isTechnician, respondToJob);
router.put("/booking/technician/cancel/:id", Auth, isTechnician, technicianCancelBooking);
router.put("/booking/reaccept/:id", Auth, isTechnician, acceptCancelledJob); // Re-accept cancelled job (optional % penalty, admin-configured)

/* ================= JOB UPDATE ================= */

// Technician updates job status

router.put("/status/:id", Auth, isTechnician, updateBookingStatus);
router.post(
  "/jobs/:id/work-images",
  Auth,
  isTechnician,
  upload.fields([
    { name: "beforeImage", maxCount: 1 },
    { name: "afterImage", maxCount: 1 },
  ]),
  uploadWorkImages
);
router.get("/jobs/current", Auth, getTechnicianCurrentJobs); // Supports both Technician and Owner roles
router.get("/jobs/accepted", Auth, getAllAcceptedJobs); // Technician/Owner/Admin — all accepted jobs, new→old
router.get("/jobs/accepted/scheduled", Auth, getAcceptedScheduledJobs); // Technician/Owner/Admin — accepted scheduled jobs
router.get("/jobs/history", Auth, isTechnician, getTechnicianJobHistory);

/* ================= ADMIN JOB HISTORY (WITH DELETED TECHNICIAN SUPPORT) ================= */
router.get("/admin/jobs/history", Auth, getAdminJobHistory); // Owner/Admin only

/* ================= TECHNICIAN WALLET ================= */

router.post("/wallet/transaction", Auth, createWalletTransaction);
router.get("/wallet/history", Auth, isTechnician, getWalletTransactions);

// Technician withdrawal requests
router.post("/wallet/withdrawal", Auth, isTechnician, requestWithdrawal);
router.post("/wallet/withdrawal/request", Auth, isTechnician, requestWithdrawal);
router.get("/wallet/withdrawalhistory/me", Auth, isTechnician, getMyWithdrawalRequests);
router.put("/wallet/withdrawal/:id/cancel", Auth, isTechnician, cancelMyWithdrawal);

/* ================= TECHNICIAN ZONE ================= */

router.get("/zone/me", Auth, isTechnician, getMyZone);
router.get("/zone/services", Auth, isTechnician, getServicesInMyZone);

/* ================= TECHNICIAN COMPLAINTS & DISPUTES ================= */

router.get("/complaints", Auth, isTechnician, technicianListMyComplaints);
router.get("/complaints/:id", Auth, isTechnician, technicianGetComplaintDetail);
router.post(
  "/complaints/:id/respond",
  Auth,
  isTechnician,
  upload.array("images", 5),
  technicianRespondToComplaint
);

export default router;
