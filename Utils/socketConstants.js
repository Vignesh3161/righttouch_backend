/**
 * 🛰 SOCKET EVENT CONSTANTS
 * Centralized registry of all socket events to ensure consistency between
 * server-side logic and client-side implementation.
 * NOTE: Only events that have real server-side handlers/emitters live here.
 */

export const SOCKET_EVENTS = {
    // 🔌 Connection Events
    CONNECTION: "connection",
    DISCONNECT: "disconnect",
    ERROR: "error",

    // 👤 User/Customer Events
    JOB_ACCEPTED_NOTIFY: "job_accepted", // Notifies customer

    // 👨‍🔧 Technician Events
    TECH_LOCATION_UPDATE: "technician:location_update",
    TECH_GET_JOBS: "technician:get_jobs",
    TECH_JOBS_LIST: "technician:jobs_list",
    // 🛰 Push notification that the technician's job feed changed — the client
    // should refetch jobs ONCE instead of polling continuously.
    TECH_JOBS_CHANGED: "technician:jobs_changed",

    // 📋 Job/Booking Events
    JOB_NEW: "job:new",
    JOB_TAKEN: "job_taken",
    // 🛰 Offer expired (cron expiry / OTW timeout / travel no-show) — client
    // drops the card instantly instead of waiting for a refetch.
    JOB_EXPIRED: "job:expired",

    // 📍 Location Events
    LOCATION_UPDATE_EMIT: "location_update", // Emitted to customer

    // ⏰ Reminders / Enforcement
    TRAVEL_REMINDER: "booking:travel_reminder",
    BOOKING_REMINDER: "booking:reminder",
    BOOKING_REBROADCAST: "booking:rebroadcast",
    BOOKING_CANCELLED: "booking_cancelled",

    // 💸 Payments / Payouts
    // 🔔 System-initiated auto-payout sent to the technician's bank/UPI
    AUTO_PAYOUT_PAID: "auto_payout_paid",
    // 🔔 Customer-facing payment status push (observed from persisted transitions)
    PAYMENT_STATUS: "payment:status",

    // 🔐 Session Control
    SESSION_REVOKED: "session:revoked",   // forced logout (status change)
    SESSION_REPLACED: "session:replaced", // another device took over

    // 🧾 Refunds / Complaints (observed from persisted transitions)
    COMPLAINT_RECEIVED: "complaint:received",
    COMPLAINT_UNDER_REVIEW: "complaint:under_review",
    COMPLAINT_REJECTED: "complaint:rejected",
    COMPLAINT_FILED_AGAINST_YOU: "complaint:filed_against_you",
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
 * 🔒 SOCKET ROOM PREFIXES
 */
export const SOCKET_ROOMS = {
    TECHNICIAN: (id) => `technician_${id}`,
    CUSTOMER: (id) => `customer_${id}`,
    ADMIN_DASHBOARD: "admin_dashboard",
};