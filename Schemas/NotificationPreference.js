import mongoose from "mongoose";

const { Schema } = mongoose;

const NotificationPreferenceSchema = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      required: true,
      unique: true,
      index: true,
    },
    language: { type: String, default: "en" },
    timezone: { type: String, default: "Asia/Kolkata" },
    channels: {
      push: { type: Boolean, default: true },
      sms: { type: Boolean, default: true },
      email: { type: Boolean, default: false },
      whatsapp: { type: Boolean, default: false },
    },
    categories: {
      marketing: { type: Boolean, default: false },
      reminders: { type: Boolean, default: true },
      bookingUpdates: { type: Boolean, default: true },
      financial: { type: Boolean, default: true },
    },
    dnd: {
      enabled: { type: Boolean, default: false },
      start: { type: String, default: "22:00" },
      end: { type: String, default: "08:00" },
    },
  },
  { timestamps: true }
);

export default mongoose.models.NotificationPreference ||
  mongoose.model("NotificationPreference", NotificationPreferenceSchema);
