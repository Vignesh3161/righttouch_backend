import { SOCKET_EVENTS } from "../Utils/socketConstants.js";

/**
 * Event registry. Each entry defines the channels used by the NEW notification
 * service. Per the deployment constraint: general notifications use only
 * socket + push (FCM); SMS is reserved for OTP; WhatsApp/email adapters exist
 * but are NOT wired into general dispatch yet.
 */
export const NOTIFICATION_EVENTS = {
  COMPLAINT_RECEIVED: {
    defaultChannels: ["socket", "push"],
    priority: "high",
    category: "complaint",
    dndAllowed: false,
    socketEvent: SOCKET_EVENTS.COMPLAINT_RECEIVED,
    recipientTypes: ["customer", "technician", "admin"],
  },
  COMPLAINT_FILED_AGAINST_YOU: {
    defaultChannels: ["socket", "push"],
    priority: "high",
    category: "complaint",
    dndAllowed: false,
    socketEvent: SOCKET_EVENTS.COMPLAINT_FILED_AGAINST_YOU,
    recipientTypes: ["technician"],
  },
  COMPLAINT_UNDER_REVIEW: {
    defaultChannels: ["socket", "push"],
    priority: "high",
    category: "complaint",
    dndAllowed: false,
    socketEvent: SOCKET_EVENTS.COMPLAINT_UNDER_REVIEW,
    recipientTypes: ["customer", "technician"],
  },
  COMPLAINT_REJECTED: {
    defaultChannels: ["socket", "push"],
    priority: "high",
    category: "complaint",
    dndAllowed: false,
    socketEvent: SOCKET_EVENTS.COMPLAINT_REJECTED,
    recipientTypes: ["customer"],
  },
  COMPLAINT_RESOLVED_IN_FAVOUR: {
    defaultChannels: ["socket", "push"],
    priority: "high",
    category: "complaint",
    dndAllowed: false,
    socketEvent: SOCKET_EVENTS.COMPLAINT_RESOLVED_IN_FAVOUR,
    recipientTypes: ["customer", "technician"],
  },
  COMPLAINT_STATUS_UPDATED: {
    defaultChannels: ["socket", "push"],
    priority: "normal",
    category: "complaint",
    dndAllowed: false,
    socketEvent: SOCKET_EVENTS.COMPLAINT_STATUS_UPDATED,
    recipientTypes: ["admin"],
  },
  REFUND_INITIATED: {
    defaultChannels: ["socket", "push"],
    priority: "high",
    category: "financial",
    dndAllowed: false,
    socketEvent: SOCKET_EVENTS.REFUND_INITIATED,
    recipientTypes: ["customer"],
  },
  REFUND_PROCESSED: {
    defaultChannels: ["socket", "push"],
    priority: "high",
    category: "financial",
    dndAllowed: false,
    socketEvent: SOCKET_EVENTS.REFUND_PROCESSED,
    recipientTypes: ["customer"],
  },
  REFUND_FAILED: {
    defaultChannels: ["socket", "push"],
    priority: "critical",
    category: "financial",
    dndAllowed: false,
    socketEvent: SOCKET_EVENTS.REFUND_FAILED,
    recipientTypes: ["customer", "admin"],
  },
  HOLD_RELEASED: {
    defaultChannels: ["socket", "push"],
    priority: "normal",
    category: "financial",
    dndAllowed: true,
    socketEvent: SOCKET_EVENTS.HOLD_RELEASED,
    recipientTypes: ["technician"],
  },
  CLAWBACK_APPLIED: {
    defaultChannels: ["socket", "push"],
    priority: "high",
    category: "financial",
    dndAllowed: false,
    socketEvent: SOCKET_EVENTS.CLAWBACK_APPLIED,
    recipientTypes: ["technician"],
  },
  OTP: {
    defaultChannels: ["sms", "whatsapp"],
    priority: "critical",
    category: "security",
    dndAllowed: false,
    preferenceRequired: false,
    recipientTypes: ["customer", "technician"],
  },
};

export const isValidEventType = (t) => Object.prototype.hasOwnProperty.call(NOTIFICATION_EVENTS, t);

export const getEventPolicy = (t) => NOTIFICATION_EVENTS[t] || null;
