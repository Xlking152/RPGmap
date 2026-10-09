import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveVisionOccluders, occlusionGeometryCacheStats, releaseOcclusionGeometryCache } from '../src/spatial/kernel.js';
import { deriveVisionOccluders as before } from './fixtures/kernel-before-pristine-reuse.js';
import { isImmutableVisionData } from '../src/vision/immutable-data.js';

const rect = (x, y, w, h) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
function fixture() {
  const map = freeze({ id: 'pristine', version: '1', metersPerUnit: 1, features: [],
    visionOccluders: [
      { id: 'house', kind: 'building', polygon: rect(5, 2, 10, 12),
        polygons: [[rect(5, 2, 10, 12), rect(8, 5, 4, 4)]], blockingHeightMeters: 8 },
      { id: 'wall', polygon: [[20, 0], [21, 0], [21, 20], [20, 20]], blockingHeightMeters: null },
    ] });
  assert.equal(isImmutableVisionData(map), true);
  return map;
}

test('pristine reuse matches the frozen pre-change kernel across damage, restoration, height and holes', () => {
  const map = fixture();
  for (const [scene, derived] of [
    [{}, {}], [{}, {}],
    [{}, { clipHits: [{ featureId: 'house', polygon: rect(4, 6, 12, 2) }] }],
    [{}, { destroyedObjectIds: ['house'] }], [{}, {}],
    [{ featureStates: { house: { vision: { blockingHeightMeters: 3 } } } }, {}],
    [{ featureStates: { house: { vision: { occluder: false } } } }, {}], [{}, {}],
  ]) assert.deepEqual(deriveVisionOccluders(map, scene, derived), before(map, scene, derived));
  const stats = occlusionGeometryCacheStats(map);
  assert.ok(stats.normalizationHits >= 6);
  assert.ok(stats.largestFeatureVersions <= 2);
  releaseOcclusionGeometryCache(map);
  assert.equal(occlusionGeometryCacheStats(map).normalizationHits, 0);
});

test('mutable and unproved public geometry keeps normalization and current nested changes', () => {
  const map = structuredClone(fixture());
  deriveVisionOccluders(map); deriveVisionOccluders(map);
  assert.equal(occlusionGeometryCacheStats(map).normalizationHits, 0);
  map.visionOccluders[0].polygon[0][0] = 4;
  map.visionOccluders[0].polygons[0][0][0][0] = 4;
  assert.deepEqual(deriveVisionOccluders(map), before(map));
});

test('new scalar parameters and legacy aliases never borrow another normalized blocker', () => {
  const original = fixture();
  const map = { ...original, visionOccluders: [...original.visionOccluders] };
  deriveVisionOccluders(map);
  for (const change of [
    { id: 'another' }, { featureId: 'bound' }, { shapeId: 'shape' }, { kind: 'door' },
    { blockingHeightMeters: 'unbounded' }, { blockingHeightMeters: 0 },
    { passableWhenOpen: true }, { passableWhenDestroyed: false },
    { polygon: undefined, blockingPolygon: original.visionOccluders[0].polygon },
  ]) {
    map.visionOccluders[0] = { ...original.visionOccluders[0], ...change };
    assert.deepEqual(deriveVisionOccluders(map), before(map));
  }
});

test('extended coordinate arrays and altered geometry methods retain original normalization behavior', () => {
  const map = fixture(); deriveVisionOccluders(map); deriveVisionOccluders(map);
  const count = occlusionGeometryCacheStats(map).normalizationHits;
  const nativeSlice = Array.prototype.slice;
  Array.prototype.slice = function (...args) { return nativeSlice.apply(this, args); };
  try { assert.deepEqual(deriveVisionOccluders(map), before(map)); }
  finally { Array.prototype.slice = nativeSlice; }
  assert.equal(occlusionGeometryCacheStats(map).normalizationHits, count);
  const extended = structuredClone(map); extended.visionOccluders[0].polygon.extension = 'kept';
  freeze(extended); isImmutableVisionData(extended);
  deriveVisionOccluders(extended); deriveVisionOccluders(extended);
  assert.deepEqual(deriveVisionOccluders(extended), before(extended));
  assert.equal(occlusionGeometryCacheStats(extended).normalizationHits, 2, 'only the ordinary wall qualifies');
});

test('pristine facts stay inside the existing 512-entry and two-version cache', () => {
  const map = fixture();
  for (let height = 0; height < 8; height++) deriveVisionOccluders(map, { featureStates: { house: { vision: { blockingHeightMeters: height } } } });
  const stats = occlusionGeometryCacheStats(map);
  assert.equal(stats.largestFeatureVersions, 2); assert.equal(stats.entries, 3);
  releaseOcclusionGeometryCache(map);
  deriveVisionOccluders(map);
  assert.equal(occlusionGeometryCacheStats(map).normalizationHits, 0);
});

test('frozen Proxy coordinate wrappers cannot acquire pristine normalization reuse', () => {
  const original = fixture();
  let offset = 0;
  const polygon = new Proxy(original.visionOccluders[0].polygon, { get(target, key, receiver) {
    if (key === 'map') return callback => Array.prototype.map.call(target, point => callback([point[0] + offset, point[1]]));
    return Reflect.get(target, key, receiver);
  } });
  const map = { ...original, visionOccluders: [{ ...original.visionOccluders[0], polygon, polygons: undefined }] };
  assert.equal(isImmutableVisionData(polygon), true, 'a structural frozen proof alone does not reject this Proxy');
  deriveVisionOccluders(map);
  for (offset of [0, 2, 4]) assert.deepEqual(deriveVisionOccluders(map), before(map));
  assert.equal(occlusionGeometryCacheStats(map).normalizationHits, 0);
});

test('inherited input getters preserve the pre-change read count and result', () => {
  const map = fixture(); deriveVisionOccluders(map); deriveVisionOccluders(map); before(map); before(map);
  let reads = 0;
  Object.defineProperty(Object.prototype, 'heightMeters', { configurable: true, get() { reads++; return 6; } });
  try {
    const current = deriveVisionOccluders(map), currentReads = reads;
    reads = 0;
    const previous = before(map);
    assert.deepEqual(current, previous);
    assert.equal(currentReads, reads);
  } finally { delete Object.prototype.heightMeters; }
});
