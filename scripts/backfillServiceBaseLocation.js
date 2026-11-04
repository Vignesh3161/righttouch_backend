import "dotenv/config";
import mongoose from "mongoose";
import TechnicianProfile from "../Schemas/TechnicianProfile.js";

const parseArgs = (argv) => {
  const args = { apply: false, limit: 5000, technicianId: null, help: false };
  for (const arg of argv) {
    if (arg === "--apply") args.apply = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg.startsWith("--limit=")) {
      const value = Number(arg.slice("--limit=".length));
      if (Number.isFinite(value) && value > 0) args.limit = Math.min(Math.floor(value), 50000);
    } else if (arg.startsWith("--technician=")) {
      args.technicianId = arg.slice("--technician=".length).trim();
    }
  }
  return args;
};

const usage = () => {
  console.log(`Usage: node scripts/backfillServiceBaseLocation.js [options]

Backfills serviceBaseLocation from the technician's last-known live GPS for
profiles that do not have a stable base location yet. Dry-run by default.

Options:
  --apply                 Apply changes. Without this flag the script is a dry run.
  --limit=N               Maximum profiles to scan (default 5000).
  --technician=<id>       Scan only one TechnicianProfile id.
  --help                  Show this message.`);
};

const run = async () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }
  if (args.technicianId && !mongoose.isValidObjectId(args.technicianId)) {
    throw new Error("--technician must be a valid TechnicianProfile id");
  }
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI is not configured");

  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 10000 });

  const filter = {
    workStatus: "approved",
    $or: [
      { serviceBaseLocation: null },
      { serviceBaseLocation: { $exists: false } },
    ],
  };
  if (args.technicianId) filter._id = args.technicianId;

  const profiles = await TechnicianProfile.find(filter)
    .select("_id location locationUpdatedAt serviceBaseLocation")
    .sort({ _id: 1 })
    .limit(args.limit)
    .lean();

  let scanned = 0;
  let eligible = 0;
  let applied = 0;
  let skipped = 0;

  for (const profile of profiles) {
    scanned += 1;
    const coords = profile.location?.coordinates;
    if (!Array.isArray(coords) || coords.length !== 2
      || !Number.isFinite(coords[0]) || !Number.isFinite(coords[1])) {
      skipped += 1;
      continue;
    }
    eligible += 1;
    if (!args.apply) continue;

    await TechnicianProfile.updateOne(
      { _id: profile._id, serviceBaseLocation: null },
      {
        $set: {
          serviceBaseLocation: { type: "Point", coordinates: [coords[0], coords[1]] },
          serviceBaseLocationSource: "last_known",
          serviceBaseLocationUpdatedAt: profile.locationUpdatedAt || new Date(),
          serviceBaseLocationVerified: false,
        },
      }
    );
    applied += 1;
  }

  console.log(JSON.stringify({
    mode: args.apply ? "apply" : "dry_run",
    scanned,
    eligible,
    applied,
    skipped,
  }, null, 2));
};

run()
  .catch((err) => {
    console.error("Backfill failed:", err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => {});
  });
