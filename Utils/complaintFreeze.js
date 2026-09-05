import ReserveHold from "../Schemas/ReserveHold.js";
import BookingPayoutBlock from "../Schemas/BookingPayoutBlock.js";
import TechnicianProfile from "../Schemas/TechnicianProfile.js";

export const freezeForComplaint = async ({ bookingId, technicianId, reportId, session = null }) => {
  const opts = session ? { session } : {};
  let frozeReserve = false;
  let payoutBlocked = false;

  if (technicianId) {
    // Real freeze: if a hold already exists for this booking, mark it frozen.
    // Otherwise create one so the retention reserve is genuinely locked and
    // `frozeReserve` reflects reality (previously this was a no-op when the
    // reserve hadn't been seeded yet).
    let hold = await ReserveHold.findOneAndUpdate(
      { bookingId, technicianId, status: { $in: ["held", "released"] } },
      { $set: { status: "frozen", frozenReason: "complaint", reportId, releasedAt: null } },
      { new: true, ...opts }
    );
    if (!hold) {
      const tech = await TechnicianProfile.findById(technicianId).select("reserveBalancePaise").lean();
      hold = await ReserveHold.create(
        [
          {
            bookingId,
            technicianId,
            amountPaise: tech?.reserveBalancePaise || 0,
            status: "frozen",
            frozenReason: "complaint",
            reportId,
          },
        ],
        opts
      );
      hold = Array.isArray(hold) ? hold[0] : hold;
    }
    frozeReserve = true;
  }

  if (bookingId) {
    const existing = await BookingPayoutBlock.findOne({ bookingId }, null, opts).lean();
    if (!existing) {
      await BookingPayoutBlock.create(
        [{ bookingId, technicianId, reason: "complaint_open", reportId }],
        opts
      );
      payoutBlocked = true;
    }
  }

  return { frozeReserve, payoutBlocked };
};

/**
 * Returns true if the technician currently has an unresolved payout block
 * (e.g. an open complaint). Payout paths MUST call this and abort/defer when
 * it returns true (O1).
 */
export const hasActivePayoutBlock = async (technicianId, { session = null } = {}) => {
  const opts = session ? { session } : {};
  const [block, profile] = await Promise.all([
    BookingPayoutBlock.findOne(
      { technicianId, releasedAt: null },
      { _id: 1 },
      opts
    ).lean(),
    TechnicianProfile.findById(technicianId, { payoutBlocked: 1 }, opts).lean(),
  ]);
  return !!block || profile?.payoutBlocked === true;
};

export const releaseOnResolution = async ({ bookingId, reportId, session = null }) => {
  const opts = session ? { session } : {};
  if (bookingId) {
    await BookingPayoutBlock.updateOne(
      { bookingId },
      { $set: { releasedAt: new Date() } },
      opts
    );
  }
  await ReserveHold.updateMany(
    { bookingId, status: "frozen", reportId },
    { $set: { status: "held", releaseAt: new Date(), frozenReason: null } },
    opts
  );
};

export const releaseExpiredHolds = async (maxHours) => {
  const cutoff = new Date(Date.now() - maxHours * 36e5);
  const res = await ReserveHold.updateMany(
    { status: "frozen", createdAt: { $lte: cutoff } },
    { $set: { status: "held", releaseAt: new Date(), frozenReason: null } }
  );
  await BookingPayoutBlock.updateMany(
    { releasedAt: null, createdAt: { $lte: cutoff } },
    { $set: { releasedAt: new Date() } }
  );
  return res.modifiedCount || 0;
};
