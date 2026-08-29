import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyWorldOperationPatch,
  applyWorldOperations,
  createWorldOperationPatch,
  deriveWorldOperations,
  projectWorldOperationState,
} from '../src/world/operations.js';
import {
  applyFeatureStateMergePatch,
  migrateLegacySceneFeatureStates,
  stripLegacyFeatureStateProjection,
} from '../src/world/feature-states.js';
import { createEmptyWorldScene, normalizeWorldV2 } from '../src/world/model.js';
import { exportRuntimeState, prepareRuntimeState } from '../src/engine/runtime-state.js';
import { infiniteHorrorRuleset } from '../src/rulesets/infinite-horror/index.js';

const MAP = { id: 'map-a', version: '1.0.0', title: 'Map A' };

function scene(id, featureStates = {}) {
  return {
    id,
    name: id,
    mapPackage: { id: MAP.id, version: MAP.version },
    tokens: [],
    markers: [],
    attackAreas: [],
    sceneEvents: [],
    featureStates: structuredClone(featureStates),
    settings: { gridVisible: true },
  };
}

function state() {
  const world = {
    schemaVersion: 2,
    id: 'world-a',
    name: 'World A',
    ruleset: { id: 'infinite-horror', version: '1.0.0' },
    activeSceneId: 'scene-a',
    actors: [],
    statusDefinitions: [],
    scenes: [scene('scene-a'), scene('scene-b')],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  return projectWorldOperationState({
    saveVersion: 2,
    mapId: MAP.id,
    mapVersion: MAP.version,
    markers: [],
    attackAreas: [],
    sceneEvents: [],
    preferences: {
      worldV2: world,
      entitySystem: { schemaVersion: 3, actors: [], tokens: [], statusDefinitions: [] },
      combatSystem: { schemaVersion: 1, combat: null },
      chatSystem: { schemaVersion: 1, messages: [] },
    },
  });
}

test('scene.featureState.patch applies recursive JSON Merge Patch without copying damage state', () => {
  const initial = state();
  initial.preferences.worldV2.scenes[0].featureStates.gate = {
    open: false,
    custom: { blockingHeightFt: 20, extension: { channel: 1, retained: true } },
  };
  const applied = applyWorldOperations(initial, [{
    type: 'scene.featureState.patch',
    payload: {
      sceneId: 'scene-a',
      featureId: 'gate',
      patch: { open: true, custom: { blockingHeightFt: null, extension: { channel: 2 } } },
    },
  }]).state;
  assert.deepEqual(applied.preferences.worldV2.scenes[0].featureStates.gate, {
    open: true,
    custom: { extension: { channel: 2, retained: true } },
  });
  assert.deepEqual(applied.preferences.featureStates, applied.preferences.worldV2.scenes[0].featureStates);
  assert.equal(Object.hasOwn(applied.preferences.worldV2.scenes[0].featureStates.gate, 'status'), false);
  assert.deepEqual(applied.preferences.worldV2.scenes[1].featureStates, {});
});

test('Scene activation swaps the read-only Feature State projection and preserves A-B-A isolation', () => {
  let current = applyWorldOperations(state(), [{
    type: 'scene.featureState.patch', payload: { sceneId: 'scene-a', featureId: 'gate', patch: { open: true } },
  }]).state;
  current = applyWorldOperations(current, [
    { type: 'scene.activate', payload: { sceneId: 'scene-b' } },
    { type: 'scene.featureState.patch', payload: { sceneId: 'scene-b', featureId: 'gate', patch: { open: false, custom: { mode: 'b' } } } },
  ]).state;
  assert.deepEqual(current.preferences.featureStates.gate, { open: false, custom: { mode: 'b' } });
  current = applyWorldOperations(current, [{ type: 'scene.activate', payload: { sceneId: 'scene-a' } }]).state;
  assert.deepEqual(current.preferences.featureStates.gate, { open: true });
});

test('Feature State operation patches are targeted and replay without an entire Scene or World', () => {
  const before = state();
  const after = applyWorldOperations(before, [{
    type: 'scene.featureState.patch', payload: { featureId: 'gate', patch: { open: true } },
  }]).state;
  const patch = createWorldOperationPatch(before, after);
  assert.equal(patch.world.scenes.upsert.length, 0);
  assert.equal(patch.world.scenes.featureStates.length, 1);
  assert.deepEqual(applyWorldOperationPatch(before, patch).preferences.worldV2, after.preferences.worldV2);

  const derived = deriveWorldOperations(before, after);
  assert.deepEqual(derived.unsupported, []);
  assert.deepEqual(derived.operations.map(operation => operation.type), ['scene.featureState.patch']);
});

test('Feature State and Status side effects commit in one reducer batch', () => {
  const initial = state();
  const applied = applyWorldOperations(initial, [
    { type: 'scene.featureState.patch', payload: { featureId: 'gate', patch: { open: true } } },
    { type: 'status.apply', payload: { scope: 'actor', targetId: 'actor-a', statusId: 'ready' } },
  ], {
    applyStatus(current) {
      const next = structuredClone(current);
      next.preferences.statusExtension = { committed: true };
      return { state: next, results: [{ action: 'status.apply' }] };
    },
  });
  assert.equal(applied.state.preferences.worldV2.scenes[0].featureStates.gate.open, true);
  assert.equal(applied.state.preferences.statusExtension.committed, true);
  assert.equal(applied.results.length, 2);
});

test('legacy global Feature State migrates once to active Scene and preserves unknown fields', () => {
  const initial = state();
  initial.preferences.featureInteractions = { gate: { open: true, custom: { old: 1 } } };
  initial.preferences.featureStates = { gate: { custom: { extension: { module: 'x' } } } };
  const first = migrateLegacySceneFeatureStates(initial);
  assert.equal(first.migrated, true);
  assert.deepEqual(first.state.preferences.worldV2.scenes[0].featureStates.gate, {
    open: true,
    custom: { old: 1, extension: { module: 'x' } },
  });
  assert.deepEqual(first.state.preferences.worldV2.scenes[1].featureStates, {});
  assert.equal(Object.hasOwn(first.state.preferences, 'featureStates'), false);
  assert.equal(Object.hasOwn(first.state.preferences, 'featureInteractions'), false);
  const second = migrateLegacySceneFeatureStates(first.state);
  assert.equal(second.migrated, false);
  assert.deepEqual(second.state, first.state);
});

test('legacy migration conflict stops without mutating the original save', () => {
  const initial = state();
  initial.preferences.worldV2.scenes[0].featureStates.gate = { open: false };
  initial.preferences.featureStates = { gate: { open: true } };
  const original = structuredClone(initial);
  assert.throws(() => migrateLegacySceneFeatureStates(initial), {
    code: 'feature_state_migration_conflict',
  });
  assert.deepEqual(initial, original);
});

test('new and normalized Scenes always own Feature State records', () => {
  const initial = state().preferences.worldV2;
  delete initial.scenes[0].featureStates;
  initial.scenes[1].featureStates = { gate: { custom: { extension: { retained: true } } } };
  const normalized = normalizeWorldV2(initial, { mapPackage: MAP });
  assert.deepEqual(normalized.scenes[0].featureStates, {});
  assert.equal(normalized.scenes[1].featureStates.gate.custom.extension.retained, true);
  const withNewScene = createEmptyWorldScene(normalized, { mapPackage: MAP, id: 'scene-c' });
  assert.deepEqual(withNewScene.scenes.find(item => item.id === 'scene-c').featureStates, {});
});

test('Feature State patches reject unsafe, non-JSON and oversized input', () => {
  assert.throws(
    () => applyFeatureStateMergePatch({}, JSON.parse('{"__proto__":{"polluted":true}}')),
    { code: 'feature_state_patch_unsafe_key' },
  );
  assert.throws(() => applyFeatureStateMergePatch({}, { value: undefined }), {
    code: 'invalid_feature_state_patch',
  });
  let deep = { value: true };
  for (let index = 0; index < 14; index += 1) deep = { nested: deep };
  assert.throws(() => applyFeatureStateMergePatch({}, deep), { code: 'feature_state_patch_limit' });
});

test('durable state strips compatibility fields without changing canonical Scene data', () => {
  const initial = state();
  initial.preferences.worldV2.scenes[0].featureStates.gate = { open: true };
  initial.preferences.featureStates = { gate: { open: true } };
  const durable = stripLegacyFeatureStateProjection(initial);
  assert.equal(Object.hasOwn(durable.preferences, 'featureStates'), false);
  assert.deepEqual(durable.preferences.worldV2.scenes[0].featureStates.gate, { open: true });
  assert.equal(initial.preferences.featureStates.gate.open, true);
});

test('browser prepare, export and reload migrate once and keep only the Scene authority on disk', () => {
  const initial = state();
  initial.preferences.featureStates = { gate: { open: true, custom: { extension: 7 } } };
  const prepared = prepareRuntimeState(initial, { mapPackage: MAP, ruleset: infiniteHorrorRuleset });
  assert.equal(prepared.migrated, true);
  assert.equal(prepared.state.preferences.worldV2.scenes[0].featureStates.gate.custom.extension, 7);
  const exported = exportRuntimeState(prepared.state, { mapPackage: MAP, ruleset: infiniteHorrorRuleset });
  assert.equal(Object.hasOwn(exported.preferences, 'featureStates'), false);
  const reloaded = prepareRuntimeState(exported, { mapPackage: MAP, ruleset: infiniteHorrorRuleset });
  assert.equal(reloaded.migrated, false);
  assert.equal(reloaded.state.preferences.featureStates.gate.open, true);
  assert.equal(reloaded.state.preferences.worldV2.scenes[0].featureStates.gate.custom.extension, 7);
});
