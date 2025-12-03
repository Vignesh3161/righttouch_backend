import mongoose from "mongoose";

const ratingSchema = new mongoose.Schema(
  {
    technicianId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Technician",
      // required: true,
    },
    serviceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Service",
      required: true,
    },
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    rates: {
      type: Number,
      required: true,
      min: 0,
      max: 5,
    },
    comment: {
      type: String,
    },
    content: {
      type: String,
      enum: ["Excellent", "Good", "Average", "Below Average"],
    },
  },
  {
    timestamps: true,
  }
);

// auto set content
ratingSchema.pre("save", function (next) {
  if (this.rates >= 4) {
    this.content = "Excellent";
  } else if (this.rates >= 3) {
    this.content = "Good";
  } else if (this.rates >= 2) {
    this.content = "Average";
  } else {
    this.content = "Below Average";
  }
  next();
});

export default mongoose.model("Rating", ratingSchema);
