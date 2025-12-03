import mongoose from "mongoose";
const tempUserSchema = new mongoose.Schema(
  {
    firstName: {
      type: String,
      required: [true, "First name is required"],
      minlength: [3, "First name must be at least 3 characters"],
      maxlength: [50, "First name cannot exceed 50 characters"],
    },
    lastName: {
      type: String,
      required: [true, "Last name is required"],
      minlength: [1, "Last name must be at least 1 character"],
      maxlength: [50, "Last name cannot exceed 50 characters"],
    },
    username: {
      type: String,
      required: true,
      unique: true, // auto-generated during signup
    },
    gender: {
      type: String,
      enum: ["Male", "Female", "Other"],
      required: true,
    },
    mobileNumber: {
      type: String,
      required: [true, "Mobile number is required"],
      unique: true,
      match: [/^[0-9]{10}$/, "Mobile number must be 10 digits"],
      sparse: true,
    },
    email: {
      type: String,
      required: true,
      lowercase: true,
      match: /^\S+@\S+\.\S+$/,
    },
    password: {
      type: String,
      required: [true, "Password is required"],
      minlength: [8, "Password must be at least 8 characters"],
    },
    role: {
      type: String,
      enum: ["Owner", "Customer", "Technician", "Developer"],
      required: true,
    },
    tempstatus: {
      type: String,
      enum: ["Pending", "Verified", "Expired"],
      default: "Pending",
    },
    locality: {
      type: String,
      required: function () {
        return this.role === "Technician";
      },
    },
  },
  { timestamps: true }
);
export default mongoose.model("TempUser", tempUserSchema);
