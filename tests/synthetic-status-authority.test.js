import test from 'node:test';
import assert from 'node:assert/strict';
import { createBoundUser, validatePlayerWorldPush } from '../deployment/local-server/access-control.mjs';
import { resolveStatusCapabilitiesForCharacter as resolveStatusCapabilitiesForToken } from '../deployment/local-server/status-operations.mjs';
import { INFINITE_HORROR_STATUS_DEFINITIONS } from '../src/rulesets/infinite-horror/statuses.js';

function state() {
  const actor = { id: 'actor-a', name: 'A', runtime: { hp: 10 }, effects: [] };
  const token = {
    id: 'token-a', actorId: 'actor-a', actorLink: false, actorDelta: null, effects: [],
    diameterMeters: 1, rotation: 0, elevationFt: 0, hidden: false, locked: false, showName: true,
    x: 1, y: 1,
  };
  return {
    version: 2,
    mapId: 'test',
    markers: [], attackAreas: [], sceneEvents: [],
    preferences: {
      entitySystem: { schemaVersion: 3, statusDefinitions: structuredClone(INFINITE_HORROR_STATUS_DEFINITIONS), actors: [actor], tokens: [token] },
      chatSystem: { messages: [] },
      combatSystem: { combat: null },
      worldV2: {
        schemaVersion: 2,
        id: 'world-test',
        name: 'Test World',
        ruleset: { id: 'infinite-horror', version: '1.0.0' },
        activeSceneId: 'scene-test',
        actors: [structuredClone(actor)],
        statusDefinitions: structuredClone(INFINITE_HORROR_STATUS_DEFINITIONS),
        scenes: [{
          id: 'scene-test', name: 'Test Scene', mapPackage: { id: 'test', version: '1' },
          tokens: [{
            id: 'token-a', actorId: 'actor-a', actorLink: false, actorDelta: null,
            placement: 'map', x: 1, y: 1, featureId: null,
            diameterMeters: 1, rotation: 0, elevationFt: 0,
            hidden: false, locked: false, showName: true, effects: [],
          }],
          markers: [], attackAreas: [], sceneEvents: [], settings: { gridVisible: true },
        }],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    },
  };
}

function rootedDelta() {
  return {
    effects: [{
      id: 'effect-rooted-instance',
      definitionId: 'status-rooted',
      stacks: 1,
      enabled: true,
    }],
  };
}

test('OWNER Player cannot forge Synthetic Actor effects through raw world.push', () => {
  const user = createBoundUser({ name: 'Alice', defaultActorId: 'actor-a' }).user;
  const before = state();
  const next = structuredClone(before);
  next.preferences.entitySystem.tokens[0].actorDelta = rootedDelta();
  next.preferences.worldV2.scenes[0].tokens[0].actorDelta = rootedDelta();

  const result = validatePlayerWorldPush({ before, next, user });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'status_gm_only');
});

test('server movement authority resolves rooted effect from unlinked Token ActorDelta', () => {
  const before = state();
  before.preferences.entitySystem.tokens[0].actorDelta = rootedDelta();
  before.preferences.worldV2.scenes[0].tokens[0].actorDelta = rootedDelta();

  const capabilities = resolveStatusCapabilitiesForToken(before, 'token-a');
  assert.equal(capabilities.canMove, false);
  assert.ok(capabilities.reasons.some(reason => /定身/.test(reason)));

  const user = createBoundUser({ name: 'Alice', defaultActorId: 'actor-a' }).user;
  const moved = structuredClone(before);
  moved.preferences.worldV2.scenes[0].tokens[0].x = 9;
  const denied = validatePlayerWorldPush({ before, next: moved, user });
  assert.equal(denied.code, 'status_movement_forbidden');
});
