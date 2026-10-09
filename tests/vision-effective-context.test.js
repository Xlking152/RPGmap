import test from 'node:test';
import assert from 'node:assert/strict';
import { sceneVisionContext, releaseVisionContexts } from '../src/vision/context.js';
import { deriveVisionOccluders, inspectLineOfSight } from '../src/spatial/kernel.js';
import { deriveSceneState } from '../src/engine/state.js';

function frozen(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(frozen); Object.freeze(value); }
  return value;
}
const map = () => ({ id: 'map', version: '1', width: 200, height: 200, metersPerUnit: 1, features: [], lights: [],
  visionOccluders: [{ id: 'wall', polygon: [[10, 0], [20, 0], [20, 100], [10, 100]],
    blockingHeightMeters: 8, passableWhenOpen: true, passableWhenDestroyed: true },
  { id: 'other', polygon: [[40, 0], [45, 0], [45, 100], [40, 100]], blockingHeightMeters: 10 }] });
const scene = () => ({ id: 'scene', featureStates: {}, sceneEvents: [], occlusionShapes: [], tokens: [] });
function assertKernel(packageMap, current, actual) {
  const full = deriveVisionOccluders(packageMap, current, deriveSceneState(current.sceneEvents));
  assert.deepEqual(actual.occluders, full);
  for (const x of [5, 15, 25, 50]) for (const y of [0, 50, 100]) for (const height of [0, 8, 20]) {
    const input = { from: { x, y, elevationMeters: height }, to: { x: 100, y, elevationMeters: 0 }, metersPerUnit: 1 };
    assert.deepEqual(inspectLineOfSight({ ...input, occluders: actual.occluders }), inspectLineOfSight({ ...input, occluders: full }));
  }
}

test('repeated immutable destruction/restoration reuses two exact effective contexts as history grows', () => {
  const packageMap = frozen(map()); let current = frozen(scene());
  const intact = sceneVisionContext(packageMap, current); let damaged;
  for (let i = 0; i < 24; i++) {
    current = frozen({ ...current, sceneEvents: [...current.sceneEvents, { id: `damage-${i}`, type: 'damage', objectIds: ['wall'] }] });
    const value = sceneVisionContext(packageMap, current); damaged ||= value;
    assert.equal(value.occluders, damaged.occluders); assert.equal(value.geometryVersion, damaged.geometryVersion);
    assert.equal(value.cacheHit, i !== 0); assert.equal(value.cacheSize, 2); assertKernel(packageMap, current, value);
    current = frozen({ ...current, sceneEvents: [...current.sceneEvents, { id: `restore-${i}`, type: 'restore', featureIds: ['wall'] }] });
    const restored = sceneVisionContext(packageMap, current);
    assert.equal(restored.occluders, intact.occluders); assert.equal(restored.geometryVersion, intact.geometryVersion);
    assert.equal(restored.cacheHit, true); assertKernel(packageMap, current, restored);
  }
  releaseVisionContexts(packageMap); assert.equal(sceneVisionContext(packageMap, current).cacheHit, false);
});

test('effective geometry retains exact partial damage, undo, height, doors and scene shapes', () => {
  const packageMap = frozen(map()), base = frozen(scene()), intact = sceneVisionContext(packageMap, base);
  const partial = { id: 'cut', type: 'damage', objectIds: [],
    clipHits: [{ featureId: 'wall', polygon: [[5, 30], [25, 30], [25, 70], [5, 70]] }] };
  const damaged = frozen({ ...base, sceneEvents: [partial] });
  const cut = sceneVisionContext(packageMap, damaged); assertKernel(packageMap, damaged, cut);
  const crater = frozen({ ...damaged, sceneEvents: [...damaged.sceneEvents,
    { id: 'crater', type: 'damage', objectIds: [], craterPolygon: [[100, 100], [110, 100], [110, 110], [100, 110]] }] });
  assert.equal(sceneVisionContext(packageMap, crater).occluders, cut.occluders);
  const undo = frozen({ ...damaged, sceneEvents: [...damaged.sceneEvents, { id: 'undo', type: 'undo', targetEventId: 'cut' }] });
  assert.equal(sceneVisionContext(packageMap, undo).occluders, intact.occluders);
  for (const patch of [{ featureStates: { wall: { open: true } } },
    { featureStates: { wall: { vision: { blockingHeightMeters: 2 } } } },
    { featureStates: { wall: { vision: { occluder: false } } } },
    { occlusionShapes: [{ id: 'custom', kind: 'wall', points: [[70, 0], [75, 0], [75, 50], [70, 50]] }] }]) {
    const changed = frozen({ ...damaged, ...patch }), value = sceneVisionContext(packageMap, changed);
    assert.notEqual(value.geometryVersion, cut.geometryVersion); assertKernel(packageMap, changed, value);
  }
  const exact = frozen({ ...damaged, sceneEvents: [{ ...partial, clipHits: [{ featureId: 'wall',
    polygon: [[5, 30], [25, 30], [25, 70.000000001], [5, 70]] }] }] });
  assertKernel(packageMap, exact, sceneVisionContext(packageMap, exact));
  assert.throws(() => sceneVisionContext(packageMap, frozen({ ...base,
    sceneEvents: [{ id: 'bad', type: 'undo', targetEventId: 'missing' }] })), /undo target/);
  releaseVisionContexts(packageMap);
});

test('mutable histories keep the complete content fallback and mutable maps still invalidate frozen contexts', () => {
  const packageMap = map(), current = scene(), initial = sceneVisionContext(packageMap, current);
  current.sceneEvents.push({ id: 'restore', type: 'restore', featureIds: ['wall'] });
  const edited = sceneVisionContext(packageMap, current);
  assert.notEqual(edited.geometryVersion, initial.geometryVersion); assertKernel(packageMap, current, edited);
  const fixed = frozen(structuredClone(current)), first = sceneVisionContext(packageMap, fixed);
  packageMap.visionOccluders[0].polygon[0][0] = 7;
  const moved = sceneVisionContext(packageMap, fixed);
  assert.notEqual(moved.geometryVersion, first.geometryVersion); assertKernel(packageMap, fixed, moved);
  releaseVisionContexts(packageMap);
});
