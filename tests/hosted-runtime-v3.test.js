import test from 'node:test';
import assert from 'node:assert/strict';
import { hostedRuntimeAdapters } from '../src/adapters/hosted-runtime.js';
import { createHostedWorldSystem } from '../src/world/hosted-system.js';
import { createRuntimeSessionCore } from '../src/runtime/core/session-base.js';
import { infiniteHorrorRuleset as ruleset } from '../src/rulesets/infinite-horror/index.js';
import { applyWorldOperationsAsync } from '../src/world/operations.js';
import { deriveWorldOperations } from '../src/world/operation-intents.js';
import { registerRuntimeStateReader } from '../src/engine/state-access.js';

const mapPackage = { id: 'hosted-map', version: '1', width: 100, height: 100, features: [], metersPerUnit: 1 };
const rename = name => [{ type: 'world.rename', payload: { name } }];
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture({ connected = true, role = 'gm', gate = null } = {}) {
  let current = hostedRuntimeAdapters.prepare({ worldId: 'hosted-world', worldName: 'Initial', mapPackage, ruleset }).state;
  let revision = 0, connection = { connected, session: { role } };
  const calls = [], handlers = new Map();
  const api = {
    mapPackage, ruleset,
    getState: () => structuredClone(current), getStateRevision: () => revision,
    commitState(next) { calls.push(['local-commit']); current = structuredClone(next); revision++; },
    on(name, callback) { handlers.set(name, [...handlers.get(name) || [], callback]); },
    emit(name, detail) { for (const handler of handlers.get(name) || []) handler({ detail }); },
    multiplayer: {
      getConnectionState: () => connection,
      async performOperations(operations, options) {
        calls.push(['server-command', structuredClone(operations), options]);
        if (gate) await gate;
        if (connection.session.role !== 'gm') throw Object.assign(new Error('permission_denied'), { code: 'permission_denied' });
        const applied = await applyWorldOperationsAsync(current, operations, { ruleset, mapPackage, source: { role: 'gm' } });
        current = applied.state; revision++;
        return { revision, operationId: options.requestedOperationId, results: applied.results };
      },
      async fetchManagement(path, options) { calls.push(['management', path, options]); return { ok: true, json: async () => ({ id: 'server-backup' }) }; },
    },
  };
  api.commitAuthoritativeState = next => api.multiplayer.performOperations(deriveWorldOperations(current, next).operations, {});
  registerRuntimeStateReader(api, () => current);
  createHostedWorldSystem().register(api);
  return { api, calls, current: () => structuredClone(current), connect(value) { connection = value; } };
}

test('hosted commands cannot write before join, during reconnect or after explicit logout', async () => {
  const f = fixture({ connected: false }), before = f.current();
  for (const connection of [
    { connected: false, joining: true },
    { connected: false, retainsServerState: true },
    { connected: false, retainsServerState: false },
  ]) {
    f.connect(connection);
    await assert.rejects(f.api.world.performOperations(rename('Unauthorized local edit')), { code: 'world_reconnect_pending' });
    await assert.rejects(f.api.world.rename('Unauthorized full edit'), { code: 'world_reconnect_pending' });
    await assert.rejects(f.api.world.createSceneRecoveryPoint(f.api.world.get().activeSceneId), { code: 'world_reconnect_pending' });
  }
  assert.deepEqual(f.current(), before); assert.deepEqual(f.calls, []);
});

test('hosted commands snapshot intent and operation ID, retain canonical state until ACK and propagate server refusal', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const f = fixture({ gate }), request = rename('Confirmed');
  const pending = f.api.world.performOperations(request, { requestedOperationId: 'idempotent-hosted-op' });
  request[0].payload.name = 'caller mutation';
  await tick();
  assert.equal(f.api.world.get().name, 'Initial');
  assert.equal(f.calls[0][1][0].payload.name, 'Confirmed');
  assert.equal(f.calls[0][2].requestedOperationId, 'idempotent-hosted-op');
  release(); const result = await pending;
  assert.equal(result.operationId, 'idempotent-hosted-op'); assert.equal(f.api.world.get().name, 'Confirmed');
  const before = f.current(); f.connect({ connected: true, session: { role: 'player' } });
  await assert.rejects(f.api.world.performOperations(rename('Player overwrite')), { code: 'permission_denied' });
  assert.deepEqual(f.current(), before); assert.equal(f.calls.some(call => call[0] === 'local-commit'), false);
});

test('hosted Scene reset and switching fence unrelated commands and require a real server recovery point', async () => {
  const f = fixture(), sceneId = f.api.world.get().activeSceneId;
  f.api.emit('scene:reset-starting', { sceneId });
  await assert.rejects(f.api.world.performOperations(rename('during reset')), { code: 'scene_transition_pending' });
  assert.equal(f.calls.length, 0);
  assert.deepEqual(await f.api.world.createSceneRecoveryPoint(sceneId, { reason: 'scene.clear' }), { id: 'server-backup' });
  assert.deepEqual(JSON.parse(f.calls[0][2].body), { sceneId, reason: 'scene.clear' });
  f.api.emit('scene:reset-failed'); await f.api.world.performOperations(rename('after failure'));
  assert.equal(f.api.world.get().name, 'after failure');
  f.connect({ connected: true, session: { role: 'player' } });
  const callCount = f.calls.length;
  await assert.rejects(f.api.world.createSceneRecoveryPoint(sceneId), { code: 'scene_reset_gm_only' });
  assert.equal(f.calls.length, callCount);
});

test('hosted persistence never stores an audience projection or restores a local baseline', async () => {
  let connection = { connected: false };
  const initialLoad = { state: { audienceProjection: true }, blocked: false };
  const persistence = hostedRuntimeAdapters.persistence({ initialLoad, getApi: () => ({ multiplayer: { getConnectionState: () => connection } }) });
  assert.equal(persistence.load(), initialLoad);
  assert.equal(persistence.persistNow(), false);
  assert.throws(() => persistence.replace({ privateWorld: true }), { code: 'world_reconnect_pending' });
  assert.throws(() => persistence.setLocalExploration({ jobs: [] }), { code: 'world_reconnect_pending' });
  connection = { connected: true }; assert.equal(await persistence.persistValidatedAsync(), true);
  const isolation = hostedRuntimeAdapters.isolation();
  assert.equal(isolation.active, true); assert.equal(isolation.updateConnection({ connected: false, retainsServerState: false }), false);
  assert.equal(isolation.active, true);
});

test('pure Runtime session requires an explicit authority and disposal rejects later commands', async () => {
  assert.throws(() => createRuntimeSessionCore({ ruleset, mapForScene: () => mapPackage }), { code: 'runtime_authority_invalid' });
  const f = fixture(); f.api.emit('app:destroy');
  await assert.rejects(f.api.world.performOperations(rename('after disposal')), { code: 'world_operation_context_changed' });
  assert.equal(f.calls.length, 0);
});

test('hosted Scene creation keeps other map versions isolated and does not change the active Scene', async () => {
  const f = fixture(), originalId = f.api.world.get().activeSceneId;
  const otherMap = { ...mapPackage, id: 'other-hosted-map', version: '2' };
  const otherScene = await f.api.world.createScene({ id: 'other-scene', name: 'Other map', mapPackage: otherMap });
  assert.equal(otherScene.mapPackage.id, otherMap.id);
  assert.equal(otherScene.mapPackage.version, '2');
  assert.equal(f.api.world.get().activeSceneId, originalId);
  await assert.rejects(f.api.world.setActiveScene(otherScene.id), { code: 'world_scene_map_reload_required' });
  assert.equal(f.api.world.get().activeSceneId, originalId);
  const second = await f.api.world.createScene({ id: 'same-map-scene', name: 'Independent Scene' });
  await f.api.world.setActiveScene(second.id);
  assert.equal(f.api.world.get().activeSceneId, second.id);
  assert.equal(f.api.world.isSceneTransitionPending(), false);
  await f.api.world.setActiveScene(originalId);
  assert.equal(f.api.world.get().activeSceneId, originalId);
});
