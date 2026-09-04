import mongoose from "mongoose";

const { Schema } = mongoose;

const NotificationOutboxSchema = new Schema(
  {
    notificationId: { type: Schema.Types.ObjectId, required: true, index: true },
    eventType: { type: String, required: true },
    sourceType: String,
    sourceId: String,
    status: {
      type: String,
      enum: ["pending", "published", "completed", "failed"],
      default: "pending",
    },
    attempts: { type: Number, default: 0 },
    nextAttemptAt: { type: Date, default: Date.now },
    lastError: String,
    createdAt: { type: Date, default: Date.now },
    publishedAt: Date,
    completedAt: Date,
  },
  { versionKey: false }
);

NotificationOutboxSchema.index({ status: 1, nextAttemptAt: 1 });

export default mongoose.models.NotificationOutbox ||
  mongoose.model("NotificationOutbox", NotificationOutboxSchema);
