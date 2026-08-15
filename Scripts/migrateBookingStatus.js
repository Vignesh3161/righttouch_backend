/**
 * 🔄 MIGRATION — Canonical booking status + new booking fields.
 *
 * Run once against the database (idempotent; safe to re-run):
 *   node Scripts/migrateBookingStatus.js
 *
 * Performs:
 *   1. Normalize legacy statuses → canonical vocabulary:
 *        ACCEPTED → accepted, SEARCHING → broadcasted, requested → pending
 *   2. Backfill assignmentStatus / cancellationStatus / cancellationFeeStatus
 *   3. Backfill completedAt for completed bookings
 *   4. Backfill version for optimistic concurrency
 *
 * No money values are changed. Historical bookings keep their price,
 * commission, schedule, technician, and cancellation facts intact.
 */
import mongoose from "mongoose";
import dotenv from "dotenv";

dotenv.config();

const uri = process.env.MONGO_URI;
if (!uri) {
  console.error("❌ MONGO_URI not set");
  process.exit(1);
}

const LEGACY_MAP = { ACCEPTED: "accepted", SEARCHING: "broadcasted", requested: "pending" };
const CANONICAL = ["pending", "broadcasted", "accepted", "on_the_way", "reached", "in_progress", "completed", "expired", "cancelled"];

const assignStatus = (status) => {
  if (CANONICAL.includes(status)) return status;
  return LEGACY_MAP[status] || status;
};

async function run() {
  await mongoose.connect(uri, { useNewUrlParser: true, useUnifiedTopology: true });
  console.log("✅ Connected.");

  const db = mongoose.connection.db;
  const col = db.collection("servicebookings");

  const total = await col.countDocuments();
  console.log(`📦 servicebookings total: ${total}`);

  const legacy = await col
    .find({ status: { $in: ["ACCEPTED", "SEARCHING", "requested"] } })
    .project({ status: 1, bookingType: 1 })
    .toArray();
  console.log(`⚠️  Legacy statuses found: ${legacy.length}`);

  for (const doc of legacy) {
    const canonical = assignStatus(doc.status);
    const updates = { $set: { status: canonical } };
    if (canonical === "accepted" && !doc.bookingType) {
      updates.$set.bookingType = doc.bookingType || "instant";
    }
    await col.updateOne({ _id: doc._id }, updates);
  }

  // Backfill assignmentStatus / cancellationStatus / cancellationFeeStatus
  const backfill = await col.updateMany(
    { assignmentStatus: { $exists: false } },
    {
      $set: {
        assignmentStatus: { $cond: [{ $ne: ["$technicianId", null] }, "assigned", "unassigned"] },
        cancellationStatus: { $cond: [{ $eq: ["$status", "cancelled"] }, "system_cancelled", "active"] },
        cancellationFeeStatus: "not_collected",
      },
    }
  );
  console.log(`✅ assignment/cancellation fields backfilled: ${backfill.modifiedCount}`);

  // completedAt backfill
  const completedAt = await col.updateMany(
    { status: "completed", completedAt: { $exists: false } },
    { $set: { completedAt: "$updatedAt" } }
  );
  console.log(`✅ completedAt backfilled: ${completedAt.modifiedCount}`);

  // version backfill
  const version = await col.updateMany(
    { version: { $exists: false } },
    { $set: { version: 1 } }
  );
  console.log(`✅ version backfilled: ${version.modifiedCount}`);

  // Payoff check
  const remaining = await col.countDocuments({ status: { $in: ["ACCEPTED", "SEARCHING", "requested"] } });
  console.log(remaining === 0 ? "🎉 Migration complete — no legacy statuses remain." : `⚠️  ${remaining} legacy statuses remain.`);

  await mongoose.connection.close();
  process.exit(remaining === 0 ? 0 : 1);
}

run().catch(async (err) => {
  console.error("❌ Migration failed:", err);
  try {
    await mongoose.connection.close();
  } catch {}
  process.exit(1);
});
