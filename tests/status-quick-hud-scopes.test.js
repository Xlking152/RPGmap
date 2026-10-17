import assert from 'node:assert/strict';
import test from 'node:test';
import { planQuickStatusCycle } from '../src/status/quick-hud.js';
import { normalizeEntityStatusState, reduceStatusOperation, resolveStatuses } from '../src/status/model.js';
import { createInitialActorDelta, resolveTokenActorDocuments } from '../src/token/actor.js';
import { infiniteHorrorRuleset as ruleset } from '../src/rulesets/infinite-horror/index.js';

function fixture({ linked = true, deniedIds = [], changes = [], scopes = ['actor', 'token'] } = {}) {
  const actor = { ...ruleset.actor.createDefault({ name: 'Shared template' }), id: 'shared', type: 'pc' };
  let state = normalizeEntityStatusState({
    schemaVersion: 4,
    actors: [actor],
    tokens: ['one', 'two'].map(id => ({ id, actorId: actor.id, actorLink: linked, effects: [],
      actorDelta: linked ? null : createInitialActorDelta(actor, { ruleset }) })),
    statusDefinitions: [{ id: 'focus', name: 'Focus', category: 'buff', scopes,
      maxStacks: 9, changes, capabilities: {} }],
  });
  const context = { ruleset, source: { role: 'offline' }, now: '2026-10-17T00:00:00.000Z' };
  const api = {
    ruleset,
    tokens: {
      getActor: id => state.actors.find(actor => actor.id === id),
      resolveActor(id) {
        const token = state.tokens.find(item => item.id === id);
        return resolveTokenActorDocuments(state.actors[0], token, { ruleset });
      },
    },
    permissions: { can: (_action, { tokenId }) => !deniedIds.includes(tokenId) },
    status: {
      getDefinitions: () => state.statusDefinitions,
      resolve({ tokenId }) {
        const token = state.tokens.find(item => item.id === tokenId);
        const { actor: resolved } = resolveTokenActorDocuments(state.actors[0], token, { ruleset });
        return resolveStatuses({ ...state, actors: [resolved], tokens: [token] }, { tokenId, ruleset });
      },
    },
  };
  const apply = operations => { state = reduceStatusOperation(state, { type: 'status.batch', operations }, context).state; };
  const seed = (scope, targetId, extra = {}) => apply([{ type: 'status.apply', scope, targetId, definitionId: 'focus', ...extra }]);
  return { api, apply, seed, get state() { return state; },
    plan: (ids = ['one']) => planQuickStatusCycle(api, state.tokens.filter(token => ids.includes(token.id)), 'focus') };
}

function details(effect) {
  const { id, stacks, note, duration } = effect;
  return { id, stacks, note, duration };
}

test('linked Token-only status toggles in its original scope without changing its shared Actor', () => {
  const f = fixture();
  f.seed('token', 'one', { stacks: 4, note: 'Token-local effect', duration: { unit: 'turns', initial: 5, remaining: 3 } });
  const original = details(f.state.tokens[0].effects[0]);
  const sibling = structuredClone(f.state.tokens[1]);
  assert.deepEqual(f.plan(), [{ type: 'status.setStacks', scope: 'token', targetId: 'one', definitionId: 'focus', stacks: 4, enabled: false }]);
  f.apply(f.plan());
  assert.equal(f.state.tokens[0].effects[0].enabled, false);
  assert.deepEqual(f.state.actors[0].effects, []);
  assert.deepEqual(f.state.tokens[1], sibling);
  assert.deepEqual(details(f.state.tokens[0].effects[0]), original);
  f.apply(f.plan());
  assert.equal(f.state.tokens[0].effects[0].enabled, true);
  assert.deepEqual(details(f.state.tokens[0].effects[0]), original);
});

test('same-definition Actor and Token effects stop and resume together with distinct metadata retained', () => {
  const f = fixture();
  f.seed('actor', 'shared', { stacks: 2, note: 'Actor source', duration: { unit: 'rounds', initial: 4, remaining: 2 } });
  f.seed('token', 'one', { stacks: 5, note: 'Token source', duration: { unit: 'turns', initial: 7, remaining: 5 } });
  const actorDetails = details(f.state.actors[0].effects[0]);
  const tokenDetails = details(f.state.tokens[0].effects[0]);
  f.apply(f.plan());
  assert.equal(f.state.actors[0].effects[0].enabled, false);
  assert.equal(f.state.tokens[0].effects[0].enabled, false);
  assert.deepEqual(f.api.status.resolve({ tokenId: 'one' }).statuses.filter(status => status.definitionId === 'focus'), []);
  f.apply(f.plan());
  assert.equal(f.state.actors[0].effects[0].enabled, true);
  assert.equal(f.state.tokens[0].effects[0].enabled, true);
  assert.deepEqual(details(f.state.actors[0].effects[0]), actorDetails);
  assert.deepEqual(details(f.state.tokens[0].effects[0]), tokenDetails);
});

test('Synthetic Actor plus Token effects use one batch without changing template or sibling', () => {
  const f = fixture({ linked: false });
  f.seed('syntheticActor', 'one', { stacks: 3, note: 'Instance' });
  f.seed('token', 'one', { stacks: 2, note: 'Token' });
  const template = structuredClone(f.state.actors[0]);
  const sibling = structuredClone(f.state.tokens[1]);
  assert.deepEqual(f.plan().map(operation => operation.scope), ['syntheticActor', 'token']);
  f.apply(f.plan());
  assert.equal(f.state.tokens[0].actorDelta.effects[0].enabled, false);
  assert.equal(f.state.tokens[0].effects[0].enabled, false);
  assert.deepEqual(f.state.actors[0], template);
  assert.deepEqual(f.state.tokens[1], sibling);
});

test('all selected Token permissions are checked before shared Actor writes are deduplicated', () => {
  const f = fixture({ deniedIds: ['two'] });
  const original = structuredClone(f.state);
  assert.throws(() => f.plan(['one', 'two']), /无权控制/);
  assert.deepEqual(f.state, original);
});

test('shared Actor disable wins over a second Token with only that disabled Actor effect', () => {
  const f = fixture();
  f.seed('actor', 'shared');
  f.seed('token', 'one');
  f.apply([{ type: 'status.setStacks', scope: 'actor', targetId: 'shared', definitionId: 'focus', stacks: 1, enabled: false }]);
  const operations = f.plan(['one', 'two']);
  assert.equal(operations.filter(operation => operation.scope === 'actor').length, 1);
  assert.equal(operations.find(operation => operation.scope === 'actor').enabled, false);
  f.apply(operations);
  assert.equal(f.state.tokens[0].effects[0].enabled, false);
  assert.equal(f.state.actors[0].effects[0].enabled, false);
});

test('new statuses keep linked Actor and independent instance targets while derived statuses stay read-only', () => {
  const linked = fixture();
  assert.deepEqual(linked.plan(['one', 'two']), [{ type: 'status.apply', scope: 'actor', targetId: 'shared', definitionId: 'focus', stacks: 1 }]);
  const independent = fixture({ linked: false });
  assert.deepEqual(independent.plan(['one', 'two']).map(operation => [operation.scope, operation.targetId]), [['syntheticActor', 'one'], ['syntheticActor', 'two']]);
  assert.deepEqual(planQuickStatusCycle(linked.api, linked.state.tokens, 'derived-unconscious'), []);
});

test('quick status rejects private Actor paths before any linked or synthetic operation can be submitted', () => {
  for (const linked of [true, false]) {
    const f = fixture({ linked, scopes: ['actor'], changes: [{ target: 'system.secret', mode: 'add', value: 1 }] });
    const before = structuredClone(f.state);
    let submissions = 0;
    assert.throws(() => {
      const operations = f.plan(['one', 'two']);
      submissions++;
      f.apply(operations);
    }, error => error.code === 'unknown_actor_attribute_path');
    assert.equal(submissions, 0);
    assert.deepEqual(f.state, before);
  }
});

test('quick status validates all new concrete targets before returning a partially valid batch', () => {
  const f = fixture({ linked: false, scopes: ['actor'], changes: [{ target: 'resources.hp.max', mode: 'add', value: 1 }] });
  const paths = ruleset.actor.attributePaths;
  const resolveActor = f.api.tokens.resolveActor;
  f.api.tokens.resolveActor = id => {
    const result = resolveActor(id);
    if (id === 'two') result.actor.validationProbeDenied = true;
    return result;
  };
  f.api.ruleset = { ...ruleset, actor: { ...ruleset.actor,
    attributePaths: actor => actor.validationProbeDenied ? [] : paths(actor),
  } };
  const before = structuredClone(f.state);
  let submissions = 0;
  assert.throws(() => {
    const operations = f.plan(['one', 'two']);
    submissions++;
    f.apply(operations);
  }, error => error.code === 'unknown_actor_attribute_path');
  assert.equal(submissions, 0);
  assert.deepEqual(f.state, before);
});

test('quick status accepts public Actor paths for linked and synthetic targets and keeps Token-only semantics', () => {
  for (const linked of [true, false]) {
    const f = fixture({ linked, scopes: ['actor'], changes: [{ target: 'resources.hp.max', mode: 'add', value: 1 }] });
    const operations = f.plan();
    assert.equal(operations[0].scope, linked ? 'actor' : 'syntheticActor');
    f.apply(operations);
    assert.equal(f.api.status.resolve({ tokenId: 'one' }).actorStatuses[0].definitionId, 'focus');
  }
  const tokenOnly = fixture({ scopes: ['token'] });
  tokenOnly.api.ruleset = { actor: { attributePaths: () => { throw new Error('Token-only status must not inspect Actor paths'); } } };
  assert.equal(tokenOnly.plan()[0].scope, 'token');
});
