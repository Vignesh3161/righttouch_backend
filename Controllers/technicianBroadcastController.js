import mongoose from "mongoose";
import JobBroadcast from "../Schemas/TechnicianBroadcast.js";
import ServiceBooking from "../Schemas/ServiceBooking.js";
import TechnicianProfile from "../Schemas/TechnicianProfile.js";
import TechnicianBookingOffer from "../Schemas/TechnicianBookingOffer.js";
import User from "../Schemas/User.js";
import { notifyCustomerJobAccepted, notifyJobTaken, emitJobsChanged } from "../Utils/sendNotification.js";
import { fetchTechnicianJobsInternal } from "../Utils/technicianJobFetch.js";
import { ensureTechnician } from "../Utils/ensureTechnician.js";
import { checkTechnicianActivation } from "../Utils/technicianActivation.js";
import { evaluateJobFeasibility, loadCommittedQueues } from "../Utils/technicianMatching.js";
import { canArriveBy, computeLatestArrival, estimateTravelMinutes } from "../Utils/feasibility.js";
import Service from "../Schemas/Service.js";
import Category from "../Schemas/Category.js";
import { checkTechnicianEligibility } from "../Services/technicianEligibilityService.js";

const DISPATCH_LOCK_MS = 10000;

/* ================= GET MY JOBS (LIVE FEED) ================= */
export const getMyJobs = async (req, res) => {
  try {
    ensureTechnician(req);
    const technicianProfileId = req.user.technicianProfileId;

    // 1. Check if technician is Online
    const techProfile = await TechnicianProfile.findById(technicianProfileId).select("availability.isOnline");
    if (!techProfile?.availability?.isOnline) {
      return res.status(200).json({
        success: true,
        message: "You are currently offline. Please go online to see and accept new jobs.",
        result: []
      });
    }

    // 2. Check for Active Jobs
    // We only block the feed if:
    // a) The technician is currently on a job (on_the_way, reached, in_progress)
    // b) The technician has an instant job in ACCEPTED status (must start travel soon)
    const activeJob = await ServiceBooking.findOne({
      technicianId: technicianProfileId,
      $or: [
        { status: { $in: ["on_the_way", "reached", "in_progress"] } },
        { status: { $in: ["accepted", "ACCEPTED"] }, bookingType: "instant" }
      ]
    }).select("_id status bookingType");

    if (activeJob) {
      const statusMsg = activeJob.status === "ACCEPTED" || activeJob.status === "accepted" 
        ? "Please start travel for your current job" 
        : `You are currently on a job (${activeJob.status})`;

      return res.status(200).json({
        success: true,
        message: `${statusMsg}. Your live feed is temporarily hidden to help you focus on the current task.`,
        result: [],
      });
    }

    // 3. Check Activation Status (KYC, Training, etc.)
    const activation = await checkTechnicianActivation(technicianProfileId);
    if (!activation.isActive) {
      return res.status(200).json({ success: true, message: activation.message, result: [] });
    }

    const jobs = await fetchTechnicianJobsInternal(technicianProfileId);
    
    // Remove basePrice from jobs for technician view (safety)
    const filteredJobs = jobs.map(job => {
      const jobObj = job.toObject ? job.toObject() : job;
      const { basePrice, ...jobData } = jobObj;
      return jobData;
    });

    return res.status(200).json({ 
      success: true, 
      message: filteredJobs.length > 0 ? "Live jobs fetched successfully" : "No new jobs available in your area right now.", 
      result: filteredJobs 
    });
  } catch (err) {
    console.error("getMyJobs Error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

/* ================= RESPOND TO JOB ================= */
export const respondToJob = async (req, res) => {
  // B-09 two-phase acceptance. Phase A performs all advisory reads outside
  // any transaction (broadcast lookup, expiry, activation, mutex, candidate,
  // version + eligibility pre-checks, feasibility). Phase B then opens a
  // SHORT transaction that re-reads the authoritative rows on a fresh
  // snapshot, re-validates version + eligibility, and performs the
  // conditional claim. Anything revoked/re-broadcast before Phase B commits
  // deterministically loses; only a revocation landing inside the short
  // Phase-B window remains invisible (documented consistency boundary).
  let session = null;
  let dispatchLockAt = null;
  try {
    ensureTechnician(req);
    const { id } = req.params;
    const technicianProfileId = req.user.technicianProfileId;
    const rawStatus =
      req.body?.action ??
      req.body?.status ??
      req.body?.response ??
      req.body?.decision ??
      "";
    const finalStatus = String(rawStatus).trim().toLowerCase();

    const isAccept = ["accepted", "accept", "agree", "yes"].includes(finalStatus);
    const isDecline = ["declined", "decline", "rejected", "reject", "no"].includes(finalStatus);

    if (!isAccept && !isDecline) {
      return res.status(400).json({ success: false, message: "Invalid response status" });
    }

    // Phase-A broadcast lookup (no session — advisory; Phase B re-reads).
    const broadcast = await JobBroadcast.findOne({
      bookingId: id,
      technicianId: technicianProfileId,
      status: { $in: ["sent"] },
    });

    if (!broadcast) {
      return res.status(403).json({ success: false, message: "Job not assigned to you or already closed" });
    }

    // ⏱ Offer must still be unexpired — a re-broadcasted job's old offer is dead.
    if (broadcast.expiresAt && new Date(broadcast.expiresAt).getTime() < Date.now()) {
      return res.status(410).json({
        success: false,
        message: "This job offer has expired. Pull to refresh your job list.",
        reason: "offer_expired",
        expiresAt: broadcast.expiresAt,
        nextRefreshHintAt: new Date(Math.ceil(Date.now() / (10 * 60 * 1000)) * 10 * 60 * 1000),
      });
    }

    // 🛑 Handle DECLINE / REJECT in its own short transaction.
    if (isDecline) {
      session = await mongoose.startSession();
      session.startTransaction();
      try {
        await JobBroadcast.updateOne(
          { bookingId: id, technicianId: technicianProfileId },
          { status: "rejected" },
          { session }
        );

        const rejectedOffer = await TechnicianBookingOffer.findOneAndUpdate(
          { bookingId: id, technicianId: technicianProfileId },
          {
            $set: {
              decision: "rejected",
              rejectReason: req.body?.reason || "declined_by_technician",
              respondedAt: new Date(),
            },
          },
          { new: true, session }
        );

        if (rejectedOffer) {
          await TechnicianBookingOffer.updateOne(
            { _id: rejectedOffer._id },
            {
              $set: {
                responseLatencyMs: Date.now() - new Date(rejectedOffer.offeredAt).getTime(),
              },
            },
            { session }
          );
        }

        await session.commitTransaction();
      } catch (declineErr) {
        if (session.inTransaction()) await session.abortTransaction();
        throw declineErr;
      } finally {
        session.endSession();
        session = null;
      }

      return res.status(200).json({
        success: true,
        message: "Job declined successfully",
      });
    }

    // 🛡 Activation gate — suspended/unapproved/KYC-incomplete technicians
    // must not accept jobs, even with a lingering "sent" broadcast record.
    const activation = await checkTechnicianActivation(technicianProfileId);
    if (!activation.isActive) {
      return res.status(403).json({
        success: false,
        message: activation.message,
      });
    }

    // 🔒 Per-technician dispatch mutex (self-expiring, cross-process via the
    // profile document) — serializes concurrent accept requests for the SAME
    // technician. Deliberately outside any transaction (self-expiry).
    dispatchLockAt = new Date(Date.now() + DISPATCH_LOCK_MS);
    const locked = await TechnicianProfile.findOneAndUpdate(
      {
        _id: technicianProfileId,
        $or: [
          { dispatchLockUntil: null },
          { dispatchLockUntil: { $lte: new Date() } },
        ],
      },
      { $set: { dispatchLockUntil: dispatchLockAt } },
      { new: true, projection: { _id: 1 } }
    ).lean();

    if (!locked) {
      return res.status(409).json({
        success: false,
        message: "Another request is being processed, please try again.",
      });
    }

    const activeJob = await ServiceBooking.findOne({
      technicianId: technicianProfileId,
      $or: [
        { status: { $in: ["on_the_way", "reached", "in_progress"] } },
        { status: { $in: ["accepted", "ACCEPTED"] }, bookingType: "instant" },
      ],
    }).select("_id status bookingType");

    if (activeJob) {
      const statusMsg =
        activeJob.status === "ACCEPTED" || activeJob.status === "accepted"
          ? "start travel for your current job"
          : "complete your current job";

      return res.status(409).json({
        success: false,
        message: `Please ${statusMsg} before accepting a new one.`,
      });
    }

    // 📡 Version the technician is claiming — client may pass the DTO's
    // broadcast version; otherwise use the broadcast row's version.
    const requestedVersion =
      Number.isInteger(req.body?.version) && req.body.version > 0
        ? req.body.version
        : broadcast.version || 1;

    // ⏱ Candidate booking snapshot (Phase-A advisory read).
    const candidate = await ServiceBooking.findById(id)
      .select("bookingType scheduledAt location status autoCancelAt activeBroadcastVersion assignmentAttempts serviceId districtId cityZoneId technicianId");
    if (!candidate) {
      return res.status(404).json({ success: false, message: "Booking not found" });
    }

    // 🎯 VERSION VALIDATION (advisory) — reject stale broadcast versions.
    // The authoritative version gate runs inside the Phase-B transaction.
    if (broadcast.version && requestedVersion !== broadcast.version) {
      return res.status(409).json({
        success: false,
        message: "This job offer has been updated. Please refresh and try again.",
        reason: "version_mismatch",
        requestedVersion,
        currentVersion: broadcast.version,
      });
    }

    // 🎯 ELIGIBILITY PRE-CHECK (advisory) — the authoritative re-check runs
    // inside the Phase-B transaction on a fresh snapshot.
    const eligibility = await checkTechnicianEligibility({
      technician: technicianProfileId,
      booking: candidate,
    });

    if (!eligibility.eligible) {
      return res.status(403).json({
        success: false,
        message: "You are no longer eligible to accept this job.",
        reasons: eligibility.reasons,
        details: eligibility.details,
      });
    }

    // ⏱ The claim must reference an active unassigned booking (advisory —
    // re-verified on live state inside Phase B).
    if (candidate.technicianId || !["pending", "broadcasted"].includes(candidate.status)) {
      return res.status(409).json({
        success: false,
        message: "Too late! Booking already taken or closed.",
      });
    }

    // ⏱ Accept-time feasibility re-check — the offer-time snapshot is stale
    // by the time the tech taps accept (queue/location may have changed).
    //   instant candidate + pending scheduled appointment → travel chain check
    //   schedule candidate                        → window overlap check
    const [techQueueMap, techProfileForCheck] = await Promise.all([
      loadCommittedQueues([technicianProfileId]),
      TechnicianProfile.findById(technicianProfileId).select("location"),
    ]);
    const techQueue = techQueueMap.get(String(technicianProfileId));

    if (candidate.bookingType === "schedule") {
      // Schedule-vs-schedule: run forward-pass travel chain (not just ±30min overlap)
      // to ensure the technician can physically travel between slots.
      const candidateSlot = new Date(candidate.scheduledAt).getTime();
      const existingSchedules = (techQueue?.schedules || []).filter(
        (s) => String(s._id) !== String(id)
      );

      if (existingSchedules.length > 0 && techProfileForCheck?.location) {
        // Sort existing schedules by slot time
        const sorted = [...existingSchedules].sort(
          (a, b) => new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime()
        );

        // Build committed queue: all existing accepted schedules
        const committedQueue = sorted.map((s) => ({
          location: s.location,
          scheduledAt: s.scheduledAt,
          estimatedDurationMinutes: 60, // default service duration
        }));

        // Check if tech can arrive at candidate after the preceding schedule
        // and still make the following schedule
        const candidateDeadline = computeLatestArrival(candidate.scheduledAt);
        const techLocation = techProfileForCheck.location;

        // Find the schedule that comes just before the candidate slot
        const preceding = sorted.filter(
          (s) => new Date(s.scheduledAt).getTime() < candidateSlot
        );
        const following = sorted.filter(
          (s) => new Date(s.scheduledAt).getTime() > candidateSlot
        );

        // Feasibility: can the tech arrive at candidate by its deadline?
        // Build a chain: [preceding schedules] -> candidate -> [following schedules]
        const chainQueue = [...preceding.map((s) => ({
          location: s.location,
          scheduledAt: s.scheduledAt,
          estimatedDurationMinutes: 60,
        })), {
          location: candidate.location,
          scheduledAt: candidate.scheduledAt,
          estimatedDurationMinutes: 60,
        }];

        // Check travel from tech to first stop, then through the chain
        let cursor = Date.now();
        let lastLocation = techLocation;

        for (const stop of chainQueue) {
          const travelMin = estimateTravelMinutes(lastLocation, stop.location);
          if (travelMin == null) continue;
          cursor += travelMin * 60 * 1000;

          // Must arrive before the slot (with grace)
          const deadline = computeLatestArrival(stop.scheduledAt);
          if (deadline && cursor > deadline.getTime()) {
            return res.status(409).json({
              success: false,
              message: "This time slot conflicts with an appointment you already accepted.",
            });
          }

          // Move cursor past the job duration
          cursor += (stop.estimatedDurationMinutes || 60) * 60 * 1000;
          lastLocation = stop.location;
        }

        // Also check that after the candidate, tech can reach following schedules
        if (following.length > 0) {
          for (const stop of following) {
            const travelMin = estimateTravelMinutes(lastLocation, stop.location);
            if (travelMin == null) continue;
            cursor += travelMin * 60 * 1000;

            const deadline = computeLatestArrival(stop.scheduledAt);
            if (deadline && cursor > deadline.getTime()) {
              return res.status(409).json({
                success: false,
                message: "Accepting this job would make you late for a later appointment.",
              });
            }
            cursor += (stop.estimatedDurationMinutes || 60) * 60 * 1000;
            lastLocation = stop.location;
          }
        }
      }
    } else {
      // Check for ANY instant jobs in technician's queue (not just scheduled)
      // Race condition fix: another instant job could have been accepted between broadcast and accept
      const allInstantJobs = (techQueue?.schedules || []).filter(s => s.bookingType === "instant");
      if (allInstantJobs.length > 0 && techProfileForCheck?.location) {
        // Check feasibility against all instant jobs
        for (const instantJob of allInstantJobs) {
          const feasibility = evaluateJobFeasibility({
            techLocation: techProfileForCheck.location,
            candidateJob,
            queue: { activeJob: null, schedules: [instantJob] },
          });
          if (!feasibility.feasible) {
            return res.status(409).json({
              success: false,
              message: "This job would make you late for another instant job you accepted.",
              result: {
                projectedArrival: feasibility.projectedArrival,
                slackMinutes: feasibility.slackMinutes,
              },
            });
          }
        }
      }

      const feasibility = evaluateJobFeasibility({
        techLocation: techProfileForCheck?.location || null,
        candidateJob: candidate,
        queue: techQueue,
      });
      if (!feasibility.feasible) {
        return res.status(409).json({
          success: false,
          message: "This job would make you late for your scheduled appointment.",
          result: {
            projectedArrival: feasibility.projectedArrival,
            slackMinutes: feasibility.slackMinutes,
          },
        });
      }
    }

    // B-09 deterministic test hook (inert in production): runs after the
    // advisory checks and BEFORE the claim transaction opens, so tests can
    // commit a revocation/re-broadcast mid-flight on a fresh snapshot.
    await globalThis.__b09OnEligible?.();

    // ================= PHASE B — CLAIM TRANSACTION (fresh snapshot) ======
    // Re-reads the authoritative rows, re-validates version + eligibility,
    // then performs the conditional claim. A concurrent winner, re-broadcast,
    // or revocation committed before this point deterministically loses.
    session = await mongoose.startSession();
    session.startTransaction();
    let booking = null;
    let otherTechIds = [];
    try {
      const fresh = await JobBroadcast.findOne({
        bookingId: id,
        technicianId: technicianProfileId,
        status: "sent",
      }).session(session);

      if (!fresh || (broadcast.version && fresh.version !== requestedVersion)) {
        await session.abortTransaction();
        return res.status(409).json({
          success: false,
          message: "This job offer has been updated. Please refresh and try again.",
          reason: "version_mismatch",
          requestedVersion,
          currentVersion: fresh?.version ?? broadcast.version,
        });
      }

      const live = await ServiceBooking.findById(id)
        .session(session)
        .select("bookingType scheduledAt location status autoCancelAt activeBroadcastVersion assignmentAttempts serviceId districtId cityZoneId technicianId");
      if (!live) {
        await session.abortTransaction();
        return res.status(404).json({ success: false, message: "Booking not found" });
      }
      if (live.technicianId || !["pending", "broadcasted"].includes(live.status)) {
        await session.abortTransaction();
        return res.status(409).json({
          success: false,
          message: "Too late! Booking already taken or closed.",
        });
      }

      const recheck = await checkTechnicianEligibility({
        technician: technicianProfileId,
        booking: live,
      });
      if (!recheck.eligible) {
        await session.abortTransaction();
        return res.status(403).json({
          success: false,
          message: "You are no longer eligible to accept this job.",
          reasons: recheck.reasons,
          details: recheck.details,
        });
      }

      // Fetch technician profile and user data for snapshot
      const technicianProfile = await TechnicianProfile.findById(technicianProfileId)
        .session(session)
        .select("userId location");

      if (!technicianProfile) {
        await session.abortTransaction();
        return res.status(404).json({ success: false, message: "Technician profile not found" });
      }

      const technicianUser = await User.findById(technicianProfile.userId)
        .session(session)
        .select("fname lname mobileNumber");

      if (!technicianUser) {
        await session.abortTransaction();
        return res.status(404).json({ success: false, message: "Technician user not found" });
      }

      const technicianSnapshot = {
        name: `${technicianUser.fname || ""} ${technicianUser.lname || ""}`.trim() || "Unknown",
        mobile: technicianUser.mobileNumber || "",
        deleted: false,
      };

      // Version-guarded broadcast flip FIRST: a re-broadcast that committed
      // after the Phase-A read misses this filter and loses deterministically.
      const flip = await JobBroadcast.updateOne(
        { bookingId: id, technicianId: technicianProfileId, status: "sent", version: fresh.version },
        { $set: { status: "accepted", respondedAt: new Date() } },
        { session }
      );
      if (flip.matchedCount === 0) {
        await session.abortTransaction();
        return res.status(409).json({
          success: false,
          message: "This job offer has been updated. Please refresh and try again.",
          reason: "version_mismatch",
          requestedVersion,
          currentVersion: fresh.version,
        });
      }

      const liveAttemptCount = Array.isArray(live.assignmentAttempts) ? live.assignmentAttempts.length : 0;

    // 🎯 ATOMIC CLAIM — the broadcast flip above already pinned the offered
    // version; this claim pins the unassigned booking. A miss means a
    // concurrent winner: conflict, no partial state changes (all in-txn).
    const acceptUpdate = {
      technicianId: technicianProfileId,
      status: "accepted",
      assignmentStatus: "assigned",
      assignedAt: new Date(),
      technicianSnapshot,
      $push: {
        assignmentAttempts: {
          technicianId: technicianProfileId,
          attemptNumber: (liveAttemptCount || 0) + 1,
          status: "assigned",
          acceptedAt: new Date(),
          feasibilitySnapshot: null,
        },
      },
      $inc: { version: 1 },
    };

    if (live.bookingType === "instant") {
      // Instant: technician must click On The Way within 30 minutes.
      acceptUpdate.autoCancelAt = new Date(Date.now() + 30 * 60 * 1000);
    }
    // Schedule: keep the slot-driven lifecycle (reminders, escalation).

    booking = await ServiceBooking.findOneAndUpdate(
      {
        _id: id,
        status: { $in: ["pending", "broadcasted"] },
        technicianId: null,
      },
      acceptUpdate,
      { new: true, session }
    ).populate("customerId").populate({
      path: "serviceId",
      populate: { path: "categoryId" }
    });

    if (!booking) {
      await session.abortTransaction();
      return res.status(409).json({ success: false, message: "Too late! Booking already taken" });
    }

    const otherBroadcasts = await JobBroadcast.find({
      bookingId: id,
      technicianId: { $ne: technicianProfileId },
      status: "sent"
    }).session(session).select("technicianId");
    otherTechIds = otherBroadcasts.map(b => b.technicianId.toString());

    await JobBroadcast.updateMany({ bookingId: id, technicianId: { $ne: technicianProfileId } }, { status: "expired" }, { session });

    // 🤝 Offer audit — accepted for this tech, superseded for everyone else (INSIDE transaction)
    const acceptedOffer = await TechnicianBookingOffer.findOneAndUpdate(
      { bookingId: id, technicianId: technicianProfileId },
      { $set: { decision: "accepted", respondedAt: new Date() } },
      { new: true, session }
    );
    if (acceptedOffer) {
      await TechnicianBookingOffer.updateOne(
        { _id: acceptedOffer._id },
        {
          $set: {
            responseLatencyMs: Date.now() - new Date(acceptedOffer.offeredAt).getTime(),
          },
        },
        { session }
      );
    }
    await TechnicianBookingOffer.updateMany(
      { bookingId: id, technicianId: { $ne: technicianProfileId }, decision: "offered" },
      { $set: { decision: "superseded" } },
      { session }
    );

    await session.commitTransaction();
    } catch (claimErr) {
      // B-09: a write/commit conflict here means a concurrent winner,
      // re-broadcast, or revocation-touching commit landed first. All writes
      // were in-transaction, so the abort leaves no partial state; surface a
      // retryable 409 (client retries the whole accept) instead of a 500.
      try {
        if (session.inTransaction()) await session.abortTransaction();
      } catch {
        /* already aborted */
      }
      const labels = claimErr?.errorLabels || [];
      const msg = String(claimErr?.message || "");
      const retryable =
        labels.includes("TransientTransactionError") ||
        labels.includes("UnknownTransactionCommitResult") ||
        claimErr?.code === 112 ||
        /WriteConflict|WriteConcern|wtimeout|transaction/i.test(msg);
      console.error("respondToJob claim error:", msg);
      return res.status(retryable ? 409 : 500).json({
        success: false,
        message: retryable ? "Too late! Booking already taken or updated. Please retry." : "Failed to accept job",
        ...(retryable ? { reason: "claim_conflict" } : {}),
      });
    }

    if (req.io) {
      if (booking.customerId) {
        notifyCustomerJobAccepted(req.io, booking.customerId._id, {
          bookingId: booking._id,
          technicianId: technicianProfileId,
          status: "accepted"
        });
      }
      if (otherTechIds.length > 0) notifyJobTaken(req.io, otherTechIds, booking._id);

      // Invalidate other technicians' job feed cursor (Fix #5):
      // their lastJobsChangeAt must now exceed our get_jobs cursor so the
      // requesting tech stops seeing this job. The NEW accepted tech's cursor
      // is not bumped — they instead move to the accepted phase queue.
      if (otherTechIds.length > 0) {
        await TechnicianProfile.updateMany(
          { _id: { $in: otherTechIds } },
          { $set: { lastJobsChangeAt: new Date() } }
        );
        // 🛰 Push: other techs' feed changed (anti-polling fix)
        otherTechIds.forEach((techId) => emitJobsChanged(req.io, techId));
      }
    }

    // Remove baseAmount and include technicianAmount from service
    const bookingData = booking.toObject ? booking.toObject() : booking;
    const { baseAmount, ...bookingWithoutBaseAmount } = bookingData;
    bookingWithoutBaseAmount.technicianAmount = bookingData.serviceId?.technicianAmount || bookingData.technicianAmount || 0;

    return res.status(200).json({ success: true, message: "Job accepted successfully", result: bookingWithoutBaseAmount });
  } catch (err) {
    try {
      if (session && session.inTransaction()) await session.abortTransaction();
    } catch {
      /* already aborted */
    }
    console.error("respondToJob Error:", err);
    return res.status(500).json({ success: false, message: err.message });
  } finally {
    // 🔓 Release the dispatch mutex (only if we still own it — a queued
    // request may have already re-acquired the lock).
    if (dispatchLockAt) {
      TechnicianProfile.updateOne(
        { _id: req.user?.technicianProfileId, dispatchLockUntil: dispatchLockAt },
        { $set: { dispatchLockUntil: new Date() } }
      ).catch(() => {});
    }
    try {
      session?.endSession();
    } catch {
      /* already ended */
    }
  }
};
