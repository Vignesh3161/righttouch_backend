import mongoose from "mongoose";

const cartSchema = new mongoose.Schema(
  {
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    itemType: {
      type: String,
      enum: ["product", "service"],
      required: true,
    },
    itemId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
    },

    quantity: {
      type: Number,
      required: true,
      min: 1,
      default: 1,
    },
    // ⏰ Scheduling (Optional - for service items)
    scheduledAt: {
      type: Date,
      default: null,
    },
    // Local display fields captured at schedule-selection time (business timezone)
    scheduledDate: {
      type: String,
      default: null,
    },
    scheduledTime: {
      type: String,
      default: null,
    },
    timezone: {
      type: String,
      default: null,
    },
    // 📝 Problem Description (Optional)
    faultProblem: {
      type: String,
      trim: true,
      default: null,
    },
  },
  { timestamps: true }
);

// Ensure unique cart item per user per item
cartSchema.index({ customerId: 1, itemType: 1, itemId: 1 }, { unique: true });

export default mongoose.models.Cart || mongoose.model("Cart", cartSchema);