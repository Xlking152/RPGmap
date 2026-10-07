import test from 'node:test';
import assert from 'node:assert/strict';
import { createFeatureOperations } from '../src/interaction/operations.js';
import { createFeatureInteractionSystem } from '../src/interaction/system.js';
import { applyWorldOperations, projectWorldOperationState } from '../src/world/operations.js';
import { registerRuntimeStateReader } from '../src/engine/state-access.js';

function fixture() {
  const features = Array.from({ length: 103 }, (_, index) => ({ id: `feature-${index}`, name: `Building ${index}`,
    category: 'building', geometry: { points: [[index, 0], [index + 1, 0], [index + 1, 1], [index, 1]] },
    capabilities: { destructible: true, inspectable: true } }));
  const mapPackage = { id: 'map', version: '1', width: 200, height: 200, metersPerUnit: 1, features };
  const scene = { id: 'scene', mapPackage: { id: 'map', version: '1' }, tokens: [], markers: [], attackAreas: [],
    sceneEvents: [{ id: 'first', type: 'damage', objectIds: ['feature-0'], clipHits: [] }],
    featureStates: { 'feature-0': { custom: { nested: { value: 'private' } } } }, settings: {} };
  let state = projectWorldOperationState({ preferences: { worldV2: { schemaVersion: 4, id: 'world', name: 'World',
    ruleset: { id: 'test', version: '1' }, activeSceneId: scene.id, actors: [], statusDefinitions: [], scenes: [scene] } } });
  let revision = 1, clones = 0, reads = 0;
  const ports = { mapPackage,
    getState() { clones++; return structuredClone(state); },
    readState() { reads++; return state; },
    getStateRevision: () => revision,
    replaceState() { throw new Error('Modern operations must submit an authority operation'); },
    performOperations(batch) {
      const applied = applyWorldOperations(state, batch, { mapPackage, source: { role: 'offline' } });
      state = applied.state; revision++; return applied;
    },
  };
  return { ports, state: () => state, clones: () => clones, reads: () => reads, revision: () => revision,
    replace(next, advance = true) { state = next; if (advance) revision++; }, advance() { revision++; } };
}

test('103 Feature reads share one revision-qualified canonical replay without cloning the World', () => {
  const value = fixture(), operations = createFeatureOperations(value.ports);
  value.state().sceneEvents = [];
  const prepared = operations.readContext();
  for (const feature of value.ports.mapPackage.features) {
    const current = operations.stateForFeature(feature.id, prepared);
    assert.equal(current.destroyed, feature.id === 'feature-0');
  }
  assert.equal(value.clones(), 0);
  assert.equal(value.reads(), 1);
  assert.equal(operations.readContext(), prepared);
  // Revisions also qualify a mutation of the same private state object.
  value.state().preferences.worldV2.scenes[0].sceneEvents.push({ id: 'second', type: 'damage', objectIds: ['feature-2'], clipHits: [] });
  value.advance();
  assert.notEqual(operations.readContext(), prepared);
  assert.equal(operations.stateForFeature('feature-2').destroyed, true);
  const current = operations.readContext();
  value.replace(structuredClone(value.state()), false);
  assert.notEqual(operations.readContext(), current, 'a changed state identity also invalidates the context');
  operations.dispose();
  assert.notEqual(operations.readContext(), current);
});

test('public Feature state and snapshots cannot change authoritative custom data or Map geometry', () => {
  const value = fixture(), operations = createFeatureOperations(value.ports);
  const before = structuredClone(value.state()), mapBefore = structuredClone(value.ports.mapPackage);
  const state = operations.stateForFeature('feature-0');
  state.custom.nested.value = 'client mutation';
  const snapshot = operations.snapshot('feature-0');
  snapshot.featureState.custom.nested.value = 'snapshot mutation';
  snapshot.feature.geometry.points[0][0] = 999;
  snapshot.feature.capabilities.destructible = false;
  assert.deepEqual(value.state(), before);
  assert.deepEqual(value.ports.mapPackage, mapBefore);
  assert.equal(operations.stateForFeature('feature-0').custom.nested.value, 'private');
  assert.equal(value.clones(), 0);
});

test('mutable legacy ports never reuse stale destruction results without a committed revision', () => {
  const value = fixture();
  const operations = createFeatureOperations({ ...value.ports, readState: null, getStateRevision: null,
    getState: value.state });
  const first = operations.readContext();
  value.state().preferences.worldV2.scenes[0].sceneEvents.length = 0;
  assert.equal(operations.stateForFeature('feature-0').destroyed, false);
  assert.notEqual(operations.readContext(), first);
});

test('status and permission decisions remain fresh when the shared geometric read context is reused', () => {
  const value = fixture();
  let allowed = true;
  const operations = createFeatureOperations({ ...value.ports,
    resolveStatus: () => ({ statuses: [], capabilities: { canInteract: allowed } }) });
  const prepared = operations.readContext();
  assert.equal(operations.actionsForFeature('feature-1', { tokenId: 'token' }).find(action => action.id === 'damage').enabled, true);
  allowed = false;
  assert.equal(operations.readContext(), prepared);
  assert.equal(operations.actionsForFeature('feature-1', { tokenId: 'token' }).find(action => action.id === 'damage').enabled, false);
});

test('damage, restoration and patches keep immutable inputs while using one detached command snapshot', async () => {
  const value = fixture(), operations = createFeatureOperations(value.ports);
  const original = value.state(), before = structuredClone(original);
  assert.equal((await operations.damage('feature-1')).ok, true);
  assert.deepEqual(original, before);
  assert.equal(value.clones(), 1, 'one detached command input replaces per-Feature copies');
  const damaged = value.state(), damagedBefore = structuredClone(damaged);
  assert.equal((await operations.restore('feature-1')).ok, true);
  assert.deepEqual(damaged, damagedBefore);
  assert.equal(value.clones(), 2);
  const restored = value.state(), restoredBefore = structuredClone(restored);
  await operations.patchState('feature-0', { custom: { nested: { value: 'changed' } } });
  assert.deepEqual(restored, restoredBefore);
  assert.equal(operations.stateForFeature('feature-0').custom.nested.value, 'changed');
});

test('real Feature visual synchronization replays once and refreshes authoritative Scene history and activation', async () => {
  const value = fixture(), nodes = value.ports.mapPackage.features.map(feature => ({ dataset: { featureId: feature.id },
    classList: { toggle() {} }, attributes: new Map(), setAttribute(name, item) { this.attributes.set(name, item); }, removeAttribute() {} }));
  let eventTypeReads = 0;
  Object.defineProperty(value.state().preferences.worldV2.scenes[0].sceneEvents[0], 'type', {
    enumerable: true, get() { eventTypeReads++; return 'damage'; },
  });
  let visualPasses = 0;
  const listeners = new Map(), shell = { querySelectorAll: () => { visualPasses++; return nodes; }, querySelector: () => null };
  const container = { closest: () => shell };
  const api = { mapPackage: value.ports.mapPackage, getState: value.ports.getState,
    getStateRevision: value.ports.getStateRevision, map: { getContainer: () => container, on() {}, off() {} },
    tokens: { list: () => [], resolveActor() {} }, movement: { canonicalSceneTokens: true },
    world: { performOperations: value.ports.performOperations },
    on(name, callback) { listeners.set(name, [...(listeners.get(name) || []), callback]); return () => {}; },
    emit(name, detail) { for (const callback of listeners.get(name) || []) callback({ detail }); },
  };
  const unregister = registerRuntimeStateReader(api, value.state);
  try {
    createFeatureInteractionSystem().register(api);
    assert.equal(value.clones(), 0, 'initial 103-Feature visual pass cannot request full public snapshots');
    assert.equal(eventTypeReads, 2, 'scene replay reads each event in its two validation/application passes only once');
    api.interaction.syncVisualState();
    assert.equal(eventTypeReads, 2, 'the current revision reuses the derived geometry across complete visual passes');
    assert.equal(nodes[0].attributes.get('data-feature-state'), 'destroyed');
    assert.equal(nodes[1].attributes.get('data-feature-state'), 'intact');
    const output = api.interaction.stateForFeature('feature-0'); output.custom.nested.value = 'outside';
    assert.equal(api.interaction.stateForFeature('feature-0').custom.nested.value, 'private');
    const next = structuredClone(value.state());
    next.preferences.worldV2.scenes[0].sceneEvents.push({ id: 'restore', type: 'restore', featureIds: ['feature-0'] });
    value.replace(projectWorldOperationState(next));
    api.emit('scene:restore', null);
    assert.equal(nodes[0].attributes.get('data-feature-state'), 'intact');
    const damaged = structuredClone(value.state());
    damaged.preferences.worldV2.scenes[0].sceneEvents.push({ id: 'remote-damage', type: 'damage', objectIds: ['feature-1'], clipHits: [] });
    value.replace(projectWorldOperationState(damaged));
    api.emit('scene:content-change', { sceneId: 'scene', types: ['SceneEvent'] });
    assert.equal(nodes[1].attributes.get('data-feature-state'), 'destroyed', 'remote destruction only emits the canonical document event');
    assert.equal(api.interaction.stateForFeature('feature-1').destroyed, true);
    const restored = structuredClone(value.state());
    restored.preferences.worldV2.scenes[0].sceneEvents.push({ id: 'remote-restore', type: 'restore', featureIds: ['feature-1'] });
    value.replace(projectWorldOperationState(restored));
    api.emit('scene:content-change', { sceneId: 'scene', types: ['SceneEvent'] });
    assert.equal(nodes[1].attributes.get('data-feature-state'), 'intact', 'remote restoration does not need a local scene:restore event');
    const unchangedPasses = visualPasses;
    api.emit('scene:content-change', { sceneId: 'other-scene', types: ['SceneEvent'] });
    api.emit('scene:content-change', { sceneId: 'scene', types: ['AttackArea'] });
    api.emit('token:move', { tokenId: 'token' });
    assert.equal(visualPasses, unchangedPasses, 'unrelated documents and token hot paths do not resynchronize all Features');
    const switched = structuredClone(value.state());
    const otherScene = { ...structuredClone(switched.preferences.worldV2.scenes[0]), id: 'scene-b',
      sceneEvents: [{ id: 'other-damage', type: 'damage', objectIds: ['feature-2'], clipHits: [] }],
      featureStates: { 'feature-0': { custom: { nested: { value: 'scene-b' } } } } };
    switched.preferences.worldV2.scenes.push(otherScene);
    switched.preferences.worldV2.activeSceneId = otherScene.id;
    value.replace(projectWorldOperationState(switched));
    api.emit('scene:activate', { sceneId: otherScene.id, canonical: true });
    assert.equal(nodes[1].attributes.get('data-feature-state'), 'intact');
    assert.equal(nodes[2].attributes.get('data-feature-state'), 'destroyed', 'scene activation invalidates prior damage results');
    assert.equal(api.interaction.stateForFeature('feature-0').custom.nested.value, 'scene-b');
    assert.equal(value.clones(), 0);
    api.emit('app:destroy', null);
    await Promise.resolve();
  } finally { unregister(); }
});
