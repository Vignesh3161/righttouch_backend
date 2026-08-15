import "dotenv/config";
import mongoose from "mongoose";

import ServiceBooking from "../Schemas/ServiceBooking.js";
import Payment from "../Schemas/Payment.js";
import WalletTransaction from "../Schemas/WalletTransaction.js";
import WithdrawalRequest from "../Schemas/WithdrawalRequest.js";
import PayoutOutbox from "../Schemas/PayoutOutbox.js";
import TechnicianProfile from "../Schemas/TechnicianProfile.js";
import PlatformLedgerEntry from "../Schemas/PlatformLedgerEntry.js";
import ReconciliationException from "../Schemas/ReconciliationException.js";
import { toPaise, rupeesToPaise } from "../Utils/money.js";
import { CALCULATION_VERSION } from "../Utils/money.js";

/**
 * One-time migration to the integer-paise financial engine (v2).
 *
 *   node scripts/migrateFinancialPaise.js
 *
 * Idempotent & safe:
 *   - Creates/ensures all indexes (schema-level).
 *   - Backfills `*Paise` fields on existing docs from their rupee mirrors.
 *   - Builds `financialSnapshot` on bookings that predate the snapshot
 *     feature (rule source = "legacy_backfill"; amounts copied as-is, NOT
 *     re-derived — the split is never silently recomputed).
 *   - Prints a summary; exits non-zero on serious failures.
 *
 * Requirements: MONGO_URI in .env
 */

const run = async () => {
  if (!process.env.MONGO_URI) {
    console.error("✋ MONGO_URI missing from .env");
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 15000 });
  console.log("✅ Connected to MongoDB");

  // ── 1. Ensure all indexes ──
  const models = [
    ServiceBooking,
    Payment,
    WalletTransaction,
    WithdrawalRequest,
    PayoutOutbox,
    TechnicianProfile,
    PlatformLedgerEntry,
    ReconciliationException,
  ];
  for (const model of models) {
    await model.init();
    console.log(`✅ Indexes ensured: ${model.collection.name}`);
  }

  const stats = { bookings: 0, payments: 0, walletTxns: 0, withdrawals: 0, outbox: 0, profiles: 0 };

  // ── 2. Bookings: backfill financialSnapshot + paidAmountPaise ──
  const bookings = await ServiceBooking.find({ financialSnapshot: { $exists: false } })
    .select("_id baseAmount commissionPercentage commissionAmount technicianAmount gstAmount gstPercentage tipAmount paidAmount")
    .cursor({ batchSize: 200 });
  for await (const b of bookings) {
    const basePaise = rupeesToPaise(b.baseAmount ?? 0);
    const gstPaise = rupeesToPaise(b.gstAmount ?? 0);
    const tipPaise = rupeesToPaise(b.tipAmount ?? 0);
    const commissionPaise = rupeesToPaise(b.commissionAmount ?? 0);
    const technicianPaise = rupeesToPaise(b.technicianAmount ?? 0);

    b.financialSnapshot = {
      baseAmountPaise: basePaise,
      discountAmountPaise: 0,
      totalAmountPaise: basePaise + gstPaise + tipPaise,
      gstPercentage: b.gstPercentage ?? 0,
      gstAmountPaise: gstPaise,
      tipAmountPaise: tipPaise,
      commissionPercentage: b.commissionPercentage ?? 0,
      commissionAmountPaise: commissionPaise,
      technicianAmountPaise: technicianPaise,
      commissionRuleSource: "legacy_backfill",
      commissionRuleId: null,
      calculationVersion: CALCULATION_VERSION,
      commissionOverridden: false,
      financialSnapshotAt: new Date(),
    };
    if (b.paidAmount != null) b.paidAmountPaise = rupeesToPaise(b.paidAmount);
    await b.save();
    stats.bookings++;
  }

  // ── 3. Payments ──
  await Payment.updateMany(
    { totalAmountPaise: { $exists: false } },
    [
      {
        $set: {
          totalAmountPaise: { $multiply: [{ $ifNull: ["$totalAmount", 0] }, 100] },
          baseAmountPaise: { $multiply: [{ $ifNull: ["$serviceAmount", "$baseAmount", 0] }, 100] },
          gstAmountPaise: { $multiply: [{ $ifNull: ["$gstAmount", 0] }, 100] },
          tipAmountPaise: { $multiply: [{ $ifNull: ["$tipAmount", 0] }, 100] },
          commissionAmountPaise: { $multiply: [{ $ifNull: ["$commissionAmount", 0] }, 100] },
          technicianAmountPaise: { $multiply: [{ $ifNull: ["$technicianAmount", 0] }, 100] },
          capturedAmountPaise: { $multiply: [{ $ifNull: ["$capturedAmount", "$totalAmount", 0] }, 100] },
          calculationVersion: CALCULATION_VERSION,
        },
      },
    ]
  );
  stats.payments = (await Payment.countDocuments({ totalAmountPaise: { $exists: true } })) - 0;

  // ── 4. Wallet transactions ──
  await WalletTransaction.updateMany(
    { amountPaise: { $exists: false } },
    [{ $set: { amountPaise: { $multiply: [{ $ifNull: ["$amount", 0] }, 100] } } }]
  );

  // ── 5. Withdrawals ──
  await WithdrawalRequest.updateMany(
    { amountPaise: { $exists: false } },
    [{ $set: { amountPaise: { $multiply: [{ $ifNull: ["$amount", 0] }, 100] } } }]
  );

  // ── 6. Payout outbox ──
  await PayoutOutbox.updateMany(
    { amountPaise: { $exists: false } },
    [{ $set: { amountPaise: { $multiply: [{ $ifNull: ["$amount", 0] }, 100] } } }]
  );

  // ── 7. Technician profiles: wallet balances in paise ──
  // lifetimeEarned/Withdrawn are derived from the transaction history
  // (credits = earned, withdraw debits = withdrawn) — never guessed at 0.
  const txnAgg = await WalletTransaction.aggregate([
    {
      $group: {
        _id: "$technicianId",
        earnedPaise: {
          $sum: { $cond: [{ $eq: ["$type", "credit"] }, { $ifNull: ["$amountPaise", { $multiply: [{ $ifNull: ["$amount", 0] }, 100] }] }, 0] },
        },
        withdrawnPaise: {
          $sum: { $cond: [{ $and: [{ $eq: ["$type", "debit"] }, { $eq: ["$source", "withdraw"] }] }, { $ifNull: ["$amountPaise", { $multiply: [{ $ifNull: ["$amount", 0] }, 100] }] }, 0] },
        },
      },
    },
  ]);
  const txnMap = new Map(txnAgg.map((t) => [String(t._id), t]));

  const profiles = await TechnicianProfile.find({ availableBalancePaise: { $exists: false } })
    .select("_id walletBalance")
    .cursor({ batchSize: 200 });
  for await (const p of profiles) {
    const hist = txnMap.get(String(p._id)) || { earnedPaise: 0, withdrawnPaise: 0 };
    p.availableBalancePaise = toPaise(p.walletBalance ?? 0);
    p.reservedBalancePaise = 0;
    p.lifetimeEarnedPaise = toPaise(hist.earnedPaise);
    p.lifetimeWithdrawnPaise = toPaise(hist.withdrawnPaise);
    await p.save();
    stats.profiles++;
  }

  console.log("\n📊 Migration summary:", stats);
  console.log("✅ Financial paise migration complete.");
  await mongoose.disconnect();
  process.exit(0);
};

run().catch(async (err) => {
  console.error("❌ Migration failed:", err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
