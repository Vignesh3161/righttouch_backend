import TechnicianProfile from "../Schemas/TechnicianProfile.js";
import TechnicianKyc from "../Schemas/TechnicianKYC.js";

/**
 * Single source of truth for "can this technician work?" — used by
 * job acceptance (respondToJob), status updates (updateBookingStatus),
 * and job feeds. All gates must pass:
 *   1. Profile complete
 *   2. workStatus = approved
 *   3. KYC verification approved
 *   4. Bank account verified
 *   5. Training completed
 */
export const checkTechnicianActivation = async (technicianProfileId) => {
  try {
    const profile = await TechnicianProfile.findById(technicianProfileId)
      .select("workStatus trainingCompleted profileComplete")
      .lean();

    if (!profile) return { isActive: false, message: "Technician profile not found" };

    if (!profile.profileComplete) {
      return { isActive: false, message: "Please complete your profile details to start receiving jobs." };
    }
    if (profile.workStatus !== "approved") {
      return { isActive: false, message: `Your account status is '${profile.workStatus}'. Please wait for admin approval.` };
    }
    if (!profile.trainingCompleted) {
      return { isActive: false, message: "You must complete the mandatory training before you can accept jobs." };
    }

    const kyc = await TechnicianKyc.findOne({ technicianId: technicianProfileId })
      .select("verificationStatus bankVerified kycVerified")
      .lean();

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
