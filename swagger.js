import swaggerJsdoc from "swagger-jsdoc";

const options = {
  definition: {
    openapi: "3.0.0",
    info: {
      title: "RightTouch Admin API Portal",
      version: "1.0.0",
      description: "Complete A-to-Z API Documentation for RightTouch Admin & Management Services",
    },
    servers: [
      {
        url: "/api",
        description: "API Base URL",
      },
      {
        url: "http://localhost:7372/api",
        description: "Local Development Server",
      },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
          description: "Enter your Admin JWT token (e.g. Bearer <token>)",
        },
      },
      schemas: {
        StandardSuccess: {
          type: "object",
          properties: {
            success: { type: "boolean", example: true },
            message: { type: "string", example: "Operation completed successfully" },
            result: { type: "object" },
          },
        },
        StandardError: {
          type: "object",
          properties: {
            success: { type: "boolean", example: false },
            message: { type: "string", example: "An error occurred" },
            result: { type: "object" },
          },
        },
        OperationalDistrict: {
          type: "object",
          properties: {
            _id: { type: "string", example: "65f987654321fedcba543210" },
            name: { type: "string", example: "Madurai District" },
            city: { type: "string", example: "Madurai" },
            state: { type: "string", example: "Tamil Nadu" },
            country: { type: "string", example: "India" },
            active: { type: "boolean", example: true },
            isRegistrationEnabled: { type: "boolean", example: true },
            isJobEnabled: { type: "boolean", example: true },
          },
        },
        CityZone: {
          type: "object",
          properties: {
            _id: { type: "string", example: "65f444456789abcdef012399" },
            name: { type: "string", example: "North Zone" },
            zoneCode: { type: "string", example: "Z-001" },
            operationalCityId: { type: "string", example: "65f987654321fedcba543210" },
            active: { type: "boolean", example: true },
          },
        },
      },
    },
    security: [{ bearerAuth: [] }],
    tags: [
      { name: "Admin - Operational Districts", description: "Master Operational City & District APIs" },
      { name: "Admin - Technician District Permissions", description: "Technician multi-district assignment and permissions" },
      { name: "Admin - Technician Zone Permissions", description: "Granular zone permissions for technicians" },
      { name: "Admin - City Zones", description: "City zones and service-zone mapping management" },
      { name: "Admin - Spatial Hierarchy & Geofence", description: "Geofencing, spatial hierarchy, broadcast audit, diagnostics" },
      { name: "Admin - Wallet & Withdrawals", description: "Technician payouts, withdrawal approvals, manual payouts" },
      { name: "Admin - Commission Governance", description: "Service commission rates, overrides, and audit logs" },
      { name: "Admin - Settings & Governance", description: "Auto-payout settings, penalty governance" },
      { name: "Admin - KYC & Bank Details", description: "Technician identity and banking verification" },
      { name: "Admin - Payments", description: "Payment ledger, offline payment recordings, manual overrides" },
      { name: "Admin - Service Availability Matrix", description: "Service availability matrix and zone toggling" },
      { name: "Admin - Quotations & Quote Requests", description: "Product quote requests, quotation creation, and sending" },
      { name: "Admin - Product Bookings", description: "Product booking management and offline payments" },
      { name: "Admin - Product Dashboard & Sales", description: "Product sales dashboard, reports, and audit logs" },
      { name: "Admin - Refunds & Complaints", description: "Customer refund approvals, payouts, and complaint handling" },
      { name: "Admin - Technician Skill Requests", description: "Review and approve/reject technician skill upgrade requests" },
      { name: "Admin - Dispatch Outbox Queue", description: "Real-time dispatch queue monitoring, stats, and retries" },
      { name: "Admin - Finance Ledger", description: "Platform revenue summaries, breakdown, and ledger" },
      { name: "Admin - Permissions & Notifications", description: "Device permissions analytics and admin notifications" },
    ],
    paths: {
      /* =========================================================================
         1. OPERATIONAL DISTRICTS
         ========================================================================= */
      "/admin/districts": {
        get: {
          tags: ["Admin - Operational Districts"],
          summary: "List all operational districts",
          parameters: [{ name: "active", in: "query", schema: { type: "boolean" }, description: "Filter by active status" }],
          responses: { 200: { description: "Success", content: { "application/json": { schema: { $ref: "#/components/schemas/StandardSuccess" } } } } },
        },
        post: {
          tags: ["Admin - Operational Districts"],
          summary: "Create a new operational district",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["name"],
                  properties: {
                    name: { type: "string", example: "Madurai District" },
                    city: { type: "string", example: "Madurai" },
                    state: { type: "string", example: "Tamil Nadu" },
                    country: { type: "string", example: "India" },
                    polygon: { type: "object" },
                  },
                },
              },
            },
          },
          responses: { 201: { description: "Created" } },
        },
      },
      "/admin/districts/{id}": {
        get: {
          tags: ["Admin - Operational Districts"],
          summary: "Get operational district by ID",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { 200: { description: "Success" }, 404: { description: "Not Found" } },
        },
        put: {
          tags: ["Admin - Operational Districts"],
          summary: "Update operational district",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } },
          responses: { 200: { description: "Updated" } },
        },
        delete: {
          tags: ["Admin - Operational Districts"],
          summary: "Delete operational district",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { 200: { description: "Deleted" } },
        },
      },
      "/admin/districts/{id}/status": {
        patch: {
          tags: ["Admin - Operational Districts"],
          summary: "Toggle district active status",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { active: { type: "boolean", example: true } } } } } },
          responses: { 200: { description: "Updated" } },
        },
      },
      "/admin/districts/{id}/registration": {
        patch: {
          tags: ["Admin - Operational Districts"],
          summary: "Toggle technician registration in district",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { isRegistrationEnabled: { type: "boolean", example: true } } } } } },
          responses: { 200: { description: "Updated" } },
        },
      },
      "/admin/districts/{id}/jobs": {
        patch: {
          tags: ["Admin - Operational Districts"],
          summary: "Toggle job bookings/dispatch in district",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { isJobEnabled: { type: "boolean", example: true } } } } } },
          responses: { 200: { description: "Updated" } },
        },
      },
      "/admin/districts/{id}/technicians": {
        get: {
          tags: ["Admin - Operational Districts"],
          summary: "List all technicians in district",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { 200: { description: "Success" } },
        },
      },
      "/admin/operational-cities/active": {
        get: {
          tags: ["Admin - Operational Districts"],
          summary: "Get active operational city",
          responses: { 200: { description: "Success" } },
        },
      },
      "/admin/operational-cities/polygons": {
        get: {
          tags: ["Admin - Operational Districts"],
          summary: "Get all active district polygons",
          responses: { 200: { description: "Success" } },
        },
      },
      "/admin/operational-cities/{id}/activate": {
        post: {
          tags: ["Admin - Operational Districts"],
          summary: "Set operational city as active",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { 200: { description: "Activated" } },
        },
      },

      /* =========================================================================
         2. TECHNICIAN DISTRICT & ZONE PERMISSIONS
         ========================================================================= */
      "/admin/technicians/{technicianId}/districts": {
        get: {
          tags: ["Admin - Technician District Permissions"],
          summary: "Get technician primary + additional districts",
          parameters: [{ name: "technicianId", in: "path", required: true, schema: { type: "string" } }],
          responses: { 200: { description: "Success" } },
        },
        post: {
          tags: ["Admin - Technician District Permissions"],
          summary: "Add additional district permission to technician",
          parameters: [{ name: "technicianId", in: "path", required: true, schema: { type: "string" } }],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["districtId"], properties: { districtId: { type: "string" } } } } } },
          responses: { 200: { description: "Added" } },
        },
      },
      "/admin/technicians/{technicianId}/districts/{districtId}:": {
        patch: {
          tags: ["Admin - Technician District Permissions"],
          summary: "Toggle technician district permission",
          parameters: [
            { name: "technicianId", in: "path", required: true, schema: { type: "string" } },
            { name: "districtId", in: "path", required: true, schema: { type: "string" } },
          ],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["isEnabled"], properties: { isEnabled: { type: "boolean" } } } } } },
          responses: { 200: { description: "Updated" } },
        },
        delete: {
          tags: ["Admin - Technician District Permissions"],
          summary: "Remove technician district permission",
          parameters: [
            { name: "technicianId", in: "path", required: true, schema: { type: "string" } },
            { name: "districtId", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: { 200: { description: "Deleted" } },
        },
      },
      "/admin/technicians/{technicianId}/city-zones": {
        get: {
          tags: ["Admin - Technician Zone Permissions"],
          summary: "Get technician city zones grouped by district",
          parameters: [{ name: "technicianId", in: "path", required: true, schema: { type: "string" } }],
          responses: { 200: { description: "Success" } },
        },
        post: {
          tags: ["Admin - Technician Zone Permissions"],
          summary: "Enable city zone permission(s) for technician",
          parameters: [{ name: "technicianId", in: "path", required: true, schema: { type: "string" } }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    cityZoneId: { type: "string" },
                    cityZoneIds: { type: "array", items: { type: "string" } },
                    reason: { type: "string" },
                  },
                },
              },
            },
          },
          responses: { 200: { description: "Enabled" } },
        },
        delete: {
          tags: ["Admin - Technician Zone Permissions"],
          summary: "Bulk revoke city zone permissions for technician",
          parameters: [{ name: "technicianId", in: "path", required: true, schema: { type: "string" } }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    cityZoneIds: { type: "array", items: { type: "string" } },
                    reason: { type: "string" },
                  },
                },
              },
            },
          },
          responses: { 200: { description: "Revoked" } },
        },
      },
      "/admin/technicians/{technicianId}/city-zones/{zoneId}": {
        delete: {
          tags: ["Admin - Technician Zone Permissions"],
          summary: "Revoke single city zone permission",
          parameters: [
            { name: "technicianId", in: "path", required: true, schema: { type: "string" } },
            { name: "zoneId", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: { 200: { description: "Revoked" } },
        },
      },

      /* =========================================================================
         3. CITY ZONES & MAPPINGS
         ========================================================================= */
      "/admin/zones": {
        get: {
          tags: ["Admin - City Zones"],
          summary: "List all city zones",
          parameters: [
            { name: "operationalCityId", in: "query", schema: { type: "string" } },
            { name: "active", in: "query", schema: { type: "boolean" } },
          ],
          responses: { 200: { description: "Success" } },
        },
        post: {
          tags: ["Admin - City Zones"],
          summary: "Create city zone",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["name", "operationalCityId"],
                  properties: {
                    name: { type: "string" },
                    zoneCode: { type: "string" },
                    operationalCityId: { type: "string" },
                    polygon: { type: "object" },
                  },
                },
              },
            },
          },
          responses: { 201: { description: "Created" } },
        },
      },
      "/admin/zones/{id}": {
        get: {
          tags: ["Admin - City Zones"],
          summary: "Get city zone by ID",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { 200: { description: "Success" } },
        },
        put: {
          tags: ["Admin - City Zones"],
          summary: "Update city zone",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } },
          responses: { 200: { description: "Updated" } },
        },
        delete: {
          tags: ["Admin - City Zones"],
          summary: "Delete city zone",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { 200: { description: "Deleted" } },
        },
      },
      "/admin/zone-mappings": {
        get: {
          tags: ["Admin - City Zones"],
          summary: "List zone-service mappings",
          parameters: [
            { name: "zoneId", in: "query", schema: { type: "string" } },
            { name: "serviceId", in: "query", schema: { type: "string" } },
          ],
          responses: { 200: { description: "Success" } },
        },
        post: {
          tags: ["Admin - City Zones"],
          summary: "Bulk create/upsert zone-service mappings",
          requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } },
          responses: { 200: { description: "Created/Updated" } },
        },
      },
      "/admin/zone-mappings/{zoneId}/{serviceId}": {
        delete: {
          tags: ["Admin - City Zones"],
          summary: "Delete zone-service mapping",
          parameters: [
            { name: "zoneId", in: "path", required: true, schema: { type: "string" } },
            { name: "serviceId", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: { 200: { description: "Deleted" } },
        },
      },
      "/admin/zones/{zoneId}/services/toggle": {
        put: {
          tags: ["Admin - City Zones"],
          summary: "Bulk toggle all services in zone",
          parameters: [{ name: "zoneId", in: "path", required: true, schema: { type: "string" } }],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { active: { type: "boolean" } } } } } },
          responses: { 200: { description: "Updated" } },
        },
      },

      /* =========================================================================
         4. WALLET, WITHDRAWALS & PAYOUTS
         ========================================================================= */
      "/admin/wallet": {
        get: {
          tags: ["Admin - Wallet & Withdrawals"],
          summary: "Get admin wallet dashboard summary",
          responses: { 200: { description: "Success" } },
        },
      },
      "/admin/wallet/withdrawals": {
        get: {
          tags: ["Admin - Wallet & Withdrawals"],
          summary: "List technician withdrawal requests",
          parameters: [
            { name: "status", in: "query", schema: { type: "string", enum: ["pending", "approved", "paid", "rejected", "processing"] } },
            { name: "type", in: "query", schema: { type: "string", enum: ["auto", "manual"] } },
          ],
          responses: { 200: { description: "Success" } },
        },
      },
      "/admin/wallet/export": {
        get: {
          tags: ["Admin - Wallet & Withdrawals"],
          summary: "Export withdrawal requests (CSV/Excel)",
          responses: { 200: { description: "File Export" } },
        },
      },
      "/admin/wallet/withdrawal/{id}/details": {
        get: {
          tags: ["Admin - Wallet & Withdrawals"],
          summary: "Get single withdrawal request details",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { 200: { description: "Success" } },
        },
      },
      "/admin/wallet/withdrawal/{id}/receipt": {
        get: {
          tags: ["Admin - Wallet & Withdrawals"],
          summary: "Get withdrawal receipt",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { 200: { description: "Success" } },
        },
      },
      "/admin/wallet/withdrawal/{id}/approve": {
        put: {
          tags: ["Admin - Wallet & Withdrawals"],
          summary: "Approve technician withdrawal request",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { 200: { description: "Approved" } },
        },
      },
      "/admin/wallet/withdrawal/{id}/reject": {
        put: {
          tags: ["Admin - Wallet & Withdrawals"],
          summary: "Reject technician withdrawal request",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { rejectionReason: { type: "string" } } } } } },
          responses: { 200: { description: "Rejected" } },
        },
      },
      "/admin/wallet/withdrawal/{id}/pay": {
        put: {
          tags: ["Admin - Wallet & Withdrawals"],
          summary: "Trigger Razorpay X bank/UPI payout to technician",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { 200: { description: "Payout triggered" } },
        },
      },
      "/admin/wallet/withdrawal/{id}/retry": {
        post: {
          tags: ["Admin - Wallet & Withdrawals"],
          summary: "Retry failed withdrawal payout",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { 200: { description: "Retried" } },
        },
      },
      "/admin/wallet/technician/{technicianId}/freeze": {
        put: {
          tags: ["Admin - Wallet & Withdrawals"],
          summary: "Toggle freeze/unfreeze on technician payouts",
          parameters: [{ name: "technicianId", in: "path", required: true, schema: { type: "string" } }],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { isFrozen: { type: "boolean" }, reason: { type: "string" } } } } } },
          responses: { 200: { description: "Updated" } },
        },
      },
      "/admin/wallet/technician/{technicianId}/send-money": {
        post: {
          tags: ["Admin - Wallet & Withdrawals"],
          summary: "Send money / manual direct payout to technician",
          parameters: [{ name: "technicianId", in: "path", required: true, schema: { type: "string" } }],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["amount"], properties: { amount: { type: "number" }, notes: { type: "string" } } } } } },
          responses: { 200: { description: "Success" } },
        },
      },
      "/admin/wallet/withdrawal/{id}/approve-manual-payout": {
        put: {
          tags: ["Admin - Wallet & Withdrawals"],
          summary: "Second-admin approval for high-value manual payout",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { 200: { description: "Approved" } },
        },
      },
      "/admin/wallet/withdrawal/{id}/resolve-manual-review": {
        put: {
          tags: ["Admin - Wallet & Withdrawals"],
          summary: "Resolve ambiguous manual review payout",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { resolution: { type: "string", enum: ["complete", "revert"] } } } } } },
          responses: { 200: { description: "Resolved" } },
        },
      },
      "/admin/wallet/auto-payouts/summary": {
        get: {
          tags: ["Admin - Wallet & Withdrawals"],
          summary: "Auto-payout dashboard counts and amounts summary",
          responses: { 200: { description: "Success" } },
        },
      },

      /* =========================================================================
         5. COMMISSION GOVERNANCE & AUDIT
         ========================================================================= */
      "/admin/commission/services": {
        get: {
          tags: ["Admin - Commission Governance"],
          summary: "List all service commission configs",
          responses: { 200: { description: "Success" } },
        },
      },
      "/admin/commission/service/{serviceId}": {
        get: {
          tags: ["Admin - Commission Governance"],
          summary: "Get single service commission config",
          parameters: [{ name: "serviceId", in: "path", required: true, schema: { type: "string" } }],
          responses: { 200: { description: "Success" } },
        },
        put: {
          tags: ["Admin - Commission Governance"],
          summary: "Set service commission rate percentage",
          parameters: [{ name: "serviceId", in: "path", required: true, schema: { type: "string" } }],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["percentage"], properties: { percentage: { type: "number" }, effectiveFrom: { type: "string", format: "date-time" } } } } } },
          responses: { 200: { description: "Updated" } },
        },
      },
      "/admin/commission/booking/{bookingId}/override": {
        put: {
          tags: ["Admin - Commission Governance"],
          summary: "Override commission on a specific booking",
          parameters: [{ name: "bookingId", in: "path", required: true, schema: { type: "string" } }],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["overridePercentage", "reason"], properties: { overridePercentage: { type: "number" }, reason: { type: "string" } } } } } },
          responses: { 200: { description: "Overridden" } },
        },
      },
      "/admin/audit-logs": {
        get: {
          tags: ["Admin - Commission Governance"],
          summary: "Get platform audit logs",
          responses: { 200: { description: "Success" } },
        },
      },

      /* =========================================================================
         6. SETTINGS & GOVERNANCE
         ========================================================================= */
      "/admin/settings/auto-payout": {
        get: {
          tags: ["Admin - Settings & Governance"],
          summary: "Get auto-payout threshold and floor settings",
          responses: { 200: { description: "Success" } },
        },
        put: {
          tags: ["Admin - Settings & Governance"],
          summary: "Update auto-payout threshold and floor settings",
          requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } },
          responses: { 200: { description: "Updated" } },
        },
      },
      "/admin/settings/reaccept-penalty": {
        get: {
          tags: ["Admin - Settings & Governance"],
          summary: "Get re-accept cancellation penalty percentage",
          responses: { 200: { description: "Success" } },
        },
        put: {
          tags: ["Admin - Settings & Governance"],
          summary: "Update re-accept cancellation penalty percentage",
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { penaltyPercentage: { type: "number" } } } } } },
          responses: { 200: { description: "Updated" } },
        },
      },

      /* =========================================================================
         7. KYC & BANK DETAILS
         ========================================================================= */
      "/admin/kyc": {
        get: {
          tags: ["Admin - KYC & Bank Details"],
          summary: "List all technician KYC records",
          responses: { 200: { description: "Success" } },
        },
      },
      "/admin/kyc/orphaned/list": {
        get: {
          tags: ["Admin - KYC & Bank Details"],
          summary: "List orphaned KYC records",
          responses: { 200: { description: "Success" } },
        },
      },
      "/admin/kyc/{technicianId}/full": {
        get: {
          tags: ["Admin - KYC & Bank Details"],
          summary: "Get complete technician KYC and documents",
          parameters: [{ name: "technicianId", in: "path", required: true, schema: { type: "string" } }],
          responses: { 200: { description: "Success" } },
        },
      },
      "/admin/kyc/{technicianId}": {
        get: {
          tags: ["Admin - KYC & Bank Details"],
          summary: "Get technician KYC summary",
          parameters: [{ name: "technicianId", in: "path", required: true, schema: { type: "string" } }],
          responses: { 200: { description: "Success" } },
        },
        put: {
          tags: ["Admin - KYC & Bank Details"],
          summary: "Admin update technician KYC identity details",
          parameters: [{ name: "technicianId", in: "path", required: true, schema: { type: "string" } }],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } },
          responses: { 200: { description: "Updated" } },
        },
        delete: {
          tags: ["Admin - KYC & Bank Details"],
          summary: "Delete technician KYC",
          parameters: [{ name: "technicianId", in: "path", required: true, schema: { type: "string" } }],
          responses: { 200: { description: "Deleted" } },
        },
      },
      "/admin/bank/{technicianId}": {
        put: {
          tags: ["Admin - KYC & Bank Details"],
          summary: "Admin update technician bank details",
          parameters: [{ name: "technicianId", in: "path", required: true, schema: { type: "string" } }],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } },
          responses: { 200: { description: "Updated" } },
        },
      },
      "/admin/kyc/{technicianId}/verify": {
        put: {
          tags: ["Admin - KYC & Bank Details"],
          summary: "Verify or reject technician KYC",
          parameters: [{ name: "technicianId", in: "path", required: true, schema: { type: "string" } }],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { status: { type: "string", enum: ["verified", "rejected"] }, remarks: { type: "string" } } } } } },
          responses: { 200: { description: "Updated" } },
        },
      },
      "/admin/bank/{technicianId}/verify": {
        put: {
          tags: ["Admin - KYC & Bank Details"],
          summary: "Verify or reject technician bank details",
          parameters: [{ name: "technicianId", in: "path", required: true, schema: { type: "string" } }],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { status: { type: "string", enum: ["verified", "rejected"] }, remarks: { type: "string" } } } } } },
          responses: { 200: { description: "Updated" } },
        },
      },
      "/admin/kyc/orphaned/cleanup/all": {
        delete: {
          tags: ["Admin - KYC & Bank Details"],
          summary: "Delete all orphaned KYC records",
          responses: { 200: { description: "Cleaned up" } },
        },
      },
      "/admin/kyc/orphaned/{kycId}": {
        delete: {
          tags: ["Admin - KYC & Bank Details"],
          summary: "Delete single orphaned KYC record",
          parameters: [{ name: "kycId", in: "path", required: true, schema: { type: "string" } }],
          responses: { 200: { description: "Deleted" } },
        },
      },

      /* =========================================================================
         8. PAYMENTS & OFFLINE RECORDINGS
         ========================================================================= */
      "/admin/payments/product-payments": {
        get: {
          tags: ["Admin - Payments"],
          summary: "List all product payments",
          responses: { 200: { description: "Success" } },
        },
      },
      "/admin/payments/product-payments/summary": {
        get: {
          tags: ["Admin - Payments"],
          summary: "Summary of product payments",
          responses: { 200: { description: "Success" } },
        },
      },
      "/admin/payments/record-offline": {
        post: {
          tags: ["Admin - Payments"],
          summary: "Record offline / cash / UPI payment",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["bookingId", "amount", "paymentMode"],
                  properties: {
                    bookingId: { type: "string" },
                    amount: { type: "number" },
                    paymentMode: { type: "string", enum: ["cash", "upi", "bank_transfer", "pos"] },
                    transactionReference: { type: "string" },
                    notes: { type: "string" },
                  },
                },
              },
            },
          },
          responses: { 200: { description: "Payment recorded" } },
        },
      },
      "/admin/payments/record-offline/{bookingId}": {
        post: {
          tags: ["Admin - Payments"],
          summary: "Record offline payment for a booking",
          parameters: [{ name: "bookingId", in: "path", required: true, schema: { type: "string" } }],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } },
          responses: { 200: { description: "Recorded" } },
        },
      },
      "/admin/payments/{id}/status": {
        put: {
          tags: ["Admin - Payments"],
          summary: "Manually override payment status with audit reason",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["status", "reason"], properties: { status: { type: "string" }, reason: { type: "string" } } } } } },
          responses: { 200: { description: "Updated" } },
        },
      },
      "/admin/payments/booking/{bookingId}": {
        get: {
          tags: ["Admin - Payments"],
          summary: "Get payment record for a booking",
          parameters: [{ name: "bookingId", in: "path", required: true, schema: { type: "string" } }],
          responses: { 200: { description: "Success" } },
        },
      },
      "/admin/payments/booking/{id}": {
        delete: {
          tags: ["Admin - Payments"],
          summary: "Delete booking payment as admin",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { 200: { description: "Deleted" } },
        },
      },

      /* =========================================================================
         9. SERVICE AVAILABILITY & MATRIX
         ========================================================================= */
      "/admin/service-availability/matrix": {
        get: {
          tags: ["Admin - Service Availability Matrix"],
          summary: "Get full service-zone availability matrix",
          responses: { 200: { description: "Success" } },
        },
      },
      "/admin/service-availability/service/{serviceId}/detail": {
        get: {
          tags: ["Admin - Service Availability Matrix"],
          summary: "Get zone availability detail for a specific service",
          parameters: [{ name: "serviceId", in: "path", required: true, schema: { type: "string" } }],
          responses: { 200: { description: "Success" } },
        },
      },
      "/admin/service-availability/toggle-zone": {
        post: {
          tags: ["Admin - Service Availability Matrix"],
          summary: "Toggle single zone availability for a service",
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { serviceId: { type: "string" }, zoneId: { type: "string" }, active: { type: "boolean" } } } } } },
          responses: { 200: { description: "Updated" } },
        },
      },
      "/admin/service-availability/bulk-toggle-zones": {
        post: {
          tags: ["Admin - Service Availability Matrix"],
          summary: "Bulk toggle multiple zones for a service",
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { serviceId: { type: "string" }, zoneIds: { type: "array", items: { type: "string" } }, active: { type: "boolean" } } } } } },
          responses: { 200: { description: "Updated" } },
        },
      },
      "/admin/service-availability/clear-district-zones": {
        post: {
          tags: ["Admin - Service Availability Matrix"],
          summary: "Clear all zones in district for a service",
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { serviceId: { type: "string" }, districtId: { type: "string" } } } } } },
          responses: { 200: { description: "Cleared" } },
        },
      },
      "/admin/service-availability/toggle-service-status": {
        post: {
          tags: ["Admin - Service Availability Matrix"],
          summary: "Toggle master active status for a service",
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { serviceId: { type: "string" }, active: { type: "boolean" } } } } } },
          responses: { 200: { description: "Updated" } },
        },
      },
      "/admin/service-availability": {
        get: {
          tags: ["Admin - Service Availability Matrix"],
          summary: "List service availability configurations",
          responses: { 200: { description: "Success" } },
        },
        post: {
          tags: ["Admin - Service Availability Matrix"],
          summary: "Create service availability configuration",
          requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } },
          responses: { 201: { description: "Created" } },
        },
      },
      "/admin/service-availability/{id}": {
        put: {
          tags: ["Admin - Service Availability Matrix"],
          summary: "Update service availability configuration",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } },
          responses: { 200: { description: "Updated" } },
        },
        delete: {
          tags: ["Admin - Service Availability Matrix"],
          summary: "Delete service availability configuration",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { 200: { description: "Deleted" } },
        },
      },
      "/admin/dispatch-debug": {
        get: {
          tags: ["Admin - Service Availability Matrix"],
          summary: "Diagnostic health and dispatch screening",
          responses: { 200: { description: "Success" } },
        },
      },

      /* =========================================================================
         10. QUOTATIONS & PRODUCT BOOKINGS
         ========================================================================= */
      "/admin/product-quote-requests": {
        get: {
          tags: ["Admin - Quotations & Quote Requests"],
          summary: "List all customer product quote requests",
          responses: { 200: { description: "Success" } },
        },
      },
      "/admin/product-quote-requests/{id}": {
        get: {
          tags: ["Admin - Quotations & Quote Requests"],
          summary: "Get quote request by ID",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { 200: { description: "Success" } },
        },
        delete: {
          tags: ["Admin - Quotations & Quote Requests"],
          summary: "Delete quote request",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { 200: { description: "Deleted" } },
        },
      },
      "/admin/product-quote-requests/{id}/assign": {
        post: {
          tags: ["Admin - Quotations & Quote Requests"],
          summary: "Assign quote request to admin staff",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { assignedTo: { type: "string" } } } } } },
          responses: { 200: { description: "Assigned" } },
        },
      },
      "/admin/product-quote-requests/{id}/status": {
        patch: {
          tags: ["Admin - Quotations & Quote Requests"],
          summary: "Update quote request status",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { status: { type: "string" } } } } } },
          responses: { 200: { description: "Updated" } },
        },
      },
      "/admin/quotations": {
        get: {
          tags: ["Admin - Quotations & Quote Requests"],
          summary: "List all created quotations",
          responses: { 200: { description: "Success" } },
        },
        post: {
          tags: ["Admin - Quotations & Quote Requests"],
          summary: "Create new quotation for customer",
          requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } },
          responses: { 201: { description: "Created" } },
        },
      },
      "/admin/quotations/{id}": {
        get: {
          tags: ["Admin - Quotations & Quote Requests"],
          summary: "Get quotation details by ID",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { 200: { description: "Success" } },
        },
        patch: {
          tags: ["Admin - Quotations & Quote Requests"],
          summary: "Update quotation items and amounts",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } },
          responses: { 200: { description: "Updated" } },
        },
        delete: {
          tags: ["Admin - Quotations & Quote Requests"],
          summary: "Delete quotation",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { 200: { description: "Deleted" } },
        },
      },
      "/admin/quotations/{id}/send": {
        post: {
          tags: ["Admin - Quotations & Quote Requests"],
          summary: "Send quotation to customer via in-app & WhatsApp",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { 200: { description: "Sent" } },
        },
      },
      "/admin/quotations/{id}/resend": {
        post: {
          tags: ["Admin - Quotations & Quote Requests"],
          summary: "Resend quotation to customer",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { 200: { description: "Resent" } },
        },
      },
      "/admin/quotations/{id}/revise": {
        post: {
          tags: ["Admin - Quotations & Quote Requests"],
          summary: "Revise existing quotation into a new version",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } },
          responses: { 200: { description: "Revised" } },
        },
      },
      "/admin/quotations/{id}/payment-status": {
        patch: {
          tags: ["Admin - Quotations & Quote Requests"],
          summary: "Update quotation payment status",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { paymentStatus: { type: "string" } } } } } },
          responses: { 200: { description: "Updated" } },
        },
      },
      "/admin/product-bookings": {
        get: {
          tags: ["Admin - Product Bookings"],
          summary: "List all product purchase bookings",
          responses: { 200: { description: "Success" } },
        },
      },
      "/admin/product-bookings/{id}": {
        get: {
          tags: ["Admin - Product Bookings"],
          summary: "Get product booking by ID",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { 200: { description: "Success" } },
        },
      },
      "/admin/product-bookings/{id}/complete": {
        put: {
          tags: ["Admin - Product Bookings"],
          summary: "Mark product booking as completed/delivered",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { 200: { description: "Completed" } },
        },
      },
      "/admin/product-bookings/{bookingId}/manual-payment": {
        post: {
          tags: ["Admin - Product Bookings"],
          summary: "Record manual payment for product booking",
          parameters: [{ name: "bookingId", in: "path", required: true, schema: { type: "string" } }],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } },
          responses: { 200: { description: "Payment recorded" } },
        },
      },

      /* =========================================================================
         11. PRODUCT DASHBOARD & SALES
         ========================================================================= */
      "/admin/product-dashboard": {
        get: {
          tags: ["Admin - Product Dashboard & Sales"],
          summary: "Get product sales & orders dashboard overview",
          responses: { 200: { description: "Success" } },
        },
      },
      "/admin/product-reports/sales": {
        get: {
          tags: ["Admin - Product Dashboard & Sales"],
          summary: "Get detailed sales report",
          responses: { 200: { description: "Success" } },
        },
      },
      "/admin/product-audit-logs": {
        get: {
          tags: ["Admin - Product Dashboard & Sales"],
          summary: "Get product audit logs",
          responses: { 200: { description: "Success" } },
        },
      },
      "/admin/product-audit-logs/{id}": {
        get: {
          tags: ["Admin - Product Dashboard & Sales"],
          summary: "Get single product audit log by ID",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { 200: { description: "Success" } },
        },
      },

      /* =========================================================================
         12. REFUNDS & COMPLAINTS
         ========================================================================= */
      "/admin/refunds": {
        get: {
          tags: ["Admin - Refunds & Complaints"],
          summary: "List all refund requests",
          responses: { 200: { description: "Success" } },
        },
        post: {
          tags: ["Admin - Refunds & Complaints"],
          summary: "Create refund request for customer",
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["bookingId", "amount"], properties: { bookingId: { type: "string" }, amount: { type: "number" }, reason: { type: "string" } } } } } },
          responses: { 201: { description: "Created" } },
        },
      },
      "/admin/refunds/preview": {
        post: {
          tags: ["Admin - Refunds & Complaints"],
          summary: "Preview refund calculation and policy tier",
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["bookingId"], properties: { bookingId: { type: "string" } } } } } },
          responses: { 200: { description: "Preview calculated" } },
        },
      },
      "/admin/refunds/{id}/approve": {
        post: {
          tags: ["Admin - Refunds & Complaints"],
          summary: "Approve customer refund",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { 200: { description: "Approved" } },
        },
      },
      "/admin/refunds/{id}/retry": {
        post: {
          tags: ["Admin - Refunds & Complaints"],
          summary: "Retry failed refund gateway call",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { 200: { description: "Retried" } },
        },
      },
      "/admin/refunds/{id}/customer-payout": {
        post: {
          tags: ["Admin - Refunds & Complaints"],
          summary: "Execute direct customer payout refund",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { 200: { description: "Payout executed" } },
        },
      },
      "/admin/complaints": {
        get: {
          tags: ["Admin - Refunds & Complaints"],
          summary: "List customer complaints and disputes",
          responses: { 200: { description: "Success" } },
        },
      },
      "/admin/complaints/{id}": {
        get: {
          tags: ["Admin - Refunds & Complaints"],
          summary: "Get complaint details by ID",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { 200: { description: "Success" } },
        },
      },
      "/admin/complaints/{id}/reject": {
        post: {
          tags: ["Admin - Refunds & Complaints"],
          summary: "Reject customer complaint",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { rejectionReason: { type: "string" } } } } } },
          responses: { 200: { description: "Rejected" } },
        },
      },
      "/admin/complaints/{id}/status": {
        post: {
          tags: ["Admin - Refunds & Complaints"],
          summary: "Update complaint resolution status",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { status: { type: "string" }, notes: { type: "string" } } } } } },
          responses: { 200: { description: "Updated" } },
        },
      },
      "/admin/complaints/categories": {
        get: {
          tags: ["Admin - Refunds & Complaints"],
          summary: "List report/complaint categories",
          responses: { 200: { description: "Success" } },
        },
      },

      /* =========================================================================
         13. TECHNICIAN SKILL REQUESTS
         ========================================================================= */
      "/admin/technician-skill-requests": {
        get: {
          tags: ["Admin - Technician Skill Requests"],
          summary: "List all pending/reviewed technician skill upgrade requests",
          responses: { 200: { description: "Success" } },
        },
      },
      "/admin/technician-skill-requests/{requestId}/review": {
        put: {
          tags: ["Admin - Technician Skill Requests"],
          summary: "Review, approve or reject a technician skill request",
          parameters: [{ name: "requestId", in: "path", required: true, schema: { type: "string" } }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["status"],
                  properties: {
                    status: { type: "string", enum: ["approved", "rejected"] },
                    remarks: { type: "string" },
                  },
                },
              },
            },
          },
          responses: { 200: { description: "Reviewed" } },
        },
      },

      /* =========================================================================
         14. DISPATCH OUTBOX QUEUE
         ========================================================================= */
      "/admin/dispatch/stats": {
        get: {
          tags: ["Admin - Dispatch Outbox Queue"],
          summary: "Get real-time dispatch queue statistics & performance metrics",
          responses: { 200: { description: "Success" } },
        },
      },
      "/admin/dispatch/failed": {
        get: {
          tags: ["Admin - Dispatch Outbox Queue"],
          summary: "List failed dispatch notifications",
          parameters: [
            { name: "page", in: "query", schema: { type: "integer" } },
            { name: "limit", in: "query", schema: { type: "integer" } },
          ],
          responses: { 200: { description: "Success" } },
        },
      },
      "/admin/dispatch/pending": {
        get: {
          tags: ["Admin - Dispatch Outbox Queue"],
          summary: "List pending/inflight dispatch notifications",
          parameters: [
            { name: "status", in: "query", schema: { type: "string", enum: ["pending", "inflight", "all"] } },
            { name: "page", in: "query", schema: { type: "integer" } },
            { name: "limit", in: "query", schema: { type: "integer" } },
          ],
          responses: { 200: { description: "Success" } },
        },
      },
      "/admin/dispatch/{id}/retry": {
        post: {
          tags: ["Admin - Dispatch Outbox Queue"],
          summary: "Manually retry a failed dispatch message",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { 200: { description: "Retried" } },
        },
      },
      "/admin/dispatch/retry-failed": {
        post: {
          tags: ["Admin - Dispatch Outbox Queue"],
          summary: "Bulk retry all failed dispatch queue messages",
          responses: { 200: { description: "Queued for retry" } },
        },
      },
      "/admin/dispatch/worker/restart": {
        post: {
          tags: ["Admin - Dispatch Outbox Queue"],
          summary: "Restart dispatch worker thread",
          responses: { 200: { description: "Restarted" } },
        },
      },
      "/admin/dispatch/worker/stop": {
        post: {
          tags: ["Admin - Dispatch Outbox Queue"],
          summary: "Stop dispatch worker thread",
          responses: { 200: { description: "Stopped" } },
        },
      },
      "/admin/dispatch/health": {
        get: {
          tags: ["Admin - Dispatch Outbox Queue"],
          summary: "Dispatch queue & Redis deduplication health check",
          responses: { 200: { description: "Health status" } },
        },
      },

      /* =========================================================================
         15. FINANCE LEDGER
         ========================================================================= */
      "/admin/finance/summary": {
        get: {
          tags: ["Admin - Finance Ledger"],
          summary: "Get overall platform financial summary (GMV, platform revenue, payouts)",
          responses: { 200: { description: "Success" } },
        },
      },
      "/admin/finance/breakdown": {
        get: {
          tags: ["Admin - Finance Ledger"],
          summary: "Get finance breakdown by service/category/period",
          responses: { 200: { description: "Success" } },
        },
      },
      "/admin/finance/payments": {
        get: {
          tags: ["Admin - Finance Ledger"],
          summary: "Get complete platform payments and transactions ledger",
          responses: { 200: { description: "Success" } },
        },
      },
      "/admin/finance/technician/{technicianId}": {
        get: {
          tags: ["Admin - Finance Ledger"],
          summary: "Get detailed financial statement and earnings for a technician",
          parameters: [{ name: "technicianId", in: "path", required: true, schema: { type: "string" } }],
          responses: { 200: { description: "Success" } },
        },
      },

      /* =========================================================================
         16. PERMISSIONS & NOTIFICATIONS
         ========================================================================= */
      "/admin/permissions/analytics": {
        get: {
          tags: ["Admin - Permissions & Notifications"],
          summary: "Get mobile app device permissions analytics (Location, Push, Background)",
          responses: { 200: { description: "Success" } },
        },
      },
      "/admin/permissions/{userId}": {
        get: {
          tags: ["Admin - Permissions & Notifications"],
          summary: "Get device permission details for a specific user/technician",
          parameters: [{ name: "userId", in: "path", required: true, schema: { type: "string" } }],
          responses: { 200: { description: "Success" } },
        },
      },
      "/admin/notifications/unread-counts": {
        get: {
          tags: ["Admin - Permissions & Notifications"],
          summary: "Get admin dashboard sidebar unread badge counts",
          responses: { 200: { description: "Success" } },
        },
      },
      "/admin/notifications/mark-read": {
        patch: {
          tags: ["Admin - Permissions & Notifications"],
          summary: "Mark admin notification badge item as read",
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { itemKey: { type: "string" } } } } } },
          responses: { 200: { description: "Marked as read" } },
        },
      },
      "/admin/notifications": {
        get: {
          tags: ["Admin - Permissions & Notifications"],
          summary: "List admin notifications",
          responses: { 200: { description: "Success" } },
        },
      },
    },
  },
  apis: ["./Routes/*.js"],
};

const swaggerSpec = swaggerJsdoc(options);

export default swaggerSpec;