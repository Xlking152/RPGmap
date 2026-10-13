import test from 'node:test';
import assert from 'node:assert/strict';

import lanzhouData from '../maps/lanzhou/runtime.json' with { type: 'json' };
import { createMinimalReferencePackage } from '../maps/minimal/package.js';
import { verifiedServerMapFixture } from './helpers/server-map-fixture.js';
import { exploreFogCircle, exploreFogSweep } from '../src/vision/fog.js';
import { applyWorldOperations as applyServerWorldOperations } from '../src/server/world-operations-entry.js';
import { assertSafeJson, WORLD_LIMITS } from '../deployment/local-server/world-schema.mjs';

const lanzhou = verifiedServerMapFixture(lanzhouData);
const LANZHOU_METRICS = {
  metersPerUnit: 1,
  width: lanzhou.width,
  height: lanzhou.height,
};

function worldState(map = lanzhou) {
  return {
    preferences: {
      worldV2: {
        schemaVersion: 3,
        id: 'world-fog-bounds',
        name: 'Fog bounds',
        ruleset: { id: 'infinite-horror', version: '1.1.0' },
        actors: [],
        statusDefinitions: [],
        activeSceneId: 'scene-lanzhou',
        scenes: [{
          id: 'scene-lanzhou',
          name: 'Lanzhou',
          // Deliberately omit width/height to emulate existing v2.2.x saves.
          mapPackage: { id: map.id, version: map.version },
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

function exploreWholeMap(map, mapForScene) {
  return applyServerWorldOperations(worldState(map), [{
    type: 'scene.fog.explore',
    payload: {
      sceneId: 'scene-lanzhou',
      partyId: 'default',
      x: 3000,
      y: 2500,
      radiusMeters: 1_000_000_000,
      // A viewpoint above the maps' finite blockers makes the rectangle an
      // exact expectation while retaining the real height-aware LOS path.
      elevationMeters: 1000,
    },
  }], {
    // Existing saves need not contain dimensions: the installed, exact map
    // supplies them to the server rather than an ID-specific fallback.
    mapMetrics: { metersPerUnit: 1 },
    mapForScene,
    now: '2026-08-31T00:00:00.000Z',
  });
}

test('packaged server operations obtain legacy Scene bounds from a verified external Lanzhou map', () => {
  const applied = exploreWholeMap(lanzhou, scene => {
    assert.deepEqual(scene.mapPackage, { id: lanzhou.id, version: lanzhou.version });
    return lanzhou;
  });
  assertWholeLanzhouMap(applied.state.preferences.worldV2.scenes[0].fog.exploredByParty.default.rows);
});

test('external map bounds determine Fog clipping for other map identities and versions', () => {
  const source = createMinimalReferencePackage();
  for (const version of [source.version, '2.0.0']) {
    const map = verifiedServerMapFixture({ ...source, version,
      width: version === source.version ? 1000 : 1200,
      height: version === source.version ? 800 : 900 });
    const applied = exploreWholeMap(map, scene => {
      assert.deepEqual(scene.mapPackage, { id: map.id, version });
      return map;
    });
    const rows = applied.state.preferences.worldV2.scenes[0].fog.exploredByParty.default.rows;
    const rowCount = map.height / 5, lastColumn = map.width / 5 - 1;
    assert.equal(Object.keys(rows).length, rowCount);
    assert.deepEqual(rows['0'], [[0, lastColumn]]);
    assert.deepEqual(rows[String(rowCount - 1)], [[0, lastColumn]]);
    assert.equal(rows[String(rowCount)], undefined);
  }
});

test('a missing installed map fails Fog operations instead of guessing Lanzhou bounds', () => {
  assert.throws(() => exploreWholeMap(lanzhou, () => null), { code: 'map_package_not_found' });
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
