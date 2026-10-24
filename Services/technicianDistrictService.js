import mongoose from "mongoose";
import TechnicianProfile from "../Schemas/TechnicianProfile.js";
import OperationalCity from "../Schemas/OperationalCity.js";
import TechnicianDistrictPermission from "../Schemas/TechnicianDistrictPermission.js";
import TechnicianZonePermissionAudit from "../Schemas/TechnicianZonePermissionAudit.js";
import CityZone from "../Schemas/CityZone.js";
import DistrictPermissionHistory from "../Schemas/DistrictPermissionHistory.js";
import { writeAuditLog } from "../Utils/audit.js";
import { withZoneWriteTransaction } from "./zoneWriteService.js";

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * B-13 source-of-truth contract (documented):
 * - AUTHORITATIVE: TechnicianDistrictPermission documents (unique
 *   {technicianId, districtId}, enabledBy provenance, history rows).
 * - DERIVED CACHES: TechnicianProfile.allowedCityIds + enabledDistrictIds.
 *   Maintained ONLY by this service, recomputed from the rows inside the
 *   same transaction, so concurrent writers converge instead of clobbering.
 * - READERS: eligibility hot paths read the profile caches (no extra query);
 *   admin readers union caches + rows (getAllowedDistrictsForTechnician).
 */

// Recompute both derived arrays from the authoritative rows. Must run
// inside the caller's transaction (reads own writes; concurrent txns that
// touch the same profile doc conflict and retry/409 instead of clobbering).
const resyncDerivedArrays = async (technicianId, session) => {
  const q = TechnicianDistrictPermission.find({ technicianId, isEnabled: true }).select("districtId permissionType");
  const rows = session ? await q.session(session).lean() : await q.lean();
  const ids = [...new Set(rows.map((r) => String(r.districtId)).filter(Boolean))];
  const pq = TechnicianProfile.updateOne(
    { _id: technicianId },
    { $set: { allowedCityIds: ids, enabledDistrictIds: ids } }
  );
  if (session) await pq.session(session);
  else await pq;
  return ids;
};

const historyActionFor = (kind) => ({ grant: "GRANT", revoke: "REVOKE", enable: "ENABLE", disable: "DISABLE" })[kind];

const writePermissionHistory = async ({ technicianId, districtId, kind, adminUserId, reason }, session) => {
  const doc = {
    technicianId,
    districtId,
    action: historyActionFor(kind),
    adminId: adminUserId,
    reason: reason || "Admin district permission change",
  };
  if (session) await DistrictPermissionHistory.create([doc], { session });
  else await DistrictPermissionHistory.create(doc);
};


// District grants carry their zones with them. Every booking is zone-scoped,
// so a district permission without zones can never authorize a job. Keep zone
// grants + audit rows in the same transaction as the district row.
const syncDistrictZones = async ({
  technicianId,
  districtId,
  enabled,
  adminUserId,
  reason,
  session,
}) => {
  const zoneQuery = CityZone.find({
    operationalCityId: districtId,
    ...(enabled ? { active: { $ne: false } } : {}),
  }).select("_id");
  const zones = session ? await zoneQuery.session(session).lean() : await zoneQuery.lean();
  const zoneIds = zones.map((z) => z._id);
  if (!zoneIds.length) return [];

  const profileUpdate = TechnicianProfile.updateOne(
    { _id: technicianId },
    enabled
      ? { $addToSet: { enabledCityZoneIds: { $each: zoneIds } } }
      : { $pull: { enabledCityZoneIds: { $in: zoneIds } } }
  );
  if (session) await profileUpdate.session(session);
  else await profileUpdate;

  if (adminUserId) {
    const auditDocs = zoneIds.map((cityZoneId) => ({
      technicianId,
      cityZoneId,
      action: enabled ? "enabled" : "disabled",
      changedBy: adminUserId,
      reason: reason || (enabled ? "Inherited from district grant" : "Removed with district permission"),
    }));
    if (session) {
      await TechnicianZonePermissionAudit.insertMany(auditDocs, { session, ordered: false });
    } else {
      await TechnicianZonePermissionAudit.insertMany(auditDocs, { ordered: false });
    }
  }
  return zoneIds;
};

// Controlled-conflict wrapper: duplicate rows and write conflicts become
// retryable client errors, never silent clobbers or raw driver errors.
const asConflict = (err, fallbackCode = "PERMISSION_CONFLICT") => {
  if (err?.code === 11000) {
    const e = new Error("District permission already granted for this technician");
    e.code = "PERMISSION_ALREADY_GRANTED";
    e.statusCode = 409;
    return e;
  }
  const labels = err?.errorLabels || [];
  if (
    labels.includes("TransientTransactionError") ||
    labels.includes("UnknownTransactionCommitResult") ||
    err?.code === 112 ||
    /WriteConflict|WriteConcern|wtimeout/i.test(String(err?.message || ""))
  ) {
    const e = new Error("Permission changed concurrently, please retry");
    e.code = "PERMISSION_CONCURRENT_CONFLICT";
    e.statusCode = 409;
    return e;
  }
  err.code = err.code || fallbackCode;
  return err;
};

/**
 * 🗺 TECHNICIAN DISTRICT SERVICE
 * Business logic layer for technician district permissions and authorization.
 */

/**
 * Syncs derived profile arrays with enabled TechnicianDistrictPermission
 * records. Legacy standalone entry point (kept for compatibility); the
 * mutation flows below resync inside their own transaction instead.
 */
export const syncAllowedCityIds = async (technicianProfileId) => {
  const profile = await TechnicianProfile.findById(technicianProfileId).select("_id").lean();
  if (!profile) return [];
  return resyncDerivedArrays(technicianProfileId, null);
};

/**
 * Returns explicitly enabled district permission IDs for a technician.
 * The primary district is auto-seeded as a PRIMARY permission row, but it is
 * never returned from profile metadata alone. Permission rows are the only
 * authorization source.
 */
export const getAllowedDistrictsForTechnician = async (techProfile) => {
  if (!techProfile) return [];

  let profileDoc = techProfile;
  if (typeof techProfile === "string" || techProfile instanceof mongoose.Types.ObjectId) {
    profileDoc = await TechnicianProfile.findById(techProfile)
      .select("_id primaryCityId primaryDistrictId allowedCityIds cityZoneId city")
      .lean();
  }

  if (!profileDoc) return [];

  let primaryId = profileDoc.primaryCityId || profileDoc.primaryDistrictId;

  // Auto-heal legacy profile if primary is null.
  if (!primaryId && profileDoc.city) {
    const cityRegex = new RegExp(`^${escapeRegExp(String(profileDoc.city).trim())}$`, "i");
    const matchedCity = await OperationalCity.findOne({
      $or: [
        { city: cityRegex },
        { name: cityRegex },
        { name: new RegExp(escapeRegExp(String(profileDoc.city).trim()), "i") },
      ],
      active: true,
    })
      .select("_id")
      .lean();

    if (matchedCity?._id) {
      primaryId = matchedCity._id;
      await TechnicianProfile.updateOne(
        { _id: profileDoc._id },
        { $set: { primaryCityId: primaryId, primaryDistrictId: primaryId } }
      ).catch(() => {});
    }
  }

  if (primaryId) {
    await TechnicianDistrictPermission.updateOne(
      { technicianId: profileDoc._id, districtId: primaryId },
      { $setOnInsert: { permissionType: "PRIMARY", isEnabled: true, enabledAt: new Date() } },
      { upsert: true }
    ).catch(() => {});
  }

  const permissions = await TechnicianDistrictPermission.find({
    technicianId: profileDoc._id,
    isEnabled: true,
  })
    .select("districtId")
    .lean();

  return Array.from(new Set(permissions.map((p) => String(p.districtId)).filter(Boolean)));
};

/**
 * Evaluates whether a technician is authorized to work in a specific district.
 * Checks district status, job enablement, primary district, and additional permissions.
 */
export const isTechnicianAllowedInDistrict = async (technicianId, districtId) => {
  if (!technicianId || !districtId) return false;

  const district = await OperationalCity.findById(districtId).select("active isJobEnabled").lean();
  if (!district || district.active === false || district.isJobEnabled === false) {
    return false;
  }

  const allowedDistrictIds = await TechnicianDistrictPermission.find({
    technicianId,
    isEnabled: true,
  }).distinct("districtId");
  return allowedDistrictIds.map(String).includes(String(districtId));
};

/**
 * Admin action: Adds an additional district permission to a technician.
 * Canonical writer (B-13): permission row + derived arrays + history +
 * audit commit together; concurrent duplicate grants surface as 409.
 */
export const addDistrictPermission = async ({ technicianId, districtId, adminUserId, adminId, adminRole, reason }) => {
  // B-13 compat: accept the legacy `adminId` alias for the actor.
  adminUserId = adminUserId || adminId;
  const fail = (code, message, statusCode = 400) => {
    const err = new Error(message);
    err.code = code;
    err.statusCode = statusCode;
    throw err;
  };

  const profile = await TechnicianProfile.findById(technicianId);
  if (!profile || profile.workStatus === "deleted" || profile.workStatus === "suspended") {
    fail("TECHNICIAN_INACTIVE", "Technician does not exist or is not active");
  }

  const district = await OperationalCity.findById(districtId);
  if (!district || district.active === false || district.isActive === false) {
    fail("DISTRICT_INACTIVE", "District does not exist or is inactive");
  }

  if (district.isJobEnabled === false) {
    fail("DISTRICT_JOBS_DISABLED", "District job assignment is currently disabled");
  }

  if (profile.primaryCityId && String(profile.primaryCityId) === String(districtId)) {
    fail("ALREADY_PRIMARY_DISTRICT", "District is already technician's primary district");
  }

  // Advisory duplicate signal (preserves the existing 400 contract for
  // sequential duplicates). True races resolve idempotently in the txn.
  const dupe = await TechnicianDistrictPermission.findOne({ technicianId, districtId, isEnabled: true })
    .select("_id")
    .lean();
  if (dupe) {
    fail("PERMISSION_ALREADY_GRANTED", "District permission already granted for this technician");
  }

  try {
    await withZoneWriteTransaction(async (session) => {
      const opts = session ? { session } : {};
      // Atomic upsert: concurrent duplicate grants collapse into one row
      // (idempotent success, no duplicate-key 500s); re-grant of a disabled
      // row re-enables with fresh provenance.
      await TechnicianDistrictPermission.updateOne(
        { technicianId, districtId },
        {
          $setOnInsert: { technicianId, districtId, permissionType: "ADDITIONAL" },
          $set: { isEnabled: true, enabledBy: adminUserId, enabledAt: new Date(), disabledBy: null, disabledAt: null },
        },
        { ...opts, upsert: true }
      );
      // Adopt as primary when the technician has none (previously done only
      // by the geofence route — now consistent for every grant path).
      if (!profile.primaryCityId && !profile.primaryDistrictId) {
        await TechnicianProfile.updateOne(
          { _id: technicianId, $or: [{ primaryCityId: null }, { primaryDistrictId: null }] },
          { $set: { primaryCityId: districtId, primaryDistrictId: districtId } },
          opts
        );
      }
      await resyncDerivedArrays(technicianId, session);
      await syncDistrictZones({ technicianId, districtId, enabled: true, adminUserId, reason, session });
      await writePermissionHistory({ technicianId, districtId, kind: "grant", adminUserId, reason }, session);
    });
  } catch (err) {
    if (err.statusCode) throw err;
    throw asConflict(err);
  }

  await writeAuditLog({
    actor: adminUserId,
    actorRole: adminRole || "Admin",
    action: "DISTRICT_ADDED",
    targetType: "TechnicianProfile",
    targetId: technicianId,
    after: { districtId, isEnabled: true },
  });

  return { success: true, message: "District permission added successfully" };
};

/**
 * Approval gate: an approved technician must have at least one working zone.
 * Ensures the primary/adopted district permission row exists and inherits all
 * active zones. Safe to call repeatedly (idempotent).
 */
export const ensureApprovedDistrictZones = async ({
  technicianId,
  adminUserId,
  reason,
}) => {
  const fail = (code, message, statusCode = 400) => {
    const err = new Error(message);
    err.code = code;
    err.statusCode = statusCode;
    throw err;
  };

  const profile = await TechnicianProfile.findById(technicianId).select(
    "primaryDistrictId primaryCityId cityZoneId enabledDistrictIds allowedCityIds enabledCityZoneIds"
  );
  if (!profile) fail("TECHNICIAN_NOT_FOUND", "Technician not found", 404);

  let districtId = profile.primaryDistrictId || profile.primaryCityId;
  if (!districtId && profile.cityZoneId) {
    const zone = await CityZone.findById(profile.cityZoneId).select("operationalCityId").lean();
    districtId = zone?.operationalCityId || null;
  }
  if (!districtId) {
    districtId = [...(profile.enabledDistrictIds || []), ...(profile.allowedCityIds || [])][0] || null;
  }
  if (!districtId) {
    fail("PRIMARY_DISTRICT_REQUIRED", "Assign the technician to a district/zone before approval");
  }

  const district = await OperationalCity.findById(districtId);
  if (!district || district.active === false || district.isActive === false) {
    fail("DISTRICT_INACTIVE", "Cannot approve: technician's district is inactive");
  }
  if (district.isJobEnabled === false) {
    fail("DISTRICT_JOBS_DISABLED", "Cannot approve: technician's district job assignment is disabled");
  }

  const primaryActiveZones = await CityZone.find({
    operationalCityId: districtId,
    active: { $ne: false },
  }).select("_id").lean();
  if (primaryActiveZones.length === 0) {
    fail("NO_ACTIVE_ZONES", "Cannot approve: technician's district has no active zones");
  }

  // Promote legacy profile arrays to real permission rows instead of silently
  // revoking access when derived arrays are recomputed from rows.
  const legacyDistrictIds = [
    ...(profile.enabledDistrictIds || []),
    ...(profile.allowedCityIds || []),
  ]
    .map((id) => String(id?._id || id))
    .filter((id) => id && id !== String(districtId));
  const legacyGrants = [];
  for (const legacyId of [...new Set(legacyDistrictIds)]) {
    if (!mongoose.Types.ObjectId.isValid(legacyId)) continue;
    const legacyDistrict = await OperationalCity.findById(legacyId).select("active isJobEnabled").lean();
    if (!legacyDistrict || legacyDistrict.active === false || legacyDistrict.isJobEnabled === false) continue;
    const zoneCount = await CityZone.countDocuments({
      operationalCityId: legacyId,
      active: { $ne: false },
    });
    if (zoneCount > 0) legacyGrants.push(legacyId);
  }

  try {
    await withZoneWriteTransaction(async (session) => {
      const opts = session ? { session } : {};
      await TechnicianProfile.updateOne(
        { _id: technicianId },
        { $set: { primaryDistrictId: districtId, primaryCityId: districtId } },
        opts
      );
      let existingQuery = TechnicianDistrictPermission.findOne({
        technicianId,
        districtId,
      }).select("_id isEnabled");
      if (session) existingQuery = existingQuery.session(session);
      const existing = await existingQuery.lean();
      await TechnicianDistrictPermission.updateOne(
        { technicianId, districtId },
        {
          $setOnInsert: { technicianId, districtId, permissionType: "PRIMARY" },
          $set: {
            isEnabled: true,
            enabledBy: adminUserId || null,
            enabledAt: new Date(),
            disabledBy: null,
            disabledAt: null,
          },
        },
        { ...opts, upsert: true }
      );
      for (const legacyId of legacyGrants) {
        await TechnicianDistrictPermission.updateOne(
          { technicianId, districtId: legacyId },
          {
            $setOnInsert: { technicianId, districtId: legacyId, permissionType: "ADDITIONAL" },
            $set: {
              isEnabled: true,
              enabledBy: adminUserId || null,
              enabledAt: new Date(),
              disabledBy: null,
              disabledAt: null,
            },
          },
          { ...opts, upsert: true }
        );
      }
      await resyncDerivedArrays(technicianId, session);
      await syncDistrictZones({
        technicianId,
        districtId,
        enabled: true,
        adminUserId,
        reason: reason || "Technician approved",
        session,
      });
      for (const legacyId of legacyGrants) {
        await syncDistrictZones({
          technicianId,
          districtId: legacyId,
          enabled: true,
          adminUserId,
          reason: reason || "Legacy district grant migrated",
          session,
        });
      }
      if (existing && !existing.isEnabled) {
        await writePermissionHistory(
          { technicianId, districtId, kind: "enable", adminUserId, reason: reason || "Technician approved" },
          session
        );
      }
    });
  } catch (err) {
    if (err.statusCode) throw err;
    throw asConflict(err);
  }

  return { districtId: String(districtId) };
};

/**
 * Admin action: Enables or disables an additional district permission for a technician.
 * Canonical writer (B-13): conditional row update (concurrent toggles
 * conflict as 409 instead of clobbering) + derived-array resync + history,
 * all in one transaction.
 */
export const toggleDistrictPermission = async ({ technicianId, districtId, isEnabled, adminUserId, adminId, adminRole, reason }) => {
  // B-13 compat: accept the legacy `adminId` alias for the actor.
  adminUserId = adminUserId || adminId;
  const fail = (code, message, statusCode = 400) => {
    const err = new Error(message);
    err.code = code;
    err.statusCode = statusCode;
    throw err;
  };

  const profile = await TechnicianProfile.findById(technicianId);
  if (!profile) {
    fail("TECHNICIAN_NOT_FOUND", "Technician not found", 404);
  }

  if (profile.primaryCityId && String(profile.primaryCityId) === String(districtId)) {
    fail("PRIMARY_DISTRICT_PROTECTED", "Cannot disable technician's primary district permission via additional permissions");
  }

  if (isEnabled) {
    const district = await OperationalCity.findById(districtId);
    if (!district || district.active === false || district.isActive === false) {
      fail("DISTRICT_INACTIVE", "Cannot enable permission: District does not exist or is inactive");
    }
    if (district.isJobEnabled === false) {
      fail("DISTRICT_JOBS_DISABLED", "Cannot enable permission: District job assignment is disabled");
    }
  }

  try {
    await withZoneWriteTransaction(async (session) => {
      const opts = session ? { session } : {};
      // Conditional on the row existing: a concurrent remover wins the race
      // deterministically (matched 0 -> 404), never resurrects silently.
      const patch = isEnabled
        ? { $set: { isEnabled: true, enabledBy: adminUserId, enabledAt: new Date(), disabledBy: null, disabledAt: null } }
        : { $set: { isEnabled: false, disabledBy: adminUserId, disabledAt: new Date() } };
      const res = await TechnicianDistrictPermission.updateOne({ technicianId, districtId }, patch, opts);
      if (res.matchedCount === 0) {
        fail("PERMISSION_NOT_FOUND", "District permission record not found for this technician and district", 404);
      }
      await resyncDerivedArrays(technicianId, session);
      await syncDistrictZones({
        technicianId,
        districtId,
        enabled: isEnabled,
        adminUserId,
        reason,
        session,
      });
      await writePermissionHistory(
        { technicianId, districtId, kind: isEnabled ? "enable" : "disable", adminUserId, reason },
        session
      );
    });
  } catch (err) {
    if (err.statusCode) throw err;
    throw asConflict(err);
  }

  await writeAuditLog({
    actor: adminUserId,
    actorRole: adminRole || "Admin",
    action: isEnabled ? "DISTRICT_ENABLED" : "DISTRICT_DISABLED",
    targetType: "TechnicianProfile",
    targetId: technicianId,
    after: { districtId, isEnabled },
  });

  return { success: true, message: `District permission ${isEnabled ? "enabled" : "disabled"} successfully` };
};

/**
 * Admin action: Removes an additional district permission.
 */
export const removeDistrictPermission = async ({ technicianId, districtId, adminUserId, adminId, adminRole, reason }) => {
  // B-13 compat: accept the legacy `adminId` alias for the actor.
  adminUserId = adminUserId || adminId;
  const fail = (code, message, statusCode = 400) => {
    const err = new Error(message);
    err.code = code;
    err.statusCode = statusCode;
    throw err;
  };

  const profile = await TechnicianProfile.findById(technicianId);
  if (!profile) {
    fail("TECHNICIAN_NOT_FOUND", "Technician not found", 404);
  }
  if (profile.primaryCityId && String(profile.primaryCityId) === String(districtId)) {
    fail("PRIMARY_DISTRICT_PROTECTED", "Cannot remove primary district permission");
  }
  if (profile.primaryDistrictId && String(profile.primaryDistrictId) === String(districtId)) {
    fail("PRIMARY_DISTRICT_PROTECTED", "Cannot remove primary district permission");
  }

  try {
    await withZoneWriteTransaction(async (session) => {
      const opts = session ? { session } : {};
      const res = await TechnicianDistrictPermission.findOneAndDelete({ technicianId, districtId }, opts);
      if (!res) {
        fail("PERMISSION_NOT_FOUND", "District permission record not found for this technician and district — nothing to remove", 404);
      }
      await resyncDerivedArrays(technicianId, session);
      await syncDistrictZones({ technicianId, districtId, enabled: false, adminUserId, reason, session });
      await writePermissionHistory({ technicianId, districtId, kind: "revoke", adminUserId, reason }, session);
    });
  } catch (err) {
    if (err.statusCode) throw err;
    throw asConflict(err);
  }

  await writeAuditLog({
    actor: adminUserId,
    actorRole: adminRole || "Admin",
    action: "DISTRICT_REMOVED",
    targetType: "TechnicianProfile",
    targetId: technicianId,
    before: { districtId },
  });

  return { success: true, message: "District permission removed successfully" };
};

export default {
  syncAllowedCityIds,
  getAllowedDistrictsForTechnician,
  isTechnicianAllowedInDistrict,
  addDistrictPermission,
  ensureApprovedDistrictZones,
  toggleDistrictPermission,
  removeDistrictPermission,
};
