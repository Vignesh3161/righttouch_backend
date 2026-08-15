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

    // 📍 Location Events
    LOCATION_UPDATE_EMIT: "location_update", // Emitted to customer

    // ⏰ Reminders / Enforcement
    TRAVEL_REMINDER: "booking:travel_reminder",
    BOOKING_REMINDER: "booking:reminder",
    BOOKING_REBROADCAST: "booking:rebroadcast",
    BOOKING_CANCELLED: "booking_cancelled",

    // 🔐 Session Control
    SESSION_REVOKED: "session:revoked",   // forced logout (status change)
    SESSION_REPLACED: "session:replaced", // another device took over
};

/**
 * 🔒 SOCKET ROOM PREFIXES
 */
export const SOCKET_ROOMS = {
    TECHNICIAN: (id) => `technician_${id}`,
    CUSTOMER: (id) => `customer_${id}`,
    ADMIN_DASHBOARD: "admin_dashboard",
};