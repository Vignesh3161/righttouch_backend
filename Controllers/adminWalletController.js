import mongoose from "mongoose";
import TechnicianProfile from "../Schemas/TechnicianProfile.js";
import TechnicianKyc from "../Schemas/TechnicianKYC.js";
import WithdrawalRequest from "../Schemas/WithdrawalRequest.js";
import WalletTransaction from "../Schemas/WalletTransaction.js";
import PayoutOutbox from "../Schemas/PayoutOutbox.js";
import Payment from "../Schemas/Payment.js";
import {
  createRazorpayContact,
  createFundAccount,
  createPayout,
} from "./razorpayXController.js";
import { writeAuditLog } from "../Utils/audit.js";
import { fingerprintBankDetails } from "../Utils/kycPrivacy.js";
import { getDekForKycDoc, decryptBankDetails } from "../Utils/kycFieldCrypto.js";
import { toPaise, rupeesToPaise, paiseToRupees } from "../Utils/money.js";
import { postPayoutLedgerEntry } from "../Utils/ledger.js";

const getStartOfDay = (date) => {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
};

const getEndOfDay = (date) => {
  const d = new Date(date);
  d.setHours(23, 59, 59, 999);
  return d;
};

const buildRangeFromQuery = (query = {}) => {
  const type = String(query.type || "").toLowerCase();
  const now = new Date();

  if (type === "day" && query.date) {
    const date = new Date(`${query.date}T00:00:00`);
    if (!Number.isNaN(date.getTime())) {
      return { type, start: getStartOfDay(date), end: getEndOfDay(date) };
    }
    return null;
  }

  if (type === "month" && query.month) {
    let year;
    let monthIndex;

    if (String(query.month).includes("-")) {
      const [y, m] = String(query.month).split("-");
      year = Number(y);
      monthIndex = Number(m) - 1;
    } else {
      year = Number(query.year || now.getFullYear());
      monthIndex = Number(query.month) - 1;
    }

    if (
      Number.isInteger(year) &&
      Number.isInteger(monthIndex) &&
      monthIndex >= 0 &&
      monthIndex <= 11
    ) {
      const start = new Date(year, monthIndex, 1, 0, 0, 0, 0);
      const end = new Date(year, monthIndex + 1, 0, 23, 59, 59, 999);
      return { type, start, end };
    }
    return null;
  }

  if (type === "year" && query.year) {
    const year = Number(query.year);
    if (Number.isInteger(year) && year > 0) {
      const start = new Date(year, 0, 1, 0, 0, 0, 0);
      const end = new Date(year, 11, 31, 23, 59, 59, 999);
      return { type, start, end };
    }
    return null;
  }

  return null;
};

/* 🔐 Admin only */
const ensureAdmin = (req) => {
  const role = req.user?.role;
  if (role !== "Admin" && role !== "Owner") {
    const err = new Error("Admin or Owner access only");
    err.statusCode = 403;
    throw err;
  }
};

/* WALLET SUMMARY */
export const getAdminWalletSummary = async (req, res) => {
  try {
    ensureAdmin(req);

    const filterRange = buildRangeFromQuery(req.query);
    const startToday = getStartOfDay(new Date());
    const endToday = getEndOfDay(new Date());

    // 🔒 Efficient: 3 aggregation queries (instead of 6+ full-collection scans).
    // One $facet pass computes all-time + today + optional range buckets.
    const paymentsBucket = (rangeMatch) => {
      const facet = {
        allTime: [
          { $group: {
              _id: null,
              collected: { $sum: "$totalAmount" },
              commission: { $sum: "$commissionAmount" },
              serviceAmount: { $sum: { $ifNull: ["$serviceAmount", "$baseAmount", 0] } },
              gst: { $sum: { $ifNull: ["$gstAmount", 0] } },
              tip: { $sum: { $ifNull: ["$tipAmount", 0] } },
              technicianPayable: { $sum: { $ifNull: ["$technicianAmount", 0] } },
          } },
        ],
        today: [
          { $match: { createdAt: { $gte: startToday, $lte: endToday } } },
          { $group: {
              _id: null,
              collected: { $sum: "$totalAmount" },
              commission: { $sum: "$commissionAmount" },
              serviceAmount: { $sum: { $ifNull: ["$serviceAmount", "$baseAmount", 0] } },
              gst: { $sum: { $ifNull: ["$gstAmount", 0] } },
              tip: { $sum: { $ifNull: ["$tipAmount", 0] } },
              technicianPayable: { $sum: { $ifNull: ["$technicianAmount", 0] } },
          } },
        ],
      };
      if (rangeMatch) {
        facet.range = [
          { $match: rangeMatch },
          { $group: {
              _id: null,
              collected: { $sum: "$totalAmount" },
              commission: { $sum: "$commissionAmount" },
              serviceAmount: { $sum: { $ifNull: ["$serviceAmount", "$baseAmount", 0] } },
              gst: { $sum: { $ifNull: ["$gstAmount", 0] } },
              tip: { $sum: { $ifNull: ["$tipAmount", 0] } },
              technicianPayable: { $sum: { $ifNull: ["$technicianAmount", 0] } },
          } },
        ];
      }
      return { $facet: facet };
    };

    const withdrawalBucket = (rangeMatch) => {
      const facet = {
        allTime: [{ $group: { _id: null, withdrawn: { $sum: "$amount" } } }],
        today: [
          { $match: { createdAt: { $gte: startToday, $lte: endToday } } },
          { $group: { _id: null, withdrawn: { $sum: "$amount" } } },
        ],
      };
      if (rangeMatch) {
        facet.range = [
          { $match: rangeMatch },
          { $group: { _id: null, withdrawn: { $sum: "$amount" } } },
        ];
      }
      return { $facet: facet };
    };

    const [paymentAgg, withdrawalAgg, statusCounts] = await Promise.all([
      Payment.aggregate([
        { $match: { status: "success" } },
        paymentsBucket(filterRange ? { createdAt: { $gte: filterRange.start, $lte: filterRange.end } } : null),
      ]),
      WithdrawalRequest.aggregate([
        { $match: { status: "paid" } },
        withdrawalBucket(filterRange ? { createdAt: { $gte: filterRange.start, $lte: filterRange.end } } : null),
      ]),
      WithdrawalRequest.aggregate([
        { $match: { status: { $in: ["pending", "requested", "approved", "rejected", "processing"] } } },
        { $group: { _id: "$status", sum: { $sum: "$amount" }, count: { $sum: 1 } } },
      ]),
    ]);

    const p = paymentAgg[0] || {};
    const w = withdrawalAgg[0] || {};
    const pick = (facet, key) => facet?.find((f) => f?._id === null)?.[key] || 0;
    const bucket = (facet, name) => (facet?.[name]?.[0] || {});

    const allTimeCollected = pick(p.allTime, "collected");
    const allTimeCommission = pick(p.allTime, "commission");
    const allTimeGst = pick(p.allTime, "gst");
    const allTimeTip = pick(p.allTime, "tip");
    const allTimeTechnicianPayable = pick(p.allTime, "technicianPayable");
    const allTimeWithdrawn = pick(w.allTime, "withdrawn");
    const todayCollected = pick(p.today, "collected");
    const todayCommission = pick(p.today, "commission");
    const todayWithdrawn = pick(w.today, "withdrawn");

    const rangeBucketP = p.range ? bucket(p, "range") : null;
    const rangeBucketW = w.range ? bucket(w, "range") : null;
    const totalCollected = rangeBucketP?.collected ?? allTimeCollected;
    const totalCommission = rangeBucketP?.commission ?? allTimeCommission;
    const totalGst = rangeBucketP?.gst ?? allTimeGst;
    const totalTip = rangeBucketP?.tip ?? allTimeTip;
    const totalTechnicianPayable = rangeBucketP?.technicianPayable ?? allTimeTechnicianPayable;
    const totalWithdrawn = rangeBucketW?.withdrawn ?? allTimeWithdrawn;

    const statusMap = new Map(statusCounts.map((s) => [s._id, s]));
    const sumOf = (...keys) => keys.reduce((acc, k) => acc + (statusMap.get(k)?.sum || 0), 0);
    const countOf = (...keys) => keys.reduce((acc, k) => acc + (statusMap.get(k)?.count || 0), 0);

    const totalPendingWithdrawals = sumOf("pending", "requested");
    const approvedWithdrawCount = countOf("approved");
    const rejectedWithdrawCount = countOf("rejected");
    const processingWithdrawCount = countOf("processing");

    res.json({
      success: true,
      result: {
        totalCollected: Math.round(totalCollected),
        totalCommission: Math.round(totalCommission),
        // 🧾 GST collected (separate liability — remitted to government)
        totalGst: Math.round(totalGst),
        // 💝 Tips collected (100% pass-through to technicians)
        totalTip: Math.round(totalTip),
        // 👨‍🔧 Amount owed to technicians (service net share + tips)
        totalPayableToTechnician: Math.round(totalTechnicianPayable),
        // Platform net revenue = commission (GST is a pass-through liability)
        platformRevenue: Math.round(totalCommission),
        // NOTE: platform cash available — does NOT include gateway fees or
        // settled-but-unpaid technician liabilities (those are reserved in
        // technician wallets at request time).
        availableBalance: Math.round(allTimeCollected - allTimeWithdrawn),
        totalWithdrawn: Math.round(totalWithdrawn),
        totalPendingWithdrawals: Math.round(totalPendingWithdrawals),
        approvedWithdrawCount,
        rejectedWithdrawCount,
        processingWithdrawCount,
        todayCollected: Math.round(todayCollected),
        todayCommission: Math.round(todayCommission),
        todayGst: Math.round(pick(p.today, "gst")),
        todayTip: Math.round(pick(p.today, "tip")),
        todayAvailableBalance: Math.round(todayCollected - todayWithdrawn),
        allTimeCollected: Math.round(allTimeCollected),
        allTimeCommission: Math.round(allTimeCommission),
        allTimeGst: Math.round(allTimeGst),
        allTimeTip: Math.round(allTimeTip),
        allTimePayableToTechnician: Math.round(allTimeTechnicianPayable),
        allTimeAvailableBalance: Math.round(allTimeCollected - allTimeWithdrawn),
        filter: filterRange
          ? {
              type: filterRange.type,
              from: filterRange.start,
              to: filterRange.end,
            }
          : null,
      },
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
};

/* ALL WITHDRAWALS (optional ?status= filter, paginated) */
export const getAllWithdrawalRequests = async (req, res) => {
  try {
    ensureAdmin(req);

    const filterRange = buildRangeFromQuery(req.query);
    const query = {};

    if (req.query.status && String(req.query.status).trim()) {
      query.status = String(req.query.status).trim();
    }
    if (filterRange) {
      query.createdAt = { $gte: filterRange.start, $lte: filterRange.end };
    }

    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit, 10) || 25, 100);
    const skip = (page - 1) * limit;

    const [data, total] = await Promise.all([
      WithdrawalRequest.find(query)
        .populate({
          path: "technicianId",
          select: "walletBalance",
          populate: { path: "userId", select: "fname lname mobileNumber" }
        })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      WithdrawalRequest.countDocuments(query),
    ]);

    res.json({
      success: true,
      result: data,
      total,
      page,
      totalPages: Math.ceil(total / limit) || 1,
      limit,
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
};

/**
 * @desc    Approve Withdrawal — status only, NO money movement.
 *          (Balance is reserved at request time; debited ledger entry exists.)
 */
export const approveWithdrawal = async (req, res) => {
  try {
    ensureAdmin(req);

    const withdrawal = await WithdrawalRequest.findById(req.params.id);
    if (!withdrawal || !["pending", "requested"].includes(withdrawal.status)) {
      return res.status(400).json({ success: false, message: "Invalid or non-pending request" });
    }

    const before = withdrawal.toObject();
    withdrawal.status = "approved";
    withdrawal.approvedAt = new Date();
    withdrawal.decidedAt = new Date();
    withdrawal.decidedBy = req.user.userId;
    withdrawal.adminNote = req.body.adminNote || "Approved by Admin";
    await withdrawal.save();

    await writeAuditLog({
      actor: req.user.userId,
      actorRole: req.user.role,
      action: "WITHDRAWAL_APPROVED",
      targetType: "WithdrawalRequest",
      targetId: withdrawal._id,
      before: { status: before.status },
      after: { status: "approved" },
      reason: req.body.adminNote || null,
    });

    res.json({ success: true, message: "Withdrawal approved successfully" });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
};

/**
 * @desc    Reject Withdrawal — refunds the reserved balance ONLY if a
 *          reserve debit ledger entry exists (protects legacy requests
 *          that never deducted at request time from double-crediting).
 */
export const rejectWithdrawal = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    ensureAdmin(req);

    const withdrawal = await WithdrawalRequest.findById(req.params.id);
    if (!withdrawal || !["pending", "requested", "approved"].includes(withdrawal.status)) {
      return res.status(400).json({ success: false, message: "Invalid or non-rejectable request (only pending/approved)" });
    }

    const before = withdrawal.toObject();
    let refundedToWalletPaise = 0;
    const amountPaiseNum = toPaise(withdrawal.amountPaise ?? rupeesToPaise(withdrawal.amount));

    await session.withTransaction(async () => {
      withdrawal.status = "rejected";
      withdrawal.rejectedAt = new Date();
      withdrawal.decidedAt = new Date();
      withdrawal.decidedBy = req.user.userId;
      withdrawal.adminNote = req.body.adminNote || "Rejected by Admin";
      await withdrawal.save({ session });

      const reserveDebit = await WalletTransaction.findOne(
        { withdrawalId: withdrawal._id, type: "debit", source: "withdraw" },
        null,
        { session }
      );

      if (reserveDebit) {
        // Move reserved → available (the reserve was deducted at request time)
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
              note: `Refund for rejected withdrawal #${withdrawal._id}`,
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
      action: "WITHDRAWAL_REJECTED",
      targetType: "WithdrawalRequest",
      targetId: withdrawal._id,
      before: { status: before.status },
      after: { status: "rejected", refundedToWalletPaise },
      reason: req.body.adminNote || null,
    });

    res.json({
      success: true,
      message: "Withdrawal rejected and balance refunded",
      result: { refundedToWallet: paiseToRupees(refundedToWalletPaise), refundedToWalletPaise },
    });
  } catch (error) {
    console.error("rejectWithdrawal Error:", error);
    res.status(error.statusCode || 500).json({ success: false, message: error.message });
  } finally {
    session.endSession();
  }
};

/**
 * @desc  Pay Withdrawal via Razorpay X — OUTBOX pattern.
 *
 *  1. [txn] Withdrawal → processing; PayoutOutbox → initiated (idempotencyKey = withdrawalId)
 *  2. Contact + Fund Account created/reused (cached on TechnicianProfile)
 *  3. Razorpay X POST /v1/payouts (X-Payout-Idempotency: withdrawalId)
 *  4. [txn] success → withdrawal paid, (legacy) debit ledger, outbox completed
 *          failure → withdrawal reverted to approved (retryable), outbox failed
 *
 *  Reconciliation cron reconciles stuck "initiated" entries against Razorpay.
 */
export const payWithdrawal = async (req, res) => {
  const session = await mongoose.startSession();
  let outboxId = null;
  try {
    ensureAdmin(req);

    /* ── 1. Load withdrawal ── */
    const withdrawal = await WithdrawalRequest.findById(req.params.id);
    if (!withdrawal) {
      return res.status(404).json({ success: false, message: "Withdrawal request not found" });
    }
    if (!["pending", "requested", "approved"].includes(withdrawal.status)) {
      return res.status(400).json({
        success: false,
        message: `Cannot pay a withdrawal with status "${withdrawal.status}"`,
      });
    }

    /* ── 2. Load technician profile + user ── */
    const techProfile = await TechnicianProfile.findById(withdrawal.technicianId).populate(
      "userId",
      "fname lname mobileNumber email"
    );
    if (!techProfile) {
      return res.status(404).json({ success: false, message: "Technician profile not found" });
    }

    const user = techProfile.userId;
    const technicianKyc = await TechnicianKyc.findOne({
      technicianId: withdrawal.technicianId,
    });

    // Payouts may only use KYC-tracked bank details. The legacy
    // techProfile.bankDetails field is NOT a valid payout source —
    // it was never subject to the verification workflow.
    // KYC bank fields are encrypted at rest — decrypt in memory for the
    // fingerprint guard and the Razorpay fund-account creation.
    const dek = await getDekForKycDoc(technicianKyc);
    const bankDetails = decryptBankDetails(technicianKyc?.bankDetails, dek) || {};
    const hasBank = bankDetails.accountNumber && bankDetails.ifscCode;
    const hasUpi = !!bankDetails.upiId;

    if (!hasBank && !hasUpi) {
      return res.status(422).json({
        success: false,
        message: "No bank/UPI on file for technician. Update bankDetails in TechnicianKYC before paying.",
      });
    }

    /* ── 3. KYC gate: verified bank/UPI required before payout ── */
    const bankVerified =
      technicianKyc?.bankVerified === true ||
      technicianKyc?.bankVerificationStatus === "approved";
    if (!bankVerified) {
      return res.status(422).json({
        success: false,
        message: "Technician bank/UPI details are not verified. Verify them before paying.",
      });
    }

    // Fingerprint guard: verification is tied to the EXACT details that were
    // approved. If they drifted (updated outside the KYC flow, legacy records,
    // tampering), invalidate the approval and block the payout until the
    // account is re-verified by an admin.
    const currentFingerprint = fingerprintBankDetails(bankDetails);
    const storedFingerprint = technicianKyc?.bankDetailsFingerprint;
    if (!storedFingerprint || !currentFingerprint || storedFingerprint !== currentFingerprint) {
      await TechnicianKyc.updateOne(
        { technicianId: withdrawal.technicianId },
        {
          $set: {
            bankVerified: false,
            bankVerificationStatus: "pending",
            bankUpdateRequired: true,
            bankDetailsFingerprint: null,
          },
        }
      );
      return res.status(422).json({
        success: false,
        message: "Bank details changed since verification (or legacy record without fingerprint). Please re-verify the technician's bank details before paying.",
      });
    }

    /* ── 4. Outbox init [txn] ── */
    let outbox;
    await session.withTransaction(async () => {
      const fresh = await WithdrawalRequest.findById(withdrawal._id).session(session);
      if (!["pending", "requested", "approved"].includes(fresh.status)) {
        const err = new Error(`Withdrawal is no longer payable (status: ${fresh.status})`);
        err.statusCode = 409;
        throw err;
      }

      fresh.status = "processing";
      fresh.decidedAt = new Date();
      fresh.decidedBy = req.user.userId;
      await fresh.save({ session });

      outbox = await PayoutOutbox.findOneAndUpdate(
        { withdrawalId: withdrawal._id },
        {
          $set: {
            status: "initiated",
            initiatedAt: new Date(),
            completedAt: null,
            failedAt: null,
            lastError: null,
          },
          $inc: { attempts: 1 },
        },
        { upsert: true, new: true, session }
      );

      fresh.payoutOutboxId = outbox._id;
      await fresh.save({ session });
      outboxId = String(outbox._id);
    });

    /* ── 5. Get or create Razorpay Contact ── */
    let contactId = techProfile.razorpayContactId;
    if (!contactId) {
      contactId = await createRazorpayContact({
        name: user ? `${user.fname || ""} ${user.lname || ""}`.trim() : "Technician",
        email: user?.email || undefined,
        contact: user?.mobileNumber || undefined,
        referenceId: String(techProfile._id),
      });
      techProfile.razorpayContactId = contactId;
      await techProfile.save();
    }

    /* ── 6. Get or create Razorpay Fund Account ── */
    let fundAccountId = techProfile.razorpayFundAccountId;
    if (!fundAccountId) {
      fundAccountId = await createFundAccount({ contactId, bankDetails });
      techProfile.razorpayFundAccountId = fundAccountId;
      await techProfile.save();
    }

    /* ── 7. Determine payout mode ── */
    const payoutMode = hasUpi ? "UPI" : "IMPS";

    /* ── 8. Initiate Razorpay X Payout (idempotent) ── */
    const amountPaiseNum = toPaise(withdrawal.amountPaise ?? rupeesToPaise(withdrawal.amount));
    const rzpPayout = await createPayout({
      fundAccountId,
      amountInPaisa: amountPaiseNum,
      mode: payoutMode,
      referenceId: String(withdrawal._id),
      narration: req.body.narration || "RightTouch Technician Payout",
    });

    /* ── 9. Complete [txn]: paid + reserve release + ledger + outbox ── */
    await session.withTransaction(async () => {
      const fresh = await WithdrawalRequest.findById(withdrawal._id).session(session);
      fresh.status = "paid";
      fresh.paidAt = new Date();
      fresh.decidedAt = new Date();
      fresh.decidedBy = req.user.userId;
      fresh.payoutProvider = "razorpay_x";
      fresh.payoutReference = rzpPayout.id;
      fresh.adminNote = req.body.adminNote || `Paid via Razorpay X (${payoutMode})`;
      await fresh.save({ session });

      // Legacy/edge: if the reserve debit was never recorded
      // (pre-reserve-model requests), deduct + record it now.
      const reserveDebit = await WalletTransaction.findOne(
        { withdrawalId: fresh._id, type: "debit", source: "withdraw" },
        null,
        { session }
      );
      if (!reserveDebit) {
        await TechnicianProfile.updateOne(
          { _id: fresh.technicianId },
          { $inc: { availableBalancePaise: -amountPaiseNum } },
          { session }
        );
        await WalletTransaction.create(
          [
            {
              technicianId: fresh.technicianId,
              amountPaise: amountPaiseNum,
              amount: paiseToRupees(amountPaiseNum),
              type: "debit",
              source: "withdraw",
              withdrawalId: fresh._id,
              idempotencyKey: `withdrawal:${fresh._id}`,
              note: `Razorpay X payout ${rzpPayout.id} (${payoutMode}) – withdrawal #${fresh._id}`,
            },
          ],
          { session }
        );
      }

      // Release the reserve + record lifetime withdrawn (reserve model)
      await TechnicianProfile.updateOne(
        { _id: fresh.technicianId },
        {
          $inc: {
            reservedBalancePaise: -amountPaiseNum,
            lifetimeWithdrawnPaise: amountPaiseNum,
          },
        },
        { session }
      );

      // 🏦 Platform ledger — real money left the platform
      const ledger = await postPayoutLedgerEntry({
        withdrawal: fresh,
        providerReference: rzpPayout.id,
        session,
      });
      if (!ledger.created) {
        console.warn(`[Payout] ledger entry already posted for withdrawal ${fresh._id}`);
      }

      outbox.status = "completed";
      outbox.razorpayPayoutId = rzpPayout.id;
      outbox.payoutPayload = { mode: payoutMode, razorpayStatus: rzpPayout.status, ledgerKey: ledger.entry?.idempotencyKey };
      outbox.completedAt = new Date();
      await outbox.save({ session });
    });

    await writeAuditLog({
      actor: req.user.userId,
      actorRole: req.user.role,
      action: "PAYOUT_EXECUTED",
      targetType: "WithdrawalRequest",
      targetId: withdrawal._id,
      after: {
        amountPaise: amountPaiseNum,
        payoutId: rzpPayout.id,
        mode: payoutMode,
        status: "paid",
      },
      reason: req.body.adminNote || null,
    });

    return res.json({
      success: true,
      message: "Payout initiated successfully",
      result: {
        payoutId: rzpPayout.id,
        payoutStatus: rzpPayout.status,
        mode: payoutMode,
        amount: withdrawal.amount,
        withdrawalStatus: "paid",
      },
    });
  } catch (error) {
    console.error("payWithdrawal Error:", error);

    // Mark outbox + withdrawal failed so the admin can retry (approved).
    // IMPORTANT: the outbox stays "initiated" (NOT "failed") — if the payout
    // actually succeeded at Razorpay before the response was lost, the
    // reconciliation cron must still reconcile it (retry with the same
    // reference id also returns the original payout). A "failed" status here
    // would orphan a potentially-sent payout, risking a DOUBLE payout.
    //
    // Ambiguous outcomes (timeouts/network errors) go to MANUAL_REVIEW — we
    // never retry blindly without knowing the provider status.
    const errMsg = String(error?.message || error?.error?.description || "");
    const ambiguous =
      /timeout|ETIMEDOUT|ECONNRESET|socket|network|ECONNREFUSED|EAI_AGAIN/i.test(errMsg);

    if (outboxId || withdrawal?._id) {
      const session2 = await mongoose.startSession();
      try {
        await session2.withTransaction(async () => {
          const outboxDoc = outboxId
            ? await PayoutOutbox.findById(outboxId).session(session2)
            : await PayoutOutbox.findOne({ withdrawalId: withdrawal._id }).session(session2);

          if (outboxDoc && outboxDoc.status === "initiated") {
            outboxDoc.lastError = errMsg || "Payout failed";
            outboxDoc.failedAt = new Date(); // informational; status stays initiated for reconcile
            if (ambiguous) outboxDoc.status = "manual_review";
            await outboxDoc.save({ session2 });
          }

          const w = await WithdrawalRequest.findById(withdrawal._id).session(session2);
          if (w && w.status === "processing") {
            w.status = ambiguous ? "manual_review" : "approved"; // retryable only when failure is certain
            w.decisionNote = `Payout ${ambiguous ? "outcome unknown" : "failed"}: ${errMsg || "unknown"}`;
            w.failedAt = new Date();
            await w.save({ session2 });
          }
        });

        await writeAuditLog({
          actor: req.user.userId,
          actorRole: req.user.role,
          action: "PAYOUT_FAILED",
          targetType: "WithdrawalRequest",
          targetId: withdrawal._id,
          after: { status: ambiguous ? "manual_review" : "approved", error: errMsg || "unknown", ambiguous },
          reason: ambiguous
            ? "Payout outcome unknown (timeout/network) — manual review required before retry"
            : "Payout failed; withdrawal reverted to approved for retry",
        });
      } catch (auditErr) {
        console.error("payWithdrawal revert error:", auditErr.message);
      } finally {
        await session2.endSession();
      }
    }

    const message =
      error?.error?.description || error?.message || "Payout failed";
    return res.status(error.statusCode || 500).json({ success: false, message });
  } finally {
    session.endSession();
  }
};
