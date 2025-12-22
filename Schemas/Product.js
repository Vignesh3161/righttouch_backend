import mongoose from "mongoose";

const ProductSchema = new mongoose.Schema({
  productName: {
  type: String,
  required: true,
  trim: true,
  match: [/^[A-Za-z ]{2,50}$/, "Product name must contain only letters and spaces (2-50 characters)"],
  set: function (value) {
    if (typeof value !== "string") return value; // ✅ guard

    return value
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");
  },
},
  productDescription: {
    type: String,
    required: true,
  },
  productPrice: {
    type: Number,
    required: true,
  },
  productDiscountPercentage: {
    type: Number,
    required: true,
    validate: {
      validator: function (value) {
        return value <= 100;
      },
      message: "Product discount percentage cannot exceed 100%",
    },
  },
  productGst: {
    type: Number,
    required: true,
    default: 0,
  },
  productCount: {
    type: Number,
    default: 1,
  },
  inStock: {
    type: Number,
    required: true,
    validate: {
      validator: function (value) {
        return value >= 0;
      },
      message: "Stock cannot be negative",
    },
  },
  outStock: {
    type: Number,
    default: 0,
    validate: {
      validator: function (value) {
        return value >= 0;
      },
      message: "Stock cannot be negative",
    },
  },
  productImage: {
    type: [String],
    default: [],
  },
  productBrand: {
    type: String,
    required: true,
  },
  productFeatures: {
    type: [String],
    default: [],
  },
  status: {
    type: String,
    enum: ["Available", "Unavailable"],
    default: "Available",
  },
  warranty: {
    type: String,
  },

  // auto-calculated 
  discountAmount: {
    type: Number,
    default: 0,
  },
  discountedPrice: {
    type: Number,
    default: 0,
  },
  gstAmount: {
    type: Number,
    default: 0,
  },
  finalPrice: {
    type: Number,
    default: 0,
  },

  createdAt: {
    type: Date,
    default: Date.now,
  },
});

//  auto-update values
ProductSchema.pre("save", function (next) {
  // stock status
  this.status = this.inStock === 0 ? "Unavailable" : "Available";

  // discount calculation
  let discountAmount = 0;
  let discountedPrice = this.productPrice;

  if (this.productDiscountPercentage > 0) {
    discountAmount = (this.productPrice * this.productDiscountPercentage) / 100;
    discountedPrice = this.productPrice - discountAmount;
  }

  // GST calculation
  const gstAmount = (discountedPrice * this.productGst) / 100;
  const finalPrice = discountedPrice + gstAmount;

  // assign values
  this.discountAmount = discountAmount;
  this.discountedPrice = discountedPrice;
  this.gstAmount = gstAmount;
  this.finalPrice = finalPrice;

  next();
});

export default mongoose.model("Product", ProductSchema);
