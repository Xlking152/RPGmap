import test from 'node:test';
import assert from 'node:assert/strict';

import { assertSafeJson, WORLD_LIMITS } from '../deployment/local-server/world-schema.mjs';
import { assertWorldV2 } from '../deployment/local-server/world-v2.mjs';
import { normalizeTokenVision } from '../src/token/access.js';
import { exploreFogCircle } from '../src/vision/fog.js';
import { assertPersistedWorldV2 } from '../src/world/validation.js';

function worldWithVisionOverride(rangeOverrideMeters = 3100) {
  return {
    schemaVersion: 3,
    id: 'world-large-vision',
    name: 'Large vision regression',
    ruleset: { id: 'infinite-horror', version: '1.0.0' },
    actors: [{ id: 'actor-scout', name: 'Scout', type: 'pc', partyId: 'default', system: {}, effects: [] }],
    statusDefinitions: [],
    activeSceneId: 'scene-a',
    scenes: [{
      id: 'scene-a',
      name: 'Scene A',
      mapPackage: { id: 'map-a', version: '1' },
      tokens: [{
        id: 'token-scout',
        actorId: 'actor-scout',
        actorLink: true,
        actorDelta: null,
        placement: 'map',
        x: 3500,
        y: 3500,
        featureId: null,
        diameterMeters: 1,
        rotation: 0,
        elevationFt: 0,
        controllerUserIds: [],
        visibility: { mode: 'party', userIds: [] },
        vision: {
          enabled: true,
          preciseRangeOverrideMeters: rangeOverrideMeters,
          vagueRangeOverrideMeters: rangeOverrideMeters,
          overrideUserIds: [],
        },
        locked: false,
        showName: true,
        effects: [],
      }],
      markers: [],
      attackAreas: [],
      sceneEvents: [],
      featureStates: {},
      fog: { schemaVersion: 1, cellSizeMeters: 5, exploredByParty: {} },
      settings: {},
    }],
  };
}

test('3100 m vision creates more than 256 Fog rows but remains a valid safe World payload', () => {
  const fog = exploreFogCircle({}, 'default', {
    x: 3500,
    y: 3500,
    radiusMeters: 3100,
  }, {
    metersPerUnit: 1,
    width: 7000,
    height: 7000,
  });
  const rows = fog.exploredByParty.default.rows;
  assert.ok(Object.keys(rows).length > 256);
  assert.ok(Object.keys(rows).length < WORLD_LIMITS.maxFogRowKeys);

  const payload = { preferences: { worldV2: { scenes: [{ fog }] } } };
  assert.doesNotThrow(() => assertSafeJson(payload, 'state'));
});

test('ordinary objects keep the 256-key hostile-input limit', () => {
  const oversized = Object.fromEntries(Array.from({ length: WORLD_LIMITS.maxObjectKeys + 1 }, (_, index) => [`k${index}`, index]));
  assert.throws(
    () => assertSafeJson({ ordinary: oversized }, 'state'),
    error => error?.code === 'world_limit' && /too many keys/.test(error.message),
  );
});

test('Token vision overrides are no longer normalized or validated back to 120 m', () => {
  assert.deepEqual(normalizeTokenVision({ rangeOverrideMeters: 3100 }, { actor: { id: 'actor-scout' } }), {
    enabled: true,
    preciseRangeOverrideMeters: 3100,
    vagueRangeOverrideMeters: 3100,
    overrideUserIds: [],
  });
  const world = worldWithVisionOverride(3100);
  assert.doesNotThrow(() => assertPersistedWorldV2(world));
  assert.doesNotThrow(() => assertWorldV2(world));
});

test('Token vague vision cannot be smaller than its precise vision', () => {
  const world = worldWithVisionOverride(80);
  world.scenes[0].tokens[0].vision.vagueRangeOverrideMeters = 40;
  assert.throws(() => assertPersistedWorldV2(world), /vague range cannot be smaller/);
  assert.throws(() => assertWorldV2(world), /vague range cannot be smaller/);
});
