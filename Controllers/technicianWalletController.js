import mongoose from "mongoose";
import TechnicianProfile from "../Schemas/TechnicianProfile.js";
import TechnicianKyc from "../Schemas/TechnicianKYC.js";
import WalletTransaction from "../Schemas/WalletTransaction.js";
import WithdrawalRequest from "../Schemas/WithdrawalRequest.js";
import ServiceBooking from "../Schemas/ServiceBooking.js";
import { writeAuditLog } from "../Utils/audit.js";
import { toPaise, rupeesToPaise, paiseToRupees } from "../Utils/money.js";
import {
  getAutoPayoutConfig,
  resolveTechPayoutSettings,
  computeAutoPayoutForTech,
} from "../Utils/autoPayout.js";
import { executeWithdrawalPayout, releaseFailedWithdrawalReserve } from "../Utils/withdrawalPayoutEngine.js";
import { hasActivePayoutBlock } from "../Utils/complaintFreeze.js";
import { atomicWalletDebit } from "../Utils/walletDebit.js";
import { getIo } from "../Utils/ioAccess.js";

const isValidObjectId = mongoose.Types.ObjectId.isValid;

const toMoney = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const getConfig = () => {
  const envMinWithdrawal = toMoney(process.env.MIN_WITHDRAWAL_AMOUNT);
  const minWithdrawal =
    envMinWithdrawal != null && envMinWithdrawal > 0 ? envMinWithdrawal : 100;
  const cooldownDays = toMoney(process.env.WITHDRAWAL_COOLDOWN_DAYS) ?? 0;
  return {
    minWithdrawal,
    cooldownMs: Math.max(0, cooldownDays) * 24 * 60 * 60 * 1000,
  };
};


// Add Wallet Transaction (Owner only)
export const createWalletTransaction = async (req, res) => {
  try {
    const { technicianId, bookingId: rawBookingId, amount, amountPaise, type, source } = req.body;

    // Normalize empty bookingId (admin UI sends "") to null — a raw "" fails
    // ObjectId casting inside the ledger and produces a 500.
    const bookingId = rawBookingId ? rawBookingId : null;

    if (req.user?.role !== "Owner") {
      return res.status(403).json({
        success: false,
        message: "Owner access only",
        result: {},
      });
    }

    if (!technicianId || !isValidObjectId(technicianId)) {
      return res.status(400).json({
        success: false,
        message: "Valid technicianId is required",
        result: {},
      });
    }

    if (bookingId && !isValidObjectId(bookingId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid bookingId",
        result: {},
      });
    }

    // Integer paise is the primary input; rupees accepted as legacy alias.
    const amountPaiseNum = toPaise(amountPaise ?? rupeesToPaise(amount));
    if (amountPaiseNum == null || amountPaiseNum <= 0) {
      return res.status(400).json({
        success: false,
        message: "Amount must be positive (amountPaise or amount in rupees)",
        result: {},
      });
    }

    if (!["credit", "debit"].includes(type)) {
      return res.status(400).json({
        success: false,
        message: "Invalid transaction type",
        result: {},
      });
    }

    const technician = await TechnicianProfile.findById(technicianId);
    if (!technician) {
      return res.status(404).json({
        success: false,
        message: "Technician not found",
        result: {},
      });
    }

    if (bookingId) {
      const booking = await ServiceBooking.findOne({ _id: bookingId, technicianId });
      if (!booking) {
        return res.status(404).json({
          success: false,
          message: "Booking not found for technician",
          result: {},
        });
      }
    }

    // Manual money movement: adjustment / bonus / penalty ONLY.
    // Job earnings are credited exclusively through the settlement pipeline —
    // manual adjustments must never double-credit jobs.
    if (!["adjustment", "bonus", "penalty"].includes(source)) {
      return res.status(400).json({
        success: false,
        message: "Manual transactions allow only adjustment/bonus/penalty sources",
        result: {},
      });
    }

    const session = await mongoose.startSession();
    let transaction;
    try {
      await session.withTransaction(async () => {
        if (type === "debit" && source === "penalty") {
          // Penalties leverage atomicWalletDebit: deducts from available balance, and any
          // uncollected remainder is added to outstandingDuesPaise to be recovered from future job earnings.
          await atomicWalletDebit({
            technicianId,
            amountPaise: amountPaiseNum,
            reason: `Manual penalty by ${req.user.role} ${req.user.userId}`,
            idempotencyKey: `manual:${technicianId}:${source}:${bookingId || "none"}:${amountPaiseNum}:${type}`,
            session,
            allowDues: true,
          });

          [transaction] = await WalletTransaction.find({
            technicianId,
            idempotencyKey: { $regex: `^manual:${technicianId}:${source}:${bookingId || "none"}:${amountPaiseNum}:${type}` },
          }).session(session);
        } else {
          // Re-check balance inside the txn for other debits
          if (type === "debit") {
            const fresh = await TechnicianProfile.findById(technicianId)
              .select("availableBalancePaise")
              .session(session);
            if (!fresh || (fresh.availableBalancePaise ?? 0) < amountPaiseNum) {
              const err = new Error("Insufficient balance for manual debit");
              err.statusCode = 400;
              throw err;
            }
          }

          const inc =
            type === "credit"
              ? { availableBalancePaise: amountPaiseNum, lifetimeEarnedPaise: amountPaiseNum }
              : { availableBalancePaise: -amountPaiseNum };

          await TechnicianProfile.updateOne(
            { _id: technicianId },
            { $inc: inc },
            { session }
          );

          [transaction] = await WalletTransaction.create(
            [
              {
                technicianId,
                bookingId,
                amountPaise: amountPaiseNum,
                amount: paiseToRupees(amountPaiseNum),
                type,
                source,
                idempotencyKey: `manual:${technicianId}:${source}:${bookingId || "none"}:${amountPaiseNum}:${type}`,
                note: `Manual ${type} by ${req.user.role} ${req.user.userId}`,
              },
            ],
            { session }
          );
        }
      });
    } finally {
      session.endSession();
    }

    // Manual money movement is audited
    await writeAuditLog({
      actor: req.user.userId,
      actorRole: req.user.role,
      action: `WALLET_MANUAL_${type.toUpperCase()}`,
      targetType: "WalletTransaction",
      targetId: transaction._id,
      after: { technicianId, bookingId, amountPaise: amountPaiseNum, source },
      reason: req.body.reason || null,
    });

    res.status(201).json({
      success: true,
      message: "Wallet transaction recorded",
      result: transaction,
    });
  } catch (error) {
    // Respect typed statusCode (e.g. 400 insufficient balance) instead of
    // always returning 500
    res.status(error.statusCode || 500).json({ success: false, message: error.message, result: { error: error.message } });
  }
};

/* GET WALLET BALANCE */
export const getTechnicianWallet = async (req, res) => {
  try {
    // ensureTechnician(req); // Handled by middleware //sk

    const tech = req.technician;
    //sk
    const techId = new mongoose.Types.ObjectId(tech._id);

    // Total earnings = job/bonus/tip credits only (excludes refund adjustments
    // that restore previously-reserved money — those are not earnings).
    const totalEarningsResult = await WalletTransaction.aggregate([
      {
        $match: {
          technicianId: techId,
          type: "credit",
          source: { $in: ["job", "bonus", "tip"] }
        }
      },
      {
        $group: {
          _id: null,
          total: { $sum: "$amount" },
          job: { $sum: { $cond: [{ $eq: ["$source", "job"] }, "$amount", 0] } },
          tips: { $sum: { $cond: [{ $eq: ["$source", "tip"] }, "$amount", 0] } },
          bonuses: { $sum: { $cond: [{ $eq: ["$source", "bonus"] }, "$amount", 0] } },
        }
      }
    ]);

    const totalEarnings = totalEarningsResult[0]?.total || 0;
    const totalJobEarnings = totalEarningsResult[0]?.job || 0;
    const totalTips = totalEarningsResult[0]?.tips || 0;
    const totalBonuses = totalEarningsResult[0]?.bonuses || 0;

    // Calculate withdrawal stats
    //sk
    const withdrawalStats = await WithdrawalRequest.aggregate([
      {
        $match: {
          technicianId: techId
        }
      },
      {
        $group: {
          _id: null,
          approvedTotal: {
            $sum: {
              $cond: [{ $eq: ["$status", "approved"] }, "$amount", 0]
            }
          },
          approvedCount: {
            $sum: {
              $cond: [{ $eq: ["$status", "approved"] }, 1, 0]
            }
          },
          rejectedCount: {
            $sum: {
              $cond: [{ $eq: ["$status", "rejected"] }, 1, 0]
            }
          },
          pendingTotal: {
            $sum: {
              //sk
              $cond: [{ $in: ["$status", ["pending", "requested"]] }, "$amount", 0]
            }
          },
          pendingCount: {
            $sum: {
              //sk
              $cond: [{ $in: ["$status", ["pending", "requested"]] }, 1, 0]
            }
          }
        }
      }
    ]);

    const stats = withdrawalStats[0] || {
      approvedTotal: 0,
      approvedCount: 0,
      rejectedCount: 0,
      pendingTotal: 0,
      pendingCount: 0
    };

    // 💸 Auto-payout context — effective settings, in-flight auto payout and
    // the next-run estimate (or how much more must be earned to trigger).
    const [autoConfig, pendingAuto] = await Promise.all([
      getAutoPayoutConfig(),
      WithdrawalRequest.findOne({
        technicianId: tech._id,
        type: "auto",
        status: { $in: ["pending", "requested", "approved", "processing"] },
      })
        .select("amountPaise status autoApprovedAt autoApprovedReason")
        .sort({ createdAt: -1 })
        .lean(),
    ]);
    const payoutSettings = resolveTechPayoutSettings(tech, autoConfig);
    const autoEstimate = computeAutoPayoutForTech(tech, autoConfig);

    const activeWithdrawal = await WithdrawalRequest.findOne({
      technicianId: tech._id,
      status: { $in: ["pending", "requested", "approved", "processing", "manual_review"] },
    })
      .sort({ createdAt: -1 })
      .lean();

    const currentAvailablePaise = tech?.availableBalancePaise ?? toPaise(tech?.walletBalance ?? 0);
    const maintenanceFloorPaise = payoutSettings.minimumMaintenancePaise;
    const availableToWithdrawPaise = Math.max(0, currentAvailablePaise - maintenanceFloorPaise);
    const config = getConfig();

    let payoutDestination = null;
    if (tech.bankDetails) {
      if (tech.bankDetails.accountNumber) {
        const acc = String(tech.bankDetails.accountNumber);
        payoutDestination = `Bank Account (****${acc.slice(-4)})`;
      } else if (tech.bankDetails.upiId) {
        payoutDestination = `UPI (${tech.bankDetails.upiId})`;
      }
    }

    res.json({
      success: true,
      // Four explicit balances (paise) + legacy rupee mirrors
      availableBalancePaise: currentAvailablePaise,
      reservedBalancePaise: tech?.reservedBalancePaise ?? 0,
      lifetimeEarnedPaise: tech?.lifetimeEarnedPaise ?? 0,
      lifetimeWithdrawnPaise: tech?.lifetimeWithdrawnPaise ?? 0,
      maintenanceFloorPaise,
      maintenanceFloor: paiseToRupees(maintenanceFloorPaise),
      availableToWithdrawPaise,
      availableToWithdraw: paiseToRupees(availableToWithdrawPaise),
      balance: paiseToRupees(currentAvailablePaise),
      walletBalance: paiseToRupees(currentAvailablePaise),
      payoutDestination,
      activeWithdrawal: activeWithdrawal
        ? {
            withdrawalId: activeWithdrawal._id,
            status: activeWithdrawal.status,
            amount: activeWithdrawal.amount,
            amountPaise: activeWithdrawal.amountPaise,
            origin: activeWithdrawal.origin,
            createdAt: activeWithdrawal.createdAt,
          }
        : null,
      payoutLimits: {
        minWithdrawal: config.minWithdrawal,
        maxWithdrawal: toMoney(process.env.MAX_WITHDRAWAL_AMOUNT) || 50000,
      },
      totalEarnings,
      totalJobEarnings,
      totalTips,
      totalBonuses,
      stats,
      payoutSettings: {
        autoPayoutEnabled: payoutSettings.autoPayoutEnabled,
        autoPayoutThreshold: paiseToRupees(payoutSettings.autoPayoutThresholdPaise),
        autoPayoutThresholdPaise: payoutSettings.autoPayoutThresholdPaise,
        minimumMaintenance: paiseToRupees(payoutSettings.minimumMaintenancePaise),
        minimumMaintenancePaise: payoutSettings.minimumMaintenancePaise,
        preferredPayoutMode: payoutSettings.preferredPayoutMode,
        global: {
          autoPayoutEnabled: autoConfig.autoPayoutEnabled,
          autoPayoutThresholdPaise: autoConfig.autoPayoutThresholdPaise,
          minimumMaintenancePaise: autoConfig.minimumMaintenancePaise,
        },
      },
      pendingAutoPayoutPaise: toPaise(pendingAuto?.amountPaise ?? 0),
      pendingAutoPayout: paiseToRupees(toPaise(pendingAuto?.amountPaise ?? 0)),
      pendingAutoPayoutStatus: pendingAuto?.status || null,
      nextAutoPayoutEstimate: autoEstimate.eligible
        ? {
            eligible: true,
            amount: paiseToRupees(autoEstimate.amountPaise),
            amountPaise: autoEstimate.amountPaise,
            message: "You are eligible for auto-payout",
          }
        : {
            eligible: false,
            remainingToThreshold: paiseToRupees(autoEstimate.remainingToThresholdPaise),
            remainingToThresholdPaise: autoEstimate.remainingToThresholdPaise,
            message:
              autoEstimate.reason === "auto_payout_disabled"
                ? "Auto-payout is disabled for your account"
                : `Earn ₹${paiseToRupees(autoEstimate.remainingToThresholdPaise).toFixed(2)} more to trigger auto-payout`,
          },
    });
  } catch (error) {
    console.error("Error in getTechnicianWallet:", error);
    res.status(500).json({ success: false, message: "Internal Server Error", error: error.message });
  }
};

/**
 * 💸 UPDATE MY PAYOUT SETTINGS — per-technician auto-payout overrides.
 * Body (all optional):
 *   { autoPayoutEnabled?: boolean,
 *     autoPayoutThreshold?: number (₹),      // >= ₹100
 *     minimumMaintenance?: number (₹),       // >= 0
 *     preferredPayoutMode?: "UPI"|"IMPS"|"NEFT" }
 */
export const updateMyPayoutSettings = async (req, res) => {
  try {
    const tech = req.technician;
    const { autoPayoutEnabled, autoPayoutThreshold, minimumMaintenance, preferredPayoutMode } =
      req.body || {};

    const updates = { ...(tech.payoutSettings || {}) };

    if (autoPayoutEnabled !== undefined) {
      if (typeof autoPayoutEnabled !== "boolean") {
        return res.status(400).json({ success: false, message: "autoPayoutEnabled must be a boolean" });
      }
      updates.autoPayoutEnabled = autoPayoutEnabled;
    }

    if (autoPayoutThreshold !== undefined) {
      const thresholdPaise = toPaise(rupeesToPaise(autoPayoutThreshold));
      if (thresholdPaise < 10000) {
        return res.status(400).json({ success: false, message: "autoPayoutThreshold must be at least ₹100" });
      }
      updates.autoPayoutThresholdPaise = thresholdPaise;
    }

    if (minimumMaintenance !== undefined) {
      const maintenancePaise = toPaise(rupeesToPaise(minimumMaintenance));
      if (maintenancePaise < 0) {
        return res.status(400).json({ success: false, message: "minimumMaintenance must be >= 0" });
      }
      updates.minimumMaintenancePaise = maintenancePaise;
    }

    // Maintenance floor can never exceed the threshold — otherwise the
    // payout would be below ₹0 and auto-payout would never fire.
    const thresholdPaise = updates.autoPayoutThresholdPaise ?? 500000;
    const maintenancePaise = updates.minimumMaintenancePaise ?? 10000;
    if (maintenancePaise >= thresholdPaise) {
      return res.status(400).json({
        success: false,
        message: "minimumMaintenance must be lower than autoPayoutThreshold",
      });
    }

    if (preferredPayoutMode !== undefined) {
      if (!["UPI", "IMPS", "NEFT"].includes(preferredPayoutMode)) {
        return res.status(400).json({ success: false, message: "preferredPayoutMode must be UPI, IMPS or NEFT" });
      }
      updates.preferredPayoutMode = preferredPayoutMode;
    }

    const before = { ...(tech.payoutSettings || {}) };
    tech.payoutSettings = updates;
    await tech.save();

    await writeAuditLog({
      actor: req.user.userId,
      actorRole: req.user.role,
      action: "PAYOUT_SETTINGS_UPDATED",
      targetType: "TechnicianProfile",
      targetId: tech._id,
      before,
      after: updates,
      reason: req.body.reason || null,
    });

    res.json({
      success: true,
      message: "Payout settings updated",
      result: {
        autoPayoutEnabled: updates.autoPayoutEnabled,
        autoPayoutThreshold: paiseToRupees(updates.autoPayoutThresholdPaise),
        autoPayoutThresholdPaise: updates.autoPayoutThresholdPaise,
        minimumMaintenance: paiseToRupees(updates.minimumMaintenancePaise),
        minimumMaintenancePaise: updates.minimumMaintenancePaise,
        preferredPayoutMode: updates.preferredPayoutMode,
      },
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
};

/* GET WALLET TRANSACTIONS */
export const getWalletTransactions = async (req, res) => {
  // ensureTechnician(req); // Handled by middleware //sk

  //sk
  let query = { technicianId: req.technician._id };

  if (req.query.startDate || req.query.endDate) {
    query.createdAt = {};
    if (req.query.startDate) {
      query.createdAt.$gte = new Date(req.query.startDate);
    }
    if (req.query.endDate) {
      // Set end date to end of day
      const end = new Date(req.query.endDate);
      end.setHours(23, 59, 59, 999);
      query.createdAt.$lte = end;
    }
  }

  const txns = await WalletTransaction.find(query).sort({ createdAt: -1 });

  res.json({ success: true, result: txns });
};



//sk
/* REQUEST WITHDRAWAL — reserve-at-request model.
   The balance is deducted and a reserve debit ledger entry is created
   atomically with the request. On reject/cancel the reserve is refunded;
   on payout the withdrawal completes with no further balance change.
   (Legacy requests created before this model are handled at pay/reject
   time by checking for the reserve debit entry.) */
export const requestWithdrawal = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const { amount, amountRupees: bodyAmountRupees, withdrawalAmount, amountPaise, clientIdempotencyKey } = req.body || {};
    const config = getConfig(); // Get config

    const rawRupees = bodyAmountRupees ?? amount ?? withdrawalAmount;
    let amountPaiseNum = null;

    if (amountPaise != null && amountPaise !== "" && Number.isFinite(Number(amountPaise))) {
      const p = Number(amountPaise);
      if (p > 0) amountPaiseNum = Math.round(p);
    } else if (rawRupees != null && rawRupees !== "" && Number.isFinite(Number(rawRupees))) {
      const r = Number(rawRupees);
      if (r > 0) amountPaiseNum = rupeesToPaise(r);
    }

    if (amountPaiseNum == null || amountPaiseNum <= 0) {
      return res.status(400).json({ success: false, message: "Invalid withdrawal amount provided" });
    }
    const amountRupees = paiseToRupees(amountPaiseNum);
    if (amountRupees < config.minWithdrawal) {
      return res.status(400).json({
        success: false,
        message: `Minimum withdrawal amount is ₹${config.minWithdrawal}`
      });
    }

    const maxWithdrawalRupees = toMoney(process.env.MAX_WITHDRAWAL_AMOUNT) || 50000;
    if (amountRupees > maxWithdrawalRupees) {
      return res.status(400).json({
        success: false,
        message: `Maximum withdrawal limit per request is ₹${maxWithdrawalRupees}`
      });
    }

    const tech = req.technician;
    if (tech.status === "blocked" || tech.workStatus === "blocked" || tech.workStatus === "suspended") {
      return res.status(403).json({ success: false, message: "Technician account is blocked or suspended from performing withdrawals" });
    }

    // 🏦 Bank Verification Withdrawal Guard — prevent withdrawal if bank account is unverified or under review
    const kycDoc = await TechnicianKyc.findOne({ technicianId: tech._id }).select("bankVerified bankVerificationStatus").lean();
    const isBankApproved = Boolean(
      kycDoc &&
      (kycDoc.bankVerified === true ||
       kycDoc.bankVerificationStatus === "approved" ||
       kycDoc.bankVerificationStatus === "VERIFIED")
    );
    if (!isBankApproved) {
      return res.status(403).json({
        success: false,
        message: "Withdrawal blocked: Your bank account details are unverified or under review. Please wait for Admin bank verification approval before requesting payouts.",
        result: {
          bankVerified: kycDoc?.bankVerified || false,
          bankVerificationStatus: kycDoc?.bankVerificationStatus || "pending"
        }
      });
    }

    // Idempotency check: return existing request if key already used
    if (clientIdempotencyKey) {
      const existingKey = await WithdrawalRequest.findOne({ clientIdempotencyKey, technicianId: tech._id }).lean();
      if (existingKey) {
        return res.status(200).json({
          success: true,
          message: "Withdrawal request already submitted (idempotent)",
          result: {
            withdrawalId: existingKey._id,
            status: existingKey.status,
            amount: existingKey.amount,
            amountPaise: existingKey.amountPaise,
            payoutMode: existingKey.payoutMode,
          },
        });
      }
    }

    // Resolve maintenance floor
    const autoConfig = await getAutoPayoutConfig();
    const payoutSettings = resolveTechPayoutSettings(tech, autoConfig);
    const maintenanceFloorPaise = payoutSettings.minimumMaintenancePaise || 10000;
    const availableBalancePaise = tech.availableBalancePaise ?? toPaise(tech.walletBalance ?? 0);
    const maxPayoutPaise = Math.max(0, availableBalancePaise - maintenanceFloorPaise);

    if (amountPaiseNum > maxPayoutPaise) {
      return res.status(400).json({
        success: false,
        message: `Requested amount ₹${amountRupees.toFixed(2)} exceeds maximum withdrawable balance of ₹${paiseToRupees(maxPayoutPaise).toFixed(2)}. Maintenance floor of ₹${paiseToRupees(maintenanceFloorPaise).toFixed(2)} must remain in wallet.`
      });
    }

    if ((tech.outstandingDuesPaise || 0) > 0) {
      return res.status(400).json({
        success: false,
        message: `Payout blocked: you have outstanding dues of ₹${paiseToRupees(tech.outstandingDuesPaise).toFixed(2)}. Dues are recovered automatically from future earnings before withdrawals.`
      });
    }

    if (await hasActivePayoutBlock(tech._id)) {
      return res.status(409).json({
        success: false,
        message: "Payout blocked: you have an active dispute or complaint on a booking. Please resolve open issues before requesting withdrawals."
      });
    }

    // Block any in-progress OR under-review payout.
    const inProgress = await WithdrawalRequest.findOne({
      technicianId: tech._id,
      status: {
        $in: ["pending", "requested", "approved", "processing", "manual_review"],
      },
    })
      .select("_id status")
      .lean();
    if (inProgress) {
      return res.status(409).json({
        success: false,
        message: "You already have a payout in progress or under review. Please wait for it to complete.",
        result: { withdrawalId: inProgress._id, status: inProgress.status },
      });
    }

    // Cooldown check (default 7 days)
    const lastPaid = await WithdrawalRequest.findOne({
      technicianId: tech._id,
      origin: "technician_request",
      status: { $in: ["paid", "approved"] },
    })
      .sort({ createdAt: -1 })
      .select("createdAt")
      .lean();
    if (lastPaid && config.cooldownMs > 0) {
      const elapsed = Date.now() - new Date(lastPaid.createdAt).getTime();
      if (elapsed < config.cooldownMs) {
        const daysLeft = Math.ceil((config.cooldownMs - elapsed) / (24 * 60 * 60 * 1000));
        return res.status(400).json({
          success: false,
          message: `Withdrawal cooldown active — retry in ${daysLeft} day(s)`,
        });
      }
    }

    let withdrawal;
    await session.withTransaction(async () => {
      // Re-check balance inside transaction
      const fresh = await TechnicianProfile.findById(tech._id).session(session);
      const freshAvailable = fresh.availableBalancePaise ?? toPaise(fresh.walletBalance ?? 0);
      const freshMaxPayout = Math.max(0, freshAvailable - maintenanceFloorPaise);
      if (amountPaiseNum > freshMaxPayout) {
        const err = new Error("Insufficient withdrawable balance (maintenance floor required)");
        err.statusCode = 400;
        throw err;
      }

      // Atomically move available → reserved
      await TechnicianProfile.updateOne(
        { _id: tech._id },
        {
          $inc: {
            availableBalancePaise: -amountPaiseNum,
            reservedBalancePaise: amountPaiseNum,
          },
        },
        { session }
      );

      // Create WithdrawalRequest in "processing" status
      withdrawal = await WithdrawalRequest.create(
        [
          {
            technicianId: tech._id,
            amount: amountRupees,
            amountPaise: amountPaiseNum,
            requestedAmountPaise: amountPaiseNum,
            netPayoutAmountPaise: amountPaiseNum,
            status: "processing",
            origin: "technician_request",
            requiresApproval: false,
            initiatedBy: { actorType: "technician", actorId: tech._id },
            clientIdempotencyKey: clientIdempotencyKey || null,
          },
        ],
        { session }
      );

      await WalletTransaction.create(
        [
          {
            technicianId: tech._id,
            amountPaise: amountPaiseNum,
            amount: amountRupees,
            type: "debit",
            source: "withdraw",
            withdrawalId: withdrawal[0]._id,
            idempotencyKey: `withdrawal:${withdrawal[0]._id}`,
            note: `Amount reserved for withdrawal request #${withdrawal[0]._id}`,
          },
        ],
        { session }
      );
    });

    await writeAuditLog({
      actor: req.user.userId,
      actorRole: req.user.role,
      action: "WITHDRAWAL_REQUESTED",
      targetType: "WithdrawalRequest",
      targetId: withdrawal[0]._id,
      after: { amountPaise: amountPaiseNum, status: "processing", origin: "technician_request", reserved: true },
    });

    // ── AUTOMATIC payout processing: single shared engine, no Admin approval ──
    const io = getIo();
    try {
      const payout = await executeWithdrawalPayout({
        withdrawalId: withdrawal[0]._id,
        actor: { userId: req.user.userId, role: req.user.role },
        narration: "RightTouch Technician Withdrawal",
        io,
      });

      return res.status(201).json({
        success: true,
        message: payout.message || "Withdrawal initiated successfully",
        result: {
          withdrawalId: withdrawal[0]._id,
          status: payout.withdrawalStatus || "processing",
          amount: payout.amount,
          amountPaise: payout.amountPaise,
          payoutId: payout.payoutId,
          mode: payout.mode,
          payoutDestination: payout.payoutDestination,
        },
      });
    } catch (payErr) {
      const w = await WithdrawalRequest.findById(withdrawal[0]._id).lean();
      if (w && w.status === "manual_review") {
        return res.status(202).json({
          success: false,
          message: "Payout outcome is being verified with your bank. We'll notify you shortly.",
          result: { withdrawalId: withdrawal[0]._id, status: "manual_review" },
        });
      }
      await releaseFailedWithdrawalReserve({
        withdrawalId: withdrawal[0]._id,
        amountPaise: amountPaiseNum,
        technicianId: tech._id,
        reason: payErr?.message,
      });
      return res.status(400).json({
        success: false,
        message: payErr?.message || "Payout failed. Your balance has been restored.",
        result: { withdrawalId: withdrawal[0]._id, status: "failed" },
      });
    }
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, message: error.message });
  } finally {
    session.endSession();
  }
};

//sk
/* MY WITHDRAWAL REQUESTS */
export const getMyWithdrawalRequests = async (req, res) => {
  // ensureTechnician(req); // Handled by middleware //sk

  //sk
  const data = await WithdrawalRequest.find({
    technicianId: req.technician._id //sk
  }).sort({ createdAt: -1 }); //sk
  res.json({ success: true, result: data });
};

/* ================= CANCEL MY WITHDRAW ================= */
export const cancelMyWithdrawal = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    // Role check handled by verifyRoles or isTechnician if applied //sk
    if (req.user?.role !== "Technician" || !req.technician) { //sk
      return res.status(403).json({
        success: false,
        message: "Technician access only" //sk
      });
    }

    const { id } = req.params;

    const withdrawal = await WithdrawalRequest.findOne({
      _id: id,
      technicianId: req.technician._id,
    });

    if (!withdrawal) {
      return res.status(404).json({
        success: false,
        message: "Withdrawal request not found"
      });
    }

    if (!["pending", "requested"].includes(withdrawal.status)) {
      return res.status(400).json({
        success: false,
        message: withdrawal.status === "processing"
          ? "Withdrawal is currently processing with RazorpayX and cannot be cancelled."
          : `Withdrawal request cannot be cancelled in status "${withdrawal.status}"`
      });
    }

    let refundedToWalletPaise = 0;
    const amountPaiseNum = toPaise(withdrawal.amountPaise ?? rupeesToPaise(withdrawal.amount));

    await session.withTransaction(async () => {
      withdrawal.status = "cancelled";
      withdrawal.rejectedAt = new Date();
      withdrawal.decidedAt = new Date();
      withdrawal.adminNote = "Cancelled by technician";
      await withdrawal.save({ session });

      // Refund the reserved amount (only if it was actually reserved)
      const reserveDebit = await WalletTransaction.findOne(
        { withdrawalId: withdrawal._id, type: "debit", source: "withdraw" },
        null,
        { session }
      );

      if (reserveDebit) {
        // Move reserved → available
        await TechnicianProfile.updateOne(
          { _id: withdrawal.technicianId },
          {
            $inc: {
              availableBalancePaise: amountPaiseNum,
              reservedBalancePaise: -amountPaiseNum,
            },
          },
          { session }
        );

        await WalletTransaction.create(
          [
            {
              technicianId: withdrawal.technicianId,
              amountPaise: amountPaiseNum,
              amount: paiseToRupees(amountPaiseNum),
              type: "credit",
              source: "adjustment",
              withdrawalId: withdrawal._id,
              idempotencyKey: `withdrawal-refund:${withdrawal._id}`,
              note: `Refund for cancelled withdrawal #${withdrawal._id}`,
            },
          ],
          { session }
        );
        refundedToWalletPaise = amountPaiseNum;
      }
    });

    await writeAuditLog({
      actor: req.user.userId,
      actorRole: req.user.role,
      action: "WITHDRAWAL_CANCELLED_BY_TECHNICIAN",
      targetType: "WithdrawalRequest",
      targetId: withdrawal._id,
      after: { status: "cancelled", refundedToWalletPaise },
    });

    return res.json({
      success: true,
      message: "Withdrawal request cancelled successfully",
      result: { refundedToWallet: paiseToRupees(refundedToWalletPaise), refundedToWalletPaise },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  } finally {
    session.endSession();
  }
};

/* GET WITHDRAWAL RECEIPT */
export const getWithdrawalReceipt = async (req, res) => {
  try {
    const { id } = req.params;
    const isTech = req.user?.role === "Technician";
    const isAdm = ["Admin", "SuperAdmin", "Owner"].includes(req.user?.role);

    if (!isTech && !isAdm) {
      return res.status(403).json({ success: false, message: "Unauthorized access" });
    }

    const query = { _id: id };
    if (isTech && req.technician) {
      query.technicianId = req.technician._id;
    }

    const withdrawal = await WithdrawalRequest.findOne(query)
      .populate({
        path: "technicianId",
        select: "userId bankDetails",
        populate: { path: "userId", select: "fname lname mobileNumber email" },
      })
      .lean();

    if (!withdrawal) {
      return res.status(404).json({ success: false, message: "Receipt not found for specified payout" });
    }

    const techUser = withdrawal.technicianId?.userId || {};
    const requestedPaise = withdrawal.requestedAmountPaise ?? withdrawal.amountPaise ?? rupeesToPaise(withdrawal.amount);
    const netPayoutPaise = withdrawal.netPayoutAmountPaise ?? requestedPaise;

    res.json({
      success: true,
      receipt: {
        receiptId: `RCP-${withdrawal._id.toString().slice(-8).toUpperCase()}`,
        issuer: "RightTouch Technologies Private Limited",
        withdrawalId: withdrawal._id,
        status: withdrawal.status,
        origin: withdrawal.origin,
        payoutMode: withdrawal.payoutMode || "UPI/IMPS",
        payoutDestination: withdrawal.payoutDestination || "Bank Account / UPI",
        payoutReference: withdrawal.payoutReference || null,
        utr: withdrawal.utr || null,
        financials: {
          requestedAmount: paiseToRupees(requestedPaise),
          requestedAmountPaise: requestedPaise,
          commissionDeduction: paiseToRupees(withdrawal.commissionDeductionPaise || 0),
          commissionDeductionPaise: withdrawal.commissionDeductionPaise || 0,
          penaltyDeduction: paiseToRupees(withdrawal.penaltyDeductionPaise || 0),
          penaltyDeductionPaise: withdrawal.penaltyDeductionPaise || 0,
          penaltyReason: withdrawal.penaltyReason || null,
          otherDeductions: paiseToRupees(withdrawal.otherDeductionsPaise || 0),
          otherDeductionsPaise: withdrawal.otherDeductionsPaise || 0,
          netPayoutAmount: paiseToRupees(netPayoutPaise),
          netPayoutAmountPaise: netPayoutPaise,
        },
        technician: {
          technicianId: withdrawal.technicianId?._id || withdrawal.technicianId,
          name: `${techUser.fname || ""} ${techUser.lname || ""}`.trim() || "Technician",
          mobileNumber: techUser.mobileNumber || null,
          email: techUser.email || null,
        },
        timestamps: {
          createdAt: withdrawal.createdAt,
          decidedAt: withdrawal.decidedAt,
          paidAt: withdrawal.paidAt,
          failedAt: withdrawal.failedAt,
        },
      },
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
};
