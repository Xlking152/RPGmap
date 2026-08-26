import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MOVEMENT_DISTANCE_STEPS,
  movementDisplayCost,
  normalizeMovementDistanceStep,
  pointAlongPolyline,
  splitRouteByWaypoints,
  summarizeMovementSegments,
} from '../src/engine/movement-distance.js';

test('movement distance steps normalize and round upward without changing actual distance', () => {
  assert.deepEqual(MOVEMENT_DISTANCE_STEPS, [1, 5, 10, 20, 50, 100]);
  assert.equal(normalizeMovementDistanceStep('20'), 20);
  assert.equal(normalizeMovementDistanceStep(7), 5);
  assert.equal(movementDisplayCost(12.4, 5), 15);
  assert.equal(movementDisplayCost(8.1, 5), 10);
  assert.equal(movementDisplayCost(26.7, 20), 40);
  assert.equal(movementDisplayCost(0, 100), 0);
});

test('route is split at waypoint legs and produces per-leg plus total display costs', () => {
  const route = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 20, y: 10 },
    { x: 30, y: 10 },
  ];
  const segments = splitRouteByWaypoints(route, [{ x: 10, y: 10 }], 1);
  assert.equal(segments.length, 2);
  assert.equal(segments[0].distance, 20);
  assert.equal(segments[1].distance, 20);
  assert.deepEqual(pointAlongPolyline(segments[0].points, 0.5), { x: 10, y: 0 });
  const summary = summarizeMovementSegments(segments, 20);
  assert.equal(summary.actualDistance, 40);
  assert.equal(summary.displayCost, 40);
  assert.deepEqual(summary.segments.map(segment => segment.displayCost), [20, 20]);

  const endpointWaypoint = splitRouteByWaypoints(route, [{ x: 30, y: 10 }], 1);
  assert.equal(endpointWaypoint.length, 1, 'a waypoint equal to the current endpoint must not create a zero-length leg');
});
