import test from 'node:test';
import assert from 'node:assert/strict';

import { MovementSession, calculateWaypointRoute } from '../src/engine/movement-path.js';

test('MovementSession manages FVTT-style waypoints', () => {
  const session = new MovementSession({ tokenId: 'hero', start: { x: 0, y: 0 } });
  session.addWaypoint({ x: 10, y: 0 });
  session.addWaypoint({ x: 10, y: 20 });
  assert.deepEqual(session.getControlPoints({ x: 30, y: 20 }), [
    { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 20 }, { x: 30, y: 20 },
  ]);
  assert.deepEqual(session.removeLastWaypoint(), { x: 10, y: 20 });
  assert.deepEqual(session.waypoints, [{ x: 10, y: 0 }]);
});

test('calculateWaypointRoute sums routed segments and reports the blocked leg', async () => {
  const session = new MovementSession({ tokenId: 'hero', start: { x: 0, y: 0 } });
  session.addWaypoint({ x: 3, y: 4 });
  const findPath = async (from, to) => ({ points: [from, to], distance: Math.hypot(to.x - from.x, to.y - from.y), destination: to });
  const route = await calculateWaypointRoute({ session, destination: { x: 3, y: 8 }, findPath });
  assert.equal(route.valid, true);
  assert.equal(route.distance, 9);
  assert.deepEqual(route.points, [{ x: 0, y: 0 }, { x: 3, y: 4 }, { x: 3, y: 8 }]);

  const blocked = await calculateWaypointRoute({
    session,
    destination: { x: 9, y: 9 },
    findPath: async (from, to) => (from.x === 3 ? null : { points: [from, to], distance: 5, destination: to }),
  });
  assert.equal(blocked.valid, false);
  assert.equal(blocked.failedSegmentIndex, 1);
});

test('manual waypoints and the final destination use the same strict direct planner', async () => {
  const session = new MovementSession({ tokenId: 'hero', start: { x: 0, y: 0 } });
  session.addWaypoint({ x: 10, y: 0 });
  const calls = [];
  const route = await calculateWaypointRoute({
    session,
    destination: { x: 20, y: 0 },
    findPath: async (from, to) => {
      calls.push({ from, to });
      return { points: [from, to], distance: 10, destination: to, routeType: 'direct' };
    },
  });
  assert.equal(route.valid, true);
  assert.deepEqual(calls, [
    { from: { x: 0, y: 0 }, to: { x: 10, y: 0 } },
    { from: { x: 10, y: 0 }, to: { x: 20, y: 0 } },
  ]);
  assert.equal(route.routeType, 'direct');
  assert.equal(route.distance, 20);
});
