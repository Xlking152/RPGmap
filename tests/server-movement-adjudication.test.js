import test from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultActor } from '../src/actor/index.js';
import { infiniteHorrorRuleset } from '../src/rulesets/infinite-horror/index.js';
import { normalizeSceneToken } from '../src/token/model.js';
import { resolveTokenActor } from '../src/token/actor.js';
import { applyWorldOperationsAsync, markMovementAdjudicationRequired } from '../src/world/operations.js';
import { createServerMovementAdjudicationActorResolver } from '../src/server/movement-adjudication.js';
import { createCanonicalWorldValidator } from '../deployment/local-server/world-schema.mjs';
import { applyStatusMessage } from '../deployment/local-server/status-operations.mjs';
import { migrateTestStateToWorldV3 } from './helpers/world-v3.js';

const now = '2026-10-07T07:00:00.000Z';
const worldOf = state => state.preferences.worldV2;
const ruleset = infiniteHorrorRuleset;
const focused = { id: 'focused', name: 'Focused', description: '', icon: 'shield', color: '#225588',
  category: 'buff', scopes: ['actor', 'token'], maxStacks: 3, changes: [], capabilities: {} };

function fixture(actorCount = 6, tokenCount = 18) {
  const actors = Array.from({ length: actorCount }, (_, index) => {
    const actor = createDefaultActor({ id: `actor-${index}`, name: `Actor ${index}`, type: 'pc', ruleset });
    actor.system.runtime.movementCapabilities = { fly: index % 2 === 0, walk: true, swim: true,
      waterWalk: index % 3 === 0, swimSpeedMeters: index % 2 === 0 ? 5 : null };
    if (!index) actor.effects = [{ id: 'existing-effect', definitionId: focused.id, stacks: 1, enabled: true,
      appliedAt: now, source: { userId: 'gm' } }];
    return actor;
  });
  const tokens = Array.from({ length: tokenCount }, (_, index) => {
    const actor = actors[index % actorCount];
    return normalizeSceneToken({ id: `token-${index}`, actorId: actor.id, actorLink: true,
      placement: 'map', x: 10 + index, y: 20, elevationMeters: 4,
      movement: { mode: 'fly', capabilities: { fly: index % 3 === 0 }, adjudicationRequired: false } },
    { actor, ruleset });
  });
  return migrateTestStateToWorldV3({ markers: [], attackAreas: [], sceneEvents: [], preferences: {
    worldV2: { schemaVersion: 3, id: 'world-adjudication', name: 'Adjudication',
      ruleset: { id: ruleset.id, version: ruleset.version }, activeSceneId: 'scene', actors,
      statusDefinitions: [focused], createdAt: now, updatedAt: now,
      scenes: [{ id: 'scene', name: 'Scene', mapPackage: { id: 'map', version: '1' }, tokens,
        markers: [], attackAreas: [], sceneEvents: [], featureStates: {}, settings: { gridVisible: true },
        fog: { schemaVersion: 1, cellSizeMeters: 5, exploredByParty: {} } }] },
  } });
}

function accepted(actorCount, tokenCount) {
  const state = fixture(actorCount, tokenCount), validate = createCanonicalWorldValidator();
  validate(state);
  return { state, validate, resolve: createServerMovementAdjudicationActorResolver({
    isCanonicalData: validate.isImmutableData,
  }) };
}

function transaction(state, overrides = {}) {
  return { ...state, preferences: { ...state.preferences,
    worldV2: { ...worldOf(state), ...overrides } } };
}

test('accepted fixed server Actors give the same descriptor as full public resolution without exposing mutable authority', () => {
  const { state, validate, resolve } = accepted();
  const world = worldOf(state), scene = world.scenes[0], before = JSON.stringify(state);
  for (const token of scene.tokens) {
    const actor = resolve({ world, scene, token, ruleset });
    assert.strictEqual(actor, world.actors.find(item => item.id === token.actorId));
    assert.equal(validate.isImmutableData(actor), true);
    assert.equal(Object.isFrozen(actor.system.runtime.movementCapabilities), true);
    const normalized = resolveTokenActor(world, token.id, { ruleset }).actor;
    assert.deepEqual(ruleset.movement.describe(actor, { token, scene, world }),
      ruleset.movement.describe(normalized, { token, scene, world }));
    assert.throws(() => { actor.system.runtime.movementCapabilities.fly = false; }, TypeError);
  }
  assert.equal(JSON.stringify(state), before);
});

test('adjudication keeps fresh per-Token grants, elevation, multiple scenes and synthetic Actor deltas', () => {
  const { state, resolve } = accepted();
  const world = worldOf(state), scene = world.scenes[0];
  const synthetic = normalizeSceneToken({ ...structuredClone(scene.tokens[0]), id: 'synthetic', actorLink: false,
    actorDelta: { system: { runtime: { movementCapabilities: { fly: true } } } },
    movement: { mode: 'fly', capabilities: {} } }, { actor: world.actors[0], ruleset });
  const second = { ...scene, id: 'other', tokens: [
    { ...scene.tokens[0], id: 'other-flying', movement: { ...scene.tokens[0].movement, capabilities: { fly: true } } },
    { ...scene.tokens[0], id: 'other-falling', movement: { ...scene.tokens[0].movement, capabilities: { fly: false } } },
    synthetic,
  ] };
  const input = transaction(state, { scenes: [...world.scenes, second] });
  const expected = transaction(input), actual = transaction(input);
  let syntheticCalls = 0, hits = 0;
  const changed = markMovementAdjudicationRequired(actual, ruleset, args => {
    if (args.token.actorLink === false) syntheticCalls++;
    const actor = resolve(args); if (actor) hits++; return actor;
  });
  assert.equal(changed, markMovementAdjudicationRequired(expected, ruleset));
  assert.deepEqual(actual, expected);
  assert.equal(hits, world.actors.length);
  assert.equal(syntheticCalls, 0);
  assert.deepEqual(worldOf(actual).scenes[1].tokens.map(token => token.movement.adjudicationRequired), [false, true, false]);
  const swapped = transaction(state, { scenes: [{ ...scene, tokens: scene.tokens.map(token => ({ ...token,
    elevationMeters: 0, movement: { ...token.movement, mode: 'walk', capabilities: { walk: false } } })) }] });
  const after = transaction(swapped);
  assert.equal(markMovementAdjudicationRequired(after, ruleset, resolve), true);
  assert.equal(worldOf(after).scenes[0].tokens.every(token => token.movement.adjudicationRequired), true);
  assert.equal(scene.tokens.every(token => !token.movement.adjudicationRequired), true);
});

test('new, changed, foreign-proof, synthetic, legacy and unknown ruleset inputs use the original resolver', () => {
  const { state, resolve } = accepted(), world = worldOf(state), scene = world.scenes[0], token = scene.tokens[0];
  const args = { world, scene, token, ruleset }, actor = world.actors[0];
  const foreign = createCanonicalWorldValidator(), foreignActor = structuredClone(actor);
  foreign({ payload: foreignActor });
  for (const other of [structuredClone(actor), { ...actor, name: 'changed' }, foreignActor]) {
    assert.equal(resolve({ ...args, world: { ...world, actors: [other] } }), null);
  }
  assert.equal(resolve({ ...args, world: { ...world, actors: [structuredClone(actor), actor] } }), null);
  for (const other of [undefined, {}, { ...ruleset }, { ...ruleset, id: 'unknown' }]) {
    assert.equal(resolve({ ...args, ruleset: other }), null);
  }
  assert.equal(resolve({ ...args, token: { ...token, actorLink: false } }), null);
  assert.equal(resolve({ ...args, token: { ...token, actorLink: undefined } }), null);
  assert.equal(resolve({ ...args, token: { ...token, actorId: 'missing' } }), null);
  assert.equal(resolve({ ...args, world: { ...world, schemaVersion: 3 } }), null);
  assert.equal(resolve({ ...args, world: { ...world, ruleset: { ...world.ruleset, version: 'unknown' } } }), null);
  assert.equal(createServerMovementAdjudicationActorResolver()(args), null);
  assert.equal(createServerMovementAdjudicationActorResolver({ isCanonicalData: () => { throw Error('proof failure'); } })(args), null);
});

test('accepted JSON alone cannot qualify legacy or invalid modern Actor systems', () => {
  const { state } = accepted(), world = worldOf(state), scene = world.scenes[0], token = scene.tokens[0];
  const validate = createCanonicalWorldValidator();
  const resolve = createServerMovementAdjudicationActorResolver({ isCanonicalData: validate.isImmutableData });
  const changes = [
    actor => { actor.runtime = { movementCapabilities: { fly: false } }; },
    actor => { actor.forms = []; },
    actor => { actor.currentFormId = 'legacy'; },
    actor => { actor.system.schemaVersion = 2; },
    actor => { actor.system.forms = {}; },
    actor => { actor.system.runtime = []; },
    actor => { actor.system.runtime.movementCapabilities = []; },
    actor => { actor.system.currentFormId = 'missing'; },
    actor => { actor.system.runtime.resources.hp = { current: 1 }; },
    actor => { actor.system.forms[0].resourceBases.hp = { max: 2 }; },
  ];
  for (const change of changes) {
    const actor = structuredClone(world.actors[0]); change(actor); validate({ payload: actor });
    assert.equal(validate.isImmutableData(actor), true);
    assert.equal(resolve({ world: { ...world, actors: [actor] }, scene, token, ruleset }), null);
  }
});

test('a changed Actor immediately loses the shortcut and its new movement grants are adjudicated', () => {
  const { state, resolve } = accepted(), world = worldOf(state), scene = world.scenes[0];
  const changed = structuredClone(world.actors[0]);
  changed.system.runtime.movementCapabilities.fly = false;
  const input = transaction(state, { actors: [changed, ...world.actors.slice(1)], scenes: [{ ...scene,
    tokens: scene.tokens.map(token => token.actorId === changed.id
      ? { ...token, movement: { ...token.movement, capabilities: {} } } : token) }] });
  const actual = transaction(input), expected = transaction(input), misses = [];
  markMovementAdjudicationRequired(actual, ruleset, args => {
    const actor = resolve(args); if (!actor) misses.push(args.token.actorId); return actor;
  });
  markMovementAdjudicationRequired(expected, ruleset);
  assert.deepEqual(actual, expected);
  assert.deepEqual(misses, [changed.id]);
  assert.equal(worldOf(actual).scenes[0].tokens.filter(token => token.actorId === changed.id)
    .every(token => token.movement.adjudicationRequired), true);
  assert.equal(world.actors[0].system.runtime.movementCapabilities.fly, true);
  assert.equal(scene.tokens.every(token => !token.movement.adjudicationRequired), true);
});

test('real server status path with 100 Actors and 500 Tokens shares 99 unchanged Actors and exactly matches full resolution', async () => {
  const { state, validate, resolve } = accepted(100, 500), before = JSON.stringify(state);
  const operations = [{ type: 'status.setStacks', payload: {
    scope: 'actor', targetId: 'actor-0', statusId: focused.id, stacks: 2, enabled: false, note: 'updated',
  } }];
  const common = { now, source: { role: 'gm', userId: 'gm' }, ruleset,
    isCanonicalData: validate.isImmutableData, trustedOperationHooks: true,
    applyStatus(current, message) {
      return applyStatusMessage(current, message, { now, mutate: true, assumeNormalized: true,
        userId: 'gm', sessionId: 'session' });
    } };
  const expected = await applyWorldOperationsAsync(state, operations, common);
  const hits = [], misses = [];
  const actual = await applyWorldOperationsAsync(state, operations, { ...common,
    prepareMovementAdjudicationActor(args) {
      const actor = resolve(args); (actor ? hits : misses).push(args.token.actorId); return actor;
    } });
  assert.deepEqual(actual, expected);
  assert.equal(JSON.stringify(actual), JSON.stringify(expected));
  assert.equal(hits.length, 99);
  assert.deepEqual(misses, ['actor-0']);
  assert.equal(new Set(hits).size, 99);
  assert.strictEqual(worldOf(actual.state).actors[1], worldOf(state).actors[1]);
  assert.notStrictEqual(worldOf(actual.state).actors[0], worldOf(state).actors[0]);
  assert.equal(worldOf(actual.state).actors[0].effects[0].stacks, 2);
  assert.equal(worldOf(actual.state).scenes[0].tokens.length, 500);
  assert.deepEqual(worldOf(actual.state).scenes[0].tokens.map(token => token.movement.adjudicationRequired),
    Array.from({ length: 500 }, (_, index) => index % 3 !== 0));
  validate(actual.state);
  assert.equal(validate.isImmutableData(actual.state), true);
  assert.equal(JSON.stringify(state), before);
});
