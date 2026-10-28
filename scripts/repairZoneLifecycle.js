import "dotenv/config";
import mongoose from "mongoose";
import { pathToFileURL } from "node:url";
import OperationalCity from "../Schemas/OperationalCity.js";
import CityZone from "../Schemas/CityZone.js";
import ZoneServiceMapping from "../Schemas/ZoneServiceMapping.js";
import ServiceAvailability from "../Schemas/ServiceAvailability.js";
import TechnicianProfile from "../Schemas/TechnicianProfile.js";
import Service from "../Schemas/Service.js";
import { deleteZoneCascade, syncServiceToZones } from "../Services/zoneWriteService.js";

const parseArgs = (argv) => {
  const args = { apply: false, districtId: null, limit: 5000, adminUserId: null, help: false };
  for (const arg of argv) {
    if (arg === "--apply") args.apply = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg.startsWith("--district=")) args.districtId = arg.slice("--district=".length).trim();
    else if (arg.startsWith("--admin-id=")) args.adminUserId = arg.slice("--admin-id=".length).trim();
    else if (arg.startsWith("--limit=")) {
      const value = Number(arg.slice("--limit=".length));
      if (Number.isFinite(value) && value > 0) args.limit = Math.min(Math.floor(value), 50000);
    }
  }
  return args;
};

const usage = () => {
  console.log(`Usage: node scripts/repairZoneLifecycle.js [options]

Options:
  --apply                 Apply fixes. Without this flag the script is a dry run.
  --district=<id>         Limit the scan to one operational district.
  --limit=N               Maximum zones/services to scan (default 5000).
  --admin-id=<id>         Actor recorded on cascaded technician removals.
  --help                  Show this message.`);
};

const idString = (value) => (value ? String(value) : null);

const run = async () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI is not configured");
  if (args.districtId && !mongoose.isValidObjectId(args.districtId)) {
    throw new Error("--district must be a valid OperationalCity id");
  }
  if (args.adminUserId && !mongoose.isValidObjectId(args.adminUserId)) {
    throw new Error("--admin-id must be a valid User id");
  }

  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 10000 });

  const districtFilter = args.districtId ? { _id: args.districtId } : {};
  const districts = await OperationalCity.find(districtFilter).select("_id name").lean();
  const allDistricts = await OperationalCity.find({}).select("_id").lean();
  const validDistrictIds = new Set(allDistricts.map((district) => String(district._id)));

  const zoneFilter = args.districtId ? { operationalCityId: args.districtId } : {};
  const zones = await CityZone.find(zoneFilter)
    .select("_id name operationalCityId polygon active")
    .sort({ _id: 1 })
    .limit(args.limit)
    .lean();
  const allZones = await CityZone.find({}).select("_id").lean();
  const allZoneIds = new Set(allZones.map((zone) => String(zone._id)));

  const orphanZones = zones.filter((zone) => !validDistrictIds.has(String(zone.operationalCityId)));
  const validZones = zones.filter((zone) => validDistrictIds.has(String(zone.operationalCityId)));
  const validZoneIds = new Set(validZones.map((zone) => String(zone._id)));

  const mappings = await ZoneServiceMapping.find(
    args.districtId ? { zoneId: { $in: zones.map((zone) => zone._id) } } : {}
  )
    .select("_id zoneId serviceId active")
    .sort({ _id: 1 })
    .limit(args.limit)
    .lean();
  const orphanMappings = mappings.filter((mapping) => !allZoneIds.has(String(mapping.zoneId)));

  const availability = await ServiceAvailability.find(
    args.districtId ? { districtId: args.districtId } : {}
  )
    .select("_id serviceId districtId cityZoneId cityId scope status")
    .sort({ _id: 1 })
    .limit(args.limit)
    .lean();
  const orphanAvailability = availability.filter((row) => {
    if (!validDistrictIds.has(String(row.districtId))) return true;
    if (row.scope === "ZONE" || row.scope === "CITY") {
      const zoneId = idString(row.cityZoneId || row.cityId);
      return !zoneId || !allZoneIds.has(zoneId);
    }
    return false;
  });

  const canonicalByKey = new Map();
  for (const row of availability) {
    if (row.scope !== "ZONE") continue;
    const zoneId = idString(row.cityZoneId || row.cityId);
    if (!zoneId) continue;
    canonicalByKey.set(`${zoneId}:${String(row.serviceId)}`, row);
  }
  const mappingConflicts = mappings
    .filter((mapping) => validZoneIds.has(String(mapping.zoneId)))
    .map((mapping) => {
      const canonical = canonicalByKey.get(`${String(mapping.zoneId)}:${String(mapping.serviceId)}`);
      if (!canonical) return { mapping, canonical: null, reason: "MISSING_CANONICAL" };
      const enabled = canonical.status === "ENABLED";
      if (enabled !== Boolean(mapping.active)) {
        return { mapping, canonical, reason: "STATUS_MISMATCH" };
      }
      return null;
    })
    .filter(Boolean);

  const affectedProfiles = await TechnicianProfile.find({
    enabledCityZoneIds: { $in: orphanZones.map((zone) => zone._id) },
  })
    .select("_id userId enabledCityZoneIds currentCityZoneId cityZoneId")
    .lean();

  const summary = {
    mode: args.apply ? "apply" : "dry-run",
    districts: districts.length,
    zonesScanned: zones.length,
    validZones: validZones.length,
    orphanZones: orphanZones.length,
    orphanMappings: orphanMappings.length,
    orphanAvailability: orphanAvailability.length,
    mappingConflicts: mappingConflicts.length,
    profilesReferencingOrphanZones: affectedProfiles.length,
    cascadedZones: 0,
    cascadedZonesSkipped: 0,
    mappingsDeleted: 0,
    availabilityDeleted: 0,
    canonicalRowsFixed: 0,
    servicesSynced: 0,
    serviceSyncFailures: 0,
  };

  console.log(`[zone-repair] mode=${summary.mode} ${JSON.stringify(summary)}`);
  for (const zone of orphanZones) {
    console.log(
      `[zone-repair] orphan-zone id=${zone._id} name=${zone.name || "unnamed"} parent=${zone.operationalCityId || "none"}`
    );
  }
  for (const conflict of mappingConflicts) {
    console.log(
      `[zone-repair] mapping-conflict zone=${conflict.mapping.zoneId} service=${conflict.mapping.serviceId} mappingActive=${conflict.mapping.active} canonical=${conflict.canonical?.status || "none"} reason=${conflict.reason}`
    );
  }

  if (!args.apply) {
    console.log(`[zone-repair] summary ${JSON.stringify(summary)}`);
    return;
  }

  const skippedZoneIds = new Set();
  for (const zone of orphanZones) {
    try {
      const deleted = await deleteZoneCascade({
        zoneId: zone._id,
        actorId: args.adminUserId,
      });
      if (deleted) summary.cascadedZones += 1;
      else {
        summary.cascadedZonesSkipped += 1;
        skippedZoneIds.add(String(zone._id));
      }
    } catch (error) {
      summary.cascadedZonesSkipped += 1;
      skippedZoneIds.add(String(zone._id));
      console.error(
        `[zone-repair] orphan-zone-skip id=${zone._id} code=${error.code || "UNKNOWN"} message=${error.message}`
      );
    }
  }

  const deletableMappings = orphanMappings.filter(
    (mapping) => !skippedZoneIds.has(String(mapping.zoneId))
  );
  if (deletableMappings.length) {
    const result = await ZoneServiceMapping.deleteMany({
      _id: { $in: deletableMappings.map((mapping) => mapping._id) },
    });
    summary.mappingsDeleted = result.deletedCount || 0;
  }

  const deletableAvailability = orphanAvailability.filter((row) => {
    const zoneId = idString(row.cityZoneId || row.cityId);
    return !zoneId || !skippedZoneIds.has(zoneId);
  });
  if (deletableAvailability.length) {
    const result = await ServiceAvailability.deleteMany({
      _id: { $in: deletableAvailability.map((row) => row._id) },
    });
    summary.availabilityDeleted = result.deletedCount || 0;
  }

  for (const conflict of mappingConflicts) {
    if (conflict.reason === "MISSING_CANONICAL") {
      await ServiceAvailability.updateOne(
        {
          serviceId: conflict.mapping.serviceId,
          cityZoneId: conflict.mapping.zoneId,
          scope: "ZONE",
        },
        {
          $set: {
            serviceId: conflict.mapping.serviceId,
            cityZoneId: conflict.mapping.zoneId,
            cityId: conflict.mapping.zoneId,
            districtId: zones.find((zone) => String(zone._id) === String(conflict.mapping.zoneId))
              ?.operationalCityId,
            scope: "ZONE",
            status: conflict.mapping.active ? "ENABLED" : "DISABLED",
            updatedBy: args.adminUserId,
          },
        },
        { upsert: true }
      );
      summary.canonicalRowsFixed += 1;
      continue;
    }
    await ServiceAvailability.updateOne(
      { _id: conflict.canonical._id },
      {
        $set: {
          status: conflict.mapping.active ? "ENABLED" : "DISABLED",
          updatedBy: args.adminUserId,
        },
      }
    );
    summary.canonicalRowsFixed += 1;
  }

  const services = await Service.find({ isActive: true }).select("_id").sort({ _id: 1 }).limit(args.limit).lean();
  for (const service of services) {
    try {
      await syncServiceToZones({
        serviceId: service._id,
        actorId: args.adminUserId,
      });
      summary.servicesSynced += 1;
    } catch (error) {
      summary.serviceSyncFailures += 1;
      console.error(
        `[zone-repair] service-sync-failed service=${service._id} code=${error.code || "UNKNOWN"} message=${error.message}`
      );
    }
  }

  console.log(`[zone-repair] summary ${JSON.stringify(summary)}`);
  if (summary.serviceSyncFailures > 0 || summary.cascadedZonesSkipped > 0) process.exitCode = 1;
};

const isMainModule =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  run()
    .catch((error) => {
      console.error(`[zone-repair] fatal: ${error.message}`);
      process.exitCode = 1;
    })
    .finally(async () => {
      await mongoose.connection.close().catch(() => {});
    });
}
