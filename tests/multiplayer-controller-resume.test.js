import test from 'node:test';
import assert from 'node:assert/strict';
import { createMultiplayerController } from '../src/multiplayer/controller.js';
import { applyDocumentChanges, createDocumentChanges } from '../src/documents/changes.js';
import { WORLD_OPERATION_SCHEMA_VERSION } from '../src/world/operations.js';
import { STATUS_SCHEMA_VERSION } from '../src/status/model.js';
import { ACCESS_SCHEMA_VERSION } from '../src/permissions/model.js';
import { registerRuntimeStateReader } from '../src/engine/state-access.js';
import { readConnectionState } from '../src/multiplayer/connection-state.js';

const settle = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };

class Element {
  constructor() { this.dataset = {}; this.style = { removeProperty() {} }; this.children = []; this.hidden = false; }
  append(child) { this.children.push(child); }
  prepend(child) { this.children.unshift(child); }
  addEventListener() {}
  remove() {}
  querySelector(selector) { return this.queries?.[selector] || null; }
}

class FakeWebSocket {
  static OPEN = 1;
  static instances = [];
  constructor(url) { this.url = url; this.listeners = new Map(); this.messages = []; this.readyState = 0; FakeWebSocket.instances.push(this); }
  addEventListener(type, listener) {
    this.listeners.set(type, [...(this.listeners.get(type) || []), listener]);
  }
  fire(type, detail = {}) { for (const listener of this.listeners.get(type) || []) listener(detail); }
  open() { this.readyState = 1; this.fire('open'); }
  send(text) { this.messages.push(JSON.parse(text)); }
  close() { this.readyState = 3; this.fire('close'); }
  async receive(message) { this.fire('message', { data: JSON.stringify(message) }); await settle(); }
}

function projectedState(sourceTokenId = 'scout') {
  const actors = [{ id: 'actor', name: 'Scout', type: 'pc', system: {}, effects: [] }];
  const tokens = ['scout', 'other'].map((id, index) => ({ id, actorId: 'actor', placement: 'map', x: 10 + index, y: 20,
    controllerUserIds: [], effects: [] }));
  const scene = { id: 'scene', name: 'Scene', mapPackage: { id: 'map', version: '1' }, tokens,
    markers: [], attackAreas: [], sceneEvents: [], featureStates: {}, settings: { gridVisible: true },
    fog: { schemaVersion: 1, cellSizeMeters: 5, exploredByParty: { party: { rows: { 0: [[0, 3]] } } } } };
  const world = { id: 'world', schemaVersion: 4, ruleset: { id: 'test', version: '1' }, activeSceneId: 'scene',
    scenes: [scene], actors, statusDefinitions: [], updatedAt: 'before' };
  return { preferences: { worldV2: world, entitySystem: { actors, tokens, statusDefinitions: [] },
    audienceVision: { source: sourceTokenId ? { tokenId: sourceTokenId, x: 10, y: 20 } : null, partyIds: ['party'] },
    combatSystem: { combat: null }, chatSystem: { schemaVersion: 1, messages: [] } } };
}

function welcome(state, revision, resumeAccepted = false) {
  return { type: 'welcome', capabilities: { occlusion: 1 }, operationSchema: WORLD_OPERATION_SCHEMA_VERSION,
    statusSchema: STATUS_SCHEMA_VERSION, accessSchema: ACCESS_SCHEMA_VERSION, resumeAccepted,
    world: { state, revision }, audienceRevision: 0, audienceFingerprint: 'confirmed-audience',
    session: { id: 'session', userId: 'player', name: 'Player', role: 'player', identityStatus: 'active' },
    permissions: { actorOwnerIds: ['actor'], actorObserverIds: ['actor'], actorLimitedIds: [], worldWrite: true },
  };
}

async function runtime(t, { internalReader = false } = {}) {
  const originalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = FakeWebSocket; FakeWebSocket.instances = [];
  let state = projectedState(), timerId = 0;
  const timers = new Map(), storage = new Map([['rpgmap:multiplayer:visionSourceTokenId', 'scout']]);
  const view = { location: { protocol: 'http:', host: '127.0.0.1:30000', hostname: '127.0.0.1' },
    performance: globalThis.performance,
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    setTimeout(callback) { const id = ++timerId; timers.set(id, callback); return id; },
    clearTimeout: id => timers.delete(id), setInterval: () => ++timerId, clearInterval() {},
  };
  const label = new Element(), status = new Element(), toolbar = new Element(), shell = new Element();
  shell.queries = { '.toolbar-right': toolbar, '[data-role="map-status"]': status };
  const document = { defaultView: view, head: new Element(), body: new Element(), getElementById: () => null,
    createElement() { const element = new Element(); element.queries = { '[data-mp-label]': label }; return element; } };
  const map = new Element(); map.ownerDocument = document; map.closest = () => shell;
  const listeners = new Map(), events = [], imports = [], documentCommits = [];
  const snapshots = { state: 0, world: 0 };
  const api = {
    map: { getContainer: () => map }, mapPackage: { id: 'map' },
    getState: () => { snapshots.state++; return structuredClone(state); }, exportState: () => structuredClone(state),
    world: { get: () => { snapshots.world++; return structuredClone(state.preferences.worldV2); } },
    tokens: { get: id => state.preferences.worldV2.scenes[0].tokens.find(token => token.id === id) || null },
    async importState(next, persist) { state = structuredClone(next); imports.push({ state, persist }); },
    applyAuthoritativeDocumentChanges(changes, options) {
      state = applyDocumentChanges(state, changes, { updatedAt: options.updatedAt }); documentCommits.push(options);
    },
    on(type, listener) { listeners.set(type, [...(listeners.get(type) || []), listener]); },
    emit(type, detail) { events.push({ type, detail }); for (const listener of listeners.get(type) || []) listener(detail); },
  };
  if (internalReader) t.after(registerRuntimeStateReader(api, () => state));
  createMultiplayerController().register(api);
  t.after(() => { api.emit('app:destroy'); globalThis.WebSocket = originalWebSocket; });
  api.multiplayer.connect({ name: 'Player', requestedRole: 'player', playerKey: 'claim', joinCode: 'join' });
  const first = FakeWebSocket.instances.at(-1); first.open(); await first.receive(welcome(state, 4));
  events.length = 0;
  return { api, imports, documentCommits, events, snapshots, get state() { return state; },
    reconnect() {
      FakeWebSocket.instances.at(-1).close();
      assert.equal(api.multiplayer.getStatus().connected, false);
      const [id, callback] = timers.entries().next().value; timers.delete(id); callback();
      const socket = FakeWebSocket.instances.at(-1); socket.open(); return socket;
    } };
}

test('light connection reads stay current and detached without copying private access tables', async t => {
  const client = await runtime(t, { internalReader: true });
  const clone = globalThis.structuredClone;
  let copies = 0;
  globalThis.structuredClone = value => { copies++; return clone(value); };
  try {
    for (let index = 0; index < 500; index++) {
      const status = readConnectionState(client.api);
      assert.equal(status.connected, true);
      assert.equal(status.revision, 4);
      assert.equal(status.session.role, 'player');
      assert.equal(status.permissions, undefined);
      assert.equal(status.access, undefined);
      status.session.role = 'gm';
    }
    assert.equal(copies, 0);
    const complete = client.api.multiplayer.getStatus();
    assert.equal(copies, 2);
    complete.permissions.actorOwnerIds.length = 0;
    complete.session.role = 'gm';
    assert.equal(client.api.multiplayer.canControlToken('scout'), true);
  } finally { globalThis.structuredClone = clone; }
  const socket = client.reconnect();
  assert.equal(readConnectionState(client.api).connected, false);
  assert.equal(readConnectionState(client.api).retainsServerState, true);
  await socket.receive(welcome(null, 4, true));
  assert.equal(readConnectionState(client.api).resuming, true);
  await socket.receive({ type: 'resume.complete', revision: 4, audienceRevision: 0 });
  assert.equal(readConnectionState(client.api).connected, true);
  assert.equal(readConnectionState(client.api).resuming, false);
  assert.equal(readConnectionState(client.api).session.role, 'player');
  assert.equal(readConnectionState({}), undefined);
  const legacy = { connected: true, session: { role: 'gm' } };
  assert.equal(readConnectionState({ multiplayer: { getStatus: () => legacy } }), legacy);
});

test('accepted resume without a snapshot or missed patches preserves the confirmed source and projection', async t => {
  const client = await runtime(t), before = structuredClone(client.state), socket = client.reconnect();
  const hello = socket.messages.find(message => message.type === 'hello');
  assert.equal(hello.resumeRevision, 4); assert.equal(hello.visionSourceTokenId, 'scout');
  assert.equal(hello.audienceFingerprint, 'confirmed-audience');
  await socket.receive(welcome(null, 4, true));
  assert.equal(client.api.multiplayer.getVisionSource(), 'scout');
  assert.equal(client.api.multiplayer.getStatus().resuming, true);
  await socket.receive({ type: 'resume.complete', revision: 4, audienceRevision: 0 });
  assert.equal(client.api.multiplayer.getVisionSource(), 'scout');
  assert.equal(client.api.multiplayer.getStatus().resuming, false);
  assert.deepEqual(client.state, before); assert.equal(client.imports.length, 1);
  assert.deepEqual(client.events.filter(event => event.type === 'vision:source-change'), []);
});

test('accepted resume applies missed Token and Fog patches while retaining the selected source', async t => {
  const client = await runtime(t), before = structuredClone(client.state), socket = client.reconnect();
  await socket.receive(welcome(null, 6, true));
  const moved = structuredClone(before); moved.preferences.worldV2.scenes[0].tokens[0].x = 99;
  moved.preferences.audienceVision.source.x = 99;
  const movement = createDocumentChanges(before, moved, null, { motion: [{ sceneId: 'scene', tokenId: 'scout' }] });
  await socket.receive({ type: 'document.batch.committed', operationId: 'missed-move', baseRevision: 4, revision: 5,
    updatedAt: 'after-move', changes: movement });
  const explored = structuredClone(client.state);
  explored.preferences.worldV2.scenes[0].fog.exploredByParty.party.rows[0] = [[0, 10]];
  const fog = createDocumentChanges(client.state, explored);
  await socket.receive({ type: 'world.operation.committed', operationId: 'missed-fog', baseRevision: 5, revision: 6,
    updatedAt: 'after-fog', changes: fog });
  await socket.receive({ type: 'resume.complete', revision: 6, audienceRevision: 0 });
  assert.equal(client.api.multiplayer.getVisionSource(), 'scout');
  assert.equal(client.api.multiplayer.getStatus().revision, 6);
  assert.equal(client.api.multiplayer.getStatus().resuming, false);
  assert.equal(client.api.tokens.get('scout').x, 99);
  assert.deepEqual(client.state.preferences.worldV2.scenes[0].fog.exploredByParty.party.rows[0], [[0, 10]]);
  assert.deepEqual(client.documentCommits.map(commit => commit.operationId), ['missed-move', 'missed-fog']);
  assert.equal(client.imports.length, 1);
  assert.deepEqual(client.events.filter(event => event.type === 'vision:source-change'), []);
});

test('rejected resume replaces the old source with the authoritative snapshot source', async t => {
  const client = await runtime(t), socket = client.reconnect(), latest = projectedState('other');
  latest.preferences.worldV2.scenes[0].tokens[1].x = 150;
  await socket.receive(welcome(latest, 8, false));
  assert.equal(client.api.multiplayer.getVisionSource(), 'other');
  assert.equal(client.api.multiplayer.getStatus().revision, 8);
  assert.equal(client.api.multiplayer.getStatus().applyingRemote, false);
  assert.equal(client.api.tokens.get('other').x, 150); assert.equal(client.imports.length, 2);
  assert.deepEqual(client.events.filter(event => event.type === 'vision:source-change').map(event => event.detail.tokenId), ['other']);
});

test('rejected resume with no permitted source clears the previous selection', async t => {
  const client = await runtime(t), socket = client.reconnect();
  await socket.receive(welcome(projectedState(null), 8, false));
  assert.equal(client.api.multiplayer.getVisionSource(), null);
  assert.equal(client.state.preferences.audienceVision.source, null);
  assert.deepEqual(client.events.filter(event => event.type === 'vision:source-change').map(event => event.detail.tokenId), [null]);
});

for (const internalReader of [false, true]) test(`permission queries preserve live ownership, turns and instance control (${internalReader ? 'internal' : 'public fallback'} reader)`, async t => {
  const client = await runtime(t, { internalReader });
  const capabilities = client.api.multiplayer.getCapabilities();
  client.snapshots.state = 0; client.snapshots.world = 0;
  const stateBefore = structuredClone(client.state);
  for (let index = 0; index < 500; index++) {
    assert.equal(client.api.multiplayer.canControlToken('scout'), true);
    assert.equal(capabilities.canControlToken('scout'), true);
    assert.equal(capabilities.canEditActor('actor'), true);
    assert.equal(client.api.multiplayer.canControlActor('actor'), true);
    assert.equal(capabilities.canPlaceActor('actor'), false);
  }
  assert.deepEqual(client.state, stateBefore);
  assert.equal(client.snapshots.world, 0);
  if (internalReader) assert.equal(client.snapshots.state, 0);
  else assert(client.snapshots.state > 0);
  client.state.preferences.combatSystem.combat = { state: 'active', turnIndex: 0, combatants: [{ actorId: 'someone-else' }] };
  assert.equal(capabilities.canControlToken('scout'), false);
  assert.equal(client.api.multiplayer.canControlActor('actor'), false);
  client.state.preferences.worldV2.scenes[0].tokens[0].controllerUserIds = ['player'];
  assert.equal(capabilities.canControlToken('scout'), true);
  assert.equal(client.api.multiplayer.canControlToken('missing'), false);
  await FakeWebSocket.instances.at(-1).receive({ type: 'permissions.update', permissions: {
    actorOwnerIds: [], placementGrants: { actorIds: ['actor'] },
  } });
  assert.equal(capabilities.canEditActor('actor'), false);
  assert.equal(client.api.multiplayer.canControlToken('other'), false);
  assert.equal(capabilities.canControlToken('scout'), true);
  assert.equal(capabilities.canPlaceActor('actor'), true);
  client.state.preferences.worldV2.scenes[0].tokens[0].controllerUserIds = [];
  assert.equal(capabilities.canControlToken('scout'), false);
});

const documentRequests = socket => socket.messages.filter(message => message.type === 'document.batch');
const revisionDenial = (operationId, revision, state) => ({ type: 'document.batch.denied', operationId,
  code: 'revision_conflict', message: 'World changed', revision, ...(state ? { state } : {}) });

async function confirmRequest(socket, client, operationId, revision, change = () => {}) {
  const before = structuredClone(client.state), after = structuredClone(before); change(after);
  await socket.receive({ type: 'document.batch.committed', operationId, baseRevision: revision - 1, revision,
    updatedAt: `revision-${revision}`, changes: createDocumentChanges(before, after) });
  await socket.receive({ type: 'document.batch.ack', operationId, revision, results: [] });
}

test('public chat waits for a confirmed conflict snapshot and retries the same intent with one confirmation timer', async t => {
  const client = await runtime(t), socket = FakeWebSocket.instances.at(-1), starts = [], ends = [], pending = new Map();
  let clock = 10, completed = false;
  client.api.diagnostics = { enabled: true, record() {},
    begin(name, id) { starts.push([name, id]); pending.set(id, clock); },
    end(name, id) { if (pending.has(id)) { ends.push([name, id, clock - pending.get(id)]); pending.delete(id); } } };
  const result = client.api.multiplayer.performOperations([{ type: 'chat.append', payload: { text: 'Keep this message' } }],
    { kind: 'chat', requestedOperationId: 'retry-chat' }).then(value => { completed = true; return value; });
  const original = structuredClone(documentRequests(socket)[0]);
  clock = 20; await socket.receive(revisionDenial(original.operationId, 5));
  assert.equal(completed, false); assert.equal(documentRequests(socket).length, 1);
  assert.equal(socket.messages.at(-1).type, 'world.snapshot.request');
  const latest = structuredClone(client.state);
  latest.preferences.worldV2.scenes[0].fog.exploredByParty.party.rows[0] = [[0, 7]];
  clock = 40; await socket.receive({ type: 'world.snapshot', state: latest, revision: 5 });
  assert.equal(documentRequests(socket).length, 2);
  assert.deepEqual(documentRequests(socket)[1], { ...original, baseRevision: 5 });
  assert.equal(client.api.multiplayer.getStatus().pendingOperationCount, 1);
  clock = 70;
  await confirmRequest(socket, client, original.operationId, 6, state => {
    state.preferences.chatSystem.messages.push({ id: 'server-chat', text: 'Keep this message', data: null });
  });
  assert.equal((await result).operationId, original.operationId);
  assert.equal(completed, true); assert.equal(client.api.multiplayer.getStatus().pendingOperationCount, 0);
  assert.equal(client.state.preferences.chatSystem.messages.length, 1);
  assert.deepEqual(starts, [['network.confirm', original.operationId]]);
  assert.deepEqual(ends, [['network.confirm', original.operationId, 60]]);
  assert.equal(client.events.filter(event => event.type === 'world:operation-result').length, 1);
});

for (const type of ['status.apply', 'status.remove']) test(`${type} reuses already confirmed Fog revision without a snapshot reload`, async t => {
  const client = await runtime(t), socket = FakeWebSocket.instances.at(-1);
  const result = client.api.multiplayer.performStatusOperation(type, {
    operationId: `retry-${type}`, scope: 'actor', targetId: 'actor', definitionId: 'ordinary',
  });
  const original = structuredClone(documentRequests(socket)[0]);
  await confirmRequest(socket, client, 'background-fog', 5, state => {
    state.preferences.worldV2.scenes[0].fog.exploredByParty.party.rows[0] = [[0, 7]];
  });
  const imports = client.imports.length;
  await socket.receive(revisionDenial(original.operationId, 5));
  assert.equal(documentRequests(socket).length, 2);
  assert.deepEqual(documentRequests(socket)[1], { ...original, baseRevision: 5 });
  assert.equal(socket.messages.filter(message => message.type === 'world.snapshot.request').length, 0);
  assert.equal(client.imports.length, imports);
  await confirmRequest(socket, client, original.operationId, 6);
  assert.equal((await result).revision, 6);
});

test('retrying chat preserves queued operation ordering until the first authoritative commit and ACK', async t => {
  const client = await runtime(t), socket = FakeWebSocket.instances.at(-1);
  const first = client.api.multiplayer.performOperations([{ type: 'chat.append', payload: { text: 'First' } }],
    { requestedOperationId: 'first-chat' });
  const second = client.api.multiplayer.performOperations([{ type: 'chat.append', payload: { text: 'Second' } }],
    { requestedOperationId: 'second-chat' });
  await socket.receive(revisionDenial('first-chat', 5, client.state));
  assert.deepEqual(documentRequests(socket).map(message => message.operationId), ['first-chat', 'first-chat']);
  await confirmRequest(socket, client, 'first-chat', 6); await first;
  assert.deepEqual(documentRequests(socket).map(message => message.operationId), ['first-chat', 'first-chat', 'second-chat']);
  assert.equal(documentRequests(socket)[2].baseRevision, 6);
  await confirmRequest(socket, client, 'second-chat', 7); await second;
});

test('revision retries are bounded and retain the original operation ID until final failure', async t => {
  const client = await runtime(t), socket = FakeWebSocket.instances.at(-1);
  const result = client.api.multiplayer.performOperations([{ type: 'chat.append', payload: { text: 'Bounded' } }],
    { requestedOperationId: 'bounded-chat' });
  const rejected = assert.rejects(result, { code: 'revision_conflict' });
  for (let revision = 5; revision <= 8; revision++) await socket.receive(revisionDenial('bounded-chat', revision, client.state));
  await rejected;
  assert.deepEqual(documentRequests(socket).map(message => [message.operationId, message.baseRevision]),
    [['bounded-chat', 4], ['bounded-chat', 5], ['bounded-chat', 6], ['bounded-chat', 7]]);
  assert.equal(client.api.multiplayer.getStatus().pendingOperationCount, 0);
});

for (const code of ['status_target_not_controlled', 'status_definition_not_found', 'entity_conflict', 'persist_failed']) {
  test(`a retried Status intent still fails immediately on ${code}`, async t => {
    const client = await runtime(t), socket = FakeWebSocket.instances.at(-1);
    const result = client.api.multiplayer.performStatusOperation('status.apply', {
      operationId: 'denied-status', scope: 'actor', targetId: 'actor', definitionId: 'ordinary',
    });
    const rejected = assert.rejects(result, { code });
    await socket.receive(revisionDenial('denied-status', 5, client.state));
    await socket.receive({ type: 'document.batch.denied', operationId: 'denied-status', revision: 5, code });
    await rejected;
    assert.equal(documentRequests(socket).length, 2);
    assert.equal(client.api.multiplayer.getStatus().pendingOperationCount, 0);
  });
}

for (const operations of [
  [{ type: 'status.setStacks', payload: { scope: 'actor', targetId: 'actor', definitionId: 'ordinary', stacks: 2 } }],
  [{ type: 'status.definition.delete', payload: { definitionId: 'ordinary' } }],
  [{ type: 'token.move', payload: { sceneId: 'scene', tokenId: 'scout', x: 50, y: 20 } }],
  [{ type: 'chat.append', payload: { text: 'Mixed' } }, { type: 'chat.clear', payload: {} }],
  [{ type: 'actor.upsert', payload: { actor: { id: 'actor', name: 'Replacement' } } }],
]) test(`absolute, movement or mixed ${operations.at(-1).type} intents never automatically retry`, async t => {
  const client = await runtime(t), socket = FakeWebSocket.instances.at(-1);
  const result = client.api.multiplayer.performOperations(operations, { requestedOperationId: 'unsafe-retry' });
  const rejected = assert.rejects(result, { code: 'revision_conflict' });
  await socket.receive(revisionDenial('unsafe-retry', 5, client.state)); await rejected;
  assert.equal(documentRequests(socket).length, 1);
});

test('conditional direct document writes preserve their precondition and are not automatically retried', async t => {
  const client = await runtime(t), socket = FakeWebSocket.instances.at(-1);
  const writes = [{ action: 'update', document: { type: 'Status', id: 'actor', parent: null }, intent: 'status.remove',
    data: { scope: 'actor', targetId: 'actor', definitionId: 'ordinary' }, precondition: { expectedEffects: [] } }];
  const result = client.api.multiplayer.performDocumentBatch(writes, { requestedOperationId: 'conditional-status' });
  const rejected = assert.rejects(result, { code: 'revision_conflict' });
  await socket.receive(revisionDenial('conditional-status', 5, client.state)); await rejected;
  assert.equal(documentRequests(socket).length, 1);
  assert.deepEqual(documentRequests(socket)[0].writes, writes);
});

for (const change of ['world', 'scene']) test(`a Status conflict cannot carry an old intention into a changed ${change}`, async t => {
  const client = await runtime(t), socket = FakeWebSocket.instances.at(-1);
  const result = client.api.multiplayer.performStatusOperation('status.remove', {
    operationId: 'old-status', scope: 'actor', targetId: 'actor', definitionId: 'ordinary',
  });
  const rejected = assert.rejects(result, { code: change === 'world' ? 'operation_rebase_failed' : 'status_rebase_failed' });
  const latest = structuredClone(client.state);
  if (change === 'world') latest.preferences.worldV2.id = 'other-world';
  else latest.preferences.worldV2.activeSceneId = 'other-scene';
  await socket.receive(revisionDenial('old-status', 5, latest)); await rejected;
  assert.equal(documentRequests(socket).length, 1);
});

test('disconnect while a conflict snapshot imports cancels the intent without resending', async t => {
  const client = await runtime(t), socket = FakeWebSocket.instances.at(-1);
  const result = client.api.multiplayer.performOperations([{ type: 'chat.append', payload: { text: 'Cancelled' } }],
    { requestedOperationId: 'cancelled-retry' });
  const rejected = assert.rejects(result, { code: 'operation_cancelled' });
  let completeImport;
  client.api.importState = () => new Promise(resolve => { completeImport = resolve; });
  await socket.receive(revisionDenial('cancelled-retry', 5, client.state));
  assert.equal(typeof completeImport, 'function');
  client.api.multiplayer.disconnect(); completeImport(); await settle(); await rejected;
  assert.equal(documentRequests(socket).length, 1);
});
