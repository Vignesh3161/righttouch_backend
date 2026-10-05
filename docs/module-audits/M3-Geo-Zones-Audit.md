# M3 — Geo / Zones / Permissions / Availability: Production Audit & Rewrite Design

> Project: RightTouch · Stack: Node.js + Express 5 + Mongoose 8 (2dsphere) · Realtime: Socket.IO (revalidation pushes)
> Scope: ONLY M3. Cross-module notes under §27.
> Status: **ANALYSIS + TARGET DESIGN ONLY — no code modified.**

---

## 1. Executive Summary

M3 decides **where the platform operates and who may work where**: `OperationalCity` (district polygon) → `CityZone` (sub-polygon) → `ZoneServiceMapping` (service approved per zone) → `ServiceAvailability` (layered DISTRICT/CITY/ZONE overrides), plus `TechnicianDistrictPermission` (+History/Audit) and mobile `Permission` mirrors. Single source of truth `resolveServiceAvailability()` exists and is used by checkout/listing/matching — good. But naming is chaotic (`districtId→OperationalCity`), two geo consoles overlap (`cityZoneController` vs `adminZoneGeofenceController`), new zones seed all-disabled (safe but ops-heavy), and zero-tech `broadcasted` never re-queues. Verdict: **YES WITH CONDITIONS** — unify the geo console, rename refs (compat), add re-queue + cancel-revoke, keep the availability resolver as-is.

## 2. Current Module Inventory

| File | Responsibility | Called by | Calls | Authoritative? | Decision |
|---|---|---|---|---|---|
| `Schemas/OperationalCity.js` | District polygon + active/isRegistrationEnabled/isJobEnabled + status/version, 2dsphere | districtService, operationalCityController, bookings (districtId) | — | YES (district truth) | REMAIN (rename refs only) |
| `Schemas/CityZone.js` | Sub-zone + zoneCode unique + polygon Mixed + active, 2dsphere | cityZoneController, matching, bookings (cityZoneId) | OperationalCity | YES | REMAIN |
| `Schemas/ZoneServiceMapping.js` | zone+service unique, active, pricingMultiplier | availability resolver, matching, cityZoneController | Zone, Service | YES (per-zone approval) | REMAIN |
| `Schemas/ServiceAvailability.js` | service+district+zone+scope unique; CITY/ZONE overrides DISTRICT | adminServiceAvailabilityController, resolver | — | YES (override layer) | REMAIN |
| `Schemas/PolygonVersion.js` | Polygon snapshots + rollback | adminZoneGeofenceController | — | YES | REMAIN |
| `Schemas/TechnicianDistrictPermission.js` | tech+district unique, PRIMARY/ADDITIONAL, isEnabled | technicianDistrictService, matching | — | YES | REMAIN |
| `Schemas/DistrictPermissionHistory.js`, `TechnicianZonePermissionAudit.js` | Grant/revoke/enable/disable audits | district/zone controllers | — | YES | REMAIN |
| `Schemas/Permission.js` + `PermissionHistory.js` | Per-device OS permission mirror | permissionController | — | PARTIAL (mirror, never OS truth) | REMAIN, document mirror status |
| `Controllers/operationalCityController.js` | District CRUD + toggles + tech listing + cache invalidation | operationalCityRoutes | districtService | YES | REMAIN, merge console w/ geofence ctrl |
| `Controllers/cityZoneController.js` | Zone CRUD + bulk mapping + ZONE-availability sync + candidates | adminZones | ZoneServiceMapping, ServiceAvailability | YES | REMAIN |
| `Controllers/adminZoneGeofenceController.js` | Legacy geo console (districts/zones/permissions/impact/hierarchy/inspect/rollback/tech admin/broadcast audit) | adminZoneGeofenceRoutes | everything geo | PARTIAL (overlaps) | MERGE into console |
| `Controllers/adminTechnicianDistrictController.js` | Thin wrapper → technicianDistrictService | adminTechnicianDistrictRoutes | service | NO | REMAIN (or fold into console) |
| `Controllers/adminTechnicianZoneController.js` | enabledCityZoneIds grant/revoke (parent-district gated) + audit + revalidation | same routes | audit, matching revalidation | YES | REMAIN |
| `Controllers/adminServiceAvailabilityController.js` | Availability CRUD/toggle/bulk/clear + matrix/detail/diagnostics | adminServiceAvailabilityRoutes | mapping sync, revalidation | YES | REMAIN |
| `Controllers/zoneAvailabilityController.js` | resolveCustomerZone/checkServiceAvailability + getMyZone/getServicesInMyZone | userZones/technicianZones | resolver + resolveZoneFromCoordinates | NO (thin) | REMAIN |
| `Controllers/permissionController.js` + `Utils/permissionService.js` | PUT/GET /permissions per device | permissionRoutes ×3 | Permission | YES | REMAIN |
| `Services/districtService.js` | getDistrictFromCoordinates ($geoIntersects active) | resolver, onboarding, checkout | OperationalCity | YES | REMAIN |
| `Services/technicianDistrictService.js` | syncAllowedCityIds/getAllowedDistricts/isAllowedInDistrict/add/toggle/remove (primary-protection + auto-heal + audit) | district/zone controllers, matching | Permission + History | YES | REMAIN |
| `Services/serviceAvailabilityService.js` | resolveServiceAvailability() layered truth | checkout, listing, matching, zone checks | Service, district, zone, mapping, overrides | YES (keep!) | REMAIN untouched |
| `Utils/resolveZoneFromCoordinates.js`, `geoValidation.js`, `servicePolygon.js`, `locationConfig.js`, `feasibility.js` | GPS→district+zone, polygon sanitize, coverage polygon, TZ config, travel feasibility | resolver, booking, matching | — | YES helpers | REMAIN |

Routes: operationalCityRoutes, adminZones, adminZoneGeofenceRoutes, adminTechnicianDistrictRoutes, adminServiceAvailabilityRoutes, userZones, technicianZones, permissionRoutes ×3 (full endpoint lists in responsibilities doc).

## 3. Actual Current Flow

```text
Customer GPS/address (or tech registration GPS)
 → resolveDistrictAndZoneFromCoordinates(includeInactive)
 → resolveServiceAvailability(): Service.isActive > district active/job > zone exists/belongs/active
   > mapping mandatory > ZONE/CITY override > DISTRICT default > fallback
 → ALLOW (checkout/listing/matching proceed) or BLOCK (inactive/mismatch/missing mapping)
Tech: registration GPS → primary district+zone + auto Permission
 → admin grants ADDITIONAL districts/zones (technicianDistrictService / zone controller, audited)
 → matching runtime: GPS freshness + permission + availability re-checked per broadcast
Admin: CRUD districts/zones/mappings/overrides → mapping sync + broadcast revalidation (sync) + polygon versioning
```

Failure: outside any polygon → BLOCK with reason; inactive district/zone → BLOCK; missing mapping → BLOCK; zone-mismatch on tech ping → flag + revalidation. Retry: client retries with corrected location. Timeout: none (sync reads). Cancel: N/A. Dup/concurrent: permission grants idempotent (unique backstop); mapping bulk upserts idempotent. Partial: mapping created but availability override stale → resolver precedence handles deterministically. Admin: impact-analysis + hierarchy + inspect endpoints pre-check blast radius.

## 4. Business Rules & Invariants

1. **A booking/job exists only inside an active district+zone with an approved mapping.** Enforcement: resolver at checkout + matching. KEEP; extend to re-queue path.
2. **ZONE/CITY overrides beat DISTRICT defaults; mapping is mandatory.** Enforcement: resolver order. KEEP; add precedence tests.
3. **Tech works only where permitted (district grant + zone grant).** Enforcement: matching + eligibility. Fail: naming confusion risks wrong-field checks. Solution: rename refs + single `isAllowedInZone()` helper. DB: keep unique grants.
4. **PRIMARY district is protected (cannot remove last/primary without replacement).** Enforcement: service guard. KEEP + test.
5. **Polygon edits are versioned + rollback-capable.** Enforcement: PolygonVersion. KEEP.
6. **Mobile permission mirror never grants server-side capability.** Document; KEEP as telemetry only.

## 5. Current Problems

- **P1 — Naming chaos (`districtId→OperationalCity`, district vs city vs zone fields).** Evidence: `ServiceBooking.districtId ref OperationalCity`; Profile `primaryCityId/primaryDistrictId/allowedCityIds`. Impact: wrong-field bugs, onboarding friction. Fix: rename to `operationalDistrictId` (schema alias + dual-read compat), docs + tests. Not P0 (works today) but required before any rewrite.
- **P1 — Two overlapping geo consoles.** Evidence: `cityZoneController` vs `adminZoneGeofenceController` (both create zones/permissions/tech-admin). Impact: divergent writes, audit gaps. Fix: single console (keep granular controllers, merge routes + dedupe logic into services).
- **P1 — Zero-tech broadcasted never re-queues; no cancel-revoke outbox.** (Owned jointly with M6; M3 action: expose revalidation API + `cancel_revoke` kind.) Impact: stuck broadcasted, offline techs miss cancels. Fix: `broadcasted→pending` re-queue + `DispatchOutbox kind=cancel_revoke`.
- **P2 — New zones seed all services DISABLED (safe but ops-heavy); bulk mapping exists but undiscoverable.** Fix: keep default-deny + add "clone mappings from zone" admin action.
- **P2 — Polygon Mixed type relies on controller-layer validation.** (Historical fix for MultiPolygon stripping — keep.) Fix: keep + add schema-level custom validator + tests for Polygon/MultiPolygon.
- **P3 — Route alias triplication on districts (`/districts|/operational-cities|/admin/districts`).** Fix: canonicalize + deprecate.

## 6. Security Findings

| Severity | Finding | Scenario | Current | Impact | Fix | Verification |
|---|---|---|---|---|---|---|
| P1 | IDOR on tech-permission endpoints? | Admin B edits tech of district they don't own | Auth only (no ownership scoping verified) | Cross-admin tampering | scope: Owner/Admin any (intended) — confirm + audit | role matrix test |
| P2 | Polygon injection (huge/degenerate) | Giant polygon DoS/memory | controller validator exists | DoS | ring-count/area caps + validator tests | fuzz test |
| P2 | Stale tech location → wrong-zone dispatch | Spoofed GPS | freshness check exists in matching | mis-dispatch | keep freshness + mismatch flag | e2e spoof test |

No auth flaws owned by M3 (gates from M1). Confirm `authorizeRoles` present on all admin geo writes (audit in §22 checklist).

## 7. Database Findings

- OperationalCity/CityZone polygons: KEEP Mixed + 2dsphere; ADD validator (ring closure, min 4 pts, max N rings/points, area cap) + keep PolygonVersion.
- ZoneServiceMapping: KEEP unique(zone,service); ADD `{serviceId,active}` index for matrix queries.
- ServiceAvailability: KEEP unique(service,district,zone,scope); ADD `{districtId,scope}` + `{cityZoneId,scope}` indexes.
- Permissions: KEEP unique grants + history append-only (no updates to history docs — enforce).
- Permission mirror: ADD TTL? No — small; keep + `{userId,deviceId}` unique + index.

## 8. Query & Index Findings

| Query | Index | Action |
|---|---|---|
| $geoIntersects district | 2dsphere on polygon ✓ (verify) | explain() IXSCAN; ensure `active:true` prefilter uses compound {active:1, polygon:2dsphere}? (2dsphere compound rules — verify on staging) |
| zone by district | {operationalCityId,active} ✓ | KEEP |
| mapping matrix per zone | {zoneId} | NEW {zoneId,active} + {serviceId,active} |
| availability resolve | unique quad ✓ | ADD district/zone-scoped secondaries |
| tech permission check | unique(tech,district) ✓ | ADD {technicianId,isEnabled} for listing |
| admin matrix (all zones × services) | — | paginate; no full-cartesian responses (cap + cursor) |

## 9. Concurrency Findings

- Concurrent permission grant same pair: unique backstop → catch → 200 idempotent. Add.
- Concurrent mapping toggle: last-wins acceptable (admin ops, audited).
- Concurrent polygon edit: version++ conditional; loser 409 → rebase. Add `version` check to update path.
- Broadcast revalidation storms after bulk mapping change: debounce/coalesce (already per-tech revalidation; add bulk endpoint that queues single revalidation pass — M6 worker).

## 10. Transaction Findings

- Zone create + seed mappings + availability sync: multi-doc → KEEP txn (already pattern in cityZoneController; verify all paths).
- Permission grant + audit history: dual-write → KEEP txn (service already; verify zone path too).
- Resolver reads: NO txn. Polygon rollback (restore + version): txn. Keep.

## 11. Outbox / Worker Findings

M3 needs no new outbox; permission/mapping changes trigger M6 broadcast revalidation synchronously + M6 rebroadcast cron covers misses. ADD `DispatchOutbox kind=cancel_revoke` (M6-owned, M3 exposes trigger API). Quotation/delivery unaffected.

## 12. Idempotency Findings

| Op | Key | Behavior |
|---|---|---|
| grant district/zone | unique pair | replay → 200 same state |
| mapping create/toggle | unique pair + active flag | replay → same |
| availability set | unique quad | replay → same |
| polygon update | version conditional | replay with same version → 409 (client refetch) |
| permission mirror PUT | (user,device) upsert | replay safe |

## 13. API Contract Findings

Alias triplication (districts ×3 paths, zones ×2, city-zones add/remove ×4 verbs) → canonicalize: `GET|POST /districts`, `GET|PUT|DELETE /districts/:id`, `PATCH .../status|registration|jobs`, `GET .../technicians`; zones `GET|POST /zones`, etc.; keep aliases one release with `X-Deprecated`. Pagination missing on tech-candidate/matrix endpoints → add. Codes: 404 unknown coords? Use 422 UNMAPPED_LOCATION (semantically invalid) — document; 409 version/duplicate; 429 none (admin ops, no limiter needed beyond global).

## 14. Target Architecture

```text
Route (Auth+authorizeRoles) → Validator (polygon/rings/ids) → Controller-thin (one per resource)
 → Service (district/zone/mapping/availability/permission — sole writers) → Repository → Mongo (txn for create-seed/audit)
 → post-commit: broadcast revalidation (M6 hook) + audit write (best-effort)
Resolver stays a pure read service used by M2/M4/M5/M6.
```

## 15. Target Schema

RENAME refs (MIGRATE with alias): `ServiceBooking.districtId→operationalDistrictId` (alias keeps old reads), Profile geo fields likewise (coordinate with M2). KEEP all collections; ADD indexes/validators above; history collections append-only (freeze updates via app guard).

## 16. Target Query Design

Geo: `$geoIntersects` with `active:true` prefilter; verify compound-2dsphere behavior via explain on staging. Matrix: keyset pagination (`?after=zoneId&limit=50`), never full cartesian. Permission checks: covered unique lookups (lean).

## 17. Target File Structure

```text
modules/geo/
├── routes/districts.routes.js | zones.routes.js | mappings.routes.js | availability.routes.js | permissions.routes.js
├── controllers/* (thin, one per resource — reuse current, minus geofence-console dup)
├── services/district.service.js | zone.service.js | mapping.service.js | availability.service.js (KEEP resolver untouched) | permission.service.js
├── repositories/* (scoped queries)
├── validators/geo.validator.js  # NEW: polygon/ids/scope
├── policies/zone-access.policy.js # NEW isAllowedInZone() for M6
└── tests/...
```

NOT in M3: matching scoring (M6), payout gating (M9).

## 18. State Machine

Districts/zones: `active/inactive × registration on/off × jobs on/off` (orthogonal toggles, audited). Permissions: `absent → granted(enabled|disabled) → revoked(absent)` + PRIMARY protection. Availability: per-scope `ENABLED ⇄ DISABLED` (precedence ZONE/CITY > DISTRICT). All via services; no direct writes.

## 19. Edge Cases

| Scenario | Expected | Current | Production |
|---|---|---|---|
| GPS in no polygon | 422 UNMAPPED + nearest-district hint? | BLOCK | keep BLOCK + structured reason |
| GPS on polygon boundary | deterministic (one district) | $geoIntersects dependent | pin + test boundary set |
| Overlapping districts | first/active wins + alert | possible | validation: warn on overlap at create (allow, alert) |
| MultiPolygon zone | matches | fixed via Mixed | keep + regression test |
| Mapping deleted mid-checkout | BLOCK at re-validate | resolver re-checks | KEEP double-check at booking create |
| Permission revoked mid-broadcast | excluded next pass + revoke msg | partial | ADD cancel_revoke |
| Polygon rollback | restore + version++ | exists | KEEP + test |

## 20. Test Plan

Unit (precedence matrix, primary-protection, validator); integration (zone-create-seed txn, grant+history txn, rollback); API (alias + canonical, pagination, 422/409); concurrency (double grant, polygon version race); security (role matrix, polygon fuzz, GPS spoof); failure (Mongo down → 503); regression (resolver outputs pinned for fixture coords); load (geo query p95 at 10k zones).

## 21. Migration Plan

P1 audit DONE. P2 tests pinned on resolver + grants. P3 additive indexes background + polygon validator. P4 console merge + canonical routes + `isAllowedInZone()` + version-conditional polygon update. P5 compat aliases + dual field names. P6 rename migration (alias → primary) + mapping-clone action. P7 shadow resolver (log-only compare old/new — should be identical). P8 enforce + cancel_revoke hookup (with M6). P9 monitor (resolve latency, BLOCK rate by reason). P10 remove aliases/old field names. Rollback: redeploy; renames alias-safe until P10.

## 22. Production Verification Checklist

Code (single resolver, single writers, no direct permission/mapping writes); DB (2dsphere verified, indexes, explain, pagination); Security (role matrix, validator fuzz); Reliability (idempotent grants, txn create-seed, revalidation hook); Observability (resolve latency, BLOCK-by-reason metric, audit on every grant/mapping/polygon change); Testing green; Deployment (background indexes, compat, rollback).

## 23-26. Files

- Create: validators/geo.validator.js, policies/zone-access.policy.js, repos, tests, clone-mappings action.
- Modify: schemas (aliases+indexes+validators), cityZone/operational/availability/permission controllers (dedupe into services), routes (canonical+deprecate), matching call sites (use policy).
- Merge: adminZoneGeofenceController dup logic into district/zone/permission services (keep file as shim one release).
- Delete: alias routes + old field names post-migration (P10).

## 27. Risks / Open Questions

Overlap policy for districts (warn vs forbid) — recommend warn+alert. Nearest-district hint for unmapped GPS — product call. `(phone,role)` multi-role (M1) doesn't affect M3. Cross-module: M2 registration/onboarding + location mismatch; M4 catalog listing filter; M5 checkout gate; M6 matching/revalidation/re-queue/cancel_revoke (joint); M9 payout gating by district? (verify); M11 zone-change pushes.

## 28. Final Acceptance Criteria

Resolver outputs pinned; single console; canonical routes; zero unscoped geo writes; re-queue + cancel_revoke wired with M6; indexes verified; tests green; migration dry-run clean.

### Can this module safely be rewritten now?

```text
YES WITH CONDITIONS
```

Conditions: resolver frozen (no logic change, only tests); renames alias-safe; console merge behind compat routes; re-queue/cancel_revoke delivered jointly with M6. Must NOT break: M2 onboarding/permission checks, M4 listing filter, M5 checkout gate, M6 matching + revalidation hooks.
