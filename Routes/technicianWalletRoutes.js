import express from "express";
import { Auth } from "../Middleware/Auth.js";
import isTechnician from "../Middleware/isTechnician.js";

import {
  getTechnicianWallet,
  getWalletTransactions,
  requestWithdrawal,
  getMyWithdrawalRequests,
  updateMyPayoutSettings,
  cancelMyWithdrawal,
  getWithdrawalReceipt,
} from "../Controllers/technicianWalletController.js";

const router = express.Router();

/* ================= TECHNICIAN WALLET ================= */


// Wallet balance (+ auto-payout settings & estimate)
router.get("/wallet", Auth, isTechnician, getTechnicianWallet);

// Wallet transactions (credits / debits)
router.get("/wallet/transactions", Auth, isTechnician, getWalletTransactions);

// Withdraw request
router.post("/wallet/withdrawal", Auth, isTechnician, requestWithdrawal);
router.post("/wallet/withdrawal/request", Auth, isTechnician, requestWithdrawal);

// Cancel withdrawal request (if pending/requested)
router.post("/wallet/withdrawal/:id/cancel", Auth, isTechnician, cancelMyWithdrawal);

// Payout receipt
router.get("/wallet/withdrawal/:id/receipt", Auth, isTechnician, getWithdrawalReceipt);

// My withdrawal history
router.get("/wallet/withdrawalhistory", Auth, isTechnician, getMyWithdrawalRequests);

// 💸 Per-technician auto-payout overrides (threshold, maintenance floor,
//    enable/disable, preferred payout mode)
router.put("/wallet/payout-settings", Auth, isTechnician, updateMyPayoutSettings);

export default router;
