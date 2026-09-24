/**
 * Centralized status constants for the application
 * Use these instead of hardcoded strings to prevent typos
 */

// Service Booking Status
export const SERVICE_BOOKING_STATUS = {
  REQUESTED: "requested",
  ACCEPTED: "accepted",
  IN_PROGRESS: "in_progress",
  COMPLETED: "completed",
  CANCELLED: "cancelled",
  REJECTED: "rejected",
};

// Product Booking Status
export const PRODUCT_BOOKING_STATUS = {
  ACTIVE: "active",
  DELIVERED: "delivered",
  CANCELLED: "cancelled",
  RETURNED: "returned",
};


// Payment Status
export const PAYMENT_STATUS = {
  PENDING: "pending",
  SUCCESS: "success",
  FAILED: "failed",
  REFUNDED: "refunded",
};

// Payment Mode
export const PAYMENT_MODE = {
  ONLINE: "online",
  COD: "cod",
};

// Location Type
export const LOCATION_TYPE = {
  SAVED: "saved",
  GPS: "gps",
};

// Address Label
export const ADDRESS_LABEL = {
  HOME: "home",
  WORK: "work",
  OTHER: "other",
};

// User Roles
export const USER_ROLE = {
  CUSTOMER: "Customer",
  TECHNICIAN: "Technician",
  ADMIN: "Admin",
  OWNER: "Owner",
};
