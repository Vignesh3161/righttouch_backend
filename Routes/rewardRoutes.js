import express from "express";
import { authorizeRoles } from "../Middleware/Auth.js";
import {
  getMyRewardBalance,
  getMyRewardHistory,
  reconcileMyRewards,
  getMyRedemptionPreview,
  getMyRedemptions,
  getRewardPolicy,
  createRewardPolicy,
  getRewardMetrics,
  adminListRewardTransactions,
  adminListRewardWallets,
  adminGetCustomerRewardOverview,
  adminListRedemptions,
  adminGetRewardReconciliation,
} from "../Controllers/rewardController.js";

// Customer self-service (mounted behind Auth; ownership via req.user).
export const customerRewardRoutes = express.Router();
customerRewardRoutes.get("/balance", getMyRewardBalance);
customerRewardRoutes.get("/history", getMyRewardHistory);
customerRewardRoutes.get("/reconcile", reconcileMyRewards);
customerRewardRoutes.get("/redemption-preview", getMyRedemptionPreview);
customerRewardRoutes.get("/redemptions", getMyRedemptions);

// Owner governance (mounted behind Auth + authorizeRoles).
// Read-only support views, policy/metrics governance, and redemption audit.
// Mutations happen only through the payment-order flow.
export const adminRewardRoutes = express.Router();
adminRewardRoutes.use(authorizeRoles("Owner"));
adminRewardRoutes.get("/policy", getRewardPolicy);
adminRewardRoutes.post("/policy", createRewardPolicy);
adminRewardRoutes.get("/metrics", getRewardMetrics);
adminRewardRoutes.get("/transactions", adminListRewardTransactions);
adminRewardRoutes.get("/wallets", adminListRewardWallets);
adminRewardRoutes.get("/wallets/:customerId", adminGetCustomerRewardOverview);
adminRewardRoutes.get("/redemptions", adminListRedemptions);
adminRewardRoutes.get("/reconciliation", adminGetRewardReconciliation);
