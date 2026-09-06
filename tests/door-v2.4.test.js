import test from 'node:test';
import assert from 'node:assert/strict';
import { applyWorldOperations } from '../src/world/operations.js';
import { validateDoorInteraction } from '../src/interaction/door-authority.js';
import { worldOperationsToDocumentWrites, documentWritesToWorldOperations } from '../src/documents/protocol.js';

const door = {
  id: 'door', center: [2, 0], entrance: [2, 0],
  geometry: { points: [[1.5, -1], [2.5, -1], [2.5, 1], [1.5, 1]] },
  capabilities: {
    openable: true,
    actions: { open: true, close: true },
    vision: {
      occluder: true, blockingHeightMeters: 3,
      polygon: [[1.5, -1], [2.5, -1], [2.5, 1], [1.5, 1]],
      passableWhenOpen: true, passableWhenDestroyed: true,
    },
  },
};

const blockingWall = {
  id: 'wall', geometry: { points: [[0.75, -1], [1.25, -1], [1.25, 1], [0.75, 1]] },
  capabilities: { vision: {
    occluder: true, blockingHeightMeters: 3,
    polygon: [[0.75, -1], [1.25, -1], [1.25, 1], [0.75, 1]],
    passableWhenDestroyed: true,
  } },
};

function fixture({ tokenX = 0, featureStates = {}, features = [door], lineOfSightEnabled = true } = {}) {
  const token = {
    id: 'token', actorId: 'actor', actorLink: true, actorDelta: null,
    placement: 'map', x: tokenX, y: 0, elevationMeters: 0, diameterMeters: 1, rotation: 0,
    movement: { mode: 'walk', spentMeters: 0, turnKey: null, adjudicationRequired: false },
    controllerUserIds: [], visibility: { mode: 'party', userIds: [] },
    vision: { enabled: true, preciseRangeOverrideMeters: null, vagueRangeOverrideMeters: null, overrideUserIds: [] },
    locked: false, showName: true, effects: [],
  };
  const scene = {
    id: 'scene', mapPackage: { id: 'map', version: '1' }, tokens: [token],
    markers: [], attackAreas: [], sceneEvents: [], featureStates,
    settings: { lineOfSightEnabled, defaultDoorInteractionRangeMeters: 2 },
  };
  const mapPackage = {
    id: 'map', version: '1', width: 20, height: 20, metersPerUnit: 1,
    features, visionOccluders: features.flatMap(feature => feature.capabilities?.vision
      ? [{ ...feature.capabilities.vision, id: feature.id, featureId: feature.id }] : []),
  };
  const state = { preferences: { worldV2: {
    schemaVersion: 4, id: 'world', ruleset: { id: 'test', version: '1' }, activeSceneId: 'scene',
    actors: [{ id: 'actor', name: 'Actor', type: 'pc', partyId: 'party', system: {}, effects: [] }],
    statusDefinitions: [], scenes: [scene],
  } } };
  return { state, scene, token, mapPackage };
}

test('door intent validates distance and excludes the target door from LOS', () => {
  const value = fixture();
  const result = applyWorldOperations(value.state, [{
    type: 'scene.door.use', payload: { sceneId: 'scene', featureId: 'door', tokenId: 'token', action: 'open' },
  }], { source: { role: 'player' }, mapPackage: value.mapPackage, mapMetrics: value.mapPackage });
  assert.equal(result.state.preferences.worldV2.scenes[0].featureStates.door.open, true);
  assert.equal(result.results[0].distanceMeters, 2);
  assert.deepEqual(result.changeSet.featureStates, [{ sceneId: 'scene', featureIds: ['door'] }]);
});

test('door intent rejects locked, distant, hidden and separately occluded targets', () => {
  const cases = [
    [fixture({ featureStates: { door: { locked: true } } }), 'door_locked'],
    [fixture({ tokenX: 8 }), 'door_out_of_range'],
    [fixture({ features: [{ ...door, visibility: { mode: 'gm' } }] }), 'door_not_visible'],
    [fixture({ features: [door, blockingWall] }), 'door_line_of_sight_blocked'],
  ];
  for (const [value, code] of cases) {
    const before = structuredClone(value.state);
    assert.throws(() => applyWorldOperations(value.state, [{
      type: 'scene.door.use', payload: {
        sceneId: 'scene', featureId: 'door', tokenId: 'token', action: 'open',
      },
    }], { source: { role: 'player' }, mapPackage: value.mapPackage, mapMetrics: value.mapPackage }), { code });
    assert.deepEqual(value.state, before);
  }
});

test('door use has one addressed Scene intent and no arbitrary Feature patch', () => {
  const operations = [{ type: 'scene.door.use', payload: {
    sceneId: 'scene', featureId: 'door', tokenId: 'token', action: 'open',
  } }];
  const writes = worldOperationsToDocumentWrites(operations, { worldId: 'world', sceneId: 'scene' });
  assert.equal(writes[0].intent, 'scene.door.use');
  assert.equal(writes[0].document.type, 'Scene');
  assert.deepEqual(documentWritesToWorldOperations(writes), operations);
});
