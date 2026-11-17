import express from "express";
import { Auth, authorizeRoles } from "../Middleware/Auth.js";

import {
  getAdminWalletSummary,
  getAllWithdrawalRequests,
  exportWithdrawalRequests,
  exportApprovedBulkPayments,
  getWithdrawalDetails,
  approveWithdrawal,
  rejectWithdrawal,
  markWithdrawalPaid,
  revertPaidWithdrawal,
  toggleTechnicianPayoutFreeze,
  getAutoPayoutSummary,
  getAutoPayoutSettings,
  updateAutoPayoutSettings,
  adminManualPayoutToTechnician,
  approveAdminManualPayout,
  resolveManualReviewPayout,
  getTechnicianWalletOverview,
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
router.get("/wallet", Auth, authorizeRoles("Owner"), getAdminWalletSummary);

// All withdrawal requests (?status=pending|approved|paid|rejected|processing, ?type=auto|manual)
router.get("/wallet/withdrawalhistory", Auth, authorizeRoles("Owner"), getAllWithdrawalRequests);
router.get("/wallet/withdrawals", Auth, authorizeRoles("Owner"), getAllWithdrawalRequests);
router.get("/wallet/export", Auth, authorizeRoles("Owner"), exportWithdrawalRequests);
router.get("/wallet/bulk-payment-export", Auth, authorizeRoles("Owner"), exportApprovedBulkPayments);
router.get("/wallet/withdrawal/:id/receipt", Auth, authorizeRoles("Owner"), getWithdrawalReceipt);
router.get("/wallet/withdrawal/:id/details", Auth, authorizeRoles("Owner"), getWithdrawalDetails);

// 💸 Auto-payout monitoring — dashboard summary (counts + amounts)
router.get("/wallet/auto-payouts/summary", Auth, authorizeRoles("Owner"), getAutoPayoutSummary);

// 💸 Global auto-payout configuration (enabled / threshold / maintenance floor)
router.get("/settings/auto-payout", Auth, authorizeRoles("Owner"), getAutoPayoutSettings);
router.put("/settings/auto-payout", Auth, authorizeRoles("Owner"), updateAutoPayoutSettings);

// Decide withdrawal
router.put("/wallet/withdrawal/:id/approve", Auth, authorizeRoles("Owner"), approveWithdrawal);
router.put("/wallet/withdrawal/:id/reject", Auth, authorizeRoles("Owner"), rejectWithdrawal);

// 💰 Manual bank-transfer flow: record an offline transfer (approved->paid)
// and revert a wrongly-recorded payment (paid->failed). No provider calls.
router.post("/wallet/withdrawal/:id/mark-paid", Auth, authorizeRoles("Owner"), markWithdrawalPaid);
router.post("/wallet/withdrawal/:id/revert-paid", Auth, authorizeRoles("Owner"), revertPaidWithdrawal);

// 🔍 Admin technician wallet overview — inspect balances, blocks, KYC
// summary and payout history before selecting a technician for payout.
router.get("/wallet/technician/:technicianId", Auth, authorizeRoles("Owner"), getTechnicianWalletOverview);

// 🔒 Admin Freeze/Unfreeze technician payouts
router.put("/wallet/technician/:technicianId/freeze", Auth, authorizeRoles("Owner"), toggleTechnicianPayoutFreeze);

// 💸 Admin manual "Send Money" to a technician — reserve-at-request model.
// origin = admin_direct; below the configurable dual-approval threshold it
// parks in `approved`, at/above it parks in `requested` for a second admin.
router.post("/wallet/technician/:technicianId/send-money", Auth, authorizeRoles("Owner"), adminManualPayoutToTechnician);

// ✅ Second-admin approval for a high-value (dual-approval) admin_direct payout.
router.put("/wallet/withdrawal/:id/approve-manual-payout", Auth, authorizeRoles("Owner"), approveAdminManualPayout);

// 🛠️ Admin resolves an ambiguous (manual_review) payout: complete | revert.
router.put("/wallet/withdrawal/:id/resolve-manual-review", Auth, authorizeRoles("Owner"), resolveManualReviewPayout);

/* ================= COMMISSION GOVERNANCE (Owner, audited) ================= */

// List all services with their commission config (admin UI) — must be
// registered BEFORE /commission/service/:serviceId so "services" is not
// captured as an id.
router.get(
  "/commission/services",
  Auth,
  authorizeRoles("Owner"),
  getAllServiceCommissions
);

// View one service's commission config (live + effective + fallback)
router.get(
  "/commission/service/:serviceId",
  Auth,
  authorizeRoles("Owner"),
  getServiceCommission
);

// Set commission percentage for a service — updates the live field AND
// writes a versioned rule (effectiveFrom optional, defaults to now).
router.put(
  "/commission/service/:serviceId",
  Auth,
  authorizeRoles("Owner"),
  setServiceCommission
);

// Booking-level override (requires reason, audit-logged, unpaid bookings only)
router.put(
  "/commission/booking/:bookingId/override",
  Auth,
  authorizeRoles("Owner"),
  overrideBookingCommission
);

/* ================= AUDIT ================= */

router.get("/audit-logs", Auth, authorizeRoles("Owner"), getAuditLogs);

/* ================= GLOBAL SETTINGS (Admin/Owner, audited) ================= */

// Technician re-accept penalty: % of booking total debited when a technician
// re-accepts a job they previously cancelled.
router.get(
  "/settings/reaccept-penalty",
  Auth,
  authorizeRoles("Owner"),
  getReacceptPenaltySetting
);
router.put(
  "/settings/reaccept-penalty",
  Auth,
  authorizeRoles("Owner"),
  setReacceptPenaltySetting
);

export default router;

