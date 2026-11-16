import mongoose from "mongoose";

/**
 * One row per accepted scheduled job (primary) or backup replacement.
 *
 * The partial unique index on { technicianId, slotKey } where active:true is
 * the hard guarantee that a technician can hold at most one scheduled job in a
 * 3-hour slot. Rows are released with active:false (never deleted) so the
 * audit trail and rollback compatibility are preserved.
 */
const technicianSlotSchema = new mongoose.Schema(
  {
    technicianId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "TechnicianProfile",
      required: true,
      index: true,
    },
    bookingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ServiceBooking",
      required: true,
      index: true,
    },
    slotKey: {
      type: String,
      required: true,
      index: true,
    },
    slotStartAt: { type: Date, required: true, index: true },
    slotEndAt: { type: Date, required: true },
    role: {
      type: String,
      enum: ["primary", "backup"],
      default: "primary",
    },
    active: { type: Boolean, default: true, index: true },
    source: {
      type: String,
      enum: ["booking", "reschedule", "replacement", "manual", "legacy_backfill"],
      default: "booking",
    },
    lateCompletionAtRisk: { type: Boolean, default: false },
    capacityKeys: { type: [String], default: [] },
    assignedAt: { type: Date, default: Date.now },
    releasedAt: { type: Date, default: null },
    releaseReason: { type: String, default: null },
    metadata: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true }
);

technicianSlotSchema.index(
  { technicianId: 1, slotKey: 1 },
  {
    unique: true,
    partialFilterExpression: { active: true },
    name: "uniq_active_technician_slot",
  }
);

technicianSlotSchema.index(
  { bookingId: 1, role: 1 },
  {
    unique: true,
    partialFilterExpression: { active: true },
    name: "uniq_active_booking_role",
  }
);

technicianSlotSchema.index({ slotKey: 1, active: 1, technicianId: 1 });
technicianSlotSchema.index({ technicianId: 1, active: 1, slotStartAt: 1 });
technicianSlotSchema.index({ bookingId: 1, active: 1 });

export default mongoose.models.TechnicianSlot ||
  mongoose.model("TechnicianSlot", technicianSlotSchema);
