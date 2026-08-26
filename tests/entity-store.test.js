import test from 'node:test';
import assert from 'node:assert/strict';
import { EntityStore } from '../src/entities/store.js';

test('EntityStore commits Token changes without routing them through save import', () => {
  const appState = {
    preferences: {},
    characters: [{ id: 'character-1', name: 'old', color: '#111111', visible: true }],
  };
  let committed = null;
  let imported = 0;
  const api = {
    getState: () => structuredClone(appState),
    commitState: (state, options) => { committed = { state, options }; },
    importState: () => { imported += 1; },
  };
  const store = new EntityStore(api);
  store.state.actors = [{
    id: 'actor-1',
    name: 'new',
    currentFormId: 'form-1',
    forms: [{ id: 'form-1', avatarDataUrl: null, tokenAppearance: { color: '#33aa55' } }],
  }];
  store.bindToken('actor-1', 'character-1');

  store.persist();

  assert.equal(imported, 0);
  assert.equal(committed.options.source, 'entities');
  assert.equal(committed.options.render, false);
  assert.equal(committed.state.preferences.entitySystem.tokens.length, 1);
  assert.equal(committed.state.characters[0].name, 'new');
  assert.equal(committed.state.characters[0].color, '#33aa55');
});

test('legacy Token migration keeps a coordinate whose 1m destination is blocked', () => {
  const appState = {
    preferences: {
      entitySystem: {
        schemaVersion: 1,
        actors: [{ id: 'actor-1', name: 'Actor', forms: [], runtime: {} }],
        tokens: [{ id: 'character-1', actorId: 'actor-1', characterId: 'character-1', size: 5 }],
      },
    },
    characters: [{ id: 'character-1', location: { type: 'map', x: 12.2, y: 6.8 } }],
  };
  let committed = null;
  const api = {
    mapPackage: { width: 100, height: 100 },
    getState: () => structuredClone(appState),
    inspectTokenPlacement: () => ({ valid: false }),
    commitState: state => { committed = state; },
  };
  const result = new EntityStore(api).load({ migrateLegacy: false, dropMarkers: false });
  assert.equal(result.migratedTokenLocations, 0);
  assert.equal(result.blockedTokenLocations, 1);
  assert.deepEqual(committed.characters[0].location, { type: 'map', x: 12.2, y: 6.8 });
  assert.equal(committed.preferences.entitySystem.tokens[0].diameterMeters, 5);
  assert.equal(committed.preferences.entitySystem.tokens[0].size, undefined);
});
