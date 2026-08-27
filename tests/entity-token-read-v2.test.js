import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { EntityStore, withCanonicalEntityTokenReadView } from '../src/entities/store.js';
import {
  formatCanonicalTokenPlacement,
  listCanonicalActorTokens,
  readCanonicalEntityToken,
} from '../src/entities/token-read-ui.js';

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
      resolveActor: id => {
        const current = tokens.find(item => String(item.id) === String(id));
        if (!current) throw new Error('missing token');
        const baseActor = { id: current.actorId, name: '模板角色', currentFormId: 'base', forms: [{ id: 'base', name: '默认形态' }] };
        const actor = current.actorLink === false
          ? { ...baseActor, name: '独立实例', currentFormId: 'instance', forms: [{ id: 'instance', name: '实例形态' }] }
          : baseActor;
        return { token: current, baseActor, actor, synthetic: current.actorLink === false, actorLink: current.actorLink !== false };
      },
    },
  };
}

test('only the Entity UI store exposes canonical Token reads while ordinary reducer stores keep mutable drafts', () => {
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

  let editorStore;
  withCanonicalEntityTokenReadView(() => { editorStore = new EntityStore(api); });
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
});

test('canonical Entity Token helpers list by Actor and read placement through get/resolveActor', () => {
  const tokens = [
    token(),
    token({ id: 'token-b', characterId: 'token-b', actorLink: false, actorId: 'actor-a', placement: 'feature', x: null, y: null, featureId: 'building-7' }),
    token({ id: 'token-c', characterId: 'token-c', actorId: 'actor-b' }),
  ];
  const api = apiWithTokens(tokens);

  assert.deepEqual(listCanonicalActorTokens(api, 'actor-a').map(item => item.id), ['token-a', 'token-b']);
  assert.equal(formatCanonicalTokenPlacement(tokens[0]), 'x 12.5 · y 18.5');
  assert.equal(formatCanonicalTokenPlacement(tokens[1]), 'Feature building-7');

  const read = readCanonicalEntityToken(api, 'token-b');
  assert.equal(read.token.id, 'token-b');
  assert.equal(read.actor.name, '独立实例');
  assert.equal(read.synthetic, true);
  assert.equal(read.placementLabel, 'Feature building-7');
});

test('Entity Token Read V2 is read-only and has no Character/Entity projection dependency', async () => {
  const source = await readFile(new URL('../src/entities/token-read-ui.js', import.meta.url), 'utf8');
  assert.match(source, /api\.tokens\.list\(\)/);
  assert.match(source, /api\.tokens\.get\(/);
  assert.match(source, /api\.tokens\.resolveActor\(/);
  assert.match(source, /tokenListSource = 'api\.tokens\.list'/);
  assert.match(source, /tokenValueSource = 'api\.tokens\.get'/);
  assert.match(source, /actorValueSource = 'api\.tokens\.resolveActor'/);
  assert.doesNotMatch(source, /state\.characters|preferences\.entitySystem|entityState\(\)/);
  assert.doesNotMatch(source, /api\.tokens\.(?:create|move|update|remove)\(/);
  assert.doesNotMatch(source, /commitState\(|importState\(/);
});

test('canonical Token read mode is explicitly scoped to Entity UI registration', async () => {
  const storeSource = await readFile(new URL('../src/entities/store.js', import.meta.url), 'utf8');
  const indexSource = await readFile(new URL('../src/entities/index.js', import.meta.url), 'utf8');
  assert.match(storeSource, /withCanonicalEntityTokenReadView/);
  assert.match(storeSource, /canonicalTokenReadView = canonicalEntityUiStoreDepth > 0/);
  assert.match(storeSource, /if \(!this\.canonicalTokenReadView\) return this\.state\.tokens/);
  assert.match(storeSource, /Object\.defineProperty\(state, 'tokens'/);
  assert.match(indexSource, /withCanonicalEntityTokenReadView\(\(\) => ui\.register\(api\)\)/);
});
