import test from 'node:test';
import assert from 'node:assert/strict';

import { createInitialState } from '../src/engine/state.js';
import { createStatePersistence } from '../src/app/storage.js';

const mapPackage = {
  id: 'storage-test-map',
  version: '2.0.0',
  compatibleMapVersions: ['1.0.0'],
  width: 100,
  height: 80,
  features: [],
};

function createMemoryStorage() {
  const values = new Map();
  let failWrites = false;
  return {
    values,
    get(key) { return values.get(key) ?? null; },
    set(key, value) {
      if (failWrites) throw new Error('quota exceeded');
      values.set(key, value);
    },
    remove(key) { values.delete(key); },
    setFailWrites(value) { failWrites = value; },
  };
}

test('persistence migrates a compatible save and preserves the original payload', () => {
  const storage = createMemoryStorage();
  const key = 'rpg-map:' + mapPackage.id + ':v1';
  const legacySave = {
    schema: 'SaveV1',
    mapId: mapPackage.id,
    mapVersion: '1.0.0',
    markers: [],
    attackAreas: [],
    sceneEvents: [],
    preferences: { gridVisible: true },
  };
  const raw = JSON.stringify(legacySave);
  storage.set(key, raw);

  let state;
  const persistence = createStatePersistence({
    mapPackage,
    storageAdapter: storage,
    getState: () => state,
  });
  const loaded = persistence.load();
  state = loaded.state;

  assert.equal(state.mapVersion, mapPackage.version);
  assert.equal(loaded.notice?.type, 'success');
  assert.equal(storage.get(key + ':backup:map-1.0.0'), raw);
  assert.equal(JSON.parse(storage.get(key)).mapVersion, mapPackage.version);
});

test('invalid storage is backed up before returning a clean state', () => {
  const storage = createMemoryStorage();
  const key = 'rpg-map:' + mapPackage.id + ':v1';
  storage.set(key, '{invalid json');
  const originalWarn = console.warn;
  console.warn = () => {};

  try {
    let state;
    const persistence = createStatePersistence({
      mapPackage,
      storageAdapter: storage,
      getState: () => state,
    });
    const loaded = persistence.load();
    state = loaded.state;

    assert.deepEqual(state, createInitialState(mapPackage));
    assert.equal(loaded.notice?.type, 'error');
    assert.equal(storage.get(key + ':backup:invalid'), '{invalid json');
    assert.equal(persistence.blocked, false);
  } finally {
    console.warn = originalWarn;
  }
});

test('a failed save blocks repeated writes until an explicit replacement succeeds', () => {
  const storage = createMemoryStorage();
  const errors = [];
  let state = createInitialState(mapPackage);
  const persistence = createStatePersistence({
    mapPackage,
    storageAdapter: storage,
    getState: () => state,
    onError: error => errors.push(error),
  });

  storage.setFailWrites(true);
  assert.equal(persistence.persistNow(), false);
  assert.equal(persistence.blocked, true);
  assert.equal(persistence.persistNow(), false);
  assert.equal(errors.length, 1);

  storage.setFailWrites(false);
  state = { ...state, preferences: { gridVisible: false } };
  assert.equal(persistence.replace(state), true);
  assert.equal(persistence.blocked, false);
  assert.equal(JSON.parse(storage.get(persistence.storageKey)).preferences.gridVisible, false);
});

test('scheduled saves use the latest state and emit one saved notification', async () => {
  const storage = createMemoryStorage();
  let saved = 0;
  let state = createInitialState(mapPackage);
  const persistence = createStatePersistence({
    mapPackage,
    storageAdapter: storage,
    getState: () => state,
    saveDelayMs: 5,
    onSaved: () => { saved += 1; },
  });

  persistence.schedule();
  state = { ...state, preferences: { gridVisible: false } };
  persistence.schedule();
  await new Promise(resolve => setTimeout(resolve, 25));

  assert.equal(saved, 1);
  assert.equal(JSON.parse(storage.get(persistence.storageKey)).preferences.gridVisible, false);
});
