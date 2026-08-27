import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorldSystem } from '../src/world/system.js';
import { WORLD_STATE_KEY, activeWorldScene } from '../src/world/model.js';

const mapPackage = { id: 'test-map', version: '1.0.0', title: '测试地图' };
function actor() { return { id: 'actor-1', name: '角色', currentFormId: 'form-1', forms: [{ id: 'form-1', tokenAppearance: { color: '#3d9b63' }, avatarDataUrl: null }], runtime: {}, effects: [] }; }
function state() {
  return {
    saveVersion: 2, mapId: 'test-map', mapVersion: '1.0.0', markers: [], attackAreas: [], sceneEvents: [],
    preferences: { gridVisible: true, entitySystem: { schemaVersion: 3, statusDefinitions: [], actors: [actor()], tokens: [{ id: 'token-1', actorId: 'actor-1', placement: 'map', x: 1.5, y: 2.5, diameterMeters: 1, rotation: 0, elevationFt: 0, hidden: false, locked: false, showName: true, effects: [] }] } },
  };
}
function apiFixture() {
  let current = state(); const events = [];
  const api = {
    mapPackage,
    getState() { return structuredClone(current); },
    commitState(next, options = {}) { current = structuredClone(next); events.push(['commit', options.source]); return true; },
    importState(next) { current = structuredClone(next); events.push(['import']); return true; },
    emit(type, detail) { events.push([type, detail]); },
  };
  return { api, events, current: () => structuredClone(current) };
}

function assertNoCharacters(value) {
  assert.equal(Object.hasOwn(value, 'characters'), false);
}

test('WorldSystem hydrates modern Token placement once and later flat commits cannot move Scene Tokens', () => {
  const fixture = apiFixture();
  createWorldSystem().register(fixture.api);
  let world = fixture.current().preferences[WORLD_STATE_KEY];
  assert.equal(activeWorldScene(world).tokens[0].x, 1.5);
  const draft = fixture.api.getState();
  assertNoCharacters(draft);
  draft.preferences.entitySystem.tokens[0].x = 30.5;
  draft.preferences.entitySystem.tokens[0].y = 40.5;
  fixture.api.commitState(draft, { source: 'reducer-test' });
  world = fixture.current().preferences[WORLD_STATE_KEY];
  assert.equal(activeWorldScene(world).tokens[0].x, 1.5);
  assert.equal(activeWorldScene(world).tokens[0].y, 2.5);
});

test('WorldSystem canonical World V2 takes precedence and Character projection stays absent', () => {
  const fixture = apiFixture();
  createWorldSystem().register(fixture.api);
  const imported = fixture.api.getState();
  const world = imported.preferences[WORLD_STATE_KEY];
  activeWorldScene(world).tokens[0].x = 77.5;
  activeWorldScene(world).tokens[0].y = 66.5;
  const projected = fixture.api.world.projectState(imported);
  fixture.api.importState(projected);
  assertNoCharacters(fixture.current());
  assert.equal(fixture.api.world.getActiveScene().tokens[0].x, 77.5);
  assert.equal(fixture.api.world.getActiveScene().tokens[0].y, 66.5);
});

test('WorldSystem can create and activate another Scene using the loaded MapPackage', async () => {
  const fixture = apiFixture();
  createWorldSystem().register(fixture.api);
  const scene = await fixture.api.world.createScene({ id: 'scene-second', name: '第二场景' });
  assert.equal(scene.id, 'scene-second');
  assert.equal(fixture.api.world.listScenes().length, 2);
  await fixture.api.world.setActiveScene('scene-second');
  assert.equal(fixture.api.world.get().activeSceneId, 'scene-second');
  assertNoCharacters(fixture.current());
  assert.equal(fixture.current().markers.length, 0);
});
