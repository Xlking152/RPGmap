import test from 'node:test';
import assert from 'node:assert/strict';
import { createMovementFastPathSystem } from '../src/movement/fast-path.js';
import {
  browserBenchmarkMoveToken,
  browserBenchmarkMovementTarget,
  browserBenchmarkPhaseOperations,
} from '../scripts/browser-benchmark-movement.mjs';

function movementRuntime({ dispatchError = null, applyCommit = true } = {}) {
  const token = { id: 'browser-token-0', actorId: 'browser-actor-0', actorLink: true,
    actorDelta: null, placement: 'map', x: 2900, y: 2500, elevationMeters: 0,
    diameterMeters: 1, locked: false, effects: [] };
  const scene = { id: 'scene-northern-song-lanzhou-1104', mapPackage: { id: 'map', version: '1' },
    tokens: [token], markers: [], attackAreas: [], sceneEvents: [], featureStates: {}, settings: {} };
  const world = { schemaVersion: 4, id: 'world', activeSceneId: scene.id,
    actors: [{ id: token.actorId, name: 'Actor', type: 'pc', system: {}, effects: [] }],
    statusDefinitions: [], scenes: [scene] };
  const state = { sceneEvents: [], preferences: { worldV2: world, featureStates: {} } };
  const writes = [];
  let clock = 10;
  const api = {
    mapPackage: { id: 'map', version: '1', width: 6000, height: 5000, metersPerUnit: 1,
      features: [], roadBuffers: [], liquidBodies: [], floodRules: {}, navigation: {} },
    getState: () => structuredClone(state),
    tokens: { get: id => structuredClone(scene.tokens.find(item => item.id === id)) },
    world: { get: () => structuredClone(world), getActiveScene: () => structuredClone(scene),
      performOperations() { assert.fail('Benchmark must use the real route entry instead of absolute token.move'); } },
    documents: { async dispatch(write) {
      writes.push(structuredClone(write));
      clock += 27;
      if (dispatchError) throw dispatchError;
      if (applyCommit) Object.assign(token, write.data.waypoints.at(-1));
      return { revision: writes.length };
    } },
    vision: { getSource: () => token.id },
    movement: { canonicalSceneTokens: true,
      inspectMovementAccess(id, destination, options = {}) {
        const current = api.tokens.get(id);
        return { valid: true, token: current, from: options.from || current, destination };
      }, invalidateNavigation() {} },
    emit() {}, on() { return () => {}; },
  };
  createMovementFastPathSystem().register(api);
  return { api, writes, now: () => clock, token };
}

test('browser movement uses the real drag/WASD route entry and its current-origin precondition', async () => {
  const value = movementRuntime();
  const serializedMove = (0, eval)(`(${browserBenchmarkMoveToken.toString()})`);
  const serializedTarget = (0, eval)(`(${browserBenchmarkMovementTarget.toString()})`);
  for (const [from, to] of [[2500, 2500.5], [2500.5, 2500]]) {
    const result = await serializedMove(value.api, 0, serializedTarget, value.now);
    const write = value.writes.at(-1);
    assert.equal(write.intent, 'token.movePath');
    assert.equal(write.action, 'move');
    assert.deepEqual(write.document, { type: 'Token', id: value.token.id,
      parent: { type: 'Scene', id: 'scene-northern-song-lanzhou-1104' } });
    assert.deepEqual(write.data.tokenIds, [value.token.id]);
    assert.deepEqual(write.data.waypoints, [{ x: 2900, y: to }]);
    assert.equal(write.data.method, 'keyboard');
    assert.equal(write.data.movementMode, 'walk');
    assert.deepEqual(write.precondition.expectedOrigins, { [value.token.id]: { x: 2900, y: from, elevationMeters: 0 } });
    assert.equal(result.elapsedMs, 27);
    assert.deepEqual(result.from, { x: 2900, y: from });
    assert.deepEqual(result.to, { x: 2900, y: to });
    assert.equal(result.sourceTokenId, value.token.id);
  }
  assert.equal(value.writes.length, 2);
});

for (const code of ['revision_conflict', 'entity_conflict', 'path_blocked', 'persist_failed']) {
  test(`browser movement fails on ${code} without retrying and retains the refused attempt duration`, async () => {
    const value = movementRuntime({ dispatchError: Object.assign(new Error('authoritative refusal'), { code }) });
    await assert.rejects(browserBenchmarkMoveToken(value.api, 0, browserBenchmarkMovementTarget, value.now), error => {
      assert.equal(error.code, code);
      assert.equal(error.elapsedMs, 27);
      assert.match(error.message, /after 27\.000 ms/);
      return true;
    });
    assert.equal(value.writes.length, 1);
    assert.deepEqual([value.token.x, value.token.y], [2900, 2500]);
  });
}

test('browser movement rejects an acknowledged route if the canonical Token never reaches its target', async () => {
  const value = movementRuntime({ applyCommit: false });
  await assert.rejects(browserBenchmarkMoveToken(value.api, 0, browserBenchmarkMovementTarget, value.now),
    { code: 'benchmark_movement_target_mismatch', elapsedMs: 27 });
  assert.equal(value.writes.length, 1);
});

test('browser movement requires an explicit committed result even if a route claims it is valid', async () => {
  const value = movementRuntime();
  let calls = 0;
  value.api.movementFast = { async moveTokenPath() { calls += 1; return { valid: true }; } };
  await assert.rejects(browserBenchmarkMoveToken(value.api, 0, browserBenchmarkMovementTarget, value.now),
    { code: 'benchmark_movement_not_committed' });
  assert.equal(calls, 1);
  assert.equal(value.writes.length, 0);
});

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
