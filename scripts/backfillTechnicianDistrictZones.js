import "dotenv/config";
import mongoose from "mongoose";
import TechnicianProfile from "../Schemas/TechnicianProfile.js";
import TechnicianDistrictPermission from "../Schemas/TechnicianDistrictPermission.js";
import OperationalCity from "../Schemas/OperationalCity.js";
import CityZone from "../Schemas/CityZone.js";
import { ensureApprovedDistrictZones } from "../Services/technicianDistrictService.js";
import {
  getBackfillDistrictId,
  inspectBackfillCandidate,
} from "../Services/technicianDistrictBackfillService.js";

const parseArgs = (argv) => {
  const args = {
    apply: false,
    limit: 500,
    technicianId: null,
    adminUserId: null,
    help: false,
  };

  for (const arg of argv) {
    if (arg === "--apply") args.apply = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg.startsWith("--limit=")) {
      const value = Number(arg.slice("--limit=".length));
      if (Number.isFinite(value) && value > 0) {
        args.limit = Math.min(Math.floor(value), 5000);
      }
    } else if (arg.startsWith("--technician=")) {
      args.technicianId = arg.slice("--technician=".length).trim();
    } else if (arg.startsWith("--admin-id=")) {
      args.adminUserId = arg.slice("--admin-id=".length).trim();
    }
  }

  return args;
};

const usage = () => {
  console.log(`Usage: node scripts/backfillTechnicianDistrictZones.js [options]

Options:
  --apply                 Apply changes. Without this flag the script is a dry run.
  --limit=N               Maximum approved technicians to scan (default 500, max 5000).
  --technician=<id>       Scan only one technician profile.
  --admin-id=<id>         Optional admin user id recorded as the grant actor.
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
  if (args.adminUserId && !mongoose.isValidObjectId(args.adminUserId)) {
    throw new Error("--admin-id must be a valid User id");
  }
  if (!process.env.MONGO_URI) {
    throw new Error("MONGO_URI is not configured");
  }

  await mongoose.connect(process.env.MONGO_URI, {
    serverSelectionTimeoutMS: 10000,
  });

  const profileFilter = { workStatus: "approved" };
  if (args.technicianId) profileFilter._id = args.technicianId;

  const profiles = await TechnicianProfile.find(profileFilter)
    .select(
      "_id userId primaryDistrictId primaryCityId cityZoneId enabledDistrictIds allowedCityIds enabledCityZoneIds"
    )
    .sort({ _id: 1 })
    .limit(args.limit)
    .lean();

  const technicianIds = profiles.map((profile) => profile._id);
  const permissionCounts = technicianIds.length
    ? await TechnicianDistrictPermission.aggregate([
        {
          $match: {
            technicianId: { $in: technicianIds },
            isEnabled: true,
          },
        },
        { $group: { _id: "$technicianId", count: { $sum: 1 } } },
      ])
    : [];
  const permissionCountByTech = new Map(
    permissionCounts.map((row) => [String(row._id), row.count])
  );

  const summary = {
    mode: args.apply ? "apply" : "dry-run",
    scanned: profiles.length,
    needsBackfill: 0,
    eligible: 0,
    ineligible: 0,
    applied: 0,
    failed: 0,
    skipped: 0,
  };

  console.log(
    `[district-backfill] mode=${summary.mode} scanned=${summary.scanned} limit=${args.limit}`
  );

  for (const profile of profiles) {
    const enabledPermissionCount = permissionCountByTech.get(String(profile._id)) || 0;
    let zoneDistrictId = null;

    if (!getBackfillDistrictId(profile) && profile.cityZoneId) {
      const zone = await CityZone.findById(profile.cityZoneId)
        .select("operationalCityId")
        .lean();
      zoneDistrictId = zone?.operationalCityId || null;
    }

    const districtId =
      getBackfillDistrictId(profile) || (zoneDistrictId ? String(zoneDistrictId) : null);
    const district = districtId
      ? await OperationalCity.findById(districtId)
          .select("name active isActive isJobEnabled")
          .lean()
      : null;
    const activeZoneCount = districtId
      ? await CityZone.countDocuments({
          operationalCityId: districtId,
          active: { $ne: false },
        })
      : 0;

    const inspection = inspectBackfillCandidate({
      profile,
      district,
      activeZoneCount,
      enabledPermissionCount,
      zoneDistrictId,
    });

    if (!inspection.needed) {
      summary.skipped++;
      continue;
    }

    summary.needsBackfill++;
    if (!inspection.eligible) {
      summary.ineligible++;
      console.log(
        `[district-backfill] skip technician=${profile._id} user=${profile.userId || "none"} district=${inspection.districtId || "none"} reason=${inspection.reason}`
      );
      continue;
    }

    summary.eligible++;
    console.log(
      `[district-backfill] ${args.apply ? "apply" : "plan"} technician=${profile._id} user=${profile.userId || "none"} district=${inspection.districtId} districtName=${district?.name || "unknown"} activeZones=${activeZoneCount} enabledPermissionRows=${enabledPermissionCount} reason=${inspection.reason}`
    );

    if (!args.apply) continue;

    try {
      await ensureApprovedDistrictZones({
        technicianId: profile._id,
        adminUserId: args.adminUserId,
        reason: "Backfill approved technician district and zone permissions",
      });
      summary.applied++;
      console.log(`[district-backfill] applied technician=${profile._id}`);
    } catch (error) {
      summary.failed++;
      console.error(
        `[district-backfill] failed technician=${profile._id} code=${error.code || "UNKNOWN"} message=${error.message}`
      );
    }
  }

  console.log(`[district-backfill] summary ${JSON.stringify(summary)}`);
  if (summary.failed > 0) process.exitCode = 1;
};

run()
  .catch((error) => {
    console.error(`[district-backfill] fatal: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.connection.close().catch(() => {});
  });
