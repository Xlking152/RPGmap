import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../src/app/storage.js';
import { registerRuntimeStateReader } from '../src/engine/state-access.js';
import { bindRuntimeWorldCatalog } from '../src/runtime/world-catalog-sync.js';
import {
  WORLD_CATALOG_STORAGE_KEY, canonicalWorldStorageKey, createWorldCatalogManager,
  inspectWorldSave, inspectWorldStateHeader,
} from '../src/world/manager.js';

function fixture() {
  return { preferences: { worldV2: { id: 'world-a', name: 'Campaign',
    ruleset: { id: 'rules', version: '1' }, activeSceneId: 'scene-a',
    updatedAt: '2026-10-06T05:00:00.000Z', actors: [], statusDefinitions: [],
    scenes: [
      { id: 'scene-a', mapPackage: { id: 'map-a', version: '1' }, tokens: [], fog: {}, sceneEvents: [] },
      { id: 'scene-b', mapPackage: { id: 'map-b', version: '2' }, tokens: [], fog: {}, sceneEvents: [] },
    ],
  } } };
}

function managerFixture() {
  const storage = createMemoryStorage();
  const manager = createWorldCatalogManager(storage);
  manager.create({ id: 'world-a', name: 'Initial', ruleset: { id: 'rules', version: '1' },
    mapPackage: { id: 'map-a', version: '1' } });
  return { storage, manager };
}

test('internal header inspection matches external save inspection and returns detached metadata', () => {
  const state = fixture(), before = structuredClone(state);
  const header = inspectWorldStateHeader(state);
  assert.deepEqual(header, inspectWorldSave(JSON.stringify(state)));
  assert.deepEqual(state, before);
  assert.notEqual(header.ruleset, state.preferences.worldV2.ruleset);
  assert.notEqual(header.mapPackage, state.preferences.worldV2.scenes[0].mapPackage);
  assert.throws(() => { header.mapPackage.id = 'changed'; }, TypeError);
  assert.throws(() => { header.ruleset.version = 'changed'; }, TypeError);
  assert.equal('actors' in header, false);
  assert.equal('scenes' in header, false);
  assert.equal('preferences' in header, false);
});

test('internal catalog updates preserve external metadata behavior for rename and active-map changes', () => {
  for (const activeSceneId of ['scene-a', 'scene-b', 'unknown']) {
    const left = managerFixture(), right = managerFixture();
    right.storage.set(WORLD_CATALOG_STORAGE_KEY, left.storage.get(WORLD_CATALOG_STORAGE_KEY));
    const state = fixture();
    Object.assign(state.preferences.worldV2, { activeSceneId, name: ' Renamed campaign ' });
    const before = structuredClone(state);
    const external = left.manager.updateFromSave('world-a', JSON.stringify(state));
    const internal = right.manager.updateFromState('world-a', state);
    assert.deepEqual(internal, external);
    assert.deepEqual(right.manager.list(), left.manager.list());
    internal.ruleset.id = 'public mutation'; internal.mapPackage.id = 'public mutation';
    assert.equal(right.manager.get('world-a').ruleset.id, 'rules');
    assert.equal(right.manager.get('world-a').mapPackage.id, activeSceneId === 'scene-b' ? 'map-b' : 'map-a');
    assert.deepEqual(state, before);
  }
});

test('confirmed-save catalog listener never exports or traverses World documents', () => {
  const { storage, manager } = managerFixture();
  let state = fixture();
  const saved = JSON.stringify(state), saveKey = canonicalWorldStorageKey('world-a');
  storage.set(saveKey, saved);
  const handlers = new Map();
  const runtime = {
    exportState() { throw new Error('Catalog cannot invoke full export validation'); },
    getState() { throw new Error('Catalog cannot clone the complete public World'); },
    on(name, callback) { handlers.set(name, callback); return () => handlers.delete(name); },
  };
  let documentReads = 0;
  const trap = (source, key) => Object.defineProperty(source, key, { enumerable: true, configurable: true,
    get() { documentReads++; throw new Error(`Catalog cannot traverse ${key}`); } });
  const world = state.preferences.worldV2;
  for (const key of ['actors', 'statusDefinitions', 'content', 'library']) trap(world, key);
  for (const scene of world.scenes) for (const key of ['tokens', 'fog', 'sceneEvents', 'featureStates', 'occlusionShapes']) trap(scene, key);
  const unregister = registerRuntimeStateReader(runtime, () => state);
  try {
    const unbind = bindRuntimeWorldCatalog({ runtime, worldManager: manager, worldId: 'world-a' });
    assert.equal(manager.get('world-a').name, 'Campaign');
    assert.equal(manager.get('world-a').mapPackage.id, 'map-a');
    world.name = 'Saved rename'; world.activeSceneId = 'scene-b'; world.updatedAt = '2026-10-06T05:01:00.000Z';
    handlers.get('state:saved')();
    const descriptor = manager.get('world-a');
    assert.equal(descriptor.name, 'Saved rename');
    assert.deepEqual(descriptor.mapPackage, { id: 'map-b', version: '2' });
    assert.equal(descriptor.updatedAt, world.updatedAt);
    assert.equal(documentReads, 0);
    assert.equal(storage.get(saveKey), saved, 'catalog refresh never rewrites the authoritative save');
    unbind();
    assert.equal(handlers.has('state:saved'), false);
  } finally { unregister(); }
});

test('external malformed or missing-World saves retain existing catalog behavior', () => {
  const { manager } = managerFixture(), before = manager.list();
  assert.equal(inspectWorldSave('{broken'), null);
  assert.deepEqual(manager.updateFromSave('world-a', '{broken'), before[0]);
  assert.deepEqual(manager.updateFromSave('world-a', { preferences: {} }), before[0]);
  assert.deepEqual(manager.list(), before);
  assert.equal(manager.updateFromSave('missing-world', fixture()), null);
  assert.equal(manager.updateFromState('missing-world', fixture()), null);
});

test('runtime without a local World catalog does not read state or attach a save listener', () => {
  const runtime = { getState() { throw new Error('unexpected read'); }, on() { throw new Error('unexpected listener'); } };
  assert.equal(typeof bindRuntimeWorldCatalog({ runtime }), 'function');
  assert.equal(typeof bindRuntimeWorldCatalog({ runtime, worldManager: {}, worldId: '' }), 'function');
});
