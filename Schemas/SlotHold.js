import mongoose from "mongoose";

/**
 * Capacity hold for a scheduled booking while it is awaiting technician
 * acceptance. Holds are created in the same transaction as the booking, and
 * converted to confirmed on accept or released on cancel/expiry/re-dispatch.
 */
const slotHoldSchema = new mongoose.Schema(
  {
    bookingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ServiceBooking",
      required: true,
      index: true,
    },
    cartGroupId: { type: String, default: null, index: true },
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    serviceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Service",
      required: true,
      index: true,
    },
    technicianId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "TechnicianProfile",
      default: null,
      index: true,
    },
    slotKey: { type: String, required: true, index: true },
    slotStartAt: { type: Date, required: true, index: true },
    slotEndAt: { type: Date, required: true },
    districtId: { type: mongoose.Schema.Types.ObjectId, ref: "OperationalCity", default: null },
    cityZoneId: { type: mongoose.Schema.Types.ObjectId, ref: "CityZone", default: null },
    status: {
      type: String,
      enum: ["held", "confirmed", "released", "expired"],
      default: "held",
      index: true,
    },
    active: { type: Boolean, default: true, index: true },
    capacityKeys: { type: [String], default: [] },
    expiresAt: { type: Date, default: null, index: true },
    confirmedAt: { type: Date, default: null },
    releasedAt: { type: Date, default: null },
    releaseReason: { type: String, default: null },
    metadata: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true }
);

slotHoldSchema.index(
  { bookingId: 1 },
  {
    unique: true,
    partialFilterExpression: { active: true },
    name: "uniq_active_hold_booking",
  }
);

slotHoldSchema.index({ slotKey: 1, active: 1, status: 1 });
slotHoldSchema.index({ slotKey: 1, active: 1, serviceId: 1 });
slotHoldSchema.index({ expiresAt: 1, active: 1, status: 1 });

export default mongoose.models.SlotHold || mongoose.model("SlotHold", slotHoldSchema);
