import mongoose from "mongoose";
import JobBroadcast from "../Schemas/TechnicianBroadcast.js";
import ServiceBooking from "../Schemas/ServiceBooking.js";
import TechnicianKyc from "../Schemas/TechnicianKYC.js";
import TechnicianProfile from "../Schemas/TechnicianProfile.js";
import User from "../Schemas/User.js";
import { notifyCustomerJobAccepted, notifyJobTaken } from "../Utils/sendNotification.js";
import { fetchTechnicianJobsInternal } from "../Utils/technicianJobFetch.js";
import { ensureTechnician } from "../Utils/ensureTechnician.js";

/* ================= TECHNICIAN ACTIVATION CHECK ================= */
const checkTechnicianActivation = async (technicianProfileId) => {
  try {
    const profile = await TechnicianProfile.findById(technicianProfileId).select("workStatus trainingCompleted profileComplete");
    
    if (!profile) return { isActive: false, message: "Technician profile not found" };

    if (!profile.profileComplete) return { isActive: false, message: "Please complete your profile details to start receiving jobs." };
    if (profile.workStatus !== "approved") return { isActive: false, message: `Your account status is '${profile.workStatus}'. Please wait for admin approval.` };
    if (!profile.trainingCompleted) return { isActive: false, message: "You must complete the mandatory training before you can accept jobs." };

    const kyc = await TechnicianKyc.findOne({ technicianId: technicianProfileId }).select("verificationStatus bankVerified kycVerified");

    if (!kyc || (kyc.verificationStatus !== "approved" && !kyc.kycVerified)) {
      return { isActive: false, message: "KYC verification is pending. Please check your document status." };
    }

    if (!kyc.bankVerified) {
      return { isActive: false, message: "Bank account verification is required for job payouts." };
    }

    return { isActive: true, message: "Technician account is active" };
  } catch (error) {
    return { isActive: false, message: `Activation check failed: ${error.message}` };
  }
};

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
  try {
    ensureTechnician(req);
    const { id } = req.params;
    const { status, response } = req.body;
    const finalStatus = (status || response || "").toLowerCase();
    const technicianProfileId = req.user.technicianProfileId;

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

    if (finalStatus !== "accepted" && finalStatus !== "accept") {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: "Invalid response status" });
    }

    // Fetch technician profile and user data for snapshot
    const technicianProfile = await TechnicianProfile.findById(technicianProfileId)
      .session(session)
      .select("userId");

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

    const booking = await ServiceBooking.findOneAndUpdate(
      { _id: id, status: { $in: ["pending", "SEARCHING", "requested", "broadcasted"] }, technicianId: null },
      {
        technicianId: technicianProfileId,
        status: "ACCEPTED",
        assignedAt: new Date(),
        autoCancelAt: new Date(Date.now() + 30 * 60 * 1000), // 30 min window to click "On the Way"
        technicianSnapshot
      },
      { new: true, session }
    ).populate("customerId").populate({
      path: "serviceId",
      populate: { path: "categoryId" }
    });

    if (!booking) {
      await session.abortTransaction();
      return res.status(409).json({ success: false, message: "Too late! Booking already taken" });
    }

    await JobBroadcast.updateOne({ bookingId: id, technicianId: technicianProfileId }, { status: "ACCEPTED" }, { session });

    const otherBroadcasts = await JobBroadcast.find({
      bookingId: id,
      technicianId: { $ne: technicianProfileId },
      status: "sent"
    }).session(session).select("technicianId");
    const otherTechIds = otherBroadcasts.map(b => b.technicianId.toString());

    await JobBroadcast.updateMany({ bookingId: id, technicianId: { $ne: technicianProfileId } }, { status: "expired" }, { session });

    await session.commitTransaction();

    if (req.io) {
      if (booking.customerId) {
        notifyCustomerJobAccepted(req.io, booking.customerId._id, {
          bookingId: booking._id,
          technicianId: technicianProfileId,
          status: "ACCEPTED"
        });
      }
      if (otherTechIds.length > 0) notifyJobTaken(req.io, otherTechIds, booking._id);
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
    session.endSession();
  }
};
