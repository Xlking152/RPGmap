import test from 'node:test';
import assert from 'node:assert/strict';
import { applyStatusMessage, assertStatusState } from '../deployment/local-server/status-operations.mjs';

function world() {
  return {
    preferences: {
      entitySystem: {
        schemaVersion: 3,
        statusDefinitions: [],
        actors: [{ id: 'actor-a', forms: [], runtime: {}, effects: [] }],
        tokens: [{ id: 'token-a', characterId: 'character-a', actorId: 'actor-a', effects: [] }],
      },
    },
  };
}

function definition(changes) {
  return {
    id: 'status-ward', name: '守护', description: '', icon: 'shield',
    color: '#225588', category: 'buff', scopes: ['actor'], maxStacks: 5,
    changes, capabilities: {},
  };
}

test('server definition edits refresh Actor projections and status metadata atomically', () => {
  let state = applyStatusMessage(world(), {
    type: 'status.definition.upsert', definition: definition([
      { target: 'resources.hp.max', mode: 'add', value: 1 },
    ]),
  }).state;
  state = applyStatusMessage(state, {
    type: 'status.apply', scope: 'actor', targetId: 'actor-a', statusId: 'status-ward', stacks: 2,
  }, { now: '2026-08-27T00:00:00.000Z' }).state;
  assert.deepEqual(state.preferences.entitySystem.actors[0].effects[0].changes, [
    { target: 'resources.hp.max', mode: 'add', value: 1 },
  ]);

  state = applyStatusMessage(state, {
    type: 'status.definition.upsert', definition: definition([
      { target: 'resources.hp.max', mode: 'add', value: 3 },
    ]),
  }).state;
  assert.deepEqual(state.preferences.entitySystem.actors[0].effects[0].changes, [
    { target: 'resources.hp.max', mode: 'add', value: 3 },
  ]);

  state = applyStatusMessage(state, {
    type: 'status.setStacks', scope: 'actor', targetId: 'actor-a', statusId: 'status-ward',
    stacks: 4, enabled: false, note: '由场景压制',
  }).state;
  const effect = state.preferences.entitySystem.actors[0].effects[0];
  assert.deepEqual({ stacks: effect.stacks, enabled: effect.enabled, note: effect.note }, {
    stacks: 4, enabled: false, note: '由场景压制',
  });
  assert.doesNotThrow(() => assertStatusState(state.preferences.entitySystem));
});

test('server rejects unknown Lucide icons without modifying the original World', () => {
  const initial = world();
  assert.throws(() => applyStatusMessage(initial, {
    type: 'status.definition.upsert', definition: { ...definition([]), icon: '<script>' },
  }), error => error?.code === 'status_icon_invalid');
  assert.deepEqual(initial.preferences.entitySystem.statusDefinitions, []);
});
