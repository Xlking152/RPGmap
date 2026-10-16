import test from 'node:test';
import assert from 'node:assert/strict';
import { applyWorldOperationsAsync, createWorldOperationPatch } from '../src/world/operations.js';
import { createDefaultActor } from '../src/actor/model.js';
import { normalizeSceneToken } from '../src/token/model.js';
import { infiniteHorrorRuleset as ruleset } from '../src/rulesets/infinite-horror/index.js';
import { createCanonicalWorldValidator, assertWorldState } from '../deployment/local-server/world-schema.mjs';
import { applyStatusMessage } from '../deployment/local-server/status-operations.mjs';
import { migrateTestStateToWorldV3 } from './helpers/world-v3.js';

const now = '2026-10-16T00:00:00.000Z';
const worldOf = state => state.preferences.worldV2;
const sceneOf = state => worldOf(state).scenes[0];
const projectedTokens = state => state.preferences.entitySystem.tokens;
const focused = { id: 'focused', name: 'Focused', category: 'buff', scopes: ['actor', 'token'],
  maxStacks: 3, changes: [], capabilities: {} };
const effect = id => ({ id, definitionId: focused.id, stacks: 1, enabled: true, source: {}, createdAt: now });

function fixture({ bulk = false } = {}) {
  const actor = createDefaultActor({ id: 'actor', type: 'pc', ruleset });
  actor.effects = [effect('actor-effect')];
  const tokens = ['linked', 'synthetic', 'other'].map((id, index) => {
    const token = normalizeSceneToken({ id, actorId: actor.id, actorLink: id !== 'synthetic',
      placement: 'map', x: 10 + index, y: 20, effects: [effect(`${id}-effect`)],
      ...(bulk && !index ? { extension: Array(500).fill(0) } : {}),
    }, { actor, ruleset });
    if (id === 'synthetic') token.actorDelta.effects = [effect('synthetic-actor-effect')];
    return token;
  });
  return migrateTestStateToWorldV3({ markers: [], attackAreas: [], sceneEvents: [], preferences: {
    worldV2: { schemaVersion: 3, id: 'world', name: 'World',
      ruleset: { id: ruleset.id, version: ruleset.version }, activeSceneId: 'scene', actors: [actor],
      statusDefinitions: [focused], createdAt: now, updatedAt: now,
      scenes: [{ id: 'scene', name: 'Scene', mapPackage: { id: 'test', version: '1' }, tokens,
        markers: [], attackAreas: [], sceneEvents: [], featureStates: {}, settings: { gridVisible: true },
        fog: { schemaVersion: 1, cellSizeMeters: 5, exploredByParty: {} } }] },
  } });
}

function context(validate, overrides = {}) {
  return { now, ruleset, source: { role: 'gm', userId: 'gm' }, trustedOperationHooks: true,
    isCanonicalData: validate.isImmutableData, mapPackage: { width: 1000, height: 1000, metersPerUnit: 1 },
    applyStatus(state, message) {
      return applyStatusMessage(state, message, { now, mutate: true, assumeNormalized: true,
        userId: 'gm', sessionId: 'session' });
    }, ...overrides };
}

const move = (tokenId = 'linked', x = 30) => ({ type: 'token.move', payload: { tokenId, x, y: 40 } });
const setStacks = (scope, targetId) => ({ type: 'status.setStacks', payload: {
  scope, targetId, statusId: focused.id, stacks: 2,
} });

test('accepted server movement shares only changed Token leaves and preserves full serialized output', async () => {
  for (const compactMetadata of [false, true]) for (const type of ['token.move', 'token.reposition', 'token.movePath']) {
    const before = fixture(), validate = createCanonicalWorldValidator({ compactMetadata });
    validate(before);
    const beforeBytes = JSON.stringify(before);
    const operation = type === 'token.movePath' ? { type, payload: { tokenId: 'linked',
      tokenIds: ['linked', 'synthetic'], expectedOrigins: { linked: { x: 10, y: 20 }, synthetic: { x: 11, y: 20 } },
      waypoints: [{ x: 25, y: 30 }, { x: 30, y: 40 }],
    } } : { ...move(), type };
    const expected = await applyWorldOperationsAsync(before, [operation], context(validate, { trustedOperationHooks: false }));
    const actual = await applyWorldOperationsAsync(before, [operation], context(validate));
    assert.deepEqual(actual, expected);
    assert.equal(JSON.stringify(actual), JSON.stringify(expected));
    assert.notStrictEqual(sceneOf(actual.state).tokens, projectedTokens(actual.state));
    const changed = type === 'token.movePath' ? [0, 1] : [0];
    for (const index of changed) {
      assert.strictEqual(sceneOf(actual.state).tokens[index], projectedTokens(actual.state)[index]);
      assert.notStrictEqual(sceneOf(actual.state).tokens[index], sceneOf(before).tokens[index]);
      assert.notStrictEqual(sceneOf(expected.state).tokens[index], projectedTokens(expected.state)[index]);
    }
    assert.strictEqual(sceneOf(actual.state).tokens[2], sceneOf(before).tokens[2]);
    validate(actual.state);
    assert.equal(validate.isImmutableData(actual.state), true);
    assert.equal(validate.serializedBytes(actual.state), Buffer.byteLength(JSON.stringify(actual.state)));
    assert.equal(Object.isFrozen(projectedTokens(actual.state)[0].vision), true);
    assert.equal(JSON.stringify(before), beforeBytes);
    const again = await applyWorldOperationsAsync(actual.state, [move('linked', 35)], context(validate));
    assert.equal(sceneOf(actual.state).tokens[0].x, 30);
    assert.strictEqual(sceneOf(again.state).tokens[0], projectedTokens(again.state)[0]);
    assert.equal(sceneOf(again.state).tokens[0].x, 35);
    validate(again.state);
  }
});

test('default, untrusted, nonboolean and unaccepted inputs keep detached movement projections', async () => {
  for (const kind of ['default', 'untrusted', 'truthy-trust', 'missing-proof', 'false-proof', 'truthy-proof',
    'mutable', 'frozen-unaccepted', 'accepted-accessor']) {
    const before = fixture(), validate = createCanonicalWorldValidator();
    if (kind === 'accepted-accessor') Object.defineProperty(before, 'extension', {
      enumerable: true, get() { return { counter: 1 }; },
    });
    if (!['mutable', 'frozen-unaccepted'].includes(kind)) validate(before);
    if (kind === 'frozen-unaccepted') createCanonicalWorldValidator()(before);
    const overrides = {
      untrusted: { trustedOperationHooks: false }, 'truthy-trust': { trustedOperationHooks: 1 },
      'missing-proof': { isCanonicalData: undefined }, 'false-proof': { isCanonicalData: () => false },
      'truthy-proof': { isCanonicalData: () => 'true' },
    }[kind] || {};
    const result = await applyWorldOperationsAsync(before, [move()], kind === 'default' ? { now } : context(validate, overrides));
    const canonical = sceneOf(result.state).tokens[0], projected = projectedTokens(result.state)[0];
    assert.notStrictEqual(canonical, projected, kind);
    assert.notStrictEqual(canonical.vision, projected.vision, kind);
    projected.vision.enabled = !canonical.vision.enabled;
    assert.notEqual(projected.vision.enabled, canonical.vision.enabled, kind);
    assert.equal(sceneOf(before).tokens[0].x, 10);
  }
});

test('callbacks observe the old independent projection until the entire movement batch completes', async () => {
  const before = fixture(), validate = createCanonicalWorldValidator(); validate(before);
  const calls = [];
  const result = await applyWorldOperationsAsync(before, [move('linked', 30), move('linked', 35)], context(validate, {
    prepareOperation({ state, index }) {
      calls.push(['before', index, sceneOf(state).tokens[0].x, projectedTokens(state)[0].x]);
      assert.notStrictEqual(sceneOf(state).tokens[0], projectedTokens(state)[0]);
      return index;
    },
    onOperationApplied({ state, index, prepared }) {
      assert.equal(prepared, index);
      calls.push(['after', index, sceneOf(state).tokens[0].x, projectedTokens(state)[0].x]);
      assert.notStrictEqual(sceneOf(state).tokens[0], projectedTokens(state)[0]);
    },
  }));
  assert.deepEqual(calls, [['before', 0, 10, 10], ['after', 0, 30, 10],
    ['before', 1, 30, 10], ['after', 1, 35, 10]]);
  assert.strictEqual(sceneOf(result.state).tokens[0], projectedTokens(result.state)[0]);
  validate(result.state);
});

test('explicit and movement-generated statuses retain detached projections and complete status effects', async () => {
  for (const generated of [false, true]) {
    const before = fixture(), validate = createCanonicalWorldValidator(); validate(before);
    const status = setStacks('token', 'linked');
    const options = context(validate, generated ? {
      validateTokenMovePath() { return { valid: true, statusOperations: [status] }; },
    } : {});
    const result = await applyWorldOperationsAsync(before, generated ? [move()] : [move(), status], options);
    assert.deepEqual(result.operations.map(operation => operation.type), ['token.move', 'status.setStacks']);
    assert.notStrictEqual(sceneOf(result.state).tokens[0], projectedTokens(result.state)[0]);
    assert.equal(sceneOf(result.state).tokens[0].x, 30);
    assert.equal(sceneOf(result.state).tokens[0].effects[0].stacks, 2);
    assert.equal(projectedTokens(result.state)[0].effects[0].stacks, 2);
    assert.equal(sceneOf(before).tokens[0].effects[0].stacks, 1);
    validate(result.state);
  }
});

test('the next Token, synthetic Actor or Actor status uses copy on write after shared movement', async () => {
  for (const [scope, targetId] of [['token', 'linked'], ['syntheticActor', 'synthetic'], ['actor', 'actor']]) {
    const before = fixture(), validate = createCanonicalWorldValidator(); validate(before);
    const moved = (await applyWorldOperationsAsync(before, [move(), move('synthetic', 31)], context(validate))).state;
    validate(moved);
    const saved = JSON.stringify(moved);
    const actual = await applyWorldOperationsAsync(moved, [setStacks(scope, targetId)], context(validate));
    const canonical = scope === 'actor' ? worldOf(actual.state).actors[0]
      : scope === 'syntheticActor' ? sceneOf(actual.state).tokens[1].actorDelta : sceneOf(actual.state).tokens[0];
    assert.equal(canonical.effects[0].stacks, 2);
    const unchangedIndex = scope === 'token' ? 1 : 0;
    assert.strictEqual(sceneOf(actual.state).tokens[unchangedIndex], sceneOf(moved).tokens[unchangedIndex]);
    assert.equal(JSON.stringify(moved), saved);
    assert.equal(worldOf(moved).actors[0].effects[0].stacks, 1);
    assert.equal(sceneOf(moved).tokens[0].effects[0].stacks, 1);
    assert.equal(sceneOf(moved).tokens[1].actorDelta.effects[0].stacks, 1);
    validate(actual.state);
    assert.equal(validate.serializedBytes(actual.state), Buffer.byteLength(JSON.stringify(actual.state)));
  }
});

test('shared movement leaves count every alias in serialized bytes and the global node budget', async () => {
  for (const compactMetadata of [false, true]) {
    const before = fixture({ bulk: true }), validate = createCanonicalWorldValidator({ compactMetadata }); validate(before);
    const moved = (await applyWorldOperationsAsync(before, [move()], context(validate))).state;
    validate(moved);
    const token = sceneOf(moved).tokens[0];
    const aliases = { ...moved, aliases: [token, token] };
    validate(aliases);
    assert.equal(validate.serializedBytes(aliases), Buffer.byteLength(JSON.stringify(aliases)));
    const oversized = { ...moved, aliases: Array(1000).fill(token) };
    assert.throws(() => assertWorldState(oversized), { code: 'world_limit' });
    assert.throws(() => validate(oversized), { code: 'world_limit' });
  }
});

test('trusted canonical patch content shortcut matches the complete clone oracle and detects every content field', async () => {
  const before = fixture(), validate = createCanonicalWorldValidator(); validate(before);
  const moved = (await applyWorldOperationsAsync(before, [move()], context(validate))).state; validate(moved);
  const changes = [null, ['markers', [{ id: 'marker', kind: 'note', x: 2, y: 3,
    controllerUserIds: [], visibility: { mode: 'public', userIds: [] }, partyId: null }]],
    ['attackAreas', [{ id: 'area', origin: { x: 1, y: 2 } }]],
    ['sceneEvents', [{ id: 'event', type: 'damage', featureIds: ['wall'] }]],
    ['settings', { gridVisible: false }]];
  for (const change of changes) {
    const after = change ? { ...moved, preferences: { ...moved.preferences,
      worldV2: { ...worldOf(moved), scenes: [{ ...sceneOf(moved), [change[0]]: change[1] }] } } } : moved;
    validate(after);
    const actual = createWorldOperationPatch(before, after, { trustedCanonical: true });
    const expected = createWorldOperationPatch(before, after);
    assert.deepEqual(actual, expected);
    assert.equal(JSON.stringify(actual), JSON.stringify(expected));
    assert.equal(actual.world.scenes.content.length, change ? 1 : 0);
    if (change) assert.notStrictEqual(actual.world.scenes.content[0][change[0]], change[1]);
  }
});

test('default patch content still performs its original getter reads and clone failures', () => {
  for (const throwOnRead of [false, true]) {
    const before = fixture(), after = structuredClone(before), trace = [];
    for (const [label, state] of [['before', before], ['after', after]]) {
      const entry = { id: 'marker' };
      Object.defineProperty(entry, 'value', { enumerable: true, get() {
        trace.push(label);
        if (throwOnRead) throw new Error('content getter');
        return label;
      } });
      sceneOf(state).markers = [entry];
    }
    if (throwOnRead) {
      assert.throws(() => createWorldOperationPatch(before, after), /content getter/);
      assert.deepEqual(trace, ['before']);
    } else {
      const patch = createWorldOperationPatch(before, after);
      assert.deepEqual(trace, ['before', 'after', 'after']);
      assert.equal(patch.world.scenes.content[0].markers[0].value, 'after');
    }
  }
});
