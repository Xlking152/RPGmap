import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WORLD_SCHEMA_VERSION,
  WORLD_STATE_KEY,
  activeWorldScene,
  createEmptyWorldScene,
  createWorldV2FromRuntimeState,
  normalizeWorldV2,
  projectWorldV2ToRuntimeState,
  synchronizeWorldV2FromRuntimeState,
} from '../src/world/model.js';
import { migrateLegacySaveV2 } from '../src/legacy/save-v2.js';
import { infiniteHorrorRuleset } from '../src/rulesets/infinite-horror/index.js';

const mapPackage = { id: 'test-map', version: '2.3.0', title: '测试地图' };
const ruleset = infiniteHorrorRuleset;
function actor(id = 'actor-1', name = '测试角色') { return { id, name, currentFormId: 'form-1', forms: [{ id: 'form-1', avatarDataUrl: null, tokenAppearance: { color: '#3d9b63', scale: 1 } }], runtime: {}, effects: [] }; }
function legacyState() {
  return {
    saveVersion: 2, mapId: mapPackage.id, mapVersion: mapPackage.version,
    markers: [{ id: 'marker-1', name: 'M', x: 2, y: 3, color: '#3498db', visible: true }],
    characters: [{ id: 'token-1', name: '测试角色', color: '#3d9b63', avatarDataUrl: null, visible: true, location: { type: 'map', x: 10.5, y: 20.5 } }],
    attackAreas: [], sceneEvents: [],
    preferences: { gridVisible: true, entitySystem: { schemaVersion: 3, statusDefinitions: [], actors: [actor()], tokens: [{ id: 'token-1', actorId: 'actor-1', diameterMeters: 1, rotation: 0, elevationFt: 5, hidden: false, locked: false, showName: true, effects: [] }] } },
  };
}
function modernState() {
  return {
    saveVersion: 2, mapId: mapPackage.id, mapVersion: mapPackage.version,
    markers: [{ id: 'marker-1', name: 'M', x: 2, y: 3, color: '#3498db', visible: true }],
    attackAreas: [], sceneEvents: [],
    preferences: { gridVisible: true, entitySystem: { schemaVersion: 3, statusDefinitions: [], actors: [actor()], tokens: [{ id: 'token-1', actorId: 'actor-1', placement: 'map', x: 10.5, y: 20.5, diameterMeters: 1, rotation: 0, elevationFt: 5, hidden: false, locked: false, showName: true, effects: [] }] } },
  };
}

test('legacy SaveV2 migration boundary converts Character placement once into World Actors and Scene Tokens', () => {
  const migration = migrateLegacySaveV2(legacyState(), { mapPackage, ruleset });
  const world = migration.world;
  assert.equal(world.schemaVersion, WORLD_SCHEMA_VERSION);
  assert.equal(world.ruleset.id, 'infinite-horror');
  assert.equal(world.actors[0].id, 'actor-1');
  const scene = activeWorldScene(world);
  assert.deepEqual({ x: scene.tokens[0].x, y: scene.tokens[0].y }, { x: 10.5, y: 20.5 });
  assert.equal(scene.tokens[0].actorLink, true);
  assert.equal(scene.tokens[0].actorDelta, null);
  assert.equal(Object.hasOwn(migration.state, 'characters'), false);
});

test('World V2 projects canonical Scene Tokens into Entity reducer state without Character documents', () => {
  const state = modernState();
  const world = createWorldV2FromRuntimeState(state, { mapPackage, ruleset });
  const scene = activeWorldScene(world);
  scene.tokens[0].x = 44.5; scene.tokens[0].y = 55.5;
  scene.tokens[0].visibility = { mode: 'gm', userIds: [] };
  const projected = projectWorldV2ToRuntimeState(state, world, { mapPackage, ruleset });
  assert.equal(Object.hasOwn(projected, 'characters'), false);
  assert.equal(projected.preferences.entitySystem.tokens[0].x, 44.5);
  assert.equal(projected.preferences.entitySystem.tokens[0].actorId, 'actor-1');
  assert.equal(projected.preferences.entitySystem.tokens[0].characterId, undefined);
  assert.equal(projected.preferences[WORLD_STATE_KEY].schemaVersion, 3);
});

test('runtime projection synchronization is read-only and preserves canonical World data', () => {
  const state = modernState();
  let world = createWorldV2FromRuntimeState(state, { mapPackage, ruleset });
  world = createEmptyWorldScene(world, { mapPackage, id: 'scene-second', name: '第二场景' });
  const draft = projectWorldV2ToRuntimeState(state, world, { mapPackage, ruleset });
  draft.preferences.entitySystem.tokens[0].effects = [{ id: 'effect-1', definitionId: 'x', stacks: 1, enabled: true }];
  draft.preferences.entitySystem.tokens[0].x = 99;
  draft.preferences.entitySystem.tokens[0].y = 88;
  const synced = synchronizeWorldV2FromRuntimeState(draft, { mapPackage, ruleset, existingWorld: world });
  assert.equal(activeWorldScene(synced).tokens[0].x, 10.5);
  assert.equal(activeWorldScene(synced).tokens[0].y, 20.5);
  assert.deepEqual(activeWorldScene(synced).tokens[0].effects, []);
  assert.equal(synced.scenes.find(scene => scene.id === 'scene-second').tokens.length, 0);
});

test('feature placement is canonical in Scene Token and Character projection stays absent', () => {
  const state = modernState();
  const world = createWorldV2FromRuntimeState(state, { mapPackage, ruleset });
  const token = activeWorldScene(world).tokens[0];
  token.placement = 'feature'; token.featureId = 'building-7'; token.x = null; token.y = null;
  const projected = projectWorldV2ToRuntimeState(state, world, { mapPackage, ruleset });
  assert.equal(Object.hasOwn(projected, 'characters'), false);
  assert.equal(projected.preferences.entitySystem.tokens[0].placement, 'feature');
  assert.equal(projected.preferences.entitySystem.tokens[0].featureId, 'building-7');
});

test('World normalization and projection preserve unknown extension fields', () => {
  const world = createWorldV2FromRuntimeState(modernState(), { mapPackage, ruleset });
  world.extension = { module: 'world-extension', enabled: true };
  world.ruleset.extension = { channel: 'stable' };
  world.actors[0].ownership = { user: 'OWNER' };
  world.actors[0].system.extension = { customResource: 7 };
  world.actors[0].system.runtime.health.extension = { track: 'custom' };
  world.statusDefinitions.push({
    id: 'custom-extension',
    name: 'Custom',
    scopes: ['actor'],
    extension: { source: 'module' },
  });
  const scene = activeWorldScene(world);
  scene.extension = { lighting: 'custom' };
  scene.mapPackage.extension = { variant: 'night' };
  scene.settings.extension = { fog: true };
  scene.tokens[0].extension = { aura: 4 };
  scene.tokens[0].effects = [{
    id: 'effect-extension',
    definitionId: 'custom-extension',
    stacks: 1,
    enabled: true,
    extension: { duration: 3 },
  }];

  const normalized = normalizeWorldV2(world, { mapPackage, ruleset });
  const projected = projectWorldV2ToRuntimeState(modernState(), normalized, { mapPackage, ruleset });
  const roundTrip = normalizeWorldV2(projected.preferences[WORLD_STATE_KEY], { mapPackage, ruleset });
  const roundTripScene = activeWorldScene(roundTrip);
  assert.deepEqual(roundTrip.extension, world.extension);
  assert.deepEqual(roundTrip.ruleset.extension, world.ruleset.extension);
  assert.deepEqual(roundTrip.actors[0].ownership, world.actors[0].ownership);
  assert.deepEqual(roundTrip.actors[0].system.extension, world.actors[0].system.extension);
  assert.deepEqual(roundTrip.actors[0].system.runtime.health.extension, { track: 'custom' });
  assert.deepEqual(roundTrip.statusDefinitions.at(-1).extension, { source: 'module' });
  assert.deepEqual(roundTripScene.extension, scene.extension);
  assert.deepEqual(roundTripScene.mapPackage.extension, scene.mapPackage.extension);
  assert.deepEqual(roundTripScene.settings.extension, scene.settings.extension);
  assert.deepEqual(roundTripScene.tokens[0].extension, scene.tokens[0].extension);
  assert.deepEqual(roundTripScene.tokens[0].effects[0].extension, { duration: 3 });
});
