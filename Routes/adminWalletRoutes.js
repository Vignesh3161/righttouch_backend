import express from "express";
import { Auth, authorizeRoles } from "../Middleware/Auth.js";

import {
  getAdminWalletSummary,
  getAllWithdrawalRequests,
  exportWithdrawalRequests,
  getWithdrawalDetails,
  approveWithdrawal,
  rejectWithdrawal,
  payWithdrawal,
  retryFailedWithdrawal,
  toggleTechnicianPayoutFreeze,
  getAutoPayoutSummary,
  getAutoPayoutSettings,
  updateAutoPayoutSettings,
  adminManualPayoutToTechnician,
  approveAdminManualPayout,
  resolveManualReviewPayout,
} from "../Controllers/adminWalletController.js";
import { getWithdrawalReceipt } from "../Controllers/technicianWalletController.js";

import {
  setServiceCommission,
  getServiceCommission,
  getAllServiceCommissions,
  overrideBookingCommission,
  getAuditLogs,
} from "../Controllers/adminCommissionController.js";

import {
  getReacceptPenaltySetting,
  setReacceptPenaltySetting,
} from "../Controllers/adminSettingsController.js";

const router = express.Router();

/* ================= ADMIN WALLET ================= */

// Summary
router.get("/wallet", Auth, getAdminWalletSummary);

// All withdrawal requests (?status=pending|approved|paid|rejected|processing, ?type=auto|manual)
router.get("/wallet/withdrawalhistory", Auth, getAllWithdrawalRequests);
router.get("/wallet/withdrawals", Auth, getAllWithdrawalRequests);
router.get("/wallet/export", Auth, exportWithdrawalRequests);
router.get("/wallet/withdrawal/:id/receipt", Auth, getWithdrawalReceipt);
router.get("/wallet/withdrawal/:id/details", Auth, getWithdrawalDetails);

// 💸 Auto-payout monitoring — dashboard summary (counts + amounts)
router.get("/wallet/auto-payouts/summary", Auth, getAutoPayoutSummary);

// 💸 Global auto-payout configuration (enabled / threshold / maintenance floor)
router.get("/settings/auto-payout", Auth, getAutoPayoutSettings);
router.put("/settings/auto-payout", Auth, updateAutoPayoutSettings);

// Decide withdrawal
router.put("/wallet/withdrawal/:id/approve", Auth, approveWithdrawal);
router.put("/wallet/withdrawal/:id/reject", Auth, rejectWithdrawal);

// ✅ Razorpay X – trigger actual bank/UPI payout to technician (outbox pattern)
router.put("/wallet/withdrawal/:id/pay", Auth, payWithdrawal);
router.post("/wallet/withdrawal/:id/retry", Auth, retryFailedWithdrawal);

// 🔒 Admin Freeze/Unfreeze technician payouts
router.put("/wallet/technician/:technicianId/freeze", Auth, toggleTechnicianPayoutFreeze);

// 💸 Admin manual "Send Money" to a technician — single shared payout engine.
// origin = admin_direct; below the configurable dual-approval threshold it
// pays immediately, at/above it parks in `requested` for a second admin.
router.post("/wallet/technician/:technicianId/send-money", Auth, adminManualPayoutToTechnician);

// ✅ Second-admin approval for a high-value (dual-approval) admin_direct payout.
router.put("/wallet/withdrawal/:id/approve-manual-payout", Auth, approveAdminManualPayout);

// 🛠️ Admin resolves an ambiguous (manual_review) payout: complete | revert.
router.put("/wallet/withdrawal/:id/resolve-manual-review", Auth, resolveManualReviewPayout);

/* ================= COMMISSION GOVERNANCE (Admin/Owner, audited) ================= */

// List all services with their commission config (admin UI) — must be
// registered BEFORE /commission/service/:serviceId so "services" is not
// captured as an id.
router.get(
  "/commission/services",
  Auth,
  authorizeRoles("Admin", "Owner"),
  getAllServiceCommissions
);

// View one service's commission config (live + effective + fallback)
router.get(
  "/commission/service/:serviceId",
  Auth,
  authorizeRoles("Admin", "Owner"),
  getServiceCommission
);

// Set commission percentage for a service — updates the live field AND
// writes a versioned rule (effectiveFrom optional, defaults to now).
router.put(
  "/commission/service/:serviceId",
  Auth,
  authorizeRoles("Admin", "Owner"),
  setServiceCommission
);

// Booking-level override (requires reason, audit-logged, unpaid bookings only)
router.put(
  "/commission/booking/:bookingId/override",
  Auth,
  authorizeRoles("Admin", "Owner"),
  overrideBookingCommission
);

/* ================= AUDIT ================= */

router.get("/audit-logs", Auth, authorizeRoles("Admin", "Owner"), getAuditLogs);

/* ================= GLOBAL SETTINGS (Admin/Owner, audited) ================= */

// Technician re-accept penalty: % of booking total debited when a technician
// re-accepts a job they previously cancelled.
router.get(
  "/settings/reaccept-penalty",
  Auth,
  authorizeRoles("Admin", "Owner"),
  getReacceptPenaltySetting
);
router.put(
  "/settings/reaccept-penalty",
  Auth,
  authorizeRoles("Admin", "Owner"),
  setReacceptPenaltySetting
);

export default router;

