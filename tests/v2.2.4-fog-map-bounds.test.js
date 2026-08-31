import test from 'node:test';
import assert from 'node:assert/strict';

import { BUILT_IN_LANZHOU_MAP } from '../src/map-package/constants.js';
import { exploreFogCircle, exploreFogSweep } from '../src/vision/fog.js';
import { applyWorldOperations as applyServerWorldOperations } from '../src/server/world-operations-entry.js';
import { assertSafeJson, WORLD_LIMITS } from '../deployment/local-server/world-schema.mjs';

const LANZHOU_METRICS = {
  metersPerUnit: 1,
  width: BUILT_IN_LANZHOU_MAP.width,
  height: BUILT_IN_LANZHOU_MAP.height,
};

function worldState() {
  return {
    preferences: {
      worldV2: {
        schemaVersion: 3,
        id: 'world-fog-bounds',
        name: 'Fog bounds',
        ruleset: { id: 'infinite-horror', version: '1.0.0' },
        actors: [],
        statusDefinitions: [],
        activeSceneId: 'scene-lanzhou',
        scenes: [{
          id: 'scene-lanzhou',
          name: 'Lanzhou',
          // Deliberately omit width/height to emulate existing v2.2.x saves.
          mapPackage: { id: BUILT_IN_LANZHOU_MAP.id, version: BUILT_IN_LANZHOU_MAP.version },
          tokens: [],
          markers: [],
          attackAreas: [],
          sceneEvents: [],
          featureStates: {},
          fog: { schemaVersion: 1, cellSizeMeters: 5, exploredByParty: {} },
          settings: {},
        }],
      },
    },
  };
}

function assertWholeLanzhouMap(rows) {
  assert.equal(Object.keys(rows).length, 1000);
  assert.deepEqual(rows['0'], [[0, 1199]]);
  assert.deepEqual(rows['999'], [[0, 1199]]);
  assert.equal(rows['1000'], undefined);
}

test('arbitrarily large Fog circles are reduced to the exact map rectangle', () => {
  const fog = exploreFogCircle({}, 'default', {
    x: 3000,
    y: 2500,
    radiusMeters: 1_000_000_000,
  }, LANZHOU_METRICS);
  assertWholeLanzhouMap(fog.exploredByParty.default.rows);
});

test('large-radius sweeps short-circuit when one endpoint already covers the map', () => {
  const fog = exploreFogSweep({}, 'default', { x: 100, y: 100 }, { x: 5900, y: 4900 }, 1_000_000_000, LANZHOU_METRICS);
  assertWholeLanzhouMap(fog.exploredByParty.default.rows);
});

test('Fog normalization removes rows and columns outside trusted map bounds', () => {
  const rawFog = {
    schemaVersion: 1,
    cellSizeMeters: 5,
    exploredByParty: {
      default: {
        rows: {
          0: [[0, 999999]],
          999: [[0, 999999]],
          1000: [[0, 999999]],
          5000: [[0, 999999]],
        },
      },
    },
  };
  const fog = exploreFogCircle(rawFog, 'default', { x: 0, y: 0, radiusMeters: 0 }, LANZHOU_METRICS);
  const rows = fog.exploredByParty.default.rows;
  assert.deepEqual(rows['0'], [[0, 1199]]);
  assert.deepEqual(rows['999'], [[0, 1199]]);
  assert.equal(rows['1000'], undefined);
  assert.equal(rows['5000'], undefined);
});

test('packaged server operations infer Lanzhou bounds for old Scene references', () => {
  const applied = applyServerWorldOperations(worldState(), [{
    type: 'scene.fog.explore',
    payload: {
      sceneId: 'scene-lanzhou',
      partyId: 'default',
      x: 3000,
      y: 2500,
      radiusMeters: 1_000_000_000,
    },
  }], {
    // This is what server.mjs historically supplied: scale only, no bounds.
    mapMetrics: { metersPerUnit: 1 },
    now: '2026-08-31T00:00:00.000Z',
  });
  assertWholeLanzhouMap(applied.state.preferences.worldV2.scenes[0].fog.exploredByParty.default.rows);
});

test('Fog row persistence allowance is expanded well beyond the previous 4096 rows', () => {
  assert.ok(WORLD_LIMITS.maxFogRowKeys >= 32_768);
  const rows = Object.fromEntries(Array.from({ length: 5000 }, (_, index) => [String(index), [[0, 0]]]));
  const payload = {
    preferences: {
      worldV2: {
        scenes: [{ fog: { exploredByParty: { default: { rows } } } }],
      },
    },
  };
  assert.doesNotThrow(() => assertSafeJson(payload, 'state'));
});
