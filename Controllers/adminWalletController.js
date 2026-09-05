import mongoose from "mongoose";
import TechnicianProfile from "../Schemas/TechnicianProfile.js";
import WithdrawalRequest from "../Schemas/WithdrawalRequest.js";
import WalletTransaction from "../Schemas/WalletTransaction.js";
import Payment from "../Schemas/Payment.js";
import { writeAuditLog } from "../Utils/audit.js";
import { toPaise, rupeesToPaise, paiseToRupees } from "../Utils/money.js";
import { getIo } from "../Utils/ioAccess.js";
import { executeWithdrawalPayout, releaseFailedWithdrawalReserve } from "../Utils/withdrawalPayoutEngine.js";
import {
  getAutoPayoutConfig,
  setAutoPayoutConfig,
} from "../Utils/autoPayout.js";
import PayoutOutbox from "../Schemas/PayoutOutbox.js";
import AuditLog from "../Schemas/AuditLog.js";
import GlobalSetting from "../Schemas/GlobalSetting.js";
import { adminResolveManualReview } from "../Utils/paymentCrons.js";
import { hasActivePayoutBlock } from "../Utils/complaintFreeze.js";

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
  const type = String(query.type || query.period || query.preset || "").toLowerCase();
  const now = new Date();

  // Presets
  if (["today"].includes(type)) {
    return { type: "today", start: getStartOfDay(now), end: getEndOfDay(now) };
  }

  if (["yesterday"].includes(type)) {
    const y = new Date(now);
    y.setDate(y.getDate() - 1);
    return { type: "yesterday", start: getStartOfDay(y), end: getEndOfDay(y) };
  }

  if (["last7days", "last_7_days", "last7"].includes(type)) {
    const s = new Date(now);
    s.setDate(s.getDate() - 7);
    return { type: "last7days", start: getStartOfDay(s), end: getEndOfDay(now) };
  }

  if (["last30days", "last_30_days", "last30"].includes(type)) {
    const s = new Date(now);
    s.setDate(s.getDate() - 30);
    return { type: "last30days", start: getStartOfDay(s), end: getEndOfDay(now) };
  }

  if (["thismonth", "this_month"].includes(type)) {
    const start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    const end = getEndOfDay(now);
    return { type: "thisMonth", start, end };
  }

  if (["lastmonth", "last_month"].includes(type)) {
    const start = new Date(now.getFullYear(), now.getMonth() - 1, 1, 0, 0, 0, 0);
    const end = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
    return { type: "lastMonth", start, end };
  }

  if (query.startDate || query.endDate || type === "custom") {
    const s = query.startDate ? new Date(query.startDate) : null;
    const e = query.endDate ? new Date(query.endDate) : null;

    if (s && Number.isNaN(s.getTime())) {
      const err = new Error("Invalid startDate format");
      err.statusCode = 400;
      throw err;
    }

    if (e && Number.isNaN(e.getTime())) {
      const err = new Error("Invalid endDate format");
      err.statusCode = 400;
      throw err;
    }

    if (s && e && s > e) {
      const err = new Error("startDate cannot be after endDate");
      err.statusCode = 400;
      throw err;
    }

    const start = s ? getStartOfDay(s) : new Date(0);
    const end = e ? getEndOfDay(e) : getEndOfDay(now);
    return { type: "custom", start, end };
  }

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

    const [paymentAgg, withdrawalAgg, statusCounts, walletAgg, originAgg, todayAgg] =
      await Promise.all([
        Payment.aggregate([
          { $match: { status: "success" } },
          paymentsBucket(filterRange ? { createdAt: { $gte: filterRange.start, $lte: filterRange.end } } : null),
        ]),
        WithdrawalRequest.aggregate([
          { $match: { status: "paid" } },
          withdrawalBucket(filterRange ? { createdAt: { $gte: filterRange.start, $lte: filterRange.end } } : null),
        ]),
        // All-status counts + sums → dashboard status buckets
        WithdrawalRequest.aggregate([
          { $group: { _id: "$status", sum: { $sum: "$amount" }, count: { $sum: 1 } } },
        ]),
        // Total technician wallet balance (available + reserved)
        TechnicianProfile.aggregate([
          {
            $group: {
              _id: null,
              available: { $sum: "$availableBalancePaise" },
              reserved: { $sum: "$reservedBalancePaise" },
            },
          },
        ]),
        // Paid payouts split by origin (automatic vs manual admin send)
        WithdrawalRequest.aggregate([
          { $match: { status: "paid" } },
          { $group: { _id: "$origin", sum: { $sum: "$amount" }, count: { $sum: 1 } } },
        ]),
        // Today's withdrawals (any status) — for "Today's Withdrawals"
        WithdrawalRequest.aggregate([
          { $match: { createdAt: { $gte: startToday, $lte: endToday } } },
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

    // ── Withdrawal status buckets ──
    const statusMap = new Map(statusCounts.map((s) => [s._id, s]));
    const sumOf = (...keys) => keys.reduce((acc, k) => acc + (statusMap.get(k)?.sum || 0), 0);
    const countOf = (...keys) => keys.reduce((acc, k) => acc + (statusMap.get(k)?.count || 0), 0);

    const allStatusRows = [...statusMap.values()];
    const totalWithdrawalCount = allStatusRows.reduce((a, v) => a + v.count, 0);
    const totalWithdrawalAmount = allStatusRows.reduce((a, v) => a + v.sum, 0);

    // ── Today's withdrawals by status ──
    const todayMap = new Map(todayAgg.map((t) => [t._id, t]));
    const todayCount = [...todayMap.values()].reduce((a, v) => a + v.count, 0);
    const todayPaid = todayMap.get("paid") || { sum: 0, count: 0 };

    // ── Origin split (automatic vs manual admin send) ──
    const originMap = new Map(originAgg.map((o) => [o._id, o]));
    const autoOrigin = originMap.get("auto") || { sum: 0, count: 0 };
    const techReqOrigin = originMap.get("technician_request") || { sum: 0, count: 0 };
    const adminDirectOrigin = originMap.get("admin_direct") || { sum: 0, count: 0 };
    const automaticWithdrawals = {
      count: autoOrigin.count + techReqOrigin.count,
      amount: Math.round(autoOrigin.sum + techReqOrigin.sum),
    };
    const manualWithdrawals = {
      count: adminDirectOrigin.count,
      amount: Math.round(adminDirectOrigin.sum),
    };

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
        availableBalance: Math.round(allTimeCollected - allTimeWithdrawn),

        /* ── Technician wallet + withdrawal monitoring (spec §8/§9) ── */
        totalTechnicianWalletBalance: Math.round(walletAgg[0]?.available || 0),
        totalReservedBalance: Math.round(walletAgg[0]?.reserved || 0),
        totalWithdrawals: totalWithdrawalCount,
        totalWithdrawalsAmount: Math.round(totalWithdrawalAmount),
        totalAmountPaid: Math.round(sumOf("paid")),
        todayWithdrawals: { count: todayCount, paidAmount: Math.round(todayPaid.sum) },
        processingWithdrawals: {
          count: countOf("processing"),
          amount: Math.round(sumOf("processing")),
        },
        successfulWithdrawals: {
          count: countOf("paid"),
          amount: Math.round(sumOf("paid")),
        },
        failedWithdrawals: {
          count: countOf("failed"),
          amount: Math.round(sumOf("failed")),
        },
        manualReviewWithdrawals: {
          count: countOf("manual_review"),
          amount: Math.round(sumOf("manual_review")),
        },
        pendingWithdrawals: {
          count: countOf("pending", "requested"),
          amount: Math.round(sumOf("pending", "requested")),
        },
        automaticWithdrawals,
        manualWithdrawals,

        // (kept for backwards-compatible dashboard widgets)
        totalWithdrawn: Math.round(totalWithdrawn),
        totalPendingWithdrawals: Math.round(sumOf("pending", "requested")),
        approvedWithdrawCount: countOf("approved"),
        rejectedWithdrawCount: countOf("rejected"),
        processingWithdrawCount: countOf("processing"),
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

const buildWithdrawalFilterQuery = (queryObj) => {
  const query = {};

  if (queryObj.status && String(queryObj.status).trim()) {
    query.status = String(queryObj.status).trim();
  }

  const payoutType = queryObj.payoutType || queryObj.type || queryObj.origin;
  if (payoutType && ["manual", "automatic", "auto", "technician_request", "admin_direct"].includes(String(payoutType))) {
    const pt = String(payoutType);
    if (pt === "manual" || pt === "admin_direct") {
      query.origin = "admin_direct";
    } else if (pt === "technician_request") {
      query.origin = "technician_request";
    } else {
      query.origin = { $in: ["technician_request", "auto"] };
    }
  }

  if (queryObj.payoutMode && String(queryObj.payoutMode).trim()) {
    query.payoutMode = String(queryObj.payoutMode).trim().toUpperCase();
  }

  if (queryObj.technicianId && mongoose.isValidObjectId(queryObj.technicianId)) {
    query.technicianId = queryObj.technicianId;
  }

  const minAmount = Number(queryObj.minAmount);
  const maxAmount = Number(queryObj.maxAmount);
  if (Number.isFinite(minAmount) && Number.isFinite(maxAmount) && minAmount > maxAmount) {
    const err = new Error("minAmount cannot be greater than maxAmount");
    err.statusCode = 400;
    throw err;
  }

  if (Number.isFinite(minAmount) && minAmount > 0) {
    query.amount = { ...(query.amount || {}), $gte: minAmount };
  }
  if (Number.isFinite(maxAmount) && maxAmount > 0) {
    query.amount = { ...(query.amount || {}), $lte: maxAmount };
  }

  if (queryObj.destination && String(queryObj.destination).trim()) {
    query.payoutDestination = {
      $regex: String(queryObj.destination).trim(),
      $options: "i",
    };
  }

  if (queryObj.utr && String(queryObj.utr).trim()) {
    query.utr = {
      $regex: String(queryObj.utr).trim(),
      $options: "i",
    };
  }

  if (queryObj.withdrawalId && String(queryObj.withdrawalId).trim()) {
    const idv = String(queryObj.withdrawalId).trim();
    if (mongoose.isValidObjectId(idv)) {
      query._id = idv;
    } else {
      query.payoutReference = idv;
    }
  }

  const filterRange = buildRangeFromQuery(queryObj);
  if (filterRange) {
    const dateField = ["createdAt", "decidedAt", "paidAt", "failedAt"].includes(queryObj.dateField)
      ? queryObj.dateField
      : "createdAt";
    query[dateField] = { $gte: filterRange.start, $lte: filterRange.end };
  }

  return query;
};

/* ALL WITHDRAWALS (optional ?status= filter, paginated) */
export const getAllWithdrawalRequests = async (req, res) => {
  try {
    ensureAdmin(req);
    const query = buildWithdrawalFilterQuery(req.query);

    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit, 10) || 25, 100);
    const skip = (page - 1) * limit;

    const [data, total] = await Promise.all([
      WithdrawalRequest.find(query)
        .populate({
          path: "technicianId",
          select: "walletBalance availableBalancePaise bankDetails decryptedBankDetails kycDetails isBankVerified status workStatus bankName accountNumber accountHolderName ifscCode branchName upiId payoutBlocked payoutBlockedReason",
          populate: { path: "userId", select: "fname lname mobileNumber email" }
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

/* EXPORT WITHDRAWAL REQUESTS (CSV) */
export const exportWithdrawalRequests = async (req, res) => {
  try {
    ensureAdmin(req);
    const query = buildWithdrawalFilterQuery(req.query);

    const withdrawals = await WithdrawalRequest.find(query)
      .populate({
        path: "technicianId",
        select: "userId bankDetails",
        populate: { path: "userId", select: "fname lname mobileNumber email" },
      })
      .sort({ createdAt: -1 })
      .limit(5000)
      .lean();

    const headers = [
      "Withdrawal ID",
      "Technician Name",
      "Technician Phone",
      "Technician Email",
      "Requested Amount (INR)",
      "Net Payout Amount (INR)",
      "Commission Deduction (INR)",
      "Penalty Deduction (INR)",
      "Penalty Reason",
      "Status",
      "Origin",
      "Payout Mode",
      "Payout Destination",
      "Razorpay Payout ID",
      "UTR",
      "Requested Date",
      "Paid Date",
    ];

    const rows = withdrawals.map((w) => {
      const user = w.technicianId?.userId || {};
      const requestedPaise = w.requestedAmountPaise ?? w.amountPaise ?? rupeesToPaise(w.amount);
      const netPaise = w.netPayoutAmountPaise ?? requestedPaise;

      return [
        String(w._id),
        `"${(`${user.fname || ""} ${user.lname || ""}`).trim() || "N/A"}"`,
        `"${user.mobileNumber || "N/A"}"`,
        `"${user.email || "N/A"}"`,
        paiseToRupees(requestedPaise).toFixed(2),
        paiseToRupees(netPaise).toFixed(2),
        paiseToRupees(w.commissionDeductionPaise || 0).toFixed(2),
        paiseToRupees(w.penaltyDeductionPaise || 0).toFixed(2),
        `"${w.penaltyReason || "N/A"}"`,
        w.status,
        w.origin,
        w.payoutMode || "N/A",
        `"${w.payoutDestination || "N/A"}"`,
        w.payoutReference || "N/A",
        w.utr || "N/A",
        w.createdAt ? new Date(w.createdAt).toISOString() : "N/A",
        w.paidAt ? new Date(w.paidAt).toISOString() : "N/A",
      ].join(",");
    });

    const csvContent = [headers.join(","), ...rows].join("\n");
    const filename = `RightTouch_Payouts_${new Date().toISOString().slice(0, 10)}.csv`;

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    return res.status(200).send(csvContent);
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
    if (!withdrawal) {
      return res.status(404).json({ success: false, message: "Withdrawal request not found" });
    }

    if (withdrawal.origin === "technician_request") {
      return res.status(400).json({
        success: false,
        message: "Admin approval is not allowed or required for technician withdrawal requests. Technician payouts are processed automatically.",
      });
    }

    if (!["pending", "requested"].includes(withdrawal.status)) {
      return res.status(400).json({ success: false, message: "Invalid or non-pending request" });
    }

    const {
      penaltyAmount,
      penaltyPaise,
      penaltyReason,
      commissionAmount,
      commissionPaise,
      otherDeductions,
      otherDeductionsPaise,
      adminNote,
    } = req.body || {};

    const requestedAmountPaise = toPaise(
      withdrawal.requestedAmountPaise ?? withdrawal.amountPaise ?? rupeesToPaise(withdrawal.amount)
    );

    const pPaise = penaltyPaise != null ? toPaise(penaltyPaise) : (penaltyAmount != null ? rupeesToPaise(penaltyAmount) : 0);
    const cPaise = commissionPaise != null ? toPaise(commissionPaise) : (commissionAmount != null ? rupeesToPaise(commissionAmount) : 0);
    const oPaise = otherDeductionsPaise != null ? toPaise(otherDeductionsPaise) : (otherDeductions != null ? rupeesToPaise(otherDeductions) : 0);

    if (pPaise > 0 && (!penaltyReason || !String(penaltyReason).trim())) {
      return res.status(400).json({
        success: false,
        message: "Penalty reason is required when applying a penalty reduction.",
      });
    }

    if (pPaise + cPaise + oPaise > requestedAmountPaise) {
      return res.status(400).json({
        success: false,
        message: "Total deductions cannot exceed requested withdrawal amount.",
      });
    }

    const netPaise = Math.max(0, requestedAmountPaise - pPaise - cPaise - oPaise);

    const before = withdrawal.toObject();
    withdrawal.status = "approved";
    withdrawal.approvedAt = new Date();
    withdrawal.decidedAt = new Date();
    withdrawal.decidedBy = req.user.userId;
    withdrawal.adminNote = adminNote || "Approved by Admin";
    withdrawal.requestedAmountPaise = requestedAmountPaise;
    withdrawal.penaltyDeductionPaise = pPaise;
    withdrawal.penaltyReason = penaltyReason ? String(penaltyReason).trim() : null;
    withdrawal.commissionDeductionPaise = cPaise;
    withdrawal.otherDeductionsPaise = oPaise;
    withdrawal.netPayoutAmountPaise = netPaise;
    await withdrawal.save();

    await writeAuditLog({
      actor: req.user.userId,
      actorRole: req.user.role,
      action: "WITHDRAWAL_APPROVED",
      targetType: "WithdrawalRequest",
      targetId: withdrawal._id,
      before: { status: before.status },
      after: {
        status: "approved",
        requestedAmountPaise,
        penaltyDeductionPaise: pPaise,
        penaltyReason,
        commissionDeductionPaise: cPaise,
        netPayoutAmountPaise: netPaise,
      },
      reason: adminNote || null,
    });

    res.json({
      success: true,
      message: "Withdrawal approved successfully",
      result: {
        withdrawalId: withdrawal._id,
        requestedAmount: paiseToRupees(requestedAmountPaise),
        penaltyDeduction: paiseToRupees(pPaise),
        penaltyReason: withdrawal.penaltyReason,
        commissionDeduction: paiseToRupees(cPaise),
        netPayoutAmount: paiseToRupees(netPaise),
      },
    });
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
    if (!withdrawal) {
      return res.status(404).json({ success: false, message: "Withdrawal request not found" });
    }

    if (withdrawal.status === "processing") {
      return res.status(400).json({
        success: false,
        message: "Withdrawal is processing with RazorpayX and cannot be manually rejected.",
      });
    }

    if (!["pending", "requested", "approved"].includes(withdrawal.status)) {
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
 *        Thin HTTP wrapper over the shared payout engine
 *        (Utils/withdrawalPayoutEngine.js), which both admin-initiated
 *        and auto-payouts run through:
 *          1. [txn] Withdrawal → processing; PayoutOutbox → initiated (idempotencyKey = withdrawalId)
 *          2. Contact + Fund Account created/reused (cached on TechnicianProfile)
 *          3. Razorpay X POST /v1/payouts (X-Payout-Idempotency: withdrawalId)
 *          4. [txn] success → withdrawal paid, (legacy) debit ledger, outbox completed
 *                  failure → withdrawal reverted to approved (retryable), outbox failed
 *
 *        Reconciliation cron reconciles stuck "initiated" entries against Razorpay.
 */
export const payWithdrawal = async (req, res) => {
  try {
    ensureAdmin(req);

    const withdrawal = await WithdrawalRequest.findById(req.params.id);
    if (!withdrawal) {
      return res.status(404).json({ success: false, message: "Withdrawal request not found" });
    }

    const {
      penaltyAmount,
      penaltyPaise,
      penaltyReason,
      commissionAmount,
      commissionPaise,
      otherDeductions,
      otherDeductionsPaise,
    } = req.body || {};

    if (
      penaltyAmount != null ||
      penaltyPaise != null ||
      commissionAmount != null ||
      commissionPaise != null ||
      otherDeductions != null ||
      otherDeductionsPaise != null
    ) {
      const requestedAmountPaise = toPaise(
        withdrawal.requestedAmountPaise ?? withdrawal.amountPaise ?? rupeesToPaise(withdrawal.amount)
      );
      const pPaise =
        penaltyPaise != null
          ? toPaise(penaltyPaise)
          : penaltyAmount != null
          ? rupeesToPaise(penaltyAmount)
          : withdrawal.penaltyDeductionPaise || 0;
      const cPaise =
        commissionPaise != null
          ? toPaise(commissionPaise)
          : commissionAmount != null
          ? rupeesToPaise(commissionAmount)
          : withdrawal.commissionDeductionPaise || 0;
      const oPaise =
        otherDeductionsPaise != null
          ? toPaise(otherDeductionsPaise)
          : otherDeductions != null
          ? rupeesToPaise(otherDeductions)
          : withdrawal.otherDeductionsPaise || 0;

      const reason = penaltyReason !== undefined ? penaltyReason : withdrawal.penaltyReason;

      if (pPaise > 0 && (!reason || !String(reason).trim())) {
        return res.status(400).json({
          success: false,
          message: "Penalty reason is required when applying a penalty reduction.",
        });
      }

      if (pPaise + cPaise + oPaise > requestedAmountPaise) {
        return res.status(400).json({
          success: false,
          message: "Total deductions cannot exceed requested withdrawal amount.",
        });
      }

      const netPaise = Math.max(0, requestedAmountPaise - pPaise - cPaise - oPaise);

      withdrawal.requestedAmountPaise = requestedAmountPaise;
      withdrawal.penaltyDeductionPaise = pPaise;
      withdrawal.penaltyReason = reason ? String(reason).trim() : null;
      withdrawal.commissionDeductionPaise = cPaise;
      withdrawal.otherDeductionsPaise = oPaise;
      withdrawal.netPayoutAmountPaise = netPaise;
      await withdrawal.save();
    }

    const result = await executeWithdrawalPayout({
      withdrawalId: req.params.id,
      actor: { userId: req.user.userId, role: req.user.role },
      narration: req.body.narration || "RightTouch Technician Payout",
      adminNote: req.body.adminNote || null,
      io: req.io || null,
    });

    return res.json({
      success: true,
      message: "Payout initiated successfully",
      result: {
        payoutId: result.payoutId,
        payoutStatus: result.payoutStatus,
        mode: result.mode,
        amount: result.amount,
        withdrawalStatus: result.withdrawalStatus,
      },
    });
  } catch (error) {
    console.error("payWithdrawal Error:", error);
    const message =
      error?.error?.description || error?.message || "Payout failed";
    return res.status(error.statusCode || 500).json({ success: false, message });
  }
};

/**
 * @desc  Auto-payout monitoring summary — counts + amounts for the admin
 *        dashboard (all-time / today / in-flight).
 */
export const getAutoPayoutSummary = async (req, res) => {
  try {
    ensureAdmin(req);

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const inFlightStatuses = ["pending", "requested", "approved", "processing"];

    const [totalAutoPayouts, todayAutoPayouts, pendingAutoPayouts, paidAgg, todayPaidAgg, totalAutoAmountAgg] =
      await Promise.all([
        WithdrawalRequest.countDocuments({ type: "auto" }),
        WithdrawalRequest.countDocuments({ type: "auto", createdAt: { $gte: today } }),
        WithdrawalRequest.countDocuments({ type: "auto", status: { $in: inFlightStatuses } }),
        WithdrawalRequest.aggregate([
          { $match: { type: "auto", status: "paid" } },
          {
            $group: {
              _id: null,
              totalPaise: { $sum: { $ifNull: ["$amountPaise", { $multiply: ["$amount", 100] }] } },
            },
          },
        ]),
        WithdrawalRequest.aggregate([
          { $match: { type: "auto", status: "paid", createdAt: { $gte: today } } },
          {
            $group: {
              _id: null,
              totalPaise: { $sum: { $ifNull: ["$amountPaise", { $multiply: ["$amount", 100] }] } },
            },
          },
        ]),
        WithdrawalRequest.aggregate([
          { $match: { type: "auto", status: { $in: ["paid", ...inFlightStatuses] } } },
          {
            $group: {
              _id: null,
              totalPaise: { $sum: { $ifNull: ["$amountPaise", { $multiply: ["$amount", 100] }] } },
            },
          },
        ]),
      ]);

    const totalAmountPaidPaise = paidAgg[0]?.totalPaise || 0;
    const todayAmountPaidPaise = todayPaidAgg[0]?.totalPaise || 0;
    const totalAutoAmountPaise = totalAutoAmountAgg[0]?.totalPaise || 0;

    const config = await getAutoPayoutConfig();

    res.json({
      success: true,
      result: {
        totalAutoPayouts,
        todayAutoPayouts,
        pendingAutoPayouts,
        totalAmountPaid: paiseToRupees(totalAmountPaidPaise),
        totalAmountPaidPaise,
        todayAmountPaid: paiseToRupees(todayAmountPaidPaise),
        todayAmountPaidPaise,
        totalAutoAmount: paiseToRupees(totalAutoAmountPaise),
        totalAutoAmountPaise,
        config: {
          autoPayoutEnabled: config.autoPayoutEnabled,
          autoPayoutThreshold: paiseToRupees(config.autoPayoutThresholdPaise),
          autoPayoutThresholdPaise: config.autoPayoutThresholdPaise,
          minimumMaintenance: paiseToRupees(config.minimumMaintenancePaise),
          minimumMaintenancePaise: config.minimumMaintenancePaise,
          autoPayoutCronExpression: config.autoPayoutCronExpression,
        },
      },
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
};

/**
 * @desc  Read global auto-payout configuration (GlobalSetting + env fallbacks).
 */
export const getAutoPayoutSettings = async (req, res) => {
  try {
    ensureAdmin(req);

    const config = await getAutoPayoutConfig();

    res.json({
      success: true,
      result: {
        autoPayoutEnabled: config.autoPayoutEnabled,
        autoPayoutThreshold: paiseToRupees(config.autoPayoutThresholdPaise),
        autoPayoutThresholdPaise: config.autoPayoutThresholdPaise,
        minimumMaintenance: paiseToRupees(config.minimumMaintenancePaise),
        minimumMaintenancePaise: config.minimumMaintenancePaise,
        autoPayoutCronExpression: config.autoPayoutCronExpression,
        minWithdrawalAmount: paiseToRupees(config.minWithdrawalAmountPaise),
        minWithdrawalAmountPaise: config.minWithdrawalAmountPaise,
        withdrawalCooldownDays: config.withdrawalCooldownDays,
        dualApprovalThreshold: paiseToRupees(config.dualApprovalThresholdPaise),
        dualApprovalThresholdPaise: config.dualApprovalThresholdPaise,
      },
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
};

/**
 * @desc  Update global auto-payout configuration.
 *        Body: { enabled?, threshold?, minimumMaintenance?, autoPayoutCronExpression?, minWithdrawalAmount?, withdrawalCooldownDays?, dualApprovalThreshold? }
 *        Values persist in GlobalSetting and take effect live.
 */
export const updateAutoPayoutSettings = async (req, res) => {
  try {
    ensureAdmin(req);

    const {
      enabled,
      threshold,
      minimumMaintenance,
      autoPayoutCronExpression,
      minWithdrawalAmount,
      withdrawalCooldownDays,
      dualApprovalThreshold,
    } = req.body || {};

    const updates = {};
    if (enabled !== undefined) {
      if (typeof enabled !== "boolean") {
        return res.status(400).json({ success: false, message: "enabled must be a boolean" });
      }
      updates.autoPayoutEnabled = enabled;
    }
    if (threshold !== undefined) {
      const thresholdPaise = toPaise(threshold * 100);
      if (!Number.isFinite(thresholdPaise) || thresholdPaise < 10000) {
        return res.status(400).json({ success: false, message: "threshold must be at least ₹100" });
      }
      updates.autoPayoutThresholdPaise = thresholdPaise;
    }
    if (minimumMaintenance !== undefined) {
      const maintenancePaise = toPaise(minimumMaintenance * 100);
      if (!Number.isFinite(maintenancePaise) || maintenancePaise < 0) {
        return res.status(400).json({ success: false, message: "minimumMaintenance must be >= 0" });
      }
      updates.minimumMaintenancePaise = maintenancePaise;
    }
    if (autoPayoutCronExpression !== undefined && String(autoPayoutCronExpression).trim()) {
      updates.autoPayoutCronExpression = String(autoPayoutCronExpression).trim();
    }
    if (minWithdrawalAmount !== undefined) {
      const minPaise = toPaise(minWithdrawalAmount * 100);
      if (!Number.isFinite(minPaise) || minPaise < 0) {
        return res.status(400).json({ success: false, message: "minWithdrawalAmount must be >= 0" });
      }
      updates.minWithdrawalAmountPaise = minPaise;
    }
    if (withdrawalCooldownDays !== undefined) {
      const days = Number(withdrawalCooldownDays);
      if (!Number.isFinite(days) || days < 0) {
        return res.status(400).json({ success: false, message: "withdrawalCooldownDays must be >= 0" });
      }
      updates.withdrawalCooldownDays = days;
    }
    if (dualApprovalThreshold !== undefined) {
      const dualPaise = toPaise(dualApprovalThreshold * 100);
      if (!Number.isFinite(dualPaise) || dualPaise < 0) {
        return res.status(400).json({ success: false, message: "dualApprovalThreshold must be >= 0" });
      }
      updates.dualApprovalThresholdPaise = dualPaise;
    }

    const config = await setAutoPayoutConfig(updates, req.user);

    await writeAuditLog({
      actor: req.user.userId,
      actorRole: req.user.role,
      action: "AUTO_PAYOUT_SETTINGS_UPDATED",
      targetType: "GlobalSetting",
      targetId: null,
      after: updates,
      reason: req.body.reason || null,
    });

    res.json({
      success: true,
      message: "Payout settings updated successfully",
      result: {
        autoPayoutEnabled: config.autoPayoutEnabled,
        autoPayoutThreshold: paiseToRupees(config.autoPayoutThresholdPaise),
        autoPayoutThresholdPaise: config.autoPayoutThresholdPaise,
        minimumMaintenance: paiseToRupees(config.minimumMaintenancePaise),
        minimumMaintenancePaise: config.minimumMaintenancePaise,
        autoPayoutCronExpression: config.autoPayoutCronExpression,
        minWithdrawalAmount: paiseToRupees(config.minWithdrawalAmountPaise),
        minWithdrawalAmountPaise: config.minWithdrawalAmountPaise,
        withdrawalCooldownDays: config.withdrawalCooldownDays,
        dualApprovalThreshold: paiseToRupees(config.dualApprovalThresholdPaise),
        dualApprovalThresholdPaise: config.dualApprovalThresholdPaise,
      },
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
};

/**
 * 🔧 Admin manual "Send Money" — configurable dual-approval threshold.
 * Below the threshold the payout is released immediately via the shared
 * engine (no second admin needed). At/above the threshold it is parked in
 * status `requested` with `requiresApproval:true` and must be confirmed by a
 * second admin via `approveAdminManualPayout`.
 *
 * The threshold lives in GlobalSetting (key
 * `payout.adminManualDualApprovalPaise`) so it is tunable without a deploy.
 * Default: ₹10,000 (1,000,000 paise).
 */
const getAdminManualDualApprovalPaise = async () => {
  const doc = await GlobalSetting.findOne({
    key: "payout.adminManualDualApprovalPaise",
  }).lean();
  const v = doc?.value;
  if (v == null) return 1000000; // default ₹10,000
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? toPaise(n) : 1000000;
};

export const adminManualPayoutToTechnician = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    ensureAdmin(req);
    const {
      technicianId: bodyTechnicianId,
      amount,
      amountPaise,
      reason,
      clientIdempotencyKey,
    } = req.body || {};
    const technicianId = req.params.technicianId || bodyTechnicianId;

    if (!technicianId || !isValidObjectId(technicianId)) {
      return res.status(400).json({ success: false, message: "Valid technicianId is required" });
    }
    const amountPaiseNum = toPaise(amountPaise ?? rupeesToPaise(amount));
    if (amountPaiseNum == null || amountPaiseNum <= 0) {
      return res.status(400).json({ success: false, message: "Invalid amount" });
    }
    if (!reason || !reason.trim()) {
      return res.status(400).json({ success: false, message: "A reason/note is required for manual payouts" });
    }

    const tech = await TechnicianProfile.findById(technicianId);
    if (!tech) {
      return res.status(404).json({ success: false, message: "Technician not found" });
    }
    if ((tech.availableBalancePaise ?? 0) < amountPaiseNum) {
      return res.status(400).json({ success: false, message: "Insufficient technician balance" });
    }

    // No other active payout (unique partial index backs this up too).
    const inProgress = await WithdrawalRequest.findOne({
      technicianId,
      status: {
        $in: ["pending", "requested", "approved", "processing", "manual_review"],
      },
    })
      .select("_id status")
      .lean();
    if (inProgress) {
      return res.status(409).json({
        success: false,
        message: "Technician already has a payout in progress or under review.",
        result: { withdrawalId: inProgress._id, status: inProgress.status },
      });
    }

    const dualThreshold = await getAdminManualDualApprovalPaise();
    const needsDual = amountPaiseNum >= dualThreshold;

    // Atomic reserve (available → reserved) so the engine's release logic
    // matches the technician-initiated flow exactly.
    const reserved = await TechnicianProfile.findOneAndUpdate(
      { _id: technicianId, availableBalancePaise: { $gte: amountPaiseNum } },
      { $inc: { availableBalancePaise: -amountPaiseNum, reservedBalancePaise: amountPaiseNum } },
      { new: true, session }
    ).lean();
    if (!reserved) {
      return res.status(400).json({ success: false, message: "Insufficient technician balance" });
    }

    let withdrawal;
    try {
      [withdrawal] = await WithdrawalRequest.create(
        [
          {
            technicianId,
            amount: paiseToRupees(amountPaiseNum),
            amountPaise: amountPaiseNum,
            status: needsDual ? "requested" : "pending",
            origin: "admin_direct",
            requiresApproval: needsDual,
            initiatedBy: { actorType: "admin", actorId: req.user.userId },
            clientIdempotencyKey: clientIdempotencyKey || null,
            adminNote: reason,
          },
        ],
        { session }
      );

      await WalletTransaction.create(
        [
          {
            technicianId,
            amountPaise: amountPaiseNum,
            amount: paiseToRupees(amountPaiseNum),
            type: "debit",
            source: "withdraw",
            withdrawalId: withdrawal._id,
            idempotencyKey: `withdrawal:${withdrawal._id}`,
            note: `Admin manual payout reserve #${withdrawal._id}`,
          },
        ],
        { session }
      );
    } catch (createErr) {
      // Roll back the reserve if the request can't be created (e.g. a
      // concurrent active payout tripped the unique partial index) so the
      // technician's balance is never left frozen.
      await TechnicianProfile.updateOne(
        { _id: technicianId },
        { $inc: { availableBalancePaise: amountPaiseNum, reservedBalancePaise: -amountPaiseNum } },
        { session }
      );
      if (createErr?.code === 11000) {
        return res.status(409).json({
          success: false,
          message: "Technician already has a payout in progress or under review.",
        });
      }
      throw createErr;
    }

    await writeAuditLog({
      actor: req.user.userId,
      actorRole: req.user.role,
      action: "ADMIN_MANUAL_PAYOUT_REQUESTED",
      targetType: "WithdrawalRequest",
      targetId: withdrawal._id,
      after: {
        amountPaise: amountPaiseNum,
        origin: "admin_direct",
        needsDualApproval: needsDual,
        reason,
      },
    });

    // High-value → wait for a second admin's approval.
    if (needsDual) {
      return res.status(200).json({
        success: true,
        message: "High-value manual payout requires a second admin approval.",
        result: {
          withdrawalId: withdrawal._id,
          status: "requested",
          needsSecondApproval: true,
        },
      });
    }

    // Below threshold → release immediately via the shared engine.
    const io = req.io || getIo();
    try {
      const payout = await executeWithdrawalPayout({
        withdrawalId: withdrawal._id,
        actor: { userId: req.user.userId, role: req.user.role },
        narration: reason || "RightTouch Admin Manual Payout",
        adminNote: reason,
        io,
      });
      return res.status(201).json({
        success: true,
        message: "Manual payout sent to technician.",
        result: {
          withdrawalId: withdrawal._id,
          status: payout.withdrawalStatus,
          amount: payout.amount,
          amountPaise: payout.amountPaise,
          payoutId: payout.payoutId,
          mode: payout.mode,
        },
      });
    } catch (payErr) {
      const w = await WithdrawalRequest.findById(withdrawal._id).lean();
      if (w && w.status === "manual_review") {
        return res.status(202).json({
          success: false,
          message: "Payout outcome is being verified with the bank. We'll notify you shortly.",
          result: { withdrawalId: withdrawal._id, status: "manual_review" },
        });
      }
      await releaseFailedWithdrawalReserve({
        withdrawalId: withdrawal._id,
        amountPaise: amountPaiseNum,
        technicianId,
        reason: payErr?.message,
      });
      return res.status(400).json({
        success: false,
        message: payErr?.message || "Payout failed. Balance restored.",
        result: { withdrawalId: withdrawal._id, status: "failed" },
      });
    }
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, message: error.message });
  } finally {
    session.endSession();
  }
};

/**
 * 🛠️ Admin resolution of an ambiguous (`manual_review`) payout. The
 * reconciliation cron auto-resolves reviewable outboxes that captured a
 * Razorpay id; this endpoint handles the rest (no id captured) — admin
 * decides "complete" (force paid) or "revert" (refund reserve).
 */
export const resolveManualReviewPayout = async (req, res) => {
  try {
    ensureAdmin(req);
    const { id } = req.params;
    const { decision } = req.body;
    if (!["complete", "revert"].includes(decision)) {
      return res.status(400).json({
        success: false,
        message: "decision must be 'complete' or 'revert'",
      });
    }
    const result = await adminResolveManualReview({
      withdrawalId: id,
      decision,
      admin: { userId: req.user.userId, role: req.user.role },
    });
    return res.status(200).json({
      success: true,
      message: `Manual review payout ${decision}ed`,
      result,
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
};

/**
 * ✅ Second-admin approval for a high-value (dual-approval) admin_direct payout parked in
 * `requested`. Executes the single shared payout engine — identical risk
 * gates (KYC / dues / complaint block) as every other flow.
 */
export const approveAdminManualPayout = async (req, res) => {
  try {
    ensureAdmin(req);
    const { id } = req.params;

    const w = await WithdrawalRequest.findById(id);
    if (!w) {
      return res.status(404).json({ success: false, message: "Withdrawal not found" });
    }
    if (w.origin !== "admin_direct" || !w.requiresApproval) {
      return res.status(400).json({ success: false, message: "This payout is not a dual-approval request" });
    }
    if (w.status !== "requested") {
      return res.status(409).json({
        success: false,
        message: `Cannot approve a payout in status '${w.status}'`,
        result: { withdrawalId: id, status: w.status },
      });
    }

    // Dual control: the approving admin must not be the one who initiated it.
    if (String(w.initiatedBy?.actorId) === String(req.user.userId)) {
      return res.status(403).json({
        success: false,
        message: "The admin who initiated this payout cannot also approve it.",
      });
    }

    const io = req.io || getIo();
    try {
      const payout = await executeWithdrawalPayout({
        withdrawalId: id,
        actor: { userId: req.user.userId, role: req.user.role },
        narration: w.adminNote || "RightTouch Admin Manual Payout",
        adminNote: w.adminNote,
        io,
      });

      await writeAuditLog({
        actor: req.user.userId,
        actorRole: req.user.role,
        action: "ADMIN_MANUAL_PAYOUT_APPROVED",
        targetType: "WithdrawalRequest",
        targetId: id,
        after: { approvedBy: req.user.userId, payoutId: payout.payoutId },
      });

      return res.status(200).json({
        success: true,
        message: "Manual payout approved and sent.",
        result: {
          withdrawalId: id,
          status: payout.withdrawalStatus,
          payoutId: payout.payoutId,
          mode: payout.mode,
        },
      });
    } catch (payErr) {
      const after = await WithdrawalRequest.findById(id).lean();
      if (after && after.status === "manual_review") {
        return res.status(202).json({
          success: false,
          message: "Payout outcome is being verified with the bank. We'll notify you shortly.",
          result: { withdrawalId: id, status: "manual_review" },
        });
      }
      await releaseFailedWithdrawalReserve({
        withdrawalId: id,
        amountPaise: toPaise(w.amountPaise ?? rupeesToPaise(w.amount)),
        technicianId: w.technicianId,
        reason: payErr?.message,
      });
      return res.status(400).json({
        success: false,
        message: payErr?.message || "Payout failed. Balance restored.",
        result: { withdrawalId: id, status: "failed" },
      });
    }
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
};

/**
 * 🔄 Admin retry failed payout — re-initiates execution via the shared payout engine.
 */
export const retryFailedWithdrawal = async (req, res) => {
  try {
    ensureAdmin(req);
    const { id } = req.params;
    const { reason } = req.body || {};

    const withdrawal = await WithdrawalRequest.findById(id);
    if (!withdrawal) {
      return res.status(404).json({ success: false, message: "Withdrawal request not found" });
    }

    if (withdrawal.status !== "failed") {
      return res.status(400).json({
        success: false,
        message: `Only failed payouts can be retried. Current status is '${withdrawal.status}'`,
      });
    }

    if (await hasActivePayoutBlock(withdrawal.technicianId)) {
      return res.status(409).json({
        success: false,
        message: "Cannot retry payout: active dispute or complaint block on technician.",
      });
    }

    withdrawal.status = "approved";
    withdrawal.adminNote = reason ? `Retry initiated by Admin: ${reason}` : "Payout retry initiated by Admin";
    await withdrawal.save();

    const io = req.io || getIo();
    const payout = await executeWithdrawalPayout({
      withdrawalId: withdrawal._id,
      actor: { userId: req.user.userId, role: req.user.role },
      narration: withdrawal.adminNote,
      adminNote: withdrawal.adminNote,
      io,
    });

    await writeAuditLog({
      actor: req.user.userId,
      actorRole: req.user.role,
      action: "WITHDRAWAL_RETRIED_BY_ADMIN",
      targetType: "WithdrawalRequest",
      targetId: id,
      after: { newStatus: payout.withdrawalStatus, payoutId: payout.payoutId },
      reason: reason || null,
    });

    return res.status(200).json({
      success: true,
      message: "Payout retry initiated successfully",
      result: {
        withdrawalId: id,
        status: payout.withdrawalStatus,
        payoutId: payout.payoutId,
        mode: payout.mode,
      },
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
};

/**
 * 🔒 Admin Freeze / Unfreeze technician payouts (Legal / Risk hold).
 */
export const toggleTechnicianPayoutFreeze = async (req, res) => {
  try {
    ensureAdmin(req);
    const { technicianId } = req.params;
    const { freeze, reason } = req.body || {};

    if (typeof freeze !== "boolean") {
      return res.status(400).json({ success: false, message: "'freeze' must be a boolean (true or false)" });
    }

    if (freeze && (!reason || !reason.trim())) {
      return res.status(400).json({ success: false, message: "A reason is required to freeze technician payouts" });
    }

    const tech = await TechnicianProfile.findById(technicianId);
    if (!tech) {
      return res.status(404).json({ success: false, message: "Technician not found" });
    }

    tech.payoutBlocked = freeze;
    tech.payoutBlockedReason = freeze ? reason.trim() : null;
    await tech.save();

    await writeAuditLog({
      actor: req.user.userId,
      actorRole: req.user.role,
      action: freeze ? "TECHNICIAN_PAYOUT_FROZEN" : "TECHNICIAN_PAYOUT_UNFROZEN",
      targetType: "TechnicianProfile",
      targetId: technicianId,
      after: { payoutBlocked: freeze, reason: tech.payoutBlockedReason },
    });

    return res.status(200).json({
      success: true,
      message: freeze ? "Technician payouts have been frozen" : "Technician payouts have been unfrozen",
      result: {
        technicianId,
        payoutBlocked: tech.payoutBlocked,
        payoutBlockedReason: tech.payoutBlockedReason,
      },
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
};

/**
 * 🔍 Detailed Payout Audit & Status View (Admin)
 */
export const getWithdrawalDetails = async (req, res) => {
  try {
    ensureAdmin(req);
    const { id } = req.params;

    const withdrawal = await WithdrawalRequest.findById(id)
      .populate({
        path: "technicianId",
        select: "userId bankDetails kycDetails isBankVerified status payoutBlocked payoutBlockedReason",
        populate: { path: "userId", select: "fname lname mobileNumber email" },
      })
      .lean();

    if (!withdrawal) {
      return res.status(404).json({ success: false, message: "Withdrawal request not found" });
    }

    const outbox = await PayoutOutbox.findOne({ withdrawalId: id }).lean();
    const walletTx = await WalletTransaction.findOne({ withdrawalId: id, source: "withdraw" }).lean();
    const auditLogs = await AuditLog.find({ targetId: String(id) }).sort({ createdAt: -1 }).lean();

    const techUser = withdrawal.technicianId?.userId || {};
    const requestedPaise = withdrawal.requestedAmountPaise ?? withdrawal.amountPaise ?? rupeesToPaise(withdrawal.amount);
    const netPayoutPaise = withdrawal.netPayoutAmountPaise ?? requestedPaise;

    return res.status(200).json({
      success: true,
      result: {
        withdrawalId: withdrawal._id,
        technician: {
          technicianId: withdrawal.technicianId?._id,
          name: `${techUser.fname || ""} ${techUser.lname || ""}`.trim() || "N/A",
          mobileNumber: techUser.mobileNumber || "N/A",
          email: techUser.email || "N/A",
          payoutBlocked: withdrawal.technicianId?.payoutBlocked || false,
          payoutBlockedReason: withdrawal.technicianId?.payoutBlockedReason || null,
        },
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
        origin: withdrawal.origin,
        status: withdrawal.status,
        payoutMode: withdrawal.payoutMode || "UPI/IMPS",
        payoutDestination: withdrawal.payoutDestination || "N/A",
        payoutReference: withdrawal.payoutReference || null,
        utr: withdrawal.utr || null,
        timestamps: {
          createdAt: withdrawal.createdAt,
          processingAt: withdrawal.processingAt || null,
          paidAt: withdrawal.paidAt || null,
          failedAt: withdrawal.failedAt || null,
          decidedAt: withdrawal.decidedAt || null,
        },
        identifiers: {
          walletTransactionId: walletTx?._id || null,
          payoutOutboxId: outbox?._id || null,
        },
        gatewayDetails: {
          gatewayResponse: outbox?.payoutPayload || null,
          failureReason: withdrawal.failureReason || outbox?.lastError || null,
          lastError: outbox?.lastError || null,
          retryCount: outbox?.attempts || 0,
          webhookEvents: outbox?.webhookEvents || [],
        },
        auditHistory: auditLogs,
      },
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
};
