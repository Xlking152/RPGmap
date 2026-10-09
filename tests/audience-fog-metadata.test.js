import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { projectStateForAudience, advanceFogProjectionMetadata, advancePublicChatProjectionMetadata, matchesSourceFreeProjectionScope } from '../src/vision/audience.js';
import { projectStateForAudience as oldFullProjection } from './fixtures/audience-before-targeted-movement.mjs';
import { createPreviousProjectionFunctions } from './fixtures/server-incremental-before-preparation.js';
import { createCanonicalWorldValidator } from '../deployment/local-server/world-schema.mjs';
import { createDocumentChanges, createDocumentChangesFull, createFogDocumentChanges } from '../src/documents/changes.js';
import { applyWorldOperations } from '../src/world/operations.js';
import { INFINITE_HORROR_STATUS_DEFINITIONS } from '../src/rulesets/infinite-horror/statuses.js';
import { migrateTestStateToWorldV3 } from './helpers/world-v3.js';

const server = readFileSync(new URL('../deployment/local-server/server.mjs', import.meta.url), 'utf8');
const serverFunctions = server.slice(server.indexOf('function lightweightProjectionShell('),
  server.indexOf('function sendAudienceSnapshot('));
const currentFactory = new Function('dependencies', `
  const { sessions, committedPatches, audienceStateFor, projectMotionForSession,
    createFogDocumentChanges, createDocumentChanges, sendSocket, rememberResumeCommit,
    describeVisionForToken, describeServerVision, structuredClone, advanceFogProjectionMetadata, advancePublicChatProjectionMetadata, matchesSourceFreeProjectionScope,
    visionMapForScene, findUser, assertCanonicalWorldState } = dependencies;
  ${serverFunctions}
  return { tryIncrementalAudienceProjection, broadcastOperationCommit };
`);
const map = { id: 'fog-metadata-map', version: '1', width: 1000, height: 1000, metersPerUnit: 1, features: [] };
const ruleset = { vision: { describe: () => ({ preciseRangeMeters: 120, vagueRangeMeters: 300, senses: {} }) } };
const worldOf = state => state.preferences.worldV2;
const sceneOf = state => worldOf(state).scenes[0];
const actorsOf = state => worldOf(state).actors;
const fogOperations = [{ type: 'scene.fog.explore', payload: { sceneId: 'scene', partyId: 'party-a' } }];
const fogResults = [{ action: 'scene.fog.explore', sceneId: 'scene', partyId: 'party-a', dirtyBounds: null }];

function fixture() {
  const actor = (id, partyId) => ({ id, name: id, type: 'pc', partyId,
    system: { privateNotes: `secret-${id}` }, effects: [] });
  const token = (id, actorId, x, y, extra = {}) => ({ id, actorId, actorLink: true, actorDelta: null,
    placement: 'map', x, y, featureId: null, elevationMeters: 0, diameterMeters: 1, rotation: 0,
    hidden: false, locked: false, showName: true, effects: [], controllerUserIds: [],
    visibility: { mode: 'public', userIds: [] }, vision: { enabled: true }, ...extra });
  return migrateTestStateToWorldV3({ markers: [], attackAreas: [], preferences: { worldV2: {
    schemaVersion: 2, id: 'fog-metadata-world', name: 'Fog metadata', ruleset: { id: 'infinite-horror', version: '1.1.0' },
    activeSceneId: 'scene', actors: [actor('scout-a', 'party-a'), actor('scout-b', 'party-b'), actor('hostile', 'party-hostile')],
    statusDefinitions: structuredClone(INFINITE_HORROR_STATUS_DEFINITIONS), scenes: [{ id: 'scene',
      mapPackage: { id: map.id, version: map.version }, markers: [], attackAreas: [], sceneEvents: [], featureStates: {},
      settings: { lighting: 'normal', gridVisible: true },
      occlusionShapes: [{ id: 'wall', kind: 'wall', points: [[100, 0], [110, 0], [110, 300], [100, 300]] }],
      tokens: [token('source-a', 'scout-a', 50, 50), token('source-b', 'scout-b', 45, 55),
        token('near', 'hostile', 80, 50), token('vague', 'hostile', 80, 200), token('far', 'hostile', 700, 700),
        token('blocked', 'hostile', 180, 50), token('policy-hidden', 'hostile', 80, 45, { visibility: { mode: 'gm', userIds: [] } })],
      fog: { schemaVersion: 1, cellSizeMeters: 5, exploredByParty: {
        'party-a': { rows: { 1: [[0, 10]] } }, 'party-b': { rows: { 2: [[20, 30]] } },
        'party-private': { rows: { 99: [[999, 999]] } },
      } } }],
  } } });
}

function viewer(validate, userId = 'a', extra = {}) {
  const ids = new Map();
  return { role: 'player', userId, user: { ownership: { [`scout-${userId}`]: 'owner' }, placementGrants: {} },
    visionSourceTokenId: `source-${userId}`, ruleset, mapPackage: map, mapMetrics: { metersPerUnit: 1 },
    trustedProjection: true, isCanonicalData: validate.isImmutableData,
    opaqueIdFor: (kind, id) => { const key = `${kind}:${id}`; const value = `opaque-${userId}-${key}`; ids.set(key, value); return value; },
    lookupOpaqueId: (kind, id) => ids.get(`${kind}:${id}`), ...extra };
}

function captureRegistrations(callback) {
  const original = WeakMap.prototype.set, records = [];
  let value;
  try {
    WeakMap.prototype.set = function (key, entry) {
      records.push({ key, entry });
      return original.call(this, key, entry);
    };
    value = callback();
  } finally { WeakMap.prototype.set = original; }
  return { value, records };
}

function metadataFor(records, projection) {
  return records.find(record => record.key === projection.preferences.audienceVision
    && record.entry && Object.hasOwn(record.entry, 'targetedState'))?.entry;
}

function setup(extra = {}) {
  const validate = createCanonicalWorldValidator(), before = fixture();
  validate(before);
  const context = viewer(validate, 'a', extra);
  const { value: projected, records } = captureRegistrations(() => projectStateForAudience(before, context));
  assert.deepEqual(projected, oldFullProjection(before, context));
  const metadata = metadataFor(records, projected);
  assert.ok(metadata?.targetedIndex, 'fixture must build the real targeted metadata');
  return { validate, before, context, projected, metadata };
}

// Match commitExplorationResults: retain every non-Fog reference, replace the
// canonical World/Scene shells, merge rows, then set the authoritative timestamp.
function fogAfter(before, step = 1) {
  const scene = sceneOf(before), explored = scene.fog.exploredByParty;
  const fog = { ...scene.fog, exploredByParty: { ...explored,
    'party-a': { rows: { ...explored['party-a'].rows, [10 + step]: [[step, step + 2]] } },
    'party-b': { rows: { ...explored['party-b'].rows, [20 + step]: [[step + 20, step + 22]] } },
    'party-private': { rows: { [100 + step]: [[900 + step, 999 + step]] } },
  } };
  return { ...before, preferences: { ...before.preferences, worldV2: { ...worldOf(before),
    updatedAt: `2026-10-04T00:00:${String(step).padStart(2, '0')}.000Z`,
    scenes: [{ ...scene, fog }, ...worldOf(before).scenes.slice(1)] } } };
}

function withFogParties(state, exploredByParty) {
  const world = worldOf(state), scene = sceneOf(state);
  return { ...state, preferences: { ...state.preferences, worldV2: { ...world,
    scenes: [{ ...scene, fog: { ...scene.fog, exploredByParty } }, ...world.scenes.slice(1)] } } };
}

function move(before, tokenIds = ['near'], offset = 1) {
  return applyWorldOperations(before, tokenIds.map(tokenId => {
    const token = sceneOf(before).tokens.find(item => item.id === tokenId);
    return { type: 'token.move', payload: { sceneId: 'scene', tokenId, x: token.x + offset, y: token.y + 1 } };
  }), { source: { role: 'gm' }, now: '2026-10-04T00:01:00.000Z' }).state;
}

function harness(state, contexts = [state.context], previous = false) {
  const calls = [], responses = [], sessions = new Map();
  const users = new Map(contexts.map(context => [context.userId, context.user]));
  const dependencies = { sessions, committedPatches: new WeakMap(), structuredClone,
    createDocumentChanges, createFogDocumentChanges, advanceFogProjectionMetadata, advancePublicChatProjectionMetadata, matchesSourceFreeProjectionScope,
    describeServerVision: ruleset.vision.describe,
    assertCanonicalWorldState: state.validate, visionMapForScene: () => map, findUser: id => users.get(id),
    describeVisionForToken: () => { throw new Error('Fog cannot request movement vision'); },
    audienceStateFor: () => { throw new Error('Fog must use the incremental branch'); },
    projectMotionForSession: () => [],
    sendSocket: (socket, response) => { calls.push(`send:${socket}`); responses.push([socket, structuredClone(response)]); },
    rememberResumeCommit: () => calls.push('resume'),
  };
  return { ...(previous ? createPreviousProjectionFunctions : currentFactory)(dependencies),
    sessions, calls, responses };
}

function fogCandidate(state, after, previous = false) {
  const instance = harness(state, [state.context], previous);
  return instance.tryIncrementalAudienceProjection({ ...state.context, id: state.context.userId },
    state.projected, after, fogOperations, fogResults, state.before);
}

function checkedMove(state, before, prior, tokenIds = ['near'], hit = true) {
  const after = move(before, tokenIds);
  state.validate(after);
  const result = projectStateForAudience(after, { ...state.context,
    movementCache: { beforeState: before, previousProjection: prior, tokenIds: new Set(tokenIds) } });
  const oracle = oldFullProjection(after, state.context);
  assert.deepEqual(result, oracle);
  assert.deepEqual(createDocumentChanges(prior, result), createDocumentChangesFull(prior, oracle));
  assert.equal(actorsOf(result) === actorsOf(prior), hit, 'Actor collection identity proves actual targeted hit');
  return { before: after, projected: result };
}

test('fresh reset/hide projection preserves only exact private ray context and unchanged detached leaves', () => {
  const state = setup();
  for (const explored of [{}, { 'party-a': { rows: { 1: [[0, 1]] } },
    'party-private': { rows: { 99: [[999, 999]] } } }]) {
    const after = withFogParties(state.before, explored); state.validate(after);
    const priorJson = JSON.stringify(state.projected);
    const { value: projected, records } = captureRegistrations(() => projectStateForAudience(after, {
      ...state.context, forceFreshDetection: true,
      movementCache: { beforeState: state.before, previousProjection: state.projected, tokenIds: new Set() },
    }));
    assert.deepEqual(projected, oldFullProjection(after, state.context));
    assert.deepEqual(createDocumentChanges(state.projected, projected),
      createDocumentChangesFull(state.projected, oldFullProjection(after, state.context)));
    assert.equal(JSON.stringify(state.projected), priorJson);
    assert.equal(projected.preferences.worldV2.actors[0], state.projected.preferences.worldV2.actors[0]);
    assert.notEqual(projected.preferences.worldV2.actors[0], worldOf(after).actors[0], 'private authority is never exposed');
    const metadata = metadataFor(records, projected);
    assert.equal(metadata.canonicalState, after);
    assert.equal(metadata.rayContexts[0], state.metadata.rayContexts[0]);
    assert.ok(!Object.hasOwn(sceneOf(projected).fog.exploredByParty, 'party-private'));
    for (const contextPatch of [{ userId: 'other', user: { ownership: {}, placementGrants: {} } },
      { visionSourceTokenId: 'source-b' }, { mapMetrics: { metersPerUnit: 2 } }]) {
      const viewer = { ...state.context, ...contextPatch };
      const actual = projectStateForAudience(after, { ...viewer, forceFreshDetection: true,
        movementCache: { beforeState: state.before, previousProjection: state.projected, tokenIds: new Set() } });
      assert.deepEqual(actual, oldFullProjection(after, viewer), 'scope changes still require current full visibility');
    }
  }
});

test('real server Fog branch advances fresh private metadata and preserves the old full output', () => {
  const state = setup(), after = fogAfter(state.before); state.validate(after);
  const priorJson = JSON.stringify(state.projected), priorInputs = state.metadata.partyInputs;
  const priorEntries = sceneOf(state.before).tokens.map(token => state.metadata.policies.get(token));
  const { value: result, records } = captureRegistrations(() => fogCandidate(state, after));
  const newMetadata = metadataFor(records, result);
  assert.deepEqual(result, fogCandidate(state, after, true));
  assert.deepEqual(result, oldFullProjection(after, state.context));
  assert.deepEqual(createFogDocumentChanges(state.projected, result, { fog: fogResults }),
    createDocumentChangesFull(state.projected, oldFullProjection(after, state.context), null, { fog: fogResults }));
  assert.notEqual(result.preferences.audienceVision, state.projected.preferences.audienceVision);
  assert.notEqual(newMetadata, state.metadata);
  assert.equal(newMetadata.targetedState, after);
  assert.equal(newMetadata.targetedIndex, state.metadata.targetedIndex);
  assert.equal(newMetadata.policies, state.metadata.policies);
  assert.equal(newMetadata.partyInputs.actors, worldOf(after).actors);
  assert.equal(newMetadata.partyInputs.scenes, worldOf(after).scenes);
  assert.equal(state.metadata.targetedState, state.before);
  assert.equal(state.metadata.partyInputs, priorInputs);
  assert.deepEqual(sceneOf(state.before).tokens.map(token => state.metadata.policies.get(token)), priorEntries);
  assert.equal(JSON.stringify(state.projected), priorJson);
  checkedMove(state, after, result, ['near', 'vague', 'far', 'blocked', 'policy-hidden']);
  checkedMove(state, after, state.projected, ['near'], false);
});

test('alternating Fog commits and target moves keep a current independent projection chain', () => {
  let state = setup();
  for (let step = 1; step <= 5; step++) {
    const after = fogAfter(state.before, step); state.validate(after);
    const fogged = fogCandidate(state, after);
    assert.deepEqual(fogged, oldFullProjection(after, state.context));
    assert.deepEqual(Object.keys(sceneOf(fogged).fog.exploredByParty), ['party-a']);
    const next = checkedMove(state, after, fogged, [step % 2 ? 'near' : 'vague']);
    state = { ...state, ...next };
  }
});

test('two recipients retain private Fog, opaque IDs and origin/resume order in a real Fog broadcast', () => {
  const state = setup(), contextB = viewer(state.validate, 'b'), contexts = [state.context, contextB];
  const projectionB = projectStateForAudience(state.before, contextB);
  const current = harness(state, contexts), previous = harness(state, contexts, true);
  for (const instance of [current, previous]) {
    for (const [index, context] of contexts.entries()) instance.sessions.set(context.userId, {
      ...context, id: context.userId, identityStatus: 'active', audienceRevision: index + 1,
      audienceProjection: index ? projectionB : state.projected,
    });
  }
  const after = fogAfter(state.before); state.validate(after);
  const commit = { beforeState: state.before, afterState: after, operationId: 'fog-one',
    baseRevision: 2, revision: 3, updatedAt: worldOf(after).updatedAt, results: fogResults,
    operations: fogOperations, originSessionId: 'b', documentBatch: true,
    onOriginProjection: () => current.calls.push('origin') };
  current.broadcastOperationCommit(commit);
  previous.broadcastOperationCommit({ ...commit, onOriginProjection: () => previous.calls.push('origin') });
  assert.deepEqual(current.responses, previous.responses);
  assert.deepEqual(current.calls, previous.calls);
  assert.deepEqual(current.calls, ['send:b', 'origin', 'send:a', 'resume']);
  const resultA = current.sessions.get('a').audienceProjection, resultB = current.sessions.get('b').audienceProjection;
  assert.deepEqual(resultA, oldFullProjection(after, state.context));
  assert.deepEqual(resultB, oldFullProjection(after, contextB));
  assert.deepEqual(Object.keys(sceneOf(resultA).fog.exploredByParty), ['party-a']);
  assert.deepEqual(Object.keys(sceneOf(resultB).fog.exploredByParty), ['party-b']);
  assert.equal(JSON.stringify(current.responses).includes('party-private'), false);
  assert.equal(JSON.stringify(resultA).includes('secret-scout-b'), false);
  assert.equal(JSON.stringify(resultB).includes('secret-scout-a'), false);
  assert.notEqual(resultA.preferences.audienceVision, resultB.preferences.audienceVision);
  const vagueA = sceneOf(resultA).tokens.find(token => token.audienceVisibility === 'vague');
  const vagueB = sceneOf(resultB).tokens.find(token => token.audienceVisibility === 'vague');
  assert.notEqual(vagueA.id, vagueB.id);
  assert.notEqual(vagueA.actorId, vagueB.actorId);
  checkedMove(state, after, resultA);
  checkedMove({ ...state, context: contextB }, after, resultB);
});

test('Fog metadata rejects extra party keys, cloned allowed records and missing allowed records', () => {
  const state = setup(), after = fogAfter(state.before); state.validate(after);
  const candidate = fogCandidate(state, after, true), parties = sceneOf(candidate).fog.exploredByParty;
  const canonicalParties = sceneOf(after).fog.exploredByParty;
  for (const altered of [
    { ...parties, 'party-private': canonicalParties['party-private'] },
    { ...parties, 'party-a': structuredClone(parties['party-a']) },
    {},
  ]) {
    const result = assertRejected(state, after, withFogParties(candidate, altered));
    assert.notEqual(result.preferences.audienceVision, candidate.preferences.audienceVision);
  }
});

test('all allowed parties survive alternating Fog and movement, and canonical removal drops only its record', () => {
  let state = setup({ user: { ownership: { 'scout-a': 'owner', 'scout-b': 'owner' }, placementGrants: {} } });
  assert.deepEqual(state.metadata.partyIds, ['party-a', 'party-b']);
  for (let step = 1; step <= 3; step++) {
    const after = fogAfter(state.before, step); state.validate(after);
    const { value: fogged, records } = captureRegistrations(() => fogCandidate(state, after));
    const metadata = metadataFor(records, fogged);
    assert.equal(metadata.targetedState, after);
    assert.deepEqual(metadata.partyIds, ['party-a', 'party-b']);
    assert.deepEqual(Object.keys(sceneOf(fogged).fog.exploredByParty), ['party-a', 'party-b']);
    assert.deepEqual(fogged, oldFullProjection(after, state.context));
    for (const partyId of metadata.partyIds) {
      assert.equal(sceneOf(fogged).fog.exploredByParty[partyId], sceneOf(after).fog.exploredByParty[partyId]);
    }
    state = { ...state, ...checkedMove(state, after, fogged, [step % 2 ? 'near' : 'vague']) };
  }
  const base = fogAfter(state.before, 4);
  const after = withFogParties(base, Object.fromEntries(Object.entries(sceneOf(base).fog.exploredByParty)
    .filter(([partyId]) => partyId !== 'party-b')));
  state.validate(after);
  const { value: fogged, records } = captureRegistrations(() => fogCandidate(state, after));
  const metadata = metadataFor(records, fogged);
  assert.equal(metadata.targetedState, after);
  assert.deepEqual(metadata.partyIds, ['party-a', 'party-b'], 'record removal does not revoke party membership');
  assert.deepEqual(Object.keys(sceneOf(fogged).fog.exploredByParty), ['party-a']);
  assert.deepEqual(fogged, oldFullProjection(after, state.context));
  checkedMove(state, after, fogged);
});

function assertRejected(state, after, candidate, context = state.context, before = state.before) {
  const json = JSON.stringify(candidate), { value: result, records } = captureRegistrations(() =>
    advanceFogProjectionMetadata(state.projected, candidate, before, after, context));
  assert.deepEqual(result, candidate, 'failed proof must preserve all Fog and recipient output values');
  assert.equal(JSON.stringify(candidate), json);
  assert.notEqual(result.preferences.audienceVision, candidate.preferences.audienceVision);
  assert.equal(records.some(record => record.key === result.preferences.audienceVision), false,
    'failure must not register either private metadata or audience scope');
  return result;
}

test('permission, source, map and missing metadata failures mint an unregistered independent key', () => {
  for (const patch of [
    { role: 'gm' }, { userId: 'other' }, { visionSourceTokenId: 'source-b' },
    { user: { ownership: { 'scout-a': 'owner', hostile: 'owner' }, placementGrants: {} } },
    { user: { ownership: { 'scout-a': 'owner' }, placementGrants: {}, disabled: true } },
    { mapPackage: { ...map } }, { mapMetrics: { metersPerUnit: 2 } },
    { trustedProjection: false }, { isCanonicalData: undefined },
  ]) {
    const state = setup(), after = fogAfter(state.before); state.validate(after);
    const candidate = fogCandidate(state, after, true);
    const result = assertRejected(state, after, candidate, { ...state.context, ...patch });
    checkedMove(state, after, result, ['near'], false);
  }
  const state = setup(), after = fogAfter(state.before); state.validate(after);
  const candidate = fogCandidate(state, after, true);
  for (const changed of [
    { ...candidate, preferences: { ...candidate.preferences, audienceVision: { ...candidate.preferences.audienceVision } } },
    { ...candidate, preferences: { ...candidate.preferences, audienceVision: { ...candidate.preferences.audienceVision, partyIds: ['party-b'] } } },
  ]) assertRejected(state, after, changed);
  const clonedState = { ...state, projected: structuredClone(state.projected) };
  assertRejected(clonedState, after, fogCandidate(clonedState, after, true));
  assertRejected(state, after, state.projected);
});

function changedCanonical(after, change) {
  const world = worldOf(after), scene = sceneOf(after);
  return { ...after, ...change.root, preferences: { ...after.preferences, ...change.preferences, worldV2: {
    ...world, ...change.world, scenes: [{ ...scene, ...change.scene }, ...world.scenes.slice(1)] } } };
}

test('every non-Fog canonical reference, unknown field and signed zero invalidates metadata advancement', () => {
  for (const change of [
    { root: { unknown: 1 } }, { root: { markers: [] } }, { root: { attackAreas: [] } },
    { preferences: { unknown: 1 } },
    { world: { name: 'changed' } }, { scene: { unknown: 1 } },
    { scene: { settings: { lighting: 'dark', gridVisible: true } } },
    { scene: { featureStates: {} } }, { scene: { sceneEvents: [] } }, { scene: { markers: [] } },
    { scene: { occlusionShapes: [] } },
  ]) {
    const state = setup(), after = changedCanonical(fogAfter(state.before), change); state.validate(after);
    assertRejected(state, after, fogCandidate(state, after, true));
  }
  {
    const state = setup(), base = fogAfter(state.before);
    const after = changedCanonical(base, { preferences: { entitySystem: { ...base.preferences.entitySystem } } });
    state.validate(after);
    assertRejected(state, after, fogCandidate(state, after, true));
  }
  for (const collection of ['actors', 'statusDefinitions', 'journals']) {
    const state = setup(), base = fogAfter(state.before);
    const after = changedCanonical(base, { world: { [collection]: [...(worldOf(base)[collection] || [])] } });
    state.validate(after); assertRejected(state, after, fogCandidate(state, after, true));
  }
  for (const tokenPatch of [{ x: 81 }, { controllerUserIds: ['a'] },
    { light: { enabled: true, rangeMeters: 300, intensity: 1, color: '#fff3c4', elevationOffsetMeters: 0, occlusion: 'scene' } }]) {
    const state = setup(), base = fogAfter(state.before);
    const after = changedCanonical(base, { scene: { tokens: sceneOf(base).tokens.map(token => token.id === 'near' ? { ...token, ...tokenPatch } : token) } });
    state.validate(after); assertRejected(state, after, fogCandidate(state, after, true));
  }
  const state = setup(), before = changedCanonical(state.before, { scene: { unknown: -0 } }); state.validate(before);
  const projected = projectStateForAudience(before, state.context), current = { ...state, before, projected };
  const after = changedCanonical(fogAfter(before), { scene: { unknown: 0 } }); state.validate(after);
  assertRejected(current, after, fogCandidate(current, after, true));
});

test('unaccepted, mutable, accessor and Proxy states cannot qualify even when schema-valid', () => {
  for (const kind of ['unaccepted', 'shallow', 'getter', 'proxy']) {
    const state = setup(), base = fogAfter(state.before);
    let after = base;
    if (kind === 'shallow') Object.freeze(after);
    if (kind === 'getter') {
      after = changedCanonical(base, { scene: { tokens: [...sceneOf(base).tokens] } });
      const token = { ...sceneOf(after).tokens[2] };
      Object.defineProperty(token, 'rotation', { enumerable: true, configurable: true, get: () => 0 });
      sceneOf(after).tokens[2] = token;
      state.validate(after);
    }
    if (kind === 'proxy') {
      after = changedCanonical(base, { scene: { tokens: [...sceneOf(base).tokens] } });
      sceneOf(after).tokens[2] = new Proxy({ ...sceneOf(after).tokens[2] }, {});
      state.validate(after);
    }
    assert.equal(state.validate.isImmutableData(after), false, kind);
    const candidate = fogCandidate(state, after, true);
    assertRejected(state, after, candidate);
  }
  const state = setup(), after = fogAfter(state.before); state.validate(after);
  assertRejected(state, after, fogCandidate(state, after, true), state.context, structuredClone(state.before));
});

test('recipient Actor, Token, entity and non-Fog output changes cannot inherit predecessor metadata', () => {
  const state = setup(), after = fogAfter(state.before); state.validate(after);
  const candidate = fogCandidate(state, after, true);
  for (const changed of [
    { ...candidate, markers: [] },
    { ...candidate, preferences: { ...candidate.preferences, entitySystem: {} } },
    { ...candidate, preferences: { ...candidate.preferences, worldV2: { ...worldOf(candidate), actors: [] } } },
    { ...candidate, preferences: { ...candidate.preferences, worldV2: { ...worldOf(candidate),
      scenes: [{ ...sceneOf(candidate), tokens: [] }] } } },
    { ...candidate, preferences: { ...candidate.preferences, worldV2: { ...worldOf(candidate),
      scenes: [{ ...sceneOf(candidate), unknown: true }] } } },
  ]) assertRejected(state, after, changed);
  const changedPartyIds = [...candidate.preferences.audienceVision.partyIds];
  candidate.preferences.audienceVision.partyIds = ['party-b'];
  try { assertRejected(state, after, candidate); }
  finally { candidate.preferences.audienceVision.partyIds = changedPartyIds; }
});
