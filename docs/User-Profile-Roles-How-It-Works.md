# User Profile & Roles — How It Works (Full Analysis)

> Scope: the `User` identity + per-role profile behavior (Customer / Technician / Owner / Admin).
> Companion: `docs/Technician-Profile-Location-Performance.md` (technician deep-dive).

---

## 1. The one-schema role model

All four roles live in **one collection** — `Schemas/User.js`:

| Field | Type / constraint | Notes |
|---|---|---|
| `role` | enum `Customer\|Technician\|Owner\|Admin`, required, indexed | Immutable in practice (never changed by code; changing it orphans the extension docs) |
| `mobileNumber` | unique, required, 10-digit or `deleted_*` | Global unique ⇒ **one mobile = one role**. No dual Customer+Technician account |
| `email` | sparse unique, lowercase | Optional; `deleted_*` allowed after anonymize |
| `fname / lname / gender` | plain strings, optional | Name lives here for Customer/Owner/Admin; for Technicians it is **mirrored** (see §3) |
| `password` | `select:false`, optional | Only meaningful for Owner/Admin (password login). OTP roles ignore it at login |
| `status` | enum `Active\|Inactive\|Blocked\|Deleted`, default `Active` | `Blocked/Deleted` enforced in `Auth` + `socketAuth`. `Inactive`/`Suspended` exist but are weakly enforced |
| `profileComplete` | Boolean, default false | One of **three** copies (User + TechnicianProfile + computed logic) — see §6 |
| `lastLoginAt` | Date | Set on LOGIN verify; also used for the 201-vs-200 heuristic |
| `fcmTokens` | `[String]` | One of **three** token stores (User + TechnicianProfile + DeviceToken) — should be DeviceToken only |
| `termsAndServices / privacyPolicy (+At)` | Boolean + Date | Required `true` for Customer/Technician signup; Owner gated by invite code instead |

Extension rule:

- **Customer / Owner / Admin** = `User` row only. Everything about them is on the User doc.
- **Technician** = `User` row + `TechnicianProfile` (`userId` unique → User) + `TechnicianKYC` (`technicianId` unique → Profile). The profile holds work data; KYC holds encrypted IDs/bank.

## 2. What each role can do (role → profile → gates → routes)

| Role | Profile storage | Login | Gates | Routes / abilities |
|---|---|---|---|---|
| **Customer** | `User` only (`fname/lname/gender/email`, addresses in `Address` collection) | OTP only (`login` → `LOGIN` OTP → verify) | `Auth` + `ensureCustomer` (Middleware + Utils copies) | Cart/checkout, service bookings, product quotes, payments, addresses, reports, ratings, notifications, device-token |
| **Technician** | `User` (name/phone) + `TechnicianProfile` (everything operational) + `TechnicianKYC` (IDs/bank) | OTP only (same flow + `workStatus != deleted` check) | `Auth` + `isTechnician` (role + profile exists) | Location pings, jobs feed (`my-jobs`), accept/decline, status progression, KYC submit, skills, wallet/withdrawal, complaints respond, zone info |
| **Owner** | `User` only | Password (`ownerLogin`, `privileged`) + OTP signup behind `OWNER_SIGNUP_INVITE_CODE` | `Auth` + `authorizeRoles("Owner")` (delete users) / `("Owner","Admin")` (admin reads) | Everything Admin can + user delete + Owner-only settings |
| **Admin** | `User` only | Password (privileged login) | `Auth` + `authorizeRoles("Admin","Owner")` | User lists, bookings, KYC verify, Skill review, zones/districts, availability, payments/refunds/complaints, dashboards |

JWT payload: `{userId, role, technicianProfileId?}` (HS256, 7d). `Auth` re-reads the DB every request (status gate + profile-id resolve); `socketAuth` does the same for sockets.

## 3. Profile read/write paths (actual code: `Services/profileService.js`)

### 3.1 `getMyProfileInternal({userId, role})`

- **Technician branch** (3 sequential DB hits):
  1. `TechnicianProfile.findOne({userId})` + `populate(userId → fname/lname/gender/mobile/email)` + `.select("-password")` (no-op select — Profile has no password field).
  2. `TechnicianKYC.findOne({technicianId})` with a narrow select (bank/verification fields).
  3. If bank present → `getDekForKycDoc` (KMS decrypt) + `decryptBankDetails` → attach decrypted bank to response.
  4. Derives `kycVerified / verificationStatus / isBankVerified / trainingCompleted / isActiveTechnician` flags onto the result.
- **Non-technician branch** (1 hit): `User.findById(userId).select("-password")` → plain object.

Called by: `GET /api/user/me` (`Routes/User.js` → `Controllers/User.js getMyProfile`).

### 3.2 `completeProfileInternal({userId, role, body})`

- Technician: allow-list (`fname/lname/gender/address/city/state/pincode/latitude/longitude/locality/experienceYears/specialization`) → splits name fields to `User`, rest to `TechnicianProfile` (builds GeoJSON `location` from lat/lng via `buildLocation`, range-checked) → **blindly sets `profileComplete = true`** on the Profile (no completeness check!) → two writes (`User.findByIdAndUpdate` + `Profile.findOneAndUpdate`).
- Customer/Owner/Admin: allow-list (`fname/lname/gender/email`) → sets `profileComplete = true` → one `User` write.

Called by: `POST /api/user/complete-profile`.

### 3.3 `updateMyProfileInternal({userId, role, body})`

- If `role === Technician && body.bankDetails`: full bank pipeline — load Profile → load-or-create KYC → block if `bankVerified && !bankUpdateRequired` (403) → regex-validate every bank field → duplicate-account check (hash + plaintext `$or`, excluding self) → normalize (Title-Case name, upper IFSC, lower UPI) → `getOrCreateDekForKycDoc` → `encryptBankDetails` → reset verification to `pending` + 30-day `bankEditableUntil` → `kyc.save()`. Then falls through to the generic profile update below.
- Technician generic: same allow-list as complete (no `profileComplete = true` this time — inconsistent with §3.2) → `Profile.findOneAndUpdate`.
- Customer: allow-list + `forbidden = {password, status, userId, profileComplete}` → loads current `fname/mobileNumber` → sets `profileComplete = true` **only if fname + mobile both present** (the only honest completeness check in the file) → `User.findByIdAndUpdate`.

Called by: `PUT /api/user/me`.

### 3.4 Admin aggregates — `getAllUsersInternal({role, search})` + `getUserByIdInternal`

- **Customer**: giant `User.aggregate` with 3 `$lookup`s (servicebookings → `serviceBookings`, productbookings → `productBookings` on `userId` — note: ProductBooking stores `customerId`, so this lookup may miss; addresses → `customerAddresses`) + `$project` (profile block, mapped addresses, jobStats by filtering embedded arrays) + `$sort createdAt -1`. **No pagination, no limit** — full-collection fan-out per call.
- **Technician**: even bigger aggregate — `User → $lookup technicianprofiles → $unwind → $lookup techniciankycs → $unwind → $lookup servicebookings (by profile _id) → $lookup services (by skills.serviceId)` + ~150-line `$project` (name fallback from KYC bank-holder name, mapped skills with nested `$filter`, kyc/bank/training/availability/rating/jobStats blocks) + sort. Then `decryptAdminUserList(users)`: one `TechnicianKyc.find({technicianId: $in})` + **one KMS decrypt per row in a loop** (sequential awaits).
- **Other roles**: plain `User.find({role, ...search})` (no pagination either).
- `getUserByIdInternal`: `User.findOne({_id, role})` — no populate (thin; fine).

Called by: `GET /api/user/users/:role`, `GET /api/user/users/:role/:id` (both `Auth + authorizeRoles(Admin, Owner)`).

## 4. Auth flows that create/consume the profile

- **Signup** (`signupAndSendOtpInternal`): normalize phone → Owner invite-code check / Customer-Tech terms check → 409 if live `User` (anonymize-and-allow if prior `Deleted`) → `TempUser` upsert → wipe old `SIGNUP` OTPs → bcrypt 4-digit OTP, 5m TTL → SMS.
- **Verify SIGNUP** (`verifyOtpInternal`): latest `verified:false`, unexpired OTP for the identifier → attempts ≥ 5 block → bcrypt compare → transaction: `User.create + TechnicianProfile.create(pending, if Technician) + TempUser/Otp cleanup` → `signToken` → 201 (new) / 200 heuristic (`!lastLoginAt`).
- **Login** (`loginInternal`): find by mobile → `ROLE_MISMATCH` (echoes registered role — oracle, fix) → `Blocked/Deleted` block → privileged (Owner/Admin): bcrypt password → token; else OTP issue (Tech: `workStatus != deleted` check).
- **Verify LOGIN**: re-check blocks → `lastLoginAt = now` → resolve `technicianProfileId` → token → 200.
- **Resend / set-password / accept-terms / delete-my-account**: 60s cooldown resend; `bcrypt(password,10)` set (min 8, no strength policy); terms patch; self-delete cascade (see M1 audit).

## 5. Guards (how the role is enforced per request)

| Guard | File | Checks | Gap |
|---|---|---|---|
| `Auth` | `Middleware/Auth.js` | Bearer JWT → verify → `User.status` (blocks `Blocked/Deleted`) → resolves `technicianProfileId`, blocks `workStatus == deleted` → `req.user` | Doesn't compare `decoded.role` vs DB role; doesn't check `Suspended`; no `tokenVersion` |
| `authorizeRoles(...)` | same file | role ∈ allow-list (must follow `Auth`) | Fine — but missing on several tech-admin reads |
| `isTechnician` | `Middleware/isTechnician.js` | `role == Technician` + Profile exists → `req.technician` | No workStatus/training/KYC check |
| `ensureCustomer` | Middleware + Utils copies | `role == Customer` | Duplicated; Middleware copy barely used |
| `socketAuth` | `Middleware/socketAuth.js` | Same as `Auth` for sockets (`handshake.auth.token` only) | Same gaps as `Auth` |

## 6. Known defects to fix in the rewrite (summary — details in `docs/module-audits/M1-Auth-Identity-Audit.md`)

1. Open Admin self-signup (no invite gate) → Owner-only creation.
2. OTP verify/resend scoped by identifier only → filter `{identifier, role, purpose}` + compound index.
3. No token revocation (`tokenVersion`/`jti`) + stale-role trust → add + check every request.
4. `suspended` techs not blocked (HTTP + socket) → central reject.
5. `ROLE_MISMATCH` echoes registered role → generic error.
6. `technicianAll/ById`, `jobs/current|accepted`, `admin/jobs/history` under bare `Auth` → `authorizeRoles`.
7. `fcmTokens` ×3 stores, `bankDetails` mirror, `profileComplete` ×3 computations → single sources (DeviceToken / KYC / computed virtual).
8. `completeProfile` blindly sets `profileComplete = true`; update path doesn't; customer path checks fname+mobile — unify into one `computeProfileComplete()`.
9. Delete inconsistency (hard vs soft-anonymize) → single `deleteUserCascade` (soft-anonymize User, hard-delete extensions, revoke tokens+sockets).
10. Admin aggregates unbounded (no pagination/limit) + sequential KMS loop → paginate + parallel decrypt + strip currency to lean fields.
11. `productBookings` lookup uses `userId` foreign field while ProductBooking stores `customerId` → returns empty; fix field.
12. `getMyProfileInternal` tech branch: 2 sequential queries + KMS round-trip on **every** `/me` call → split hot (name/status) vs sensitive (bank, on-demand endpoint).

## 7. Rewrite prescription (User side)

- Keep single `User` collection; `role` immutable; add `tokenVersion`, `Suspended` status (+`suspendedAt/Reason`); drop `fcmTokens`; partial index excluding `Deleted`.
- One `computeProfileComplete()` helper (Customer: fname+mobile; Technician: name + address/city + valid location + ≥1 mapped skill + KYC submitted).
- Validators file (phone/role/OTP/password/terms) + repository layer (`user.repo`, `otp.repo` with scoped find + atomic consume).
- Canonical routes only; `otpLimiter` on OTP-issuing login; generic auth errors; paginated admin lists (20/100) with legacy cap + `X-Deprecated`.
- `setPassword`: strong policy + recent-OTP-proof + Owner/Admin-login-only semantics.
