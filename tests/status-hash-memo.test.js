import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeActorDelta } from '../src/token/actor.js';

let moduleNumber = 0;
const freshModel = () => import(`../src/status/model.js?hash-memo-test=${++moduleNumber}`);
const ruleset = { statuses: { derive: () => [] } };

// Preserve the pre-memo sorting and FNV formula independently of the resolver.
function oldSorted(value) {
  if (Array.isArray(value)) return value.map(oldSorted);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, oldSorted(value[key])]));
}
function oldHash(source) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < source.length; i++) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
function oldInput(model, input, context = {}) {
  const entities = context.assumeNormalized ? input : model.normalizeEntityStatusState(input);
  const token = context.token || entities.tokens.find(item => String(item.id) === String(context.tokenId)) || null;
  const actorId = context.actorId ?? context.actor?.id ?? token?.actorId ?? null;
  const actor = context.actor || entities.actors.find(item => String(item.id) === String(actorId)) || null;
  const definitions = model.getStatusDefinitions(entities);
  return JSON.stringify(oldSorted({
    definitions: definitions.map(definition => ({ id: definition.id, capabilities: definition.capabilities,
      changes: definition.changes, maxStacks: definition.maxStacks })),
    actorId: actor?.id || null, actorEffects: actor?.effects || [], tokenId: token?.id || null,
    tokenEffects: token?.effects || [], system: actor?.system || null,
  }));
}
function state(key = 'actor', payload = 'x'.repeat(4_096)) {
  return { schemaVersion: 4,
    statusDefinitions: [{ id: 'memo-blocked', name: 'Blocked', scopes: ['actor', 'token'],
      capabilities: { canMove: false }, maxStacks: 2 }],
    actors: [{ id: key, system: { payload, secret: `secret-${key}` }, effects: [] }],
    tokens: [{ id: `${key}-token`, actorId: key, effects: [] }] };
}
const contextFor = (input, extra = {}) => ({ tokenId: input.tokens[0].id, ruleset, ...extra });
function verify(model, input, context = contextFor(input)) {
  const expected = oldHash(oldInput(model, input, context));
  const actual = model.resolveStatuses(input, context);
  assert.equal(actual.statusVersion, expected);
  assert.equal(typeof actual.statusVersion, 'string');
  return actual;
}
function hashCalls(callback) {
  const original = Math.imul;
  let calls = 0;
  Math.imul = (a, b) => {
    if (b === 0x01000193) calls++;
    return original(a, b);
  };
  try { return { value: callback(), calls }; }
  finally { Math.imul = original; }
}
function sizedState(model, key, characters) {
  const input = state(key, '');
  const emptyLength = oldInput(model, input, contextFor(input)).length;
  input.actors[0].system.payload = 'x'.repeat(characters - emptyLength);
  assert.equal(oldInput(model, input, contextFor(input)).length, characters);
  return input;
}

test('hash memo preserves the old UTF-16, JSON and effect/definition/synthetic version semantics', async () => {
  const model = await freshModel();
  const input = state('unicode', '地图😀\ud800\u0000\\"'.repeat(512));
  Object.assign(input.actors[0].system, { absent: undefined, nested: { z: -0, a: null },
    list: [undefined, NaN, Infinity, '🥳'], finite: 3.5 });
  const initial = verify(model, input);
  assert.equal(verify(model, input).statusVersion, initial.statusVersion);
  input.actors[0].system.nested.a = 'changed';
  const changedSystem = verify(model, input);
  assert.notEqual(changedSystem.statusVersion, initial.statusVersion);
  input.actors[0].effects = [{ id: 'actor-block', definitionId: 'memo-blocked', note: '私有注释', stacks: 1 }];
  const actorEffect = verify(model, input);
  assert.equal(actorEffect.capabilities.canMove, false);
  assert.notEqual(actorEffect.statusVersion, changedSystem.statusVersion);
  input.tokens[0].effects = [{ id: 'token-block', definitionId: 'memo-blocked', enabled: false }];
  const tokenEffect = verify(model, input);
  assert.notEqual(tokenEffect.statusVersion, actorEffect.statusVersion);
  input.statusDefinitions[0].capabilities.canMove = true;
  const definition = verify(model, input);
  assert.equal(definition.capabilities.canMove, true);
  assert.notEqual(definition.statusVersion, tokenEffect.statusVersion);
  const base = structuredClone(input.actors[0]);
  input.tokens[0].actorLink = false;
  input.tokens[0].actorDelta = { system: { secret: 'instance-private' }, effects: [] };
  input.actors[0] = mergeActorDelta(base, input.tokens[0].actorDelta);
  const synthetic = verify(model, input);
  assert.notEqual(synthetic.statusVersion, definition.statusVersion);
  input.tokens[0].actorDelta.system.secret = 'instance-changed';
  input.actors[0] = mergeActorDelta(base, input.tokens[0].actorDelta);
  assert.notEqual(verify(model, input).statusVersion, synthetic.statusVersion);
});

test('mutable getters and proxies are read before every exact-string cache lookup', async () => {
  const model = await freshModel();
  for (const proxy of [false, true]) {
    const input = state(proxy ? 'proxy' : 'getter');
    let value = 'first';
    let reads = 0;
    Object.defineProperty(input.actors[0].system, 'dynamic', { enumerable: true,
      get() { reads++; return value; } });
    if (proxy) input.actors[0].system = new Proxy(input.actors[0].system, {});
    const context = contextFor(input, { assumeNormalized: proxy });
    const first = verify(model, input, context);
    const beforeHit = reads;
    assert.equal(verify(model, input, context).statusVersion, first.statusVersion);
    assert.ok(reads > beforeHit);
    value = 'second';
    assert.notEqual(verify(model, input, context).statusVersion, first.statusVersion);
  }
});

test('large-string hits skip only the FNV loop while normalization and Ruleset derivation stay fresh', async () => {
  const model = await freshModel();
  const input = state('fresh-derived');
  let derives = 0;
  let reads = 0;
  Object.defineProperty(input.actors[0].system, 'readEveryTime', { enumerable: true,
    get() { reads++; return 'same-value'; } });
  const context = contextFor(input, { ruleset: { statuses: { derive(actor) {
    derives++;
    return [{ definitionId: 'derived-fresh', label: `Invocation ${derives}`, enabled: true,
      capabilities: { canMove: true }, changes: [], privateValues: { secret: actor.system.secret } }];
  } } } });
  const expected = oldHash(oldInput(model, input, context));
  const length = oldInput(model, input, context).length;
  const first = hashCalls(() => model.resolveStatuses(input, context));
  assert.equal(first.calls, length);
  assert.equal(first.value.statusVersion, expected);
  first.value.derivedStatuses[0].privateValues.secret = 'caller-overwrite';
  first.value.capabilities.canMove = false;
  const readsBeforeHit = reads;
  const second = hashCalls(() => model.resolveStatuses(input, context));
  assert.equal(second.calls, 0);
  assert.equal(second.value.statusVersion, expected);
  assert.equal(derives, 2);
  assert.ok(reads > readsBeforeHit);
  assert.equal(second.value.derivedStatuses[0].label, 'Invocation 2');
  assert.equal(second.value.derivedStatuses[0].privateValues.secret, input.actors[0].system.secret);
  assert.equal(second.value.capabilities.canMove, true);
  assert.notEqual(second.value, first.value);
  assert.notEqual(second.value.derivedStatuses[0], first.value.derivedStatuses[0]);
});

test('cache eligibility keeps exact lower/upper character bounds and falls back outside them', async () => {
  const model = await freshModel();
  for (const characters of [2_047, 2_048, 65_536, 65_537]) {
    const input = sizedState(model, `size-${characters}`, characters);
    const context = contextFor(input);
    const expected = oldHash(oldInput(model, input, context));
    assert.equal(hashCalls(() => model.resolveStatuses(input, context)).calls, characters);
    const again = hashCalls(() => model.resolveStatuses(input, context));
    assert.equal(again.calls, characters === 2_047 || characters === 65_537 ? characters : 0);
    assert.equal(again.value.statusVersion, expected);
  }
});

test('entry limit is LRU and refreshing a hit preserves it while evicting the oldest entry', async () => {
  const model = await freshModel();
  const inputs = Array.from({ length: 33 }, (_, index) => sizedState(model, `entry-${index}`, 3_000));
  for (const input of inputs.slice(0, 32)) verify(model, input);
  assert.equal(hashCalls(() => model.resolveStatuses(inputs[0], contextFor(inputs[0]))).calls, 0);
  verify(model, inputs[32]);
  assert.equal(hashCalls(() => model.resolveStatuses(inputs[0], contextFor(inputs[0]))).calls, 0);
  const evicted = hashCalls(() => model.resolveStatuses(inputs[1], contextFor(inputs[1])));
  assert.equal(evicted.calls, 3_000);
  assert.equal(evicted.value.statusVersion, oldHash(oldInput(model, inputs[1], contextFor(inputs[1]))));
});

test('aggregate character budget evicts old large keys before the entry limit', async () => {
  const model = await freshModel();
  const inputs = Array.from({ length: 9 }, (_, index) => sizedState(model, `budget-${index}`, 60_000));
  for (const input of inputs) verify(model, input);
  assert.equal(hashCalls(() => model.resolveStatuses(inputs[8], contextFor(inputs[8]))).calls, 0);
  const evicted = hashCalls(() => model.resolveStatuses(inputs[0], contextFor(inputs[0])));
  assert.equal(evicted.calls, 60_000);
  assert.equal(evicted.value.statusVersion, oldHash(oldInput(model, inputs[0], contextFor(inputs[0]))));
});
