/**
 * 🚑 ONE-TIME BACKFILL — fix "technician wallet shows ₹0" for existing data.
 *
 * Finds every ServiceBooking that is:
 *   - paymentStatus === "paid"
 *   - status === "completed"
 *   - settlementStatus !== "settled"
 * and settles it through the (now fixed) settlement pipeline — which uses
 * the authoritative Payment split (serviceAmount − commission + tip).
 *
 * Usage:
 *   node scripts/backfillSettlements.js            # dry-run (prints what would happen)
 *   node scripts/backfillSettlements.js --apply     # actually credits wallets
 */
import mongoose from "mongoose";
import dotenv from "dotenv";

dotenv.config();

import ServiceBooking from "../Schemas/ServiceBooking.js";
import { settleEligibleBookingsBackstop } from "../Utils/settlement.js";

const APPLY = process.argv.includes("--apply");

const main = async () => {
  if (!process.env.MONGO_URI) {
    console.error("MONGO_URI not set in .env");
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI, {
    serverSelectionTimeoutMS: 10000,
  });
  console.log(`Connected. Mode: ${APPLY ? "APPLY (credits wallets)" : "DRY-RUN"}`);

  const candidates = await ServiceBooking.find({
    settlementStatus: { $ne: "settled" },
    paymentStatus: "paid",
    status: "completed",
    technicianId: { $ne: null },
  })
    .select("_id baseAmount tipAmount technicianAmount paymentId technicianId")
    .lean();

  console.log(`Found ${candidates.length} paid+completed bookings not yet settled.`);

  if (!APPLY) {
    for (const b of candidates.slice(0, 20)) {
      console.log(
        `  • ${b._id} | base ₹${b.baseAmount} | tip ₹${b.tipAmount || 0} | techAmount ${b.technicianAmount}`
      );
    }
    if (candidates.length > 20) {
      console.log(`  …and ${candidates.length - 20} more.`);
    }
    console.log("\nDry-run done. Re-run with --apply to credit technician wallets.");
    await mongoose.disconnect();
    process.exit(0);
  }

  const { processed, settled } = await settleEligibleBookingsBackstop(500);
  console.log(`Settlement backstop: processed ${processed}, settled ${settled}.`);

  const stillPending = await ServiceBooking.countDocuments({
    settlementStatus: { $ne: "settled" },
    paymentStatus: "paid",
    status: "completed",
  });
  console.log(`Still pending after this pass: ${stillPending}. Re-run if > 0.`);

  await mongoose.disconnect();
  process.exit(0);
};

main().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
