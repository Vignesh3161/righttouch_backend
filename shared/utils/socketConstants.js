/**
 * 🛰 SOCKET EVENT CONSTANTS
 * Centralized registry of all socket events to ensure consistency between
 * server-side logic and client-side implementation.
 */

export const SOCKET_EVENTS = {
    // 🔌 Connection Events
    CONNECTION: "connection",
    DISCONNECT: "disconnect",
    ERROR: "error",

    // 🔔 Unified Notification Events
    NOTIFICATION_NEW: "notification:new",

    // 👤 User/Customer Events
    JOB_ACCEPTED_NOTIFY: "job_accepted", // Legacy event
    BOOKING_ACCEPTED: "booking:accepted", // Standardized event
    BOOKING_STARTED: "booking:started",
    BOOKING_ARRIVED: "booking:arrived",
    BOOKING_COMPLETED: "booking:completed",
    BOOKING_CANCELLED: "booking:cancelled",
    TECHNICIAN_STARTED_TRAVEL: "technician_started_travel",
    TECHNICIAN_ARRIVED: "technician_arrived",

    // 👨‍🔧 Technician Events
    TECH_LOCATION_UPDATE: "technician:location_update",
    TECH_GET_JOBS: "technician:get_jobs",
    TECH_JOBS_LIST: "technician:jobs_list",
    TECH_JOBS_CHANGED: "technician:jobs_changed",
    JOB_CANCELLED_BY_CUSTOMER: "job_cancelled_by_customer",

    // 📋 Job/Booking Events
    JOB_NEW: "job:new",
    JOB_BROADCAST: "job:broadcast",
    JOB_TAKEN: "job_taken",
    JOB_EXPIRED: "job:expired",

    // 📍 Location Events
    LOCATION_UPDATE_EMIT: "location_update", // Emitted to customer

    // ⏰ Reminders / Enforcement
    TRAVEL_REMINDER: "booking:travel_reminder",
    BOOKING_REMINDER: "booking:reminder",
    BOOKING_REBROADCAST: "booking:rebroadcast",
    BOOKING_AT_RISK: "booking_at_risk",

    // 💸 Payments / Payouts
    PAYMENT_SUCCESS: "payment_success",
    PAYMENT_RECEIVED: "payment_received",
    AUTO_PAYOUT_PAID: "auto_payout_paid",
    WITHDRAWAL_FAILED: "withdrawal_failed",
    PAYMENT_STATUS: "payment:status",

    // 👑 Admin Events
    NEW_BOOKING: "new_booking",
    ADMIN_UNREAD_COUNTS_UPDATED: "admin:unread_counts_updated",

    // 🔐 Session Control & Permissions
    SESSION_REVOKED: "session:revoked",
    SESSION_REPLACED: "session:replaced",
    PERMISSION_STATUS_CHANGED: "permission_status_changed",

    // 🧾 Refunds / Complaints
    COMPLAINT_RECEIVED: "complaint:received",
    COMPLAINT_UNDER_REVIEW: "complaint:under_review",
    COMPLAINT_REJECTED: "complaint:rejected",
    COMPLAINT_FILED_AGAINST_YOU: "complaint:filed_against_you",
    COMPLAINT_SLA_BREACH: "complaint:sla_breach",
    REFUND_INITIATED: "refund:initiated",
    REFUND_PROCESSED: "refund:processed",
    REFUND_FAILED: "refund:failed",
    CLAWBACK_APPLIED: "clawback:applied",
    CLAWBACK_TO_DUES: "clawback:to_dues",
    HOLD_RELEASED: "hold:released",
    COMPLAINT_RESOLVED_IN_FAVOUR: "complaint:resolved_in_favour",
    COMPLAINT_STATUS_UPDATED: "complaint:status_updated",
    REFUND_MANUAL_REVIEW: "refund:manual_review",
    CREDIT_NOTE_DEADLINE_APPROACHING: "credit_note:deadline_approaching",
};

/**
 * 🔒 SOCKET ROOM PREFIXES & HELPERS
 */
export const SOCKET_ROOMS = {
    // Standardized user/role rooms
    USER: (userId) => `user:${userId}`,
    ROLE: (role) => `role:${String(role).toLowerCase()}`,

    // Backward-compatible legacy rooms
    TECHNICIAN: (id) => `technician_${id}`,
    CUSTOMER: (id) => `customer_${id}`,
    ADMIN_DASHBOARD: "admin_dashboard",
    ADMIN_ROOM: "admin_room",
    ADMIN: "admin",
};
