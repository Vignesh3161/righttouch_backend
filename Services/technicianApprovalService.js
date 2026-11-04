import mongoose from "mongoose";
import TechnicianProfile from "../Schemas/TechnicianProfile.js";
import TechnicianKyc from "../Schemas/TechnicianKYC.js";

const fail = (code, message, statusCode = 400) => {
  const err = new Error(message);
  err.code = code;
  err.statusCode = statusCode;
  throw err;
};

export const assertTechnicianActivationPrerequisites = async (
  technicianId,
  { trainingCompleted } = {}
) => {
  if (!technicianId || !mongoose.Types.ObjectId.isValid(technicianId)) {
    fail("INVALID_TECHNICIAN_ID", "Invalid Technician ID");
  }

  const profile = await TechnicianProfile.findById(technicianId)
    .select("trainingCompleted workStatus")
    .lean();
  if (!profile) fail("TECHNICIAN_NOT_FOUND", "Technician not found", 404);

  const effectiveTraining =
    trainingCompleted === undefined
      ? profile.trainingCompleted === true
      : Boolean(trainingCompleted);
  if (!effectiveTraining) {
    fail("TRAINING_REQUIRED", "Technician must complete training before approval");
  }

  const kyc = await TechnicianKyc.findOne({ technicianId })
    .select("verificationStatus kycVerified")
    .lean();
  if (!kyc || (kyc.verificationStatus !== "approved" && kyc.kycVerified !== true)) {
    fail("KYC_NOT_APPROVED", "KYC must be approved before technician approval");
  }

  return { profile, kyc };
};
