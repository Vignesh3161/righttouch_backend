# Role Profiles & Authentication — Technical Flow Reference

> How each role's profile works and how authentication works in this codebase,
> traced function-by-function through the real code. Paths below are post-restructure
> (`modules/<domain>/…`, `shared/middleware/…`).

---

## 1. Identity model (the foundation everything hangs off)

**One collection for all roles** — `modules/identity/models/User.js`:

- `role: Customer | Technician | Owner | Admin` (required, indexed). Immutable in practice.
- `mobileNumber` unique globally → **one mobile number = one role**. A person cannot hold two roles on one number.
- `password` (`select:false`, optional) — only Owner/Admin ever use it.
- `status: Active | Inactive | Blocked | Deleted` — gates in `shared/middleware/resolveAuth.js`.
- `profileComplete`, `lastLoginAt`, `fcmTokens[]`, `termsAndServices/privacyPolicy (+At)`, timestamps.

**Extension rule:**

| Role | Where its profile lives |
|---|---|
| Customer | `User` row only (`fname/lname/gender/email`); addresses in `cart-address/models/Address.js` |
| Technician | `User` row (name/phone) + `technician/models/TechnicianProfile.js` (`userId` unique → User) + `technician/models/TechnicianKYC.js` (`technicianId` unique → Profile) |
| Owner / Admin | `User` row only |

**Staging collections** (exist only between signup and verify): `identity/models/TempUser.js` (`identifier+role` unique, `tempstatus`, consent timestamps) and `identity/models/Otp.js` (`identifier/role/otp`-bcrypt-hash/`expiresAt` 5-min/`attempts`/`verified`/`purpose: SIGNUP|LOGIN|RESET_PASSWORD`).

---

## 2. Per-role authentication flows (exact code paths)

### 2.1 Customer — OTP only

```text
POST /api/user/signup/customer {identifier, termsAndServices:true, privacyPolicy:true}
  → Routes: modules/identity/routes/User.js (forces req.body.role="Customer")
  → Controllers: modules/identity/controllers/User.js → signupAndSendOtp
  → Services: modules/identity/services/authService.js → signupAndSendOtpInternal (:36)
      1. normalizeIndianMobile() → 400 INVALID_MOBILE_NUMBER if bad
      2. terms/privacy must be true → 400 TERMS_OR_PRIVACY_NOT_ACCEPTED
      3. User.findOne({mobileNumber}) → live user? 409 MOBILE_ALREADY_EXISTS
         (Deleted user? anonymize to deleted_<id>_<ts>, free the number — :94-116)
      4. TempUser upsert {identifier, role} → tempstatus Pending (+consent timestamps)
      5. Otp.deleteMany({identifier, role, purpose:SIGNUP}) — last-write-wins
      6. CSPRNG 4-digit OTP → bcrypt(10) → Otp.create({expiresAt: now+5m})
      7. sendSms() → throws 500 SMS_SEND_FAILED (OTP row already saved, resend works)
  ← {identifier, role, purpose:SIGNUP, expiresInSeconds:300}

POST /api/user/signup/customer/verify-otp {identifier, otp}
  → verifyOtp → authService.verifyOtpInternal (:254)
      1. find latest Otp {identifier, verified:false, expiresAt>=now} → else 400 OTP_INVALID_OR_EXPIRED
      2. attempts>=5 → 429 OTP_TOO_MANY_ATTEMPTS
      3. bcrypt.compare fail → attempts+1 → 400 OTP_INVALID (+attemptsRemaining)
      4. mark verified:true → purpose SIGNUP → TempUser lookup → else 404 TEMPUSER_NOT_FOUND
      5. MONGO TRANSACTION: User.create({role, mobileNumber, Active, consents})
         + TempUser.deleteOne + Otp.deleteMany → commit (abort → throw, client retries)
      6. signToken({userId, role}) — modules/identity/utils/token.js, HS256, 7d
  ← {token, user:{…}, technicianProfileId:null}

POST /api/user/login/customer {identifier}
  → login → authService.loginInternal (:498)
      1. User.findOne({mobileNumber}).select(+password role status)
      2. not found → 404 USER_NOT_FOUND
      3. requestedRole != user.role → 403 ROLE_MISMATCH (echoes registeredRole)
      4. Blocked/Deleted → 403
      5. role is Customer (not privileged/Owner/Admin) → wipe old LOGIN OTPs
         → new bcrypt OTP + SMS
  ← {type:OTP_SENT, identifier, role, purpose:LOGIN, expiresInSeconds:300}

POST /api/user/login/customer/verify-otp {identifier, otp}
  → verifyOtpInternal → purpose LOGIN branch (:379)
      1. same OTP checks as above
      2. Owner/Admin role → 403 PASSWORD_ONLY_LOGIN (OTP can never log them in)
      3. User.findOne({mobileNumber, role}) → 404; Deleted/Blocked → 403
      4. lastLoginAt=now; Otp.deleteOne (consumed)
      5. signToken({userId, role, technicianProfileId:null})
  ← {token, user:{…}} (200)
```

### 2.2 Technician — OTP only + profile creation + workStatus gate

Identical to Customer except three differences (same files, `role="Technician"`):

1. **Signup routes**: `POST /api/technician/signup/technician` (+`/verify-otp`) in `modules/technician/routes/technician.js`; login via `POST /api/technician/login/technician` → `technicianLogin` wrapper and `/login/technician/verify-otp` → `verifyTechnicianOtp` (thin role-forcing wrappers in `identity/controllers/User.js`).
2. **Verify SIGNUP runs one extra write inside the same transaction** (`authService.js:328-340`): `TechnicianProfile.create({userId, location:null, workStatus:"pending", profileComplete:false})`, then `broadcastAdminUnreadCounts(getIo())` post-commit, and the JWT carries `technicianProfileId` (`token.js` payload `{userId, role, technicianProfileId?}`).
3. **Two `workStatus === "deleted"` gates**: `loginInternal` (`:588-596`) and LOGIN-verify (`:409-417`) both refuse deleted technicians with 403. (`suspended` is NOT refused here — enforced later at request gates, see §4.)

After this, the technician onboards: `POST /technicianData` → `createTechnician` (GPS-validated district/zone + skill-vs-mapping check) → KYC/bank submit → training + admin verify → `workStatus: approved` → go-online → dispatchable.

### 2.3 Owner — invite-gated signup + password login

```text
POST /api/user/owner/signup {identifier, inviteCode}
  → role forced "Owner" → signupAndSendOtpInternal
      → inviteCode must equal OWNER_SIGNUP_INVITE_CODE → else 403 OWNER_INVITE_REQUIRED
      → (no terms check for Owner) → TempUser + SIGNUP OTP as above
POST /api/user/owner/verify-otp → same SIGNUP branch (creates User, no profile)
POST /api/user/owner/set-password {password} (Auth) → setPasswordInternal (:458):
      password>=8 → bcrypt(10) → save (400 VALIDATION_ERROR / 404)
POST /api/user/login/owner | /owner/login {identifier, password}
  → ownerLogin wrapper (privileged=true) → loginInternal privileged branch (:543-585)
      1. user lookup (any stored role) → non-Owner/Admin number on this endpoint → 403
      2. !user.password → 400 PASSWORD_NOT_SET
      3. !password → 400 PASSWORD_REQUIRED
      4. bcrypt.compare fail → 401 INVALID_CREDENTIALS
      5. lastLoginAt=now → signToken({userId, role}) — NO technicianProfileId
  ← {type:PASSWORD_LOGIN, token, userId, role}
```

### 2.4 Admin — no public signup, password login only

- No signup endpoint exists for Admin (only Owner has `/owner/signup`).
- Login goes through the same privileged branch as Owner (`login/owner`-style endpoints with `privileged=true`, or role-based dispatch in `loginInternal` since `normalizedRole === "Admin"` also enters the password branch at `:543`).
- LOGIN-purpose OTP can never authenticate Owner/Admin (`:380-385` → 403 `PASSWORD_ONLY_LOGIN`).
- Capabilities: everything through `authorizeRoles("Admin","Owner")` (lists, KYC verify, zones, payments, refunds, dashboards) — except `DELETE /users/:id`, which is `authorizeRoles("Owner")` only, and `GET /debug/check-user/:identifier`.

### 2.5 Shared OTP utilities (all roles)

- `resendOtpInternal` (`:187`): lookup last OTP **by identifier only** → 404 if none → 60 s cooldown from `createdAt` → 429 `OTP_COOLDOWN` → Owner restricted to SIGNUP purpose → wipe same `(identifier,role,purpose)` → new OTP + SMS. Returns `cooldownSeconds:60`.
- `generateSecureOtp` (`:20`): CSPRNG 4-digit via `crypto.randomInt`.
- `acceptTermsInternal` (`:636`): `POST /auth/accept-terms` (Auth) patches `termsAndServices/privacyPolicy (+At)`; at least one `true` required.
- `checkUserByIdentifierInternal` (`:680`): Owner/Admin debug — returns user (password stripped) + `hasPassword` + `hasTechnicianProfile`.
- `deleteMyAccount` (`identity/controllers/accountController.js` → `services/accountService.js`): transactional self-delete; Owner-only `deleteUserById` with active-Owner quorum + technician snapshot preservation.

---

## 3. Token, session and request-gate mechanics (how a logged-in call works)

### 3.1 JWT issue/verify — `modules/identity/utils/token.js`

- Sign: `HS256` pinned, `JWT_SECRET`, expiry `JWT_EXPIRES_IN` (default `7d`), optional `JWT_ISSUER/AUDIENCE` (opt-in both sides).
- Payload: `{userId, role, technicianProfileId?}` (+`email` attached at gate time from decode). No `jti`, no version.
- Verify options: `algorithms:[HS256]`, `ignoreExpiration:false`.

### 3.2 HTTP gate — `shared/middleware/Auth.js` → `shared/middleware/resolveAuth.js`

Every protected request runs:

```text
Bearer parse (missing/malformed → 401 Unauthorized)
  → jwt.verify (bad/expired → 401)
  → resolveAuthSubject(decoded):
      User.findById(userId).select(status role tokenVersion).lean()
      !user → 401 · Deleted → 403 · Blocked → 403 · Inactive → 403
      token role != DB role (case-insensitive) → 403 SESSION_ROLE_MISMATCH
      tokenVersion mismatch (only when both sides carry it) → 401 SESSION_REVOKED
      role==Technician → resolve profile BY OWNER (token id never trusted blindly;
        self-heal via findOne({userId}) on mismatch/absence)
        → deleted → 403 · suspended → 403 · else attach id (null if none)
  → req.user = {_id, userId, role(DB truth), email, technicianProfileId}
```

Then one of (all must run after `Auth`):

| Gate | File | Rule |
|---|---|---|
| `authorizeRoles(...allowed)` | `shared/middleware/Auth.js` | role ∈ set (precomputed, case-insensitive); no user → 401; mismatch → 403 |
| `isTechnician` (default export) | `shared/middleware/isTechnician.js` | role==Technician → profile id present → `findById().lean()` exists → owner match → not deleted/suspended → `req.technician = doc`; consumers read `_id/userId/payoutSettings/workStatus` |
| `ensureCustomer` (middleware) | `shared/middleware/ensureCustomer.js` | role==Customer + valid ObjectId userId; else 403/401 |
| `ensureCustomer` (throw-helper) | `shared/utils/ensureCustomer.js` | same rule, throws `{statusCode}` for use inside controllers (cart, address, quotes, productBooking) |

### 3.3 Socket gate — `shared/middleware/socketAuth.js` (+ `socketRateLimiter.js` before it)

```text
io.use(handshakeLimiter 20/min/IP, fixed-window) → io.use(socketAuth):
  token ONLY from handshake.auth.token (query string refused — URL leak)
  → jwt.verify (async form, non-blocking) → resolveAuthSubject (same as HTTP)
  → socket.user = {_id, userId, role, email, technicianProfileId}
Room joins (index.js): user:{userId} + role:{role} + customer_{userId}(compat)
  + technician_{profileId} (techs) + admin_dashboard/admin (Owner/Admin)
  + single-session kick (new socket disconnects old) + acked location/get_jobs handlers
```

### 3.4 Profile endpoints (what each role calls day-to-day)

| Endpoint | Role | Code | DB hits |
|---|---|---|---|
| `GET /me` | Customer/Owner/Admin | `profileService.getMyProfileInternal` non-tech branch: `User.findById.select(-password)` | 1 |
| `GET /me` | Technician | tech branch: `Profile.findOne({userId})` + populate user fields → `KYC.findOne` (narrow select) → KMS decrypt bank → derived flags (`kycVerified/isBankVerified/trainingCompleted/isActiveTechnician`) | 2 + KMS |
| `POST /complete-profile` | all | `completeProfileInternal`: allow-list split (name→User, rest→Profile + GeoJSON build); sets `profileComplete=true` | 1–2 writes |
| `PUT /me` | Technician + bankDetails | `updateMyProfileInternal` bank pipeline: load Profile → load-or-create KYC → verified-block check → regex validation → dup-account (hash) check → normalize → encrypt → reset to pending + 30-day editable window | KYC save + Profile update |
| `PUT /me` | others | allow-list update; Customer sets `profileComplete` only when fname+mobile present | 1–2 reads/writes |
| `GET /users/:role`, `/users/:role/:id` | Admin/Owner | `getAllUsersInternal` (Customer 3-`$lookup` aggregate / Technician 4-`$lookup` aggregate + per-row KMS decrypt; plain find otherwise), `getUserByIdInternal` | heavy / 1 |

---

## 4. End-to-end role journeys (one line per hop)

**Customer:** signup+terms → SIGNUP OTP → verify (User created) → login → LOGIN OTP → verify (JWT) → `complete-profile` → addresses → cart → checkout (zone+slot gate) → booking broadcast → pay (Razorpay order→verify/webhook→paid) → rate → book-again. Every step: `Auth` (+`ensureCustomer` on customer-only routes).

**Technician:** tech-signup+terms → verify (User + pending Profile, JWT+profileId) → `technicianData` onboarding (GPS district/zone + mapped skills) → KYC/bank/docs submit → training + admin `verifyKYC` → approved → online → pings (`PUT /location` or socket, 12/min) → `my-jobs` → accept (atomic claim) → `status` steps → completed → settlement → withdrawal → RazorpayX payout. Every step: `Auth` + `isTechnician`; dispatch additionally requires approved/trained/online/fresh-GPS/permission/skill (matching + eligibility services).

**Owner:** invite signup → verify → set-password → password login → full admin surface + `DELETE /users/:id` + debug lookup + settings.

**Admin:** provisioned out-of-band (no signup route) → password login → `authorizeRoles("Admin","Owner")` surface: users, KYC verify, skill review, zones/districts/availability, payments/refunds/complaints, dashboards, dispatch ops.

---

## 5. Error-code map (stable contract across roles)

`400 VALIDATION_ERROR / INVALID_MOBILE_NUMBER / OTP_INVALID / PASSWORD_REQUIRED / PASSWORD_NOT_SET`
`401 UNAUTHORIZED / INVALID_CREDENTIALS / SESSION_REVOKED`
`403 ROLE_MISMATCH / OWNER_INVITE_REQUIRED / ACCOUNT_BLOCKED / ACCOUNT_DELETED / PASSWORD_ONLY_LOGIN / SESSION_ROLE_MISMATCH / TECHNICIAN_SUSPENDED / ACCOUNT_INACTIVE`
`404 USER_NOT_FOUND / TEMPUSER_NOT_FOUND / OTP_NOT_FOUND`
`409 MOBILE_ALREADY_EXISTS`
`429 OTP_COOLDOWN / OTP_TOO_MANY_ATTEMPTS`
`500 SMS_SEND_FAILED / TEMPUSER_CREATE_FAILED`
Shape: `{success:false, message, result:{}}` (+`code`, sometimes `details`).
