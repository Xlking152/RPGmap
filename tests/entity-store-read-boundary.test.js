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
  assert.equal(commits[0].next.preferences.entitySystem.schemaVersion, 3);
  assert.ok(commits[0].next.preferences.entitySystem.actors[0].system);
});
