import test from 'node:test';
import assert from 'node:assert/strict';
import { createBoundUser, validatePlayerWorldPush } from '../deployment/local-server/access-control.mjs';
import { assertWorldState } from '../deployment/local-server/world-schema.mjs';
import { migrateTestStateToWorldV3 } from './helpers/world-v3.js';

function tokenRuntime({ x = 1, y = 2 } = {}) {
  return {
    id: 'token-a', actorId: 'actor-a', actorLink: true, actorDelta: null,
    x, y, featureId: null,
    diameterMeters: 1, rotation: 0, elevationFt: 0,
    hidden: false, locked: false, showName: true, effects: [],
  };
}

function tokenWorld({ x = 1, y = 2 } = {}) {
  return {
    id: 'token-a', actorId: 'actor-a', actorLink: true, actorDelta: null,
    placement: 'map', x, y, featureId: null,
    diameterMeters: 1, rotation: 0, elevationFt: 0,
    hidden: false, locked: false, showName: true, effects: [],
  };
}

function state({ x = 1, y = 2 } = {}) {
  return migrateTestStateToWorldV3({
    version: 2,
    mapId: 'test',
    markers: [], attackAreas: [], sceneEvents: [],
    preferences: {
      entitySystem: {
        schemaVersion: 3,
        statusDefinitions: [],
        actors: [{ id: 'actor-a', name: 'A', effects: [] }],
        tokens: [tokenRuntime({ x, y })],
      },
      chatSystem: { messages: [] },
      worldV2: {
        schemaVersion: 2,
        id: 'world-test', name: 'World',
        ruleset: { id: 'infinite-horror', version: '1.0.0' },
        activeSceneId: 'scene-test',
        actors: [{ id: 'actor-a', name: 'A', effects: [] }],
        statusDefinitions: [],
        scenes: [{
          id: 'scene-test', name: 'Scene', mapPackage: { id: 'test', version: '1' },
          tokens: [tokenWorld({ x, y })], markers: [], attackAreas: [], sceneEvents: [],
          settings: { gridVisible: true },
        }],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    },
  });
}

test('canonical Scene Token placement survives server normalization', () => {
  const value = state();
  value.preferences.worldV2.scenes[0].tokens[0].x = 17;
  value.preferences.worldV2.scenes[0].tokens[0].y = 18;
  assertWorldState(value);
  assert.equal(value.preferences.worldV2.scenes[0].tokens[0].x, 17);
  assert.equal(value.preferences.worldV2.scenes[0].tokens[0].y, 18);
  assert.equal(value.preferences.entitySystem.tokens[0].x, 1);
  assert.equal(Object.hasOwn(value, 'characters'), false);
});

test('owned canonical Scene Token movement survives authorization without Character mirror', () => {
  const before = state();
  const moved = structuredClone(before);
  moved.preferences.worldV2.scenes[0].tokens[0].x = 6;
  moved.preferences.worldV2.scenes[0].tokens[0].y = 7;
  const user = createBoundUser({ name: 'Player', defaultActorId: 'actor-a' }).user;
  const result = validatePlayerWorldPush({ before, next: moved, user });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(moved.preferences.worldV2.scenes[0].tokens[0].x, 6);
  assert.equal(moved.preferences.worldV2.scenes[0].tokens[0].y, 7);
  assert.equal(Object.hasOwn(moved, 'characters'), false);
});
