/**
 * Read-only production diagnostics for the job broadcast pipeline.
 *
 * Usage:
 *   node .diag-jobs.mjs [--booking=<bookingId>] [--limit=100] [--days=3]
 *
 * This script NEVER writes to MongoDB. It reports technician population,
 * GPS freshness, canonical district/zone/service references, orphaned IDs,
 * outbox/broadcast state, and per-stage eligibility reasons.
 */
import mongoose from "mongoose";
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));

dotenv.config({ path: path.join(root, ".env"), quiet: true });

const args = process.argv.slice(2);
const argValue = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const bookingIdArg = argValue("booking", null);
const limit = Math.min(Math.max(Number(argValue("limit", 100)) || 100, 1), 500);
const days = Math.min(Math.max(Number(argValue("days", 3)) || 3, 1), 30);
const jsonOutput = args.includes("--json");

const S = 24 * 60 * 60 * 1000;
const since = new Date(Date.now() - days * S);

await mongoose.connect(process.env.MONGO_URI, {
  serverSelectionTimeoutMS: 10000,
  autoIndex: false,
  autoCreate: false,
  readPreference: "secondaryPreferred",
});
console.log("connected", { database: mongoose.connection.name, bookingIdArg, limit, days });

const { default: TechnicianProfile } = await import(`${root}/Schemas/TechnicianProfile.js`);
const { default: TechnicianKyc } = await import(`${root}/Schemas/TechnicianKYC.js`);
const { default: ServiceBooking } = await import(`${root}/Schemas/ServiceBooking.js`);
const { default: JobBroadcast } = await import(`${root}/Schemas/TechnicianBroadcast.js`);
const { default: BookingOutbox } = await import(`${root}/Schemas/BookingOutbox.js`);
const { default: DispatchOutbox } = await import(`${root}/Schemas/DispatchOutbox.js`);
const { default: Service } = await import(`${root}/Schemas/Service.js`);
const { default: User } = await import(`${root}/Schemas/User.js`);
const { default: OperationalCity } = await import(`${root}/Schemas/OperationalCity.js`);
const { default: CityZone } = await import(`${root}/Schemas/CityZone.js`);
const { default: ServiceCompletionChallenge } = await import(`${root}/Schemas/ServiceCompletionChallenge.js`);
const { default: AuditLog } = await import(`${root}/Schemas/AuditLog.js`);
const { validateCompletionSmsConfig } = await import(`${root}/Utils/sendCompletionSms.js`);
const { AUTH_SMS_TEMPLATE_ID } = await import(`${root}/Utils/sendSMS.js`);
const { evaluateTechnicianEligibility } = await import(`${root}/Services/technicianEligibilityService.js`);
const { resolveServiceAvailability } = await import(`${root}/Services/serviceAvailabilityService.js`);
const { getGpsState, STALENESS_SECONDS, ACCEPT_GRACE_SECONDS } = await import(`${root}/Utils/locationConfig.js`);
const { resolveOperationalCityFromCoordinates, filterByBookingZone } = await import(`${root}/Utils/technicianMatching.js`);

const tally = (rows, key = "n") => Object.fromEntries(rows.map((r) => [String(r._id ?? "null"), r[key]]));

/* ── 1. Technician population + canonical GPS state ── */
const total = await TechnicianProfile.countDocuments();
const byStatus = tally(await TechnicianProfile.aggregate([{ $group: { _id: "$workStatus", n: { $sum: 1 } } }]));
const online = await TechnicianProfile.countDocuments({ "availability.isOnline": true });
const approvedOnline = await TechnicianProfile.countDocuments({
  workStatus: "approved",
  "availability.isOnline": true,
});
const withGps = await TechnicianProfile.countDocuments({ "location.coordinates.0": { $type: "number" } });
const missingTs = await TechnicianProfile.countDocuments({ locationUpdatedAt: { $exists: false } });
const invalidCoords = await TechnicianProfile.countDocuments({
  $or: [
    { "location.coordinates": { $not: { $type: "array" } } },
    { "location.coordinates.0": { $not: { $type: "number" } } },
    { "location.coordinates.1": { $not: { $type: "number" } } },
  ],
});
const fresh90 = await TechnicianProfile.countDocuments({
  locationUpdatedAt: { $gte: new Date(Date.now() - STALENESS_SECONDS * 1000) },
});
const fresh15m = await TechnicianProfile.countDocuments({
  locationUpdatedAt: { $gte: new Date(Date.now() - ACCEPT_GRACE_SECONDS * 1000) },
});
console.log("1 TECHS:", { total, byStatus, online, approvedOnline, withGps, missingTs, invalidCoords });
console.log("1 GPS:", {
  thresholdSeconds: STALENESS_SECONDS,
  fresh90s: fresh90,
  fresh15m,
  staleApprovedOnline: Math.max(0, approvedOnline - fresh90),
});

const skillAgg = await TechnicianProfile.aggregate([
  { $unwind: "$skills" },
  { $group: { _id: "$skills.serviceId", n: { $sum: 1 } } },
  { $sort: { n: -1 } },
  { $limit: 10 },
]);
console.log("1 TOP SKILLS:", JSON.stringify(skillAgg.map((s) => [String(s._id), s.n])));

/* ── 2. Canonical reference integrity (orphans never authorize dispatch) ── */
const cities = await OperationalCity.find({}).select("_id name active status isJobEnabled").lean();
const cityById = new Map(cities.map((c) => [String(c._id), c]));
const zones = await CityZone.find({}).select("_id name operationalCityId active").lean();
const zoneById = new Map(zones.map((z) => [String(z._id), z]));
const services = await Service.find({}).select("_id serviceName isActive").lean();
const serviceById = new Map(services.map((s) => [String(s._id), s]));

const activeCityIds = new Set(cities.filter((c) => c.active !== false && c.status !== "INACTIVE" && c.isJobEnabled !== false).map((c) => String(c._id)));
const activeZoneIds = new Set(zones.filter((z) => z.active !== false && activeCityIds.has(String(z.operationalCityId))).map((z) => String(z._id)));
const activeServiceIds = new Set(services.filter((s) => s.isActive !== false).map((s) => String(s._id)));

const profiles = await TechnicianProfile.find({})
  .select("_id workStatus availability location locationUpdatedAt primaryDistrictId primaryCityId enabledDistrictIds allowedCityIds cityZoneId currentCityZoneId enabledCityZoneIds skills")
  .maxTimeMS(15000)
  .lean();

const orphanProfiles = [];
const gpsReasonTally = {};
const gpsAgeBuckets = { fresh: 0, "<=5m": 0, "<=1h": 0, "<=24h": 0, ">24h": 0, missing: 0 };
for (const p of profiles) {
  const issues = [];
  const districtRefs = [p.primaryDistrictId, p.primaryCityId, ...(p.enabledDistrictIds || []), ...(p.allowedCityIds || [])]
    .filter(Boolean).map(String);
  const badDistricts = [...new Set(districtRefs.filter((id) => !activeCityIds.has(id)))];
  if (badDistricts.length) issues.push(`district_refs_not_active=${badDistricts.join(",")}`);

  const zoneRefs = [p.cityZoneId, p.currentCityZoneId, ...(p.enabledCityZoneIds || [])]
    .filter(Boolean).map(String);
  const badZones = [...new Set(zoneRefs.filter((id) => !zoneById.has(id)))];
  const inactiveZones = [...new Set(zoneRefs.filter((id) => zoneById.has(id) && !activeZoneIds.has(id)))];
  if (badZones.length) issues.push(`zone_refs_orphaned=${badZones.join(",")}`);
  if (inactiveZones.length) issues.push(`zone_refs_inactive=${inactiveZones.join(",")}`);

  const badSkills = [...new Set((p.skills || []).map((s) => String(s.serviceId?._id || s.serviceId)).filter((id) => id && !activeServiceIds.has(id)))];
  if (badSkills.length) issues.push(`skill_refs_not_active=${badSkills.join(",")}`);

  if (!p.location?.coordinates || p.location.coordinates.length !== 2 || !p.location.coordinates.every(Number.isFinite)) {
    issues.push("invalid_gps");
  }
  const gps = getGpsState(p, "BROADCAST");
  gpsReasonTally[gps.reason || "FRESH"] = (gpsReasonTally[gps.reason || "FRESH"] || 0) + 1;
  const age = gps.ageSeconds;
  if (age == null) gpsAgeBuckets.missing += 1;
  else if (age <= STALENESS_SECONDS) gpsAgeBuckets.fresh += 1;
  else if (age <= 5 * 60) gpsAgeBuckets["<=5m"] += 1;
  else if (age <= 60 * 60) gpsAgeBuckets["<=1h"] += 1;
  else if (age <= 24 * 60 * 60) gpsAgeBuckets["<=24h"] += 1;
  else gpsAgeBuckets[">24h"] += 1;

  if (issues.length) orphanProfiles.push({ id: String(p._id), workStatus: p.workStatus, online: p.availability?.isOnline === true, issues });
}
console.log("2 CANONICAL:", {
  cities: cities.length,
  activeCities: activeCityIds.size,
  zones: zones.length,
  activeZones: activeZoneIds.size,
  services: services.length,
  activeServices: activeServiceIds.size,
  orphanProfiles: orphanProfiles.length,
  gpsStates: gpsReasonTally,
  gpsAgeBuckets,
});
for (const p of orphanProfiles.slice(0, 15)) console.log("  ORPHAN PROFILE:", JSON.stringify(p));

/* ── 3. Recent bookings + reference resolution ── */
const bookings = await ServiceBooking.find({ createdAt: { $gte: since } })
  .select("_id status assignmentStatus serviceId districtId cityZoneId location scheduledAt createdAt broadcastedAt matchingLeaseUntil assignmentAttempts autoCancelAt technicianId")
  .sort({ createdAt: -1 })
  .limit(Math.min(limit, 25))
  .maxTimeMS(15000)
  .lean();
console.log(`3 RECENT BOOKINGS (${days}d):`, bookings.length);
for (const b of bookings) {
  const districtId = b.districtId ? String(b.districtId) : null;
  const zoneId = b.cityZoneId ? String(b.cityZoneId) : null;
  const districtState = !districtId ? "missing" : !cityById.has(districtId) ? "ORPHAN" : !activeCityIds.has(districtId) ? "INACTIVE" : "ok";
  const zoneState = !zoneId ? "missing" : !zoneById.has(zoneId) ? "ORPHAN" : !activeZoneIds.has(zoneId) ? "INACTIVE" : "ok";
  const coords = b.location?.coordinates;
  const leaseState = b.matchingLeaseUntil
    ? new Date(b.matchingLeaseUntil) > new Date()
      ? "held"
      : "expired"
    : "-";
  const attemptCount = Array.isArray(b.assignmentAttempts) ? b.assignmentAttempts.length : 0;
  console.log(
    `  B ${b._id} status=${b.status}/${b.assignmentStatus} lease=${leaseState} ` +
    `attempts=${attemptCount} tech=${b.technicianId ? "SET" : "null"} svc=${b.serviceId} ` +
    `district=${districtId || "-"}:${districtState} zone=${zoneId || "-"}:${zoneState} ` +
    `loc=${Array.isArray(coords) && coords.every(Number.isFinite) ? "yes" : "NO"} ` +
    `at=${b.broadcastedAt || "-"} created=${b.createdAt?.toISOString?.()}`
  );
}

/* ── 4. Broadcast/outbox activity ── */
const broadcastCounts = tally(await JobBroadcast.aggregate([{ $group: { _id: "$status", n: { $sum: 1 } } }]));
const broadcastRecent = await JobBroadcast.countDocuments({ createdAt: { $gte: since } });
const bookingOutboxCounts = tally(await BookingOutbox.aggregate([{ $group: { _id: "$status", n: { $sum: 1 } } }]));
const bookingOutboxStale = await BookingOutbox.countDocuments({ status: "pending", nextAttemptAt: { $lte: new Date() }, createdAt: { $lt: since } });
const dispatchOutboxCounts = tally(await DispatchOutbox.aggregate([{ $group: { _id: "$status", n: { $sum: 1 } } }]));
const staleInflight = await DispatchOutbox.countDocuments({ status: "inflight", claimedAt: { $lt: new Date(Date.now() - 5 * 60 * 1000) } });
const staleBookingInflight = await BookingOutbox.countDocuments({ status: "inflight", claimedAt: { $lt: new Date(Date.now() - 5 * 60 * 1000) } });
console.log("4 BROADCASTS:", { recent: broadcastRecent, allTime: broadcastCounts });
console.log("4 BOOKING OUTBOX:", { allTime: bookingOutboxCounts, stalePending: bookingOutboxStale, staleInflight: staleBookingInflight });
console.log("4 DISPATCH OUTBOX:", { allTime: dispatchOutboxCounts, staleInflight });
const lastBc = await JobBroadcast.find({}).sort({ updatedAt: -1 }).limit(5)
  .select("bookingId technicianId status updatedAt expiresAt purgeAt version").lean();
console.log("4 LAST BROADCASTS:", lastBc.map((x) => `${x.bookingId} -> ${x.technicianId} ${x.status} @${x.updatedAt?.toISOString?.()} purgeAt=${x.purgeAt || "-"} v=${x.version}`));

/* ── 5. Stage-by-stage eligibility diagnostics for one booking ── */
const target = bookingIdArg
  ? await ServiceBooking.findById(bookingIdArg)
      .select("_id status assignmentStatus serviceId districtId cityZoneId location technicianId")
      .lean()
  : bookings.find((b) => ["pending", "broadcasted"].includes(b.status) && !b.technicianId) || bookings[0];

let stagesReport = null;
let reasonTallyReport = null;

if (!target) {
  console.log("5 ELIGIBILITY: no booking available");
} else {
  const lat = target.location?.coordinates?.[1];
  const lng = target.location?.coordinates?.[0];
  let jobDistrictId = target.districtId ? String(target.districtId) : null;
  let jobZoneId = target.cityZoneId ? String(target.cityZoneId) : null;
  if (!jobDistrictId && Number.isFinite(lat) && Number.isFinite(lng)) {
    const city = await resolveOperationalCityFromCoordinates(lat, lng);
    if (city?._id) jobDistrictId = String(city._id);
  }

  const serviceId = target.serviceId ? String(target.serviceId._id || target.serviceId) : null;
  const service = serviceId ? serviceById.get(serviceId) : null;
  if (!jobZoneId && target.serviceId && Number.isFinite(lat) && Number.isFinite(lng)) {
    const zone = await CityZone.findOne({
      polygon: { $geoIntersects: { $geometry: { type: "Point", coordinates: [lng, lat] } } },
      active: true,
    }).select("_id").lean();
    if (zone?._id) jobZoneId = String(zone._id);
  }
  const eligibilityContext = {
    jobDistrictId,
    jobZoneId,
    traceId: `diag-${target._id}`,
  };
  if (serviceId && jobDistrictId) {
    eligibilityContext.serviceAvailability = await resolveServiceAvailability({
      serviceId,
      districtId: jobDistrictId,
      cityZoneId: jobZoneId,
    });
  }

  const stageBase = {
    workStatus: "approved",
    profileComplete: true,
    trainingCompleted: true,
    "availability.isOnline": true,
  };
  const skillOr = serviceId
    ? { $or: [{ "skills.serviceId": new mongoose.Types.ObjectId(serviceId) }, { "skills.serviceId": serviceId }] }
    : null;
  const stageFilter = skillOr ? { $and: [stageBase, skillOr] } : stageBase;
  const stages = {};
  stages.approved = await TechnicianProfile.countDocuments({ workStatus: "approved" });
  stages.approvedOnline = await TechnicianProfile.countDocuments({ workStatus: "approved", "availability.isOnline": true });
  stages.skill = serviceId ? await TechnicianProfile.countDocuments(stageFilter) : null;
  stages.freshGps = await TechnicianProfile.countDocuments({
    ...stageFilter,
    locationUpdatedAt: { $gte: new Date(Date.now() - STALENESS_SECONDS * 1000) },
  });
  const districtRef = jobDistrictId && mongoose.Types.ObjectId.isValid(jobDistrictId)
    ? new mongoose.Types.ObjectId(jobDistrictId)
    : jobDistrictId;
  const districtOr = jobDistrictId ? {
    $or: [
      { primaryDistrictId: districtRef },
      { primaryCityId: districtRef },
      { enabledDistrictIds: districtRef },
      { allowedCityIds: districtRef },
    ],
  } : null;
  const combinedFilter = districtOr ? { $and: [stageFilter, districtOr] } : stageFilter;
  stages.districtPermission = await TechnicianProfile.countDocuments(combinedFilter);

  let candidates = await TechnicianProfile.find(combinedFilter)
    .select("userId location locationUpdatedAt availability skills enabledDistrictIds allowedCityIds primaryDistrictId primaryCityId cityZoneId currentCityZoneId enabledCityZoneIds serviceRadiusKm workStatus profileComplete trainingCompleted")
    .limit(limit)
    .maxTimeMS(15000)
    .lean();
  stages.districtCandidates = candidates.length;

  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    const radiusKm = Number(process.env.DIAG_RADIUS_KM || 100);
    const ids = candidates.map((c) => c._id);
    // Zone filter is read-only; empty result can also mean "outside all
    // permitted zones", which is exactly what operators need to see.
    const zoneIds = await filterByBookingZone(ids, target._id).catch(() => null);
    if (Array.isArray(zoneIds)) {
      const zoneSet = new Set(zoneIds.map(String));
      candidates = candidates.filter((c) => zoneSet.has(String(c._id)));
      stages.zoneCandidates = candidates.length;
    } else {
      stages.zoneCandidates = "skipped";
    }
    const withinRadiusAgg = await TechnicianProfile.aggregate([
      {
        $geoNear: {
          near: { type: "Point", coordinates: [lng, lat] },
          distanceField: "distanceMeters",
          maxDistance: radiusKm * 1000,
          spherical: true,
          query: combinedFilter,
        },
      },
      { $count: "n" },
    ]).option({ maxTimeMS: 15000 });
    stages.withinRadius = withinRadiusAgg[0]?.n || 0;
  } else {
    stages.zoneCandidates = "no_job_coords";
    stages.withinRadius = "no_job_coords";
  }

  const kycApproved = new Set(
    (await TechnicianKyc.find({ technicianId: { $in: candidates.map((c) => c._id) }, verificationStatus: "approved" }).distinct("technicianId"))
      .map(String)
  );
  stages.kycApproved = candidates.filter((c) => kycApproved.has(String(c._id))).length;

  const reasonTally = {};
  const eligibleIds = [];
  const started = Date.now();
  for (const tech of candidates) {
    const result = await evaluateTechnicianEligibility({
      technician: tech,
      booking: target,
      mode: "BROADCAST",
      context: eligibilityContext,
    });
    if (result.eligible) eligibleIds.push(String(tech._id));
    for (const reason of result.reasons) reasonTally[reason] = (reasonTally[reason] || 0) + 1;
  }
  const elapsedMs = Date.now() - started;

  console.log(`5 ELIGIBILITY booking=${target._id} status=${target.status}/${target.assignmentStatus}`);
  console.log("5 RESOLVED:", {
    serviceId,
    service: service ? { name: service.serviceName, active: service.isActive } : null,
    jobDistrictId,
    district: jobDistrictId ? cityById.get(jobDistrictId) || "ORPHAN" : null,
    jobZoneId,
    zone: jobZoneId ? zoneById.get(jobZoneId) || "ORPHAN" : null,
    serviceAvailability: eligibilityContext.serviceAvailability || null,
    gpsThresholdSeconds: STALENESS_SECONDS,
  });
  console.log("5 STAGES:", stages);
  console.log("5 EVALUATED:", {
    candidates: candidates.length,
    eligible: eligibleIds.length,
    elapsedMs,
    avgMsPerCandidate: candidates.length ? Number((elapsedMs / candidates.length).toFixed(1)) : null,
    eligibleIds: eligibleIds.slice(0, 20),
  });
  console.log("5 REASON TALLY:", JSON.stringify(reasonTally));
  stagesReport = stages;
  reasonTallyReport = reasonTally;
}

/* ── 6. Online sample (user/role/profile sanity) ── */
const onlines = await TechnicianProfile.find({ "availability.isOnline": true })
  .select("_id userId lastJobsChangeAt location locationUpdatedAt workStatus profileComplete")
  .limit(10)
  .maxTimeMS(15000)
  .lean();
console.log("6 ONLINE SAMPLE:");
for (const t of onlines) {
  const u = await User.findById(t.userId).select("status role").lean();
  const gps = getGpsState(t, "BROADCAST");
  console.log(`  T ${t._id} user=${t.userId} uStatus=${u?.status} role=${u?.role} ws=${t.workStatus} pc=${t.profileComplete} lastJobsChangeAt=${t.lastJobsChangeAt?.toISOString?.()} gps=${gps.reason || "FRESH"} age=${gps.ageSeconds}s`);
}

/* ── 7. Service completion OTP health ── */
const completionTemplate = process.env.COMPLETION_SMS_TEMPLATE_ID || null;
const smsCfg = validateCompletionSmsConfig();
const sendCooldownMs = Number(process.env.COMPLETION_OTP_SEND_COOLDOWN_MS) || 60000;
console.log("7 COMPLETION OTP CONFIG:", {
  configured: smsCfg.configured,
  reason: smsCfg.reason,
  warning: smsCfg.warning || null,
  templateId: completionTemplate,
  authTemplateId: AUTH_SMS_TEMPLATE_ID,
  reusesAuthTemplate: completionTemplate === AUTH_SMS_TEMPLATE_ID,
  sendCooldownMs,
});

const challengeStatuses = tally(
  await ServiceCompletionChallenge.aggregate([{ $group: { _id: "$status", n: { $sum: 1 } } }])
);
const openChallengeFilter = { status: { $in: ["pending_delivery", "pending"] } };
const openChallenges = await ServiceCompletionChallenge.countDocuments(openChallengeFilter);
const expiredOpen = await ServiceCompletionChallenge.countDocuments({
  ...openChallengeFilter,
  expiresAt: { $lte: new Date() },
});
const stuckDelivery = await ServiceCompletionChallenge.countDocuments({
  status: "pending_delivery",
  updatedAt: { $lt: new Date(Date.now() - 5 * 60 * 1000) },
});
console.log("7 COMPLETION CHALLENGES:", {
  allTime: challengeStatuses,
  open: openChallenges,
  expiredOpen,
  stuckDelivery,
});

const recentChallenges = await ServiceCompletionChallenge.find({ createdAt: { $gte: since } })
  .sort({ createdAt: -1 })
  .limit(10)
  .select("bookingId technicianId customerId status generation resendCount attempts createdAt updatedAt expiresAt lastSentAt")
  .maxTimeMS(15000)
  .lean();
for (const c of recentChallenges) {
  const ageMin = c.createdAt ? Number(((Date.now() - new Date(c.createdAt).getTime()) / 60000).toFixed(1)) : null;
  console.log(
    `  CC booking=${c.bookingId} status=${c.status} gen=${c.generation} resend=${c.resendCount || 0} ` +
    `attempts=${c.attempts || 0} ageMin=${ageMin} sentAt=${c.lastSentAt || "-"} expires=${c.expiresAt || "-"}`
  );
}

const duplicateActive = await ServiceCompletionChallenge.aggregate([
  { $match: openChallengeFilter },
  { $group: { _id: "$bookingId", n: { $sum: 1 } } },
  { $match: { n: { $gt: 1 } } },
]);
console.log("7 DUPLICATE ACTIVE:", { bookings: duplicateActive.length, detail: duplicateActive.slice(0, 5) });

const openChallengeDocs = await ServiceCompletionChallenge.find(openChallengeFilter)
  .select("bookingId customerId")
  .maxTimeMS(15000)
  .lean();
const challengeCustomerIds = [...new Set(openChallengeDocs.map((c) => String(c.customerId)))];
const challengeCustomers = await User.find({ _id: { $in: challengeCustomerIds } })
  .select("mobileNumber role status")
  .lean();
const challengeCustomerById = new Map(challengeCustomers.map((u) => [String(u._id), u]));
const phoneStates = {};
for (const c of openChallengeDocs) {
  const customer = challengeCustomerById.get(String(c.customerId));
  const digits = String(customer?.mobileNumber || "").replace(/\D/g, "");
  const validPhone = /^[0-9]{10}$/.test(digits) || (digits.length === 12 && digits.startsWith("91"));
  const key = !customer ? "customer_missing" : validPhone ? "ok" : "invalid_phone";
  phoneStates[key] = (phoneStates[key] || 0) + 1;
}
console.log("7 ACTIVE CUSTOMER PHONES:", phoneStates);

const recentFailures = await AuditLog.find({
  action: "COMPLETION_OTP_DELIVERY_FAILED",
  createdAt: { $gte: since },
})
  .sort({ createdAt: -1 })
  .limit(20)
  .select("targetId after createdAt")
  .maxTimeMS(15000)
  .lean();
const failureTally = {};
for (const f of recentFailures) {
  const key = [
    f.after?.error || "unknown",
    f.after?.providerStatus != null ? `http=${f.after.providerStatus}` : "http=-",
    f.after?.providerMessage || "-",
  ].join(" | ");
  failureTally[key] = (failureTally[key] || 0) + 1;
}
console.log("7 DELIVERY FAILURES:", { recent: recentFailures.length, byReason: failureTally });
for (const f of recentFailures.slice(0, 5)) {
  console.log(`  FAIL booking=${f.targetId} at=${f.createdAt?.toISOString?.()}`, JSON.stringify(f.after || {}));
}

let smsProviderReport = null;
if (args.includes("--sms")) {
  if (!process.env.FAST2SMS_API_KEY) {
    smsProviderReport = { error: "FAST2SMS_API_KEY missing" };
  } else {
    const { default: axios } = await import("axios");
    const today = new Date().toISOString().slice(0, 10);
    const headers = { authorization: process.env.FAST2SMS_API_KEY };
    smsProviderReport = {};
    try {
      const wallet = await axios.get("https://www.fast2sms.com/dev/wallet", { headers, timeout: 15000 });
      smsProviderReport.wallet = wallet.data;
    } catch (e) {
      smsProviderReport.wallet = { error: e.response?.status || e.message };
    }
    try {
      const summary = await axios.get("https://www.fast2sms.com/dev/sms_summary", {
        headers,
        params: { from: today, to: today },
        timeout: 15000,
      });
      smsProviderReport.today = summary.data?.data || summary.data;
    } catch (e) {
      smsProviderReport.today = { error: e.response?.status || e.message };
    }
  }
  console.log("7 FAST2SMS:", JSON.stringify(smsProviderReport));
}

const completionOtpReport = {
  config: {
    configured: smsCfg.configured,
    reason: smsCfg.reason,
    warning: smsCfg.warning || null,
    templateId: completionTemplate,
    reusesAuthTemplate: completionTemplate === AUTH_SMS_TEMPLATE_ID,
    sendCooldownMs,
  },
  challengeStatuses,
  openChallenges,
  expiredOpen,
  stuckDelivery,
  duplicateActiveBookings: duplicateActive.length,
  phoneStates,
  deliveryFailuresRecent: recentFailures.length,
  deliveryFailureReasons: failureTally,
  smsProvider: smsProviderReport,
};

if (jsonOutput) {
  console.log(JSON.stringify({
    database: mongoose.connection.name,
    total,
    byStatus,
    online,
    approvedOnline,
    withGps,
    fresh90,
    fresh15m,
    gpsAgeBuckets,
    bookings: bookings.length,
    broadcastCounts,
    bookingOutboxCounts,
    dispatchOutboxCounts,
    target: target
      ? {
          id: String(target._id),
          status: target.status,
          assignmentStatus: target.assignmentStatus,
        }
      : null,
    stages: stagesReport,
    reasonTally: reasonTallyReport,
    completionOtp: completionOtpReport,
  }, null, 2));
}

await mongoose.disconnect();
console.log("done");
