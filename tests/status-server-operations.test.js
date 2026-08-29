import test from 'node:test';
import assert from 'node:assert/strict';
import { applyStatusMessage, assertStatusState } from '../deployment/local-server/status-operations.mjs';
import { INFINITE_HORROR_STATUS_DEFINITIONS } from '../src/rulesets/infinite-horror/statuses.js';

function world() {
  return {
    preferences: {
      entitySystem: {
        schemaVersion: 3,
        statusDefinitions: structuredClone(INFINITE_HORROR_STATUS_DEFINITIONS),
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

test('server definition edits keep Effect instances runtime-only and update canonical rules atomically', () => {
  let state = applyStatusMessage(world(), {
    type: 'status.definition.upsert', definition: definition([
      { target: 'resources.hp.max', mode: 'add', value: 1 },
    ]),
  }).state;
  state = applyStatusMessage(state, {
    type: 'status.apply', scope: 'actor', targetId: 'actor-a', statusId: 'status-ward', stacks: 2,
  }, { now: '2026-08-27T00:00:00.000Z' }).state;
  const effectBeforeDefinitionEdit = structuredClone(state.preferences.entitySystem.actors[0].effects[0]);
  assert.equal(Object.hasOwn(effectBeforeDefinitionEdit, 'changes'), false);
  assert.deepEqual(state.preferences.entitySystem.statusDefinitions
    .find(item => item.id === 'status-ward').changes, [
    { target: 'resources.hp.max', mode: 'add', value: 1 },
  ]);

  state = applyStatusMessage(state, {
    type: 'status.definition.upsert', definition: definition([
      { target: 'resources.hp.max', mode: 'add', value: 3 },
    ]),
  }).state;
  assert.deepEqual(state.preferences.entitySystem.actors[0].effects[0], effectBeforeDefinitionEdit);
  assert.equal(Object.hasOwn(state.preferences.entitySystem.actors[0].effects[0], 'changes'), false);
  assert.deepEqual(state.preferences.entitySystem.statusDefinitions
    .find(item => item.id === 'status-ward').changes, [
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
  assert.equal(Object.hasOwn(effect, 'changes'), false);
  assert.doesNotThrow(() => assertStatusState(state.preferences.entitySystem));
});

test('server rejects unknown Lucide icons without modifying the original World', () => {
  const initial = world();
  assert.throws(() => applyStatusMessage(initial, {
    type: 'status.definition.upsert', definition: { ...definition([]), icon: '<script>' },
  }), error => error?.code === 'status_icon_invalid');
  assert.deepEqual(initial.preferences.entitySystem.statusDefinitions, structuredClone(INFINITE_HORROR_STATUS_DEFINITIONS));
});

test('server reads built-ins from World and strips forged builtIn flags from custom definitions', () => {
  let state = applyStatusMessage(world(), {
    type: 'status.apply', scope: 'actor', targetId: 'actor-a', statusId: 'status-rooted', stacks: 1,
  }).state;
  assert.equal(state.preferences.entitySystem.actors[0].effects[0].definitionId, 'status-rooted');

  assert.throws(() => applyStatusMessage(state, {
    type: 'status.definition.upsert',
    definition: { ...structuredClone(INFINITE_HORROR_STATUS_DEFINITIONS[1]), builtIn: false },
  }), error => error?.code === 'status_builtin_readonly');

  state = applyStatusMessage(state, {
    type: 'status.definition.upsert',
    definition: { ...definition([]), id: 'status-forged', builtIn: true },
  }).state;
  assert.equal(state.preferences.entitySystem.statusDefinitions.find(item => item.id === 'status-forged').builtIn, false);
});


test('modern server schema rejects Definition-owned fields on Effect instances', () => {
  const forgedValues = {
    name: '伪造状态名', label: '伪造标签', description: '伪造描述', icon: 'shield',
    color: '#225588', category: 'buff', scope: 'actor', scopes: ['actor'], maxStacks: 2,
    capabilities: {}, statusId: 'status-rooted', changes: [],
  };
  for (const [key, value] of Object.entries(forgedValues)) {
    const initial = world();
    initial.preferences.entitySystem.actors[0].effects.push({
      id: `effect-forged-${key}`, definitionId: 'status-rooted', stacks: 1, enabled: true, [key]: value,
    });
    assert.throws(
      () => assertStatusState(initial.preferences.entitySystem),
      error => error?.code === 'status_instance_rule_data_forbidden',
      `modern EffectInstance should reject Definition-owned field: ${key}`,
    );
  }
});
