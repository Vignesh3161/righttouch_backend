import mongoose from "mongoose";

const technicianSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User", //   your main User model
      required: true,
    },

    panNumber: {
      type: String,
      match: /^[A-Z]{5}[0-9]{4}[A-Z ]{1}$/, // Format: ABCDE1234F
      required: true,
      unique: true,
    },

    aadhaarNumber: {
      type: String,
      match: /^\d{12}$/, // Aadhaar should be 12 digits
      required: true,
      unique: true,
    },

    passportNumber: {
      type: String,
      match: /^[A-PR-WY][1-9]\d{6}$/, // Indian Passport format
      required: false,
      unique: true,
      sparse: true, // allows null/empty without uniqueness conflicts
    },

    drivingLicenseNumber: {
      type: String,
      required: [true, "Driving License Number is required"],
      unique: true,
      match: [
        /^([A-Z]{2}\d{2}\s\d{11}|[A-Z]{2}\d{2}[A-Z]{1}\d{10})$/,
        "Driving License Number must be either 'TN10 12345678901' or 'TN60Z2024001234' format",
      ],
    },

    documents: {
      panCard: {
        data: Buffer,
        contentType: String,
      },
      aadhaarCard: {
        data: Buffer,
        contentType: String,
      },
      passport: {
        data: Buffer,
        contentType: String,
      },
      drivingLicense: {
        data: Buffer,
        contentType: String,
      },
    },

    balance: {
      type: Number,
      default: 0,
      min: 0,
    },

    status: {
      type: String,
      enum: ["active", "inactive", "suspended"],
      default: "active",
    },

    // performance

    report: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Report",
      default: null,
    },
    rating: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Rating",
      default: null,
    },
    serviceBooking: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ServiceBooking",
      default: null,
    },
    experienceYear: {
      type: Number,
      default: 0,
      min: [0, "Years cannot be negative"],
    },

    experienceMonths: {
      type: Number,
      min: [3, "Minimum 3 months of experience required"],
      max: [12, "Maximum 12 months of experience required"],
      required: function () {
        return this.experienceYear === 0;
      },
      default: 0,
    },

    totalJobCompleted: {
      type: Number,
      default: 0,
    },
    tracking: {
      type: String,
      enum: [
        "waiting",
        "accepted",
        "comming",
        "reached",
        "working",
        "completed",
      ],
      default: "waiting",
    },
    // image

    image: {
      type: String,
    },

    createdAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    toJSON: { virtuals: true },
  }
);

// create virtual data not store in db

technicianSchema.virtual("reports", {
  ref: "report",
  localField: "_id",
  foreignField: "technicianId",
});

// technicianSchema.pre("save", function (next) {
//   Object.keys(this.toObject()).forEach((key) => {
//     if (this[key] === "" || this[key] === null || this[key] === undefined) {
//       this.set(key, undefined); // remove field
//     }
//   });
//   next();
// });

export default mongoose.model("Technician", technicianSchema);

// const mongoose = require("mongoose");

// const userSchema = new mongoose.Schema({
//   experienceYear: {
//     type: Number,
//     default: 0,
//     min: [0, "Years cannot be negative"]
//   },
//   experienceMonths: {
//     type: Number,
//     min: [0, "Months cannot be negative"],
//     max: [11, "Months should be less than 12"], // keep it realistic
//     required: true
//   }
// });

// // ✅ Custom validation: at least 3 months total
// userSchema.path("experienceMonths").validate(function () {
//   const totalMonths = (this.experienceYear * 12) + this.experienceMonths;
//   return totalMonths >= 3;
// }, "Minimum 3 months of experience required");

// const User = mongoose.model("User", userSchema);
// export default User;
