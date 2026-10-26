

import "dotenv/config";
import fs from "node:fs";
import mongoose from "mongoose";

const EXPECTED_DB = "RightTouch4";
const CONFIRM_TOKEN = "CLEAR_TRANSACTIONAL_DATA";

// Core-only keep list requested by the operator. TechnicianProfile is kept
// because TechnicianKYC references it and it holds technician account data.
const KEEP_COLLECTIONS = new Set([
  "users",
  "technicianprofiles",
  "techniciankycs",
  "addresses",
  "addresscounters",
  "products",
  "services",
  "categories",
  "devicetokens",
  "notificationpreferences",
  "permissions",
]);

// Human-readable delete order: children/outboxes before parents/ledgers.
const DELETE_ORDER = [
  "notificationdeliveries",
  "notificationoutboxes",
  "dispatchoutboxes",
  "bookingoutboxes",
  "refundoutboxes",
  "payoutoutboxes",
  "jobbroadcasts",
  "technicianbookingoffers",
  "servicecompletionchallenges",
  "otps",
  "technicianlocationhistories",
  "technicianskillrequests",
  "auditlogs",
  "reports",
  "ratings",
  "permissionhistories",
  "districtpermissionhistories",
  "technicianzonepermissionaudits",
  "notifications",
  "servicebookings",
  "productbookings",
  "carts",
  "quotations",
  "productquoterequests",
  "quotationdeliveries",
  "payments",
  "paymentattempts",
  "paymentevents",
  "receipts",
  "refunds",
  "creditnotes",
  "chargebacks",
  "customerrefundpayouts",
  "bookingpayoutblocks",
  "reserveholds",
  "reconciliationexceptions",
  "platformledgerentries",
  "wallettransactions",
  "withdrawalrequests",
  "customerrewardswallets",
  "rewardlots",
  "rewardredemptions",
  "rewardtransactions",
  "tempusers",
  "authsessions",
  "workerwatermarks",
  "operationalcities",
  "cityzones",
  "polygonversions",
  "serviceavailabilities",
  "zoneservicemappings",
  "servicecommissionrules",
  "techniciandistrictpermissions",
  "globalsettings",
  "rewardpolicies",
];

const parseArgs = (argv) => {
  const args = { dryRun: true, confirm: null, backup: null, db: EXPECTED_DB };
  for (const arg of argv) {
    if (arg === "--execute") args.dryRun = false;
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg.startsWith("--confirm=")) args.confirm = arg.slice("--confirm=".length);
    else if (arg.startsWith("--backup=")) args.backup = arg.slice("--backup=".length);
    else if (arg.startsWith("--db=")) args.db = arg.slice("--db=".length);
    else if (arg === "--help") {
      console.log(
        [
          "Usage:",
          "  node scripts/clearTransactionalData.js --dry-run",
          "  node scripts/clearTransactionalData.js --execute --confirm=CLEAR_TRANSACTIONAL_DATA --backup=/path/to/backup.archive.gz",
          "",
          "The script refuses to run unless the connected database is RightTouch4.",
        ].join("\n")
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
};

const fmt = (n) => Number(n || 0).toLocaleString("en-IN");

const main = async () => {
  const args = parseArgs(process.argv.slice(2));

  if (!process.env.MONGO_URI) throw new Error("MONGO_URI is not configured");
  if (args.db !== EXPECTED_DB) {
    throw new Error(`Refusing database "${args.db}"; expected "${EXPECTED_DB}"`);
  }

  await mongoose.connect(process.env.MONGO_URI, {
    maxPoolSize: 5,
    serverSelectionTimeoutMS: 10000,
  });

  const db = mongoose.connection.db;
  const dbName = db.databaseName;
  if (dbName !== EXPECTED_DB) {
    throw new Error(`Connected to "${dbName}", expected "${EXPECTED_DB}"`);
  }

  const collectionInfos = await db.listCollections().toArray();
  const collections = collectionInfos
    .filter((c) => c.type !== "view" && !c.name.startsWith("system."))
    .map((c) => c.name);

  const keepExisting = collections.filter((name) => KEEP_COLLECTIONS.has(name));
  const unknownExisting = collections.filter((name) => !KEEP_COLLECTIONS.has(name));
  const deleteSet = new Set(unknownExisting);
  const orderedDelete = [
    ...DELETE_ORDER.filter((name) => deleteSet.has(name)),
    ...unknownExisting
      .filter((name) => !DELETE_ORDER.includes(name))
      .sort(),
  ];

  console.log(`Database: ${dbName}`);
  console.log(`Mode: ${args.dryRun ? "DRY RUN" : "EXECUTE"}`);
  console.log(`Keep collections: ${keepExisting.length}`);
  console.log(`Delete collections: ${orderedDelete.length}`);

  console.log("\nKEEP");
  for (const name of keepExisting) {
    const count = await db.collection(name).countDocuments({});
    console.log(`  ${name.padEnd(32)} ${fmt(count)}`);
  }

  console.log("\nDELETE");
  let totalToDelete = 0;
  for (const name of orderedDelete) {
    const count = await db.collection(name).countDocuments({});
    totalToDelete += count;
    console.log(`  ${name.padEnd(32)} ${fmt(count)}`);
  }
  console.log(`  ${"TOTAL".padEnd(32)} ${fmt(totalToDelete)}`);

  if (args.dryRun) {
    console.log("\nDry run complete. No writes were made.");
    return;
  }

  if (args.confirm !== CONFIRM_TOKEN) {
    throw new Error(
      `Execution requires --confirm=${CONFIRM_TOKEN}`
    );
  }
  if (!args.backup) {
    throw new Error("Execution requires --backup=/path/to/verified/backup.archive.gz");
  }
  if (!fs.existsSync(args.backup)) {
    throw new Error(`Backup not found: ${args.backup}`);
  }
  const backupSize = fs.statSync(args.backup).size;
  if (backupSize <= 0) {
    throw new Error(`Backup is empty: ${args.backup}`);
  }
  console.log(`\nBackup: ${args.backup} (${fmt(backupSize)} bytes)`);

  console.log("\nDELETING");
  for (const name of orderedDelete) {
    const res = await db.collection(name).deleteMany({});
    console.log(`  ${name.padEnd(32)} deleted ${fmt(res.deletedCount)}`);
  }

  console.log("\nRESETTING RETAINED DOCUMENTS");
  const now = new Date();

  const techReset = await db.collection("technicianprofiles").updateMany(
    {},
    {
      $set: {
        location: null,
        locationUpdatedAt: null,
        primaryCityId: null,
        primaryDistrictId: null,
        allowedCityIds: [],
        enabledDistrictIds: [],
        enabledCityZoneIds: [],
        cityZoneId: null,
        currentDistrictId: null,
        currentCityZoneId: null,
        zoneMismatch: false,
        zoneMismatchSince: null,
        dispatchLockUntil: null,
        lastMatchingAt: null,
        lastJobsChangeAt: null,
        isRead: false,
        readAt: null,
        readBy: null,
        rating: { avg: 0, count: 0 },
        walletBalance: 0,
        availableBalancePaise: 0,
        reservedBalancePaise: 0,
        reserveBalancePaise: 0,
        outstandingDuesPaise: 0,
        lifetimeEarnedPaise: 0,
        lifetimeWithdrawnPaise: 0,
        walletVersion: 0,
        totalJobsCompleted: 0,
        jobRejectCount: 0,
        "availability.isOnline": false,
        "availability.offlineReason": "data_reset",
        "availability.offlineAt": now,
      },
    }
  );
  console.log(`  technicianprofiles reset: ${fmt(techReset.modifiedCount)}`);

  const userReset = await db.collection("users").updateMany(
    {},
    { $inc: { tokenVersion: 1 } }
  );
  console.log(`  users session-invalidated: ${fmt(userReset.modifiedCount)}`);

  for (const name of ["products", "services"]) {
    const res = await db.collection(name).updateMany(
      {},
      {
        $set: {
          "ratingSummary.averageRating": 0,
          "ratingSummary.totalRatings": 0,
        },
      }
    );
    console.log(`  ${name} ratings reset: ${fmt(res.modifiedCount)}`);
  }

  console.log("\nVERIFYING");
  let remaining = 0;
  for (const name of orderedDelete) {
    const count = await db.collection(name).countDocuments({});
    if (count !== 0) {
      remaining += count;
      console.log(`  ⚠️ ${name} still has ${fmt(count)} docs`);
    }
  }
  if (remaining !== 0) {
    throw new Error(`Cleanup incomplete: ${fmt(remaining)} documents remain`);
  }
  console.log("  All non-keep collections are empty.");

  for (const name of keepExisting) {
    const count = await db.collection(name).countDocuments({});
    console.log(`  kept ${name.padEnd(32)} ${fmt(count)}`);
  }

  console.log("\nCleanup complete.");
};

main()
  .catch((err) => {
    console.error(`\nERROR: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => {});
  });
