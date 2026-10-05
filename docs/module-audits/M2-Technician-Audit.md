# M2 — Technician (Profile, Onboarding, KYC, Skills, Location): Production Audit & Rewrite Design

> Project: RightTouch · Stack: Node.js + Express 5 + Mongoose 8 · Realtime: Socket.IO (location pings)
> Scope: ONLY M2. Cross-module notes under "External Dependency / Cross-Module Impact".
> Status: **ANALYSIS + TARGET DESIGN ONLY — no code modified.**

---

## 1. Executive Summary

M2 turns a `User(role=Technician)` into a dispatchable worker via `TechnicianProfile` (location, skills, `workStatus`, availability, wallet/payout mirrors, geo-permissions), `TechnicianKYC` (encrypted IDs + bank), `TechnicianSkillRequest` queue, and `TechnicianLocationHistory`. The pipeline works end-to-end (onboarding → KYC → training verify → approved → online → pings → skills → dispatch-eligible), but the controller is a god-object (`Controllers/technician.js`), wallet/bank/profileComplete fields are duplicated sources of truth, `suspended` is not enforced at the query layer, and admin list endpoints leak PII. Verdict: **YES WITH CONDITIONS** — split the controller, delete mirror fields, enforce workStatus centrally, then rewrite incrementally.

## 2. Current Module Inventory

| File | Responsibility | Called by | Calls | Authoritative? | Decision |
|---|---|---|---|---|---|
| `Schemas/TechnicianProfile.js` (~369 lines) | Operational profile: GeoJSON location 2dsphere, workDetails, skills[{serviceId,exp}], trainingCompleted, workStatus pending\|trained\|approved\|suspended\|deleted, availability.isOnline, fcmTokens[], rating{avg,count}, wallet mirrors (walletBalance/available/reserved/reserve/outstanding/lifetime*Paise, walletVersion), payout/bank mirrors, payoutBlocked, geo-permission ids, dispatchLockUntil, counters, isRead | technician.js, matching, settlement, wallet controllers | User, Service | YES (ops state) | REMAIN, prune mirrors |
| `Schemas/TechnicianKYC.js` | Encrypted aadhaar/pan/dl (Mixed plain-or-cipher) + Cloudinary urls, verificationStatus, bank encrypted + accountNumberHash + fingerprint, encryptedDek | technicianKycController, payout engine, profileService | kmsClient, cloudinary | YES (KYC truth) | REMAIN, forbid plaintext |
| `Schemas/TechnicianSkillRequest.js` | serviceId+zone/district+reason/docs, pending\|approved\|rejected + reviewedBy | technician.js submit, skillRequestController review | Service, Profile | YES | REMAIN |
| `Schemas/TechnicianLocationHistory.js` | GPS pings, 2dsphere + 30-day TTL | technicianLocation.handleLocationUpdate | — | YES (trail) | REMAIN |
| `Controllers/technician.js` | God-controller: location, FCM, skills add/remove, registration districts/zones/validate/zone-services, skill-request submit/list, createTechnician onboarding, getAll/getById/getMy/update, status, training, profile-image, delete | Routes/technician.js | Profile, ZoneServiceMapping, districtService, matching | PARTIAL (mixes self-service + admin) | SPLIT into 4 controllers |
| `Controllers/technicianKycController.js` | submit KYC/bank/docs, masked reads, audited getFullPII, admin verifyKYC (training-gated)/verifyBank (fingerprint)/update/delete/orphan cleanup | Routes/technician.js + adminKycRoutes | KYC, kms crypto, cloudinary, AuditLog | YES | REMAIN, extract requireOwnerAdmin |
| `Controllers/technicianSkillRequestController.js` | Admin list + review approve (push skill + auto-enable mapping)/reject + notify | adminSkillRequestRoutes | Profile, ZoneServiceMapping, notification | YES | REMAIN |
| `Services/technicianEligibilityService.js` + `Utils/technicianEligibility.js` | BROADCAST vs ACCEPT eligibility | matching, getMyJobs, respondToJob | Profile, availability | YES | REMAIN, single entry |
| `Utils/technicianActivation.js` | KYC+training+workStatus gate | matching, getMyJobs | Profile, KYC | YES | REMAIN |
| `Utils/technicianLocation.js` | handleLocationUpdate: persist + history + zoneMismatch + revalidation | HTTP PUT /location + socket TECH_LOCATION_UPDATE | Profile, History, geo | YES | REMAIN |
| `Utils/technicianGeo.js`, `technicianJobFetch.js`, `findNearbyTechnicians.js` | Geo helpers, fetchTechnicianJobsInternal, $nearSphere+Haversine | socket get_jobs, matching | Profile, Booking | PARTIAL helpers | REMAIN |
| `Utils/kycEncryption.js`, `kycFieldCrypto.js`, `kycPrivacy.js`, `kmsClient.js` | Envelope encrypt/decrypt, masking | KYC controller, profileService | KMS/env | YES | REMAIN |
| `Routes/technician.js` | All tech HTTP surface (see M-responsibilities doc) | index.js /api/technician | above controllers | YES | REMAIN, add guards + prune aliases |
| `Routes/adminKycRoutes.js`, `adminSkillRequestRoutes.js` | Admin KYC + skill review | index.js /api/admin | same | YES | REMAIN |

No M2-owned workers/crons; location budgets live in `index.js` + `socketRateLimiter`.

## 3. Actual Current Flow

```text
Onboarding: POST /technicianData(Auth) → createTechnician: GPS → validateRegistrationLocation
 (district/zone resolve) → skill vs ZoneServiceMapping check → TechnicianProfile.create
KYC: POST /kyc → submitTechnicianKyc → encrypt IDs → KYC.create(pending)
     POST /kyc/upload (multer kycUpload) → Cloudinary urls
     POST /banks → submitTechnicianBankDetails → encrypt + hash + fingerprint
     Admin PUT /kyc/verify (training-gated) → approved → workStatus flow; PUT /kyc/bank/verify
Skills: PUT /technician/skills/add → if mapped: direct push; else → POST /skill-requests → Admin review → approve pushes skill + auto-enables mapping
Location: PUT /location (locationLimiter 12/min) or socket TECH_LOCATION_UPDATE (12/min acked)
 → handleLocationUpdate → Profile.location + History.insert + zoneMismatch compute + broadcast revalidation
Reads: GET /technician/me (self) vs GET /technicianAll|/technicianById/:id (Auth only — see §5)
```

Failure/retry/timeout/cancel/dup/concurrent/partial/admin flows mirror M1 patterns; key extras: KYC reject → resubmit allowed; bank fingerprint change → re-verify required; location throttle → 429 + ack retryAfterMs.

## 4. Business Rules & Invariants

1. **One User ↔ one TechnicianProfile.** Enforcement: userId unique. Fail: none observed. KEEP + test.
2. **Only approved+trained+KYC-verified+online techs are dispatchable.** Enforcement: scattered (activation in matching/getMyJobs; offline-enforcement only masks response). Fail: suspended/untrained reach APIs. Solution: central `isDispatchable()` used by matching + gates. DB: index {workStatus,trainingCompleted,updatedAt}.
3. **KYC PII must be encrypted at rest, masked by default, full access audited.** Enforcement: good (envelope crypto + masking + audited full read). KEEP; forbid Mixed plaintext writes going forward.
4. **Bank account changes must re-verify (payout safety).** Enforcement: fingerprint compare + verifyBankDetails. KEEP.
5. **Skills must be zone-mapped.** Enforcement: addSkills gate + SkillRequest path. KEEP.
6. **Wallet truth lives in ledger, not Profile mirrors.** Enforcement: NONE (mirrors written alongside). Fail: drift. Solution: mirrors → read-model or delete (§18).

## 5. Current Problems

- **P0 — Suspended/untrained techs reach dispatch APIs; enforcement is response-masking.** Evidence: `Controllers/technicianBroadcastController.js getMyJobs` masks + best-effort updateOne; `isTechnician.js` no status check. Impact: unsafe dispatch. Fix: `workStatus∉{suspended,deleted} + trainingCompleted` checks at query + `authorizeRoles` + `isDispatchable()` single helper.
- **P1 — PII/wallet leak on bare-Auth admin reads.** Evidence: `Routes/technician.js:123-124` technicianAll/ById; `getAdminJobHistory`, jobs/current|accepted under Auth. Impact: any login enumerates techs. Fix: `authorizeRoles(Owner,Admin)` on admin subset; separate self vs admin routers.
- **P1 — God-controller + wallet/bank/profileComplete mirrors.** Evidence: `Controllers/technician.js` ~1000+ lines mixing onboarding/skills/location/admin; Profile wallet*Paise + bankDetails + fcmTokens + profileComplete×3. Impact: unmaintainable, drift. Fix: split 4 controllers; delete mirrors (ledger/DeviceToken/KYC source); computed `profileComplete` virtual.
- **P2 — KYC Mixed plaintext legacy; skill-request auto-enable mapping side effects undocumented.** Fix: forbid plaintext (migration encrypts); document + audit mapping auto-enable.
- **P2 — Route alias triplication (/kyc×2, /banks×4, registration doubles).** Fix: canonical paths + 301/shim one release.
- **P3 — isRead badge on Profile (admin-unread) conflates ops state with notification state.** Fix: derive from Notification module (M11) or keep with TTL; document.

## 6. Security Findings

| Severity | Finding | Scenario | Current | Impact | Fix | Verification |
|---|---|---|---|---|---|---|
| P1 | PII leak (tech list/PII/wallet to any auth user) | Customer token GET technicianAll | bare-Auth routes | Privacy breach | authorizeRoles | 403 test |
| P1 | Suspend bypass → job access | Suspended tech accepts broadcast | no workStatus gate | Safety | central gate | e2e suspend |
| P2 | Full-PII endpoint needs audit (already audited — KEEP) | getTechnicianKycFull | audited Owner/Admin | OK | keep + alert on bulk | audit log test |
| P2 | Profile image upload without strict type/size? | malicious file via multer-single | upload.single(profileImage) | storage abuse | mime+size allowlist + AV scan note | upload fuzz |
| P2 | Plaintext legacy IDs readable | old Mixed plaintext rows | Mixed type | at-rest exposure | migration encrypt + forbid | DB scan test |

## 7. Database Findings

Profile: REMOVE `bankDetails` mirror, `fcmTokens`, stored `profileComplete`, wallet `*Paise` mirrors (→ read-model/ledger); ADD `suspendedAt/suspendedReason`; KEEP location/skills/availability/geo-permissions/counters. KYC: forbid Mixed plaintext (app guard + migration); ADD `unique(accountNumberHash)` partial + `statusHistory[]`. SkillRequest: ADD compound `{technicianId,status,createdAt}` index. LocationHistory: KEEP TTL 30d + `{technicianId,timestamp}` index.

## 8. Query & Index Findings

| Query | Filter/Sort | Index | Action |
|---|---|---|---|
| getMyTechnician | {userId} unique ✓ | KEEP | lean + select minimal |
| admin tech lists | {workStatus,training,updatedAt} + paginate | NEW compound | enforce pagination (20/100) |
| matching candidates | {location $nearSphere, workStatus, skills, perms} | 2dsphere + composites | covered in M6 deep audit; keep lean + limit |
| location update | findById + save | _id ✓ | use updateOne (no doc load) |
| history trail | {technicianId,timestamp desc} | NEW compound + TTL | capped read (limit 100) |

Unnecessary populate() in getAllTechnicians (User+KYC per row) → replace with targeted selects + paginate.

## 9. Concurrency Findings

- Concurrent skill add/remove same tech: array push/pull races → use `$addToSet`/`$pull` atomics (already mostly) + version check. No Redis.
- Concurrent location pings: last-write-wins acceptable; History inserts independent. OK.
- Double onboarding same user: userId unique backstop → catch 11000 → 409. Add.
- KYC verify vs tech resubmit race: conditional `findOneAndUpdate({_id, verificationStatus:'pending'})`; loser 409. Add.

## 10. Transaction Findings

- createTechnician (User exists + Profile.create + Permission auto-grant): multi-doc → KEEP txn where permission grant included; else single create, no txn needed.
- Skill-request approve (Profile push + mapping enable + audit): multi-doc → KEEP txn.
- KYC verify/bank verify: single-doc + audit (audit best-effort, never blocks) → NO txn (or txn with audit if session passed — keep best-effort).
- Location ping: single writes → NO txn.

## 11. Outbox / Worker Findings

M2 needs NO new outbox. Skill-approval notification + KYC decision notification go through M11 `notify()` (already). Broadcast revalidation after location/permission change is synchronous in-request (acceptable) + cron rebroadcast covers misses (M6). No worker changes.

## 12. Idempotency Findings

| Op | Key | Behavior |
|---|---|---|
| createTechnician | userId unique | second → 409 |
| addSkills | $addToSet | replay safe |
| submitKYC resubmit | technicianId unique (upsert) | last-wins while pending; blocked once approved (must admin-reset) |
| bank update | fingerprint compare | same details → no-op 200 |
| location ping | none (state, not event) | last-wins |
| skill-request review | conditional status pending→approved/rejected | replay → 409 |

## 13. API Contract Findings

Issues: registration aliases (`/registration/districts` vs `/districts`); KYC path triplicates; `PUT /updateTechnician` (should be PATCH /me); admin reads mixed with self-service under one router; `technicianAll` unpaginated. Fix: canonical REST (`GET|PATCH /me`, `POST /skills/add`, `GET /registration/...` single set), paginate admin lists, keep aliases one release with `X-Deprecated`. Codes: use 403 suspended, 409 dup/race-lost, 422 validation, 429 location throttle (already).

## 14. Target Architecture

```text
Route (Auth + requireRole) → Validator → Controller-thin (onboarding|profile|skills|location) 
 → Service (technician.service, kyc.service, skills.service) → Repository → Mongo (txn only approve/onboard-grant)
 → notify() (M11) post-commit, best-effort
```

## 15. Target Schema

Profile: KEEP identity-link/location/skills/training/workStatus/availability/rating/counters/geo-permissions/dispatchLock; REMOVE mirrors (wallet/bank/fcm/stored-complete); ADD suspendedAt/Reason; `profileComplete` → DERIVED. KYC: KEEP + plaintext-forbid + hash-unique + history. SkillRequest/History: KEEP + indexes.

## 16. Target Query Design

All `_id`/unique → IXSCAN. Admin lists via new compound + `lean().skip().limit()`. Location update via `updateOne`. Matching candidate query verified in M6 audit (explain on staging with realistic tech density).

## 17. Target File Structure

```text
modules/technician/
├── routes/technician-self.routes.js   # me/skills/location/kyc-submit/skill-requests (Auth+Technician)
├── routes/technician-admin.routes.js  # list/detail/verify/review (Auth+Owner/Admin)
├── controllers/onboarding.controller.js | profile.controller.js | skills.controller.js | location.controller.js
├── services/technician.service.js | kyc.service.js | skills.service.js
├── repositories/technician.repo.js | kyc.repo.js
├── validators/technician.validator.js # NEW single place
├── policies/dispatchable.policy.js     # NEW isDispatchable() shared with M6
└── tests/...
```

## 18. State Machine

```text
workStatus: pending → trained → approved ⇄ suspended → (approved | deleted terminal)
trainingCompleted: false → true (gates verify/approve)
KYC verificationStatus: pending → approved | rejected → (resubmit → pending)
SkillRequest: pending → approved | rejected (terminal)
```

Guards: verifyKYC requires trainingCompleted; approve (dispatchable) requires KYC-approved + training + workStatus approved + online. All transitions via services (no direct `workStatus=` writes — grep-enforced). Concurrent protection: conditional findOneAndUpdate on expected status.

## 19. Edge Cases

| Scenario | Expected | Current | Production |
|---|---|---|---|
| Double onboarding | 409 | maybe 500 | catch dup → 409 |
| Verify while resubmit in flight | one wins, other 409 | possible overwrite | conditional update |
| Suspended tech polls jobs | 403 + empty | masked list | 403 + socket guard |
| Location ping storm | 429 + ack | HTTP path had no limit (now 12/min) | KEEP + monitor |
| Bank change post-verify | re-verify required | fingerprint path exists | KEEP + test |
| Skill add for unmapped service | SkillRequest created | works | KEEP + test |
| Orphan KYC (user deleted) | cleaned | orphan list + cleanup exists | KEEP + scheduled sweep |

## 20. Test Plan

Unit (dispatchable policy, complete-compute, fingerprint compare); integration (onboard txn, approve txn); API (self vs admin gates, aliases, pagination); concurrency (double onboard/verify/add-skill); idempotency (replay table); security (PII 403 matrix, upload fuzz, suspend bypass); failure (KMS down → 503, Cloudinary down → 503 + retry); regression (mobile onboarding path shape); load (location ping burst, admin list p95).

## 21. Migration Plan

Phase 1 audit DONE. Phase 2 tests on current code. Phase 3 additive indexes (background) + suspendedAt. Phase 4 split controllers + central gates + mirror-removal with dual-read compat (read ledger/DeviceToken, fallback mirrors one release). Phase 5 route canonicalization + deprecation headers. Phase 6 backfill/encrypt-plaintext + drop mirrors. Phase 7 shadow dispatchable checks (log-only). Phase 8 enforce. Phase 9 monitor (onboard success, verify latency, location 429 rate). Phase 10 delete legacy mirrors/aliases. Rollback each phase = redeploy prior image; schema additive until Phase 6 (backup before destructive).

## 22. Production Verification Checklist

Code (no god-controller, no direct status writes, single dispatchable helper); DB (schemas/indexes/explain/pagination); Security (gates, PII audit, upload policy); Reliability (idempotent approve/verify, txn where needed, notify best-effort); Observability (requestId, KYC decision audit, location-drop metric); Testing (all suites green); Deployment (migration dry-run, compat, rollback doc).

## 23-26. Files

- Create: validators, policies/dispatchable.policy.js, repos, split controllers, tests, encrypt-backfill script.
- Modify: Schemas (prune + indexes), skillRequestController (txn + conditional), KYC controller (forbid plaintext), routes (guards + canonical), matching/getMyJobs (use policy).
- Merge: split `Controllers/technician.js` into 4 (delete original post-compat).
- Delete: mirrors post-migration; alias routes post-client-migration.

## 27. Risks / Open Questions

Training content/ownership outside backend scope — keep boolean. Biometric/ID verification vendor? None currently (manual admin) — keep. Multi-zone techs allowed via ADDITIONAL grants — confirm product wants per-zone skill mapping (yes, current). Cross-module: M1 (role/status gates), M3 (district/zone/mapping truth), M6 (matching/eligibility consumer), M9 (wallet/payout reads Profile/KYC), M11 (notifications + DeviceToken), M12 (admin lists).

## 28. Final Acceptance Criteria

Onboarding→verify→approved→online→ping→skill→dispatch-eligible e2e green; suspended/untrained → 403 everywhere; no PII leak; no mirror drift (ledger/DeviceToken/KYC single sources); concurrent onboard/verify/skill exactly-once; tests green; migration dry-run clean.

### Can this module safely be rewritten now?

```text
YES WITH CONDITIONS
```

Conditions: additive indexes first; central dispatchable gate + admin guard coverage in same release; mirror removal behind dual-read compat; full gate + concurrency suite green. Must NOT break: M1 signup auto-create, M3 permission/mapping writes, M6 matching queries, M9 payout KYC reads, M11 notify calls.
