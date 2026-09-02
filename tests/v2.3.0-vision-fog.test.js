import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const visionSource = await readFile(new URL('../src/vision/system.js', import.meta.url), 'utf8');

test('Fog renderer uses separate desaturation and darkness canvases with precise and vague masks', () => {
  assert.match(visionSource, /createCanvas\('saturation', 'saturation'\)/);
  assert.match(visionSource, /createCanvas\('darkness'\)/);
  assert.match(visionSource, /saturation\.globalCompositeOperation = 'destination-out'/);
  assert.match(visionSource, /drawCurrentCircle\(saturation, source\?\.preciseRangeMeters/);
  assert.match(visionSource, /drawCurrentCircle\(darkness, source\?\.vagueRangeMeters/);
  assert.match(visionSource, /rgba\(5,8,10,0\.975\)/);
  assert.match(visionSource, /rgba\(11,16,18,0\.82\)/);
});

test('Fog renderer batches frames, clips bounded invalidations, and ignores persistence-only events', () => {
  assert.match(visionSource, /pendingDirtyBounds/);
  assert.match(visionSource, /context\.rect\(x, y/);
  assert.match(visionSource, /detail => scheduleRender\(detail\?\.dirtyBounds \?\? null\)/);
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
