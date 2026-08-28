import test from 'node:test';
import assert from 'node:assert/strict';
import { TokenDragPhase, TokenDragPlan } from '../src/engine/token-drag.js';

test('TokenDragPlan follows drag, planning, ready and moving phases', () => {
  const drag = new TokenDragPlan();
  drag.begin({ tokenId: 'hero', start: { x: 10, y: 20 }, pointerId: 7, client: { x: 100, y: 100 } });
  assert.equal(drag.phase, TokenDragPhase.DRAGGING);
  assert.equal(Math.round(drag.draggedPixels({ x: 103, y: 104 })), 5);

  drag.update({ x: 30, y: 20 });
  drag.setRoute({ valid: true, destination: { x: 30, y: 20 }, distance: 20 });
  drag.continuePlanning();
  assert.equal(drag.addWaypoint(), true);
  assert.equal(drag.phase, TokenDragPhase.PLANNING);
  assert.deepEqual(drag.session.waypoints, [{ x: 30, y: 20 }]);

  const route = { valid: true, destination: { x: 30, y: 50 }, distance: 50 };
  assert.equal(drag.ready(route), true);
  assert.equal(drag.phase, TokenDragPhase.READY);
  assert.deepEqual(drag.movementTargets(), [{ x: 30, y: 20 }, { x: 30, y: 50 }]);
  assert.equal(drag.startMoving(), true);
  assert.equal(drag.phase, TokenDragPhase.MOVING);
});

test('Ctrl drag release does not become a waypoint and arms the next left click', () => {
  const drag = new TokenDragPlan();
  drag.begin({ tokenId: 'hero', start: { x: 0, y: 0 }, pointerId: 9 });
  drag.update({ x: 40, y: 0 });
  drag.setRoute({ valid: true, destination: { x: 40, y: 0 }, distance: 40 });

  drag.continuePlanning({ nextClickCreatesWaypoint: true });
  assert.equal(drag.phase, TokenDragPhase.PLANNING);
  assert.equal(drag.nextClickCreatesWaypoint, true);
  assert.deepEqual(drag.session.waypoints, []);

  drag.update({ x: 60, y: 20 });
  drag.setRoute({ valid: true, destination: { x: 60, y: 20 }, distance: 70 });
  assert.equal(drag.addWaypoint(drag.route.destination), true);
  assert.deepEqual(drag.session.waypoints, [{ x: 60, y: 20 }]);
  assert.equal(drag.nextClickCreatesWaypoint, false);
});

test('Adding a waypoint while still dragging is guarded and never stores the drag endpoint', () => {
  const drag = new TokenDragPlan();
  drag.begin({ tokenId: 'hero', start: { x: 0, y: 0 } });
  drag.update({ x: 25, y: 0 });
  drag.setRoute({ valid: true, destination: { x: 25, y: 0 }, distance: 25 });

  assert.equal(drag.addWaypoint(), false);
  assert.equal(drag.phase, TokenDragPhase.PLANNING);
  assert.equal(drag.nextClickCreatesWaypoint, true);
  assert.deepEqual(drag.session.waypoints, []);
});

test('TokenDragPlan can undo the last waypoint and reset cleanly', () => {
  const drag = new TokenDragPlan();
  drag.begin({ tokenId: 'hero', start: { x: 0, y: 0 } });
  drag.continuePlanning();
  drag.update({ x: 10, y: 0 });
  drag.setRoute({ valid: true, destination: { x: 10, y: 0 }, distance: 10 });
  drag.addWaypoint();
  drag.update({ x: 20, y: 0 });
  drag.setRoute({ valid: true, destination: { x: 20, y: 0 }, distance: 20 });
  drag.ready(drag.route);
  assert.deepEqual(drag.removeWaypoint(), { x: 10, y: 0 });
  assert.equal(drag.phase, TokenDragPhase.PLANNING);
  drag.reset();
  assert.equal(drag.phase, TokenDragPhase.IDLE);
  assert.equal(drag.session, null);
  assert.equal(drag.nextClickCreatesWaypoint, false);
});
