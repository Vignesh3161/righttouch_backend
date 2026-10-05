# Folder Structure

Every backend domain lives in its own folder. Cross-cutting code lives in `shared/`.
Root holds only entry, docs, tooling: `index.js` (boot), `swagger.js`, `package.json`,
`scripts/`, `postman/`, `docs/`.

```text
modules/
  identity/        M1  Auth, OTP/JWT, roles, account      controllers/ routes/ models/ services/ utils/
  technician/      M2  Profile, onboarding, KYC, skills   controllers/ routes/ models/ services/ utils/
  geo/             M3  Districts, zones, permissions      controllers/ routes/ models/ services/ utils/
  catalog/         M4  Category, Service, Product        controllers/ models/ services/ utils/
  cart-address/    M5  Cart, Address, checkout staging   controllers/ routes/ models/ services/ utils/
  booking/         M6  Booking lifecycle + dispatch      controllers/ routes/ models/ utils/
  quote-product/   M7  Quote requests, quotations        controllers/ routes/ models/ services/ utils/
  payments/        M8  Razorpay in, attempts, webhooks    controllers/ routes/ models/ services/ utils/
  payouts/         M9  Ledger, wallet, RazorpayX out     controllers/ routes/ models/ utils/
  refunds/         M10 Refunds, clawback, holds          controllers/ routes/ models/ utils/
  notifications/   M11 Socket, FCM, SMS, mail            controllers/ routes/ models/ services/ utils/
  support-system/  M12 Complaints, rating, settings      controllers/ routes/ models/ services/ utils/
shared/
  middleware/  Auth, isTechnician, ensureCustomer, socketAuth, socketRateLimiter
  utils/       money, constants, token-observer(ioAccess), socket*, audit,
               cloudinaryUpload, secretValidation, redisDedupe, ensure*
  config/      notificationEvents, google-services
```

## Layer rules

| Layer | May contain | Must NOT contain |
|---|---|---|
| `routes/` | paths + limiters + `Auth`/`authorizeRoles` only | business logic, direct DB calls |
| `controllers/` | thin req↔service mapping | status-machine writes, money math |
| `services/` | business rules, transactions | HTTP req/res objects |
| `models/` | Mongoose schemas, indexes, hooks | queries from other domains |
| `utils/` | pure helpers, workers, crons | cross-module business rules |

## Conventions

- Imports are ESM relative with explicit `.js` extension.
- A module may import from another module (e.g. booking → geo availability), but the
  **state owner** is single: booking status only via `modules/booking/utils/bookingStatus.js`,
  money truth via `modules/payouts` ledger, notify via `modules/notifications`.
- `shared/` never imports from `modules/` (dependency flows one way: modules → shared).
- New files go in the owning module's layer folder. New cross-cutting helpers go in `shared/utils/`.
- Runtime file paths (credentials, uploads) resolve from repo root — see
  `modules/notifications/utils/firebase.js`.

## Realtime & delivery concepts per module

Full end-to-end analysis: `docs/Realtime-Concepts-Polling-Dispatch-Socket.md`.
Short version — there is **no HTTP long-polling** in this codebase:

- **Worker poll loops** (timer + atomic claim over a Mongo outbox): booking owns
  `dispatchQueue` + `bookingOutboxWorker` + `bookingCron`; notifications owns
  `notificationWorker` + quotation delivery; payments/payouts/refunds own their
  sweeper/reconcile/retry workers. Same pattern everywhere, no external queue infra.
- **Push-primary job feed** (replaces client polling): server emits
  `technician:jobs_changed` on every feed mutation; `technician:get_jobs` is a
  cursor-polled fallback (`since` vs `lastJobsChangeAt` short-circuit, 1/3 s cap).
- **Dispatch queue** (booking): `DispatchOutbox` (one row per booking×technician,
  same TX as the broadcast) + bounded worker (50/batch, 10 concurrent, pre-send
  booking-status guard, exponential backoff ×6 → failed). Operated via
  `/api/admin/dispatch/*`.
- **Socket layer** (notifications + `index.js`): handshake limiter → `socketAuth` →
  rooms (`user:` / `role:` / `technician_` / `admin_dashboard`) → acked
  `location_update` (12/min/tech) / `get_jobs` handlers, single-session kick,
  stable wire DTOs in `shared/utils/socketDTO.js`.
