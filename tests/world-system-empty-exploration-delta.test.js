import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorldSystem } from '../src/world/system.js';
import { registeredInfiniteHorrorRuleset } from '../src/ruleset/index.js';
import { exportRuntimeState } from '../src/engine/runtime-state.js';
import { applyDocumentChanges } from '../src/documents/changes.js';
import { registerRuntimeStateReader } from '../src/engine/state-access.js';
import { copyMap, worldCopyInput } from './fixtures/world-copy-inputs.js';

const clone = structuredClone;
const emptyDelta = () => ({ schemaVersion: 1, cellSizeMeters: 5,
  exploredByParty: { party: { rows: {} } } });
const job = () => ({ id: 'confirmed-path', sceneId: 'scene-a', input: { partyId: 'party',
  payload: { x: 10, y: 20, radiusMeters: 20, visionSourceTokenId: 'token-a' },
  lineOfSightEnabled: true, occluders: [], map: { width: 200, height: 200, metersPerUnit: 1 } } });
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) {
  for (let attempt = 0; attempt < 30; attempt++) { if (predicate()) return; await tick(); }
  assert.fail('local exploration did not reach the expected save boundary');
}

function fixture({ jobs = [job()], ruleset = registeredInfiniteHorrorRuleset, localActive = true } = {}) {
  let current = worldCopyInput().state, revision = 0, metadata = { schemaVersion: 1, jobs: clone(jobs) };
  let durableMetadata = clone(metadata), renders = 0, fullValidations = 0;
  const handlers = new Map(), requests = [], pending = [], saveCalls = [], toasts = [];
  const originalWorker = globalThis.Worker;
  globalThis.Worker = class {
    postMessage(message) { if (message.input) requests.push({ worker: this, message: clone(message) }); }
    terminate() {}
  };
  const validateAndStore = () => {
    exportRuntimeState(current, { mapPackage: copyMap, ruleset });
    fullValidations++; durableMetadata = clone(metadata);
  };
  const api = {
    mapPackage: copyMap, ruleset, getState: () => clone(current), getStateRevision: () => revision,
    isLocalWorldActive: () => localActive,
    commitState(next) { current = next; revision++; },
    applyAuthoritativeDocumentChanges(changes, options) {
      current = applyDocumentChanges(current, changes, { updatedAt: options.updatedAt });
      revision++; renders++;
    },
    getLocalExploration: () => clone(metadata), setLocalExploration(next) { metadata = clone(next); },
    persistNow(options) {
      saveCalls.push(['sync', options]);
      if (options?.trustedWorldRevision == null) validateAndStore();
      else durableMetadata = clone(metadata);
      return true;
    },
    persistValidatedAsync() {
      saveCalls.push(['full']);
      return new Promise((resolve, reject) => pending.push({
        resolve(value = true) {
          if (value !== false) {
            try { validateAndStore(); } catch (error) { reject(error); return; }
          }
          resolve(value);
        }, reject,
      }));
    },
    on(name, callback) { const callbacks = handlers.get(name) || []; callbacks.push(callback); handlers.set(name, callbacks); },
    emit() {}, showToast(message) { toasts.push(message); },
  };
  registerRuntimeStateReader(api, () => current);
  createWorldSystem().register(api);
  return { api, requests, pending, saveCalls, toasts, current: () => current, revision: () => revision,
    renders: () => renders, metadata: () => metadata, durableMetadata: () => durableMetadata,
    fullValidations: () => fullValidations,
    async respond(result = emptyDelta()) {
      await until(() => requests.length);
      const request = requests.shift();
      request.worker.onmessage({ data: { id: request.message.id, result: clone(result) } });
    },
    dispose() { for (const callback of handlers.get('app:destroy') || []) callback(); globalThis.Worker = originalWorker; },
  };
}

test('empty delta waits for complete validation and stores queue progress without changing World revision or render', async () => {
  const f = fixture(), before = f.current(), snapshot = clone(before), revision = f.revision();
  try {
    await f.respond(); await until(() => f.pending.length === 1);
    assert.deepEqual(f.saveCalls, [['full']]);
    assert.equal(f.api.world.getExplorationStatus().running, true);
    assert.equal(f.metadata().jobs.length, 0);
    assert.equal(f.durableMetadata().jobs.length, 1, 'removal is not durable before full save completes');
    assert.equal(f.current(), before); assert.deepEqual(f.current(), snapshot);
    assert.equal(f.revision(), revision); assert.equal(f.renders(), 0);
    f.pending.shift().resolve(); await until(() => !f.api.world.getExplorationStatus().running);
    assert.equal(f.durableMetadata().jobs.length, 0); assert.equal(f.fullValidations(), 1);
    assert.equal(f.current(), before); assert.equal(f.revision(), revision); assert.equal(f.renders(), 0);
  } finally { f.dispose(); }
});

for (const failure of ['false', 'throw']) {
  test(`empty delta ${failure} save failure restores the confirmed task and pauses processing`, async () => {
    const f = fixture(), before = f.current(), revision = f.revision();
    try {
      await f.respond(); await until(() => f.pending.length === 1);
      const save = f.pending.shift();
      if (failure === 'false') save.resolve(false); else save.reject(new Error('validation or storage failed'));
      await until(() => !f.api.world.getExplorationStatus().running);
      assert.deepEqual(f.metadata().jobs, [job()]); assert.deepEqual(f.durableMetadata().jobs, [job()]);
      assert.equal(f.current(), before); assert.equal(f.revision(), revision); assert.equal(f.renders(), 0);
      assert.equal(f.toasts.length, 1); assert.match(f.toasts[0], failure === 'false' ? /可靠保存/ : /validation or storage failed/);
      assert.deepEqual(f.saveCalls, [['full']]);
    } finally { f.dispose(); }
  });
}

test('empty delta uses a complete synchronous save without a trusted revision when async persistence is unavailable', async () => {
  const f = fixture(), before = f.current(), revision = f.revision();
  delete f.api.persistValidatedAsync;
  try {
    await f.respond(); await until(() => !f.api.world.getExplorationStatus().running);
    assert.deepEqual(f.saveCalls, [['sync', undefined]]); assert.equal(f.fullValidations(), 1);
    assert.equal(f.durableMetadata().jobs.length, 0);
    assert.equal(f.current(), before); assert.equal(f.revision(), revision); assert.equal(f.renders(), 0);
  } finally { f.dispose(); }
});

test('empty delta synchronous save failure or missing persistence restores the confirmed task', async () => {
  for (const failure of ['false', 'throw', 'missing']) {
    const f = fixture(); delete f.api.persistValidatedAsync;
    f.api.persistNow = failure === 'missing' ? undefined : () => {
      if (failure === 'throw') throw new Error('synchronous store failed');
      return false;
    };
    try {
      await f.respond(); await until(() => !f.api.world.getExplorationStatus().running);
      assert.deepEqual(f.metadata().jobs, [job()]); assert.deepEqual(f.durableMetadata().jobs, [job()]);
      assert.equal(f.renders(), 0); assert.equal(f.toasts.length, 1);
    } finally { f.dispose(); }
  }
});

test('local-world suspension is checked before empty delta validation and persistence', async () => {
  const f = fixture({ localActive: false });
  try {
    await f.respond(); await until(() => !f.api.world.getExplorationStatus().running);
    assert.deepEqual(f.metadata().jobs, [job()]); assert.deepEqual(f.saveCalls, []);
    assert.equal(f.renders(), 0); assert.match(f.toasts[0], /联机续传/);
  } finally { f.dispose(); }
});

test('public complete empty exploration results still use the original authority operation and trusted Fog save', async () => {
  const f = fixture({ jobs: [] }), revision = f.revision();
  try {
    const input = job().input;
    await f.api.world.performOperations([{ type: 'scene.fog.explore', payload: {
      ...input.payload, sceneId: 'scene-a', partyId: input.partyId,
    } }], { addedExploration: emptyDelta() });
    assert.equal(f.revision(), revision + 1); assert.equal(f.renders(), 1);
    assert.deepEqual(f.saveCalls, [['sync', { trustedWorldRevision: f.revision() }]]);
  } finally { f.dispose(); }
});

test('noncanonical empty shapes and nonempty deltas continue through the original Fog authority', async () => {
  const samples = [
    { ...emptyDelta(), schemaVersion: 2 }, { ...emptyDelta(), cellSizeMeters: 10 },
    { ...emptyDelta(), extra: 'preserved' },
    { ...emptyDelta(), exploredByParty: { other: { rows: {} } } },
    { ...emptyDelta(), exploredByParty: { party: { rows: {} }, other: { rows: {} } } },
    { ...emptyDelta(), exploredByParty: { party: { rows: {}, extension: {} } } },
    { ...emptyDelta(), exploredByParty: { party: null } },
    { ...emptyDelta(), exploredByParty: { party: { rows: [] } } },
    { ...emptyDelta(), exploredByParty: { party: { rows: { 0: [] } } } },
    { ...emptyDelta(), exploredByParty: { party: { rows: { 0: [[0, 1]] } } } },
  ];
  for (const result of samples) {
    const f = fixture(), revision = f.revision();
    try {
      await f.respond(result); await until(() => !f.api.world.getExplorationStatus().running);
      if (result.exploredByParty.party === null) {
        assert.equal(f.revision(), revision, 'original null-record normalization failure remains atomic');
        assert.equal(f.renders(), 0); assert.deepEqual(f.saveCalls, []);
        assert.deepEqual(f.metadata().jobs, [job()]); assert.equal(f.toasts.length, 1);
      } else {
        assert.equal(f.revision(), revision + 1, JSON.stringify(result)); assert.equal(f.renders(), 1);
        assert.deepEqual(f.saveCalls, [['sync', { trustedWorldRevision: f.revision() }]]);
      }
    } finally { f.dispose(); }
  }
});

test('invalid recovered jobs retain the original Fog preparation errors even when their derived result is empty', async () => {
  for (const invalid of [
    { ...job(), sceneId: 'missing-scene' },
    { ...job(), input: { ...job().input, payload: { ...job().input.payload, radiusMeters: Infinity } } },
    { ...job(), input: { ...job().input, payload: { ...job().input.payload, x: NaN } } },
  ]) {
    const f = fixture({ jobs: [invalid] }), before = f.current(), revision = f.revision();
    try {
      await f.respond(); await until(() => !f.api.world.getExplorationStatus().running);
      assert.deepEqual(f.metadata().jobs, [invalid]); assert.deepEqual(f.saveCalls, []);
      assert.equal(f.current(), before); assert.equal(f.revision(), revision); assert.equal(f.renders(), 0);
      assert.equal(f.toasts.length, 1); assert.match(f.toasts[0], /Scene|scene|finite/);
    } finally { f.dispose(); }
  }
});

test('an empty delta full save captures the latest metadata when another confirmed move arrives during validation', async () => {
  const f = fixture();
  try {
    await f.respond(); await until(() => f.pending.length === 1);
    const save = f.pending.shift();
    f.api.vision = { getSource: () => 'token-a' };
    await f.api.world.performOperations([{ type: 'token.reposition', payload: { tokenId: 'token-a', x: 25, y: 26 } }]);
    assert.equal(f.metadata().jobs.length, 1);
    const confirmed = clone(f.metadata());
    save.resolve(); await until(() => f.requests.length === 1);
    assert.deepEqual(f.durableMetadata(), confirmed);
    assert.deepEqual(f.metadata(), confirmed);
    assert.equal(Object.hasOwn(f.metadata().jobs[0].input, 'exploredRows'), false);
    assert.deepEqual(f.saveCalls.map(call => call[0]), ['full', 'sync']);
  } finally { f.dispose(); }
});
