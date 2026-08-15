import mongoose from "mongoose";
import TechnicianProfile from "../Schemas/TechnicianProfile.js";
import WalletTransaction from "../Schemas/WalletTransaction.js";
import WithdrawalRequest from "../Schemas/WithdrawalRequest.js";
import ServiceBooking from "../Schemas/ServiceBooking.js";
import { writeAuditLog } from "../Utils/audit.js";
import { toPaise, rupeesToPaise, paiseToRupees } from "../Utils/money.js";

const isValidObjectId = mongoose.Types.ObjectId.isValid;

const toMoney = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const getConfig = () => {
  const envMinWithdrawal = toMoney(process.env.MIN_WITHDRAWAL_AMOUNT);
  const minWithdrawal =
    envMinWithdrawal != null && envMinWithdrawal > 0 ? envMinWithdrawal : 100;
  const cooldownDays = toMoney(process.env.WITHDRAWAL_COOLDOWN_DAYS) ?? 7;
  return {
    minWithdrawal,
    cooldownMs: Math.max(0, cooldownDays) * 24 * 60 * 60 * 1000,
  };
};


// Add Wallet Transaction (Owner only)
export const createWalletTransaction = async (req, res) => {
  try {
    const { technicianId, bookingId, amount, amountPaise, type, source } = req.body;

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
        // Re-check balance inside the txn for debits
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

    res.json({
      success: true,
      // Four explicit balances (paise) + legacy rupee mirrors
      availableBalancePaise: tech?.availableBalancePaise ?? toPaise(tech?.walletBalance ?? 0),
      reservedBalancePaise: tech?.reservedBalancePaise ?? 0,
      lifetimeEarnedPaise: tech?.lifetimeEarnedPaise ?? 0,
      lifetimeWithdrawnPaise: tech?.lifetimeWithdrawnPaise ?? 0,
      balance: paiseToRupees(tech?.availableBalancePaise ?? toPaise(tech?.walletBalance ?? 0)),
      walletBalance: paiseToRupees(tech?.availableBalancePaise ?? toPaise(tech?.walletBalance ?? 0)),
      totalEarnings,
      totalJobEarnings,
      totalTips,
      totalBonuses,
      stats
    });
  } catch (error) {
    console.error("Error in getTechnicianWallet:", error);
    res.status(500).json({ success: false, message: "Internal Server Error", error: error.message });
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
    const { amount, amountPaise } = req.body;
    const config = getConfig(); // Get config

    const amountPaiseNum = toPaise(amountPaise ?? rupeesToPaise(amount));
    if (amountPaiseNum == null || amountPaiseNum <= 0) {
      return res.status(400).json({ success: false, message: "Invalid amount" });
    }
    const amountRupees = paiseToRupees(amountPaiseNum);
    if (amountRupees < config.minWithdrawal) {
      return res.status(400).json({
        success: false,
        message: `Minimum withdrawal amount is ₹${config.minWithdrawal}`
      });
    }

    const tech = req.technician;
    if ((tech.availableBalancePaise ?? toPaise(tech.walletBalance ?? 0)) < amountPaiseNum) {
      return res.status(400).json({ success: false, message: "Insufficient balance" });
    }

    // Cooldown — one withdrawal per cooldown window (default 7 days)
    const lastPaid = await WithdrawalRequest.findOne({
      technicianId: tech._id,
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
      // Re-check balance inside the txn to prevent concurrent overspend
      const fresh = await TechnicianProfile.findById(tech._id).session(session);
      const freshAvailable = fresh.availableBalancePaise ?? toPaise(fresh.walletBalance ?? 0);
      if (freshAvailable < amountPaiseNum) {
        const err = new Error("Insufficient balance");
        err.statusCode = 400;
        throw err;
      }

      // Atomically move available → reserved. Reserved funds are NOT spendable.
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

      withdrawal = await WithdrawalRequest.create(
        [
          {
            technicianId: tech._id,
            amount: amountRupees,
            amountPaise: amountPaiseNum,
            status: "pending",
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
      after: { amountPaise: amountPaiseNum, status: "pending", reserved: true },
    });

    res.status(201).json({
      success: true,
      message: "Withdrawal request sent",
      result: {
        withdrawalId: withdrawal[0]._id,
        status: "pending",
        amount: paiseToRupees(amountPaiseNum),
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

    const withdrawal = await WithdrawalRequest.findOne({
      _id: id,
      technicianId: req.technician._id,
      status: { $in: ["pending", "requested"] }
    });

    if (!withdrawal) {
      return res.status(404).json({
        success: false,
        message: "Pending withdrawal request not found"
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
