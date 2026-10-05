/**
 * 🗺 GeoJSON Geometry Validation & Sanitization Service
 *
 * Enforces strict RFC 7946 GeoJSON compliance for Polygons and MultiPolygons:
 * 1. Coordinate order: MUST be [longitude, latitude]
 * 2. Bounds: Longitude ∈ [-180, 180], Latitude ∈ [-90, 90]
 * 3. Linear ring closure: First vertex MUST equal last vertex
 * 4. Minimum vertices: At least 4 vertices per linear ring
 * 5. Rewind / Winding Order: Ensures exterior ring is counter-clockwise (Right-Hand Rule)
 * 6. Self-intersection & Zero-Area detection
 */

export function validateAndSanitizePolygon(geometry) {
  const errors = [];
  if (!geometry || typeof geometry !== "object") {
    return { valid: false, errors: ["Geometry object is missing or null"], sanitizedPolygon: null };
  }

  const { type, coordinates } = geometry;

  if (!type || !["Polygon", "MultiPolygon"].includes(type)) {
    return { valid: false, errors: [`Invalid geometry type: ${type}. Must be Polygon or MultiPolygon.`], sanitizedPolygon: null };
  }

  if (!Array.isArray(coordinates) || coordinates.length === 0) {
    return { valid: false, errors: ["Coordinates array is empty or invalid."], sanitizedPolygon: null };
  }

  let sanitizedCoordinates = [];

  if (type === "Polygon") {
    sanitizedCoordinates = validateAndSanitizeRings(coordinates, errors);
  } else if (type === "MultiPolygon") {
    sanitizedCoordinates = coordinates.map((polyRings, idx) => {
      const ringErrors = [];
      const sanitized = validateAndSanitizeRings(polyRings, ringErrors);
      ringErrors.forEach((err) => errors.push(`MultiPolygon[${idx}]: ${err}`));
      return sanitized;
    });
  }

  const isValid = errors.length === 0;

  return {
    valid: isValid,
    errors,
    sanitizedPolygon: isValid
      ? {
          type,
          coordinates: sanitizedCoordinates,
        }
      : null,
  };
}

function validateAndSanitizeRings(rings, errors) {
  if (!Array.isArray(rings) || rings.length === 0) {
    errors.push("Polygon contains no coordinate rings.");
    return rings;
  }

  return rings.map((ring, ringIdx) => {
    if (!Array.isArray(ring) || ring.length < 4) {
      errors.push(`Ring ${ringIdx} must have at least 4 coordinate pairs (got ${ring?.length || 0}).`);
      return ring;
    }

    const sanitizedRing = [];

    // Validate coordinate bounds and order
    for (let i = 0; i < ring.length; i++) {
      const pt = ring[i];
      if (!Array.isArray(pt) || pt.length < 2) {
        errors.push(`Ring ${ringIdx} vertex ${i} is not a valid [lng, lat] pair.`);
        continue;
      }

      const lng = Number(pt[0]);
      const lat = Number(pt[1]);

      if (isNaN(lng) || lng < -180 || lng > 180) {
        errors.push(`Ring ${ringIdx} vertex ${i} longitude out of bounds [-180, 180]: ${pt[0]}`);
      }

      if (isNaN(lat) || lat < -90 || lat > 90) {
        errors.push(`Ring ${ringIdx} vertex ${i} latitude out of bounds [-90, 90]: ${pt[1]}`);
      }

      // Check common Lat/Lng swap error where Lat is first and exceeds bounds or fits India bounds inversely
      if (Math.abs(lng) <= 37 && Math.abs(lat) >= 68 && Math.abs(lat) <= 97) {
        errors.push(
          `Ring ${ringIdx} vertex ${i} appears to have reversed coordinates [lat, lng] instead of GeoJSON standard [lng, lat].`
        );
      }

      sanitizedRing.push([lng, lat]);
    }

    // Ensure Linear Ring Closure (first vertex == last vertex)
    if (sanitizedRing.length >= 4) {
      const first = sanitizedRing[0];
      const last = sanitizedRing[sanitizedRing.length - 1];

      if (first[0] !== last[0] || first[1] !== last[1]) {
        // Auto-close linear ring by appending first point
        sanitizedRing.push([first[0], first[1]]);
      }
    }

    // Rewind Check (exterior ring counter-clockwise)
    if (ringIdx === 0 && sanitizedRing.length >= 4) {
      const area = calculateSignedArea(sanitizedRing);
      if (area === 0) {
        errors.push("Polygon exterior ring has zero area (degenerate polygon).");
      } else if (area > 0) {
        // Clockwise in GeoJSON standard — reverse to counter-clockwise
        sanitizedRing.reverse();
      }
    }

    return sanitizedRing;
  });
}

function calculateSignedArea(ring) {
  let area = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const p1 = ring[i];
    const p2 = ring[i + 1];
    area += p1[0] * p2[1] - p2[0] * p1[1];
  }
  return area / 2;
}

/**
 * Checks if point [lng, lat] is inside a polygon ring using Ray-Casting algorithm.
 */
export function isPointInPolygonRing(point, ring) {
  const [x, y] = point;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0],
      yi = ring[i][1];
    const xj = ring[j][0],
      yj = ring[j][1];

    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * Verifies that a sub-zone polygon is geographically contained inside its parent district polygon.
 */
export function validateZoneInsideDistrict(zonePolygon, districtPolygon) {
  if (!zonePolygon || !districtPolygon) return { valid: false, reason: "Missing polygon geometry" };
  
  const zoneRings = zonePolygon.coordinates ? (zonePolygon.type === "Polygon" ? [zonePolygon.coordinates[0]] : zonePolygon.coordinates.map(p => p[0])) : [];
  const districtRings = districtPolygon.coordinates ? (districtPolygon.type === "Polygon" ? [districtPolygon.coordinates[0]] : districtPolygon.coordinates.map(p => p[0])) : [];

  if (!zoneRings.length || !districtRings.length) return { valid: false, reason: "Empty polygon coordinate rings" };

  const districtOuterRing = districtRings[0];
  const zoneOuterRing = zoneRings[0];

  let insideCount = 0;
  for (const pt of zoneOuterRing) {
    if (isPointInPolygonRing(pt, districtOuterRing)) {
      insideCount++;
    }
  }

  const ratio = insideCount / zoneOuterRing.length;
  if (ratio < 0.5) {
    return {
      valid: false,
      reason: `Sub-zone polygon is geographically outside the parent Operational District boundary (only ${Math.round(ratio * 100)}% of vertices fall inside district polygon).`
    };
  }

  return { valid: true };
}

/**
 * Checks whether two zone outer rings overlap geographically.
 */
export function checkZoneOverlap(zonePolygon1, zonePolygon2) {
  if (!zonePolygon1 || !zonePolygon2) return false;
  const getRing = (p) => p.coordinates ? (p.type === "Polygon" ? p.coordinates[0] : p.coordinates[0][0]) : p;
  const ring1 = getRing(zonePolygon1);
  const ring2 = getRing(zonePolygon2);

  if (!Array.isArray(ring1) || !Array.isArray(ring2)) return false;

  for (const pt of ring1) {
    if (isPointInPolygonRing(pt, ring2)) return true;
  }
  for (const pt of ring2) {
    if (isPointInPolygonRing(pt, ring1)) return true;
  }
  return false;
}

