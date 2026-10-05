import mongoose from "mongoose";

const { Schema } = mongoose;

const NotificationDeliverySchema = new Schema(
  {
    notificationId: { type: Schema.Types.ObjectId, required: true, index: true },
    recipientId: { type: Schema.Types.ObjectId, required: true, index: true },
    channel: {
      type: String,
      enum: ["socket", "push", "sms", "whatsapp", "email"],
      required: true,
    },
    status: {
      type: String,
      enum: [
        "pending",
        "queued",
        "provider_accepted",
        "device_received",
        "opened",
        "failed",
        "skipped",
        "dead_letter",
      ],
      default: "pending",
    },
    providerMessageId: String,
    providerResponse: Schema.Types.Mixed,
    attemptCount: { type: Number, default: 0 },
    lastAttemptAt: Date,
    providerAcceptedAt: Date,
    deviceReceivedAt: Date,
    openedAt: Date,
    failedAt: Date,
    failureCode: String,
    failureReason: String,
    nextAttemptAt: Date,
    createdAt: { type: Date, default: Date.now },
  },
  { versionKey: false }
);

NotificationDeliverySchema.index({ notificationId: 1, channel: 1 }, { unique: true });
NotificationDeliverySchema.index({ status: 1, nextAttemptAt: 1 });

export default mongoose.models.NotificationDelivery ||
  mongoose.model("NotificationDelivery", NotificationDeliverySchema);
