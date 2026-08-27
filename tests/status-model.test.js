import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getStatusDefinitions,
  normalizeEntityStatusState,
  reduceStatusOperation,
  resolveStatuses,
} from '../src/status/model.js';
import { resolveResource } from '../src/entities/resolver.js';
import { getActiveRuleset } from '../src/ruleset/index.js';

const BUILTIN_STATUS_DEFINITIONS = getActiveRuleset().statuses.definitions;

function actor(id = 'actor-1') {
  return {
    id,
    name: '测试角色',
    currentFormId: 'form-1',
    forms: [{
      id: 'form-1',
      source: { type: 'xlsx' },
      resourceBases: { hp: { id: 'hp', name: '生命', kind: 'hp', baseMax: 5 } },
    }],
    runtime: {
      resources: { hp: { current: 5, maxOverride: null, policy: 'preserve' } },
      health: { mode: 'wound-track', wounds: { bashing: 0, lethal: 0, aggravated: 0 } },
    },
    effects: [],
  };
}

function emptyState() {
  return {
    schemaVersion: 3,
    statusDefinitions: structuredClone(BUILTIN_STATUS_DEFINITIONS),
    actors: [actor()],
    tokens: [{ id: 'token-1', actorId: 'actor-1', effects: [] }],
  };
}

test('built-in definitions use the server IDs and spirit bypasses only structures', () => {
  assert.deepEqual(BUILTIN_STATUS_DEFINITIONS.map(definition => definition.id), [
    'status-spirit', 'status-rooted', 'status-incapacitated',
  ]);
  const spirit = BUILTIN_STATUS_DEFINITIONS.find(definition => definition.id === 'status-spirit');
  assert.deepEqual(spirit.capabilities.collisionBypassGroups, ['structure']);
  assert.equal(Object.isFrozen(spirit.capabilities), true);
});

test('legacy Actor effects migrate deterministically to custom definitions and normalized instances', () => {
  const legacy = emptyState();
  legacy.schemaVersion = 2;
  legacy.actors[0].effects = [{
    id: 'old-bonus',
    name: '生命强化',
    enabled: true,
    changes: [{ target: 'resources.hp.max', mode: 'add', value: 10 }],
  }];

  const first = normalizeEntityStatusState(legacy);
  const second = normalizeEntityStatusState(legacy);
  assert.equal(first.schemaVersion, 3);
  assert.equal(first.statusDefinitions.length, BUILTIN_STATUS_DEFINITIONS.length + 1);
  assert.deepEqual(first.statusDefinitions, second.statusDefinitions);
  assert.equal(first.actors[0].effects[0].id, 'old-bonus');
  const migratedDefinition = first.statusDefinitions.find(definition => definition.id.startsWith('status-legacy-'));
  assert.equal(first.actors[0].effects[0].definitionId, migratedDefinition.id);
  assert.deepEqual(first.actors[0].effects[0].changes, migratedDefinition.changes);
  assert.equal('name' in first.actors[0].effects[0], false);

  const repeated = normalizeEntityStatusState(first);
  assert.deepEqual(repeated.statusDefinitions, first.statusDefinitions);
  assert.deepEqual(repeated.actors[0].effects, first.actors[0].effects);
});

test('Actor and Token effects normalize, merge duplicate definitions, and clamp stacks', () => {
  const raw = emptyState();
  raw.statusDefinitions = [{
    id: 'status-focus', name: '专注', scopes: ['actor', 'token'], maxStacks: 3,
    changes: [], capabilities: { canInteract: true },
  }];
  raw.tokens[0].effects = [
    { id: 'focus-a', definitionId: 'status-focus', stacks: 2 },
    { id: 'focus-b', definitionId: 'status-focus', stacks: 9, enabled: false },
  ];
  const normalized = normalizeEntityStatusState(raw);
  assert.equal(normalized.tokens[0].effects.length, 1);
  assert.equal(normalized.tokens[0].effects[0].stacks, 3);
  assert.equal(normalized.tokens[0].effects[0].enabled, true);
  assert.deepEqual(normalized.actors[0].effects, []);
});

test('resolveStatuses combines Actor and Token statuses with disabling capabilities taking precedence', () => {
  const raw = emptyState();
  raw.statusDefinitions = [...structuredClone(BUILTIN_STATUS_DEFINITIONS), {
    id: 'status-encouraged', name: '鼓舞', scopes: ['actor'], maxStacks: 1,
    changes: [], capabilities: { canMove: true, canInteract: true, canActInCombat: true },
  }];
  raw.actors[0].effects = [
    { id: 'rooted', definitionId: 'status-rooted', stacks: 1, enabled: true },
    { id: 'encouraged', definitionId: 'status-encouraged', stacks: 1, enabled: true },
  ];
  raw.tokens[0].effects = [{ id: 'spirit', definitionId: 'status-spirit', stacks: 1, enabled: true }];
  const resolved = resolveStatuses(raw, { tokenId: 'token-1' });
  assert.equal(resolved.actorStatuses.length, 2);
  assert.equal(resolved.tokenStatuses.length, 1);
  assert.equal(resolved.capabilities.canMove, false);
  assert.equal(resolved.capabilities.canInteract, true);
  assert.equal(resolved.capabilities.canActInCombat, true);
  assert.deepEqual(resolved.capabilities.collisionBypassGroups, ['structure']);
});

test('unconscious, dead, and B/L/A badges are derived read-only statuses', () => {
  const unconsciousState = emptyState();
  unconsciousState.actors[0].runtime.health.wounds = { bashing: 2, lethal: 3, aggravated: 0 };
  unconsciousState.actors[0].runtime.resources.hp.current = 0;
  const unconscious = resolveStatuses(unconsciousState, { actorId: 'actor-1' });
  assert.deepEqual(unconscious.derivedStatuses.map(status => status.definitionId), [
    'derived-unconscious', 'derived-wound-b', 'derived-wound-l',
  ]);
  assert.equal(unconscious.derivedStatuses.every(status => status.derived && status.readOnly), true);
  assert.equal(unconscious.capabilities.canMove, false);
  assert.equal(unconscious.capabilities.canInteract, false);
  assert.equal(unconscious.capabilities.canActInCombat, false);

  const deadState = emptyState();
  deadState.actors[0].runtime.health.wounds = { bashing: 0, lethal: 0, aggravated: 5 };
  deadState.actors[0].runtime.resources.hp.current = 0;
  const dead = resolveStatuses(deadState, { actorId: 'actor-1' });
  assert.deepEqual(dead.derivedStatuses.map(status => status.definitionId), ['derived-dead', 'derived-wound-a']);
  assert.equal(dead.derivedStatuses.some(status => status.definitionId === 'derived-unconscious'), false);
});

test('bad-status points derive the highest reached light, severe, or destruction badge', () => {
  const state = emptyState();
  state.actors[0].forms[0].badStatuses = [{
    id: 'bad-status-fear', name: '恐惧点数', light: 2, severe: 4, destruction: 7,
  }];
  state.actors[0].runtime.badStatuses = { 'bad-status-fear': 5 };
  const severe = resolveStatuses(state, { actorId: 'actor-1' });
  const badge = severe.derivedStatuses.find(status => status.definitionId.includes('bad-status-fear'));
  assert.equal(badge.label, '恐惧点数 · 重度');
  assert.equal(badge.stacks, 5);
  assert.equal(badge.readOnly, true);

  state.actors[0].runtime.badStatuses['bad-status-fear'] = 7;
  const destruction = resolveStatuses(state, { actorId: 'actor-1' });
  assert.equal(destruction.derivedStatuses.find(status => status.definitionId.includes('bad-status-fear')).label, '恐惧点数 · 毁灭');
});

test('Token status resolution carries authoritative version and structure bypass metadata', () => {
  const entities = emptyState();
  entities.tokens[0].effects = [{
    id: 'spirit', definitionId: 'status-spirit', stacks: 1, enabled: true,
  }];
  const resolved = resolveStatuses(entities, { tokenId: 'token-1' });
  assert.deepEqual(resolved.capabilities.collisionBypassGroups, ['structure']);
  assert.match(resolved.statusVersion, /^[0-9a-f]{8}$/);

  entities.tokens[0].effects.push({
    id: 'rooted', definitionId: 'status-rooted', stacks: 1, enabled: true,
  });
  const changed = resolveStatuses(entities, { tokenId: 'token-1' });
  assert.notEqual(changed.statusVersion, resolved.statusVersion);
  assert.equal(changed.capabilities.canMove, false);
});

test('disabled effects remain editable but do not affect resolved capabilities', () => {
  const state = emptyState();
  state.actors[0].effects = [{
    id: 'rooted', definitionId: 'status-rooted', stacks: 1, enabled: false, note: '暂时压制',
  }];
  const resolved = resolveStatuses(state, { actorId: 'actor-1' });
  assert.equal(resolved.actorStatuses.length, 1);
  assert.equal(resolved.actorStatuses[0].enabled, false);
  assert.equal(resolved.actorStatuses[0].note, '暂时压制');
  assert.equal(resolved.statuses.some(status => status.definitionId === 'status-rooted'), false);
  assert.equal(resolved.capabilities.canMove, true);
});

test('offline reducer applies server-shaped operations atomically', () => {
  const initial = emptyState();
  const definition = {
    id: 'status-warded', name: '守护', scopes: ['actor'], maxStacks: 3,
    changes: [{ target: 'resources.hp.max', mode: 'add', value: 2 }], capabilities: {},
  };
  const defined = reduceStatusOperation(initial, { type: 'status.definition.upsert', definition });
  const applied = reduceStatusOperation(defined.state, {
    type: 'status.batch',
    operations: [
      { type: 'status.apply', scope: 'actor', targetId: 'actor-1', definitionId: 'status-warded', stacks: 1 },
      { type: 'status.setStacks', scope: 'actor', targetId: 'actor-1', definitionId: 'status-warded', stacks: 3 },
    ],
  }, { now: '2026-08-26T00:00:00.000Z', idFactory: () => 'effect-fixed' });
  assert.equal(applied.state.actors[0].effects[0].id, 'effect-fixed');
  assert.equal(applied.state.actors[0].effects[0].stacks, 3);
  assert.deepEqual(applied.state.actors[0].effects[0].changes, definition.changes);
  assert.equal(resolveResource(applied.state.actors[0], 'hp').max, 11);
  assert.equal(initial.statusDefinitions.length, BUILTIN_STATUS_DEFINITIONS.length);
  assert.equal(initial.actors[0].effects.length, 0);

  assert.throws(() => reduceStatusOperation(applied.state, {
    type: 'status.batch',
    operations: [
      { type: 'status.remove', scope: 'actor', targetId: 'actor-1', definitionId: 'status-warded' },
      { type: 'status.setStacks', scope: 'actor', targetId: 'actor-1', definitionId: 'missing', stacks: 2 },
    ],
  }));
  assert.equal(applied.state.actors[0].effects.length, 1);
  assert.equal(getStatusDefinitions(applied.state).some(item => item.id === 'status-warded'), true);
});
