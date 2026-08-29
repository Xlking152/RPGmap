import test from 'node:test';
import assert from 'node:assert/strict';

import { createSceneManagerSystem } from '../src/scene/manager.js';

function fixture() {
  let world = {
    activeSceneId: 'scene-a',
    scenes: [
      { id: 'scene-a', name: 'A', mapPackage: { id: 'map-a', version: '1' } },
      { id: 'scene-a2', name: 'A2', mapPackage: { id: 'map-a', version: '1' } },
      { id: 'scene-b', name: 'B', mapPackage: { id: 'map-b', version: '2' } },
    ],
  };
  const calls = { setActive: [], stored: [], reload: 0, persist: 0, create: [] };
  const api = {
    mapPackage: { id: 'map-a', version: '1' },
    map: { getContainer: () => null },
    world: {
      get: () => structuredClone(world),
      listScenes: () => structuredClone(world.scenes),
      getActiveScene: () => structuredClone(world.scenes.find(scene => scene.id === world.activeSceneId)),
      async setActiveScene(id) { calls.setActive.push(id); world.activeSceneId = id; return structuredClone(world.scenes.find(scene => scene.id === id)); },
      async createScene(options) { calls.create.push(options); return { id: 'created', ...options }; },
    },
    persistNow() { calls.persist += 1; },
    emit() {},
  };
  const mapPackages = {
    list: () => [{ id: 'map-a' }, { id: 'map-b' }],
    async load(ref) { return { id: ref.id, version: ref.id === 'map-b' ? '2' : '1', createSvg() {} }; },
  };
  const manager = {
    activateStoredScene(worldId, sceneId) { calls.stored.push([worldId, sceneId]); return { id: sceneId }; },
  };
  createSceneManagerSystem({
    mapPackages,
    worldCatalogManager: manager,
    worldId: 'world-a',
    reload: () => { calls.reload += 1; },
  }).register(api);
  return { api, calls };
}

test('same-Map Scene activation stays inside the current Runtime', async () => {
  const { api, calls } = fixture();
  await api.scenes.activate('scene-a2');
  assert.deepEqual(calls.setActive, ['scene-a2']);
  assert.equal(calls.reload, 0);
});

test('cross-Map offline Scene activation updates stored World and reloads Runtime', async () => {
  const { api, calls } = fixture();
  await api.scenes.activate('scene-b');
  assert.equal(calls.persist, 1);
  assert.deepEqual(calls.stored, [['world-a', 'scene-b']]);
  assert.equal(calls.reload, 1);
});

test('Scene creation resolves its target package through MapPackage Registry', async () => {
  const { api, calls } = fixture();
  await api.scenes.create({ name: 'B Scene', mapPackage: { id: 'map-b', version: '2' } });
  assert.equal(calls.create[0].name, 'B Scene');
  assert.equal(calls.create[0].mapPackage.id, 'map-b');
});
