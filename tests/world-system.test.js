import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorldSystem } from '../src/world/system.js';
import { WORLD_STATE_KEY, activeWorldScene } from '../src/world/model.js';

const mapPackage = { id: 'test-map', version: '1.0.0', title: '测试地图' };

function actor() {
  return {
    id: 'actor-1', name: '角色', currentFormId: 'form-1',
    forms: [{ id: 'form-1', tokenAppearance: { color: '#3d9b63' }, avatarDataUrl: null }],
    runtime: {}, effects: [],
  };
}

function state() {
  return {
    saveVersion: 2, mapId: 'test-map', mapVersion: '1.0.0',
    markers: [], attackAreas: [], sceneEvents: [],
    characters: [{
      id: 'token-1', name: '角色', color: '#3d9b63', avatarDataUrl: null, visible: true,
      location: { type: 'map', x: 1.5, y: 2.5 },
    }],
    preferences: {
      gridVisible: true,
      entitySystem: {
        schemaVersion: 3, statusDefinitions: [], actors: [actor()],
        tokens: [{
          id: 'token-1', characterId: 'token-1', actorId: 'actor-1', diameterMeters: 1,
          rotation: 0, elevationFt: 0, hidden: false, locked: false, showName: true, effects: [],
        }],
      },
    },
  };
}

function apiFixture() {
  let current = state();
  const events = [];
  const api = {
    mapPackage,
    getState() { return structuredClone(current); },
    commitState(next, options = {}) { current = structuredClone(next); events.push(['commit', options.source]); return true; },
    importState(next) { current = structuredClone(next); events.push(['import']); return true; },
    emit(type, detail) { events.push([type, detail]); },
  };
  return { api, events, current: () => structuredClone(current) };
}

test('WorldSystem migrates current state and synchronizes later runtime commits', () => {
  const fixture = apiFixture();
  createWorldSystem().register(fixture.api);
  assert.equal(fixture.api.world.schemaVersion, 2);
  let world = fixture.current().preferences[WORLD_STATE_KEY];
  assert.equal(activeWorldScene(world).tokens[0].x, 1.5);

  const moved = fixture.api.getState();
  moved.characters[0].location = { type: 'map', x: 30.5, y: 40.5 };
  fixture.api.commitState(moved, { source: 'movement-test' });
  world = fixture.current().preferences[WORLD_STATE_KEY];
  assert.equal(activeWorldScene(world).tokens[0].x, 30.5);
  assert.equal(activeWorldScene(world).tokens[0].y, 40.5);
});

test('WorldSystem import gives canonical World V2 precedence over stale flat projection', () => {
  const fixture = apiFixture();
  createWorldSystem().register(fixture.api);
  const imported = fixture.api.getState();
  imported.characters[0].location = { type: 'map', x: 2.5, y: 2.5 };
  const world = imported.preferences[WORLD_STATE_KEY];
  activeWorldScene(world).tokens[0].x = 77.5;
  activeWorldScene(world).tokens[0].y = 66.5;
  fixture.api.importState(imported);
  assert.deepEqual(fixture.current().characters[0].location, { type: 'map', x: 77.5, y: 66.5 });
});
