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
import { hasActivePayoutBlock } from "../Utils/complaintFreeze.js";
import { getDekForKycDoc, decryptBankDetails } from "../Utils/kycFieldCrypto.js";
import { fingerprintBankDetails } from "../Utils/kycPrivacy.js";
import { SOCKET_ROOMS } from "../Utils/socketConstants.js";
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
    const kycDoc = await TechnicianKyc.findOne({ technicianId: tech._id })
      .select("bankVerified bankVerificationStatus bankDetails bankDetailsFingerprint encryptedDek")
      .lean();
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

    // 🔒 Fingerprint guard at request time (Stage 1 manual flow): the
    // verified bank details must still match exactly what the admin approved.
    // Unlike the old automated engine, this check NEVER mutates KYC here —
    // it only rejects so an admin re-verification can resolve the drift.
    try {
      const reqDek = await getDekForKycDoc(kycDoc);
      const reqBank = decryptBankDetails(kycDoc?.bankDetails, reqDek) || {};
      const reqHasBank = Boolean(reqBank.accountNumber && reqBank.ifscCode);
      const reqHasUpi = Boolean(reqBank.upiId);
      if (!reqHasBank && !reqHasUpi) {
        return res.status(422).json({
          success: false,
          message: "Withdrawal blocked: no bank/UPI details on file. Please update your bank details and wait for verification.",
        });
      }
      const reqCurrent = fingerprintBankDetails(reqBank);
      const reqStored = kycDoc?.bankDetailsFingerprint;
      if (!reqStored || !reqCurrent || reqStored !== reqCurrent) {
        return res.status(422).json({
          success: false,
          message: "Withdrawal blocked: your bank details changed since verification. Please ask Admin to re-verify them before requesting payouts.",
        });
      }
    } catch (fpErr) {
      return res.status(422).json({
        success: false,
        message: "Withdrawal blocked: bank details could not be verified right now. Please try again later.",
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
    try {
      await session.withTransaction(async () => {
        // Re-check withdrawable balance inside the transaction (the
        // pre-transaction read of req.technician may be stale).
        const fresh = await TechnicianProfile.findById(tech._id).session(session);
        if (!fresh) {
          const err = new Error("Technician profile not found");
          err.statusCode = 404;
          throw err;
        }
        const freshAvailable = fresh.availableBalancePaise ?? toPaise(fresh.walletBalance ?? 0);
        const freshMaxPayout = Math.max(0, freshAvailable - maintenanceFloorPaise);
        if (amountPaiseNum > freshMaxPayout) {
          const err = new Error("Insufficient withdrawable balance (maintenance floor required)");
          err.statusCode = 400;
          throw err;
        }

        // Atomically move available → reserved. The
        // availableBalancePaise >= N filter makes the debit conditional so
        // concurrent requests can never overspend; walletVersion bumps for
        // optimistic-concurrency consumers. A null return means the balance
        // moved under us — abort instead of creating an unfunded request.
        const moved = await TechnicianProfile.findOneAndUpdate(
          { _id: tech._id, availableBalancePaise: { $gte: amountPaiseNum } },
          [
            {
              $set: {
                availableBalancePaise: { $subtract: ["$availableBalancePaise", amountPaiseNum] },
                reservedBalancePaise: { $add: ["$reservedBalancePaise", amountPaiseNum] },
                walletVersion: { $add: [{ $ifNull: ["$walletVersion", 0] }, 1] },
              },
            },
          ],
          { session, new: true }
        );
        if (!moved) {
          const err = new Error("Insufficient withdrawable balance (maintenance floor required)");
          err.statusCode = 400;
          throw err;
        }

        // Stage 1 manual flow: requests park in "requested" for admin
        // approval + offline bank transfer. Nothing is sent to any provider
        // here (the old automated engine call is intentionally gone).
        withdrawal = await WithdrawalRequest.create(
          [
            {
              technicianId: tech._id,
              amount: amountRupees,
              amountPaise: amountPaiseNum,
              requestedAmountPaise: amountPaiseNum,
              netPayoutAmountPaise: amountPaiseNum,
              status: "requested",
              origin: "technician_request",
              requiresApproval: false,
              initiatedBy: { actorType: "technician", actorId: tech._id },
              // Omitted (undefined) when the client sent no key: with the
              // unique sparse index, an absent field is not indexed, while an
              // explicit null WOULD collide across keyless requests (E11000).
              clientIdempotencyKey: clientIdempotencyKey || undefined,
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
    } catch (txnErr) {
      // Concurrent double-submit: the uniq_active_payout_per_technician
      // partial index (or the clientIdempotencyKey unique index) rejected the
      // second insert. Report the live active request instead of a raw 11000.
      if (txnErr?.code === 11000) {
        const live = await WithdrawalRequest.findOne({
          technicianId: tech._id,
          status: { $in: ["pending", "requested", "approved", "processing", "manual_review"] },
        })
          .select("_id status amount amountPaise")
          .lean();
        if (live) {
          if (clientIdempotencyKey) {
            const sameKey = await WithdrawalRequest.findOne({
              clientIdempotencyKey,
              technicianId: tech._id,
            }).lean();
            if (sameKey && String(sameKey._id) === String(live._id)) {
              return res.status(200).json({
                success: true,
                message: "Withdrawal request already submitted (idempotent)",
                result: {
                  withdrawalId: sameKey._id,
                  status: sameKey.status,
                  amount: sameKey.amount,
                  amountPaise: sameKey.amountPaise,
                },
              });
            }
          }
          return res.status(409).json({
            success: false,
            message: "You already have a payout in progress or under review. Please wait for it to complete.",
            result: { withdrawalId: live._id, status: live.status },
          });
        }
      }
      throw txnErr;
    }

    await writeAuditLog({
      actor: req.user.userId,
      actorRole: req.user.role,
      action: "WITHDRAWAL_REQUESTED",
      targetType: "WithdrawalRequest",
      targetId: withdrawal[0]._id,
      after: { amountPaise: amountPaiseNum, status: "requested", origin: "technician_request", reserved: true },
    });

    // Notify admins of the new request (best-effort: must never break the
    // committed money flow).
    try {
      const io = getIo();
      io?.to(SOCKET_ROOMS.ADMIN_DASHBOARD).emit("withdrawal:requested", {
        withdrawalId: String(withdrawal[0]._id),
        technicianId: String(tech._id),
        amount: amountRupees,
        amountPaise: amountPaiseNum,
        status: "requested",
        timestamp: new Date().toISOString(),
      });
    } catch (notifyErr) {
      console.warn("[requestWithdrawal] admin notify failed:", notifyErr.message);
    }

    return res.status(201).json({
      success: true,
      message: "Withdrawal request submitted. Admin will review and transfer the amount to your verified bank account.",
      result: {
        withdrawalId: withdrawal[0]._id,
        status: "requested",
        amount: amountRupees,
        amountPaise: amountPaiseNum,
      },
    });
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

    let refundedToWalletPaise = 0;
    let cancelledId = null;

    await session.withTransaction(async () => {
      // Compare-and-set: only pending/requested can be cancelled. The status
      // filter makes concurrent double-clicks safe — exactly one wins.
      const updated = await WithdrawalRequest.findOneAndUpdate(
        {
          _id: id,
          technicianId: req.technician._id,
          status: { $in: ["pending", "requested"] },
        },
        {
          $set: {
            status: "cancelled",
            rejectedAt: new Date(),
            decidedAt: new Date(),
            adminNote: "Cancelled by technician",
          },
        },
        { session, new: true }
      );

      if (!updated) {
        const err = new Error("CANCEL_CAS_MISS");
        err.statusCode = 409;
        throw err;
      }
      cancelledId = updated._id;

      const amountPaiseNum = toPaise(updated.amountPaise ?? rupeesToPaise(updated.amount));

      // Refund the reserved amount (only if it was actually reserved —
      // legacy pre-reserve docs have no debit and must not double-credit).
      const reserveDebit = await WalletTransaction.findOne(
        { withdrawalId: updated._id, type: "debit", source: "withdraw" },
        null,
        { session }
      );

      if (reserveDebit && amountPaiseNum > 0) {
        // Move reserved → available, guarded so reserved never goes negative,
        // and bump walletVersion for optimistic-concurrency consumers.
        await TechnicianProfile.findOneAndUpdate(
          { _id: updated.technicianId, reservedBalancePaise: { $gte: amountPaiseNum } },
          [
            {
              $set: {
                availableBalancePaise: { $add: ["$availableBalancePaise", amountPaiseNum] },
                reservedBalancePaise: { $subtract: ["$reservedBalancePaise", amountPaiseNum] },
                walletVersion: { $add: [{ $ifNull: ["$walletVersion", 0] }, 1] },
              },
            },
          ],
          { session }
        );

        try {
          await WalletTransaction.create(
            [
              {
                technicianId: updated.technicianId,
                amountPaise: amountPaiseNum,
                amount: paiseToRupees(amountPaiseNum),
                type: "credit",
                source: "adjustment",
                withdrawalId: updated._id,
                idempotencyKey: `withdrawal-refund:${updated._id}`,
                note: `Refund for cancelled withdrawal #${updated._id}`,
              },
            ],
            { session }
          );
        } catch (creditErr) {
          // Replay-safe: a retried cancel reuses the same idempotency key.
          if (creditErr?.code !== 11000) throw creditErr;
        }
        refundedToWalletPaise = amountPaiseNum;
      }
    });

    await writeAuditLog({
      actor: req.user.userId,
      actorRole: req.user.role,
      action: "WITHDRAWAL_CANCELLED_BY_TECHNICIAN",
      targetType: "WithdrawalRequest",
      targetId: cancelledId,
      after: { status: "cancelled", refundedToWalletPaise },
    });

    return res.json({
      success: true,
      message: "Withdrawal request cancelled successfully",
      result: { refundedToWallet: paiseToRupees(refundedToWalletPaise), refundedToWalletPaise },
    });
  } catch (error) {
    if (error?.message === "CANCEL_CAS_MISS") {
      const current = await WithdrawalRequest.findOne({
        _id: req.params.id,
        technicianId: req.technician._id,
      })
        .select("status")
        .lean();
      if (!current) {
        return res.status(404).json({
          success: false,
          message: "Withdrawal request not found",
        });
      }
      return res.status(400).json({
        success: false,
        message:
          current.status === "processing" || current.status === "manual_review"
            ? "Withdrawal is currently being processed/verified and cannot be cancelled."
            : `Withdrawal request cannot be cancelled in status "${current.status}"`,
      });
    }
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
