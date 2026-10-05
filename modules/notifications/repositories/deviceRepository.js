/**
 * P3 — DeviceToken repository (notifications-owned persistence seam).
 *
 * Covers DeviceToken persistence plus the existing legacy User/
 * TechnicianProfile `fcmTokens` mirror writes, exactly as the current
 * service performs them (dual-write compat; mirror removal is P7).
 * Role branching and return values stay in the service; this file owns
 * query shapes only. Device-token endpoints are unchanged (Task 7).
 */
import DeviceToken from "../models/DeviceToken.js";
import { addFcmMirror as addUserMirror, pullFcmMirror as pullUserMirror } from "../../identity/repositories/userRepository.js";
import { addFcmMirror as addProfileMirror, pullFcmMirror as pullProfileMirror } from "../../identity/repositories/profileRepository.js";

export const upsertDeviceToken = ({ userId, normRole, deviceId, platform, fcmToken, appVersion }) =>
  DeviceToken.findOneAndUpdate(
    { userId, deviceId },
    {
      $set: {
        role: normRole,
        fcmToken,
        isActive: true,
        platform: platform ? String(platform).toLowerCase() : undefined,
        appVersion: appVersion || undefined,
        lastSeenAt: new Date(),
      },
    },
    { upsert: true, setDefaultsOnInsert: true }
  );

export const findActiveByUserDevice = (userId, deviceId) =>
  DeviceToken.findOne({ userId, deviceId, isActive: true });

export const deactivateByUserDevice = (userId, deviceId) =>
  DeviceToken.findOneAndUpdate({ userId, deviceId }, { $set: { isActive: false } });

export const deactivateByUserToken = (userId, fcmToken) =>
  DeviceToken.updateOne({ userId, fcmToken }, { $set: { isActive: false } });

export const deactivateByTokenGlobal = (fcmToken) =>
  DeviceToken.updateOne({ fcmToken, isActive: true }, { $set: { isActive: false } }).catch(() => {});

/** Legacy mirrors (fire-and-forget, as today). Customer → User, else → TechnicianProfile. */
export const mirrorTokenToLegacyStore = (isCustomer, ownerId, fcmToken) =>
  (isCustomer ? addUserMirror(ownerId, fcmToken) : addProfileMirror(ownerId, fcmToken));

export const pullTokenFromLegacyStore = (isCustomer, ownerId, pull) =>
  (isCustomer ? pullUserMirror(ownerId, pull) : pullProfileMirror(ownerId, pull));
