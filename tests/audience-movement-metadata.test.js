import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as audience from '../src/vision/audience.js';
import { projectStateForAudience as fullProjection } from './fixtures/audience-before-targeted-movement.mjs';
import { hasCompletePreciseTokenProjection } from '../deployment/local-server/movement-projection.mjs';
import { createCanonicalWorldValidator } from '../deployment/local-server/world-schema.mjs';
import { applyWorldOperations } from '../src/world/operations.js';
import { createDocumentChanges, createDocumentChangesFull } from '../src/documents/changes.js';
import { INFINITE_HORROR_STATUS_DEFINITIONS } from '../src/rulesets/infinite-horror/statuses.js';
import { migrateTestStateToWorldV3 } from './helpers/world-v3.js';

const server = readFileSync(new URL('../deployment/local-server/server.mjs', import.meta.url), 'utf8');
const functions = server.slice(server.indexOf('function lightweightProjectionShell('), server.indexOf('function sendAudienceSnapshot('));
const factory = new Function('dependencies', `
  const { hasCanonicalPrivateMovementPredecessor, audienceStateFor, advanceFogProjectionMetadata, advancePublicChatProjectionMetadata,
    matchesSourceFreeProjectionScope, describeVisionForToken, describeServerVision, visionMapForScene,
    findUser, assertCanonicalWorldState, hasCompletePreciseTokenProjection } = dependencies;
  ${functions}
  return tryIncrementalAudienceProjection;
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

function candidate(state, applied, context = state.context) {
  const incremental = factory({ ...audience, hasCompletePreciseTokenProjection,
    describeServerVision: context.describeVision, visionMapForScene: () => context.mapPackage,
    findUser: () => context.user, assertCanonicalWorldState: state.validate,
    audienceStateFor: (_session, after, options) => audience.projectStateForAudience(after, { ...context, ...options }),
    describeVisionForToken() { throw new Error('A stationary source must not be resolved by the source-move branch'); } });
  return incremental(context, state.projected, applied.state, applied.operations, applied.results, state.before);
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

test('private movement eligibility rejects stale, forged, unaccepted and changed recipient scopes', () => {
  const state = setup(), applied = move(state);
  const qualifies = (projected = state.projected, before = state.before, after = applied.state, extra = {}) =>
    audience.hasCanonicalPrivateMovementPredecessor(projected, before, after, { ...state.context, ...extra });
  assert.equal(qualifies(), true);
  for (const extra of [
    { role: 'gm' }, { userId: 'different' }, { trustedProjection: false },
    { visionSourceTokenId: 'owned' }, { user: { ownership: {}, placementGrants: {} } },
    { user: { ...state.context.user, disabled: true } },
  ]) assert.equal(qualifies(state.projected, state.before, applied.state, extra), false);
  assert.equal(qualifies(structuredClone(state.projected)), false, 'a copied output has no registered predecessor');
  const importedBefore = structuredClone(state.before); state.validate(importedBefore);
  assert.equal(qualifies(state.projected, importedBefore), false, 'equal imported data is a different predecessor');
  assert.equal(qualifies(state.projected, state.before, structuredClone(applied.state)), false, 'an unvalidated after-state cannot supply a relation');
  const sourceMove = move(state, 'source');
  assert.equal(qualifies(state.projected, state.before, sourceMove.state), false, 'a moving source retains full detection');
  assert.equal(candidate(state, sourceMove), null, 'a source with restricted targets retains the existing server fallback');
  const foreignMove = move(state, 'foreign');
  assert.equal(qualifies(state.projected, state.before, foreignMove.state), false, 'restricted selections never become private targets');
});

test('canonical policy, light and geometry edits cannot qualify as a private coordinate-only predecessor', () => {
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
    assert.equal(audience.hasCanonicalPrivateMovementPredecessor(state.projected, state.before, after, state.context), false, edit);
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
