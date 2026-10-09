import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalExplorationQueue } from '../src/vision/local-exploration.js';
import { isOwnedExplorationSnapshot, ownedExplorationSnapshot, prepareOwnedExplorationJob } from '../src/vision/owned-exploration-snapshot.js';
import { createWorldStatePersistence } from '../src/app/world-storage.js';
import { createInitialRuntimeState, validateRuntimeState } from '../src/engine/runtime-state.js';
import { createWorldV2FromRuntimeState, projectWorldV2ToRuntimeState } from '../src/world/model.js';
import { infiniteHorrorRuleset as ruleset } from '../src/rulesets/infinite-horror/index.js';

const mapPackage = { id: 'snapshot-map', version: '1', width: 100, height: 100, metersPerUnit: 1, features: [] };
function persistence() {
  const seed = createInitialRuntimeState(mapPackage, { ruleset });
  const world = createWorldV2FromRuntimeState(seed, { mapPackage, ruleset });
  const state = validateRuntimeState(projectWorldV2ToRuntimeState(seed, world, { mapPackage, ruleset }), { mapPackage, ruleset });
  const storage = new Map(), controller = createWorldStatePersistence({ mapPackage, ruleset, getState: () => state,
    storageAdapter: { get: key => storage.get(key), set: (key, value) => storage.set(key, value) } });
  return { controller, saved: () => JSON.parse(storage.get(controller.storageKey)) };
}
function input(x = 10) {
  return { partyId: 'party', contextVersion: 1, map: mapPackage, lineOfSightEnabled: true,
    payload: { x, y: 10, radiusMeters: 10 }, occluders: [{ id: 'wall', geometry: { polygons: [[[1, 2], [3, 4]]] } }] };
}

test('confirmed queue snapshots share immutable geometry while old snapshots retain their exact job list', () => {
  const originalWorker = globalThis.Worker; globalThis.Worker = undefined;
  const snapshots = [], f = persistence(), firstInput = input();
  const queue = createLocalExplorationQueue({ setLocalExplorationSnapshot(value) {
    snapshots.push(value); f.controller.setLocalExplorationSnapshot(value);
  }, setLocalExploration() { assert.fail('ordinary queue did not use its owned snapshot'); },
  persistNow: () => f.controller.persistNow() }, async () => {});
  try {
    queue.enqueue(firstInput, 'scene-a'); queue.persist();
    const before = snapshots[0], expected = JSON.stringify(before), saved = f.saved()._localExploration;
    firstInput.occluders[0].geometry.polygons[0][0][0] = 999;
    assert.equal(before.jobs[0].input.occluders[0].geometry.polygons[0][0][0], 1);
    queue.enqueue(input(20), 'scene-a'); queue.persist();
    assert.equal(snapshots.at(-1).jobs[0], before.jobs[0]);
    assert.notEqual(snapshots.at(-1).jobs, before.jobs);
    assert.equal(before.jobs.length, 1);
    assert.equal(JSON.stringify(before), expected);
    assert.deepEqual(saved, before);
    const detached = f.controller.getLocalExploration();
    detached.jobs[0].input.payload.x = 777;
    assert.equal(f.controller.getLocalExploration().jobs[0].input.payload.x, 10);
    queue.cancel('scene-a'); queue.persist();
    assert.deepEqual(f.saved()._localExploration.jobs, []);
    assert.equal(before.jobs.length, 1);
    assert.equal(isOwnedExplorationSnapshot(before), true);
    assert.throws(() => { before.jobs[0].input.payload.x = 333; }, TypeError);
  } finally { queue.dispose(); f.controller.dispose(); globalThis.Worker = originalWorker; }
});

test('restored jobs use owned clones and preserve stored queue extensions through the complete setter', () => {
  const originalWorker = globalThis.Worker; globalThis.Worker = undefined;
  const original = { schemaVersion: 1, jobs: [{ id: 'old', sceneId: 'scene-a', input: input() }], extension: { retain: true } };
  const f = persistence(); f.controller.setLocalExploration(original);
  let fullWrites = 0;
  const queue = createLocalExplorationQueue({ getLocalExploration: () => f.controller.getLocalExploration(),
    setLocalExplorationSnapshot() { assert.fail('queue extensions must preserve the complete clone path'); },
    setLocalExploration(value) { fullWrites++; f.controller.setLocalExploration(value); }, persistNow: () => f.controller.persistNow() }, async () => {});
  try {
    queue.enqueue(input(20), 'scene-a'); queue.persist();
    assert.ok(fullWrites >= 2);
    assert.deepEqual(f.saved()._localExploration.extension, { retain: true });
    assert.equal(original.jobs.length, 1);
    assert.equal(f.saved()._localExploration.jobs[0].input.payload.x, 10);
  } finally { queue.dispose(); f.controller.dispose(); globalThis.Worker = originalWorker; }
});

test('frozen impostors, mutable data, class values, cycles, and Proxy input never gain sharing receipts', () => {
  const f = persistence(), mutable = { schemaVersion: 1, jobs: [{ id: 'mutable' }] };
  f.controller.setLocalExplorationSnapshot(mutable); mutable.jobs[0].id = 'changed';
  assert.equal(f.controller.getLocalExploration().jobs[0].id, 'mutable');
  const fake = Object.freeze({ schemaVersion: 1, jobs: Object.freeze([Object.freeze({ id: 'fake' })]) });
  assert.equal(isOwnedExplorationSnapshot(fake), false);
  assert.equal(ownedExplorationSnapshot(fake), null);
  for (const extra of [new Date('2026-10-08T00:00:00Z'), new Map([['a', 1]])]) {
    const job = prepareOwnedExplorationJob({ id: 'unusual', input: { extra } });
    assert.equal(ownedExplorationSnapshot({ schemaVersion: 1, jobs: [job] }), null);
    f.controller.setLocalExplorationSnapshot({ schemaVersion: 1, jobs: [job] });
    assert.notEqual(f.controller.getLocalExploration().jobs[0].input.extra, job.input.extra);
  }
  const cyclic = { id: 'cycle' }; cyclic.self = cyclic;
  const job = prepareOwnedExplorationJob(cyclic);
  assert.equal(ownedExplorationSnapshot({ schemaVersion: 1, jobs: [job] }), null);
  assert.equal(job.self, job);
  assert.throws(() => prepareOwnedExplorationJob({ input: new Proxy({}, {}) }), { name: 'DataCloneError' });
  assert.throws(() => f.controller.setLocalExplorationSnapshot(new Proxy({}, {})), { name: 'DataCloneError' });
  assert.throws(() => prepareOwnedExplorationJob({ input: { discarded: () => 1 } }), { name: 'DataCloneError' });
  f.controller.dispose();
});

test('legacy null and primitive jobs retain queue startup and complete metadata-clone behavior', () => {
  const originalWorker = globalThis.Worker; globalThis.Worker = undefined;
  for (const primitive of [null, 3, 'legacy', false]) {
    assert.equal(prepareOwnedExplorationJob(primitive), primitive);
    assert.equal(ownedExplorationSnapshot({ schemaVersion: 1, jobs: [primitive] }), null);
    let saved;
    const queue = createLocalExplorationQueue({ getLocalExploration: () => ({ schemaVersion: 1, jobs: [primitive] }),
      setLocalExplorationSnapshot() { assert.fail('invalid old job must not acquire a sharing receipt'); },
      setLocalExploration(value) { saved = structuredClone(value); }, persistNow: () => true }, async () => {});
    try {
      assert.deepEqual(queue.stats(), { queued: 1, running: false });
      queue.persist();
      assert.deepEqual(saved, { schemaVersion: 1, jobs: [primitive] });
    } finally { queue.dispose(); }
  }
  globalThis.Worker = originalWorker;
});

test('legacy sparse jobs and array extensions retain their native clone boundaries', () => {
  const originalWorker = globalThis.Worker; globalThis.Worker = undefined;
  const cases = [new Array(1), Object.assign([prepareOwnedExplorationJob({ id: 'old', input: input() })], { extension: { keep: true } })];
  for (const jobs of cases) {
    assert.equal(ownedExplorationSnapshot({ schemaVersion: 1, jobs }), null);
    let saved;
    const queue = createLocalExplorationQueue({ getLocalExploration: () => ({ schemaVersion: 1, jobs: structuredClone(jobs) }),
      setLocalExplorationSnapshot() { assert.fail('unusual array must not acquire a sharing receipt'); },
      setLocalExploration(value) { saved = structuredClone(value); }, persistNow: () => true }, async () => {});
    try {
      queue.persist();
      assert.deepEqual(saved.jobs, jobs);
      assert.equal(Object.hasOwn(saved.jobs, 0), Object.hasOwn(jobs, 0));
      assert.deepEqual(saved.jobs.extension, jobs.extension);
    } finally { queue.dispose(); }
  }
  globalThis.Worker = originalWorker;
});

test('custom iterators and accessor jobs cannot substitute an unowned Proxy into a sharing receipt', () => {
  const job = prepareOwnedExplorationJob({ id: 'owned', input: input() });
  const jobs = [job], impostor = Object.freeze(new Proxy({ id: 'impostor' }, {}));
  jobs[Symbol.iterator] = function* () { yield impostor; };
  assert.equal(ownedExplorationSnapshot({ schemaVersion: 1, jobs }), null);
  assert.throws(() => structuredClone({ jobs: [...jobs] }), { name: 'DataCloneError' });
  const accessor = [job];
  Object.defineProperty(accessor, 0, { enumerable: true, configurable: true, get: () => impostor });
  assert.equal(ownedExplorationSnapshot({ schemaVersion: 1, jobs: accessor }), null);
  const snapshot = ownedExplorationSnapshot({ jobs: [job], schemaVersion: 1 });
  assert.equal(isOwnedExplorationSnapshot(snapshot), true);
  assert.deepEqual(Object.keys(snapshot), ['jobs', 'schemaVersion']);
  assert.deepEqual(structuredClone(snapshot), snapshot);
});
