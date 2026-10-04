import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { projectStateForAudience } from '../src/vision/audience.js';

const audienceUrl = new URL('../src/vision/audience.js', import.meta.url);
const source = readFileSync(audienceUrl, 'utf8');
// Retain the complete pre-change Actor selection, independent of its new
// return representation. The surrounding projection code is unchanged.
const previousSelection = `  world.actors = (world.actors || []).flatMap(actor => {
    const actorId = String(actor.id);
    const access = ownershipLevel(context.user, actorId);
    const owned = access === 'owner';
    const observed = access === 'observer';
    const limited = access === 'limited';
    const allied = Boolean((actor.type === 'pc' || actor.type === 'summon')
      && actor.partyId && parties.has(String(actor.partyId)));
    const placementGranted = actorPlacementGranted(actor, context);
    if (!referencedActorIds.has(actorId) && !owned && !observed && !limited && !allied && !placementGranted) {
      hiddenActorIds.add(actorId);
      return [];
    }
    const prior = movementCache && previousActors.get(actorId) === actor ? projectedActors.get(actorId) : null;
    if (privateActorIds.has(actorId) || owned || observed || allied) return [prior && prior.audienceRestricted !== true ? prior : clone(actor)];
    restrictedActorIds.add(actorId);
    return [prior?.audienceRestricted === true ? prior : restrictedActor(actor)];
  });
`;

async function instrumentedProjection(previous) {
  let code = source;
  if (previous) {
    const start = code.indexOf('  world.actors = (world.actors || []).flatMap(actor => {');
    const end = code.indexOf('  world.actors.push(...vagueActors);', start);
    assert.ok(start >= 0 && end > start);
    code = code.slice(0, start) + previousSelection + code.slice(end);
  }
  code = code.replace('const clone = structuredClone;', `
    let cloneObserver = () => {};
    export function observeClones(observer) { cloneObserver = observer; }
    const clone = value => { cloneObserver(value); return structuredClone(value); };
  `).replace(/from\s+(['"])(\.\.?\/[^'"]+)\1/g,
    (_match, quote, relative) => `from ${quote}${new URL(relative, audienceUrl).href}${quote}`);
  code += `\n//# sourceURL=vision-audience-actor-selection-${previous ? 'previous' : 'current'}.mjs`;
  return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
}
const current = await instrumentedProjection(false);
const previous = await instrumentedProjection(true);
const map = { id: 'actor-selection-map', version: '1', width: 1_000, height: 1_000,
  metersPerUnit: 1, features: [] };
const ruleset = { vision: { describe: () => ({ preciseRangeMeters: 120, vagueRangeMeters: 300, senses: {} }) } };

function fixture(traced = false) {
  const trace = [], labels = new WeakMap();
  const specs = [
    ['scout', 'pc', 'p'], ['observed', 'npc', null], ['limited', 'npc', null],
    ['allied', 'summon', 'p'], ['grant', 'npc', null], ['near', 'npc', null],
    ['vague', 'npc', null], ['hidden', 'npc', null], ['far', 'npc', null],
  ];
  const actors = specs.map(([id, type, partyId]) => {
    const values = { id, name: id, type, partyId, notes: `private-${id}`, system: { privateValue: id },
      effects: [], prototypeToken: {}, publicProfile: {}, organization: {} };
    const actor = {};
    for (const [key, value] of Object.entries(values)) {
      Object.defineProperty(actor, key, traced ? { enumerable: true,
        get() { trace.push(`actor:${id}:${key}`); return value; } }
        : { enumerable: true, configurable: true, writable: true, value });
    }
    labels.set(actor, `actor:${id}`);
    return actor;
  });
  const token = (id, actorId, x) => ({ id, actorId, actorLink: true, actorDelta: null,
    placement: 'map', x, y: 10, elevationMeters: 0, diameterMeters: 1, effects: [],
    controllerUserIds: [], visibility: { mode: 'public', userIds: [] }, vision: { enabled: true } });
  const tokens = [token('source', 'scout', 10), token('near-token', 'near', 30),
    token('vague-token', 'vague', 180), token('far-token', 'far', 900)];
  const scene = { id: 'scene', settings: { lighting: 'normal' }, tokens, featureStates: {},
    sceneEvents: [],
    markers: [], attackAreas: [], fog: { cellSizeMeters: 5,
      exploredByParty: { p: { rows: { 0: [[1, 2]] } }, secret: { rows: { 10: [[4, 8]] } } } } };
  const state = { preferences: { worldV2: { schemaVersion: 4, activeSceneId: scene.id,
    actors, scenes: [scene], statusDefinitions: [], journals: [] }, chatSystem: { messages: [
      { id: 'safe', data: { tokenId: 'source' } }, { id: 'private-event', data: { actorId: 'hidden' } },
    ] } } };
  const ownership = {};
  const levels = { scout: 'owner', observed: 'observer', limited: 'limited' };
  for (const [id] of specs) Object.defineProperty(ownership, id, traced ? { enumerable: true,
    get() { trace.push(`ownership:${id}`); return levels[id] || 'none'; } }
    : { enumerable: true, configurable: true, writable: true, value: levels[id] || 'none' });
  const grants = { actorIds: ['grant'] };
  const user = { ownership };
  Object.defineProperty(user, 'placementGrants', traced ? { enumerable: true,
    get() { trace.push('placement-grants'); return grants; } }
    : { enumerable: true, configurable: true, writable: true, value: grants });
  const context = { role: 'player', userId: 'viewer', user, visionSourceTokenId: 'source',
    ruleset, mapPackage: map, mapMetrics: { metersPerUnit: 1 }, trustedProjection: true,
    opaqueIdFor: (kind, id) => `opaque-${kind}-${id}`, lookupOpaqueId: (kind, id) => `opaque-${kind}-${id}` };
  return { state, context, trace, labels };
}
function projectWithTrace(module, values) {
  values.trace.length = 0;
  module.observeClones(value => values.trace.push(`clone:${values.labels.get(value) || typeof value}`));
  try { return module.projectStateForAudience(values.state, values.context); }
  finally { module.observeClones(() => {}); }
}
function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(freeze);
  return Object.freeze(value);
}
function move(before) {
  const world = before.preferences.worldV2, scene = world.scenes[0];
  return freeze({ ...before, preferences: { ...before.preferences, worldV2: { ...world,
    scenes: [{ ...scene, tokens: scene.tokens.map(token => token.id === 'source' ? { ...token, x: 11 } : token) }],
  } } });
}

test('Actor selection preserves full old projection, permission reads and clone order across access branches', () => {
  for (const trustedProjection of [false, true]) {
    const actualInput = fixture(true), expectedInput = fixture(true);
    actualInput.context.trustedProjection = expectedInput.context.trustedProjection = trustedProjection;
    const actual = projectWithTrace(current, actualInput), expected = projectWithTrace(previous, expectedInput);
    assert.deepEqual(actual, expected);
    assert.deepEqual(actualInput.trace, expectedInput.trace);
    const fresh = fixture();
    assert.deepEqual(projectStateForAudience(fresh.state, { ...fresh.context, trustedProjection }), expected);
    const actors = actual.preferences.worldV2.actors;
    assert.deepEqual(actors.map(actor => actor.id), ['scout', 'observed', 'limited', 'allied', 'grant',
      'near', 'opaque-actor-vague-token']);
    for (const id of ['limited', 'grant', 'near']) assert.equal(actors.find(actor => actor.id === id).audienceRestricted, true);
    for (const id of ['scout', 'observed', 'allied']) assert.equal(actors.find(actor => actor.id === id).notes, `private-${id}`);
    assert.equal(actual.preferences.worldV2.scenes[0].fog.exploredByParty.secret, undefined);
  }
});

test('Actor selection preserves prior object reuse and nested Array Actor/prior shapes', () => {
  for (const arrayActor of [false, true]) {
    const values = fixture();
    if (arrayActor) values.state.preferences.worldV2.actors[0] = Object.assign(['nested-actor-entry'],
      values.state.preferences.worldV2.actors[0]);
    const before = freeze(values.state), after = move(before);
    const actualPrior = current.projectStateForAudience(before, values.context);
    const expectedPrior = previous.projectStateForAudience(before, values.context);
    const options = projection => ({ ...values.context,
      movementCache: { beforeState: before, previousProjection: projection, tokenIds: new Set(['source']) } });
    let actual = current.projectStateForAudience(after, options(actualPrior));
    let expected = previous.projectStateForAudience(after, options(expectedPrior));
    assert.deepEqual(actual, expected);
    for (const id of ['scout', 'near']) {
      assert.equal(actual.preferences.worldV2.actors.find(actor => actor.id === id),
        actualPrior.preferences.worldV2.actors.find(actor => actor.id === id));
    }
    assert.equal(Array.isArray(actual.preferences.worldV2.actors[0]), arrayActor);
    for (const projection of [actualPrior, expectedPrior]) {
      projection.preferences.worldV2.actors = projection.preferences.worldV2.actors.map(actor =>
        ['scout', 'near'].includes(actor.id) ? Object.assign([], actor, { 0: 'nested-prior-entry' }) : actor);
    }
    actual = current.projectStateForAudience(after, options(actualPrior));
    expected = previous.projectStateForAudience(after, options(expectedPrior));
    assert.deepEqual(actual, expected);
    for (const id of ['scout', 'near']) {
      const actor = actual.preferences.worldV2.actors.find(actor => actor.id === id);
      assert.equal(Array.isArray(actor), true);
      assert.equal(actor[0], 'nested-prior-entry');
      assert.equal(actor, actualPrior.preferences.worldV2.actors.find(item => item.id === id));
    }
  }
});

test('ordinary Actor selections avoid wrapper arrays and exclusions share a frozen empty selection', () => {
  const values = fixture(), actors = values.state.preferences.worldV2.actors;
  const nativeFlatMap = Array.prototype.flatMap, selections = [];
  Array.prototype.flatMap = function (callback, thisArg) {
    return Reflect.apply(nativeFlatMap, this, [function (value, index, input) {
      const selected = Reflect.apply(callback, thisArg, [value, index, input]);
      if (input === actors) selections.push(selected);
      return selected;
    }]);
  };
  let projected;
  try { projected = projectStateForAudience(values.state, values.context); }
  finally { Array.prototype.flatMap = nativeFlatMap; }
  const exclusions = selections.filter(Array.isArray);
  assert.equal(exclusions.length, 3);
  assert.ok(exclusions.every(value => value === exclusions[0] && value.length === 0 && Object.isFrozen(value)));
  assert.equal(selections.filter(value => !Array.isArray(value)).length, 6);
  assert.deepEqual(projected, previous.projectStateForAudience(values.state, values.context));
});
