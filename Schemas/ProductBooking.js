import mongoose from "mongoose";
const ProductBookingSchema = new mongoose.Schema({
  productId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Product",
    required: true,
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  status: {
    type: String,
    enum: ["active", "cancelled", "completed"],
    default: "active",
  },
  amount: {
    type: Number,
    required: true,
    min: [0, "Amount must be positive"],
  },
  createdAt: { type: Date, default: Date.now },

});

export default mongoose.model("ProductBooking", ProductBookingSchema)