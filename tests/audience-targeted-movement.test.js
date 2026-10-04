import test from 'node:test';
import assert from 'node:assert/strict';
import { projectStateForAudience } from '../src/vision/audience.js';
import { projectStateForAudience as previousProjection } from './fixtures/audience-before-targeted-movement.mjs';
import { createCanonicalWorldValidator } from '../deployment/local-server/world-schema.mjs';
import { createDocumentChanges, createDocumentChangesFull } from '../src/documents/changes.js';
import { applyWorldOperations } from '../src/world/operations.js';
import { INFINITE_HORROR_STATUS_DEFINITIONS } from '../src/rulesets/infinite-horror/statuses.js';
import { migrateTestStateToWorldV3 } from './helpers/world-v3.js';

const map = { id: 'targeted-map', version: '1', width: 1000, height: 1000, metersPerUnit: 1, features: [] };
const ruleset = { vision: { describe: () => ({ preciseRangeMeters: 120, vagueRangeMeters: 300, senses: {} }) } };
const worldOf = state => state.preferences.worldV2;
const sceneOf = state => worldOf(state).scenes[0];
const actorList = state => worldOf(state).actors;

function fixture() {
  const actor = (id, partyId) => ({ id, name: id, type: 'pc', partyId,
    system: { privateNotes: `secret-${id}` }, effects: [] });
  const token = (id, actorId, x, y, extra = {}) => ({ id, actorId, actorLink: true, actorDelta: null,
    placement: 'map', x, y, featureId: null, elevationMeters: 0, diameterMeters: 1, rotation: 0,
    hidden: false, locked: false, showName: true, effects: [], controllerUserIds: [],
    visibility: { mode: 'public', userIds: [] }, vision: { enabled: true }, ...extra });
  return migrateTestStateToWorldV3({ markers: [], attackAreas: [], preferences: { worldV2: {
    schemaVersion: 2, id: 'targeted-world', name: 'Targeted', ruleset: { id: 'infinite-horror', version: '1.1.0' },
    activeSceneId: 'scene', actors: [actor('scout-a', 'party-a'), actor('scout-b', 'party-b'), actor('hostile', 'party-hostile'),
      ...['c', 'd', 'e', 'f'].map(id => actor(`scout-${id}`, `party-${id}`))],
    statusDefinitions: structuredClone(INFINITE_HORROR_STATUS_DEFINITIONS), scenes: [{ id: 'scene',
      mapPackage: { id: map.id, version: map.version }, markers: [], attackAreas: [], sceneEvents: [], featureStates: {},
      settings: { lighting: 'normal', gridVisible: true },
      occlusionShapes: [{ id: 'wall', kind: 'wall', points: [[100, 0], [110, 0], [110, 300], [100, 300]] }],
      tokens: [token('source-a', 'scout-a', 50, 50), token('source-b', 'scout-b', 45, 55),
        token('near', 'hostile', 80, 50), token('vague', 'hostile', 80, 200), token('far', 'hostile', 700, 700),
        token('blocked', 'hostile', 180, 50), token('policy-hidden', 'hostile', 80, 45, { visibility: { mode: 'gm', userIds: [] } }),
        token('lamp', 'scout-a', 80, 20, { light: { enabled: true, rangeMeters: 300, intensity: 1, color: '#fff3c4', elevationOffsetMeters: 0, occlusion: 'scene' } }),
        ...['c', 'd', 'e', 'f'].map(id => token(`source-${id}`, `scout-${id}`, 45, 55))],
      fog: { schemaVersion: 1, cellSizeMeters: 5, exploredByParty: {
        'party-a': { rows: { 1: [[0, 10]] } }, 'party-b': { rows: { 2: [[20, 30]] } }, 'party-c': { rows: { 9: [[99, 99]] } },
      } } }],
  } } });
}

function viewer(validate, userId = 'a', extra = {}) {
  const ids = new Map();
  const ownership = { [`scout-${userId}`]: 'owner' };
  const context = { role: 'player', userId, user: { ownership, placementGrants: {} },
    visionSourceTokenId: `source-${userId}`, ruleset, mapPackage: map, mapMetrics: { metersPerUnit: 1 },
    trustedProjection: true, isCanonicalData: validate.isImmutableData,
    opaqueIdFor: (kind, id) => { const key = `${kind}:${id}`; const value = `opaque-${userId}-${key}`; ids.set(key, value); return value; },
    lookupOpaqueId: (kind, id) => ids.get(`${kind}:${id}`), ...extra };
  return { context, ids };
}

function setup(extra = {}) {
  const validate = createCanonicalWorldValidator(), before = fixture();
  validate(before);
  const { context, ids } = viewer(validate, 'a', extra);
  const projected = projectStateForAudience(before, context);
  assert.deepEqual(projected, previousProjection(before, context));
  return { validate, before, projected, context, ids };
}

function move(before, ids, offset = 3) {
  return applyWorldOperations(before, ids.map(id => {
    const token = sceneOf(before).tokens.find(item => item.id === id);
    return { type: 'token.move', payload: { sceneId: 'scene', tokenId: id, x: token.x + offset, y: token.y + 1 } };
  }), { source: { role: 'gm' }, now: '2026-10-04T00:00:00.000Z' }).state;
}

function patched(before, { tokenId, tokenPatch, scenePatch, worldPatch, preferencesPatch, rootPatch } = {}) {
  const world = worldOf(before), scene = sceneOf(before);
  return { ...before, ...rootPatch, preferences: { ...before.preferences, ...preferencesPatch, worldV2: { ...world, ...worldPatch,
    scenes: [{ ...scene, ...scenePatch,
      tokens: tokenId ? scene.tokens.map(token => token.id === tokenId ? { ...token, ...tokenPatch } : token) : scene.tokens },
      ...world.scenes.slice(1)] } } };
}

function checkedProjection({ validate, before, projected, context }, after, ids, expectHit = true, viewerContext = context) {
  validate(after);
  const previousJson = JSON.stringify(projected), rawJson = JSON.stringify(after);
  const declaredIds = new Set(ids);
  const result = projectStateForAudience(after, { ...viewerContext,
    movementCache: { beforeState: before, previousProjection: projected, tokenIds: declaredIds } });
  const oracle = previousProjection(after, viewerContext);
  assert.deepEqual(result, oracle);
  assert.deepEqual(createDocumentChanges(projected, result), createDocumentChangesFull(projected, oracle));
  assert.equal(JSON.stringify(projected), previousJson);
  assert.equal(JSON.stringify(after), rawJson);
  assert.deepEqual([...declaredIds], ids);
  assert.equal(actorList(result) === actorList(projected), expectHit, 'Actor collection reuse proves actual targeted hit');
  return result;
}

test('precise, vague, spatial-hidden and policy-hidden targets hit and preserve complete old output', () => {
  for (const id of ['near', 'vague', 'far', 'blocked', 'policy-hidden', 'source-b']) {
    const state = setup(), after = move(state.before, [id]);
    const result = checkedProjection(state, after, [id]);
    assert.equal(result.preferences.worldV2.journals, state.projected.preferences.worldV2.journals);
    assert.equal(result.preferences.audienceVision === state.projected.preferences.audienceVision, false);
    assert.equal(JSON.stringify(result).includes('secret-hostile'), false);
    assert.deepEqual(Object.keys(sceneOf(result).fog.exploredByParty), ['party-a']);
  }
});

test('multi-target, repeated submissions and consecutive targeted/full projections keep metadata current', () => {
  let state = setup();
  for (const ids of [['near', 'vague', 'far'], ['near'], ['vague'], ['blocked'], ['policy-hidden']]) {
    const after = move(state.before, ids);
    const result = checkedProjection(state, after, ids);
    const repeated = checkedProjection(state, after, ids);
    assert.deepEqual(repeated, result);
    state = { ...state, before: after, projected: result };
  }
  const sourceMove = move(state.before, ['source-a']);
  const full = checkedProjection(state, sourceMove, ['source-a'], false);
  state = { ...state, before: sourceMove, projected: full };
  checkedProjection(state, move(sourceMove, ['near']), ['near']);
});

test('early target projection still invokes a dynamic Ruleset vision hook and observes its changed output', () => {
  let calls = 0, range = 120;
  const state = setup({ describeVision: () => {
    calls += 1;
    return { preciseRangeMeters: range, vagueRangeMeters: 300, senses: {} };
  } });
  let after = move(state.before, ['near']);
  state.validate(after);
  const priorCalls = calls;
  const result = projectStateForAudience(after, { ...state.context,
    movementCache: { beforeState: state.before, previousProjection: state.projected, tokenIds: new Set(['near']) } });
  assert.equal(calls, priorCalls + 1);
  assert.equal(actorList(result), actorList(state.projected));
  assert.deepEqual(result, previousProjection(after, state.context));
  const next = { ...state, before: after, projected: result };
  range = 60;
  after = move(after, ['near']);
  checkedProjection(next, after, ['near'], false);
});

test('category transitions use the complete original projection and never retain stale masks', () => {
  for (const [id, patch] of [['near', { x: 700, y: 700 }], ['far', { x: 80, y: 50 }],
    ['vague', { x: 75, y: 55 }], ['near', { x: 80, y: 200 }]]) {
    const state = setup();
    checkedProjection(state, patched(state.before, { tokenId: id, tokenPatch: patch }), [id], false);
  }
});

test('unknown changes, Fog, definitions, Actor, Scene geometry and token policy force complete fallback', () => {
  for (const change of [
    { rootPatch: { unknown: 1 } }, { preferencesPatch: { unknown: 1 } },
    { worldPatch: { name: 'Changed World' } }, { scenePatch: { unknown: 1 } },
    { scenePatch: { featureStates: { wall: { vision: { occluder: false } } } } },
    { scenePatch: { settings: { lighting: 'dark', gridVisible: true } } },
    { scenePatch: { sceneEvents: [] } }, { scenePatch: { occlusionShapes: [] } },
    { scenePatch: { fog: { schemaVersion: 1, cellSizeMeters: 5, exploredByParty: {} } } },
    { tokenId: 'near', tokenPatch: { visibility: { mode: 'gm', userIds: [] } } },
    { tokenId: 'near', tokenPatch: { controllerUserIds: ['a'] } },
    { tokenId: 'near', tokenPatch: { actorId: 'scout-a' } },
    { tokenId: 'near', tokenPatch: { effects: [{ id: 'invisible', definitionId: 'status-invisible', stacks: 1, enabled: true }] } },
  ]) {
    const state = setup();
    const after = patched(move(state.before, ['near']), change);
    checkedProjection(state, after, ['near'], false);
  }
  for (const field of ['actors', 'statusDefinitions', 'journals']) {
    const state = setup(), moved = move(state.before, ['near']);
    const current = worldOf(moved)[field] || [];
    checkedProjection(state, patched(moved, { worldPatch: { [field]: [...current] } }), ['near'], false);
  }
  const state = setup(), withNegativeZero = patched(state.before, { scenePatch: { unknown: -0 } });
  state.validate(withNegativeZero);
  const projected = projectStateForAudience(withNegativeZero, state.context);
  checkedProjection({ ...state, before: withNegativeZero, projected },
    patched(move(withNegativeZero, ['near']), { scenePatch: { unknown: 0 } }), ['near'], false);
});

test('source, light, permission, map scale, opaque identity and missing metadata cannot take targeted path', () => {
  for (const id of ['source-a', 'lamp']) {
    const state = setup();
    checkedProjection(state, move(state.before, [id]), [id], false);
  }
  for (const contextPatch of [
    { userId: 'other' }, { visionSourceTokenId: 'source-b' },
    { user: { ownership: { 'scout-a': 'owner', hostile: 'owner' }, placementGrants: {} } },
    { mapMetrics: { metersPerUnit: 2 } }, { mapPackage: { ...map } },
    { ruleset: { vision: { describe: () => ({ preciseRangeMeters: 130, vagueRangeMeters: 310 }) } } },
    { trustedProjection: false }, { isCanonicalData: undefined }, { lookupOpaqueId: undefined },
    { visionSourceTokenId: null },
  ]) {
    const state = setup();
    checkedProjection(state, move(state.before, ['near']), ['near'], false, { ...state.context, ...contextPatch });
  }
  const state = setup();
  checkedProjection(state, move(state.before, ['vague']), ['vague'], false, { ...state.context,
    opaqueIdFor: (kind, id) => `changed-${kind}-${id}`, lookupOpaqueId: () => undefined });
  const prior = previousProjection(state.before, state.context);
  checkedProjection({ ...state, projected: prior }, move(state.before, ['near']), ['near'], false);
});

test('undeclared changes, reorder and unsafe canonical inputs use the old full fallback', () => {
  for (const declared of [[], ['near']]) {
    const state = setup();
    checkedProjection(state, move(state.before, ['near', 'far']), declared, false);
  }
  const state = setup(), moved = move(state.before, ['near']);
  const reordered = patched(moved);
  sceneOf(reordered).tokens = [...sceneOf(moved).tokens].reverse();
  checkedProjection(state, reordered, ['near'], false);
  for (const variant of ['mutable', 'shallow', 'getter', 'proxy']) {
    const current = setup(), after = move(current.before, ['near']);
    if (variant === 'shallow') Object.freeze(after);
    if (variant === 'getter') Object.defineProperty(sceneOf(after).tokens[2], 'rotation', { enumerable: true,
      configurable: true, get: () => 0 });
    if (variant === 'proxy') sceneOf(after).tokens[2] = new Proxy(sceneOf(after).tokens[2], {});
    if (variant === 'getter' || variant === 'proxy') current.validate(after);
    assert.equal(current.validate.isImmutableData(after), false, variant);
    const result = projectStateForAudience(after, { ...current.context, movementCache: {
      beforeState: current.before, previousProjection: current.projected, tokenIds: new Set(['near']) } });
    assert.deepEqual(result, previousProjection(after, current.context));
    assert.notEqual(actorList(result), actorList(current.projected));
  }
});

test('one canonical proof is shared by audiences while masks, parties and fresh opaque closures remain private', () => {
  const validate = createCanonicalWorldValidator(), before = fixture(); validate(before);
  const first = viewer(validate, 'a'), second = viewer(validate, 'b');
  const projectedA = projectStateForAudience(before, first.context), projectedB = projectStateForAudience(before, second.context);
  const others = ['c', 'd', 'e', 'f'].map(id => {
    const audience = viewer(validate, id);
    return { audience, prior: projectStateForAudience(before, audience.context) };
  });
  const after = move(before, ['near', 'vague']); validate(after);
  const originalKeys = Object.keys;
  let worldChecks = 0;
  const project = (viewer, projected) => projectStateForAudience(after, { ...viewer.context,
    opaqueIdFor: (kind, id) => viewer.context.opaqueIdFor(kind, id),
    lookupOpaqueId: (kind, id) => viewer.context.lookupOpaqueId(kind, id),
    movementCache: { beforeState: before, previousProjection: projected, tokenIds: new Set(['near', 'vague']) } });
  let resultA, resultB, otherResults;
  try {
    Object.keys = value => { if (value === worldOf(after)) worldChecks++; return originalKeys(value); };
    resultA = project(first, projectedA); resultB = project(second, projectedB);
    otherResults = others.map(({ audience, prior }) => project(audience, prior));
  } finally { Object.keys = originalKeys; }
  assert.equal(worldChecks, 1, 'six recipients share only one successful public relationship proof');
  assert.equal(actorList(resultA), actorList(projectedA)); assert.equal(actorList(resultB), actorList(projectedB));
  assert.notEqual(actorList(resultA), actorList(resultB));
  assert.deepEqual(resultA, previousProjection(after, first.context));
  assert.deepEqual(resultB, previousProjection(after, second.context));
  otherResults.forEach((result, index) => {
    assert.equal(actorList(result), actorList(others[index].prior));
    assert.deepEqual(result, previousProjection(after, others[index].audience.context));
  });
  const vagueA = sceneOf(resultA).tokens.find(token => token.audienceVisibility === 'vague');
  const vagueB = sceneOf(resultB).tokens.find(token => token.audienceVisibility === 'vague');
  assert.notEqual(vagueA.id, vagueB.id); assert.notEqual(vagueA.actorId, vagueB.actorId);
  assert.equal(JSON.stringify(resultA).includes('secret-scout-b'), false);
  assert.equal(JSON.stringify(resultB).includes('secret-scout-a'), false);
  assert.deepEqual(Object.keys(sceneOf(resultA).fog.exploredByParty), ['party-a']);
  assert.deepEqual(Object.keys(sceneOf(resultB).fog.exploredByParty), ['party-b']);
});

test('Actor party changes, Scene switching and actual anchor movement retain the full old behavior', () => {
  const state = setup(), moved = move(state.before, ['near']);
  const actorChanged = patched(moved, { worldPatch: { actors: actorList(moved).map(actor => actor.id === 'hostile'
    ? { ...actor, partyId: 'party-a', name: 'New Ally' } : actor) } });
  const allied = checkedProjection(state, actorChanged, ['near'], false);
  assert.equal(JSON.stringify(allied).includes('secret-hostile'), true);

  for (const variant of ['activate', 'scene-order', 'anchor']) {
    const validate = createCanonicalWorldValidator(), before = fixture();
    if (variant !== 'anchor') worldOf(before).scenes.push({ ...sceneOf(before), id: 'other', tokens: [] });
    else sceneOf(before).attackAreas = [{ id: 'area', anchor: { type: 'token', tokenId: 'source-b' }, origin: { x: 45, y: 55 } }];
    validate(before);
    const { context } = viewer(validate), projected = projectStateForAudience(before, context);
    const after = move(before, [variant === 'anchor' ? 'source-b' : 'near']);
    if (variant === 'activate') worldOf(after).activeSceneId = 'other';
    if (variant === 'scene-order') worldOf(after).scenes = [...worldOf(after).scenes].reverse();
    checkedProjection({ validate, before, projected, context }, after,
      [variant === 'anchor' ? 'source-b' : 'near'], false);
  }
});

test('no-source trusted audiences never allocate a targeted selection index or take the path', () => {
  const originalSet = WeakMap.prototype.set, metadata = [];
  let state;
  try {
    WeakMap.prototype.set = function (key, value) {
      if (Object.hasOwn(value || {}, 'targetedIndex')) metadata.push(value);
      return originalSet.call(this, key, value);
    };
    state = setup({ visionSourceTokenId: null });
    const after = move(state.before, ['near']);
    const projected = checkedProjection(state, after, ['near'], false);
    checkedProjection({ ...state, before: after, projected }, move(after, ['near']), ['near'], false);
  } finally { WeakMap.prototype.set = originalSet; }
  assert.equal(metadata.length, 3);
  assert.ok(metadata.every(entry => entry.targetedIndex === null && entry.targetedState === null));
});

test('a result keeps only one weakly keyed canonical predecessor proof', () => {
  const state = setup(), after = move(state.before, ['near']); state.validate(after);
  const alternate = move(state.before, ['near'], 1); state.validate(alternate);
  const alternateProjection = projectStateForAudience(alternate, state.context);
  const inspect = (before, projected) => {
    const originalKeys = Object.keys; let checks = 0, result;
    try {
      Object.keys = value => { if (value === worldOf(after)) checks++; return originalKeys(value); };
      result = projectStateForAudience(after, { ...state.context,
        movementCache: { beforeState: before, previousProjection: projected, tokenIds: new Set(['near']) } });
    } finally { Object.keys = originalKeys; }
    assert.equal(actorList(result), actorList(projected));
    assert.deepEqual(result, previousProjection(after, state.context));
    return checks;
  };
  assert.equal(inspect(state.before, state.projected), 1);
  assert.equal(inspect(state.before, state.projected), 0);
  assert.equal(inspect(alternate, alternateProjection), 1);
  assert.equal(inspect(state.before, state.projected), 1, 'the alternate predecessor replaced the original entry');
});
