import test from 'node:test';
import assert from 'node:assert/strict';
import { createActorFromImport } from '../src/entities/model.js';
import { createStatusController } from '../src/status/controller.js';
import { validateStatusDefinitionForActors } from '../src/status/target-validation.js';
import { infiniteHorrorRuleset } from '../src/rulesets/infinite-horror/index.js';

function actor() {
  return createActorFromImport({
    formName: '默认形态',
    identity: { name: '路径校验角色' },
    resources: { hp: { max: 20 }, stamina: { max: 8 }, willpower: { max: 6 } },
    attributes: [{ id: 'strength', name: '力量', base: 3 }],
    checks: { skills: [], saves: [] },
    badStatuses: [],
    combat: { attacks: [], defenses: [] },
    tokenAppearance: {},
    source: { type: 'manual' },
  }, { ruleset: infiniteHorrorRuleset });
}

function definition(id, target) {
  return {
    id,
    name: id,
    scopes: ['actor'],
    maxStacks: 1,
    changes: [{ target, mode: 'add', value: 1 }],
    capabilities: {},
  };
}

function runtime() {
  const currentActor = actor();
  let state = {
    preferences: {
      entitySystem: {
        schemaVersion: 3,
        statusDefinitions: [],
        actors: [currentActor],
        tokens: [],
      },
    },
  };
  const listeners = new Map();
  const api = {
    ruleset: infiniteHorrorRuleset,
    getState: () => state,
    commitState(next) {
      state = next;
      api.emit('state:commit', { source: 'test' });
    },
    persistNow() {},
    emit(type, detail) {
      for (const listener of listeners.get(type) || []) listener({ detail });
    },
    on(type, listener) {
      const values = listeners.get(type) || [];
      values.push(listener);
      listeners.set(type, values);
      return () => listeners.set(type, values.filter(value => value !== listener));
    },
    multiplayer: {
      getCapabilities: () => ({ connected: false, canManageStatuses: true }),
    },
  };
  createStatusController().register(api);
  return { api, actor: currentActor, get state() { return state; } };
}

test('Infinite Horror canonicalizes legacy Status targets against its writable attribute surface', () => {
  const currentActor = actor();
  const canonical = validateStatusDefinitionForActors({
    id: 'legacy-aliases',
    changes: [
      { target: 'attributes.strength', mode: 'add', value: 2 },
      { target: 'resources.hp.max', mode: 'add', value: 5 },
    ],
  }, [currentActor], infiniteHorrorRuleset);

  assert.deepEqual(canonical.changes.map(change => change.target), [
    'system.attributes.strength',
    'system.health.max',
  ]);
});

test('Status targets reject private and read-only Actor paths even when the Ruleset can resolve them', () => {
  const currentActor = actor();
  for (const target of ['system.secret', 'system.health.current']) {
    assert.throws(
      () => validateStatusDefinitionForActors(definition(`invalid-${target}`, target), [currentActor], infiniteHorrorRuleset),
      error => error?.code === 'unknown_actor_attribute_path',
      target,
    );
  }
});

test('Status Controller canonicalizes authored targets and refuses invalid Actor application', async () => {
  const current = runtime();

  await current.api.status.upsertDefinition(definition('status-strength', 'attributes.strength'), {
    actorId: current.actor.id,
  });
  const stored = current.state.preferences.entitySystem.statusDefinitions.find(item => item.id === 'status-strength');
  assert.equal(stored.changes[0].target, 'system.attributes.strength');

  // A reusable definition may exist before a concrete Actor is selected, but
  // it cannot be applied to an Actor whose Ruleset does not expose the target.
  await current.api.status.upsertDefinition(definition('status-future', 'system.secret'));
  await assert.rejects(
    current.api.status.apply({
      scope: 'actor', targetId: current.actor.id, definitionId: 'status-future', stacks: 1,
    }),
    error => error?.code === 'unknown_actor_attribute_path',
  );
  assert.equal(current.actor.effects.length, 0);

  await current.api.status.apply({
    scope: 'actor', targetId: current.actor.id, definitionId: 'status-strength', stacks: 1,
  });
  await assert.rejects(
    current.api.status.upsertDefinition(definition('status-strength', 'system.secret')),
    error => error?.code === 'unknown_actor_attribute_path',
  );

  await assert.rejects(
    current.api.status.upsertDefinition(definition('status-current-hp', 'system.health.current'), {
      actorId: current.actor.id,
    }),
    error => error?.code === 'unknown_actor_attribute_path',
  );
});
