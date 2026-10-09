import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorldValidationWork } from '../src/app/world-validation-work.js';
import { currentWorldValidationRecipe } from '../src/app/world-validation-context.js';
import { exportRuntimeState, exportPreparedRuntimeState, prepareRuntimeStateValidationInput } from '../src/engine/runtime-state.js';
import { infiniteHorrorRuleset } from '../src/rulesets/infinite-horror/index.js';
import { registeredInfiniteHorrorRuleset } from '../src/ruleset/index.js';
import { INFINITE_HORROR_RESOURCE_DEFS } from '../src/rulesets/infinite-horror/definitions.js';
import { STATUS_ICON_NAMES } from '../src/status/model.js';
import { prepareMapPackage, isPreparedMapPackage } from '../src/map-package/contract.js';
import { copyMap, copyRuleset, worldCopyInput } from './fixtures/world-copy-inputs.js';

const options = { mapPackage: copyMap, ruleset: copyRuleset };
const scheduler = { budgetMs: 0, yieldTask: async () => {} };
const tick = () => new Promise(resolve => setImmediate(resolve));
const exported = state => JSON.stringify(exportRuntimeState(state, options));

function transport({ throwPost = false } = {}) {
  const workers = [], requests = [];
  function factory() {
    const worker = { postMessage(message) {
      if (throwPost) throw new Error('message clone failed');
      requests.push({ data: structuredClone(message), worker, receive: worker.onmessage });
    }, terminate() { worker.terminated = true; } };
    workers.push(worker);
    return worker;
  }
  function reply(request, result) {
    request.receive({ data: { protocol: 1, kind: 'runtime-world-export-result',
      id: request.data.id, generation: request.data.generation, ...result } });
  }
  function complete(request) {
    try {
      reply(request, { json: JSON.stringify(exportPreparedRuntimeState(request.data.prepared, {
        mapPackage: request.data.mapPackage, ruleset: infiniteHorrorRuleset,
      })) });
    } catch (error) { reply(request, { error: { name: error.name, message: error.message, code: error.code } }); }
  }
  return { workers, requests, factory, reply, complete };
}

function fixture(t, overrides = {}) {
  const io = transport(overrides);
  const work = createWorldValidationWork({ ...options, workerFactory: io.factory, ...overrides });
  t.after(() => work.dispose());
  return { io, work };
}

test('exact built-in identities use one Worker and preserve every full export byte for schemas 2/3/4', async t => {
  for (const ruleset of [infiniteHorrorRuleset, registeredInfiniteHorrorRuleset]) {
    const { io, work } = fixture(t, { ruleset });
    for (const schemaVersion of [2, 3, 4]) {
      const { state } = worldCopyInput();
      state.preferences.worldV2.schemaVersion = schemaVersion;
      const before = structuredClone(state), expected = exported(state);
      const promise = work.serialize(state, scheduler);
      await tick();
      const request = io.requests.at(-1);
      assert.ok(request);
      assert.equal(request.data.prepared.hasCanonicalWorld, true);
      assert.equal(request.data.recipe, currentWorldValidationRecipe());
      io.complete(request);
      assert.equal(await promise, expected);
      assert.deepEqual(state, before);
    }
    assert.equal(io.workers.length, 1);
  }
});

test('raw classes retain their rejection and caller getters run only in the original main-thread prefix', async t => {
  const { io, work } = fixture(t);
  class State {}
  const classState = Object.assign(new State(), worldCopyInput().state);
  await assert.rejects(work.serialize(classState, scheduler), error => error instanceof TypeError
    && error.message === 'Feature State migration requires a state object');
  assert.equal(io.workers.length, 0);
  let reads = 0;
  const state = worldCopyInput().state;
  Object.defineProperty(state.extension, 'value', { enumerable: true, get() { reads += 1; return 'owned'; } });
  const promise = work.serialize(state, scheduler);
  assert.equal(reads, 1, 'raw input is detached synchronously at serialize, even before queue dispatch');
  await tick();
  io.workers[0].onerror({ message: 'Worker unavailable' });
  const result = await promise;
  assert.equal(reads, 1, 'fallback must not rerun the raw prefix');
  assert.equal(JSON.parse(result).extension.value, 'owned');
});

test('legacy preference classes keep their pre-clone hasLegacy classification', async t => {
  const { io, work } = fixture(t);
  class Preferences {}
  const state = worldCopyInput().state;
  state.preferences = Object.assign(new Preferences(), state.preferences);
  const expected = exported(state);
  const promise = work.serialize(state, scheduler);
  await tick();
  assert.equal(io.requests[0].data.prepared.hasLegacy, false);
  io.complete(io.requests[0]);
  assert.equal(await promise, expected);
});

test('queued confirmed snapshots are captured at call time and never run simultaneously', async t => {
  const { io, work } = fixture(t);
  const first = worldCopyInput().state, second = worldCopyInput().state;
  second.extension.nested.value = 'second confirmed';
  const expected = exported(second);
  const p1 = work.serialize(first, scheduler), p2 = work.serialize(second, scheduler);
  second.extension.nested.value = 'unconfirmed mutation';
  await tick();
  assert.equal(io.requests.length, 1);
  io.complete(io.requests[0]);
  await p1;
  await tick();
  assert.equal(io.requests.length, 2);
  io.complete(io.requests[1]);
  assert.equal(await p2, expected);
  assert.equal(io.workers.length, 1);
});

test('noncanonical saves keep original complete reads before yielding and stay off the Worker', async t => {
  const { io, work } = fixture(t);
  const state = { mapId: copyMap.id, mapVersion: copyMap.version, markers: [{ id: 'm', x: 1, y: 2 }],
    attackAreas: [], sceneEvents: [], preferences: {} };
  const expected = exported(state);
  const promise = work.serialize(state, scheduler);
  state.markers[0].x = 999;
  assert.equal(await promise, expected);
  assert.equal(io.workers.length, 0);
});

test('same-ID custom rulesets fall back to complete local validation', async t => {
  const { io, work } = fixture(t, { ruleset: Object.freeze({ ...copyRuleset }) });
  const state = worldCopyInput().state;
  assert.equal(await work.serialize(state, scheduler), exported(state));
  assert.equal(io.workers.length, 0);
});

test('only read metadata is copied; mutable map getters force the full local path', async t => {
  const state = worldCopyInput().state;
  const mapPackage = prepareMapPackage({ ...copyMap, layers: ['base'], features: [{ id: 'feature', uncloneable: () => {} }], svg: '<svg/>', createSvg: () => '<svg/>' });
  assert.equal(isPreparedMapPackage(mapPackage), true);
  const f = fixture(t, { mapPackage });
  const promise = f.work.serialize(state, scheduler);
  await tick();
  assert.deepEqual(f.io.requests[0].data.mapPackage, { id: copyMap.id, version: copyMap.version, title: copyMap.title });
  f.io.complete(f.io.requests[0]);
  assert.equal(await promise, exported(state));
  let reads = 0;
  const mutableMap = { ...copyMap };
  Object.defineProperty(mutableMap, 'title', { get() { reads += 1; return copyMap.title; } });
  const expected = JSON.stringify(exportRuntimeState(state, { ...options, mapPackage: mutableMap }));
  reads = 0;
  const g = fixture(t, { mapPackage: mutableMap });
  assert.equal(await g.work.serialize(state, scheduler), expected);
  assert.ok(reads > 0);
  assert.equal(g.io.workers.length, 0);
});

test('mutable closed resource definitions and icon tables require local full validation', async t => {
  const { io, work } = fixture(t), state = worldCopyInput().state;
  const resource = INFINITE_HORROR_RESOURCE_DEFS[0], originalId = resource.id;
  try {
    resource.id = 'changed-resource';
    assert.equal(currentWorldValidationRecipe(), null);
    assert.equal(await work.serialize(state, scheduler), exported(state));
    assert.equal(io.workers.length, 0);
  } finally { resource.id = originalId; }
  try {
    STATUS_ICON_NAMES.add('extension-icon');
    assert.equal(currentWorldValidationRecipe(), null);
    assert.equal(await work.serialize(state, scheduler), exported(state));
    assert.equal(io.workers.length, 0);
  } finally { STATUS_ICON_NAMES.delete('extension-icon'); }
  assert.ok(currentWorldValidationRecipe());
});

test('map Proxy descriptors cannot qualify a different map than the actual get semantics', async t => {
  const state = worldCopyInput().state;
  const mapPackage = new Proxy({ ...copyMap, id: 'descriptor-map' }, {
    get(target, key, receiver) { return key === 'id' ? copyMap.id : Reflect.get(target, key, receiver); },
  });
  const { io, work } = fixture(t, { mapPackage });
  const expected = JSON.stringify(exportRuntimeState(state, { ...options, mapPackage }));
  assert.equal(await work.serialize(state, scheduler), expected);
  assert.equal(io.workers.length, 0);
  assert.equal(isPreparedMapPackage(mapPackage), false);
});

test('the prepared receipt cannot be copied and unused manifest aliases stay off the transfer', async t => {
  const manifest = new Proxy({}, { get() { throw new Error('unreachable manifest alias'); } });
  const mapPackage = prepareMapPackage({ ...copyMap, layers: ['base'], features: [], svg: '<svg/>', manifest });
  assert.equal(isPreparedMapPackage({ ...mapPackage }), false);
  const { io, work } = fixture(t, { mapPackage }), state = worldCopyInput().state;
  const expected = JSON.stringify(exportRuntimeState(state, { ...options, mapPackage }));
  const promise = work.serialize(state, scheduler);
  await tick();
  assert.equal(Object.hasOwn(io.requests[0].data.mapPackage, 'manifest'), false);
  io.complete(io.requests[0]);
  assert.equal(await promise, expected);
});

test('qualification never reads unrelated map getters and falls back to the original export', async t => {
  let unrelatedReads = 0;
  const mapPackage = { ...copyMap };
  Object.defineProperty(mapPackage, 'unrelated', { enumerable: true, get() { unrelatedReads += 1; throw new Error('unrelated'); } });
  const { io, work } = fixture(t, { mapPackage }), state = worldCopyInput().state;
  assert.equal(unrelatedReads, 0, 'constructor must not clone an accessor-bearing map');
  assert.equal(await work.serialize(state, scheduler), exported(state));
  assert.equal(unrelatedReads, 0);
  assert.equal(io.workers.length, 0);
});

test('a manifest getter added after constructor qualification keeps complete projection errors on the local path', async t => {
  const mapPackage = { ...copyMap };
  const { io, work } = fixture(t, { mapPackage }), state = worldCopyInput().state;
  let reads = 0;
  Object.defineProperty(mapPackage, 'manifest', { configurable: true, get() {
    reads += 1;
    if (reads >= 4) throw new Error('manifest projection rejected');
    return {};
  } });
  await assert.rejects(work.serialize(state, scheduler), /manifest projection rejected/);
  assert.equal(io.workers.length, 0);
  assert.equal(reads, 4);
});

test('whole prototype tables detect flatMap and inherited Token defaults without invoking extra getters', () => {
  const flatMap = Array.prototype.flatMap;
  try {
    Array.prototype.flatMap = Array.prototype.map;
    assert.equal(currentWorldValidationRecipe(), null);
  } finally { Array.prototype.flatMap = flatMap; }
  const descriptor = Object.getOwnPropertyDescriptor(Object.prototype, 'showName');
  try {
    Object.defineProperty(Object.prototype, 'showName', { value: false, configurable: true });
    assert.equal(currentWorldValidationRecipe(), null);
  } finally {
    if (descriptor) Object.defineProperty(Object.prototype, 'showName', descriptor);
    else delete Object.prototype.showName;
  }
  assert.ok(currentWorldValidationRecipe());
});

test('custom local fallback executes migration before the first microtask and keeps getter errors in order', async t => {
  const events = [], custom = { ...copyRuleset, statuses: { ...copyRuleset.statuses,
    get definitions() { events.push('definitions'); return copyRuleset.statuses.definitions; } } };
  const { io, work } = fixture(t, { ruleset: custom }), state = worldCopyInput().state;
  queueMicrotask(() => events.push('microtask'));
  const promise = work.serialize(state, { yieldTask: async () => { events.push('yield'); } });
  assert.equal(events[0], 'definitions');
  assert.equal(events[1], 'yield');
  await promise;
  assert.ok(events.indexOf('microtask') > events.indexOf('yield'));
  assert.equal(io.workers.length, 0);
});

test('changed closure context after dispatch discards the old result and validates the owned input locally', async t => {
  const { io, work } = fixture(t), state = worldCopyInput().state;
  const promise = work.serialize(state, scheduler);
  await tick();
  const oldJSON = exported(state);
  const resource = INFINITE_HORROR_RESOURCE_DEFS[0], originalId = resource.id;
  try {
    resource.id = 'current-resource';
    const expected = exported(state);
    assert.notEqual(expected, oldJSON);
    io.reply(io.requests[0], { json: oldJSON });
    assert.equal(await promise, expected);
    assert.equal(io.requests.length, 1);
  } finally { resource.id = originalId; }
});

test('serialization hooks and changed platform methods fail qualification', async t => {
  const { io, work } = fixture(t), state = worldCopyInput().state;
  const descriptor = Object.getOwnPropertyDescriptor(INFINITE_HORROR_RESOURCE_DEFS[0], 'toJSON');
  try {
    Object.defineProperty(INFINITE_HORROR_RESOURCE_DEFS[0], 'toJSON', { configurable: true, get() { throw new Error('not read by qualification'); } });
    assert.equal(currentWorldValidationRecipe(), null);
    // The full old algorithm, rather than qualification, remains responsible
    // for any serialization behavior of the actual authority input.
    assert.equal(await work.serialize(state, scheduler), exported(state));
    assert.equal(io.workers.length, 0);
  } finally {
    if (descriptor) Object.defineProperty(INFINITE_HORROR_RESOURCE_DEFS[0], 'toJSON', descriptor);
    else delete INFINITE_HORROR_RESOURCE_DEFS[0].toJSON;
  }
  const stringify = JSON.stringify;
  try {
    JSON.stringify = (...args) => stringify(...args);
    assert.equal(currentWorldValidationRecipe(), null);
    assert.equal(await work.serialize(state, scheduler), exported(state));
    assert.equal(io.workers.length, 0);
  } finally { JSON.stringify = stringify; }
});

test('signal cancellation stops only its request; queued cancellation rejects without waiting for the active Worker', async t => {
  const { io, work } = fixture(t), state = worldCopyInput().state;
  const queued = new AbortController();
  const first = work.serialize(state, scheduler), second = work.serialize(state, { ...scheduler, signal: queued.signal });
  await tick();
  queued.abort();
  await assert.rejects(second, { name: 'AbortError' });
  assert.equal(io.workers[0].terminated, undefined);
  io.complete(io.requests[0]);
  assert.equal(await first, exported(state));
  await tick();
  assert.equal(io.requests.length, 1);
});

test('cancel fences stale responses, drains queued work and permits a fresh request', async t => {
  const { io, work } = fixture(t), state = worldCopyInput().state;
  const first = work.serialize(state, scheduler), second = work.serialize(state, scheduler);
  await tick();
  const old = io.requests[0];
  work.cancel();
  await assert.rejects(first, { name: 'AbortError' });
  await assert.rejects(second, { name: 'AbortError' });
  assert.equal(old.worker.terminated, true);
  const third = work.serialize(state, scheduler);
  await tick();
  io.reply(old, { json: '{"obsolete":true}' });
  assert.equal(io.requests.length, 2);
  io.complete(io.requests[1]);
  assert.equal(await third, exported(state));
});

test('dispose and already-aborted signals cannot create or revive a Worker', async t => {
  const { io, work } = fixture(t), state = worldCopyInput().state;
  const signal = AbortSignal.abort();
  await assert.rejects(work.serialize(state, { ...scheduler, signal }), { name: 'AbortError' });
  assert.equal(io.workers.length, 0);
  const pending = work.serialize(state, scheduler);
  await tick();
  work.dispose();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.doesNotThrow(() => work.cancel());
  await assert.rejects(work.serialize(state, scheduler), { name: 'AbortError' });
  assert.equal(io.workers.length, 1);
});

test('Worker constructor/postMessage/errors/timeouts fall back once and disable recreation', async t => {
  const state = worldCopyInput().state, expected = exported(state);
  for (const failure of ['constructor', 'postMessage', 'error', 'messageerror', 'timeout']) {
    const f = fixture(t, { ...(failure === 'constructor' ? { workerFactory: () => { throw new Error('unavailable'); } } : {}),
      throwPost: failure === 'postMessage', timeoutMs: failure === 'timeout' ? 5 : 1000 });
    const promise = f.work.serialize(state, scheduler);
    await tick();
    if (failure === 'error') f.io.workers[0].onerror({ message: 'unavailable' });
    if (failure === 'messageerror') f.io.workers[0].onmessageerror({});
    assert.equal(await promise, expected);
    const count = f.io.workers.length;
    assert.equal(await f.work.serialize(state, scheduler), expected);
    assert.equal(f.io.workers.length, count);
    assert.ok(f.io.workers.every(worker => worker.terminated));
  }
});

test('malformed and contradictory Worker replies are infrastructure failures, never successful saves', async t => {
  const state = worldCopyInput().state, expected = exported(state);
  for (const response of [{ json: 'garbage' }, { error: 'bad' }, { error: { name: 'Error', message: [] } },
    { json: expected, error: { name: 'Error', message: 'contradiction' } }, { error: { name: 'Error', message: 'bad', code: {} } }]) {
    const { io, work } = fixture(t);
    const promise = work.serialize(state, scheduler);
    await tick();
    io.reply(io.requests[0], response);
    assert.equal(await promise, expected);
    assert.equal(io.workers[0].terminated, true);
  }
});

test('genuine validation errors preserve name/message/code and never enter infrastructure fallback', async t => {
  const { io, work } = fixture(t), state = worldCopyInput().state;
  const promise = work.serialize(state, { yieldTask: async () => { throw new Error('fallback forbidden'); } });
  await tick();
  io.reply(io.requests[0], { error: { name: 'TypeError', message: 'invalid authority', code: 'INVALID_WORLD' } });
  await assert.rejects(promise, error => error instanceof TypeError && error.message === 'invalid authority' && error.code === 'INVALID_WORLD');
  assert.equal(io.workers[0].terminated, undefined);
  const next = work.serialize(state, scheduler);
  await tick();
  io.complete(io.requests[1]);
  assert.equal(await next, exported(state));
});

test('real Worker entry rejects a foreign recipe and runs the same complete continuation including BigInt errors', async () => {
  const messages = [], previous = globalThis.self;
  globalThis.self = { postMessage(message) { messages.push(message); } };
  try {
    await import('../src/app/world-validation-worker.js');
    const state = worldCopyInput().state;
    const request = { protocol: 1, kind: 'runtime-world-export', id: 1, generation: 2,
      prepared: prepareRuntimeStateValidationInput(state, options), mapPackage: copyMap, recipe: 'foreign' };
    self.onmessage({ data: request });
    assert.ok(messages.at(-1).infrastructureError);
    request.recipe = currentWorldValidationRecipe();
    self.onmessage({ data: structuredClone(request) });
    assert.equal(messages.at(-1).json, exported(state));
    request.prepared.source.extension.bigint = 1n;
    self.onmessage({ data: structuredClone(request) });
    const error = messages.at(-1).error;
    assert.equal(error.name, 'TypeError');
    assert.match(error.message, /BigInt/);
    assert.equal(messages.at(-1).json, undefined);
  } finally { if (previous === undefined) delete globalThis.self; else globalThis.self = previous; }
});
