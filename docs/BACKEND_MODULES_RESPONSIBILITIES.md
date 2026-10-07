# RightTouch Backend — Module & Responsibility Reference

> Full codebase inventory: what every module owns, which files belong to it,
> what each file does, which APIs it exposes, and how it flows.
> Grouped in **12 domains**. Companion doc: `docs/BACKEND_REWRITE_ANALYSIS.md`
> (wrong-flows + rewrite spec — not repeated here).

- Stack: Express 5 (ESM) + Mongoose 8 + Socket.IO 4 (+ Redis adapter) + Razorpay + RazorpayX + FCM + Twilio/Fast2SMS + Cloudinary.
- Entry: `index.js` → Express + HTTP + Socket.IO → Mongo connect → `startBackgroundWorkers()` → route mounts → health/swagger/error-handler → graceful shutdown.
- Counts (verified 2026-10-03): Controllers 40 · Routes 30 · Schemas 62 · Services 19 · Utils ~75 · Middleware 5.
- Money rule: `*Paise` integers are truth; rupee mirrors are legacy/display; `financialSnapshot` on booking is immutable.
- Roles: `Customer | Technician | Owner | Admin` (single `User` collection + `TechnicianProfile`/`TechnicianKYC` extension for technicians).

---

## 0. System overview

### 0.1 Startup (`index.js`)

| Step | Responsibility |
|---|---|
| `sanitizeNoSqlPayload` + `express.json({verify: rawBody})` | Strip `$`/dotted keys (params/query/body); keep `req.rawBody` for webhook HMAC |
| `generalLimiter` (1000/15m) + `helmet` + `cors` + 60s timeout | Edge hardening |
| `new Server(http, {connectionStateRecovery 2m, maxHttpBufferSize 500KB})` + Redis adapter (fallback single-node) | Realtime transport |
| `io.use(handshakeLimiter 20/min) → io.use(socketAuth)` | Socket gate before any handler |
| Room joins + single-session kick + `location_update` (12/min per tech) + `get_jobs` (1/3s per socket, cursor short-circuit) handlers | Socket runtime |
| `mongoose.connect(pool 50/5)` → `initRedisAdapter` → `validateFcmConfig` → `startBackgroundWorkers()` | Boot order (workers only after Mongo) |
| `GET /health/live`, `/health/ready`, `/health/fcm`, `/health/metrics`, `/health/socket-rooms/:userId` | Supervisor/LB + diagnostics |
| `App.use(ApiRoutes)` → swagger → global error handler (Multer + JSON-parse + fallback) | HTTP surface |
| `SIGTERM/SIGINT → stop*Worker + io.close + http.close + mongo.close + redis.quit` | Graceful shutdown |

### 0.2 Route mounts (`index.js:620-664`)

| Base | Router file | Responsibility |
|---|---|---|
| `/api/admin` | `adminWalletRoutes`, `operationalCityRoutes`, `adminTechnicianDistrictRoutes`, `adminZones`, `financeRoutes(admin)`, `adminRefunds`, `adminQuotationRoutes`, `adminProductDashboardRoutes`, `adminServiceAvailabilityRoutes`, `adminZoneGeofenceRoutes(/api/admin/zone-geofence)`, `adminKycRoutes`, `adminSkillRequestRoutes`, `adminPaymentRoutes(/api/admin/payments)`, `notificationRoutes(/api/admin/notifications: Auth+Admin/Owner)`, `adminPermissionRoutes(/api/admin/permissions)` | All Owner/Admin ops |
| `/api/technician` | `technician.js`, `technicianWalletRoutes`, `technicianFinanceRoutes`, `technicianRefundsRoutes`, `notificationRoutes(/api/technician/notifications: Auth+isTechnician)`, `permissionRoutes(/permissions: Auth)`, `deviceRoutes(/device-token: Auth)` | All technician self-service |
| `/api/user` | `User.js`, `customerPayments(/api/user/payments)`, `userReports(/api/user/reports)`, `productQuoteRoutes`, `notificationRoutes(/api/user/notifications: Auth)`, `permissionRoutes(/permissions)`, `deviceRoutes(/device-token)` | All customer self-service |
| `/api/addresses` | `address.js` | Customer address book (+ admin reads) |
| `/api` | `userZones` (`/zones/resolve`, `/zones/check-service`), `razorpayXWebhookRoutes`, `adminDispatchRoutes(/api/admin/dispatch)` | Public zone-check + webhooks + dispatch ops |
| `/api-docs`, `/api-docs.json` | `swagger.js` | API docs |

### 0.3 Background workers / crons (all in `startBackgroundWorkers()`)

| Worker | File | Interval / trigger | Responsibility |
|---|---|---|---|
| Booking crons | `Utils/bookingCron.js` | expiry 5m, rebroadcast 10m, instant-OTW timeout 1m, scheduled enforcement 1m, reminders, orphan-broadcast cleanup 30m | Expire/timeout/remind/re-broadcast bookings |
| Dispatch worker | `Utils/dispatchQueue.js` | continuous, batch 50 / conc 10 / 1.5s | Deliver `DispatchOutbox(job_new)` → socket+FCM |
| Booking outbox worker | `Utils/bookingOutboxWorker.js` | poll | `BookingOutbox(booking_created)` → `matchAndBroadcastBooking` after commit |
| Payment reconcile + settlement backstop | `Utils/paymentCrons.js` | 15m payments, 10m payouts, 6h auto-payout, daily ledger audit | Heal stuck payments/payouts, auto-payout, ledger audit |
| Attempt expiry sweeper | `Utils/attemptExpirySweeper.js` | continuous | Expire stale `PaymentAttempt` |
| Payment notification worker | `Utils/paymentNotificationWorker.js` | continuous | Realtime payment-status pushes |
| Refund worker / reconcile / ClassA scanner / complaint SLA / reserve-freeze expiry | `Utils/refundEngine.js`, `Utils/complaintFreeze.js`, `Utils/refundPolicy.js` | 30s / 5m / 2m / 1h / 15m | Execute + reconcile refunds, auto ClassA refunds, SLA escalation, release expired holds |
| Notification worker | `Utils/notificationWorker.js` | 5s | Lease `NotificationOutbox pending` (+ reclaim stale `published` >2m) → per-channel dispatch |
| Quotation delivery + expiry | `Services/quotationDeliveryService.js`, `Services/quotationService.js` | 30s / 1h | Send quotation in_app/WhatsApp deliveries; expire stale quotes |
| Socket metrics logger | `Utils/socketMetrics.js` | 60s | Log socket/location/drop metrics |

### 0.4 Socket rooms & events

Rooms (`Utils/socketConstants.js`, `index.js` joins): `user:{userId}` (all roles), `role:{role}`, `customer_{userId}` (compat), `technician_{technicianProfileId}` (tech ops), `admin_dashboard` + `admin` (Owner/Admin feed). DTOs: `Utils/socketDTO.js` (`toBookingCreated/Cancelled/JobNewDTO`). Socket files: `Middleware/socketAuth.js` (handshake `auth.token`-only JWT), `Middleware/socketRateLimiter.js` (20/min/IP), `Utils/ioAccess.js` (`setIo/getIo` singleton), `Utils/socketSessionControl.js` (single-session kick), `Utils/socketMetrics.js`, `Utils/broadcastMetrics.js`.

---

## M1 — Identity, Auth, RBAC, Account

**Purpose:** who the user is, how they prove it (OTP/password), what role they hold, and how every request/socket is gated.

### Schemas

| File | Key fields | Responsibility |
|---|---|---|
| `Schemas/User.js` | `role: Customer\|Technician\|Owner\|Admin` (indexed, required), `mobileNumber` unique 10-digit (or `deleted_*`), `email` sparse unique, `fname/lname/gender`, `password select:false optional`, `status: Active\|Inactive\|Blocked\|Deleted`, `profileComplete`, `lastLoginAt`, `fcmTokens[]`, `termsAndServices/privacyPolicy + At`, timestamps | Single canonical identity for all roles |
| `Schemas/Otp.js` | `identifier, role, otp bcrypt-hash, expiresAt TTL 5m, attempts, verified, purpose: SIGNUP\|LOGIN\|RESET_PASSWORD` | Hashed OTP store with attempt cap |
| `Schemas/TempUser.js` | `identifier, role unique(identifier,role), tempstatus, terms*/privacy*+At` | Pre-signup staging before `User` creation |

### Services / Utils

| File | Responsibility |
|---|---|
| `Services/authService.js` | `signupAndSendOtpInternal / resendOtpInternal / verifyOtpInternal / loginInternal / setPasswordInternal / acceptTermsInternal` + `signToken`; Owner invite-code gate, terms enforcement, `TempUser` upsert, OTP bcrypt+SMS, txn `User.create (+TechnicianProfile)` on verify, `PASSWORD_LOGIN` vs `OTP_SENT` branching |
| `Services/accountService.js` | Transactional self-delete + Owner-only `deleteUserById` (Owner quorum, technician snapshot preservation) |
| `Services/profileService.js` | Customer (`User`-only) vs Technician (`User+Profile+KYC`, encrypted bank) get/complete/update + admin list/detail aggregations |
| `Utils/token.js` | Central `signToken/verifyTokenOptions` (HS256, `JWT_SECRET`, P6 access lifetime `JWT_ACCESS_EXPIRES_IN` default 1h with `JWT_EXPIRES_IN` legacy fallback, optional iss/aud); payload `{userId, role, technicianProfileId?}` + P5 `tokenVersion/sid` |
| `Utils/ensureCustomer.js` (+ `Middleware/ensureCustomer.js` duplicate) | Customer-only guard (helper-throw vs middleware-next variants) |
| `Utils/ensureTechnician.js` | Technician-only helper variant |
| `Utils/phoneValidation.js` | `normalizeIndianMobile()` |

### Middleware

| File | Responsibility |
|---|---|
| `Middleware/Auth.js` | `Auth`: Bearer JWT verify → `User.status` gate (Blocked/Deleted) → resolve `technicianProfileId` (block `deleted` workStatus) → `req.user`; `authorizeRoles(...)` role gate (must follow `Auth`) |
| `Middleware/isTechnician.js` | `role==Technician` + `TechnicianProfile` exists → `req.technician` |
| `Middleware/ensureCustomer.js` | `role==Customer` + valid `userId` → `next()` |
| `Middleware/socketAuth.js` | Async `jwt.verify(handshake.auth.token)` (no query token) + same Deleted/Blocked/deleted-Tech checks → `socket.user` |

### Controllers / Routes

| File | Responsibility |
|---|---|
| `Controllers/User.js` | Thin HTTP wrappers over `authService/profileService`; role-forcing `technicianLogin/customerLogin/ownerLogin`, `verifyOtp/verifyLoginOtp/verifyTechnicianOtp`, `getMyProfile/completeProfile/updateMyProfile`, `getAllUsers/getUserById/deleteUserById/checkUserByIdentifier` |
| `Controllers/accountController.js` | `DELETE /delete-my-account` wrapper |
| `Routes/User.js` (mounted `/api/user`) | `POST /auth/login/request-otp`, `/auth/login/verify-otp`, `POST /auth/accept-terms (Auth)`, `DELETE /delete-my-account (Auth)`; `POST /signup|/resend-otp|/verify-otp|/set-password(Auth)|/login` (authLimiter/otpLimiter); `/signup/customer(+/verify-otp)`, `/login/customer(+/verify-otp)` (role-forced); `/login/owner`, `/owner/signup|/verify-otp|/set-password(Auth)|/login`; `GET /debug/check-user/:identifier (Auth+Owner/Admin)`; `GET /me`, `POST /complete-profile`, `PUT /me`; `GET /users/:role/:id`, `GET /users/:role`, `DELETE /users/:id (Owner only)`; plus category/service/rating/report/product/booking/payment/cart routes also mounted here (see their modules) |

### Flows

- **Signup:** `POST /signup[/customer|/technician|/owner/signup]` → normalize phone → Owner invite-code / Customer-Tech terms check → 409 if active `User` (anonymize if prior `Deleted`) → `TempUser` upsert → `deleteMany OTP(SIGNUP)` → random 4-digit + bcrypt + 5m TTL → SMS.
- **Login:** `POST /login[/customer|/technician|/owner]` → find `User` by mobile → `ROLE_MISMATCH` if requested≠stored → block `Blocked/Deleted` → privileged (Owner/Admin or `privileged:true`): bcrypt password → `PASSWORD_LOGIN + token`; else Customer/Tech: check Tech `workStatus≠deleted` → issue `LOGIN` OTP → `OTP_SENT`.
- **Verify:** `POST /verify-otp…` → latest `verified:false, unexpired` → attempts≥5 block → bcrypt compare → `SIGNUP`: txn create `User(+TechnicianProfile pending)` + cleanup + `signToken` (201); `LOGIN`: forbid Owner/Admin OTP, re-check blocks, `lastLoginAt=now`, `signToken` (200). `resendOtp`: 60s cooldown, reuse role/purpose. `setPassword (Auth)`: bcrypt≥8. `acceptTerms (Auth)`: patch flags.
- **HTTP gate:** `Auth` → `authorizeRoles(...)` on admin/Owner routes. **Socket gate:** `socketAuth` → `socket.user`.

---

## M2 — Technician (profile, onboarding, KYC, skills, location)

**Purpose:** everything that makes a `User(role=Technician)` employable: profile, GPS, skills, KYC/bank verification, training, online state.

### Schemas

| File | Key fields | Responsibility |
|---|---|---|
| `Schemas/TechnicianProfile.js` | `userId unique→User`, `profileImage`, `location` GeoJSON Point 2dsphere, `locality/address/city/state/pincode`, `experienceYears`, `serviceRadiusKm`, `specialization`, `certifications[]`, `skills[{serviceId, experienceYears}]`, `trainingCompleted`, `workStatus: pending\|trained\|approved\|suspended\|deleted`, `availability.isOnline`, `fcmTokens[]`, `rating{avg,count}`, wallet mirrors (`walletBalance/available/reserved/reserve/outstanding/lifetime*Paise`, `walletVersion`), `razorpayContactId/FundAccountId`, `payoutSettings`, `payoutBlocked/Reason`, `bankDetails` mirror, `totalJobsCompleted`, `profileComplete`, `jobRejectCount`, `lastMatchingAt/lastJobsChangeAt/locationUpdatedAt`, geo-permission fields (`primaryCityId/primaryDistrictId/allowedCityIds/enabledDistrictIds/enabledCityZoneIds/currentDistrictId/currentCityZoneId/cityZoneId/zoneMismatch*`), `dispatchLockUntil`, `isRead/readAt/readBy` | Technician operational profile (identity extension + dispatch state) |
| `Schemas/TechnicianKYC.js` | `technicianId unique`, `aadhaar/pan/dl` (Mixed plain-or-`{ciphertext,iv,authTag}`) + `documents{aadhaarUrl,panUrl,dlUrl}` (Cloudinary), `kycVerified`, `verificationStatus: pending\|approved\|rejected`, `rejectionReason/verifiedBy/At`, `bankDetails{holder/bank plain; accountNumber/ifsc/upiId encrypted; accountNumberHash}`, `bankVerified/status/fingerprint/updateRequired/editableUntil/verifiedBy/At`, `encryptedDek` | Encrypted identity + bank verification dossier |
| `Schemas/TechnicianSkillRequest.js` | `technicianId, serviceId, zone/district, reason, docs, status: pending\|approved\|rejected, reviewedBy/At` | Request queue for unmapped/new skills |
| `Schemas/TechnicianLocationHistory.js` | `technicianId, location Point, timestamp`, 2dsphere + 30-day TTL | GPS ping audit trail |

### Controllers / Services / Utils

| File | Responsibility |
|---|---|
| `Controllers/technician.js` | Self-service + admin god-controller: `updateTechnicianLocation`, `registerTechnicianFcmToken`, `add/removeTechnicianSkills` (zone-restricted gate), `getRegistrationDistricts/Zones`, `validateRegistrationLocation`, `getZoneServicesForTechnician`, `submit/getMyTechnicianSkillRequests`, `createTechnician` (GPS-validated onboarding), `getAll/getById/getMy/updateTechnician`, `updateTechnicianStatus/Training`, `uploadProfileImage`, `deleteTechnician` |
| `Controllers/technicianKycController.js` | Tech `submitTechnicianKyc/BankDetails`, `uploadTechnicianKycDocuments` (multer `kycUpload`), masked self/admin reads, audited `getTechnicianKycFull` (unmasked PII), admin `verifyTechnicianKyc` (training-gated) / `verifyBankDetails` (fingerprint) / update/delete/orphan-cleanup; encrypt/decrypt + signed URLs + offline enforcement |
| `Controllers/technicianSkillRequestController.js` | Admin `listTechnicianSkillRequests` (filter/paginate) + `reviewTechnicianSkillRequest` approve (push skill + auto-enable mapping) / reject + audit + push/in-app notify |
| `Services/technicianEligibilityService.js` + `Utils/technicianEligibility.js` | `BROADCAST` vs `ACCEPT` eligibility (approved/online/skilled/not-busy/fresh-GPS/permission/availability) |
| `Utils/technicianActivation.js` | Activation gate (KYC + training + workStatus) used by broadcast/matching/`getMyJobs` |
| `Utils/technicianLocation.js` | `handleLocationUpdate` (HTTP + socket path): persist location, history, `zoneMismatch`, broadcast revalidation |
| `Utils/technicianGeo.js`, `Utils/technicianJobFetch.js`, `Utils/findNearbyTechnicians.js` | Geo helpers, `fetchTechnicianJobsInternal` (socket `get_jobs`), `$nearSphere` + Haversine candidate search |
| `Utils/kycEncryption.js`, `Utils/kycFieldCrypto.js`, `Utils/kycPrivacy.js`, `Utils/kmsClient.js` | Field-level encrypt/decrypt (KMS envelope `encryptedDek`), PII masking for reads |
| `Routes/technician.js` (mounted `/api/technician`) | `POST /signup/technician(+/verify-otp)`; `GET /registration/districts\|/districts`, `/registration/zones\|/zones`, `POST /registration/validate-location`, `GET /registration/zone-services\|/zone-services(Auth+isTechnician)`; `POST|GET /skill-requests(Auth+isTechnician)`; `POST /login/technician`, `/login/technician/verify-otp`; `PUT /location(Auth+isTechnician+locationLimiter 12/min)`, `PUT /fcm-token`, `POST /technicianData(Auth)`, `GET /technicianAll\|/technicianById/:id\|/technician/me(Auth)`, `PUT /updateTechnician\|/technician/skills/add\|/remove(Auth+isTechnician)\|/technician/status`, `PUT /:technicianId/training`, `POST /technician/profile-image`, `DELETE /technicianDelete/:id`; KYC aliases (`/kyc`, `/technician/kyc`, `/banks`, `/technician/banks`, `/kyc/bank-details`, … + `/kyc/me`, `/kyc/:technicianId[/full]`, `PUT /kyc/verify`, `/kyc/bank/verify`, orphan `list/cleanup`); jobs (see M6); wallet subset (see M9); `GET /zone/me`, `/zone/services`; complaints subset (see M12) |
| `Routes/adminKycRoutes.js` (mounted `/api/admin`) | `GET /kyc`, `/kyc/orphaned/list`, `/kyc/:technicianId/full`, `/kyc/:technicianId`, `PUT /kyc/:technicianId`, `PUT /bank/:technicianId`, `PUT /kyc/:technicianId/verify`, `PUT /bank/:technicianId/verify`, `DELETE /kyc/orphaned/cleanup/all`, `/kyc/orphaned/:kycId`, `/kyc/:technicianId` |
| `Routes/adminSkillRequestRoutes.js` | `GET /technician-skill-requests`, `PUT /technician-skill-requests/:requestId/review` |

### Flow

`createTechnician` (GPS-validated district/zone + skill vs `ZoneServiceMapping`) → `submitKyc/BankDetails/Docs` → training + admin `verifyKYC` → `workStatus=approved` → online-gated (KYC+training+workStatus) → live pings (`TechnicianLocationHistory` + `zoneMismatch` + broadcast revalidation) → `addSkills` directly if mapped else `SkillRequest` → admin approve → dispatch-eligible.

---

## M3 — Geo / Zone / Permissions / Availability

**Purpose:** where the platform operates (districts → zones → polygons), which services sell where, and which technicians may work where.

### Schemas

| File | Key fields | Responsibility |
|---|---|---|
| `Schemas/OperationalCity.js` | `name, polygon: Polygon\|MultiPolygon + active/isRegistrationEnabled/isJobEnabled + status/version`, 2dsphere | Operational **District** polygon (code calls it city/district interchangeably) |
| `Schemas/CityZone.js` | `operationalCityId, name, zoneCode unique, polygon Mixed (Polygon\|MultiPolygon), active`, 2dsphere | Sub-zone inside a district |
| `Schemas/ZoneServiceMapping.js` | `zoneId+serviceId unique, active, pricingMultiplier` | Service-approved-per-zone gate |
| `Schemas/ServiceAvailability.js` | `serviceId+districtId+cityZoneId+scope unique; status DISTRICT/CITY/ZONE ENABLED/DISABLED`; CITY/ZONE overrides DISTRICT | Layered availability override |
| `Schemas/PolygonVersion.js` | polygon snapshots + `rollback` support | Geofence versioning / rollback |
| `Schemas/TechnicianDistrictPermission.js` | `technicianId+districtId unique, type PRIMARY/ADDITIONAL, isEnabled` | Per-tech district grant |
| `Schemas/DistrictPermissionHistory.js` | `GRANT/REVOKE/ENABLE/DISABLE + adminId+reason` | District-permission audit |
| `Schemas/TechnicianZonePermissionAudit.js` | zone grant/revoke audit | Zone-permission audit |
| `Schemas/Permission.js` + `Schemas/PermissionHistory.js` | `userId+deviceId: location/camera/notification/microphone` mirror (never OS-granted server-side) | Mobile OS-permission mirror |

### Controllers / Services / Utils

| File | Responsibility |
|---|---|
| `Controllers/operationalCityController.js` | Owner/Admin district CRUD + `active/registration/job` toggles + `primary/additional` tech listing + polygon-cache invalidation |
| `Controllers/cityZoneController.js` | Owner/Admin zone CRUD + bulk `ZoneServiceMapping` create/delete/toggle (syncs `ServiceAvailability ZONE`) + zone-candidate listing; new zones seed all services `DISABLED` |
| `Controllers/adminZoneGeofenceController.js` | Legacy geo console: district/zone create, `grant/revokeDistrictPermission`, `impact/hierarchy/dashboard`, `inspectJobLocation`, polygon rollback, admin tech list/details/verification, broadcast audit |
| `Controllers/adminTechnicianDistrictController.js` | Thin wrapper `GET/POST/PATCH/DELETE /admin/technicians/:technicianId/districts` → `technicianDistrictService` |
| `Controllers/adminTechnicianZoneController.js` | Granular `enabledCityZoneIds` grant/revoke gated on parent-district permission + audit + broadcast revalidation |
| `Controllers/adminServiceAvailabilityController.js` | `ServiceAvailability` CRUD + `toggle/bulkToggle/clear`, service `isActive` toggle, service-zone matrix/detail, `dispatchDiagnostics` (mapping sync + broadcast revalidation) |
| `Controllers/zoneAvailabilityController.js` | Customer `resolveCustomerZone/checkServiceAvailability` + tech `getMyZone/getServicesInMyZone` |
| `Controllers/permissionController.js` + `Utils/permissionService.js` | JWT-identity `PUT/GET /permissions` per-device upsert/fetch |
| `Services/districtService.js` | `getDistrictFromCoordinates(lat,lng)` via `$geoIntersects` on active districts |
| `Services/technicianDistrictService.js` | `syncAllowedCityIds/getAllowedDistricts/isAllowedInDistrict/add/toggle/remove` (primary-protection + legacy auto-heal + audit) |
| `Services/serviceAvailabilityService.js` | Single source of truth `resolveServiceAvailability()`: `Service.isActive > district active/job > zone exists/belongs/active > mapping mandatory > ZONE/CITY override > DISTRICT default > fallback` |
| `Utils/resolveZoneFromCoordinates.js`, `Utils/geoValidation.js`, `Utils/servicePolygon.js`, `Utils/locationConfig.js`, `Utils/feasibility.js` | GPS→district+zone resolve, polygon validate/sanitize, service-coverage polygon, business-TZ/slot config, travel-chain feasibility |

### Routes

| Mount | Endpoints |
|---|---|
| `operationalCityRoutes (/api/admin)` | `GET /districts\|/operational-cities\|/admin/districts`, `/operational-cities/active`, `/operational-cities/polygons`, `GET /districts/:id\|/operational-cities/:id\|/admin/districts/:id`, `POST /districts\|/operational-cities\|/admin/districts`, `PUT …`, `PATCH …/status\|/registration\|/jobs` (+ `/admin/…` aliases), `GET …/technicians`, `POST /operational-cities/:id/activate`, `DELETE …` |
| `adminZones (/api/admin)` | `GET|POST /zones`, `GET|PUT|DELETE /zones/:id`, `GET|POST /zone-mappings`, `DELETE /zone-mappings/:zoneId/:serviceId`, `PUT /zones/:zoneId/services/toggle`, `GET /zones/:zoneId/technician-candidates` |
| `adminZoneGeofenceRoutes (/api/admin/zone-geofence)` | `POST|PUT|GET /districts`, `GET /districts/:id/dashboard`, `POST|GET /city-zones`, `GET /technicians[/:id/details]`, `POST /technicians/:id/verification`, `POST /technicians/grant-district\|revoke-district`, `GET /spatial-hierarchy\|/impact-analysis\|/jobs/:bookingId/location-inspect\|/broadcast-audit\|/zone-health-dashboard\|/health-dashboard\|/live-monitor`, `POST /polygons/rollback` |
| `adminTechnicianDistrictRoutes (/api/admin)` | `GET|POST /technicians/:technicianId/districts`, `PATCH|DELETE …/districts/:districtId`, `GET /technicians/:technicianId/city-zones\|/zones`, `POST …/city-zones\|/zones/:zoneId/enable`, `DELETE|POST …/city-zones…(remove/disable)` |
| `adminServiceAvailabilityRoutes (/api/admin)` | availability CRUD/toggle/bulk/clear + matrix/detail/diagnostics |
| `userZones (/api)` + `technicianZones (/api/technician)` | `POST /zones/resolve`, `POST /zones/check-service`; `GET /zone/me`, `GET /zone/services` |
| `permissionRoutes` ×3 mounts | `PUT / + GET /` at `/api/admin/permissions`, `/api/technician/permissions`, `/api/user/permissions` (all `Auth`) |

### Flow

Customer GPS/address (or tech registration GPS) → `resolveDistrictAndZoneFromCoordinates(includeInactive)` → `resolveServiceAvailability()` → checkout/listing/matching gate (inactive / mismatch / missing mapping = BLOCK). Tech: registration GPS → primary district+zone + auto `TechnicianDistrictPermission` → admin grants ADDITIONAL districts/zones → matching checks GPS freshness + permission + availability.

---

## M4 — Catalog (Category / Service / Product / Commission)

**Purpose:** what the platform sells and what cut the platform takes.

### Schemas

| File | Key fields | Responsibility |
|---|---|---|
| `Schemas/Category.js` | `category(+slug), description, categoryType: service\|product, image, isActive` | Catalog grouping |
| `Schemas/Service.js` | `categoryId, pricing, commission, discount, GST, content, checklists, isActive, zoneRestricted, coveragePolygon`; pre-save auto `discount/commission/technicianAmount` | Sellable service (price + commission source) |
| `Schemas/Product.js` | `pricingModel, estimateRange, GST, quoteRequired, siteInspection, specs, warranty, AMC, FAQs`, text index | Sellable product (quote-driven) |
| `Schemas/ServiceCommissionRule.js` | `serviceId, commission%, effectiveFrom, setBy, version`; latest wins; bookings snapshot immutably | Versioned commission rule |

### Controllers / Utils

| File | Responsibility |
|---|---|
| `Controllers/categoryController.js` | `serviceCategory` (dup-guard by name+type), image upload/remove, `getAllCategory(byType)`, `getById`, `update(+slug)`, `delete` |
| `Controllers/serviceController.js` | `createService` (validated category+pricing), image add/remove/replace, `getAllServices` (location-aware: default-address/GPS + availability; tech hides pricing), `getById`, `update`, `delete`, coverage-polygon get/set/remove (audited), `toggleZoneRestriction` |
| `Controllers/productController.js` | `createProduct` (pricing-validated), image add/remove/replace, `getProduct` (text-search+paginate), `getOneProduct`, `updateProduct`, `deleteProduct` (blocked if active bookings) |
| `Controllers/adminCommissionController.js` | Commission-rule admin (create/list/per-booking override bookkeeping) |
| `Utils/commission.js`, `Utils/productPricing.js`, `Services/quotationPricingService.js` | `resolveCommissionSnapshot` (booking-time immutable snapshot), product/quote totals |

### Routes (all in `Routes/User.js` → `/api/user`)

- Category: `POST /category`, `POST /category/upload-image`, `DELETE /category/remove-image`, `GET /getAllcategory`, `GET /getByIdcategory/:id`, `PUT /updatecategory/:id`, `DELETE /deletecategory/:id` (writes: `Auth+Admin/Owner`).
- Service: `POST /service`, `POST /services/upload-images`, `DELETE /services/remove-image`, `PUT /services/replace-images`, `GET /getAllServices`, `GET /getServiceById/:id`, `PUT /updateService/:id`, `PUT /service/:id/zone-restriction`, `DELETE /services/:id`, `GET|PUT|DELETE /service/:id/polygon`.
- Product: `POST /product`, `POST /product/upload-images`, `DELETE /product/remove-image`, `PUT /product/replace-images`, `GET /getProduct`, `GET /getOneProduct/:id`, `PUT /updateProduct/:id`, `DELETE /deleteProduct/:id`.

### Flow

`Category(service|product)` → `Service/Product` CRUD (admin) → customer listing (`getAllServices` location-filtered, `getProduct` search) → price/commission snapshotted at booking/quote time (never live-read at settlement).

---

## M5 — Cart & Address

**Purpose:** staging area before money moves + where the job happens.

### Schemas

| File | Key fields | Responsibility |
|---|---|---|
| `Schemas/Cart.js` | `customerId, itemType: product\|service, itemId, quantity, scheduledAt+scheduledDate/Time/timezone, faultProblem`, unique `(customer,type,item)` | Per-customer staging list |
| `Schemas/Address.js` | `customerId, label home/work/other, addressLine, city/state/pincode, lat/lng paired, isDefault (unique partial)` | Saved address book |

### Controllers / Services / Utils

| File | Responsibility |
|---|---|
| `Controllers/cartController.js` | `addToCart` (upsert+inc), `getMyCart` (bulk populate), `updateCartItem/updateCartById`, `removeFromCart`, `setCartItemSchedule` (TZ-validated), `checkout` (txn: resolve location → strict district+zone gate → validate cart → `buildServiceBookingDoc` paise snapshot for services → create `ProductQuoteRequest` for products → clear cart → `matchAndBroadcastBooking`), unrestricted read/delete (ownership-checked) |
| `Controllers/addressController.js` → `Services/addressService.js` | Thin customer `search/reverse/create/list/get/update/delete/setDefault/getDefault` + admin reads |
| `Utils/resolveUserLocation.js` | Normalize `saved|gps` → `{label,line,city,state,pincode,lat,lng}` address snapshot |
| `Utils/slots.js` | Slot validation (Tomorrow/DayAfter, business TZ) |

### Routes

- Cart/checkout (`Routes/User.js` → `/api/user`): `POST /cart/add`, `GET /cart/my-cart`, `GET /cart/:id`, `PUT /cart/update`, `PUT /cart/:id`, `POST /cart/set-schedule`, `DELETE /cart/remove/:id`, `GET /carts/:id`, `DELETE /cart/removed/:id`, `POST /checkout` (all `Auth`).
- Address (`Routes/address.js` → `/api/addresses`): `GET /admin/all (Admin/Owner)`, `GET /admin/:id (Admin/Owner)`, `GET /search`, `GET /reverse`, `POST /`, `GET /`, `GET /default`, `PUT /`, `PUT /default`, `DELETE /` (all `Auth`).

### Flow

`Address(default drives listing)` → `Cart(service+schedule / product)` → `checkout`: service lines ⇒ `ServiceBooking` + broadcast; product lines ⇒ `ProductQuoteRequest` ⇒ quote flow (M7).

---

## M6 — Service Booking, Dispatch, Broadcast, Matching

**Purpose:** the core job lifecycle: create → broadcast → accept → execute → complete/cancel/expire.

### Schemas

| File | Key fields | Responsibility |
|---|---|---|
| `Schemas/ServiceBooking.js` | `customerId/serviceId/technicianId(+Snapshot)`, rupee price fields + immutable `financialSnapshot{paise}` + `paidAmountPaise`, `paymentStatus: pending\|paid\|refunded`, `settlementStatus: pending\|eligible\|settled`, `bookingType: instant\|schedule`, `status: pending\|broadcasted\|accepted\|on_the_way\|reached\|in_progress\|completed\|cancelled\|expired (+legacy SEARCHING/ACCEPTED/requested normalized pre-save)`, `assignmentStatus: unassigned\|broadcasted\|assigned\|released`, `cancellationStatus: active\|customer\|technician\|system_cancelled`, `cancellationFeeStatus`, TZ-local schedule fields, `estimatedArrivalAt`, `completedAt`, `activeBroadcastVersion`, `assignmentAttempts[]`, `leaseUntil/Owner`, `version`, `cancelReason/cancelledBy/cancellationFee(+Paise)/technicianPenalty(+Paise/debited)`, `retryCount/rejectCount`, `assignedAt`, `location` Point, `broadcastedAt/broadcastStartedAt/autoCancelAt`, `radius`, `workImages{before,after}`, `faultProblem`, `noShowAt`, `remindersSent{}`, `enforcementAlertAt`, `districtId/cityZoneId`; indexes: tech+status, settlement, 2dsphere, reminder/enforcement, lease | Canonical booking aggregate |
| `Schemas/BookingOutbox.js` | `bookingId, event booking_created, status pending\|inflight\|done\|failed, idempotencyKey=booking-created:<id>` | Booking-level TX outbox (broadcast only after commit) |
| `Schemas/DispatchOutbox.js` | `(booking×tech, kind=job_new)`, claim TTL + dedupe index + 24h TTL | Per-tech fan-out queue |
| `Schemas/TechnicianBroadcast.js` (`JobBroadcast`) | `bookingId+technicianId unique, version, status sent\|accepted\|rejected\|expired, expiresAt TTL` | Per-tech deliverable offer |
| `Schemas/TechnicianBookingOffer.js` | `(booking×tech): decision offered\|accepted\|declined\|expired\|superseded(+rejected write), distanceAtOffer/feasibilitySnapshot/latency` | Offer-funnel audit |
| `Schemas/TechnicianLocationHistory.js` | (see M2) | GPS trail feeding matching freshness |

### Controllers / Utils

| File | Responsibility |
|---|---|
| `Controllers/serviceBookController.js` | Customer `createBooking` (legacy inline) / `storeBookingSchedule` (transactional), `getBookings/getCustomerBookings`, `cancelBooking` (+fee table) / `getCancellationReasons`, deletes, Owner `getOwnerAllBookings/ById`, tech `updateBookingStatus` (`canTransition` + `version` CAS) / `uploadWorkImages`, `getTechnicianCurrentJobs/AcceptedJobs/AcceptedScheduledJobs/JobHistory`, `getAdminJobHistory`, `technicianCancelBooking` (₹200 penalty path), `acceptCancelledJob` (re-accept + admin penalty %) |
| `Controllers/bookAgainController.js` | `getCompletedServices` (completed+paid, grouped/list) + `rebookService` (ownership + live price + shared pipeline) |
| `Controllers/technicianBroadcastController.js` | `getMyJobs` (online/active-job/activation gates) + `respondToJob` accept/decline (atomic claim, winner/loser fan-out) |
| `Utils/bookingService.js` | Shared pipeline: `resolveServiceZoneAvailability/resolveScheduleInput/computeAutoCancelAt/buildServiceBookingDoc/createBookingAndOutbox/broadcastCreatedBooking/processBookingCreatedOutbox` |
| `Utils/bookingStatus.js` | `normalize/canTransition/isTerminal + BOOKING_TRANSITIONS` canonical machine |
| `Utils/technicianMatching.js` | `findEligibleTechniciansForService/matchAndBroadcastBooking/broadcastPendingJobsToTechnician/upsertTechnicianOffers/loadCommittedQueues/evaluateJobFeasibility` (approved/online/skilled/not-busy/fresh-GPS + district-permission + 10km `$nearSphere`+Haversine + polygon + zone filter) |
| `Utils/dispatchQueue.js` | `DispatchOutbox` worker (batch 50/conc 10/1.5s): pre-send booking-state check → `notifyTechnicianOfNewJob` |
| `Utils/bookingOutboxWorker.js` | `BookingOutbox` claim-poll → recheck aggregate → `matchAndBroadcastBooking` |
| `Utils/bookingCron.js` | Expiry/rebroadcast/OTW-timeout/enforcement/escalation/reminders/orphan-cleanup |
| `Utils/broadcastMetrics.js` | Broadcast funnel metrics |

### Routes

- Customer (`Routes/User.js` → `/api/user`): `GET /service/booking`, `GET /booking/slots`, `POST /booking/schedule`, `PUT /booking/cancel/:id`, `GET /booking/reasons`, `GET /booking/getCustomerBookings`, `DELETE /booking/deleteAll`, `DELETE /booking/:id`, `DELETE /booking/admin/:id (Admin/Owner)`, `GET /booking/completed-services`, `POST /booking/book-again`, `GET /booking/getAllBookings (Admin/Owner)`, `GET /booking/getBookingById/:id (Admin/Owner)`.
- Technician (`Routes/technician.js` → `/api/technician`): `GET /job-broadcast/my-jobs`, `PUT /job-broadcast/respond/:id`, `PUT /booking/technician/cancel/:id`, `PUT /booking/reaccept/:id`, `PUT /status/:id`, `POST /jobs/:id/work-images`, `GET /jobs/current|/jobs/accepted|/jobs/accepted/scheduled|/jobs/history`, `GET /admin/jobs/history`.
- Admin ops (`Routes/adminDispatchRoutes.js` → `/api/admin/dispatch`): `GET /stats|/failed|/pending|/health`, `POST /:id/retry|/retry-failed|/worker/restart|/worker/stop`.

### Lifecycle & happy path

`status`: `pending → broadcasted → accepted → on_the_way → reached → in_progress → completed` (sidelines `→ cancelled|expired`); `assignmentStatus`: `unassigned→broadcasted→assigned→released`; `cancellationStatus` + `cancellationFeeStatus` + `paymentStatus` + `settlementStatus` orthogonal.
Create (zone+slot+commission snapshot → `buildServiceBookingDoc(pending, autoCancelAt)`) → `createBookingAndOutbox` TX → `broadcastCreatedBooking → matchAndBroadcastBooking` (eligible-tech filter → `JobBroadcast(sent, version++)` + `booking→broadcasted` + `DispatchOutbox(job_new)` → socket `JOB_NEW` + FCM, worker retries) → tech `getMyJobs` → `respond accept` (atomic `findOneAndUpdate{status∈[pending,broadcasted], tech=null}` → `accepted/assigned`) → `status` progression (`version` CAS) → `completed` → `settleBookingEarningsIfEligible` + `PAYMENT_DUE` → pay (M8) → `book-again`-eligible.

---

## M7 — Product flow (QuoteRequest → Quotation → ProductBooking)

**Purpose:** quote-driven product sales: request → draft → send → view → accept (partial allowed) → order → pay → complete.

### Schemas

| File | Key fields | Responsibility |
|---|---|---|
| `Schemas/ProductQuoteRequest.js` | `requestNumber, customerId, productId(+items[]), snapshots, location/addressSnapshot, status: quote_requested→under_review→quotation_prepared→quotation_sent→viewed→accepted (+rejected/cancelled/expired), assignedAdminId, version, history`; single active thread per `(customer,product)` | Customer quote thread |
| `Schemas/Quotation.js` | `quotationNumber, quoteRequestId, customerId, productId(+items[{status pending\|accepted\|rejected}]), financialSnapshot paise immutable, status: draft→sent→viewed→accepted→converted (+rejected\|expired\|superseded), paymentStatus: unpaid\|paid\|partial, notificationStatus: pending\|queued\|sent\|failed\|retrying, rev/supersedes`; single-active `(sent,viewed)` guard | Versioned price offer |
| `Schemas/ProductBooking.js` | `customerId, productId, quotationId (sparse non-unique: multi-product), paymentGroupId, quoteRequestId, quantity, amount(+Paise snapshot), location/addressSnapshot, paymentStatus: pending\|paid\|refunded\|completed, status: active\|completed\|cancelled` | Product order |
| `Schemas/QuotationDelivery.js` | `(quotationId,channel,notificationType) unique; status pending\|queued\|sent\|delivered\|read\|failed` | Quotation outbox (in_app/whatsapp/sms/email) |

### Controllers / Services / Utils

| File | Responsibility |
|---|---|
| `Controllers/productQuoteRequestController.js` → `Services/productQuoteRequestService.js` | Customer `create/list/get/update/cancel` + admin `list/get/assign/status/delete`; single-thread lock, cancel-guard, `under_review` re-open |
| `Controllers/quotationController.js` → `Services/quotationService.js` + `quotationAcceptanceService.js` + `quotationPricingService.js` | Customer `list/get/view/accept(partial items→N bookings, paymentGroupId)/reject` + admin `createDraft/list/get/updateDraft/send(TX supersede+enqueue)/resend/revise/delete/paymentStatus`; totals server-recalculated |
| `Controllers/productBooking.js` | `list/detail` (commission stripped for non-admin), customer `update` (quantity-only, unpaid), `cancel`, admin `complete` (rating gate); money/payment server-controlled |
| `Services/quotationDeliveryService.js` | `enqueueDeliveries (TX)`, `processQuotationDeliveries (30s)`, `recordProviderCallback`, `expireQuotations (1h)` |
| `Utils/quotationStateMachine.js`, `Utils/quotationNumber.js` | `QUOTE_REQUEST_TRANSITIONS / QUOTATION_TRANSITIONS` guards + human-readable numbers |

### Routes

- Customer (`Routes/productQuoteRoutes.js` → `/api/user`): `POST /product-quote-requests | /product-quotes/request`, `PATCH /product-quote-requests/:id | /product-quotes/:id`, `GET /product-quote-requests | /product-quotes`, `GET /product-quote-requests/:id | /product-quotes/:id`, `POST /product-quote-requests/:id/cancel`, `GET /quotations`, `GET /quotations/:id`, `POST /quotations/:id/view|/accept|/reject|/decline`, `GET /product-bookings`, `GET /product-bookings/:id`; legacy in `Routes/User.js`: `GET /getAllProductBooking`, `PUT /productBookingUpdate/:id|/productBookingCancel/:id`, `PUT /admin/productBooking/:id/complete (Admin/Owner)`.
- Admin (`Routes/adminQuotationRoutes.js` → `/api/admin`): `GET|GET :id|POST :id/assign|PATCH :id/status|DELETE :id /product-quote-requests`, `POST|GET /quotations`, `GET|PATCH|PUT /quotations/:id`, `POST /quotations/:id/send|/resend|/revise`, `PATCH /quotations/:id/payment-status`, `DELETE /quotations/:id`, `GET /product-bookings[/:id]`, `PUT /product-bookings/:id/complete`, `POST /product-bookings/:bookingId/manual-payment`.

### Flow

Customer `POST product-quote-requests` (open-thread lock) → admin `assign` (`quote_requested→under_review`) → admin `POST quotations` (`draft revN`) → `send` (TX: supersede others → `sent`, request→`quotation_sent`, `enqueueDeliveries`) → customer `view` (`sent→viewed`) → `accept` (TX: claim + create 1..N `ProductBooking[paymentGroupId]`, request→`accepted`) / `reject` (request re-opens `under_review`) → pay (M8) → admin `complete` (rating gate) → rate (M12).

---

## M8 — Customer payments (Razorpay in)

**Purpose:** collect customer money against a booking snapshot, authoritatively reconciled via webhooks.

### Schemas

| File | Key fields | Responsibility |
|---|---|---|
| `Schemas/Payment.js` | `bookingId unique→ServiceBooking, itemType: service\|product\|quotation + paymentType: SERVICE\|PRODUCT\|QUOTATION, settlementType, provider: razorpay, mode: online\|offline\|cash\|bank_transfer\|upi_direct\|cheque\|other + offlineDetails{ref,receivedAt,recordedBy,notes}, currency INR, providerOrderId/PaymentId/Signature (unique partials), snapshot copy paise{base,total,commission(%,rule,ruleId,version),technician,gst,tip}, idempotencyKey, capturedAmountPaise, lastAttemptId, amountRefundedPaise, legacy rupee mirrors, status: pending\|success\|failed\|refunded\|manual_review, failureReason, verifiedAt, reconciliationAttempts/At` | Canonical per-booking payment (snapshot copy, never recomputed) |
| `Schemas/PaymentAttempt.js` | `paymentId, providerOrderId, amountPaise, status: created\|authorized\|captured\|failed\|expired, idempotencyKey, expiresAt` (+ sweeper) | Per-checkout in-flight attempt |
| `Schemas/PaymentEvent.js` | `eventId unique, payload, processed` | Raw webhook dedupe log |
| `Schemas/Receipt.js` | receipt per successful payment | Customer receipt |

### Controllers / Services / Utils / Routes

| File | Responsibility |
|---|---|
| `Controllers/paymentController.js` | `createPaymentOrder` (from booking snapshot), `verifyPayment` (fast HMAC), `razorpayWebhook payment.captured` (authoritative, `PaymentEvent` dedupe, amount guard), offline + manual override (`recordAdminOfflinePayment`), `retryPaymentSettlement`, `getPaymentByBooking`, `updatePaymentStatus` |
| `Controllers/customerPaymentController.js` | Customer read-model: `listMyPayments/getMyPaymentSummary/getMyPaymentDetail/getReceipt/getRefunds`, `initiatePayment/retryMyPayment/declareCashPayment` |
| `Services/paymentSettlementService.js` | Product/quote settlement: mark paid + `customer_payment` ledger + receipt + stock decrement |
| `Utils/razorpay.js`, `Utils/paymentTransitions.js`, `Utils/paymentAttempts.js`, `Utils/paymentReadModel.js`, `Utils/paymentCrons.js`, `Utils/attemptExpirySweeper.js`, `Utils/paymentNotificationWorker.js`, `Utils/money.js`, `Utils/receiptService.js` | Provider client, transition guards, attempt lifecycle, customer read-model builders, reconcile/settlement-backstop schedulers, expiry sweeper, realtime status worker, paise helpers, receipt builder |
| `Routes/customerPayments.js` (`/api/user/payments`) | `GET /`, `/summary`, `GET /:bookingId`, `/:bookingId/receipt`, `/:bookingId/refunds`, `POST /:bookingId/order|/retry|/cash/declare` (order paths rate-limited) |
| `Routes/User.js` (`/api/user`) legacy | `POST /payment/order`, `/payment/verify`, `POST /payment/webhook/razorpay` (no auth — HMAC), `PUT /payment/:id/status (Admin/Owner)`, `GET /payment/:bookingId`, `POST /payment/retry-settlement` |
| `Routes/adminPaymentRoutes.js` (`/api/admin/payments`) | `GET /product-payments`, `/product-payments/summary`, `POST /record-offline[/:bookingId]`, `PUT /:id/status`, `GET /booking/:bookingId`, `DELETE /booking/:id` (admin booking delete) |

### Flow

`initiatePayment` copies `booking.financialSnapshot` → `Payment(pending)` + Razorpay order → `verifyPayment` (HMAC fast path) / `razorpayWebhook payment.captured` (authoritative: `PaymentEvent` dedupe → amount guard → `markPaymentSucceeded` → `ledger: customer_payment + technician_earning_liability + platform_commission`, `booking.paymentStatus=paid`) → variants: ₹0 `free` instant success, admin offline success + ledger + receipt → `paymentCrons` reconcile + `settlement` backstop (M9).

---

## M9 — Settlement, Wallet, Withdrawal, Payout (RazorpayX out)

**Purpose:** move platform-held liability → technician wallet → real bank payout.

### Schemas

| File | Key fields | Responsibility |
|---|---|---|
| `Schemas/WalletTransaction.js` | `technicianId/bookingId/paymentId/withdrawalId, amountPaise, amount(legacy), type: credit\|debit, source: job\|tip\|withdraw\|adjustment\|bonus\|penalty\|refund, idempotencyKey unique sparse (job:<bookingId>, withdrawal:<id>, penalty:<bookingId>…)`; unique partial `(bookingId,type=credit,source=job)` | Append-only technician wallet ledger |
| `Schemas/WithdrawalRequest.js` | `technicianId, amountPaise, status: pending→processing→paid\|failed\|manual_review, reserve refs, dual-approval fields, fingerprint` | Payout request lifecycle |
| `Schemas/PayoutOutbox.js` | `withdrawalId, status: initiated\|completed\|failed\|manual_review, idempotency=withdrawalId` | RazorpayX send-vs-DB gap closer |
| `Schemas/PlatformLedgerEntry.js` | `type: customer_payment\|technician_earning_liability\|platform_commission\|technician_payout\|customer_refund\|commission_reversal\|mdr_loss\|processing_fee…, amountPaise, refs, idempotencyKey` | Platform cash single source of truth |
| `Schemas/BookingPayoutBlock.js` | payout blocks per booking | Payout gating |
| `Schemas/ReserveHold.js` | complaint-driven reserve freeze | Hold primitive (with `complaintFreeze`) |

### Controllers / Utils / Routes

| File | Responsibility |
|---|---|
| `Controllers/technicianWalletController.js` | `getTechnicianWallet/getWalletTransactions`, `updateMyPayoutSettings`, `requestWithdrawal` (KYC-bank/floor/dues/complaint/active-payout/cooldown gates → `available→reserved` + debit + `WithdrawalRequest(processing)`), `cancelMyWithdrawal`, `getWithdrawalReceipt`, `getMyWithdrawalRequests`, `createWalletTransaction` (legacy/manual) |
| `Controllers/adminWalletController.js` | `adminWalletSummary`, `approve/reject/payWithdrawal`, `adminManualPayoutToTechnician` (≥₹10k dual-approval), auto-payout config |
| `Controllers/financeController.js` | `adminFinanceSummary/Breakdown/PaymentsLedger`, per-tech detail, `technicianEarnings` |
| `Controllers/razorpayXController.js` + `Controllers/razorpayXWebhookController.js` + `Utils/razorpayX.js` | Contact/fund-account/payout thin wrapper + payout webhook → status finalize |
| `Utils/settlement.js` | `settleBookingEarningsIfEligible` (`paid+completed+Payment success` + snapshot match → `job:<id>/tip:<id>` credits + dues-first recovery) |
| `Utils/ledger.js` | Idempotent `postLedgerEntry` helpers |
| `Utils/withdrawalPayoutEngine.js` | Shared RazorpayX pipeline: KYC/fingerprint/dues/complaint re-gates + `PayoutOutbox` + success/failure settlement + notify |
| `Utils/autoPayout.js` | Threshold-based pre-approved `auto` requests via shared engine |
| `Utils/walletDebit.js` | Atomic wallet debit helper (penalty/clawback path) |
| `Routes/technicianWalletRoutes.js` (`/api/technician`) | `GET /wallet`, `/wallet/transactions`, `POST /wallet/withdrawal|/withdrawal/request`, `POST /wallet/withdrawal/:id/cancel`, `GET /wallet/withdrawal/:id/receipt`, `GET /wallet/withdrawalhistory`, `PUT /wallet/payout-settings` (all `Auth+isTechnician`) |
| `Routes/technician.js` legacy wallet subset | `POST /wallet/transaction`, `GET /wallet/history`, `POST /wallet/withdrawal[/request]`, `GET /wallet/withdrawalhistory/me`, `PUT /wallet/withdrawal/:id/cancel` |
| `Routes/financeRoutes.js` | `adminFinanceRoutes (/api/admin)`: `/finance/summary|breakdown|payments`; `technicianFinanceRoutes (/api/technician)`: `/finance/earnings` |
| `Routes/adminWalletRoutes.js` | Admin wallet/withdrawal approve-pay-manual endpoints |
| `Routes/razorpayXWebhookRoutes.js` (`/api`) | RazorpayX payout webhooks (signature-verified) |

### Flow

`completed+paid` → `settleBookingEarningsIfEligible` → `WalletTransaction credit job/tip` + `availableBalance += credit` (dues first) + `technician_earning_liability` ledger → `requestWithdrawal` (`available→reserved` + debit + request) → `withdrawalPayoutEngine.executeWithdrawalPayout` (re-gate → `PayoutOutbox(initiated)` → contact/fund/payout) → `paid` (reserved release, lifetime+, `technician_payout` ledger, outbox completed) / `failed` (reserve refund) / timeout (`manual_review`) → admin manual/dual-approval + `autoPayout (6h)` reuse same engine → `reconcileStuckPayouts (10m)` + `reconcileDailyLedger` heal orphans.

---

## M10 — Refunds, Disputes, Complaint holds

**Purpose:** return customer money correctly and claw back technician liability without leaking platform loss.

### Schemas

| File | Key fields | Responsibility |
|---|---|---|
| `Schemas/Refund.js` | `paymentId/bookingId(+bookingType product\|service)/customerId/technicianId, refundClass: restitution\|adjudication, reason, faultParty: technician\|platform\|customer\|none\|shared, sharePct, reportId, initiatedBy/approvedBy, gross/breakdown{base,gst,tip,product}/materialCost/net, clawback{required,applied,fromReserve,toDues}, commissionReversed, mdrLoss, processingFee, gstRecoverable, creditNoteId, rail: razorpay_reverse\|razorpayx_payout, speed, providerRefundId unique sparse, providerStatus, status: pending_execution\|initiated\|processed\|failed\|retrying\|manual_review\|unrefundable_source, attempts, lastError, awaitingApproval, idempotencyKey unique sparse, ledgerEntryIds` | Customer refund with full money breakdown |
| `Schemas/RefundOutbox.js` | `refundId, status: new\|processing\|done\|failed` | Async refund execution queue |
| `Schemas/CreditNote.js` | per-refund GST credit note + deadline/declared tracking | GST compliance artifact |
| `Schemas/Chargeback.js` | `status: open\|under_review\|contested\|won\|lost + evidence` | Provider dispute tracking |
| `Schemas/CustomerRefundPayout.js` | manual RazorpayX customer payout path | Non-reversible payout rail |
| `Schemas/ReconciliationException.js` | fingerprint-deduped inconsistency record | Admin finance-inconsistency surfacing |

### Controllers / Utils / Routes

| File | Responsibility |
|---|---|
| `Controllers/refundController.js` | `adminPreviewRefund` (allocation math) / `adminCreateRefund` / `adminApproveRefund` (second-admin over limit) / `adminRetryRefund` / `adminCreateCustomerPayoutRefund` (manual X path) / `adminListRefunds`, technician `technicianGetMyRefunds` |
| `Utils/refundEngine.js` | `computeRefundAllocation + createRefund` (reserve `amountRefundedPaise`, clawback, ledger, credit-note, outbox) + `refundWorker/executeRefund` (Razorpay reverse normal/optimum or X payout) + `reconcileRefunds` + `classARefundScanner` + `complaintSlaEscalation` |
| `Utils/refundPolicy.js` | Tunables from `GlobalSetting` (MDR, dual-approval threshold, windows, ClassA/B reasons) |
| `Utils/refundClawback.js` (+ `reverseClawback`) | Clawback cascade `ReserveHold → reserve/available → outstandingDues` + reversal on failure |
| `Utils/complaintFreeze.js` | `freezeForComplaint / releaseOnResolution / releaseExpiredHolds` (`ReserveHold→frozen` + `BookingPayoutBlock`) |
| `Routes/adminRefunds.js` (`/api/admin`) | `POST /refunds/preview|/refunds|/refunds/:id/approve|/retry|/customer-payout`, `GET /refunds`, `GET /complaints[/:id]`, `POST /complaints/:id/reject|/status`, `GET /complaints/categories` |
| `Routes/technicianRefunds.js` (`/api/technician`) | `GET /refunds (Auth+isTechnician)`, `GET /reports/categories` |

### Flow

`adminPreview` (net=`gross−material`, clawback=`net×techShare×sharePct`, commission reversal, MDR, fee, GST) → `createRefund` (atomic reserve + clawback + `customer_refund/commission_reversal/mdr_loss/processing_fee` ledger + `CreditNote` + `RefundOutbox(new)`) → `refundWorker` executes rail → `processed/failed` webhook + `reconcileRefunds`; failure → `reverseClawback` + reservation revert; over-limit → second admin; disputes → `Chargeback`, mismatches → `ReconciliationException`.

---

## M11 — Notifications, Realtime, Devices

**Purpose:** tell the right person on the right channel at the right time — socket first, push/SMS/WhatsApp as fallback — durably (outbox) and idempotently.

### Schemas

| File | Key fields | Responsibility |
|---|---|---|
| `Schemas/Notification.js` | `recipientId+recipientType: customer\|technician\|admin, eventType, title, body, data, priority low\|normal\|high\|critical, category, sourceType/Id, correlationId, idempotencyKey unique sparse, readAt/receivedAt/openedAt, expiresAt` | Persistent inbox record |
| `Schemas/NotificationOutbox.js` | `notificationId, status: pending→published→completed\|failed, lease` | Async dispatch driver |
| `Schemas/NotificationDelivery.js` | `(notificationId+channel) unique; channel: socket\|push\|sms\|whatsapp\|email; status` | Per-channel attempt tracker |
| `Schemas/NotificationPreference.js` | `userId: channel/category/DND/language prefs` | Per-user channel policy |
| `Schemas/DeviceToken.js` | `userId+deviceId unique → one active FCM token` (synced to legacy `User/TechnicianProfile.fcmTokens`) | FCM registry |

### Services / Utils

| File | Responsibility |
|---|---|
| `Services/notificationService.js` | Central `notify()`: event validation → idempotency check → template render → pref/DND+permission gate → `Notification + Delivery + Outbox` create; never throws |
| `Services/unifiedNotificationService.js` | Legacy immediate path `sendAppNotification()`: direct `Notification.create` + instant `io.to(user:)` emit + background push |
| `Services/quotationDeliveryService.js` | Quotation-only outbox: `enqueueDeliveries`, `processQuotationDeliveries` (in_app→Notification, whatsapp→Twilio), `recordProviderCallback` |
| `Utils/notificationWorker.js` | 5s poller: lease `pending` + reclaim stale `published` (>2m) → `dispatchByChannel` with retry/backoff → `completed/dead_letter` |
| `Utils/notificationTemplates.js` | `renderTemplate(event,lang,data)→{title,body}` (~30 events: booking/job/payment/complaint/quotation/OTP) |
| `Utils/notificationAdapters.js` | `dispatchByChannel`: `socketAdapter(io.to(room).emit)`, `pushAdapter(FCM)`, OTP-only `smsAdapter`; whatsapp/email stubbed |
| `Utils/sendNotification.js` | Hot-path realtime+push: `hasLiveSocket`, `notifyTechnicianOfNewJob` (activation+online+Redis dedupe), `broadcastJobToTechnicians`, `notifyCustomerJobAccepted`, `sendPushNotification` (gather+prune tokens), batch + socket→push fallback |
| `Utils/firebase.js` | Lazy FCM singleton (`righttouchmessaging-401e9`), `sendFcmMulticast`; missing creds → `{skipped:true}` |
| `Utils/sendSMS.js` / `Utils/sendWhatsapp.js` / `Utils/sendMail.js` | Fast2SMS DLT OTP SMS / Twilio OTP WhatsApp / Nodemailer (reserved) |
| `Utils/notificationMetrics.js` | Dispatch success/drop metrics (`/health/metrics`) |
| `config/notificationEvents.js` | Event policy: `defaultChannels/priority/category/dndAllowed/socketEvent/recipientTypes` (OTP→sms+whatsapp, admin→socket, most→socket+push) |

### Controllers / Routes / Sockets

| File | Responsibility |
|---|---|
| `Controllers/notificationController.js` | User inbox: cursor `list`, `unread-count`, `read/read-all/received/opened` scoped by `req.user.role` |
| `Controllers/adminNotificationController.js` | Admin badges (`ProductQuoteRequest/TechnicianProfile/Report where isRead≠true`) + `mark-read` + `broadcastAdminUnreadCounts(io)` → `admin_dashboard` |
| `Routes/notificationRoutes.js` (×3 mounts) | `GET /unread-counts`, `PATCH /mark-read` (admin badges) + `GET /`, `/unread-count`, `PATCH /:id/read`, `/read-all`, `POST /:id/received|/opened` at `/api/admin/notifications (Auth+Admin/Owner)`, `/api/technician/notifications (Auth+isTechnician)`, `/api/user/notifications (Auth)` |
| `Routes/deviceRoutes.js` (`…/device-token`, `Auth`) | `POST /` register, `DELETE /` unregister via `permissionService` |
| Socket runtime (`index.js` + Middleware) | `handshakeLimiter→socketAuth`, room joins, single-session kick, `TECH_LOCATION_UPDATE` (12/min acked), `TECH_GET_JOBS` (1/3s + `since≥lastJobsChangeAt` short-circuit) |

### Flow

`notify({eventType,recipient,data,source})` → event+idempotency check → preference/template/channel filter (+DND delay) → `Notification + Delivery + Outbox(pending)` → `notificationWorker` lease → `dispatchByChannel(socket→emit | push→FCM | sms→Fast2SMS)` with retries → `completed/dead_letter`. Fast path (`unifiedNotificationService/sendNotification.js`) emits directly + background FCM. Quotation path isolated via `QuotationDelivery` cron. Reads: user inbox + admin badges (`admin:unread_counts_updated` push).

---

## M12 — Support (Report/Complaint/Rating) & System (Settings/Audit/Dashboard)

**Purpose:** trust loop (complain → freeze → adjudicate → refund → release) + quality signal (ratings) + admin knobs and audit trail.

### Schemas

| File | Key fields | Responsibility |
|---|---|---|
| `Schemas/Report.js` | `bookingId, customerId, technicianId, category, description, status: open\|under_review\|resolved_refunded\|resolved_no_refund\|withdrawn\|expired, faultParty, refund/penalty refs, SLA deadline, freeze refs, isRead` | Complaint dossier |
| `Schemas/Rating.js` | `bookingId unique, technicianId, customerId, serviceId/productId, score 1-5, comment, content label`; rollup indexes | One rating per booking |
| `Schemas/GlobalSetting.js` | singleton `key→value` (`technician.reacceptPenaltyPercent`, `report.categories`, refund policy…) + `updatedBy` | Admin-tunable knobs (read live, no cache) |
| `Schemas/AuditLog.js` | `actor/action/targetType/targetId/before/after/reason/metadata` (immutable) | Money/status mutation trail |

### Controllers / Services / Utils

| File | Responsibility |
|---|---|
| `Controllers/complaintController.js` → `Services/complaintService.js` | New complaint API: customer create/withdraw/categories/mine; admin list/get/update/reject; tech list/detail/respond/refunds; lifecycle (validate window + no-open-duplicate → `open + slaDeadline+24h` → freeze → notify + audit + admin-unread → `under_review→resolved_*` → optional auto-refund + release + notify + audit) |
| `Controllers/reportController.js` | Legacy `/api/report*` compat shim → `complaintService` (maps `resolved→resolved_no_refund`) |
| `Controllers/ratingController.js` → `Services/ratingService.js` | Rating CRUD + `mine` + `rebuildAggregate`; guarded create (owns booking + `completed` + no duplicate; targets from booking) + averages rollup (`TechnicianProfile/Service/Product`) |
| `Controllers/adminSettingsController.js` | `GET/SET technician.reacceptPenaltyPercent (0-100)` + `writeAuditLog`; `getSettingValue/getReacceptPenaltyPercent` helpers |
| `Controllers/productDashboardController.js` | Turnover summary (`ProductBooking+Payment+Quotation+Product`), filtered sales report, `AuditLog` query |
| `Utils/reportCategories.js` | Static 7 + `GlobalSetting report.categories` override |
| `Utils/complaintFreeze.js` | `freezeForComplaint/releaseOnResolution/releaseExpiredHolds` |
| `Utils/audit.js` | Never-throws `writeAuditLog()` (optional txn session) |

### Routes

| Mount | Endpoints |
|---|---|
| `userReports (/api/user/reports)` | `POST /`, `GET /mine`, `GET /categories`, `POST /:id/withdraw` (all `Auth`) |
| `Routes/User.js` report/rating (`/api/user`) | `POST /report`, `GET /getAllReports (Admin/Owner)`, `GET /get-my-reports`, `GET /getReportById/:id (Admin/Owner)`, `PUT /report/resolve/:id (Admin/Owner)`; `POST /rating`, `GET /getAllRatings (Admin/Owner)`, `GET /ratings`, `/ratings/:id`, `/getRatingById/:id`, `PUT /updateRating/:id`, `DELETE /deleteRating/:id`, `GET /get-my-ratings`, `POST /admin/ratings/rebuild/:targetType/:targetId (Admin/Owner)`, `GET /admin/ratings (Admin/Owner)` |
| `Routes/technician.js` (`/api/technician`) | `GET /complaints`, `GET /complaints/:id`, `POST /complaints/:id/respond` (all `Auth+isTechnician`) |
| `Routes/adminRefunds.js` (`/api/admin`) complaints subset | `GET /complaints[/:id]`, `POST /complaints/:id/reject|/status`, `GET /complaints/categories` |
| `Routes/adminProductDashboardRoutes.js` (`/api/admin`) | `GET /product-dashboard`, `/product-reports/sales`, `/product-audit-logs[/:id]` |

### Flows

- **Complaint:** create (ownership + window + dedupe) → `open` + freeze + `COMPLAINT_RECEIVED/FILED_AGAINST_YOU` + audit + admin-unread → admin `under_review→resolved_refunded (→Refund M10) | resolved_no_refund` → `releaseOnResolution` (skip if other active complaint) → notify + audit; tech `respond` (evidence); customer `withdraw→withdrawn` + release; SLA cron escalates.
- **Rating:** `createService/ProductRating` → booking `completed`? → `Rating.create` → rollup averages.
- **Settings/audit:** `SET key→GlobalSetting(upsert)+AuditLog` → read live per-request (re-accept penalty, categories, refund policy).

---

## Appendix A — File → module index (every file)

| Layer | File | Module |
|---|---|---|
| Schema | `Address.js` | M5 |
| Schema | `AuditLog.js` | M12 |
| Schema | `BookingOutbox.js` | M6 |
| Schema | `BookingPayoutBlock.js` | M9 |
| Schema | `Cart.js` | M5 |
| Schema | `Category.js` | M4 |
| Schema | `Chargeback.js` | M10 |
| Schema | `CityZone.js` | M3 |
| Schema | `CreditNote.js` | M10 |
| Schema | `CustomerRefundPayout.js` | M10 |
| Schema | `DeviceToken.js` | M11 |
| Schema | `DispatchOutbox.js` | M6 |
| Schema | `DistrictPermissionHistory.js` | M3 |
| Schema | `GlobalSetting.js` | M12 |
| Schema | `Notification.js` | M11 |
| Schema | `NotificationDelivery.js` | M11 |
| Schema | `NotificationOutbox.js` | M11 |
| Schema | `NotificationPreference.js` | M11 |
| Schema | `OperationalCity.js` | M3 |
| Schema | `Otp.js` | M1 |
| Schema | `Payment.js` | M8 |
| Schema | `PaymentAttempt.js` | M8 |
| Schema | `PaymentEvent.js` | M8 |
| Schema | `PayoutOutbox.js` | M9 |
| Schema | `Permission.js` | M3 |
| Schema | `PermissionHistory.js` | M3 |
| Schema | `PlatformLedgerEntry.js` | M9 |
| Schema | `PolygonVersion.js` | M3 |
| Schema | `Product.js` | M4 |
| Schema | `ProductBooking.js` | M7 |
| Schema | `ProductQuoteRequest.js` | M7 |
| Schema | `Quotation.js` | M7 |
| Schema | `QuotationDelivery.js` | M7/M11 |
| Schema | `Rating.js` | M12 |
| Schema | `Receipt.js` | M8 |
| Schema | `ReconciliationException.js` | M10 |
| Schema | `Refund.js` | M10 |
| Schema | `RefundOutbox.js` | M10 |
| Schema | `Report.js` | M12 |
| Schema | `ReserveHold.js` | M9/M10 |
| Schema | `Service.js` | M4 |
| Schema | `ServiceAvailability.js` | M3 |
| Schema | `ServiceBooking.js` | M6 |
| Schema | `ServiceCommissionRule.js` | M4 |
| Schema | `TechnicianBroadcast.js` | M6 |
| Schema | `TechnicianBookingOffer.js` | M6 |
| Schema | `TechnicianDistrictPermission.js` | M3 |
| Schema | `TechnicianKYC.js` | M2 |
| Schema | `TechnicianLocationHistory.js` | M2/M6 |
| Schema | `TechnicianProfile.js` | M2 |
| Schema | `TechnicianSkillRequest.js` | M2 |
| Schema | `TechnicianZonePermissionAudit.js` | M3 |
| Schema | `TempUser.js` | M1 |
| Schema | `User.js` | M1 |
| Schema | `WalletTransaction.js` | M9 |
| Schema | `WithdrawalRequest.js` | M9 |
| Schema | `ZoneServiceMapping.js` | M3 |
| Controller | `accountController.js` | M1 |
| Controller | `addressController.js` | M5 |
| Controller | `adminCommissionController.js` | M4 |
| Controller | `adminNotificationController.js` | M11 |
| Controller | `adminServiceAvailabilityController.js` | M3 |
| Controller | `adminSettingsController.js` | M12 |
| Controller | `adminTechnicianDistrictController.js` | M3 |
| Controller | `adminTechnicianZoneController.js` | M3 |
| Controller | `adminWalletController.js` | M9 |
| Controller | `adminZoneGeofenceController.js` | M3 |
| Controller | `bookAgainController.js` | M6 |
| Controller | `cartController.js` | M5 |
| Controller | `categoryController.js` | M4 |
| Controller | `cityZoneController.js` | M3 |
| Controller | `complaintController.js` | M12 |
| Controller | `customerPaymentController.js` | M8 |
| Controller | `financeController.js` | M9 |
| Controller | `notificationController.js` | M11 |
| Controller | `operationalCityController.js` | M3 |
| Controller | `paymentController.js` | M8 |
| Controller | `permissionController.js` | M3 |
| Controller | `productBooking.js` | M7 |
| Controller | `productController.js` | M4 |
| Controller | `productDashboardController.js` | M12 |
| Controller | `productQuoteRequestController.js` | M7 |
| Controller | `quotationController.js` | M7 |
| Controller | `ratingController.js` | M12 |
| Controller | `razorpayXController.js` | M9 |
| Controller | `razorpayXWebhookController.js` | M9 |
| Controller | `refundController.js` | M10 |
| Controller | `reportController.js` | M12 |
| Controller | `serviceBookController.js` | M6 |
| Controller | `serviceController.js` | M4 |
| Controller | `technician.js` | M2 |
| Controller | `technicianBroadcastController.js` | M6 |
| Controller | `technicianKycController.js` | M2 |
| Controller | `technicianSkillRequestController.js` | M2 |
| Controller | `technicianWalletController.js` | M9 |
| Controller | `User.js` | M1 |
| Controller | `zoneAvailabilityController.js` | M3 |
| Service | `accountService.js` | M1 |
| Service | `addressService.js` | M5 |
| Service | `authService.js` | M1 |
| Service | `complaintService.js` | M12 |
| Service | `districtService.js` | M3 |
| Service | `notificationService.js` | M11 |
| Service | `paymentSettlementService.js` | M8 |
| Service | `productQuoteRequestService.js` | M7 |
| Service | `profileService.js` | M1 |
| Service | `quotationAcceptanceService.js` | M7 |
| Service | `quotationDeliveryService.js` | M7/M11 |
| Service | `quotationPricingService.js` | M4/M7 |
| Service | `quotationService.js` | M7 |
| Service | `ratingService.js` | M12 |
| Service | `serviceAvailabilityService.js` | M3 |
| Service | `technicianDistrictService.js` | M3 |
| Service | `technicianEligibilityService.js` | M2/M6 |
| Service | `unifiedNotificationService.js` | M11 |
| Middleware | `Auth.js` | M1 |
| Middleware | `ensureCustomer.js` | M1 |
| Middleware | `isTechnician.js` | M1 |
| Middleware | `socketAuth.js` | M1/M11 |
| Middleware | `socketRateLimiter.js` | M11 |
| Route | `address.js` → `/api/addresses` | M5 |
| Route | `adminDispatchRoutes.js` → `/api/admin/dispatch` | M6 |
| Route | `adminKycRoutes.js` → `/api/admin` | M2 |
| Route | `adminPaymentRoutes.js` → `/api/admin/payments` | M8 |
| Route | `adminPermissionRoutes.js` → `/api/admin/permissions` | M3 |
| Route | `adminProductDashboardRoutes.js` → `/api/admin` | M12 |
| Route | `adminQuotationRoutes.js` → `/api/admin` | M7 |
| Route | `adminRefunds.js` → `/api/admin` | M10/M12 |
| Route | `adminServiceAvailabilityRoutes.js` → `/api/admin` | M3 |
| Route | `adminSkillRequestRoutes.js` → `/api/admin` | M2 |
| Route | `adminWalletRoutes.js` → `/api/admin` | M9 |
| Route | `adminZoneGeofenceRoutes.js` → `/api/admin/zone-geofence` | M3 |
| Route | `adminZones.js` → `/api/admin` | M3 |
| Route | `customerPayments.js` → `/api/user/payments` | M8 |
| Route | `deviceRoutes.js` → `…/device-token` (×2 mounts) | M11 |
| Route | `financeRoutes.js` → `/api/admin` + `/api/technician` | M9 |
| Route | `notificationRoutes.js` → ×3 mounts | M11 |
| Route | `operationalCityRoutes.js` → `/api/admin` | M3 |
| Route | `permissionRoutes.js` → ×3 mounts | M3 |
| Route | `productQuoteRoutes.js` → `/api/user` | M7 |
| Route | `razorpayXWebhookRoutes.js` → `/api` | M9 |
| Route | `technician.js` → `/api/technician` | M2/M6/M9/M12 |
| Route | `technicianRefunds.js` → `/api/technician` | M10 |
| Route | `technicianWalletRoutes.js` → `/api/technician` | M9 |
| Route | `technicianZones.js` → `/api/technician` | M3 |
| Route | `User.js` → `/api/user` | M1/M4/M5/M6/M7/M8/M12 |
| Route | `userReports.js` → `/api/user/reports` | M12 |
| Route | `userZones.js` → `/api` | M3 |
| Util/Worker | `attemptExpirySweeper.js` | M8 |
| Util/Worker | `autoPayout.js` | M9 |
| Util/Worker | `bookingCron.js` | M6 |
| Util/Worker | `bookingOutboxWorker.js` | M6 |
| Util/Worker | `bookingService.js` | M6 |
| Util/Worker | `bookingStatus.js` | M6 |
| Util/Worker | `dispatchQueue.js` | M6 |
| Util/Worker | `ledger.js` / `settlement.js` | M9 |
| Util/Worker | `notificationWorker.js` + `notificationTemplates/Adapters/Metrics` | M11 |
| Util/Worker | `paymentCrons.js` / `paymentNotificationWorker.js` / `paymentAttempts.js` / `paymentReadModel.js` / `paymentTransitions.js` | M8 |
| Util/Worker | `quotationStateMachine.js` / `quotationNumber.js` | M7 |
| Util/Worker | `refundEngine.js` / `refundPolicy.js` / `refundClawback.js` / `complaintFreeze.js` | M10 |
| Util | `audit.js` | M12 |
| Util | `commission.js` / `productPricing.js` | M4 |
| Util | `firebase.js` / `sendSMS/Whatsapp/Mail/Notification` | M11 |
| Util | `ioAccess.js` / `socketConstants/DTO/Metrics/SessionControl` | M11 |
| Util | `resolveUserLocation.js` / `resolveZoneFromCoordinates.js` / `geoValidation/servicePolygon/locationConfig/feasibility/slots` | M3/M5 |
| Util | `technicianLocation/JobFetch/Geo/Eligibility/Activation/Matching` | M2/M6 |
| Util | `kycEncryption/FieldCrypto/Privacy/kmsClient` | M2 |
| Util | `money.js` / `constants.js` / `token.js` / `phoneValidation` / `redisDedupe` / `cloudinaryUpload` / `razorpay(X)` / `secretValidation` / `reportCategories` / `sendReminder` / `receiptService` / `walletDebit` / `permissionService` | cross-cutting |

## Appendix B — Schema-field quick reference (per module)

- **M1:** `User{role,mobileNumber unique,email sparse unique,password select:false,status,profileComplete,lastLoginAt,fcmTokens,terms*/privacy*+At}` · `Otp{identifier,role,otp-hash,expiresAt TTL,attempts,verified,purpose}` · `TempUser{identifier+role unique,tempstatus,terms*+At}`.
- **M2:** `TechnicianProfile{userId unique,location 2dsphere,skills[],trainingCompleted,workStatus,availability,fcmTokens,rating,wallet*Paise,payout/bank mirrors,geo-permission ids,zoneMismatch,dispatchLock,jobRejectCount,last*At,isRead}` · `TechnicianKYC{technicianId unique,ids Mixed+urls,verificationStatus,bank encrypted+hash/fingerprint,encryptedDek}` · `SkillRequest{tech,service,zone/district,reason,docs,status}` · `LocationHistory{tech,point,ts TTL30d}`.
- **M3:** `OperationalCity{name,polygon(active/reg/job toggles),status,version}` · `CityZone{operationalCityId,zoneCode unique,polygon Mixed,active}` · `ZoneServiceMapping{zone+service unique,active,pricingMultiplier}` · `ServiceAvailability{service+district+zone+scope unique,status}` · `TechnicianDistrictPermission{tech+district unique,type,isEnabled}` · `*History/Audit` · `Permission{user+device: 4 mirrors}`.
- **M4:** `Category{category+slug,type,image,isActive}` · `Service{categoryId,pricing,commission,discount,GST,content,checklists,isActive,zoneRestricted,coveragePolygon}` · `Product{pricingModel,estimateRange,GST,quoteRequired,siteInspection,specs,warranty,AMC,FAQs}` · `ServiceCommissionRule{serviceId,%,effectiveFrom,setBy,version}`.
- **M5:** `Cart{customer,itemType,itemId,quantity,scheduledAt/Date/Time/timezone,faultProblem}` unique triple · `Address{customer,label,line,city/state/pincode,lat/lng,isDefault partial-unique}`.
- **M6:** `ServiceBooking` (see §M6 table: 5 parallel machines + geo + version/lease + attempts + reminders) · `BookingOutbox{booking_created}` · `DispatchOutbox{job_new per tech}` · `TechnicianBroadcast{unique pair,version,expiresAt}` · `BookingOffer{funnel audit}`.
- **M7:** `ProductQuoteRequest{requestNumber,customer,product(+items),snapshots,location/address,status,assignedAdmin,version,history}` · `Quotation{quotationNumber,request,customer,product(+items[].status),snapshot paise,status,paymentStatus,notificationStatus,rev}` · `ProductBooking{customer,product,quotationId sparse,paymentGroupId,quoteRequestId,qty,amount*Paise,location/address,paymentStatus,status}` · `QuotationDelivery{(quotation,channel,type) unique}`.
- **M8:** `Payment{bookingId unique,snapshot paise copy,provider ids unique partials,idempotencyKey,capturedAmountPaise,lastAttemptId,amountRefundedPaise,legacy rupees,status}` · `PaymentAttempt{created\|authorized\|captured\|failed\|expired}` · `PaymentEvent{eventId unique}` · `Receipt`.
- **M9:** `WalletTransaction{tech/booking/payment/withdrawal,amountPaise,type,source,idempotencyKey unique}` · `WithdrawalRequest{pending→processing→paid\|failed\|manual_review}` · `PayoutOutbox{initiated\|completed\|failed\|manual_review}` · `PlatformLedgerEntry{typed append-only + idempotency}` · `BookingPayoutBlock` · `ReserveHold`.
- **M10:** `Refund{…gross/breakdown/material/net,clawback×4,commissionReversed,mdrLoss,processingFee,gstRecoverable,rail,speed,providerRefundId unique,status,attempts,idempotencyKey}` · `RefundOutbox{new\|processing\|done\|failed}` · `CreditNote` · `Chargeback{open\|…\|lost}` · `CustomerRefundPayout` · `ReconciliationException{fingerprint}`.
- **M11:** `Notification{recipientId+Type,eventType,title,body,data,priority,category,source,correlationId,idempotencyKey unique,read/received/opened,expiresAt}` · `NotificationOutbox{pending→published→completed\|failed}` · `NotificationDelivery{(notification,channel) unique}` · `NotificationPreference{user prefs}` · `DeviceToken{user+device unique}`.
- **M12:** `Report{booking/customer/tech,category,status,faultParty,refund/penalty,SLA,freeze,isRead}` · `Rating{bookingId unique,tech/customer/service/product,score,comment}` · `GlobalSetting{key→value + updatedBy}` · `AuditLog{actor/action/target/before/after/reason}`.

## Appendix C — Worker / cron schedule

| Cadence | Job | File |
|---|---|---|
| 1m | instant OTW-timeout, scheduled enforcement/escalation | `bookingCron.js` |
| 5m | booking expiry; refund reconcile | `bookingCron.js`, `refundEngine.js` |
| 10m | rebroadcast; payout reconcile | `bookingCron.js`, `paymentCrons.js` |
| 15m | payment reconcile + settlement backstop; reserve-freeze expiry | `paymentCrons.js`, `complaintFreeze.js` |
| 30m | orphan broadcast cleanup | `bookingCron.js` |
| 30s | refund worker; quotation deliveries | `refundEngine.js`, `quotationDeliveryService.js` |
| 2m | ClassA refund scanner | `refundEngine.js` |
| 5s | notification worker | `notificationWorker.js` |
| 1h | complaint SLA escalation; quotation expiry | `refundEngine.js`, `quotationService.js` |
| 6h | auto-payout | `paymentCrons.js`/`autoPayout.js` |
| daily | ledger audit | `paymentCrons.js` |
| 60s | socket metrics log | `socketMetrics.js` |
| continuous | dispatch queue; booking outbox; attempt sweeper; payment-notify worker | `dispatchQueue.js`, `bookingOutboxWorker.js`, `attemptExpirySweeper.js`, `paymentNotificationWorker.js` |
