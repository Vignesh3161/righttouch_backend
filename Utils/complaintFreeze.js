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
    // 🔒 Multi-Complaint Financial Guard: Check if ANY OTHER active complaint exists for this booking.
    // H14: reuses ACTIVE_COMPLAINT_STATUSES (single source of truth) — the
    // per-booking payout block releases only when zero active complaints
    // remain; per-report holds below stay scoped to the resolving reportId.
    const Report = (await import("../Schemas/Report.js")).default;
    const otherActive = await Report.findOne(
      {
        bookingId,
        _id: { $ne: reportId },
        status: { $in: ACTIVE_COMPLAINT_STATUSES },
      },
      { _id: 1 },
      opts
    ).lean();

    if (otherActive) {
      console.log(`[COMPLAINT_FREEZE] Other active complaint (${otherActive._id}) exists for booking ${bookingId} — keeping payout hold & reserve frozen.`);
      return { released: false, reason: "OTHER_ACTIVE_COMPLAINT_EXISTS" };
    }

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
  return { released: true };
};

// H14: complaint terminal states per the Report schema enum. An open or
// under-review complaint keeps its holds frozen regardless of age; every
// other status (resolved_*, withdrawn, expired) permits expiry release.
export const ACTIVE_COMPLAINT_STATUSES = ["open", "under_review"];

export const releaseExpiredHolds = async (maxHours) => {
  // H14: never release by age alone. Each frozen hold / payout block is
  // released only when NO active complaint references its booking (or its
  // report). Missing or inconsistent references fail safe: the hold is kept
  // and surfaced via ReconciliationException. The read-check-release for one
  // booking runs in a transaction on replica sets so a concurrent complaint
  // update cannot slip between the check and the release.
  const cutoff = new Date(Date.now() - maxHours * 36e5);
  const { default: Report } = await import("../Schemas/Report.js");
  const { raiseReconciliationException } = await import("./paymentTransitions.js");

  const candidateHolds = await ReserveHold.find({
    status: "frozen",
    createdAt: { $lte: cutoff },
  })
    .select("_id bookingId reportId")
    .lean();
  const candidateBlocks = await BookingPayoutBlock.find({
    releasedAt: null,
    createdAt: { $lte: cutoff },
  })
    .select("_id bookingId reportId")
    .lean();

  const bookingIds = Array.from(
    new Set(
      [...candidateHolds, ...candidateBlocks]
        .map((r) => (r.bookingId ? String(r.bookingId) : null))
        .filter(Boolean)
    )
  );

  let released = 0;
  const releaseOneBooking = async (bookingId, session) => {
    const opts = session ? { session } : {};
    const activeComplaint = await Report.findOne(
      { bookingId, status: { $in: ACTIVE_COMPLAINT_STATUSES } },
      { _id: 1 },
      opts
    ).lean();
    if (activeComplaint) return { released: false, reason: "ACTIVE_COMPLAINT" };

    const reports = await Report.find({ bookingId }, { _id: 1 }, opts).lean();
    const holdsForBooking = candidateHolds.filter((h) => String(h.bookingId) === String(bookingId));
    if (holdsForBooking.length > 0 && reports.length === 0 && holdsForBooking.some((h) => h.reportId)) {
      // Hold points at a report that does not exist: fail safe + surface.
      await raiseReconciliationException({
        code: "HOLD_DANGLING_REPORT",
        severity: "critical",
        details: { bookingId, holdIds: holdsForBooking.map((h) => h._id) },
        session: session || undefined,
      });
      return { released: false, reason: "DANGLING_REFERENCE" };
    }

    const holdRes = await ReserveHold.updateMany(
      { bookingId, status: "frozen", createdAt: { $lte: cutoff } },
      { $set: { status: "held", releaseAt: new Date(), frozenReason: null } },
      opts
    );
    const blockRes = await BookingPayoutBlock.updateMany(
      { bookingId, releasedAt: null, createdAt: { $lte: cutoff } },
      { $set: { releasedAt: new Date() } },
      opts
    );
    // H14: count only actual transitions — a concurrent sweeper that arrives
    // after the release matches zero documents (updates are idempotent), so
    // exactly one sweep reports the release and double-release is observable.
    const transitioned = (holdRes.modifiedCount || 0) + (blockRes.modifiedCount || 0);
    return { released: transitioned > 0, holds: holdRes.modifiedCount || 0, blocks: blockRes.modifiedCount || 0 };
  };

  // Bookings with NO bookingId at all cannot be complaint-checked: keep + surface.
  const orphans = [...candidateHolds, ...candidateBlocks].filter((r) => !r.bookingId);
  for (const o of orphans) {
    await raiseReconciliationException({
      code: "HOLD_MISSING_BOOKING",
      severity: "critical",
      details: { holdId: o._id },
    });
  }

  const mongoose = (await import("mongoose")).default;
  for (const bookingId of bookingIds) {
    let session = null;
    try {
      session = await mongoose.startSession();
      let outcome = null;
      await session.withTransaction(async () => {
        outcome = await releaseOneBooking(bookingId, session);
      });
      if (outcome?.released) released += 1;
    } catch (e) {
      if (/replica set|Transaction|mongos/.test(String(e?.message || ""))) {
        const outcome = await releaseOneBooking(bookingId, null);
        if (outcome?.released) released += 1;
      } else {
        console.error(`[HoldRelease] booking ${bookingId}: ${e?.message || e}`);
      }
    } finally {
      if (session) await session.endSession().catch(() => {});
    }
  }
  return released;
};
