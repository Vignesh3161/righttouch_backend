/**
 * Quotation delivery — outbox + channel tracker (architecture §11).
 *
 * The DB is the source of truth; WhatsApp/push/SMS/email are channels only.
 * Rows are created inside the same transaction that changes the quotation, then
 * a worker (`processQuotationDeliveries`) sends them. Failures update THIS row
 * and are retried; they never flip the parent Quotation status back to failed.
 */
import mongoose from "mongoose";
import QuotationDelivery from "../Schemas/QuotationDelivery.js";
import Quotation from "../Schemas/Quotation.js";
import Notification from "../Schemas/Notification.js";
import { paiseToRupees } from "../Utils/money.js";

const MAX_ATTEMPTS = 5;
const BACKOFF_MS = 30 * 60 * 1000; // 30 min

const buildMessage = (quotation) => {
  const total = paiseToRupees(quotation.financialSnapshot.totalAmountPaise).toFixed(2);
  return `Hi ${quotation.customerSnapshot?.name || "there"}, your RightTouch quotation ${quotation.quotationNumber} is ready. Total: ₹${total}. Valid until ${quotation.validUntil?.toLocaleDateString?.() || ""}.`;
};

/**
 * Upsert one delivery row per channel. Safe to call on send AND resend — the
 * unique (quotationId, channel, notificationType) key makes it idempotent.
 */
export const enqueueDeliveries = async ({
  quotationId,
  customerId,
  requestId = null,
  notificationType = "QUOTATION_SENT",
  title = "Quotation ready",
  body = null,
  session = null,
}) => {
  const channels = ["in_app", "whatsapp"];
  const rows = [];
  for (const channel of channels) {
    const row = await QuotationDelivery.findOneAndUpdate(
      { quotationId, channel, notificationType },
      {
        $set: {
          customerId,
          requestId,
          status: "pending",
          nextAttemptAt: new Date(),
          title,
          body,
        },
        $setOnInsert: { attempts: 0 },
      },
      { upsert: true, new: true, ...(session ? { session } : {}) }
    );
    rows.push(row);
  }
  return rows;
};

const markDelivered = async (id, patch) =>
  QuotationDelivery.findByIdAndUpdate(id, { $set: patch, $inc: { attempts: 1 } });

const sendInApp = async (delivery, quotation) => {
  await Notification.create({
    recipientId: delivery.customerId,
    recipientType: "customer",
    eventType: delivery.notificationType,
    title: delivery.title || "Quotation update",
    body: delivery.body || buildMessage(quotation),
    data: { quotationId: String(quotation._id), requestId: quotation.quoteRequestId?.toString?.() },
    category: "quotation",
    sourceType: "Quotation",
    sourceId: String(quotation._id),
  });
  await markDelivered(delivery._id, { status: "delivered", sentAt: new Date(), deliveredAt: new Date() });
  // In-app is reliable — reflect success on the quotation (see architecture §13).
  await Quotation.findByIdAndUpdate(delivery.quotationId, { notificationStatus: "sent" });
};

const sendWhatsapp = async (delivery, quotation) => {
  const phone = quotation.customerSnapshot?.phone;
  if (!phone) {
    await markDelivered(delivery._id, { status: "failed", lastError: "No customer phone", nextAttemptAt: new Date(Date.now() + BACKOFF_MS) });
    await Quotation.findByIdAndUpdate(delivery.quotationId, {
      notificationStatus: "failed",
      failedAt: new Date(),
      lastError: "No customer phone",
      $inc: { retryCount: 1 },
    });
    return;
  }
  try {
    const { default: sendWhatsapp } = await import("./sendWhatsapp.js");
    // sendWhatsapp util currently expects an OTP body; we send the quotation text.
    const client = (await import("twilio")).default(
      process.env.TWILIO_SID_WHATSAPP,
      process.env.TWILIO_TOKEN_WHATSAPP
    );
    const msg = await client.messages.create({
      from: process.env.WHATSAPP_SENDER,
      to: `whatsapp:+91${phone}`,
      body: delivery.body || buildMessage(quotation),
    });
    await markDelivered(delivery._id, { status: "sent", providerMessageId: msg.sid, sentAt: new Date() });
    await Quotation.findByIdAndUpdate(delivery.quotationId, { notificationStatus: "sent", sentAt: new Date() });
  } catch (e) {
    const willRetry = delivery.attempts + 1 < MAX_ATTEMPTS;
    await markDelivered(delivery._id, {
      status: willRetry ? "pending" : "failed",
      lastError: e.message,
      nextAttemptAt: new Date(Date.now() + BACKOFF_MS),
    });
    await Quotation.findByIdAndUpdate(delivery.quotationId, {
      notificationStatus: willRetry ? "retrying" : "failed",
      failedAt: willRetry ? undefined : new Date(),
      lastError: e.message,
      $inc: { retryCount: 1 },
    });
  }
};

export const processQuotationDeliveries = async (limit = 25) => {
  const due = await QuotationDelivery.find({
    status: { $in: ["pending", "queued"] },
    nextAttemptAt: { $lte: new Date() },
  })
    .limit(limit)
    .lean();

  for (const delivery of due) {
    const quotation = await Quotation.findById(delivery.quotationId).lean();
    if (!quotation) {
      await QuotationDelivery.findByIdAndUpdate(delivery._id, { status: "failed", lastError: "Quotation missing" });
      continue;
    }
    if (delivery.channel === "in_app") await sendInApp(delivery, quotation);
    else if (delivery.channel === "whatsapp") await sendWhatsapp(delivery, quotation);
    else await markDelivered(delivery._id, { status: "sent", sentAt: new Date() });
  }
};

/** Map a provider webhook (sent/delivered/read) back to the delivery row. */
export const recordProviderCallback = async ({ providerMessageId, status }) => {
  if (!providerMessageId) return;
  const map = { sent: "sent", delivered: "delivered", read: "read" };
  const next = map[status];
  if (!next) return;
  await QuotationDelivery.updateOne(
    { providerMessageId },
    { $set: { status: next, ...(next === "delivered" ? { deliveredAt: new Date() } : {}), ...(next === "read" ? { readAt: new Date() } : {}) } }
  );
};
