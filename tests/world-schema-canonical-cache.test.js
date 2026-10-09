import test from 'node:test';
import assert from 'node:assert/strict';
import { assertWorldState, createCanonicalWorldValidator, WORLD_LIMITS } from '../deployment/local-server/world-schema.mjs';
import { INFINITE_HORROR_STATUS_DEFINITIONS } from '../src/rulesets/infinite-horror/statuses.js';
import { migrateTestStateToWorldV3 } from './helpers/world-v3.js';

function canonicalFixture() {
  const actor = { id: 'actor-a', name: 'A', type: 'pc', partyId: null, system: {}, effects: [] };
  const token = (id, x) => ({ id, actorId: actor.id, actorLink: true, actorDelta: null,
    placement: 'map', x, y: 2, featureId: null, diameterMeters: 1, rotation: 0, elevationMeters: 0,
    hidden: false, locked: false, showName: true, effects: [] });
  return migrateTestStateToWorldV3({ preferences: { worldV2: {
    schemaVersion: 2, id: 'world-cache', name: 'Cache',
    ruleset: { id: 'infinite-horror', version: '1.1.0' }, activeSceneId: 'scene-cache',
    actors: [actor], statusDefinitions: structuredClone(INFINITE_HORROR_STATUS_DEFINITIONS),
    scenes: [{ id: 'scene-cache', mapPackage: { id: 'test', version: '1' },
      tokens: [token('token-a', 1), token('token-b', 3)], markers: [], attackAreas: [], sceneEvents: [],
      settings: { gridVisible: true } }],
  } } });
}

function movedCandidate(before) {
  const world = before.preferences.worldV2;
  const scene = world.scenes[0];
  const entity = before.preferences.entitySystem;
  return { ...before, preferences: { ...before.preferences,
    worldV2: { ...world, scenes: [{ ...scene, tokens: [{ ...scene.tokens[0], x: 5 }, scene.tokens[1]] }] },
    entitySystem: { ...entity, tokens: [{ ...entity.tokens[0], x: 5 }, entity.tokens[1]] },
  } };
}

function assertSameRejection(validate, candidate) {
  let oracle;
  try { assertWorldState(candidate); } catch (error) { oracle = error; }
  assert.ok(oracle, 'the full validator must reject the candidate');
  assert.throws(() => validate(candidate), { code: oracle.code });
}

test('canonical validation freezes accepted branches and revalidates changed branches', () => {
  const validate = createCanonicalWorldValidator();
  const first = { preferences: {}, payload: { nested: ['valid', 1] } };
  validate(first);
  assert.equal(Object.isFrozen(first.payload.nested), true);
  assert.throws(() => { first.payload.nested.push(2); }, TypeError);
  const next = { ...first, preferences: { ...first.preferences }, movement: { x: 2, y: 3 } };
  assert.equal(validate(next), next);
  assert.throws(() => validate({ ...next, movement: { x: Infinity, y: 3 } }), /finite numbers/);
  assert.throws(() => validate({ ...next, movement: { x: 'x'.repeat(WORLD_LIMITS.maxStringLength + 1) } }), { code: 'world_limit' });
});

test('cached canonical branches still count each occurrence toward node and depth limits', () => {
  const validate = createCanonicalWorldValidator();
  const shared = Array(1000).fill(0);
  const first = { a: Array(100).fill(shared) };
  validate(first);
  // Half the graph retains identical paths and references. The new half must
  // still contribute the full cost, including every repeated shared branch.
  assert.throws(() => validate({ ...first, b: Array(100).fill(shared) }), { code: 'world_limit' });
  let nested = { leaf: 1 };
  for (let index = 0; index < 22; index += 1) nested = { child: nested };
  const atLimit = { payload: nested };
  validate(atLimit);
  assert.throws(() => validate({ payload: { child: nested } }), { code: 'world_limit' });
});

test('untrusted mutable inputs never inherit canonical reference validation', () => {
  const mutable = { preferences: {}, payload: { value: 1 } };
  assertWorldState(mutable);
  assert.equal(Object.isFrozen(mutable.payload), false);
  mutable.payload.value = Infinity;
  assert.throws(() => assertWorldState(mutable), /finite numbers/);
  const validate = createCanonicalWorldValidator();
  const rejected = { payload: { good: [1, 2], bad: Infinity } };
  assert.throws(() => validate(rejected), /finite numbers/);
  assert.equal(Object.isFrozen(rejected.payload.good), false);
  rejected.payload.good[0] = NaN;
  rejected.payload.bad = 1;
  assert.throws(() => validate(rejected), /finite numbers/);
});

test('Fog dictionary exemptions remain path-specific for cached branches', () => {
  const validate = createCanonicalWorldValidator();
  const rows = Object.fromEntries(Array.from({ length: 300 }, (_, index) => [index, [[0, 0]]]));
  // A minimal legacy state can carry an opaque Fog-like field, allowing us to
  // isolate generic JSON limits from the independent World V2 Fog validator.
  const first = { scene: { fog: { exploredByParty: { party: { rows } } } } };
  validate(first);
  assert.throws(() => validate({ ...first, ordinary: { rows } }), { code: 'world_limit' });
});

test('cached canonical documents match full validation on movement and still check global references', () => {
  const validate = createCanonicalWorldValidator();
  const before = canonicalFixture();
  validate(before);
  const after = movedCandidate(before);
  assert.equal(assertWorldState(after), after);
  assert.equal(validate(after), after);
  assert.equal(Object.isFrozen(after.preferences.worldV2.scenes[0].tokens[0]), true);

  const scene = after.preferences.worldV2.scenes[0];
  const duplicate = movedCandidate(after);
  duplicate.preferences.worldV2.scenes[0].tokens[1] = scene.tokens[0];
  assertSameRejection(validate, duplicate);

  const missingAnchor = movedCandidate(after);
  missingAnchor.preferences.worldV2.scenes[0].attackAreas = [
    { id: 'area-a', anchor: { type: 'token', tokenId: 'missing-token' } },
  ];
  assertSameRejection(validate, missingAnchor);
});

test('Actor and status-definition changes invalidate cached Token checks', () => {
  const validate = createCanonicalWorldValidator();
  const before = canonicalFixture();
  before.preferences.entitySystem.tokens[1].effects = [
    { id: 'effect-rooted', definitionId: 'status-rooted', stacks: 1, enabled: true },
  ];
  validate(before);

  const changedActor = movedCandidate(before);
  changedActor.preferences.worldV2.actors = [{ ...before.preferences.worldV2.actors[0], type: 'monster' }];
  assertSameRejection(validate, changedActor);

  const changedDefinitions = movedCandidate(before);
  changedDefinitions.preferences.entitySystem.statusDefinitions = [];
  changedDefinitions.preferences.worldV2.statusDefinitions = [];
  assertSameRejection(validate, changedDefinitions);

  let previous = before;
  for (let index = 0; index < 16; index += 1) {
    const next = movedCandidate(previous);
    next.preferences.worldV2.actors = [{ ...previous.preferences.worldV2.actors[0] }];
    next.preferences.entitySystem.actors = [{ ...previous.preferences.entitySystem.actors[0] }];
    next.preferences.worldV2.statusDefinitions = structuredClone(previous.preferences.worldV2.statusDefinitions);
    next.preferences.entitySystem.statusDefinitions = structuredClone(previous.preferences.entitySystem.statusDefinitions);
    assert.equal(assertWorldState(next), next);
    assert.equal(validate(next), next);
    previous = next;
  }
  const invalidAfterReplacements = movedCandidate(previous);
  invalidAfterReplacements.preferences.worldV2.statusDefinitions = [];
  invalidAfterReplacements.preferences.entitySystem.statusDefinitions = [];
  assertSameRejection(validate, invalidAfterReplacements);
});

test('a structurally rejected candidate cannot seed document validation', () => {
  const validate = createCanonicalWorldValidator();
  const before = canonicalFixture();
  validate(before);
  const candidate = movedCandidate(before);
  const scene = candidate.preferences.worldV2.scenes[0];
  scene.fog = { ...scene.fog, exploredByParty: { party: { rows: { 1: [[4, 3]] } } } };
  assertSameRejection(validate, candidate);
  assert.equal(Object.isFrozen(scene.tokens[0]), false);

  scene.fog = structuredClone(before.preferences.worldV2.scenes[0].fog);
  scene.tokens[0].x = 'invalid';
  assertSameRejection(validate, candidate);
});

test('public full validation never trusts a shallow-frozen document from a canonical call', () => {
  const validate = createCanonicalWorldValidator();
  const canonical = canonicalFixture();
  validate(canonical);
  const untrusted = canonicalFixture();
  const token = untrusted.preferences.worldV2.scenes[0].tokens[0];
  Object.freeze(token);
  assert.equal(assertWorldState(untrusted), untrusted);
  untrusted.preferences.worldV2.scenes[0].tokens[1].x = Infinity;
  assert.throws(() => assertWorldState(untrusted), /finite numbers/);
});

test('single-path JSON summaries promote through many aliases without changing bytes or occurrence budgets', () => {
  const validate = createCanonicalWorldValidator();
  const shared = { ranges: Array.from({ length: 1000 }, (_, index) => [index, index + 1]) };
  const first = { first: shared };
  validate(first);
  assert.equal(validate.serializedBytes(first), Buffer.byteLength(JSON.stringify(first)));
  // More than eight paths exercises the bounded alias cache and eviction;
  // revisiting the initial path must still enforce the same full accounting.
  for (let index = 0; index < 12; index++) {
    const value = { [`alias${index}`]: shared, repeated: shared };
    assert.equal(assertWorldState(value), value);
    assert.equal(validate(value), value);
    assert.equal(validate.serializedBytes(value), Buffer.byteLength(JSON.stringify(value)));
  }
  assert.equal(validate({ first: shared }).first, shared);
  const tooManyOccurrences = { repeated: Array(67).fill(shared) };
  assertSameRejection(validate, tooManyOccurrences);
  const rejected = { first: shared, changed: { invalid: Infinity } };
  assertSameRejection(validate, rejected);
  assert.equal(Object.isFrozen(rejected.changed), false);
  rejected.changed.invalid = 1;
  assert.equal(validate(rejected), rejected);
  assert.equal(validate.isImmutableData(rejected), true);
});
