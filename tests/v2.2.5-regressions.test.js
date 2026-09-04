import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createMovementFastPathSystem } from '../src/movement/fast-path.js';
import { userControlsToken, currentCombatTokenId } from '../deployment/local-server/access-control.mjs';

const movementController = readFileSync(new URL('../src/movement/controller.js', import.meta.url), 'utf8');
const movementIndex = readFileSync(new URL('../src/movement/index.js', import.meta.url), 'utf8');
const multiplayerIndex = readFileSync(new URL('../src/multiplayer/index.js', import.meta.url), 'utf8');
const serverAccess = readFileSync(new URL('../deployment/local-server/access-control.mjs', import.meta.url), 'utf8');
const healthIndex = readFileSync(new URL('../src/health/index.js', import.meta.url), 'utf8');
const selectionHud = readFileSync(new URL('../src/health/selection-hud.js', import.meta.url), 'utf8');
const tokenBars = readFileSync(new URL('../src/health/token-bars.js', import.meta.url), 'utf8');

function token(id, actorId, x, y) {
  return {
    id, actorId, actorLink: true, actorDelta: null,
    placement: 'map', x, y, featureId: null,
    diameterMeters: 1, rotation: 0, elevationFt: 0,
    hidden: false, locked: false, showName: true, effects: [],
  };
}

function movementFixture() {
  let currentWorld = {
    schemaVersion: 2,
    id: 'world-fast', name: 'Fast',
    ruleset: { id: 'infinite-horror', version: '1.0.0' },
    actors: [{ id: 'actor-a', name: 'A' }],
    statusDefinitions: [], activeSceneId: 'scene-a',
    scenes: [{
      id: 'scene-a', name: 'Scene', mapPackage: { id: 'map', version: '1' },
      tokens: [token('a', 'actor-a', 1.5, 1.5), token('b', 'actor-a', 2.5, 2.5)],
      markers: [], attackAreas: [], sceneEvents: [], settings: {},
    }],
  };
  let inspectCount = 0;
  const api = {
    mapPackage: {
      id: 'map', mapId: 'map', version: '1', width: 20, height: 20,
      features: [], roadBuffers: [], liquidBodies: [], floodRules: {}, navigation: {},
    },
    getState: () => ({ preferences: { featureStates: {} }, sceneEvents: [] }),
    tokens: {
      get(id) {
        return structuredClone(currentWorld.scenes[0].tokens.find(item => String(item.id) === String(id)) || null);
      },
    },
    world: {
      get: () => structuredClone(currentWorld),
      getActiveScene: () => structuredClone(currentWorld.scenes[0]),
      async commit(next) { currentWorld = structuredClone(next); return structuredClone(currentWorld); },
    },
    documents: {
      async dispatch(write) {
        const destination = write.data.waypoints.at(-1);
        const ids = new Set(write.data.tokenIds.map(String));
        currentWorld.scenes[0].tokens = currentWorld.scenes[0].tokens.map(item =>
          ids.has(String(item.id)) ? { ...item, x: destination.x, y: destination.y } : item);
        return { revision: 1, motion: write.data.tokenIds.map(tokenId => ({ tokenId, to: destination })) };
      },
    },
    status: {
      resolve: () => ({ statusVersion: 'same', capabilities: { canMove: true, collisionBypassGroups: [] } }),
    },
    movement: {
      canonicalSceneTokens: true,
      inspectMovementAccess(id, destination, options = {}) {
        inspectCount += 1;
        const value = api.tokens.get(id);
        return { valid: true, token: value, from: options.from || { x: value.x, y: value.y }, destination };
      },
      invalidateNavigation() {},
    },
    emit() {},
    on() { return () => {}; },
  };
  createMovementFastPathSystem().register(api);
  return { api, getWorld: () => structuredClone(currentWorld), getInspectCount: () => inspectCount };
}

test('v2.2.5 preserves token-first control for NPC and monster instances', () => {
  const state = {
    preferences: {
      entitySystem: { actors: [], tokens: [] },
      worldV2: {
        activeSceneId: 'scene',
        actors: [
          { id: 'npc-template', type: 'npc' },
          { id: 'pc-a', type: 'pc' },
        ],
        scenes: [{
          id: 'scene',
          tokens: [
            { id: 'npc-1', actorId: 'npc-template', controllerUserIds: ['user-a'] },
            { id: 'npc-2', actorId: 'npc-template', controllerUserIds: [] },
            { id: 'pc-1', actorId: 'pc-a', controllerUserIds: [] },
          ],
        }],
      },
      combatSystem: { combat: null },
    },
  };
  const controller = { id: 'user-a', ownership: {} };
  const pcOwner = { id: 'user-b', ownership: { 'pc-a': 'owner' } };
  const [npc1, npc2, pc1] = state.preferences.worldV2.scenes[0].tokens;
  assert.equal(userControlsToken(state, controller, npc1), true);
  assert.equal(userControlsToken(state, controller, npc2), false);
  assert.equal(userControlsToken(state, pcOwner, pc1), true);
  assert.match(multiplayerIndex, /typeof multiplayer\.canControlToken !== 'function'/);
  assert.match(serverAccess, /userControlsToken\(before, user, token\)/);
});

test('combat movement authority is locked to the active Token instance, not only its Actor template', () => {
  const state = {
    preferences: {
      combatSystem: {
        combat: {
          state: 'active', turnIndex: 1,
          combatants: [
            { tokenId: 'monster-1', actorId: 'monster-template' },
            { tokenId: 'monster-2', actorId: 'monster-template' },
          ],
        },
      },
    },
  };
  assert.equal(currentCombatTokenId(state), 'monster-2');
});

test('movement fast path validates once per direct commit and reuses same-context navigation grids', async () => {
  const fixture = movementFixture();
  const first = await fixture.api.movementFast.moveTokenTo('a', { x: 5.5, y: 1.5 });
  assert.equal(first.valid, true);
  assert.equal(first.committed, true);
  assert.equal(fixture.getInspectCount(), 1);
  assert.equal(fixture.getWorld().scenes[0].tokens.find(item => item.id === 'a').x, 5.5);
  assert.equal(fixture.api.movementFast.getNavigationCacheSize(), 1);

  const second = await fixture.api.movementFast.validateTokenMove('b', { x: 6.5, y: 2.5 });
  assert.equal(second.valid, true);
  assert.equal(fixture.api.movementFast.getNavigationCacheSize(), 1);
});

test('Movement V5 uses RAF preview updates, persistent Leaflet preview objects, and coalesced WASD segments', () => {
  assert.match(movementIndex, /createMovementController/);
  assert.match(movementIndex, /createMovementFastPathSystem/);
  assert.match(movementController, /requestAnimationFrame/);
  assert.match(movementController, /previewLine\.setLatLngs/);
  assert.match(movementController, /sameDirection\(last, direction\)/);
  assert.match(movementController, /last\.count \+= 1/);
  assert.match(movementController, /setPointerCapture/);
  assert.match(movementController, /releasePointerCapture/);
  assert.match(movementController, /dragstart/);
});

test('selection health HUD stays Ruleset-described and batch edits reuse canonical health operations', () => {
  assert.match(healthIndex, /createHealthTokenBars/);
  assert.match(healthIndex, /createHealthSelectionHud/);
  assert.match(selectionHud, /describeHealth\(health, \{ ruleset: api\.ruleset \}\)/);
  assert.match(selectionHud, /entry\?\.view\?\.title/);
  assert.match(selectionHud, /applyDamageToTokenIds/);
  assert.match(selectionHud, /applyHealingToTokenIds/);
  assert.match(selectionHud, /Health Runtime.*Presentation/);
  assert.match(tokenBars, /function upsertToken/);
  assert.match(tokenBars, /\['health:change', 'status:change', 'actor:change'\]/);
  assert.doesNotMatch(tokenBars, /api\.on\('state:commit'/);
});
