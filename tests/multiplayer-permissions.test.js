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

test('GM wildcard bypasses local ownership preflight', () => {
  const before = state();
  const next = structuredClone(before);
  next.preferences.entitySystem.actors[1].runtime.hp = 1;
  next.preferences.combatSystem.combat = { id: 'c', state: 'setup', round: 0, turnIndex: 0, combatants: [] };
  assert.equal(validateLocalPlayerChange({ before, next, permissions: { actorOwnerIds: ['*'] } }).ok, true);
});
