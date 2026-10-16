import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as audience from '../src/vision/audience.js';
import { projectStateForAudience as fullProjection } from './fixtures/audience-before-targeted-movement.mjs';
import { createCanonicalWorldValidator } from '../deployment/local-server/world-schema.mjs';
import { applyWorldOperations } from '../src/world/operations.js';
import { createDocumentChanges, createDocumentChangesFull, createFogDocumentChanges } from '../src/documents/changes.js';
import { INFINITE_HORROR_STATUS_DEFINITIONS } from '../src/rulesets/infinite-horror/statuses.js';
import { migrateTestStateToWorldV3 } from './helpers/world-v3.js';

const server = readFileSync(new URL('../deployment/local-server/server.mjs', import.meta.url), 'utf8');
const functions = server.slice(server.indexOf('function lightweightProjectionShell('), server.indexOf('function sendAudienceSnapshot('));
const factory = new Function('dependencies', `
  const { audienceStateFor, advanceFogProjectionMetadata, advancePublicChatProjectionMetadata,
    matchesSourceFreeProjectionScope, describeServerVision, visionMapForScene,
    findUser, assertCanonicalWorldState, sessions, createDocumentChanges, createFogDocumentChanges,
    projectMotionForSession, sendSocket, rememberResumeCommit, committedPatches,
    projectionCollectionChanges, canonicalMovementCollectionChanges } = dependencies;
  ${functions}
  return broadcastOperationCommit;
`);
const map = { id: 'movement-metadata-map', version: '1', width: 1000, height: 1000, metersPerUnit: 1, features: [] };
const describeVision = () => ({ preciseRangeMeters: 120, vagueRangeMeters: 300, senses: {} });
const worldOf = state => state.preferences.worldV2;
const sceneOf = state => worldOf(state).scenes[0];

function metadataDuring(callback) {
  const original = WeakMap.prototype.set, entries = [];
  let value;
  try {
    WeakMap.prototype.set = function (key, entry) {
      if (entry && Object.hasOwn(entry, 'canonicalState')) entries.push({ key, entry });
      return original.call(this, key, entry);
    };
    value = callback();
  } finally { WeakMap.prototype.set = original; }
  return { value, metadata: entries.find(entry => entry.key === value?.preferences?.audienceVision)?.entry };
}

function setup(extra = {}) {
  const token = (id, actorId, x) => ({ id, actorId, actorLink: true, actorDelta: null,
    placement: 'map', x, y: 50, featureId: null, elevationMeters: 0, diameterMeters: 1, rotation: 0,
    hidden: false, locked: false, showName: true, effects: [], controllerUserIds: [],
    visibility: { mode: 'public', userIds: [] }, vision: { enabled: true } });
  const before = migrateTestStateToWorldV3({ markers: [], attackAreas: [], preferences: { worldV2: {
    id: 'movement-metadata-world', schemaVersion: 2, ruleset: { id: 'infinite-horror', version: '1.1.0' }, activeSceneId: 'scene',
    actors: [{ id: 'scout', name: 'Scout', type: 'pc', partyId: 'party', effects: [], system: {} },
      { id: 'hostile', name: 'Hostile', type: 'pc', partyId: 'other', effects: [], system: { privateNotes: 'secret' } }],
    statusDefinitions: structuredClone(INFINITE_HORROR_STATUS_DEFINITIONS), scenes: [{ id: 'scene',
      mapPackage: { id: map.id, version: map.version }, markers: [], attackAreas: [], sceneEvents: [], featureStates: {},
      settings: { lighting: 'normal', gridVisible: true }, occlusionShapes: [],
      tokens: [token('source', 'scout', 50), token('owned', 'scout', 60), token('foreign', 'hostile', 80)],
      fog: { schemaVersion: 1, cellSizeMeters: 5, exploredByParty: {
        party: { rows: { 1: [[0, 10]] } }, other: { rows: { 9: [[99, 99]] } },
      } } }],
  }, chatSystem: { schemaVersion: 1, messages: [] } } });
  const validate = createCanonicalWorldValidator(); validate(before);
  const context = { role: 'player', userId: 'player', user: { ownership: { scout: 'owner' }, placementGrants: {} },
    visionSourceTokenId: 'source', describeVision, mapPackage: map, mapMetrics: { metersPerUnit: 1 },
    trustedProjection: true, isCanonicalData: validate.isImmutableData,
    opaqueIdFor: (kind, id) => `opaque-player-${kind}-${id}`, lookupOpaqueId: (kind, id) => `opaque-player-${kind}-${id}`, ...extra };
  const { value: projected, metadata } = metadataDuring(() => audience.projectStateForAudience(before, context));
  return { before, projected, metadata, context, validate };
}

function move(state, tokenId = 'owned', offset = 3) {
  const token = sceneOf(state.before).tokens.find(item => item.id === tokenId);
  const operations = [{ type: 'token.move', payload: { sceneId: 'scene', tokenId, x: token.x + offset, y: token.y } }];
  const applied = applyWorldOperations(state.before, operations, { source: { role: 'gm' }, now: '2026-10-05T00:00:00.000Z' });
  state.validate(applied.state);
  return { ...applied, operations };
}

function candidate(state, applied, context = state.context, onResponse = () => {}) {
  const viewer = { ...context, id: context.userId, identityStatus: 'active', audienceRevision: 1,
    audienceProjection: state.projected };
  const broadcast = factory({ ...audience, sessions: new Map([['player', viewer]]),
    describeServerVision: context.describeVision, visionMapForScene: () => context.mapPackage,
    findUser: () => context.user, assertCanonicalWorldState: state.validate,
    createDocumentChanges, createFogDocumentChanges,
    projectMotionForSession: () => [], sendSocket: (_socket, response) => onResponse(response),
    rememberResumeCommit() {}, committedPatches: new WeakMap(),
    audienceStateFor: (_session, after, options) => audience.projectStateForAudience(after, { ...context, ...options }) });
  broadcast({ beforeState: state.before, afterState: applied.state, operations: applied.operations,
    results: applied.results, operationId: 'move', baseRevision: 1, revision: 2,
    updatedAt: '2026-10-05T00:00:00.000Z', originSessionId: viewer.id });
  return viewer.audienceProjection;
}

test('an owned stationary-source move advances canonical metadata and preserves the following targeted projection', () => {
  const state = setup(), applied = move(state);
  const beforeJson = JSON.stringify(state.projected), priorMetadata = state.metadata;
  const { value: result, metadata } = metadataDuring(() => candidate(state, applied));
  assert.ok(result);
  assert.deepEqual(result, fullProjection(applied.state, state.context));
  assert.equal(metadata?.canonicalState, applied.state, 'the fast move must advance its exact canonical predecessor');
  assert.equal(metadata.targetedState, applied.state);
  assert.equal(metadata.targetedIndex, priorMetadata.targetedIndex);
  assert.equal(priorMetadata.canonicalState, state.before);
  assert.equal(JSON.stringify(state.projected), beforeJson);
  assert.notEqual(result.preferences.audienceVision, state.projected.preferences.audienceVision);
  const proof = audience.projectionCollectionChanges(state.projected, result);
  assert.ok(proof, 'the same verified pair must provide addressed collection changes');
  assert.deepEqual(createDocumentChanges(state.projected, result, null, { collectionChanges: proof }),
    createDocumentChangesFull(state.projected, fullProjection(applied.state, state.context)));
  const next = move({ ...state, before: applied.state }, 'foreign');
  const following = audience.projectStateForAudience(next.state, { ...state.context,
    movementCache: { beforeState: applied.state, previousProjection: result, tokenIds: new Set(['foreign']) } });
  assert.deepEqual(following, fullProjection(next.state, state.context));
  assert.ok(audience.targetedProjectionCollectionChanges(result, following), 'a fast move must not break the next complete target proof');
});

test('source and hostile movement broadcast fresh detection and exact Document changes across visibility categories', () => {
  for (const moved of ['source', 'foreign']) {
    let state = setup();
    const positions = moved === 'source' ? [350, 450, 100] : [250, 450, 90];
    for (const [index, position] of positions.entries()) {
      const oldToken = sceneOf(state.before).tokens.find(token => token.id === moved);
      const applied = move(state, moved, position - oldToken.x);
      const previousBytes = JSON.stringify(state.projected), canonicalBytes = JSON.stringify(state.before);
      const expected = fullProjection(applied.state, state.context);
      let response;
      const { value: actual, metadata } = metadataDuring(() => candidate(state, applied, state.context,
        value => { response = value; }));
      assert.deepEqual(actual, expected, `${moved}/${position}`);
      assert.deepEqual(response.changes, createDocumentChangesFull(state.projected, expected), `${moved}/${position}`);
      assert.equal(JSON.stringify(state.projected), previousBytes);
      assert.equal(JSON.stringify(state.before), canonicalBytes);
      assert.strictEqual(metadata.canonicalState, applied.state);
      assert.strictEqual(metadata.targetedState, applied.state);
      const selected = sceneOf(actual).tokens.find(token => token.actorId === 'hostile'
        || token.audienceVisibility === 'vague');
      if (index === 0) assert.equal(selected?.audienceVisibility, 'vague');
      if (index === 1) assert.equal(selected, undefined);
      if (index === 2) assert.equal(selected?.audienceVisibility, 'precise');
      assert.equal(JSON.stringify(actual).includes('secret'), false);
      state = { ...state, before: applied.state, projected: actual, metadata };
    }
  }
});

test('mixed movement and Fog uses a complete fresh projection and retains private party filtering', () => {
  const state = setup(), moved = move(state, 'foreign');
  const operations = [...moved.operations, { type: 'scene.fog.reset', payload: { sceneId: 'scene', partyId: 'party' } }];
  const applied = applyWorldOperations(state.before, operations, {
    source: { role: 'gm' }, now: '2026-10-05T00:00:00.000Z', mapPackage: map,
  });
  state.validate(applied.state);
  const expected = fullProjection(applied.state, state.context);
  let response;
  const actual = candidate(state, { ...applied, operations }, state.context, value => { response = value; });
  assert.deepEqual(actual, expected);
  const fog = applied.results.filter(result => Object.hasOwn(result, 'dirtyBounds'));
  assert.deepEqual(response.changes, createDocumentChangesFull(state.projected, expected, null, { fog }));
  assert.deepEqual(Object.keys(sceneOf(actual).fog.exploredByParty), []);
  assert.equal(JSON.stringify(actual).includes('secret'), false);
});

test('canonical movement collection changes address only proved Token indices with the full Document oracle', () => {
  const state = setup(), applied = move(state, 'source');
  const beforeScene = sceneOf(state.before), afterScene = sceneOf(applied.state);
  const proof = audience.canonicalMovementCollectionChanges(state.before, applied.state, state.validate.isImmutableData);
  assert.ok(proof instanceof Map);
  const collection = proof.get(afterScene.tokens);
  assert.strictEqual(collection.before, beforeScene.tokens);
  assert.deepEqual(collection.indices, [0]);
  assert.ok(Object.isFrozen(collection) && Object.isFrozen(collection.indices));
  const motion = [{ sceneId: 'scene', tokenId: 'source' }];
  assert.deepEqual(createDocumentChanges(state.before, applied.state, null, { motion, collectionChanges: proof }),
    createDocumentChangesFull(state.before, applied.state, null, { motion }));
  assert.equal(audience.canonicalMovementCollectionChanges(state.before, applied.state, () => false), null,
    'a cached relation never bypasses the current canonical proof');
  assert.equal(audience.canonicalMovementCollectionChanges(state.before, structuredClone(applied.state), state.validate.isImmutableData), null);
  assert.equal(audience.canonicalMovementCollectionChanges(state.projected, applied.state, state.validate.isImmutableData), null,
    'a recipient projection is not an accepted canonical predecessor');
});

test('canonical collection indices remain Scene-scoped when Scenes reuse Token identifiers', () => {
  const state = setup(), world = worldOf(state.before), scene = sceneOf(state.before);
  const before = { ...state.before, preferences: { ...state.before.preferences,
    worldV2: { ...world, scenes: [scene, { ...scene, id: 'second-scene', tokens: [...scene.tokens] }] } } };
  state.validate(before);
  const applied = applyWorldOperations(before, [{ type: 'token.move',
    payload: { sceneId: 'second-scene', tokenId: 'owned', x: 65, y: 50 } }],
  { source: { role: 'gm' }, now: '2026-10-05T00:00:00.000Z' });
  state.validate(applied.state);
  const proof = audience.canonicalMovementCollectionChanges(before, applied.state, state.validate.isImmutableData);
  assert.ok(proof);
  const scenes = worldOf(applied.state).scenes;
  assert.deepEqual(proof.get(scenes[0].tokens).indices, []);
  assert.deepEqual(proof.get(scenes[1].tokens).indices, [1]);
  const motion = [{ sceneId: 'second-scene', tokenId: 'owned' }];
  const changes = createDocumentChanges(before, applied.state, null, { motion, collectionChanges: proof });
  assert.deepEqual(changes, createDocumentChangesFull(before, applied.state, null, { motion }));
  assert.deepEqual(changes.filter(change => change.document.type === 'Token').map(change => change.document.parent.id), ['second-scene']);
});

test('canonical movement collection proof requires an explicit boolean acceptance for both states', () => {
  const state = setup(), applied = move(state);
  const before = structuredClone(state.before), after = structuredClone(applied.state);
  for (const truthy of ['true', 1, {}, []]) {
    assert.equal(audience.canonicalMovementCollectionChanges(before, after, () => truthy), null);
    assert.equal(audience.canonicalMovementCollectionChanges(before, after,
      value => value === before ? true : truthy), null);
  }
  assert.ok(audience.canonicalMovementCollectionChanges(state.before, applied.state, state.validate.isImmutableData));
  assert.equal(audience.canonicalMovementCollectionChanges(state.before, applied.state, () => 'true'), null,
    'a cached relation also requires explicit boolean acceptance');
});

test('canonical movement collection proof rejects membership, order and non-coordinate changes', () => {
  for (const edit of ['reorder', 'append', 'delete', 'actor', 'fog', 'light']) {
    const state = setup(), applied = move(state), world = worldOf(applied.state), scene = sceneOf(applied.state);
    let tokens = scene.tokens, nextScene = scene, actors = world.actors;
    if (edit === 'reorder') tokens = [...tokens].reverse();
    if (edit === 'append') tokens = [...tokens, { ...tokens[0], id: 'added-token' }];
    if (edit === 'delete') tokens = tokens.slice(1);
    if (edit === 'light') tokens = tokens.map(token => token.id !== 'owned' ? token : { ...token,
      light: { enabled: true, rangeMeters: 100, intensity: 1, color: '#fff3c4', elevationOffsetMeters: 0, occlusion: 'scene' } });
    if (edit === 'actor') actors = actors.map(actor => actor.id === 'scout' ? { ...actor, name: 'Changed' } : actor);
    if (edit === 'fog') nextScene = { ...scene, fog: { ...scene.fog, exploredByParty: {} } };
    const after = { ...applied.state, preferences: { ...applied.state.preferences,
      entitySystem: { ...applied.state.preferences.entitySystem, tokens, actors },
      worldV2: { ...world, actors, scenes: [{ ...nextScene, tokens }] } } };
    state.validate(after);
    assert.equal(audience.canonicalMovementCollectionChanges(state.before, after, state.validate.isImmutableData), null, edit);
  }
});

test('accepted canonical projection reuses its whole-graph policy proof while source movement still refreshes detection', () => {
  const state = setup(), applied = move(state, 'source');
  const options = { ...state.context, movementCache: { beforeState: state.before,
    previousProjection: state.projected, tokenIds: new Set(['source']) } };
  const warmed = audience.projectStateForAudience(applied.state, options);
  const documents = new Set([...worldOf(state.before).actors, ...sceneOf(state.before).tokens]);
  const weakHas = WeakSet.prototype.has;
  let checks = 0;
  WeakSet.prototype.has = function (value) {
    if (documents.has(value)) checks++;
    return weakHas.call(this, value);
  };
  try {
    assert.deepEqual(audience.projectStateForAudience(applied.state, options), warmed);
    assert.equal(checks, 0, 'the server-accepted graph replaces repeated per-Token/Actor immutable qualification');
  } finally { WeakSet.prototype.has = weakHas; }
  assert.deepEqual(warmed, fullProjection(applied.state, state.context));
  let hookCalls = 0;
  const changed = audience.projectStateForAudience(applied.state, { ...options,
    describeVision() { hookCalls++; return { preciseRangeMeters: 1, vagueRangeMeters: 1, senses: {} }; } });
  assert.ok(hookCalls > 0);
  assert.equal(sceneOf(changed).tokens.some(token => token.id === 'foreign'), false,
    'canonical immutability never suppresses fresh source range and target detection');
});

test('server-accepted previous Token arrays share the existing canonical index while recipient indexes stay private', () => {
  const state = setup(), applied = move(state, 'source');
  const canonicalToken = sceneOf(state.before).tokens.find(token => token.id === 'foreign');
  const projectedToken = sceneOf(state.projected).tokens.find(token => token.id === 'foreign');
  assert.notStrictEqual(canonicalToken, projectedToken);
  const options = { ...state.context, movementCache: { beforeState: state.before,
    previousProjection: state.projected, tokenIds: new Set(['source']) } };
  const mapSet = Map.prototype.set;
  let canonicalInsertions = 0, projectedInsertions = 0;
  Map.prototype.set = function (key, value) {
    if (value === canonicalToken) canonicalInsertions++;
    if (value === projectedToken) projectedInsertions++;
    return mapSet.call(this, key, value);
  };
  try {
    const first = audience.projectStateForAudience(applied.state, options);
    assert.equal(canonicalInsertions, 1);
    assert.equal(projectedInsertions, 1);
    assert.deepEqual(audience.projectStateForAudience(applied.state, options), first);
    assert.equal(canonicalInsertions, 1, 'the accepted graph need not be separately registered in the vision WeakSet');
    assert.equal(projectedInsertions, 2, 'each recipient still builds its own selected Token index');
    assert.deepEqual(first, fullProjection(applied.state, state.context));
  } finally { Map.prototype.set = mapSet; }
});

test('the common movement projector refreshes stale, copied, unaccepted and changed recipient scopes', () => {
  const state = setup(), applied = move(state);
  const fresh = (after, projected = state.projected, before = state.before, extra = {}) => {
    const context = { ...state.context, ...extra };
    const actual = audience.projectStateForAudience(after, { ...context, movementCache: {
      beforeState: before, previousProjection: projected, tokenIds: new Set(['owned', 'source', 'foreign']),
    } });
    assert.deepEqual(actual, fullProjection(after, context));
    return actual;
  };
  fresh(applied.state);
  for (const extra of [
    { role: 'gm' }, { userId: 'different' }, { trustedProjection: false },
    { visionSourceTokenId: 'owned' }, { user: { ownership: {}, placementGrants: {} } },
    { user: { ...state.context.user, disabled: true } },
  ]) fresh(applied.state, state.projected, state.before, extra);
  const copied = structuredClone(state.projected);
  fresh(applied.state, copied);
  const importedBefore = structuredClone(state.before); state.validate(importedBefore);
  fresh(applied.state, state.projected, importedBefore);
  const unaccepted = structuredClone(applied.state);
  fresh(unaccepted);
  const following = move({ ...state, before: applied.state }, 'foreign');
  fresh(following.state, state.projected, applied.state);
  for (const tokenId of ['source', 'foreign']) fresh(move(state, tokenId).state);
});

test('the common projector refreshes policy, light, Actor, Fog and geometry edits against the full oracle', () => {
  for (const edit of ['light', 'visibility', 'actor', 'fog', 'geometry']) {
    const state = setup(), moved = move(state), world = worldOf(moved.state), scene = sceneOf(moved.state);
    let nextWorld = world, nextScene = scene;
    if (edit === 'light' || edit === 'visibility') nextScene = { ...scene, tokens: scene.tokens.map(token => token.id !== 'owned' ? token : {
      ...token, ...(edit === 'light' ? { light: { enabled: true, rangeMeters: 100, intensity: 1, color: '#fff3c4',
        elevationOffsetMeters: 0, occlusion: 'scene' } } : { visibility: { mode: 'gm', userIds: [] } }),
    }) };
    if (edit === 'actor') nextWorld = { ...world, actors: world.actors.map(actor => actor.id === 'scout' ? { ...actor, partyId: 'other' } : actor) };
    if (edit === 'fog') nextScene = { ...scene, fog: { ...scene.fog, exploredByParty: {} } };
    if (edit === 'geometry') nextScene = { ...scene, featureStates: { wall: { open: true } } };
    const after = { ...moved.state, preferences: { ...moved.state.preferences,
      worldV2: { ...nextWorld, scenes: [nextScene] } } };
    state.validate(after);
    const context = { ...state.context, movementCache: { beforeState: state.before,
      previousProjection: state.projected, tokenIds: new Set(['owned']) } };
    const actual = audience.projectStateForAudience(after, context);
    assert.deepEqual(actual, fullProjection(after, state.context), edit);
    assert.equal(audience.targetedProjectionCollectionChanges(state.projected, actual), null,
      `${edit} cannot be mistaken for a coordinate-only change`);
  }
});

test('the reused targeted projector still runs a changed vision hook and preserves fresh masks', () => {
  const state = setup(), applied = move(state);
  const context = { ...state.context, describeVision: () => ({ preciseRangeMeters: 1, vagueRangeMeters: 1, senses: {} }) };
  const result = candidate(state, applied, context);
  assert.deepEqual(result, fullProjection(applied.state, context));
  assert.equal(sceneOf(result).tokens.some(token => token.id === 'foreign'), false);
  assert.equal(JSON.stringify(result).includes('secret'), false);
  assert.deepEqual(Object.keys(sceneOf(result).fog.exploredByParty), ['party']);
  assert.equal(audience.targetedProjectionCollectionChanges(state.projected, result), null,
    'changed perception uses the complete existing projector rather than certifying the old private shell');
});
