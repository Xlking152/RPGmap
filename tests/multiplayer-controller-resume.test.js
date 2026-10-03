import test from 'node:test';
import assert from 'node:assert/strict';
import { createMultiplayerController } from '../src/multiplayer/controller.js';
import { applyDocumentChanges, createDocumentChanges } from '../src/documents/changes.js';
import { WORLD_OPERATION_SCHEMA_VERSION } from '../src/world/operations.js';
import { STATUS_SCHEMA_VERSION } from '../src/status/model.js';
import { ACCESS_SCHEMA_VERSION } from '../src/permissions/model.js';

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

async function runtime(t) {
  const originalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = FakeWebSocket; FakeWebSocket.instances = [];
  let state = projectedState(), timerId = 0;
  const timers = new Map(), storage = new Map([['rpgmap:multiplayer:visionSourceTokenId', 'scout']]);
  const view = { location: { protocol: 'http:', host: '127.0.0.1:30000', hostname: '127.0.0.1' },
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
  const api = {
    map: { getContainer: () => map }, mapPackage: { id: 'map' },
    getState: () => structuredClone(state), exportState: () => structuredClone(state),
    world: { get: () => structuredClone(state.preferences.worldV2) },
    tokens: { get: id => state.preferences.worldV2.scenes[0].tokens.find(token => token.id === id) || null },
    async importState(next, persist) { state = structuredClone(next); imports.push({ state, persist }); },
    applyAuthoritativeDocumentChanges(changes, options) {
      state = applyDocumentChanges(state, changes, { updatedAt: options.updatedAt }); documentCommits.push(options);
    },
    on(type, listener) { listeners.set(type, [...(listeners.get(type) || []), listener]); },
    emit(type, detail) { events.push({ type, detail }); for (const listener of listeners.get(type) || []) listener(detail); },
  };
  createMultiplayerController().register(api);
  t.after(() => { api.emit('app:destroy'); globalThis.WebSocket = originalWebSocket; });
  api.multiplayer.connect({ name: 'Player', requestedRole: 'player', playerKey: 'claim', joinCode: 'join' });
  const first = FakeWebSocket.instances.at(-1); first.open(); await first.receive(welcome(state, 4));
  events.length = 0;
  return { api, imports, documentCommits, events, get state() { return state; },
    reconnect() {
      FakeWebSocket.instances.at(-1).close();
      assert.equal(api.multiplayer.getStatus().connected, false);
      const [id, callback] = timers.entries().next().value; timers.delete(id); callback();
      const socket = FakeWebSocket.instances.at(-1); socket.open(); return socket;
    } };
}

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
