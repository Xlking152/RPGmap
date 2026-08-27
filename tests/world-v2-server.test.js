import test from 'node:test';
import assert from 'node:assert/strict';
import { assertWorldState } from '../deployment/local-server/world-schema.mjs';

function state() {
  return {
    characters: [{
      id: 'token-1', name: '角色', color: '#3d9b63', avatarDataUrl: null, visible: true,
      location: { type: 'map', x: 12.5, y: 18.5 },
    }],
    markers: [],
    attackAreas: [],
    sceneEvents: [],
    preferences: {
      entitySystem: {
        schemaVersion: 3,
        statusDefinitions: [],
        actors: [{ id: 'actor-1', name: '角色', forms: [], runtime: {}, effects: [] }],
        tokens: [{
          id: 'token-1', characterId: 'token-1', actorId: 'actor-1', actorLink: true,
          diameterMeters: 1, rotation: 0, elevationFt: 0, hidden: false, locked: false, showName: true, effects: [],
        }],
      },
      worldV2: {
        schemaVersion: 2,
        id: 'world-default',
        name: 'World',
        ruleset: { id: 'infinite-horror', version: '1.0.0' },
        activeSceneId: 'scene-test',
        actors: [],
        statusDefinitions: [],
        scenes: [{
          id: 'scene-test', name: 'Scene', mapPackage: { id: 'test-map', version: '1' },
          tokens: [], markers: [], attackAreas: [], sceneEvents: [], settings: { gridVisible: true },
        }],
      },
    },
  };
}

test('server validation mirrors authoritative Actor/Token projection into World V2', () => {
  const value = state();
  assert.equal(assertWorldState(value), value);
  assert.equal(value.preferences.worldV2.actors[0].id, 'actor-1');
  assert.equal(value.preferences.worldV2.scenes[0].tokens[0].actorId, 'actor-1');
  assert.equal(value.preferences.worldV2.scenes[0].tokens[0].x, 12.5);
  assert.equal(value.preferences.worldV2.scenes[0].tokens[0].y, 18.5);
});

test('legacy server states without World V2 remain valid and are not rewritten', () => {
  const value = state();
  delete value.preferences.worldV2;
  assert.equal(assertWorldState(value), value);
  assert.equal(value.preferences.worldV2, undefined);
});

test('World V2 rejects an active Scene reference that does not exist', () => {
  const value = state();
  value.preferences.worldV2.activeSceneId = 'missing-scene';
  assert.throws(() => assertWorldState(value), /activeSceneId references missing Scene/);
});
