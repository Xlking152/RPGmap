import test from 'node:test';
import assert from 'node:assert/strict';
import { createBoundUser, validatePlayerWorldPush } from '../deployment/local-server/access-control.mjs';
import { assertWorldState } from '../deployment/local-server/world-schema.mjs';

function tokenRuntime({ x = 1, y = 2 } = {}) {
  return {
    id: 'token-a', characterId: 'token-a', actorId: 'actor-a',
    actorLink: true, actorDelta: null,
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
  return {
    version: 2,
    mapId: 'test',
    characters: [{
      id: 'token-a', name: 'A', visible: true,
      location: { type: 'map', x, y },
    }],
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
  };
}

test('canonical-only Scene Token position tampering is overwritten before Player World persistence', () => {
  const before = state();
  const forged = structuredClone(before);
  forged.preferences.worldV2.scenes[0].tokens[0].x = 17;
  forged.preferences.worldV2.scenes[0].tokens[0].y = 18;

  // World schema synchronization is the server's pre-persistence canonicalization
  // boundary. A client cannot move a Token by editing only the World V2 mirror.
  assertWorldState(forged);
  assert.equal(forged.preferences.worldV2.scenes[0].tokens[0].x, 1);
  assert.equal(forged.preferences.worldV2.scenes[0].tokens[0].y, 2);

  const user = createBoundUser({ name: 'Player', defaultActorId: 'actor-a' }).user;
  const submitted = structuredClone(before);
  submitted.preferences.worldV2.scenes[0].tokens[0].x = 19;
  const result = validatePlayerWorldPush({ before, next: submitted, user });
  assert.equal(result.ok, true);
  assert.equal(submitted.preferences.worldV2.scenes[0].tokens[0].x, 1);
  assert.equal(submitted.characters[0].location.x, 1);
});

test('mirrored owned-Token movement survives server normalization and authorization', () => {
  const before = state();
  const moved = state({ x: 6, y: 7 });
  const user = createBoundUser({ name: 'Player', defaultActorId: 'actor-a' }).user;
  const result = validatePlayerWorldPush({ before, next: moved, user });
  assert.equal(result.ok, true);
  assert.equal(moved.characters[0].location.x, 6);
  assert.equal(moved.preferences.entitySystem.tokens[0].x, 6);
  assert.equal(moved.preferences.worldV2.scenes[0].tokens[0].x, 6);
  assert.equal(moved.preferences.worldV2.scenes[0].tokens[0].y, 7);
});
