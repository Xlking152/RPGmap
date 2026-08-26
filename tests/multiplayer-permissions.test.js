import test from 'node:test';
import assert from 'node:assert/strict';
import { actorIdForCharacter, canControlActor, validateLocalPlayerChange } from '../src/multiplayer/permissions.js';

function state({ combat = null } = {}) {
  return {
    version: 2,
    mapId: 'test',
    characters: [
      { id: 'token-a', location: { type: 'map', x: 1, y: 1 } },
      { id: 'token-b', location: { type: 'map', x: 2, y: 2 } },
    ],
    preferences: {
      entitySystem: {
        actors: [
          { id: 'actor-a', runtime: { hp: 10 } },
          { id: 'actor-b', runtime: { hp: 10 } },
        ],
        tokens: [
          { id: 'token-a', characterId: 'token-a', actorId: 'actor-a' },
          { id: 'token-b', characterId: 'token-b', actorId: 'actor-b' },
        ],
      },
      chatSystem: { messages: [] },
      combatSystem: { combat },
    },
  };
}

const playerPermissions = {
  actorOwnerIds: ['actor-a'],
  actorObserverIds: ['actor-a'],
  combatManage: false,
};

test('client maps Character/Token to Actor ownership', () => {
  assert.equal(actorIdForCharacter(state(), 'token-a'), 'actor-a');
  assert.equal(actorIdForCharacter(state(), 'token-b'), 'actor-b');
});

test('client preflight allows owned actor changes and blocks unowned changes', () => {
  const before = state();
  const owned = structuredClone(before);
  owned.characters[0].location.x = 5;
  assert.equal(validateLocalPlayerChange({ before, next: owned, permissions: playerPermissions }).ok, true);

  const unowned = structuredClone(before);
  unowned.characters[1].location.x = 5;
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

test('client resolves a legacy current combatant through its Token binding', () => {
  const combat = {
    id: 'combat', state: 'active', round: 1, turnIndex: 0,
    combatants: [{ id: 'cb-a', actorId: null, tokenId: 'token-a', order: 0 }],
  };
  const before = state({ combat });
  assert.equal(canControlActor({ actorId: 'actor-a', state: before, permissions: playerPermissions }), true);
  const next = structuredClone(before);
  next.preferences.entitySystem.actors[0].runtime.health = { mode: 'wound-track', wounds: { bashing: 1, lethal: 0, aggravated: 0 } };
  assert.equal(validateLocalPlayerChange({ before, next, permissions: playerPermissions }).ok, true);
});

test('GM wildcard bypasses local ownership preflight', () => {
  const before = state();
  const next = structuredClone(before);
  next.preferences.entitySystem.actors[1].runtime.hp = 1;
  next.preferences.combatSystem.combat = { id: 'c', state: 'setup', round: 0, turnIndex: 0, combatants: [] };
  assert.equal(validateLocalPlayerChange({ before, next, permissions: { actorOwnerIds: ['*'] } }).ok, true);
});

test('Player cannot change an owned Token diameter', () => {
  const before = state();
  const next = structuredClone(before);
  next.preferences.entitySystem.tokens[0].diameterMeters = 10;
  assert.equal(
    validateLocalPlayerChange({ before, next, permissions: playerPermissions }).code,
    'token_size_gm_only',
  );
});

test('Player cannot forge Actor, Token, or definition status changes through World push', () => {
  const before = state();
  before.preferences.entitySystem.statusDefinitions = [];
  before.preferences.entitySystem.actors.forEach(actor => { actor.effects = []; });
  before.preferences.entitySystem.tokens.forEach(token => { token.effects = []; });

  const actorChange = structuredClone(before);
  actorChange.preferences.entitySystem.actors[0].effects.push({
    id: 'effect-rooted', definitionId: 'status-rooted', stacks: 1, enabled: true,
  });
  assert.equal(validateLocalPlayerChange({ before, next: actorChange, permissions: playerPermissions }).code, 'status_server_only');

  const tokenChange = structuredClone(before);
  tokenChange.preferences.entitySystem.tokens[0].effects.push({
    id: 'effect-spirit', definitionId: 'status-spirit', stacks: 1, enabled: true,
  });
  assert.equal(validateLocalPlayerChange({ before, next: tokenChange, permissions: playerPermissions }).code, 'status_server_only');

  const definitionChange = structuredClone(before);
  definitionChange.preferences.entitySystem.statusDefinitions.push({ id: 'custom', name: 'Custom' });
  assert.equal(validateLocalPlayerChange({ before, next: definitionChange, permissions: playerPermissions }).code, 'status_server_only');
});
