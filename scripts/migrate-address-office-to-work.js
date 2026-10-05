/**
 * Address label migration: office -> work (one-time backfill).
 *
 * Updates:
 *  1. Address docs with label "office" -> "work"
 *  2. ServiceBooking addressSnapshot.label "office" -> "work"
 *
 * Usage:
 *   node scripts/migrate-address-office-to-work.js [--dry-run]
 */
import mongoose from "mongoose";
import dotenv from "dotenv";

dotenv.config();

const DRY_RUN = process.argv.includes("--dry-run");

const run = async () => {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI missing in env");

  await mongoose.connect(uri, { maxPoolSize: 5, serverSelectionTimeoutMS: 15000 });
  console.log(`Connected. DRY_RUN=${DRY_RUN}`);

  const Address = (await import("../modules/cart-address/models/Address.js")).default;
  const ServiceBooking = (await import("../modules/booking/models/ServiceBooking.js")).default;

  const officeAddresses = await Address.countDocuments({ label: "office" });
  console.log(`Address docs with label=office: ${officeAddresses}`);

  if (!DRY_RUN && officeAddresses > 0) {
    const r = await Address.updateMany({ label: "office" }, { $set: { label: "work" } });
    console.log(`Migrated addresses: ${r.modifiedCount}`);
  }

  const officeSnapshots = await ServiceBooking.countDocuments({ "addressSnapshot.label": "office" });
  console.log(`ServiceBooking snapshots with label=office: ${officeSnapshots}`);

  if (!DRY_RUN && officeSnapshots > 0) {
    const r2 = await ServiceBooking.updateMany(
      { "addressSnapshot.label": "office" },
      { $set: { "addressSnapshot.label": "work" } }
    );
    console.log(`Migrated booking snapshots: ${r2.modifiedCount}`);
  }

  await mongoose.disconnect();
  console.log("Done.");
};

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
