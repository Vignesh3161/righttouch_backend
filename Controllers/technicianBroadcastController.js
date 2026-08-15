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

const DISPATCH_LOCK_MS = 3000;

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
  const session = await mongoose.startSession();
  session.startTransaction();
  let dispatchLockAt = null;
  try {
    ensureTechnician(req);
    const { id } = req.params;
    const { status, response } = req.body;
    const finalStatus = (status || response || "").toLowerCase();
    const technicianProfileId = req.user.technicianProfileId;

    // 🛡 Activation gate — suspended/unapproved/KYC-incomplete technicians
    // must not accept jobs, even with a lingering "sent" broadcast record.
    const activation = await checkTechnicianActivation(technicianProfileId);
    if (!activation.isActive) {
      await session.abortTransaction();
      return res.status(403).json({
        success: false,
        message: activation.message,
      });
    }

    // 🔒 Per-technician dispatch mutex (self-expiring) — serializes
    // concurrent accept requests for the SAME technician (e.g. two
    // schedule accepts racing through different notification channels).
    // Auto-expires after 3s so a crashed handler can never deadlock the tech.
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
      await session.abortTransaction();
      return res.status(409).json({
        success: false,
        message: "Another request is being processed, please try again.",
      });
    }

    const activeJob = await ServiceBooking.findOne({
      technicianId: technicianProfileId,
      $or: [
        { status: { $in: ["on_the_way", "reached", "in_progress"] } },
        { status: { $in: ["accepted", "ACCEPTED"] }, bookingType: "instant" }
      ]
    }).session(session).select("_id status bookingType");

    if (activeJob) {
      await session.abortTransaction();
      const statusMsg = activeJob.status === "ACCEPTED" || activeJob.status === "accepted" 
        ? "start travel for your current job" 
        : "complete your current job";

      return res.status(409).json({
        success: false,
        message: `Please ${statusMsg} before accepting a new one.`,
      });
    }

    const broadcast = await JobBroadcast.findOne({
      bookingId: id,
      technicianId: technicianProfileId,
      status: { $in: ["sent"] },
    }).session(session);

    if (!broadcast) {
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: "Job not assigned to you or already closed" });
    }

    // ⏱ Offer must still be unexpired — a re-broadcasted job's old offer is dead.
    if (broadcast.expiresAt && new Date(broadcast.expiresAt).getTime() < Date.now()) {
      await session.abortTransaction();
      return res.status(410).json({
        success: false,
        message: "This job offer has expired. Pull to refresh your job list.",
      });
    }

    if (finalStatus !== "accepted" && finalStatus !== "accept") {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: "Invalid response status" });
    }

    // 📡 Version the technician is claiming — client may pass the DTO's
    // broadcast version; otherwise use the broadcast row's version.
    const requestedVersion =
      Number.isInteger(req.body?.version) && req.body.version > 0
        ? req.body.version
        : broadcast.version || 1;

    // ⏱ Candidate booking snapshot (pre-claim, same transaction)
    const candidate = await ServiceBooking.findById(id)
      .session(session)
      .select("bookingType scheduledAt location status autoCancelAt activeBroadcastVersion assignmentAttempts");
    if (!candidate) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: "Booking not found" });
    }

    const bookingAttemptCount = Array.isArray(candidate.assignmentAttempts)
      ? candidate.assignmentAttempts.length
      : 0;

    // ⏱ The claim must reference the current broadcast cycle.
    if ((candidate.activeBroadcastVersion || 1) !== requestedVersion) {
      await session.abortTransaction();
      return res.status(409).json({
        success: false,
        message: "This job was updated. Please refresh and try again.",
      });
    }

    // ⏱ Accept-time feasibility re-check — the offer-time snapshot is stale
    // by the time the tech taps accept (queue/location may have changed).
    //   instant candidate + pending scheduled appointment → travel chain check
    //   schedule candidate                        → window overlap check
    const [techQueueMap, techProfileForCheck] = await Promise.all([
      loadCommittedQueues([technicianProfileId]),
      TechnicianProfile.findById(technicianProfileId)
        .session(session)
        .select("location"),
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
            await session.abortTransaction();
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
              await session.abortTransaction();
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
      const feasibility = evaluateJobFeasibility({
        techLocation: techProfileForCheck?.location || null,
        candidateJob: candidate,
        queue: techQueue,
      });
      if (!feasibility.feasible) {
        await session.abortTransaction();
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

    // 🎯 ATOMIC CLAIM — status in [pending, broadcasted], technicianId null,
    // and the exact broadcast version the technician was offered. If the claim
    // fails, the booking was taken or re-broadcast concurrently: conflict, no
    // partial state changes.
    const acceptUpdate = {
      technicianId: technicianProfileId,
      status: "accepted",
      assignmentStatus: "assigned",
      assignedAt: new Date(),
      technicianSnapshot,
      $push: {
        assignmentAttempts: {
          technicianId: technicianProfileId,
          attemptNumber: (bookingAttemptCount || 0) + 1,
          status: "assigned",
          acceptedAt: new Date(),
          feasibilitySnapshot: null,
        },
      },
      $inc: { version: 1 },
    };

    if (candidate.bookingType === "instant") {
      // Instant: technician must click On The Way within 30 minutes.
      acceptUpdate.autoCancelAt = new Date(Date.now() + 30 * 60 * 1000);
    }
    // Schedule: keep the slot-driven lifecycle (reminders, escalation).

    const booking = await ServiceBooking.findOneAndUpdate(
      {
        _id: id,
        status: { $in: ["pending", "broadcasted"] },
        technicianId: null,
        activeBroadcastVersion: requestedVersion,
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

    await JobBroadcast.updateOne({ bookingId: id, technicianId: technicianProfileId }, { status: "accepted" }, { session });

    const otherBroadcasts = await JobBroadcast.find({
      bookingId: id,
      technicianId: { $ne: technicianProfileId },
      status: "sent"
    }).session(session).select("technicianId");
    const otherTechIds = otherBroadcasts.map(b => b.technicianId.toString());

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
    if (session.inTransaction()) await session.abortTransaction();
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
    session.endSession();
  }
};
