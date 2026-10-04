import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectLineOfSight, normalizeVisionOccluder } from '../src/spatial/kernel.js';

const EPSILON = 1e-9;
const cross = (ax, ay, bx, by) => ax * by - ay * bx;
function intersection(from, to, a, b) {
  const rx = to.x - from.x, ry = to.y - from.y;
  const sx = b[0] - a[0], sy = b[1] - a[1];
  const denominator = cross(rx, ry, sx, sy);
  if (Math.abs(denominator) <= EPSILON) return null;
  const qx = a[0] - from.x, qy = a[1] - from.y;
  const t = cross(qx, qy, sx, sy) / denominator;
  const u = cross(qx, qy, rx, ry) / denominator;
  return t >= -EPSILON && t <= 1 + EPSILON && u >= -EPSILON && u <= 1 + EPSILON ? t : null;
}
function inside(point, ring) {
  let result = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const [x1, y1] = ring[index], [x2, y2] = ring[previous];
    if ((y1 > point.y) !== (y2 > point.y)
      && point.x < ((x2 - x1) * (point.y - y1)) / ((y2 - y1) || EPSILON) + x1) result = !result;
  }
  return result;
}

// Preserved pre-optimization interval algorithm. It deliberately does not use
// the scalar crossing or solid-membership helpers from the production kernel.
function referenceRay({ from, to, occluders, metersPerUnit = 1 }) {
  const start = { ...from, elevationMeters: from.elevationMeters ?? 0 };
  const end = { ...to, elevationMeters: to.elevationMeters ?? 0 };
  const bounds = [Math.min(start.x, end.x), Math.min(start.y, end.y), Math.max(start.x, end.x), Math.max(start.y, end.y)];
  for (const obstacle of occluders) {
    const polygon = obstacle.polygon;
    if (polygon.every(point => point[0] < bounds[0]) || polygon.every(point => point[0] > bounds[2])
      || polygon.every(point => point[1] < bounds[1]) || polygon.every(point => point[1] > bounds[3])) continue;
    const crossings = [0, 1];
    for (const rings of obstacle.polygons) for (const ring of rings) for (let i = 0; i < ring.length; i++) {
      const t = intersection(start, end, ring[i], ring[(i + 1) % ring.length]);
      if (t !== null && t > 0 && t < 1) crossings.push(t);
    }
    crossings.sort((a, b) => a - b);
    let hit;
    const slope = end.elevationMeters - start.elevationMeters;
    for (let i = 1; i < crossings.length; i++) {
      const first = crossings[i - 1], last = crossings[i];
      if (last - first <= EPSILON) continue;
      const middle = (first + last) / 2;
      const point = { x: start.x + (end.x - start.x) * middle, y: start.y + (end.y - start.y) * middle };
      if (!obstacle.polygons.some(([outer, ...holes]) => inside(point, outer) && !holes.some(hole => inside(point, hole)))) continue;
      if (start.elevationMeters + slope * first <= obstacle.blockingHeightMeters + EPSILON) hit = first;
      else if (slope < 0 && start.elevationMeters + slope * last <= obstacle.blockingHeightMeters + EPSILON)
        hit = (obstacle.blockingHeightMeters - start.elevationMeters) / slope;
      if (hit !== undefined) break;
    }
    if (hit !== undefined) {
      const x = start.x + (end.x - start.x) * hit;
      const y = start.y + (end.y - start.y) * hit;
      const z = start.elevationMeters + (end.elevationMeters - start.elevationMeters) * hit;
      return { clear: false, code: 'line_of_sight_blocked', occluderId: obstacle.id, featureId: obstacle.featureId,
        distanceMeters: Math.hypot((x - start.x) * metersPerUnit, (y - start.y) * metersPerUnit, z - start.elevationMeters) };
    }
  }
  return { clear: true, code: 'ok' };
}

const rectangle = [[0,0],[10,0],[10,10],[0,10]];
const concave = [[0,0],[10,0],[10,3],[3,3],[3,7],[10,7],[10,10],[0,10]];
const shapes = [
  [[rectangle]], [[rectangle.toReversed()]],
  [[[[0,5],[5,0],[10,5],[5,10]]]], [[[[0,0],[10,0],[5,10]]]],
  [[concave]], [[rectangle, [[2,2],[8,2],[8,8],[2,8]]]],
  [[[[0,0],[3,0],[3,10],[0,10]]], [[[7,0],[10,0],[10,10],[7,10]]]],
  [[[[0,0],[10,10],[0,10],[10,0]]]],
];
function blockers(polygons, height = 6) {
  return Object.freeze([normalizeVisionOccluder({ id: 'first', polygon: rectangle, polygons, blockingHeightMeters: height }),
    normalizeVisionOccluder({ id: 'second', polygon: [[12,-10],[15,-10],[15,20],[12,20]], blockingHeightMeters: 8 })]);
}

test('scalar crossing intervals exactly match legacy rays at boundaries, holes, fragments and finite heights', () => {
  const points = [[-5,0],[0,0],[5,0],[10,0],[15,0],[-5,10],[5,10],[15,10],[5,5],[0,5],[10,5],
    [5,-5],[5,15],[10 + 1e-10,5],[10 - 1e-10,5]];
  for (const polygons of shapes) for (const height of [0,6,Infinity]) {
    const occluders = blockers(polygons, height);
    for (const [x,y] of points) for (const [tx,ty] of points) for (const [z,tz] of [[0,0],[12,0],[0,12],[6,6]]) {
      const input = { from: {x,y,elevationMeters:z}, to: {x:tx,y:ty,elevationMeters:tz}, occluders, metersPerUnit: 0.7 };
      assert.deepEqual(inspectLineOfSight(input), referenceRay(input));
    }
  }
});

test('seeded arbitrary rays preserve exact hit distances and first-hit order across indexed geometry', () => {
  let seed = 537249;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  for (let index = 0; index < 10000; index++) {
    const occluders = blockers(shapes[index % shapes.length], index % 9 === 0 ? Infinity : random() * 15);
    const point = () => ({x:random()*30-10,y:random()*30-10,elevationMeters:random()*20});
    const input = {from:point(),to:point(),occluders,metersPerUnit:0.25+random()*4};
    assert.deepEqual(inspectLineOfSight(input),referenceRay(input));
  }
});

test('prepared ring coefficients preserve signed zero and widely scaled floating point boundaries', () => {
  for (const scale of [1e-12, 1, 1e6, 2 ** 45, 1e100]) {
    const polygon = [[-0, -0], [10 * scale, 0], [10 * scale, 10 * scale], [0, 10 * scale]];
    const holes = [[[2 * scale, 2 * scale], [8 * scale, 2 * scale], [8 * scale, 8 * scale], [2 * scale, 8 * scale]]];
    const occluders = Object.freeze([normalizeVisionOccluder({ id: 'scaled', polygon,
      polygons: [[polygon, ...holes]], blockingHeightMeters: 6 })]);
    for (const y of [0, 2 * scale, 5 * scale, 8 * scale, 10 * scale]) {
      const input = { from: { x: -5 * scale, y }, to: { x: 15 * scale, y }, occluders };
      for (let repetition = 0; repetition < 3; repetition++) assert.deepEqual(inspectLineOfSight(input), referenceRay(input));
    }
  }
});

test('mutable geometry with a reused ID is normalized afresh after moving its contour', () => {
  const raw = { id: 'mutable', polygon: structuredClone(rectangle), blockingHeightMeters: 6 };
  const input = { from: { x: -5, y: 5 }, to: { x: 15, y: 5 }, occluders: [raw] };
  assert.equal(inspectLineOfSight(input).clear, false);
  raw.polygon = raw.polygon.map(([x, y]) => [x, y + 20]);
  assert.equal(inspectLineOfSight(input).clear, true);
  raw.polygon = structuredClone(rectangle);
  assert.equal(inspectLineOfSight(input).clear, false);
});
