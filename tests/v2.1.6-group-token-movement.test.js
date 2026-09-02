import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createMovementTokenRuntimeSystem } from '../src/movement/token-runtime.js';
import { validateLocalPlayerChange } from '../src/multiplayer/permissions.js';
import { createBoundUser, validatePlayerWorldPush } from '../deployment/local-server/access-control.mjs';
import { INFINITE_HORROR_STATUS_DEFINITIONS } from '../src/rulesets/infinite-horror/statuses.js';

function actor() {
  return { id: 'actor-a', name: 'A', type: 'pc', partyId: 'party-default', system: {}, effects: [] };
}

function token(id, x, y, elevationFt = 0) {
  return {
    id, actorId: 'actor-a', actorLink: true, actorDelta: null,
    placement: 'map', x, y, featureId: null,
    diameterMeters: 1, rotation: 0, elevationFt,
    controllerUserIds: [],
    visibility: { mode: 'party', userIds: [] },
    vision: {
      enabled: true,
      preciseRangeOverrideMeters: null,
      vagueRangeOverrideMeters: null,
      overrideUserIds: [],
    },
    locked: false, showName: true, effects: [],
  };
}

function world(tokens) {
  return {
    schemaVersion: 3,
    id: 'world-test', name: 'World',
    ruleset: { id: 'infinite-horror', version: '1.0.0' },
    actors: [actor()],
    statusDefinitions: structuredClone(INFINITE_HORROR_STATUS_DEFINITIONS),
    activeSceneId: 'scene-a',
    scenes: [{
      id: 'scene-a', name: 'Scene', mapPackage: { id: 'map', version: '1' },
      tokens: structuredClone(tokens), markers: [], attackAreas: [], sceneEvents: [],
      featureStates: {}, fog: { schemaVersion: 1, cellSizeMeters: 5, exploredByParty: {} }, settings: {},
    }],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function movementFixture() {
  const initial = [token('leader', 2.5, 2.5), token('wing', 5.5, 3.5, 20)];
  let currentWorld = world(initial);
  let commits = 0;
  const listeners = new Map();
  const prepared = new Map();
  const api = {
    mapPackage: {
      id: 'map', mapId: 'map', version: '1', width: 20, height: 20,
      features: [], roadBuffers: [], liquidBodies: [], floodRules: {}, navigation: {},
    },
    getState() { return { preferences: { featureStates: {} }, sceneEvents: [] }; },
    tokens: {
      get(id) { return structuredClone(currentWorld.scenes[0].tokens.find(item => item.id === String(id)) || null); },
      list() { return structuredClone(currentWorld.scenes[0].tokens); },
    },
    world: {
      get() { return structuredClone(currentWorld); },
      getActiveScene() { return structuredClone(currentWorld.scenes[0]); },
      async commit(next) { commits += 1; currentWorld = structuredClone(next); return structuredClone(currentWorld); },
    },
    status: {
      resolve() {
        return { statusVersion: 'test', statuses: [], capabilities: { canMove: true, canInteract: true, collisionBypassGroups: [] } };
      },
    },
    renderer: {
      prepareTokenVisualRoute(id, points) { prepared.set(String(id), structuredClone(points)); return true; },
    },
    on(name, listener) {
      const set = listeners.get(name) || new Set(); set.add(listener); listeners.set(name, set); return () => set.delete(listener);
    },
    emit(name, detail) { for (const listener of listeners.get(name) || []) listener({ detail }); },
  };
  createMovementTokenRuntimeSystem().register(api);
  return { api, prepared, get commits() { return commits; }, getWorld: () => structuredClone(currentWorld) };
}

function once(api, name) {
  return new Promise(resolve => {
    const off = api.on(name, event => { off(); resolve(event.detail); });
  });
}

test('atomic group move preserves formation, elevation and visual waypoint translation', async () => {
  const fx = movementFixture();
  const leaderPath = [{ x: 2.5, y: 2.5 }, { x: 8.5, y: 2.5 }, { x: 8.5, y: 8.5 }];
  const plan = await fx.api.movement.planTokenGroupMove(['leader', 'wing'], 'leader', leaderPath);
  assert.equal(plan.valid, true);
  const done = once(fx.api, 'token:group-move');
  assert.equal(fx.api.movement.commitTokenGroupMove(), true);
  await done;
  assert.equal(fx.commits, 1, 'the whole formation must use one canonical World commit');

  const [leader, wing] = fx.getWorld().scenes[0].tokens;
  assert.deepEqual({ x: leader.x, y: leader.y }, { x: 8.5, y: 8.5 });
  assert.deepEqual({ x: wing.x, y: wing.y }, { x: 11.5, y: 9.5 });
  assert.equal(wing.elevationFt, 20);
  assert.deepEqual(fx.prepared.get('leader'), [{ x: 8.5, y: 2.5 }, { x: 8.5, y: 8.5 }]);
  assert.deepEqual(fx.prepared.get('wing'), [{ x: 11.5, y: 3.5 }, { x: 11.5, y: 9.5 }]);
});

test('group planning rejects the whole formation when one translated member leaves the map', async () => {
  const fx = movementFixture();
  const before = fx.getWorld();
  const plan = await fx.api.movement.planTokenGroupMove(
    ['leader', 'wing'], 'leader', [{ x: 2.5, y: 2.5 }, { x: 18.5, y: 2.5 }],
  );
  assert.equal(plan, null);
  assert.equal(fx.api.movement.commitTokenGroupMove(), false);
  assert.equal(fx.commits, 0);
  assert.deepEqual(fx.getWorld(), before);
});

function permissionState({ combat = false } = {}) {
  const tokens = [token('token-a', 2, 2), token('token-b', 5, 3)];
  const canonicalTokens = tokens.map(item => {
    const copy = structuredClone(item); delete copy.placement; delete copy.featureId; return copy;
  });
  const value = {
    version: 2, mapId: 'test',
    preferences: {
      entitySystem: { schemaVersion: 4, actors: [actor()], tokens: canonicalTokens, statusDefinitions: structuredClone(INFINITE_HORROR_STATUS_DEFINITIONS) },
      chatSystem: { messages: [] },
      combatSystem: { combat: combat ? {
        id: 'combat', state: 'active', round: 1, turnIndex: 0,
        combatants: [{ id: 'cb-a', tokenId: 'token-a', actorId: 'actor-a', initiative: 10, order: 0 }],
      } : null },
      worldV2: world(tokens),
    },
  };
  return value;
}

function moveBoth(value) {
  const tokens = value.preferences.worldV2.scenes[0].tokens;
  tokens[0].x += 4; tokens[0].y += 2;
  tokens[1].x += 4; tokens[1].y += 2;
}

test('Player may group-move owned Tokens outside Combat but not during active Combat', () => {
  let before = permissionState();
  let next = structuredClone(before); moveBoth(next);
  const permissions = { actorOwnerIds: ['actor-a'] };
  assert.equal(validateLocalPlayerChange({ before, next, permissions }).ok, true);
  const user = createBoundUser({ name: 'Player', defaultActorId: 'actor-a' }).user;
  assert.equal(validatePlayerWorldPush({ before, next, user }).ok, true);

  before = permissionState({ combat: true });
  next = structuredClone(before); moveBoth(next);
  assert.equal(validateLocalPlayerChange({ before, next, permissions }).code, 'combat_group_move_gm_only');
  assert.equal(validatePlayerWorldPush({ before, next, user }).code, 'combat_group_move_gm_only');
});

test('v2.1.6 keeps group movement transient, Token-first and render-only outside canonical commit', async () => {
  const [controller, runtime, ghost, renderer] = await Promise.all([
    readFile(new URL('../src/movement/controller.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/movement/token-runtime.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/movement/ghost-renderer.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/render/token-layer.js', import.meta.url), 'utf8'),
  ]);
  assert.match(controller, /getSelectedTokenIds/);
  assert.match(controller, /members\.length > 1/);
  assert.match(controller, /planTokenGroupMove/);
  assert.match(runtime, /source: 'movement:group'/);
  assert.match(runtime, /planTokenGroupMove/);
  assert.match(ghost, /getGroupPreviewMembers/);
  assert.match(renderer, /prepareTokenVisualRoute/);
  for (const source of [controller, runtime, ghost, renderer]) {
    assert.doesNotMatch(source, /\btokenGroups\b|class\s+TokenGroup|state\.characters|characterId/);
  }
});
