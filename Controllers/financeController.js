import mongoose from "mongoose";
import Payment from "../Schemas/Payment.js";
import ServiceBooking from "../Schemas/ServiceBooking.js";
import WalletTransaction from "../Schemas/WalletTransaction.js";
import WithdrawalRequest from "../Schemas/WithdrawalRequest.js";
import TechnicianProfile from "../Schemas/TechnicianProfile.js";
import PlatformLedgerEntry from "../Schemas/PlatformLedgerEntry.js";
import { toPaise, paiseToRupees } from "../Utils/money.js";
import { buildPaymentDetailsSummary } from "../Utils/paymentReadModel.js";

/**
 * 💹 FINANCE TRACKING API
 *
 * Money model per booking (service):
 *   totalAmount      = serviceAmount + gstAmount + tipAmount   ← what customer pays
 *   commissionAmount = serviceAmount × commission%             ← company revenue
 *   gstAmount        = serviceAmount × gst%                    ← govt liability (pass-through)
 *   technicianAmount = (serviceAmount − commission) + tipAmount ← owed to technician
 *
 * The platform holds all money first ("admin holds full amount").
 * The technician earns ledger credits at settlement (job + tip rows), and
 * money actually leaves the admin account only when a withdrawal is APPROVED
 * and PAID via Razorpay X — the approved amount is already net of commission.
 */

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const pick = (row, key) => row?.[0]?.[key] ?? 0;

/* =====================================================
   1️⃣ FINANCE SUMMARY — every amount in one place
===================================================== */

export const getFinanceSummary = async (req, res) => {
  try {
    const match = { status: "success" };

    // Canonical aggregates are PAISE (integer); rupee mirrors kept for display.
    const paymentsFacet = await Payment.aggregate([
      { $match: match },
      {
        $group: {
          _id: null,
          collectedPaise: {
            $sum: { $ifNull: ["$totalAmountPaise", { $multiply: [{ $ifNull: ["$totalAmount", 0] }, 100] }] },
          },
          servicePaise: {
            $sum: {
              $ifNull: ["$baseAmountPaise", { $multiply: [{ $ifNull: ["$serviceAmount", "$baseAmount", 0] }, 100] }],
            },
          },
          gstPaise: {
            $sum: { $ifNull: ["$gstAmountPaise", { $multiply: [{ $ifNull: ["$gstAmount", 0] }, 100] }] },
          },
          tipPaise: {
            $sum: { $ifNull: ["$tipAmountPaise", { $multiply: [{ $ifNull: ["$tipAmount", 0] }, 100] }] },
          },
          commissionPaise: {
            $sum: { $ifNull: ["$commissionAmountPaise", { $multiply: [{ $ifNull: ["$commissionAmount", 0] }, 100] }] },
          },
          technicianPayablePaise: {
            $sum: { $ifNull: ["$technicianAmountPaise", { $multiply: [{ $ifNull: ["$technicianAmount", 0] }, 100] }] },
          },
          count: { $sum: 1 },
        },
      },
    ]);

    // Service booking payment status breakdown (paid vs unpaid/pending)
    const bookingPaymentsFacet = await ServiceBooking.aggregate([
      {
        $group: {
          _id: { $ifNull: ["$paymentStatus", "pending"] },
          count: { $sum: 1 },
          totalAmountPaise: {
            $sum: { $ifNull: ["$totalAmountPaise", { $multiply: [{ $ifNull: ["$totalAmount", 0] }, 100] }] }
          },
          baseAmountPaise: {
            $sum: { $ifNull: ["$baseAmountPaise", { $multiply: [{ $ifNull: ["$baseAmount", 0] }, 100] }] }
          },
          gstAmountPaise: {
            $sum: { $ifNull: ["$gstAmountPaise", { $multiply: [{ $ifNull: ["$gstAmount", 0] }, 100] }] }
          },
          commissionAmountPaise: {
            $sum: { $ifNull: ["$commissionAmountPaise", { $multiply: [{ $ifNull: ["$commissionAmount", 0] }, 100] }] }
          }
        }
      }
    ]);

    const withdrawalsFacet = await WithdrawalRequest.aggregate([
      {
        $group: {
          _id: "$status",
          sumPaise: { $sum: { $ifNull: ["$amountPaise", { $multiply: [{ $ifNull: ["$amount", 0] }, 100] }] } },
          count: { $sum: 1 },
        },
      },
    ]);

    // 🏦 Platform ledger — the single source of truth for money in/out
    const ledgerFacet = await PlatformLedgerEntry.aggregate([
      { $group: { _id: "$type", direction: { $first: "$direction" }, totalPaise: { $sum: "$amountPaise" } } },
    ]);
    const ledgerTotal = (types) =>
      ledgerFacet.filter((e) => types.includes(e._id)).reduce((acc, e) => acc + (e.totalPaise || 0), 0);
    const customerPaymentsIn = ledgerTotal(["customer_payment"]);
    const payoutsOut = ledgerTotal(["technician_payout"]);
    const platformCommissionIn = ledgerTotal(["platform_commission", "commission_income", "commission_deduction"]);
    const refundsOut = ledgerTotal(["customer_refund", "refund"]);
    const gatewayFees = ledgerTotal(["gateway_fee"]);
    const gatewayFeeTax = ledgerTotal(["gateway_fee_tax"]);
    const payoutFees = ledgerTotal(["payout_fee"]);
    const chargebacks = ledgerTotal(["chargeback"]);
    const cancellationFeesIn = ledgerTotal(["cancellation_fee"]);
    const ledgerBalancePaise = customerPaymentsIn - payoutsOut - refundsOut - gatewayFees - gatewayFeeTax - payoutFees - chargebacks;

    // Net platform revenue — NEVER "successful payments − technician withdrawals".
    // Commission income minus fees, taxes, chargebacks and refunds.
    const netPlatformRevenuePaise =
      platformCommissionIn - gatewayFees - gatewayFeeTax - payoutFees - chargebacks - refundsOut;

    // Operational visibility: at-risk / expired jobs and penalty receivables
    const now = new Date();
    const [atRiskJobs, expiredJobs, penaltyReceivableFacet] = await Promise.all([
      ServiceBooking.countDocuments({
        status: { $in: ["accepted", "on_the_way"] },
        bookingType: "schedule",
        scheduledAt: { $gte: now, $lte: new Date(now.getTime() + 20 * 60 * 1000) },
      }),
      ServiceBooking.countDocuments({ status: "expired" }),
      ServiceBooking.aggregate([
        { $match: { technicianPenaltyPaise: { $gt: 0 } } },
        {
          $group: {
            _id: null,
            penaltyPaise: { $sum: "$technicianPenaltyPaise" },
            debitedPaise: { $sum: "$technicianPenaltyDebitedPaise" },
          },
        },
      ]),
    ]);
    const penaltyTotals = penaltyReceivableFacet[0] || { penaltyPaise: 0, debitedPaise: 0 };
    const penaltyOutstandingPaise = penaltyTotals.penaltyPaise - penaltyTotals.debitedPaise;

    const statusMap = new Map(withdrawalsFacet.map((s) => [s._id, s]));
    const sumOf = (...keys) => keys.reduce((acc, k) => acc + (statusMap.get(k)?.sumPaise || 0), 0);
    const countOf = (...keys) => keys.reduce((acc, k) => acc + (statusMap.get(k)?.count || 0), 0);

    const bookingStatusMap = new Map(bookingPaymentsFacet.map((b) => [b._id, b]));
    const paidBooking = bookingStatusMap.get("paid") || {};
    const pendingBooking = bookingStatusMap.get("pending") || bookingStatusMap.get("unpaid") || {};
    const failedBooking = bookingStatusMap.get("failed") || {};

    const paidServicesPaise = paidBooking.totalAmountPaise || 0;
    const unpaidServicesPaise = pendingBooking.totalAmountPaise || 0;

    const p = paymentsFacet[0] || {};
    const collectedPaise = toPaise(p.collectedPaise ?? 0);
    const servicePaise = toPaise(p.servicePaise ?? 0);
    const gstPaise = toPaise(p.gstPaise ?? 0);
    const tipPaise = toPaise(p.tipPaise ?? 0);
    const commissionPaise = toPaise(p.commissionPaise ?? 0);
    const technicianPayablePaise = toPaise(p.technicianPayablePaise ?? 0);
    const paidOutPaise = sumOf("paid");
    const heldPaise = collectedPaise - paidOutPaise;

    res.json({
      success: true,
      result: {
        services: {
          paid: {
            count: paidBooking.count || 0,
            totalAmountPaise: paidServicesPaise,
            totalAmount: paiseToRupees(paidServicesPaise),
            baseAmount: paiseToRupees(paidBooking.baseAmountPaise || 0),
            gstAmount: paiseToRupees(paidBooking.gstAmountPaise || 0),
            commissionAmount: paiseToRupees(paidBooking.commissionAmountPaise || 0),
          },
          unpaid: {
            count: pendingBooking.count || 0,
            totalAmountPaise: unpaidServicesPaise,
            totalAmount: paiseToRupees(unpaidServicesPaise),
            baseAmount: paiseToRupees(pendingBooking.baseAmountPaise || 0),
            gstAmount: paiseToRupees(pendingBooking.gstAmountPaise || 0),
            commissionAmount: paiseToRupees(pendingBooking.commissionAmountPaise || 0),
          },
          failed: {
            count: failedBooking.count || 0,
            totalAmount: paiseToRupees(failedBooking.totalAmountPaise || 0),
          },
        },
        summary: {
          totalCollectedPaise: collectedPaise,                       // money in (all payments)
          totalCollected: paiseToRupees(collectedPaise),
          totalServiceAmountPaise: servicePaise,                     // before tax & tip
          totalGstPaise: gstPaise,                                   // govt liability
          totalTipPaise: tipPaise,                                   // 100% owed to technicians
          totalCommissionPaise: commissionPaise,                     // platform revenue
          totalPayableToTechnicianPaise: technicianPayablePaise,     // tech net share + tips
          totalPaidOutToTechnicianPaise: paidOutPaise,               // via paid payouts
          totalHeldByPlatformPaise: heldPaise,                       // collected − paid out
          paymentCount: p.count || 0,
        },
        ledger: {
          customerPaymentsInPaise: customerPaymentsIn,
          customerPaymentsIn: paiseToRupees(customerPaymentsIn),
          platformCommissionInPaise: platformCommissionIn,
          platformCommissionIn: paiseToRupees(platformCommissionIn),
          payoutsOutPaise: payoutsOut,
          payoutsOut: paiseToRupees(payoutsOut),
          refundsOutPaise: refundsOut,
          refundsOut: paiseToRupees(refundsOut),
          gatewayFeesPaise: gatewayFees,
          gatewayFees: paiseToRupees(gatewayFees),
          gatewayFeeTaxPaise: gatewayFeeTax,
          gatewayFeeTax: paiseToRupees(gatewayFeeTax),
          payoutFeesPaise: payoutFees,
          payoutFees: paiseToRupees(payoutFees),
          chargebacksPaise: chargebacks,
          chargebacks: paiseToRupees(chargebacks),
          cancellationFeesCollectedPaise: cancellationFeesIn,
          cancellationFeesCollected: paiseToRupees(cancellationFeesIn),
          netPlatformRevenuePaise: netPlatformRevenuePaise,
          netPlatformRevenue: paiseToRupees(netPlatformRevenuePaise),
          ledgerBalancePaise: ledgerBalancePaise,
          ledgerBalance: paiseToRupees(ledgerBalancePaise),
          // should equal totalCollectedPaise − totalPaidOutToTechnicianPaise − refundsOutPaise − fees
          balanceConsistency:
            ledgerBalancePaise ===
            collectedPaise - paidOutPaise - refundsOut - gatewayFees - gatewayFeeTax - payoutFees - chargebacks,
        },
        operations: {
          atRiskScheduledJobs: atRiskJobs,
          expiredBookings: expiredJobs,
          technicianPenaltyPaise: penaltyTotals.penaltyPaise,
          technicianPenaltyDebitedPaise: penaltyTotals.debitedPaise,
          technicianPenaltyOutstandingPaise: penaltyOutstandingPaise,
        },
        withdrawals: {
          pending: { count: countOf("pending", "requested"), amountPaise: sumOf("pending", "requested"), amount: paiseToRupees(sumOf("pending", "requested")) },
          approved: { count: countOf("approved"), amountPaise: sumOf("approved"), amount: paiseToRupees(sumOf("approved")) },
          paid: { count: countOf("paid"), amountPaise: sumOf("paid"), amount: paiseToRupees(sumOf("paid")) },
          rejected: { count: countOf("rejected"), amountPaise: sumOf("rejected"), amount: paiseToRupees(sumOf("rejected")) },
          processing: { count: countOf("processing"), amountPaise: sumOf("processing"), amount: paiseToRupees(sumOf("processing")) },
          cancelled: { count: countOf("cancelled"), amountPaise: sumOf("cancelled"), amount: paiseToRupees(sumOf("cancelled")) },
          failed: { count: countOf("failed"), amountPaise: sumOf("failed"), amount: paiseToRupees(sumOf("failed")) },
          manualReview: { count: countOf("manual_review"), amountPaise: sumOf("manual_review"), amount: paiseToRupees(sumOf("manual_review")) },
        },
        formula: {
          totalAmount: "serviceAmount + gstAmount + tipAmount",
          technicianAmount: "(serviceAmount − commissionAmount) + tipAmount",
          platformRevenue: "commissionAmount (GST is pass-through)",
          ledgerBalance: "customerPayments − payouts − refunds",
        },
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message, result: { error: error.message } });
  }
};

/* =====================================================
   2️⃣ FINANCE BREAKDOWN — per booking, every split
===================================================== */

export const getFinanceBreakdown = async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit, 10) || 25, 100);
    const skip = (page - 1) * limit;

    const query = {};
    if (req.query.status && String(req.query.status).trim()) {
      query.status = String(req.query.status).trim();
    }
    if (req.query.paymentStatus && String(req.query.paymentStatus).trim()) {
      query.paymentStatus = String(req.query.paymentStatus).trim();
    }
    if (req.query.technicianId && mongoose.Types.ObjectId.isValid(req.query.technicianId)) {
      query.technicianId = req.query.technicianId;
    }
    if (req.query.from || req.query.to) {
      query.createdAt = {};
      if (req.query.from) query.createdAt.$gte = new Date(req.query.from);
      if (req.query.to) {
        const end = new Date(req.query.to);
        end.setHours(23, 59, 59, 999);
        query.createdAt.$lte = end;
      }
    }

    const [rows, total] = await Promise.all([
      ServiceBooking.find(query)
        .select(
          "_id customerId serviceId technicianId baseAmount gstPercentage gstAmount tipAmount " +
          "commissionPercentage commissionAmount technicianAmount totalAmount paymentStatus status " +
          "paymentProvider paymentMode paymentProviderPaymentId paidAmount paidAmountPaise " +
          "settlementStatus settledAt paymentId createdAt"
        )
        .populate("serviceId", "serviceName serviceType")
        .populate({
          path: "technicianId",
          select: "userId",
          populate: { path: "userId", select: "fname lname mobileNumber" },
        })
        .populate({
          path: "paymentId",
          select: "provider mode providerPaymentId offlineDetails verifiedAt status"
        })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      ServiceBooking.countDocuments(query),
    ]);

    res.json({
      success: true,
      result: rows.map((b) => {
        const paymentDoc = b.paymentId || null;
        const provider = b.paymentProvider || paymentDoc?.provider || (b.paymentStatus === "paid" ? "razorpay" : null);
        const mode = b.paymentMode || paymentDoc?.mode || (b.paymentStatus === "paid" ? "online" : null);
        const ref = b.paymentProviderPaymentId || paymentDoc?.providerPaymentId || paymentDoc?.offlineDetails?.transactionReference || null;
        const summary = paymentDoc
          ? buildPaymentDetailsSummary(paymentDoc)
          : (b.paymentStatus === "paid" ? `Paid via ${mode ? mode.toUpperCase() : "Online"}${ref ? ` (Ref: ${ref})` : ""}` : null);

        return {
          bookingId: b._id,
          service: b.serviceId?.serviceName || null,
          technician: b.technicianId?.userId
            ? `${b.technicianId.userId.fname || ""} ${b.technicianId.userId.lname || ""}`.trim()
            : null,
          status: b.status,
          paymentStatus: b.paymentStatus,
          paymentProvider: provider,
          paymentMode: mode,
          paymentReference: ref,
          paymentDetailsSummary: summary,
          offlineDetails: paymentDoc?.offlineDetails || null,
          settlementStatus: b.settlementStatus,
          settledAt: b.settledAt,
          serviceAmount: round2(b.baseAmount),
          gstPercentage: b.gstPercentage || 0,
          gstAmount: round2(b.gstAmount || 0),
          tipAmount: round2(b.tipAmount || 0),
          commissionPercentage: b.commissionPercentage || 0,
          commissionAmount: round2(b.commissionAmount || 0),
          technicianAmount: round2(b.technicianAmount || 0),
          paidAmount: round2(b.paidAmount || 0),
          createdAt: b.createdAt,
        };
      }),
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) || 1 },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message, result: { error: error.message } });
  }
};

/* =====================================================
   3️⃣ PAYMENTS LEDGER — every customer payment & split
===================================================== */

export const getPaymentsLedger = async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit, 10) || 25, 100);
    const skip = (page - 1) * limit;

    const query = {};
    if (req.query.status && String(req.query.status).trim()) {
      query.status = String(req.query.status).trim();
    }
    if (req.query.from || req.query.to) {
      query.createdAt = {};
      if (req.query.from) query.createdAt.$gte = new Date(req.query.from);
      if (req.query.to) {
        const end = new Date(req.query.to);
        end.setHours(23, 59, 59, 999);
        query.createdAt.$lte = end;
      }
    }

    const [rows, total] = await Promise.all([
      Payment.find(query)
        .select(
          "_id bookingId itemType provider mode status serviceAmount baseAmount gstPercentage gstAmount tipAmount " +
          "totalAmount commissionAmount technicianAmount commissionRuleSource providerOrderId " +
          "providerPaymentId offlineDetails verifiedAt createdAt"
        )
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Payment.countDocuments(query),
    ]);

    res.json({
      success: true,
      result: rows.map((p) => ({
        paymentId: p._id,
        bookingId: p.bookingId,
        itemType: p.itemType,
        provider: p.provider || "razorpay",
        mode: p.mode || "online",
        status: p.status,
        serviceAmount: round2(p.serviceAmount ?? p.baseAmount ?? 0),
        gstPercentage: p.gstPercentage || 0,
        gstAmount: round2(p.gstAmount || 0),
        tipAmount: round2(p.tipAmount || 0),
        totalAmount: round2(p.totalAmount || 0),
        commissionAmount: round2(p.commissionAmount || 0),
        technicianAmount: round2(p.technicianAmount || 0),
        commissionRuleSource: p.commissionRuleSource,
        providerOrderId: p.providerOrderId,
        providerPaymentId: p.providerPaymentId,
        paymentDetailsSummary: buildPaymentDetailsSummary(p),
        offlineDetails: p.offlineDetails || null,
        paidAt: p.verifiedAt,
        createdAt: p.createdAt,
      })),
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) || 1 },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message, result: { error: error.message } });
  }
};

/* =====================================================
   4️⃣ PER-TECHNICIAN FINANCE DETAIL (admin)
===================================================== */

export const getTechnicianFinanceDetail = async (req, res) => {
  try {
    const { technicianId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(technicianId)) {
      return res.status(400).json({ success: false, message: "Invalid technicianId" });
    }

    const tech = await TechnicianProfile.findById(technicianId)
      .populate("userId", "fname lname mobileNumber email")
      .lean();
    if (!tech) return res.status(404).json({ success: false, message: "Technician not found" });

    // Completed+paid bookings (the basis of earnings)
    const bookingsAgg = await ServiceBooking.aggregate([
      {
        $match: {
          technicianId: new mongoose.Types.ObjectId(technicianId),
          paymentStatus: "paid",
          status: "completed",
        },
      },
      {
        $group: {
          _id: null,
          count: { $sum: 1 },
          serviceAmount: { $sum: "$baseAmount" },
          gst: { $sum: { $ifNull: ["$gstAmount", 0] } },
          tip: { $sum: { $ifNull: ["$tipAmount", 0] } },
          commission: { $sum: { $ifNull: ["$commissionAmount", 0] } },
          earned: { $sum: { $ifNull: ["$technicianAmount", 0] } },
          settled: {
            $sum: { $cond: [{ $eq: ["$settlementStatus", "settled"] }, 1, 0] },
          },
        },
      },
    ]);

    const ledger = await WalletTransaction.aggregate([
      { $match: { technicianId: new mongoose.Types.ObjectId(technicianId) } },
      {
        $group: {
          _id: "$source",
          credit: { $sum: { $cond: [{ $eq: ["$type", "credit"] }, "$amount", 0] } },
          debit: { $sum: { $cond: [{ $eq: ["$type", "debit"] }, "$amount", 0] } },
          count: { $sum: 1 },
        },
      },
    ]);

    const ledgerMap = new Map(ledger.map((l) => [l._id, l]));
    const totalCredit = ledger.reduce((acc, l) => acc + (l.credit || 0), 0);
    const totalDebit = ledger.reduce((acc, l) => acc + (l.debit || 0), 0);

    const b = bookingsAgg[0] || {};

    res.json({
      success: true,
      result: {
        technician: {
          technicianId: tech._id,
          name: tech.userId ? `${tech.userId.fname || ""} ${tech.userId.lname || ""}`.trim() : null,
          mobile: tech.userId?.mobileNumber || null,
          walletBalance: tech.walletBalance || 0,
          workStatus: tech.workStatus,
        },
        bookings: {
          count: b.count || 0,
          settledCount: b.settled || 0,
          serviceAmount: round2(b.serviceAmount || 0),
          gst: round2(b.gst || 0),
          tip: round2(b.tip || 0),
          commission: round2(b.commission || 0),
          earned: round2(b.earned || 0),
        },
        ledger: {
          jobEarnings: round2(ledgerMap.get("job")?.credit || 0),
          tips: round2(ledgerMap.get("tip")?.credit || 0),
          bonuses: round2(ledgerMap.get("bonus")?.credit || 0),
          adjustments: round2(ledgerMap.get("adjustment")?.credit || 0),
          withdrawals: round2((ledgerMap.get("withdraw")?.debit || 0) + (ledgerMap.get("withdraw")?.credit || 0)),
          penalties: round2(ledgerMap.get("penalty")?.debit || 0),
          totalCredited: round2(totalCredit),
          totalDebited: round2(totalDebit),
        },
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message, result: { error: error.message } });
  }
};

/* =====================================================
   5️⃣ MY EARNINGS (technician self-view)
===================================================== */

export const getMyEarnings = async (req, res) => {
  try {
    const techId = req.user?.technicianProfileId;
    if (!techId || !mongoose.Types.ObjectId.isValid(techId)) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const tech = await TechnicianProfile.findById(techId).select("walletBalance").lean();
    if (!tech) return res.status(404).json({ success: false, message: "Technician profile not found" });

    const ledger = await WalletTransaction.aggregate([
      { $match: { technicianId: new mongoose.Types.ObjectId(techId) } },
      {
        $group: {
          _id: null,
          job: { $sum: { $cond: [{ $and: [{ $eq: ["$type", "credit"] }, { $eq: ["$source", "job"] }] }, "$amount", 0] } },
          tips: { $sum: { $cond: [{ $and: [{ $eq: ["$type", "credit"] }, { $eq: ["$source", "tip"] }] }, "$amount", 0] } },
          bonuses: { $sum: { $cond: [{ $and: [{ $eq: ["$type", "credit"] }, { $eq: ["$source", "bonus"] }] }, "$amount", 0] } },
          withdrawn: { $sum: { $cond: [{ $eq: ["$type", "debit"] }, "$amount", 0] } },
        },
      },
    ]);
    const l = ledger[0] || {};
    const totalEarnings = round2((l.job || 0) + (l.tips || 0) + (l.bonuses || 0));

    // Pending withdrawals (reserved, not yet approved)
    const pendingWithdrawals = await WithdrawalRequest.aggregate([
      { $match: { technicianId: new mongoose.Types.ObjectId(techId), status: { $in: ["pending", "requested"] } } },
      { $group: { _id: null, amount: { $sum: "$amount" }, count: { $sum: 1 } } },
    ]);
    const pw = pendingWithdrawals[0] || {};

    res.json({
      success: true,
      result: {
        balance: tech.walletBalance || 0,
        totalEarnings,
        totalJobEarnings: round2(l.job || 0),
        totalTips: round2(l.tips || 0),
        totalBonuses: round2(l.bonuses || 0),
        totalWithdrawn: round2(l.withdrawn || 0),
        pendingWithdrawals: { amount: round2(pw.amount || 0), count: pw.count || 0 },
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message, result: { error: error.message } });
  }
};