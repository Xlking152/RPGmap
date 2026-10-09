import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareCanonicalMovementInputs, validateAuthoritativeTokenMovePath } from '../src/server/movement-authority-entry.js';
import { createMovementAuthority, resolveMovementStatus } from '../src/movement/authority.js';
import { resolveTokenActor } from '../src/token/actor.js';
import { infiniteHorrorRuleset as ruleset } from '../src/rulesets/infinite-horror/index.js';
import { createCanonicalWorldValidator } from '../deployment/local-server/world-schema.mjs';
import { applyWorldOperations, projectWorldOperationState } from '../src/world/operations.js';
import { createMinimalReferencePackage } from '../reference/maps/minimal/package.js';
import { migrateTestStateToWorldV3 } from './helpers/world-v3.js';

const map = createMinimalReferencePackage();
const worldOf = state => state.preferences.worldV2;
function setup() {
  const actor = { id: 'actor-inputs', name: 'Inputs', type: 'pc', system: {}, effects: [],
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
  const token = { id: 'token-inputs', actorId: actor.id, actorLink: true, actorDelta: null,
    placement: 'map', x: 700, y: 430, diameterMeters: 1, elevationMeters: 0 };
  const state = migrateTestStateToWorldV3({ preferences: { worldV2: {
    schemaVersion: 2, id: 'world-inputs', name: 'Inputs', ruleset: { id: ruleset.id, version: ruleset.version },
    activeSceneId: 'scene-inputs', actors: [actor], statusDefinitions: [{ id: 'stop', name: 'Stop', scopes: ['actor', 'token'],
      maxStacks: 1, changes: [], capabilities: { canMove: false } }], scenes: [{ id: 'scene-inputs', name: 'Inputs',
      mapPackage: { id: map.id, version: map.version }, tokens: [token], markers: [], attackAreas: [], sceneEvents: [],
      featureStates: {}, settings: {} }] } } });
  const validate = createCanonicalWorldValidator(); validate(state);
  return { state, validate };
}
function args(state, validate) {
  const world = worldOf(state), scene = world.scenes[0], token = scene.tokens[0];
  return { state, world, scene, token, ruleset, isCanonicalData: validate.isImmutableData,
    origin: { x: token.x, y: token.y }, waypoints: [{ x: token.x + 5, y: token.y }] };
}
function check(state, validate, reusable = true) {
  const input = args(state, validate), before = JSON.stringify(state);
  const prepared = prepareCanonicalMovementInputs(input);
  if (reusable) {
    assert.ok(prepared);
    assert.deepEqual(prepared.actor, resolveTokenActor(input.world, input.token.id, { ruleset }).actor);
    assert.deepEqual(prepared.status, resolveMovementStatus(input.world, input.scene, input.token, ruleset));
  } else assert.equal(prepared, null);
  assert.deepEqual(validateAuthoritativeTokenMovePath(input), createMovementAuthority(() => map)(input));
  assert.equal(JSON.stringify(state), before);
  return prepared;
}
test('coordinate-only moves reuse canonical inputs without changing status, costs or collision results', () => {
  const { state: original, validate } = setup(); let state = original;
  for (let index = 0; index < 8; index++) {
    const prepared = check(state, validate);
    prepared.actor.system = { polluted: true };
    prepared.status.capabilities.canMove = false;
    assert.notEqual(check(state, validate).actor.system.polluted, true);
    state = applyWorldOperations(state, [{ type: 'token.move', payload: {
      tokenId: 'token-inputs', x: 700 + (index + 1) * 5, y: 430 } }]).state;
    validate(state);
  }
});
test('Actor, Token effects, definitions and synthetic deltas invalidate cached movement inputs', () => {
  const { state, validate } = setup(); check(state, validate);
  for (const change of [
    next => { worldOf(next).actors[0].effects = [{ id: 'stop-a', definitionId: 'stop', stacks: 1, enabled: true }]; },
    next => { worldOf(next).scenes[0].tokens[0].effects = [{ id: 'stop-t', definitionId: 'stop', stacks: 1, enabled: true }]; },
    next => { worldOf(next).statusDefinitions[0].capabilities = { canMove: true }; },
    next => { const token = worldOf(next).scenes[0].tokens[0]; token.actorLink = false;
      token.actorDelta = { system: { runtime: { movementCapabilities: { fly: true } } }, effects: [] }; },
  ]) {
    const next = structuredClone(state); change(next); projectWorldOperationState(next); validate(next);
    check(next, validate, worldOf(next).scenes[0].tokens[0].actorLink === true);
    check(state, validate);
  }
});
test('custom Ruleset hooks and mutable, unaccepted or detached inputs retain the original resolver', () => {
  const { state, validate } = setup(), input = args(state, validate);
  for (const modified of [{ ...input, ruleset: { ...ruleset } }, { ...input, isCanonicalData: undefined },
    { ...input, isCanonicalData: () => false }, { ...input, token: structuredClone(input.token) },
    { ...input, isCanonicalData: () => 'true' },
    { ...input, scene: { ...input.scene, tokens: [] } }]) assert.equal(prepareCanonicalMovementInputs(modified), null);
  let calls = 0;
  const custom = { ...ruleset, statuses: { ...ruleset.statuses, derive(...values) {
    calls++; return ruleset.statuses.derive(...values);
  } } };
  for (let i = 0; i < 2; i++) validateAuthoritativeTokenMovePath({ ...input, ruleset: custom });
  assert.equal(calls, 2);
});
test('legacy Actors with clock-dependent defaults retain fresh complete normalization', () => {
  const { state, validate } = setup();
  for (const field of ['createdAt', 'updatedAt']) {
    const next = structuredClone(state); delete worldOf(next).actors[0][field];
    projectWorldOperationState(next); validate(next); check(next, validate, false);
  }
});
test('separate server bundles explicitly select their fixed Ruleset instance and invalidate on replacement', () => {
  const { state, validate } = setup(), input = args(state, validate);
  const bundled = Object.freeze({ ...ruleset });
  const trusted = { ...input, ruleset: bundled, canonicalMovementRuleset: bundled };
  assert.equal(prepareCanonicalMovementInputs({ ...trusted, canonicalMovementRuleset: ruleset }), null);
  assert.deepEqual(prepareCanonicalMovementInputs(trusted).status, resolveMovementStatus(input.world, input.scene, input.token, bundled));
  assert.deepEqual(validateAuthoritativeTokenMovePath(trusted), createMovementAuthority(() => map)(trusted));
  check(state, validate);
});
test('cache turnover across 70 canonical Actors does not change later results or retain caller mutations', () => {
  const { state, validate } = setup(); check(state, validate);
  for (let i = 0; i < 70; i++) {
    const next = structuredClone(state), world = worldOf(next);
    world.actors[0].id = `actor-turnover-${i}`;
    world.scenes[0].tokens[0].actorId = world.actors[0].id;
    world.scenes[0].tokens[0].id = `token-turnover-${i}`;
    projectWorldOperationState(next); validate(next); check(next, validate);
  }
  check(state, validate);
});

test('unrelated Actor collection replacement preserves only exact accepted Actor dependencies', () => {
  const { state: original, validate } = setup();
  const originalWorld = worldOf(original);
  const other = { ...structuredClone(originalWorld.actors[0]), id: 'actor-other', name: 'Other' };
  const state = { ...original, preferences: { ...original.preferences,
    worldV2: { ...originalWorld, actors: [...originalWorld.actors, other] } } };
  validate(state);
  let calls = 0;
  // The host's fixed bundled instance can be instrumented without mutating
  // the public Ruleset. This counter proves reuse while outputs stay identical.
  const fixed = Object.freeze({ ...ruleset, statuses: Object.freeze({ ...ruleset.statuses,
    derive(...values) { calls++; return ruleset.statuses.derive(...values); } }) });
  const prepare = next => prepareCanonicalMovementInputs({ ...args(next, validate),
    ruleset: fixed, canonicalMovementRuleset: fixed });
  const initial = prepare(state);
  assert.equal(calls, 1);
  const unrelated = { ...state, preferences: { ...state.preferences,
    worldV2: { ...worldOf(state), actors: [worldOf(state).actors[0],
      { ...structuredClone(worldOf(state).actors[1]), name: 'Changed other' }] } } };
  validate(unrelated);
  assert.deepEqual(prepare(unrelated), initial);
  assert.equal(calls, 1, 'unchanged accepted Actor does not rederive because the collection changed');
  const changed = { ...unrelated, preferences: { ...unrelated.preferences,
    worldV2: { ...worldOf(unrelated), actors: [{ ...structuredClone(worldOf(unrelated).actors[0]),
      effects: [{ id: 'stop-a', definitionId: 'stop', stacks: 1, enabled: true }] }, worldOf(unrelated).actors[1]] } } };
  changed.preferences.entitySystem = { ...changed.preferences.entitySystem };
  projectWorldOperationState(changed); validate(changed);
  const result = prepare(changed);
  assert.equal(calls, 2, 'same-ID replacement still requires new status derivation');
  assert.equal(result.status.capabilities.canMove, false);
  assert.deepEqual(result.actor, resolveTokenActor(worldOf(changed), 'token-inputs', { ruleset }).actor);
  result.status.capabilities.canMove = true;
  assert.equal(prepare(changed).status.capabilities.canMove, false, 'returned data is still detached');
  check(changed, validate);
});
