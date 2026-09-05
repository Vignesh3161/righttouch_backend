import mongoose from "mongoose";
import Payment from "../Schemas/Payment.js";
import PaymentAttempt from "../Schemas/PaymentAttempt.js";
import ServiceBooking from "../Schemas/ServiceBooking.js";
import ProductBooking from "../Schemas/ProductBooking.js";
import { getIo } from "./ioAccess.js";
import { SOCKET_EVENTS, SOCKET_ROOMS } from "./socketConstants.js";

let timer = null;

// 🔒 Durable watermark — survives restarts. Previously an in-memory `new Date(0)`
// caused every restart to replay every payment event since the beginning of time.
const WorkerWatermark =
  mongoose.models.WorkerWatermark ||
  mongoose.model(
    "WorkerWatermark",
    new mongoose.Schema(
      {
        name: { type: String, required: true, unique: true },
        lastSeen: { type: Date, default: () => new Date(0) },
      },
      { versionKey: false }
    )
  );

let lastSeen = null;
let loaded = false;

const loadWatermark = async () => {
  if (loaded) return;
  try {
    const doc = await WorkerWatermark.findOne({ name: "paymentNotification" }).lean();
    lastSeen = doc?.lastSeen ? new Date(doc.lastSeen) : new Date(0);
  } catch {
    lastSeen = new Date(0);
  }
  loaded = true;
};

const persistWatermark = async (value) => {
  lastSeen = value;
  try {
    await WorkerWatermark.updateOne(
      { name: "paymentNotification" },
      { $set: { lastSeen: value } },
      { upsert: true }
    );
  } catch (e) {
    console.error("paymentNotificationWorker watermark persist error:", e.message);
  }
};

// Observes persisted Payment transitions (verify | webhook | cron | admin) and:
//  1. closes live attempts to captured/failed, and
//  2. emits a PII-free payment:status event to the customer room.
// Because it reads persisted state (not called from the core), NO function in
// paymentTransitions / webhook / crons is modified.
export const startPaymentNotificationWorker = () => {
  if (timer) return;
  timer = setInterval(async () => {
    try {
      await loadWatermark();
      const payments = await Payment.find({ updatedAt: { $gt: lastSeen } })
        .sort({ updatedAt: 1 })
        .limit(200)
        .lean();

      let maxSeen = lastSeen;
      for (const p of payments) {
        // 1. close live attempts based on authoritative payment state
        if (p.status === "success") {
          await PaymentAttempt.updateMany(
            { paymentId: p._id, state: { $in: ["created", "authorized"] } },
            { $set: { state: "captured", closedAt: new Date() } }
          );
        } else if (p.status === "failed") {
          await PaymentAttempt.updateMany(
            { paymentId: p._id, state: { $in: ["created", "authorized"] } },
            { $set: { state: "failed", closedAt: new Date() } }
          );
        }

        // 2. resolve customer + emit
        const booking =
          (await ServiceBooking.findById(p.bookingId).select("customerId").lean()) ||
          (await ProductBooking.findById(p.bookingId).select("customerId").lean());
        const customerId = booking?.customerId;
        if (customerId) {
          const state =
            p.status === "success"
              ? "paid"
              : p.status === "manual_review"
              ? "under_review"
              : p.status === "failed"
              ? "failed"
              : "processing";
          const io = getIo();
          io?.to(SOCKET_ROOMS.CUSTOMER(customerId.toString())).emit(SOCKET_EVENTS.PAYMENT_STATUS, {
            bookingId: p.bookingId?.toString(),
            paymentId: p._id?.toString(),
            customerState: state,
            amountDuePaise: state === "paid" ? 0 : p.totalAmountPaise || 0,
            paidAt: p.verifiedAt || null,
          });
        }

        if (p.updatedAt > maxSeen) maxSeen = p.updatedAt;
      }

      if (maxSeen > lastSeen) {
        await persistWatermark(maxSeen);
      }
    } catch (e) {
      console.error("paymentNotificationWorker error:", e.message);
    }
  }, 5000);
  timer.unref?.();
};

export const stopPaymentNotificationWorker = () => {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
};
