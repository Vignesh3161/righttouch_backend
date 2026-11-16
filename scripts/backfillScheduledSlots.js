import "dotenv/config";
import mongoose from "mongoose";
import ServiceBooking from "../Schemas/ServiceBooking.js";
import TechnicianSlot from "../Schemas/TechnicianSlot.js";
import { getSlotForTime } from "../Utils/slots.js";

const ACTIVE_STATUSES = ["accepted", "on_the_way", "reached", "in_progress"];

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
  console.log(`Usage: node scripts/backfillScheduledSlots.js [options]

Backfills the four-slot model for legacy scheduled bookings:
  - derives slotKey/slotValue/slotLabel/slotStartAt/slotEndAt from scheduledAt
  - normalizes scheduledAt to the containing slot start
  - sets dispatchEligibleAt to null (immediate scheduled dispatch)
  - sets inProgressAt for in-progress bookings when missing
  - creates an active primary TechnicianSlot for accepted scheduled jobs

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

  const filter = {
    $or: [
      { bookingType: "schedule", $or: [{ slotKey: null }, { slotStartAt: null }] },
      { status: "in_progress", inProgressAt: null },
    ],
  };

  const bookings = await ServiceBooking.find(filter)
    .select("_id bookingType status scheduledAt slotKey slotValue slotLabel slotStartAt slotEndAt technicianId dispatchEligibleAt inProgressAt estimatedDurationMinutes updatedAt assignedAt createdAt")
    .sort({ createdAt: 1 })
    .limit(args.limit)
    .lean();

  const summary = {
    scanned: bookings.length,
    updated: 0,
    skippedOutsideSlotWindow: 0,
    slotsCreated: 0,
    slotConflicts: 0,
    errors: 0,
  };

  for (const booking of bookings) {
    const set = {};
    if (booking.status === "in_progress" && !booking.inProgressAt) {
      set.inProgressAt = booking.updatedAt || booking.assignedAt || booking.createdAt || new Date();
    }

    if (booking.bookingType === "schedule" && (!booking.slotKey || !booking.slotStartAt)) {
      const slot = getSlotForTime(booking.scheduledAt);
      if (!slot) {
        summary.skippedOutsideSlotWindow += 1;
        console.warn(
          `[backfill] skip booking=${booking._id} scheduledAt=${booking.scheduledAt || "null"} reason=outside_slot_window`
        );
        continue;
      }
      set.slotKey = slot.slotKey;
      set.slotValue = slot.slotValue;
      set.slotLabel = slot.slotLabel;
      set.slotStartAt = slot.slotStartAt;
      set.slotEndAt = slot.slotEndAt;
      set.scheduledAt = slot.slotStartAt;
      set.dispatchEligibleAt = null;
      if (!booking.estimatedDurationMinutes) {
        set.estimatedDurationMinutes = 60;
      }
    }

    if (!Object.keys(set).length) continue;

    if (args.apply) {
      try {
        await ServiceBooking.updateOne({ _id: booking._id }, { $set: set });
        summary.updated += 1;
      } catch (error) {
        summary.errors += 1;
        console.error(`[backfill] booking=${booking._id} update failed:`, error.message);
        continue;
      }
    } else {
      summary.updated += 1;
    }

    const effective = { ...booking, ...set };
    if (
      ACTIVE_STATUSES.includes(effective.status) &&
      effective.technicianId &&
      effective.slotKey &&
      effective.slotStartAt &&
      effective.slotEndAt
    ) {
      const existing = await TechnicianSlot.findOne({
        bookingId: booking._id,
        active: true,
        role: "primary",
      }).lean();
      if (!existing) {
        if (args.apply) {
          try {
            await TechnicianSlot.create({
              technicianId: effective.technicianId,
              bookingId: booking._id,
              slotKey: effective.slotKey,
              slotStartAt: effective.slotStartAt,
              slotEndAt: effective.slotEndAt,
              role: "primary",
              active: true,
              source: "legacy_backfill",
            });
            summary.slotsCreated += 1;
          } catch (error) {
            if (error?.code === 11000) {
              summary.slotConflicts += 1;
              console.warn(`[backfill] booking=${booking._id} slot conflict for technician=${effective.technicianId} slot=${effective.slotKey}`);
            } else {
              summary.errors += 1;
              console.error(`[backfill] booking=${booking._id} slot create failed:`, error.message);
            }
          }
        } else {
          summary.slotsCreated += 1;
        }
      }
    }
  }

  console.log(`[backfill] ${args.apply ? "APPLIED" : "DRY RUN"} summary:`, summary);
  await mongoose.disconnect();
};

run().catch(async (error) => {
  console.error("[backfill] fatal:", error);
  try {
    await mongoose.disconnect();
  } catch {
    /* noop */
  }
  process.exitCode = 1;
});
