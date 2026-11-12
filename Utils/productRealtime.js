/**
 * Product-flow realtime helper.
 *
 * Emits minimal, PII-free change notifications to the admin dashboard room.
 * Safe to call from services, controllers, cron jobs, and tests where no
 * Socket.IO instance exists.
 */
import { getIo } from "./ioAccess.js";
import { SOCKET_EVENTS, SOCKET_ROOMS } from "./socketConstants.js";

const emitProductFlowEvent = (event, payload = {}) => {
  const io = getIo();
  if (!io || typeof io.to !== "function") return;
  io.to(SOCKET_ROOMS.ADMIN_DASHBOARD).emit(event, {
    ...payload,
    emittedAt: new Date().toISOString(),
  });
};

export const emitProductQuoteRequestChanged = (payload) =>
  emitProductFlowEvent(SOCKET_EVENTS.PRODUCT_QUOTE_REQUEST_CHANGED, payload);

export const emitProductQuotationChanged = (payload) =>
  emitProductFlowEvent(SOCKET_EVENTS.PRODUCT_QUOTATION_CHANGED, payload);

export const emitProductBookingChanged = (payload) =>
  emitProductFlowEvent(SOCKET_EVENTS.PRODUCT_BOOKING_CHANGED, payload);

export { emitProductFlowEvent };
