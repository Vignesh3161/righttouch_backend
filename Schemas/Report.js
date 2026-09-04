import mongoose from "mongoose";

const reportSchema = new mongoose.Schema(
  {
    bookingId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
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

    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    complaint: {
      type: String,
      required: true,
    },

    image: String,

    status: {
      type: String,
      enum: [
        "open",
        "under_review",
        "resolved_refunded",
        "resolved_no_refund",
        "withdrawn",
        "expired",
      ],
      default: "open",
    },

    // Kind of complaint — drives Class A (automatic) vs Class B (adjudication).
    category: {
      type: String,
      enum: [
        "quality_dispute",
        "damage",
        "incomplete_work",
        "technician_misconduct",
        "goodwill",
        "product_issue",
        "other",
      ],
      default: "quality_dispute",
    },

    refundId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Refund",
      default: null,
    },

    reviewedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    reviewedAt: { type: Date, default: null },

    resolutionNote: { type: String, default: null },

    // SLA deadline for admin response (complaintSlaCron escalates past this).
    slaDeadline: { type: Date, default: null },

    // Whether the complaint froze a reserve hold (audit trail).
    frozeReserve: { type: Boolean, default: false },
    payoutBlocked: { type: Boolean, default: false },

    isRead: { type: Boolean, default: false, index: true },
    readAt: { type: Date, default: null },
    readBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

reportSchema.index({ status: 1, slaDeadline: 1 });
reportSchema.index({ customerId: 1, createdAt: -1 });
reportSchema.index({ bookingId: 1, status: 1 });
reportSchema.index({ isRead: 1, status: 1 });

export default mongoose.models.Report || mongoose.model("Report", reportSchema);
