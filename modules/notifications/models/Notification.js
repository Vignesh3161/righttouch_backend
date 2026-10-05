import mongoose from "mongoose";

const { Schema } = mongoose;

const NotificationSchema = new Schema(
  {
    recipientId: { type: Schema.Types.ObjectId, required: true, index: true },
    recipientType: {
      type: String,
      enum: ["customer", "technician", "admin"],
      required: true,
    },
    eventType: { type: String, required: true, index: true },
    title: { type: String, required: true },
    body: { type: String, required: true },
    data: { type: Schema.Types.Mixed, default: {} },
    priority: {
      type: String,
      enum: ["low", "normal", "high", "critical"],
      default: "normal",
    },
    category: { type: String, default: "general" },
    sourceType: String,
    sourceId: String,
    correlationId: String,
    idempotencyKey: { type: String, unique: true, sparse: true },
    readAt: { type: Date, default: null },
    receivedAt: { type: Date, default: null },
    openedAt: { type: Date, default: null },
    expiresAt: { type: Date, default: null },
  },
  { versionKey: false, timestamps: true }
);

NotificationSchema.index({ recipientId: 1, recipientType: 1, createdAt: -1 });
NotificationSchema.index({ recipientId: 1, readAt: 1, createdAt: -1 });

export default mongoose.models.Notification || mongoose.model("Notification", NotificationSchema);
