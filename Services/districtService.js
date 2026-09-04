import mongoose from "mongoose";
import OperationalCity from "../Schemas/OperationalCity.js";

/**
 * 🗺 DISTRICT SERVICE
 * Provides utility methods for geographic district detection and management.
 */

/**
 * Resolves an active OperationalCity from (latitude, longitude) coordinates using 2dsphere $geoIntersects.
 * @param {number} latitude
 * @param {number} longitude
 * @returns {Promise<Object|null>} OperationalCity document or null
 */
export const getDistrictFromCoordinates = async (latitude, longitude) => {
  const lat = Number(latitude);
  const lng = Number(longitude);

  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return null;
  }

  const district = await OperationalCity.findOne({
    active: true,
    polygon: {
      $geoIntersects: {
        $geometry: {
          type: "Point",
          coordinates: [lng, lat],
        },
      },
    },
  })
    .select("_id name city state country code polygon active isRegistrationEnabled isJobEnabled")
    .lean();

  return district || null;
};

export default {
  getDistrictFromCoordinates,
};
