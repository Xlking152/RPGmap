import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorldCheckpoint } from '../deployment/local-server/world-checkpoint.mjs';

const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function clock() {
  let at = 0, sequence = 0;
  const timers = new Map();
  return {
    now: () => at,
    setTimer(callback, delay) { const id = ++sequence; timers.set(id, { at: at + delay, callback }); return id; },
    clearTimer: id => timers.delete(id),
    get size() { return timers.size; },
    async advance(duration) {
      const target = at + duration;
      for (;;) {
        const next = [...timers].filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!next) break;
        at = next[1].at; timers.delete(next[0]); next[1].callback(); await flush();
      }
      at = target;
      await flush();
    },
  };
}
function fixture(overrides = {}) {
  const time = clock(), order = [], snapshots = [], snapshotErrors = [], storageErrors = [];
  let chain = Promise.resolve();
  const api = {
    world: { revision: 100, state: { x: 1 }, exploration: { jobs: { first: { cursor: 0 } } } },
    wal: ['confirmed revision 100'],
    queue(callback) { const next = chain.catch(() => {}).then(callback); chain = next.catch(() => {}); return next; },
    time, order, snapshots, snapshotErrors, storageErrors,
  };
  api.checkpoint = createWorldCheckpoint({
    now: time.now, setTimer: time.setTimer, clearTimer: time.clearTimer,
    getWorld: () => api.world,
    serialize: task => api.queue(task),
    async save(world) { order.push('save'); snapshots.push(structuredClone(world)); },
    async reset() { order.push('reset'); api.wal.length = 0; },
    onSnapshotFailure: error => snapshotErrors.push(error),
    onStorageFailure: error => storageErrors.push(error),
    ...overrides,
  });
  return api;
}

test('WAL-confirmed ACK returns before snapshot IO; checkpoint reads the latest World and private queue', async () => {
  const saved = deferred();
  let api;
  api = fixture({ async save(world) {
    api.order.push('save'); api.snapshots.push(structuredClone(world)); await saved.promise;
  } });
  async function confirmedMove() {
    await Promise.resolve(); // The caller has already completed its WAL fsync.
    api.checkpoint.request();
    api.order.push('ack');
    return 'accepted';
  }
  assert.equal(await confirmedMove(), 'accepted');
  assert.deepEqual(api.order, ['ack']);
  api.world = { revision: 101, state: { x: 20 }, exploration: { jobs: { latest: { cursor: 7 } } } };
  await api.time.advance(50);
  assert.deepEqual(api.order, ['ack', 'save']);
  assert.deepEqual(api.snapshots, [api.world]);
  assert.equal(api.checkpoint.stats().running, true);
  assert.equal(api.wal.length, 1);
  saved.resolve(); await flush();
  assert.deepEqual(api.order, ['ack', 'save', 'reset']);
  assert.equal(api.checkpoint.stats().due, false);
});

test('maintenance joins the latest serial tail after already queued movement', async () => {
  const moving = deferred(), api = fixture();
  api.checkpoint.request();
  const move = api.queue(async () => {
    api.order.push('move-start'); await moving.promise;
    api.world = { ...api.world, revision: 102, state: { x: 42 }, exploration: { jobs: { next: { cursor: 9 } } } };
    api.order.push('move-ack');
  });
  await api.time.advance(50);
  assert.equal(api.snapshots.length, 0);
  assert.equal(api.checkpoint.stats().queued, true);
  moving.resolve(); await move; await flush();
  assert.deepEqual(api.order, ['move-start', 'move-ack', 'save', 'reset']);
  assert.equal(api.snapshots[0].revision, 102);
  assert.deepEqual(api.snapshots[0].exploration.jobs, { next: { cursor: 9 } });
});

test('repeated requests and interaction refresh quiet time but never the first 500 ms bound', async () => {
  const api = fixture();
  api.checkpoint.request();
  await api.time.advance(49); assert.equal(api.snapshots.length, 0);
  api.checkpoint.noteActivity();
  await api.time.advance(49); assert.equal(api.snapshots.length, 0);
  api.checkpoint.request();
  for (let i = 0; i < 10; i++) {
    await api.time.advance(40); api.checkpoint.noteActivity(); api.checkpoint.request();
    assert.equal(api.snapshots.length, 0);
    assert.equal(api.time.size, 1);
  }
  await api.time.advance(1); assert.equal(api.snapshots.length, 0);
  await api.time.advance(1);
  assert.equal(api.time.now(), 500);
  assert.equal(api.snapshots.length, 1);
  assert.deepEqual(api.order, ['save', 'reset']);
  await api.time.advance(1000); assert.equal(api.snapshots.length, 1);
});

test('interaction received while maintenance waits for its lane defers it until quiet', async () => {
  const barrier = deferred(), api = fixture();
  api.queue(() => barrier.promise);
  api.checkpoint.request(); await api.time.advance(50);
  await api.time.advance(10); api.checkpoint.noteActivity();
  barrier.resolve(); await flush();
  assert.equal(api.snapshots.length, 0);
  assert.equal(api.checkpoint.stats().scheduled, true);
  await api.time.advance(49); assert.equal(api.snapshots.length, 0);
  await api.time.advance(1); assert.equal(api.snapshots.length, 1);
});

test('snapshot failure keeps the WAL and due request, then retries a fresh complete World', async () => {
  let attempts = 0, api;
  api = fixture({ async save(world) {
    attempts++; if (attempts === 1) throw new Error('snapshot fsync failed');
    api.order.push('save'); api.snapshots.push(structuredClone(world));
  } });
  api.checkpoint.request(); await api.time.advance(50);
  assert.equal(api.snapshotErrors.length, 1);
  assert.equal(api.storageErrors.length, 0);
  assert.equal(api.checkpoint.stats().due, true);
  assert.equal(api.wal.length, 1);
  api.world = { ...api.world, revision: 110, exploration: { jobs: { recover: { cursor: 12 } } } };
  api.checkpoint.request();
  await api.time.advance(999); assert.equal(attempts, 1);
  await api.time.advance(1);
  assert.equal(attempts, 2);
  assert.deepEqual(api.snapshots, [api.world]);
  assert.deepEqual(api.order, ['save', 'reset']);
  assert.equal(api.checkpoint.stats().due, false);
});

test('uncertain WAL reset failure calls storage failure once and stops all scheduling', async () => {
  const failure = new Error('truncate fsync uncertain'), api = fixture({ async reset() { throw failure; } });
  api.checkpoint.request(); await api.time.advance(50);
  assert.deepEqual(api.storageErrors, [failure]);
  assert.equal(api.snapshots.length, 1);
  assert.equal(api.checkpoint.stats().failed, true);
  assert.equal(api.checkpoint.request(), false);
  api.checkpoint.noteActivity(); await api.time.advance(5000);
  assert.equal(api.snapshots.length, 1);
  assert.equal(api.time.size, 0);
});

test('serial lane rejection retains due work and retries without treating it as uncertain reset', async () => {
  let attempts = 0, api;
  api = fixture({ serialize(task) {
    attempts++; if (attempts === 1) return Promise.reject(new Error('lane was unavailable'));
    return api.queue(task);
  } });
  api.checkpoint.request(); await api.time.advance(50);
  assert.equal(api.snapshotErrors.length, 1);
  assert.equal(api.storageErrors.length, 0);
  await api.time.advance(1000);
  assert.deepEqual(api.order, ['save', 'reset']);
});

test('import cancels an old queued task and a new request captures only the imported World', async () => {
  const barrier = deferred(), api = fixture();
  api.queue(() => barrier.promise);
  api.checkpoint.request(); await api.time.advance(50);
  api.checkpoint.cancel();
  api.world = { revision: 200, state: { imported: true }, exploration: { jobs: {} } };
  api.checkpoint.request(); await api.time.advance(50);
  barrier.resolve(); await flush();
  assert.deepEqual(api.snapshots, [api.world]);
  assert.deepEqual(api.order, ['save', 'reset']);
});

test('successful import serialized behind a running checkpoint replaces World and WAL in order', async () => {
  const saved = deferred();
  let api;
  api = fixture({ async save(world) { api.snapshots.push(structuredClone(world)); await saved.promise; } });
  api.checkpoint.request(); await api.time.advance(50);
  const imported = api.queue(() => {
    api.checkpoint.cancel();
    api.world = { revision: 201, state: { imported: true }, exploration: { jobs: {} } };
    api.wal = ['new-world revision 201']; api.order.push('import');
  });
  assert.equal(api.order.length, 0);
  saved.resolve(); await imported; await flush();
  assert.deepEqual(api.order, ['reset', 'import']);
  assert.deepEqual(api.wal, ['new-world revision 201']);
  assert.equal(api.snapshots[0].revision, 100);
  await api.time.advance(1000); assert.equal(api.snapshots.length, 1);
});

test('close cancels scheduled and queued maintenance while retaining confirmed WAL bytes', async () => {
  for (const queued of [false, true]) {
    const barrier = deferred(), api = fixture();
    if (queued) api.queue(() => barrier.promise);
    api.checkpoint.request();
    if (queued) await api.time.advance(50);
    api.checkpoint.close(); barrier.resolve(); await flush(); await api.time.advance(5000);
    assert.deepEqual(api.order, []);
    assert.equal(api.wal.length, 1);
    assert.equal(api.checkpoint.request(), false);
    assert.equal(api.time.size, 0);
  }
});

test('close during snapshot IO keeps the complete WAL and never starts a late reset or retry', async () => {
  const saved = deferred();
  const api = fixture({ save: () => saved.promise });
  api.checkpoint.request(); await api.time.advance(50);
  api.checkpoint.close(); saved.resolve(); await flush(); await api.time.advance(5000);
  assert.deepEqual(api.order, []);
  assert.equal(api.wal.length, 1);
  assert.equal(api.time.size, 0);
  assert.equal(api.storageErrors.length, 0);
});
