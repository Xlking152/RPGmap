import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorldStatePersistence, createRemoteWorldIsolation } from '../src/app/world-storage.js';
import { exportRuntimeState, exportPreparedRuntimeState, stringifyTrustedRuntimeState } from '../src/engine/runtime-state.js';
import { registeredInfiniteHorrorRuleset } from '../src/ruleset/index.js';
import { copyMap, worldCopyInput } from './fixtures/world-copy-inputs.js';
import { validationTurns, flushValidationTurn } from './fixtures/validation-turns.js';

const options = { mapPackage: { ...copyMap, features: [] }, ruleset: registeredInfiniteHorrorRuleset };

// A controlled worker transport keeps cross-turn races explicit, without
// launching a browser, a real Worker thread or timers to emulate CPU load.
function workerTransport() {
  const workers = [], requests = [];
  function factory() {
    const worker = { onmessage: null, onerror: null, onmessageerror: null, terminated: false,
      postMessage(message) {
        requests.push({ message: structuredClone(message), worker, receive: worker.onmessage });
      },
      terminate() { worker.terminated = true; },
    };
    workers.push(worker);
    return worker;
  }
  function reply(request, result) {
    request.receive({ data: { protocol: 1, kind: 'runtime-world-export-result',
      id: request.message.id, generation: request.message.generation, ...result } });
  }
  function complete(request) {
    try {
      const state = exportPreparedRuntimeState(request.message.prepared, {
        mapPackage: request.message.mapPackage, ruleset: options.ruleset,
      });
      reply(request, { json: JSON.stringify(state) });
    } catch (error) {
      reply(request, { error: { name: error.name, message: error.message, code: error.code } });
    }
  }
  async function request(index) {
    await flushValidationTurn();
    assert.ok(requests[index], `expected Worker request ${index}`);
    assert.equal(requests[index].message.kind, 'runtime-world-export');
    return requests[index];
  }
  return { factory, workers, requests, reply, complete, request };
}

function fixture(t, { onSaved = () => {} } = {}) {
  let state = exportRuntimeState(worldCopyInput().state, options), revision = 1;
  let writeError = null, afterWrite = null;
  const records = new Map(), writes = [], errors = [], turns = validationTurns(), transport = workerTransport();
  const persistence = createWorldStatePersistence({ ...options,
    getState: () => state, getStateRevision: () => revision,
    validationYieldTask: turns.yieldTask, validationWorkerFactory: transport.factory,
    stringifyTrustedState: current => stringifyTrustedRuntimeState(current, options),
    storageAdapter: { get: key => records.get(key), set(key, value) {
      records.set(key, value); writes.push(JSON.parse(value)); afterWrite?.(); if (writeError) throw writeError;
    } }, onSaved, onError: error => errors.push(error),
  });
  t.after(() => persistence.dispose());
  function change(label, { inPlace = false } = {}) {
    if (!inPlace) state = structuredClone(state);
    state.extension.nested.value = label;
    state.preferences.worldV2.extension.nested.value = label;
    revision += 1;
  }
  async function start() {
    const saving = persistence.persistValidatedAsync();
    await turns.release();
    return { saving, request: await transport.request(transport.requests.length - 1) };
  }
  return { persistence, writes, errors, records, turns, transport, change, start,
    get state() { return state; }, set state(value) { state = value; revision += 1; },
    set writeError(value) { writeError = value; }, set afterWrite(value) { afterWrite = value; } };
}

test('Worker saves retain the initial paint and retry newer movement/Fog after a trusted write', async t => {
  const f = fixture(t), saving = f.persistence.persistValidatedAsync();
  assert.equal(f.persistence.persistValidatedAsync(), saving);
  await f.turns.wait();
  assert.equal(f.transport.requests.length, 0, 'no validation work precedes the committed state paint');
  await f.turns.release();
  const oldRequest = await f.transport.request(0);
  assert.notEqual(oldRequest.message.prepared.source, f.state);
  f.change('latest movement and Fog');
  f.state.preferences.worldV2.scenes[0].tokens[0].x = 42;
  f.state.preferences.worldV2.scenes[0].fog.exploredByParty.party.rows[3] = [[2, 8]];
  f.state = exportRuntimeState(f.state, options);
  assert.equal(f.persistence.persistTrustedNow(), true);
  f.transport.complete(oldRequest);
  const currentRequest = await f.transport.request(1);
  assert.equal(f.writes.length, 1, 'an old Worker result cannot add a stale full save');
  f.transport.complete(currentRequest);
  assert.equal(await saving, true);
  assert.equal(JSON.stringify(f.writes.at(-1)), JSON.stringify(exportRuntimeState(f.state, options)));
  assert.ok(f.writes.every(saved => saved.preferences.worldV2.scenes[0].tokens[0].x === 42));
  assert.ok(f.writes.every(saved => saved.preferences.worldV2.scenes[0].fog.exploredByParty.party.rows[3]));
  assert.equal(f.errors.length, 0);
  assert.equal(f.turns.pending, 0);
});

test('Worker saves detect same-identity revisions and append the latest private queue only at write', async t => {
  const f = fixture(t);
  f.persistence.setLocalExploration({ jobs: [{ id: 'old route' }] });
  const { saving, request } = await f.start();
  const originalIdentity = f.state;
  f.change('same identity, new revision', { inPlace: true });
  assert.equal(f.state, originalIdentity);
  f.transport.complete(request);
  const latestRequest = await f.transport.request(1);
  assert.equal(f.writes.length, 0);
  const latestQueue = { jobs: [{ id: 'new route', confirmedPath: [{ x: 42, y: 20 }] }], generations: { 'scene-a': 2 } };
  f.persistence.setLocalExploration(latestQueue);
  f.transport.complete(latestRequest);
  assert.equal(await saving, true);
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].extension.nested.value, 'same identity, new revision');
  assert.deepEqual(f.writes[0]._localExploration, latestQueue);
  assert.equal(Object.hasOwn(f.state, '_localExploration'), false);
  assert.equal(f.errors.length, 0);
});

test('a private queue update without a World revision is preserved by a pending Worker save', async t => {
  const f = fixture(t), { saving, request } = await f.start();
  f.persistence.setLocalExploration({ jobs: [{ id: 'confirmed while validation ran' }] });
  f.transport.complete(request);
  assert.equal(await saving, true);
  assert.deepEqual(f.writes[0]._localExploration, f.persistence.getLocalExploration());
  assert.equal(f.transport.requests.length, 1, 'queue changes do not require another World validation');
});

test('onSaved queues a distinct Worker save behind the acknowledged snapshot', async t => {
  let f, second, notifications = 0;
  f = fixture(t, { onSaved() {
    notifications++;
    if (notifications === 1) { f.change('reentrant latest'); second = f.persistence.persistValidatedAsync(); }
  } });
  const { saving, request } = await f.start();
  f.transport.complete(request);
  assert.equal(await saving, true);
  assert.ok(second);
  assert.notEqual(second, saving);
  await f.turns.release();
  f.transport.complete(await f.transport.request(1));
  assert.equal(await second, true);
  assert.equal(f.writes.length, 2);
  assert.equal(f.writes[0].extension.nested.value, 'state');
  assert.equal(f.writes[1].extension.nested.value, 'reentrant latest');
});

for (const action of ['cancel', 'suspend', 'dispose']) {
  test(`${action} fences active Worker replies without blocking later valid saves`, async t => {
    const f = fixture(t), { saving, request } = await f.start();
    f.persistence[action]();
    assert.equal(await saving, false);
    assert.equal(request.worker.terminated, true);
    // Deliver an already queued old event even after terminate()/listener clear.
    f.transport.complete(request);
    await flushValidationTurn();
    assert.equal(f.writes.length, 0);
    assert.equal(f.errors.length, 0);
    assert.equal(f.persistence.blocked, false);
    if (action === 'dispose') {
      assert.equal(f.persistence.persistNow(), false);
      assert.equal(await f.persistence.persistValidatedAsync(), false);
      return;
    }
    if (action === 'suspend') {
      assert.equal(await f.persistence.persistValidatedAsync(), false);
      assert.equal(f.persistence.persistTrustedNow(), false);
      f.persistence.resume();
    }
    f.change('new generation');
    const resumed = await f.start();
    f.transport.complete(resumed.request);
    assert.equal(await resumed.saving, true);
    assert.equal(f.writes.length, 1);
    assert.equal(f.writes[0].extension.nested.value, 'new generation');
  });
}

test('import replacement preserves its record against a terminated old Worker result', async t => {
  const f = fixture(t), { saving, request } = await f.start();
  const imported = structuredClone(f.state);
  imported.extension.nested.value = 'imported World';
  f.persistence.setLocalExploration({ jobs: [{ id: 'old scene' }] });
  assert.equal(f.persistence.replace(imported), true);
  f.state = imported;
  assert.equal(await saving, false);
  f.transport.complete(request);
  await flushValidationTurn();
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].extension.nested.value, 'imported World');
  assert.equal(Object.hasOwn(f.writes[0], '_localExploration'), false);
  assert.equal(f.persistence.getLocalExploration(), null);
});

test('LAN projection isolation cancels local Workers and resumes only the restored local World', async t => {
  const f = fixture(t), local = structuredClone(f.state), queue = { jobs: [{ id: 'local confirmed route' }] };
  f.persistence.setLocalExploration(queue);
  const isolation = createRemoteWorldIsolation({ persistence: f.persistence, getState: () => f.state,
    restoreState: value => { f.state = value; } });
  const { saving, request } = await f.start();
  isolation.updateConnection({ connected: true, retainsServerState: true });
  f.change('private server projection');
  assert.equal(await saving, false);
  f.transport.complete(request);
  assert.equal(await f.persistence.persistValidatedAsync(), false);
  assert.equal(isolation.updateConnection({ connected: false, retainsServerState: true }), false);
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].extension.nested.value, 'state');
  assert.deepEqual(f.writes[0]._localExploration, queue);
  assert.equal(isolation.updateConnection({ connected: false, retainsServerState: false }), true);
  assert.deepEqual(f.state, local);
  const resumed = await f.start();
  f.transport.complete(resumed.request);
  assert.equal(await resumed.saving, true);
  assert.ok(f.writes.every(saved => saved.extension.nested.value === 'state'));
});

test('Worker infrastructure failure falls back from the same owned input without rereading raw getters', async t => {
  const f = fixture(t);
  let captures = 0;
  Object.defineProperty(f.state.extension, 'captureProof', { enumerable: true,
    get() { captures++; return { value: 'only captured once' }; } });
  const { saving, request } = await f.start();
  assert.equal(captures, 1);
  f.transport.reply(request, { infrastructureError: 'Worker transport stopped' });
  assert.equal(await f.turns.finish(saving), true);
  assert.equal(captures, 1, 'fallback must consume prepared input rather than clone the caller again');
  assert.deepEqual(f.writes[0].extension.captureProof, { value: 'only captured once' });
  assert.equal(f.errors.length, 0);
  assert.equal(f.persistence.blocked, false);
});

test('a changed MapPackage alias cannot publish a Worker export validated against the previous context', async t => {
  const f = fixture(t), { saving, request } = await f.start();
  options.mapPackage.mapVersion = 'new-runtime-alias';
  t.after(() => { delete options.mapPackage.mapVersion; });
  f.transport.complete(request);
  assert.equal(await f.turns.finish(saving), true);
  assert.equal(f.writes[0].mapVersion, 'new-runtime-alias');
  assert.equal(JSON.stringify(f.writes[0]), JSON.stringify(exportRuntimeState(f.state, options)));
  assert.equal(f.transport.requests.length, 1, 'the obsolete context uses main-thread full validation fallback');
  assert.equal(f.errors.length, 0);
});

test('a stale Worker validation error cannot block a newer valid World', async t => {
  const f = fixture(t), { saving, request } = await f.start();
  f.change('valid latest');
  f.transport.reply(request, { error: { name: 'TypeError', message: 'old invalid scene', code: 'world_invalid_geometry' } });
  const latestRequest = await f.transport.request(1);
  assert.equal(f.persistence.blocked, false);
  f.transport.complete(latestRequest);
  assert.equal(await saving, true);
  assert.equal(f.writes[0].extension.nested.value, 'valid latest');
  assert.equal(f.errors.length, 0);
});

test('current Worker validation and uncertain backend failures block further automatic writes', async t => {
  for (const failure of ['validation', 'storage']) {
    await t.test(failure, async child => {
      const f = fixture(child), { saving, request } = await f.start();
      if (failure === 'validation') {
        f.transport.reply(request, { error: { name: 'TypeError', message: 'current invalid scene', code: 'world_invalid_geometry' } });
      } else {
        f.writeError = new Error('write completed but durability uncertain');
        f.afterWrite = () => f.change('state changed inside uncertain write');
        f.transport.complete(request);
      }
      assert.equal(await saving, false);
      assert.equal(f.persistence.blocked, true);
      assert.equal(f.errors.length, 1);
      if (failure === 'validation') assert.equal(f.errors[0].code, 'world_invalid_geometry');
      const writes = f.writes.length;
      assert.equal(f.persistence.persistNow(), false);
      assert.equal(await f.persistence.persistValidatedAsync(), false);
      assert.equal(f.writes.length, writes);
    });
  }
});
