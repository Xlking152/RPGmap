import test from 'node:test';
import assert from 'node:assert/strict';
import polygonClipping from 'polygon-clipping';
import { polygonDifference, intersectionArea, polygonArea, pointInPolygon,
  normalizePolygonGeometry, GeometryClipError } from '../src/engine/geometry.js';

const rect = (x, y, width, height) => [[x, y], [x + width, y], [x + width, y + height], [x, y + height]];
const sweepFailure = () => new Error('Unable to pop() left SweepEvent [3408, 1567] from segment #9142 from queue.');

test('clipping cleans duplicate and exact collinear edges without filling holes or erasing thin walls', () => {
  const subject = [[[0, 0], [5, 0], [10, 0], [10, 0], [10, 10], [0, 10], [0, 0]], rect(2, 2, 2, 2)];
  const clean = normalizePolygonGeometry(subject);
  assert.equal(clean[0][0].length, 5);
  assert.equal(clean[0].length, 2);
  const remaining = polygonDifference(subject, rect(8, -1, 4, 12));
  assert.equal(polygonArea(remaining), 76);
  assert.equal(pointInPolygon({ x: 3, y: 3 }, remaining), false);
  assert.equal(pointInPolygon({ x: 7, y: 3 }, remaining), true);
  const thin = rect(0, 0, 1e-12, 10);
  assert.equal(normalizePolygonGeometry(thin).length, 1);
  assert.equal(polygonArea(thin), 1e-11);
  assert.deepEqual(normalizePolygonGeometry([[[0, 0], [1, 0], [2, 0]], rect(0, 0, 1, 1)]), [],
    'a degenerate exterior must not promote its hole to a solid');
});

test('healthy difference and intersection keep their original floating-point coordinates', () => {
  const subject = rect(3581.491689174436, 1553.9528916589916, 101.0123456789, 20);
  const clipping = rect(3628.528142813593, 1540, 5.987654321098, 60);
  const direct = polygonClipping.difference([normalizePolygonGeometry(subject)[0]], [normalizePolygonGeometry(clipping)[0]]);
  assert.deepEqual(polygonDifference(subject, clipping), direct);
  assert.equal(intersectionArea(subject, clipping), polygonArea(polygonClipping.intersection(
    normalizePolygonGeometry(subject), normalizePolygonGeometry(clipping))));
});

test('known sweep failures retry local coordinates in metres at exactly two bounded precisions', () => {
  const original = polygonClipping.difference;
  const calls = [];
  polygonClipping.difference = (subject, clipping) => {
    calls.push(structuredClone({ subject, clipping }));
    if (calls.length < 3) throw sweepFailure();
    return original(subject, clipping);
  };
  try {
    const subject = rect(3581.491689174436, 1553.9528916589916, 100, 20);
    const result = polygonDifference(subject, rect(3631.491689174436, 1543.9528916589916, 25, 40), { metersPerUnit: 2 });
    assert.equal(calls.length, 3);
    assert.deepEqual(calls[0].subject, normalizePolygonGeometry(subject));
    assert.equal(calls[1].subject[0][0][0][0], 0);
    assert.equal(calls[1].subject[0][0][1][0], 200);
    assert.equal(calls[2].subject[0][0][1][0], 200);
    assert.ok(Math.abs(polygonArea(result) - 1500) <= 1e-6);
    assert.equal(pointInPolygon({ x: 3640, y: 1560 }, result), false);
    assert.equal(pointInPolygon({ x: 3600, y: 1560 }, result), true);
  } finally { polygonClipping.difference = original; }
});

test('known sweep failures in intersection use the same limited local retry', () => {
  const original = polygonClipping.intersection;
  let calls = 0;
  polygonClipping.intersection = (...args) => { calls += 1; if (calls === 1) throw sweepFailure(); return original(...args); };
  try {
    assert.equal(intersectionArea(rect(1000, 1000, 10, 10), rect(1005, 1000, 10, 10)), 50);
    assert.equal(calls, 2);
  } finally { polygonClipping.intersection = original; }
});

test('persistent clipping errors throw a typed failure instead of clearing the blocker', () => {
  const original = polygonClipping.difference;
  let calls = 0;
  polygonClipping.difference = () => { calls += 1; throw sweepFailure(); };
  try {
    assert.throws(() => polygonDifference(rect(0, 0, 10, 10), rect(2, 2, 2, 2)), error =>
      error instanceof GeometryClipError && error.code === 'geometry_clip_failed' && error.operation === 'difference');
    assert.equal(calls, 3);
  } finally { polygonClipping.difference = original; }
});

test('unexpected library errors and nonfinite inputs fail without precision retries', () => {
  const original = polygonClipping.difference;
  let calls = 0;
  polygonClipping.difference = () => { calls += 1; throw new Error('unexpected internal invariant'); };
  try {
    assert.throws(() => polygonDifference(rect(0, 0, 10, 10), rect(2, 2, 2, 2)), { code: 'geometry_clip_failed' });
    assert.equal(calls, 1);
  } finally { polygonClipping.difference = original; }
  assert.throws(() => polygonDifference([[0, 0], [Infinity, 0], [0, 2]], rect(0, 0, 1, 1)), { code: 'geometry_clip_failed' });
  assert.throws(() => intersectionArea(rect(0, 0, 1, 1), [[0, 0], [2, NaN], [0, 2]]), { code: 'geometry_clip_failed' });
});

test('precision retries cannot collapse a genuine thin polygon or hole into empty geometry', () => {
  const original = polygonClipping.difference;
  let calls = 0;
  polygonClipping.difference = () => { calls += 1; throw sweepFailure(); };
  try {
    assert.throws(() => polygonDifference(rect(0, 0, 1e-12, 10), rect(-1, 2, 2, 2)), { code: 'geometry_clip_failed' });
    assert.equal(calls, 1, 'collapsed retry inputs must never reach the clipping library');
  } finally { polygonClipping.difference = original; }
});

test('a malformed clipping result is a typed failure and never an accepted empty blocker', () => {
  const original = polygonClipping.difference;
  polygonClipping.difference = () => [[[[0, 0], [1, 0], [1, NaN], [0, 0]]]];
  try {
    assert.throws(() => polygonDifference(rect(0, 0, 10, 10), rect(2, 2, 2, 2)), { code: 'geometry_clip_failed' });
  } finally { polygonClipping.difference = original; }
});

test('local area arithmetic preserves small geometry far from the coordinate origin', () => {
  assert.equal(polygonArea(rect(1e9, 1e9, 0.25, 0.5)), 0.125);
  assert.equal(intersectionArea(rect(1e9, 1e9, 0.25, 0.5), rect(1e9 + 0.125, 1e9, 0.5, 0.5)), 0.0625);
});
