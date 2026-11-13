import mongoose from "mongoose";

/**
 * Approximate counter for scheduled slot capacity.
 *
 * Counters are deliberately not the source of truth: the TechnicianSlot unique
 * index is. Counters make hot-slot admission fast and are reconciled every
 * few minutes from active holds + active technician slots.
 *
 * Keys:
 *   g:<slotKey>:<districtId>:<cityZoneId>          global capacity
 *   s:<slotKey>:<serviceId>:<districtId>:<cityZoneId> service capacity
 */
const slotCapacitySchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, index: true },
    scope: {
      type: String,
      enum: ["global", "service_zone"],
      required: true,
      index: true,
    },
    slotKey: { type: String, required: true, index: true },
    serviceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Service",
      default: null,
      index: true,
    },
    districtId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "OperationalCity",
      default: null,
      index: true,
    },
    cityZoneId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "CityZone",
      default: null,
      index: true,
    },
    capacity: { type: Number, default: 0, min: 0 },
    held: { type: Number, default: 0, min: 0 },
    confirmed: { type: Number, default: 0, min: 0 },
    lastReconciledAt: { type: Date, default: null },
  },
  { timestamps: true }
);

slotCapacitySchema.index({ slotKey: 1, scope: 1 });

export default mongoose.models.SlotCapacity ||
  mongoose.model("SlotCapacity", slotCapacitySchema);
