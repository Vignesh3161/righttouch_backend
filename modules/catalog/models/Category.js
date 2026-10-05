import mongoose from "mongoose";

const categorySchema = new mongoose.Schema({
  category: {
    type: String,
    required: true,
    trim: true,
    match: [/^[A-Za-z &]{2,50}$/, "Invalid category name"],
    set: function (value) {
      if (typeof value !== "string") return value;
      return value
        .trim()
        .split(/\s+/)
        .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
        .join(" ");
    },
  },


  slug: {
    type: String,
    unique: true,
    lowercase: true,
  },

  description: {
    type: String,
    required: true,
  },

  categoryType: {
    type: String,
    enum: ["service", "product"],
    default: "service",
    required: true,
  },

  image: {
    type: String,
    default: null, // 👈 image uploaded later
  },

  isActive: {
    type: Boolean,
    default: true,
  },


  createdAt: {
    type: Date,
    default: Date.now,
  },
});

// Auto-generate slug
categorySchema.pre("save", function (next) {
  if (this.category) {
    const typeSuffix = this.categoryType ? `-${this.categoryType}` : "";
    this.slug =
      this.category
        .toLowerCase()
        .replace(/&/g, "and")
        .replace(/\s+/g, "-") + typeSuffix;
  }
  next();
});

export default mongoose.models.Category || mongoose.model("Category", categorySchema);
