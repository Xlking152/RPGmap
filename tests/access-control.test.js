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

function addWorldV2(value) {
  value.preferences.worldV2 = {
    schemaVersion: 2,
    id: 'world-test',
    name: 'Test World',
    ruleset: { id: 'infinite-horror', version: '1.0.0' },
    activeSceneId: 'scene-test',
    actors: [],
    statusDefinitions: [],
    scenes: [{
      id: 'scene-test', name: 'Test Scene', mapPackage: { id: 'test', version: '1' },
      tokens: [], markers: [], attackAreas: [], sceneEvents: [], settings: { gridVisible: true },
    }],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  return value;
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

test('server resolves legacy combat turns without actorId through the Token binding', () => {
  const user = createBoundUser({ name: 'Alice', defaultActorId: 'actor-a' }).user;
  const before = world({ activeActorId: 'actor-a' });
  before.preferences.combatSystem.combat.combatants[0].actorId = null;
  const next = structuredClone(before);
  next.preferences.entitySystem.actors[0].runtime.health = { mode: 'wound-track', wounds: { bashing: 1, lethal: 0, aggravated: 0 } };
  assert.equal(validatePlayerWorldPush({ before, next, user }).ok, true);
});

test('World schema rejects duplicate raw IDs before permission Maps can collapse them', () => {
  const duplicateActor = world();
  duplicateActor.preferences.entitySystem.actors.push({ id: 'actor-a', name: 'shadow duplicate' });
  assert.throws(() => assertWorldState(duplicateActor), { code: 'duplicate_id' });

  const duplicateToken = world();
  duplicateToken.preferences.entitySystem.tokens.push({ id: 'token-a', characterId: 'token-b', actorId: 'actor-b' });
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
  before.preferences.entitySystem.schemaVersion = 3;

  const actorEffect = structuredClone(before);
  actorEffect.preferences.entitySystem.actors[0].effects = [{
    id: 'effect-rooted', definitionId: 'status-rooted', stacks: 1, enabled: true,
  }];
  assert.equal(validatePlayerWorldPush({ before, next: actorEffect, user }).code, 'status_gm_only');

  const tokenEffect = structuredClone(before);
  tokenEffect.preferences.entitySystem.tokens[0].effects = [{
    id: 'effect-spirit', definitionId: 'status-spirit', stacks: 1, enabled: true,
  }];
  assert.equal(validatePlayerWorldPush({ before, next: tokenEffect, user }).code, 'status_gm_only');

  const definition = structuredClone(before);
  definition.preferences.entitySystem.statusDefinitions = [{
    id: 'custom-slow', name: 'Slow', scopes: ['actor'], maxStacks: 1,
    category: 'debuff', color: '#445566', changes: [], capabilities: { canMove: false },
  }];
  assert.equal(validatePlayerWorldPush({ before, next: definition, user }).code, 'status_gm_only');
});

test('authoritative status and derived health capabilities block Player movement', () => {
  const user = createBoundUser({ name: 'Alice', defaultActorId: 'actor-a' }).user;

  const rooted = world();
  rooted.preferences.entitySystem.schemaVersion = 3;
  rooted.preferences.entitySystem.actors[0].effects = [{
    id: 'effect-rooted', definitionId: 'status-rooted', stacks: 1, enabled: true,
  }];
  const rootedMove = structuredClone(rooted);
  rootedMove.characters[0].location.x = 9;
  assert.equal(validatePlayerWorldPush({ before: rooted, next: rootedMove, user }).code, 'status_movement_forbidden');

  for (const [label, wounds] of [
    ['unconscious', { bashing: 2, lethal: 0, aggravated: 0 }],
    ['dead', { bashing: 0, lethal: 0, aggravated: 2 }],
  ]) {
    const incapacitated = world();
    incapacitated.preferences.entitySystem.actors[0] = {
      id: 'actor-a', name: 'A', currentFormId: 'form-a',
      forms: [{ id: 'form-a', resourceBases: { hp: { baseMax: 2 } }, source: { type: 'xlsx' } }],
      runtime: {
        resources: { hp: { current: 0, maxOverride: null } },
        health: { mode: 'wound-track', wounds },
      },
      effects: [],
    };
    const moved = structuredClone(incapacitated);
    moved.characters[0].location.y = 11;
    const denied = validatePlayerWorldPush({ before: incapacitated, next: moved, user });
    assert.equal(denied.code, 'status_movement_forbidden', label);
  }
});

test('server Player permissions allow mirrored World V2 movement but protect World structure', () => {
  const user = createBoundUser({ name: 'Alice', defaultActorId: 'actor-a' }).user;
  const before = addWorldV2(world());
  const moved = structuredClone(before);
  moved.characters[0].location.x = 9;
  assert.equal(validatePlayerWorldPush({ before, next: moved, user }).ok, true);
  assert.equal(moved.preferences.worldV2.scenes[0].tokens[0].x, 9);

  const rulesetTamper = structuredClone(before);
  rulesetTamper.preferences.worldV2.ruleset.id = 'forged-ruleset';
  assert.equal(validatePlayerWorldPush({ before, next: rulesetTamper, user }).code, 'world_scope_forbidden');

  const sceneTamper = structuredClone(before);
  sceneTamper.preferences.worldV2.scenes.push({
    id: 'scene-forged', name: 'Forged', mapPackage: { id: 'test', version: '1' },
    tokens: [], markers: [], attackAreas: [], sceneEvents: [], settings: { gridVisible: true },
  });
  assert.equal(validatePlayerWorldPush({ before, next: sceneTamper, user }).code, 'world_scope_forbidden');
});
