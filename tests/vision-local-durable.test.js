import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialRuntimeState, validateRuntimeState, exportRuntimeState } from '../src/engine/runtime-state.js';
import { createWorldV2FromRuntimeState, projectWorldV2ToRuntimeState } from '../src/world/model.js';
import { createWorldStatePersistence, createRemoteWorldIsolation } from '../src/app/world-storage.js';
import { createWorldSystem } from '../src/world/system.js';
import { computeFogExploration } from '../src/vision/fog.js';
import { createLocalExplorationQueue } from '../src/vision/local-exploration.js';
import { infiniteHorrorRuleset as ruleset } from '../src/rulesets/infinite-horror/index.js';

const mapPackage = { id: 'durable-map', version: '1', width: 100, height: 100, metersPerUnit: 1, features: [] };
function seed() {
  const initial = createInitialRuntimeState(mapPackage, { ruleset });
  initial.preferences.entitySystem.actors = [{ id: 'actor', name: 'Scout', partyId: 'party', currentFormId: 'form',
    forms: [{ id: 'form', tokenAppearance: { color: '#3d9b63' }, avatarDataUrl: null }], runtime: {}, effects: [] }];
  initial.preferences.entitySystem.tokens = [{ id: 'scout', actorId: 'actor', placement: 'map', x: 10, y: 10,
    diameterMeters: 1, elevationMeters: 0, effects: [],
    vision: { enabled: true, preciseRangeOverrideMeters: 20, vagueRangeOverrideMeters: 20 } }];
  const world = createWorldV2FromRuntimeState(initial, { mapPackage, ruleset });
  return validateRuntimeState(projectWorldV2ToRuntimeState(initial, world, { mapPackage, ruleset }), { mapPackage, ruleset });
}
function runtime(storage) {
  let state = seed();
  const handlers = new Map();
  const persistence = createWorldStatePersistence({ mapPackage, ruleset,
    storageAdapter: { get: key => storage.get(key), set: (key, value) => storage.set(key, value) }, getState: () => state });
  state = persistence.load().state;
  // Restore the fixture seed on first start; production bootstrap supplies its own canonical World.
  if (!state.preferences.worldV2.actors.length) state = seed();
  const api = { mapPackage, ruleset, getState: () => structuredClone(state),
    commitState(value) { state = structuredClone(value); },
    persistNow: () => persistence.persistNow(),
    getLocalExploration: () => persistence.getLocalExploration(),
    setLocalExploration: value => persistence.setLocalExploration(value),
    setLocalExplorationSnapshot: value => persistence.setLocalExplorationSnapshot(value),
    vision: { getSource: () => 'scout', getVisibleRegion: () => ({ vagueRangeMeters: 20, rangeMeters: 20 }) },
    on(name, callback) { const list = handlers.get(name) || []; list.push(callback); handlers.set(name, list); },
    emit(name, detail) { for (const callback of handlers.get(name) || []) callback({ detail }); } };
  const isolation = createRemoteWorldIsolation({ persistence, getState: () => state,
    restoreState: value => { state = value; } });
  api.isLocalWorldActive = () => !isolation.active;
  api.on('multiplayer:capabilities', () => {
    if (isolation.updateConnection(api.multiplayer?.getStatus?.()))
      api.emit('state:import', { source: 'offline:resume', persist: false });
  });
  createWorldSystem().register(api);
  return { api, persistence, state: () => state, replaceState(value) { state = structuredClone(value); } };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('durable exploration did not finish');
}

test('offline confirmed route and durable queue share one save, and refresh resumes every segment', async () => {
  const original = globalThis.Worker, requests = [];
  globalThis.Worker = class { postMessage(message) { requests.push({ worker: this, message }); } terminate() {} };
  try {
    const storage = new Map(), first = runtime(storage);
    const sceneId = first.api.world.getActiveScene().id;
    await first.api.world.performOperations([{ type: 'token.movePath', payload: { sceneId, tokenId: 'scout', tokenIds: ['scout'],
      expectedOrigins: { scout: { x: 10, y: 10, elevationMeters: 0 } }, waypoints: [{ x: 20, y: 10 }, { x: 20, y: 30 }] } }]);
    const saved = JSON.parse(storage.get(first.persistence.storageKey));
    assert.equal(saved.preferences.worldV2.scenes[0].tokens[0].y, 30);
    assert.equal(saved._localExploration.jobs.length, 2);
    assert.deepEqual(saved._localExploration.jobs.map(job => [job.input.payload.from.x, job.input.payload.from.y,
      job.input.payload.to.x, job.input.payload.to.y]), [[10, 10, 20, 10], [20, 10, 20, 30]]);
    assert.equal(first.state()._localExploration, undefined);
    assert.equal(exportRuntimeState(first.state(), { mapPackage, ruleset })._localExploration, undefined);
    first.api.emit('app:destroy');
    const second = runtime(storage); await tick();
    assert.equal(second.api.world.getExplorationStatus().queued, 2);
    for (let index = 0; index < 2; index++) {
      const request = requests.at(-1);
      request.worker.onmessage({ data: { id: request.message.id, result: computeFogExploration(request.message.input) } });
      await until(() => index === 0 ? requests.at(-1) !== request : !second.api.world.getExplorationStatus().running);
    }
    assert.equal(second.api.world.getExplorationStatus().queued, 0);
    assert.ok(Object.keys(second.api.world.getActiveScene().fog.exploredByParty.party.rows).length);
    assert.equal(JSON.parse(storage.get(second.persistence.storageKey))._localExploration.jobs.length, 0);
    second.api.emit('app:destroy');
  } finally { globalThis.Worker = original; }
});

test('LAN snapshots and temporary disconnects retain offline paths until explicit exit restores their World', async () => {
  const original = globalThis.Worker, requests = [];
  globalThis.Worker = class { postMessage(message) { requests.push({ worker: this, message }); } terminate() {} };
  try {
    const storage = new Map(), local = runtime(storage), { api, persistence } = local;
    const sceneId = api.world.getActiveScene().id;
    await api.world.performOperations([{ type: 'token.move', payload: { sceneId, tokenId: 'scout', x: 20, y: 10 } }]);
    await tick();
    const before = storage.get(persistence.storageKey), offline = structuredClone(local.state());
    let connection = { connected: true, retainsServerState: true };
    api.multiplayer = { getStatus: () => connection };
    api.emit('multiplayer:capabilities', connection);
    const projection = seed();
    projection.preferences.worldV2.name = 'Private LAN projection';
    projection.preferences.worldV2.actors = [];
    projection.preferences.worldV2.scenes[0].tokens = [];
    local.replaceState(projection);
    api.emit('state:import', { source: 'server', persist: false });
    assert.equal(api.world.getExplorationStatus().queued, 1);
    assert.equal(api.persistNow(), false);
    assert.equal(storage.get(persistence.storageKey), before);
    requests[0].worker.onmessage({ data: { id: requests[0].message.id,
      result: computeFogExploration(requests[0].message.input) } });
    await until(() => !api.world.getExplorationStatus().running);
    connection = { connected: false, retainsServerState: true };
    api.emit('multiplayer:capabilities', connection); await tick();
    assert.deepEqual(local.state(), projection, 'a temporary disconnect discarded the delta-resume baseline');
    assert.equal(requests.length, 1, 'temporary reconnect restarted offline exploration against a LAN projection');
    await assert.rejects(api.world.performOperations([{ type: 'scene.fog.reset', payload: { sceneId, partyId: 'party' } }]),
      { code: 'world_reconnect_pending' });
    connection = { connected: true, retainsServerState: true };
    api.emit('multiplayer:capabilities', connection);
    api.emit('state:import', { source: 'server', persist: false });
    assert.equal(api.world.getExplorationStatus().queued, 1);
    connection = { connected: false, retainsServerState: false };
    api.emit('multiplayer:capabilities', connection);
    await until(() => requests.length === 2);
    assert.deepEqual(local.state(), offline, 'offline World was not restored before its queue restarted');
    requests[1].worker.onmessage({ data: { id: requests[1].message.id,
      // The same Worker retains the original geometry when the retried input
      // carries only its unchanged context version.
      result: computeFogExploration(requests[0].message.input) } });
    await until(() => !api.world.getExplorationStatus().running);
    const saved = JSON.parse(storage.get(persistence.storageKey));
    assert.equal(saved.preferences.worldV2.name, offline.preferences.worldV2.name);
    assert.equal(saved.preferences.worldV2.scenes[0].tokens[0].x, 20);
    assert.equal(saved._localExploration.jobs.length, 0);
    assert.ok(Object.keys(saved.preferences.worldV2.scenes[0].fog.exploredByParty.party.rows).length);
    api.emit('app:destroy');
  } finally { globalThis.Worker = original; }
});

test('a real offline user import still cancels retained jobs and ignores late results', async () => {
  const original = globalThis.Worker; let request;
  globalThis.Worker = class { postMessage(message) { request = { worker: this, message }; } terminate() {} };
  try {
    const storage = new Map(), local = runtime(storage), { api, persistence } = local;
    const sceneId = api.world.getActiveScene().id;
    await api.world.performOperations([{ type: 'token.move', payload: { sceneId, tokenId: 'scout', x: 20, y: 10 } }]);
    await tick(); const late = request;
    const imported = seed(); local.replaceState(imported);
    api.emit('state:import', { source: 'file-import', persist: true });
    assert.equal(api.persistNow(), true);
    late.worker.onmessage({ data: { id: late.message.id, result: computeFogExploration(late.message.input) } });
    await tick();
    assert.equal(api.world.getExplorationStatus().queued, 0);
    assert.equal(JSON.parse(storage.get(persistence.storageKey))._localExploration.jobs.length, 0);
    assert.deepEqual(local.state(), imported);
    api.emit('app:destroy');
  } finally { globalThis.Worker = original; }
});

test('Fog reset atomically cancels durable jobs and a late result cannot refill it', async () => {
  const original = globalThis.Worker; let request;
  globalThis.Worker = class { postMessage(message) { request = { worker: this, message }; } terminate() {} };
  try {
    const storage = new Map(), { api, persistence } = runtime(storage);
    const sceneId = api.world.getActiveScene().id;
    await api.world.performOperations([{ type: 'scene.fog.explore', payload: { sceneId, partyId: 'party', x: 10, y: 10, radiusMeters: 20 } }],
      { source: 'vision:explore' }); await tick();
    const late = request;
    await api.world.performOperations([{ type: 'scene.fog.reset', payload: { sceneId, partyId: 'party' } }]);
    late.worker.onmessage({ data: { id: late.message.id, result: computeFogExploration(late.message.input) } });
    await tick();
    assert.equal(api.world.getActiveScene().fog.exploredByParty.party, undefined);
    const saved = JSON.parse(storage.get(persistence.storageKey));
    assert.equal(saved._localExploration.jobs.length, 0);
    assert.equal(saved.preferences.worldV2.scenes[0].fog.exploredByParty.party, undefined);
    api.emit('app:destroy');
  } finally { globalThis.Worker = original; }
});

test('reset during the commit-await window cannot resurrect a removed durable job after a write failure', async () => {
  const original = globalThis.Worker;
  globalThis.Worker = undefined;
  let metadata = null, rejectCommit;
  const api = { setLocalExploration: value => { metadata = structuredClone(value); }, persistNow: () => true };
  const queue = createLocalExplorationQueue(api, () => new Promise((_resolve, reject) => { rejectCommit = reject; }));
  try {
    queue.enqueue({ partyId: 'party', map: mapPackage, lineOfSightEnabled: false,
      payload: { x: 10, y: 10, radiusMeters: 10 } }, 'scene');
    queue.persist(); queue.start();
    await until(() => Boolean(rejectCommit));
    assert.equal(queue.stats().queued, 0);
    queue.cancel('scene', 'party'); queue.persist();
    rejectCommit(new Error('import or storage cancelled commit'));
    await until(() => !queue.stats().running);
    assert.equal(queue.stats().queued, 0);
    assert.equal(metadata.jobs.length, 0);
  } finally { queue.dispose(); globalThis.Worker = original; }
});

test('direct map moves retain every accepted leg and reposition explores only its endpoint', async () => {
  const original = globalThis.Worker;
  globalThis.Worker = class { postMessage() {} terminate() {} };
  try {
    const storage = new Map(), { api, persistence } = runtime(storage);
    const sceneId = api.world.getActiveScene().id;
    await api.world.performOperations([
      { type: 'token.move', payload: { sceneId, tokenId: 'scout', x: 20, y: 10 } },
      { type: 'token.move', payload: { sceneId, tokenId: 'scout', x: 20, y: 30 } },
    ]);
    let saved = JSON.parse(storage.get(persistence.storageKey));
    assert.deepEqual(saved._localExploration.jobs.map(job => [job.input.payload.from.x, job.input.payload.from.y,
      job.input.payload.to.x, job.input.payload.to.y]), [[10, 10, 20, 10], [20, 10, 20, 30]]);
    await api.world.performOperations([{ type: 'token.reposition', payload: { sceneId, tokenId: 'scout', x: 80, y: 80 } }]);
    saved = JSON.parse(storage.get(persistence.storageKey));
    assert.equal(saved._localExploration.jobs.length, 3);
    const endpoint = saved._localExploration.jobs.at(-1).input.payload;
    assert.equal(endpoint.from, undefined); assert.equal(endpoint.to, undefined);
    assert.equal(endpoint.x, 80); assert.equal(endpoint.y, 80);
    assert.equal(saved.preferences.worldV2.scenes[0].tokens[0].x, 80);
    api.emit('app:destroy');
  } finally { globalThis.Worker = original; }
});

test('a reset in an accepted batch discards preceding routes and retains movement after the reset', async () => {
  const original = globalThis.Worker;
  globalThis.Worker = class { postMessage() {} terminate() {} };
  try {
    const storage = new Map(), { api, persistence } = runtime(storage);
    const sceneId = api.world.getActiveScene().id;
    await api.world.performOperations([
      { type: 'token.move', payload: { sceneId, tokenId: 'scout', x: 20, y: 10 } },
      { type: 'scene.fog.reset', payload: { sceneId, partyId: 'party' } },
      { type: 'token.move', payload: { sceneId, tokenId: 'scout', x: 30, y: 10 } },
    ]);
    const saved = JSON.parse(storage.get(persistence.storageKey));
    assert.equal(saved._localExploration.jobs.length, 1);
    assert.equal(saved._localExploration.jobs[0].input.payload.from.x, 20);
    assert.equal(saved._localExploration.jobs[0].input.payload.to.x, 30);
    api.emit('app:destroy');
  } finally { globalThis.Worker = original; }
});

test('editing a map Token altitude explores its new endpoint with the full sphere range', async () => {
  const original = globalThis.Worker;
  globalThis.Worker = class { postMessage() {} terminate() {} };
  try {
    const storage = new Map(), { api, persistence } = runtime(storage);
    const scene = api.world.getActiveScene();
    const token = { ...scene.tokens[0], elevationMeters: 12 };
    await api.world.performOperations([{ type: 'token.upsert', payload: { sceneId: scene.id, token } }]);
    const saved = JSON.parse(storage.get(persistence.storageKey)), input = saved._localExploration.jobs[0].input;
    assert.equal(saved._localExploration.jobs.length, 1);
    assert.equal(input.payload.from, undefined);
    assert.equal(input.payload.x, 10); assert.equal(input.payload.elevationMeters, 12);
    assert.equal(input.sourceRangeMeters, 20);
    api.emit('app:destroy');
  } finally { globalThis.Worker = original; }
});

test('rejected Fog and Scene resets leave confirmed jobs intact; accepted Scene reset cancels them', async () => {
  const original = globalThis.Worker; let request;
  globalThis.Worker = class { postMessage(message) { request = { worker: this, message }; } terminate() {} };
  try {
    const storage = new Map(), { api, persistence } = runtime(storage);
    const sceneId = api.world.getActiveScene().id;
    await api.world.performOperations([{ type: 'token.move', payload: { sceneId, tokenId: 'scout', x: 20, y: 10 } }]);
    const late = request, acceptedSave = storage.get(persistence.storageKey);
    await assert.rejects(api.world.performOperations([{ type: 'scene.fog.reset', payload: { sceneId, partyId: '' } }]));
    await assert.rejects(api.world.performOperations([{ type: 'scene.reset', payload: { sceneId: 'missing' } }]));
    assert.equal(api.world.getExplorationStatus().queued, 1);
    assert.equal(storage.get(persistence.storageKey), acceptedSave);
    await api.world.performOperations([{ type: 'scene.reset', payload: { sceneId } }]);
    late.worker.onmessage({ data: { id: late.message.id, result: computeFogExploration(late.message.input) } });
    await tick();
    const saved = JSON.parse(storage.get(persistence.storageKey));
    assert.equal(saved.preferences.worldV2.scenes[0].tokens.length, 0);
    assert.equal(saved._localExploration.jobs.length, 0);
    assert.equal(api.world.getActiveScene().fog.exploredByParty.party, undefined);
    api.emit('app:destroy');
  } finally { globalThis.Worker = original; }
});

test('deleting an inactive Scene cancels its durable work and late results cannot stall the queue', async () => {
  const original = globalThis.Worker; let request;
  globalThis.Worker = class { postMessage(message) { request = { worker: this, message }; } terminate() {} };
  try {
    const storage = new Map(), { api, persistence } = runtime(storage);
    const sceneId = api.world.getActiveScene().id;
    await api.world.performOperations([{ type: 'token.move', payload: { sceneId, tokenId: 'scout', x: 20, y: 10 } }]);
    const late = request;
    await assert.rejects(api.world.performOperations([{ type: 'scene.delete', payload: { sceneId } }]),
      { code: 'scene_active_delete_forbidden' });
    assert.equal(api.world.getExplorationStatus().queued, 1);
    const other = await api.world.createScene({ id: 'other', name: 'Other' });
    await api.world.setActiveScene(other.id);
    assert.equal(api.world.getExplorationStatus().queued, 1);
    await api.world.performOperations([{ type: 'scene.delete', payload: { sceneId } }]);
    late.worker.onmessage({ data: { id: late.message.id, result: computeFogExploration(late.message.input) } });
    await until(() => !api.world.getExplorationStatus().running);
    assert.equal(api.world.getExplorationStatus().queued, 0);
    const saved = JSON.parse(storage.get(persistence.storageKey));
    assert.equal(saved._localExploration.jobs.length, 0);
    assert.equal(saved.preferences.worldV2.scenes.some(scene => scene.id === sceneId), false);
    api.emit('app:destroy');
  } finally { globalThis.Worker = original; }
});

test('a failed reset save preserves the previous World and its matching durable jobs for restart', async () => {
  const original = globalThis.Worker;
  globalThis.Worker = class { postMessage() {} terminate() {} };
  class FaultyStorage extends Map {
    set(key, value) { if (this.failWrites) throw new Error('disk full'); return super.set(key, value); }
  }
  try {
    const storage = new FaultyStorage(), first = runtime(storage);
    const sceneId = first.api.world.getActiveScene().id;
    await first.api.world.performOperations([{ type: 'token.move', payload: { sceneId, tokenId: 'scout', x: 20, y: 10 } }]);
    const acceptedSave = storage.get(first.persistence.storageKey);
    storage.failWrites = true;
    await assert.rejects(first.api.world.performOperations([{ type: 'scene.fog.reset', payload: { sceneId, partyId: 'party' } }]));
    assert.equal(first.persistence.blocked, true);
    assert.equal(storage.get(first.persistence.storageKey), acceptedSave);
    first.api.emit('app:destroy'); storage.failWrites = false;
    const second = runtime(storage);
    assert.equal(second.api.world.getActiveScene().tokens[0].x, 20);
    assert.equal(second.api.world.getExplorationStatus().queued, 1);
    second.api.emit('app:destroy');
  } finally { globalThis.Worker = original; }
});

test('restored geometry cannot collide with a new session revision while new jobs reuse one context', async () => {
  const original = globalThis.Worker, requests = [];
  globalThis.Worker = class { postMessage(message) { requests.push({ worker: this, message }); } terminate() {} };
  const oldInput = { partyId: 'party', map: mapPackage, occluders: [{ id: 'old-wall' }],
    lineOfSightEnabled: true, payload: { x: 10, y: 10, radiusMeters: 5 }, contextVersion: 'local:old-session:1' };
  let metadata = { schemaVersion: 1, jobs: [{ id: 'old-session:1', sceneId: 'scene', input: oldInput }] };
  const api = { getLocalExploration: () => structuredClone(metadata),
    setLocalExploration: value => { metadata = structuredClone(value); }, persistNow: () => true };
  const queue = createLocalExplorationQueue(api, async () => {});
  try {
    const input = { ...oldInput, occluders: [{ id: 'new-wall' }], contextVersion: 1 };
    queue.enqueue(input, 'scene'); queue.enqueue(input, 'scene'); queue.persist(); queue.start();
    for (let index = 0; index < 3; index++) {
      await until(() => requests.length === index + 1);
      const request = requests[index];
      request.worker.onmessage({ data: { id: request.message.id, result: {} } });
    }
    await until(() => !queue.stats().running);
    assert.deepEqual(requests[0].message.input.occluders, [{ id: 'old-wall' }]);
    assert.deepEqual(requests[1].message.input.occluders, [{ id: 'new-wall' }]);
    assert.notEqual(requests[0].message.input.contextVersion, requests[1].message.input.contextVersion);
    assert.equal(requests[1].message.input.contextVersion, requests[2].message.input.contextVersion);
    assert.equal(requests[2].message.input.occluders, undefined);
    assert.equal(requests[2].message.input.map, undefined);
    assert.equal(queue.stats().queued, 0);
  } finally { queue.dispose(); globalThis.Worker = original; }
});
