import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { projectStateForAudience, advancePublicChatProjectionMetadata, matchesSourceFreeProjectionScope, advanceFogProjectionMetadata,
  projectionCollectionChanges } from '../src/vision/audience.js';
import { projectStateForAudience as oldFullProjection } from './fixtures/audience-before-targeted-movement.mjs';
import { createCanonicalWorldValidator } from '../deployment/local-server/world-schema.mjs';
import { applyStatusMessage } from '../deployment/local-server/status-operations.mjs';
import { createDocumentChanges, createDocumentChangesFull } from '../src/documents/changes.js';
import { applyWorldOperations } from '../src/world/operations.js';
import { INFINITE_HORROR_STATUS_DEFINITIONS } from '../src/rulesets/infinite-horror/statuses.js';
import { migrateTestStateToWorldV3 } from './helpers/world-v3.js';

const map = { id: 'chat-map', version: '1', width: 1000, height: 1000, metersPerUnit: 1, features: [] };
const describeVision = () => ({ preciseRangeMeters: 120, vagueRangeMeters: 300, senses: {} });
const worldOf = state => state.preferences.worldV2;
const sceneOf = state => worldOf(state).scenes[0];
const server = readFileSync(new URL('../deployment/local-server/server.mjs', import.meta.url), 'utf8');
const serverFunctions = server.slice(server.indexOf('function lightweightProjectionShell('), server.indexOf('function sendAudienceSnapshot('));
const factory = new Function('dependencies', `
  const { advancePublicChatProjectionMetadata, matchesSourceFreeProjectionScope, advanceFogProjectionMetadata, describeServerVision,
    visionMapForScene, findUser, assertCanonicalWorldState } = dependencies;
  ${serverFunctions}
  return tryIncrementalAudienceProjection;
`);

function setup(extra = {}, messages = []) {
  const actors = [{ id: 'scout', name: 'Scout', type: 'pc', partyId: 'party', effects: [], system: {} },
    { id: 'hostile', name: 'Hostile', type: 'pc', partyId: 'other', effects: [], system: { privateNotes: 'secret' } }];
  const token = (id, actorId, x, y) => ({ id, actorId, actorLink: true, actorDelta: null,
    placement: 'map', x, y, featureId: null, elevationMeters: 0, diameterMeters: 1, rotation: 0,
    hidden: false, locked: false, showName: true, effects: [], controllerUserIds: [],
    visibility: { mode: 'public', userIds: [] }, vision: { enabled: true } });
  const before = migrateTestStateToWorldV3({ markers: [], attackAreas: [], preferences: { worldV2: {
    id: 'chat-world', schemaVersion: 2, ruleset: { id: 'infinite-horror', version: '1.1.0' }, activeSceneId: 'scene',
    actors, statusDefinitions: structuredClone(INFINITE_HORROR_STATUS_DEFINITIONS), scenes: [{ id: 'scene',
      mapPackage: { id: map.id, version: map.version }, markers: [], attackAreas: [], sceneEvents: [], featureStates: {},
      settings: { lighting: 'normal', gridVisible: true }, occlusionShapes: [{ id: 'wall', kind: 'wall',
        points: [[100, 0], [110, 0], [110, 300], [100, 300]] }],
      tokens: [token('source', 'scout', 50, 50), token('near', 'hostile', 80, 50), token('vague', 'hostile', 80, 200)],
      fog: { schemaVersion: 1, cellSizeMeters: 5, exploredByParty: {
        party: { rows: { 1: [[0, 10]] } }, other: { rows: { 9: [[99, 99]] } },
      } } }],
  }, chatSystem: { schemaVersion: 1, messages } } });
  const validate = createCanonicalWorldValidator(); validate(before);
  const context = { role: 'player', userId: 'player', user: { ownership: { scout: 'owner' }, placementGrants: {} },
    visionSourceTokenId: 'source', describeVision, mapPackage: map, mapMetrics: { metersPerUnit: 1 },
    trustedProjection: true, isCanonicalData: validate.isImmutableData,
    opaqueIdFor: (kind, id) => `opaque-player-${kind}-${id}`, lookupOpaqueId: (kind, id) => `opaque-player-${kind}-${id}`, ...extra };
  const projected = projectStateForAudience(before, context);
  return { before, projected, context, validate };
}

function append(state, text = 'Public chat') {
  const applied = applyWorldOperations(state.before, [{ type: 'chat.append', payload: { text } }], {
    now: '2026-10-05T00:00:00.000Z', randomId: () => 'public-chat',
    isCanonicalData: state.validate.isImmutableData, trustedOperationHooks: true,
  });
  state.validate(applied.state);
  return applied;
}

function candidate(state, after, context = state.context, results = [{ chatId: 'public-chat' }]) {
  return factory({ advancePublicChatProjectionMetadata, matchesSourceFreeProjectionScope, advanceFogProjectionMetadata,
    describeServerVision: context.describeVision, visionMapForScene: () => context.mapPackage,
    findUser: () => context.user, assertCanonicalWorldState: state.validate })(context, state.projected, after,
    [{ type: 'chat.append', payload: {} }], results, state.before);
}

function metadataDuring(callback) {
  const originalSet = WeakMap.prototype.set, entries = [];
  let value;
  try {
    WeakMap.prototype.set = function (key, entry) {
      if (entry && Object.hasOwn(entry, 'canonicalState')) entries.push({ key, entry });
      return originalSet.call(this, key, entry);
    };
    value = callback();
  } finally { WeakMap.prototype.set = originalSet; }
  return { value, metadata: entries.find(entry => entry.key === value?.preferences?.audienceVision)?.entry };
}

function sourceFreeStatusPredecessor(messages = []) {
  const state = setup({ visionSourceTokenId: null }, messages);
  const operations = [{ type: 'status.apply', payload: {
    scope: 'actor', targetId: 'scout', definitionId: 'status-strengthened',
  } }];
  const applied = applyWorldOperations(state.before, operations, {
    now: '2026-10-08T00:00:00.000Z',
    applyStatus: (value, message) => applyStatusMessage(value, message, { mutate: true, assumeNormalized: true }),
  });
  state.validate(applied.state);
  const projected = factory({ advancePublicChatProjectionMetadata, matchesSourceFreeProjectionScope, advanceFogProjectionMetadata,
    describeServerVision: state.context.describeVision, visionMapForScene: () => map,
    findUser: () => state.context.user, assertCanonicalWorldState: state.validate })(
    state.context, state.projected, applied.state, operations, applied.results, state.before);
  assert.ok(projected);
  assert.deepEqual(projected, oldFullProjection(applied.state, state.context));
  assert.equal(projected.preferences.audienceVision, state.projected.preferences.audienceVision);
  return { ...state, before: applied.state, projected };
}

test('public chat after a real source-free status keeps the owned increment without advancing stale metadata', () => {
  const state = sourceFreeStatusPredecessor(), applied = append(state);
  const { value: result, metadata } = metadataDuring(() => candidate(state, applied.state, state.context, applied.results));
  assert.ok(result); assert.equal(metadata, undefined);
  assert.equal(result.preferences.audienceVision, state.projected.preferences.audienceVision);
  const oracle = oldFullProjection(applied.state, state.context);
  assert.deepEqual(result, oracle);
  assert.deepEqual(createDocumentChanges(state.projected, result), createDocumentChangesFull(state.projected, oracle));
  assert.notEqual(worldOf(result).actors[0], worldOf(applied.state).actors[0]);
  assert.equal(JSON.stringify(result).includes('secret'), false);
  assert.deepEqual(Object.keys(sceneOf(result).fog.exploredByParty), ['party']);

  const moved = applyWorldOperations(applied.state, [{ type: 'token.move', payload: {
    sceneId: 'scene', tokenId: 'source', x: 51, y: 50,
  } }], { now: '2026-10-08T00:00:02.000Z' }).state;
  state.validate(moved);
  const { value: fresh, metadata: freshMetadata } = metadataDuring(() => projectStateForAudience(moved, {
    ...state.context, movementCache: { beforeState: applied.state, previousProjection: result, tokenIds: new Set(['source']) },
  }));
  assert.deepEqual(fresh, oldFullProjection(moved, state.context));
  assert.equal(freshMetadata.canonicalState, moved);
  assert.notEqual(worldOf(fresh).actors, worldOf(result).actors, 'stale metadata cannot qualify a later movement');
});

test('source-free stale metadata retains audience, map and ownership guards', () => {
  const state = sourceFreeStatusPredecessor(), applied = append(state);
  assert.equal(matchesSourceFreeProjectionScope(state.projected, state.context), true);
  for (const patch of [
    { role: 'gm' }, { userId: 'other' }, { user: { ownership: {}, placementGrants: {} } },
    { user: { ownership: { scout: 'owner' }, disabled: true } }, { visionSourceTokenId: 'source' },
    { mapPackage: { ...map } }, { mapMetrics: { metersPerUnit: 2 } }, { trustedProjection: false },
  ]) {
    const context = { ...state.context, ...patch };
    assert.equal(matchesSourceFreeProjectionScope(state.projected, context), false);
    if (!Object.hasOwn(patch, 'mapMetrics') && !Object.hasOwn(patch, 'trustedProjection')) {
      assert.equal(candidate(state, applied.state, context, applied.results) === null, true, JSON.stringify(patch));
    }
  }
  assert.equal(matchesSourceFreeProjectionScope(structuredClone(state.projected), state.context), false);
  assert.equal(candidate({ ...state, before: structuredClone(state.before) }, applied.state), null);
  const changed = { ...applied.state, preferences: { ...applied.state.preferences, worldV2: {
    ...worldOf(applied.state), scenes: [{ ...sceneOf(applied.state), featureStates: { wall: { vision: { occluder: false } } } }],
  } } }; state.validate(changed);
  assert.equal(candidate(state, changed), null);
});

test('source-free stale metadata cannot bypass trimming or protected chat', () => {
  const trimmed = sourceFreeStatusPredecessor(Array.from({ length: 500 }, (_, index) => ({
    id: `old-${index}`, type: 'chat', createdAt: '2026-10-08T00:00:00.000Z', text: 'old', data: null,
  })));
  assert.equal(candidate(trimmed, append(trimmed).state), null);
  const state = sourceFreeStatusPredecessor(), after = append(state).state;
  const protectedAfter = { ...after, preferences: { ...after.preferences, chatSystem: {
    ...after.preferences.chatSystem, messages: after.preferences.chatSystem.messages.map(message => ({
      ...message, data: { actorId: 'hostile' },
    })),
  } } }; state.validate(protectedAfter);
  assert.equal(candidate(state, protectedAfter), null);
});

for (const source of ['source', null]) test(`real canonical public chat advances private metadata and Doc proofs (${source || 'no source'})`, () => {
  const state = setup({ visionSourceTokenId: source }), applied = append(state), after = applied.state;
  assert.equal(worldOf(after).actors, worldOf(state.before).actors);
  assert.equal(worldOf(after).scenes, worldOf(state.before).scenes);
  assert.notEqual(after.preferences.entitySystem, state.before.preferences.entitySystem);
  const priorJson = JSON.stringify(state.projected);
  const { value: result, metadata } = metadataDuring(() => candidate(state, after, state.context, applied.results));
  assert.ok(result); assert.equal(metadata.canonicalState, after);
  assert.notEqual(result.preferences.audienceVision, state.projected.preferences.audienceVision);
  const oracle = oldFullProjection(after, state.context);
  assert.deepEqual(result, oracle);
  assert.ok(projectionCollectionChanges(state.projected, result));
  assert.deepEqual(createDocumentChanges(state.projected, result, null,
    { collectionChanges: projectionCollectionChanges(state.projected, result) }), createDocumentChangesFull(state.projected, oracle));
  assert.equal(JSON.stringify(state.projected), priorJson);

  const status = applyWorldOperations(after, [{ type: 'status.apply', payload: {
    scope: 'actor', targetId: 'hostile', definitionId: 'status-rooted',
  } }], { now: '2026-10-05T00:00:01.000Z',
    applyStatus: (value, message) => applyStatusMessage(value, message, { mutate: true, assumeNormalized: true }),
  }).state;
  state.validate(status);
  const fresh = projectStateForAudience(status, { ...state.context, forceFreshDetection: true,
    movementCache: { beforeState: after, previousProjection: result, tokenIds: new Set() } });
  assert.deepEqual(fresh, oldFullProjection(status, state.context));
  assert.ok(projectionCollectionChanges(result, fresh), 'the next real status retains its exact predecessor qualification');
});

test('public chat keeps move and Fog metadata current without changing private Fog or its predecessor', () => {
  const state = setup(), after = append(state).state, projected = candidate(state, after);
  const moved = applyWorldOperations(after, [{ type: 'token.move', payload: { sceneId: 'scene', tokenId: 'near', x: 81, y: 50 } }],
    { now: '2026-10-05T00:00:02.000Z' }).state;
  state.validate(moved);
  const next = projectStateForAudience(moved, { ...state.context,
    movementCache: { beforeState: after, previousProjection: projected, tokenIds: new Set(['near']) } });
  assert.equal(worldOf(next).actors, worldOf(projected).actors, 'a non-source move still takes the real targeted path');
  assert.deepEqual(next, oldFullProjection(moved, state.context));
  const scene = sceneOf(after), fog = { ...scene.fog, exploredByParty: { ...scene.fog.exploredByParty,
    party: { rows: { 2: [[20, 25]] } } } };
  const fogged = { ...after, preferences: { ...after.preferences, worldV2: { ...worldOf(after),
    updatedAt: 'fog', scenes: [{ ...scene, fog }] } } }; state.validate(fogged);
  const shell = { ...projected, preferences: { ...projected.preferences, entitySystem: { ...projected.preferences.entitySystem },
    worldV2: { ...worldOf(projected), updatedAt: 'fog', actors: [...worldOf(projected).actors],
      scenes: [{ ...sceneOf(projected), fog: { ...sceneOf(projected).fog, exploredByParty: { party: fog.exploredByParty.party } } }] } } };
  const { value: fogResult, metadata } = metadataDuring(() => advanceFogProjectionMetadata(projected, shell, after, fogged, state.context));
  assert.equal(metadata.canonicalState, fogged);
  assert.deepEqual(fogResult, oldFullProjection(fogged, state.context));
  assert.deepEqual(Object.keys(sceneOf(fogResult).fog.exploredByParty), ['party']);
});

test('500-message trimming and protected chat retain complete projection', () => {
  const state = setup({}, Array.from({ length: 500 }, (_, index) => ({ id: `old-${index}`, type: 'chat',
    createdAt: '2026-10-05T00:00:00.000Z', text: 'old', data: null })));
  const after = append(state).state;
  assert.equal(after.preferences.chatSystem.messages.length, 500);
  assert.equal(candidate(state, after), null);
  const full = projectStateForAudience(after, state.context);
  assert.deepEqual(full, oldFullProjection(after, state.context));
  assert.equal(full.preferences.chatSystem.messages[0].id, 'old-1');
  const ordinary = setup(), publicAfter = append(ordinary).state;
  const protectedAfter = { ...publicAfter, preferences: { ...publicAfter.preferences, chatSystem: {
    ...publicAfter.preferences.chatSystem, messages: [{ id: 'public-chat', type: 'chat',
      createdAt: '2026-10-05T00:00:00.000Z', text: 'secret', data: { tokenId: 'missing' } }],
  } } }; ordinary.validate(protectedAfter);
  assert.equal(candidate(ordinary, protectedAfter), null);
});

test('permission, source, hook, map and canonical predecessor changes cannot advance public-chat metadata', () => {
  const state = setup(), after = append(state).state;
  for (const patch of [
    { userId: 'other' }, { user: { ownership: {}, placementGrants: {} } }, { user: { ownership: { scout: 'owner' }, disabled: true } },
    { visionSourceTokenId: null }, { mapPackage: { ...map } }, { mapMetrics: { metersPerUnit: 2 } },
    { describeVision: () => ({ preciseRangeMeters: 30, vagueRangeMeters: 50, senses: {} }) },
    { trustedProjection: false }, { isCanonicalData: undefined },
  ]) {
    const normal = candidate(state, after); assert.ok(normal);
    assert.equal(advancePublicChatProjectionMetadata(state.projected,
      { ...normal, preferences: { ...normal.preferences, audienceVision: state.projected.preferences.audienceVision } },
      state.before, after, { ...state.context, ...patch }), null);
  }
  assert.equal(candidate({ ...state, before: structuredClone(state.before) }, after), null);
});

test('all non-chat canonical and recipient leaves must remain unchanged', () => {
  const state = setup(), after = append(state).state, normal = candidate(state, after);
  const shell = { ...normal, preferences: { ...normal.preferences, audienceVision: state.projected.preferences.audienceVision } };
  for (const changed of [
    { ...after, markers: [] },
    { ...after, preferences: { ...after.preferences, entitySystem: { ...after.preferences.entitySystem, tokens: [] } } },
    { ...after, preferences: { ...after.preferences, worldV2: { ...worldOf(after), scenes: [{ ...sceneOf(after), occlusionShapes: [] }] } } },
    { ...after, preferences: { ...after.preferences, worldV2: { ...worldOf(after), actors: [...worldOf(after).actors] } } },
  ]) {
    state.validate(changed);
    assert.equal(advancePublicChatProjectionMetadata(state.projected, shell, state.before, changed, state.context), null);
  }
  for (const changed of [
    { ...shell, markers: [] },
    { ...shell, preferences: { ...shell.preferences, entitySystem: { ...shell.preferences.entitySystem, tokens: [] } } },
    { ...shell, preferences: { ...shell.preferences, worldV2: { ...worldOf(shell), actors: [{ ...worldOf(shell).actors[0] }] } } },
    { ...shell, preferences: { ...shell.preferences, worldV2: { ...worldOf(shell), scenes: [{ ...sceneOf(shell), fog: {} }] } } },
    { ...shell, preferences: { ...shell.preferences, chatSystem: { ...shell.preferences.chatSystem,
      messages: [{ ...shell.preferences.chatSystem.messages[0], text: 'Tampered' }] } } },
  ]) assert.equal(advancePublicChatProjectionMetadata(state.projected, changed, state.before, after, state.context), null);
});
