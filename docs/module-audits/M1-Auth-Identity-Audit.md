# M1 — Auth & Identity: Production Audit & Rewrite Design

> Project: RightTouch · Backend: Node.js + Express 5 + Mongoose 8 · Auth: OTP + JWT · Realtime: Socket.IO
> Scope: ONLY M1. Other modules appear solely under "External Dependency / Cross-Module Impact".
> Companion docs: `docs/BACKEND_MODULES_RESPONSIBILITIES.md`, `docs/BACKEND_REWRITE_ANALYSIS.md`.
> Status: **ANALYSIS + TARGET DESIGN ONLY — no code modified.**

---

## 1. Executive Summary

Identity is a **single-collection model** (`User.role ∈ Customer|Technician|Owner|Admin`, `mobileNumber` globally unique) with OTP-first login for Customer/Technician and password login for Owner/Admin, plus pre-signup staging (`TempUser` + `Otp`) and JWT (HS256, 7d) enforced by `Auth`/`authorizeRoles`/`isTechnician`/`ensureCustomer` on HTTP and `socketAuth` on sockets. The design is simple and mostly works, but has **P0-grade auth flaws**: open Admin signup, OTP queries unscoped by role/purpose, no token revocation/version, `suspended` technicians not blocked, stale-role trust, role-mismatch oracle, and unguarded admin list endpoints. Verdict: **YES WITH CONDITIONS** — fix signup gating + OTP scoping + token versioning + guard coverage first, then rewrite incrementally behind compatible routes.

## 2. Current Module Inventory

### 2.1 Files

| File | Responsibility | Called by | Calls | Authoritative? | Duplicate? | Decision |
|---|---|---|---|---|---|---|
| `Schemas/User.js` | Canonical identity: role, mobile unique, status, consents, fcmTokens | authService, profileService, Auth, socketAuth | — | YES (identity) | `fcmTokens` dup w/ DeviceToken/Profile | REMAIN, prune fcmTokens |
| `Schemas/Otp.js` | Hashed OTP, TTL 5m, attempts≤5, purpose | authService | — | YES (OTP store) | — | REMAIN, scope queries |
| `Schemas/TempUser.js` | Pre-verification staging per identifier+role | authService | — | YES (staging) | — | REMAIN |
| `Services/authService.js` | signup/login/verify/resend/setPassword/acceptTerms + signToken | Controllers/User.js | User, TempUser, Otp, TechnicianProfile, sendSms, token.js | YES (logic) | — | REMAIN, harden |
| `Services/accountService.js` | Txn hard-delete, Owner quorum, tech snapshot | accountController, User.js deleteUserById | User, TechnicianProfile, KYC | YES | — | REMAIN → rename deleteUserCascade |
| `Services/profileService.js` | Customer vs Technician get/complete/update + admin aggregates | Controllers/User.js | User, Profile, KYC, kyc crypto | YES | profileComplete ×3 impls | SPLIT (compute helper) |
| `Middleware/Auth.js` | `Auth` JWT gate + `authorizeRoles` | all protected routes | User, TechnicianProfile | YES (HTTP gate) | — | REMAIN, add version/role checks |
| `Middleware/isTechnician.js` | role==Technician + profile exists → req.technician | technician routes | TechnicianProfile | PARTIAL (no status check) | overlaps authorizeRoles | MERGE into requireRole+profile check |
| `Middleware/ensureCustomer.js` | role==Customer + ObjectId check | few routes | — | PARTIAL | dup w/ Utils/ensureCustomer.js | MERGE (keep one) |
| `Utils/ensureCustomer.js` | Throw-helper same logic | cart/address/quote controllers | — | PARTIAL | dup above | DELETE one |
| `Middleware/socketAuth.js` | Handshake auth.token-only JWT + Deleted/Blocked/deleted-Tech checks | io.use | User, TechnicianProfile | YES (socket gate) | shares logic w/ Auth.js | REMAIN, share resolveAuth() |
| `Controllers/User.js` | Thin wrappers + role-forcing logins | Routes/User.js, technician.js | authService, profileService | NO | role-hacks per route | REMAIN, thin further |
| `Controllers/accountController.js` | DELETE /delete-my-account wrapper | Routes/User.js | accountService | NO | — | REMAIN |
| `Routes/User.js` | Public auth + /me + Owner/Admin mgmt + rate limiters | index.js /api/user | Controllers/User.js | YES (mount) | alias explosion | REMAIN, prune aliases |
| `Routes/technician.js` (auth part) | tech signup/login/verify + protected tech APIs | index.js /api/technician | same controllers | YES | KYC/bank alias ×3 | REMAIN, canonicalize |
| `Routes/adminKycRoutes.js` | Admin KYC reads/decisions | index.js /api/admin | technicianKycController | YES | same controller under /api/technician | REMAIN, clarify boundary |
| `Utils/token.js` | signToken/verifyTokenOptions HS256 7d | authService, Auth, socketAuth | jsonwebtoken | YES | — | REMAIN, add tokenVersion/jti |
| `Utils/phoneValidation.js` | normalizeIndianMobile | authService | — | YES | — | REMAIN |

No dedicated validators, workers, crons, socket handlers (beyond gate), config, or tests were found for M1 — noted as gaps (§6, §21).

### 2.2 Request trace (verified)

```text
POST /api/user/signup → authLimiter → signupAndSendOtp → authService.signupAndSendOtpInternal
 → normalizeIndianMobile → Owner invite-code / terms check → User.exists? → TempUser upsert
 → Otp.deleteMany(SIGNUP) + create(bcrypt,5m) → sendSms → {OTP_SENT}
POST /api/user/verify-otp → verifyOtp → authService.verifyOtpInternal
 → find latest verified:false,unexpired (identifier ONLY) → attempts>=5? → bcrypt.compare
 → SIGNUP: txn User.create(+TechnicianProfile) + cleanup + signToken → 201/200
 → LOGIN: block Owner/Admin OTP, lastLoginAt=now, signToken → 200
GET /api/user/me → Auth (Bearer→verify→User.status→resolve technicianProfileId) → getMyProfile
Socket: io.use(handshakeLimiter) → io.use(socketAuth: handshake.auth.token→verify→DB checks) → socket.user
```

Reverse dependencies into M1: every module's routes use `Auth`; technician dispatch uses `isTechnician`; cart/address/quote use `ensureCustomer`; sockets across M6/M11 use `socketAuth`; admin KYC/complaint/finance use `authorizeRoles`.

## 3. Actual Current Flow

```text
Client → Route(+limiter) → Controller(thin) → authService → [TempUser|Otp|User|TechnicianProfile] (txn on verify-signup)
 → sendSms (side effect, outside txn) → Response{type, token?}
Authenticated: Client(Bearer) → Auth → authorizeRoles? → isTechnician? → Controller → Service → Mongo → Response
Socket: Client(auth.token) → handshakeLimiter → socketAuth → socket.user → room joins (index.js)
```

- Normal/success: signup OTP → verify → User+Profile created → JWT 7d → Auth passes → role gate passes.
- Failure: 409 MOBILE_ALREADY_EXISTS; 403 ROLE_MISMATCH/BLOCKED/DELETED; 429 attempts/cooldown; 401 bad token/missing user.
- Retry: resend OTP (60s cooldown from last record); verify retries ≤5 then blocked (must resend).
- Timeout: OTP expires 5m (TTL); JWT expires 7d (must re-login).
- Cancellation: TempUser/Otp rows deleted on successful verify; self-delete hard-deletes User/Profile/KYC (see §10).
- Duplicate: `deleteMany` prior OTPs of same purpose before create (last-write-wins); verify marks `verified:true` + deletes rows.
- Concurrent: two signups same mobile → both upsert TempUser, both create OTP; first verify wins User.create (unique mobileNumber), second hits duplicate-key → 409 (acceptable but unhandled cleanly — see §9).
- Partial failure: User created but SMS fails → user exists, client never got OTP → must use login-OTP path (works, undocumented).
- Recovery: login-OTP re-issues; resend re-issues.
- Admin: Owner/Admin password login; `authorizeRoles` gates; `deleteUserById` Owner-only with quorum.

## 4. Business Rules & Invariants

1. **One mobile = one role (current rule).**
 Why: global unique mobileNumber. Enforcement: schema unique. Fails: blocks legitimate dual Customer+Tech use; leaks registeredRole. Solution: keep single-role OR migrate to (phone,role) compound + account-link table. DB: unique index either way.
2. **OTP must be single-use, time-bound, brute-force-resistant.**
 Why: account takeover. Enforcement: bcrypt hash, 5m TTL, attempts≤5. Fails: verify/resend query by identifier only (cross role/purpose confusion). Solution: always filter `{identifier, role, purpose}` + consume (verified:true + delete) atomically. DB: compound index (identifier,role,purpose,createdAt).
3. **Blocked/Deleted/suspended principals must have no access.**
 Why: safety/compliance. Enforcement: Auth/socketAuth check Blocked/Deleted/deleted-workStatus only. Fails: `suspended` techs keep API+socket. Solution: reject `Inactive/Blocked/Suspended/Deleted` centrally. DB: status enum + index.
4. **A revoked/changed role must invalidate old tokens.**
 Why: privilege containment. Enforcement: none (no version/jti). Fails: stale role trusted until 7d expiry; suspension needs socket-kick hack. Solution: `tokenVersion` in User + JWT; check on every Auth; bump on block/role-change/suspend. DB: `tokenVersion Number default 0`.
5. **Admin creation must be privileged.**
 Why: privilege escalation. Enforcement: Owner invite-code only; Admin open. Fails: anyone can self-register Admin. Solution: Admin creation Owner-only (allowlist/invite), remove public `role:Admin` signup. App + route-level allowlist.
6. **Passwords (where used) must be strong and OTP-proof-gated.**
 Why: credential confusion. Enforcement: min-8 bcrypt(10), no policy beyond. Fails: any OTP user can set password that is then ignored at login. Solution: password login ONLY for Owner/Admin; strong policy; require recent OTP-proof to set. App enforcement.
7. **PII reads must be role-gated.**
 Why: privacy. Enforcement: ad-hoc inline checks. Fails: `technicianAll/ById`, job history under bare `Auth`. Solution: `authorizeRoles` on every admin read. App + tests.

## 5. Current Problems

- **P0 — Open Admin self-signup.** Finding: `signupAndSendOtp` gates Owner by invite code, Admin has no gate. Evidence: `Services/authService.js` signup branch; `Routes/User.js` POST /signup accepts arbitrary role. File: authService signup + User.js route. Current: anyone registers Admin. Impact: full privilege escalation. Fix: allowlist roles for public signup (Customer, Technician only); Admin/Owner via Owner-only endpoint. Verify: POST /signup {role:Admin} → 403 post-fix.
- **P0 — OTP identifier-only scoping.** Finding: verify/resend query by identifier, ignoring role/purpose. Evidence: `verifyOtpInternal` find-latest + `resendOtpInternal` reuse-last-record. Impact: cross-purpose confusion, cooldown bypass surface. Fix: filter `{identifier,role,purpose}` everywhere + compound index. Verify: integration test with two purposes pending.
- **P0 — No token revocation; stale-role trust.** Finding: no tokenVersion/jti; Auth never compares decoded.role vs DB. Evidence: `Utils/token.js` payload; `Middleware/Auth.js` post-DB logic. Impact: block/role-change ineffective ≤7d. Fix: tokenVersion + role-equality check. Verify: bump → old token 401.
- **P1 — Suspended techs not blocked.** Finding: gates check only Blocked/Deleted/deleted. Evidence: Auth.js + socketAuth.js. Impact: suspended techs keep jobs/socket. Fix: reject suspended centrally. Verify: suspend → API+socket 403.
- **P1 — Unguarded tech-admin reads (PII/wallet leak).** Finding: `GET technicianAll/technicianById/jobs/*` under bare Auth; inline role checks. Evidence: `Routes/technician.js:123-124,236-242`. Impact: any login lists technicians. Fix: authorizeRoles on router subset. Verify: customer token → 403.
- **P1 — ROLE_MISMATCH oracle.** Finding: login returns registeredRole. Evidence: `loginInternal` ROLE_MISMATCH branch. Impact: user enumeration. Fix: generic message, no role echo. Verify: response contains no role.
- **P2 — ensureCustomer duplication; isTechnician thin.** Finding: Middleware vs Utils copies; isTechnician lacks status/training/KYC checks. Impact: inconsistent enforcement, dead middleware. Fix: single middleware each, used in routes. Verify: grep single definition.
- **P2 — fcmTokens triple store; bankDetails mirror; profileComplete ×3.** Impact: drift. Fix: DeviceToken only; KYC-only bank; computed virtual. Verify: schema diff + migration.
- **P2 — Delete inconsistency; route alias explosion; limiter gaps.** Fix: single deleteUserCascade (soft-anonymize User always); canonical routes; otpLimiter on OTP-issuing login. Verify: route table snapshot test.
- **P3 — Dead password path for OTP roles; 201/200 heuristic.** Fix: password login Owner/Admin only; service returns isNewUser flag. Verify: contract test.

## 6. Security Findings

| Severity | Finding | Attack scenario | Current code | Impact | Fix | Verification |
|---|---|---|---|---|---|---|
| P0 | Open Admin signup | Attacker POST /signup {role:Admin} → verify → Admin JWT | authService signup; Routes/User.js:179 | Full takeover of admin surface | Owner-only Admin creation | POST → 403; e2e test |
| P0 | OTP scope confusion | Attacker with pending LOGIN OTP reuses for SIGNUP verify (or cross-role) | verifyOtpInternal identifier-only query | Auth bypass / confusion | {identifier,role,purpose} filter + index | Two-purpose test |
| P0 | No revocation | Blocked admin/owner token usable ≤7d | token.js payload; Auth.js | Privilege persistence | tokenVersion | Old token 401 test |
| P1 | Suspend bypass | Suspended tech keeps accepting jobs | Auth/socketAuth gates | Unsafe dispatch | Suspended→403 central | Suspended e2e |
| P1 | PII leak | Any user lists all technicians + wallet | Routes/technician.js bare-Auth reads | Privacy breach | authorizeRoles | 403 test |
| P1 | Enumeration oracle | Probe mobiles, learn registered roles | loginInternal ROLE_MISMATCH echo | Targeted phishing | Generic error | Response assert |
| P2 | OTP spam on login | login issues OTP without otpLimiter | Routes/User.js:183 login under authLimiter only | SMS cost/abuse | otpLimiter on login | Rate-limit test |
| P2 | NoSQL/prototype | Mitigated globally | index.js sanitizeNoSqlPayload | Low residual | Keep + test | Payload fuzz test |
| P2 | Weak password policy | min-8 only; settable by OTP roles | setPasswordInternal | Credential confusion | Strong policy + OTP-proof + Owner/Admin-only login | Policy test |

JWT: HS256 pinned, 7d expiry, opt iss/aud — keep; add `tokenVersion`, consider shortening to 24h + refresh later (M1 follow-up, mobile impact → backward-compat §20).

## 7. Database Findings

- `User.mobileNumber` global unique → one-role-per-mobile (see invariant 1). Redesign: KEEP single User; ADD `tokenVersion`, `suspendedAt/Reason`; REMOVE `fcmTokens`; partial index excluding Deleted; role immutable (app + pre-save guard).
- `Otp`: ADD compound `{identifier,role,purpose,createdAt}` index; ensure TTL on expiresAt; consume atomically (`findOneAndUpdate verified:false→true`).
- `TempUser`: KEEP unique(identifier,role); add `expiresAt` TTL (stale staging cleanup).
- `TechnicianProfile` role-fields: REMOVE bank mirror/fcmTokens/profileComplete-stored; ADD `suspendedAt/suspendedReason`, index `{workStatus,trainingCompleted}`.
- No orphan risk beyond TempUser/Otp leftovers → TTL handles.

## 8. Query & Index Findings

| Query | Collection | Filter/Sort/Proj | Index used/required | Issue | Recommendation |
|---|---|---|---|---|---|
| login/find by mobile | User | `{mobileNumber}` | unique ✓ | none | KEEP; add `.select('+password')` only for privileged path |
| verify OTP latest | Otp | `{identifier, verified:false, expiresAt>=now}` sort createdAt desc | single-field/TTL | unscoped | NEW compound `{identifier,role,purpose,createdAt desc}` partial `verified:false` |
| resend cooldown | Otp | last by identifier | — | unscoped | same compound |
| Auth per-request | User | `{_id}` + profile lookup | _id ✓ + profile userId unique ✓ | 2 queries/req (acceptable) | KEEP; combine via lean; cache nothing (freshness > latency here) |
| admin user lists | User | `{role,status}` + paginate | role indexed; status not | COLLSCAN risk at scale | NEW `{role,status,createdAt desc}`; enforce pagination |
| tech admin reads | TechnicianProfile | various | userId unique ✓ | missing workStatus composite | NEW `{workStatus,trainingCompleted,updatedAt desc}` |

N+1: profileService admin aggregates populate User+KYC per row — acceptable at admin scale; add pagination + lean. No unbounded arrays on User (fcmTokens removed anyway).

## 9. Concurrency Findings

- Double-signup same mobile: both pass `exists?` check → second `User.create` hits duplicate-key. Current: raw 11000 error. Fix: catch → return 409 MOBILE_ALREADY_EXISTS (idempotent outcome). Key: unique mobileNumber (already DB-enforced). No Redis needed.
- Double-verify same OTP: both pass `verified:false` read → both consume. Fix: atomic `findOneAndUpdate({_id, verified:false, expiresAt:{$gte:now}}, {verified:true})`; loser gets 410/409 → must resend. No distributed lock (single-doc atomic suffices).
- Resend vs verify race: resend `deleteMany` could wipe OTP being verified. Fix: resend creates new row without deleting in-flight unverified-expired only (`deleteMany {expiresAt:<now}`), or version chain; simplest: resend does NOT delete unexpired rows, just adds newer (verify picks latest). Document last-wins.
- Multi-device login: allowed (single-session kick is socket-layer, §M11). No change.

## 10. Transaction Findings

- Verify-signup: `User.create + TechnicianProfile.create + TempUser.delete + Otp.delete` MUST be atomic → KEEP Mongo transaction (already). Failure mid-way → rollback → client retries verify (OTP still valid) or resends. SMS send stays OUTSIDE txn (side effect; retry-safe since OTP row persists).
- Self-delete / Owner delete: multi-doc (User/Profile/KYC) → KEEP transaction; unify to soft-anonymize User (`deleted_*`) + hard-delete extensions + `tokenVersion++` (revoke) + socket kick (best-effort post-commit).
- Login-OTP issue, resend, setPassword, acceptTerms: single-doc → NO transaction.

## 11. Outbox / Worker Findings

M1 needs NO outbox: auth responses are synchronous; post-signup `broadcastAdminUnreadCounts()` is best-effort (already fire-and-forget, must never throw — verify try/catch). No worker/cron for M1. OTP expiry relies on TTL index (verify cron needed? No — TTL suffices).

## 12. Idempotency Findings

| Operation | Key | Stored | Unique | Retry | Duplicate behavior |
|---|---|---|---|---|---|
| signup OTP request | (identifier,role,SIGNUP) | Otp rows | compound (new) | resend creates newer; verify picks latest | returns OTP_SENT (same outcome) |
| verify SIGNUP | Otp _id consume | verified flag | _id | second verify → 409 already-consumed | first creates User; second 409 (no dup user: mobile unique backstop) |
| login OTP request | (identifier,role,LOGIN) | Otp rows | compound (new) | same as signup | OTP_SENT |
| verify LOGIN | Otp _id consume | verified flag | _id | second → 409 | second login needs fresh OTP |
| resend | cooldown on last createdAt | Otp | — | 429 within 60s | same OTP window extended (new row) |
| setPassword | userId + recent OTP-proof (new) | — | — | safe retry | same hash outcome |
| delete account | userId + tokenVersion++ | User | _id | second → 404 | already-deleted response |

## 13. API Contract Findings

All endpoints `POST /api/user/*` + `POST /api/technician/signup|login*`. Auth: public (signup/login/verify/resend) vs `Auth` (/me, set-password, users, delete-my-account). Issues: role-forcing wrappers (`req.body.role=` hacks) instead of explicit params — REST-smell but backward-compatible; keep paths, validate role against allowlist. Status codes: 409 exists-mobile ✓; 403 ROLE_MISMATCH should be 403 (keep) but WITHOUT role echo; attempts-exhausted uses 429 ✓; verify-consumed should be 409 (add); resend-cooldown 429 ✓; validation failures 400 (ensure); Auth failures 401 vs 403 correctly split (missing/bad token 401; Blocked/Deleted 403 — keep). Pagination missing on `getAllUsers` — add `?page&limit` (default 20, max 100) with backward-compat (unpaginated default for now + deprecation header? Simpler: paginate with defaults — response shape `{data, page, total}` breaks old clients → use compat: if no `page` param, return legacy array capped at 50 + `X-Deprecated` header; see §20).

## 14. Target Architecture

```text
Route (limiter + role-allowlist)
 ↓
Auth? (public? skip : Auth → authorizeRoles)
 ↓
Validator (zod/express-validator: phone, role, otp, password policy)
 ↓
Controller (thin: map req → service)
 ↓
Application Service (authService / accountService / profileService)
 ↓
Repository (UserRepo / OtpRepo / TempUserRepo: scoped queries, atomic consume)
 ↓
MongoDB (txn only for verify-signup + delete cascade)
                              ├── Redis (rate-limit buckets future; NOT for locks — atomics suffice)
                              └── External: SMS provider (outside txn, retry-safe)
```

No new layers beyond Validator + Repository thin wrappers; maintainable by current team.

## 15. Target Schema

```text
User: KEEP all; ADD tokenVersion Number default 0 (index not needed; read by _id)
      ADD suspendedAt Date, suspendedReason String; REMOVE fcmTokens (MIGRATE → DeviceToken)
      role: RENAME semantics → immutable (app guard); status enum ADD Suspended
      NEW partial index {status:1} where status≠Deleted (admin lists)
Otp:  KEEP all; NEW compound {identifier:1, role:1, purpose:1, createdAt:-1} partial {verified:false}
      KEEP TTL on expiresAt; consume via atomic findOneAndUpdate
TempUser: KEEP all; NEW expiresAt TTL 24h
TechnicianProfile (M1-relevant): REMOVE bankDetails mirror, fcmTokens, stored profileComplete → DERIVED virtual
      ADD suspendedAt/suspendedReason mirror? NO — derive from User.status + workStatus (single check in Auth)
```

## 16. Target Query Design

- `findUserByMobile(mobile)` → `User.findOne({mobileNumber}).lean()` (+`.select('+password')` only privileged).
- `findValidOtp({identifier,role,purpose})` → `findOne({identifier,role,purpose,verified:false,expiresAt:{$gte:now}}).sort({createdAt:-1})`; consume → `findOneAndUpdate({_id,verified:false},{verified:true})` → null means lost race → 409.
- `Auth`: `User.findById(decoded.userId).lean()` → checks: exists? (401) → `tokenVersion===decoded.tokenVersion`? (401) → `decoded.role===user.role`? (403 stale) → `status∈{Blocked,Deleted,Suspended,Inactive}`? (403) → tech: `TechnicianProfile.findOne({userId}).select('workStatus trainingCompleted').lean()` → block `deleted/suspended`. Verify with `.explain('executionStats')`: all `_id`/unique → IXSCAN.
- Admin lists: `User.find({role,status}).sort({createdAt:-1}).skip().limit().lean()` + `countDocuments({role,status})` → compound `{role:1,status:1,createdAt:-1}` → IXSCAN.

## 17. Target File Structure

```text
modules/identity/
├── routes/auth.routes.js            # public: signup/login/verify/resend (role allowlist) — mounts /api/user + /api/technician aliases
├── routes/account.routes.js         # Auth: /me, complete-profile, delete-my-account, users/:role (authorizeRoles)
├── controllers/auth.controller.js   # thin wrappers (no role hacks; role from validated param)
├── controllers/account.controller.js
├── services/auth.service.js         # signup/login/verify/resend/password/terms (scoped OTP, generic errors)
├── services/account.service.js      # deleteUserCascade (soft-anonymize + revoke + socket kick)
├── services/profile.service.js      # get/computeProfileComplete/update (single helper)
├── repositories/user.repo.js        # findByMobile/ById, bumpTokenVersion
├── repositories/otp.repo.js         # issueScoped, findValid, consumeAtomic
├── validators/auth.validator.js     # NEW: phone/role/otp/password/terms (single place)
├── middleware/requireAuth.js        # re-export Auth+authorizeRoles (no logic change)
└── tests/auth.{unit,api,concurrency,security}.test.js  # NEW
```

Responsibilities: routes (paths+limiters+guards only); validators (input only, never DB); controllers (req↔service mapping only); services (business rules); repositories (query shapes only, no rules); tests per §21. NOT in M1: wallet/bank/KYC content (M2/M9), zone logic (M3).

## 18. State Machine

M1 has no order-like lifecycle; OTP sub-machine:

```text
OTP: ISSUED ──verify OK──→ CONSUMED (terminal)
      │──attempt fail (attempts<5)──→ ISSUED (attempts++)
      │──attempts≥5──→ BLOCKED (must resend → new ISSUED)
      └──expires 5m──→ EXPIRED (TTL removes; resend → new ISSUED)
```

| Transition | Who | Via | Guard | Idempotency |
|---|---|---|---|---|
| issue | any client | HTTP signup/login/resend | cooldown 60s | new row; last-wins |
| consume OK | owner of phone | HTTP verify | atomic verified:false→true + unexpired | second → 409 |
| fail++ | owner | HTTP verify | attempts<5 | counter |
| block | system | verify (attempts≥5) | — | 429 until resend |

User.status machine: `Active ↔ Inactive → Blocked/Suspended → Deleted(terminal)`; transitions ONLY via admin actions + self-delete (no direct `status=` writes elsewhere — grep-enforced).

## 19. Edge Cases

| Scenario | Expected | Current | Production |
|---|---|---|---|
| Duplicate signup same mobile+role | 409 both | second 500/11000 possible | 409 MOBILE_ALREADY_EXISTS (catch dup key) |
| Concurrent verify same OTP | one 200/201, one 409 | both may pass read | atomic consume → loser 409 |
| Resend during verify | verify of newest succeeds | deleteMany may wipe in-flight | no delete of unexpired; last-wins documented |
| SMS provider down | OTP row exists; 503 with retry-after | unhandled throw? | 503 SMS_UNAVAILABLE, row kept, resend allowed |
| Deleted user re-signup | new account allowed (anonymized old) | works (anonymize) | KEEP + test |
| Dual-role aspirant | clear error + upgrade path | ROLE_MISMATCH + role leak | generic error + support flow |
| Stale token after block | 401 everywhere incl socket | usable ≤7d | tokenVersion → 401 + socket disconnect |
| Suspended tech socket connected | disconnected | stays | socketAuth rejects → disconnect |
| Admin list without pagination | capped page | unbounded | default page 20 + cap 100 |
| set-password without proof | 403 | allowed w/ Auth only | require recent OTP-proof (new col verifiedAt reasonable: Auth + verified OTP within 10m — store lastVerifiedAt on User) |

## 20. Test Plan

- Unit: normalize phone; role allowlist; password policy; OTP consume atomicity (mock); tokenVersion check logic.
- Integration: signup→verify txn rollback (kill mid-txn); delete cascade; suspended tokenVersion bump.
- API: every endpoint × happy + 400/401/403/409/429 matrix; role echo absence; pagination defaults.
- Transaction: verify-signup double-submit → single User; delete twice → 404 second.
- Concurrency: 10 parallel verifies same OTP → exactly one success; 5 parallel signups → one User + four 409.
- Idempotency: resend×3 → latest verifies, older 409; verify replay → 409.
- Security: Admin signup 403; customer→technicianAll 403; IDOR users/:role/:id cross-role 403; OTP brute-force 429 after 5; NoSQL payload `{"$gt":""}` sanitized; rate-limit headers.
- Failure: SMS mock down → 503 + row kept; Mongo down → 503 (not 500) on auth paths; socket with revoked token → disconnect.
- Regression: all current client paths (customer/tech/owner login, /me, complete-profile) unchanged shape.
- Load: realistic — 100 concurrent OTP issues (SMS mocked), p95 Auth latency; no fabricated numbers, measure in staging.

## 21. Migration Plan

```text
Phase 1 Audit — DONE (this doc). Risk: none.
Phase 2 Tests — add auth api+concurrency+security tests on CURRENT code (new tests/ dir). Verify green.
Phase 3 Schema/index prep — ADD tokenVersion/suspendedAt/compound OTP index (background build)/TempUser TTL. No app change. Rollback: drop indexes/fields (unused). Verify: index builds, explain().
Phase 4 New impl — validators + repos + scoped OTP + generic errors + tokenVersion issue/check + Admin-signup gate + guards on reads. Behind same routes. Risk: medium. Rollback: revert deploy (fields unused by old code except harmless). Verify: full test suite + staging e2e.
Phase 5 Compat — legacy alias routes kept; unpaginated getAllUsers compat (cap 50 + X-Deprecated); JWTs: old tokens (no tokenVersion) → treat as version 0? DECISION: accept during 7d window (decoded.tokenVersion ?? 0 must equal user.tokenVersion which starts 0) then enforce. Verify: old-app login still works.
Phase 6 Data migration — backfill tokenVersion:0, anonymize already-Deleted correctly, move fcmTokens→DeviceToken (script, dry-run first). Risk: low. Rollback: restore backup. Verify: counts match.
Phase 7 Shadow — dual-run Auth checks (log mismatches without enforcing suspended/role-equality) 48h. Verify: zero unexpected denies.
Phase 8 Switch — enforce all checks; remove Admin public signup. Monitor 401/403 rates, login success, OTP SMS volume.
Phase 9 Monitor — dashboards: login_success_total, otp_issue/verify/fail, auth_deny_total by reason, p95 Auth latency.
Phase 10 Remove legacy — delete Utils/ensureCustomer dup, alias KYC/bank routes (after client migration), old unpaginated path.
```

## 22. Production Verification Checklist

- Code: single OTP implementation; no unreachable role hacks; no direct status writes (grep `status:` writes outside services); single delete path.
- DB: schemas validated; indexes built in background; `.explain()` IXSCAN on login/verify/Auth/admin-list; pagination everywhere.
- Security: signup gate tested; OTP scoped; revocation tested; IDOR tested; rate limits tested; PII masked.
- Reliability: idempotent verify; txn on signup-verify + delete; no outbox needed (confirmed); SMS-failure 503 path tested; socket revoke tested.
- Observability: requestId logs on auth failures (no OTP value logged!); metrics (login/otp/deny); audit on Admin create/delete/block.
- Testing: unit+integration+api+concurrency+security+failure+regression green.
- Deployment: migration dry-run; compat verified with current mobile builds; rollback = redeploy previous image + drop-new-indexes note.

## 23. Files To Create

- `modules/identity/validators/auth.validator.js`, `repositories/user.repo.js`, `repositories/otp.repo.js`, `tests/auth.{unit,api,concurrency,security}.test.js`, migration script `scripts/backfill-token-version.js`.

## 24. Files To Modify

- `Schemas/User.js` (+tokenVersion/suspendedAt, −fcmTokens), `Schemas/Otp.js` (+compound index), `Schemas/TempUser.js` (+TTL), `Services/authService.js` (scoped OTP, generic errors, signup allowlist, tokenVersion issue), `Services/accountService.js` (cascade+revoke), `Services/profileService.js` (single complete-helper), `Middleware/Auth.js` (version+role-equality+suspended), `Middleware/socketAuth.js` (same), `Controllers/User.js` (remove role hacks, isNewUser flag), `Routes/User.js` + `Routes/technician.js` (guards, limiters, deprecate aliases), `Utils/token.js` (payload+verify).

## 25. Files To Merge

- `Middleware/ensureCustomer.js` + `Utils/ensureCustomer.js` → one `middlewares/requireCustomer.js` used in routes. `Middleware/isTechnician.js` → merge into `requireRole('Technician')` + profile attach (keep file as re-export shim during compat).

## 26. Files To Delete

- One of the two ensureCustomer copies (post-compat); deprecated alias routes (`/kyc` vs `/technician/kyc` triplicates — M2-owned but M1-gated; coordinate); `Utils/ensureTechnician.js` if unused (verify callers first — "Not verified from the available repository evidence" for full caller list; grep before delete).

## 27. Risks / Open Questions

1. Single-role-per-mobile vs multi-role accounts: product decision required — compound-unique migration is breaking for clients. RECOMMEND: keep single-role for rewrite; add account-linking later.
2. JWT lifetime 7d vs shorter + refresh: mobile UX impact; keep 7d + tokenVersion for now.
3. `lastVerifiedAt` for set-password proof: new field vs stateless — needs product sign-off.
4. Admin/Owner OTP-login explicitly forbidden today — confirm intended (yes, password-only) and keep.
5. External: SMS provider failover (Fast2SMS only?) — SRE concern, out of M1 code scope; recommend secondary provider.
6. Cross-module: M2 wallet/bank mirrors, M3 zone permission, M11 DeviceToken sync — M1 must not break their reads during fcmTokens migration (compat shim emitting to both stores for one release).

## 28. Final Acceptance Criteria

- POST /signup {role:Admin} → 403; Owner flow unchanged; Customer/Tech OTP flows unchanged in shape.
- OTP verify/resend scoped; concurrent same-OTP → exactly one success; replay → 409.
- Blocked/suspended/deleted principal → 401/403 on HTTP AND socket disconnect; old tokens invalid after tokenVersion bump.
- No PII leak: customer token on tech-admin reads → 403.
- No role echo in errors; NoSQL payloads sanitized; rate limits (incl. login OTP) enforced.
- Admin user lists paginated; query plans IXSCAN; zero COLLSCAN on auth hot paths.
- Tests (§20) green; migration dry-run clean; rollback rehearsed.

### Can this module safely be rewritten now?

```text
YES WITH CONDITIONS
```

Conditions: (1) backfill-safe additive schema changes first with background indexes; (2) Admin-signup gate + OTP scoping + tokenVersion land together (single release, compat window for old JWTs); (3) guard coverage on tech-admin reads in same release; (4) full auth API+concurrency+security suite green before traffic switch; (5) fcmTokens/DeviceToken dual-write compat with M11 during migration. Dependencies that must NOT break: M2 (TechnicianProfile auto-create on signup, KYC/bank reads), M3 (registration district/zone validators calling into profile), M6 (job endpoints behind isTechnician/Auth), M8/M9 (payment/wallet ownership checks via req.user), M11 (socketAuth + DeviceToken + admin-unread broadcast on signup), M12 (admin user/complaint/rating gates via authorizeRoles). Cross-module items: DeviceToken sync ownership → M11; bank/KYC field moves → M2; zone-permission checks → M3; all listed here, designed in their own audits.
