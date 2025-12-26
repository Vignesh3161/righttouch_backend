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

  image: {
    type: String,
    default: null, // 👈 image uploaded later
  },

  isActive: {
    type: Boolean,
    default: true,
  },

  displayOrder: {
    type: Number,
    default: 0,
  },

  createdAt: {
    type: Date,
    default: Date.now,
  },
});

// Auto-generate slug
categorySchema.pre("save", function (next) {
  if (this.category) {
    this.slug = this.category
      .toLowerCase()
      .replace(/&/g, "and")
      .replace(/\s+/g, "-");
  }
  next();
});

export default mongoose.model("Category", categorySchema);
