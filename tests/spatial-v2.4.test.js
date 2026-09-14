import test from 'node:test';
import assert from 'node:assert/strict';
import lanzhou from '../reference/maps/lanzhou/runtime.json' with { type: 'json' };
import {
  deriveVisionOccluders,
  deriveSceneLightSources,
  distance3dMeters,
  inspectLineOfSight,
  lightContributionAtPoint,
  normalizeVisionOccluder,
  perceptionLevelAtPoint,
  sphereGroundRadiusMeters,
} from '../src/spatial/kernel.js';
import { projectStateForAudience } from '../src/vision/audience.js';
import { exploreFogVisibleCircle, isFogCellExplored } from '../src/vision/fog.js';
import { createInitialState, createDamagePreview, commitDamageEvent, deriveSceneState, undoLastSceneEvent, commitRestoreEvent, commitResetSceneEvent } from '../src/engine/state.js';

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

test('LOS reuses only trusted normalized occluders and revalidates mutable input', () => {
  const input = structuredClone(wall);
  const normalized = normalizeVisionOccluder(input);
  assert.strictEqual(normalizeVisionOccluder(normalized), normalized);
  input.blockingHeightMeters = 12;
  assert.equal(normalizeVisionOccluder(input).blockingHeightMeters, 12);
});

test('open and destroyed features remove only their own vision blocker', () => {
  const mapPackage = { visionOccluders: [wall, { ...wall, id: 'wall-b', featureId: 'wall-b' }] };
  const scene = { featureStates: { 'wall-a': { open: true } } };
  const values = deriveVisionOccluders(mapPackage, scene, { destroyedObjectIds: ['wall-b'] });
  assert.deepEqual(values, []);
});

const rect = (x, y, w, h) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
const damagedOccluders = (polygons, others = []) => deriveVisionOccluders(
  { visionOccluders: [wall, ...others] }, {},
  { clipHits: polygons.map(polygon => ({ featureId: wall.featureId, polygon })) },
);
const sight = (occluders, y = 0, elevationMeters = 0) => inspectLineOfSight({
  occluders, from: { x: 0, y, elevationMeters }, to: { x: 10, y, elevationMeters },
});

test('localized damage opens only its own LOS gap and light path, preserving separate remnants', () => {
  const values = damagedOccluders([rect(3, -0.5, 2, 1), rect(4.5, -0.5, 3, 1)]);
  assert.equal(values[0].polygons.length, 2);
  assert.equal(sight(values).clear, true);
  assert.equal(sight(values, 1).clear, false);
  assert.equal(sight(values, -1, 6).clear, true);
  assert.equal(sight(values, 1, 5).clear, false);
  assert.equal(lightContributionAtPoint({ x: 10, y: 0 }, [{ x: 0, y: 0, rangeMeters: 20 }], { occluders: values }), 0.5);
  const overlap = { ...wall, id: 'other', featureId: 'other' };
  assert.equal(sight(damagedOccluders([rect(3, -1, 4, 2)], [overlap])).featureId, 'other');
  assert.equal(sight(damagedOccluders([rect(3, -3, 4, 6)])).clear, true);
});

test('interior damage holes stay empty but surrounding walls still obstruct and retain height checks', () => {
  const values = damagedOccluders([rect(4.5, -1, 1, 2)]);
  assert.equal(values[0].polygons[0].length, 2);
  assert.equal(inspectLineOfSight({ occluders: values, from: { x: 5, y: -0.5 }, to: { x: 5, y: 0.5 } }).clear, true);
  assert.equal(sight(values).clear, false);
  assert.equal(inspectLineOfSight({ occluders: values,
    from: { x: 5, y: 0 }, to: { x: 10, y: 0 } }).clear, false);
  assert.equal(inspectLineOfSight({ occluders: [wall],
    from: { x: 0, y: 0, elevationMeters: 10 }, to: { x: 10, y: 0 } }).clear, false);
});

test('damage reload and undo update authoritative player visibility without stale occluders', () => {
  const map = { id: 'test-map', version: '1', features: [{ id: wall.featureId, category: 'wall',
    mode: 'clip', geometry: { type: 'polygon', points: wall.polygon } }], width: 30, height: 30 };
  const initial = createInitialState(map);
  const area = { id: 'blast', shape: 'circle', origin: { x: 5, y: 0 }, radius: 3 };
  const damaged = commitDamageEvent(initial, area, createDamagePreview(area, map.features, ['wall']));
  for (const [state, visible] of [[initial, false], [JSON.parse(JSON.stringify(damaged)), true],
    [undoLastSceneEvent(damaged), false], [commitRestoreEvent(damaged, [wall.featureId]), false],
    [commitResetSceneEvent(damaged), false]]) {
    const audience = audienceState(0);
    audience.preferences.worldV2.scenes[0].sceneEvents = state.sceneEvents;
    const projected = projectStateForAudience(audience, audienceContext);
    assert.equal(projected.preferences.worldV2.scenes[0].tokens.some(token => token.id === 'target'), visible);
    assert.equal(sight(deriveVisionOccluders(audienceContext.mapPackage, {}, deriveSceneState(state.sceneEvents))).clear, visible);
  }
});

test('light contribution respects 3D range and configured occlusion', () => {
  const point = { x: 10, y: 0, elevationMeters: 0 };
  const light = { x: 0, y: 0, elevationMeters: 0, rangeMeters: 20, intensity: 1, occlusion: 'sight' };
  assert.equal(lightContributionAtPoint(point, [light], { occluders: [wall] }), 0);
  assert.equal(lightContributionAtPoint(point, [{ ...light, occlusion: 'none' }]), 0.5);
});

test('target lighting and senses use the same precise or vague perception result', () => {
  const vision = {
    x: 0, y: 0, elevationMeters: 0,
    preciseRangeMeters: 20, vagueRangeMeters: 20, senses: {},
  };
  const target = { x: 10, y: 0, elevationMeters: 0 };
  assert.equal(perceptionLevelAtPoint({ vision, target, ambient: 'dark' }), 'vague');
  assert.equal(perceptionLevelAtPoint({
    vision, target, ambient: 'dark',
    lights: [{ x: 10, y: 0, elevationMeters: 2, rangeMeters: 20, intensity: 1, occlusion: 'none' }],
  }), 'precise');
  assert.equal(perceptionLevelAtPoint({
    vision: { ...vision, senses: { darkvision: true } }, target, ambient: 'dark',
  }), 'precise');
  assert.equal(perceptionLevelAtPoint({
    vision, target, ambient: 'normal', lineOfSightEnabled: true, occluders: [wall],
  }), 'none');
});

test('Scene light sources combine static MapPackage and Token lights without exposing disabled values', () => {
  const values = deriveSceneLightSources({ lights: [{
    id: 'static', x: 1, y: 2, elevationMeters: 3, rangeMeters: 10, intensity: 1,
  }] }, { tokens: [{
    id: 'token', placement: 'map', x: 4, y: 5, elevationMeters: 6,
    light: { enabled: true, rangeMeters: 8, intensity: 2, elevationOffsetMeters: 1 },
  }, {
    id: 'dark', placement: 'map', x: 0, y: 0,
    light: { enabled: false, rangeMeters: 100 },
  }] });
  assert.deepEqual(values.map(value => [value.id, value.elevationMeters, value.rangeMeters]), [
    ['static', 3, 10], ['token-light:token', 7, 8],
  ]);
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

test('Scene and player LOS overrides cannot bypass character visual occlusion', () => {
  const bypassed = projectStateForAudience(audienceState(0), { ...audienceContext, lineOfSightOverride: false });
  assert.deepEqual(bypassed.preferences.worldV2.scenes[0].tokens.map(token => token.id), ['source']);
  const state = audienceState(0);
  state.preferences.worldV2.scenes[0].settings.lineOfSightEnabled = false;
  const forced = projectStateForAudience(state, { ...audienceContext, lineOfSightOverride: true });
  assert.deepEqual(forced.preferences.worldV2.scenes[0].tokens.map(token => token.id), ['source']);
});

test('X-ray character sees the complete precise and vague circular area through Features', () => {
  const xray = { ...audienceContext, ruleset: {
    vision: { describe: () => ({ preciseRangeMeters: 100, vagueRangeMeters: 100, senses: { xrayVision: true } }) },
  } };
  const projected = projectStateForAudience(audienceState(0), xray);
  assert.deepEqual(projected.preferences.worldV2.scenes[0].tokens.map(token => token.id), ['source', 'target']);
});

test('Lanzhou declares bounded LOS only for walls and openable gates', () => {
  const occluders = deriveVisionOccluders(lanzhou, { featureStates: {} }, { destroyedObjectIds: [] });
  assert.ok(occluders.length >= 20);
  const featureById = new Map(lanzhou.features.map(feature => [feature.id, feature]));
  assert.ok(occluders.every(entry => {
    const feature = featureById.get(entry.featureId);
    return feature?.category === 'building' || feature?.category === 'wall' || feature?.capabilities?.openable === true;
  }));
  assert.ok(occluders.every(entry => Number.isFinite(entry.blockingHeightMeters)));
});
