/**
 * Generates the FULL Technician-role collection:
 * postman/technician/RightTouch-API-Technician.postman_collection.json
 *
 * Every /api/technician* backend route (technician.js + wallet + refunds +
 * finance + notifications + permissions + device-token) with:
 *  - Authorization: Bearer {{technicianToken}} (absent only on public auth/registration reads)
 *  - Content-Type: application/json on JSON bodies
 *  - Example bodies / query params / form-data file placeholders
 *
 * Run: node postman/generate_technician_collection.js
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const T = "technicianToken";

const auth = () => [
  { key: "Authorization", value: `Bearer {{${T}}}`, type: "text" },
  { key: "Content-Type", value: "application/json", type: "text" },
];
const authNoBody = () => [{ key: "Authorization", value: `Bearer {{${T}}}`, type: "text" }];
const url = (p, query = []) => ({
  raw: `{{baseUrl}}${p}${query.length ? "?" + query.map((q) => `${q.key}=${q.value}`).join("&") : ""}`,
  host: ["{{baseUrl}}"],
  path: p.replace(/^\//, "").split("/"),
  ...(query.length ? { query: query.map((q) => ({ key: q.key, value: q.value, description: q.description || "" })) } : {}),
});
const jsonBody = (obj) => ({ mode: "raw", raw: JSON.stringify(obj, null, 2), options: { raw: { language: "json" } } });
const formFile = (fields) => ({
  mode: "formdata",
  formdata: fields.map((f) => ({ key: f, type: "file", src: `REPLACE_WITH_${f.toUpperCase()}_FILE_PATH` })),
});
const R = (name, method, p, opts = {}) => {
  const hasBody = opts.body !== undefined || opts.form !== undefined;
  const r = { name, request: { method, header: opts.public ? [] : hasBody && !opts.form ? auth() : authNoBody(), url: url(p, opts.query || []) } };
  if (opts.description) r.request.description = opts.description;
  if (opts.body !== undefined) {
    r.request.body = jsonBody(opts.body);
    if (!opts.public && !r.request.header.some((h) => h.key === "Content-Type"))
      r.request.header.push({ key: "Content-Type", value: "application/json", type: "text" });
  }
  if (opts.form !== undefined) r.request.body = formFile(opts.form);
  return r;
};

const LAT = 11.0168;
const LNG = 76.9558;

const collection = {
  info: {
    _postman_id: "rt-technician-full-v1",
    name: "RightTouch API - Technician Operations",
    description:
      "COMPLETE Technician-role collection (all /api/technician* routes). Auth: technicianToken variable (login via 1.x). Public endpoints (signup/login/registration reads) carry no token. FINAL zone rules: registration anywhere allowed; jobs only in Admin-approved zones (enabledCityZoneIds); zone/me shows mismatch; skills gated for zoneRestricted services.",
    schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
  },
  variable: [
    { key: "baseUrl", value: "http://localhost:7372", type: "string" },
    { key: "technicianToken", value: "PASTE_TECHNICIAN_JWT", type: "string" },
    { key: "adminToken", value: "PASTE_ADMIN_JWT_FOR_ADMIN_ONLY_CALLS", type: "string" },
    { key: "districtId", value: "REPLACE_WITH_OPERATIONAL_CITY_ID", type: "string" },
    { key: "cityZoneId", value: "REPLACE_WITH_CITY_ZONE_ID", type: "string" },
    { key: "zoneId", value: "REPLACE_WITH_CITY_ZONE_ID", type: "string" },
    { key: "serviceId", value: "REPLACE_WITH_SERVICE_ID", type: "string" },
    { key: "technicianId", value: "REPLACE_WITH_TECHNICIAN_PROFILE_ID", type: "string" },
    { key: "bookingId", value: "REPLACE_WITH_BOOKING_ID", type: "string" },
    { key: "broadcastId", value: "REPLACE_WITH_BROADCAST_ID", type: "string" },
    { key: "kycId", value: "REPLACE_WITH_KYC_DOC_ID", type: "string" },
    { key: "notificationId", value: "REPLACE_WITH_NOTIFICATION_ID", type: "string" },
    { key: "withdrawalId", value: "REPLACE_WITH_WITHDRAWAL_ID", type: "string" },
    { key: "transactionId", value: "REPLACE_WITH_WALLET_TXN_ID", type: "string" },
    { key: "complaintId", value: "REPLACE_WITH_COMPLAINT_ID", type: "string" },
  ],
  item: [
    {
      name: "1. Auth (public)",
      item: [
        R("Signup technician (send OTP)", "POST", "/api/technician/signup/technician", { public: true, body: { fname: "Ravi", lname: "Kumar", mobileNumber: "9876543210", role: "Technician" } }),
        R("Signup verify OTP (public)", "POST", "/api/technician/signup/technician/verify-otp", { public: true, body: { mobileNumber: "9876543210", otp: "123456" } }),
        R("Login technician (send OTP)", "POST", "/api/technician/login/technician", { public: true, body: { mobileNumber: "9876543210" } }),
        R("Login verify OTP (public)", "POST", "/api/technician/login/technician/verify-otp", { public: true, body: { mobileNumber: "9876543210", otp: "123456" }, description: "Returns technicianToken — set it in collection variables." }),
      ],
    },
    {
      name: "2. Registration + zones (public reads)",
      description: "Register from anywhere. Zone permission is a separate Admin approval step.",
      item: [
        R("Registration districts", "GET", "/api/technician/registration/districts", { public: true }),
        R("Districts alias", "GET", "/api/technician/districts", { public: true }),
        R("Registration zones for district", "GET", "/api/technician/registration/zones", { public: true, query: [{ key: "districtId", value: "{{districtId}}" }] }),
        R("Zones alias", "GET", "/api/technician/zones", { public: true, query: [{ key: "districtId", value: "{{districtId}}" }] }),
        R("Validate registration location", "POST", "/api/technician/registration/validate-location", { public: true, body: { latitude: LAT, longitude: LNG, selectedDistrictId: "{{districtId}}", selectedZoneId: "{{cityZoneId}}" }, description: "Authoritative GPS vs selected district/zone check." }),
        R("Zone services (public)", "GET", "/api/technician/registration/zone-services", { public: true, query: [{ key: "zoneId", value: "{{cityZoneId}}" }] }),
        R("Zone services (auth, my skills annotated)", "GET", "/api/technician/zone-services", { query: [{ key: "zoneId", value: "{{cityZoneId}}" }] }),
        R("Submit skill request", "POST", "/api/technician/skill-requests", { body: { serviceId: "{{serviceId}}", experienceYears: 2, reason: "2 years AC repair experience", documentUrls: [], zoneId: "{{cityZoneId}}" } }),
        R("My skill requests", "GET", "/api/technician/skill-requests", {}),
      ],
    },
    {
      name: "3. Zone status (FINAL rules)",
      item: [
        R("My zone + mismatch", "GET", "/api/technician/zone/me", { description: "Registered zone, zoneMismatch flag, mismatchSince." }),
        R("Services in my zone", "GET", "/api/technician/zone/services", { description: "Active ZoneServiceMapping services for my cityZoneId." }),
      ],
    },
    {
      name: "4. Profile",
      item: [
        R("Create technician profile", "POST", "/api/technician/technicianData", { body: { locality: "Gandhipuram", address: "100 Cross St", city: "Coimbatore", state: "Tamil Nadu", pincode: "641012", experienceYears: 3, specialization: "AC Repair", serviceRadiusKm: 10 } }),
        R("List technicians (admin view)", "GET", "/api/technician/technicianAll", { query: [{ key: "zoneId", value: "{{cityZoneId}}" }] }),
        R("Technician by id", "GET", "/api/technician/technicianById/{{technicianId}}", {}),
        R("My profile (token)", "GET", "/api/technician/technician/me", {}),
        R("Update my profile", "PUT", "/api/technician/updateTechnician", { body: { locality: "RS Puram", city: "Coimbatore", state: "Tamil Nadu", pincode: "641002", experienceYears: 4, specialization: "AC + Refrigerator" } }),
        R("Add skills (zone-gated if restricted)", "PUT", "/api/technician/technician/skills/add", { body: { serviceIds: ["{{serviceId}}"], experienceYears: 2 }, description: "zoneRestricted services need an active mapping in ANY of my zones." }),
        R("Remove skills", "PUT", "/api/technician/technician/skills/remove", { body: { serviceIds: ["{{serviceId}}"] } }),
        R("Update status (online/offline)", "PUT", "/api/technician/technician/status", { body: { isOnline: true } }),
        R("Update training flag", "PUT", "/api/technician/{{technicianId}}/training", { body: { trainingCompleted: true } }),
        R("Upload profile image", "POST", "/api/technician/technician/profile-image", { form: ["profileImage"], description: "multipart/form-data. Replace src with a local file." }),
        R("Delete technician (admin)", "DELETE", "/api/technician/technicianDelete/{{technicianId}}", {}),
        R("Update live location", "PUT", "/api/technician/location", { body: { latitude: LAT, longitude: LNG }, description: "Drives zoneMismatch + job matching (30s rate limit)." }),
        R("Register FCM token", "PUT", "/api/technician/fcm-token", { body: { fcmToken: "PASTE_FCM_DEVICE_TOKEN" } }),
      ],
    },
    {
      name: "5. KYC + bank",
      item: [
        R("Submit KYC", "POST", "/api/technician/kyc", { body: { aadhaarNumber: "123412341234", panNumber: "ABCDE1234F", drivingLicenseNumber: "TN3820250001234" } }),
        R("Submit KYC alias", "POST", "/api/technician/technician/kyc", { body: { aadhaarNumber: "123412341234", panNumber: "ABCDE1234F" } }),
        R("Submit bank details", "POST", "/api/technician/banks", { body: { accountNumber: "50100234567890", ifscCode: "HDFC0001234", accountName: "Ravi Kumar", upiId: "ravi@upi" } }),
        R("Submit bank alias 1", "POST", "/api/technician/technician/banks", { body: { accountNumber: "50100234567890", ifscCode: "HDFC0001234", accountName: "Ravi Kumar" } }),
        R("Submit bank alias 2", "POST", "/api/technician/kyc/bank-details", { body: { accountNumber: "50100234567890", ifscCode: "HDFC0001234", accountName: "Ravi Kumar" } }),
        R("Submit bank alias 3", "POST", "/api/technician/technician/kyc/bank-details", { body: { accountNumber: "50100234567890", ifscCode: "HDFC0001234", accountName: "Ravi Kumar" } }),
        R("Upload KYC docs", "POST", "/api/technician/kyc/upload", { form: ["aadhaarImage", "panImage", "dlImage"] }),
        R("Upload KYC docs alias", "POST", "/api/technician/technician/kyc/upload", { form: ["aadhaarImage", "panImage", "dlImage"] }),
        R("My KYC", "GET", "/api/technician/kyc/me", {}),
        R("My KYC alias", "GET", "/api/technician/technician/kyc/me", {}),
        R("All KYC (admin)", "GET", "/api/technician/kyc", {}),
        R("All KYC alias (admin)", "GET", "/api/technician/technician/kyc", {}),
        R("KYC full (admin)", "GET", "/api/technician/kyc/{{technicianId}}/full", {}),
        R("KYC full alias (admin)", "GET", "/api/technician/technician/kyc/{{technicianId}}/full", {}),
        R("KYC by tech (admin)", "GET", "/api/technician/kyc/{{technicianId}}", {}),
        R("KYC by tech alias (admin)", "GET", "/api/technician/technician/kyc/{{technicianId}}", {}),
        R("Verify KYC (admin)", "PUT", "/api/technician/kyc/verify", { body: { technicianId: "{{technicianId}}", status: "approved", rejectionReason: "" }, description: "Admin/Owner only (kycAdminLimiter)." }),
        R("Verify KYC alias (admin)", "PUT", "/api/technician/technician/kyc/verify", { body: { technicianId: "{{technicianId}}", status: "approved" } }),
        R("Verify bank (admin)", "PUT", "/api/technician/kyc/bank/verify", { body: { technicianId: "{{technicianId}}", verified: true } }),
        R("Verify bank alias (admin)", "PUT", "/api/technician/technician/kyc/bank/verify", { body: { technicianId: "{{technicianId}}", verified: true } }),
        R("Update KYC details (admin)", "PUT", "/api/technician/kyc/{{technicianId}}", { body: { aadhaarNumber: "123412341234", panNumber: "ABCDE1234F", drivingLicenseNumber: "TN3820250001234" } }),
        R("Update bank details (admin)", "PUT", "/api/technician/bank/{{technicianId}}", { body: { accountNumber: "50100234567890", ifscCode: "HDFC0001234", accountName: "Ravi Kumar" } }),
        R("Delete KYC (admin)", "DELETE", "/api/technician/deletekyc/{{technicianId}}", {}),
        R("Delete KYC alias (admin)", "DELETE", "/api/technician/technician/deletekyc/{{technicianId}}", {}),
        R("Orphaned KYC list (admin)", "GET", "/api/technician/kyc/orphaned/list", {}),
        R("Orphaned KYC list alias", "GET", "/api/technician/technician/kyc/orphaned/list", {}),
        R("Cleanup orphaned KYC (admin)", "DELETE", "/api/technician/kyc/orphaned/cleanup/all", {}),
        R("Cleanup orphaned KYC alias", "DELETE", "/api/technician/technician/kyc/orphaned/cleanup/all", {}),
        R("Delete orphaned KYC doc (admin)", "DELETE", "/api/technician/kyc/orphaned/{{kycId}}", {}),
        R("Delete orphaned KYC doc alias", "DELETE", "/api/technician/technician/kyc/orphaned/{{kycId}}", {}),
      ],
    },
    {
      name: "6. Jobs + broadcast",
      item: [
        R("My broadcast jobs", "GET", "/api/technician/job-broadcast/my-jobs", {}),
        R("Respond to job", "PUT", "/api/technician/job-broadcast/respond/{{broadcastId}}", { body: { action: "accept", version: 1 }, description: "action: accept|reject. Version-guarded; eligibility re-validated (ACCEPT mode)." }),
        R("Cancel my booking", "PUT", "/api/technician/booking/technician/cancel/{{bookingId}}", { body: { reason: "Customer not available", cancellationFeeApplicable: false } }),
        R("Re-accept cancelled job", "PUT", "/api/technician/booking/reaccept/{{bookingId}}", { description: "Optional admin-configured penalty %." }),
        R("Update booking status", "PUT", "/api/technician/status/{{bookingId}}", { body: { status: "on_the_way" }, description: "accepted -> on_the_way -> reached -> in_progress -> completed." }),
        R("Upload work images", "POST", "/api/technician/jobs/{{bookingId}}/work-images", { form: ["beforeImage", "afterImage"] }),
        R("Current jobs", "GET", "/api/technician/jobs/current", {}),
        R("Accepted jobs", "GET", "/api/technician/jobs/accepted", {}),
        R("Accepted scheduled jobs", "GET", "/api/technician/jobs/accepted/scheduled", {}),
        R("Job history", "GET", "/api/technician/jobs/history", {}),
        R("Admin job history", "GET", "/api/technician/admin/jobs/history", { description: "Owner/Admin only." }),
      ],
    },
    {
      name: "7. Wallet + payouts + finance",
      item: [
        R("Create wallet txn (admin)", "POST", "/api/technician/wallet/transaction", { body: { technicianId: "{{technicianId}}", bookingId: "{{bookingId}}", amount: 100, type: "credit", source: "admin_adjustment" } }),
        R("Wallet history", "GET", "/api/technician/wallet/history", {}),
        R("Request withdrawal", "POST", "/api/technician/wallet/withdrawal", { body: { amount: 500, mode: "UPI" } }),
        R("Request withdrawal alias", "POST", "/api/technician/wallet/withdrawal/request", { body: { amount: 500, mode: "UPI" } }),
        R("My withdrawals", "GET", "/api/technician/wallet/withdrawalhistory/me", {}),
        R("Cancel withdrawal", "PUT", "/api/technician/wallet/withdrawal/{{withdrawalId}}/cancel", {}),
        R("Wallet summary", "GET", "/api/technician/wallet", {}),
        R("Wallet transactions", "GET", "/api/technician/wallet/transactions", {}),
        R("Withdrawal request (wallet routes)", "POST", "/api/technician/wallet/withdrawal", { body: { amount: 500, mode: "UPI" } }),
        R("Withdrawal request alias", "POST", "/api/technician/wallet/withdrawal/request", { body: { amount: 500, mode: "UPI" } }),
        R("Cancel withdrawal (wallet routes)", "POST", "/api/technician/wallet/withdrawal/{{withdrawalId}}/cancel", {}),
        R("Withdrawal receipt", "GET", "/api/technician/wallet/withdrawal/{{withdrawalId}}/receipt", {}),
        R("My withdrawal history (wallet routes)", "GET", "/api/technician/wallet/withdrawalhistory", {}),
        R("Update payout settings", "PUT", "/api/technician/wallet/payout-settings", { body: { autoPayoutEnabled: true, autoPayoutThresholdPaise: 500000, minimumMaintenancePaise: 10000, preferredPayoutMode: "UPI" } }),
        R("My refunds", "GET", "/api/technician/refunds", {}),
        R("Report categories", "GET", "/api/technician/reports/categories", {}),
        R("My finance earnings", "GET", "/api/technician/finance/earnings", {}),
      ],
    },
    {
      name: "8. Complaints",
      item: [
        R("My complaints", "GET", "/api/technician/complaints", {}),
        R("Complaint detail", "GET", "/api/technician/complaints/{{complaintId}}", {}),
        R("Respond to complaint", "POST", "/api/technician/complaints/{{complaintId}}/respond", { form: ["images"], description: "multipart + text fields (message). Add message field in Postman as text." }),
      ],
    },
    {
      name: "9. Notifications",
      item: [
        R("List notifications", "GET", "/api/technician/notifications", {}),
        R("Unread count", "GET", "/api/technician/notifications/unread-count", {}),
        R("Unread counts", "GET", "/api/technician/notifications/unread-counts", {}),
        R("Mark one read", "PATCH", "/api/technician/notifications/{{notificationId}}/read", {}),
        R("Mark all read", "PATCH", "/api/technician/notifications/read-all", {}),
        R("Mark read (admin style)", "PATCH", "/api/technician/notifications/mark-read", { body: { notificationIds: ["{{notificationId}}"] } }),
        R("Mark received", "POST", "/api/technician/notifications/{{notificationId}}/received", { body: { deviceId: "test-device-1" } }),
        R("Mark opened", "POST", "/api/technician/notifications/{{notificationId}}/opened", { body: { deviceId: "test-device-1" } }),
      ],
    },
    {
      name: "10. Permissions + device token",
      item: [
        R("Get my permissions", "GET", "/api/technician/permissions", {}),
        R("Update permissions", "PUT", "/api/technician/permissions", { body: { platform: "android", appVersion: "1.0.0", permissions: { location: true, camera: true, notification: true } } }),
        R("Register device token", "POST", "/api/technician/device-token", { body: { deviceId: "test-device-1", fcmToken: "PASTE_FCM_DEVICE_TOKEN", platform: "android" } }),
        R("Unregister device token", "DELETE", "/api/technician/device-token", { body: { deviceId: "test-device-1" } }),
      ],
    },
  ],
};

const outDir = path.join(__dirname, "technician");
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, "RightTouch-API-Technician.postman_collection.json");
fs.writeFileSync(out, JSON.stringify(collection, null, 2));
const n = collection.item.reduce((a, f) => a + f.item.length, 0);
console.log(`Wrote ${out} (${n} requests)`);
