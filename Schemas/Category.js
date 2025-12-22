import mongoose from "mongoose";

const categorySchema = new mongoose.Schema({
  category: {
    type: String,
    required: true,
    trim: true,
    match: [
      /^[A-Za-z &]{2,50}$/,
      "Category name must contain only letters, spaces, or '&' (2-50 characters)",
    ],
    set: function (value) {
      if (typeof value !== "string") return value; // ✅ IMPORTANT GUARD

      return value
        .trim()
        .split(/\s+/)
        .map(
          (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
        )
        .join(" ");
    },
  },

  description: {
    type: String,
    required: true,
  },

  image: {
    type: String,
    required: true,
  },

  createdAt: {
    type: Date,
    default: Date.now,
  },
});

export default mongoose.model("Category", categorySchema);
