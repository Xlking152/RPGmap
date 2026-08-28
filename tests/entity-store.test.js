import test from 'node:test';
import assert from 'node:assert/strict';
import { EntityStore } from '../src/entities/store.js';

test('EntityStore persists Actor reducer state without synchronizing Character documents', () => {
  const appState = { preferences: {}, characters: [] };
  let committed = null;
  let imported = 0;
  const api = {
    getState: () => structuredClone(appState),
    commitState: (state, options) => { committed = { state, options }; },
    importState: () => { imported += 1; },
  };
  const store = new EntityStore(api);
  store.state.actors = [{ id: 'actor-1', name: 'Actor', currentFormId: null, forms: [], runtime: {}, effects: [] }];
  store.state.tokens = [{ id: 'token-1', actorId: 'actor-1', diameterMeters: 1, elevationFt: 0, effects: [] }];

  store.persist();

  assert.equal(imported, 0);
  assert.equal(committed.options.source, 'entities');
  assert.equal(committed.options.render, false);
  assert.equal(committed.state.preferences.entitySystem.tokens[0].id, 'token-1');
  assert.equal(committed.state.preferences.entitySystem.tokens[0].characterId, undefined);
  assert.deepEqual(committed.state.characters, []);
});

test('canonical EntityStore Token read view delegates to Token Runtime and never creates Character aliases', () => {
  const canonicalTokens = [{ id: 'token-live', actorId: 'actor-1', diameterMeters: 5, elevationFt: 20, effects: [] }];
  const api = {
    getState: () => ({ preferences: { entitySystem: { schemaVersion: 3, actors: [{ id: 'actor-1', forms: [], runtime: {}, effects: [] }], tokens: [] } }, characters: [] }),
    tokens: {
      list: () => structuredClone(canonicalTokens),
      get: id => canonicalTokens.find(token => token.id === id) || null,
    },
    commitState() {},
  };
  const store = new EntityStore(api, { canonicalTokenReads: true });
  store.load({ migrateLegacy: false, dropMarkers: false });
  assert.equal(store.token('token-live').id, 'token-live');
  assert.deepEqual(store.snapshot().tokens, canonicalTokens);
  assert.equal(store.snapshot().tokens[0].characterId, undefined);
  assert.equal(typeof store.bindToken, 'undefined');
  assert.equal(typeof store.syncCharacters, 'undefined');
});
