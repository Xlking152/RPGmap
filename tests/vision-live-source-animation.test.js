import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { resolveLiveAudienceVision, resolveVisionAudience } from '../src/vision/system.js';

const audience = {
  schemaVersion: 1,
  source: {
    tokenId: 'scout', x: 10, y: 20, elevationMeters: 0,
    preciseRangeMeters: 30, vagueRangeMeters: 60,
  },
  partyIds: ['party-a'],
};
const scene = {
  tokens: [{ id: 'scout', placement: 'map', x: 40, y: 50, elevationMeters: 2 }],
};

test('disconnecting uses current offline vision instead of a retained server audience', () => {
  const local = { ...audience, source: { ...audience.source, preciseRangeMeters: 1000, vagueRangeMeters: 1000 } };
  assert.equal(resolveVisionAudience(false, audience, local), local);
  assert.equal(resolveVisionAudience(true, audience, local), audience);
  assert.equal(resolveVisionAudience(true, null, local), null);
});

test('live audience vision follows the rendered Token point during movement animation', () => {
  const resolved = resolveLiveAudienceVision(audience, scene, 'scout', {
    x: 32.5, y: 41.25, elevationMeters: 1.5,
  });
  assert.equal(resolved.source.tokenId, 'scout');
  assert.equal(resolved.source.x, 32.5);
  assert.equal(resolved.source.y, 41.25);
  assert.equal(resolved.source.elevationMeters, 1.5);
  assert.equal(resolved.source.preciseRangeMeters, 30);
  assert.equal(resolved.source.vagueRangeMeters, 60);
});

test('live audience vision falls back to authoritative coordinates without a usable rendered point', () => {
  const resolved = resolveLiveAudienceVision(audience, scene, 'scout', { x: Number.NaN, y: 99 });
  assert.equal(resolved.source.x, 40);
  assert.equal(resolved.source.y, 50);
  assert.equal(resolved.source.elevationMeters, 2);
});

test('offline and LAN movement wait for authoritative commit before visual animation', async () => {
  const source = await readFile(new URL('../src/movement/fast-path.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /predictTokenVisualRoute|rollbackTokenVisual/);
});
