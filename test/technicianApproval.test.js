import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import TechnicianProfile from "../Schemas/TechnicianProfile.js";
import TechnicianKyc from "../Schemas/TechnicianKYC.js";
import OperationalCity from "../Schemas/OperationalCity.js";
import CityZone from "../Schemas/CityZone.js";
import TechnicianDistrictPermission from "../Schemas/TechnicianDistrictPermission.js";
import {
  ensureApprovedDistrictZones,
  getAllowedDistrictsForTechnician,
  addDistrictPermission,
  toggleDistrictPermission,
  removeDistrictPermission,
} from "../Services/technicianDistrictService.js";
import { assertTechnicianActivationPrerequisites } from "../Services/technicianApprovalService.js";
import { verifyTechnicianKyc } from "../Controllers/technicianKycController.js";
import { updateTechnicianStatus, updateTechnicianTraining } from "../Controllers/technician.js";

let mongod;

const makeResponse = () => ({
  statusCode: 200,
  body: null,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(payload) {
    this.body = payload;
    return this;
  },
});

const polygon = {
  type: "Polygon",
  coordinates: [
    [
      [77.0, 11.0],
      [77.1, 11.0],
      [77.1, 11.1],
      [77.0, 11.1],
      [77.0, 11.0],
    ],
  ],
};

const createDistrict = (overrides = {}) =>
  OperationalCity.create({
    name: "Test District",
    city: "Test City",
    state: "Tamil Nadu",
    polygon,
    active: true,
    isJobEnabled: true,
    ...overrides,
  });

const createZone = (districtId, overrides = {}) =>
  CityZone.create({
    operationalCityId: districtId,
    name: "Test Zone",
    zoneCode: `Z-${new mongoose.Types.ObjectId().toString().slice(-8).toUpperCase()}`,
    polygon,
    active: true,
    ...overrides,
  });

const createProfile = (overrides = {}) =>
  TechnicianProfile.create({
    userId: new mongoose.Types.ObjectId(),
    trainingCompleted: true,
    workStatus: "trained",
    ...overrides,
  });

const createKyc = (technicianId, overrides = {}) =>
  TechnicianKyc.create({
    technicianId,
    aadhaarNumber: "123412341234",
    panNumber: "ABCDE1234F",
    drivingLicenseNumber: "DL-1234567890",
    documents: {
      aadhaarUrl: ["https://res.cloudinary.com/demo/aadhaar.jpg"],
      panUrl: ["https://res.cloudinary.com/demo/pan.jpg"],
      dlUrl: ["https://res.cloudinary.com/demo/dl.jpg"],
    },
    verificationStatus: "pending",
    kycVerified: false,
    ...overrides,
  });

const adminRequest = (body, role = "Owner") => ({
  body,
  user: { userId: new mongoose.Types.ObjectId(), role },
});

const trainingRequest = (profile, role) => ({
  params: { technicianId: String(profile._id) },
  body: { trainingCompleted: true },
  user: { userId: new mongoose.Types.ObjectId(), role },
});

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
});

after(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

beforeEach(async () => {
  await Promise.all([
    TechnicianProfile.deleteMany({}),
    TechnicianKyc.deleteMany({}),
    OperationalCity.deleteMany({}),
    CityZone.deleteMany({}),
    TechnicianDistrictPermission.deleteMany({}),
  ]);
});

test("KYC approval does not require training or a district and does not activate the technician", async () => {
  const profile = await createProfile({ trainingCompleted: false, workStatus: "pending" });
  await createKyc(profile._id);

  const res = makeResponse();
  await verifyTechnicianKyc(
    adminRequest({ technicianId: String(profile._id), status: "approved" }),
    res
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.result.verificationStatus, "approved");
  assert.equal(res.body.result.workStatus, "pending");
  assert.equal(res.body.result.nextStep, "training");

  const saved = await TechnicianProfile.findById(profile._id).lean();
  assert.equal(saved.workStatus, "pending");
});

test("KYC rejection only suspends an already-approved technician", async () => {
  const approved = await createProfile({ workStatus: "approved" });
  await createKyc(approved._id, { verificationStatus: "approved", kycVerified: true });

  const pending = await createProfile({ workStatus: "trained" });
  await createKyc(pending._id, { verificationStatus: "approved", kycVerified: true });

  const approvedRes = makeResponse();
  await verifyTechnicianKyc(
    adminRequest({
      technicianId: String(approved._id),
      status: "rejected",
      rejectionReason: "Documents unclear",
    }),
    approvedRes
  );

  const pendingRes = makeResponse();
  await verifyTechnicianKyc(
    adminRequest({
      technicianId: String(pending._id),
      status: "rejected",
      rejectionReason: "Documents unclear",
    }),
    pendingRes
  );

  assert.equal(approvedRes.statusCode, 200);
  assert.equal(pendingRes.statusCode, 200);
  assert.equal((await TechnicianProfile.findById(approved._id).lean()).workStatus, "suspended");
  assert.equal((await TechnicianProfile.findById(pending._id).lean()).workStatus, "trained");
});

test("activation prerequisites require KYC approval and completed training", async () => {
  const noKyc = await createProfile({ trainingCompleted: true });
  await assert.rejects(
    () => assertTechnicianActivationPrerequisites(noKyc._id),
    (err) => err.code === "KYC_NOT_APPROVED"
  );

  const noTraining = await createProfile({ trainingCompleted: false });
  await createKyc(noTraining._id, { verificationStatus: "approved", kycVerified: true });
  await assert.rejects(
    () => assertTechnicianActivationPrerequisites(noTraining._id),
    (err) => err.code === "TRAINING_REQUIRED"
  );

  const ready = await createProfile({ trainingCompleted: true });
  await createKyc(ready._id, { verificationStatus: "approved", kycVerified: true });
  const result = await assertTechnicianActivationPrerequisites(ready._id);
  assert.equal(String(result.kyc.verificationStatus), "approved");
});

test("ensureApprovedDistrictZones adopts an enabled permission row", async () => {
  const district = await createDistrict();
  await createZone(district._id);
  const profile = await createProfile();
  await TechnicianDistrictPermission.create({
    technicianId: profile._id,
    districtId: district._id,
    permissionType: "ADDITIONAL",
    isEnabled: true,
  });

  const result = await ensureApprovedDistrictZones({
    technicianId: profile._id,
    adminUserId: new mongoose.Types.ObjectId(),
    reason: "test",
  });

  assert.equal(result.districtId, String(district._id));
  const saved = await TechnicianProfile.findById(profile._id).lean();
  assert.equal(String(saved.primaryDistrictId), String(district._id));
  assert.deepEqual(saved.allowedCityIds.map(String), [String(district._id)]);
  assert.deepEqual(saved.enabledDistrictIds.map(String), [String(district._id)]);
  assert.ok(saved.enabledCityZoneIds.length > 0);

  const permission = await TechnicianDistrictPermission.findOne({
    technicianId: profile._id,
    districtId: district._id,
  }).lean();
  assert.equal(permission.permissionType, "ADDITIONAL");
});

test("ensureApprovedDistrictZones never auto-grants district coverage", async () => {
  const district = await createDistrict();
  await createZone(district._id);
  const profile = await createProfile({ currentDistrictId: district._id });

  const result = await ensureApprovedDistrictZones({
    technicianId: profile._id,
    adminUserId: new mongoose.Types.ObjectId(),
    reason: "test",
  });

  assert.equal(result.districtId, String(district._id));
  const saved = await TechnicianProfile.findById(profile._id).lean();
  assert.equal(String(saved.primaryDistrictId), String(district._id));
  assert.deepEqual(saved.allowedCityIds.map(String), []);
  assert.deepEqual(saved.enabledDistrictIds.map(String), []);
  assert.deepEqual(saved.enabledCityZoneIds.map(String), []);

  const permissionCount = await TechnicianDistrictPermission.countDocuments({
    technicianId: profile._id,
  });
  assert.equal(permissionCount, 0);

  const allowed = await getAllowedDistrictsForTechnician(profile._id);
  assert.deepEqual(allowed, []);
});

test("primary district can be granted, toggled, and revoked explicitly", async () => {
  const district = await createDistrict();
  await createZone(district._id);
  const profile = await createProfile({ primaryCityId: district._id, primaryDistrictId: district._id });
  const adminUserId = new mongoose.Types.ObjectId();

  await addDistrictPermission({
    technicianId: profile._id,
    districtId: district._id,
    adminUserId,
    adminRole: "Owner",
  });

  const grant = await TechnicianDistrictPermission.findOne({
    technicianId: profile._id,
    districtId: district._id,
  }).lean();
  assert.equal(grant.permissionType, "ADDITIONAL");
  assert.equal(grant.isEnabled, true);
  assert.deepEqual(await getAllowedDistrictsForTechnician(profile._id), [String(district._id)]);

  await toggleDistrictPermission({
    technicianId: profile._id,
    districtId: district._id,
    isEnabled: false,
    adminUserId,
    adminRole: "Owner",
  });
  assert.deepEqual(await getAllowedDistrictsForTechnician(profile._id), []);

  await toggleDistrictPermission({
    technicianId: profile._id,
    districtId: district._id,
    isEnabled: true,
    adminUserId,
    adminRole: "Owner",
  });
  assert.deepEqual(await getAllowedDistrictsForTechnician(profile._id), [String(district._id)]);

  await removeDistrictPermission({
    technicianId: profile._id,
    districtId: district._id,
    adminUserId,
    adminRole: "Owner",
  });
  assert.deepEqual(await getAllowedDistrictsForTechnician(profile._id), []);

  const saved = await TechnicianProfile.findById(profile._id).lean();
  assert.equal(String(saved.primaryDistrictId), String(district._id));
});

test("ensureApprovedDistrictZones falls back to the live GPS district", async () => {
  const district = await createDistrict();
  await createZone(district._id);
  const profile = await createProfile({ currentDistrictId: district._id });

  const result = await ensureApprovedDistrictZones({
    technicianId: profile._id,
    adminUserId: new mongoose.Types.ObjectId(),
    reason: "test",
  });

  assert.equal(result.districtId, String(district._id));
  const saved = await TechnicianProfile.findById(profile._id).lean();
  assert.equal(String(saved.primaryDistrictId), String(district._id));
});

test("ensureApprovedDistrictZones still rejects a district without active zones", async () => {
  const district = await createDistrict();
  const profile = await createProfile({ currentDistrictId: district._id });

  await assert.rejects(
    () =>
      ensureApprovedDistrictZones({
        technicianId: profile._id,
        adminUserId: new mongoose.Types.ObjectId(),
        reason: "test",
      }),
    (err) => err.code === "NO_ACTIVE_ZONES"
  );
});

test("final approval requires KYC, training, and a working district", async () => {
  const district = await createDistrict();
  const zone = await createZone(district._id);
  const profile = await createProfile({ trainingCompleted: true });
  await createKyc(profile._id, { verificationStatus: "approved", kycVerified: true });
  await TechnicianDistrictPermission.create({
    technicianId: profile._id,
    districtId: district._id,
    permissionType: "ADDITIONAL",
    isEnabled: true,
  });

  const res = makeResponse();
  await updateTechnicianStatus(
    adminRequest({ technicianId: String(profile._id), workStatus: "approved" }),
    res
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.result.workStatus, "approved");
  assert.ok(res.body.result.approvedAt);

  const saved = await TechnicianProfile.findById(profile._id).lean();
  assert.equal(saved.workStatus, "approved");
  assert.equal(String(saved.primaryDistrictId), String(district._id));
  assert.deepEqual(saved.enabledCityZoneIds.map(String), [String(zone._id)]);
});

test("Admin and Owner can approve training while technicians cannot", async () => {
  const adminProfile = await createProfile({ trainingCompleted: false, workStatus: "pending" });
  const ownerProfile = await createProfile({ trainingCompleted: false, workStatus: "pending" });
  const technicianProfile = await createProfile({ trainingCompleted: false, workStatus: "pending" });

  const adminRes = makeResponse();
  await updateTechnicianTraining(trainingRequest(adminProfile, "Admin"), adminRes);
  assert.equal(adminRes.statusCode, 200);
  assert.equal((await TechnicianProfile.findById(adminProfile._id).lean()).workStatus, "trained");

  const ownerRes = makeResponse();
  await updateTechnicianTraining(trainingRequest(ownerProfile, "Owner"), ownerRes);
  assert.equal(ownerRes.statusCode, 200);

  const technicianRes = makeResponse();
  await updateTechnicianTraining(trainingRequest(technicianProfile, "Technician"), technicianRes);
  assert.equal(technicianRes.statusCode, 403);
  assert.equal(technicianRes.body.message, "Admin or Owner access only");

  const saved = await TechnicianProfile.findById(technicianProfile._id).lean();
  assert.equal(saved.trainingCompleted, false);
  assert.equal(saved.workStatus, "pending");
});

test("final approval rejects missing KYC", async () => {
  const district = await createDistrict();
  await createZone(district._id);
  const profile = await createProfile({ trainingCompleted: true, currentDistrictId: district._id });

  const res = makeResponse();
  await updateTechnicianStatus(
    adminRequest({ technicianId: String(profile._id), workStatus: "approved" }),
    res
  );

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, "KYC_NOT_APPROVED");
});

test("final approval rejects missing training", async () => {
  const district = await createDistrict();
  await createZone(district._id);
  const profile = await createProfile({ trainingCompleted: false, currentDistrictId: district._id });
  await createKyc(profile._id, { verificationStatus: "approved", kycVerified: true });

  const res = makeResponse();
  await updateTechnicianStatus(
    adminRequest({ technicianId: String(profile._id), workStatus: "approved" }),
    res
  );

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, "TRAINING_REQUIRED");
});
