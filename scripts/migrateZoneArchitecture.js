/**
 * Zone architecture migration — one-time backfill.
 *
 * 1. ServiceAvailability legacy docs: copy cityId -> cityZoneId where
 *    cityZoneId is null and scope in [CITY, ZONE]. Keeps cityId for compat.
 * 2. Technician grandfather: add cityZoneId/currentCityZoneId into
 *    enabledCityZoneIds (strict approval model would otherwise lock out
 *    registration-only techs). Run once; new approvals remain admin-driven.
 * 3. Seed missing ZoneServiceMapping rows (active:false default) for every
 *    (active zone x active service) pair + matching ZONE DISABLED
 *    ServiceAvailability overrides where no override exists. Never overwrites
 *    existing active mappings / overrides.
 *
 * Usage:
 *   node scripts/migrateZoneArchitecture.js [--dry-run]
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

  const ServiceAvailability = (await import("../modules/geo/models/ServiceAvailability.js")).default;
  const ZoneServiceMapping = (await import("../modules/geo/models/ZoneServiceMapping.js")).default;
  const CityZone = (await import("../modules/geo/models/CityZone.js")).default;
  const Service = (await import("../modules/catalog/models/Service.js")).default;
  const TechnicianProfile = (await import("../modules/technician/models/TechnicianProfile.js")).default;

  // ---- 1. Legacy cityId -> cityZoneId backfill ----
  const legacyDocs = await ServiceAvailability.find({
    cityZoneId: null,
    cityId: { $ne: null },
    scope: { $in: ["CITY", "ZONE"] },
  })
    .select("_id serviceId districtId cityId scope status")
    .lean();
  console.log(`[1] Legacy availability docs needing backfill: ${legacyDocs.length}`);
  let backfilled = 0;
  for (const doc of legacyDocs) {
    if (DRY_RUN) continue;
    try {
      await ServiceAvailability.updateOne(
        { _id: doc._id },
        { $set: { cityZoneId: doc.cityId } }
      );
      backfilled++;
    } catch (e) {
      // Duplicate after backfill (same service/district/zone/scope already has a row):
      // keep DISABLED-wins, drop the redundant legacy row.
      const existing = await ServiceAvailability.findOne({
        serviceId: doc.serviceId,
        districtId: doc.districtId,
        cityZoneId: doc.cityId,
        scope: doc.scope,
        _id: { $ne: doc._id },
      }).lean();
      if (existing) {
        if (existing.status !== "DISABLED" && doc.status === "DISABLED") {
          await ServiceAvailability.updateOne({ _id: existing._id }, { $set: { status: "DISABLED" } });
        }
        await ServiceAvailability.deleteOne({ _id: doc._id });
        backfilled++;
        console.log(`[1] Merged duplicate legacy doc ${doc._id}`);
      } else {
        console.warn(`[1] Backfill failed for ${doc._id}: ${e.message}`);
      }
    }
  }
  console.log(`[1] Backfilled: ${backfilled}`);

  // ---- 2. Technician grandfather (registration zones -> approved) ----
  const techsNeeding = await TechnicianProfile.find({
    $or: [
      { cityZoneId: { $ne: null } },
      { currentCityZoneId: { $ne: null } },
    ],
  })
    .select("_id cityZoneId currentCityZoneId enabledCityZoneIds")
    .lean();
  let grandfathered = 0;
  for (const t of techsNeeding) {
    const enabled = new Set((t.enabledCityZoneIds || []).map(String));
    const toAdd = [];
    for (const z of [t.cityZoneId, t.currentCityZoneId]) {
      if (z && !enabled.has(String(z))) toAdd.push(z);
    }
    if (!toAdd.length) continue;
    if (DRY_RUN) {
      grandfathered++;
      continue;
    }
    await TechnicianProfile.updateOne(
      { _id: t._id },
      { $addToSet: { enabledCityZoneIds: { $each: toAdd } } }
    );
    grandfathered++;
  }
  console.log(`[2] Technicians grandfathered (registration zones approved): ${grandfathered} / scanned ${techsNeeding.length}`);

  // ---- 3. Seed missing DISABLED mappings for existing zones ----
  const [zones, services] = await Promise.all([
    CityZone.find({}).select("_id active operationalCityId").lean(),
    Service.find({ isActive: true }).select("_id").lean(),
  ]);
  console.log(`[3] Zones: ${zones.length}, active services: ${services.length}`);
  const existingMaps = await ZoneServiceMapping.find({}).select("zoneId serviceId").lean();
  const mapSet = new Set(existingMaps.map((m) => `${String(m.zoneId)}_${String(m.serviceId)}`));
  const existingAvail = await ServiceAvailability.find({ scope: { $in: ["ZONE", "CITY"] } })
    .select("serviceId districtId cityZoneId cityId")
    .lean();
  const availSet = new Set(
    existingAvail.map((a) => `${String(a.serviceId)}_${String(a.districtId)}_${String(a.cityZoneId || a.cityId)}`)
  );

  let mapsToSeed = [];
  let availToSeed = [];
  for (const z of zones) {
    for (const s of services) {
      const key = `${String(z._id)}_${String(s._id)}`;
      if (!mapSet.has(key)) {
        mapsToSeed.push({
          updateOne: {
            filter: { zoneId: z._id, serviceId: s._id },
            update: {
              $setOnInsert: { zoneId: z._id, serviceId: s._id, approvedAt: new Date() },
              $set: { active: false },
            },
            upsert: true,
          },
        });
      }
      const aKey = `${String(s._id)}_${String(z.operationalCityId)}_${String(z._id)}`;
      if (!availSet.has(aKey)) {
        availToSeed.push({
          updateOne: {
            filter: { serviceId: s._id, districtId: z.operationalCityId, cityZoneId: z._id, scope: "ZONE" },
            update: {
              $set: {
                serviceId: s._id,
                districtId: z.operationalCityId,
                cityZoneId: z._id,
                scope: "ZONE",
                status: "DISABLED",
              },
            },
            upsert: true,
          },
        });
      }
    }
  }
  console.log(`[3] Missing mappings to seed (DISABLED): ${mapsToSeed.length}`);
  console.log(`[3] Missing ZONE overrides to seed (DISABLED): ${availToSeed.length}`);
  // NOTE: seeding a DISABLED override for a zone/service that already has an
  // ACTIVE mapping would wrongly disable it. Filter those out: only seed the
  // override when there is no active mapping for that pair.
  const activeMapSet = new Set(
    (await ZoneServiceMapping.find({ active: true }).select("zoneId serviceId").lean()).map(
      (m) => `${String(m.serviceId)}_${String(m.zoneId)}`
    )
  );
  const filteredAvailSeed = availToSeed.filter((op) => {
    const f = op.updateOne.filter;
    return !activeMapSet.has(`${String(f.serviceId)}_${String(f.cityZoneId)}`);
  });
  console.log(`[3] ZONE overrides after active-mapping filter: ${filteredAvailSeed.length}`);

  if (!DRY_RUN) {
    if (mapsToSeed.length) {
      const r = await ZoneServiceMapping.bulkWrite(mapsToSeed, { ordered: false });
      console.log(`[3] Mappings upserted: ${r.upsertedCount}, modified: ${r.modifiedCount}`);
    }
    if (filteredAvailSeed.length) {
      const r2 = await ServiceAvailability.bulkWrite(filteredAvailSeed, { ordered: false });
      console.log(`[3] Overrides upserted: ${r2.upsertedCount}, modified: ${r2.modifiedCount}`);
    }
  }

  console.log("Migration complete.");
  await mongoose.disconnect();
};

run().catch((e) => {
  console.error("Migration failed:", e);
  process.exit(1);
});
