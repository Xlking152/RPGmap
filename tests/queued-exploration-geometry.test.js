import test from 'node:test';
import assert from 'node:assert/strict';
import { sceneVisionContext, releaseVisionContexts } from '../src/vision/context.js';
import { deriveVisionOccluders, isOwnedVisionOccluderCollection } from '../src/spatial/kernel.js';
import { createQueuedExplorationJob, prepareOwnedExplorationJob, ownedExplorationSnapshot } from '../src/vision/owned-exploration-snapshot.js';
import { createLocalExplorationQueue } from '../src/vision/local-exploration.js';
import { computeFogExploration } from '../src/vision/fog.js';

const map = () => ({ id: 'map', width: 100, height: 100, metersPerUnit: 1, features: [],
  visionOccluders: [{ id: 'wall', polygon: [[40, 0], [45, 0], [45, 100], [40, 100]], blockingHeightMeters: 3 }] });
function fixture() {
  const packageMap = map(), spatial = sceneVisionContext(packageMap, {});
  return { packageMap, geometry: spatial.occluders, input: { partyId: 'party',
    payload: { x: 20, y: 50, radiusMeters: 40 }, lineOfSightEnabled: true,
    occluders: spatial.occluders, contextVersion: spatial.geometryVersion,
    map: { width: 100, height: 100, metersPerUnit: 1 } } };
}
const legacy = input => prepareOwnedExplorationJob({ id: 'job', sceneId: 'scene',
  input: { ...input, contextVersion: `local:session:${input.contextVersion ?? 'job'}` } });
const queued = input => createQueuedExplorationJob('job', 'scene', input, 'session');

test('constructor-owned geometry is shared while every mutable parameter is natively detached', () => {
  const f = fixture(), original = structuredClone, calls = [];
  let actual;
  globalThis.structuredClone = value => { calls.push(value); return original(value); };
  try { actual = queued(f.input); } finally { globalThis.structuredClone = original; }
  const expected = legacy(f.input);
  assert.equal(isOwnedVisionOccluderCollection(f.geometry), true);
  assert.equal(actual.input.occluders, f.geometry);
  assert.notEqual(expected.input.occluders, f.geometry);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input.occluders, undefined, 'the large geometry is absent from the native copy');
  assert.deepEqual(actual, expected); assert.equal(JSON.stringify(actual), JSON.stringify(expected));
  assert.ok(ownedExplorationSnapshot({ schemaVersion: 1, jobs: [actual] }));
  f.input.payload.x = 99; f.input.map.width = 999;
  f.packageMap.visionOccluders[0].polygon[0][0] = 1;
  assert.equal(actual.input.payload.x, 20); assert.equal(actual.input.map.width, 100);
  assert.equal(actual.input.occluders[0].polygon[0][0], 40);
  assert.ok(Object.isFrozen(actual.input.payload)); releaseVisionContexts(f.packageMap);
});

test('source spread getters retain their original order and private route aliases remain intact', () => {
  const f = fixture(), point = { x: 20, y: 50, elevationMeters: 2 }, reads = [];
  const input = { ...f.input, payload: { from: point, to: point, radiusMeters: 40 },
    get partyId() { reads.push('party'); return 'party'; },
    get contextVersion() { reads.push('context'); return 'version'; } };
  const expected = legacy(input), oldReads = reads.splice(0);
  const actual = queued(input);
  assert.deepEqual(reads, oldReads); assert.deepEqual(actual, expected);
  assert.equal(actual.input.payload.from, actual.input.payload.to);
  assert.notEqual(actual.input.payload.from, point);
  point.x = 88; assert.equal(actual.input.payload.from.x, 20);
  releaseVisionContexts(f.packageMap);
});

test('extensions, geometry aliases and cyclic input retain the complete native clone boundary', () => {
  const f = fixture();
  for (const input of [
    { ...f.input, extra: { retained: true } },
    { ...f.input, map: { ...f.input.map, extension: f.geometry[0] } },
    { ...f.input, payload: { ...f.input.payload, geometryRef: f.geometry[0] } },
  ]) {
    const actual = queued(input), expected = legacy(input);
    assert.deepEqual(actual, expected); assert.notEqual(actual.input.occluders, f.geometry);
    if (input.payload.geometryRef) assert.equal(actual.input.payload.geometryRef, actual.input.occluders[0]);
    if (input.map.extension) assert.equal(actual.input.map.extension, actual.input.occluders[0]);
  }
  const cycle = { ...f.input.payload }; cycle.self = cycle;
  const actual = queued({ ...f.input, payload: cycle });
  assert.equal(actual.input.payload.self, actual.input.payload);
  assert.equal(ownedExplorationSnapshot({ schemaVersion: 1, jobs: [actual] }), null);
  releaseVisionContexts(f.packageMap);
});

test('frozen lookalikes and altered constructor arrays cannot acquire the sharing receipt', () => {
  const f = fixture(), lookalike = Object.freeze([...f.geometry]);
  assert.equal(isOwnedVisionOccluderCollection(lookalike), false);
  const actual = queued({ ...f.input, occluders: lookalike });
  assert.notEqual(actual.input.occluders, lookalike); assert.deepEqual(actual, legacy({ ...f.input, occluders: lookalike }));
  const modified = deriveVisionOccluders(f.packageMap);
  assert.equal(Object.isFrozen(modified), false, 'public derivation keeps its original mutable container');
  modified.extension = 'legacy'; Object.freeze(modified);
  assert.equal(isOwnedVisionOccluderCollection(modified), false);
  assert.equal(queued({ ...f.input, occluders: modified }).input.occluders.extension, 'legacy');
  const nonenumerable = deriveVisionOccluders(f.packageMap);
  Object.defineProperty(nonenumerable, '0', { enumerable: false }); Object.freeze(nonenumerable);
  assert.equal(isOwnedVisionOccluderCollection(nonenumerable), false);
  const copied = queued({ ...f.input, occluders: nonenumerable });
  assert.equal(Object.hasOwn(copied.input.occluders, 0), false, 'native clone keeps the old nonenumerable-index hole');
  assert.deepEqual(copied, legacy({ ...f.input, occluders: nonenumerable }));
  releaseVisionContexts(f.packageMap);
});

test('geometry, small-field and nested Proxies still cause native DataCloneError', () => {
  const f = fixture();
  for (const input of [
    { ...f.input, occluders: new Proxy(f.geometry, {}) },
    { ...f.input, payload: new Proxy(f.input.payload, {}) },
    { ...f.input, map: new Proxy(f.input.map, {}) },
    { ...f.input, payload: { from: new Proxy({ x: 1, y: 2 }, {}), to: { x: 5, y: 6 }, radiusMeters: 10 } },
    { ...f.input, payload: { ...f.input.payload, extension() {} } },
  ]) {
    assert.throws(() => legacy(input), { name: 'DataCloneError' });
    assert.throws(() => queued(input), { name: 'DataCloneError' });
  }
  const modified = deriveVisionOccluders(f.packageMap);
  modified[0] = new Proxy(modified[0], {}); Object.freeze(modified);
  assert.equal(isOwnedVisionOccluderCollection(modified), false);
  assert.throws(() => queued({ ...f.input, occluders: modified }), { name: 'DataCloneError' });
  releaseVisionContexts(f.packageMap);
});

test('new private jobs produce the same circle and complete-path Fog as the original clone', () => {
  const f = fixture();
  for (const payload of [f.input.payload, { from: { x: 10, y: 30 }, to: { x: 85, y: 60, elevationMeters: 5 },
    radiusMeters: 40, visionSourceTokenId: 'scout' }]) {
    const input = { ...f.input, payload, sourceRangeMeters: 40 };
    assert.deepEqual(computeFogExploration(queued(input).input), computeFogExploration(legacy(input).input));
  }
  releaseVisionContexts(f.packageMap);
});

test('the production snapshot-enabled queue uses owned geometry while durable metadata stays identical', () => {
  const f = fixture(); let metadata;
  const queue = createLocalExplorationQueue({ getLocalExploration: () => null,
    setLocalExplorationSnapshot: value => { metadata = value; }, setLocalExploration: value => { metadata = structuredClone(value); },
  }, async () => {});
  try {
    queue.enqueue(f.input, 'scene');
    assert.equal(metadata.jobs[0].input.occluders, f.geometry);
    assert.equal(metadata.jobs[0].input.payload.x, 20);
    assert.deepEqual(structuredClone(metadata).jobs[0].input.occluders, structuredClone(f.geometry));
    assert.equal(Object.hasOwn(metadata.jobs[0].input, 'exploredRows'), false);
  } finally { queue.dispose(); releaseVisionContexts(f.packageMap); }
});
