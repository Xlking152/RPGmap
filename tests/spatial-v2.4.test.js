import test from 'node:test';
import assert from 'node:assert/strict';
import lanzhou from '../reference/maps/lanzhou/runtime.json' with { type: 'json' };
import {
  deriveVisionOccluders,
  distance3dMeters,
  inspectLineOfSight,
  lightContributionAtPoint,
  sphereGroundRadiusMeters,
} from '../src/spatial/kernel.js';
import { projectStateForAudience } from '../src/vision/audience.js';
import { exploreFogVisibleCircle, isFogCellExplored } from '../src/vision/fog.js';

const wall = {
  id: 'wall-a', featureId: 'wall-a',
  polygon: [[4, -2], [6, -2], [6, 2], [4, 2]],
  blockingHeightMeters: 5,
  passableWhenOpen: true,
  passableWhenDestroyed: true,
};

test('sphere vision uses 3D distance and a ground-plane cross section', () => {
  assert.equal(distance3dMeters(
    { x: 0, y: 0, elevationMeters: 0 },
    { x: 3, y: 4, elevationMeters: 12 },
  ), 13);
  assert.equal(sphereGroundRadiusMeters(13, 12), 5);
  assert.equal(sphereGroundRadiusMeters(10, 10), 0);
  assert.equal(sphereGroundRadiusMeters(10, 11), null);
});

test('finite-height LOS blocks the exact top, clears above it, and can exclude the target door', () => {
  const common = { from: { x: 0, y: 0, elevationMeters: 0 }, occluders: [wall] };
  assert.equal(inspectLineOfSight({ ...common, to: { x: 10, y: 0, elevationMeters: 10 } }).clear, false);
  assert.equal(inspectLineOfSight({ ...common, to: { x: 10, y: 0, elevationMeters: 14 } }).clear, true);
  assert.equal(inspectLineOfSight({ ...common, to: { x: 10, y: 0, elevationMeters: 0 },
    excludedFeatureIds: ['wall-a'] }).clear, true);
});

test('open and destroyed features remove only their own vision blocker', () => {
  const mapPackage = { visionOccluders: [wall, { ...wall, id: 'wall-b', featureId: 'wall-b' }] };
  const scene = { featureStates: { 'wall-a': { open: true } } };
  const values = deriveVisionOccluders(mapPackage, scene, { destroyedObjectIds: ['wall-b'] });
  assert.deepEqual(values, []);
});

test('light contribution respects 3D range and configured occlusion', () => {
  const point = { x: 10, y: 0, elevationMeters: 0 };
  const light = { x: 0, y: 0, elevationMeters: 0, rangeMeters: 20, intensity: 1, occlusion: 'sight' };
  assert.equal(lightContributionAtPoint(point, [light], { occluders: [wall] }), 0);
  assert.equal(lightContributionAtPoint(point, [{ ...light, occlusion: 'none' }]), 0.5);
});

test('LOS-constrained exploration stores only visible five-metre cells', () => {
  const mapPackage = { width: 30, height: 10, metersPerUnit: 1 };
  const occluder = { ...wall, polygon: [[4, 0], [6, 0], [6, 5], [4, 5]] };
  const fog = exploreFogVisibleCircle({}, 'party', {
    x: 0, y: 2.5, elevationMeters: 0, radiusMeters: 20,
  }, mapPackage, { sourceElevationMeters: 0, occluders: [occluder] });
  assert.equal(isFogCellExplored(fog, 'party', { x: 2.5, y: 2.5 }), true);
  assert.equal(isFogCellExplored(fog, 'party', { x: 12.5, y: 2.5 }), false);
});

function audienceState(targetElevationMeters) {
  const actors = [
    { id: 'pc', name: 'PC', type: 'pc', partyId: 'party', system: {}, effects: [] },
    { id: 'npc', name: 'NPC', type: 'npc', partyId: null, system: {}, effects: [] },
  ];
  const token = (id, actorId, x, elevationMeters, visibility) => ({
    id, actorId, actorLink: actorId === 'pc', actorDelta: actorId === 'pc' ? null : { system: {}, effects: [] },
    placement: 'map', x, y: 0, elevationMeters, diameterMeters: 1, rotation: 0,
    movement: { mode: 'walk', spentMeters: 0, turnKey: null, adjudicationRequired: false },
    controllerUserIds: [], visibility: { mode: visibility, userIds: [] },
    vision: { enabled: true, preciseRangeOverrideMeters: 100, vagueRangeOverrideMeters: 100, overrideUserIds: [] },
    locked: false, showName: true, effects: [],
  });
  const scene = {
    id: 'scene', mapPackage: { id: 'test-map', version: '1' },
    tokens: [token('source', 'pc', 0, 0, 'party'), token('target', 'npc', 10, targetElevationMeters, 'public')],
    markers: [], attackAreas: [], sceneEvents: [], featureStates: {},
    fog: { schemaVersion: 1, cellSizeMeters: 5, exploredByParty: {} },
    settings: { lineOfSightEnabled: true },
  };
  return { preferences: { worldV2: {
    schemaVersion: 4, id: 'world', ruleset: { id: 'test', version: '1' }, activeSceneId: 'scene',
    actors, statusDefinitions: [], scenes: [scene],
  }, entitySystem: { schemaVersion: 4, actors, tokens: scene.tokens, statusDefinitions: [] } } };
}

const audienceContext = {
  role: 'player', userId: 'user', user: { id: 'user', ownership: { pc: 'owner' } },
  visionSourceTokenId: 'source',
  ruleset: { vision: { describe: () => ({ preciseRangeMeters: 100, vagueRangeMeters: 100 }) } },
  mapMetrics: { metersPerUnit: 1 },
  mapPackage: { visionOccluders: [wall] },
  opaqueIdFor: (kind, id) => `opaque-${kind}-${id}`,
};

test('Audience projection applies sphere range and LOS to airborne hostile Tokens', () => {
  const blocked = projectStateForAudience(audienceState(0), audienceContext);
  assert.deepEqual(blocked.preferences.worldV2.scenes[0].tokens.map(token => token.id), ['source']);
  const visible = projectStateForAudience(audienceState(14), audienceContext);
  assert.deepEqual(visible.preferences.worldV2.scenes[0].tokens.map(token => token.id), ['source', 'target']);
});

test('Lanzhou declares bounded LOS only for walls and openable gates', () => {
  const occluders = deriveVisionOccluders(lanzhou, { featureStates: {} }, { destroyedObjectIds: [] });
  assert.ok(occluders.length >= 20);
  const featureById = new Map(lanzhou.features.map(feature => [feature.id, feature]));
  assert.ok(occluders.every(entry => {
    const feature = featureById.get(entry.featureId);
    return feature?.category === 'wall' || feature?.capabilities?.openable === true;
  }));
  assert.ok(occluders.every(entry => Number.isFinite(entry.blockingHeightMeters)));
});
