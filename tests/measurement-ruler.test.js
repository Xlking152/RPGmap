import test from 'node:test';
import assert from 'node:assert/strict';
import { RulerSession } from '../src/measurement/session.js';
import { summarizeRulerPath, formatRulerDistance } from '../src/measurement/distance.js';

test('ruler session supports one ruler with chained waypoints', () => {
  const ruler = new RulerSession();
  assert.equal(ruler.begin({ x: 0, y: 0 }), true);
  ruler.update({ x: 3, y: 4 });
  assert.equal(ruler.addWaypoint(), true);
  ruler.update({ x: 6, y: 8 });
  assert.equal(ruler.finish(), true);
  assert.deepEqual(ruler.points, [{ x:0,y:0 }, { x:3,y:4 }, { x:6,y:8 }]);
  const summary = summarizeRulerPath(ruler.points);
  assert.equal(summary.segments.length, 2);
  assert.equal(summary.total, 10);
});

test('right-click style removal keeps ruler origin and removes latest waypoint', () => {
  const ruler = new RulerSession();
  ruler.begin({ x: 10, y: 10 });
  ruler.update({ x: 20, y: 10 });
  ruler.addWaypoint();
  ruler.update({ x: 30, y: 10 });
  ruler.addWaypoint();
  const removed = ruler.removeWaypoint();
  assert.deepEqual(removed, { x: 30, y: 10 });
  assert.deepEqual(ruler.points, [{ x:10,y:10 }, { x:20,y:10 }]);
});

test('ruler formatting preserves useful precision for short distances', () => {
  assert.equal(formatRulerDistance(37.44), '37.4 m');
  assert.equal(formatRulerDistance(180), '180 m');
  assert.equal(formatRulerDistance(1234), '1.23 km');
});
