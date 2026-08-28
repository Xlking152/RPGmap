import test from 'node:test';
import assert from 'node:assert/strict';
import { actorIdForToken, canControlActor, validateLocalPlayerChange } from '../src/multiplayer/permissions.js';

function state({ combat = null } = {}) {
  const actors = [
    { id: 'actor-a', name: 'A', system: { counter: 10 }, effects: [] },
    { id: 'actor-b', name: 'B', system: { counter: 10 }, effects: [] },
  ];
  const tokens = [
    { id: 'token-a', actorId: 'actor-a', actorLink: true, actorDelta: null, diameterMeters: 1, effects: [] },
    { id: 'token-b', actorId: 'actor-b', actorLink: true, actorDelta: null, diameterMeters: 1, effects: [] },
  ];
  return {
    version: 2,
    mapId: 'test',
    preferences: {
      entitySystem: { schemaVersion: 3, actors: structuredClone(actors), tokens: structuredClone(tokens), statusDefinitions: [] },
      chatSystem: { messages: [] },
      combatSystem: { combat },
      worldV2: {
        schemaVersion: 2,
        id: 'world-test',
        name: 'Test World',
        ruleset: { id: 'infinite-horror', version: '1.0.0' },
        activeSceneId: 'scene-test',
        actors: structuredClone(actors),
        statusDefinitions: [],
        scenes: [{
          id: 'scene-test', name: 'Test Scene', mapPackage: { id: 'test', version: '1' },
          tokens: [
            { id: 'token-a', actorId: 'actor-a', actorLink: true, actorDelta: null, placement: 'map', x: 1, y: 1, diameterMeters: 1, rotation: 0, elevationFt: 0, hidden: false, locked: false, showName: true, effects: [] },
            { id: 'token-b', actorId: 'actor-b', actorLink: true, actorDelta: null, placement: 'map', x: 2, y: 2, diameterMeters: 1, rotation: 0, elevationFt: 0, hidden: false, locked: false, showName: true, effects: [] },
          ],
          markers: [], attackAreas: [], sceneEvents: [], settings: { gridVisible: true },
        }],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    },
  };
}

function moveToken(value, tokenId, patch) {
  Object.assign(value.preferences.worldV2.scenes[0].tokens.find(token => token.id === tokenId), patch);
}

const playerPermissions = {
  actorOwnerIds: ['actor-a'],
  actorObserverIds: ['actor-a'],
  combatManage: false,
};

test('client maps canonical Token to Actor ownership', () => {
  assert.equal(actorIdForToken(state(), 'token-a'), 'actor-a');
  assert.equal(actorIdForToken(state(), 'token-b'), 'actor-b');
});

test('client preflight allows owned Token movement and blocks unowned Token movement', () => {
  const before = state();
  const owned = structuredClone(before);
  moveToken(owned, 'token-a', { x: 5 });
  assert.equal(validateLocalPlayerChange({ before, next: owned, permissions: playerPermissions }).ok, true);

  const unowned = structuredClone(before);
  moveToken(unowned, 'token-b', { x: 5 });
  assert.equal(validateLocalPlayerChange({ before, next: unowned, permissions: playerPermissions }).code, 'actor_not_owned');
});

test('client canControlActor follows active Combat turn', () => {
  assert.equal(canControlActor({ actorId: 'actor-a', state: state(), permissions: playerPermissions }), true);
  assert.equal(canControlActor({ actorId: 'actor-b', state: state(), permissions: playerPermissions }), false);

  const combat = {
    id: 'combat', state: 'active', round: 1, turnIndex: 0,
    combatants: [
      { id: 'cb-b', actorId: 'actor-b', tokenId: 'token-b', order: 0 },
      { id: 'cb-a', actorId: 'actor-a', tokenId: 'token-a', order: 1 },
    ],
  };
  assert.equal(canControlActor({ actorId: 'actor-a', state: state({ combat }), permissions: playerPermissions }), false);
  combat.turnIndex = 1;
  assert.equal(canControlActor({ actorId: 'actor-a', state: state({ combat }), permissions: playerPermissions }), true);
});

test('client resolves a combatant without actorId through canonical Token binding', () => {
  const combat = {
    id: 'combat', state: 'active', round: 1, turnIndex: 0,
    combatants: [{ id: 'cb-a', actorId: null, tokenId: 'token-a', order: 0 }],
  };
  const before = state({ combat });
  assert.equal(canControlActor({ actorId: 'actor-a', state: before, permissions: playerPermissions }), true);
  const next = structuredClone(before);
  next.preferences.entitySystem.actors[0].system.counter = 9;
  assert.equal(validateLocalPlayerChange({ before, next, permissions: playerPermissions }).ok, true);
});

test('GM wildcard bypasses local ownership preflight', () => {
  const before = state();
  const next = structuredClone(before);
  next.preferences.entitySystem.actors[1].system.counter = 1;
  next.preferences.combatSystem.combat = { id: 'c', state: 'setup', round: 0, turnIndex: 0, combatants: [] };
  assert.equal(validateLocalPlayerChange({ before, next, permissions: { actorOwnerIds: ['*'] } }).ok, true);
});

test('Player cannot change an owned Token diameter', () => {
  const before = state();
  const next = structuredClone(before);
  next.preferences.entitySystem.tokens[0].diameterMeters = 10;
  assert.equal(validateLocalPlayerChange({ before, next, permissions: playerPermissions }).code, 'token_size_gm_only');
});

test('Player cannot forge Actor, Token, or definition status changes through World push', () => {
  const before = state();
  const actorChange = structuredClone(before);
  actorChange.preferences.entitySystem.actors[0].effects.push({ id: 'effect-rooted', definitionId: 'status-rooted', stacks: 1, enabled: true });
  assert.equal(validateLocalPlayerChange({ before, next: actorChange, permissions: playerPermissions }).code, 'status_server_only');

  const tokenChange = structuredClone(before);
  tokenChange.preferences.entitySystem.tokens[0].effects.push({ id: 'effect-spirit', definitionId: 'status-spirit', stacks: 1, enabled: true });
  assert.equal(validateLocalPlayerChange({ before, next: tokenChange, permissions: playerPermissions }).code, 'status_server_only');

  const definitionChange = structuredClone(before);
  definitionChange.preferences.entitySystem.statusDefinitions.push({ id: 'custom', name: 'Custom' });
  assert.equal(validateLocalPlayerChange({ before, next: definitionChange, permissions: playerPermissions }).code, 'status_server_only');
});

test('World V2 mirror allows owned movement but keeps World structure GM-only', () => {
  const before = state();
  const moved = structuredClone(before);
  moveToken(moved, 'token-a', { x: 9 });
  moved.preferences.worldV2.updatedAt = '2026-01-01T00:00:01.000Z';
  assert.equal(validateLocalPlayerChange({ before, next: moved, permissions: playerPermissions }).ok, true);

  const rulesetTamper = structuredClone(before);
  rulesetTamper.preferences.worldV2.ruleset.id = 'forged-ruleset';
  assert.equal(validateLocalPlayerChange({ before, next: rulesetTamper, permissions: playerPermissions }).code, 'world_scope_forbidden');

  const sceneTamper = structuredClone(before);
  sceneTamper.preferences.worldV2.scenes.push({
    id: 'scene-forged', name: 'Forged', mapPackage: { id: 'test', version: '1' },
    tokens: [], markers: [], attackAreas: [], sceneEvents: [], settings: { gridVisible: true },
  });
  assert.equal(validateLocalPlayerChange({ before, next: sceneTamper, permissions: playerPermissions }).code, 'world_scope_forbidden');
});

test('client preflight rejects Character-era identity fields', () => {
  const before = state();
  const next = structuredClone(before);
  next.characters = [];
  assert.equal(validateLocalPlayerChange({ before, next, permissions: playerPermissions }).code, 'legacy_character_forbidden');
});
