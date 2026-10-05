# REWRITE READINESS REPORT — Authentication & Profile System (RightTouch)

> **Phase: DISCOVERY ONLY. No code was modified, deleted, renamed, or migrated to produce this report.**
> All findings traced from the actual source (post-restructure paths `modules/<domain>/…`, `shared/…`).
> Anything not verifiable in code is marked **UNKNOWN** with the exact file/behavior to inspect.
> Default rule applied throughout: **preserve the external API contract**; rewrite internals only.

**Contract legend used in §2:** `PRESERVE` = byte-level request/response behavior unchanged.
`PRESERVE+` = contract unchanged, optional additive fields/behavior allowed.
`BREAKING` = change requires a documented security/correctness reason + migration plan (never for cleanliness).

---

## 1) Current Architecture

```text
Client (mobile apps per role; no frontend code in repo)
  │  HTTP: Bearer JWT · Socket: handshake.auth.token
  ▼
Routes  modules/identity/routes/User.js (/api/user)
        modules/technician/routes/technician.js (/api/technician)
        modules/technician/routes/adminKycRoutes.js + adminSkillRequestRoutes.js (/api/admin)
        modules/notifications/routes/deviceRoutes.js (/api/*/device-token)
  │  express-rate-limit (authLimiter 100/15m, otpLimiter 10/60s, kycAdminLimiter 120/15m,
  │  locationLimiter 12/60s, global 1000/15m) + multer (images) + NoSQL sanitizer
  ▼
Middleware  shared/middleware/Auth.js (Auth + authorizeRoles)
            shared/middleware/resolveAuth.js (resolveAuthSubject — SOLE policy point for HTTP+socket)
            shared/middleware/isTechnician.js · ensureCustomer.js · socketAuth.js · socketRateLimiter.js
            shared/utils/ensureCustomer.js + ensureTechnician.js (throw-helpers for controllers)
  ▼
Controllers  modules/identity/controllers/User.js (ok/fail envelopes) + accountController.js
             modules/technician/controllers/technician.js (god-controller) + technicianKycController.js
             + technicianSkillRequestController.js · geo permissionService (device tokens)
  ▼
Services  modules/identity/services/authService.js (OTP/signup/login/password/terms/debug)
          + accountService.js (delete cascade) + profileService.js (get/complete/update/list)
          modules/technician/services/* · geo districtService/technicianDistrictService
  ▼
Models  identity: User · Otp · TempUser
        technician: TechnicianProfile · TechnicianKYC · TechnicianSkillRequest · TechnicianLocationHistory
        notifications: DeviceToken (+ fcmTokens[] mirrors on User and TechnicianProfile)
  ▼
External  Fast2SMS (OTP SMS) · FCM (push) · Cloudinary (images/docs) · KMS envelope (KYC/bank crypto)
          + RazorpayX fund-account invalidation on bank change
```

No `AuthSession`/refresh-token model exists (verified: no such model file; only `tokenVersion` compat
wiring in `resolveAuth.js:83-93` and `SESSION_REVOKED` socket event name). No logout endpoint exists
(verified: zero `/logout|/signout` routes; only device-token unregister + socket single-session kick).
Sessions are stateless HS256 JWTs, 7d default (`identity/utils/token.js:19`), validated per request
against live DB status.

---

## 2) Existing Endpoint Contract (inventory + classification)

Mounts: `User.js → /api/user`, `technician.js → /api/technician`, `adminKycRoutes + adminSkillRequestRoutes → /api/admin`, `deviceRoutes → /api/*/device-token` (`index.js:620-659`).

### 2A. Identity auth endpoints (all roles share these handlers)

| # | Method + path | Guards | Handler → service | Contract decision |
|---|---|---|---|---|
| 1 | `POST /api/user/signup` | authLimiter | `signupAndSendOtp` (`controllers/User.js:109`) → `signupAndSendOtpInternal` (`authService.js:36`) | PRESERVE (except Admin role value — see BREAKING-1) |
| 2 | `POST /api/user/signup/customer` | authLimiter, role forced `Customer` | same | PRESERVE |
| 3 | `POST /api/user/signup/customer/verify-otp` | authLimiter | `verifyOtp` (`User.js:151`) → `verifyOtpInternal` (`authService.js:254`) | PRESERVE |
| 4 | `POST /api/user/verify-otp` | authLimiter | same `verifyOtp` | PRESERVE |
| 5 | `POST /api/user/login` | authLimiter | `login` (`User.js:196`) → `loginInternal` (`authService.js:498`) | PRESERVE+ (may add optional session fields later) |
| 6 | `POST /api/user/login/customer` | authLimiter, role forced | same | PRESERVE |
| 7 | `POST /api/user/login/customer/verify-otp` | authLimiter | same `verifyOtp` | PRESERVE |
| 8 | `POST /api/user/auth/login/request-otp` | global limiter only | `requestLoginOtp` (`User.js:267`) → same `login` | PRESERVE+ (add route limiter — behavior-preserving tightening) |
| 9 | `POST /api/user/auth/login/verify-otp` | global limiter only | `verifyLoginOtp` (`User.js:271`) → same verify | PRESERVE |
| 10 | `POST /api/user/resend-otp` | otpLimiter | `resendOtp` (`User.js:134`) → `resendOtpInternal` (`authService.js:187`) | PRESERVE (internal: scope by role+purpose — no contract change) |
| 11 | `POST /api/user/set-password` | authLimiter + Auth | `setPassword` (`User.js:178`) → `setPasswordInternal` (`authService.js:458`) | PRESERVE |
| 12 | `POST /api/user/auth/accept-terms` | Auth | `acceptTerms` (`User.js:325`) → `acceptTermsInternal` (`authService.js:636`) | PRESERVE |
| 13 | `DELETE /api/user/delete-my-account` | Auth | `deleteMyAccount` (`accountController.js:6`) → `deleteMyAccountInternal` (`accountService.js:19`) | PRESERVE |

**Existing Contract — #1/#2 signup:** req `{identifier|mobileNumber, role, termsAndServices, privacyPolicy, inviteCode?}`.
Customer/Technician require both terms `true` (`authService.js:74-90`); Owner requires
`inviteCode == OWNER_SIGNUP_INVITE_CODE` (`:63-72`); Admin has **no gate** (hole, §10).
Mobile normalized (`normalizeIndianMobile`, `phoneValidation.js:11-27`, requires `/^[6-9]\d{9}$/`).
Live duplicate → `409 {code:MOBILE_ALREADY_EXISTS, details:{identifier, existingRole}}`;
`Deleted` duplicate → anonymized to `deleted_<id>_<ts>` and freed (`:94-116`). Flow:
`TempUser.findOneAndUpdate upsert` → `Otp.deleteMany(SIGNUP)` → CSPRNG OTP
(`crypto.randomInt(1000,10000)`, `bcrypt(10)`, `expiresAt +5m`) → `sendSms` (Fast2SMS).
Resp `200 {success:true, message:"OTP sent successfully", result:{identifier, role, purpose:"SIGNUP", expiresInSeconds:300}}`.
**Recommended Internal Implementation:** identical contract; move to repository layer
(`OtpRepo.issueScoped{identifier,role,purpose}`), add `clientRequestId` optional dedupe (PRESERVE+),
keep last-write-wins semantics (document it).

**Existing Contract — #3/#4/#7 verify:** req `{identifier|mobileNumber, otp, role?}` (**role ignored**;
record's role wins — `authService.js:264-271` queries identifier-only).
`attempts>=5` → `429 OTP_TOO_MANY_ATTEMPTS`; wrong → `400 OTP_INVALID {attemptsRemaining}` + `$inc`;
expired/used/absent → `400 OTP_INVALID_OR_EXPIRED`. SIGNUP: `TempUser` lookup → **transaction**
`User.create + TechnicianProfile.create (iff Technician) + TempUser.deleteOne + Otp.deleteMany`
(`:308-345`) → `signToken` → controller returns **201** `"Account created successfully"` when
`profileComplete===false && !lastLoginAt` else **200** `"Login successful"` (`User.js:158-164`),
`result:{token, user:{_id,fname,lname,mobileNumber,email,role,profileComplete}, technicianProfileId|null}`.
LOGIN: Owner/Admin → `403 PASSWORD_ONLY_LOGIN`; `User.findOne({mobileNumber,role})` → Deleted/Blocked → 403;
tech `workStatus deleted` → 403; `lastLoginAt=now` + `Otp.deleteOne` → token → **200**.
**Recommended Internal Implementation:** identical contract + statuses; internally scope OTP lookup by
`{identifier, role, purpose}` (fixes cross-purpose acceptance without changing any accepted request —
all current clients already send the matching triple; only mismatched triples newly 400, which is the
security fix), atomic consume (`findOneAndUpdate verified:false→true`) for concurrent verifies.

**Existing Contract — #5/#6/#8 login:** req `{identifier|mobileNumber, role?, password?}`.
`User.findOne({mobileNumber}).select(+password role status)` → 404 `USER_NOT_FOUND`;
role mismatch → `403 ROLE_MISMATCH {registeredRole, requestedRole}`; Blocked/Deleted → 403.
Customer/Technician: wipe old LOGIN OTPs → new OTP+SMS → `200 "OTP sent successfully"
{identifier, role, purpose:"LOGIN", expiresInSeconds:300}`. Owner/Admin (privileged flag or stored
role): no password set → 400; no password sent → 400; bcrypt mismatch → `401 INVALID_CREDENTIALS`;
→ `200 "Login successful" {token, userId, role}` (`User.js:210-216`).
**Recommended Internal Implementation:** identical contract. PRESERVE+ later: same `token` field keeps
meaning *Access Token*; refresh travels via HttpOnly cookie (web) or optional `refresh_token` response
field (mobile) — §14. Internal: stop echoing `registeredRole` (enumeration oracle → generic message;
response shape `{code, details}` stays, value generalized — PRESERVE+).

**Existing Contract — #10 resend:** req `{identifier|mobileNumber}` (role/purpose inherited from last OTP row).
60 s DB-`createdAt` cooldown → `429 OTP_COOLDOWN`; Owner non-SIGNUP → 403; wipe same triple → new OTP+SMS
→ `200 {identifier, role, purpose, expiresInSeconds:300, cooldownSeconds:60}`.
No prior row → `404 OTP_NOT_FOUND`. **Recommended:** identical; internal cooldown key becomes
`(identifier,role,purpose)` — same client-visible behavior.

**Existing Contract — #11 set-password:** `Auth` + req `{password}` (min 8, bcrypt-10 save).
`200 "Password set successfully"`. No role/old-password check. **Recommended:** identical contract;
internally require recent OTP-proof for Owner/Admin first-time set (reject only proof-less *Admin*
sets after the Admin-hole closure; Customer calls are already meaningless-but-harmless and stay 200).

**Existing Contract — #13 self-delete:** no body. Transaction: Owner-quorum check
(`400` if last active Owner) → `Address.deleteMany ×2` → tech snapshot/profile/KYC cleanup →
`Otp/TempUser` purge → `User.deleteOne` (`accountService.js:28-87`). `200 "Account deleted successfully"`.
Post-delete tokens die at `Auth` (`401/403`). **Recommended:** identical; internally switch to
soft-anonymize + `tokenVersion++` + socket kick (clients see same 200; subsequent calls same 401/403).

### 2B. Identity profile endpoints

| # | Method + path | Guards | Handler → service | Decision |
|---|---|---|---|---|
| 14 | `GET /api/user/me` | Auth | `getMyProfile` (`User.js:279`) → `getMyProfileInternal` (`profileService.js:69`) | PRESERVE |
| 15 | `POST /api/user/complete-profile` | Auth | `completeProfile` (`User.js:294`) → `completeProfileInternal` (`profileService.js:134`) | PRESERVE |
| 16 | `PUT /api/user/me` | Auth | `updateMyProfile` (`User.js:309`) → `updateMyProfileInternal` (`profileService.js:213`) | PRESERVE |
| 17 | `GET /api/user/debug/check-user/:identifier` | Auth + Owner/Admin | `checkUserByIdentifier` → `checkUserByIdentifierInternal` (`authService.js:680`) | PRESERVE |
| 18 | `GET /api/user/users/:role` | Auth + Admin/Owner | `getAllUsers` → `getAllUsersInternal` (`profileService.js:377`) | PRESERVE+ (add optional `page/limit`, defaults preserve current full-list shape) |
| 19 | `GET /api/user/users/:role/:id` | Auth + Admin/Owner | `getUserById` → `getUserByIdInternal` (`profileService.js:713`) | PRESERVE |
| 20 | `DELETE /api/user/users/:id` | Auth + **Owner only** | `deleteUserById` → `deleteUserByIdInternal` (`accountService.js:117`) | PRESERVE |

**Existing Contract — #14:** no input. Customer/Owner/Admin: `User.findById.select(-password)` →
`200 "Profile fetched successfully" {<full user doc>}`. Technician: Profile+populate → KYC narrow select →
KMS-decrypt bank → derived flags (`kycVerified/isBankVerified/trainingCompleted/isActiveTechnician`).
404/401 as usual. **Recommended:** identical response; internally split hot fields (name/status) from
sensitive bank (on-demand sub-resource later — additive, current shape kept).

**Existing Contract — #15/#16:** allow-listed writes (Customer: `fname/lname/gender/email`;
Technician adds address/city/state/pincode/lat/lng/locality/experienceYears/specialization + bank branch
with full regex/dup-hash/normalize/encrypt pipeline, `403 BANK_EDIT_BLOCKED` when verified).
`complete-profile` forces `profileComplete:true` unchecked; `PUT /me` sets it iff fname+mobile present and
forbids `password/status/userId/profileComplete`. Both `200` + updated doc (no password).
**Recommended:** identical contracts; internally unify into one `computeProfileComplete()` and one bank
service (response bytes unchanged).

### 2C. Technician auth/profile endpoints (`/api/technician`)

| # | Method + path | Guards | Handler | Decision |
|---|---|---|---|---|
| 21 | `POST /signup/technician` | authLimiter, role forced | `signupAndSendOtp` | PRESERVE |
| 22 | `POST /signup/technician/verify-otp` | authLimiter | `verifyOtp` | PRESERVE |
| 23 | `POST /login/technician` | (none at route) | `technicianLogin` (forces role) → `login` | PRESERVE+ (add limiter — no contract change) |
| 24 | `POST /login/technician/verify-otp` | (none at route) | `verifyTechnicianOtp` → `verifyOtp` | PRESERVE |
| 25 | `POST /technicianData` | Auth | `createTechnician` (`technician.js:922`) — GPS district/zone resolve, mapping skill gate, server-computed `profileComplete`, User name update, district-permission auto-grant | PRESERVE |
| 26 | `GET /technician/me` | Auth | `getMyTechnician` (+activation enrich, offline-enforce on copy) | PRESERVE |
| 27 | `PUT /updateTechnician` | Auth | `updateTechnician` (txn; online-gate; rebroadcast/offline side-effects) | PRESERVE |
| 28 | `PUT /technician/skills/add` / `/remove` | Auth + isTechnician | zone-restricted add gate / `$pull` remove | PRESERVE |
| 29 | `PUT /technician/status` | Auth (Owner-only inside) | `updateTechnicianStatus` | PRESERVE |
| 30 | `PUT /:technicianId/training` | Auth (Owner-only inside) | `updateTechnicianTraining` + socket revoke when unset | PRESERVE |
| 31 | `POST /technician/profile-image` | Auth + isTechnician + multer single | `uploadProfileImage` | PRESERVE |
| 32 | `DELETE /technicianDelete/:id` | Auth (Owner-or-self inside) | txn: booking snapshot → KYC delete → User anonymize → Profile hard-delete | PRESERVE |
| 33 | `PUT /location` | Auth + isTechnician + locationLimiter 12/m | `updateTechnicianLocation` → `handleLocationUpdate` | PRESERVE |
| 34 | `PUT /fcm-token` | Auth + isTechnician | `registerTechnicianFcmToken` (dedupe, cap 5) | PRESERVE |
| 35 | `GET /registration/districts`, `/districts` | **none (public)** | `getRegistrationDistricts` | PRESERVE |
| 36 | `GET /registration/zones`, `/zones` | **none (public)** | `getRegistrationZones` | PRESERVE |
| 37 | `POST /registration/validate-location` | **none (public)** | `validateRegistrationLocation` | PRESERVE |
| 38 | `GET /registration/zone-services` (public) + `GET /zone-services` (Auth+isTechnician) | mixed | `getZoneServicesForTechnician` (annotated availability+skill status) | PRESERVE |
| 39 | `POST /skill-requests` / `GET /skill-requests` | Auth + isTechnician | submit (dup-pending guard) / list mine | PRESERVE |
| 40 | `GET /zone/me` / `GET /zone/services` | Auth + isTechnician | `getMyZone` / `getServicesInMyZone` | PRESERVE |
| 41 | KYC: `POST /kyc`+`/technician/kyc`, `POST /banks`+`/technician/banks`+`/kyc/bank-details`+`/technician/kyc/bank-details`, `POST /kyc/upload`+`/technician/kyc/upload`, `GET /kyc/me`+`/technician/kyc/me` | Auth + isTechnician | `submitTechnicianKyc`, `submitTechnicianBankDetails`, `uploadTechnicianKycDocuments` (any doc change resets status→pending), `getMyTechnicianKyc` (+eligibility) | PRESERVE (aliases kept; canonicalize internally) |
| 42 | KYC admin reads/verify/delete/orphans (`GET /kyc`, `/kyc/:id[/full]`, `PUT /kyc/verify`, `PUT /kyc/bank/verify`, `DELETE /deletekyc/:id`, orphan list/cleanup) | Auth only + **in-controller** `isOwnerOrAdmin` | `technicianKycController` fns | **BREAKING-2**: add `authorizeRoles` at route (same as canonical `/api/admin` twins) — non-privileged 200s become 403s (security reason; affected: any non-admin client calling these — must use admin app) |
| 43 | `GET /technicianAll`, `GET /technicianById/:id`, job-history reads, `GET /admin/jobs/history` | Auth only | technicians lists | **BREAKING-2** (same reason) |
| 44 | Admin: `GET /technician-skill-requests`, `PUT /technician-skill-requests/:requestId/review` | Auth+authorizeRoles per `adminSkillRequestRoutes` (guard presence verified at router; exact roles UNKNOWN — verify `adminSkillRequestRoutes.js` before implementation) | skill request review (approve pushes skill + auto-enables mapping + notify; reject + audit) | PRESERVE |

### 2D. Owner endpoints (`/api/user`)

| # | Method + path | Guards | Handler | Decision |
|---|---|---|---|---|
| 45 | `POST /owner/signup` | authLimiter, role forced Owner | `signupAndSendOtp` (invite-gated in service) | PRESERVE |
| 46 | `POST /owner/verify-otp` | authLimiter | `verifyOtp` (role-forcing commented out; record role wins) | PRESERVE |
| 47 | `POST /owner/set-password` | authLimiter + Auth | `setPassword` | PRESERVE |
| 48 | `POST /owner/login` + `POST /login/owner` | authLimiter | `ownerLogin` (privileged) | PRESERVE |

### 2E. Admin endpoints (provisioning hole + admin surface)

- **No** `/admin/signup`, `/signup/admin`, `/admin/set-password`, `/login/admin` route exists (full
  `routes/User.js` + `technician.js` scan); no create-admin script found (only zone seeds) → official
  bootstrap is **UNKNOWN (presumed out-of-band DB insert)**.
- **BREAKING-1 (security, REQUIRED): generic `POST /api/user/signup` accepts `role:"Admin"`**
  (`routes/User.js:179` passes client role; `controllers/User.js:112-119` forwards it;
  `authService.js:54-60` only null-checks; no invite/terms gate for Admin unlike Owner `:63-72` and
  Customer/Tech `:74-90`; `verifyOtpInternal` SIGNUP branch `:311-325` creates the Admin unconditionally).
  An unauthenticated caller sending `{identifier, role:"Admin"}` receives an **Active Admin + JWT**.
  Fix = reject `Admin` (and any future privileged role) on public signup → `403`. Affected clients:
  none legitimate (no admin app signs up via this path — verify against mobile builds before deploy).
  Migration: Owner-only `POST /api/admin/users` provisioning endpoint (new, additive) + one-time DB seed
  for the first Owner/Admin; compat layer not needed (no legitimate traffic to preserve).
- Admin login = generic `POST /login` password branch (auto-selected by stored role, `authService.js:543`)
  or privileged owner endpoints (which also accept Admin, `:544`). PRESERVE.
- Admin profile/self-delete = same handlers as Owner; note self-delete has **no Admin safeguard**
  (Owner-quorum only) — PRESERVE contract; internally keep (documented behavior).

### 2F. Device-token endpoints

`POST /` + `DELETE /` on `/api/user/device-token`, `/api/technician/device-token` (Auth) via
`deviceRoutes.makeDeviceRouter` → `permissionService.register/unregisterDeviceToken`
(DeviceToken upsert/deactivate + legacy `fcmTokens` mirror sync). PRESERVE contract; CHANGE internals
to write DeviceToken only (mirror sync removed after migration, §16).

## 3) Current Request/Response Inventory (compatibility contract)

**Envelopes** (must be preserved byte-for-byte):
- Identity controllers: success `{success:true, message, result}` (`controllers/User.js:24-29`);
  failure `{success:false, message, code, details}` (`:31-37`, `details` sometimes `undefined` — preserved as-is).
- Middleware denials (Auth/authorizeRoles/isTechnician/ensureCustomer-mw): `{success:false, message, result:{}}`
  (no `code`). Admin/user controllers: `{success:false, message, result:{}}` or `{result:{error}}`.
  Inconsistency between the two failure shapes is **preserved** (clients parse both); standardize only
  internally for new code paths without touching existing responses.
- Success messages are per-endpoint strings (`"OTP sent successfully"`, `"Login successful"`,
  `"Account created successfully"`, `"Profile fetched successfully"`, …) — clients match on some;
  preserve all existing strings; new messages only for new endpoints.
- `result` is `{}` by default on `ok()`; `technicianProfileId:null` present on Customer payloads (keep the key).
- Null behavior: missing names serialize as `""` in auth payloads (`fname: user.fname || ""`); KYC-gated
  reads return explicit `null` sub-objects. Preserve null-vs-absent per endpoint.
- Pagination: `getAllUsers` and most admin lists are **unpaginated** (full arrays, `$sort createdAt:-1`).
  `getMyRatings`-style cursor work and skill-request `page/limit≤100` exist elsewhere. Rule: add optional
  `page/limit` whose defaults reproduce current output (PRESERVE+), never mandatory pagination.
- Status codes in use: 200/201 (signup-vs-login heuristic, `User.js:158-164`), 400, 401, 403, 404, 429, 500.
  No 422/409-beyond-duplicate in this surface (duplicate-mobile is 409). Keep the exact code per endpoint.

## 4) Current Authentication Flow Per Role

**Customer (OTP-only).** `POST /signup/customer` (terms-gated) → SIGNUP OTP+SMS → `POST /verify-otp`
→ TXN `User.create(role=Customer)` → 201 + JWT `{userId, role}`. Login: `POST /login/customer` →
`User.findOne` → role-match check → LOGIN OTP+SMS → `POST /verify-otp` → `lastLoginAt=now`, row consumed →
200 + JWT. Owner/Admin OTP attempts on a Customer number fail at role-mismatch (403); Customer OTP on
Owner/Admin numbers fails at `PASSWORD_ONLY_LOGIN`. Full trace: §2A endpoints #1–#10.
**Technician (OTP-only + profile + workStatus gate).** Same rails with `role=Technician` forced at
technician routes (`technician.js:87-119`): signup-verify creates `User` **and** pending
`TechnicianProfile` in one TXN (`authService.js:328-340`), JWT carries `technicianProfileId`, and both
login entry (`:588-596`) and login-verify (`:409-417`) refuse `workStatus: deleted` (403). `suspended`
techs CAN complete login — suspension bites only at request gates (§8/`resolveAuth`). Then onboarding →
KYC → training → approval → online. Full trace: §2C #21–#24 + technician-report §10–13.
**Owner (invite-gated signup + password).** `POST /owner/signup` (+`inviteCode`, no terms check) →
SIGNUP OTP → `POST /owner/verify-otp` (role-force commented out; record role wins) → `User.create`
→ `POST /owner/set-password` (Auth, min-8, no proof) → `POST /owner/login` or `/login/owner`
(privileged) → bcrypt verify → 200 `PASSWORD_LOGIN {token, userId, role}`. OTP-login permanently refused
(`403 PASSWORD_ONLY_LOGIN`). `Inactive` Owner passes login but 403s on every `Auth` call (gap, §10).
**Admin (no signup; password).** No creation/login endpoints of its own: created today via the **public
generic signup hole** (`POST /signup {role:"Admin"}` → Active Admin + JWT, §2E) or UNKNOWN out-of-band
seeding; sets password via generic `set-password`; logs in via generic `/login` (auto password branch)
or the owner privileged endpoints (which accept Admin). `PUT /me`, `/me`, self-delete shared with Owner
(no Admin leaver safeguard). All admin capability flows through `authorizeRoles("Admin","Owner")` —
except the §2C-42/43 twins reachable under bare `Auth` (BREAKING-2).

## 5) Current Profile Flow Per Role

**Customer.** Read: `GET /me` → single `User.findById(-password)` → full doc. Complete: `POST
/complete-profile` → allow-list write, forces `profileComplete:true` unchecked. Update: `PUT /me` →
allow-list + forbidden-set, `profileComplete` iff fname+mobile present. Consent: `POST /auth/accept-terms`
patches flags+timestamps. Addresses: `Address.customerId = req.user.userId` (never body), full CRUD +
default promotion; wiped on self-delete cascade. Delete: `DELETE /delete-my-account` (Owner-quorum
guarded) → hard-deletes User+addresses+OTP/TempUser rows.
**Technician.** Read: `GET /technician/me` (populated profile + activation enrich + response-copy offline
enforce) and `GET /me` (same enriched shape via profileService + KMS bank decrypt). Write paths (three
contracts, one domain): `POST /technicianData` (full onboarding: GPS resolve → district/zone + mapping
skill gate → computed `profileComplete` → User+Profile writes → district auto-grant), `PUT
/updateTechnician` (txn; online-gate; rebroadcast/offline side-effects; zone reassignment), and
`/complete-profile`+`/me` (allow-list + location rebuild + bank pipeline; bank rules: verified-lock,
regex, hash-dedupe, normalize, encrypt, reset-to-pending + 30-day window). Registration reads are public
(districts/zones/validate/zone-services); skills via direct add/remove (zone-gated) or SkillRequest →
admin review → push + mapping auto-enable + notify. KYC: submit/upload/me (self, masked+signed) →
admin verify/bank-verify (training-gated, audited) → approved/suspended transitions + socket revoke.
Location: `PUT /location` (12/min) + socket pings → `handleLocationUpdate` (distance gate, freshness stamp,
Redis GEO, district/zone resolve, history TTL insert, mismatch flips, revalidation, 30 s match throttle).
FCM: `PUT /fcm-token` (dedupe, cap 5) + `DeviceToken` mounts. Delete: Owner-or-self txn (booking snapshot
→ KYC delete → User anonymize → Profile hard-delete).
**Owner/Admin.** Same three endpoints as Customer (`/me`, `complete-profile`, `PUT /me`) with identical
allow-lists; difference is capability (debug lookup, user lists, Owner-only delete, whole admin surface).
No separate profile store; no KYC/bank/location concepts.

## 6) Current Session/Token Architecture

- **Issue**: `signToken` (`identity/utils/token.js:21-27`) — HS256 pinned, `JWT_SECRET`,
  `expiresIn = JWT_EXPIRES_IN || "7d"`, optional `iss/aud`. Payloads: Customer `{userId, role}` (+`technicianProfileId:null`
  on OTP-login); Technician adds real `technicianProfileId`; Owner/Admin `{userId, role}`.
- **Validate**: `verifyTokenOptions()` (`:29-34`) — `algorithms:[HS256]`, `ignoreExpiration:false`.
  Missing `JWT_SECRET` fails closed in prod (`secretValidation.validateSecrets`, `index.js:716`) + load-time
  warning in `Auth.js:5-9`.
- **Per-request resolution** (HTTP `Auth.js:11-40` → `resolveAuth.js:34-137`; socket `socketAuth.js:14-75`
  → same resolver): `User.findById.select(status role tokenVersion).lean()` → Deleted/Blocked/Inactive → 403;
  token-role vs DB-role mismatch → `403 SESSION_ROLE_MISMATCH` (DB wins downstream); `tokenVersion`
  enforced only if both sides carry it (**currently inert**: signer never emits it, `User` schema has no
  such field — verified `models/User.js`); Technician profile resolved **by owner** with self-heal,
  `deleted/suspended` → 403 (socket maps to `Authentication error: Account not found|blocked|suspended`).
- **HTTP vs socket compared**: same resolver, same rules (verified by reading both files) — the historical
  drift (socket checked ownership, HTTP did not) is already unified in-tree. Differences that remain by
  design: socket takes token from `handshake.auth.token` only (no query fallback, no Bearer scheme);
  socket errors are `Error` messages not HTTP statuses; socket has handshake limiter + single-session kick.
- **Revocation today**: none effective. No `AuthSession`/refresh model (verified absent), no logout route
  (verified absent; device-token unregister is the closest), no blacklist. Server-side invalidation paths:
  expiry (7d), `Blocked/Deleted/Inactive` status (next request), hard-delete (next request). Password change
  does **not** revoke existing tokens. Role change is neutralized going forward (role-equality forces
  re-login) but old tokens remain valid until expiry for unchanged roles.
- **Multi-device**: fully supported implicitly (stateless; socket layer kicks previous socket but REST tokens
  stay valid everywhere). `lastLoginAt` overwritten per login (no per-device tracking).
- **Gmail-like persistent login**: requires short-lived Access + long-lived AuthSession/Refresh (does not
  exist). Auto-logout today = token expiry only (client-side token drop). §14 designs the compatible upgrade.

## 7) Current OTP Architecture

- **Generate**: `generateSecureOtp` (`authService.js:20-22`) — `crypto.randomInt(1000,10000)` (CSPRNG, 4-digit).
- **Store**: `bcrypt.hash(otp, 10)` in `Otp.otp`; row `{identifier, role, purpose, expiresAt:+5m, attempts:0,
  verified:false}` (`authService.js:153-164`); TTL index on `expiresAt` (`Otp.js:42`).
- **Query scoping (gap)**: signup wipes by `{identifier, role, purpose:SIGNUP}` (scoped, good);
  **verify looks up by identifier only** (`authService.js:264-271` — no role/purpose filter), so a valid
  code is accepted for whatever purpose/role its row carries; resend reads last row by identifier only
  (`:196`) then reuses its role/purpose. A Customer code cannot become a Technician code (row role is
  authoritative and login re-checks `User.findOne({mobileNumber, role})`), but cross-purpose acceptance
  within one identifier is possible — fix internally with no contract change (all legitimate clients send
  the matching triple).
- **Consume**: success marks `verified:true` (`:297`); SIGNUP deletes all rows for the triple in-txn;
  LOGIN deletes the single row (`:420`). Consume is read-then-write (not atomic `findOneAndUpdate`) —
  concurrent double-verify can both pass the read (fix: atomic consume, same 200/409 contract).
- **Expiry/deletion**: 5-min `expiresAt` + TTL sweeper; resend/signup wipe siblings (only newest valid);
  `attempts>=5` → `429` until resend (brute-force cap per code, not per IP — route limiters add per-IP).
- **Resend races**: resend `deleteMany`s the triple then creates new; a concurrent verify of the old code
  fails closed (row gone → 400). Cooldown is DB-`createdAt` 60 s per identifier.
- **Rate limits**: route `otpLimiter` 10/60s (resend only), `authLimiter` 100/15m (signup/verify/login);
  unified `/auth/login/*` have no route limiter (global 1000/15m only) — add limiters (no contract change).
- **External**: Fast2SMS (`notifications/utils/sendSMS.js:3-48`, 10 s timeout, DLT sender `RTHUBS`,
  template id `208466` — body text UNKNOWN). SMS send is **outside** transactions (correct: side effects
  never in TXN); failure → `500 SMS_SEND_FAILED` while the OTP row persists (retry via resend — correct).

## 8) Current Authorization Architecture

| Layer | File | Responsibility | Duplication / gap |
|---|---|---|---|
| HTTP gate | `shared/middleware/Auth.js` | Bearer → verify → `resolveAuthSubject` → `req.user` | sole gate — good |
| Policy | `shared/middleware/resolveAuth.js` | status / role-equality / tokenVersion / tech workStatus+ownership | sole policy — good |
| Role check | `authorizeRoles` (`Auth.js:44`) | precomputed case-insensitive set | good |
| Tech check | `shared/middleware/isTechnician.js` | role + profile exists (lean) + ownership + deleted/suspended | good; re-verifies behind Auth (defense in depth) |
| Customer check (mw) | `shared/middleware/ensureCustomer.js` | role + ObjectId | **DUPLICATE, unused by any customer route** (verified imports) — remove after verification |
| Customer check (fn) | `shared/utils/ensureCustomer.js` | same rule, throws | used by cart/address/quotes/productBooking — KEEP as the one |
| Tech check (fn) | `shared/utils/ensureTechnician.js` | role + profileId presence | used by my-jobs/respond — KEEP |
| Ownership | inline per controller | `cart.customerId == req.user`, booking `customerId`, complaint actor, withdrawal `technicianId` | pattern correct where present; **UNKNOWN** inside `Auth`-alone product-booking/payment-retry/rating handlers — must audit before rewrite |
| Admin scoping | `authorizeRoles` at route vs `isOwnerOrAdmin` in-controller (KYC/tech-admin) | two enforcement styles | canonical `/api/admin` twins guarded; `/api/technician` twins rely on in-controller — unify to route-level (BREAKING-2) |
| Devices | `deviceRoutes.makeDeviceRouter(role)` + Auth | role-pinned mounts | good |

**IDOR / privilege-escalation findings (auth/profile surface):**
- F1 (P0, BREAKING-1): public Admin creation via `POST /signup {role:"Admin"}` (§2E). Evidence chain in §2E.
- F2 (P1, BREAKING-2): ~20 tech/KYC admin endpoints reachable under bare `Auth` via `/api/technician`
  (listed §2C-42/43). Any authenticated user can list technicians, read masked KYC, approve KYC/bank,
  delete KYC, change training/status. Fix at route level.
- F3 (P2): `ROLE_MISMATCH` echoes `{registeredRole}` (`authService.js:518-526,544-552`) — user-enumeration
  oracle. Generalize message, keep `{code, details}` shape (PRESERVE+).
- F4 (P2): `debug/check-user` returns full PII + `hasPassword` to any Owner/Admin token — keep endpoint
  (PRESERVE) but confirm audience; consider audit-logging reads (ADD).
- F5 (P2): `PUT /service/:id/polygon` + `POST /payment/retry-settlement` + product-booking/rating
  read/write/delete under bare `Auth` — controller-internal checks UNKNOWN; audit each before rewrite,
  default to adding `authorizeRoles`/ownership checks (behavior change only for abusers).
- No evidence of client-supplied `userId/technicianProfileId/bookingId` trust on auth/profile endpoints
  (all derive from `req.user`); booking/complaint flows re-checked separately in their audits.

## 9) Database and Index Analysis

**Schemas (auth/profile-owned):** `User` (identity; role/mobile unique, status enum, password
`select:false`, consents+timestamps, `fcmTokens[]` mirror, `profileComplete`, `lastLoginAt`),
`TechnicianProfile` (~50 fields: link, photo, GeoJSON `location` 2dsphere, work details, skills[],
training/workStatus, `availability.isOnline`, `fcmTokens[]` mirror, rating, wallet `*Paise` mirrors +
`walletVersion`, RazorpayX ids, payout settings, payout freeze, **plaintext `bankDetails` mirror**,
counters, geo-permission ids ×7, mismatch flags, `dispatchLockUntil`, `isRead` badge),
`TechnicianKYC` (encrypted ids + Cloudinary urls, verification state machine, encrypted bank + hash +
fingerprint, `encryptedDek`), `TechnicianSkillRequest`, `TechnicianLocationHistory` (30-day TTL),
`TempUser` (unique `(identifier,role)`, consent timestamps, **no TTL** — stale rows linger),
`Otp` (identifier/role indexes, TTL on `expiresAt`), `DeviceToken` (`user+device` unique).

**Field source-of-truth map (write × read):**

| Field | Truth | Writers | Readers | Verdict |
|---|---|---|---|---|
| `User.role/mobile/status` | User | signup-verify TXN, admin acts, delete cascade | every gate + login | KEEP; role immutable; add `tokenVersion` (ADD) |
| `User.password` | User | set-password (any authed user — tighten per §2A-11) | privileged login only | KEEP; ADD strength policy + OTP-proof |
| `User.profileComplete` | derived (should be) | 3 divergent writers (forced-true, conditional, txn-create-false) | verify-OTP 201/200 heuristic, matching gate | CHANGE → single `computeProfileComplete()`; heuristic stays byte-identical |
| `User/TechProfile.fcmTokens` | DeviceToken (should be) | permissionService sync, tech register endpoint | push sender (both stores read!) | CHANGE → DeviceToken sole; dual-read compat then REMOVE mirrors |
| `TechProfile.wallet*Paise/version` | WalletTransaction/ledger (should be) | settlement/withdrawal/engine/clawback | wallet/finance reads | CHANGE → read-model; REMOVE writes (M9 plan) |
| `TechProfile.bankDetails` (plain) | TechnicianKYC encrypted (should be) | legacy submit path | payout engine (must switch to KYC) | REMOVE after encrypted backfill |
| `bankVerified/fingerprint/hash` | KYC | verify flows | payout/withdrawal gates | KEEP |
| `workStatus/training/isOnline` | Profile (+KYC verify) | status/training/KYC-verify/availability actions | gates + matching + eligibility | KEEP; all transitions via services |
| `location(+UpdatedAt)` | Profile (ping writer only) | `handleLocationUpdate` | matching/fetch/staleness | KEEP; narrow selects (perf doc) |
| `lastLoginAt` | User | LOGIN-verify + password login | 201/200 heuristic, admin review | KEEP |
| `terms*/privacy*(+At)` | User (+TempUser staging) | signup staging → verify copy; accept-terms | signup gate, audits | KEEP; never backfill |

**Indexes — present:** `User.mobileNumber` unique, `User.role`, `User.email` sparse-unique,
`Otp.{identifier,role}` singles + `expiresAt` TTL, `TempUser(identifier,role)` unique,
`TechnicianProfile.userId` unique + `location` 2dsphere + `locationUpdatedAt` + payout/geo/read composites.
**Missing / to ADD (all additive, background builds):** `Otp(identifier,role,purpose,createdAt desc)`
partial `verified:false` (verify + resend share it); `TempUser.expiresAt` TTL 24h; `User(role,status,createdAt desc)`
(admin lists); `TechnicianKYC.accountNumberHash` unique partial; `TechnicianProfile(workStatus,trainingCompleted,updatedAt)`;
`(bookingId,customerId)` open-complaint dedupe (M12) only if reused here — out of scope otherwise.
**Query hazards:** `getAllUsersInternal` Customer (3 `$lookup`s) + Technician (4 `$lookup`s + per-row sequential
KMS decrypt, **no pagination/limit**) — full-collection fan-out per admin call; fix with pagination defaults
(PRESERVE+) + parallel decrypt + lean selects. `productBookings` lookup uses foreign `userId` while the model
stores `customerId` → returns empty (correctness bug, internal fix, response gains data — PRESERVE+).
`getMyProfileInternal` tech branch = 2 sequential queries + KMS round-trip on every `/me` (split hot vs
sensitive reads internally, same response).

## 10) Internal Problems and Security Issues (ranked, production impact)

- **P0 — Public Admin creation (BREAKING-1).** Unauthenticated → Active Admin + JWT. Evidence §2E.
  Impact: full platform compromise. Fix: reject privileged roles on public signup + Owner-only provisioning
  endpoint + seed. No legitimate-client impact (verify builds first).
- **P0 — Auth-bypass-adjacent: 20 admin endpoints under bare `Auth` (BREAKING-2).** Any login lists
  technicians, reads KYC, approves banks, changes training/status. Evidence §2C-42/43. Fix: route-level
  `authorizeRoles` mirroring `/api/admin` twins.
- **P1 — OTP verify/resend identifier-only scoping.** Cross-purpose acceptance possible; cooldown bypass
  surface. Fix internally (scoped queries + compound index), zero contract change.
- **P1 — Non-atomic OTP consume + non-atomic resend-vs-verify.** Double-submit can double-create
  (backstopped only by mobile unique → raw 11000). Fix: atomic consume + duplicate-key → 409 mapping.
- **P1 — No effective revocation; password change doesn't revoke; no logout.** 7d window of stale access
  after block/delete/password-change (mitigated only by per-request status checks). Fix: AuthSession +
  refresh rotation (§14) + `tokenVersion++` on security events.
- **P1 — Suspended-tech login succeeds** (verify-login checks only `deleted`); enforcement deferred to
  request gates (now present in-tree). && **Inactive gap**: `loginInternal` doesn't check `Inactive`
  → token issued, then every `Auth` 403s. Fix: check `Inactive` at login (same 403, earlier).
- **P2 — Enumeration oracles**: `ROLE_MISMATCH{registeredRole}`, `MOBILE_ALREADY_EXISTS{existingRole}`,
  `check-user` PII+`hasPassword`. Generalize messages (shape kept), audit-log debug reads.
- **P2 — `set-password` for OTP roles + no policy beyond length 8 + no old-password/proof.** Dead credential
  today; becomes live attack surface the moment password-login expands. Fix: proof-gated, Owner/Admin semantics.
- **P2 — Missing limiters** on unified `/auth/login/*`, tech login/verify, skill/KYC self routes rely on
  global only. Add route limiters (no contract change).
- **P2 — `TempUser` never expires; `Otp` plaintext? No — bcrypt (good); `accountNumberHash` not unique
  (dup check is app-level `$or`, racy). Fix: TTL + unique partial.
- **P3 — `completeProfile` forces `profileComplete:true` unchecked; three divergent computations;
  201/200 heuristic depends on the flag.** Unify computation (heuristic output unchanged — verify by test).
- **P3 — PII in responses**: `getAllUsers` ships full docs incl. `fcmTokens`, KYC decrypt outputs, bank data
  to any Owner/Admin token; `check-user` similar. Keep endpoints; add field minimization review + read-audit.

## 11) Duplicate / Legacy Code (remove only after verification + migration)

| Item | Locations | Verdict |
|---|---|---|
| `ensureCustomer` middleware vs util-helper | `shared/middleware/ensureCustomer.js` (unused by all customer routes — verified imports) vs `shared/utils/ensureCustomer.js` (used ×15+) | REMOVE middleware copy; keep helper. Verify: grep shows zero route usage before delete |
| Third inline `ensureCustomer` | was in `quote-product/controllers/productBooking.js:23` | Already consolidated to shared import (in-tree). Verify tests green |
| `isTechnician` vs `authorizeRoles("Technician")` + `ensureTechnician` | middleware + two helpers | KEEP all three (different jobs: hydrated attach vs gate vs controller-throw); document, don't merge |
| Auth vs socketAuth bodies | were ~40 duplicated lines | Already unified behind `resolveAuth.js` (in-tree). Verify socket suite |
| KYC/bank route aliases (`/kyc` ×2, `/banks` ×4, registration doubles, quote aliases) | `technician.js:136-211`, registration `99-111` | KEEP aliases through rewrite; canonicalize + `X-Deprecated` + remove post-client-migration |
| `POST /technicianData` vs `PUT /updateTechnician` vs `/complete-profile`+`/me` | three onboarding/update paths, divergent `profileComplete` | KEEP all three contracts; unify internals behind one profile writer |
| `RESET_PASSWORD` OTP purpose | `Otp.js:35` enum only; zero producers/consumers found | REMOVE enum value only after confirming no client sends it (postman grep + prod log check) |
| `TempUser.tempstatus` Verified/Expired | written? only `Pending` observed in signup path | UNKNOWN — grep writers before removing states |
| `User.fcmTokens`, `TechnicianProfile.fcmTokens/bankDetails/walletBalance`, stored `profileComplete` | mirrors | REMOVE post-migration (dual-read compat first), §16 |
| `GET /carts/:id` + `/cart/removed/:id` ownership-inside aliases | cart routes | out of auth scope but same pattern — keep, test ownership |
| `isEncryptionEnabled`/KMS rotation, FCM pruning paths | comments only | verify implementation before relying on in rewrite |

## 12) Cross-Module Dependencies (who depends on auth/profile behavior)

**Booking/Dispatch** (`booking/controllers/serviceBookController.js` — `technician.profileComplete` gate,
`User` PII snapshot; `technicianBroadcastController.js` — `ensureTechnician`, `technicianProfileId`,
`availability`, `dispatchLockUntil` mutex; `bookAgainController.js` — inline Customer check;
`technicianMatching.js` — `workStatus/availability/location/staleness/skills/permissions/profileComplete`,
`lastJobsChangeAt` bumps; `bookingCron.js` — cursor bumps; `sendReminder.js` — profile+User PII for
push/SMS; outbox workers via `getIo`; `adminDispatchRoutes` — `authorizeRoles`; models ref
`customerId→User`, `technicianId→TechnicianProfile`).
**Notifications/Socket** (`index.js` socket pipeline + `socket.user`; `sendNotification.js` — both
`fcmTokens` stores + `DeviceToken` + dead-token `$pull`; `unifiedNotificationService` — tech rooms;
`deviceRoutes` + `permissionService` mirror sync; inbox scoping by `role/userId/technicianProfileId`;
admin badges + broadcasts; `socketSessionControl/ioAccess/constants/DTO/metrics`).
**Wallet/Finance/Payout** (`technicianWalletController` — balances, payout settings, bank mirrors, KYC gates;
`financeController` — wallet reads; `adminWalletController` — role checks; `withdrawalPayoutEngine` —
RazorpayX ids (NOT profile bank), KYC bank, User names; `autoPayout/settlement/razorpayX` — balances/dues/
versions/bank fields; finance routes role-split).
**KYC** (`technicianKycController` — training/workStatus gates; `adminKycRoutes` guards; `profileService`
bank pipeline; `kycFieldCrypto/kycEncryption/kycPrivacy/kmsClient` envelope + dedupe + fingerprint).
**Permissions/Devices** (`permissionService` — `User+Profile+DeviceToken` triple-sync; role-pinned routers;
admin analytics routes).
**Geo** (`technicianDistrictService` — primary/allowed ids + actor; zone/geofence controllers — grants +
diagnostics + `User.profileComplete`; `zoneAvailabilityController` — self lookups; `servicePolygon/
locationConfig` — location + staleness; zone routes guards; `scripts/migrateZoneArchitecture.js` backfill).
**Cart/Address** (`addressController` + `ensureCustomer`; `cartController` — ownership + User PII snapshot;
`addressService` — User populate + completeness; `resolveUserLocation` — names/phone hydration).
**Quote-Product** (customer-only creation/cancel/accept + ownership scoping; admin `adminId` attribution;
User snapshot for requests/delivery; route role-split).
**Payments** (customer ownership scoping; privileged override + tech context; admin offline/status routes;
settlement wallet credits post-payment).
**Refunds/Complaints** (admin approve/retry/audit + customer hydration; clawback/freeze on profile balances;
role-split routes; `Refund` attribution refs).
**Support/Admin-dashboard** (rating submit/update + `rating.avg` recompute; complaint file/respond/resolve
with actor roles + ownership; product dashboard + audit actor; `userReports`; identity-router catalog/
service/product/report/rating/payment mounts with per-route guards + `req.body.role` forcing; technician
router self-profile/location/FCM/skills + admin list/detail/delete; eligibility/activation/nearby utils).
**Shared/identity core** (`authService` — full OTP/password/consent/JWT surface; `profileService` —
completion + aggregates + write-blocklist; `accountService` — delete cascades + Owner quorum).
Rule for rewrite: no auth/profile field, middleware, token shape, or status semantic changes without
checking this map's consumers first; the map is the blast-radius checklist per phase (§18).

## 13) Keep / Change / Add / Remove Inventory

**KEEP (external behavior/clients depend on):** all endpoint paths + methods (§2 tables); `ok/fail`
envelopes + message strings + `result` shapes (incl. `technicianProfileId:null`, `""`-defaults,
`{code,details}` on failures); 200/201 signup-vs-login heuristic; OTP 4-digit/5-min/5-attempt/60s-cooldown
semantics; `TempUser`+`Otp` staging model; password-login for Owner/Admin; `DELETE` self-delete + Owner delete
semantics; registration public reads; KYC alias paths; device-token paths; `check-user` shape;
`AuthorizeRoles` 401-vs-403 split; socket `handshake.auth.token` + room/event names + ack shapes
(`unchanged`, `throttled`, `retryAfterMs`); postman collections as contract tests input.

**CHANGE (internal, contract-neutral):** scoped OTP queries + atomic consume + duplicate-key→409 mapping;
single `computeProfileComplete()`; single bank/KYC service; single profile writer behind 3 contracts;
`getAllUsers` pagination-defaults + parallel KMS decrypt + lean selects; `productBookings` lookup field
(`userId`→`customerId`); `/me` hot/sensitive read split; route-level `authorizeRoles` on §2C-42/43 twins;
resend/signup OTP lookup scoping; `Inactive` check at login; `ROLE_MISMATCH`/duplicate messages generalized
(shape kept); `ensureCustomer`-middleware removal; alias canonicalization (paths kept).
**ADD (genuinely required):** `User.tokenVersion` + signer emission (activates resolver revocation);
`AuthSession` collection + refresh rotation + logout/revoke endpoints (§14); missing route limiters;
`Otp` compound + `TempUser` TTL + admin-list + KYC-hash + dedupe-partial indexes; read-audit on
`check-user` + `kyc/:id/full`; Owner-only Admin provisioning endpoint + first-seed; `clientRequestId`
optional dedupe on signup/checkout-adjacent writes; auth/security event log + metrics
(`login_success_total`, `otp_issue/verify/fail`, `auth_deny by reason`, Auth p95, suspend/block effects);
set-password strength + OTP-proof; Admin self-delete safeguard (Owner-quorum parity — behavior change,
document as BREAKING-3 minor).
**REMOVE (only after verification+migration):** `shared/middleware/ensureCustomer.js`;
`RESET_PASSWORD` enum (after proof of zero use); `fcmTokens[]` ×2, Profile `bankDetails`/`walletBalance`,
stored `profileComplete` (after dual-read + backfill); plaintext-`Mixed` KYC writes (after encrypt
migration); route aliases (after client migration + deprecation window); `GET /carts/:id`-style redundant
aliases (owning-module decision).

## 14) Backward Compatibility Strategy (incl. persistent login without breaking login)

- **Default stance:** every phase ships behind the existing contract; additive only. Contract tests
  (postman collections + recorded response fixtures) gate each release: any byte-level diff in preserved
  fields fails the build.
- **Persistent login (Gmail-like) without changing login:** keep `POST /login*` request shape and keep the
  `token` response field forever meaning **Access Token** (shorten lifetime only after refresh exists:
  e.g. 7d → 24h → 1h across releases, each announced). Introduce refresh via **both** transports, negotiated
  by client capability (no frontend code in repo — capability UNKNOWN, so support both from day one):
  (a) `HttpOnly; Secure; SameSite` cookie `rt_refresh` (web/browsers; mobile WebViews ignore), and
  (b) optional `refresh_token` (+`expires_in`) fields **added** to the existing login/verify responses
  (PRESERVE+: old parsers ignore unknown fields) for native apps to store in keychain/keystore.
  New endpoints (all additive): `POST /auth/refresh` (cookie or body → rotate pair, reuse-detection =
  revoke chain), `POST /auth/logout` (revoke current session; `POST /auth/logout-all` for password-change/
  block flows). `AuthSession{_id, userId, deviceId?, refreshHash, createdAt, lastUsedAt, expiresAt,
  revokedAt?, replacedBy?}` collection owns revocation; Access JWT stays stateless and short.
- **Compat layers where behavior must change:** BREAKING-1 (Admin signup) needs none (no legitimate traffic —
  verify builds). BREAKING-2 (route guards) needs none (403-for-abusers only) but announce + provide admin-app
  build. Message generalization (F3) keeps `{code,details}` keys. Pagination defaults reproduce full lists
  under a threshold (e.g. ≤200 rows identical; larger sets paginate with `Link`/meta — document threshold).
- **Versioning:** no URL versioning (no evidence clients support it); prefer additive evolution + deprecation
  headers (`X-Deprecated`, Sunset) on aliases.

## 15) Target Production Architecture (monolith, layered, contract-preserving)

```text
Routes (paths + limiters + Auth pipeline only)
  → Validators (NEW: per-endpoint zod/express-validator schemas; reject unknown privileged fields;
     accept everything accepted today — validation parity suite)
  → Controllers (thin: req↔service mapping, ok/fail envelopes — UNCHANGED bytes)
  → Application Services (authService · profileService · accountService · deviceService(NEW, extracted
     from permissionService) · sessionService(NEW: AuthSession issue/rotate/revoke))
  → Domain policies (resolveAuthSubject · isDispatchable/eligibility stays in M2/M6 ·
     passwordPolicy · otpPolicy · roleTransitionPolicy)
  → Repositories (NEW: userRepo · otpRepo(scoped+atomic) · tempUserRepo · profileRepo · kycRepo ·
     deviceRepo · sessionRepo · auditRepo — all query shapes live here, zero business rules)
  → MongoDB (TXN only: signup-verify create, self/owner delete, session-rotate+revoke chains)
  → Outbox/events (signup → admin-unread broadcast already; session revoke → socket kick via
     socketSessionControl; security events → audit + metrics)
  → External (Fast2SMS OUTSIDE txn w/ retry+timeout; FCM best-effort; KMS for KYC/bank; Cloudinary)
Redis: rate-limit buckets + presence/session-kick fan-out when multi-replica (behind flag; single-instance
  behavior identical). No microservices: no evidence in code that auth/profile needs separation; modular
  monolith with the above seams is the target.
```

## 16) Database Migration Plan (additive first, destructive last)

**Additive/safe (background index builds, zero-downtime, rollback = drop):**
1. `Otp` compound `{identifier:1, role:1, purpose:1, createdAt:-1}` partial `verified:false`;
   verify: `explain()` IXSCAN on verify/resend queries + staging traffic shadow.
2. `TempUser.expiresAt` TTL 24h (new writes carry it; old rows age out naturally).
3. `User.tokenVersion: Number default 0` + backfill `{$set: tokenVersion:0}` where missing;
   signer starts emitting it (activates resolver revocation; old tokens pass until rotated — intended).
4. `AuthSession` collection (new; §14 shape) + `{userId, revokedAt}` + `{expiresAt}` TTL + `{refreshHash}` unique.
5. `User(role,status,createdAt desc)`; `TechnicianKYC.accountNumberHash` unique partial;
   open-complaint dedupe partial (M12-owned; listed for awareness).
   Rollback each: drop index / ignore field (code guards `!= null` before enforcing).
**Data backfill required:** tokenVersion default; `DeviceToken` rows from `User/TechProfile.fcmTokens`
(dedupe by value, attribute `userId` via owner lookup — dry-run counts first); KYC plaintext→encrypted
re-wrap (KMS data-key rotation ceremony, per-doc, resumable cursor).
**Destructive (only after dual-read compat + verification queries show zero legacy reads):**
D1. Remove `User.fcmTokens` + `TechnicianProfile.fcmTokens` writes (reads already DeviceToken-only);
   verify: 7d with `fcm_legacy_read_total == 0`. Rollback: re-add field (data re-seeded from DeviceToken).
D2. Remove `TechnicianProfile.bankDetails` mirror + `walletBalance` rupee mirror (M9 ledger plan);
   verify: payout engine reads KYC-only in prod for 7d.
D3. Remove stored `profileComplete` (replace with virtual + persisted cache column if hot-path needs it).
D4. Remove `RESET_PASSWORD` enum + dead aliases (post-client-migration + deprecation window).
D5. Drop `ensureCustomer`-middleware file (no imports — grep gate in CI).
Each destructive step: forward migration script (`scripts/migrate-auth-<n>.js --dry-run` first),
backup snapshot, rollback = restore + redeploy prior image, verification query listed per step in §18.

## 17) Testing and Verification Plan

- **Contract tests (compatibility gate):** replay postman collections
  (`postman/{customer,technician,admin,master}/*.json`) + recorded fixtures for every §2 endpoint;
  assert method/path/status/envelope/message/result-shape byte-equality (allowlist the documented deltas).
- **Unit:** phone normalization, role normalization, password policy, `computeProfileComplete` matrix,
  OTP attempt math, token claims, cooldown math, anonymization format.
- **Integration (DB):** signup-verify TXN commit/rollback (kill mid-TXN); delete cascade; scoped OTP issue/
  consume; session rotate/revoke chains; `TempUser` TTL; compound-index `explain()`.
- **API:** every endpoint × happy + 400/401/403/404/409/429 matrix; role echo absence; pagination defaults;
  alias parity (canonical vs alias identical bytes).
- **AuthN security:** Admin-signup 403; Owner invite bypass attempts; OTP brute-force (5 → 429, then resend
  required); cross-purpose/role OTP acceptance (must 400); forged/expired/tampered JWTs; `alg:none`;
  missing-secret boot behavior; rate-limiter effectiveness per route.
- **AuthZ/IDOR:** customer↔customer (address/cart/quote/booking/payment/rating/complaint), tech↔tech
  (profile/KYC/jobs/wallet), customer→tech-admin reads (must 403 post-BREAKING-2), tech→admin acts,
  Admin→Owner-only delete (403), debug endpoint audience, device-token cross-user register.
- **Concurrency:** 10× parallel same-OTP verifies → exactly one success + rest 409; 5× parallel signups →
  one User + four 409 (no raw 11000 leak); resend-vs-verify race → closed outcome either way;
  refresh-rotate race → single-use rotation + reuse-detection revokes chain; password-change vs active
  sessions → old revoked, new works.
- **Session:** access-expiry enforcement, refresh rotation, reuse detection, logout (single + all),
  block/delete mid-session → next-request denial on HTTP **and** socket disconnect, multi-device independence.
- **OTP:** expiry boundary (5m ± clock), TTL sweeper lag tolerance, SMS-failure → 500 + resendable row,
  cooldown boundary (60 s), attempt-exhaustion + resend recovery.
- **Socket.IO auth:** no-token/query-token/stale-role/suspended/revoked handshakes rejected; `jobs_changed`
  not leaked cross-user (room isolation); single-session kick; `SESSION_REVOKED` handling.
- **DB:** index `explain()` on all hot queries (no COLLSCAN), unbounded-list guard (row caps in tests),
  KMS failure → 503 paths (KYC/bank reads), migration dry-runs + rollback rehearsals.
- **Regression:** full happy paths per role (signup→verify→login→me→update→booking/job flows downstream);
  201-vs-200 heuristic outputs pinned.
- **Load (realistic, measure — never fabricate):** 100 concurrent OTP issues (SMS stubbed) p95; Auth p95 at
  1k rps; socket handshake burst; admin-list with 100k users (paginated).

## 18) Phased Implementation Plan (each phase independently shippable + verifiable)

- **P0 — Freeze & harness (no behavior change).** Commit contract fixtures (record live responses for §2);
  add contract-test runner; add missing route limiters (unified auth, tech login/verify). Accept: fixtures
  green on current code. Rollback: revert.
- **P1 — Close the holes (BREAKING-1 + BREAKING-2 + F5 unknowns audited).** Reject privileged roles on
  public signup; route-level `authorizeRoles` on §2C-42/43 twins (+ audit the `Auth`-alone polygon/retry/
  booking/rating handlers, adding guards/ownership where missing); Owner-only provisioning endpoint + first
  seed. Files: `identity/routes+authService`, `technician/routes/*`, `adminKycRoutes`, target controllers.
  Accept: Admin-signup 403 proof; non-privileged 403 matrix on all twins; builds' smoke tests pass.
  Rollback: redeploy prior image (no schema change).
- **P2 — Harden OTP internals (contract-neutral).** Scoped queries + compound index (background) + atomic
  consume + dup-key→409 mapping + `Inactive` login check + generalized mismatch messages + `TempUser` TTL.
  Accept: storm tests (double-verify/double-signup) exactly-once; cross-purpose 400; explain IXSCAN.
- **P3 — Repository + validator seam (no behavior change).** Extract `userRepo/otpRepo/tempUserRepo/
  profileRepo/kycRepo/deviceRepo` + per-endpoint validators with parity suite (everything accepted today
  still accepted). Accept: parity suite + contract fixtures green; no route logic touched.
- **P4 — Unify profile/bank computation (contract-neutral).** Single `computeProfileComplete()` + single bank
  service behind 3 contracts; `/me` hot/sensitive split; `getAllUsers` pagination-defaults + parallel KMS.
  Accept: byte-identical responses (fixtures), faster p95, KMS call count drop.
- **P5 — Sessions without breaking login (additive).** `User.tokenVersion` + signer emission; `AuthSession`
  collection; `POST /auth/refresh|/logout|/logout-all`; dual cookie+body refresh; `tokenVersion++` on
  password-change/block/delete; socket revoke hookup. Login/signup responses unchanged except optional
  additive `refresh_token/expires_in`. Accept: session matrix (rotate/reuse/logout/multi-device) green;
  old clients unaffected (no refresh usage → same as today, plus revocation now effective).
- **P6 — Token-lifetime tightening (announced).** 7d → 24h (with refresh live + client releases using it),
  later → 1h. Accept: refresh adoption metrics above threshold before each step; rollback = revert env.
- **P7 — Mirror removal (destructive, §16 D1–D3).** Dual-read compat → backfills → stop writes →
  7d zero-legacy-read verification → drop columns. Accept: drift metrics zero throughout; rollback per step.
- **P8 — Alias/dead-code removal (post-migration).** Deprecation headers → client-migration window →
  remove aliases, `ensureCustomer`-middleware file, `RESET_PASSWORD` enum. Accept: zero prod hits on
  deprecated paths for one release.
- **P9 — Observability + final audit.** Security-event log, metrics dashboards, read-audits (check-user,
  full-PII), rate-limit tuning from prod data, final penetration re-test of §10 findings. Accept: all P0–P2
  items verified closed in prod.

## 19) Risks and Rollback Plan

| Risk | Mitigation | Rollback |
|---|---|---|
| Locking out legitimate Admins (P1) | verify mobile builds never hit public signup; seed + provisioning endpoint live first; announce | redeploy prior image (no schema dependency) |
| Over-blocking techs/customers (P1 guards, P2 scoping) | contract fixtures + canary (single replica / internal numbers first) | redeploy; guards are code-only |
| Token-lifetime cut strands old apps (P6) | adoption-gated steps; refresh dual-transport | env revert (lifetime is config) |
| Session tables hot-spot (P5) | TTL + lean writes; rotation is single-doc atomic | feature-flag refresh off → stateless behavior resumes |
| KMS/bank migration corruption (P7) | per-doc resumable cursor; decrypt-verify sampling; backup | restore snapshot + prior image |
| Index builds stall prod (P2/P5) | background builds in low-traffic window; `explain` before/after | drop index |
| Destructive drops (P7/P8) | 7d zero-use proof + backups + dry-runs | restore + redeploy |
| Unknowns (§20-adjacent list in each section) | UNKNOWN-tagged verifications scheduled as P0 tasks before the phase that needs them | — |

## 20) Final Recommended Starting Point

**Start with P0 + P1 together (one release train, two deploy gates):** they are code-only, need no schema
change, and eliminate the two P0s (public Admin creation; 20 unguarded admin endpoints) that make every
later phase unsafe to verify (you cannot trust test results on a system anyone can silently admin).
Concretely, first week: (1) record contract fixtures + add missing limiters (P0); (2) land signup role
rejection + route guards + provisioning endpoint + seed (P1) behind a canary with the 403-matrix suite
green; (3) immediately follow with P2 OTP hardening while the fixtures harness is fresh. Defer everything
session-related (P5/P6) until revocation has a store, and defer all destructive removals (P7/P8) until
dual-read metrics prove zero legacy use. **Can this surface be rewritten now? YES WITH CONDITIONS:**
P0-harness first, P1-holes closed before any other behavior change, contract fixtures gating every phase,
and each UNKNOWN above resolved in the phase that depends on it — with the dependency map (§12) as the
per-phase blast-radius checklist.



