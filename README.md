# RightTouch Backend Server

**Private & Confidential — Internal Use Only**

This repository and its documentation are proprietary. Do not distribute, publish, or share this document outside the organization. Environment configuration, credentials, infrastructure details, and API route contracts are intentionally excluded and are maintained separately in the private engineering runbook.

---

## Table of Contents

- [Overview](#overview)
- [Key Features](#key-features)
- [Tech Stack](#tech-stack)
- [System Architecture](#system-architecture)
- [Project Directory Structure](#project-directory-structure)
- [Database Data Models](#database-data-models)
- [Real-Time & Background Processing](#real-time--background-processing)
- [Security & Privacy](#security--privacy)
- [Testing](#testing)
- [License](#license)

---

## Overview

The **RightTouch Backend** powers an electronics and home-appliance services marketplace with product commerce. It manages the complete operational lifecycle for four primary roles:

- **Customers**: discover services and products, create bookings, track technician progress, make payments, raise complaints, and manage their account.
- **Technicians**: receive nearby job offers, accept and complete work, stream GPS location, manage availability and KYC, and withdraw earnings.
- **Admins**: configure operational cities and service zones, review KYC, generate quotations, manage bookings and refunds, and monitor operations.
- **Owners**: oversee platform finances, commission rules, permissions, reconciliation, and system-wide reporting.

---

## Key Features

### Service Booking & Technician Matching

- Server-side pricing and immutable financial snapshots for every booking.
- Slot validation, operational-zone availability checks, and technician feasibility checks.
- Geospatial matching using service radius, district and zone permissions, skills, KYC state, and GPS freshness.
- Version-guarded, transactional booking acceptance to prevent double assignment.
- Scheduled and instant booking lifecycles with expiry, reminders, and re-dispatch.
- Customer-confirmed completion using a one-time code with attempt and resend limits.

### Real-Time Job Broadcast & Dispatch

- Broadcast offers only to technicians who are online, nearby, eligible, and permitted for the service and zone.
- Transactional outbox and dispatch queues so an offer is never delivered before the booking is committed.
- Retry, backoff, stale-offer detection, and duplicate-suppression safeguards.
- Offer expiry and re-broadcast when a technician declines, cancels, or becomes ineligible.
- Live technician feed with change notifications instead of aggressive polling.
- Operational metrics for broadcast delivery, skipped offers, and failures.

### GPS, Presence & Geofencing

- Live GPS ingestion with coordinate validation and freshness thresholds.
- Movement-aware location updates that avoid unnecessary database writes.
- Redis geospatial index for fast nearby-technician pre-filtering, with database fallback.
- Presence tracking with explicit online/offline control.
- Current district and zone resolution from live coordinates.
- Zone-drift detection and eligibility revalidation after movement.
- Short-retention location history for operational and audit use.

### Technician Lifecycle & KYC

- Technician onboarding, skills, training, activation, suspension, and soft deletion.
- District and zone permission management with audit history.
- KYC submission, review, approval, rejection, and bank verification.
- Field-level encryption for sensitive identity and bank data.
- Signed access to private KYC documents and audited full-PII access.
- Online prerequisites that enforce approved KYC, training, and account standing.

### Product Catalog & Quotations

- Product catalog, cart, and product booking flows.
- Customer product quote requests with requirement details.
- Admin-authored quotations with line-item pricing, delivery, and validity rules.
- Quotation state machine with acceptance, rejection, expiry, and delivery tracking.
- Quotation-to-booking conversion with immutable pricing snapshots.

### Payments, Wallets, Ledger & Payouts

- Customer payment collection through Razorpay with server-side signature and webhook verification.
- Payment attempts, retries, reconciliation, and manual-review handling.
- Integer-paise money model with commission, GST, tip, and technician-share snapshots.
- Platform ledger entries with idempotency keys for financial auditability.
- Technician wallet with available, reserved, and lifetime balances.
- Manual NEFT payouts with admin approval and UTR tracking.
- Reserve holds, payout blocks, outstanding dues, and clawback support.
- Refund workflow with allocation, approval, provider execution, and reconciliation hooks.
- Receipts and financial reporting for customers, technicians, admins, and owners.

### Complaints & Dispute Resolution

- Customer complaints and technician disputes tied to bookings.
- SLA tracking, admin review, and resolution outcomes.
- Optional refund and penalty handling with payout/reserve protection.
- Audit logging for every administrative decision.

### Notifications

- Unified delivery pipeline for in-app socket events, Firebase push, email, SMS, and WhatsApp.
- Notification outbox with retries and delivery tracking.
- Preferences and device-token management per user.
- Transactional notifications for bookings, payments, payouts, quotations, and complaints.

### Platform Operations

- Operational city, district, zone, and service-availability management.
- GeoJSON service coverage and zone polygon validation.
- Commission rules by service, city, or zone with historical versions.
- Admin permissions and role-based access controls.
- Audit logs for sensitive operations.
- Health checks, graceful shutdown, and background-worker lifecycle management.

---

## Tech Stack

| Domain | Technology |
| --- | --- |
| Runtime | Node.js, native ES Modules |
| Web Framework | Express 5 |
| Database | MongoDB with Mongoose 8 |
| Real-Time | Socket.IO 4 with Redis adapter support |
| Cache & Geospatial Index | Redis |
| Payments | Razorpay |
| Cloud Storage | Bunny Storage (with legacy Cloudinary compatibility) |
| Push Notifications | Firebase Cloud Messaging |
| Email | SendGrid, Nodemailer, Resend |
| SMS & WhatsApp | Fast2SMS, Twilio |
| Image Processing | Sharp |
| Security | Helmet, JWT, bcrypt, rate limiting, input sanitization |

---

## System Architecture

```text
                               +---------------------------+
                               |   Clients & Web Apps      |
                               | Customer / Tech / Admin   |
                               +-------------+-------------+
                                             |
                                             | HTTPS / WebSockets
                                             v
+--------------------------------------------------------------------------------+
|                                Express 5 Server                                |
|                                                                                |
|  +-----------------------+   +-----------------------+   +------------------+  |
|  |  Security & Auth      |   |   Controllers Layer   |   |  Socket.IO       |  |
|  |  Helmet / Sanitizer   |-->| Bookings, Payments,   |-->| Sessions, GPS,   |  |
|  |  JWT / Rate Limiting  |   | KYC, Admin, Quotations|   | Job Feed         |  |
|  +-----------------------+   +-----------+-----------+   +------------------+  |
|                                          |                                     |
|                                          v                                     |
|                              +-----------------------+                         |
|                              |    Services Layer     |                         |
|                              | Business & Financial  |                         |
|                              +-----------+-----------+                         |
+------------------------------------------+-------------------------------------+
                                           |
        +----------------------------------+----------------------------------+
        |                                  |                                  |
        v                                  v                                  v
+---------------+                 +-----------------+                +------------------+
| MongoDB       |                 | Redis           |                | Background       |
| Domain models |                 | Cache, GEO,     |                | Workers & Crons  |
| and ledgers   |                 | pub/sub         |                | Outbox, refunds  |
+---------------+                 +-----------------+                +------------------+
```

The application follows a layered design:

- **Routes** define access boundaries and middleware.
- **Controllers** handle request/response concerns.
- **Services and utilities** hold business rules, state machines, financial logic, and integrations.
- **Schemas** define persistence, validation, and indexes.
- **Workers and crons** process outboxes, expiry, reconciliation, reminders, and notifications.

Critical financial and assignment operations use MongoDB transactions, optimistic version checks, and idempotency keys.

---

## Project Directory Structure

```text
RighttouchServerNew/
├── config/                     # Notification events and system configuration
├── Controllers/                # Request handlers by domain
│   ├── serviceBookController.js
│   ├── technicianBroadcastController.js
│   ├── paymentController.js
│   ├── adminWalletController.js
│   ├── technicianKycController.js
│   └── ...
├── Middleware/                 # Authentication, authorization, socket auth, rate limits
├── Routes/                     # Role and domain route registration
├── Schemas/                    # Mongoose models, indexes, and retention rules
├── Services/                   # Business services (auth, quotations, complaints, ratings)
├── Utils/                      # Money, ledger, matching, GPS, outbox, crons, integrations
├── scripts/                    # Operational and backfill scripts
├── postmancollection/          # Internal API collection assets
├── test/                       # Automated test suites
├── index.js                    # Application entry point, HTTP/Socket.IO setup, workers
├── package.json
└── README.md
```

Detailed API contracts, environment configuration, deployment topology, and operational credentials are maintained in the private engineering runbook.

---

## Database Data Models

The data layer is organized by domain:

- **Identity & Accounts**: users, temporary users, OTPs, technician profiles, KYC records, permissions, audit history, device tokens, addresses.
- **Services & Bookings**: services, categories, service bookings, booking outbox, dispatch outbox, technician offers, broadcasts, ratings, completion challenges.
- **Products & Quotations**: products, carts, product quote requests, quotations, quotation delivery, product bookings.
- **Geography & Zones**: operational cities, city zones, zone-service mappings, polygons.
- **Financials & Ledgers**: payments, payment attempts, payment events, platform ledger entries, wallet transactions, withdrawal requests, commission rules, receipts, reserve holds, chargebacks, payout blocks, customer refund payouts, payout/refund outboxes.
- **Complaints & Refunds**: reports, refunds, reconciliation exceptions.
- **Notifications & Audit**: notifications, notification deliveries, notification outbox, preferences, audit logs, global settings.

Financial amounts are stored as integer paise, with legacy rupee mirrors retained only where required for reporting compatibility.

---

## Real-Time & Background Processing

### Real-Time Layer

- Authenticated WebSocket sessions with database-authoritative roles.
- One active session per identity, with older sessions replaced on new login.
- Short-disconnect recovery so transient network drops do not lose state.
- Throttled GPS streaming to protect database capacity.
- Push-based job-feed change notifications with cursor-based refresh.
- Room-scoped delivery so customers, technicians, and admins only receive relevant events.

### Background Workers

- Booking expiry, auto-cancel, reminders, and escalation.
- Broadcast and dispatch outbox processing.
- Payment attempt expiry and payment-status notifications.
- Refund retries, reconciliation, and complaint SLA escalation.
- Quotation delivery and expiry.
- Notification outbox processing across push, email, SMS, and WhatsApp.
- Technician presence and eligibility revalidation.
- Periodic orphaned-record cleanup and financial reconciliation.

Workers start only after the database is ready and are stopped during graceful shutdown.

---

## Security & Privacy

- Helmet security headers and configurable CORS.
- JWT authentication with algorithm pinning, token-version revocation, and role checks resolved from the database.
- Blocked, suspended, and deleted accounts are rejected on both HTTP and WebSocket paths.
- Rate limiting for HTTP, authentication, OTP, location updates, and socket handshakes.
- Recursive NoSQL-operator sanitization for request parameters, query, and body.
- Request body size limits and controlled upload validation.
- Field-level encryption for sensitive technician identity and bank data.
- Signed URLs for private KYC documents.
- Audited access to full technician PII.
- Server-side payment signature and webhook verification.
- Idempotency protection and transactional writes on financial paths.
- Structured audit logging for sensitive administrative actions.
- Secrets, environment configuration, and deployment credentials are never stored in this document or committed to the repository.

Security reports and suspected vulnerabilities must be routed privately to the engineering and security owners.

---

## Testing

The project uses Node's native test runner. Run the configured suite with:

```bash
npm test
```

The deployment pipeline is expected to validate syntax, dependencies, and automated tests before releasing to production. Test data, fixtures, and internal credentials must never be committed.

---

## License

This project is proprietary and confidential. Unauthorized copying, distribution, modification, or disclosure is prohibited.

Powered by **FlareMinds Tech**.
