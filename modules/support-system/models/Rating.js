import mongoose from "mongoose";

const ratingSchema = new mongoose.Schema(
  {
    bookingId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      unique: true, // one rating per order
    },

    bookingType: {
      type: String,
      enum: ["product", "service"],
      required: true,
    },

    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
    },

    
    serviceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Service",
    },

    technicianId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "TechnicianProfile",
    },

    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    rates: {
      type: Number,
      min: 1,
      max: 5,
      required: true,
    },

    comment: String,

    content: {
      type: String,
      enum: ["Excellent", "Good", "Average", "Below Average"],
    },
  },

  { timestamps: true }

);

// ── Indexes (architecture §24/§51) ──
// Single rating per booking is enforced by the unique bookingId index.
// Compound indexes keep rollups efficient and isolated per bookingType.
ratingSchema.index({ technicianId: 1, bookingType: 1 });
ratingSchema.index({ serviceId: 1, bookingType: 1 });
ratingSchema.index({ productId: 1, bookingType: 1 });

// auto label
ratingSchema.pre("save", function (next) {
  if (this.rates >= 4) this.content = "Excellent";
  else if (this.rates >= 3) this.content = "Good";
  else if (this.rates >= 2) this.content = "Average";
  else this.content = "Below Average";
  next();
});

export default mongoose.models.Rating || mongoose.model("Rating", ratingSchema);