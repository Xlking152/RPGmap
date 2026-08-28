import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../src/app/storage.js';
import {
  prepareStoredWorldState,
  readStoredWorldState,
  worldStateStorageKey,
} from '../src/app/world-storage.js';
import { readServerWorldBootstrap, readWorldBootstrap } from '../src/world/bootstrap.js';
import { WORLD_STATE_KEY, activeWorldScene } from '../src/world/model.js';
import { readRpgMapServerBootstrap } from '../src/multiplayer/server-bootstrap.js';
import { infiniteHorrorRuleset } from '../src/rulesets/infinite-horror/index.js';
import { prepareRuleset } from '../src/ruleset/contract.js';
import { getActiveRuleset, setActiveRuleset } from '../src/ruleset/index.js';

const mapPackage = { id: 'test-map', version: '1.0.0', title: 'Test Map' };
const ruleset = infiniteHorrorRuleset;

function legacyState() {
  return {
    saveVersion: 2,
    mapId: mapPackage.id,
    mapVersion: mapPackage.version,
    markers: [], attackAreas: [], sceneEvents: [],
    characters: [{
      id: 'token-legacy', name: 'Legacy', color: '#335577', avatarDataUrl: null,
      visible: true, location: { type: 'map', x: 12, y: 18 },
    }],
    preferences: {
      entitySystem: {
        schemaVersion: 3,
        statusDefinitions: [],
        actors: [{
          id: 'actor-legacy', name: 'Legacy', notes: 'keep-notes',
          currentFormId: 'form-legacy',
          forms: [{
            id: 'form-legacy', name: 'Legacy', resources: { hp: { current: 7, max: 10 } },
            tokenAppearance: { color: '#335577', scale: 1 },
          }],
          runtime: { health: { mode: 'simple' } }, effects: [],
        }],
        tokens: [{ id: 'token-legacy', actorId: 'actor-legacy', diameterMeters: 1, effects: [] }],
      },
    },
  };
}

test('World bootstrap classifies empty, legacy, and World V2 state without normalization', () => {
  const empty = readWorldBootstrap(null, { defaultRuleset: ruleset });
  assert.deepEqual({ kind: empty.kind, ruleset: empty.ruleset }, {
    kind: 'empty', ruleset: { id: 'infinite-horror', version: '1.0.0' },
  });
  assert.equal(readWorldBootstrap(legacyState(), { defaultRuleset: ruleset }).kind, 'legacy');

  const storage = createMemoryStorage();
  const initial = prepareStoredWorldState({ mapPackage, ruleset, storageAdapter: storage, raw: null });
  const modern = readWorldBootstrap(initial.state, { defaultRuleset: ruleset });
  assert.equal(modern.kind, 'world-v2');
  assert.deepEqual(modern.ruleset, { id: 'infinite-horror', version: '1.0.0' });
});

test('new offline state owns World V2 before Runtime systems register', () => {
  const storage = createMemoryStorage();
  const loaded = prepareStoredWorldState({ mapPackage, ruleset, storageAdapter: storage, raw: null });
  const world = loaded.state.preferences[WORLD_STATE_KEY];
  assert.equal(world.schemaVersion, 2);
  assert.equal(world.ruleset.id, 'infinite-horror');
  assert.equal(world.activeSceneId, activeWorldScene(world).id);
  assert.equal(loaded.blocked, false);
});

test('legacy SaveV2 migration remains explicit, backed up, and World-first', () => {
  const storage = createMemoryStorage();
  const raw = JSON.stringify(legacyState());
  storage.set(worldStateStorageKey(mapPackage), raw);
  const snapshot = readStoredWorldState({ mapPackage, storageAdapter: storage });
  const loaded = prepareStoredWorldState({ mapPackage, ruleset, storageAdapter: storage, raw: snapshot.raw });
  const world = loaded.state.preferences[WORLD_STATE_KEY];
  assert.equal(world.ruleset.id, 'infinite-horror');
  assert.equal(world.actors[0].notes, 'keep-notes');
  assert.equal(activeWorldScene(world).tokens[0].id, 'token-legacy');
  assert.equal(Object.hasOwn(loaded.state, 'characters'), false);
  assert.equal(storage.get(`${snapshot.storageKey}:backup:legacy-${loaded.notice ? '1.0.0' : 'missing'}`) !== null, true);
});

test('legacy migration uses the resolved Ruleset argument instead of the global active Ruleset', () => {
  const fakeRuleset = prepareRuleset({
    apiVersion: 1,
    id: 'bootstrap-fake',
    title: 'Bootstrap Fake',
    version: '1.0.0',
    actor: {
      migrateLegacy: actor => ({ name: actor?.name || 'Actor', system: { migratedBy: 'bootstrap-fake' } }),
      normalizeSystem: system => structuredClone(system || {}),
    },
  });
  const originalId = getActiveRuleset().id;
  setActiveRuleset('infinite-horror');
  try {
    const storage = createMemoryStorage();
    const loaded = prepareStoredWorldState({
      mapPackage,
      ruleset: fakeRuleset,
      storageAdapter: storage,
      raw: JSON.stringify(legacyState()),
    });
    const world = loaded.state.preferences[WORLD_STATE_KEY];
    assert.equal(world.ruleset.id, 'bootstrap-fake');
    assert.equal(world.actors[0].system.migratedBy, 'bootstrap-fake');
    assert.equal(getActiveRuleset().id, 'infinite-horror');
  } finally {
    setActiveRuleset(originalId);
  }
});

test('prepared modern World preserves Actor system, Synthetic Delta, Effects, definitions, and Scene map reference', () => {
  const storage = createMemoryStorage();
  const initial = prepareStoredWorldState({ mapPackage, ruleset, storageAdapter: storage, raw: null }).state;
  const world = initial.preferences[WORLD_STATE_KEY];
  world.actors = [{
    id: 'actor-a', name: 'Actor', notes: 'notes', effects: [{
      id: 'effect-a', definitionId: 'custom-focus', stacks: 1, enabled: true,
    }],
    system: {
      currentFormId: 'form-a',
      forms: [{
        id: 'form-a', name: 'Default', avatarDataUrl: null,
        resources: { hp: { id: 'hp', name: 'HP', current: 8, max: 10 } },
        attributes: {}, skills: [], saves: [], tokenAppearance: { color: '#335577', scale: 1 },
      }],
      runtime: { health: { mode: 'simple' }, resources: { custom: { current: 3, max: 5 } } },
    },
  }];
  world.statusDefinitions.push({
    id: 'custom-focus', name: 'Focus', description: '', icon: 'star', color: '#335577',
    category: 'buff', scopes: ['actor'], maxStacks: 1, changes: [], capabilities: {}, builtIn: false,
  });
  activeWorldScene(world).tokens = [{
    id: 'token-a', actorId: 'actor-a', actorLink: false,
    actorDelta: { system: { runtime: { resources: { custom: { current: 1 } } } } },
    placement: 'map', x: 12, y: 18, featureId: null,
    diameterMeters: 1, rotation: 0, elevationFt: 0,
    hidden: false, locked: false, showName: true, effects: [],
  }];
  const prepared = prepareStoredWorldState({
    mapPackage, ruleset, storageAdapter: storage, raw: JSON.stringify(initial),
  }).state.preferences[WORLD_STATE_KEY];
  assert.equal(prepared.actors[0].notes, 'notes');
  assert.equal(prepared.actors[0].system.runtime.resources.custom.current, 3);
  assert.equal(activeWorldScene(prepared).tokens[0].actorDelta.system.runtime.resources.custom.current, 1);
  assert.equal(prepared.statusDefinitions.some(item => item.id === 'custom-focus'), true);
  assert.deepEqual(activeWorldScene(prepared).mapPackage, { id: 'test-map', version: '1.0.0' });
});

test('server bootstrap metadata resolves before the authenticated World snapshot', async () => {
  const metadata = {
    initialized: true,
    kind: 'world-v2',
    schemaVersion: 2,
    ruleset: { id: 'infinite-horror', version: '1.0.0' },
  };
  assert.deepEqual(readServerWorldBootstrap(metadata, { defaultRuleset: ruleset }).ruleset, metadata.ruleset);
  assert.equal(readServerWorldBootstrap({ initialized: true, kind: 'legacy' }, { defaultRuleset: ruleset }).kind, 'legacy');
  assert.throws(
    () => readServerWorldBootstrap({ ...metadata, schemaVersion: 99 }, { defaultRuleset: ruleset }),
    error => error.code === 'world_schema_incompatible',
  );

  const result = await readRpgMapServerBootstrap({
    location: { protocol: 'http:' },
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return { status: 'ok', app: 'RPGmap', multiplayer: { enabled: true }, world: metadata };
      },
    }),
  });
  assert.equal(result.serverRuntime, true);
  assert.deepEqual(result.world, metadata);
});
