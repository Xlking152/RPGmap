import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createNavigationBase,
  createNavigationGrid,
  inspectDirectNavigationPath,
} from '../src/engine/navigation.js';
import { deriveSceneState } from '../src/engine/state.js';
import { createMovementTokenRuntimeSystem } from '../src/movement/token-runtime.js';

function wallFeature(id, minX, maxX) {
  return {
    id,
    geometry: { points: [[minX, 0], [maxX, 0], [maxX, 20], [minX, 20]] },
    capabilities: { navigation: { blocks: true, collisionGroup: 'structure' } },
  };
}

function mapPackage({ secondWall = false } = {}) {
  return {
    id: 'v2.4.8-collision-test',
    version: '1',
    width: 20,
    height: 20,
    metersPerUnit: 1,
    navigation: { bridgeFeatureIds: [] },
    roadBuffers: [],
    liquidBodies: [],
    floodRules: {},
    features: [
      wallFeature('wall-a', 5, 6),
      ...(secondWall ? [wallFeature('wall-b', 8, 9)] : []),
    ],
  };
}

function navigation(options = {}) {
  const map = mapPackage(options);
  return createNavigationGrid(map, deriveSceneState([]), createNavigationBase(map), {
    appState: { preferences: { featureStates: {} }, sceneEvents: [] },
    moverContext: { tokenId: 'token-a', elevationMeters: 0, diameterMeters: 1, collisionBypassGroups: [] },
  });
}

function productionPlacementInspector(map) {
  const scene = { id: 'scene-a', tokens: [], markers: [], attackAreas: [], sceneEvents: [], settings: {} };
  const world = { id: 'world-a', activeSceneId: scene.id, actors: [], statusDefinitions: [], scenes: [scene] };
  const api = {
    mapPackage: map,
    getState: () => ({ preferences: { featureStates: {} }, sceneEvents: [] }),
    tokens: { get: () => null },
    world: {
      get: () => world,
      getActiveScene: () => scene,
      commit: async () => world,
    },
    on: () => () => {},
    emit: () => {},
  };
  createMovementTokenRuntimeSystem().register(api);
  return api.inspectTokenPlacement;
}

test('1 m Token may sit flush against a blocked neighbouring cell without false footprint collision', () => {
  const result = inspectDirectNavigationPath(
    navigation(),
    { x: 4.5, y: 10.5 },
    { x: 4.5, y: 10.5 },
    { diameterMeters: 1, allowBlockedStartEscape: false },
  );
  assert.equal(result.valid, true);
});

test('legacy Token already inside a blocker may leave the initial blocked prefix', () => {
  const result = inspectDirectNavigationPath(
    navigation(),
    { x: 5.5, y: 10.5 },
    { x: 7.5, y: 10.5 },
    { diameterMeters: 1 },
  );
  assert.equal(result.valid, true);
  assert.equal(result.escapedBlockedStart, true);

  const stayingBlocked = inspectDirectNavigationPath(
    navigation(),
    { x: 5.5, y: 10.5 },
    { x: 5.5, y: 10.5 },
    { diameterMeters: 1 },
  );
  assert.equal(stayingBlocked.valid, false, 'recovery must still require a clear destination');
});

test('blocked-start recovery cannot re-enter another blocker after reaching clear ground', () => {
  const result = inspectDirectNavigationPath(
    navigation({ secondWall: true }),
    { x: 5.5, y: 10.5 },
    { x: 10.5, y: 10.5 },
    { diameterMeters: 1 },
  );
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'blocked');
  assert.deepEqual(result.blockingCell, { x: 8, y: 10 });
});

test('production Movement runtime rejects blocked placement and accepts an adjacent clear cell', () => {
  const inspectPlacement = productionPlacementInspector(mapPackage());
  assert.equal(inspectPlacement(null, { x: 4.5, y: 10.5 }, { diameterMeters: 1 }).valid, true);
  const blocked = inspectPlacement(null, { x: 5.5, y: 10.5 }, { diameterMeters: 1 });
  assert.equal(blocked.valid, false);
  assert.equal(blocked.code, 'placement_blocked');
});
