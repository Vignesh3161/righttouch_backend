import "dotenv/config";
import mongoose from "mongoose";
import TechnicianDistrictPermission from "../Schemas/TechnicianDistrictPermission.js";
import { syncAllowedCityIds } from "../Services/technicianDistrictService.js";

const usage = () => {
  console.log(`Usage: node scripts/migratePrimaryDistrictPermissions.js [options]

Options:
  --apply   Demote legacy PRIMARY permission rows to ADDITIONAL and resync
            technician grant arrays. Without this flag the script is a dry run.
  --help    Show this message.

Primary district is registration metadata only. After this migration every
district grant — including the technician's primary district — is an explicit
ADDITIONAL permission row that admins can disable or revoke.`);
};

const parseArgs = (argv) => {
  const args = { apply: false, help: false };
  for (const arg of argv) {
    if (arg === "--apply") args.apply = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
};

const run = async () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }

  if (!process.env.MONGO_URI) throw new Error("MONGO_URI is not configured");

  await mongoose.connect(process.env.MONGO_URI, {
    maxPoolSize: 5,
    serverSelectionTimeoutMS: 10000,
  });

  try {
    const dbName = mongoose.connection.db.databaseName;
    const primaryRows = await TechnicianDistrictPermission.find({
      permissionType: "PRIMARY",
    })
      .select("technicianId districtId isEnabled")
      .lean();

    const technicianIds = [
      ...new Set(primaryRows.map((row) => String(row.technicianId)).filter(Boolean)),
    ];

    console.log(`Database: ${dbName}`);
    console.log(`Mode: ${args.apply ? "APPLY" : "DRY RUN"}`);
    console.log(`Legacy PRIMARY rows: ${primaryRows.length}`);
    console.log(`Affected technicians: ${technicianIds.length}`);

    if (!args.apply) {
      console.log("\nDry run complete. No writes were made.");
      return;
    }

    const result = await TechnicianDistrictPermission.updateMany(
      { permissionType: "PRIMARY" },
      { $set: { permissionType: "ADDITIONAL" } }
    );
    console.log(`\nDemoted rows: ${result.modifiedCount}`);

    let resynced = 0;
    for (const technicianId of technicianIds) {
      await syncAllowedCityIds(technicianId);
      resynced++;
    }
    console.log(`Resynced technicians: ${resynced}`);
  } finally {
    await mongoose.disconnect();
  }
};

run().catch((err) => {
  console.error("Migration failed:", err.message);
  process.exitCode = 1;
});
