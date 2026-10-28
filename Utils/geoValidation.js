/**
 * 🗺 GeoJSON Geometry Validation & Sanitization Service
 *
 * Enforces strict RFC 7946 GeoJSON compliance for Polygons and MultiPolygons:
 * 1. Coordinate order: MUST be [longitude, latitude]
 * 2. Bounds: Longitude ∈ [-180, 180], Latitude ∈ [-90, 90]
 * 3. Linear ring closure: First vertex MUST equal last vertex
 * 4. Minimum vertices: At least 4 vertices per linear ring
 * 5. Rewind / Winding Order: exterior rings are normalized to
 *    counter-clockwise and holes to clockwise (RFC 7946 section 3.1.6,
 *    right-hand rule). Signed shoelace area > 0 means counter-clockwise in
 *    the lng(x)/lat(y) plane.
 * 6. Zero-Area detection (exterior and holes). Self-intersection rejection
 *    lives in `hasSelfIntersection` below and is enforced per ring.
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

    // Validate coordinate bounds and order. Only finite numbers (or
    // finite numeric strings) are accepted — null/boolean/empty values must
    // not silently coerce to 0 via Number(). Altitude elements are dropped.
    for (let i = 0; i < ring.length; i++) {
      const pt = ring[i];
      if (!Array.isArray(pt) || pt.length < 2) {
        errors.push(`Ring ${ringIdx} vertex ${i} is not a valid [lng, lat] pair.`);
        continue;
      }

      const rawLng = pt[0];
      const rawLat = pt[1];
      const lngOk =
        (typeof rawLng === "number" || (typeof rawLng === "string" && rawLng.trim() !== "")) &&
        Number.isFinite(Number(rawLng));
      const latOk =
        (typeof rawLat === "number" || (typeof rawLat === "string" && rawLat.trim() !== "")) &&
        Number.isFinite(Number(rawLat));
      if (!lngOk || !latOk) {
        errors.push(`Ring ${ringIdx} vertex ${i} is not a finite numeric [lng, lat] pair.`);
        continue;
      }
      const lng = Number(rawLng);
      const lat = Number(rawLat);

      if (lng < -180 || lng > 180) {
        errors.push(`Ring ${ringIdx} vertex ${i} longitude out of bounds [-180, 180]: ${pt[0]}`);
      }

      if (lat < -90 || lat > 90) {
        errors.push(`Ring ${ringIdx} vertex ${i} latitude out of bounds [-90, 90]: ${pt[1]}`);
      }

      // Heuristic for a common [lat, lng] swap inside the India operating
      // band. This REJECTS (never silently swaps) ambiguous input.
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

    // Winding normalization (RFC 7946 section 3.1.6): exterior rings MUST be
    // counter-clockwise (signed area > 0), holes MUST be clockwise
    // (signed area < 0). The previous implementation reversed area > 0,
    // forcing exteriors to clockwise — the opposite of the standard.
    if (sanitizedRing.length >= 4) {
      const area = calculateSignedArea(sanitizedRing);
      if (area === 0) {
        errors.push(
          ringIdx === 0
            ? "Polygon exterior ring has zero area (degenerate polygon)."
            : `Polygon hole ring ${ringIdx} has zero area (degenerate hole).`
        );
      } else if (ringIdx === 0 && area < 0) {
        sanitizedRing.reverse(); // exterior -> counter-clockwise
      } else if (ringIdx !== 0 && area > 0) {
        sanitizedRing.reverse(); // hole -> clockwise
      }
    }

    // Self-intersection rejection (bowtie / figure-8 rings).
    if (sanitizedRing.length >= 5 && hasSelfIntersection(sanitizedRing)) {
      errors.push(
        ringIdx === 0
          ? "Polygon exterior ring is self-intersecting."
          : `Polygon hole ring ${ringIdx} is self-intersecting.`
      );
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

// Segment intersection primitives shared by self-intersection rejection
// (within one ring: touching counts) and zone-overlap detection (between
// rings: only proper interior crossings count, so zones sharing a border
// vertex or edge are NOT reported as overlapping).
const orientation = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);

const onSegment = (a, b, c) =>
  Math.min(a[0], c[0]) <= b[0] && b[0] <= Math.max(a[0], c[0]) &&
  Math.min(a[1], c[1]) <= b[1] && b[1] <= Math.max(a[1], c[1]);

const segmentsIntersectInclusive = (p1, p2, p3, p4) => {
  const o1 = orientation(p1, p2, p3);
  const o2 = orientation(p1, p2, p4);
  const o3 = orientation(p3, p4, p1);
  const o4 = orientation(p3, p4, p2);
  if (o1 === 0 && onSegment(p1, p3, p2)) return true;
  if (o2 === 0 && onSegment(p1, p4, p2)) return true;
  if (o3 === 0 && onSegment(p3, p1, p4)) return true;
  if (o4 === 0 && onSegment(p3, p2, p4)) return true;
  return o1 * o2 < 0 && o3 * o4 < 0;
};

const segmentsProperlyIntersect = (p1, p2, p3, p4) => {
  const o1 = orientation(p1, p2, p3);
  const o2 = orientation(p1, p2, p4);
  const o3 = orientation(p3, p4, p1);
  const o4 = orientation(p3, p4, p2);
  return o1 * o2 < 0 && o3 * o4 < 0;
};

const eachEdgePair = (ringA, ringB, fn) => {
  const n = ringA.length - 1;
  const m = ringB.length - 1;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < m; j++) {
      if (ringA === ringB) {
        // Edges sharing a vertex (adjacent, or first/last pair of the
        // closed ring) legitimately touch — only non-adjacent pairs count.
        if (i === j) continue;
        if (Math.abs(i - j) === 1) continue;
        if (i === 0 && j === n - 1) continue;
        if (j === 0 && i === n - 1) continue;
      }
      if (fn(ringA[i], ringA[i + 1], ringB[j], ringB[j + 1])) return true;
    }
  }
  return false;
};

/** True when a closed ring crosses or pinches itself (figure-8, bowtie). */
export function hasSelfIntersection(ring) {
  if (!Array.isArray(ring) || ring.length < 5) return false;
  return eachEdgePair(ring, ring, segmentsIntersectInclusive);
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

const EPS = 1e-9;
// Absorbs only floating-point noise around the district edge (≈1 cm at
// Indian latitudes). It is deliberately not large enough to accept zones
// that genuinely extend beyond the boundary.
export const CONTAINMENT_TOLERANCE_DEG = 1e-7;

const pointOnSegment = (pt, a, b, tolerance = 0) => {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lenSq = dx * dx + dy * dy;

  if (lenSq === 0) {
    return Math.hypot(pt[0] - a[0], pt[1] - a[1]) <= Math.max(EPS, tolerance);
  }

  // Clamped projection gives the closest point on the segment, including
  // the endpoints. Distance (not signed collinearity) is compared so a
  // point just past a vertex is handled the same as one beside the edge.
  const t = Math.max(0, Math.min(1, ((pt[0] - a[0]) * dx + (pt[1] - a[1]) * dy) / lenSq));
  const projX = a[0] + t * dx;
  const projY = a[1] + t * dy;
  return Math.hypot(pt[0] - projX, pt[1] - projY) <= Math.max(EPS, tolerance);
};

const pointOnRingBoundary = (pt, ring, tolerance = 0) => {
  for (let i = 0; i < ring.length - 1; i++) {
    if (pointOnSegment(pt, ring[i], ring[i + 1], tolerance)) return true;
  }
  return false;
};

/**
 * Boundary policy (explicit, consistent everywhere):
 * - A point ON a ring boundary counts as inside for containment purposes,
 *   so zones tiling a district may share border vertices with it.
 * - A point strictly inside another zone, or proper edge crossings between
 *   two zones, count as overlap. Mere shared borders/vertices do NOT.
 */
export const pointInRingInclusive = (pt, ring, tolerance = 0) =>
  isPointInPolygonRing(pt, ring) || pointOnRingBoundary(pt, ring, tolerance);

const outerRingsOf = (polygon) => {
  if (!polygon || !Array.isArray(polygon.coordinates)) return [];
  if (polygon.type === "Polygon") return [polygon.coordinates[0]].filter(Boolean);
  if (polygon.type === "MultiPolygon") return polygon.coordinates.map((p) => p[0]).filter(Boolean);
  return [];
};

const allRingsOf = (polygon) => {
  if (!polygon || !Array.isArray(polygon.coordinates)) return [];
  if (polygon.type === "Polygon") return polygon.coordinates.filter(Array.isArray);
  if (polygon.type === "MultiPolygon") return polygon.coordinates.flatMap((p) => (Array.isArray(p) ? p : []));
  return [];
};

const ringsProperlyCross = (ringA, ringB) => eachEdgePair(ringA, ringB, segmentsProperlyIntersect);

/**
 * Crossings caused only by a vertex that sits a floating-point hair outside
 * the district (within `tolerance`) are tolerated. A crossing between two
 * well-inside vertices that leaves and re-enters a concave district boundary
 * is still rejected because neither edge endpoint is near the boundary.
 */
const ringsCrossBeyondTolerance = (ringA, ringB, tolerance) => {
  if (tolerance <= EPS) return ringsProperlyCross(ringA, ringB);

  const n = ringA.length - 1;
  const m = ringB.length - 1;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < m; j++) {
      if (!segmentsProperlyIntersect(ringA[i], ringA[i + 1], ringB[j], ringB[j + 1])) continue;
      const endpointNearBoundary =
        pointOnRingBoundary(ringA[i], ringB, tolerance) ||
        pointOnRingBoundary(ringA[i + 1], ringB, tolerance);
      if (!endpointNearBoundary) return true;
    }
  }
  return false;
};

/**
 * Verifies that EVERY ring (outer + holes, all MultiPolygon components) of
 * the sub-zone lies inside one of the parent district's outer rings, with no
 * edge properly crossing any district boundary and without swallowing any
 * district component. Replaces the old 50%-of-vertices shortcut, which
 * accepted zones straddling the boundary or bulging outside it.
 *
 * `options.tolerance` (degrees) absorbs floating-point noise at the shared
 * boundary; defaults to CONTAINMENT_TOLERANCE_DEG.
 */
export function validateZoneInsideDistrict(zonePolygon, districtPolygon, options = {}) {
  if (!zonePolygon || !districtPolygon) return { valid: false, reason: "Missing polygon geometry" };

  const tolerance =
    Number.isFinite(options.tolerance) && options.tolerance >= 0
      ? options.tolerance
      : CONTAINMENT_TOLERANCE_DEG;

  const zoneRings = allRingsOf(zonePolygon);
  const districtOuters = outerRingsOf(districtPolygon);

  if (!zoneRings.length || !districtOuters.length) return { valid: false, reason: "Empty polygon coordinate rings" };

  // A district may legitimately be a MultiPolygon (mainland plus islands or
  // disjoint wards). Every zone ring must be contained by one of the
  // district's outer rings — checking only districtOuters[0] incorrectly
  // rejected zones located in any later component.
  for (let r = 0; r < zoneRings.length; r++) {
    const ring = zoneRings[r];
    for (let i = 0; i < ring.length; i++) {
      const insideAnyDistrictRing = districtOuters.some((outer) =>
        pointInRingInclusive(ring[i], outer, tolerance)
      );
      if (!insideAnyDistrictRing) {
        const [lng, lat] = ring[i];
        return {
          valid: false,
          reason: `Sub-zone polygon extends outside the parent Operational District boundary (ring ${r} vertex ${i} [${lng}, ${lat}] is outside).`,
          details: { ring: r, vertex: i, coordinate: [lng, lat] },
        };
      }
    }

    for (const outer of districtOuters) {
      if (ringsCrossBeyondTolerance(ring, outer, tolerance)) {
        return {
          valid: false,
          reason: `Sub-zone polygon edge crosses the parent Operational District boundary (ring ${r}).`,
          details: { ring: r },
        };
      }
    }
  }

  // The zone must not swallow any district component: a district vertex
  // strictly inside a zone outer means the zone contains (not sits inside)
  // that part of the district. Check every outer component on both sides.
  const zoneOuters = outerRingsOf(zonePolygon);
  for (const zoneOuter of zoneOuters) {
    for (const districtOuter of districtOuters) {
      for (const pt of districtOuter) {
        if (isPointInPolygonRing(pt, zoneOuter) && !pointOnRingBoundary(pt, zoneOuter, tolerance)) {
          return {
            valid: false,
            reason: "Sub-zone polygon contains the parent district boundary instead of sitting inside it.",
          };
        }
      }
    }
  }

  return { valid: true };
}

/**
 * True when two zone geometries genuinely overlap: a vertex of one lies
 * strictly inside the other, or any edge pair properly crosses. Shared
 * borders/vertices (tiling) and holes are handled: holes are part of the
 * geometry and crossing a hole boundary still counts.
 */
export function checkZoneOverlap(zonePolygon1, zonePolygon2) {
  const outers1 = outerRingsOf(zonePolygon1);
  const outers2 = outerRingsOf(zonePolygon2);
  if (!outers1.length || !outers2.length) return false;

  const midpoint = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  // Ring centroid (average of distinct vertices). For identical or fully
  // coincident geometries every edge lies exactly on the peer boundary, so
  // vertex/midpoint/crossing tests all abstain — but the shared interior
  // point is strictly inside both rings, which still proves duplication.
  const centroid = (ring) => {
    const pts = ring.slice(0, -1);
    if (!pts.length) return null;
    return [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];
  };
  for (const r1 of outers1) {
    for (const r2 of outers2) {
      const c1 = centroid(r1);
      const c2 = centroid(r2);
      if (c1 && isPointInPolygonRing(c1, r2) && !pointOnRingBoundary(c1, r2)) return true;
      if (c2 && isPointInPolygonRing(c2, r1) && !pointOnRingBoundary(c2, r1)) return true;
      for (const pt of r1) {
        if (isPointInPolygonRing(pt, r2) && !pointOnRingBoundary(pt, r2)) return true;
      }
      for (const pt of r2) {
        if (isPointInPolygonRing(pt, r1) && !pointOnRingBoundary(pt, r1)) return true;
      }
      if (ringsProperlyCross(r1, r2)) return true;
      // Edge-midpoint sampling: catches edges that pass through the other
      // ring with both endpoints on/outside its boundary (e.g. a vertex
      // landing exactly on the peer edge). Midpoints of genuinely shared
      // tiling borders lie ON the boundary, never strictly inside.
      for (let i = 0; i < r1.length - 1; i++) {
        const mid = midpoint(r1[i], r1[i + 1]);
        if (isPointInPolygonRing(mid, r2) && !pointOnRingBoundary(mid, r2)) return true;
      }
      for (let j = 0; j < r2.length - 1; j++) {
        const mid = midpoint(r2[j], r2[j + 1]);
        if (isPointInPolygonRing(mid, r1) && !pointOnRingBoundary(mid, r1)) return true;
      }
    }
  }
  return false;
}

