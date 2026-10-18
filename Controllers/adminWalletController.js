import mongoose from "mongoose";
import TechnicianProfile from "../Schemas/TechnicianProfile.js";
import WithdrawalRequest from "../Schemas/WithdrawalRequest.js";
import WalletTransaction from "../Schemas/WalletTransaction.js";
import Payment from "../Schemas/Payment.js";
import { writeAuditLog } from "../Utils/audit.js";
import { toPaise, rupeesToPaise, paiseToRupees } from "../Utils/money.js";
import { getIo } from "../Utils/ioAccess.js";
import TechnicianKyc from "../Schemas/TechnicianKYC.js";
import Notification from "../Schemas/Notification.js";
import { getDekForKycDoc, decryptBankDetails } from "../Utils/kycFieldCrypto.js";
import { fingerprintBankDetails } from "../Utils/kycPrivacy.js";
import { postPayoutLedgerEntry, postLedgerEntry } from "../Utils/ledger.js";
import { sendPushNotification } from "../Utils/sendNotification.js";
import { SOCKET_ROOMS, SOCKET_EVENTS } from "../Utils/socketConstants.js";
import {
  getAutoPayoutConfig,
  setAutoPayoutConfig,
  resolveTechPayoutSettings,
} from "../Utils/autoPayout.js";
import AuditLog from "../Schemas/AuditLog.js";
import GlobalSetting from "../Schemas/GlobalSetting.js";
import { adminResolveManualReview } from "../Utils/paymentCrons.js";
import { hasActivePayoutBlock } from "../Utils/complaintFreeze.js";

const isValidObjectId = (v) => mongoose.Types.ObjectId.isValid(v);

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

    // Stage 1 manual flow: age of the longest-waiting approved payout (bank-run SLA).
    let oldestApprovedAgeHours = null;
    try {
      const oldestApproved = await WithdrawalRequest.findOne({ status: "approved" })
        .sort({ createdAt: 1 })
        .select("createdAt")
        .lean();
      if (oldestApproved?.createdAt) {
        oldestApprovedAgeHours =
          Math.round(((Date.now() - new Date(oldestApproved.createdAt).getTime()) / 36e5) * 10) / 10;
      }
    } catch (ageErr) {
      console.warn("[getAdminWalletSummary] oldest-approved lookup failed:", ageErr.message);
    }

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
        // Stage 1 manual flow: the offline bank-run queue.
        awaitingPayment: {
          count: countOf("approved"),
          amount: Math.round(sumOf("approved")),
        },
        oldestApprovedAgeHours,
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

  if (queryObj.status) {
    if (Array.isArray(queryObj.status)) {
      const list = queryObj.status.map((s) => String(s).trim()).filter(Boolean);
      if (list.length === 1) query.status = list[0];
      else if (list.length > 1) query.status = { $in: list };
    } else {
      const raw = String(queryObj.status).trim();
      if (raw.includes(",")) {
        const list = raw.split(",").map((s) => s.trim()).filter(Boolean);
        if (list.length === 1) query.status = list[0];
        else if (list.length > 1) query.status = { $in: list };
      } else if (raw) {
        query.status = raw;
      }
    }
  }

  const searchTerm = String(queryObj.search || queryObj.q || "").trim();
  if (searchTerm) {
    const isOid = mongoose.isValidObjectId(searchTerm);
    const searchConditions = [
      { utr: { $regex: searchTerm, $options: "i" } },
      { payoutReference: { $regex: searchTerm, $options: "i" } },
      { payoutDestination: { $regex: searchTerm, $options: "i" } },
      { adminNote: { $regex: searchTerm, $options: "i" } },
    ];
    if (isOid) {
      searchConditions.push({ _id: searchTerm });
      searchConditions.push({ technicianId: searchTerm });
    }
    query.$or = searchConditions;
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

    const sanitizeCsvCell = (val) => {
      if (val == null) return "N/A";
      let str = String(val).trim();
      if (!str) return "N/A";
      if (/^[=+@\-\t\r|]/.test(str)) {
        str = '\x27' + str;
      }
      return '"' + str.replace(/"/g, '""') + '"';
    };

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
      "Payout Reference",
      "Bank UTR",
      "Requested Date",
      "Paid Date",
    ];

    const rows = withdrawals.map((w) => {
      const user = w.technicianId?.userId || {};
      const requestedPaise = w.requestedAmountPaise ?? w.amountPaise ?? rupeesToPaise(w.amount);
      const netPaise = w.netPayoutAmountPaise ?? requestedPaise;

      return [
        sanitizeCsvCell(w._id),
        sanitizeCsvCell((`${user.fname || ""} ${user.lname || ""}`).trim()),
        sanitizeCsvCell(user.mobileNumber),
        sanitizeCsvCell(user.email),
        paiseToRupees(requestedPaise).toFixed(2),
        paiseToRupees(netPaise).toFixed(2),
        paiseToRupees(w.commissionDeductionPaise || 0).toFixed(2),
        paiseToRupees(w.penaltyDeductionPaise || 0).toFixed(2),
        sanitizeCsvCell(w.penaltyReason),
        sanitizeCsvCell(w.status),
        sanitizeCsvCell(w.origin),
        sanitizeCsvCell(w.payoutMode),
        sanitizeCsvCell(w.payoutDestination),
        sanitizeCsvCell(w.payoutReference),
        sanitizeCsvCell(w.utr),
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
 * @desc    Bulk-payment export of APPROVED requests for the offline bank run:
 *          request id, technician name/phone, account holder, MASKED account
 *          (last 4 only), IFSC, net amount. Masked values only — full account
 *          numbers are available solely via getWithdrawalDetails (audited).
 *          Suitable for copy-paste into bank bulk-upload sheets.
 */
export const exportApprovedBulkPayments = async (req, res) => {
  try {
    ensureAdmin(req);

    const limit = Math.min(parseInt(req.query.limit, 10) || 500, 1000);
    const withdrawals = await WithdrawalRequest.find({ status: "approved" })
      .populate({
        path: "technicianId",
        select: "userId",
        populate: { path: "userId", select: "fname lname mobileNumber email" },
      })
      .sort({ createdAt: 1 })
      .limit(limit)
      .lean();

    const headers = [
      "Withdrawal ID",
      "Technician Name",
      "Technician Phone",
      "Account Holder",
      "Account (masked)",
      "IFSC",
      "Net Amount (INR)",
      "Net Amount (paise)",
      "Requested Date",
    ];

    const rows = [];
    for (const w of withdrawals) {
      const user = w.technicianId?.userId || {};
      const profileId = w.technicianId?._id || w.technicianId;
      let holder = "";
      let masked = "";
      let ifsc = "";
      try {
        const kyc = await TechnicianKyc.findOne({ technicianId: profileId })
          .select("bankDetails encryptedDek")
          .lean();
        if (kyc) {
          const dek = await getDekForKycDoc(kyc);
          const plain = decryptBankDetails(kyc.bankDetails, dek) || {};
          holder = plain.accountHolderName || "";
          const acc = String(plain.accountNumber || "").replace(/\s/g, "");
          masked = acc ? `****${acc.slice(-4)}` : "";
          ifsc = plain.ifscCode || "";
        }
      } catch (decErr) {
        console.warn(`[bulkExport] bank decrypt failed for withdrawal ${w._id}:`, decErr.message);
      }
      const netPaise = toPaise(w.netPayoutAmountPaise ?? w.requestedAmountPaise ?? w.amountPaise ?? 0);
      rows.push(
        [
          String(w._id),
          `"${(`${user.fname || ""} ${user.lname || ""}`).trim() || "N/A"}"`,
          `"${user.mobileNumber || "N/A"}"`,
          `"${String(holder).replace(/"/g, "") || "N/A"}"`,
          `"${masked || "N/A"}"`,
          `"${ifsc || "N/A"}"`,
          paiseToRupees(netPaise).toFixed(2),
          netPaise,
          w.createdAt ? new Date(w.createdAt).toISOString() : "N/A",
        ].join(",")
      );
    }

    await writeAuditLog({
      actor: req.user.userId,
      actorRole: req.user.role,
      action: "BULK_PAYMENT_EXPORTED",
      targetType: "WithdrawalRequest",
      targetId: null,
      after: { status: "approved", count: withdrawals.length },
    });

    const csvContent = [headers.join(","), ...rows].join("\n");
    const filename = `RightTouch_BulkPayments_${new Date().toISOString().slice(0, 10)}.csv`;

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
 *          Stage 1 manual flow: technician_request origins are approved here,
 *          then paid offline via mark-paid. Compare-and-set so concurrent
 *          approves cannot double-process.
 */
export const approveWithdrawal = async (req, res) => {
  try {
    ensureAdmin(req);

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

    const existing = await WithdrawalRequest.findById(req.params.id)
      .select("requestedAmountPaise amountPaise amount status origin requiresApproval initiatedBy")
      .lean();
    if (!existing) {
      return res.status(404).json({ success: false, message: "Withdrawal request not found" });
    }

    // Maker-checker separation: The admin who initiated an admin_direct payout
    // cannot approve it.
    if (
      existing.origin === "admin_direct" &&
      existing.initiatedBy?.actorId &&
      String(existing.initiatedBy.actorId) === String(req.user.userId)
    ) {
      return res.status(403).json({
        success: false,
        message: "Maker-checker violation: The admin who initiated this payout cannot also approve it.",
      });
    }

    // Dual-control guard: high-value admin_direct payouts parked with
    // requiresApproval must go through the second-admin endpoint
    // (approve-manual-payout, initiator != approver). The generic approve
    // endpoint must not bypass that check.
    if (existing.origin === "admin_direct") {
      const dualThreshold = await getAdminManualDualApprovalPaise();
      const grossPaise = toPaise(
        existing.requestedAmountPaise ?? existing.amountPaise ?? rupeesToPaise(existing.amount)
      );
      if (existing.requiresApproval || (grossPaise != null && grossPaise >= dualThreshold)) {
        return res.status(400).json({
          success: false,
          message: "This payout requires second-admin approval via approve-manual-payout.",
        });
      }
    }

    if (!["pending", "requested"].includes(existing.status)) {
      return res.status(400).json({ success: false, message: "Invalid or non-pending request" });
    }

    const requestedAmountPaise = toPaise(
      existing.requestedAmountPaise ?? existing.amountPaise ?? rupeesToPaise(existing.amount)
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

    const netPaise = requestedAmountPaise - pPaise - cPaise - oPaise;
    if (netPaise <= 0) {
      return res.status(400).json({
        success: false,
        message: "Net payout must be greater than zero after deductions. Reject the request instead of approving a zero payout.",
      });
    }

    const before = existing.status;
    // Compare-and-set: only pending/requested flip to approved.
    const withdrawal = await WithdrawalRequest.findOneAndUpdate(
      { _id: existing._id, status: { $in: ["pending", "requested"] } },
      {
        $set: {
          status: "approved",
          approvedAt: new Date(),
          approvedBy: req.user.userId,
          decidedAt: new Date(),
          decidedBy: req.user.userId,
          adminNote: adminNote || "Approved by Admin",
          requestedAmountPaise,
          penaltyDeductionPaise: pPaise,
          penaltyReason: penaltyReason ? String(penaltyReason).trim() : null,
          commissionDeductionPaise: cPaise,
          otherDeductionsPaise: oPaise,
          netPayoutAmountPaise: netPaise,
        },
      },
      { new: true }
    );

    if (!withdrawal) {
      return res.status(409).json({
        success: false,
        message: "Withdrawal is no longer pending (concurrent decision). Refresh and retry.",
      });
    }

    await writeAuditLog({
      actor: req.user.userId,
      actorRole: req.user.role,
      action: "WITHDRAWAL_APPROVED",
      targetType: "WithdrawalRequest",
      targetId: withdrawal._id,
      before: { status: before },
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
 *          Compare-and-set; reason required (min 5 chars).
 */
export const rejectWithdrawal = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    ensureAdmin(req);

    const reason = String(req.body?.adminNote || req.body?.reason || "").trim();
    if (reason.length < 5) {
      return res.status(400).json({
        success: false,
        message: "A rejection reason of at least 5 characters is required.",
      });
    }

    const existing = await WithdrawalRequest.findById(req.params.id)
      .select("status amountPaise amount technicianId")
      .lean();
    if (!existing) {
      return res.status(404).json({ success: false, message: "Withdrawal request not found" });
    }

    if (existing.status === "processing" || existing.status === "manual_review") {
      return res.status(400).json({
        success: false,
        message: "Withdrawal is a legacy in-flight record under review and cannot be rejected here. Use resolve-manual-review with verified evidence.",
      });
    }

    if (!["pending", "requested", "approved"].includes(existing.status)) {
      return res.status(400).json({ success: false, message: "Invalid or non-rejectable request (only pending/requested/approved)" });
    }

    const before = existing.status;
    let refundedToWalletPaise = 0;
    const amountPaiseNum = toPaise(existing.amountPaise ?? rupeesToPaise(existing.amount));
    let rejectedId = null;

    await session.withTransaction(async () => {
      const updated = await WithdrawalRequest.findOneAndUpdate(
        { _id: existing._id, status: { $in: ["pending", "requested", "approved"] } },
        {
          $set: {
            status: "rejected",
            rejectedAt: new Date(),
            decidedAt: new Date(),
            decidedBy: req.user.userId,
            adminNote: reason,
          },
        },
        { session, new: true }
      );
      if (!updated) {
        const err = new Error("Withdrawal is no longer rejectable (concurrent decision). Refresh and retry.");
        err.statusCode = 409;
        throw err;
      }
      rejectedId = updated._id;

      const reserveDebit = await WalletTransaction.findOne(
        { withdrawalId: updated._id, type: "debit", source: "withdraw" },
        null,
        { session }
      );

      if (reserveDebit && amountPaiseNum > 0) {
        // Move reserved → available (the reserve was deducted at request time),
        // guarded so reserved never goes negative; bump walletVersion.
        // H11: honor the guard — on a miss no funds moved, so skip the
        // credit row and surface the shortfall for human review.
        const moved = await TechnicianProfile.findOneAndUpdate(
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
          { session, new: true }
        );

        if (moved) {
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
                  note: `Refund for rejected withdrawal #${updated._id}`,
                },
              ],
              { session }
            );
          } catch (creditErr) {
            // Replay-safe: double-click reuses the same idempotency key.
            if (creditErr?.code !== 11000) throw creditErr;
          }
          refundedToWalletPaise = amountPaiseNum;
        } else {
          refundedToWalletPaise = 0;
          await writeAuditLog({
            actor: req.user.userId,
            actorRole: req.user.role,
            action: "WITHDRAWAL_REJECT_RESERVE_SHORTFALL",
            targetType: "WithdrawalRequest",
            targetId: updated._id,
            after: { requestedPaise: amountPaiseNum, refundedToWalletPaise: 0 },
            reason: "Reserved balance insufficient at reject time — requires human review",
            session,
          });
        }
      }
    });

    await writeAuditLog({
      actor: req.user.userId,
      actorRole: req.user.role,
      action: "WITHDRAWAL_REJECTED",
      targetType: "WithdrawalRequest",
      targetId: rejectedId,
      before: { status: before },
      after: { status: "rejected", refundedToWalletPaise },
      reason,
    });

    // Best-effort technician notification (never breaks the committed flow).
    try {
      await Notification.create({
        recipientId: existing.technicianId,
        recipientType: "technician",
        eventType: "WITHDRAWAL_REJECTED",
        title: "Withdrawal request rejected",
        body: `Your withdrawal request was rejected by Admin. Reason: ${reason}. ${refundedToWalletPaise > 0 ? `₹${paiseToRupees(refundedToWalletPaise).toFixed(2)} has been returned to your wallet.` : ""}`,
        data: { type: "WITHDRAWAL_REJECTED", withdrawalId: String(rejectedId) },
        category: "finance",
      });
    } catch (notifyErr) {
      console.warn("[rejectWithdrawal] technician notify failed:", notifyErr.message);
    }

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

/* ── Stage 1 manual-flow helpers ── */

const UTR_RE = /^[A-Z0-9]{8,30}$/;
const MANUAL_PAYOUT_MODES = ["IMPS", "NEFT", "UPI", "RTGS"];

const normalizeUtr = (v) => String(v || "").trim().toUpperCase();

/**
 * Re-run the payout gates at mark-paid time (complaint block, dues, KYC bank
 * verified + fingerprint). Read-only; throws with .statusCode on failure.
 * Same semantics as the old automated engine gates, minus any mutation.
 */
const assertManualPayable = async (technicianId) => {
  if (await hasActivePayoutBlock(technicianId)) {
    const err = new Error(
      "Payout blocked: an open complaint is holding the retention reserve. Resolve the complaint first."
    );
    err.statusCode = 409;
    throw err;
  }

  const techProfile = await TechnicianProfile.findById(technicianId)
    .select("outstandingDuesPaise")
    .lean();
  if (!techProfile) {
    const err = new Error("Technician profile not found");
    err.statusCode = 404;
    throw err;
  }
  if ((techProfile.outstandingDuesPaise || 0) > 0) {
    const err = new Error(
      `Payout blocked: technician has outstanding dues of ₹${(techProfile.outstandingDuesPaise / 100).toFixed(2)}. Recover via earnings first.`
    );
    err.statusCode = 409;
    throw err;
  }

  const technicianKyc = await TechnicianKyc.findOne({ technicianId });
  const dek = await getDekForKycDoc(technicianKyc);
  const bankDetails = decryptBankDetails(technicianKyc?.bankDetails, dek) || {};
  const hasBank = Boolean(bankDetails.accountNumber && bankDetails.ifscCode);
  const hasUpi = Boolean(bankDetails.upiId);
  if (!hasBank && !hasUpi) {
    const err = new Error("No bank/UPI on file for technician. Verify bank details before marking paid.");
    err.statusCode = 422;
    throw err;
  }
  const bankVerified =
    technicianKyc?.bankVerified === true ||
    technicianKyc?.bankVerificationStatus === "approved";
  if (!bankVerified) {
    const err = new Error("Technician bank/UPI details are not verified. Verify them before marking paid.");
    err.statusCode = 422;
    throw err;
  }
  const currentFingerprint = fingerprintBankDetails(bankDetails);
  const storedFingerprint = technicianKyc?.bankDetailsFingerprint;
  if (!storedFingerprint || !currentFingerprint || storedFingerprint !== currentFingerprint) {
    const err = new Error(
      "Bank details changed since verification. Re-verify the technician's bank details before marking paid."
    );
    err.statusCode = 422;
    throw err;
  }
};

const paidResultOf = (w) => ({
  withdrawalId: w._id,
  status: w.status,
  requestedAmount: paiseToRupees(w.requestedAmountPaise ?? w.amountPaise ?? 0),
  netPayoutAmount: paiseToRupees(w.netPayoutAmountPaise ?? w.amountPaise ?? 0),
  utr: w.utr || null,
  payoutMode: w.payoutMode || null,
  paidAt: w.paidAt || null,
});

/**
 * @desc  Mark an approved withdrawal as PAID after an offline manual bank
 *        transfer. The admin pays from the bank account directly, then records
 *        {utr, paymentMode, paidAt} here. ONE transaction, compare-and-set
 *        approved->paid. Idempotent on same UTR; 409 on different UTR.
 */
export const markWithdrawalPaid = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    ensureAdmin(req);

    const utr = normalizeUtr(req.body?.utr);
    if (!UTR_RE.test(utr)) {
      return res.status(400).json({
        success: false,
        message: "utr is required: 8-30 uppercase alphanumerics (bank UTR / UPI reference).",
      });
    }
    const paymentMode = String(req.body?.paymentMode || "").trim().toUpperCase();
    if (!MANUAL_PAYOUT_MODES.includes(paymentMode)) {
      return res.status(400).json({
        success: false,
        message: `paymentMode is required: one of ${MANUAL_PAYOUT_MODES.join("|")}.`,
      });
    }
    let paidAt = new Date();
    if (req.body?.paidAt != null && String(req.body.paidAt).trim() !== "") {
      paidAt = new Date(req.body.paidAt);
      if (Number.isNaN(paidAt.getTime())) {
        return res.status(400).json({ success: false, message: "paidAt must be a valid date." });
      }
      if (paidAt.getTime() > Date.now()) {
        return res.status(400).json({ success: false, message: "paidAt cannot be in the future." });
      }
    }
    const proofUrl = req.body?.proofUrl != null ? String(req.body.proofUrl).trim().slice(0, 2048) : null;
    const adminNote = req.body?.adminNote != null ? String(req.body.adminNote).trim().slice(0, 2000) : null;

    const existing = await WithdrawalRequest.findById(req.params.id).lean();
    if (!existing) {
      return res.status(404).json({ success: false, message: "Withdrawal request not found" });
    }

    // Idempotency: already paid with the SAME utr → return existing, write nothing.
    if (existing.status === "paid") {
      if (normalizeUtr(existing.utr) === utr) {
        return res.status(200).json({
          success: true,
          message: "Withdrawal already marked paid with this UTR (idempotent).",
          result: paidResultOf(existing),
        });
      }
      return res.status(409).json({
        success: false,
        message: "Withdrawal is already paid with a different UTR. Use revert-paid to correct it.",
        result: { withdrawalId: existing._id, recordedUtr: existing.utr || null },
      });
    }

    if (existing.status !== "approved") {
      return res.status(400).json({
        success: false,
        message: `Only approved withdrawals can be marked paid (current: "${existing.status}"). Approve it first.`,
      });
    }

    // Application-level UTR uniqueness (the unique partial index
    // uniq_withdrawal_utr backs this up against races).
    const utrClash = await WithdrawalRequest.findOne({ utr, _id: { $ne: existing._id } })
      .select("_id")
      .lean();
    if (utrClash) {
      return res.status(409).json({
        success: false,
        message: "This UTR is already recorded on another withdrawal.",
        result: { withdrawalId: utrClash._id },
      });
    }

    // Re-run gates at record time.
    try {
      await assertManualPayable(existing.technicianId);
    } catch (gateErr) {
      return res.status(gateErr.statusCode || 422).json({ success: false, message: gateErr.message });
    }

    // Optional maker-checker: approver cannot record the payment.
    if (
      process.env.MAKER_CHECKER_ENABLED === "true" &&
      existing.approvedBy &&
      String(existing.approvedBy) === String(req.user.userId)
    ) {
      return res.status(403).json({
        success: false,
        message: "Maker-checker is enabled: the admin who approved this withdrawal cannot mark it paid.",
      });
    }

    const grossPaise = toPaise(
      existing.requestedAmountPaise ?? existing.amountPaise ?? rupeesToPaise(existing.amount)
    );
    const commissionPaise = toPaise(existing.commissionDeductionPaise || 0);
    const penaltyPaise = toPaise(existing.penaltyDeductionPaise || 0);
    const otherPaise = toPaise(existing.otherDeductionsPaise || 0);
    const netPaise = toPaise(existing.netPayoutAmountPaise ?? grossPaise - commissionPaise - penaltyPaise - otherPaise);
    if (grossPaise <= 0 || netPaise <= 0) {
      return res.status(422).json({
        success: false,
        message: "Withdrawal has no payable amount. Reject it instead of marking paid.",
      });
    }

    // Additive confirmed-amount cross-check (backward compatible: absent =
    // current behavior). When the admin passes the bank-slip amount, it must
    // equal the approved net payable — partial/over payments are rejected,
    // never silently accepted.
    const { confirmedAmountPaise: rawConfirmedPaise, confirmedAmount: rawConfirmedRupees } = req.body || {};
    if (rawConfirmedPaise != null || rawConfirmedRupees != null) {
      const confirmedPaise =
        rawConfirmedPaise != null ? toPaise(rawConfirmedPaise) : rupeesToPaise(rawConfirmedRupees);
      if (confirmedPaise !== netPaise) {
        return res.status(409).json({
          success: false,
          message: "Confirmed amount does not match the approved net payable amount.",
          result: { confirmedAmountPaise: confirmedPaise, netPayoutAmountPaise: netPaise },
        });
      }
    }

    const ip = req.ip || null;
    let paid = null;

    await session.withTransaction(async () => {
      // Compare-and-set approved->paid.
      paid = await WithdrawalRequest.findOneAndUpdate(
        { _id: existing._id, status: "approved" },
        {
          $set: {
            status: "paid",
            paidAt,
            processedAt: new Date(),
            utr,
            payoutMode: paymentMode,
            payoutProvider: "manual",
            paidBy: req.user.userId,
            proofUrl,
            adminNote: adminNote || existing.adminNote || "Paid via manual bank transfer",
            requestedAmountPaise: grossPaise,
            netPayoutAmountPaise: netPaise,
            amountPaise: netPaise,
            amount: paiseToRupees(netPaise),
            failureReason: null,
          },
        },
        { session, new: true }
      );
      if (!paid) {
        const err = new Error("Withdrawal is no longer approved (concurrent decision). Refresh and retry.");
        err.statusCode = 409;
        throw err;
      }

      // Release the reserve (gross) + record lifetime withdrawn (net),
      // guarded so reserved never goes negative; bump walletVersion.
      const wallet = await TechnicianProfile.findOneAndUpdate(
        { _id: existing.technicianId, reservedBalancePaise: { $gte: grossPaise } },
        [
          {
            $set: {
              reservedBalancePaise: { $subtract: ["$reservedBalancePaise", grossPaise] },
              lifetimeWithdrawnPaise: { $add: [{ $ifNull: ["$lifetimeWithdrawnPaise", 0] }, netPaise] },
              walletVersion: { $add: [{ $ifNull: ["$walletVersion", 0] }, 1] },
            },
          },
        ],
        { session, new: true }
      );
      if (!wallet) {
        const err = new Error(
          "Reserve mismatch: technician reserved balance is lower than the withdrawal gross. Escalate to engineering — do not retry blindly."
        );
        err.statusCode = 409;
        throw err;
      }

      if (penaltyPaise > 0) {
        await WalletTransaction.create(
          [
            {
              technicianId: existing.technicianId,
              amountPaise: penaltyPaise,
              amount: paiseToRupees(penaltyPaise),
              type: "debit",
              source: "penalty",
              withdrawalId: existing._id,
              idempotencyKey: `withdrawal-penalty:${existing._id}`,
              note: `Penalty deduction: ${existing.penaltyReason || "Penalty applied on withdrawal"}`,
            },
          ],
          { session }
        );
      }
      if (commissionPaise > 0) {
        await WalletTransaction.create(
          [
            {
              technicianId: existing.technicianId,
              amountPaise: commissionPaise,
              amount: paiseToRupees(commissionPaise),
              type: "debit",
              source: "adjustment",
              withdrawalId: existing._id,
              idempotencyKey: `withdrawal-commission:${existing._id}`,
              note: `Commission deduction on withdrawal #${existing._id}`,
            },
          ],
          { session }
        );
      }

      const ledger = await postPayoutLedgerEntry({
        withdrawal: { _id: existing._id, technicianId: existing.technicianId, amountPaise: netPaise },
        providerReference: utr,
        session,
      });
      if (!ledger.created) {
        const err = new Error("Payout ledger entry already exists for this withdrawal.");
        err.statusCode = 409;
        throw err;
      }
    });

    await writeAuditLog({
      actor: req.user.userId,
      actorRole: req.user.role,
      action: "PAYOUT_MARKED_PAID",
      targetType: "WithdrawalRequest",
      targetId: paid._id,
      before: { status: "approved" },
      after: {
        status: "paid",
        grossPaise,
        netPaise,
        utr,
        paymentMode,
        paidAt: paidAt.toISOString(),
      },
      reason: adminNote,
      metadata: { ip },
    });

    // Best-effort technician notification (never breaks the committed flow).
    try {
      const net = paiseToRupees(netPaise);
      await Notification.create({
        recipientId: existing.technicianId,
        recipientType: "technician",
        eventType: "WITHDRAWAL_PAID",
        title: "Payout transferred",
        body: `₹${net.toFixed(2)} has been transferred to your verified bank/UPI account. UTR: ${utr}.`,
        data: {
          type: "WITHDRAWAL_PAID",
          withdrawalId: String(existing._id),
          netPayoutAmount: net,
          netPayoutAmountPaise: netPaise,
          utr,
        },
        category: "finance",
      });
      const io = getIo();
      io?.to(SOCKET_ROOMS.TECHNICIAN(String(existing.technicianId))).emit(
        SOCKET_EVENTS.AUTO_PAYOUT_PAID,
        {
          withdrawalId: String(existing._id),
          netPayoutAmount: net,
          netPayoutAmountPaise: netPaise,
          amountPaise: netPaise,
          amount: net,
          utr,
          payoutMode: paymentMode,
          timestamp: new Date().toISOString(),
        }
      );
      await sendPushNotification(
        existing.technicianId,
        {
          title: "Payout transferred",
          body: `₹${net.toFixed(2)} has been transferred to your account. UTR: ${utr}.`,
          data: { type: "WITHDRAWAL_PAID", withdrawalId: String(existing._id), utr },
        },
        { recipientType: "technician" }
      );
    } catch (notifyErr) {
      console.warn("[markWithdrawalPaid] technician notify failed:", notifyErr.message);
    }

    return res.status(200).json({
      success: true,
      message: "Withdrawal marked paid.",
      result: paidResultOf(paid),
    });
  } catch (error) {
    console.error("markWithdrawalPaid Error:", error);
    // 11000 here means a concurrent mark-paid won the race (UTR index or
    // idempotency keys) — surface as conflict, never as server error.
    if (error?.code === 11000) {
      return res.status(409).json({
        success: false,
        message: "Concurrent payment record detected. Refresh the withdrawal and retry.",
      });
    }
    return res.status(error.statusCode || 500).json({ success: false, message: error.message });
  } finally {
    session.endSession();
  }
};

/**
 * @desc  Revert a wrongly-recorded manual payment (bounced transfer or data
 *        entry error). paid -> failed (with REVERTED markers; no new status).
 *        Append-only: existing ledger/wallet rows are NEVER edited or deleted.
 *        Owner role only. Idempotent.
 */
export const revertPaidWithdrawal = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    ensureAdmin(req);
    if (req.user?.role !== "Owner") {
      return res.status(403).json({
        success: false,
        message: "Only Owner can revert a recorded payment.",
      });
    }

    const reason = String(req.body?.reason || "").trim();
    if (reason.length < 5) {
      return res.status(400).json({
        success: false,
        message: "A revert reason of at least 5 characters is required.",
      });
    }
    const bankReturnUtr =
      req.body?.bankReturnUtr != null ? normalizeUtr(req.body.bankReturnUtr) : null;

    const existing = await WithdrawalRequest.findById(req.params.id).lean();
    if (!existing) {
      return res.status(404).json({ success: false, message: "Withdrawal request not found" });
    }

    // Idempotency: already reverted → return existing, write nothing.
    if (existing.status === "failed" && existing.revertedBy) {
      return res.status(200).json({
        success: true,
        message: "Withdrawal already reverted (idempotent).",
        result: {
          withdrawalId: existing._id,
          status: existing.status,
          failureReason: existing.failureReason || null,
          revertedAt: existing.revertedAt || null,
        },
      });
    }
    if (existing.status !== "paid") {
      return res.status(400).json({
        success: false,
        message: `Only paid withdrawals can be reverted (current: "${existing.status}").`,
      });
    }

    const grossPaise = toPaise(
      existing.requestedAmountPaise ?? existing.amountPaise ?? rupeesToPaise(existing.amount)
    );
    const netPaise = toPaise(existing.netPayoutAmountPaise ?? grossPaise);
    const commissionPaise = toPaise(existing.commissionDeductionPaise || 0);
    const penaltyPaise = toPaise(existing.penaltyDeductionPaise || 0);

    const ip = req.ip || null;
    let reverted = null;

    await session.withTransaction(async () => {
      reverted = await WithdrawalRequest.findOneAndUpdate(
        { _id: existing._id, status: "paid" },
        {
          $set: {
            status: "failed",
            failedAt: new Date(),
            revertedAt: new Date(),
            revertedBy: req.user.userId,
            failureReason: `REVERTED: ${reason}`,
            decisionNote: `Payment record reverted by Owner: ${reason}`,
          },
        },
        { session, new: true }
      );
      if (!reverted) {
        const err = new Error("Withdrawal is no longer paid (concurrent change). Refresh and retry.");
        err.statusCode = 409;
        throw err;
      }

      // Restore spendable balance (full gross) and unwind lifetime (net),
      // guarded so lifetime never goes negative; bump walletVersion.
      const wallet = await TechnicianProfile.findOneAndUpdate(
        { _id: existing.technicianId, lifetimeWithdrawnPaise: { $gte: netPaise } },
        [
          {
            $set: {
              availableBalancePaise: { $add: ["$availableBalancePaise", grossPaise] },
              lifetimeWithdrawnPaise: { $subtract: ["$lifetimeWithdrawnPaise", netPaise] },
              walletVersion: { $add: [{ $ifNull: ["$walletVersion", 0] }, 1] },
            },
          },
        ],
        { session, new: true }
      );
      if (!wallet) {
        const err = new Error(
          "Lifetime-withdrawn mismatch: cannot unwind this payout cleanly. Escalate to engineering — do not retry blindly."
        );
        err.statusCode = 409;
        throw err;
      }

      // Reverse the deduction debits with NEW credit rows (originals kept).
      if (commissionPaise > 0) {
        try {
          await WalletTransaction.create(
            [
              {
                technicianId: existing.technicianId,
                amountPaise: commissionPaise,
                amount: paiseToRupees(commissionPaise),
                type: "credit",
                source: "adjustment",
                withdrawalId: existing._id,
                idempotencyKey: `withdrawal-commission-reversal:${existing._id}`,
                note: `Commission reversal for reverted withdrawal #${existing._id}: ${reason}`,
              },
            ],
            { session }
          );
        } catch (creditErr) {
          if (creditErr?.code !== 11000) throw creditErr;
        }
      }
      if (penaltyPaise > 0) {
        try {
          await WalletTransaction.create(
            [
              {
                technicianId: existing.technicianId,
                amountPaise: penaltyPaise,
                amount: paiseToRupees(penaltyPaise),
                type: "credit",
                source: "penalty",
                withdrawalId: existing._id,
                idempotencyKey: `withdrawal-penalty-reversal:${existing._id}`,
                note: `Penalty reversal for reverted withdrawal #${existing._id}: ${reason}`,
              },
            ],
            { session }
          );
        } catch (creditErr) {
          if (creditErr?.code !== 11000) throw creditErr;
        }
      }

      // NEW compensating ledger entry; the original technician_payout row is kept.
      const reversal = await postLedgerEntry({
        type: "technician_payout_reversal",
        direction: "credit",
        amountPaise: netPaise,
        idempotencyKey: `payout:${existing._id}:technician-payout-reversal`,
        refs: { withdrawalId: existing._id, technicianId: existing.technicianId },
        providerReference: bankReturnUtr || existing.utr || null,
        description: "Reversal of wrongly-recorded manual payout (funds returned to wallet)",
        session,
      });
      if (!reversal.created) {
        const err = new Error("Reversal ledger entry already exists for this withdrawal.");
        err.statusCode = 409;
        throw err;
      }
    });

    await writeAuditLog({
      actor: req.user.userId,
      actorRole: req.user.role,
      action: "PAYOUT_REVERTED",
      targetType: "WithdrawalRequest",
      targetId: reverted._id,
      before: { status: "paid", utr: existing.utr || null },
      after: { status: "failed", reason, bankReturnUtr },
      reason,
      metadata: { ip },
    });

    try {
      await Notification.create({
        recipientId: existing.technicianId,
        recipientType: "technician",
        eventType: "WITHDRAWAL_FAILED",
        title: "Payout record corrected",
        body: `Your payout record of ₹${paiseToRupees(netPaise).toFixed(2)} was corrected by Admin and the amount has been returned to your wallet. Reason: ${reason}.`,
        data: { type: "PAYOUT_REVERTED", withdrawalId: String(existing._id) },
        category: "finance",
      });
    } catch (notifyErr) {
      console.warn("[revertPaidWithdrawal] technician notify failed:", notifyErr.message);
    }

    return res.status(200).json({
      success: true,
      message: "Payment record reverted; amount returned to wallet.",
      result: {
        withdrawalId: reverted._id,
        status: reverted.status,
        refundedToWalletPaise: grossPaise,
        refundedToWallet: paiseToRupees(grossPaise),
      },
    });
  } catch (error) {
    console.error("revertPaidWithdrawal Error:", error);
    if (error?.code === 11000) {
      return res.status(409).json({
        success: false,
        message: "Concurrent revert detected. Refresh the withdrawal and retry.",
      });
    }
    return res.status(error.statusCode || 500).json({ success: false, message: error.message });
  } finally {
    session.endSession();
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

    // Same amount discipline as technician-initiated requests: global
    // min/max limits plus the maintenance floor that must stay in the wallet.
    const autoConfig = await getAutoPayoutConfig();
    const minWithdrawalPaise = Math.max(0, toPaise(autoConfig.minWithdrawalAmountPaise ?? 10000));
    if (amountPaiseNum < minWithdrawalPaise) {
      return res.status(400).json({
        success: false,
        message: `Amount is below the minimum withdrawal of ₹${paiseToRupees(minWithdrawalPaise).toFixed(2)}.`,
      });
    }
    const maxWithdrawalRupees = Number(process.env.MAX_WITHDRAWAL_AMOUNT);
    const maxWithdrawalPaise = Number.isFinite(maxWithdrawalRupees) && maxWithdrawalRupees > 0
      ? Math.round(maxWithdrawalRupees * 100)
      : 50000 * 100;
    if (amountPaiseNum > maxWithdrawalPaise) {
      return res.status(400).json({
        success: false,
        message: `Amount exceeds the maximum withdrawal limit of ₹${paiseToRupees(maxWithdrawalPaise).toFixed(2)} per request.`,
      });
    }
    const payoutSettings = resolveTechPayoutSettings(tech.toObject ? tech.toObject() : tech, autoConfig);
    const maintenanceFloorPaise = Math.max(0, toPaise(payoutSettings.minimumMaintenancePaise ?? 10000));
    const availablePaise = toPaise(tech.availableBalancePaise ?? 0);
    const maxWithdrawablePaise = Math.max(0, availablePaise - maintenanceFloorPaise);
    if (amountPaiseNum > maxWithdrawablePaise) {
      return res.status(400).json({
        success: false,
        message: `Amount exceeds the withdrawable balance of ₹${paiseToRupees(maxWithdrawablePaise).toFixed(2)} (maintenance floor ₹${paiseToRupees(maintenanceFloorPaise).toFixed(2)} must remain).`,
      });
    }

    // Same eligibility gates as mark-paid: complaint block, outstanding
    // dues, verified + fingerprinted bank details.
    try {
      await assertManualPayable(technicianId);
    } catch (gateErr) {
      return res.status(gateErr.statusCode || 422).json({ success: false, message: gateErr.message });
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

    // Reserve + request + debit atomically in ONE transaction (Stage 1 fix:
    // previously these passed {session} without withTransaction, so a crash
    // between reserve and create left the balance frozen).
    let withdrawal;
    try {
      await session.withTransaction(async () => {
        const reserved = await TechnicianProfile.findOneAndUpdate(
          { _id: technicianId, availableBalancePaise: { $gte: amountPaiseNum } },
          [
            {
              $set: {
                availableBalancePaise: { $subtract: ["$availableBalancePaise", amountPaiseNum] },
                reservedBalancePaise: { $add: ["$reservedBalancePaise", amountPaiseNum] },
                walletVersion: { $add: [{ $ifNull: ["$walletVersion", 0] }, 1] },
              },
            },
          ],
          { new: true, session }
        );
        if (!reserved) {
          const err = new Error("Insufficient technician balance");
          err.statusCode = 400;
          throw err;
        }

        [withdrawal] = await WithdrawalRequest.create(
          [
            {
              technicianId,
              amount: paiseToRupees(amountPaiseNum),
              amountPaise: amountPaiseNum,
              requestedAmountPaise: amountPaiseNum,
              netPayoutAmountPaise: amountPaiseNum,
              status: needsDual ? "requested" : "approved",
              origin: "admin_direct",
              requiresApproval: needsDual,
              approvedBy: needsDual ? null : req.user.userId,
              approvedAt: needsDual ? null : new Date(),
              decidedAt: needsDual ? null : new Date(),
              decidedBy: needsDual ? null : req.user.userId,
              initiatedBy: { actorType: "admin", actorId: req.user.userId },
              // Omitted (undefined) when no key was sent — see the schema
              // note: explicit null collides across keyless requests.
              clientIdempotencyKey: clientIdempotencyKey || undefined,
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
      });
    } catch (createErr) {
      // Transaction aborted atomically — no manual rollback needed. A
      // concurrent active payout trips the unique partial index.
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

    // Stage 1 manual flow: below-threshold payouts are pre-approved here; the
    // admin transfers the money offline, then records it via mark-paid.
    // NO automated provider call.
    return res.status(201).json({
      success: true,
      message: "Manual payout recorded as approved. Transfer the amount offline, then mark it paid with the bank UTR.",
      result: {
        withdrawalId: withdrawal._id,
        status: "approved",
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

/**
 * 🛠️ Admin resolution of a legacy `manual_review` payout. Nothing runs
 * automatically and no provider is involved — the admin decides "complete"
 * (force paid, money confirmed via bank records) or "revert" (refund reserve).
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
 * `requested`. Stage 1 manual flow: flips requested->approved (compare-and-set);
 * the approving admin then transfers offline and records via mark-paid.
 * No automated provider call.
 */
export const approveAdminManualPayout = async (req, res) => {
  try {
    ensureAdmin(req);
    const { id } = req.params;

    const w = await WithdrawalRequest.findById(id)
      .select("origin requiresApproval status initiatedBy")
      .lean();
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

    const approved = await WithdrawalRequest.findOneAndUpdate(
      { _id: id, origin: "admin_direct", status: "requested" },
      {
        $set: {
          status: "approved",
          approvedAt: new Date(),
          approvedBy: req.user.userId,
          decidedAt: new Date(),
          decidedBy: req.user.userId,
        },
      },
      { new: true }
    );
    if (!approved) {
      return res.status(409).json({
        success: false,
        message: "Payout is no longer awaiting approval (concurrent decision). Refresh and retry.",
        result: { withdrawalId: id },
      });
    }

    await writeAuditLog({
      actor: req.user.userId,
      actorRole: req.user.role,
      action: "ADMIN_MANUAL_PAYOUT_APPROVED",
      targetType: "WithdrawalRequest",
      targetId: id,
      before: { status: "requested" },
      after: { status: "approved", approvedBy: req.user.userId },
    });

    return res.status(200).json({
      success: true,
      message: "Manual payout approved. Transfer the amount offline, then mark it paid with the bank UTR.",
      result: {
        withdrawalId: id,
        status: "approved",
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
 * 🔍 Detailed Payout Audit & Status View (Admin).
 * Stage 1 manual flow: includes DECRYPTED bank details for the transfer
 * (this endpoint only — never in list/export/logs), audit-logged per view.
 * Provider gateway/outbox sections removed (no automated provider).
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

    const walletTx = await WalletTransaction.findOne({ withdrawalId: id, source: "withdraw" }).lean();
    // Fixed: AuditLog.targetId is an ObjectId (Schemas/AuditLog.js:33-36);
    // the old String(id) query silently missed every log row.
    const auditLogs = await AuditLog.find({ targetId: withdrawal._id }).sort({ createdAt: -1 }).lean();

    // Decrypted bank details — admin-only, this endpoint only.
    const profileId = withdrawal.technicianId?._id || withdrawal.technicianId;
    let bankDetails = null;
    try {
      const kyc = await TechnicianKyc.findOne({ technicianId: profileId })
        .select("bankDetails encryptedDek bankVerified bankVerificationStatus")
        .lean();
      if (kyc) {
        const dek = await getDekForKycDoc(kyc);
        const plain = decryptBankDetails(kyc.bankDetails, dek) || {};
        bankDetails = {
          accountHolderName: plain.accountHolderName || null,
          accountNumber: plain.accountNumber || null,
          ifscCode: plain.ifscCode || null,
          upiId: plain.upiId || null,
          bankName: plain.bankName || kyc.bankDetails?.bankName || null,
          branchName: plain.branchName || kyc.bankDetails?.branchName || null,
          bankVerified: kyc.bankVerified || false,
          bankVerificationStatus: kyc.bankVerificationStatus || "pending",
        };
      }
    } catch (bankErr) {
      console.warn("[getWithdrawalDetails] bank decrypt failed:", bankErr.message);
      bankDetails = null;
    }

    await writeAuditLog({
      actor: req.user.userId,
      actorRole: req.user.role,
      action: "BANK_DETAILS_VIEWED",
      targetType: "WithdrawalRequest",
      targetId: withdrawal._id,
      after: { bankDetailsServed: !!bankDetails },
      metadata: { adminId: req.user.userId, withdrawalId: String(withdrawal._id), ip: req.ip || null },
    });

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
        },
        bankDetails,
        auditHistory: auditLogs,
      },
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
};

/**
 * @desc    Admin technician wallet overview — inspect any technician's wallet
 *          and payout history before selecting them for a direct payout.
 *          Read-only: balances, blocks/dues/KYC summary (no secrets),
 *          active withdrawal, recent withdrawals and wallet transactions.
 */
export const getTechnicianWalletOverview = async (req, res) => {
  try {
    ensureAdmin(req);
    const { technicianId } = req.params;
    if (!technicianId || !isValidObjectId(technicianId)) {
      return res.status(400).json({ success: false, message: "Valid technicianId is required" });
    }

    const tech = await TechnicianProfile.findById(technicianId)
      .select("userId availableBalancePaise reservedBalancePaise reserveBalancePaise outstandingDuesPaise lifetimeEarnedPaise lifetimeWithdrawnPaise walletVersion payoutBlocked payoutBlockedReason payoutSettings workStatus status")
      .populate({ path: "userId", select: "fname lname mobileNumber email status" })
      .lean();
    if (!tech) {
      return res.status(404).json({ success: false, message: "Technician not found" });
    }

    const [autoConfig, kyc, hasBlock, activeWithdrawal, recentWithdrawals, recentTransactions] = await Promise.all([
      getAutoPayoutConfig(),
      TechnicianKyc.findOne({ technicianId })
        .select("bankVerified bankVerificationStatus bankDetailsFingerprint")
        .lean(),
      hasActivePayoutBlock(technicianId),
      WithdrawalRequest.findOne({
        technicianId,
        status: { $in: ["pending", "requested", "approved", "processing", "manual_review"] },
      })
        .select("_id status origin amountPaise requestedAmountPaise netPayoutAmountPaise createdAt")
        .lean(),
      WithdrawalRequest.find({ technicianId })
        .select("_id status origin amountPaise requestedAmountPaise netPayoutAmountPaise payoutMode utr createdAt paidAt")
        .sort({ createdAt: -1 })
        .limit(10)
        .lean(),
      WalletTransaction.find({ technicianId })
        .select("_id type source amountPaise withdrawalId idempotencyKey createdAt")
        .sort({ createdAt: -1 })
        .limit(10)
        .lean(),
    ]);

    const settings = resolveTechPayoutSettings(tech, autoConfig);
    const maintenanceFloorPaise = Math.max(0, toPaise(settings.minimumMaintenancePaise ?? 10000));
    const availablePaise = toPaise(tech.availableBalancePaise ?? 0);

    return res.json({
      success: true,
      result: {
        technician: {
          _id: tech._id,
          user: tech.userId || null,
          workStatus: tech.workStatus || null,
          status: tech.status || null,
        },
        wallet: {
          availableBalancePaise: availablePaise,
          reservedBalancePaise: toPaise(tech.reservedBalancePaise ?? 0),
          reserveBalancePaise: toPaise(tech.reserveBalancePaise ?? 0),
          outstandingDuesPaise: toPaise(tech.outstandingDuesPaise ?? 0),
          lifetimeEarnedPaise: toPaise(tech.lifetimeEarnedPaise ?? 0),
          lifetimeWithdrawnPaise: toPaise(tech.lifetimeWithdrawnPaise ?? 0),
          walletVersion: tech.walletVersion ?? 0,
        },
        eligibility: {
          payoutBlocked: Boolean(tech.payoutBlocked),
          payoutBlockedReason: tech.payoutBlockedReason || null,
          hasActivePayoutBlock: Boolean(hasBlock),
          outstandingDuesPaise: toPaise(tech.outstandingDuesPaise ?? 0),
          bankVerified: kyc ? (kyc.bankVerified === true || kyc.bankVerificationStatus === "approved") : false,
          bankVerificationStatus: kyc?.bankVerificationStatus || "pending",
          hasBankFingerprint: Boolean(kyc?.bankDetailsFingerprint),
          hasActiveWithdrawal: Boolean(activeWithdrawal),
        },
        payoutSettings: settings,
        maintenanceFloorPaise,
        maxWithdrawablePaise: Math.max(0, availablePaise - maintenanceFloorPaise),
        activeWithdrawal: activeWithdrawal || null,
        recentWithdrawals,
        recentTransactions,
      },
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
};
