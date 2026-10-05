import mongoose from "mongoose";
import TechnicianProfile from "../models/TechnicianProfile.js";
import TechnicianKyc from "../models/TechnicianKYC.js";
import { getKycSubmitState } from "./bankKycStatus.js";

export const getTechnicianJobEligibility = async ({ technicianProfileId, session } = {}) => {
  if (!technicianProfileId || !mongoose.Types.ObjectId.isValid(technicianProfileId)) {
    return {
      eligible: false,
      reasons: ["invalid_profileId"],
      status: {
        profileComplete: false,
        workStatus: null,
        isOnline: false,
        kycStatus: "not_submitted",
      },
    };
  }

  let techQuery = TechnicianProfile.findById(technicianProfileId).select(
    "profileComplete workStatus trainingCompleted availability"
  );
  if (session) techQuery = techQuery.session(session);
  const tech = await techQuery;

  if (!tech) {
    return {
      eligible: false,
      reasons: ["technician_not_found"],
      status: {
        profileComplete: false,
        workStatus: null,
        isOnline: false,
        kycStatus: "not_submitted",
      },
    };
  }

  let kycQuery = TechnicianKyc.findOne({ technicianId: technicianProfileId }).select(
    "verificationStatus"
  );
  if (session) kycQuery = kycQuery.session(session);
  const kyc = await kycQuery;

  const status = {
    profileComplete: Boolean(tech.profileComplete),
    workStatus: tech.workStatus || null,
    isOnline: Boolean(tech.availability?.isOnline),
    // P4: canonical submit-state (verbatim: stored status, else "not_submitted").
    kycStatus: getKycSubmitState(kyc),
  };

  const reasons = [];
  if (!status.profileComplete) reasons.push("profile_incomplete");
  if (status.kycStatus !== "approved") reasons.push("kyc_not_approved");
  if (status.workStatus !== "approved") reasons.push("workStatus_not_approved");
  if (!status.isOnline) reasons.push("offline");

  return {
    eligible: reasons.length === 0,
    reasons,
    status,
  };
};

