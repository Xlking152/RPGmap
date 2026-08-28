import test from 'node:test';
import assert from 'node:assert/strict';

import { MovementPhase, TokenDragPlan } from '../src/movement/state.js';

test('ctrl drag release enters planning without creating the first waypoint', () => {
  const drag = new TokenDragPlan();
  drag.begin({ tokenId: 'hero', start: { x: 0, y: 0 }, pointerId: 1, client: { x: 10, y: 10 } });
  drag.update({ x: 20, y: 0 }, { valid: true, destination: { x: 20, y: 0 } }, { x: 20, y: 0 });

  const addedOnRelease = drag.addWaypoint({ x: 20, y: 0 });

  assert.equal(addedOnRelease, false);
  assert.equal(drag.phase, MovementPhase.PLANNING);
  assert.deepEqual(drag.session.waypoints, []);

  const addedOnFirstClick = drag.addWaypoint({ x: 40, y: 10 });

  assert.equal(addedOnFirstClick, true);
  assert.deepEqual(drag.session.waypoints, [{ x: 40, y: 10 }]);
});
