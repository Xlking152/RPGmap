import test from 'node:test';
import assert from 'node:assert/strict';
import { EntityStore } from '../src/entities/store.js';

function legacyProjection() {
  return {
    characters: [],
    preferences: {
      entitySystem: {
        schemaVersion: 2,
        statusDefinitions: [],
        actors: [{
          id: 'actor-legacy',
          name: 'Legacy',
          currentFormId: null,
          forms: [],
          runtime: {},
          effects: [],
        }],
        tokens: [],
      },
    },
  };
}

test('ordinary EntityStore reload normalizes for reading without writing the projection back', () => {
  const state = legacyProjection();
  const commits = [];
  const api = {
    getState: () => structuredClone(state),
    commitState(next, options) { commits.push({ next, options }); },
  };
  const store = new EntityStore(api);
  store.load({ migrateLegacy: false, dropMarkers: false });

  assert.equal(commits.length, 0);
  assert.equal(store.actor('actor-legacy')?.id, 'actor-legacy');
  assert.ok(store.actor('actor-legacy')?.system);
});

test('explicit migration load may repair and persist the normalized Entity projection', () => {
  const state = legacyProjection();
  const commits = [];
  const api = {
    getState: () => structuredClone(state),
    commitState(next, options) { commits.push({ next, options }); },
  };
  const store = new EntityStore(api);
  store.load({ migrateLegacy: true, dropMarkers: false });

  assert.equal(commits.length, 1);
  assert.equal(commits[0].options.source, 'entities:migration');
  assert.equal(commits[0].next.preferences.entitySystem.schemaVersion, 4);
  assert.ok(commits[0].next.preferences.entitySystem.actors[0].system);
});

for (const role of ['player', 'gm', 'disconnected-host']) {
  test(`initial ${role} sheet load with 500 projected Tokens cannot migrate or clear canonical data`, () => {
    const state = legacyProjection();
    state.preferences.entitySystem.schemaVersion = 4;
    state.preferences.entitySystem.tokens = Array.from({ length: 500 }, (_, index) => ({
      id: `projected-token-${index}`, actorId: 'actor-legacy', x: index, y: 10,
    }));
    state.markers = [{ id: 'retained-marker' }];
    state.attackAreas = [{ id: 'retained-area', anchor: { type: 'marker', markerId: 'retained-marker' } }];
    const original = structuredClone(state);
    let writes = 0;
    const api = {
      getState: () => structuredClone(state),
      isLocalWorldActive: () => role === 'disconnected-host' ? false : true,
      multiplayer: { getConnectionState: () => ({ connected: role !== 'disconnected-host', role }) },
      commitState() { writes++; throw new Error('Audience view attempted an unauthorized repair'); },
    };
    const store = new EntityStore(api);
    const result = store.load({ migrateLegacy: true, dropMarkers: true });
    assert.equal(writes, 0);
    assert.equal(result.droppedMarkers, 0);
    assert.ok(store.actor('actor-legacy')?.system, 'the read view still fills display defaults');
    assert.deepEqual(state, original);
  });
}
