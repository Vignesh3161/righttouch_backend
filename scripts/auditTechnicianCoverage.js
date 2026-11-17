import "dotenv/config";
import mongoose from "mongoose";
import TechnicianProfile from "../Schemas/TechnicianProfile.js";
import OperationalCity from "../Schemas/OperationalCity.js";
import CityZone from "../Schemas/CityZone.js";
import TechnicianDistrictPermission from "../Schemas/TechnicianDistrictPermission.js";
import DistrictPermissionHistory from "../Schemas/DistrictPermissionHistory.js";
import { writeAuditLog } from "../Utils/audit.js";

const usage = () => {
  console.log(`Usage: node scripts/auditTechnicianCoverage.js [options]

Options:
  --apply                 Apply the cleanup. Without this flag the script is a dry run.
  --technician=<id>       Limit the audit to one technician profile.
  --verbose               Print per-technician findings.
  --help                  Show this message.

Only auto-created district permission rows are removed:
  - enabledBy is empty AND there is no admin GRANT/ENABLE history.

Legacy permissionType "PRIMARY" rows with admin provenance are reported but
retained for manual review, because an older admin action may have granted
real coverage. Explicit Admin/Owner grants are preserved. Derived arrays and
inherited zone coverage are then reconciled from the remaining explicit
grants. Technician workStatus is never changed.`);
};

const parseArgs = (argv) => {
  const args = { apply: false, verbose: false, help: false, technicianId: null };
  for (const arg of argv) {
    if (arg === "--apply") args.apply = true;
    else if (arg === "--verbose") args.verbose = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg.startsWith("--technician=")) args.technicianId = arg.split("=")[1];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
};

const sameIdSet = (left = [], right = []) => {
  const a = new Set(left.map(String));
  const b = new Set(right.map(String));
  return a.size === b.size && [...a].every((id) => b.has(id));
};

const run = async () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }

  if (!process.env.MONGO_URI) throw new Error("MONGO_URI is not configured");
  if (args.technicianId && !mongoose.Types.ObjectId.isValid(args.technicianId)) {
    throw new Error("--technician must be a valid ObjectId");
  }

  await mongoose.connect(process.env.MONGO_URI, {
    maxPoolSize: 5,
    serverSelectionTimeoutMS: 10000,
  });

  try {
    const dbName = mongoose.connection.db.databaseName;
    const permissionFilter = args.technicianId
      ? { technicianId: new mongoose.Types.ObjectId(args.technicianId) }
      : {};

    const permissions = await TechnicianDistrictPermission.find(permissionFilter)
      .select("_id technicianId districtId permissionType isEnabled enabledBy enabledAt")
      .lean();

    const permissionTechnicianIds = [
      ...new Set(permissions.map((permission) => String(permission.technicianId))),
    ].filter((id) => mongoose.Types.ObjectId.isValid(id));

    const profileFilter = args.technicianId
      ? { _id: new mongoose.Types.ObjectId(args.technicianId) }
      : {
          $or: [
            { _id: { $in: permissionTechnicianIds } },
            { "enabledCityZoneIds.0": { $exists: true } },
            { "enabledDistrictIds.0": { $exists: true } },
            { "allowedCityIds.0": { $exists: true } },
          ],
        };

    const profiles = await TechnicianProfile.find(profileFilter)
      .select("_id enabledCityZoneIds enabledDistrictIds allowedCityIds")
      .lean();

    const profileIds = profiles.map((profile) => profile._id);

    const histories = await DistrictPermissionHistory.find({
      technicianId: { $in: profileIds },
      action: { $in: ["GRANT", "ENABLE"] },
    })
      .select("technicianId districtId adminId")
      .lean();

    const explicitHistory = new Set(
      histories
        .filter((history) => history.adminId)
        .map((history) => `${history.technicianId}:${history.districtId}`)
    );

    const rowsByTechnician = new Map();
    for (const permission of permissions) {
      const key = String(permission.technicianId);
      if (!rowsByTechnician.has(key)) rowsByTechnician.set(key, []);
      rowsByTechnician.get(key).push(permission);
    }

    const autoRows = [];
    const legacyPrimaryRows = [];
    const rowsToDelete = new Set();
    const remainingDistrictsByTechnician = new Map();

    for (const permission of permissions) {
      const key = `${permission.technicianId}:${permission.districtId}`;
      const hasExplicitHistory = explicitHistory.has(key);
      const isAuto = !permission.enabledBy && !hasExplicitHistory;
      const isLegacyPrimaryWithProvenance =
        permission.permissionType === "PRIMARY" && !isAuto;

      if (isAuto) {
        autoRows.push({ ...permission, hasExplicitHistory });
        rowsToDelete.add(String(permission._id));
      } else if (isLegacyPrimaryWithProvenance) {
        legacyPrimaryRows.push({ ...permission, hasExplicitHistory });
        if (permission.isEnabled) {
          const techKey = String(permission.technicianId);
          if (!remainingDistrictsByTechnician.has(techKey)) {
            remainingDistrictsByTechnician.set(techKey, new Set());
          }
          remainingDistrictsByTechnician.get(techKey).add(String(permission.districtId));
        }
      } else if (permission.isEnabled) {
        const techKey = String(permission.technicianId);
        if (!remainingDistrictsByTechnician.has(techKey)) {
          remainingDistrictsByTechnician.set(techKey, new Set());
        }
        remainingDistrictsByTechnician.get(techKey).add(String(permission.districtId));
      }
    }

    const allRemainingDistrictIds = [
      ...new Set(
        [...remainingDistrictsByTechnician.values()].flatMap((ids) => [...ids])
      ),
    ].filter((id) => mongoose.Types.ObjectId.isValid(id));

    const activeZones = allRemainingDistrictIds.length
      ? await CityZone.find({
          operationalCityId: { $in: allRemainingDistrictIds },
          active: { $ne: false },
        })
          .select("_id operationalCityId")
          .lean()
      : [];

    const zonesByDistrict = new Map();
    for (const zone of activeZones) {
      const districtId = String(zone.operationalCityId);
      if (!zonesByDistrict.has(districtId)) zonesByDistrict.set(districtId, []);
      zonesByDistrict.get(districtId).push(String(zone._id));
    }

    const technicianFindings = [];
    for (const profile of profiles) {
      const technicianId = String(profile._id);
      const rows = rowsByTechnician.get(technicianId) || [];
      const autoForTech = rows.filter((row) => rowsToDelete.has(String(row._id)));
      const remainingEnabled = [
        ...(remainingDistrictsByTechnician.get(technicianId) || new Set()),
      ].sort();
      const desiredZoneIds = [
        ...new Set(
          remainingEnabled.flatMap((districtId) => zonesByDistrict.get(districtId) || [])
        ),
      ].sort();
      const currentZoneIds = (profile.enabledCityZoneIds || []).map(String);
      const currentDistrictIds = (profile.enabledDistrictIds || []).map(String);
      const currentAllowedIds = (profile.allowedCityIds || []).map(String);

      const orphanZoneIds = currentZoneIds.filter((id) => !desiredZoneIds.includes(id));
      const staleDistrictArrays =
        !sameIdSet(currentDistrictIds, remainingEnabled) ||
        !sameIdSet(currentAllowedIds, remainingEnabled);
      const needsUpdate =
        autoForTech.length > 0 ||
        orphanZoneIds.length > 0 ||
        staleDistrictArrays ||
        !sameIdSet(currentZoneIds, desiredZoneIds);

      if (!needsUpdate) continue;

      technicianFindings.push({
        technicianId,
        autoPermissionRows: autoForTech.length,
        autoPermissionDetails: autoForTech.map((row) => ({
          districtId: String(row.districtId),
          permissionType: row.permissionType,
          isEnabled: row.isEnabled,
          enabledBy: row.enabledBy || null,
          hasExplicitHistory: row.hasExplicitHistory,
        })),
        remainingDistrictIds: remainingEnabled,
        orphanZoneIds,
        staleDistrictArrays,
        currentDistrictIds,
        currentAllowedIds,
        desiredZoneIds,
      });
    }

    const districtIdsToValidate = [
      ...new Set(
        [...autoRows, ...legacyPrimaryRows]
          .map((row) => String(row.districtId))
          .filter((id) => mongoose.Types.ObjectId.isValid(id))
      ),
    ];
    const knownDistricts = districtIdsToValidate.length
      ? await OperationalCity.find({ _id: { $in: districtIdsToValidate } })
          .select("_id name city")
          .lean()
      : [];
    const districtNames = new Map(
      knownDistricts.map((district) => [String(district._id), district.name || district.city || String(district._id)])
    );

    console.log(`Database: ${dbName}`);
    console.log(`Mode: ${args.apply ? "APPLY" : "DRY RUN"}`);
    console.log(`Technician profiles scanned: ${profiles.length}`);
    console.log(`Auto-created permission rows: ${autoRows.length}`);
    console.log(`Legacy PRIMARY rows retained for review: ${legacyPrimaryRows.length}`);
    console.log(`Technicians needing coverage reconciliation: ${technicianFindings.length}`);
    console.log(
      `Orphan zone references: ${technicianFindings.reduce((sum, finding) => sum + finding.orphanZoneIds.length, 0)}`
    );

    if (autoRows.length > 0) {
      console.log("\nAuto-created permission rows:");
      for (const row of autoRows) {
        console.log(
          `  technician=${row.technicianId} district=${row.districtId} ` +
            `(${districtNames.get(String(row.districtId)) || "unknown"}) ` +
            `type=${row.permissionType} enabled=${row.isEnabled} ` +
            `enabledBy=${row.enabledBy || "null"} explicitHistory=${row.hasExplicitHistory}`
        );
      }
    }

    if (legacyPrimaryRows.length > 0) {
      console.log("\nLegacy PRIMARY rows retained (admin provenance):");
      for (const row of legacyPrimaryRows) {
        console.log(
          `  technician=${row.technicianId} district=${row.districtId} ` +
            `(${districtNames.get(String(row.districtId)) || "unknown"}) ` +
            `enabled=${row.isEnabled} enabledBy=${row.enabledBy || "null"} ` +
            `explicitHistory=${row.hasExplicitHistory}`
        );
      }
    }

    if (args.verbose) {
      console.log("\nReconciliation findings:");
      for (const finding of technicianFindings) {
        console.log(
          `  technician=${finding.technicianId} ` +
            `remove=${finding.autoPermissionRows} ` +
            `remainingDistricts=${finding.remainingDistrictIds.length} ` +
            `orphanZones=${finding.orphanZoneIds.length} ` +
            `staleArrays=${finding.staleDistrictArrays}`
        );
      }
    }

    if (!args.apply) {
      console.log("\nDry run complete. No writes were made.");
      console.log("Review the findings, then rerun with --apply to clean up.");
      return;
    }

    if (rowsToDelete.size > 0) {
      const result = await TechnicianDistrictPermission.deleteMany({
        _id: { $in: [...rowsToDelete] },
      });
      console.log(`\nDeleted auto-created permission rows: ${result.deletedCount}`);
    }

    let updated = 0;
    for (const finding of technicianFindings) {
      await TechnicianProfile.updateOne(
        { _id: finding.technicianId },
        {
          $set: {
            enabledDistrictIds: finding.remainingDistrictIds,
            allowedCityIds: finding.remainingDistrictIds,
            enabledCityZoneIds: finding.desiredZoneIds,
          },
        }
      );

      await writeAuditLog({
        action: "TECHNICIAN_COVERAGE_CLEANUP",
        targetType: "TechnicianProfile",
        targetId: finding.technicianId,
        before: {
          autoPermissionRows: finding.autoPermissionRows,
          enabledDistrictIds: finding.currentDistrictIds,
          allowedCityIds: finding.currentAllowedIds,
          orphanZoneIds: finding.orphanZoneIds,
        },
        after: {
          enabledDistrictIds: finding.remainingDistrictIds,
          allowedCityIds: finding.remainingDistrictIds,
          enabledCityZoneIds: finding.desiredZoneIds,
        },
        reason:
          "Removed auto-created district coverage. Registration address/GPS does not grant work permission.",
      });

      updated += 1;
    }

    console.log(`Reconciled technicians: ${updated}`);
    console.log("Cleanup complete. Technician workStatus values were not changed.");
  } finally {
    await mongoose.disconnect();
  }
};

run().catch((err) => {
  console.error("Technician coverage audit failed:", err.message);
  process.exitCode = 1;
});
