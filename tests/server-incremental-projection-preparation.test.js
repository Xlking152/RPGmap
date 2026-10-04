import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createDocumentChanges, createFogDocumentChanges } from '../src/documents/changes.js';
import { projectStateForAudience, advanceFogProjectionMetadata, targetedProjectionCollectionChanges } from '../src/vision/audience.js';
import { createPreviousProjectionFunctions } from './fixtures/server-incremental-before-preparation.js';

const server = readFileSync(new URL('../deployment/local-server/server.mjs', import.meta.url), 'utf8');
const functionSource = server.slice(server.indexOf('function lightweightProjectionShell('),
  server.indexOf('function sendAudienceSnapshot('));
const currentFactory = new Function('dependencies', `
  const { sessions, audienceStateFor, projectMotionForSession, createFogDocumentChanges,
    createDocumentChanges, sendSocket, rememberResumeCommit, committedPatches,
    describeVisionForToken, advanceFogProjectionMetadata, targetedProjectionCollectionChanges, visionMapForScene,
    findUser, assertCanonicalWorldState, structuredClone, metrics } = dependencies;
  ${functionSource}
  const shell = lightweightProjectionShell;
  lightweightProjectionShell = (...args) => { metrics.shells++; return shell(...args); };
  const targets = movementProjectionTargets;
  movementProjectionTargets = (...args) => { metrics.targets++; return targets(...args); };
  const incremental = tryIncrementalAudienceProjection;
  tryIncrementalAudienceProjection = (...args) => {
    metrics.preparedTargets.push(args[6]);
    return incremental(...args);
  };
  return { tryIncrementalAudienceProjection, broadcastOperationCommit, movementProjectionTargets };
`);

const token = (id, actorId, x = 10) => ({ id, actorId, actorLink: true, placement: 'map',
  x, y: 20, elevationMeters: 0, effects: [], light: { enabled: false } });

function fixture() {
  const actors = [{ id: 'actor-source', type: 'pc', partyId: 'p', system: { hp: 10 } },
    { id: 'actor-target', type: 'npc', partyId: null, system: { hp: 8 } }];
  const source = token('source', actors[0].id), target = token('target', actors[1].id, 30);
  const scenes = [{ id: 'active', name: 'Active', tokens: [source, target], markers: [], attackAreas: [
    { id: 'area', anchor: { type: 'token', tokenId: 'target' }, x: 30 },
  ], sceneEvents: [], featureStates: {}, fog: { cellSizeMeters: 5,
    exploredByParty: { p: { rows: { 1: [[1, 2]] } }, private: { rows: { 5: [[5, 6]] } } } } },
  { id: 'other:α', name: 'Other', tokens: [token('other-token', actors[1].id)], markers: [],
    attackAreas: [], sceneEvents: [], featureStates: {}, fog: { cellSizeMeters: 5, exploredByParty: {} } }];
  const before = { preferences: { worldV2: { id: 'world', activeSceneId: 'active',
    updatedAt: 'before', actors, scenes, journals: [], statusDefinitions: [
      { id: 'ordinary', capabilities: {} }, { id: 'invisible', capabilities: { visibility: 'invisible' } },
    ] }, entitySystem: { actors, tokens: scenes[0].tokens }, chatSystem: { messages: [] } } };
  const projection = structuredClone(before);
  projection.preferences.audienceVision = { schemaVersion: 1, partyIds: ['p'], source: {
    tokenId: 'source', x: 10, y: 20, elevationMeters: 0, preciseRangeMeters: 120,
    vagueRangeMeters: 120, senses: {}, lighting: 'normal',
  } };
  delete projection.preferences.worldV2.scenes[0].fog.exploredByParty.private;
  const after = structuredClone(before);
  after.preferences.worldV2.updatedAt = 'after';
  after.preferences.worldV2.scenes[0].tokens[1].x = 34;
  after.preferences.worldV2.scenes[0].attackAreas[0].x = 34;
  return { before, projection, after };
}

function harness(previous = false, overrides = {}) {
  const metrics = { shells: 0, clones: 0, targets: 0, preparedTargets: [], caches: [],
    calls: [], responses: [], resumptions: [] };
  const dependencies = {
    sessions: new Map(), committedPatches: new WeakMap(), metrics,
    advanceFogProjectionMetadata, targetedProjectionCollectionChanges, visionMapForScene: () => null, findUser: () => null,
    assertCanonicalWorldState: { isImmutableData: () => false },
    structuredClone(value) { metrics.clones++; return structuredClone(value); },
    describeVisionForToken(state, id) {
      const value = state.preferences.worldV2.scenes.flatMap(scene => scene.tokens).find(item => item.id === id);
      return value ? { ...value, preciseRangeMeters: 120, vagueRangeMeters: 150,
        preciseGroundRangeMeters: 120, vagueGroundRangeMeters: 150, senses: { darkvision: true }, lighting: 'normal' } : null;
    },
    audienceStateFor(session, state, options = {}) {
      metrics.caches.push(options.movementCache);
      metrics.calls.push(`full:${session.id}`);
      const next = structuredClone(state);
      next.preferences.audienceVision = { partyIds: [session.id], source: null };
      next.preferences.worldV2.actors = [{ ...next.preferences.worldV2.actors[0], name: session.id }];
      next.preferences.worldV2.scenes[0].tokens = next.preferences.worldV2.scenes[0].tokens.slice(0, 1);
      next.preferences.worldV2.scenes[1].tokens = [];
      return next;
    },
    projectMotionForSession(_results, _before, _after, session) {
      metrics.calls.push(`motion:${session.id}`);
      return [{ tokenId: session.id, sceneId: 'active' }];
    },
    createDocumentChanges, createFogDocumentChanges,
    sendSocket(socket, response) {
      metrics.calls.push(`send:${socket}`);
      metrics.responses.push([socket, structuredClone(response)]);
    },
    rememberResumeCommit(entry) { metrics.calls.push('resume'); metrics.resumptions.push(entry); },
    ...overrides,
  };
  return { ...((previous ? createPreviousProjectionFunctions : currentFactory)(dependencies)), metrics, dependencies };
}

const move = ids => [{ type: 'token.movePath', payload: { tokenIds: ids } }];
const session = { id: 'player', role: 'player', visionSourceTokenId: 'source' };

function compareIncremental({ before, projection, after }, operations, results = [], viewer = session) {
  const input = structuredClone({ before, projection, after, operations, results, viewer });
  const current = harness(), previous = harness(true);
  const actual = current.tryIncrementalAudienceProjection(viewer, projection, after, operations, results, before);
  const expected = previous.tryIncrementalAudienceProjection(viewer, projection, after, operations, results, before);
  assert.deepEqual(actual, expected);
  assert.deepEqual({ before, projection, after, operations, results, viewer }, input);
  return { actual, current, previous };
}

test('rejected source, target, chat and unsupported operations allocate no projection shell', () => {
  for (const kind of ['restricted-source-move', 'vague-source-move', 'hidden-source-move',
    'restricted-target', 'vague-target', 'hidden-target', 'missing-target', 'missing-scene',
    'disabled-source', 'protected-chat', 'unsupported', 'status-definition', 'status-vision']) {
    const values = fixture();
    let operations = move(['target']), results = [];
    if (kind.includes('source-move')) operations = move(['source']);
    if (kind.startsWith('restricted')) values.projection.preferences.worldV2.scenes[0].tokens[1].audienceRestricted = true;
    if (kind.startsWith('vague')) values.projection.preferences.worldV2.scenes[0].tokens[1].audienceVisibility = 'vague';
    if (kind.startsWith('hidden')) values.projection.preferences.worldV2.scenes[0].tokens.pop();
    if (kind === 'missing-target') operations = move(['absent']);
    if (kind === 'missing-scene') values.after.preferences.worldV2.scenes.pop();
    if (kind === 'disabled-source') {
      operations = move(['source']);
      values.after.preferences.worldV2.scenes[0].tokens.shift();
    }
    if (kind === 'protected-chat') {
      operations = [{ type: 'chat.append', payload: {} }]; results = [{ chatId: 'chat' }];
      values.after.preferences.chatSystem.messages.push({ id: 'chat', data: { tokenId: 'private' } });
    }
    if (kind === 'unsupported') operations = [{ type: 'scene.settings.patch', payload: {} }];
    if (kind === 'status-definition') operations = [{ type: 'status.definition.upsert', payload: {} }];
    if (kind === 'status-vision') operations = [{ type: 'status.add', payload: {
      scope: 'token', targetId: 'target', statusId: 'invisible',
    } }];
    const { actual, current } = compareIncremental(values, operations, results);
    assert.equal(actual, null, kind);
    assert.equal(current.metrics.shells, 0, kind);
  }
});

test('movement preparation matches the previous output across sources, scenes, Fog and duplicate IDs', () => {
  for (const kind of ['target', 'source', 'multi', 'other-scene', 'mixed-fog', 'fog-change',
    'fog-only-change-in-other-scene', 'duplicate-projected', 'colon-id', 'empty-targets']) {
    const values = fixture();
    let operations = move(['target']);
    if (kind === 'source' || kind === 'multi') {
      operations = move(kind === 'multi' ? ['source', 'target'] : ['source']);
      values.after.preferences.worldV2.scenes[0].tokens[0].x = 15;
    }
    if (kind === 'other-scene' || kind === 'colon-id') {
      operations = [{ type: 'token.move', payload: { sceneId: 'other:α', tokenId: 'other-token' } }];
      values.after.preferences.worldV2.scenes[1].tokens[0].x = 19;
    }
    if (kind === 'mixed-fog') operations.push({ type: 'scene.fog.explore', payload: { partyId: 'p' } });
    if (kind === 'fog-change' || kind === 'mixed-fog') {
      values.after.preferences.worldV2.scenes[0].fog.exploredByParty.p.rows[1].push([4, 5]);
    }
    if (kind === 'fog-only-change-in-other-scene') {
      values.after.preferences.worldV2.scenes[1].fog.exploredByParty.p = { rows: { 1: [[1, 2]] } };
    }
    if (kind === 'duplicate-projected') {
      values.projection.preferences.worldV2.scenes[0].tokens.push({
        ...values.projection.preferences.worldV2.scenes[0].tokens[1], audienceRestricted: true,
      });
    }
    if (kind === 'empty-targets') operations = move([]);
    const { actual, current } = compareIncremental(values, operations);
    assert.ok(actual, kind);
    assert.equal(current.metrics.shells, 1, kind);
    if (kind === 'target') {
      assert.equal(actual.preferences.worldV2.scenes[1], values.projection.preferences.worldV2.scenes[1]);
      assert.equal(actual.preferences.worldV2.scenes[0].tokens[0], values.projection.preferences.worldV2.scenes[0].tokens[0]);
      actual.preferences.worldV2.scenes[0].tokens[1].x = 999;
      assert.equal(values.after.preferences.worldV2.scenes[0].tokens[1].x, 34);
    }
  }
});

test('Fog, public chat and ordinary Actor/Token status paths keep their full previous output', () => {
  for (const kind of ['fog', 'chat', 'actor-status', 'token-status', 'source-status', 'missing-status-target']) {
    const values = fixture();
    let operations, results = [];
    if (kind === 'fog') {
      operations = [{ type: 'scene.fog.explore', payload: {} }];
      values.after.preferences.worldV2.scenes[0].fog.exploredByParty.p.rows[1].push([4, 5]);
    } else if (kind === 'chat') {
      operations = [{ type: 'chat.append', payload: {} }]; results = [{ chatId: 'chat' }];
      values.after.preferences.chatSystem.messages.push({ id: 'chat', data: null, text: 'hello' });
    } else {
      operations = [{ type: 'status.add', payload: { scope: kind === 'actor-status' ? 'actor' : 'token',
        targetId: kind === 'actor-status' ? 'actor-target' : kind === 'source-status' ? 'source'
          : kind === 'missing-status-target' ? 'missing' : 'target', statusId: 'ordinary' } }];
      values.after.preferences.worldV2.actors[1].system.hp = 9;
      values.after.preferences.worldV2.scenes[0].tokens[1].effects = [{ definitionId: 'ordinary' }];
    }
    compareIncremental(values, operations, results);
  }
});

function broadcastFixture() {
  const values = fixture();
  const sessions = new Map();
  for (let index = 0; index < 6; index++) {
    const projection = structuredClone(values.projection);
    projection.preferences.worldV2.scenes[0].tokens[1].audienceRestricted = true;
    sessions.set(`socket-${index}`, { id: `player-${index}`, role: 'player', identityStatus: 'active',
      audienceRevision: index, visionSourceTokenId: 'source', audienceProjection: projection });
  }
  sessions.set('socket-gm', { id: 'gm', role: 'gm', audienceRevision: 1, audienceProjection: structuredClone(values.before) });
  sessions.set('socket-pending', { id: 'pending', role: 'player', identityStatus: 'pending' });
  return { ...values, sessions };
}

test('one broadcast prepares movement inputs once and preserves independent masks and origin/resume ordering', () => {
  const currentValues = broadcastFixture(), previousValues = broadcastFixture();
  const current = harness(false, { sessions: currentValues.sessions });
  const previous = harness(true, { sessions: previousValues.sessions });
  const input = { operationId: 'move', baseRevision: 1, revision: 2, updatedAt: 'after',
    results: [{ action: 'token.movePath', tokenIds: ['source', 'target'], motion: [] }],
    originSessionId: 'player-4', operations: move(['source', 'target']), documentBatch: true };
  let currentAck = 0, previousAck = 0;
  current.broadcastOperationCommit({ ...input, beforeState: currentValues.before, afterState: currentValues.after,
    onOriginProjection(projection) {
      currentAck++; current.metrics.calls.push('origin');
      assert.equal(projection.preferences.worldV2.actors[0].name, 'player-4');
    } });
  previous.broadcastOperationCommit({ ...input, beforeState: previousValues.before, afterState: previousValues.after,
    onOriginProjection() { previousAck++; previous.metrics.calls.push('origin'); } });
  assert.equal(current.metrics.targets, 1);
  assert.equal(current.metrics.shells, 0);
  assert.equal(current.metrics.preparedTargets.length, 7);
  assert.ok(current.metrics.preparedTargets.every(value => value === current.metrics.preparedTargets[0]));
  assert.equal(current.metrics.caches.length, 7);
  assert.ok(current.metrics.caches.every(value => value.tokenIds === current.metrics.caches[0].tokenIds));
  assert.deepEqual([...current.metrics.caches[0].tokenIds], ['source', 'target']);
  assert.deepEqual(current.metrics.responses, previous.metrics.responses);
  assert.deepEqual(current.metrics.calls, previous.metrics.calls);
  assert.equal(current.metrics.responses.length, 7);
  assert.equal(current.metrics.responses[0][0], 'socket-4');
  assert.equal(current.metrics.calls.at(-1), 'resume');
  assert.equal(currentAck, 1);
  assert.equal(previousAck, 1);
  assert.equal(current.metrics.resumptions[0].beforeState, currentValues.before);
  assert.equal(current.metrics.resumptions[0].afterState, currentValues.after);
  for (const viewer of currentValues.sessions.values()) {
    if (viewer.identityStatus === 'active') assert.equal(viewer.audienceProjection.preferences.worldV2.actors[0].name, viewer.id);
  }
  // A following authoritative commit gets a fresh private descriptor and Set.
  const oldTargets = current.metrics.preparedTargets[0], oldIds = current.metrics.caches[0].tokenIds;
  current.broadcastOperationCommit({ ...input, operationId: 'next', beforeState: currentValues.before,
    afterState: currentValues.after, operations: move(['target']), results: [{ action: 'token.movePath', tokenIds: ['target'] }] });
  assert.notEqual(current.metrics.preparedTargets.at(-1), oldTargets);
  assert.notEqual(current.metrics.caches.at(-1).tokenIds, oldIds);
  assert.deepEqual([...oldIds], ['source', 'target']);
});

test('one broadcast mixes private incremental and restricted fallback projections without sharing viewer data', () => {
  function mixedHarness(previous) {
    const values = fixture();
    for (const state of [values.before, values.after]) {
      const world = state.preferences.worldV2;
      world.actors[0].notes = 'private-p-actor';
      Object.assign(world.actors[1], { type: 'pc', partyId: 'q', notes: 'private-q-actor' });
      world.scenes[0].tokens.push(token('q-source', 'actor-target', 50));
      world.scenes[0].fog.exploredByParty.q = { rows: { 2: [[7, 8]] } };
    }
    const viewers = [
      { id: 'all-owner', visionSourceTokenId: 'target', ownership: {
        'actor-source': 'owner', 'actor-target': 'owner',
      } },
      { id: 'p-scout', visionSourceTokenId: 'source', ownership: { 'actor-source': 'owner' } },
      { id: 'q-owner', visionSourceTokenId: 'q-source', ownership: { 'actor-target': 'owner' } },
      { id: 'p-short', visionSourceTokenId: 'source', ownership: { 'actor-source': 'owner' }, range: 5 },
    ];
    const sessions = new Map(viewers.map((viewer, index) => {
      const session = { ...viewer, role: 'player', identityStatus: 'active', audienceRevision: index,
        userId: viewer.id, user: { ownership: viewer.ownership, placementGrants: {}, range: viewer.range } };
      return [`socket-${viewer.id}`, session];
    }));
    sessions.set('socket-gm', { id: 'gm', role: 'gm', audienceRevision: 7 });
    sessions.set('socket-pending', { id: 'pending', role: 'player', identityStatus: 'pending' });
    const project = (viewer, state, options = {}) => projectStateForAudience(state, {
      role: viewer.role, userId: viewer.userId, user: viewer.user,
      visionSourceTokenId: viewer.visionSourceTokenId, trustedProjection: true,
      describeVision: (_actor, { user }) => ({ preciseRangeMeters: user?.range || 120,
        vagueRangeMeters: user?.range || 150, senses: { darkvision: true } }),
      opaqueIdFor: (kind, id) => `${viewer.id}:${viewer.visionSourceTokenId}:${kind}:${id}`,
      ...options,
    });
    for (const viewer of sessions.values()) {
      if (viewer.identityStatus !== 'pending') viewer.audienceProjection = project(viewer, values.before);
    }
    const originalProjections = new Map([...sessions].map(([socket, viewer]) =>
      [socket, { reference: viewer.audienceProjection, copy: structuredClone(viewer.audienceProjection) }]));
    let runner;
    runner = harness(previous, { sessions,
      describeVisionForToken(state, id) {
        const source = state.preferences.worldV2.scenes[0].tokens.find(item => item.id === id);
        return source ? { tokenId: source.id, x: source.x, y: source.y,
          elevationMeters: source.elevationMeters, preciseRangeMeters: 120, vagueRangeMeters: 150,
          preciseGroundRangeMeters: 120, vagueGroundRangeMeters: 150,
          senses: { darkvision: true }, lighting: 'normal' } : null;
      },
      audienceStateFor(viewer, state, options = {}) {
        runner.metrics.calls.push(`full:${viewer.id}`);
        runner.metrics.caches.push(options.movementCache);
        return project(viewer, state, options);
      },
      projectMotionForSession(results, before, after, viewer) {
        runner.metrics.calls.push(`motion:${viewer.id}`);
        const tokens = after.preferences.worldV2.scenes[0].tokens;
        const precisePrivateTarget = tokens.find(item => item.id === 'target'
          && item.audienceRestricted !== true && item.audienceVisibility !== 'vague');
        return precisePrivateTarget ? structuredClone(results[0].motion) : [];
      },
    });
    return { ...values, runner, sessions, originalProjections };
  }
  const current = mixedHarness(false), previous = mixedHarness(true);
  const input = { operationId: 'mixed-audiences', baseRevision: 1, revision: 2, updatedAt: 'after',
    originSessionId: 'q-owner', operations: move(['target']), documentBatch: true,
    results: [{ action: 'token.movePath', tokenIds: ['target'], motion: [{ tokenId: 'target', sceneId: 'active',
      from: { x: 30, y: 20 }, waypoints: [{ x: 34, y: 20 }], to: { x: 34, y: 20 } }] }] };
  const unchangedInput = structuredClone(input);
  for (const values of [current, previous]) {
    const before = structuredClone(values.before), after = structuredClone(values.after);
    values.runner.broadcastOperationCommit({ ...input, beforeState: values.before, afterState: values.after,
      onOriginProjection(projection) {
        values.runner.metrics.calls.push('origin');
        assert.equal(projection.preferences.audienceVision.source.tokenId, 'q-source');
        assert.deepEqual(projection.preferences.audienceVision.partyIds, ['q']);
      } });
    assert.deepEqual(values.before, before);
    assert.deepEqual(values.after, after);
    for (const original of values.originalProjections.values()) assert.deepEqual(original.reference, original.copy);
  }
  assert.deepEqual(input, unchangedInput);
  assert.deepEqual(current.runner.metrics.responses, previous.runner.metrics.responses);
  assert.deepEqual(current.runner.metrics.calls, previous.runner.metrics.calls);
  assert.deepEqual(current.runner.metrics.calls.filter(value => value.startsWith('full:')),
    ['full:p-scout', 'full:p-short', 'full:gm']);
  assert.equal(current.runner.metrics.shells, 2, 'only the two eligible Players build incremental shells');
  assert.equal(current.runner.metrics.responses.length, 5, 'pending identity receives no commit');
  assert.equal(current.runner.metrics.responses[0][0], 'socket-q-owner');
  assert.equal(current.runner.metrics.calls.filter(value => value === 'origin').length, 1);
  assert.equal(current.runner.metrics.calls[current.runner.metrics.calls.indexOf('send:socket-q-owner') + 1], 'origin');
  assert.equal(current.runner.metrics.calls.at(-1), 'resume');
  assert.equal(current.runner.metrics.resumptions.length, 1);
  assert.deepEqual(current.runner.metrics.resumptions, previous.runner.metrics.resumptions);
  assert.equal(current.runner.metrics.targets, 1);
  assert.ok(current.runner.metrics.preparedTargets.every(value => value === current.runner.metrics.preparedTargets[0]));
  assert.deepEqual([...current.runner.metrics.preparedTargets[0]].map(([scene, ids]) => [scene, [...ids]]),
    [['active', ['target']]]);
  assert.ok(current.runner.metrics.caches.every(value => value.tokenIds === current.runner.metrics.caches[0].tokenIds));
  assert.deepEqual([...current.runner.metrics.caches[0].tokenIds], ['target']);
  for (const [socket, viewer] of current.sessions) {
    assert.deepEqual(viewer.audienceProjection, previous.sessions.get(socket).audienceProjection);
    if (viewer.role !== 'player' || viewer.identityStatus !== 'active') continue;
    const projected = viewer.audienceProjection.preferences;
    const fog = projected.worldV2.scenes[0].fog.exploredByParty;
    assert.equal(fog.private, undefined);
    const expectedParties = viewer.id === 'all-owner' ? ['p', 'q'] : viewer.id === 'q-owner' ? ['q'] : ['p'];
    assert.deepEqual(Object.keys(fog).sort(), expectedParties);
    for (const party of expectedParties) assert.deepEqual(fog[party].rows,
      current.after.preferences.worldV2.scenes[0].fog.exploredByParty[party].rows);
    assert.equal(projected.audienceVision.source.tokenId, viewer.visionSourceTokenId);
    const target = projected.worldV2.scenes[0].tokens.find(item => item.id === 'target');
    if (viewer.id === 'p-short') assert.equal(target, undefined);
    else assert.equal(target.audienceRestricted === true, viewer.id === 'p-scout');
    const actor = projected.worldV2.actors.find(item => item.id === 'actor-target');
    assert.equal(actor?.notes === 'private-q-actor', ['all-owner', 'q-owner'].includes(viewer.id));
    const pActor = projected.worldV2.actors.find(item => item.id === 'actor-source');
    assert.equal(pActor?.notes === 'private-p-actor', viewer.id !== 'q-owner');
  }
  const ownerTarget = current.sessions.get('socket-all-owner').audienceProjection.preferences.worldV2.scenes[0].tokens.find(item => item.id === 'target');
  const qTarget = current.sessions.get('socket-q-owner').audienceProjection.preferences.worldV2.scenes[0].tokens.find(item => item.id === 'target');
  assert.notEqual(ownerTarget, qTarget);
  ownerTarget.x = 999;
  assert.equal(qTarget.x, 34);
  assert.equal(current.after.preferences.worldV2.scenes[0].tokens[1].x, 34);
});

test('mixed and nonmovement broadcasts keep the previous fallback without granting a movement cache', () => {
  for (const operations of [[...move(['source']), { type: 'actor.metadata.update', payload: {} }],
    [...move(['source']), { type: 'scene.fog.explore', payload: {} }],
    [{ type: 'scene.settings.patch', payload: {} }]]) {
    const values = broadcastFixture(), oldValues = broadcastFixture();
    const current = harness(false, { sessions: values.sessions });
    const previous = harness(true, { sessions: oldValues.sessions });
    const input = { operationId: 'mixed', baseRevision: 1, revision: 2, updatedAt: 'after',
      results: [{ action: 'token.movePath', tokenIds: ['source'] }, { action: 'scene.fog.explore' }],
      originSessionId: 'player-0', operations, documentBatch: false };
    current.broadcastOperationCommit({ ...input, beforeState: values.before, afterState: values.after });
    previous.broadcastOperationCommit({ ...input, beforeState: oldValues.before, afterState: oldValues.after });
    assert.equal(current.metrics.targets, 1);
    assert.ok(current.metrics.caches.every(value => value === undefined));
    assert.deepEqual(current.metrics.responses, previous.metrics.responses);
    assert.deepEqual(current.metrics.calls, previous.metrics.calls);
  }
});
