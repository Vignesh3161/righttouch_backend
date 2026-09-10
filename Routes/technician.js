import express from "express";
import { Auth } from "../Middleware/Auth.js";
import isTechnician from "../Middleware/isTechnician.js";
import { upload, kycUpload } from "../Utils/cloudinaryUpload.js";
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
} from "../Controllers/technician.js";
import { technicianLogin, verifyTechnicianOtp } from "../Controllers/User.js";
import { respondToJob, getMyJobs } from "../Controllers/technicianBroadcastController.js";
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
} from "../Controllers/technicianKycController.js";
import { updateBookingStatus, getTechnicianJobHistory, getTechnicianCurrentJobs, uploadWorkImages, getAdminJobHistory, technicianCancelBooking, getAllAcceptedJobs, getAcceptedScheduledJobs, acceptCancelledJob } from "../Controllers/serviceBookController.js";
import { createWalletTransaction, getWalletTransactions, requestWithdrawal, getMyWithdrawalRequests, cancelMyWithdrawal } from "../Controllers/technicianWalletController.js";
import { getMyZone, getServicesInMyZone } from "../Controllers/zoneAvailabilityController.js";
import { technicianListMyComplaints, technicianGetComplaintDetail, technicianRespondToComplaint } from "../Controllers/complaintController.js";




const router = express.Router();


/* ================= TECHNICIAN SIGNUP (TERMS REQUIRED) ================= */
// Technician signup route - requires termsAccepted
import { signupAndSendOtp, verifyOtp } from "../Controllers/User.js";
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
router.post("/signup/technician/verify-otp", authLimiter, verifyOtp);

/* ================= TECHNICIAN AUTH ================= */
router.post("/login/technician", technicianLogin);
router.post("/login/technician/verify-otp", verifyTechnicianOtp);
router.put("/location", Auth, isTechnician, locationLimiter, updateTechnicianLocation);
router.put("/fcm-token", Auth, isTechnician, registerTechnicianFcmToken);
router.post("/technicianData", Auth, createTechnician);
router.get("/technicianAll", Auth, getAllTechnicians);
router.get("/technicianById/:id", Auth, getTechnicianById);
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

router.get("/kyc", Auth, getAllTechnicianKyc);
router.get("/technician/kyc", Auth, getAllTechnicianKyc);

// 🔏 Full unmasked PII — audited access, Owner/Admin only. Define BEFORE
// the generic /:technicianId route (explicit match wins by order).
router.get("/kyc/:technicianId/full", Auth, getTechnicianKycFull);
router.get("/technician/kyc/:technicianId/full", Auth, getTechnicianKycFull);

router.get("/kyc/:technicianId", Auth, getTechnicianKyc);
router.get("/technician/kyc/:technicianId", Auth, getTechnicianKyc);

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

router.put("/kyc/verify", Auth, kycAdminLimiter, verifyTechnicianKyc);
router.put("/technician/kyc/verify", Auth, kycAdminLimiter, verifyTechnicianKyc);

router.put("/kyc/bank/verify", Auth, kycAdminLimiter, verifyBankDetails);
router.put("/technician/kyc/bank/verify", Auth, kycAdminLimiter, verifyBankDetails);

router.delete("/deletekyc/:technicianId", Auth, deleteTechnicianKyc);
router.delete("/technician/deletekyc/:technicianId", Auth, deleteTechnicianKyc);

router.get("/kyc/orphaned/list", Auth, getOrphanedKyc);
router.get("/technician/kyc/orphaned/list", Auth, getOrphanedKyc);

router.delete("/kyc/orphaned/cleanup/all", Auth, deleteAllOrphanedKyc);
router.delete("/technician/kyc/orphaned/cleanup/all", Auth, deleteAllOrphanedKyc);

router.delete("/kyc/orphaned/:kycId", Auth, deleteOrphanedKyc);
router.delete("/technician/kyc/orphaned/:kycId", Auth, deleteOrphanedKyc);

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
