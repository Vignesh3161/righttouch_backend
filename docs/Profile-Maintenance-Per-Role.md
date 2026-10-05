# Profile Maintenance Guide — Per Role (What to Maintain, Who Writes What, Rules)

> Operational guide: for each role, which fields exist, which code is allowed to write them,
> what validation applies, and what must never be done. Code paths are post-restructure.
> Flow details: `docs/User-Profile-Roles-How-It-Works.md`. Technician deep-dive:
> `docs/Technician-Profile-Location-Performance.md`.

---

## 0. Golden rules (all roles)

1. **One writer per field.** The tables below name the single allowed writer. Any other
   writer is a bug — add it to code review checklists.
2. **Allow-lists, never pass-through.** Profile updates accept only named fields
   (`profileService.js`: `completeProfileInternal`, `updateMyProfileInternal`). Adding a
   new editable field = adding it to the allow-list + validator, never `req.body` spread.
3. **`profileComplete` is derived, never typed.** No client input may set it. Target:
   single `computeProfileComplete()` (Customer: fname + mobile present; Technician: name +
   address/city + valid location + ≥1 mapped skill + KYC submitted).
4. **Money, tokens and secrets never live on the profile as primary truth.**
   Balances → `WalletTransaction`/ledger (M9). Push tokens → `DeviceToken` (M11).
   Bank/ID numbers → encrypted `TechnicianKYC` (M2). Profile mirrors of these are
   scheduled for deletion — do not add new ones.
5. **Every admin write is audited** (`writeAuditLog`) with actor + before/after + reason.

---

## 1. Customer profile — maintain on the `User` row

**Lives in:** `modules/identity/models/User.js` (`role="Customer"`). Addresses are separate
rows in `modules/cart-address/models/Address.js` — the profile itself holds no address.

| Field | Allowed writer | Validation | Notes |
|---|---|---|---|
| `fname / lname` | `POST complete-profile`, `PUT /me` (allow-list) | trim; no digits-only garbage (add: min length 1 if present) | Required for `profileComplete` |
| `gender` | same | enum Male/Female/Other | Optional |
| `email` | same | sparse-unique, lowercase, regex or `deleted_*` | Duplicate → Mongo 11000 → must map to 409 (verify handler) |
| `mobileNumber` | signup verify only (once) | 10-digit / `+91` normalized at entry | **Immutable after creation.** Number change = support flow (new verify), never an update endpoint |
| `profileComplete` | server only | fname + mobile present (the one honest check, `updateMyProfileInternal` non-tech branch) | Never accept from client (`forbidden` set already blocks it — keep) |
| `status` | admin actions / delete cascade only | enum | Never client-writable (blocked by allow-list — keep) |
| `terms*/privacy* (+At)` | signup staging → verify copy; `POST /auth/accept-terms` | must be `true` | Timestamps prove consent — never backfill |
| `lastLoginAt` | LOGIN-verify only | — | Analytics/fraud signal; never manual |
| `password` | nobody (OTP role) | — | `set-password` on a Customer row is a dead credential (login ignores it). Consider rejecting with 403 for OTP roles |

**Address book (per customer):** `label home/work/other`, paired `lat/lng`, exactly one `isDefault`
(partial-unique). Maintain via `modules/cart-address/controllers/addressController.js` →
`addressService.js`. Deleting the default must promote the newest remaining row (define + test).
Default address drives `getAllServices` location filtering — keep it geocoded (both lat+lng or neither).

**Do not:** store job history, wallet, or preferences on the User doc (jobStats are computed
in the admin aggregate; preferences belong to `NotificationPreference`).

---

## 2. Technician profile — maintain across three docs, each with one job

**Lives in:** `User` (identity) + `modules/technician/models/TechnicianProfile.js` (operations)
+ `modules/technician/models/TechnicianKYC.js` (identity proof + bank). Skill requests in
`TechnicianSkillRequest.js`; GPS trail in `TechnicianLocationHistory.js` (30-day TTL).

### 2.1 Writer matrix (the core of this document)

| Field(s) | Allowed writer | How |
|---|---|---|
| `userId` link | signup-verify transaction (`authService.verifyOtpInternal` SIGNUP branch) | set once; cascade on delete |
| `fname/lname/gender` (User side) | `complete-profile` / `PUT /me` (split to User in service) | same rules as Customer |
| `address/city/state/pincode/locality/experienceYears/specialization` | same profile endpoints (Profile side of the split) | trim/clamp; allow-list only |
| `profileImage` | `POST /technician/profile-image` (multer single) | mime + size allowlist; delete old asset after success |
| `location` + `locationUpdatedAt` | `handleLocationUpdate` ONLY (HTTP `PUT /location` + socket `location_update`); onboarding seeds once | >10 m move rewrites coords; every ping stamps freshness; never toggled `isOnline` here (invariant + test) |
| `currentDistrictId / currentCityZoneId` | same ping handler (best-effort resolve) | write only on change (dirty-check); never blocks ping |
| `zoneMismatch (+Since)` | same handler, transition-only writes | admin report + matching weight; never manual |
| `cityZoneId` (registered zone) | onboarding + admin zone grant | requires parent-district permission first |
| `primaryCityId/primaryDistrictId/allowedCityIds/enabledDistrictIds/enabledCityZoneIds` | `technicianDistrictService` / zone controller (audited, primary-protected) | never hand-edit; matching depends on exact shape |
| `skills[]` | `add/removeTechnicianSkills` (mapped → direct `$addToSet`/`$pull`) or SkillRequest approve (unmapped → request → admin approve + auto-enable mapping) | `serviceId` must reference live Service; drop dead ids when a mapping is disabled |
| `serviceRadiusKm` | admin per-tech override (default 10, clamp 1–100) | feeds matching radius |
| `trainingCompleted` | training action | gates KYC verify |
| `workStatus` | onboarding (`pending`) → training (`trained`) → admin verify (`approved`) ⇄ admin suspend (`suspended`) → delete (`deleted`, terminal) | service-only transitions; suspended/deleted 403 at `Auth` + `isTechnician` |
| `availability.isOnline` | explicit go-online/offline action ONLY | pings read it, never write it |
| `dispatchLockUntil` | atomic `findOneAndUpdate` in accept path; seconds-TTL | crash-safe by expiry; never elsewhere |
| `lastJobsChangeAt` | broadcast-created/taken/expired emitters + matching + cron | socket cursor — keep writes to exactly these 3 events |
| `lastMatchingAt` | ping handler (30 s rate-limit cursor) | never reset elsewhere |
| `jobRejectCount / totalJobsCompleted` | `$inc` on decline/complete | never absolute-set |
| `rating{avg,count}` | `ratingService` on rating create (completion-gated, one-per-booking) | fix race with atomic sum/count incs (see M12) |
| `isRead/readAt/readBy` | create (false) + admin `mark-read` | badge only; don't reuse |
| KYC ids + documents + `verificationStatus` | tech submit/upload → admin verify/reject (training-gated) | encrypted at rest, masked reads, full-PII read audited |
| Bank details | tech `submitBankDetails` → admin `verifyBankDetails` (fingerprint + hash dedupe) | verified bank locks edits until `bankUpdateRequired`; changes reset to pending + 30-day window |
| Wallet `*Paise` / `walletVersion` | settlement + withdrawal + payout engine + clawback (M9/M10) | ledger/`WalletTransaction` are truth; mirrors → read-model then delete |
| `razorpayContactId/FundAccountId` | payout engine (cache) | refresh on failure, never invent |
| `payoutSettings` | tech `updateMyPayoutSettings` (validated ranges) over global config | — |
| `payoutBlocked(+Reason)` | admin/legal/fraud hold (+audit) | checked in withdrawal + engine gates |
| `bankDetails` (Profile mirror), `fcmTokens`, stored `profileComplete`, `walletBalance` | NOBODY (deprecated) | read from KYC / DeviceToken / computed / ledger; delete columns post-migration |

### 2.2 Technician lifecycle checklist (maintainer's view)

1. Verify creates User + pending Profile (+ TempUser/Otp cleanup) in one transaction.
2. `technicianData` onboarding: GPS → district/zone resolve → skill-vs-mapping check → primary grants.
3. KYC + bank + docs → training → admin verify → approved.
4. Go-online → pings flow → matching eligible → jobs → accept → execute → settle → withdraw → payout.
5. Suspend (admin) → 403 everywhere incl. sockets. Delete → anonymize User, hard-delete Profile/KYC, revoke tokens+sockets.

---

## 3. Owner profile — maintain minimally, guard maximally

**Lives in:** `User` row (`role="Owner"`). No extension doc.

| Field | Allowed writer | Notes |
|---|---|---|
| `mobileNumber` | invite-gated signup verify (once, immutable after) | `OWNER_SIGNUP_INVITE_CODE` enforced in service — never bypass |
| `password` | `owner/set-password` (Auth, post-OTP) → bcrypt-10, min 8 | Add strength policy + recent-OTP-proof (planned) |
| `fname/lname/email` | same Customer endpoints | same validation |
| `status` | Owner-quorum delete only | Never delete the last active Owner (service enforces — keep + test) |

Maintain: invite code rotation procedure (env change + rollout note), active-Owner count alert (<2 → page), password-login audit on failures.

## 4. Admin profile — maintain as provisioned identity

**Lives in:** `User` row (`role="Admin"`). No extension doc. **No public signup exists** — provisioning is out-of-band/Owner-only (keep it that way; `POST /signup {role:Admin}` must 403 — test it).

| Field | Allowed writer | Notes |
|---|---|---|
| Everything | Owner-driven provisioning + self `PUT /me` (name/email) + password set | Same field rules as Owner |
| `status` | Owner/admin action + audit | Blocked admin loses HTTP + socket immediately (resolver) |

Maintain: leavers checklist (Block → verify 401s → delete), periodic access review (who holds Admin and why), full-PII endpoints (`kyc/:id/full`) access-log review.

---

## 5. Cross-role maintenance jobs (schedule these)

| Job | Cadence | What |
|---|---|---|
| Orphan sweep | daily | `TechnicianKYC` without Profile, `TempUser`/`Otp` past TTL (TTL covers most — alert on growth), `LocationHistory` TTL lag |
| Mirror-drift check | daily until mirrors deleted | Profile wallet/bank/fcm vs ledger/KYC/DeviceToken — alert on divergence |
| Dead-skill prune | weekly | `skills.serviceId` pointing at inactive/deleted Services → report, then prune |
| Default-address repair | weekly | customers with zero default → promote newest |
| Consent backfill audit | monthly | rows with `terms=false` but active usage → investigate (never auto-set) |
| Admin access review | monthly | Admin/Owner roster + last login + justification |
| `zoneMismatch` aging | daily | techs mismatched >N days → ops follow-up (wrong registered zone vs drifting worker) |

---

## 6. What changed vs the old docs (no duplication)

- `docs/User-Profile-Roles-How-It-Works.md` = role model + auth flows (how it *works*).
- `docs/Technician-Profile-Location-Performance.md` = field reference + location query performance (how it *performs*).
- **This document** = who may write what + validation + lifecycle + scheduled jobs (how to *maintain* it). If a rule appears here and in code behavior differs, the code is the bug — file it against the owning module (M1 identity, M2 technician, M5 address).
