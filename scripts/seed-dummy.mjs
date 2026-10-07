/**
 * 🌱 DUMMY SEED — creates one realistic, fully-linked dataset across ALL domains
 * for testing (every schema + controller flow has data to read).
 *
 * Usage:
 *   node scripts/seed-dummy.mjs            # idempotent: skips docs that already exist
 *   node scripts/seed-dummy.mjs --fresh    # ⚠️ wipes seeded collections first, then inserts
 *   SEED_DB_URI=mongodb://127.0.0.1:27017/rt_test node scripts/seed-dummy.mjs --fresh
 *
 * Dependency / mapping order:
 *  Category → Service (+CommissionRule) + Product
 *  → OperationalCity → CityZone → ZoneServiceMapping + ServiceAvailability + PolygonVersion
 *  → Users (Owner/Admin/Customers/Technicians) → TechnicianProfile → KYC/DistrictPerm/ZoneAudit/SkillRequest/LocationHistory
 *  → Address/Cart/Permission/DeviceToken/NotificationPreference/TempUser/Otp/AuthSession
 *  → ServiceBooking (+Outboxes/Broadcast/Offer) → ProductQuoteRequest → Quotation → QuotationDelivery → ProductBooking
 *  → Payment (+Attempt/Event/Receipt) → Wallet/Withdrawal/PayoutOutbox/ReserveHold/PayoutBlock/Ledger
 *  → Report → Refund (+Outbox/CreditNote/CustomerPayout/Chargeback/ReconException)
 *  → Notification (+Delivery/Outbox) + Rating + AuditLog + GlobalSetting
 */
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import dotenv from "dotenv";

dotenv.config();

// ── Models ──────────────────────────────────────────────────────────
import User from "../modules/identity/models/User.js";
import TempUser from "../modules/identity/models/TempUser.js";
import Otp from "../modules/identity/models/Otp.js";
import AuthSession from "../modules/identity/models/AuthSession.js";
import TechnicianProfile from "../modules/technician/models/TechnicianProfile.js";
import TechnicianKyc from "../modules/technician/models/TechnicianKYC.js";
import TechnicianSkillRequest from "../modules/technician/models/TechnicianSkillRequest.js";
import TechnicianLocationHistory from "../modules/technician/models/TechnicianLocationHistory.js";
import OperationalCity from "../modules/geo/models/OperationalCity.js";
import CityZone from "../modules/geo/models/CityZone.js";
import ZoneServiceMapping from "../modules/geo/models/ZoneServiceMapping.js";
import ServiceAvailability from "../modules/geo/models/ServiceAvailability.js";
import TechnicianDistrictPermission from "../modules/geo/models/TechnicianDistrictPermission.js";
import DistrictPermissionHistory from "../modules/geo/models/DistrictPermissionHistory.js";
import TechnicianZonePermissionAudit from "../modules/geo/models/TechnicianZonePermissionAudit.js";
import Permission from "../modules/geo/models/Permission.js";
import PermissionHistory from "../modules/geo/models/PermissionHistory.js";
import PolygonVersion from "../modules/geo/models/PolygonVersion.js";
import Category from "../modules/catalog/models/Category.js";
import Service from "../modules/catalog/models/Service.js";
import Product from "../modules/catalog/models/Product.js";
import ServiceCommissionRule from "../modules/catalog/models/ServiceCommissionRule.js";
import Address from "../modules/cart-address/models/Address.js";
import Cart from "../modules/cart-address/models/Cart.js";
import ServiceBooking from "../modules/booking/models/ServiceBooking.js";
import TechnicianBroadcast from "../modules/booking/models/TechnicianBroadcast.js";
import TechnicianBookingOffer from "../modules/booking/models/TechnicianBookingOffer.js";
import BookingOutbox from "../modules/booking/models/BookingOutbox.js";
import DispatchOutbox from "../modules/booking/models/DispatchOutbox.js";
import ProductQuoteRequest from "../modules/quote-product/models/ProductQuoteRequest.js";
import Quotation from "../modules/quote-product/models/Quotation.js";
import QuotationDelivery from "../modules/quote-product/models/QuotationDelivery.js";
import ProductBooking from "../modules/quote-product/models/ProductBooking.js";
import Payment from "../modules/payments/models/Payment.js";
import PaymentAttempt from "../modules/payments/models/PaymentAttempt.js";
import PaymentEvent from "../modules/payments/models/PaymentEvent.js";
import Receipt from "../modules/payments/models/Receipt.js";
import WalletTransaction from "../modules/payouts/models/WalletTransaction.js";
import WithdrawalRequest from "../modules/payouts/models/WithdrawalRequest.js";
import PayoutOutbox from "../modules/payouts/models/PayoutOutbox.js";
import ReserveHold from "../modules/payouts/models/ReserveHold.js";
import BookingPayoutBlock from "../modules/payouts/models/BookingPayoutBlock.js";
import PlatformLedgerEntry from "../modules/payouts/models/PlatformLedgerEntry.js";
import Refund from "../modules/refunds/models/Refund.js";
import RefundOutbox from "../modules/refunds/models/RefundOutbox.js";
import CreditNote from "../modules/refunds/models/CreditNote.js";
import CustomerRefundPayout from "../modules/refunds/models/CustomerRefundPayout.js";
import Chargeback from "../modules/refunds/models/Chargeback.js";
import ReconciliationException from "../modules/refunds/models/ReconciliationException.js";
import Notification from "../modules/notifications/models/Notification.js";
import NotificationDelivery from "../modules/notifications/models/NotificationDelivery.js";
import NotificationOutbox from "../modules/notifications/models/NotificationOutbox.js";
import NotificationPreference from "../modules/notifications/models/NotificationPreference.js";
import DeviceToken from "../modules/notifications/models/DeviceToken.js";
import Report from "../modules/support-system/models/Report.js";
import Rating from "../modules/support-system/models/Rating.js";
import AuditLog from "../modules/support-system/models/AuditLog.js";
import GlobalSetting from "../modules/support-system/models/GlobalSetting.js";

const FRESH = process.argv.includes("--fresh");
const MONGO_URI = process.env.SEED_DB_URI || process.env.MONGO_URI;
if (!MONGO_URI) {
  console.error("❌ Set MONGO_URI (or SEED_DB_URI) to run the seeder.");
  process.exit(1);
}

const counts = {};
const bump = (k) => (counts[k] = (counts[k] || 0) + 1);
// Idempotent helper: find by unique filter, else create (runs schema hooks).
const ensure = async (Model, filter, doc, label) => {
  const found = await Model.findOne(filter);
  if (found) return { doc: found, created: false };
  const created = await Model.create(doc);
  bump(label || Model.modelName);
  return { doc: created, created: true };
};

// Fixed Madurai geo (lng,lat) — zone squares sit inside the district square.
const DISTRICT_POLY = [[[78.05, 9.85], [78.2, 9.85], [78.2, 10.0], [78.05, 10.0], [78.05, 9.85]]];
const ZONE1_POLY = [[[78.08, 9.9], [78.14, 9.9], [78.14, 9.96], [78.08, 9.96], [78.08, 9.9]]];
const ZONE2_POLY = [[[78.14, 9.9], [78.19, 9.9], [78.19, 9.96], [78.14, 9.96], [78.14, 9.9]]];
const TECH_LNG = 78.11, TECH_LAT = 9.93;

const run = async () => {
  await mongoose.connect(MONGO_URI);
  console.log(`✅ Connected → ${FRESH ? "FRESH wipe + seed" : "idempotent seed"}`);

  if (FRESH) {
    const all = [TempUser, Otp, AuthSession, TechnicianLocationHistory, TechnicianSkillRequest, DistrictPermissionHistory, TechnicianZonePermissionAudit, PermissionHistory, PolygonVersion, Cart, TechnicianBroadcast, TechnicianBookingOffer, BookingOutbox, DispatchOutbox, QuotationDelivery, PaymentAttempt, PaymentEvent, Receipt, WalletTransaction, PayoutOutbox, ReserveHold, BookingPayoutBlock, PlatformLedgerEntry, RefundOutbox, CreditNote, CustomerRefundPayout, Chargeback, ReconciliationException, NotificationDelivery, NotificationOutbox, Notification, DeviceToken, NotificationPreference, Permission, Report, Rating, AuditLog, Payment, Refund, WithdrawalRequest, ProductBooking, Quotation, ProductQuoteRequest, ServiceBooking, Address, TechnicianKyc, TechnicianDistrictPermission, ZoneServiceMapping, ServiceAvailability, ServiceCommissionRule, TechnicianProfile, Service, Product, Category, CityZone, OperationalCity, User, GlobalSetting];
    for (const M of all) await M.deleteMany({});
    console.log("🧹 Wiped seeded collections");
  }

  // ── 1. CATALOG ────────────────────────────────────────────────
  const { doc: catSvc } = await ensure(Category, { slug: "electrical-services-service" },
    { category: "Electrical Services", description: "Wiring, repair and appliance services", categoryType: "service", slug: "electrical-services-service", isActive: true }, "Category");
  const { doc: catProd } = await ensure(Category, { slug: "home-appliances-product" },
    { category: "Home Appliances", description: "AC, fridge and washing machines", categoryType: "product", slug: "home-appliances-product", isActive: true }, "Category");

  const { doc: svcAC } = await ensure(Service, { serviceName: "AC Repair Dummy" },
    { categoryId: catSvc._id, serviceName: "AC Repair Dummy", description: "Split/window AC repair", serviceType: "Repair", serviceCost: 499, pricingType: "fixed", gstPercentage: 18, commissionPercentage: 15, commissionAmount: 75, technicianAmount: 424, discountedPrice: 499, isActive: true, zoneRestricted: false }, "Service");
  const { doc: svcWM } = await ensure(Service, { serviceName: "Washing Machine Install Dummy" },
    { categoryId: catSvc._id, serviceName: "Washing Machine Install Dummy", description: "WM installation", serviceType: "Installation", serviceCost: 799, pricingType: "fixed", gstPercentage: 18, commissionPercentage: 12, commissionAmount: 96, technicianAmount: 703, discountedPrice: 799, isActive: true, zoneRestricted: true }, "Service");
  const { doc: prodAC } = await ensure(Product, { productName: "Split AC 1.5 Ton Dummy" },
    { categoryId: catProd._id, productName: "Split AC 1.5 Ton Dummy", productType: "Air Conditioner", description: "5-star inverter split AC", pricingModel: "fixed", estimatedPriceFrom: 32000, estimatedPriceTo: 35000, estimatedPriceFromPaise: 3200000, estimatedPriceToPaise: 3500000, productGst: 18, isActive: true }, "Product");
  const { doc: prodFridge } = await ensure(Product, { productName: "Double Door Fridge Dummy" },
    { categoryId: catProd._id, productName: "Double Door Fridge Dummy", productType: "Refrigerator", description: "320L double door fridge", pricingModel: "after_inspection", productGst: 18, quoteRequired: true, isActive: true }, "Product");

  // ── 2. GEO ────────────────────────────────────────────────────
  const { doc: district } = await ensure(OperationalCity, { name: "Madurai District Dummy" },
    { name: "Madurai District Dummy", city: "Madurai", state: "Tamil Nadu", country: "India", code: "MDD", polygon: { type: "Polygon", coordinates: DISTRICT_POLY }, active: true, status: "ACTIVE", isRegistrationEnabled: true, isJobEnabled: true }, "OperationalCity");
  const { doc: zone1 } = await ensure(CityZone, { zoneCode: "Z-DUM-01" },
    { operationalCityId: district._id, name: "Anna Nagar Dummy Zone", zoneCode: "Z-DUM-01", polygon: { type: "Polygon", coordinates: ZONE1_POLY }, active: true }, "CityZone");
  const { doc: zone2 } = await ensure(CityZone, { zoneCode: "Z-DUM-02" },
    { operationalCityId: district._id, name: "KK Nagar Dummy Zone", zoneCode: "Z-DUM-02", polygon: { type: "Polygon", coordinates: ZONE2_POLY }, active: true }, "CityZone");

  for (const [z, s] of [[zone1, svcAC], [zone1, svcWM], [zone2, svcAC]]) {
    await ensure(ZoneServiceMapping, { zoneId: z._id, serviceId: s._id },
      { zoneId: z._id, serviceId: s._id, active: true, pricingMultiplier: 1.0 }, "ZoneServiceMapping");
  }
  await ensure(ServiceAvailability, { serviceId: svcAC._id, districtId: district._id, scope: "DISTRICT" },
    { serviceId: svcAC._id, districtId: district._id, scope: "DISTRICT", status: "ENABLED" }, "ServiceAvailability");

  // Commission rules need setBy (admin) → created after users below.

  // ── 3. USERS ──────────────────────────────────────────────────
  const pwdHash = await bcrypt.hash("Dummy@1234", 10);
  const mkUser = async (mobile, role, extra = {}) => (await ensure(User, { mobileNumber: mobile },
    { mobileNumber: mobile, role, status: "Active", profileComplete: true, termsAndServices: true, privacyPolicy: true, ...extra }, "User")).doc;
  const owner = await mkUser("9000000001", "Owner", { fname: "Dummy", lname: "Owner", email: "owner.dummy@example.com", password: pwdHash });
  const admin = await mkUser("9000000002", "Admin", { fname: "Dummy", lname: "Admin", email: "admin.dummy@example.com", password: pwdHash });
  const cust1 = await mkUser("9000000003", "Customer", { fname: "Ravi", lname: "Customer", email: "ravi.dummy@example.com" });
  const cust2 = await mkUser("9000000004", "Customer", { fname: "Meena", lname: "Customer", email: "meena.dummy@example.com" });
  const techU1 = await mkUser("9000000005", "Technician", { fname: "Arun", lname: "Tech", email: "arun.tech.dummy@example.com" });
  const techU2 = await mkUser("9000000006", "Technician", { fname: "Bala", lname: "Tech", email: "bala.tech.dummy@example.com" });

  await ensure(TempUser, { identifier: "9000000007", role: "Customer" },
    { identifier: "9000000007", role: "Customer", tempstatus: "Pending" }, "TempUser");
  await ensure(Otp, { identifier: "9000000007", role: "Customer", purpose: "SIGNUP" },
    { identifier: "9000000007", role: "Customer", purpose: "SIGNUP", otp: "hashed-dummy-otp", expiresAt: new Date(Date.now() + 5 * 60 * 1000) }, "Otp");
  await ensure(AuthSession, { tokenHash: "seed-dummy-token-hash-cust1" },
    { userId: cust1._id, role: "Customer", tokenHash: "seed-dummy-token-hash-cust1", familyId: new mongoose.Types.ObjectId(), expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000), device: { userAgent: "seed", ip: "127.0.0.1", deviceId: "seed-device-1", platform: "android" } }, "AuthSession");

  // Geo version + commission rules (need admin user for required *_by fields)
  await ensure(PolygonVersion, { entityType: "DISTRICT", entityId: district._id, version: 1 },
    { entityType: "DISTRICT", entityId: district._id, version: 1, polygon: { type: "Polygon", coordinates: DISTRICT_POLY }, changedBy: admin._id, changeReason: "dummy seed v1" }, "PolygonVersion");
  const mkRule = async (svc, pct) => {
    const ex = await ServiceCommissionRule.findOne({ serviceId: svc._id }).sort({ effectiveFrom: -1 });
    if (ex) return ex;
    const r = await ServiceCommissionRule.create({ serviceId: svc._id, commissionPercentage: pct, effectiveFrom: new Date("2025-01-01"), setBy: admin._id });
    bump("ServiceCommissionRule"); return r;
  };
  const ruleAC = await mkRule(svcAC, 15);
  await mkRule(svcWM, 12);

  // ── 4. TECHNICIANS ────────────────────────────────────────────
  const mkTech = async (user, online, zone) => {
    let t = await TechnicianProfile.findOne({ userId: user._id });
    if (!t) {
      t = await TechnicianProfile.create({
        userId: user._id, location: { type: "Point", coordinates: [TECH_LNG, TECH_LAT] },
        city: "Madurai", state: "Tamil Nadu", experienceYears: 4, specialization: "AC & Appliances",
        skills: [{ serviceId: svcAC._id, experienceYears: 3 }, { serviceId: svcWM._id, experienceYears: 2 }],
        trainingCompleted: true, workStatus: "approved", availability: { isOnline: online },
        availableBalancePaise: 250000, lifetimeEarnedPaise: 500000, lifetimeWithdrawnPaise: 250000,
        primaryDistrictId: district._id, primaryCityId: district._id, cityZoneId: zone._id,
        enabledDistrictIds: [district._id], enabledCityZoneIds: [zone._id],
        currentDistrictId: district._id, currentCityZoneId: zone._id,
        profileComplete: true, locationUpdatedAt: new Date(),
      });
      bump("TechnicianProfile");
    }
    return t;
  };
  const tech1 = await mkTech(techU1, true, zone1);
  const tech2 = await mkTech(techU2, false, zone2);

  await ensure(TechnicianKyc, { technicianId: tech1._id },
    { technicianId: tech1._id, aadhaarNumber: "XXXX-XXXX-1234", panNumber: "ABCDE1234F", verificationStatus: "approved", kycVerified: true, bankDetails: { accountHolderName: "Arun Tech", bankName: "State Bank", accountNumber: "XXXXXX5678", ifscCode: "SBIN0001234", upiId: "aruntech@upi" }, bankVerificationStatus: "approved", bankVerified: true }, "TechnicianKYC");
  await ensure(TechnicianKyc, { technicianId: tech2._id },
    { technicianId: tech2._id, verificationStatus: "pending", kycVerified: false, bankVerificationStatus: "pending", bankVerified: false }, "TechnicianKYC");

  await ensure(TechnicianDistrictPermission, { technicianId: tech1._id, districtId: district._id },
    { technicianId: tech1._id, districtId: district._id, permissionType: "PRIMARY", isEnabled: true }, "TechnicianDistrictPermission");
  await ensure(DistrictPermissionHistory, { technicianId: tech1._id, districtId: district._id, action: "GRANT", adminId: admin._id },
    { technicianId: tech1._id, districtId: district._id, action: "GRANT", adminId: admin._id, reason: "dummy seed grant" }, "DistrictPermissionHistory");
  await ensure(TechnicianZonePermissionAudit, { technicianId: tech1._id, cityZoneId: zone1._id, action: "enabled", changedBy: admin._id },
    { technicianId: tech1._id, cityZoneId: zone1._id, action: "enabled", changedBy: admin._id, reason: "dummy seed" }, "TechnicianZonePermissionAudit");
  await ensure(TechnicianSkillRequest, { technicianId: tech2._id, serviceId: svcWM._id, status: "approved" },
    { technicianId: tech2._id, userId: techU2._id, serviceId: svcWM._id, reason: "2 years WM experience, requesting zone approval", status: "approved", reviewedBy: admin._id, reviewedAt: new Date() }, "TechnicianSkillRequest");
  const locHist = await TechnicianLocationHistory.findOne({ technicianId: tech1._id });
  if (!locHist) {
    await TechnicianLocationHistory.create({ technicianId: tech1._id, location: { type: "Point", coordinates: [TECH_LNG, TECH_LAT] }, districtId: district._id, cityZoneId: zone1._id, source: "http" });
    bump("TechnicianLocationHistory");
  }

  // ── 5. CUSTOMER SURFACE ───────────────────────────────────────
  const mkAddr = async (cust, isDef, line) => {
    const ex = await Address.findOne({ customerId: cust._id, isDefault: true });
    if (isDef && ex) return ex;
    const dup = await Address.findOne({ customerId: cust._id, addressLine: line });
    if (dup) return dup;
    const a = await Address.create({ customerId: cust._id, label: "home", addressLine: line, city: "Madurai", state: "Tamil Nadu", pincode: "625001", latitude: TECH_LAT, longitude: TECH_LNG, isDefault: isDef });
    bump("Address"); return a;
  };
  const addr1 = await mkAddr(cust1, true, "12 Dummy Street, Anna Nagar");
  await mkAddr(cust2, true, "45 Dummy Road, KK Nagar");

  await ensure(Cart, { customerId: cust2._id, itemType: "service", itemId: svcAC._id },
    { customerId: cust2._id, itemType: "service", itemId: svcAC._id, quantity: 1, faultProblem: "AC not cooling" }, "Cart");
  await ensure(Cart, { customerId: cust2._id, itemType: "product", itemId: prodFridge._id },
    { customerId: cust2._id, itemType: "product", itemId: prodFridge._id, quantity: 1 }, "Cart");

  await ensure(Permission, { userId: cust1._id, deviceId: "seed-device-1" },
    { userId: cust1._id, role: "Customer", deviceId: "seed-device-1", platform: "android", permissions: { location: { status: "granted" }, notification: { status: "granted" } } }, "Permission");
  const ph = await PermissionHistory.findOne({ userId: cust1._id, deviceId: "seed-device-1" });
  if (!ph) {
    await PermissionHistory.create({ userId: cust1._id, role: "Customer", deviceId: "seed-device-1", permission: "location", oldStatus: "not_requested", newStatus: "granted" });
    bump("PermissionHistory");
  }
  await ensure(DeviceToken, { userId: cust1._id, deviceId: "seed-device-1" },
    { userId: cust1._id, role: "Customer", deviceId: "seed-device-1", platform: "android", fcmToken: "dummy-fcm-token-cust1", isActive: true }, "DeviceToken");
  await ensure(NotificationPreference, { userId: cust1._id },
    { userId: cust1._id, language: "en", timezone: "Asia/Kolkata" }, "NotificationPreference");

  // ── 6. SERVICE BOOKINGS (full + live) ─────────────────────────
  const finSnap = { baseAmountPaise: 49900, discountAmountPaise: 0, totalAmountPaise: 58900, commissionPercentage: 15, commissionAmountPaise: 8835, technicianAmountPaise: 41065, commissionRuleSource: "rule", commissionRuleId: ruleAC._id, calculationVersion: 2, commissionOverridden: false, financialSnapshotAt: new Date(), gstPercentage: 18, gstAmountPaise: 8982, tipAmountPaise: 0 };
  const mkBooking = async (cust, tech, status, assign) => {
    const ex = await ServiceBooking.findOne({ customerId: cust._id, serviceId: svcAC._id, status });
    if (ex) return ex;
    const b = await ServiceBooking.create({
      customerId: cust._id, serviceId: svcAC._id, technicianId: tech ? tech._id : null,
      baseAmount: 499, gstPercentage: 18, gstAmount: 89.82, locationType: "saved",
      address: "12 Dummy Street, Anna Nagar, Madurai 625001", addressId: addr1._id,
      location: { type: "Point", coordinates: [TECH_LNG, TECH_LAT] },
      districtId: district._id, cityZoneId: zone1._id, bookingType: "schedule",
      scheduledAt: new Date(Date.now() + 24 * 3600 * 1000),
      status, assignmentStatus: assign, paymentStatus: status === "completed" ? "paid" : "pending",
      settlementStatus: status === "completed" ? "settled" : "pending",
      completedAt: status === "completed" ? new Date() : null, financialSnapshot: finSnap,
    });
    bump("ServiceBooking"); return b;
  };
  const bookingDone = await mkBooking(cust1, tech1, "completed", "assigned");
  const bookingLive = await mkBooking(cust2, null, "broadcasted", "broadcasted");

  await ensure(BookingOutbox, { idempotencyKey: `booking-created:${bookingDone._id}` },
    { aggregateId: bookingDone._id, eventType: "booking_created", idempotencyKey: `booking-created:${bookingDone._id}`, status: "done", version: 1 }, "BookingOutbox");
  await ensure(TechnicianBroadcast, { bookingId: bookingLive._id, technicianId: tech1._id },
    { bookingId: bookingLive._id, technicianId: tech1._id, status: "sent", version: 1, expiresAt: new Date(Date.now() + 3600 * 1000) }, "TechnicianBroadcast");
  await ensure(TechnicianBookingOffer, { bookingId: bookingLive._id, technicianId: tech1._id },
    { bookingId: bookingLive._id, technicianId: tech1._id, channel: "broadcast", decision: "offered" }, "TechnicianBookingOffer");
  const dExists = await DispatchOutbox.findOne({ bookingId: bookingLive._id, technicianId: tech1._id, kind: "job_new" });
  if (!dExists) {
    await DispatchOutbox.create({ bookingId: bookingLive._id, technicianId: tech1._id, kind: "job_new", status: "pending", payload: { bookingId: String(bookingLive._id) } });
    bump("DispatchOutbox");
  }

  // ── 7. QUOTE → QUOTATION → PRODUCT BOOKING ────────────────────
  const { doc: qr } = await ensure(ProductQuoteRequest, { requestNumber: "REQ-DUMMY-001" },
    { requestNumber: "REQ-DUMMY-001", customerId: cust1._id, productId: prodFridge._id, quantity: 1, locationType: "saved", addressSnapshot: { addressLine: "12 Dummy Street", city: "Madurai", state: "Tamil Nadu", pincode: "625001" }, location: { type: "Point", coordinates: [TECH_LNG, TECH_LAT] }, requirementDescription: "Need 320L fridge with installation", status: "accepted", assignedAdminId: admin._id }, "ProductQuoteRequest");
  const { doc: quote } = await ensure(Quotation, { quotationNumber: "QT-DUMMY-001" },
    { quotationNumber: "QT-DUMMY-001", quoteRequestId: qr._id, customerId: cust1._id, productId: prodFridge._id, items: [{ productId: prodFridge._id, quantity: 1, status: "accepted" }], revision: 1, quantity: 1, validFrom: new Date(), validUntil: new Date(Date.now() + 7 * 24 * 3600 * 1000), createdBy: admin._id, status: "accepted", paymentStatus: "paid", notificationStatus: "sent", financialSnapshot: { currency: "INR", unitPricePaise: 2800000, baseAmountPaise: 2800000, installationPaise: 50000, additionalPaise: 0, discountPaise: 100000, taxableAmountPaise: 2750000, gstPercent: 18, gstAmountPaise: 495000, totalAmountPaise: 3245000, calculationVersion: 2 } }, "Quotation");
  qr.acceptedQuotationId = quote._id; await qr.save().catch(() => {});
  await ensure(QuotationDelivery, { quotationId: quote._id, channel: "in_app", notificationType: "QUOTATION_SENT" },
    { quotationId: quote._id, customerId: cust1._id, requestId: qr._id, channel: "in_app", notificationType: "QUOTATION_SENT", status: "sent", title: "Your quotation is ready", body: "QT-DUMMY-001 for Double Door Fridge" }, "QuotationDelivery");
  const { doc: pBooking } = await ensure(ProductBooking, { customerId: cust1._id, productId: prodFridge._id, quotationId: quote._id },
    { customerId: cust1._id, productId: prodFridge._id, quotationId: quote._id, quoteRequestId: qr._id, quantity: 1, amount: 32450, amountPaise: 3245000, locationType: "saved", addressSnapshot: { addressLine: "12 Dummy Street", city: "Madurai", pincode: "625001" }, location: { type: "Point", coordinates: [TECH_LNG, TECH_LAT] }, paymentStatus: "paid", status: "active" }, "ProductBooking");

  // ── 8. PAYMENTS ───────────────────────────────────────────────
  const { doc: pay1 } = await ensure(Payment, { bookingId: bookingDone._id },
    { bookingId: bookingDone._id, itemType: "service", paymentType: "SERVICE", provider: "razorpay", mode: "online", providerOrderId: "order_dummy001", providerPaymentId: "pay_dummy001", status: "success", baseAmountPaise: 49900, totalAmountPaise: 58900, commissionAmountPaise: 8835, technicianAmountPaise: 41065, capturedAmountPaise: 58900, verifiedAt: new Date() }, "Payment");
  bookingDone.paymentId = pay1._id; await bookingDone.save().catch(() => {});
  await ensure(Payment, { bookingId: pBooking._id },
    { bookingId: pBooking._id, itemType: "product", paymentType: "PRODUCT", provider: "razorpay", mode: "online", providerOrderId: "order_dummy002", providerPaymentId: "pay_dummy002", status: "success", baseAmountPaise: 2750000, totalAmountPaise: 3245000, capturedAmountPaise: 3245000, verifiedAt: new Date() }, "Payment");
  await ensure(PaymentAttempt, { providerOrderId: "order_dummy001" },
    { bookingId: bookingDone._id, customerId: cust1._id, paymentId: pay1._id, method: "razorpay", amountPaise: 58900, state: "captured", providerOrderId: "order_dummy001", providerPaymentId: "pay_dummy001", expiresAt: new Date(Date.now() + 15 * 60 * 1000) }, "PaymentAttempt");
  await ensure(PaymentEvent, { eventId: "evt_dummy001" },
    { eventId: "evt_dummy001", eventType: "payment.captured", payload: { bookingId: String(bookingDone._id) }, processed: true }, "PaymentEvent");
  await ensure(Receipt, { receiptNumber: "RCP-DUMMY-001" },
    { receiptNumber: "RCP-DUMMY-001", paymentId: pay1._id, bookingId: bookingDone._id, customerId: cust1._id, baseAmountPaise: 49900, gstAmountPaise: 8982, totalAmountPaise: 58900 }, "Receipt");

  // ── 9. WALLET / PAYOUTS / LEDGER ──────────────────────────────
  await ensure(WalletTransaction, { idempotencyKey: `job:${bookingDone._id}` },
    { technicianId: tech1._id, bookingId: bookingDone._id, paymentId: pay1._id, amountPaise: 41065, amount: 410.65, type: "credit", source: "job", idempotencyKey: `job:${bookingDone._id}` }, "WalletTransaction");
  const { doc: wd } = await ensure(WithdrawalRequest, { clientIdempotencyKey: "wd-dummy-001" },
    { technicianId: tech1._id, amount: 2000, amountPaise: 200000, netPayoutAmountPaise: 200000, origin: "technician_request", status: "paid", clientIdempotencyKey: "wd-dummy-001", payoutMode: "UPI", paidAt: new Date() }, "WithdrawalRequest");
  await ensure(WalletTransaction, { idempotencyKey: `withdrawal:${wd._id}` },
    { technicianId: tech1._id, withdrawalId: wd._id, amountPaise: 200000, amount: 2000, type: "debit", source: "withdraw", idempotencyKey: `withdrawal:${wd._id}` }, "WalletTransaction");
  await ensure(PayoutOutbox, { withdrawalId: wd._id },
    { withdrawalId: wd._id, idempotencyKey: String(wd._id), status: "completed", amountPaise: 200000 }, "PayoutOutbox");
  await ensure(ReserveHold, { bookingId: bookingDone._id, technicianId: tech1._id, status: "released" },
    { bookingId: bookingDone._id, technicianId: tech1._id, status: "released", amountPaise: 0 }, "ReserveHold");
  const mkLedger = async (key, type, dir, amt, extra = {}) => {
    await ensure(PlatformLedgerEntry, { idempotencyKey: key },
      { type, direction: dir, amountPaise: amt, idempotencyKey: key, bookingId: bookingDone._id, paymentId: pay1._id, technicianId: tech1._id, ...extra }, "PlatformLedgerEntry");
  };
  await mkLedger(`seed:pay:${pay1._id}`, "customer_payment", "credit", 58900);
  await mkLedger(`seed:comm:${pay1._id}`, "platform_commission", "credit", 8835);
  await mkLedger(`seed:liab:${pay1._id}`, "technician_earning_liability", "debit", 41065);
  await mkLedger(`seed:payout:${wd._id}`, "technician_payout", "debit", 200000, { withdrawalId: wd._id });

  // ── 10. COMPLAINT → REFUND ────────────────────────────────────
  const { doc: report } = await ensure(Report, { bookingId: bookingLive._id, customerId: cust2._id, status: "under_review" },
    { bookingId: bookingLive._id, bookingType: "service", customerId: cust2._id, serviceId: svcAC._id, category: "quality_dispute", complaint: "Dummy complaint: service quality not as expected", description: "Technician left without testing the AC", status: "under_review", isRead: false }, "Report");
  await ensure(BookingPayoutBlock, { bookingId: bookingLive._id },
    { bookingId: bookingLive._id, technicianId: tech1._id, reportId: report._id, reason: "complaint_open" }, "BookingPayoutBlock");
  const payLive = await ensure(Payment, { bookingId: bookingLive._id },
    { bookingId: bookingLive._id, itemType: "service", paymentType: "SERVICE", provider: "razorpay", mode: "online", providerOrderId: "order_dummy003", providerPaymentId: "pay_dummy003", status: "success", baseAmountPaise: 49900, totalAmountPaise: 58900, capturedAmountPaise: 58900, verifiedAt: new Date() }, "Payment");
  const { doc: refund } = await ensure(Refund, { idempotencyKey: "refund-dummy-001" },
    { paymentId: payLive.doc._id, bookingId: bookingLive._id, bookingType: "service", customerId: cust2._id, reportId: report._id, refundClass: "adjudication", reason: "quality_dispute", faultParty: "technician", sharePct: 100, grossAmountPaise: 58900, netRefundPaise: 58900, rail: "razorpay_reverse", status: "initiated", idempotencyKey: "refund-dummy-001", initiatedBy: admin._id }, "Refund");
  await ensure(RefundOutbox, { refundId: refund._id },
    { refundId: refund._id, status: "new" }, "RefundOutbox");
  await ensure(CreditNote, { refundId: refund._id },
    { refundId: refund._id, creditNoteNumber: "CN-DUMMY-001", taxableAmountPaise: 49900, cgstPaise: 4491, sgstPaise: 4491, totalPaise: 58882, declared: false }, "CreditNote");
  await ensure(CustomerRefundPayout, { refundId: refund._id },
    { refundId: refund._id, customerId: cust2._id, amountPaise: 58900, rail: "razorpayx_payout", status: "pending_approval", destination: { type: "bank", accountNumber: "XXXXXX1234", ifsc: "SBIN0001234" } }, "CustomerRefundPayout");
  await ensure(Chargeback, { providerDisputeId: "dsp_dummy001" },
    { paymentId: payLive.doc._id, bookingId: bookingLive._id, providerDisputeId: "dsp_dummy001", status: "open", amountPaise: 58900 }, "Chargeback");
  await ensure(ReconciliationException, { fingerprint: "seed-dummy-recon-001" },
    { code: "PAYMENT_AMOUNT_MISMATCH", severity: "warning", fingerprint: "seed-dummy-recon-001", bookingId: bookingLive._id, paymentId: payLive.doc._id, resolved: false }, "ReconciliationException");

  // ── 11. NOTIFY + TRUST + SYSTEM ───────────────────────────────
  const { doc: notif } = await ensure(Notification, { idempotencyKey: "notif-dummy-001" },
    { recipientId: cust2._id, recipientType: "customer", eventType: "JOB_BROADCASTED", title: "Technician search started (dummy)", body: "Your dummy booking is now visible to nearby technicians", category: "booking", priority: "normal", idempotencyKey: "notif-dummy-001" }, "Notification");
  await ensure(NotificationDelivery, { notificationId: notif._id, channel: "socket" },
    { notificationId: notif._id, recipientId: cust2._id, channel: "socket", status: "provider_accepted" }, "NotificationDelivery");
  await ensure(NotificationDelivery, { notificationId: notif._id, channel: "push" },
    { notificationId: notif._id, recipientId: cust2._id, channel: "push", status: "queued" }, "NotificationDelivery");
  await ensure(NotificationOutbox, { notificationId: notif._id, eventType: "JOB_BROADCASTED" },
    { notificationId: notif._id, eventType: "JOB_BROADCASTED", status: "completed" }, "NotificationOutbox");
  await ensure(Rating, { bookingId: bookingDone._id },
    { bookingId: bookingDone._id, bookingType: "service", userId: cust1._id, technicianId: tech1._id, serviceId: svcAC._id, rates: 5, comment: "Excellent dummy service" }, "Rating");
  const al = await AuditLog.findOne({ action: "DUMMY_SEED", targetType: "ServiceBooking", targetId: bookingDone._id });
  if (!al) {
    await AuditLog.create({ actor: admin._id, actorRole: "Admin", action: "DUMMY_SEED", targetType: "ServiceBooking", targetId: bookingDone._id, reason: "seed linkage proof" });
    bump("AuditLog");
  }
  for (const [k, v] of [["technician.reacceptPenaltyPercent", 10], ["report.categories", ["quality_dispute", "damage", "incomplete_work"]], ["refund.policy", { dualApprovalAbovePaise: 500000, mdrPercent: 2.36 }]]) {
    await ensure(GlobalSetting, { key: k }, { key: k, value: v, updatedBy: admin._id, updatedByRole: "Admin" }, "GlobalSetting");
  }

  // ── SUMMARY + MAP ─────────────────────────────────────────────
  console.log("\n✅ Dummy seed complete. New docs this run:");
  for (const [k, v] of Object.entries(counts)) console.log(`   +${v} ${k}`);
  console.log("\n🗺️  Dummy data map (ids for testing):");
  console.log(JSON.stringify({
    users: { owner: owner._id, admin: admin._id, customer1: cust1._id, customer2: cust2._id, techUser1: techU1._id, techUser2: techU2._id },
    logins: { ownerMobile: "9000000001", adminMobile: "9000000002", customer1Mobile: "9000000003", customer2Mobile: "9000000004", tech1Mobile: "9000000005", tech2Mobile: "9000000006", password_owner_admin: "Dummy@1234" },
    catalog: { serviceAC: svcAC._id, serviceWM: svcWM._id, productAC: prodAC._id, productFridge: prodFridge._id },
    geo: { district: district._id, zone1: zone1._id, zone2: zone2._id },
    technicians: { tech1: tech1._id, tech2: tech2._id },
    bookings: { completedPaid: bookingDone._id, liveBroadcasted: bookingLive._id },
    quoteFlow: { request: qr._id, quotation: quote._id, productBooking: pBooking._id },
    money: { paymentCompleted: pay1._id, withdrawalPaid: wd._id, refundInitiated: refund._id, reportUnderReview: report._id, notification: notif._id },
  }, null, 2));

  await mongoose.disconnect();
};

run().catch((e) => { console.error("❌ Seed failed:", e); process.exit(1); });
