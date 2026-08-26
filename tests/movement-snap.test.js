import test from 'node:test';
import assert from 'node:assert/strict';
import { MOVEMENT_STEPS, normalizeMovementStep, cycleMovementStep, snapMovementPoint, recommendedMovementStep } from '../src/movement/snap.js';
import { MovementSession } from '../src/movement/session.js';

test('movement snap steps cycle through 1/5/10/20/50/100 metres', () => {
  assert.deepEqual(MOVEMENT_STEPS, [1, 5, 10, 20, 50, 100]);
  assert.equal(cycleMovementStep(20, -1), 10);
  assert.equal(cycleMovementStep(20, 1), 50);
  assert.equal(cycleMovementStep(5, -1), 1);
  assert.equal(cycleMovementStep(1, -1), 1);
  assert.equal(cycleMovementStep(100, 1), 100);
  assert.equal(normalizeMovementStep('50'), 50);
});

test('movement snapping affects only the live control point and preserves placed waypoints', () => {
  const session = new MovementSession({ characterId: 'hero', start: { x: 0, y: 0 }, snapStep: 20 });
  session.addWaypoint({ x: 40, y: 20 });
  session.updateCurrent(snapMovementPoint({ x: 87, y: 73 }, 20), { x: 87, y: 73 });
  assert.deepEqual(session.current, { x: 80.5, y: 80.5 });
  assert.deepEqual(session.waypoints, [{ x: 40, y: 20 }]);
  session.setSnapStep(5);
  session.updateCurrent(snapMovementPoint(session.rawPointer, 5), session.rawPointer);
  assert.deepEqual(session.current, { x: 85.5, y: 75.5 });
  assert.deepEqual(session.waypoints, [{ x: 40, y: 20 }]);
});

test('automatic movement step follows map scale bands', () => {
  assert.equal(recommendedMovementStep({ metersPerPixel: 0.1 }), 1);
  assert.equal(recommendedMovementStep({ metersPerPixel: 0.4 }), 5);
  assert.equal(recommendedMovementStep({ metersPerPixel: 1 }), 10);
  assert.equal(recommendedMovementStep({ metersPerPixel: 2 }), 20);
  assert.equal(recommendedMovementStep({ metersPerPixel: 4 }), 50);
  assert.equal(recommendedMovementStep({ metersPerPixel: 12 }), 100);
});
