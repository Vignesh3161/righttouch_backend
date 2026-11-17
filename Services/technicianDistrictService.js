import mongoose from "mongoose";
import TechnicianProfile from "../Schemas/TechnicianProfile.js";
import OperationalCity from "../Schemas/OperationalCity.js";
import TechnicianDistrictPermission from "../Schemas/TechnicianDistrictPermission.js";
import TechnicianZonePermissionAudit from "../Schemas/TechnicianZonePermissionAudit.js";
import CityZone from "../Schemas/CityZone.js";
import DistrictPermissionHistory from "../Schemas/DistrictPermissionHistory.js";
import { writeAuditLog } from "../Utils/audit.js";
import { withZoneWriteTransaction } from "./zoneWriteService.js";

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

/**
 * Grant a newly created (or re-activated) zone to every technician holding an
 * enabled permission for its parent district. District grants carry their
 * zones, so a zone created after the district grant must not leave
 * enabledCityZoneIds empty. Idempotent; writes are batched.
 */
export const grantZoneToDistrictTechnicians = async ({
  zoneId,
  districtId,
  adminUserId = null,
  reason = "Auto-granted with district permission",
  session = null,
} = {}) => {
  if (!zoneId || !districtId) return { granted: 0 };
  if (!mongoose.Types.ObjectId.isValid(zoneId) || !mongoose.Types.ObjectId.isValid(districtId)) {
    return { granted: 0 };
  }

  const zoneObjId = new mongoose.Types.ObjectId(zoneId);
  const permissionQuery = TechnicianDistrictPermission.find({
    districtId,
    isEnabled: true,
  }).select("technicianId");
  const permissions = session
    ? await permissionQuery.session(session).lean()
    : await permissionQuery.lean();

  const technicianIds = [...new Set(
    permissions.map((p) => String(p.technicianId)).filter((id) => mongoose.Types.ObjectId.isValid(id))
  )];

  let granted = 0;
  const BATCH_SIZE = 500;
  for (let i = 0; i < technicianIds.length; i += BATCH_SIZE) {
    const batch = technicianIds.slice(i, i + BATCH_SIZE);
    const missingQuery = TechnicianProfile.find({
      _id: { $in: batch },
      enabledCityZoneIds: { $ne: zoneObjId },
    }).select("_id");
    const missing = session
      ? await missingQuery.session(session).lean()
      : await missingQuery.lean();
    if (!missing.length) continue;

    const update = TechnicianProfile.updateMany(
      { _id: { $in: missing.map((t) => t._id) } },
      { $addToSet: { enabledCityZoneIds: zoneObjId } }
    );
    if (session) await update.session(session);
    else await update;

    if (adminUserId) {
      const auditDocs = missing.map((tech) => ({
        technicianId: tech._id,
        cityZoneId: zoneObjId,
        action: "enabled",
        changedBy: adminUserId,
        reason,
      }));
      if (session) {
        await TechnicianZonePermissionAudit.insertMany(auditDocs, { session, ordered: false });
      } else {
        await TechnicianZonePermissionAudit.insertMany(auditDocs, { ordered: false });
      }
    }
    granted += missing.length;
  }

  return { granted };
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
 * The primary district is registration metadata only and is never auto-seeded;
 * permission rows are the only authorization source.
 */
export const getAllowedDistrictsForTechnician = async (techProfile) => {
  if (!techProfile) return [];

  let profileDoc = techProfile;
  if (typeof techProfile === "string" || techProfile instanceof mongoose.Types.ObjectId) {
    profileDoc = await TechnicianProfile.findById(techProfile).select("_id").lean();
  }

  if (!profileDoc?._id) return [];

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
 * Reconciles technician coverage at approval time.
 *
 * Registration metadata (address, primary district, registered zone, current
 * GPS) is never used to grant coverage. Only explicit enabled district
 * permission rows are considered. Coverage is advisory at approval: a
 * technician may be approved with zero valid permission rows, in which case
 * `coveragePending` is true and no dispatch coverage is enabled.
 *
 * Safe to call repeatedly.
 */
export const ensureApprovedDistrictZones = async ({ technicianId }) => {
  const profile = await TechnicianProfile.findById(technicianId).select(
    "_id primaryDistrictId primaryCityId"
  );
  if (!profile) {
    const err = new Error("Technician not found");
    err.code = "TECHNICIAN_NOT_FOUND";
    err.statusCode = 404;
    throw err;
  }

  const permissionRows = await TechnicianDistrictPermission.find({
    technicianId,
    isEnabled: true,
  })
    .select("districtId")
    .lean();

  const grantedDistrictIds = [
    ...new Set(
      permissionRows
        .map((row) => String(row.districtId || ""))
        .filter((id) => mongoose.Types.ObjectId.isValid(id))
    ),
  ];

  const warnings = [];
  const validDistricts = [];
  const approvedZoneIds = [];

  for (const districtId of grantedDistrictIds) {
    const district = await OperationalCity.findById(districtId)
      .select("active isActive isJobEnabled")
      .lean();

    if (!district) {
      warnings.push({
        code: "DISTRICT_MISSING",
        districtId,
        message: "Granted district no longer exists.",
      });
      continue;
    }
    if (district.active === false || district.isActive === false) {
      warnings.push({
        code: "DISTRICT_INACTIVE",
        districtId,
        message: "Granted district is inactive.",
      });
      continue;
    }
    if (district.isJobEnabled === false) {
      warnings.push({
        code: "DISTRICT_JOBS_DISABLED",
        districtId,
        message: "Granted district job assignment is disabled.",
      });
      continue;
    }

    const zones = await CityZone.find({
      operationalCityId: districtId,
      active: { $ne: false },
    })
      .select("_id")
      .lean();

    if (zones.length === 0) {
      warnings.push({
        code: "NO_ACTIVE_ZONES",
        districtId,
        message: "Granted district has no active zones.",
      });
      continue;
    }

    validDistricts.push({ _id: district._id, districtId });
    for (const zone of zones) {
      const zoneId = String(zone._id);
      if (!approvedZoneIds.includes(zoneId)) approvedZoneIds.push(zoneId);
    }
  }

  const approvedDistrictIds = validDistricts.map((district) => district.districtId);
  const coveragePending = approvedDistrictIds.length === 0;

  if (coveragePending) {
    warnings.push({
      code: "COVERAGE_PENDING",
      districtId: null,
      message: "No valid district coverage. Admin/Owner approval is required before dispatch.",
    });
  }

  try {
    await withZoneWriteTransaction(async (session) => {
      const opts = session ? { session } : {};
      const updates = { enabledCityZoneIds: approvedZoneIds };

      if (!profile.primaryDistrictId && !profile.primaryCityId && validDistricts.length > 0) {
        updates.primaryDistrictId = validDistricts[0]._id;
        updates.primaryCityId = validDistricts[0]._id;
      }

      await TechnicianProfile.updateOne(
        { _id: technicianId },
        { $set: updates },
        opts
      );
      await resyncDerivedArrays(technicianId, session);
    });
  } catch (err) {
    throw asConflict(err);
  }

  return {
    coveragePending,
    districtId: approvedDistrictIds[0] || null,
    approvedDistrictIds,
    approvedZoneIds,
    warnings,
  };
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
  grantZoneToDistrictTechnicians,
  toggleDistrictPermission,
  removeDistrictPermission,
};
