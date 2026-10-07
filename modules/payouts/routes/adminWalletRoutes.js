import express from "express";
import { Auth, authorizeRoles } from "../../../shared/middleware/Auth.js";

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
} from "../controllers/adminWalletController.js";
import { getWithdrawalReceipt } from "../controllers/technicianWalletController.js";

import {
  setServiceCommission,
  getServiceCommission,
  getAllServiceCommissions,
  overrideBookingCommission,
  getAuditLogs,
} from "../../catalog/controllers/adminCommissionController.js";

import {
  getReacceptPenaltySetting,
  setReacceptPenaltySetting,
} from "../../support-system/controllers/adminSettingsController.js";

const router = express.Router();

/* ================= ADMIN WALLET ================= */

// Summary
router.get("/wallet", Auth, authorizeRoles("Admin", "Owner"), getAdminWalletSummary);

// All withdrawal requests (?status=pending|approved|paid|rejected|processing, ?type=auto|manual)
router.get("/wallet/withdrawalhistory", Auth, authorizeRoles("Admin", "Owner"), getAllWithdrawalRequests);
router.get("/wallet/withdrawals", Auth, authorizeRoles("Admin", "Owner"), getAllWithdrawalRequests);
router.get("/wallet/export", Auth, authorizeRoles("Admin", "Owner"), exportWithdrawalRequests);
router.get("/wallet/withdrawal/:id/receipt", Auth, authorizeRoles("Admin", "Owner"), getWithdrawalReceipt);
router.get("/wallet/withdrawal/:id/details", Auth, authorizeRoles("Admin", "Owner"), getWithdrawalDetails);

// 💸 Auto-payout monitoring — dashboard summary (counts + amounts)
router.get("/wallet/auto-payouts/summary", Auth, authorizeRoles("Admin", "Owner"), getAutoPayoutSummary);

// 💸 Global auto-payout configuration (enabled / threshold / maintenance floor)
router.get("/settings/auto-payout", Auth, authorizeRoles("Admin", "Owner"), getAutoPayoutSettings);
router.put("/settings/auto-payout", Auth, authorizeRoles("Admin", "Owner"), updateAutoPayoutSettings);

// Decide withdrawal
router.put("/wallet/withdrawal/:id/approve", Auth, authorizeRoles("Admin", "Owner"), approveWithdrawal);
router.put("/wallet/withdrawal/:id/reject", Auth, authorizeRoles("Admin", "Owner"), rejectWithdrawal);

// ✅ Razorpay X – trigger actual bank/UPI payout to technician (outbox pattern)
router.put("/wallet/withdrawal/:id/pay", Auth, authorizeRoles("Admin", "Owner"), payWithdrawal);
router.post("/wallet/withdrawal/:id/retry", Auth, authorizeRoles("Admin", "Owner"), retryFailedWithdrawal);

// 🔒 Admin Freeze/Unfreeze technician payouts
router.put("/wallet/technician/:technicianId/freeze", Auth, authorizeRoles("Admin", "Owner"), toggleTechnicianPayoutFreeze);

// 💸 Admin manual "Send Money" to a technician — single shared payout engine.
// origin = admin_direct; below the configurable dual-approval threshold it
// pays immediately, at/above it parks in `requested` for a second admin.
router.post("/wallet/technician/:technicianId/send-money", Auth, authorizeRoles("Admin", "Owner"), adminManualPayoutToTechnician);

// ✅ Second-admin approval for a high-value (dual-approval) admin_direct payout.
router.put("/wallet/withdrawal/:id/approve-manual-payout", Auth, authorizeRoles("Admin", "Owner"), approveAdminManualPayout);

// 🛠️ Admin resolves an ambiguous (manual_review) payout: complete | revert.
router.put("/wallet/withdrawal/:id/resolve-manual-review", Auth, authorizeRoles("Admin", "Owner"), resolveManualReviewPayout);

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

