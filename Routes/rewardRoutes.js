import express from "express";
import {
  getMyRewardBalance,
  getMyRewardHistory,
  reconcileMyRewards,
  getRewardPolicy,
  createRewardPolicy,
  getRewardMetrics,
  adminListRewardTransactions,
  adminListRewardWallets,
  adminGetCustomerRewardOverview,
} from "../Controllers/rewardController.js";

// Customer self-service (mounted behind Auth; ownership via req.user).
export const customerRewardRoutes = express.Router();
customerRewardRoutes.get("/balance", getMyRewardBalance);
customerRewardRoutes.get("/history", getMyRewardHistory);
customerRewardRoutes.get("/reconcile", reconcileMyRewards);

// Admin/Owner governance (mounted behind Auth + authorizeRoles).
// Phase 1 is read-only support views + existing policy/metrics governance.
// No redemption mutation lives here; redemption stays disabled.
export const adminRewardRoutes = express.Router();
adminRewardRoutes.get("/policy", getRewardPolicy);
adminRewardRoutes.post("/policy", createRewardPolicy);
adminRewardRoutes.get("/metrics", getRewardMetrics);
adminRewardRoutes.get("/transactions", adminListRewardTransactions);
adminRewardRoutes.get("/wallets", adminListRewardWallets);
adminRewardRoutes.get("/wallets/:customerId", adminGetCustomerRewardOverview);
