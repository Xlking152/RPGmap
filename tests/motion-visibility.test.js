import test from 'node:test';
import assert from 'node:assert/strict';
import { motionPathPreciselyVisible } from '../src/server/authority.js';
import { deriveSceneState } from '../src/engine/state.js';
import { deriveVisionOccluders, deriveSceneLightSources, isPathPreciselyVisible } from '../src/spatial/kernel.js';

const map = { width: 120, height: 120, metersPerUnit: 1, features: [], visionOccluders: [
  { id: 'wall', featureId: 'wall', kind: 'wall', polygon: [[40, 0], [45, 0], [45, 100], [40, 100]],
    blockingHeightMeters: 20, passableWhenOpen: true },
] };
const vision = { tokenId: 'scout', x: 20, y: 50, elevationMeters: 0,
  preciseRangeMeters: 100, vagueRangeMeters: 100, lighting: 'normal', lineOfSightEnabled: true, senses: {} };
const motion = { tokenId: 'other', from: { x: 60, y: 50 }, waypoints: [{ x: 65, y: 50 }], to: { x: 70, y: 50 } };

test('shared motion geometry preserves exact visibility across door changes and permissions', () => {
  const scene = { id: 'motion-scene', sceneEvents: [], featureStates: {}, tokens: [], settings: { lighting: 'normal' } };
  for (const open of [false, true, false]) {
    scene.featureStates.wall = { open };
    const occluders = deriveVisionOccluders(map, scene, deriveSceneState(scene.sceneEvents));
    const oracle = isPathPreciselyVisible([motion.from, ...motion.waypoints, motion.to], vision,
      { metersPerUnit: 1, occluders, lights: deriveSceneLightSources(map, scene), ambient: 'normal', lineOfSightEnabled: true });
    assert.equal(motionPathPreciselyVisible({ motion, vision, mapPackage: map, scene }), oracle);
    assert.equal(oracle, open);
  }
  assert.equal(motionPathPreciselyVisible({ motion: { ...motion, tokenId: 'scout' }, vision, mapPackage: map, scene }), true);
});

test('X-ray motion perception does not let a light pass through the wall', () => {
  const scene = { id: 'motion-light', sceneEvents: [], featureStates: {}, settings: { lighting: 'dark' }, tokens: [
    { id: 'lamp', placement: 'map', x: 70, y: 50, elevationMeters: 0,
      light: { enabled: true, rangeMeters: 100, intensity: 4 } },
  ] };
  const left = { tokenId: 'other', from: { x: 25, y: 50 }, to: { x: 30, y: 50 } };
  const xray = { ...vision, senses: { xrayVision: true }, lighting: 'dark' };
  assert.equal(motionPathPreciselyVisible({ motion: left, vision: xray, mapPackage: map, scene }), false);
  scene.featureStates.wall = { open: true };
  assert.equal(motionPathPreciselyVisible({ motion: left, vision: xray, mapPackage: map, scene }), true);
});
