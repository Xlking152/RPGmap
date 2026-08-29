import test from 'node:test';
import assert from 'node:assert/strict';
import {
  interpolateTokenPoint,
  normalizeTokenPoint,
  sameTokenPoint,
  tokenMoveDuration,
} from '../src/render/token-motion.js';

test('Token motion interpolation remains render-only numeric geometry', () => {
  assert.deepEqual(normalizeTokenPoint({ x: '10', y: 20 }), { x: 10, y: 20 });
  assert.equal(normalizeTokenPoint({ x: 'bad', y: 20 }), null);
  assert.deepEqual(interpolateTokenPoint({ x: 0, y: 0 }, { x: 10, y: 20 }, 0.5), { x: 5, y: 10 });
  assert.deepEqual(interpolateTokenPoint({ x: 0, y: 0 }, { x: 10, y: 20 }, 3), { x: 10, y: 20 });
  assert.equal(sameTokenPoint({ x: 1, y: 2 }, { x: 1 + 1e-7, y: 2 }), true);
});

test('Token motion duration is visible but capped for long routes', () => {
  assert.equal(tokenMoveDuration({ x: 0, y: 0 }, { x: 1, y: 0 }), 180);
  assert.equal(tokenMoveDuration({ x: 0, y: 0 }, { x: 10, y: 0 }), 350);
  assert.equal(tokenMoveDuration({ x: 0, y: 0 }, { x: 100, y: 0 }), 900);
});
