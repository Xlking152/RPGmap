import test from 'node:test';
import assert from 'node:assert/strict';
import {
  browserBenchmarkMovementTarget,
  browserBenchmarkPhaseOperations,
} from '../scripts/browser-benchmark-movement.mjs';

test('seven-session browser schedule moves each Player on every step across both phases', () => {
  const tokens = Array.from({ length: 6 }, (_, index) => ({
    id: `browser-token-${index}`, placement: 'map', x: 2900 + index * 2, y: 2500,
  }));
  for (const phase of ['normal', 'los-light']) {
    const moves = Array(6).fill(0);
    for (let step = 0; step < 118; step += 1) {
      const index = step % 6;
      const previous = tokens[index];
      const next = browserBenchmarkMovementTarget(previous, index);
      assert.notDeepEqual([next.x, next.y], [previous.x, previous.y], `${phase} step ${step}`);
      tokens[index] = { ...previous, ...next };
      moves[index] += 1;
    }
    assert.deepEqual(moves, [20, 20, 20, 20, 19, 19]);
  }
  assert.deepEqual(tokens.map(token => token.y), Array(6).fill(2500));
});

test('browser benchmark phase setup keeps 500 Tokens and enables only three occluded lights in dark phase', () => {
  const scene = { id: 'scene-northern-song-lanzhou-1104', settings: { gridVisible: true, lineOfSightEnabled: false },
    tokens: Array.from({ length: 500 }, (_, index) => ({ id: `browser-token-${index}`, placement: 'map' })) };
  const normal = browserBenchmarkPhaseOperations(scene, 500, 'normal');
  const dark = browserBenchmarkPhaseOperations(scene, 500, 'dark');
  assert.equal(normal.length, 1);
  assert.deepEqual(normal[0].payload.settings, { gridVisible: true, lineOfSightEnabled: true, lighting: 'normal' });
  assert.equal(dark.length, 4);
  assert.equal(dark[0].payload.settings.lighting, 'dark');
  assert.deepEqual(dark.slice(1).map(operation => operation.payload.token.id),
    ['browser-token-497', 'browser-token-498', 'browser-token-499']);
  assert.ok(dark.slice(1).every(operation => operation.type === 'token.upsert'
    && operation.payload.token.light.enabled === true
    && operation.payload.token.light.rangeMeters === 120
    && operation.payload.token.light.intensity === 1.2
    && operation.payload.token.light.elevationOffsetMeters === 3
    && operation.payload.token.light.occlusion === 'scene'));
  assert.equal(scene.tokens.filter(token => token.light?.enabled).length, 0);
});
