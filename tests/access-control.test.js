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
import { assertWorldState } from '../deployment/local-server/world-schema.mjs';
import { INFINITE_HORROR_STATUS_DEFINITIONS } from '../src/rulesets/infinite-horror/statuses.js';
import { migrateTestStateToWorldV3 } from './helpers/world-v3.js';

function canonicalToken(id, actorId, x, y) {
  return {
    id, actorId, actorLink: true, actorDelta: null,
    diameterMeters: 1, rotation: 0, elevationFt: 0,
    hidden: false, locked: false, showName: true, effects: [], x, y,
  };
}

function sceneToken(id, actorId, x, y) {
  return {
    id, actorId, actorLink: true, actorDelta: null,
    placement: 'map', x, y, featureId: null,
    diameterMeters: 1, rotation: 0, elevationFt: 0,
    hidden: false, locked: false, showName: true, effects: [],
  };
}

function world({ activeActorId = null } = {}) {
  const actors = [
    { id: 'actor-a', name: 'A', system: { counter: 10 }, effects: [] },
    { id: 'actor-b', name: 'B', system: { counter: 10 }, effects: [] },
  ];
  const tokens = [canonicalToken('token-a', 'actor-a', 1, 1), canonicalToken('token-b', 'actor-b', 2, 2)];
  const combatants = [
    { id: 'cb-a', tokenId: 'token-a', actorId: 'actor-a', initiative: 10, order: 0 },
    { id: 'cb-b', tokenId: 'token-b', actorId: 'actor-b', initiative: 5, order: 1 },
  ];
  const turnIndex = activeActorId === 'actor-b' ? 1 : 0;
  return migrateTestStateToWorldV3({
    version: 2,
    mapId: 'test',
    preferences: {
      entitySystem: {
        schemaVersion: 3,
        actors: structuredClone(actors),
        tokens: structuredClone(tokens),
        statusDefinitions: structuredClone(INFINITE_HORROR_STATUS_DEFINITIONS),
      },
      chatSystem: { messages: [] },
      combatSystem: { combat: activeActorId ? { id: 'combat', state: 'active', round: 1, turnIndex, combatants } : null },
      worldV2: {
        schemaVersion: 2,
        id: 'world-test',
        name: 'Test World',
        ruleset: { id: 'infinite-horror', version: '1.0.0' },
        activeSceneId: 'scene-test',
        actors: structuredClone(actors),
        statusDefinitions: structuredClone(INFINITE_HORROR_STATUS_DEFINITIONS),
        scenes: [{
          id: 'scene-test', name: 'Test Scene', mapPackage: { id: 'test', version: '1' },
          tokens: [sceneToken('token-a', 'actor-a', 1, 1), sceneToken('token-b', 'actor-b', 2, 2)],
          markers: [], attackAreas: [], sceneEvents: [], settings: { gridVisible: true },
        }],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    },
  });
}

function moveToken(state, tokenId, patch) {
  const token = state.preferences.worldV2.scenes[0].tokens.find(item => item.id === tokenId);
  Object.assign(token, patch);
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

test('access normalization preserves formal monster placement grants', () => {
  const normalized = normalizeAccessState({ users: [{
    id: 'u-monster', name: 'Monster Handler',
    placementGrants: { actorTypes: ['monster', 'npc', 'forged'], actorIds: [], markerKinds: [] },
  }] });
  assert.deepEqual(normalized.users[0].placementGrants.actorTypes, ['monster', 'npc']);
});

test('Player may change owned Actor but not unowned Actor or Combat state in World V2', () => {
  const user = createBoundUser({ name: 'Alice', defaultActorId: 'actor-a' }).user;
  const before = world();
  const owned = structuredClone(before);
  owned.preferences.entitySystem.actors[0].system.counter = 9;
  assert.equal(validatePlayerWorldPush({ before, next: owned, user }).ok, true);
  const unowned = structuredClone(before);
  unowned.preferences.entitySystem.actors[1].system.counter = 9;
  assert.equal(validatePlayerWorldPush({ before, next: unowned, user }).code, 'actor_not_owned');
  const combat = structuredClone(before);
  combat.preferences.combatSystem.combat = { id: 'c', state: 'active', round: 1, turnIndex: 0, combatants: [] };
  assert.equal(validatePlayerWorldPush({ before, next: combat, user }).code, 'combat_gm_only');
});

test('active Combat only permits the current owned Actor to change', () => {
  const user = createBoundUser({ name: 'Alice', defaultActorId: 'actor-a' }).user;
  const ownTurn = world({ activeActorId: 'actor-a' });
  const allowed = structuredClone(ownTurn);
  allowed.preferences.entitySystem.actors[0].system.counter = 8;
  assert.equal(validatePlayerWorldPush({ before: ownTurn, next: allowed, user }).ok, true);
  const otherTurn = world({ activeActorId: 'actor-b' });
  const denied = structuredClone(otherTurn);
  denied.preferences.entitySystem.actors[0].system.counter = 8;
  assert.equal(validatePlayerWorldPush({ before: otherTurn, next: denied, user }).code, 'combat_turn_locked');
});

test('Combat resolves a missing combatant actorId through canonical Token binding', () => {
  const user = createBoundUser({ name: 'Alice', defaultActorId: 'actor-a' }).user;
  const before = world({ activeActorId: 'actor-a' });
  before.preferences.combatSystem.combat.combatants[0].actorId = null;
  const next = structuredClone(before);
  next.preferences.entitySystem.actors[0].system.counter = 9;
  assert.equal(validatePlayerWorldPush({ before, next, user }).ok, true);
});

test('World schema rejects duplicate raw IDs before permission Maps can collapse them', () => {
  const duplicateActor = world();
  duplicateActor.preferences.entitySystem.actors.push({ id: 'actor-a', name: 'shadow duplicate', effects: [] });
  assert.throws(() => assertWorldState(duplicateActor), { code: 'duplicate_id' });
  const duplicateToken = world();
  duplicateToken.preferences.entitySystem.tokens.push(canonicalToken('token-a', 'actor-b', 3, 3));
  assert.throws(() => assertWorldState(duplicateToken), { code: 'duplicate_id' });
});

test('only GM may modify Token diameter and the schema bounds allowed values', () => {
  const user = createBoundUser({ name: 'Alice', defaultActorId: 'actor-a' }).user;
  const before = world();
  const changed = structuredClone(before);
  changed.preferences.entitySystem.tokens[0].diameterMeters = 10;
  assert.equal(validatePlayerWorldPush({ before, next: changed, user }).code, 'token_size_gm_only');
  const invalidDiameter = world();
  invalidDiameter.preferences.entitySystem.tokens[0].diameterMeters = 7;
  assert.throws(() => assertWorldState(invalidDiameter), /diameterMeters/);
});

test('Player World pushes cannot rewrite status definitions or Actor/Token effects', () => {
  const user = createBoundUser({ name: 'Alice', defaultActorId: 'actor-a' }).user;
  const before = world();
  const actorEffect = structuredClone(before);
  actorEffect.preferences.entitySystem.actors[0].effects = [{ id: 'effect-rooted', definitionId: 'status-rooted', stacks: 1, enabled: true }];
  assert.equal(validatePlayerWorldPush({ before, next: actorEffect, user }).code, 'status_gm_only');
  const tokenEffect = structuredClone(before);
  tokenEffect.preferences.entitySystem.tokens[0].effects = [{ id: 'effect-spirit', definitionId: 'status-spirit', stacks: 1, enabled: true }];
  assert.equal(validatePlayerWorldPush({ before, next: tokenEffect, user }).code, 'status_gm_only');
  const definition = structuredClone(before);
  definition.preferences.entitySystem.statusDefinitions = [{ id: 'custom-slow', name: 'Slow', scopes: ['actor'], maxStacks: 1, category: 'debuff', color: '#445566', icon: 'anchor', description: '', changes: [], capabilities: { canMove: false } }];
  assert.equal(validatePlayerWorldPush({ before, next: definition, user }).code, 'status_gm_only');
});

test('authoritative World status capabilities block canonical Token movement', () => {
  const user = createBoundUser({ name: 'Alice', defaultActorId: 'actor-a' }).user;
  const rooted = world();
  rooted.preferences.entitySystem.actors[0].effects = [{ id: 'effect-rooted', definitionId: 'status-rooted', stacks: 1, enabled: true }];
  const rootedMove = structuredClone(rooted);
  moveToken(rootedMove, 'token-a', { x: 9 });
  assert.equal(validatePlayerWorldPush({ before: rooted, next: rootedMove, user }).code, 'status_movement_forbidden');
});

test('server Player permissions allow canonical World V2 movement but protect World structure', () => {
  const user = createBoundUser({ name: 'Alice', defaultActorId: 'actor-a' }).user;
  const before = world();
  const moved = structuredClone(before);
  moveToken(moved, 'token-a', { x: 9 });
  const movementResult = validatePlayerWorldPush({ before, next: moved, user });
  assert.equal(movementResult.ok, true, JSON.stringify(movementResult));
  assert.equal(moved.preferences.worldV2.scenes[0].tokens[0].x, 9);
  assert.equal(Object.hasOwn(moved, 'characters'), false);

  const rulesetTamper = structuredClone(before);
  rulesetTamper.preferences.worldV2.ruleset.id = 'forged-ruleset';
  assert.equal(validatePlayerWorldPush({ before, next: rulesetTamper, user }).code, 'world_scope_forbidden');

  const sceneTamper = structuredClone(before);
  sceneTamper.preferences.worldV2.scenes.push({
    id: 'scene-forged', name: 'Forged', mapPackage: { id: 'test', version: '1' },
    tokens: [], markers: [], attackAreas: [], sceneEvents: [], featureStates: {},
    fog: { schemaVersion: 1, cellSizeMeters: 5, exploredByParty: {} },
    settings: { gridVisible: true },
  });
  assert.equal(validatePlayerWorldPush({ before, next: sceneTamper, user }).code, 'world_scope_forbidden');
});
