import test from 'node:test';
import assert from 'node:assert/strict';
import { getStatusDefinitions, normalizeEntityStatusState, resolveActorEffects, resolveTokenEffects,
  resolveStatuses } from '../src/status/model.js';

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(freeze);
  return Object.freeze(value);
}

const ruleset = { statuses: { derive: () => [] } };
function definitions() {
  return [
    { id: 'memo-root', name: 'Root', scopes: ['actor', 'token'], capabilities: { canMove: false }, maxStacks: 2 },
    { id: 'memo-strength', name: 'Strength', scopes: ['actor'], maxStacks: 3,
      changes: [{ target: 'attributes.strength', mode: 'add', value: 2 }], capabilities: {} },
  ];
}
function state(statusDefinitions, { id = 'actor-a', actorEffects = [], tokenEffects = [], secret = 'private-a' } = {}) {
  return { schemaVersion: 4, statusDefinitions,
    actors: [{ id, system: { secret }, effects: actorEffects }],
    tokens: [{ id: `${id}-token`, actorId: id, effects: tokenEffects }] };
}
function resolve(input) {
  return resolveStatuses(input, { tokenId: input.tokens[0].id, ruleset });
}
function mutableOracle(input) {
  return resolve({ ...input, statusDefinitions: structuredClone(input.statusDefinitions) });
}

test('immutable definition memo matches uncached resolution and public APIs still detach all nested values', () => {
  const frozen = freeze(definitions());
  const input = state(frozen, { actorEffects: [{ id: 'strength', definitionId: 'memo-strength', stacks: 2 }],
    tokenEffects: [{ id: 'root', definitionId: 'memo-root', stacks: 1 }] });
  const before = structuredClone(input);
  assert.deepEqual(resolve(input), mutableOracle(input));
  assert.deepEqual(resolveActorEffects(input.actors[0], frozen), resolveActorEffects(input.actors[0], structuredClone(frozen)));
  assert.deepEqual(resolveTokenEffects(input.tokens[0], frozen), resolveTokenEffects(input.tokens[0], structuredClone(frozen)));
  const publicDefinitions = getStatusDefinitions(input);
  const publicNormalized = normalizeEntityStatusState(input);
  assert.deepEqual(publicDefinitions, getStatusDefinitions({ statusDefinitions: structuredClone(frozen) }));
  assert.equal(Object.isFrozen(publicDefinitions), false);
  assert.equal(Object.isFrozen(publicDefinitions[0].capabilities), false);
  assert.equal(Object.isFrozen(publicNormalized.statusDefinitions), false);
  publicDefinitions[0].capabilities.canMove = true;
  publicDefinitions[1].changes[0].value = 100;
  publicNormalized.statusDefinitions[0].scopes.push('invalid');
  const result = resolve(input);
  result.actorStatuses[0].changes[0].value = 999;
  result.tokenStatuses[0].capabilities.canMove = true;
  assert.deepEqual(resolve(input), mutableOracle(input));
  assert.deepEqual(input, before);
});

test('memo avoids repeated normalization clones while retaining required public result clones', () => {
  const frozen = freeze(definitions());
  const input = state(frozen);
  const expected = resolve(input); // Warm the immutable collection once.
  const originalClone = globalThis.structuredClone;
  let definitionClones = 0;
  globalThis.structuredClone = value => {
    if (typeof value?.id === 'string' && value.id.startsWith('memo-')) definitionClones++;
    return originalClone(value);
  };
  try {
    for (let i = 0; i < 6; i++) assert.deepEqual(resolve(input), expected);
    assert.equal(definitionClones, 0, 'no-effect movement resolution should not clone or normalize definitions again');
    const publicValues = getStatusDefinitions(input);
    assert.equal(definitionClones, frozen.length, 'public views must still be detached once per returned definition');
    publicValues[0].name = 'Changed';
    assert.equal(getStatusDefinitions(input)[0].name, 'Root');
  } finally { globalThis.structuredClone = originalClone; }
});

test('mutable and shallow-frozen definition collections observe edits without stale memo results', () => {
  for (const shallow of [false, true]) {
    const values = definitions();
    if (shallow) Object.freeze(values);
    const input = state(values, { tokenEffects: [{ id: 'root', definitionId: 'memo-root' }] });
    const first = resolve(input);
    assert.equal(first.capabilities.canMove, false);
    values[0].capabilities.canMove = true;
    values[0].name = 'Updated Root';
    const second = resolve(input);
    assert.equal(second.capabilities.canMove, true);
    assert.equal(second.tokenStatuses[0].label, 'Updated Root');
    assert.notEqual(second.statusVersion, first.statusVersion);
    assert.deepEqual(second, mutableOracle(input));
  }
});

test('definition replacement and import references invalidate independently of the stable definition IDs', () => {
  const original = freeze(definitions());
  const first = state(original, { actorEffects: [{ id: 'root', definitionId: 'memo-root' }] });
  const old = resolve(first);
  const replacement = freeze(definitions().map(value => value.id === 'memo-root'
    ? { ...value, capabilities: { canMove: true } } : value));
  const imported = { ...first, statusDefinitions: replacement };
  const next = resolve(imported);
  assert.equal(next.capabilities.canMove, true);
  assert.notEqual(next.statusVersion, old.statusVersion);
  assert.deepEqual(next, mutableOracle(imported));
  assert.equal(resolve(first).capabilities.canMove, false);
});

test('legacy migration and scope extension use independent working definitions with a frozen baseline', () => {
  const original = freeze([{ id: 'memo-scope', name: 'Scope', scopes: ['actor'], builtIn: false, changes: [],
    capabilities: { canInteract: false } }]);
  for (const effects of [
    [{ id: 'scope', definitionId: 'memo-scope' }],
    [{ id: 'legacy', name: 'Legacy Spirit', capabilities: { collisionBypassGroups: ['structure'] } }],
  ]) {
    const input = state(original, { tokenEffects: effects });
    assert.deepEqual(resolve(input), mutableOracle(input));
    assert.deepEqual(normalizeEntityStatusState(input), normalizeEntityStatusState({
      ...input, statusDefinitions: structuredClone(original),
    }));
    assert.deepEqual(original[0].scopes, ['actor']);
    assert.equal(original.length, 1);
  }
  assert.deepEqual(resolve(state(original, { tokenEffects: [{ id: 'scope', definitionId: 'memo-scope' }] }))
    .tokenStatuses[0].scopes, ['actor', 'token']);
});

test('duplicate definition precedence and legacy 128-entry cutoff remain identical to the uncached paths', () => {
  const duplicate = freeze([
    { id: 'memo-dupe', name: 'First', scopes: ['actor'], capabilities: { canMove: true } },
    { id: 'memo-dupe', name: 'Last', scopes: ['actor'], capabilities: { canMove: false } },
  ]);
  const actor = { id: 'actor', effects: [{ id: 'effect', definitionId: 'memo-dupe' }] };
  assert.equal(getStatusDefinitions({ statusDefinitions: duplicate })[0].name, 'First');
  assert.equal(resolveActorEffects(actor, duplicate)[0].name, 'Last');
  assert.deepEqual(resolveActorEffects(actor, duplicate), resolveActorEffects(actor, structuredClone(duplicate)));
  const values = [null, ...Array.from({ length: 129 }, (_, i) => ({
    id: `memo-limit-${i}`, name: `Definition ${i}`, scopes: ['actor'], capabilities: { canMove: i < 127 },
  }))];
  const input = state(freeze(values), { actorEffects: [{ id: 'past-limit', definitionId: 'memo-limit-127' }] });
  assert.equal(getStatusDefinitions(input).length, 129, 'public getter has no normalizer cutoff');
  assert.deepEqual(resolve(input), mutableOracle(input), 'cutoff applies to input positions before invalid definitions are filtered');
  assert.equal(normalizeEntityStatusState(input).statusDefinitions.length, 128); // Adds one migrated inline definition.
});

test('shared immutable definitions never reuse another Actor or Token private status result or version', () => {
  const frozen = freeze(definitions());
  const restricted = state(frozen, { id: 'restricted', secret: 'private-restricted',
    actorEffects: [{ id: 'root-a', definitionId: 'memo-root', note: 'private note' }] });
  const allowed = state(frozen, { id: 'allowed', secret: 'private-allowed' });
  const blocked = resolve(restricted), open = resolve(allowed);
  assert.equal(blocked.capabilities.canMove, false);
  assert.equal(open.capabilities.canMove, true);
  assert.equal(open.statuses.length, 0);
  assert.notEqual(blocked.statusVersion, open.statusVersion);
  assert.deepEqual(blocked, mutableOracle(restricted));
  assert.deepEqual(open, mutableOracle(allowed));
  restricted.actors[0].effects = [];
  restricted.actors[0].system.secret = 'changed-private-state';
  const unblocked = resolve(restricted);
  assert.equal(unblocked.capabilities.canMove, true);
  assert.notEqual(unblocked.statusVersion, blocked.statusVersion);
});
