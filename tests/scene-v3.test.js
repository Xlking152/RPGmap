import test from 'node:test';
import assert from 'node:assert/strict';
import { applyWorldOperations, projectWorldOperationState } from '../src/world/operations.js';
import { createEmptyWorldScene, normalizeWorldV2, projectWorldV2ToRuntimeState } from '../src/world/model.js';
import { createDefaultSceneSettings } from '../src/world/scene-defaults.js';
import { normalizeFogState, computeFogExploration } from '../src/vision/fog.js';
import { createMovementAuthority } from '../src/movement/authority.js';
import { createExplorationOperationCapture } from '../src/vision/exploration-operations.js';
import { createDocumentChanges, applyDocumentChanges } from '../src/documents/changes.js';
import { worldOperationsToDocumentWrites, documentWritesToWorldOperations } from '../src/documents/protocol.js';
import { restoreCurrentSceneEnvironment, clearCurrentScene } from '../src/ui/scene-reset.js';
import { createSceneManagerSystem } from '../src/scene/manager.js';
import { createWorldSystem } from '../src/world/system.js';
import { infiniteHorrorRuleset as ruleset } from '../src/rulesets/infinite-horror/index.js';

const map = { id: 'sample', version: '1', width: 100, height: 100, metersPerUnit: 1, features: [] };
const NOW = '2026-10-13T00:00:00.000Z';

test('direct projection rejects a different map version without changing either input', () => {
  const initial = state(), world = initial.preferences.worldV2;
  const before = structuredClone(initial);
  assert.throws(() => projectWorldV2ToRuntimeState(initial, world, { mapPackage: { ...map, version: '2' }, ruleset }),
    { code: 'world_scene_map_reload_required' });
  assert.deepEqual(initial, before);
  assert.equal(projectWorldV2ToRuntimeState(initial, world, { mapPackage: map, ruleset }).mapVersion, '1');
});

function scene(id) {
  return {
    id, name: id, mapPackage: { id: map.id, version: map.version },
    tokens: [{ id: `token-${id}`, actorId: 'actor', actorLink: true, actorDelta: null,
      placement: 'map', x: 5, y: 5, elevationMeters: 0, diameterMeters: 1, effects: [],
      vision: { enabled: true, preciseRangeOverrideMeters: 10, vagueRangeOverrideMeters: 10 } }],
    markers: [{ id: 'note', x: 3, y: 4, kind: 'note' }],
    attackAreas: [{ id: 'area', origin: { x: 5, y: 5 }, anchor: { type: 'token', tokenId: `token-${id}` } }],
    sceneEvents: [{ id: 'damage', type: 'damage' }],
    featureStates: { gate: { open: true, custom: { blockingHeightMeters: 1 } } },
    occlusionShapes: [{ id: 'obstacle', kind: 'building', points: [[30, 30], [33, 30], [33, 33], [30, 33]], blockingHeightMeters: 2 }],
    fog: normalizeFogState({ exploredByParty: { party: { rows: { 0: [[0, 5]] } } } }),
    settings: { gridVisible: false, lineOfSightEnabled: true, movementBudgetMetersPerTurn: 10,
      defaultDoorInteractionRangeMeters: 4, lighting: 'dim' },
  };
}

function state() {
  const world = {
    schemaVersion: 4, id: 'world', name: 'World', ruleset: { id: ruleset.id, version: ruleset.version },
    activeSceneId: 'a', actors: [{ id: 'actor', name: 'Scout', partyId: 'party', effects: [] }],
    statusDefinitions: [], scenes: [scene('a'), scene('b')], journals: [{ id: 'journal', title: 'Journal', bodyRef: `body:${'0'.repeat(64)}` }],
    createdAt: NOW, updatedAt: NOW,
  };
  return projectWorldOperationState({ preferences: { worldV2: world,
    combatSystem: { schemaVersion: 1, combat: { combatants: [{ tokenId: 'token-a', actorId: 'actor' }], turnIndex: 0 } },
    chatSystem: { schemaVersion: 1, messages: [{ id: 'message', text: 'history' }] } } });
}

for (const [type, clear] of [['scene.environment.reset', false], ['scene.clear', true]]) {
  test(`${type} keeps World identity and other Scenes, resetting exactly the declared fields`, () => {
    const initial = state(), before = structuredClone(initial);
    const operation = { type, payload: { sceneId: 'a', expectedActiveSceneId: 'a' } };
    const writes = worldOperationsToDocumentWrites([operation]);
    assert.deepEqual(documentWritesToWorldOperations(writes), [operation]);
    const applied = applyWorldOperations(initial, [operation], { source: { role: 'gm' }, now: NOW });
    const world = applied.state.preferences.worldV2, restored = world.scenes[0], original = before.preferences.worldV2;
    for (const field of ['id', 'name', 'mapPackage']) assert.deepEqual(restored[field], original.scenes[0][field]);
    for (const field of ['sceneEvents', 'occlusionShapes']) assert.deepEqual(restored[field], []);
    assert.deepEqual(restored.featureStates, {});
    assert.deepEqual(restored.fog, normalizeFogState());
    for (const field of ['tokens', 'markers', 'attackAreas']) assert.deepEqual(restored[field], clear ? [] : original.scenes[0][field]);
    assert.deepEqual(restored.settings, clear ? createDefaultSceneSettings() : original.scenes[0].settings);
    for (const field of ['id', 'name', 'ruleset', 'activeSceneId', 'actors', 'journals']) assert.deepEqual(world[field], original[field]);
    assert.deepEqual(world.scenes[1], original.scenes[1]);
    assert.deepEqual(applied.state.preferences.chatSystem, before.preferences.chatSystem);
    assert.deepEqual(applied.state.preferences.combatSystem.combat, clear ? null : before.preferences.combatSystem.combat);
    assert.deepEqual(initial, before);
    const replayed = applyDocumentChanges(initial, createDocumentChanges(initial, applied.state), { updatedAt: NOW });
    assert.deepEqual(replayed.preferences.worldV2, world);
    assert.deepEqual(applyWorldOperations(applied.state, [operation], { source: { role: 'offline' }, now: NOW }).state, applied.state);
  });

  test(`${type} rejects unauthorized, missing and switched targets without partial mutation`, () => {
    const initial = state(), before = structuredClone(initial);
    const reset = { type, payload: { sceneId: 'a' } };
    assert.throws(() => applyWorldOperations(initial, [reset], { source: { role: 'player' } }), { code: 'scene_reset_gm_only' });
    assert.throws(() => applyWorldOperations(initial, [reset], {}), { code: 'scene_reset_gm_only' });
    assert.throws(() => applyWorldOperations(initial, [reset, { type, payload: { sceneId: 'missing' } }], { source: { role: 'gm' } }), { code: 'scene_not_found' });
    assert.throws(() => applyWorldOperations(initial, [{ type, payload: { sceneId: 'b', expectedActiveSceneId: 'a' } }], { source: { role: 'gm' } }), { code: 'scene_content_conflict' });
    assert.deepEqual(initial, before);
  });
}

test('Scene clear uses the same settings as creating a fresh Scene', () => {
  const normalized = normalizeWorldV2(state().preferences.worldV2, { mapPackage: map, ruleset });
  const world = createEmptyWorldScene(normalized, { mapPackage: map, id: 'new' });
  assert.deepEqual(world.scenes.at(-1).settings, createDefaultSceneSettings());
});

test('new reset cancels previously queued exploration; environment restore captures current retained Token vision', () => {
  for (const type of ['scene.environment.reset', 'scene.clear']) {
    const capture = createExplorationOperationCapture({ sourceIds: ['token-a'], ruleset, mapForScene: () => map });
    applyWorldOperations(state(), [{ type, payload: { sceneId: 'a' } }], {
      source: { role: 'offline' }, ruleset, mapPackage: map,
      prepareOperation: capture.prepareOperation, onOperationApplied: capture.onOperationApplied,
    });
    assert.deepEqual(capture.events[0], { type: 'cancel', sceneId: 'a', partyId: null });
    assert.equal(capture.events.filter(event => event.type === 'explore').length, type === 'scene.clear' ? 0 : 1);
    if (type === 'scene.environment.reset') assert.deepEqual(capture.events[1].path, [{ x: 5, y: 5, elevationMeters: 0 }]);
  }
});

function resetFixture() {
  let active = { id: 'a', name: 'Map' };
  const calls = [];
  const api = { world: { getActiveScene: () => active,
    createSceneRecoveryPoint: async (id, options) => { calls.push(['backup', id, options]); return { id: 'recovery' }; },
    performOperations: async operations => { calls.push(['operation', operations]); } },
    emit: (...args) => calls.push(['event', ...args]), showToast: (...args) => calls.push(['toast', ...args]) };
  return { api, calls, switchScene() { active = { id: 'b' }; } };
}

for (const [reset, type] of [[restoreCurrentSceneEnvironment, 'scene.environment.reset'], [clearCurrentScene, 'scene.clear']]) {
  test(`${type} UI persists recovery before submitting; cancellation, backup failure and Scene switch submit nothing`, async () => {
    const cancelled = resetFixture();
    assert.equal(await reset(cancelled.api, () => false), false);
    assert.deepEqual(cancelled.calls, []);
    const f = resetFixture();
    assert.equal(await reset(f.api, () => true), true);
    assert.equal(f.calls[0][0], 'backup');
    assert.deepEqual(f.calls.find(call => call[0] === 'operation')[1], [{ type, payload: { sceneId: 'a', expectedActiveSceneId: 'a' } }]);
    const failed = resetFixture();
    failed.api.world.createSceneRecoveryPoint = async () => { throw new Error('disk full'); };
    await assert.rejects(reset(failed.api, () => true), /disk full/);
    assert.deepEqual(failed.calls, []);
    const noStore = resetFixture(); delete noStore.api.world.createSceneRecoveryPoint;
    await assert.rejects(reset(noStore.api, () => true), { code: 'recovery_point_required' });
    assert.deepEqual(noStore.calls, []);
    const switched = resetFixture();
    switched.api.world.createSceneRecoveryPoint = async () => { switched.switchScene(); return { id: 'recovery' }; };
    await assert.rejects(reset(switched.api, () => true), { code: 'scene_content_conflict' });
    assert.deepEqual(switched.calls, []);
    const player = resetFixture(); player.api.multiplayer = { getStatus: () => ({ connected: true, role: 'player' }) };
    await assert.rejects(reset(player.api, () => { assert.fail('must deny before confirmation'); }), { code: 'scene_reset_gm_only' });
  });
}

function managerFixture({ missing = false, connected = false } = {}) {
  let world = { id: 'world', activeSceneId: 'a', scenes: [
    { id: 'a', mapPackage: { id: map.id, version: '1' } },
    { id: 'b', mapPackage: { id: map.id, version: '2' } },
  ] };
  const calls = [];
  const api = { mapPackage: map, map: { getContainer: () => null },
    multiplayer: { getStatus: () => ({ connected, role: 'gm' }) },
    world: { get: () => structuredClone(world), listScenes: () => world.scenes,
      getActiveScene: () => world.scenes.find(scene => scene.id === world.activeSceneId),
      setActiveScene: async id => calls.push(['setActive', id]),
      performOperations: async ops => calls.push(['operations', ops]), createScene: async options => options },
    persistNow: () => { calls.push(['persist']); return true; }, emit: (...args) => calls.push(['event', ...args]) };
  const registry = { list: () => [map, { ...map, version: '2' }], load: async ref => {
    calls.push(['load', structuredClone(ref)]);
    if (missing) throw Object.assign(new Error('Missing map'), { code: 'map_package_not_found' });
    return { ...map, version: ref.version };
  } };
  createSceneManagerSystem({ mapPackages: registry, worldId: 'world',
    worldCatalogManager: { activateStoredScene: (worldId, sceneId) => { calls.push(['stored', worldId, sceneId]); world.activeSceneId = sceneId; } },
    reload: () => calls.push(['reload']) }).register(api);
  calls.length = 0;
  return { api, calls };
}

for (const connected of [false, true]) {
  test(`same-map DIFFERENT-VERSION activation preflights and reloads ${connected ? 'LAN' : 'offline'} Runtime`, async () => {
    const f = managerFixture({ connected });
    await f.api.scenes.activate('b');
    assert.deepEqual(f.calls[0], ['load', { id: map.id, version: '2' }]);
    assert.equal(f.calls.some(call => call[0] === 'setActive'), false);
    assert.equal(f.calls.at(-1)[0], 'reload');
    assert.equal(f.calls.some(call => call[0] === (connected ? 'operations' : 'stored')), true);
    const failed = managerFixture({ connected, missing: true });
    await assert.rejects(failed.api.scenes.activate('b'), { code: 'map_package_not_found' });
    assert.deepEqual(failed.calls.map(call => call[0]), ['load']);
    assert.equal(failed.api.world.get().activeSceneId, 'a');
  });
}

test('offline World recovery delegates an immutable snapshot and fails closed without storage', async () => {
  let current = state();
  const api = { mapPackage: map, ruleset, getState: () => structuredClone(current),
    commitState: value => { current = structuredClone(value); } };
  createWorldSystem().register(api);
  await assert.rejects(api.world.createSceneRecoveryPoint('a'), { code: 'recovery_point_required' });
  let captured;
  api.saveSceneRecoveryPoint = async input => { captured = input; return { id: 'saved' }; };
  assert.deepEqual(await api.world.createSceneRecoveryPoint('a', { reason: 'scene.clear' }), { id: 'saved' });
  assert.equal(captured.worldId, 'world'); assert.equal(captured.sceneId, 'a'); assert.equal(captured.reason, 'scene.clear');
  captured.state.preferences.worldV2.scenes[0].tokens.length = 0;
  assert.equal(api.world.getActiveScene().tokens.length, 1);
  api.saveSceneRecoveryPoint = async () => false;
  await assert.rejects(api.world.createSceneRecoveryPoint('a'), { code: 'recovery_point_failed' });
});

test('LAN recovery uses the authenticated management API and denies a Player before requesting a backup', async () => {
  let current = state(), connection = { connected: true, role: 'gm' };
  const calls = [];
  const api = { mapPackage: map, ruleset, getState: () => structuredClone(current),
    commitState: value => { current = structuredClone(value); },
    multiplayer: { getConnectionState: () => connection,
      fetchManagement: async (path, options) => { calls.push([path, options]); return { ok: true, json: async () => ({ id: 'backup' }) }; } } };
  createWorldSystem().register(api);
  assert.deepEqual(await api.world.createSceneRecoveryPoint('a', { reason: 'scene.clear' }), { id: 'backup' });
  assert.equal(calls[0][0], '/api/manage/worlds/scene-backup');
  assert.deepEqual(JSON.parse(calls[0][1].body), { sceneId: 'a', reason: 'scene.clear' });
  connection = { connected: true, role: 'player' };
  await assert.rejects(api.world.createSceneRecoveryPoint('a'), { code: 'scene_reset_gm_only' });
  assert.equal(calls.length, 1);
  connection = { connected: true, role: 'gm' };
  api.multiplayer.fetchManagement = async () => ({ ok: false, json: async () => ({ error: 'disk_full' }) });
  await assert.rejects(api.world.createSceneRecoveryPoint('a'), /disk_full/);
});

for (const type of ['scene.environment.reset', 'scene.clear']) {
  test(`${type} invalidates in-flight background exploration and cannot resurrect old Fog`, async () => {
    const previousWorker = globalThis.Worker;
    let request;
    globalThis.Worker = class {
      postMessage(message) { request = { worker: this, message }; }
      terminate() {}
    };
    try {
      let current = state();
      const handlers = new Map();
      const api = { mapPackage: map, ruleset, getState: () => structuredClone(current),
        commitState: value => { current = structuredClone(value); }, persistNow: () => true,
        on(name, callback) { const list = handlers.get(name) || []; list.push(callback); handlers.set(name, list); },
        emit(name, detail) { for (const callback of handlers.get(name) || []) callback({ detail }); } };
      createWorldSystem().register(api);
      const pending = api.world.performOperations([{ type: 'scene.fog.explore', payload: { sceneId: 'a', partyId: 'party',
        x: 80, y: 80, radiusMeters: 10 } }]);
      assert.ok(request);
      const late = request;
      await api.world.performOperations([{ type, payload: { sceneId: 'a' } }]);
      late.worker.onmessage({ data: { id: late.message.id, result: computeFogExploration(late.message.input) } });
      assert.equal((await pending).unchanged, true);
      assert.deepEqual(api.world.getActiveScene().fog, normalizeFogState());
      assert.equal(api.world.getActiveScene().tokens.length, type === 'scene.clear' ? 0 : 1);
      api.emit('app:destroy');
    } finally { globalThis.Worker = previousWorker; }
  });
}

test('restoring a wall reports colliding retained Tokens without rewriting their position or state', () => {
  const initial = state();
  const wallMap = { ...map, features: [{ id: 'wall', category: 'wall', mode: 'clip',
    geometry: { type: 'polygon', points: [[0, 0], [12, 0], [12, 12], [0, 12]] },
    capabilities: { navigation: { blocks: true, blockingHeightMeters: 4 } } }] };
  const validate = createMovementAuthority(() => wallMap);
  const tokenBefore = structuredClone(initial.preferences.worldV2.scenes[0].tokens[0]);
  const result = applyWorldOperations(initial, [{ type: 'scene.environment.reset', payload: { sceneId: 'a' } }], {
    source: { role: 'gm' }, ruleset, mapPackage: wallMap,
    validateTokenMovePath: args => validate({ ...args, ruleset }),
  });
  assert.deepEqual(result.state.preferences.worldV2.scenes[0].tokens[0], tokenBefore);
  assert.deepEqual(result.results[0].positionConflicts, ['token-a']);
});
