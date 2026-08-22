import assert from 'node:assert/strict';
import test from 'node:test';

import { irregularDamagePolygon } from '../src/render/scene-renderer.js';

function radius(point) {
  return Math.hypot(point.x, point.y);
}

test('building damage polygons become stable irregular inward scars', () => {
  const circle = Array.from({ length: 64 }, (_, index) => {
    const angle = Math.PI * 2 * index / 64;
    return { x: Math.cos(angle) * 40, y: Math.sin(angle) * 40 };
  });
  const first = irregularDamagePolygon(circle, 'barracks-01-0');
  const repeated = irregularDamagePolygon(circle, 'barracks-01-0');

  assert.deepEqual(first, repeated);
  assert.equal(first.length, 14);
  assert.ok(first.every((point) => radius(point) < 40));
  assert.ok(Math.max(...first.map(radius)) - Math.min(...first.map(radius)) > 6);
});

test('irregular damage keeps small polygons valid and rejects bad points', () => {
  const result = irregularDamagePolygon([
    [0, 0], [20, 0], [20, 10], [0, 10], ['bad', 2],
  ], 'small');
  assert.equal(result.length, 4);
  assert.ok(result.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y)));
});
