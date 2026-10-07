import test from 'node:test';
import assert from 'node:assert/strict';
import polygonClipping from 'polygon-clipping';
import { deriveVisionOccluders, inspectLineOfSight, validateSceneOcclusionGeometry,
  occlusionGeometryCacheStats, releaseOcclusionGeometryCache } from '../src/spatial/kernel.js';
import { sceneVisionContext, releaseVisionContexts } from '../src/vision/context.js';
import { polygonArea } from '../src/engine/geometry.js';

const rect = (x, y, width, height) => [[x, y], [x + width, y], [x + width, y + height], [x, y + height]];
const feature = (id, points = rect(4, -4, 2, 8)) => ({ id, category: 'building', geometry: { type: 'polygon', points },
  capabilities: { vision: { occluder: true, blockingHeightMeters: 6, passableWhenDestroyed: true } } });
const mapWith = features => ({ id: 'geometry-cache', version: '1', metersPerUnit: 1, features, lights: [] });
const gap = id => ({ featureId: id, polygon: rect(3, -1, 4, 2) });
const ray = values => inspectLineOfSight({ from: { x: 0, y: 0 }, to: { x: 12, y: 0 }, occluders: values }).clear;
const damageEvent = (id, featureId, polygon) => ({ id, type: 'damage', objectIds: [], clipHits: [{ featureId, polygon }] });

test('unrelated movement, Actor input and Feature edits reuse the affected object geometry', () => {
  const map = mapWith([feature('house'), feature('other', rect(20, -4, 2, 8))]);
  const derived = { clipHits: [gap('house')] };
  const original = polygonClipping.difference;
  let calls = 0;
  polygonClipping.difference = (...args) => { calls += 1; return original(...args); };
  try {
    const first = deriveVisionOccluders(map, { id: 'one', tokens: [{ id: 'token', x: 0 }], featureStates: {} }, derived);
    assert.equal(calls, 1);
    assert.equal(ray(first), true);
    const second = deriveVisionOccluders(map, { id: 'two', tokens: [{ id: 'token', x: 10 }], actors: [{ private: true }],
      featureStates: { other: { vision: { blockingHeightMeters: 12 } } } }, structuredClone(derived));
    assert.equal(calls, 1);
    assert.equal(second[0], first[0]);
    assert.equal(second[1].blockingHeightMeters, 12);
    assert.equal(occlusionGeometryCacheStats(map).largestFeatureVersions, 2);
  } finally { polygonClipping.difference = original; }
});

test('height, configuration, geometry, binding, scale and damage contents invalidate the object cache', () => {
  const map = mapWith([feature('house')]);
  const base = deriveVisionOccluders(map, {}, { clipHits: [gap('house')] })[0];
  const raised = deriveVisionOccluders(map, { featureStates: { house: { vision: { blockingHeightMeters: 12 } } } },
    { clipHits: [gap('house')] })[0];
  assert.notEqual(raised, base);
  assert.equal(raised.blockingHeightMeters, 12);
  map.features[0].geometry.points = rect(6, -4, 2, 8);
  const moved = deriveVisionOccluders(map, {}, { clipHits: [gap('house')] })[0];
  assert.equal(moved.polygon[0][0], 6);
  map.features[0].capabilities.vision.passableWhenDestroyed = false;
  assert.equal(ray(deriveVisionOccluders(map, {}, { clipHits: [gap('house')] })), false);
  map.features[0].capabilities.vision.passableWhenDestroyed = true;
  const bound = deriveVisionOccluders(map, { occlusionShapes: [{ id: 'outline', featureId: 'house', kind: 'building',
    points: rect(8, -4, 2, 8) }] }, { clipHits: [gap('house')] })[0];
  assert.equal(bound.polygon[0][0], 8);
  map.metersPerUnit = 2;
  assert.notEqual(deriveVisionOccluders(map, {}, { clipHits: [gap('house')] })[0], moved);
  const changedDamage = deriveVisionOccluders(map, {}, { clipHits: [{ featureId: 'house', polygon: rect(5, -0.25, 4, 0.5) }] })[0];
  assert.ok(polygonArea(changedDamage.polygons) > polygonArea(moved.polygons));
  assert.equal(occlusionGeometryCacheStats(map).largestFeatureVersions, 2);
});

test('legacy failure retains the complete original solid and strict validation never accepts that cache entry', () => {
  const map = mapWith([feature('house')]);
  const derived = { clipHits: [gap('house')] };
  const original = polygonClipping.difference;
  let calls = 0;
  polygonClipping.difference = () => { calls += 1; throw new Error('Unable to pop() left SweepEvent from queue.'); };
  try {
    const conservative = deriveVisionOccluders(map, {}, derived);
    assert.equal(ray(conservative), false);
    assert.equal(polygonArea(conservative[0].polygons), 16);
    assert.equal(calls, 3);
    assert.equal(ray(deriveVisionOccluders(map, {}, derived)), false);
    assert.equal(calls, 3, 'the bounded legacy cache prevents repeated failing work');
    assert.throws(() => deriveVisionOccluders(map, {}, derived, { strictGeometry: true }), error =>
      error.code === 'geometry_clip_failed' && error.featureId === 'house' && error.occluderId === 'house');
    assert.equal(calls, 3);
  } finally { polygonClipping.difference = original; }
  assert.equal(validateSceneOcclusionGeometry(map, { sceneEvents: [] }, { featureIds: ['house'] }), true);
  assert.equal(occlusionGeometryCacheStats(map).failures, 1);
});

test('new-damage preflight excludes unrelated old failures and includes selected damage', () => {
  const map = mapWith([feature('bad'), feature('new', rect(20, -4, 2, 8))]);
  const scene = { sceneEvents: [damageEvent('old', 'bad', rect(3, -1, 4, 2)), damageEvent('new', 'new', rect(19, -1, 4, 2))] };
  const original = polygonClipping.difference;
  let calls = 0;
  polygonClipping.difference = (...args) => {
    calls += 1;
    if (args[0][0][0][0][0] < 10) throw new Error('Unexpected old geometry failure');
    return original(...args);
  };
  try {
    assert.equal(validateSceneOcclusionGeometry(map, scene, { featureIds: new Set(['new']) }), true);
    assert.equal(calls, 1);
    assert.throws(() => validateSceneOcclusionGeometry(map, scene, { featureIds: ['bad'] }), error =>
      error.code === 'geometry_clip_failed' && error.featureId === 'bad');
  } finally { polygonClipping.difference = original; }
});

test('door preflight includes its host and host failures keep the original wall closed', () => {
  const map = mapWith([]);
  map.occlusionShapes = [{ id: 'host', kind: 'wall', points: rect(4, -4, 2, 8) },
    { id: 'door', kind: 'door', hostShapeId: 'host', points: rect(3, -1, 4, 2) }];
  const scene = { featureStates: { door: { open: true } }, sceneEvents: [] };
  assert.equal(ray(deriveVisionOccluders(map, scene)), true);
  releaseOcclusionGeometryCache(map);
  const original = polygonClipping.difference;
  polygonClipping.difference = () => { throw new Error('Unable to pop() left SweepEvent from queue.'); };
  try {
    assert.equal(ray(deriveVisionOccluders(map, scene)), false);
    assert.throws(() => validateSceneOcclusionGeometry(map, scene, { featureIds: ['door'] }), error =>
      error.code === 'geometry_clip_failed' && error.featureId === 'host');
  } finally { polygonClipping.difference = original; }
});

test('cache slots stay relative to each object when unrelated blockers and doors change order', () => {
  const map = mapWith([]);
  const a = { id: 'unrelated', polygon: rect(20, -4, 2, 8) };
  const first = { id: 'left', featureId: 'shared', polygon: rect(4, -4, 2, 2) };
  const second = { id: 'right', featureId: 'shared', polygon: rect(4, 2, 2, 2) };
  map.visionOccluders = [a, first, second];
  const prior = deriveVisionOccluders(map);
  map.visionOccluders = [first, second];
  const later = deriveVisionOccluders(map);
  assert.equal(later[0], prior[1]);
  assert.equal(later[1], prior[2]);
  map.occlusionShapes = [{ id: 'host', kind: 'wall', points: rect(4, -10, 2, 20) },
    { id: 'other-host', kind: 'wall', points: rect(20, -10, 2, 20) },
    { id: 'other-door', kind: 'door', hostShapeId: 'other-host', points: rect(19, -1, 4, 2) },
    { id: 'door-a', kind: 'door', hostShapeId: 'host', points: rect(3, -4, 4, 2) },
    { id: 'door-b', kind: 'door', hostShapeId: 'host', points: rect(3, 2, 4, 2) }];
  const cut = deriveVisionOccluders(map, { featureStates: { 'door-a': { open: true }, 'door-b': { open: true } } })
    .find(value => value.id === 'host');
  map.occlusionShapes = map.occlusionShapes.filter(shape => shape.id !== 'other-door');
  const recut = deriveVisionOccluders(map, { featureStates: { 'door-a': { open: true }, 'door-b': { open: true } } })
    .find(value => value.id === 'host');
  assert.deepEqual(recut.polygons, cut.polygons);
});

test('public map cache is bounded to 512 entries and two versions per object and releases with vision contexts', () => {
  const map = mapWith(Array.from({ length: 513 }, (_, index) => feature(`house-${index}`, rect(index * 10, 0, 2, 8))));
  deriveVisionOccluders(map);
  assert.equal(occlusionGeometryCacheStats(map).entries, 512);
  assert.equal(occlusionGeometryCacheStats(map).evictions, 1);
  for (const height of [6, 8, 10, 12]) deriveVisionOccluders(map, {
    featureStates: { 'house-512': { vision: { blockingHeightMeters: height } } },
  }, null, { featureIds: ['house-512'] });
  const stats = occlusionGeometryCacheStats(map);
  assert.ok(stats.entries <= 512);
  assert.equal(stats.largestFeatureVersions, 2);
  const first = sceneVisionContext(map, { id: 'scene' });
  releaseVisionContexts(map);
  assert.equal(occlusionGeometryCacheStats(map).entries, 0);
  assert.notEqual(sceneVisionContext(map, { id: 'scene' }).occluders, first.occluders);
});
