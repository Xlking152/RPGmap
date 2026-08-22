import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createBoundUser,
  createClaimableUser,
  bindWithPlayerKey,
  normalizeAccessState,
  resetUserPlayerKey,
  validatePlayerWorldPush,
  verifyPlayerKey,
  verifyUserCredential,
} from '../deployment/local-server/access-control.mjs';

function world({ activeActorId = null } = {}) {
  const combatants = [
    { id: 'cb-a', tokenId: 'token-a', actorId: 'actor-a', initiative: 10, order: 0 },
    { id: 'cb-b', tokenId: 'token-b', actorId: 'actor-b', initiative: 5, order: 1 },
  ];
  const turnIndex = activeActorId === 'actor-b' ? 1 : 0;
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
          { id: 'actor-a', name: 'A', runtime: { hp: 10 } },
          { id: 'actor-b', name: 'B', runtime: { hp: 10 } },
        ],
        tokens: [
          { id: 'token-a', characterId: 'token-a', actorId: 'actor-a' },
          { id: 'token-b', characterId: 'token-b', actorId: 'actor-b' },
        ],
      },
      chatSystem: { messages: [] },
      combatSystem: { combat: activeActorId ? { id: 'combat', state: 'active', round: 1, turnIndex, combatants } : null },
    },
  };
}

test('persistent User stores hashes while returning portable Player Key and browser credential', () => {
  const { user, authToken, playerKey } = createBoundUser({ name: 'Alice', defaultActorId: 'actor-a' });
  assert.equal(authToken, playerKey);
  assert.match(playerKey, /^[0-9A-F]{16}$/);
  assert.equal(user.ownership['actor-a'], 'owner');
  assert.equal(verifyUserCredential(user, authToken), true);
  assert.equal(verifyPlayerKey(user, playerKey), true);
  assert.notEqual(user.tokenHash, authToken);
  assert.notEqual(user.playerKeyHash, playerKey);
});

test('pre-created User can issue browser credential from reusable Player Key and key can be rotated', () => {
  const { user, playerKey } = createClaimableUser({ name: 'Prepared' });
  assert.equal(verifyPlayerKey(user, playerKey), true);
  const browserToken = bindWithPlayerKey(user, playerKey);
  assert.ok(browserToken);
  assert.equal(verifyUserCredential(user, browserToken), true);
  assert.equal(verifyPlayerKey(user, playerKey), true);
  const newKey = resetUserPlayerKey(user);
  assert.equal(verifyPlayerKey(user, playerKey), false);
  assert.equal(verifyUserCredential(user, browserToken), false);
  assert.equal(verifyPlayerKey(user, newKey), true);
});

test('access normalization never exposes raw credentials and keeps default Actor OWNER', () => {
  const normalized = normalizeAccessState({ users: [{
    id: 'u1', name: 'Alice', defaultActorId: 'actor-a', ownership: { 'actor-a': 'observer' },
    tokenHash: 'a'.repeat(64), playerKeyHash: 'b'.repeat(64),
  }] });
  assert.equal(normalized.users[0].defaultActorId, null);
  assert.equal(normalized.users[0].ownership['actor-a'], 'observer');
});

test('Player may change owned Actor but not unowned Actor or Combat state', () => {
  const user = createBoundUser({ name: 'Alice', defaultActorId: 'actor-a' }).user;
  const before = world();
  const owned = structuredClone(before);
  owned.preferences.entitySystem.actors[0].runtime.hp = 9;
  assert.equal(validatePlayerWorldPush({ before, next: owned, user }).ok, true);

  const unowned = structuredClone(before);
  unowned.preferences.entitySystem.actors[1].runtime.hp = 9;
  assert.equal(validatePlayerWorldPush({ before, next: unowned, user }).code, 'actor_not_owned');

  const combat = structuredClone(before);
  combat.preferences.combatSystem.combat = { id: 'c', state: 'active', round: 1, turnIndex: 0, combatants: [] };
  assert.equal(validatePlayerWorldPush({ before, next: combat, user }).code, 'combat_gm_only');
});

test('active Combat only permits the current owned Actor to change', () => {
  const user = createBoundUser({ name: 'Alice', defaultActorId: 'actor-a' }).user;
  const ownTurn = world({ activeActorId: 'actor-a' });
  const allowed = structuredClone(ownTurn);
  allowed.preferences.entitySystem.actors[0].runtime.hp = 8;
  assert.equal(validatePlayerWorldPush({ before: ownTurn, next: allowed, user }).ok, true);

  const otherTurn = world({ activeActorId: 'actor-b' });
  const denied = structuredClone(otherTurn);
  denied.preferences.entitySystem.actors[0].runtime.hp = 8;
  assert.equal(validatePlayerWorldPush({ before: otherTurn, next: denied, user }).code, 'combat_turn_locked');
});
