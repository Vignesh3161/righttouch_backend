# Technician Profile — What to Maintain, Location Tracking & Query Performance

> Scope: `TechnicianProfile` field-by-field maintenance guide + every location read/write with its query cost + performance redesign.
> Companion: `docs/User-Profile-Roles-How-It-Works.md` (role model), `docs/module-audits/M2-Technician-Audit.md`.

---

## PART A — Field groups: what each is for and how to maintain it

The doc is `Schemas/TechnicianProfile.js` (369 lines, ~50 fields). Groups below say **KEEP / DERIVE / MOVE / DELETE** for the rewrite.

### A1. Identity link + photo (KEEP)

| Field | Maintain how |
|---|---|
| `userId` unique → User | Set once at signup verify (`User.create` + `Profile.create` in one txn). Never update. Cascade on delete (hard-delete Profile when User anonymized) |
| `profileImage` | Cloudinary URL via `upload.single("profileImage")`. Validate mime/size; delete old asset after successful replace |

### A2. Location + freshness (KEEP, but split hot path — see Part B)

| Field | Maintain how |
|---|---|
| `location` (GeoJSON Point, 2dsphere) | Written **only** by `handleLocationUpdate` (HTTP `PUT /location` + socket `TECH_LOCATION_UPDATE`), and only on significant move (>10 m) or first ping. Never written by onboarding/updates — onboarding `latitude/longitude` should seed it once, then hands off to pings |
| `locationUpdatedAt` | Stamped on **every** ping (even zero-move) — this is the staleness signal, not the coordinates. Indexed (`{locationUpdatedAt: -1}`). Never set manually |
| `lastMatchingAt` | Rate-limit cursor for per-tech matching (30 s gate in `handleLocationUpdate`). Written only there. Never reset elsewhere |

### A3. Work details + skills (KEEP, validate)

| Field | Maintain how |
|---|---|
| `locality/address/city/state/pincode`, `experienceYears`, `specialization`, `certifications[]` | Allow-listed profile updates only (`completeProfile`/`updateMyProfile`). Trim strings, clamp numbers |
| `skills[{serviceId, experienceYears}]` | Write only via `add/removeTechnicianSkills` (direct if service mapped in tech's zone) or SkillRequest approve path (auto-enables mapping). Use `$addToSet`/`$pull` atomics. `serviceId` must reference a live Service — never store dead ids (check on mapping disable) |
| `serviceRadiusKm` (default 10, 1–100) | Admin-configurable per tech; clamp. Feeds matching radius |
| `trainingCompleted` (bool), `workStatus` (`pending→trained→approved ⇄ suspended → deleted`) | Transitions only via training/KYC-verify/suspend admin actions through services (no direct writes). `verifyKYC` requires training done. Suspended must 403 everywhere (currently doesn't — fix in M1/M2) |

### A4. Presence + dispatch machinery (KEEP, all service-owned)

| Field | Maintain how |
|---|---|
| `availability.isOnline` | Owned **exclusively** by explicit go-online/offline action. `handleLocationUpdate` reads it but must never write it (code already respects this — keep the invariant with a test) |
| `dispatchLockUntil` | Self-expiring mutex set atomically (`findOneAndUpdate`) before accept-conflict checks; few-second TTL so crashes can't deadlock. Never set/read elsewhere |
| `lastJobsChangeAt` | Feed cursor bumped on broadcast-created/taken/expired (matching + cron). Socket `get_jobs` short-circuits on it (`since >= cursor` → "unchanged", no heavy query). Write only at those 3 events |
| `jobRejectCount`, `totalJobsCompleted` | `$inc` atomics on decline/complete. Never set absolutely |
| `currentDistrictId / currentCityZoneId` | Resolved from live GPS on every ping (`resolveZoneFromCoordinates` → district fallback). Best-effort (never blocks ping). Read-only for matching/eligibility |
| `cityZoneId` (registered zone), `zoneMismatch (+Since)` | `cityZoneId` set at onboarding/admin grant. `zoneMismatch` flipped by ping handler when GPS leaves the registered polygon (cleared on return). Admin report reads it; matching may down-weight mismatched techs |
| `primaryCityId / primaryDistrictId / allowedCityIds / enabledDistrictIds / enabledCityZoneIds` | Geo-permission grants. Primary set at onboarding; additional only via `technicianDistrictService` / zone controller (audited, primary-protected). Matching filters on these — never hand-edit in DB |
| `isRead / readAt / readBy` | Admin-unread badge for new techs. Set false on create; `mark-read` flips. Don't reuse for anything else |

### A5. Rating (KEEP, fix race)

| Field | Maintain how |
|---|---|
| `rating{avg, count}` | Updated only by `ratingService` on rating create (completion-gated, one-per-booking). Current read-modify-write races — switch to atomic sum/count (`$inc`) or recompute-under-lock. Never edited by hand |

### A6. Wallet + payout + bank mirror (MOVE / DELETE — owned by M9/M2-KYC)

| Field | Verdict | Maintain how |
|---|---|---|
| `walletBalance` (rupee mirror) | DELETE | Legacy mirror of `availableBalancePaise`. Stop writing; compute reads from `WalletTransaction`/ledger |
| `availableBalancePaise / reservedBalancePaise / reserveBalancePaise / outstandingDuesPaise / lifetimeEarnedPaise / lifetimeWithdrawnPaise / walletVersion` | MOVE to read-model | Written today by settlement/withdrawal/payout engine alongside ledger. Rewrite: ledger + `WalletTransaction` are truth; these become derived (nightly reconciler first, then stop writes). Never adjust by hand — adjustments go through `adjustment` WalletTransactions |
| `razorpayContactId / razorpayFundAccountId` | KEEP (cache) | Cached payout identifiers; refresh from RazorpayX on failure, never invent |
| `payoutSettings{autoPayoutEnabled, autoPayoutThresholdPaise, minimumMaintenancePaise, preferredPayoutMode}` | KEEP | Per-tech overrides over global config; validate ranges on write |
| `payoutBlocked / payoutBlockedReason` | KEEP | Admin/legal/fraud hold; checked in withdrawal + engine gates; always with reason + audit |
| `bankDetails{accountNumber, ifscCode, accountName, upiId}` (plaintext mirror) | DELETE | Drift source vs encrypted KYC bank. Reads/writes go to `TechnicianKYC.bankDetails` (encrypted + hashed + fingerprinted) only. Backfill-encrypt then drop the mirror |
| `fcmTokens` | DELETE | Third token store. `DeviceToken` collection is the registry; prune on FCM `not-registered` |
| `profileComplete` (stored bool) | DERIVE | Replace with `computeProfileComplete()` virtual (name + address/city + valid location + ≥1 mapped skill + KYC submitted). Three divergent computations exist today — delete all, keep one |

### A6b. Index maintenance (keep + add)

Keep: `userId` unique, `location` 2dsphere, `{locationUpdatedAt: -1}`, `{availableBalancePaise: 1}` (auto-payout scan), `{isRead, workStatus}`, `{allowedCityIds}`, `{availability.isOnline, workStatus, primaryDistrictId}`, `dispatchLockUntil`, geo-permission singles. Add: `{workStatus, trainingCompleted, updatedAt}` (admin queues), `{technicianId→ userId?}` none needed, `{cityZoneId, availability.isOnline, workStatus}` (zone-scoped matching). Build in background; verify with `explain()`.

---

## PART B — Location tracking: full flow and every query it costs

### B1. Write path — one ping (`handleLocationUpdate`, `Utils/technicianLocation.js:26-199`)

Per ping (HTTP `PUT /api/technician/location`, limiter 12/min, or socket `TECH_LOCATION_UPDATE`, 12/min acked):

| # | Query | Cost | Notes |
|---|---|---|---|
| 1 | `TechnicianProfile.findById(id).select("location lastMatchingAt availability workStatus trainingCompleted")` | `_id` IXSCAN, small proj — cheap | Full doc NOT loaded (good). But result is a hydrated doc, could be `.lean()` |
| 2 | `TechnicianProfile.updateOne({_id}, {location, locationUpdatedAt})` **or** `updateOne({_id}, {locationUpdatedAt})` | `_id` write — cheap | Distance gate (>10 m) correctly avoids rewriting coordinates on jitter |
| 3 | `geoAdd(id, lng, lat)` (Redis GEO, best-effort) | sub-ms, fire-and-forget | Only when online. If Redis down, silently skipped — matching falls back to Mongo geo (good degradation, keep) |
| 4 | `resolveZoneFromCoordinates(lat, lng)` → `$geoIntersects` on CityZone + fallback `getDistrictFromCoordinates` on OperationalCity | 2dsphere queries per ping — **moderate, × ping-rate** | Best-effort try/catch (good). Cacheable: zone polygons change rarely — add short TTL cache keyed by geohash |
| 5 | `TechnicianProfile.updateOne({_id}, {currentDistrictId, currentCityZoneId})` | `_id` write — cheap but **unconditional** (even when unchanged) | Add dirty-check: skip write if both ids equal current (saves a write per ping) |
| 6 | `TechnicianLocationHistory.create({...})` (fire-and-forget) | 1 insert/ping, 30-day TTL | Correct (TTL bounds growth). At 12/min × 8 h day = ~5.7k docs/tech/day — fine with TTL, but shard/TTL-monitor at scale |
| 7 | `TechnicianProfile.findById(id).select("cityZoneId zoneMismatch").lean()` | `_id` lean — cheap | Re-read right after step 5 wrote the same doc — merge: reuse the update result / single read |
| 8 | conditional `updateOne` for `zoneMismatch` flip | occasional — cheap | Good (only on transitions) |
| 9–10 | staleness + significant-move branches: `findById(id).select("userId").lean()` then `revalidateActiveBroadcasts(...)` which itself does: `JobBroadcast.find({tech, sent, unexpired})` + `TechnicianProfile.findById().lean()` (**full doc, no select!** `technicianLocation.js:235`) + `ServiceBooking.find({_id: $in, status: $in, tech: null})` + `evaluateTechnicianEligibility` per booking | **The expensive tail**: 3–5 queries + per-booking eligibility (each may hit availability/mapping). Gated by 30 s `lastMatchingAt` + significant-move, but a moving online tech with broadcasts pays it every 30 s | Fixes: lean+select the tech re-read (list needed fields); cap bookings per revalidation (e.g. 20); skip when zero active broadcasts (already: early return — keep) |

**Per-ping total today: 4–6 Mongo ops + 1–2 geo reads + 1 history insert + (every 30 s or on move) a revalidation fan-out.** At 12 pings/min/tech this is the hottest write path in the system.

### B2. Read path — everywhere `location` is consumed (verified via repo search)

| Caller | Query / projection | Frequency | Cost verdict |
|---|---|---|---|
| `technicianMatching.findEligible` (`technicianMatching.js:189,214`) | `TechnicianProfile.find({workStatus, online, skills, perms, locationUpdatedAt ≥ cutoff, …})` + `$nearSphere` variants (`:756,796,805,847,978`) | Per booking broadcast + per re-broadcast + per ping-triggered `broadcastPendingJobsToTechnician` | **Hottest read.** Needs the compound geo+status index review + candidate cap (50) before in-memory feasibility. Full-doc hydration in places (`:354 findById` no select; `:1013` has a good select — standardize on the `:1014` select list) |
| `technicianJobFetch.fetchTechnicianJobsInternal` (`:28-29`) | `findById(id).select("location locationUpdatedAt availability workStatus primaryDistrictId primaryCityId enabledDistrictIds allowedCityIds enabledCityZoneIds skills serviceRadiusKm")` | Per socket `get_jobs` (1/3 s, cursor short-circuit first) | Good: narrow select + staleness gate hides jobs on stale GPS. Keep. Add `.lean()` if missing |
| `technicianEligibility` (`technicianEligibility.js:19`) | `findById(id).select(…)` | Per candidate per broadcast | Narrow (verify select covers all used fields — else hidden full-doc fallback). Keep + audit select list |
| `revalidateTechniciansForService` (`technicianLocation.js:405`) | `find({workStatus, online, skills.serviceId, $or district perms, enabledCityZoneIds}).select("_id location locationUpdatedAt")` | On every service availability change | Narrow select (good). Risk: district `$or` over 4 array fields without a supporting compound — add `{skills.serviceId, availability.isOnline, workStatus}` composite; cap techs scanned |
| `sendNotification` (`:337`) | `findById(id).select("availability.isOnline").lean()` | Per job push | Cheap. Keep pattern (this is the model: lean + minimal select) |
| `sendNotification` (`:172,212`) | `select("userId")`, `select("fcmTokens userId")` | Per notify | `fcmTokens` select dies with the mirror (→ DeviceToken). `userId`-only lookups are fine |
| `Auth` / `socketAuth` per-request profile resolve | `findOne({userId}).select(...)` (verify narrow) | Every authenticated tech request + every socket handshake | Must stay narrow (`_id workStatus trainingCompleted availability`) — audit today; never populate here |
| Admin lists (`getAllTechnicians`, `getAdminJobHistory`, district tech lists) | full-profile selects + populates | Admin scale | Paginate + lean + minimal columns; never reuse the 150-line user-aggregate for ops screens |
| Wallet/payout/refund reads (`settlement`, `walletDebit`, `withdrawalPayoutEngine`, `refundEngine`, `paymentCrons`, `autoPayout`) | `findById(id)` mostly unscoped or balance-only | Per settlement/payout/refund | Narrow to needed balance/reward fields; these don't need `location` at all — strip it from selects to keep working set small |

### B3. Why "taking location separately" hurts today

1. **No dedicated hot-path read**: every consumer loads the 50-field Profile (or a different ad-hoc select) just to get coordinates + freshness + online + a few ids. Working set bloats; buffer cache churns at ping rate.
2. **Write amplification**: up to 3 `updateOne`s per ping (coords/freshness + district/zone + mismatch) + 1 history insert + geo-upsert. Unconditional district/zone write + redundant re-read (B1 #7) are pure waste.
3. **Revalidation fan-out has no cap** and one re-read loads the **full doc** (`:235`).
4. **Matching runs full-doc candidates** in at least one path (`:354`), then per-candidate eligibility with more reads.
5. **Admin aggregates drag `location` + everything else** through `$lookup` pipelines even when the screen shows a table.

---

## PART C — Redesign: split the hot location path, keep one truth

### C1. Principle

`TechnicianProfile` stays the **only truth** (no second location collection to drift). Performance comes from **narrow, capped, cached access** — not from duplicating coordinates elsewhere. (A Redis GEO mirror already exists as a *best-effort pre-filter*, not truth — keep that distinction.)

### C2. Changes

1. **Standard lean select lists** (new `repositories/technician.repo.js`):
   - `LOCATION_HOT = "_id location locationUpdatedAt availability.isOnline workStatus"` — pings, staleness, guards.
   - `MATCH_CANDIDATE = "_id userId location locationUpdatedAt workStatus availability skills primaryDistrictId primaryCityId enabledDistrictIds allowedCityIds cityZoneId enabledCityZoneIds serviceRadiusKm"` (the `:1014` list — already good, make it canonical).
   - `AUTH_RESOLVE = "_id workStatus trainingCompleted availability.isOnline"` — Auth/socketAuth only.
   - Forbid unscoped `findById(techId)` on this collection (lint rule + review checklist).
2. **Ping handler slim-down** (`handleLocationUpdate`):
   - Step 1 read → `.lean()` + HOT select.
   - District/zone write only on change (compare with resolved values first).
   - Drop re-read #7 (reuse known values).
   - Full-doc re-read in `revalidateActiveBroadcasts` → MATCH_CANDIDATE-equivalent select.
   - Cap revalidation bookings per run (20) + keep early-exit on zero broadcasts.
   - Cache `resolveZoneFromCoordinates` per geohash-7 for 5 min (polygons rarely change; invalidate on polygon write).
3. **Matching caps**: candidate limit 50 before feasibility scoring; single `$in` booking fetch (no per-candidate booking reads); `explain()` on the geo+status query with production-like tech density before sign-off.
4. **History**: keep TTL insert (already correct); monitor insert rate + TTL deletion lag; consider capped per-tech read (limit 100, no full-trail endpoints).
5. **Cursors**: keep `lastMatchingAt` (30 s), `lastJobsChangeAt` (socket short-circuit) — both proven; add metrics (match-skipped-by-rate-limit count, short-circuit hit rate).
6. **Indexes** (background builds): keep all in A6b + add `{skills.serviceId, availability.isOnline, workStatus}` and `{cityZoneId, availability.isOnline, workStatus}`; verify `$geoIntersects`/2dsphere compound behavior via `explain("executionStats")` (IXSCAN, keysExamined ≈ returned).
7. **Field deletions** (Part A A6): wallet mirrors → reconciler → read-model; bank/fcm mirrors → sources; stored `profileComplete` → virtual. Each deletion shrinks every full-doc load until selects are fully standardized — do these in the same release as the select lists.

### C3. Query verification (run on staging with realistic data)

```javascript
db.technicianprofiles.find({ location: { $nearSphere: { $geometry: { type: "Point", coordinates: [lng, lat] }, $maxDistance: 10000 } }, workStatus: "approved", "availability.isOnline": true }).explain("executionStats")
// require: IXSCAN, no COLLSCAN, keysExamined/docosExamined bounded by limit
db.technicianprofiles.find({ _id: ObjectId("...") }).explain("executionStats") // _id IXSCAN trivially
```

### C4. Metrics to watch

`location_ping_total{via}` / `location_ping_latency` / `location_stale_skip_total` / `match_rate_limited_total` / `get_jobs_shortcircuit_hit_total` / `revalidate_run_total{reason}` + duration / `zone_resolve_cache_hit_total` / `history_insert_errors_total` / geo-query `executionTimeMillis` (slow-query log).

### C5. Acceptance

- Ping p95 down (fewer ops/ping: target ≤3 Mongo ops on no-move path, ≤4 on move path, excluding throttled revalidation).
- Zero unscoped Profile loads in hot paths (grep audit).
- Matching candidate query IXSCAN with cap; storm test (50 techs × 12 pings/min + broadcast) shows no COLLSCAN and bounded docsExamined.
- All 28-section criteria in `docs/module-audits/M2-Technician-Audit.md` §22 still green after the slim-down.
