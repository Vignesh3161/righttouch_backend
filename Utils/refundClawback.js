import mongoose from "mongoose";
import TechnicianProfile from "../Schemas/TechnicianProfile.js";
import WalletTransaction from "../Schemas/WalletTransaction.js";
import ReserveHold from "../Schemas/ReserveHold.js";
import { atomicWalletDebit } from "./walletDebit.js";

const key = (refundId, step) => `rfd:${refundId}:${step}`;

export const applyClawback = async ({ technicianId, refundId, amountPaise, session = null }) => {
  const opts = session ? { session } : {};

  // H11/H13 — consume ONLY the hold belonging to THIS refund's booking.
  // The previous filter ({technicianId, any held/frozen}) could seize an
  // unrelated booking's hold, corrupting both bookings' accounting. The claim
  // is conditional (unconsumed + still held/frozen) so concurrent clawbacks
  // for the same booking collapse to one consumer.
  const Refund = (await import("../Schemas/Refund.js")).default;
  const refundDoc = await Refund.findById(refundId).select("bookingId").lean();
  await ReserveHold.findOneAndUpdate(
    {
      technicianId,
      ...(refundDoc?.bookingId ? { bookingId: refundDoc.bookingId } : { bookingId: null }),
      status: { $in: ["held", "frozen"] },
      $or: [{ consumedBy: null }, { consumedBy: { $exists: false } }],
    },
    { $set: { status: "consumed", consumedBy: refundId } },
    { ...opts }
  );

  // Cascade B/C/D — atomic, clamped, CAS-guarded debit (no read-then-write race,
  // balance can never go negative). Ledger rows are idempotent per step.
  const result = await atomicWalletDebit({
    technicianId,
    amountPaise,
    reason: "Clawback",
    idempotencyKey: key(refundId, "clawback"),
    session,
  });

  return { appliedReserve: result.reserve, appliedAvailable: result.available, toDues: result.dues };
};

export const reverseClawback = async ({ technicianId, refundId, session = null }) => {
  // H13: the reversal runs in ONE transaction (own session when the caller
  // passes none) so concurrent reversals serialize on the marker rows and a
  // crash cannot leave a half-applied restoration. Standalone/dev falls back
  // to sequential best-effort application (documented, not crash-safe).
  if (!session) {
    const own = await mongoose.startSession();
    try {
      let out = null;
      await own.withTransaction(async () => {
        out = await reverseClawbackInner({ technicianId, refundId, session: own });
      });
      return out;
    } catch (e) {
      if (/replica set|Transaction|mongos/.test(String(e?.message || ""))) {
        return await reverseClawbackInner({ technicianId, refundId, session: null });
      }
      throw e;
    } finally {
      await own.endSession().catch(() => {});
    }
  }
  return reverseClawbackInner({ technicianId, refundId, session });
};

const reverseClawbackInner = async ({ technicianId, refundId, session = null }) => {
  // H13 — compensating reversal that PRESERVES history and restores the
  // correct balance category. The previous implementation:
  //   (a) DELETED the original debit rows (audit trail destroyed);
  //   (b) credited reserve-taken funds into availableBalancePaise (wrong
  //       bucket — retention reserve must go back to reserve);
  //   (c) decremented dues without a floor (could drive dues negative);
  //   (d) restored ANY hold consumed by this refund to held + stamped
  //       releaseAt, even for bookings with still-open complaints.
  // New behavior: original rows are kept; per-step compensating CREDIT rows
  // (keyed `${base}:reversal:{step}`) restore reserve→reserve,
  // available→available, dues→dues (floored at 0). The reversal markers make
  // repeats and concurrent reversals idempotent no-ops. Holds are restored
  // booking-scoped, back to frozen while their complaint stays open.
  const opts = session ? { session } : {};
  const base = key(refundId, "clawback");
  const steps = ["reserve", "available", "dues"];

  const entries = await WalletTransaction.find(
    {
      technicianId,
      idempotencyKey: { $in: steps.map((s) => `${base}:${s}`) },
    },
    null,
    opts
  ).lean();
  const debitSteps = new Set(
    (entries || []).map((e) => String(e.idempotencyKey).split(":").pop())
  );

  const already = await WalletTransaction.find(
    { technicianId, idempotencyKey: { $in: steps.map((s) => `${base}:reversal:${s}`) } },
    { idempotencyKey: 1 },
    opts
  ).lean();
  const reversed = new Set((already || []).map((r) => String(r.idempotencyKey).split(":").pop()));
  // Fully reversed ⟺ every step that was ever debited has its marker. (A
  // refund that only touched `available` needs just that marker — requiring
  // all three steps would never report already_reversed and would invite
  // duplicate work.)
  if ([...debitSteps].every((s) => reversed.has(s))) {
    await restoreConsumedHolds({ technicianId, refundId, session });
    return { reversed: false, reason: "already_reversed" };
  }

  for (const e of entries) {
    const step = e.idempotencyKey.split(":").pop();
    if (reversed.has(step)) continue; // idempotent per step
    // H13: claim the reversal marker FIRST — a concurrent reverser loses the
    // unique-key race here, before any balance is touched. (Inside the
    // reversal transaction this serializes cleanly; crash before the balance
    // update aborts the marker with it.)
    try {
      await WalletTransaction.create(
        [
          {
            technicianId,
            amountPaise: e.amountPaise,
            amount: null,
            type: "credit",
            source: "refund",
            idempotencyKey: `${base}:reversal:${step}`,
            note: `Clawback reversal (${step}) for refund ${refundId} — compensating entry, original debit preserved`,
          },
        ],
        opts
      );
    } catch (err) {
      if (err?.code === 11000) continue; // concurrent reverser won this step
      throw err;
    }
    if (step === "dues") {
      await TechnicianProfile.updateOne(
        { _id: technicianId },
        [
          {
            $set: {
              outstandingDuesPaise: {
                $max: [{ $subtract: [{ $ifNull: ["$outstandingDuesPaise", 0] }, e.amountPaise] }, 0],
              },
              walletVersion: { $add: [{ $ifNull: ["$walletVersion", 0] }, 1] },
            },
          },
        ],
        opts
      );
    } else if (step === "reserve") {
      await TechnicianProfile.updateOne(
        { _id: technicianId },
        { $inc: { reserveBalancePaise: e.amountPaise, walletVersion: 1 } },
        opts
      );
    } else {
      await TechnicianProfile.updateOne(
        { _id: technicianId },
        { $inc: { availableBalancePaise: e.amountPaise, walletVersion: 1 } },
        opts
      );
    }
  }

  await restoreConsumedHolds({ technicianId, refundId, session });
  return { reversed: true };
};

const restoreConsumedHolds = async ({ technicianId, refundId, session = null }) => {
  const opts = session ? { session } : {};
  const Refund = (await import("../Schemas/Refund.js")).default;
  const refundDoc = await Refund.findById(refundId).select("bookingId").lean();
  const holds = await ReserveHold.find(
    {
      consumedBy: refundId,
      ...(refundDoc?.bookingId ? { bookingId: refundDoc.bookingId } : {}),
    },
    null,
    opts
  ).lean();
  for (const hold of holds) {
    // H13/H14: a hold tied to a still-open complaint must NOT be released —
    // restore it to frozen (re-locked), not held. releaseAt is left untouched:
    // only a genuine release stamps it.
    let restoreTo = "held";
    if (hold.reportId || hold.bookingId) {
      const Report = (await import("../Schemas/Report.js")).default;
      const openComplaint = await Report.findOne(
        {
          $or: [
            ...(hold.reportId ? [{ _id: hold.reportId }] : []),
            ...(hold.bookingId ? [{ bookingId: hold.bookingId }] : []),
          ],
          status: { $in: ["open", "under_review"] },
        },
        { _id: 1 },
        opts
      ).lean();
      if (openComplaint) restoreTo = "frozen";
    }
    await ReserveHold.updateOne(
      { _id: hold._id, status: "consumed", consumedBy: refundId },
      {
        $set: {
          status: restoreTo,
          consumedBy: null,
          ...(restoreTo === "frozen"
            ? { frozenReason: hold.frozenReason || "complaint" }
            : { frozenReason: null }),
        },
      },
      opts
    );
  }
};
