import "dotenv/config";
import mongoose from "mongoose";
import ProductBooking from "../Schemas/ProductBooking.js";

const parseArgs = (argv) => {
  const args = { apply: false, help: false };
  for (const arg of argv) {
    if (arg === "--apply") args.apply = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
  }
  return args;
};

const usage = () => {
  console.log(`Usage: node scripts/backfillProductBookingKeys.js [options]

Backfills bookingKey for quotation-linked ProductBookings.

Single-booking quotations receive bookingKey=<quotationId>. Legacy multi-booking
quotations receive bookingKey=<quotationId>:<bookingId>. Safe to re-run.

Options:
  --apply   Apply the backfill. Without this flag the script is a dry run.
  --help    Show this message.`);
};

const run = async () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI is not configured");

  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 10000 });

  const rows = await ProductBooking.aggregate([
    { $match: { quotationId: { $ne: null }, $or: [{ bookingKey: { $exists: false } }, { bookingKey: null }] } },
    { $sort: { createdAt: 1 } },
    {
      $group: {
        _id: "$quotationId",
        bookings: { $push: { _id: "$_id", productId: "$productId" } },
        count: { $sum: 1 },
      },
    },
  ]);

  const updates = [];
  for (const row of rows) {
    for (const booking of row.bookings) {
      const key = row.count === 1
        ? String(row._id)
        : `${String(row._id)}:${String(booking._id)}`;
      updates.push({
        updateOne: {
          filter: { _id: booking._id, $or: [{ bookingKey: { $exists: false } }, { bookingKey: null }] },
          update: { $set: { bookingKey: key } },
        },
      });
    }
  }

  console.log(`[backfill] ${args.apply ? "Applying" : "Dry run:"} ${updates.length} ProductBooking(s) across ${rows.length} quotation(s)`);

  if (!args.apply || updates.length === 0) {
    for (const update of updates.slice(0, 20)) {
      console.log(`  ${update.updateOne.filter._id} -> ${update.updateOne.update.$set.bookingKey}`);
    }
    if (updates.length > 20) console.log(`  ... and ${updates.length - 20} more`);
    return;
  }

  const result = await ProductBooking.bulkWrite(updates, { ordered: false });
  console.log(`[backfill] matched=${result.matchedCount} modified=${result.modifiedCount}`);
};

run()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
