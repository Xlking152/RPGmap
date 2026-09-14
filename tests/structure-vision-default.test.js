import test from 'node:test';
import assert from 'node:assert/strict';

import { prepareMapPackage } from '../src/map-package/contract.js';
import { deriveVisionOccluders, inspectLineOfSight } from '../src/spatial/kernel.js';

const BLOCKING_POLYGON = Object.freeze([
  Object.freeze([4, -2]),
  Object.freeze([6, -2]),
  Object.freeze([6, 2]),
  Object.freeze([4, 2]),
]);

function packageWithFeature(feature) {
  return prepareMapPackage({
    id: 'structure-vision-test',
    version: '1.0.0',
    width: 100,
    height: 100,
    layers: ['structure'],
    svg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
    features: [feature],
  }, { source: 'test' });
}

function structureFeature(overrides = {}) {
  const capabilities = overrides.capabilities || {};
  return {
    id: 'building-a',
    category: 'building',
    geometry: { type: 'polygon', points: BLOCKING_POLYGON },
    ...overrides,
    capabilities: {
      ...capabilities,
      navigation: {
        blocks: true,
        collisionGroup: 'structure',
        blockingHeightMeters: 6,
        passableWhenOpen: true,
        passableWhenDestroyed: true,
        ...(capabilities.navigation || {}),
      },
    },
  };
}

test('structure navigation blockers default to matching vision occluders', () => {
  const mapPackage = packageWithFeature(structureFeature());
  const feature = mapPackage.features[0];

  assert.equal(feature.capabilities.vision?.occluder, true);
  assert.equal(feature.capabilities.vision?.blockingHeightMeters, 6);
  assert.deepEqual(feature.capabilities.vision?.polygon, BLOCKING_POLYGON);
  assert.equal(feature.capabilities.vision?.passableWhenOpen, true);
  assert.equal(feature.capabilities.vision?.passableWhenDestroyed, true);

  const occluders = deriveVisionOccluders(mapPackage);
  assert.equal(occluders.length, 1);
  assert.equal(inspectLineOfSight({
    from: { x: 0, y: 0, elevationMeters: 0 },
    to: { x: 10, y: 0, elevationMeters: 0 },
    occluders,
  }).clear, false);
});

test('inferred structure vision follows navigation open and destroyed passage states', () => {
  const mapPackage = packageWithFeature(structureFeature());

  assert.equal(deriveVisionOccluders(mapPackage, {
    featureStates: { 'building-a': { open: true } },
  }).length, 0);

  assert.equal(deriveVisionOccluders(mapPackage, null, {
    destroyedObjectIds: ['building-a'],
    clipHits: [],
  }).length, 0);
});

test('vision.occluder false explicitly opts a structure blocker out of sight blocking', () => {
  const mapPackage = packageWithFeature(structureFeature({
    capabilities: { vision: { occluder: false } },
  }));

  assert.equal(mapPackage.features[0].capabilities.vision, null);
  assert.deepEqual(deriveVisionOccluders(mapPackage), []);
});

test('non-structure navigation blockers do not become vision occluders implicitly', () => {
  const mapPackage = packageWithFeature(structureFeature({
    capabilities: {
      navigation: { collisionGroup: 'terrain' },
    },
  }));

  assert.equal(mapPackage.features[0].capabilities.navigation.blocks, true);
  assert.equal(mapPackage.features[0].capabilities.vision, null);
  assert.deepEqual(deriveVisionOccluders(mapPackage), []);
});
