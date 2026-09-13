import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareMapPackage } from '../src/map-package/index.js';
import { normalizeSceneToken } from '../src/token/model.js';

test('MapPackage normalizes bounded static light descriptions', () => {
  const map = prepareMapPackage({
    id: 'map', version: '1', width: 10, height: 10,
    layers: ['base'], svg: '<svg></svg>', features: [],
    lights: [{ id: 'lamp', x: 2, y: 3, elevationMeters: 4, rangeMeters: 12, intensity: 2, color: '#ffeeaa' }],
  });
  assert.deepEqual(map.lights[0], {
    id: 'lamp', x: 2, y: 3, elevationMeters: 4, rangeMeters: 12,
    intensity: 2, color: '#ffeeaa', enabled: true, occlusion: 'scene',
  });
  assert.throws(() => prepareMapPackage({
    id: 'bad', version: '1', width: 10, height: 10,
    layers: ['base'], svg: '<svg></svg>', features: [],
    lights: [{ id: 'bad', x: 0, y: 0, rangeMeters: -1 }],
  }), /rangeMeters/);
});

test('Token light state is canonical, bounded and independent of Token vision', () => {
  const token = normalizeSceneToken({
    id: 'token', actorId: 'actor', placement: 'map', x: 1, y: 2,
    light: { enabled: true, rangeMeters: 30, intensity: 9, color: 'red', elevationOffsetMeters: 2 },
  }, { actor: { id: 'actor', type: 'pc', partyId: 'party' } });
  assert.deepEqual(token.light, {
    enabled: true, rangeMeters: 30, intensity: 4, color: '#fff3c4',
    elevationOffsetMeters: 2, occlusion: 'scene',
  });
  assert.equal(token.vision.enabled, true);
});
