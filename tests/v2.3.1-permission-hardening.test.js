import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { projectStateForAudience } from '../src/vision/audience.js';

function actor() {
  return {
    id: 'npc-private',
    name: 'Private NPC',
    img: 'npc.webp',
    type: 'npc',
    partyId: null,
    prototypeToken: { texture: { src: 'npc.webp' }, showName: true },
    system: { secretStat: 99 },
    effects: [{ id: 'actor-secret-effect', definitionId: 'secret-effect', enabled: true }],
  };
}

function token({ controllerUserIds = [], userIds = ['viewer'] } = {}) {
  return {
    id: 'npc-token',
    actorId: 'npc-private',
    actorLink: false,
    actorDelta: {
      system: { runtime: { secretHp: 12 } },
      effects: [{ id: 'token-secret-effect', definitionId: 'secret-effect', enabled: true }],
    },
    placement: 'map',
    x: 30,
    y: 40,
    featureId: null,
    texture: { src: 'npc-token.webp' },
    color: '#334455',
    diameterMeters: 1,
    rotation: 0,
    elevationFt: 0,
    locked: false,
    showName: true,
    effects: [],
    controllerUserIds,
    visibility: { mode: 'users', userIds },
    vision: {
      enabled: true,
      preciseRangeOverrideMeters: null,
      vagueRangeOverrideMeters: null,
      overrideUserIds: [],
    },
  };
}

function state(tokenValue) {
  return {
    preferences: {
      worldV2: {
        activeSceneId: 'scene-a',
        actors: [actor()],
        statusDefinitions: [],
        scenes: [{
          id: 'scene-a',
          tokens: [tokenValue],
          markers: [],
          attackAreas: [],
          sceneEvents: [],
          fog: { schemaVersion: 1, cellSizeMeters: 5, exploredByParty: {} },
          settings: { lighting: 'normal' },
        }],
      },
      entitySystem: { actors: [], tokens: [], statusDefinitions: [] },
      combatSystem: { combat: null },
      chatSystem: { messages: [] },
    },
  };
}

const playerContext = {
  role: 'player',
  userId: 'viewer',
  user: { id: 'viewer', ownership: {} },
  mapMetrics: { metersPerUnit: 1 },
};

test('explicit Token visibility reveals a LIMITED record without granting private Actor or Token runtime data', () => {
  const projected = projectStateForAudience(state(token()), playerContext);
  const projectedWorld = projected.preferences.worldV2;
  const projectedActor = projectedWorld.actors.find(item => item.id === 'npc-private');
  const projectedToken = projectedWorld.scenes[0].tokens.find(item => item.id === 'npc-token');

  assert.ok(projectedToken, 'explicitly visible Token should not require a vision source');
  assert.equal(projectedToken.audienceRestricted, true);
  assert.deepEqual(projectedToken.controllerUserIds, []);
  assert.deepEqual(projectedToken.visibility, { mode: 'public', userIds: [] });
  assert.equal(projectedToken.vision.enabled, false);
  assert.deepEqual(projectedToken.actorDelta, { system: {}, effects: [] });
  assert.deepEqual(projectedToken.effects, []);

  assert.ok(projectedActor);
  assert.equal(projectedActor.audienceRestricted, true);
  assert.deepEqual(projectedActor.system, {});
  assert.deepEqual(projectedActor.effects, []);
});

test('Token controllers still receive private runtime data without requiring Actor OWNER', () => {
  const projected = projectStateForAudience(state(token({ controllerUserIds: ['viewer'], userIds: [] })), playerContext);
  const projectedWorld = projected.preferences.worldV2;
  const projectedActor = projectedWorld.actors.find(item => item.id === 'npc-private');
  const projectedToken = projectedWorld.scenes[0].tokens.find(item => item.id === 'npc-token');

  assert.deepEqual(projectedActor.system, { secretStat: 99 });
  assert.deepEqual(projectedToken.actorDelta.system, { runtime: { secretHp: 12 } });
  assert.deepEqual(projectedToken.controllerUserIds, ['viewer']);
  assert.equal(projectedToken.audienceRestricted, undefined);
});

test('Feature enter and exit permissions use token.move instead of Actor ownership', () => {
  const source = readFileSync(new URL('../src/interaction/system.js', import.meta.url), 'utf8');
  const start = source.indexOf('function actionPermission(action, tokenId)');
  const end = source.indexOf('function syncFeatureVisualState()', start);
  assert.ok(start >= 0 && end > start);
  const permissionBlock = source.slice(start, end);

  assert.match(permissionBlock, /api\.permissions\?\.can/);
  assert.match(permissionBlock, /api\.permissions\.can\('token\.move'/);
  assert.match(permissionBlock, /canControlToken/);
  assert.doesNotMatch(permissionBlock, /canControlActor/);
});
