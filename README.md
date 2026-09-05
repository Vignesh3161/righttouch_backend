# RightTouch Backend Server API (`righttouch_backend`)

An enterprise-grade, high-performance Node.js REST API and real-time WebSocket server powering the **RightTouch** Electronics & Home Appliance Services and Product E-Commerce Platform. Built with Express 5, Mongoose 8, Socket.IO 4, and automated financial settlement engines.

---

## 📋 Table of Contents

- [Overview](#-overview)
- [Key Features](#-key-features)
- [Tech Stack](#-tech-stack)
- [System Architecture](#-system-architecture)
- [Project Directory Structure](#-project-directory-structure)
- [Database Data Models](#-database-data-models)
- [API Namespaces & Route Map](#-api-namespaces--route-map)
- [Real-Time WebSockets Architecture](#-real-time-websockets-architecture)
- [Automated Background Workers & Crons](#-automated-background-workers--crons)
- [Environment Configuration](#-environment-configuration)
- [Local Setup & Installation](#-local-setup--installation)
- [Testing](#-testing)
- [Security & Performance Hardening](#-security--performance-hardening)

---

## 🚀 Overview

The **RightTouch Backend** manages end-to-end operational workflows for home appliance repair, maintenance services, and custom product sales. The server provides robust role-based functionality for four primary user types:
- **Customers**: Browse services/products, book technician visits, request custom product quotations, track technicians in real-time, process payments, and manage support reports.
- **Technicians**: Real-time job discovery, broadcast acceptance, live GPS location updates, automated wallet management, KYC verification, and payout withdrawals.
- **Admins**: Operational city & zone mapping, technician KYC adjudication, quotation creation & pricing, customer refund processing, dynamic commission rules, and service allocation.
- **Owners**: System-wide analytical reports, platform financial ledger management, administrative permission delegation, and platform settings configuration.

---

## ✨ Key Features

### 1. 🛠 Service Booking & Technician Matching Engine
- **Geospatial Availability**: Polygon-based city zone matching with dynamic technician eligibility scanning.
- **Broadcast & Dispatch Queue**: Transactional outbox pattern ensuring broadcast alerts are sent only after booking commit (`DispatchQueue` / `BookingOutbox`).
- **State Machine Lifecycle**: Strict status transitions (`PENDING_BROADCAST` → `ACCEPTED` → `ARRIVED` → `IN_PROGRESS` → `COMPLETED` / `CANCELLED`).

### 2. 🏷 Product Catalog & Quotation Lifecycle
- **Quote Requests & Custom Offers**: Customers submit tailored requirements (`ProductQuoteRequest`); Admins generate line-item pricing proposals (`Quotation`).
- **Immutability & State Safeguards**: Enforces state machine integrity (`quote_requested` → `quotation_prepared` → `ACCEPTED` / `REJECTED`), preventing illegal modifications on finalized contracts.
- **Quotation-to-Booking Conversion**: Automated workflow converting accepted quotations into formal `ProductBooking` entries.

### 3. 💳 Financial Ledger, Wallets & Automated Payouts
- **Double-Entry Platform Ledger**: Complete auditability via `PlatformLedgerEntry` tracking gross revenue, platform commissions, reserve holds, and tax deductions.
- **Razorpay & RazorpayX Integration**: Live customer payment collection alongside automated technician bank payouts via RazorpayX.
- **Wallet & Clawback System**: Real-time balance calculations, automated withdrawal approvals, reserve holds, and complaint freeze mechanisms.

### 4. ⚡ Real-Time Socket.IO Infrastructure
- **Single Active Session**: Ensures one user identity per live socket connection; automatically terminates duplicate device connections.
- **Connection State Recovery**: Gracefully replays missed events during brief mobile network dropouts without dropping state.
- **Throttled GPS Stream**: Per-technician rate-limiting (1 ping/5s) protecting database resources from excessive updates.

### 5. 🛡 Complaint & Refund Resolution Engine
- **Class A Restitution vs Class B Adjudication**: Automated SLA tracking, instant refund triggers for policy-matched disputes, and administrative manual reviews.
- **Customer Refund Outbox**: Asynchronous refund payouts (`CustomerRefundPayout`), credit notes generation, and automated reserve release.

### 6. 🔔 Multi-Channel Notification Dispatcher
- **Unified Delivery Engine**: Outbox pattern supporting Socket.IO (In-App), Firebase Cloud Messaging (FCM Push), SendGrid/Nodemailer/Resend (Email), and Twilio (SMS/WhatsApp).

---

## 💻 Tech Stack

| Domain | Technology | Description |
| :--- | :--- | :--- |
| **Runtime Environment** | Node.js (v18+) | Native ES Modules (`"type": "module"`) |
| **Web Framework** | Express v5.1.0 | Fast, unopinionated web framework |
| **Database & ODM** | MongoDB Atlas / Mongoose v8.17.1 | Schematized NoSQL document store |
| **Real-Time Layer** | Socket.IO v4.8.3 | WebSockets with Redis Adapter support |
| **Caching & Pub/Sub** | Redis v4.6.13 | High-speed data store for location & session scaling |
| **Payment Gateways** | Razorpay v2.9.6 | Customer payment processing & RazorpayX Payouts |
| **Cloud Storage** | Cloudinary & GCP Cloud Storage | Media, service assets & KYC document uploads |
| **Push & Messaging** | Firebase Admin, SendGrid, Resend, Twilio | Multi-channel communication suite |
| **Image Processing** | Sharp v0.34.5 | High-performance image optimization |
| **Security & Middleware** | Helmet, Express Rate Limit, BcryptJS, JWT | HTTP header security, rate limiting, and encryption |

---

## 🏗 System Architecture

```
                               ┌───────────────────────────┐
                               │   Clients & Web Apps      │
                               │ Customer / Tech / Admin   │
                               └─────────────┬─────────────┘
                                             │ HTTP / WebSockets
                                             ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                                    Express 5 Server                                    │
│                                                                                        │
│  ┌───────────────────────┐   ┌───────────────────────┐   ┌──────────────────────────┐  │
│  │   Security & Auth     │   │   Controllers Layer   │   │   Socket.IO Server       │  │
│  │ Helmet / Sanitizer    │──►│ User, Tech, Admin,    │──►│ Single-Active Session    │  │
│  │ JWT / Rate Limiting   │   │ Booking, Quotation    │   │ Geo Location Stream      │  │
│  └───────────────────────┘   └───────────┬───────────┘   └──────────────────────────┘  │
│                                          │                                             │
│                                          ▼                                             │
│                              ┌───────────────────────┐                                 │
│                              │    Services Layer     │                                 │
│                              │ Business & Financial  │                                 │
│                              └───────────┬───────────┘                                 │
│                                          │                                             │
└──────────────────────────────────────────┼─────────────────────────────────────────────┘
                                           │
       ┌───────────────────────────────────┼──────────────────────────────────┐
       ▼                                   ▼                                  ▼
┌──────────────┐                  ┌─────────────────┐               ┌──────────────────┐
│ MongoDB      │                  │ Redis Cache     │               │ Background Crons │
│ 50 Mongoose  │                  │ GEO & Pub/Sub   │               │ Outbox Workers,  │
│ Schemas      │                  │ Sessions        │               │ Refund Engine    │
└──────────────┘                  └─────────────────┘               └──────────────────┘
```

---

## 📁 Project Directory Structure

```
RighttouchServerNew/
├── config/                     # Event configuration & system constants
│   └── notificationEvents.js
├── Controllers/                # API Request handlers (33 modules)
│   ├── User.js                 # Authentication & profile management
│   ├── serviceBookController.js# Core service booking & status workflow
│   ├── quotationController.js  # Quotation management
│   ├── technician.js           # Technician profile & job lifecycle
│   ├── adminWalletController.js# Admin financial ledgers & payout approvals
│   └── ...
├── Middleware/                 # Security & authentication middleware
│   ├── Auth.js                 # JWT Verification & Role Authorization
│   ├── ensureCustomer.js       # Customer role enforcement
│   ├── isTechnician.js         # Technician role enforcement
│   ├── socketAuth.js           # Handshake JWT authentication for Socket.IO
│   └── socketRateLimiter.js    # Socket rate limiting middleware
├── Routes/                     # Express Router definitions (23 route files)
│   ├── User.js                 # Customer auth, profile & services
│   ├── technician.js           # Technician jobs, availability & location
│   ├── adminWalletRoutes.js    # Admin financials, withdrawals & ledgers
│   ├── productQuoteRoutes.js   # Customer product quote requests
│   ├── adminQuotationRoutes.js # Admin quotation management
│   └── ...
├── Schemas/                    # Mongoose Data Models (50 Schemas)
│   ├── User.js                 # User identity & authentication
│   ├── ServiceBooking.js       # Service appointment details & lifecycle
│   ├── Quotation.js            # Admin product quotation schema
│   ├── PlatformLedgerEntry.js  # Platform financial audit ledger
│   ├── TechnicianProfile.js    # Technician details, skills & status
│   └── ...
├── Services/                   # Business domain services (12 services)
│   ├── authService.js          # Authentication business logic & OTP
│   ├── quotationService.js     # Quotation state machine & logic
│   ├── notificationService.js  # Outbox-based notification builder
│   └── ...
├── Utils/                      # Utility functions, crons & workers (68 modules)
│   ├── bookingCron.js          # Booking expiration & reminder crons
│   ├── autoPayout.js           # Automated technician settlement engine
│   ├── dispatchQueue.js        # Asynchronous job broadcast worker
│   ├── refundEngine.js         # SLA escalation & refund processor
│   ├── technicianLocation.js   # Real-time technician GPS tracking
│   └── ...
├── docs/                       # Project documentation assets
├── postman/                    # Postman API collections
├── test/                       # Unit & integration test suites
├── index.js                    # Application entry point & server setup
├── package.json                # Dependencies and npm scripts
└── README.md                   # Backend documentation
```

---

## 🗄 Database Data Models

The database comprises **50 Mongoose Schemas** organized by domain:

- **Identity & Accounts**: `User`, `TempUser`, `Otp`, `TechnicianProfile`, `TechnicianKYC`, `Permission`, `PermissionHistory`, `DeviceToken`, `Address`.
- **Services & Bookings**: `Service`, `Category`, `ServiceBooking`, `BookingOutbox`, `DispatchOutbox`, `TechnicianBookingOffer`, `TechnicianBroadcast`, `Rating`.
- **Products & Quotations**: `Product`, `Cart`, `ProductQuoteRequest`, `Quotation`, `QuotationDelivery`, `ProductBooking`.
- **Geography & Zones**: `OperationalCity`, `CityZone`, `ZoneServiceMapping`.
- **Financials & Ledgers**: `Payment`, `PaymentAttempt`, `PaymentEvent`, `PlatformLedgerEntry`, `WalletTransaction`, `WithdrawalRequest`, `ServiceCommissionRule`, `Receipt`, `ReserveHold`, `Chargeback`, `BookingPayoutBlock`, `CustomerRefundPayout`, `PayoutOutbox`, `RefundOutbox`.
- **Complaints & Refunds**: `Report`, `Refund`, `ReconciliationException`.
- **Notifications & Audit**: `Notification`, `NotificationDelivery`, `NotificationOutbox`, `NotificationPreference`, `AuditLog`, `GlobalSetting`.

---

## 🛣 API Namespaces & Route Map

### 1. Customer Routes (`/api/user`)
- `POST /api/user/signup` - Register a new customer account
- `POST /api/user/login` - Authenticate customer & return JWT
- `POST /api/user/verify-otp` - Verify mobile OTP
- `GET /api/user/profile` - Fetch logged-in user profile
- `POST /api/user/book-service` - Create new service booking appointment
- `GET /api/user/bookings` - Retrieve user service booking history
- `POST /api/user/product-quote-request` - Request custom product price quote
- `GET /api/user/quotations` - View received product quotations
- `PUT /api/user/quotations/:id/accept` - Accept received quotation

### 2. Technician Routes (`/api/technician`)
- `GET /api/technician/jobs` - Fetch matching service job offers
- `POST /api/technician/jobs/:id/accept` - Accept assigned service booking
- `PUT /api/technician/status` - Toggle online/offline availability
- `POST /api/technician/kyc` - Submit KYC verification details & documents
- `GET /api/technician/wallet` - Fetch wallet balance & transaction history
- `POST /api/technician/withdraw` - Request earnings payout withdrawal

### 3. Admin & Owner Routes (`/api/admin`)
- `GET /api/admin/kyc/pending` - Review pending technician KYC applications
- `PUT /api/admin/kyc/:id/approve` - Approve technician KYC
- `POST /api/admin/quotations` - Generate formal price quotation for quote request
- `GET /api/admin/finance/ledger` - Access platform ledger & commission breakdown
- `POST /api/admin/refunds/process` - Process customer refund / complaint settlement
- `PUT /api/admin/zones` - Manage operational city zones and polygon mappings

---

## ⚡ Real-Time WebSockets Architecture

The backend leverages Socket.IO for low-latency bidirectional communication:

### Key Connection Events:
- `connection` - Authenticates JWT token via `socketAuth` middleware.
- `tech:location_update` - Receives real-time technician GPS coordinates (throttled).
- `tech:get_jobs` - Cursor-based job polling short-circuited if no new assignments exist.
- `session_replaced` - Disconnects older sockets if user connects from a new device.

### Room Subscriptions:
- `customer_{userId}` - Private channel for customer booking status updates.
- `technician_{techProfileId}` - Private channel for job dispatch alerts.
- `admin_dashboard_room` - Admin live monitoring feed.

---

## ⚙️ Automated Background Workers & Crons

Background processes initialize asynchronously post-MongoDB connection:

1. **Booking Cron** (`initBookingCrons`): Scans expired booking requests and auto-cancels unaccepted appointments.
2. **Dispatch Outbox Worker** (`startDispatchWorker`): Asynchronously broadcasts job offers to nearby eligible technicians.
3. **Attempt Expiry Sweeper** (`startAttemptExpirySweeper`): Expires stale payment attempts and releases locked booking slots.
4. **Payment Notification Worker** (`startPaymentNotificationWorker`): Processes webhooks and emits real-time payment status updates.
5. **Refund Engine Sweepers**:
   - `refundWorker`: Retries queued customer refund payouts.
   - `reconcileRefunds`: Scans gateway transactions for discrepancies.
   - `complaintSlaEscalation`: Escalates unresolved customer complaints reaching SLA limits.
6. **Quotation Delivery & Expiry Sweeper**: Delivers quotations via WhatsApp/In-App and expires outdated offers.
7. **Notification Worker** (`startNotificationWorker`): Processes notification outbox items for FCM Push, SMS, and Email.

---

## 🔑 Environment Configuration

Create a `.env` file in the root directory:

```env
# Server Configuration
PORT=7372
NODE_ENV=development
TRUST_PROXY=false
ALLOWED_ORIGINS=http://localhost:3000,http://localhost:5173

# Database & Cache
MONGO_URI=mongodb+srv://<username>:<password>@cluster.mongodb.net/righttouch?retryWrites=true&w=majority
REDIS_URL=redis://localhost:6379

# Security Secrets
JWT_SECRET=your_super_secret_jwt_key_min_32_characters
ENCRYPTION_KEY=32_byte_hex_string_for_kyc_field_crypto

# Payment Gateway - Razorpay & RazorpayX
RAZORPAY_KEY_ID=rzp_test_xxxxxxxxx
RAZORPAY_KEY_SECRET=xxxxxxx_secret
RAZORPAY_WEBHOOK_SECRET=xxxxxxx_webhook_secret
RAZORPAYX_ACCOUNT_NUMBER=23344556677

# Cloud Storage
CLOUDINARY_CLOUD_NAME=your_cloud_name
CLOUDINARY_API_KEY=your_api_key
CLOUDINARY_API_SECRET=your_api_secret

# Firebase Push Notifications
FIREBASE_PROJECT_ID=righttouch-firebase
FIREBASE_CLIENT_EMAIL=firebase-adminsdk@righttouch.iam.gserviceaccount.com
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"

# Messaging & Email
SENDGRID_API_KEY=SG.xxxxxxxx
RESEND_API_KEY=re_xxxxxxxx
TWILIO_ACCOUNT_SID=ACxxxxxxxxx
TWILIO_AUTH_TOKEN=xxxxxxxxx
TWILIO_PHONE_NUMBER=+1234567890
```

---

## 🛠 Local Setup & Installation

### Prerequisites
- **Node.js**: v18.x or higher
- **MongoDB**: Local instance or MongoDB Atlas cluster
- **Redis**: Local instance or Redis Cloud (Optional for single-instance dev mode)

### Step-by-Step Installation

1. **Clone the repository**:
   ```bash
   git clone https://github.com/FlareMindsTech/righttouch_backend.git
   cd righttouch_backend
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Configure Environment Variables**:
   Copy `.env` sample and populate your configuration values.

4. **Start the Development Server**:
   ```bash
   npm run dev
   ```

5. **Start Production Server**:
   ```bash
   npm start
   ```

---

## 🧪 Testing

The repository uses Node's native test runner (`node --test`) for fast unit and integration tests:

Run all tests:
```bash
npm test
```

### Included Test Modules:
- `test/auto-payout.engine.test.js` - Automated technician settlement tests
- `test/bookingEngine.test.js` - Service booking state machine tests
- `test/finance.engine.test.js` - Double-entry ledger audit tests
- `test/productQuoteFlow.test.js` - Product quote request workflow tests
- `test/productQuoteLifecycle.test.js` - Quotation lifecycle validation tests
- `test/quotationPricing.test.js` - Quotation itemized pricing calculator tests
- `test/socket.contract.test.js` - WebSocket payload contract tests
- `test/socket.presence.test.js` - Real-time technician presence tests

---

## 🔒 Security & Performance Hardening

1. **NoSQL Injection Guard**: Custom input sanitizer (`sanitizeNoSqlPayload`) recursively strips Mongo operators (`$` and `.`) from `req.body`, `req.params`, and `req.query`.
2. **Strict Secret Validation**: Checks for default or weak secrets on startup (`validateSecrets()`) and halts boot if security constraints are violated.
3. **PII Field-Level Encryption**: Sensitive technician KYC documents and bank details are encrypted using AES-256-GCM before database insertion.
4. **Rate-Limiting Protection**: Express Rate Limit applied globally to prevent brute-force endpoints, with dedicated socket handshake limiters.
5. **Graceful Shutdown**: Intercepts `SIGTERM` and `SIGINT` signals to flush outbox jobs, notify active WebSocket sessions, and close database connections cleanly.

---

### 📄 License

This project is proprietary and confidential. Powered by **FlareMinds Tech**.