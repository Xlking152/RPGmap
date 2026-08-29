import test from 'node:test';
import assert from 'node:assert/strict';

import { createMemoryStorage } from '../src/app/storage.js';
import {
  WORLD_CATALOG_STORAGE_KEY,
  canonicalWorldStorageKey,
  createWorldCatalogManager,
  legacyMapWorldStorageKey,
} from '../src/world/manager.js';

function stateFor({ worldId = 'world-a', activeSceneId = 'scene-a', mapId = 'map-a' } = {}) {
  return {
    saveVersion: 2,
    mapId,
    mapVersion: '1',
    markers: [], attackAreas: [], sceneEvents: [],
    preferences: {
      worldV2: {
        schemaVersion: 2,
        id: worldId,
        name: '测试 World',
        ruleset: { id: 'infinite-horror', version: '1.0.0' },
        activeSceneId,
        actors: [], statusDefinitions: [],
        scenes: [
          { id: 'scene-a', name: 'A', mapPackage: { id: 'map-a', version: '1' }, tokens: [], markers: [], attackAreas: [], sceneEvents: [], settings: {} },
          { id: 'scene-b', name: 'B', mapPackage: { id: 'map-b', version: '2' }, tokens: [], markers: [], attackAreas: [], sceneEvents: [], settings: {} },
        ],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    },
  };
}

test('World Manager creates/selects/removes descriptors with World-id storage keys', () => {
  const storage = createMemoryStorage();
  const manager = createWorldCatalogManager(storage, { idFactory: () => 'world-fixed' });
  const created = manager.create({
    name: '无限恐怖战役',
    ruleset: { id: 'infinite-horror', version: '1.0.0' },
    mapPackage: { id: 'map-a', version: '1' },
  });
  assert.equal(created.id, 'world-fixed');
  assert.equal(created.storageKey, canonicalWorldStorageKey('world-fixed'));
  assert.equal(manager.active().id, 'world-fixed');
  assert.ok(storage.get(WORLD_CATALOG_STORAGE_KEY));
  assert.equal(manager.remove('world-fixed'), true);
  assert.equal(manager.active(), null);
});

test('legacy map-key save is copied once into World-id storage and old key remains as backup', () => {
  const storage = createMemoryStorage();
  const raw = JSON.stringify(stateFor());
  storage.set(legacyMapWorldStorageKey('map-a'), raw);
  const manager = createWorldCatalogManager(storage, { idFactory: () => 'fallback-world' });
  const adopted = manager.adoptLegacyMapWorld({
    mapPackage: { id: 'map-a' },
    fallbackRuleset: { id: 'infinite-horror', version: '1.0.0' },
  });
  assert.equal(adopted.id, 'world-a');
  assert.equal(storage.get(adopted.storageKey), raw);
  assert.equal(storage.get(legacyMapWorldStorageKey('map-a')), raw);
});

test('offline cross-Map Scene activation updates the stored canonical World before reload', () => {
  const storage = createMemoryStorage();
  const manager = createWorldCatalogManager(storage, { idFactory: () => 'world-a' });
  const descriptor = manager.create({
    id: 'world-a', name: '测试 World',
    ruleset: { id: 'infinite-horror', version: '1.0.0' },
    mapPackage: { id: 'map-a', version: '1' },
  });
  storage.set(descriptor.storageKey, JSON.stringify(stateFor()));
  const target = manager.activateStoredScene('world-a', 'scene-b');
  const saved = JSON.parse(storage.get(descriptor.storageKey));
  assert.equal(target.id, 'scene-b');
  assert.equal(saved.preferences.worldV2.activeSceneId, 'scene-b');
  assert.equal(manager.active().mapPackage.id, 'map-b');
});
