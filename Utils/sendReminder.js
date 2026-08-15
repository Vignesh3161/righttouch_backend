/**
 * 🔔 REMINDER UTILITY
 * Handles scheduled booking reminders (push + SMS) for technicians and customers.
 * Called by the scheduledBookingCron.js jobs.
 */

import { sendPushNotification, sendSocketNotification } from "./sendNotification.js";
import { SOCKET_EVENTS } from "./socketConstants.js";
import sendSms from "./sendSMS.js";
import TechnicianProfile from "../Schemas/TechnicianProfile.js";
import User from "../Schemas/User.js";

/**
 * Send a scheduled booking reminder to the assigned technician.
 *
 * @param {Object} booking  - ServiceBooking document (populated or plain)
 * @param {"h24"|"h1"|"min15"} type - Reminder type
 * @param {Object} io - Socket.IO instance
 */
export const sendScheduledReminder = async (booking, type, io) => {
    try {
        const technicianProfileId = booking.technicianId?.toString?.() || booking.technicianId;
        if (!technicianProfileId) return { success: false, reason: "No technician assigned" };

        // Resolve technician's user record for SMS
        const techProfile = await TechnicianProfile.findById(technicianProfileId)
            .select("userId")
            .populate("userId", "fname mobileNumber");

        const techName = techProfile?.userId?.fname || "Technician";
        const techPhone = techProfile?.userId?.mobileNumber || null;

        // Compose message based on type
        const scheduledDate = booking.scheduledAt
            ? new Date(booking.scheduledAt).toLocaleString("en-IN", {
                day: "2-digit", month: "short", year: "numeric",
                hour: "2-digit", minute: "2-digit", hour12: true,
            })
            : "your scheduled time";

        const messages = {
            h24: { title: "⏰ Reminder: Job Tomorrow", body: `Hi ${techName}, you have a scheduled job tomorrow at ${scheduledDate}. Please be prepared!` },
            h1: { title: "🔔 Job in 1 Hour", body: `Hi ${techName}, your job starts in 1 hour at ${scheduledDate}. Head out soon!` },
            min15: { title: "🚀 Job Starts in 15 Minutes!", body: `Hi ${techName}, your job starts in 15 minutes. Navigate to customer location now.` },
            enforceOTW: { title: "🚀 Action Required: Start Travel", body: `Hi ${techName}, your job starts at ${scheduledDate}. Please click 'On the Way' within 5 minutes or the job will be unassigned.` },
        };

        const msg = messages[type];
        if (!msg) return { success: false, reason: "Unknown reminder type" };

        // 1️⃣ Push Notification (stubbed until FCM is integrated)
        await sendPushNotification(technicianProfileId, {
            title: msg.title,
            body: msg.body,
            data: { type: `reminder_${type}`, bookingId: booking._id.toString() },
        });

        // 2️⃣ Socket notification
        if (io) {
            sendSocketNotification(io, technicianProfileId, SOCKET_EVENTS.BOOKING_REMINDER, {
                type,
                bookingId: booking._id,
                scheduledAt: booking.scheduledAt,
                message: msg.body,
            });
        }

        // 3️⃣ SMS (only for 1h and 15min reminders where urgency is high)
        if (techPhone && (type === "h1" || type === "min15")) {
            try {
                await sendSms(techPhone, msg.body);
            } catch (smsErr) {
                console.warn(`⚠️ SMS failed for tech ${technicianProfileId}:`, smsErr.message);
            }
        }

        console.log(`✅ [REMINDER:${type.toUpperCase()}] Sent to technician ${technicianProfileId} for booking ${booking._id}`);
        return { success: true };
    } catch (err) {
        console.error(`❌ sendScheduledReminder error:`, err.message);
        return { success: false, error: err.message };
    }
};

/**
 * Notify customer that their booking was re-broadcast (technician no-show).
 *
 * @param {Object} booking - ServiceBooking document
 * @param {Object} io - Socket.IO instance
 */
export const notifyCustomerOfRebroadcast = async (booking, io) => {
    try {
        const customerId = booking.customerId?.toString?.() || booking.customerId;
        if (!customerId) return;

        const message = "Your previous technician couldn't make it on time. We're finding you a new technician right away!";

        // Socket notification to customer
        if (io) {
            io.to(`customer_${customerId}`).emit(SOCKET_EVENTS.BOOKING_REBROADCAST, {
                bookingId: booking._id,
                message,
                timestamp: new Date(),
            });
        }

        // SMS to customer (best effort)
        try {
            const customer = await User.findById(customerId).select("mobileNumber fname");
            if (customer?.mobileNumber) {
                await sendSms(customer.mobileNumber, `RightTouch: ${message}`);
            }
        } catch (smsErr) {
            console.warn(`⚠️ Customer SMS failed:`, smsErr.message);
        }

        console.log(`✅ Customer ${customerId} notified of re-broadcast for booking ${booking._id}`);
    } catch (err) {
        console.error(`❌ notifyCustomerOfRebroadcast error:`, err.message);
    }
};
