import mongoose from "mongoose";
import SlotCapacity from "../Schemas/SlotCapacity.js";
import SlotHold from "../Schemas/SlotHold.js";
import TechnicianSlot from "../Schemas/TechnicianSlot.js";
import {
  countEligibleTechniciansForSlot,
} from "./slotAvailabilityService.js";

const keyPart = (value) => (value ? String(value) : "none");

export const buildCapacityKeys = ({ slotKey, serviceId, districtId, cityZoneId }) => {
  const globalKey = `g:${slotKey}:${keyPart(districtId)}:${keyPart(cityZoneId)}`;
  const serviceKey = `s:${slotKey}:${keyPart(serviceId)}:${keyPart(districtId)}:${keyPart(cityZoneId)}`;
  return [
    {
      key: globalKey,
      scope: "global",
      slotKey,
      serviceId: null,
      districtId: districtId || null,
      cityZoneId: cityZoneId || null,
    },
    {
      key: serviceKey,
      scope: "service_zone",
      slotKey,
      serviceId: serviceId || null,
      districtId: districtId || null,
      cityZoneId: cityZoneId || null,
    },
  ];
};

const ensureCapacityDoc = async ({ key, scope, slotKey, serviceId, districtId, cityZoneId, capacity }) => {
  try {
    await SlotCapacity.updateOne(
      { key },
      {
        $setOnInsert: {
          key,
          scope,
          slotKey,
          serviceId,
          districtId,
          cityZoneId,
          capacity,
          held: 0,
          confirmed: 0,
        },
      },
      { upsert: true }
    );
  } catch (error) {
    if (error?.code !== 11000) throw error;
  }
  await SlotCapacity.updateOne(
    { key, capacity: { $ne: capacity } },
    { $set: { capacity } }
  );
};

const acquireOne = async (key) => {
  return SlotCapacity.findOneAndUpdate(
    {
      key,
      $expr: { $lt: [{ $add: ["$held", "$confirmed"] }, "$capacity"] },
    },
    { $inc: { held: 1 } },
    { new: true }
  ).lean();
};

const releaseOneHeld = async (key) => {
  await SlotCapacity.updateOne(
    { key, held: { $gt: 0 } },
    { $inc: { held: -1 } }
  );
};

const confirmOne = async (key) => {
  const result = await SlotCapacity.updateOne(
    { key, held: { $gt: 0 } },
    { $inc: { held: -1, confirmed: 1 } }
  );
  if (!result.modifiedCount) {
    await SlotCapacity.updateOne({ key }, { $inc: { confirmed: 1 } });
  }
};

const releaseOneConfirmed = async (key) => {
  await SlotCapacity.updateOne(
    { key, confirmed: { $gt: 0 } },
    { $inc: { confirmed: -1 } }
  );
};

/**
 * Acquire both global and service-zone capacity counters for a scheduled
 * booking. Counters are approximate and are acquired outside the booking
 * transaction to avoid hot-document write conflicts. The TechnicianSlot
 * unique index remains the hard guard.
 *
 * @returns {{ ok: true, capacityKeys: string[], eligibleCount: number } | { ok: false, code: string }}
 */
export const acquireSlotCapacity = async ({
  slotKey,
  serviceId,
  districtId = null,
  cityZoneId = null,
  latitude = null,
  longitude = null,
}) => {
  const eligibleCount = await countEligibleTechniciansForSlot({
    serviceId,
    districtId,
    cityZoneId,
    latitude,
    longitude,
  });
  if (eligibleCount <= 0) {
    return { ok: false, code: "NO_ELIGIBLE_TECHNICIAN", eligibleCount: 0 };
  }

  const keyDefs = buildCapacityKeys({ slotKey, serviceId, districtId, cityZoneId });
  for (const def of keyDefs) {
    await ensureCapacityDoc({ ...def, capacity: eligibleCount });
  }

  const acquired = [];
  for (const def of keyDefs) {
    const doc = await acquireOne(def.key);
    if (!doc) {
      for (const key of acquired) await releaseOneHeld(key);
      return { ok: false, code: "SLOT_BUSY", eligibleCount };
    }
    acquired.push(def.key);
  }

  return { ok: true, capacityKeys: acquired, eligibleCount };
};

export const releaseSlotCapacity = async (capacityKeys = [], { confirmed = false } = {}) => {
  for (const key of capacityKeys) {
    if (confirmed) await releaseOneConfirmed(key);
    else await releaseOneHeld(key);
  }
};

export const confirmSlotCapacity = async (capacityKeys = []) => {
  for (const key of capacityKeys) await confirmOne(key);
};

/**
 * Move confirmed capacity back to held (used when an accepted scheduled job
 * is re-dispatched after a technician cancellation).
 */
export const revertConfirmedCapacityToHeld = async (capacityKeys = []) => {
  for (const key of capacityKeys) {
    await SlotCapacity.updateOne(
      { key, confirmed: { $gt: 0 } },
      { $inc: { confirmed: -1, held: 1 } }
    );
  }
};

/**
 * Create (or reuse) the active hold row. Call inside the booking transaction
 * after acquireSlotCapacity() succeeds outside the transaction.
 */
export const createSlotHold = async ({
  bookingId,
  cartGroupId = null,
  customerId,
  serviceId,
  slotKey,
  slotStartAt,
  slotEndAt,
  districtId = null,
  cityZoneId = null,
  capacityKeys,
  expiresAt,
  session = null,
  metadata = null,
}) => {
  const existing = await SlotHold.findOne({ bookingId, active: true }).session(session).lean();
  if (existing) return { hold: existing, reused: true };

  try {
    const [hold] = await SlotHold.create(
      [
        {
          bookingId,
          cartGroupId,
          customerId,
          serviceId,
          slotKey,
          slotStartAt,
          slotEndAt,
          districtId,
          cityZoneId,
          capacityKeys,
          expiresAt,
          status: "held",
          active: true,
          metadata,
        },
      ],
      session ? { session } : {}
    );
    return { hold, reused: false };
  } catch (error) {
    if (error?.code === 11000) {
      const hold = await SlotHold.findOne({ bookingId, active: true }).session(session).lean();
      if (hold) return { hold, reused: true };
    }
    throw error;
  }
};

/**
 * Convert the hold to confirmed and reserve the technician's slot.
 * Throws SLOT_BUSY when the technician already holds this slot.
 */
export const confirmScheduledSlot = async ({
  bookingId,
  technicianId,
  role = "primary",
  source = "booking",
  capacityKeys = null,
  session = null,
  adjustCapacity = true,
}) => {
  const hold = await SlotHold.findOne({ bookingId, active: true }).session(session);
  if (!hold) {
    const error = new Error("Scheduled slot hold not found or already released");
    error.statusCode = 409;
    error.code = "SLOT_HOLD_MISSING";
    throw error;
  }
  if (hold.status === "confirmed" && String(hold.technicianId) === String(technicianId)) {
    return { hold, technicianSlot: null, alreadyConfirmed: true };
  }

  let technicianSlot;
  try {
    [technicianSlot] = await TechnicianSlot.create(
      [
        {
          technicianId,
          bookingId,
          slotKey: hold.slotKey,
          slotStartAt: hold.slotStartAt,
          slotEndAt: hold.slotEndAt,
          role,
          active: true,
          source,
          capacityKeys: capacityKeys || hold.capacityKeys,
        },
      ],
      session ? { session } : {}
    );
  } catch (error) {
    if (error?.code === 11000) {
      const conflict = new Error("Technician already has a scheduled job in this slot");
      conflict.statusCode = 409;
      conflict.code = "SLOT_BUSY";
      throw conflict;
    }
    throw error;
  }

  if (adjustCapacity) {
    await confirmSlotCapacity(capacityKeys || hold.capacityKeys);
  }
  hold.status = "confirmed";
  hold.technicianId = technicianId;
  hold.confirmedAt = new Date();
  await hold.save({ session });

  return { hold, technicianSlot, alreadyConfirmed: false };
};

/**
 * Release a booking's hold and technician slot. Safe to call repeatedly.
 */
export const releaseScheduledSlot = async ({
  bookingId,
  reason = "released",
  session = null,
  expired = false,
}) => {
  const hold = await SlotHold.findOne({ bookingId, active: true }).session(session);
  let releasedHold = null;
  if (hold) {
    await releaseSlotCapacity(hold.capacityKeys, { confirmed: hold.status === "confirmed" });
    hold.active = false;
    hold.status = expired ? "expired" : "released";
    hold.releasedAt = new Date();
    hold.releaseReason = reason;
    await hold.save({ session });
    releasedHold = hold;
  }

  const slots = await TechnicianSlot.find({ bookingId, active: true }).session(session);
  for (const slot of slots) {
    slot.active = false;
    slot.releasedAt = new Date();
    slot.releaseReason = reason;
    await slot.save({ session });
  }

  return { hold: releasedHold, releasedTechnicianSlots: slots.length };
};

export const releaseTechnicianSlot = async ({
  technicianId,
  slotKey,
  bookingId,
  reason = "released",
  session = null,
}) => {
  const query = { active: true };
  if (technicianId) query.technicianId = technicianId;
  if (slotKey) query.slotKey = slotKey;
  if (bookingId) query.bookingId = bookingId;
  const slots = await TechnicianSlot.find(query).session(session);
  for (const slot of slots) {
    slot.active = false;
    slot.releasedAt = new Date();
    slot.releaseReason = reason;
    await slot.save({ session });
  }
  return slots.length;
};

/**
 * Expire stale held bookings whose hold deadline passed before acceptance.
 * Capacity is released and the booking is marked expired by the caller.
 */
export const expireStaleSlotHolds = async ({ now = new Date(), limit = 100 } = {}) => {
  const holds = await SlotHold.find({
    active: true,
    status: "held",
    expiresAt: { $ne: null, $lt: now },
  })
    .sort({ expiresAt: 1 })
    .limit(limit)
    .lean();

  const expiredBookingIds = [];
  for (const hold of holds) {
    const result = await SlotHold.findOneAndUpdate(
      { _id: hold._id, active: true, status: "held" },
      {
        $set: {
          active: false,
          status: "expired",
          releasedAt: now,
          releaseReason: "hold_expired",
        },
      },
      { new: true }
    );
    if (result) {
      await releaseSlotCapacity(hold.capacityKeys, { confirmed: false });
      expiredBookingIds.push(hold.bookingId);
    }
  }
  return expiredBookingIds;
};

/**
 * Recompute held/confirmed counters from authoritative rows. Conditional
 * delete is intentionally avoided; a daily cleanup removes zeroed rows.
 */
export const reconcileSlotCapacity = async ({ slotKeys = [], limit = 100 } = {}) => {
  const query = slotKeys.length ? { slotKey: { $in: slotKeys } } : {};
  const docs = await SlotCapacity.find(query).sort({ updatedAt: 1 }).limit(limit).lean();
  let updated = 0;

  for (const doc of docs) {
    const [held, confirmed] = await Promise.all([
      SlotHold.countDocuments({
        active: true,
        status: "held",
        capacityKeys: doc.key,
      }),
      TechnicianSlot.countDocuments({
        active: true,
        capacityKeys: doc.key,
      }),
    ]);
    await SlotCapacity.updateOne(
      { _id: doc._id },
      { $set: { held, confirmed, lastReconciledAt: new Date() } }
    );
    updated += 1;
  }
  return { scanned: docs.length, updated };
};

export const cleanupZeroCapacityRows = async ({ olderThan = new Date(Date.now() - 24 * 60 * 60 * 1000) } = {}) => {
  const result = await SlotCapacity.deleteMany({
    held: 0,
    confirmed: 0,
    updatedAt: { $lt: olderThan },
  });
  return result.deletedCount || 0;
};

export const getActiveHoldForBooking = async (bookingId) =>
  SlotHold.findOne({ bookingId, active: true }).lean();

export const getActiveTechnicianSlot = async ({ technicianId, slotKey }) =>
  TechnicianSlot.findOne({ technicianId, slotKey, active: true }).lean();

export const countActiveSlotsForTechnicianDate = async ({ technicianId, dayStart, dayEnd }) => {
  return TechnicianSlot.countDocuments({
    technicianId,
    active: true,
    slotStartAt: { $gte: dayStart, $lt: dayEnd },
  });
};

export const findNextActiveSlotForTechnician = async ({ technicianId, from = new Date() }) =>
  TechnicianSlot.findOne({
    technicianId,
    active: true,
    slotEndAt: { $gte: from },
  })
    .sort({ slotStartAt: 1 })
    .lean();

/**
 * Create a scheduled booking + BOOKING_CREATED outbox + capacity hold inside
 * the caller's transaction. Capacity is acquired before the transaction to
 * avoid hot-document conflicts; callers MUST call result.releaseCapacity() if
 * the transaction/commit fails after this helper returns.
 */
export const prepareScheduledBooking = async ({
  doc,
  session,
  latitude = null,
  longitude = null,
  cartGroupId = null,
}) => {
  if (doc.bookingType !== "schedule") {
    const { createBookingAndOutbox } = await import("../Utils/bookingService.js");
    const result = await createBookingAndOutbox({ doc, session });
    return { ...result, capacityKeys: [], hold: null, releaseCapacity: async () => {} };
  }

  const acquired = await acquireSlotCapacity({
    slotKey: doc.slotKey,
    serviceId: doc.serviceId,
    districtId: doc.districtId,
    cityZoneId: doc.cityZoneId,
    latitude,
    longitude,
  });
  if (!acquired.ok) {
    const error = new Error(
      acquired.code === "NO_ELIGIBLE_TECHNICIAN"
        ? "No technician is currently available for this service and slot"
        : "This slot is currently full. Please choose another slot."
    );
    error.statusCode = acquired.code === "NO_ELIGIBLE_TECHNICIAN" ? 409 : 409;
    error.code = acquired.code;
    throw error;
  }

  try {
    const { createBookingAndOutbox } = await import("../Utils/bookingService.js");
    const { booking, traceId } = await createBookingAndOutbox({ doc, session });
    const { hold } = await createSlotHold({
      bookingId: booking._id,
      cartGroupId,
      customerId: doc.customerId,
      serviceId: doc.serviceId,
      slotKey: doc.slotKey,
      slotStartAt: doc.slotStartAt,
      slotEndAt: doc.slotEndAt,
      districtId: doc.districtId,
      cityZoneId: doc.cityZoneId,
      capacityKeys: acquired.capacityKeys,
      expiresAt: doc.autoCancelAt || new Date(Date.now() + 60 * 60 * 1000),
      session,
      metadata: { eligibleCount: acquired.eligibleCount },
    });
    let capacityReleased = false;
    return {
      booking,
      traceId,
      hold,
      capacityKeys: acquired.capacityKeys,
      releaseCapacity: async () => {
        if (capacityReleased) return;
        capacityReleased = true;
        await releaseSlotCapacity(acquired.capacityKeys);
      },
    };
  } catch (error) {
    await releaseSlotCapacity(acquired.capacityKeys);
    throw error;
  }
};

export const isValidObjectId = (value) => mongoose.Types.ObjectId.isValid(value);
