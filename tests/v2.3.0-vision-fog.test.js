import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const visionSource = await readFile(new URL('../src/vision/system.js', import.meta.url), 'utf8');

test('Fog renderer separates static exploration memory from the lightweight perception mist', () => {
  assert.match(visionSource, /createCanvas\('exploration-cache'\)/);
  assert.match(visionSource, /createCanvas\('perception'\)/);
  assert.match(visionSource, /explorationCanvas\.style\.display = 'none'/);
  assert.match(visionSource, /rgba\(8,12,14,0\.96\)/);
  assert.match(visionSource, /rgba\(11,16,18,0\.70\)/);
  assert.match(visionSource, /rgba\(218,226,228,0\.20\)/);
  assert.match(visionSource, /drawCurrentCircle\(perception, source\?\.vagueRangeMeters/);
  assert.match(visionSource, /drawCurrentCircle\(perception, source\?\.preciseRangeMeters/);
  assert.doesNotMatch(visionSource, /grayscale|saturat/i);
});

test('Fog renderer batches frames, clips bounded invalidations, and ignores persistence-only events', () => {
  assert.match(visionSource, /pendingDirtyBounds/);
  assert.match(visionSource, /context\.rect\(x, y/);
  assert.match(visionSource, /scheduleRender\(event\?\.detail\?\.dirtyBounds \?\? null/);
  assert.match(visionSource, /requestAnimationFrame/);
  assert.doesNotMatch(visionSource, /api\.on\?\.\('state:saved'/);
  assert.match(visionSource, /visionSignature\(\) !== lastVisionSignature/);
});

test('local vision consumes dual Token overrides and visual Status capabilities', () => {
  assert.match(visionSource, /preciseRangeOverrideMeters/);
  assert.match(visionSource, /vagueRangeOverrideMeters/);
  assert.match(visionSource, /resolveCapabilities\?\.\(\{ tokenId: token\.id \}\)/);
  assert.match(visionSource, /capabilities\.visionPrecision === 'vague'/);
});
