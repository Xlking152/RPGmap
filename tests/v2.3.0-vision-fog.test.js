import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { classifyVisionChange } from '../src/vision/invalidation.js';

const visionSource = await readFile(new URL('../src/vision/system.js', import.meta.url), 'utf8');

test('Fog renderer separates static exploration memory from the lightweight perception mist', () => {
  assert.match(visionSource, /createCanvas\('exploration-cache'\)/);
  assert.match(visionSource, /createCanvas\('perception'\)/);
  assert.match(visionSource, /explorationCanvas\.style\.display = 'none'/);
  assert.match(visionSource, /rgba\(8,12,14,0\.96\)/);
  assert.match(visionSource, /rgba\(11,16,18,0\.70\)/);
  assert.match(visionSource, /rgba\(218,226,228,0\.20\)/);
  assert.match(visionSource, /const drawCurrent = \(context, rawRange, kind\) =>/);
  assert.match(visionSource, /computeVisibilityRows/);
  assert.match(visionSource, /drawCurrentCircle\(context, rangeMeters\)/);
  assert.match(visionSource, /const vagueRange = Number\(source\?\.vagueGroundRangeMeters/);
  assert.match(visionSource, /const preciseRange = Number\(source\?\.preciseGroundRangeMeters/);
  assert.match(visionSource, /drawCurrent\(perception, vagueRange, 'vague'\)/);
  assert.match(visionSource, /drawCurrent\(perception, preciseRange, 'precise'\)/);
  assert.doesNotMatch(visionSource, /grayscale|saturat/i);
});

test('Fog renderer batches frames, clips bounded invalidations, and ignores persistence-only events', () => {
  assert.match(visionSource, /pendingDirtyBounds/);
  assert.match(visionSource, /perception\.rect\(x, y/);
  assert.match(visionSource, /requestAnimationFrame/);
  assert.doesNotMatch(visionSource, /api\.on\?\.\('state:saved'/);
  const scene = { id: 's', tokens: [{ id: 'pc', actorId: 'actor', placement: 'map', x: 0, y: 0 }],
    fog: { cellSizeMeters: 5, exploredByParty: { party: { rows: { 0: [[0, 0]] } } } } };
  const before = { preferences: { worldV2: { activeSceneId: 's', actors: [], scenes: [scene] },
    audienceVision: { partyIds: ['party'] } } };
  const after = { ...before, preferences: { ...before.preferences, worldV2: { ...before.preferences.worldV2,
    scenes: [{ ...scene, fog: { ...scene.fog, exploredByParty: { party: { rows: { 0: [[0, 1]] } } } } }] } } };
  const dirtyBounds = { minX: 5, minY: 0, maxX: 10, maxY: 5 };
  const options = { beforeState: before, afterState: after, sourceTokenId: 'pc', connected: true };
  assert.deepEqual(classifyVisionChange({ ...options,
    changeSet: { fog: [{ sceneId: 's', dirtyBounds }] } }).dirtyBounds, dirtyBounds);
  assert.equal(classifyVisionChange({ ...options, afterState: before, changeSet: {} }).render, false);
});

test('local vision consumes dual Token overrides and visual Status capabilities', () => {
  assert.match(visionSource, /preciseRangeOverrideMeters/);
  assert.match(visionSource, /vagueRangeOverrideMeters/);
  assert.match(visionSource, /resolveCapabilities\?\.\(\{ tokenId: token\.id \}\)/);
  assert.match(visionSource, /capabilities\.visionPrecision === 'vague'/);
});
