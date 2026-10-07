# Customer Flow — RightTouch Backend

End-to-end journey of a **Customer** through the RightTouch API, traced from
the actual route/controller/service code. Base URL: `http://localhost:7372`
(`{{baseUrl}}` in Postman). All authenticated calls send
`Authorization: Bearer {{customerToken}}`.

Standard envelope — success: `{ success: true, message, result }`;
failure: `{ success: false, message, code?, result/details? }`.

Related docs: `Role-Profiles-And-Authentication-Flows.md` (auth detail),
`User-Profile-Roles-How-It-Works.md` (profile model),
`Realtime-Concepts-Polling-Dispatch-Socket.md` (socket detail),
`BACKEND_MODULES_RESPONSIBILITIES.md` (module map).

---

## Stage 0 — Authentication (OTP, passwordless for customers)

Customers authenticate with **mobile OTP only** (no passwords).

| Step | Method & Path | Body | Success |
|---|---|---|---|
| 1. Request signup OTP | `POST /api/user/signup/customer` | `{ identifier|mobileNumber, termsAndServices: true, privacyPolicy: true }` | 200 `OTP sent successfully` |
| 2. Verify signup OTP | `POST /api/user/signup/customer/verify-otp` | `{ identifier, otp }` | **201** `Account created successfully`, `result: { token, refresh_token, expires_in, user, technicianProfileId: null }` |
| 3. Request login OTP | `POST /api/user/login/customer` | `{ identifier }` | 200 `OTP sent successfully` (`purpose: LOGIN`) |
| 4. Verify login OTP | `POST /api/user/login/customer/verify-otp` | `{ identifier, otp }` | 200/201 `Login successful`, same `result` shape as step 2 |
| Generic aliases | `POST /api/user/signup`, `/verify-otp`, `/login`, `/auth/login/request-otp`, `/auth/login/verify-otp` | same, with `role: "Customer"` | same |

Notes:

- `identifier` and `mobileNumber` are interchangeable (10 digits, optional +91).
- Save `result.token` as `{{customerToken}}` and `result.refresh_token` for Stage 0b.
- Wrong OTP → 400 `OTP_INVALID` (5 attempts, then 429). Expired/reused OTP → 400 `OTP_INVALID_OR_EXPIRED`. Resend via `POST /api/user/resend-otp` (60s cooldown → 429 `OTP_COOLDOWN`).
- Duplicate signup on a registered number → 409 `MOBILE_ALREADY_EXISTS`.

### Stage 0b — Persistent sessions (P5)

| Step | Method & Path | Body | Success |
|---|---|---|---|
| Refresh (rotation) | `POST /api/user/auth/refresh` | `{ refresh_token }` (also accepts `refreshToken`) | 200 `Token refreshed successfully`, `result: { token, refresh_token, expires_in: 3600 }` (P6: short-lived 1h access tokens; `expires_in` always equals the real access lifetime). Old refresh token dies immediately (replay → 401 + theft protection: whole token family revoked). |
| Logout (one device) | `POST /api/user/auth/logout` _(auth)_ | — | 200 `Logged out successfully`, `result: { revoked: true }`. Current session dies now; other devices unaffected. Active socket for that session is disconnected (`session:revoked`). |
| Logout (all devices) | `POST /api/user/auth/logout-all` _(auth)_ | — | 200 `Logged out from all devices successfully`. All sessions revoked, global token version bumped, all sockets disconnected. |

Missing/malformed refresh → 400; unknown/expired/revoked/reused → 401
`REFRESH_INVALID` (uniform — no session oracle). Deleted/blocked/inactive
accounts and suspended technicians are rejected on refresh (403, P2 codes).

## Stage 1 — Profile

| Step | Method & Path | Body | Success |
|---|---|---|---|
| Read profile | `GET /api/user/me` _(auth)_ | — | 200 `result` = user doc (`profileComplete`, names, email, …) |
| First-time completion | `POST /api/user/complete-profile` _(auth)_ | `{ fname, lname, gender?, email? }` | 200, `profileComplete: true` |
| Update profile | `PUT /api/user/me` _(auth)_ | any of `fname, lname, gender, email` (`password/status/userId/profileComplete` are ignored) | 200 updated user |
| Accept terms | `POST /api/user/auth/accept-terms` _(auth)_ | `{ termsAndServices, privacyPolicy }` | 200 |
| Delete own account | `DELETE /api/user/delete-my-account` _(auth)_ | — | 200 (all sessions revoked; refresh can never restore access) |

## Stage 2 — Addresses & service-area resolution

| Step | Method & Path | Body | Success |
|---|---|---|---|
| Add address | `POST /api/addresses` _(auth)_ | `{ label: home\|work\|other, name, phone, addressLine, city, state, pincode, latitude?, longitude?, isDefault? }` | 200/201 created address (`addressId`) |
| List / default | `GET /api/addresses`, `GET /api/addresses/default` _(auth)_ | — | 200 |
| Update / default / delete | `PUT /api/addresses`, `PUT /api/addresses/default`, `DELETE /api/addresses` _(auth)_ | address fields / `{ addressId }` | 200 |
| Resolve GPS → zone | `POST /api/zones/resolve` _(auth)_ | `{ latitude, longitude }` | 200 district + city-zone |
| Check service in zone | `POST /api/zones/check-service` _(auth)_ | `{ serviceId, latitude, longitude }` (or zone ids) | 200 availability verdict |

Rule of thumb (FINAL catalog rules): with no usable location you get the
FULL active catalog + `availabilityPrompt`; with a resolved address/GPS
you get the zone-filtered catalog (District + Zone both required);
outside all polygons → empty list.

## Stage 3 — Browse catalog (public reads)

`GET /api/user/getAllcategory`, `/getByIdcategory/:id`,
`GET /api/user/getAllServices`, `/getServiceById/:id`,
`GET /api/user/getProduct`, `/getOneProduct/:id`. No auth required.
Each service carries pricing, GST, warranty, `zoneRestricted` flag.

## Stage 4 — Service booking (two equivalent rails)

**Rail A — Cart → Checkout (recommended for app flow):**

| Step | Method & Path | Body |
|---|---|---|
| 1. Add to cart | `POST /api/user/cart/add` _(auth)_ | `{ itemType: "service", itemId: serviceId, quantity?, scheduledAt?, faultProblem? }` |
| 2. View cart | `GET /api/user/cart/my-cart` _(auth)_ | — |
| 3. Set schedule | `POST /api/user/cart/set-schedule` _(auth)_ | `{ cartId, scheduledAt }` — must be tomorrow/day-after-tomorrow (business timezone) |
| 4. Checkout | `POST /api/user/checkout` _(auth)_ | `{ addressId }` **or** ad-hoc `{ addressLine, city, state, pincode, latitude, longitude }`, plus `scheduledAt?`, `name?`, `phone?` |

**Rail B — Direct booking:** `POST /api/user/booking/schedule` _(auth)_
`{ serviceId, faultProblem?, addressId?|address fields|lat+lng, locationType: saved|gps, scheduledAt?|slot fields }`.

Both rails snapshot server-side pricing (immutable financial snapshot),
resolve District + Zone, and open a broadcast to eligible technicians.
Instant booking (no `scheduledAt`) dispatches immediately; scheduled
bookings enforce start-travel reminders. History:
`GET /api/user/booking/getCustomerBookings`; cancel:
`PUT /api/user/booking/cancel/:id`; re-book a finished service:
`POST /api/user/booking/book-again`; slots:
`GET /api/user/booking/slots`.

## Stage 5 — Live tracking (Socket.IO + push)

Connect with `handshake.auth.token = {{customerToken}}`. The customer
auto-joins `user:<userId>` and `customer_<userId>` rooms and receives:

| Event | Meaning |
|---|---|
| `booking:accepted` (legacy `job_accepted`) | a technician took the job |
| `notification:new` | any titled alert (status moves, reminders) |
| `booking:reminder` / `booking:rebroadcast` | schedule reminders / re-dispatch notices |
| `payment:status` | payment state changes |
| `refund:initiated` / `refund:processed` / `refund:failed` | refund lifecycle |
| `session:revoked` | logged out elsewhere → re-authenticate |

Technician live location flows through the booking detail/location
endpoints once assigned.

## Stage 6 — Payment (Razorpay online, or cash)

| Step | Method & Path | Body | Notes |
|---|---|---|---|
| 1. Create order | `POST /api/user/payments/:bookingId/order` _(auth)_ | — (+ optional `Idempotency-Key` header) | returns Razorpay order + amount split |
| 2a. Verify online payment | handled via `POST /api/user/payment/verify` _(auth)_ | Razorpay payment payload | marks payment success → receipt |
| 2b. Declare cash | `POST /api/user/payments/:bookingId/cash/declare` _(auth)_ | cash declaration | offline path, admin-confirmed |
| Retry | `POST /api/user/payments/:bookingId/retry` _(auth)_ | — | 409 `ALREADY_PAID` / `PAYMENT_IN_FLIGHT` guards |
| Read | `GET /api/user/payments[/summary\|/:bookingId\|/:bookingId/receipt\|/:bookingId/refunds]` _(auth)_ | — | history, GST receipt, refund status |

Webhook `POST /api/user/payment/webhook/razorpay` is gateway-to-server
(signature-verified) — not called by apps.

## Stage 7 — Product quotations (custom-price flow)

| Step | Method & Path |
|---|---|
| 1. Request quote | `POST /api/user/product-quote-requests` _(auth)_ `{ productId?, items?, quantity?, requirementDescription, locationType, addressSnapshot?, preferredContactMethod? }` (alias: `POST /api/user/product-quotes/request`) |
| 2. Track | `GET /api/user/product-quote-requests`, `/product-quotes`, `/:id` _(auth)_; cancel `POST .../:id/cancel`; edit `PATCH .../:id` |
| 3. Review quotation (admin-priced) | `GET /api/user/quotations[/:id]` _(auth)_; mark seen `POST .../:id/view` |
| 4. Decide | `POST /api/user/quotations/:id/accept` → converts to `ProductBooking` _(auth)_ · `.../decline` or `.../reject` |
| 5. Track purchase | `GET /api/user/product-bookings[/:id]` _(auth)_ |

## Stage 8 — After service: ratings, complaints, refunds

| Step | Method & Path |
|---|---|
| Rate (service/product/tech) | `POST /api/user/rating` _(auth)_ `{ bookingId, rates 1-5, comment? }`; mine: `GET /api/user/get-my-ratings`, `/ratings`, `/ratings/:id`; edit `PUT /api/user/updateRating/:id`; delete `DELETE /api/user/deleteRating/:id` |
| Complain | `POST /api/user/reports` _(auth)_ `{ bookingId, complaint, category?, images? }`; mine: `GET /api/user/reports/mine`; categories: `GET /api/user/reports/categories`; withdraw: `POST /api/user/reports/:id/withdraw`; legacy: `POST /api/user/report`, `GET /api/user/get-my-reports` |
| Refund status | `GET /api/user/payments/:bookingId/refunds` _(auth)_ + `refund:*` socket events |

Refunds are admin-executed (approve → gateway reverse or RazorpayX
payout); customers only observe status.

## Stage 9 — Notifications, devices, permissions

| Step | Method & Path |
|---|---|
| Inbox | `GET /api/user/notifications` _(auth)_, `GET .../unread-count[s]` |
| Mark read | `PATCH .../mark-read`, `.../read-all`, `.../:id/read`, `POST .../:id/received\|.../opened` |
| Register device (FCM) | `POST /api/user/device-token` _(auth)_ `{ deviceId, platform: android\|ios\|web, fcmToken }`; remove: `DELETE /api/user/device-token` |
| Report OS permission state | `PUT /api/user/permissions` _(auth)_; read: `GET /api/user/permissions` |

## Error-code quick reference (customer-visible)

| Code | HTTP | When |
|---|---|---|
| `OTP_INVALID` / `OTP_INVALID_OR_EXPIRED` | 400 | wrong / stale / reused OTP |
| `OTP_COOLDOWN` | 429 | resend within 60s |
| `MOBILE_ALREADY_EXISTS` | 409 | signup on a registered number |
| `SERVICE_NOT_AVAILABLE` / `ZONE_*` | 400 | outside service area / zone |
| `NOT_PAYABLE` / `ALREADY_PAID` / `PAYMENT_IN_FLIGHT` | 400/409 | payment guards |
| `REFRESH_INVALID` | 401 | bad/expired/revoked/reused refresh (uniform) |
| `SESSION_REVOKED` | 401 | logged-out / logout-all access token |
| `TECHNICIAN_SUSPENDED`, `ACCOUNT_INACTIVE/BLOCKED/DELETED` | 403 | account-state gates |

## Happy-path checklist (smoke test order)

1. Signup → verify-otp (201, store `token` + `refresh_token`)
2. `POST complete-profile` → `GET /me`
3. `POST /api/addresses` (default) → `POST /api/zones/resolve`
4. `GET getAllServices` → `POST cart/add` → `POST checkout`
5. Watch `booking:accepted` on socket → `GET payments/:bookingId`
   → `POST payments/:bookingId/order` → verify → `GET .../receipt`
6. `POST /api/user/rating`
7. `POST /api/user/auth/refresh` (rotate) → `POST /auth/logout`
