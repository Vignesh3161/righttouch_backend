/**
 * Generates the canonical zone-wise collection for EACH role:
 * postman/master/RightTouch_Zone_Wise_All_Roles.postman_collection.json
 *
 * All zone-wise endpoints grouped per role with proper auth:
 *  - Admin (adminToken)    : zones CRUD, mappings, toggle, candidates,
 *    districts/operational-cities, geofence, service-availability matrix,
 *    technician district/zone approval, zone-restriction flag, diagnostics
 *  - Technician (technicianToken): registration, zone/me, zone/services,
 *    zone-gated skills, location
 *  - Customer (customerToken): addresses/default, service listing (pre-address
 *    FULL catalog with no params; post-address zone-filtered via default
 *    address), resolve, check-service, cart, checkout, direct booking
 *  - Technician (technicianToken): registration, zone/me, zone/services,
 *    zone-gated skills, location, service browse (no default address — full
 *    catalog, pricing hidden; jobs via GPS + enabledCityZoneIds only)
 *
 * FINAL backend rules: pre-address (no explicit location + no usable customer
 * default address) => FULL active catalog with availabilityPrompt; post-address
 * => zone-filtered (District + Zone both required); explicit location outside
 * all polygons => [] "No services available in your area"; inactive/invalid
 * zone => [] "Services are currently unavailable in this area"; new zones seed
 * DISABLED; registration != approval (enabledCityZoneIds only); technicians
 * have NO default address (Address lookup is Customer-only).
 *
 * Run: node postman/generate_zone_wise_complete.js
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const auth = (v) => [
  { key: "Authorization", value: `Bearer {{${v}}}`, type: "text" },
  { key: "Content-Type", value: "application/json", type: "text" },
];
const authNoBody = (v) => [{ key: "Authorization", value: `Bearer {{${v}}}`, type: "text" }];
const url = (p, query = []) => ({
  raw: `{{baseUrl}}${p}${query.length ? "?" + query.map((q) => `${q.key}=${q.value}`).join("&") : ""}`,
  host: ["{{baseUrl}}"],
  path: p.replace(/^\//, "").split("/"),
  ...(query.length ? { query: query.map((q) => ({ key: q.key, value: q.value, description: q.description || "" })) } : {}),
});
const R = (name, method, p, token, opts = {}) => {
  const r = { name, request: { method, header: opts.body ? auth(token) : authNoBody(token), url: url(p, opts.query || []) } };
  if (opts.description) r.request.description = opts.description;
  if (opts.body !== undefined) r.request.body = { mode: "raw", raw: JSON.stringify(opts.body, null, 2), options: { raw: { language: "json" } } };
  return r;
};

const POLY = { type: "Polygon", coordinates: [[[76.95, 11.01], [76.96, 11.01], [76.96, 11.02], [76.95, 11.02], [76.95, 11.01]]] };
const LAT = 11.0168;
const LNG = 76.9558;
const A = "adminToken";
const Tc = "technicianToken";
const Cu = "customerToken";

const collection = {
  info: {
    _postman_id: "rt-zone-wise-all-roles-v3",
    name: "RightTouch Zone-Wise — All Roles (FINAL rules)",
    description: "Zone-wise endpoints per role. FINAL catalog rules: (1) PRE-ADDRESS (no explicit location + no usable customer default address, incl. logged-out) => FULL active catalog + availabilityPrompt. (2) POST-ADDRESS (explicit lat/lng/zoneId or customer default address) => zone-filtered, District + Zone both required. (3) Explicit location outside all polygons => [] 'No services available in your area'. (4) Inactive/invalid zone => [] 'Services are currently unavailable in this area'. (5) New zones seed every service DISABLED. (6) Technicians register anywhere, have NO default address (Address lookup is Customer-only); jobs only in Admin-approved zones. Set baseUrl + role tokens in variables.",
    schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
  },
  variable: [
    { key: "baseUrl", value: "http://localhost:7372", type: "string" },
    { key: "adminToken", value: "PASTE_ADMIN_OR_OWNER_JWT", type: "string" },
    { key: "technicianToken", value: "PASTE_TECHNICIAN_JWT", type: "string" },
    { key: "customerToken", value: "PASTE_CUSTOMER_JWT", type: "string" },
    { key: "districtId", value: "REPLACE_WITH_OPERATIONAL_CITY_ID", type: "string" },
    { key: "cityZoneId", value: "REPLACE_WITH_CITY_ZONE_ID", type: "string" },
    { key: "serviceId", value: "REPLACE_WITH_SERVICE_ID", type: "string" },
    { key: "technicianId", value: "REPLACE_WITH_TECHNICIAN_PROFILE_ID", type: "string" },
    { key: "bookingId", value: "REPLACE_WITH_BOOKING_ID", type: "string" },
    { key: "addressId", value: "REPLACE_WITH_ADDRESS_ID", type: "string" },
    { key: "availabilityId", value: "REPLACE_WITH_AVAILABILITY_ID", type: "string" },
  ],
  item: [
    {
      name: "ADMIN — zones CRUD + mappings (adminToken)",
      item: [
        R("List zones", "GET", "/api/admin/zones", A, { query: [{ key: "operationalCityId", value: "{{districtId}}" }, { key: "active", value: "true" }] }),
        R("Get zone", "GET", "/api/admin/zones/{{cityZoneId}}", A, {}),
        R("Create zone (seeds DISABLED)", "POST", "/api/admin/zones", A, { description: "Response includes seededDisabledServices. Every active service starts DISABLED.", body: { operationalCityId: "{{districtId}}", name: "Gandhipuram", zoneCode: "CBE-GANDHI-01", polygon: POLY, active: true, description: "Gandhipuram micro-zone" } }),
        R("Update zone / deactivate", "PUT", "/api/admin/zones/{{cityZoneId}}", A, { description: "active:false deactivates — listing [] + checkout blocked inside.", body: { name: "Gandhipuram", active: true, description: "Updated" } }),
        R("Delete zone (cascades)", "DELETE", "/api/admin/zones/{{cityZoneId}}", A, { description: "Deletes mappings + ZONE overrides; pulls tech approvals; nulls registrations." }),
        R("Zone technician candidates", "GET", "/api/admin/zones/{{cityZoneId}}/technician-candidates", A, { description: "GPS-inside but NOT approved. Approve via technicians/:id/city-zones." }),
        R("List zone-service mappings", "GET", "/api/admin/zone-mappings", A, { query: [{ key: "zoneId", value: "{{cityZoneId}}" }] }),
        R("Enable services in zone", "POST", "/api/admin/zone-mappings", A, { body: { zoneId: "{{cityZoneId}}", serviceIds: ["{{serviceId}}"] } }),
        R("Delete zone-service mapping", "DELETE", "/api/admin/zone-mappings/{{cityZoneId}}/{{serviceId}}", A, {}),
        R("Bulk toggle zone services", "PUT", "/api/admin/zones/{{cityZoneId}}/services/toggle", A, { description: "Syncs ServiceAvailability ZONE overrides too.", body: { active: true } }),
      ],
    },
    {
      name: "ADMIN — districts + geofence (adminToken)",
      item: [
        R("List districts", "GET", "/api/admin/districts", A, { query: [{ key: "active", value: "true" }] }),
        R("Get district", "GET", "/api/admin/districts/{{districtId}}", A, {}),
        R("Active operational city", "GET", "/api/admin/operational-cities/active", A, {}),
        R("Active polygons", "GET", "/api/admin/operational-cities/polygons", A, {}),
        R("Create district", "POST", "/api/admin/districts", A, { body: { name: "Coimbatore", city: "Coimbatore", state: "Tamil Nadu", country: "India", code: "CBE", polygon: POLY, isRegistrationEnabled: true, isJobEnabled: true } }),
        R("Update district", "PUT", "/api/admin/districts/{{districtId}}", A, { body: { name: "Coimbatore", isRegistrationEnabled: true, isJobEnabled: true } }),
        R("District status", "PATCH", "/api/admin/districts/{{districtId}}/status", A, { body: { active: true } }),
        R("District registration flag", "PATCH", "/api/admin/districts/{{districtId}}/registration", A, { body: { isRegistrationEnabled: true } }),
        R("District jobs flag", "PATCH", "/api/admin/districts/{{districtId}}/jobs", A, { body: { isJobEnabled: true } }),
        R("District technicians", "GET", "/api/admin/districts/{{districtId}}/technicians", A, {}),
        R("Delete district", "DELETE", "/api/admin/districts/{{districtId}}", A, {}),
        R("Geofence create city-zone", "POST", "/api/admin/zone-geofence/city-zones", A, { body: { operationalCityId: "{{districtId}}", name: "RS Puram", zoneCode: "CBE-RSP-01", polygon: POLY } }),
        R("Geofence list city-zones", "GET", "/api/admin/zone-geofence/city-zones", A, { query: [{ key: "districtId", value: "{{districtId}}" }] }),
        R("Geofence create district", "POST", "/api/admin/zone-geofence/districts", A, { body: { name: "Coimbatore", state: "Tamil Nadu", polygon: POLY, isRegistrationEnabled: true, isJobEnabled: true } }),
        R("Geofence list districts", "GET", "/api/admin/zone-geofence/districts", A, {}),
        R("Grant district to tech", "POST", "/api/admin/zone-geofence/technicians/grant-district", A, { body: { technicianId: "{{technicianId}}", districtId: "{{districtId}}", reason: "Coverage expansion" } }),
        R("Revoke district from tech", "POST", "/api/admin/zone-geofence/technicians/revoke-district", A, { body: { technicianId: "{{technicianId}}", districtId: "{{districtId}}", reason: "Coverage revoked" } }),
        R("Spatial hierarchy", "GET", "/api/admin/zone-geofence/spatial-hierarchy", A, {}),
        R("Impact analysis", "GET", "/api/admin/zone-geofence/impact-analysis", A, { query: [{ key: "type", value: "district" }, { key: "id", value: "{{districtId}}" }] }),
        R("District dashboard", "GET", "/api/admin/zone-geofence/districts/{{districtId}}/dashboard", A, {}),
        R("Inspect job location", "GET", "/api/admin/zone-geofence/jobs/{{bookingId}}/location-inspect", A, {}),
        R("Job broadcast audit", "GET", "/api/admin/zone-geofence/jobs/{{bookingId}}/broadcast-audit", A, {}),
        R("Zone health dashboard", "GET", "/api/admin/zone-geofence/zone-health-dashboard", A, {}),
        R("Geofence technicians", "GET", "/api/admin/zone-geofence/technicians", A, { query: [{ key: "districtId", value: "{{districtId}}" }] }),
        R("Geofence tech details", "GET", "/api/admin/zone-geofence/technicians/{{technicianId}}/details", A, {}),
        R("Tech verification action", "POST", "/api/admin/zone-geofence/technicians/{{technicianId}}/verification", A, { body: { action: "APPROVE", reason: "Docs verified" } }),
        R("Polygon rollback", "POST", "/api/admin/zone-geofence/polygons/rollback", A, { body: { entityType: "CITY_ZONE", entityId: "{{cityZoneId}}", targetVersion: 1 } }),
      ],
    },
    {
      name: "ADMIN — service availability (adminToken)",
      item: [
        R("Service-zone matrix", "GET", "/api/admin/service-availability/matrix", A, { query: [{ key: "districtId", value: "{{districtId}}" }] }),
        R("Service zone detail", "GET", "/api/admin/service-availability/service/{{serviceId}}/detail", A, {}),
        R("Toggle single zone", "POST", "/api/admin/service-availability/toggle-zone", A, { description: "Writes BOTH ServiceAvailability and ZoneServiceMapping.", body: { serviceId: "{{serviceId}}", districtId: "{{districtId}}", cityZoneId: "{{cityZoneId}}", status: "ENABLED" } }),
        R("Bulk toggle zones", "POST", "/api/admin/service-availability/bulk-toggle-zones", A, { body: { serviceId: "{{serviceId}}", districtId: "{{districtId}}", cityZoneIds: ["{{cityZoneId}}"], status: "ENABLED" } }),
        R("Clear district zones", "POST", "/api/admin/service-availability/clear-district-zones", A, { body: { serviceId: "{{serviceId}}", districtId: "{{districtId}}" } }),
        R("Toggle global service", "POST", "/api/admin/service-availability/toggle-service-status", A, { body: { serviceId: "{{serviceId}}", isActive: true } }),
        R("Toggle zone-restriction flag", "PUT", "/api/user/service/{{serviceId}}/zone-restriction", A, { body: { zoneRestricted: true } }),
        R("Create availability config", "POST", "/api/admin/service-availability", A, { body: { serviceId: "{{serviceId}}", districtId: "{{districtId}}", scope: "DISTRICT", status: "ENABLED" } }),
        R("List availability configs", "GET", "/api/admin/service-availability", A, { query: [{ key: "districtId", value: "{{districtId}}" }] }),
        R("Update availability config", "PUT", "/api/admin/service-availability/{{availabilityId}}", A, { body: { status: "DISABLED" } }),
        R("Delete availability config", "DELETE", "/api/admin/service-availability/{{availabilityId}}", A, {}),
        R("Dispatch diagnostics", "GET", "/api/admin/dispatch-debug", A, { query: [{ key: "technicianId", value: "{{technicianId}}" }, { key: "bookingId", value: "{{bookingId}}" }] }),
      ],
    },
    {
      name: "ADMIN — technician approval (adminToken)",
      description: "STRICT: only enabledCityZoneIds grants jobs; cityZoneId alone never qualifies.",
      item: [
        R("Tech district permissions", "GET", "/api/admin/technicians/{{technicianId}}/districts", A, {}),
        R("Add tech district", "POST", "/api/admin/technicians/{{technicianId}}/districts", A, { body: { districtId: "{{districtId}}" } }),
        R("Toggle tech district", "PATCH", "/api/admin/technicians/{{technicianId}}/districts/{{districtId}}", A, { body: { isEnabled: true } }),
        R("Remove tech district", "DELETE", "/api/admin/technicians/{{technicianId}}/districts/{{districtId}}", A, {}),
        R("Tech zone permissions", "GET", "/api/admin/technicians/{{technicianId}}/city-zones", A, {}),
        R("Approve zone(s)", "POST", "/api/admin/technicians/{{technicianId}}/city-zones", A, { description: "Parent district permission required first.", body: { cityZoneIds: ["{{cityZoneId}}"], reason: "Assigned coverage for Gandhipuram cluster" } }),
        R("Revoke single zone", "DELETE", "/api/admin/technicians/{{technicianId}}/city-zones/{{cityZoneId}}", A, {}),
        R("Bulk revoke zones", "DELETE", "/api/admin/technicians/{{technicianId}}/city-zones", A, { body: { cityZoneIds: ["{{cityZoneId}}"], reason: "Coverage area updated" } }),
      ],
    },
    {
      name: "TECHNICIAN — zone endpoints (technicianToken)",
      description: "Technicians have NO default address: service browse with no explicit location returns the FULL catalog (pricing hidden). Job eligibility is live GPS + Admin-approved enabledCityZoneIds only.",
      item: [
        R("Registration districts", "GET", "/api/technician/registration/districts", Tc, {}),
        R("Registration zones", "GET", "/api/technician/registration/zones", Tc, { query: [{ key: "districtId", value: "{{districtId}}" }] }),
        R("Validate location", "POST", "/api/technician/registration/validate-location", Tc, { body: { latitude: LAT, longitude: LNG, selectedDistrictId: "{{districtId}}", selectedZoneId: "{{cityZoneId}}" } }),
        R("Zone services", "GET", "/api/technician/registration/zone-services", Tc, { query: [{ key: "zoneId", value: "{{cityZoneId}}" }] }),
        R("My zone + mismatch", "GET", "/api/technician/zone/me", Tc, {}),
        R("Services in my zone", "GET", "/api/technician/zone/services", Tc, {}),
        R("Browse services (no default address → FULL catalog)", "GET", "/api/user/getAllServices", Tc, { description: "No Address lookup for technicians. Returns ALL active services with pricing hidden (technicianAmount only). Pass ?latitude & longitude or ?zoneId to zone-filter instead." }),
        R("Browse services (explicit zone → filtered)", "GET", "/api/user/getAllServices", Tc, { description: "Zone-filtered by ?zoneId; pricing hidden for technicians.", query: [{ key: "zoneId", value: "{{cityZoneId}}" }] }),
        R("Add skills (zone-gated)", "PUT", "/api/technician/technician/skills/add", Tc, { description: "zoneRestricted services need mapping in ANY of my zones.", body: { serviceIds: ["{{serviceId}}"], experienceYears: 2 } }),
        R("Update live location", "PUT", "/api/technician/location", Tc, { body: { latitude: LAT, longitude: LNG } }),
      ],
    },
    {
      name: "CUSTOMER — zone endpoints (customerToken)",
      description: "PRE-ADDRESS: no params => FULL catalog. POST-ADDRESS: default address or explicit location => zone-filtered. Booking/checkout gates unchanged.",
      item: [
        R("Create address", "POST", "/api/addresses", Cu, { body: { label: "home", name: "Test Customer", phone: "9876543210", addressLine: "100 Gandhipuram, Coimbatore", city: "Coimbatore", state: "Tamil Nadu", pincode: "641012", latitude: LAT, longitude: LNG, isDefault: false } }),
        R("My addresses", "GET", "/api/addresses", Cu, {}),
        R("Default address", "GET", "/api/addresses/default", Cu, {}),
        R("Set default address", "PUT", "/api/addresses/default", Cu, { body: { addressId: "{{addressId}}" } }),
        {
          name: "List services (PRE-ADDRESS → FULL catalog, no auth needed)",
          request: {
            method: "GET",
            header: [],
            url: url("/api/user/getAllServices"),
            description: "No token, no params: returns ALL active services + availabilityPrompt 'Select an address to check exact service availability.' Same for a logged-in customer with no default address.",
          },
        },
        R("List services (default address → filtered)", "GET", "/api/user/getAllServices", Cu, { description: "Backend resolves the customer default address internally. Only zone-enabled services returned (District + Zone both required); none in area => [] 'No services available in your area'." }),
        R("List services (explicit point → filtered)", "GET", "/api/user/getAllServices", Cu, { query: [{ key: "latitude", value: String(LAT) }, { key: "longitude", value: String(LNG) }], description: "Selected-address / map-pin flow: filters by resolved District + Zone, default address ignored." }),
        R("List services (explicit zone → filtered)", "GET", "/api/user/getAllServices", Cu, { query: [{ key: "zoneId", value: "{{cityZoneId}}" }], description: "Filters by ?zoneId (+ derived district). Unknown zoneId => [] 'Services are currently unavailable in this area'." }),
        R("List services (outside area → [])", "GET", "/api/user/getAllServices", Cu, { query: [{ key: "latitude", value: "0" }, { key: "longitude", value: "0" }], description: "Explicit point outside all polygons => [] 'No services available in your area' (NOT the full catalog)." }),
        R("Resolve zone", "POST", "/api/zones/resolve", Cu, { body: { latitude: LAT, longitude: LNG } }),
        R("Check service at location", "POST", "/api/zones/check-service", Cu, { body: { latitude: LAT, longitude: LNG, serviceId: "{{serviceId}}" } }),
        R("Add to cart (no gate)", "POST", "/api/user/cart/add", Cu, { description: "Cart is location-agnostic; gate is at checkout.", body: { itemId: "{{serviceId}}", itemType: "service", quantity: 1 } }),
        R("Checkout (hard gate)", "POST", "/api/user/checkout", Cu, { description: "Inactive/no-zone/disabled => 400 SERVICE_NOT_AVAILABLE. No booking created.", body: { addressId: "{{addressId}}", paymentMethod: "online" } }),
        R("Direct booking (hard gate)", "POST", "/api/user/booking/schedule", Cu, { body: { serviceId: "{{serviceId}}", latitude: LAT, longitude: LNG, bookingType: "instant", addressId: "{{addressId}}" } }),
      ],
    },
  ],
};

const outDir = path.join(__dirname, "master");
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, "RightTouch_Zone_Wise_All_Roles.postman_collection.json");
fs.writeFileSync(out, JSON.stringify(collection, null, 2));
console.log(`Wrote ${out} (${collection.item.reduce((a, f) => a + f.item.length, 0)} requests)`);
