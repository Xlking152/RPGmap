import test from 'node:test';
import assert from 'node:assert/strict';

import { createMemoryStorage } from '../src/app/storage.js';
import { createWorldStatePersistence, worldStateStorageKey } from '../src/app/world-storage.js';
import { canonicalWorldStorageKey, legacyMapWorldStorageKey } from '../src/world/manager.js';
import { createMinimalReferencePackage } from '../reference/maps/minimal/package.js';
import { infiniteHorrorRuleset } from '../src/rulesets/infinite-horror/index.js';

test('modern persistence is keyed by World id while map-key form remains legacy-compatible', () => {
  assert.equal(worldStateStorageKey('world-a'), canonicalWorldStorageKey('world-a'));
  assert.equal(worldStateStorageKey({ id: 'map-a' }), legacyMapWorldStorageKey('map-a'));

  const mapPackage = createMinimalReferencePackage();
  const storage = createMemoryStorage();
  const persistence = createWorldStatePersistence({
    worldId: 'world-a',
    worldName: 'World A',
    mapPackage,
    ruleset: infiniteHorrorRuleset,
    storageAdapter: storage,
    getState: () => null,
  });
  assert.equal(persistence.storageKey, canonicalWorldStorageKey('world-a'));
});
