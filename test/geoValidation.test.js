import test from "node:test";
import assert from "node:assert/strict";
import { checkZoneOverlap } from "../Utils/geoValidation.js";

const polygon = (...rings) => ({ type: "Polygon", coordinates: rings });

const square = (minX, minY, maxX, maxY) =>
  polygon([
    [minX, minY],
    [maxX, minY],
    [maxX, maxY],
    [minX, maxY],
    [minX, minY],
  ]);

test("shared district boundary with a T-junction vertex is not overlap", () => {
  const karurEdge = polygon([
    [77.8127, 10.7584],
    [77.8269, 10.7497],
    [77.812, 10.765],
    [77.8127, 10.7584],
  ]);
  const tiruppurEdge = polygon([
    [77.8217, 10.7335],
    [77.82509036753744, 10.750808718480581],
    [77.82, 10.73],
    [77.8217, 10.7335],
  ]);

  assert.equal(checkZoneOverlap(karurEdge, tiruppurEdge), false);
});

test("polygons sharing an edge or a vertex are not overlap", () => {
  const left = square(0, 0, 1, 1);
  const right = square(1, 0, 2, 1);
  const corner = square(1, 1, 2, 2);

  assert.equal(checkZoneOverlap(left, right), false);
  assert.equal(checkZoneOverlap(left, corner), false);
});

test("genuinely overlapping and identical polygons are overlap", () => {
  const base = square(0, 0, 2, 2);
  const overlapping = square(1, 1, 3, 3);
  const inside = square(0.5, 0.5, 1.5, 1.5);

  assert.equal(checkZoneOverlap(base, overlapping), true);
  assert.equal(checkZoneOverlap(base, inside), true);
  assert.equal(checkZoneOverlap(base, square(0, 0, 2, 2)), true);
});

test("identical concave polygons are overlap", () => {
  const concave = polygon([
    [
      [0, 0],
      [3, 0],
      [3, 1],
      [1, 1],
      [1, 3],
      [0, 3],
      [0, 0],
    ],
  ]);

  assert.equal(checkZoneOverlap(concave, concave), true);
});

test("a polygon inside another polygon's hole is not overlap", () => {
  const donut = polygon(
    [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
      [0, 0],
    ],
    [
      [3, 3],
      [3, 7],
      [7, 7],
      [7, 3],
      [3, 3],
    ]
  );

  assert.equal(checkZoneOverlap(donut, square(4, 4, 6, 6)), false);
  assert.equal(checkZoneOverlap(donut, square(3, 3, 7, 7)), false);
  assert.equal(checkZoneOverlap(donut, square(2, 2, 4, 4)), true);
  assert.equal(checkZoneOverlap(donut, square(2, 2, 8, 8)), true);
});
