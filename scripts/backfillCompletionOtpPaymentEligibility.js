import "dotenv/config";
import mongoose from "mongoose";
import ServiceBooking from "../Schemas/ServiceBooking.js";
import ServiceCompletionChallenge from "../Schemas/ServiceCompletionChallenge.js";

const parseArgs = (argv) => {
  const args = { apply: false, limit: 10000, help: false };
  for (const arg of argv) {
    if (arg === "--apply") args.apply = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg.startsWith("--limit=")) {
      const value = Number(arg.slice("--limit=".length));
      if (Number.isFinite(value) && value > 0) args.limit = Math.min(Math.floor(value), 100000);
    }
  }
  return args;
};

const usage = () => {
  console.log(`Usage: node scripts/backfillCompletionOtpPaymentEligibility.js [options]

Backfills completionOtpRequestedAt for bookings that already have an active
completion OTP challenge created before the pay-before-completion marker
existed.

Options:
  --apply       Apply the backfill. Without this flag the script is a dry run.
  --limit=N     Maximum bookings to scan (default 10000).
  --help        Show this message.`);
};

const run = async () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI is not configured");

  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 10000 });

  const rows = await ServiceCompletionChallenge.aggregate([
    { $match: { status: { $in: ["pending_delivery", "pending"] } } },
    { $sort: { createdAt: 1 } },
    { $group: { _id: "$bookingId", requestedAt: { $first: "$createdAt" } } },
    {
      $lookup: {
        from: ServiceBooking.collection.name,
        localField: "_id",
        foreignField: "_id",
        as: "booking",
      },
    },
    { $unwind: "$booking" },
    { $match: { "booking.completionOtpRequestedAt": null } },
    { $project: { _id: 1, requestedAt: 1 } },
    { $limit: args.limit },
  ]);

  console.log(`[backfill] ${args.apply ? "Applying" : "Dry run:"} ${rows.length} booking(s) need the marker`);

  if (!args.apply || rows.length === 0) {
    for (const row of rows.slice(0, 20)) {
      console.log(`  ${row._id} -> ${row.requestedAt?.toISOString?.() || "(now)"}`);
    }
    if (rows.length > 20) console.log(`  ... and ${rows.length - 20} more`);
    return;
  }

  const now = new Date();
  const result = await ServiceBooking.bulkWrite(
    rows.map((row) => ({
      updateOne: {
        filter: { _id: row._id, completionOtpRequestedAt: null },
        update: { $set: { completionOtpRequestedAt: row.requestedAt || now } },
      },
    })),
    { ordered: false }
  );

  console.log(`[backfill] Updated ${result.modifiedCount} booking(s)`);
};

run()
  .catch((err) => {
    console.error("[backfill] Failed:", err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => {});
  });
