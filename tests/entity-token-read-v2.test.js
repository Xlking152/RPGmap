import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { EntityStore } from '../src/entities/store.js';

function token(overrides = {}) {
  return {
    id: 'token-a',
    characterId: 'token-a',
    actorId: 'actor-a',
    actorLink: true,
    actorDelta: null,
    placement: 'map',
    x: 12.5,
    y: 18.5,
    diameterMeters: 5,
    rotation: 45,
    elevationFt: 10,
    hidden: false,
    showName: true,
    effects: [],
    ...overrides,
  };
}

function apiWithTokens(tokens = [token()]) {
  return {
    tokens: {
      list: () => structuredClone(tokens),
      get: id => structuredClone(tokens.find(item => String(item.id) === String(id)) || null),
    },
  };
}

test('only an explicitly configured Entity UI store exposes canonical Token reads while reducers keep mutable drafts', () => {
  const canonical = [token()];
  const api = apiWithTokens(canonical);

  const reducerStore = new EntityStore(api);
  reducerStore.state = {
    schemaVersion: 3,
    statusDefinitions: [],
    actors: [],
    tokens: [token({ id: 'draft-token', characterId: 'draft-token', actorDelta: { runtime: { hp: 10 } } })],
  };
  reducerStore.compatTokens = reducerStore.state.tokens;
  assert.equal(reducerStore.canonicalTokenReadView, false);
  const mutable = reducerStore.token('draft-token');
  mutable.actorDelta.runtime.hp = 7;
  assert.equal(reducerStore.snapshot().tokens[0].actorDelta.runtime.hp, 7);
  assert.equal(reducerStore.token('token-a'), null, 'ordinary reducer stores must not replace their draft with api.tokens.get()');

  const editorStore = new EntityStore(api, { canonicalTokenReads: true });
  editorStore.installCanonicalTokenReadView({
    schemaVersion: 3,
    statusDefinitions: [],
    actors: [],
    tokens: [{ id: 'legacy-token', actorId: 'legacy-actor' }],
  });
  assert.equal(editorStore.canonicalTokenReadView, true);
  assert.deepEqual(editorStore.state.tokens.map(item => item.id), ['token-a']);
  assert.deepEqual(editorStore.compatTokens.map(item => item.id), ['legacy-token']);
  assert.deepEqual(editorStore.snapshot().tokens.map(item => item.id), ['token-a']);

  canonical.push(token({ id: 'token-b', characterId: 'token-b' }));
  assert.deepEqual(editorStore.state.tokens.map(item => item.id), ['token-a', 'token-b']);
  assert.equal(editorStore.token('token-b').id, 'token-b');
});

test('canonical Token read mode is explicit in live Entity UI and no longer uses a dynamic registration scope', async () => {
  const storeSource = await readFile(new URL('../src/entities/store.js', import.meta.url), 'utf8');
  const uiSource = await readFile(new URL('../src/entities/ui-live.js', import.meta.url), 'utf8');
  const indexSource = await readFile(new URL('../src/entities/index.js', import.meta.url), 'utf8');

  assert.match(storeSource, /constructor\(api, \{ canonicalTokenReads = false \} = \{\}\)/);
  assert.match(storeSource, /this\.canonicalTokenReadView = canonicalTokenReads === true/);
  assert.match(storeSource, /Object\.defineProperty\(state, 'tokens'/);
  assert.match(uiSource, /new EntityStore\(api, \{ canonicalTokenReads: true \}\)/);
  assert.match(uiSource, /api\.tokens\?\.list\?\.\(\)/);
  assert.doesNotMatch(storeSource, /withCanonicalEntityTokenReadView|canonicalEntityUiStoreDepth|canonicalEntityUiStore/);
  assert.doesNotMatch(indexSource, /withCanonicalEntityTokenReadView|token-read-ui/);
});

test('Entity editor Token reads have no direct Character-position dependency', async () => {
  const controllerSource = await readFile(new URL('../src/entities/token-controller.js', import.meta.url), 'utf8');
  const uiSource = await readFile(new URL('../src/entities/ui-live.js', import.meta.url), 'utf8');
  assert.match(controllerSource, /api\.tokens\.list\?\.\(\)/);
  assert.match(controllerSource, /api\.tokens\.get\(/);
  assert.doesNotMatch(controllerSource, /state\.characters|preferences\.entitySystem/);
  assert.doesNotMatch(uiSource, /api\.getState\(\)\.characters|character\.location|data-character-id/);
});
