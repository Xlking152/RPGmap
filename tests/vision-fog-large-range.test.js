import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { resolveInfiniteHorrorDetection } from '../src/rulesets/infinite-horror/detection.js';
import { exploreFogCircle, isFogCellExplored } from '../src/vision/fog.js';
import { applyWorldOperations } from '../src/world/operations.js';

const operationsSource = await readFile(new URL('../src/world/operations.js', import.meta.url), 'utf8');

function state() {
  return {
    preferences: {
      worldV2: {
        schemaVersion: 3,
        id: 'world-large-vision',
        name: 'Large Vision',
        ruleset: { id: 'infinite-horror', version: '1.0.0' },
        actors: [],
        statusDefinitions: [],
        activeSceneId: 'scene-a',
        scenes: [{
          id: 'scene-a',
          name: 'Scene A',
          mapPackage: { id: 'map-a', version: '1' },
          tokens: [],
          markers: [],
          attackAreas: [],
          sceneEvents: [],
          featureStates: {},
          fog: {},
          settings: {},
        }],
      },
    },
  };
}

const mapMetrics = { metersPerUnit: 1, width: 500, height: 500 };

test('explicit Ruleset detection ranges are not truncated to 120 metres', () => {
  const configured = resolveInfiniteHorrorDetection({
    form: { detection: { configured: true, preciseRangeMeters: 300, vagueRangeMeters: 450, senses: {} } },
  });
  assert.equal(configured.preciseRangeMeters, 300);
  assert.equal(configured.vagueRangeMeters, 450);

  const overridden = resolveInfiniteHorrorDetection({
    form: { detection: { configured: true, preciseRangeMeters: 30, vagueRangeMeters: 60, senses: {} } },
    runtime: { detectionOverrides: { preciseRangeMeters: 200, vagueRangeMeters: 350 } },
  });
  assert.equal(overridden.preciseRangeMeters, 200);
  assert.equal(overridden.vagueRangeMeters, 350);
});

test('World Fog operations accept explore and hide radii above 120 metres', () => {
  let current = applyWorldOperations(state(), [{
    type: 'scene.fog.explore',
    payload: { sceneId: 'scene-a', partyId: 'party-a', x: 250, y: 250, radiusMeters: 300 },
  }], { mapMetrics, now: '2026-01-01T00:00:00.000Z' }).state;

  let fog = current.preferences.worldV2.scenes[0].fog;
  assert.equal(isFogCellExplored(fog, 'party-a', { x: 490, y: 250 }, mapMetrics), true);

  current = applyWorldOperations(current, [{
    type: 'scene.fog.hide',
    payload: { sceneId: 'scene-a', partyId: 'party-a', x: 250, y: 250, radiusMeters: 300 },
  }], { mapMetrics, now: '2026-01-01T00:00:01.000Z' }).state;

  fog = current.preferences.worldV2.scenes[0].fog;
  assert.equal(isFogCellExplored(fog, 'party-a', { x: 490, y: 250 }, mapMetrics), false);
  assert.doesNotMatch(operationsSource, /Fog radius exceeds 120 metres|MAX_FOG_RADIUS_METERS/);
});

test('extreme Fog radii are clipped to useful map work instead of becoming a rules limit', () => {
  const fog = exploreFogCircle({}, 'party-a', {
    x: 250,
    y: 250,
    radiusMeters: 1_000_000_000,
  }, mapMetrics);

  assert.equal(isFogCellExplored(fog, 'party-a', { x: 2.5, y: 2.5 }, mapMetrics), true);
  assert.equal(isFogCellExplored(fog, 'party-a', { x: 497.5, y: 497.5 }, mapMetrics), true);
});
