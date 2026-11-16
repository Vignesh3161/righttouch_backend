import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";

process.env.COMPLETION_OTP_PEPPER = "test-completion-otp-pepper";
process.env.COMPLETION_OTP_SEND_COOLDOWN_MS = "0";
process.env.FAST2SMS_API_KEY = "test-fast2sms-key";

let replSet;
let User;
let ServiceBooking;
let TechnicianProfile;
let TechnicianKyc;
let Payment;
let ServiceCompletionChallenge;
let completionService;
let completionOtp;
let paymentController;
let technicianController;
let paymentReadModel;
let servicePaymentEligibility;

const makeRes = () => {
  const res = {};
  res.statusCode = null;
  res.body = null;
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body) => {
    res.body = body;
    return res;
  };
  return res;
};

let phoneSeq = 0;
const nextPhone = () => String(9000000000 + ++phoneSeq);

const createTechnician = async () => {
  const technicianUser = await User.create({ role: "Technician", mobileNumber: nextPhone() });
  const profile = await TechnicianProfile.create({
    userId: technicianUser._id,
    profileComplete: true,
    workStatus: "approved",
    trainingCompleted: true,
  });
  await TechnicianKyc.create({
    technicianId: profile._id,
    verificationStatus: "approved",
    kycVerified: true,
    bankVerified: true,
    bankVerificationStatus: "approved",
  });
  return { technicianUser, profile };
};

const createBooking = async ({ status = "in_progress" } = {}) => {
  const customer = await User.create({ role: "Customer", mobileNumber: nextPhone() });
  const { technicianUser, profile } = await createTechnician();

  const booking = await ServiceBooking.create({
    customerId: customer._id,
    technicianId: profile._id,
    serviceId: new mongoose.Types.ObjectId(),
    status,
    bookingType: "instant",
    assignmentStatus: "assigned",
    locationType: "saved",
    address: "1 Test Street",
    baseAmount: 100,
    totalAmount: 100,
    paymentStatus: "pending",
    financialSnapshot: {
      baseAmountPaise: 10000,
      totalAmountPaise: 10000,
      commissionPercentage: 10,
      commissionAmountPaise: 1000,
      technicianAmountPaise: 9000,
      calculationVersion: 1,
    },
  });

  return { booking, customer, technicianUser, profile };
};

const payOnline = async (booking) => {
  const payment = await Payment.create({
    bookingId: booking._id,
    itemType: "service",
    paymentType: "SERVICE",
    provider: "razorpay",
    mode: "online",
    status: "success",
    providerPaymentId: `pay_${booking._id}`,
    totalAmountPaise: 10000,
    grossTotalAmountPaise: 10000,
    baseAmountPaise: 10000,
  });
  await ServiceBooking.updateOne(
    { _id: booking._id },
    { $set: { paymentStatus: "paid", paymentId: payment._id } }
  );
  return payment;
};

before(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replSet.getUri(), { directConnection: true });

  ({ default: User } = await import("../Schemas/User.js"));
  ({ default: ServiceBooking } = await import("../Schemas/ServiceBooking.js"));
  ({ default: TechnicianProfile } = await import("../Schemas/TechnicianProfile.js"));
  ({ default: TechnicianKyc } = await import("../Schemas/TechnicianKYC.js"));
  ({ default: Payment } = await import("../Schemas/Payment.js"));
  ({ default: ServiceCompletionChallenge } = await import("../Schemas/ServiceCompletionChallenge.js"));
  completionService = await import("../Services/completionVerificationService.js");
  completionOtp = await import("../Utils/completionOtp.js");
  paymentController = await import("../Controllers/paymentController.js");
  technicianController = await import("../Controllers/technician.js");
  paymentReadModel = await import("../Utils/paymentReadModel.js");
  servicePaymentEligibility = await import("../Utils/servicePaymentEligibility.js");
});

after(async () => {
  await mongoose.disconnect();
  await replSet.stop();
});

beforeEach(async () => {
  const collections = await mongoose.connection.db.collections();
  await Promise.all(collections.map((collection) => collection.deleteMany({})));
});

test("requesting completion sets the payment-due marker without sending an OTP", async () => {
  const { booking, profile } = await createBooking();
  const sent = [];
  const notifications = [];

  const result = await completionService.requestCompletionOtp({
    bookingId: booking._id,
    technicianProfileId: profile._id,
    smsSender: async (_phone, otp) => sent.push(otp),
    notifier: async (payload) => notifications.push(payload),
  });

  assert.equal(result.paymentRequired, true);
  assert.equal(result.verificationStatus, "awaiting_payment");
  assert.equal(sent.length, 0);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].type, "PAYMENT_DUE");
  assert.equal(notifications[0].recipientType, "customer");

  const marked = await ServiceBooking.findById(booking._id).lean();
  assert.ok(marked.completionOtpRequestedAt instanceof Date);
  assert.equal(await ServiceCompletionChallenge.countDocuments({ bookingId: booking._id }), 0);
});

test("verification is rejected before payment and does not consume attempts", async () => {
  const { booking, profile } = await createBooking();
  await completionService.requestCompletionOtp({
    bookingId: booking._id,
    technicianProfileId: profile._id,
    smsSender: async () => {},
    notifier: async () => {},
  });

  await assert.rejects(
    () =>
      completionService.verifyCompletionOtp({
        bookingId: booking._id,
        technicianProfileId: profile._id,
        otp: "",
      }),
    (err) => err.code === "PAYMENT_REQUIRED" && err.statusCode === 409
  );

  assert.equal(await ServiceCompletionChallenge.countDocuments({ bookingId: booking._id }), 0);
  const unchanged = await ServiceBooking.findById(booking._id).lean();
  assert.equal(unchanged.status, "in_progress");
  assert.equal(unchanged.paymentStatus, "pending");
});

test("payment success issues the OTP and verification completes the booking", async () => {
  const { booking, profile } = await createBooking();
  const notifications = [];
  const sent = [];

  await completionService.requestCompletionOtp({
    bookingId: booking._id,
    technicianProfileId: profile._id,
    smsSender: async (_phone, otp) => sent.push(otp),
    notifier: async (payload) => notifications.push(payload),
  });

  await payOnline(booking);
  const issued = await completionService.issueCompletionOtpForPaidBooking({
    bookingId: booking._id,
    smsSender: async (_phone, otp) => sent.push(otp),
    notifier: async (payload) => notifications.push(payload),
  });

  assert.equal(issued.verificationStatus, "pending");
  assert.equal(sent.length, 1);
  assert.ok(notifications.some((n) => n.type === "COMPLETION_OTP_SENT"));

  const verified = await completionService.verifyCompletionOtp({
    bookingId: booking._id,
    technicianProfileId: profile._id,
    otp: sent[0],
  });

  assert.equal(verified.booking.status, "completed");
  assert.equal(verified.booking.paymentStatus, "paid");

  const status = await completionService.getCompletionStatus({
    bookingId: booking._id,
    technicianProfileId: profile._id,
  });
  assert.equal(status.verificationStatus, "verified");
  assert.equal(status.requiresCompletionOtp, false);
  assert.equal(status.paymentDue, false);
});

test("resend after payment rotates the OTP and only the new code works", async () => {
  const { booking, profile } = await createBooking();
  const sent = [];

  await completionService.requestCompletionOtp({
    bookingId: booking._id,
    technicianProfileId: profile._id,
    smsSender: async (_phone, otp) => sent.push(otp),
    notifier: async () => {},
  });
  await payOnline(booking);
  await completionService.issueCompletionOtpForPaidBooking({
    bookingId: booking._id,
    smsSender: async (_phone, otp) => sent.push(otp),
    notifier: async () => {},
  });
  await completionService.resendCompletionOtp({
    bookingId: booking._id,
    technicianProfileId: profile._id,
    smsSender: async (_phone, otp) => sent.push(otp),
    notifier: async () => {},
  });

  assert.equal(sent.length, 2);
  assert.notEqual(sent[0], sent[1]);

  await assert.rejects(
    () =>
      completionService.verifyCompletionOtp({
        bookingId: booking._id,
        technicianProfileId: profile._id,
        otp: sent[0],
      }),
    (err) => err.code === "INVALID"
  );

  const verified = await completionService.verifyCompletionOtp({
    bookingId: booking._id,
    technicianProfileId: profile._id,
    otp: sent[1],
  });
  assert.equal(verified.booking.status, "completed");
});

test("service payment order is rejected until the technician requests completion", async () => {
  const { booking, customer } = await createBooking();
  const res = makeRes();

  await paymentController.createPaymentOrder(
    {
      user: { role: "Customer", userId: customer._id.toString() },
      body: { bookingId: booking._id.toString() },
    },
    res
  );

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.result.code, "PAYMENT_NOT_DUE");

  const marked = await ServiceBooking.findByIdAndUpdate(
    booking._id,
    { $set: { completionOtpRequestedAt: new Date() } },
    { new: true }
  ).lean();
  assert.equal(servicePaymentEligibility.isServicePaymentEligible(marked), true);
  assert.equal(paymentReadModel.isBookingPayable({ ...marked, itemType: "service" }), true);
});

test("technician self-update cannot change training", async () => {
  const { booking, profile, technicianUser } = await createBooking();
  await TechnicianProfile.updateOne(
    { _id: profile._id },
    { $set: { "availability.isOnline": true } }
  );
  const res = makeRes();

  await technicianController.updateTechnician(
    {
      user: {
        role: "Technician",
        userId: technicianUser._id.toString(),
        technicianProfileId: profile._id.toString(),
      },
      body: { trainingCompleted: false },
    },
    res
  );

  assert.equal(res.statusCode, 200);
  const saved = await TechnicianProfile.findById(profile._id).lean();
  assert.equal(saved.trainingCompleted, true);
  assert.equal(saved.availability?.isOnline, true);
  assert.equal(booking.status, "in_progress");
});
