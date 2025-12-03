import mongoose from "mongoose";

const serviceSchema = new mongoose.Schema({
  categoryId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Category",
    required: true,
  },
  serviceName: {
    type: String,
    required: true,
    trim: true,
    match: [/^[A-Za-z ]{2,50}$/, "service name must contain only letters and spaces (2-50 characters)"],
    set: function (value) {
      return value
        .toLowerCase()
        .split(" ")
        .filter(Boolean)
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(" ");
    },
  },
  description: {
    type: String,
    required: true,
  },
  serviceCost: {
    type: Number,
    required: true,
  },

  // commission
  commissionPercentage: {
    type: Number,
    required: true,
    default: 0,
    max: [50, "Commission cannot exceed 50%"],
  },

  // auto-calculated amounts
  CommissionAmount: {
    type: Number,
    default: 0,
  },
  TechnicianAmount: {
    type: Number,
    default: 0,
  },

  serviceDiscountPercentage: {
    type: Number,
    required: true,
    validate: {
      validator: function (value) {
        return value <= 100;
      },
      message: "Service discount percentage cannot exceed 100%",
    },
  },
  quantity: {
    type: Number,
    required: true,
    default: 1,
  },
  active: {
    type: String,
    enum: ["active", "inactive"],
    required: true,
  },
  status: {
    type: String,
    enum: ["waiting", "accepted", "decline"],
    required: true,
    default: "waiting",
  },
  duration: {
    type: String,
  },

  // discount calculations
  discountAmount: {
    type: Number,
    default: 0,
  },
  discountedPrice: {
    type: Number,
    default: 0,
  },

  createdAt: {
    type: Date,
    default: Date.now,
  },
});

// Auto-calculation before save
serviceSchema.pre("save", function (next) {
  // Step 1: Discount calculation
  let discountAmount = 0;
  let discountedPrice = this.serviceCost;

  if (this.serviceDiscountPercentage > 0) {
    discountAmount = (this.serviceCost * this.serviceDiscountPercentage) / 100;
    discountedPrice = this.serviceCost - discountAmount;
  }

  this.discountAmount = discountAmount;
  this.discountedPrice = discountedPrice;

  // Step 2: Commission & Technician calculation (based on discountedPrice)
  this.CommissionAmount = (discountedPrice * this.commissionPercentage) / 100;
  this.TechnicianAmount = discountedPrice - this.CommissionAmount;

  next();
});

export default mongoose.model("Service", serviceSchema);
