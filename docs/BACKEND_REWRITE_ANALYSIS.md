# RightTouch Backend — Full System Analysis & Per-Module Rewrite Blueprint

> Repo: `RighttouchServerNew` (Express 5 + Mongoose 8 + Socket.IO 4 + Razorpay/RazorpayX + FCM + Redis adapter)
> Entry: `index.js` → Mongo connect → `startBackgroundWorkers()` → route mounts (`/api/admin/*`, `/api/technician/*`, `/api/user/*`, `/api/*` webhooks)
> Generated: 2026-10-03. Purpose: rewrite-ready spec. Each module has **As-Is → Wrong flows → To-Be (rewrite)**.

---

## 0. System map (all mounts)

| Base | Routers | Who |
|---|---|---|
| `/api/admin` | wallet, operationalCity, technicianDistrict, zones, finance(admin), refunds(admin), quotations(admin), productDashboard, serviceAvailability, zone-geofence, kyc, skillRequest, `payments/*`, `notifications/*` (Auth+Admin/Owner), `permissions/*` | Owner/Admin |
| `/api/technician` | `technician.js` (god-router), wallet, finance(tech), refunds(tech), `notifications` (Auth+isTechnician), `permissions`, `device-token` | Technician |
| `/api/user` | `User.js` (auth+booking+payment+quote), `payments/*`, `reports/*`, productQuote, `notifications`, `permissions`, `device-token` | Customer |
| `/api/addresses`, `/api/*userZones` | Address, zone-availability public | Customer/public |
| `/api/*` | razorpayX webhooks, `admin/dispatch` | system |
| sockets | `socketAuth` → rooms `user:{id}`, `role:*`, `customer_{id}`, `technician_{profileId}`, `admin_*` | all |

Background workers (all started post-Mongo in `startBackgroundWorkers`): `bookingCron`, `dispatchQueue`, `bookingOutboxWorker`, `paymentCrons`, `attemptExpirySweeper`, `paymentNotificationWorker`, `refundWorker/reconcileRefunds/classARefundScanner/complaintSlaEscalation/releaseExpiredHolds`, `notificationWorker`, `processQuotationDeliveries`, `expireQuotations`.

Money rule (keep in rewrite): **paise integers are truth** (`*Paise` fields). Rupee mirrors (`baseAmount`, `totalAmount`, …) are legacy/display only. `financialSnapshot` on booking is immutable copy, never recomputed.

---

## M1 — Identity, Auth, RBAC (answers your "same schema" question)

**As-Is:**
- ONE collection `User` for all roles: `role: Customer|Technician|Owner|Admin`, `mobileNumber` unique globally, `password select:false optional`, `status Active|Inactive|Blocked|Deleted`, `profileComplete`, `fcmTokens[]`, terms flags. `Schemas/User.js:5-55`.
- Technician = `User(role=Technician)` + 1:1 `TechnicianProfile(userId unique)` + 1:1 `TechnicianKYC(technicianId unique)`. Customer/Owner/Admin = `User` only, no profile extension.
- Pre-signup staging: `TempUser(identifier,role unique)` + `Otp(identifier,role,bcryptHash,TTL 5m,attempts,purpose SIGNUP|LOGIN|RESET_PASSWORD)`.
- Flows: `signup→OTP→verify-otp(create User+Profile, signToken)` ; `login(role)` → privileged (Owner/Admin password) vs OTP (Customer/Tech) ; `resendOtp` (60s cooldown) ; `set-password` ; `accept-terms`. JWT HS256 7d payload `{userId,role,technicianProfileId?}` — no `jti/tokenVersion`. `Middleware/Auth.js` (Bearer→DB status gate→auto-resolve profileId), `authorizeRoles(...)`, `isTechnician.js` (role+profile exists only), `ensureCustomer` duplicated in `Middleware/` and `Utils/` (latter used inline in controllers).

**WRONG (must fix in rewrite):**
1. `mobileNumber unique` globally ⇒ **one mobile = one role**. A person can't be Customer+Technician. Login leaks `registeredRole` on `ROLE_MISMATCH` (user-enumeration oracle).
2. **Open Admin signup**: Owner signup gated by invite code, `role:Admin` has no gate — anyone can `POST /signup {role:Admin}`.
3. `verify/resend OTP` query by `identifier` only, ignoring `role/purpose` — cross-purpose confusion + cooldown bypass.
4. `Auth/socketAuth` only block `Blocked/Deleted/deleted-workStatus`. `suspended` techs keep full API+socket. No `tokenVersion/jti` ⇒ no revocation; stale `decoded.role` trusted after role change.
5. `isTechnician` doesn't check `workStatus/suspended/training/KYC`. Many `GET /technicianAll, /jobs/*` routes have only `Auth` (no `authorizeRoles`); controllers do ad-hoc `role!==Owner` PII leaks.
6. `fcmTokens` on `User` AND `TechnicianProfile` AND `DeviceToken` collection — triple source of truth. `bankDetails` plaintext mirror on Profile vs encrypted in KYC. `profileComplete` on User+Profile computed 3 different ways. Delete is inconsistent (hard-delete vs soft-anonymize `deleted_*`).
7. `set-password` usable by OTP users but Customer/Tech login ignores password (credential confusion). Route alias explosion (`/kyc`+`/technician/kyc`, `/banks`×3, registration doubles).

**Rewrite spec (M1):**
- Keep single `User` collection (correct for identity), but: make `role` immutable, add `tokenVersion:Number` (bump on block/role-change/suspend; embed+check in JWT), add `status: Suspended`, remove `fcmTokens` (use `DeviceToken` only), partial index excluding `Deleted`.
- If multi-role needed: introduce `UserIdentity(1) → UserRole(N)` or allow same mobile with `phone+role` compound unique. Minimum: return generic `OTP_SENT/ROLE_MISMATCH` without leaking registered role.
- Gate `Admin` creation to Owner-only invite/allowlist endpoint. Scope all OTP queries `{identifier,role,purpose}`. Apply `otpLimiter` to OTP-issuing `login` too.
- Middleware: single `Auth` that checks `decoded.role===db.role && decoded.tokenVersion===db.tokenVersion`, rejects `Inactive/Blocked/Suspended/Deleted`; single `requireRole(...)`; single `ensureCustomer`; `isTechnician` checks `workStatus∉{suspended,deleted}`. Canonical routes only: `/api/auth/*`, `/api/technician/kyc/*`, `/api/admin/kyc/*`. One `deleteUserCascade()` (soft-anonymize User, hard-delete extensions) + `revokeTokens()`.

---

## M2 — Technician onboarding / Profile / KYC / Skills

**As-Is:** `TechnicianProfile` (~369 lines: GeoJSON `location` 2dsphere, `workStatus pending|trained|approved|suspended|deleted`, `availability.isOnline`, `skills[{serviceId,experienceYears}]`, wallet mirrors `walletBalance+available/reserved/reserve/outstanding/lifetime*Paise+walletVersion`, payout/bank mirrors, geo `primaryCityId/primaryDistrictId/allowedCityIds/enabledDistrictIds/enabledCityZoneIds/current*`, `dispatchLockUntil`, `jobRejectCount`, `lastMatchingAt/lastJobsChangeAt`). `TechnicianKYC` (aadhaar/pan/dl `Mixed` plain-or-encrypted + Cloudinary urls, `verificationStatus pending|approved|rejected`, bank encrypted + `accountNumberHash`, `encryptedDek`). Controllers: `technician.js` (god: onboarding+skills+location+admin-list), `technicianKycController`, `technicianSkillRequestController`, `accountController`.

**WRONG:** god-controller; wallet fields on Profile duplicate ledger truth; bank/plaintext dual-write with two validation paths; `profileComplete` blindly set `true` in update path; suspended techs not enforced (response-masking only); admin list endpoints unguarded.

**Rewrite spec:** Split into `technician-onboarding`, `technician-profile`, `technician-skills`, `technician-location` controllers. Profile keeps only operational fields (location, availability, skills, geo-permissions, counters); **delete** `walletBalance/*Paise` mirrors (compute from `WalletTransaction`+`PlatformLedgerEntry`), `bankDetails` mirror, `fcmTokens`, `profileComplete` (make virtual `computeProfileComplete()`). KYC: forbid `Mixed` plaintext (migration encrypts), add `unique(accountNumberHash)` partial + `statusHistory[]`. Enforce `suspended→403` at query layer. `authorizeRoles` on all admin reads.

---

## M3 — Geo: OperationalCity / District / CityZone / Permissions / Availability

**As-Is:** `OperationalCity` (district polygon, the "district" in code) → `CityZone` (`operationalCityId`, `zoneCode unique`, `polygon Polygon|MultiPolygon Mixed` + 2dsphere, `active`). `ZoneServiceMapping` (service approved per zone). `TechnicianDistrictPermission` + `DistrictPermissionHistory` + `TechnicianZonePermissionAudit` + `Permission/PermissionHistory`. `ServiceAvailability` (admin service on/off per zone). Matching: `resolveZoneFromCoordinates → resolveServiceZoneAvailability → technicianMatching.matchAndBroadcastBooking` (zone/district/skill/online filter).

**WRONG:** Naming chaos (`districtId → OperationalCity`, `cityZoneId → CityZone`, `district` vs `city` fields on Profile). Polygon was `[[[Number]]]` (stripped MultiPolygon, `$geoIntersects` never matched) — fixed via `Mixed` + controller validator, keep. No `broadcasted→pending` re-queue when zero techs (stays `broadcasted` till expiry). Cancel-revoke has no outbox message (offline techs miss `job_cancelled` socket).

**Rewrite spec:** Rename model refs (keep collection names, fix field names/docs): `operationalDistrictId`, `cityZoneId` everywhere. Single `geoService.resolveBookingZone(lng,lat,serviceId)` returning `{district,zone,mapping,available}` or typed error. Single permission write path (`technicianDistrictService`) with audit. Add `DispatchOutbox kind=cancel_revoke`. Add re-queue transition `broadcasted→pending`.

---

## M4 — Catalog: Category / Service / Product + Commission

**As-Is:** `Category`, `Service` (base price, `gstPercentage`, active), `Product` (+stock/images), `ServiceCommissionRule` (+`commissionRuleSource/Id`, `calculationVersion`). `productController`, `productDashboardController`, `categoryController`, `serviceController`, `adminCommissionController`. Pricing snapshot at booking: `resolveCommissionSnapshot → financialSnapshot{paise}`.

**WRONG:** Live price vs snapshot divergence (book-again uses live price override, legacy create uses client radius/pricing); `commissionOverridden` admin path exists but no version guard; rupee/paise dual writes.

**Rewrite spec:** Catalog is source of truth for *display* only; booking-time `pricingService.snapshot(serviceId)` is the only writer of `financialSnapshot` (paise-only, with `ruleId+version`). Admin override allowed only when `paymentStatus=pending`, bumps `calculationVersion`, sets `commissionOverridden=true`, writes audit. Drop all rupee writes in new code.

---

## M5 — Cart + Address

**As-Is:** `Cart{customerId,itemType product|service,itemId,quantity,scheduledAt+scheduledDate/Time/timezone,faultProblem}` unique `(customer,itemType,itemId)`. `Address{saved addresses + GeoJSON}`. `cartController` (add/update/checkout→booking pipeline), `addressController`, `resolveUserLocation(saved|gps)`.

**WRONG:** Cart `scheduledAt` has no slot validation (booking pipeline does — late failure after checkout). `addressSnapshot.label` unnormalized. Checkout duplicates booking-build logic.

**Rewrite spec:** Cart is a dumb staging list. Checkout calls the **single** `bookingService.createBookingAndOutbox()` (same as schedule/book-again). Validate slot + zone at add-to-cart (fail fast) and re-validate at checkout. Normalize `addressSnapshot{label,line,city,state,pincode,lat,lng}` once in `resolveUserLocation`.

---

## M6 — Service Booking + Dispatch / Broadcast / Matching (core)

**As-Is state machines** (`Utils/bookingStatus.js` + schema pre-save normalize):
- `status: pending→broadcasted→accepted→on_the_way→reached→in_progress→completed | expired|cancelled` (+ legacy `SEARCHING→broadcasted, ACCEPTED→accepted, requested→pending`; BUG `scheduled→schedule` where `schedule` isn't a status).
- Orthogonal: `assignmentStatus unassigned→broadcasted→assigned→released`; `cancellationStatus active|customer|technician|system_cancelled`; `cancellationFeeStatus not_collected|collected|waived|disputed`; `paymentStatus pending|paid|refunded`; `settlementStatus pending|eligible|settled`; `bookingType instant|schedule`.
- Create: `buildServiceBookingDoc → createBookingAndOutbox{Booking+BookingOutbox TX} → broadcastCreatedBooking → matchAndBroadcastBooking{TX: JobBroadcast×N + status→broadcasted + DispatchOutbox job_new×N} → socket+FCM (dispatchQueue worker retries)`. **Legacy `createBooking` bypasses outbox TX entirely.**
- Accept: atomic `findOneAndUpdate{_id,status∈[pending,broadcasted],activeBroadcastVersion}→accepted+technicianId+assignedAt`; `TechnicianBookingOffer/JobBroadcast` superseded; `notifyCustomerJobAccepted`.
- Progress: `PUT /status/:id` (`canTransition` + `version` optimistic lock) → `completed` sets `released`, `settleBookingEarningsIfEligible`, `PAYMENT_DUE` push.
- Cancel: customer (`pending,broadcasted,accepted,on_the_way,reached` + fee table) vs technician (`accepted…in_progress` + ₹200 penalty debit + scheduled-future resets to `pending/unassigned` for re-dispatch else `cancelled`) vs crons (`autoCancelAt→expired/cancelled`, reminders, no-show, re-broadcast).

**WRONG (critical):**
1. Two creation pipelines (new TX+outbox vs legacy direct-create). Different `autoCancelAt/version/assignmentStatus` defaults.
2. `bookingType` chaos `instant|schedule` vs input `scheduled` vs checks for both.
3. Skip-steps allowed: `accepted→completed` in one call (tech can complete without travel). `completed` has no payment guard.
4. Customer cancel excludes `in_progress` but transition table allows it — 409 vs table mismatch.
5. Technician-cancel re-dispatch nulls `technicianId` but keeps `cancellationStatus=technician_cancelled` + penalty on doc (dirty for next accept).
6. `paymentStatus/settlementStatus` vocab drift (utils promise `order_created/success/blocked/reversed`, schema lacks them).
7. `Broadcasted` with zero techs never re-queues; `accepted…→expired` (no-show) bypasses `canTransition`; `version` predicate fails for pre-version docs.

**Rewrite spec:** One pipeline (delete legacy body, route through `bookingService`). One `bookingTransitions.js` used by **all** writers (endpoints + crons + admin). Linear enforcement `accepted→on_the_way→reached→in_progress→completed` (allow `reached→completed` only with `workImages`). Customer `in_progress` cancel policy explicit (allow+fee or forbid in both table+endpoint). Technician re-dispatch writes clean doc + `assignmentAttempts[]` entry (already exists — use it, don't keep penalty on doc). Align payment/settlement enums with schema; decide `blocked/reversed`. Fix `bookingType` to `instant|schedule` + migrate old `scheduled` docs. Outbox events for `cancelled/completed/expired` or document single-event scope.

---

## M7 — Product flow: QuoteRequest → Quotation → ProductBooking

**As-Is:**
- `ProductQuoteRequest: quote_requested→under_review→quotation_prepared→quotation_sent→viewed→accepted | rejected→(re-open), cancelled, expired` (`Utils/quotationStateMachine.js`; partial unique `(customerId,productId)` blocks new thread while open incl. `expired/rejected`).
- `Quotation: draft→sent→viewed→accepted→converted | rejected|expired|superseded` (`ACTIVE=[sent,viewed]` partial unique 1 active/request; per-`items[].status pending|accepted|rejected` for partial accept; `paymentStatus unpaid|paid|partial` unguarded; `notificationStatus` mirrors `QuotationDelivery` worker).
- `ProductBooking: status active|completed|cancelled, paymentStatus pending|paid|refunded|completed(nonsense)` — no machine, no outbox.
- Flow: customer creates request → admin assign → admin creates `Quotation[draft revN]` → `send` (TX supersede others + `enqueueDeliveries` unique `(quotation,channel,type)`) → customer `view/accept` (`acceptQuotation` TX creates 1..N `ProductBooking[paymentGroupId]` idempotent by count) / `reject` (request re-opens `under_review`) → pay via `paymentController` → admin `complete` (rating gate).

**WRONG:**
1. `ProductBooking.cancel` checks dead states `ready_for_delivery/out_for_delivery` (never in enum); `active+paid` cancellable with **no refund hook**; `save()` with no payment/refund transition.
2. `revise` sets `supersededAt/supersededBy` but NOT `status=superseded` — old rev still claimable; `accept` allows `accepted` (good idempotency) but no DB unique guard (app `count` race).
3. QuoteRequest lock includes `expired/rejected` then mutates old row to `under_review` and returns it (caller expecting new `requestNumber` gets old thread).
4. Delete guards allow deleting `sent/viewed` quotations and `under_review/quotation_prepared` requests with orphan `draft`s.
5. `converted` never executed (accept stops at `accepted`); `paymentStatus.completed` nonsense value; `draft→expired/cancelled` missing; `quotation.paymentStatus` updated via unguarded admin endpoint.
6. No `ProductBooking` outbox; no `active→expired/refunded` paths.

**Rewrite spec:** `ProductBooking{status active|completed|cancelled} + {paymentStatus pending|paid|refunded}` (drop `completed` from payment enum). `cancel(paid)→Refund pipeline`, forbid qty edit after paid. `revise` atomically `status=superseded` + `version++`. Delete blocked for `sent/viewed` and parents with `draft`s. Request lock excludes `expired/rejected/cancelled` (new thread on those). DB guard `unique partial (quotationId,productId)` or `(quotationId,itemId)` for idempotent accept. On `ProductBooking paid` TX: `Quotation accepted→converted, paymentStatus=paid`. Cron expires stale `draft`s. Add `cancel_revoke`-style fulfilment outbox if needed.

---

## M8 — Customer payments (Razorpay)

**As-Is:** `Payment{bookingId unique, itemType service|product|quotation + paymentType SERVICE|PRODUCT|QUOTATION (dual, redundant), settlementType, provider razorpay, mode online|offline|cash|…, offlineDetails, financialSnapshot copy paise, idempotencyKey, capturedAmountPaise, lastAttemptId, amountRefundedPaise, status pending|success|failed|refunded|manual_review}` + unique `(provider,providerOrderId/ProviderPaymentId)` partial. `PaymentAttempt` (order attempts, expiry sweeper) + `PaymentEvent` (webhook log) + `Receipt`. Flow: `POST /payment/:bookingId/order` (snapshot copy) → Razorpay order → `verify` (HMAC, `capturedAmount` vs `totalAmount` mismatch→review) → `paymentStatus=paid, paidAmountPaise` → settlement eligible. Crons: `paymentCrons` reconciliation, `attemptExpirySweeper`, `paymentNotificationWorker`. `customerPaymentController` (manage surface) + `adminPaymentRoutes`.

**WRONG:** `itemType`+`paymentType` duplicate enums (`service` vs `SERVICE`) — one will drift. `bookingId ref:ServiceBooking` blocks product/quote FK (relies on loose `bookingId` in Refund instead). `Payment.bookingId unique` blocks multi-payment/retry rows (forces attempt table split — ok but undocumented). Offline/cash path writes `paid` without maker-checker.

**Rewrite spec:** Single `itemType: SERVICE|PRODUCT|QUOTATION` (migrate, drop `paymentType`). `bookingId: ObjectId` without fixed `ref` + `bookingModel: ServiceBooking|ProductBooking|Quotation` (refPath). Keep `Payment 1:1 booking` + `PaymentAttempt 1:N` split, document it. Offline payments require `recordedBy + approvedBy` (two-person) + receipt. Keep `capturedAmountPaise` mismatch → `manual_review` + `ReconciliationException`.

---

## M9 — Settlement / Wallet / Withdrawal / Payout (RazorpayX)

**As-Is:** `settleBookingEarningsIfEligible` on `completed+paid` → `WalletTransaction{technicianId,bookingId,paymentId,withdrawalId,amountPaise,type credit|debit,source job|tip|withdraw|adjustment|bonus|penalty|refund,idempotencyKey unique sparse}` + unique partial `(bookingId,type,source)` one job-credit. `PlatformLedgerEntry` (double-entry truth) via `Utils/ledger.js` + `settlement.js`. `WithdrawalRequest` + `withdrawalPayoutEngine` + `autoPayout` + `PayoutOutbox` → RazorpayX contact/fund-account/payout; `razorpayXController + razorpayXWebhookController` update payout status. `BookingPayoutBlock`, `ReserveHold` (`complaintFreeze`), `GlobalSetting` (policy).

**WRONG:** Wallet mirrors on `TechnicianProfile` (`available/reserved/…`) can drift from ledger (no reconciler documented). Penalty debit `₹200` shortfall handling (debited vs policy split) lives partly on booking doc, partly in reconciliation. `settlementStatus eligible→settled` timing vs withdrawal reserve unclear.

**Rewrite spec:** Ledger is truth; Profile wallet fields become read-model (nightly reconcile job, or delete). One `settlementService.settle(bookingId)` idempotent by `job:<bookingId>` key. One `withdrawalService.request→approve→execute(razorpayx)→webhook→done/failed` with `PayoutOutbox` lease pattern (same as booking outbox). Complaint holds via `ReserveHold` only (drop ad-hoc freeze paths). Document `eligible` (payable) vs `settled` (credited) vs `reserved` (held).

---

## M10 — Refunds / Chargebacks / Complaints / Reports

**As-Is:** `Refund{paymentId,bookingId(+bookingType product|service),customerId,technicianId,refundClass restitution|adjudication,reason,faultParty,sharePct,reportId,initiatedBy/approvedBy,gross/breakdown/materialCost/net,clawback*Paise,commissionReversed,mdrLoss,processingFee,gstRecoverable,creditNoteId,rail razorpay_reverse|razorpayx_payout,providerRefundId unique sparse,status pending_execution|initiated|processed|failed|retrying|manual_review|unrefundable_source,idempotencyKey unique sparse}` + `RefundOutbox` + `refundEngine{refundWorker,reconcileRefunds,classARefundScanner,complaintSlaEscalation}` + `refundPolicy + refundClawback + complaintFreeze(releaseExpiredHolds)` + `CreditNote, Chargeback, CustomerRefundPayout, ReconciliationException`. `Report` (+`reportCategories`) + `complaintController` (SLA escalation, reserve freeze) + `ratingController` (completion-gated).

**WRONG:** Product paid-cancel never creates `Refund` (money dangles). `cancellationFeeStatus=not_collected` has no collector/reconciler. `faultParty/sharePct` vs `clawback` math split between `refundEngine` and `refundClawback` (two truths).

**Rewrite spec:** Every paid-cancel/complaint-accept creates `Refund` (never direct `paymentStatus=refunded`). One `refundService.execute(refundId)` worker (lease+retry+idempotencyKey). One clawback calculator. `Report→Refund` link mandatory for `adjudication`. SLA cron keeps `complaintSlaEscalation`. `CreditNote` issued for `gstRecoverable`. Reconcile `not_collected` fees + `outstanding` penalties in one job.

---

## M11 — Notifications / Devices / Realtime

**As-Is:** `Notification{recipientId+recipientType customer|technician|admin,eventType,title,body,data,priority,category,sourceType/Id,correlationId,idempotencyKey unique sparse,readAt/receivedAt/openedAt,expiresAt}` + `NotificationOutbox` + `NotificationDelivery` + `NotificationPreference` + `DeviceToken` (+`fcmTokens[]` mirrors) + `notificationTemplates/adapters/worker/metrics`, `unifiedNotificationService/notificationService/sendNotification/FCM/SMS/WhatsApp`. `TechnicianBroadcast + TechnicianBookingOffer + DispatchOutbox + dispatchQueue` for job fan-out. Socket rooms+`socketDTO/socketConstants/socketMetrics/socketSessionControl(single-session Map per-process)+socketRateLimiter+TECH_LOC 12/min budget`.

**WRONG:** Triple token stores (`User.fcmTokens`, `Profile.fcmTokens`, `DeviceToken`). Per-process presence/rate maps break with ≥2 replicas (code itself warns; Redis adapter fans out emits but not presence). `Notification` has no `refPath` (`recipientId` untyped). Job-cancel has no durable revoke (socket-only). `QuotationDelivery` duplicates generic outbox pattern instead of reusing it.

**Rewrite spec:** One token store: `DeviceToken` (prune on FCM `not-registered`). One `notificationService.notify({recipient,eventType,template,data})` → `Notification + NotificationOutbox` → worker (socket+FCM+SMS/WA per `NotificationPreference`). Move presence/buckets to Redis for multi-replica. Add `DispatchOutbox cancel_revoke`. Merge `QuotationDelivery` into generic `NotificationOutbox` with `channel` field, or document why separate (WhatsApp threading) and share lease/retry helper.

---

## M12 — Rating / BookAgain / Catalog ops / Finance dashboards / Admin settings

**As-Is:** `Rating{booking+technician+customer, score, comment}` (completion+payment gated, one per booking) + `ratingService`. `bookAgainController` (completed+paid → live-price rebuild → same pipeline). `Cart checkout` same. `financeController + adminWalletController + technicianWalletController` (earnings summaries over `WalletTransaction`+`Payment`). `adminSettingsController + GlobalSetting` (fees, penalties, payout policy). `AuditLog`, `Report`, `permissionController`, `addressController`, `operationalCityController/cityZoneController/zoneAvailabilityController/adminZoneGeofenceController/adminServiceAvailabilityController`.

**WRONG:** `bookAgain` re-checks `scheduled||schedule` (enum bug surface). Rating gate logic duplicated in controller+service. Finance summaries read Profile mirrors instead of ledger (drift risk).

**Rewrite spec:** `bookAgain` = `fetchPrevious(completed+paid) → snapshot(live) → createBookingAndOutbox` (no special casing). Rating one-write (unique `bookingId`) + recompute `Profile.rating{avg,count}` in same TX. Finance reads `PlatformLedgerEntry+WalletTransaction+Payment` only. Settings behind `GlobalSetting` cache + audit on change.

---

## Cross-cutting rewrite rules (apply to every module)

1. **State machines**: one `transitions.js` per aggregate, all writers (HTTP+socket+crons+admin) call `assertTransition`. No skip-steps. No direct `status=` writes.
2. **Outbox pattern**: `{create aggregate + outbox row} in one TX (idempotencyKey) → worker claims `pending→inflight(lease)` → `done/failed(backoff,maxAttempts)` → TTL cleanup. Use for booking-created, dispatch fan-out + cancel-revoke, notification, payout, refund, quotation-delivery.
3. **Money**: paise-only writes; `financialSnapshot` immutable; rupee fields read-only legacy.
4. **AuthZ**: `Auth + requireRole(...)` on every router; no inline `role!==Owner` checks; no unguarded list endpoints.
5. **Indexes**: keep existing 2dsphere/partial-unique/lease indexes; add `tokenVersion`, `cancel_revoke` partial, quote→order unique, `accountNumberHash` unique partial.
6. **Socket**: versioned DTOs (`socketDTO`), `technician:{id}` room joins in `socketAuth`, Redis-backed presence before scaling past 1 replica.
7. **Deletes**: soft-anonymize `User` (`deleted_*`), hard-delete extensions, revoke tokens+sockets. Never hard-delete `User` with money history (keep for ledger/audit).
8. ** 玩 Rewrite order** (independent, low-risk first): M1(auth) → M4(catalog) → M5(cart/address) → M3(geo) → M2(tech onboarding) → M6(service booking) → M7(product/quote) → M8(payments) → M9(settlement/wallet) → M10(refund/complaint) → M11(notifications) → M12(finance/dashboards).

---

## Appendix: key files per module

- M1: `Schemas/User|Otp|TempUser`, `Controllers/User|accountController`, `Services/authService|profileService|accountService`, `Middleware/Auth|isTechnician|ensureCustomer|socketAuth`, `Routes/User|adminKycRoutes`, `Utils/token|phoneValidation|ensureCustomer`.
- M2: `Schemas/TechnicianProfile|TechnicianKYC`, `Controllers/technician|technicianKycController|technicianSkillRequestController`, `Utils/technicianEligibility|technicianActivation|kyc*`.
- M3: `Schemas/OperationalCity|CityZone|ZoneServiceMapping|ServiceAvailability|TechnicianDistrictPermission|*History|Permission*`, `Controllers/*Zone*|*District*|*Availability*|permissionController`, `Services/districtService|technicianDistrictService|serviceAvailabilityService`, `Utils/*geo*|*polygon*|resolveZone*|feasibility`.
- M4: `Schemas/Category|Service|Product|ServiceCommissionRule`, `Controllers/category|service|product|productDashboard|adminCommission`, `Utils/commission|productPricing`.
- M5: `Schemas/Cart|Address`, `Controllers/cart|addressController`, `Services/addressService`, `Utils/resolveUserLocation|slots`.
- M6: `Schemas/ServiceBooking|BookingOutbox|DispatchOutbox|TechnicianBroadcast|TechnicianBookingOffer|TechnicianLocationHistory|ReserveHold`, `Controllers/serviceBook|bookAgain|technicianBroadcast`, `Utils/bookingService|bookingStatus|technicianMatching|dispatchQueue|bookingOutboxWorker|bookingCron|technicianLocation|technicianJobFetch|findNearbyTechnicians`, `Routes/technician|User|adminDispatch`.
- M7: `Schemas/Quotation|ProductQuoteRequest|ProductBooking|QuotationDelivery`, `Controllers/quotation|productQuoteRequest|productBooking`, `Services/quotationService|quotationAcceptanceService|quotationPricingService|productQuoteRequestService|quotationDeliveryService`, `Utils/quotationStateMachine|quotationNumber`.
- M8: `Schemas/Payment|PaymentAttempt|PaymentEvent|Receipt`, `Controllers/payment|customerPayment`, `Services/paymentSettlementService`, `Utils/razorpay|paymentTransitions|paymentAttempts|paymentReadModel|paymentCrons|attemptExpirySweeper|paymentNotificationWorker|money`, `Routes/customerPayments|adminPayment`.
- M9: `Schemas/WalletTransaction|WithdrawalRequest|PayoutOutbox|PlatformLedgerEntry|BookingPayoutBlock|GlobalSetting`, `Controllers/technicianWallet|adminWallet|finance|razorpayX`, `Utils/ledger|settlement|withdrawalPayoutEngine|autoPayout|walletDebit|razorpayX`, `Routes/*Wallet*|finance`.
- M10: `Schemas/Refund|RefundOutbox|CreditNote|Chargeback|CustomerRefundPayout|ReconciliationException|Report`, `Controllers/refund|complaint|report`, `Services/complaintService`, `Utils/refundEngine|refundPolicy|refundClawback|complaintFreeze`, `Routes/adminRefunds|technicianRefunds|userReports`.
- M11: `Schemas/Notification|NotificationOutbox|NotificationDelivery|NotificationPreference|DeviceToken`, `Controllers/notification|adminNotification`, `Services/notificationService|unifiedNotificationService`, `Utils/notification*|sendNotification|sendSMS|sendWhatsapp|sendMail|firebase|notificationWorker|ioAccess|socket*`, `Routes/notification|device|permission`.
- M12: `Schemas/Rating|AuditLog`, `Controllers/rating|bookAgain|cart|adminSettings|operationalCity|cityZone|zoneAvailability|productDashboard`, `Services/ratingService`, `Utils/audit`, `swagger.js`, `index.js` mounts.
