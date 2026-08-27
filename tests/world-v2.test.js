import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WORLD_SCHEMA_VERSION,
  WORLD_STATE_KEY,
  activeWorldScene,
  createEmptyWorldScene,
  createWorldV2FromRuntimeState,
  projectWorldV2ToRuntimeState,
  synchronizeWorldV2FromRuntimeState,
} from '../src/world/model.js';

const mapPackage = { id: 'test-map', version: '2.3.0', title: '测试地图' };
const ruleset = { id: 'infinite-horror', version: '1.0.0', title: '无限跑团' };
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

test('legacy single-map state migrates once into World V2 with World Actors and Scene Tokens', () => {
  const world = createWorldV2FromRuntimeState(legacyState(), { mapPackage, ruleset });
  assert.equal(world.schemaVersion, WORLD_SCHEMA_VERSION);
  assert.equal(world.ruleset.id, 'infinite-horror');
  assert.equal(world.actors[0].id, 'actor-1');
  const scene = activeWorldScene(world);
  assert.deepEqual({ x: scene.tokens[0].x, y: scene.tokens[0].y }, { x: 10.5, y: 20.5 });
  assert.equal(scene.tokens[0].actorLink, true);
  assert.equal(scene.tokens[0].actorDelta, null);
});

test('World V2 projects canonical Scene Tokens into Entity reducer state but not Character documents', () => {
  const state = legacyState();
  const world = createWorldV2FromRuntimeState(state, { mapPackage, ruleset });
  const scene = activeWorldScene(world);
  scene.tokens[0].x = 44.5; scene.tokens[0].y = 55.5; scene.tokens[0].hidden = true;
  const projected = projectWorldV2ToRuntimeState(state, world, { mapPackage, ruleset });
  assert.deepEqual(projected.characters, []);
  assert.equal(projected.preferences.entitySystem.tokens[0].x, 44.5);
  assert.equal(projected.preferences.entitySystem.tokens[0].actorId, 'actor-1');
  assert.equal(projected.preferences.entitySystem.tokens[0].characterId, undefined);
  assert.equal(projected.preferences[WORLD_STATE_KEY].schemaVersion, 2);
});

test('runtime reducer synchronization preserves canonical active Scene placement', () => {
  const state = legacyState();
  let world = createWorldV2FromRuntimeState(state, { mapPackage, ruleset });
  world = createEmptyWorldScene(world, { mapPackage, id: 'scene-second', name: '第二场景' });
  const draft = projectWorldV2ToRuntimeState(state, world, { mapPackage, ruleset });
  draft.preferences.entitySystem.tokens[0].effects = [{ id: 'effect-1', definitionId: 'x', stacks: 1, enabled: true }];
  const synced = synchronizeWorldV2FromRuntimeState(draft, { mapPackage, ruleset, existingWorld: world });
  assert.equal(activeWorldScene(synced).tokens[0].x, 10.5);
  assert.equal(activeWorldScene(synced).tokens[0].y, 20.5);
  assert.equal(synced.scenes.find(scene => scene.id === 'scene-second').tokens.length, 0);
});

test('feature placement is canonical in Scene Token and Character projection stays retired', () => {
  const state = legacyState();
  const world = createWorldV2FromRuntimeState(state, { mapPackage, ruleset });
  const token = activeWorldScene(world).tokens[0];
  token.placement = 'feature'; token.featureId = 'building-7'; token.x = null; token.y = null;
  const projected = projectWorldV2ToRuntimeState(state, world, { mapPackage, ruleset });
  assert.deepEqual(projected.characters, []);
  assert.equal(projected.preferences.entitySystem.tokens[0].placement, 'feature');
  assert.equal(projected.preferences.entitySystem.tokens[0].featureId, 'building-7');
});
