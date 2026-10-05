import TechnicianProfile from "../models/TechnicianProfile.js";

export const findNearbyTechnicians = async ({
  latitude,
  longitude,
  radiusMeters = 5000,
  limit = 20,
  technicianIds = [], // Added filter support
}) => {
  const query = {
    "availability.isOnline": true,
    // Safely ensure location is valid before doing $near (prevents crash on null location)
    "location.type": "Point",
    "location.coordinates.0": { $type: "number" },
    "location.coordinates.1": { $type: "number" },
    location: {
      $near: {
        $geometry: {
          type: "Point",
          coordinates: [Number(longitude), Number(latitude)], // [lng, lat]
        },
        $maxDistance: radiusMeters,
      },
    },
  };

  if (technicianIds.length > 0) {
    query._id = { $in: technicianIds };
  }

  return TechnicianProfile.find(query)
    .limit(limit)
    .select("_id location");
};

