import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FEET_TO_METERS,
  feetToMeters,
  migrateWorldSchema4State,
} from '../src/world/migration.js';
import { readWorldBootstrap } from '../src/world/bootstrap.js';

function schema3State() {
  return {
    saveVersion: 2,
    mapId: 'northern-song-lanzhou-1104',
    mapVersion: '1.0.6',
    preferences: {
      combatSystem: { schemaVersion: 2, combat: { state: 'active', turnOrigin: { x: 1, y: 2, elevationFt: 12 } } },
      entitySystem: { schemaVersion: 4 },
      worldV2: {
        schemaVersion: 3,
        id: 'world-metric',
        ruleset: { id: 'infinite-horror', version: '1.0.0' },
        activeSceneId: 'scene-a',
        actors: [{
          id: 'actor-a', name: 'A', type: 'pc', partyId: 'party-a', system: {}, effects: [],
          prototypeToken: { elevationFt: 5, extension: { keep: true } },
        }],
        statusDefinitions: [],
        scenes: [{
          id: 'scene-a', name: 'A', mapPackage: { id: 'northern-song-lanzhou-1104', version: '1.0.6' },
          tokens: [{
            id: 'token-a', actorId: 'actor-a', actorLink: true, actorDelta: null,
            placement: 'map', x: 1, y: 2, diameterMeters: 1, rotation: 0, elevationFt: 12,
            controllerUserIds: [], visibility: { mode: 'public', userIds: [] },
            vision: { enabled: true, preciseRangeOverrideMeters: null, vagueRangeOverrideMeters: null, overrideUserIds: [] },
            locked: false, showName: true, effects: [], extension: { keep: true },
          }],
          markers: [], attackAreas: [], sceneEvents: [], fog: { schemaVersion: 1, cellSizeMeters: 5, exploredByParty: {} },
          featureStates: { wall: { open: false, custom: { blockingHeightFt: 20, extension: { keep: true } } } },
          settings: { gridVisible: true }, extension: { keep: true },
        }],
      },
    },
  };
}

test('World 3 to 4 converts only known feet fields exactly once and upgrades built-ins', () => {
  assert.equal(FEET_TO_METERS, 0.3048);
  assert.equal(feetToMeters(12), 12 * 0.3048);
  const first = migrateWorldSchema4State(schema3State());
  const world = first.state.preferences.worldV2;
  assert.equal(first.migrated, true);
  assert.equal(world.schemaVersion, 4);
  assert.deepEqual(world.ruleset, { id: 'infinite-horror', version: '1.1.0' });
  assert.deepEqual(world.scenes[0].mapPackage, { id: 'northern-song-lanzhou-1104', version: '1.1.0' });
  assert.equal(world.actors[0].prototypeToken.elevationMeters, 5 * 0.3048);
  assert.equal(world.scenes[0].tokens[0].elevationMeters, 12 * 0.3048);
  assert.equal(world.scenes[0].featureStates.wall.custom.blockingHeightMeters, 20 * 0.3048);
  assert.equal(first.state.preferences.combatSystem.combat.turnOrigin.elevationMeters, 12 * 0.3048);
  assert.equal(world.scenes[0].settings.lineOfSightEnabled, false);
  assert.equal('elevationFt' in world.scenes[0].tokens[0], false);
  assert.equal('blockingHeightFt' in world.scenes[0].featureStates.wall.custom, false);
  assert.equal(world.scenes[0].tokens[0].extension.keep, true);
  assert.equal(world.scenes[0].featureStates.wall.custom.extension.keep, true);
  assert.deepEqual(migrateWorldSchema4State(first.state).state, first.state);
});

test('World bootstrap resolves known schema 3 package references before loading code', () => {
  const bootstrap = readWorldBootstrap(schema3State(), {
    defaultRuleset: { id: 'infinite-horror', version: '1.1.0' },
  });
  assert.deepEqual(bootstrap.ruleset, { id: 'infinite-horror', version: '1.1.0' });
  assert.deepEqual(bootstrap.mapPackage, { id: 'northern-song-lanzhou-1104', version: '1.1.0' });
});

test('metric migration rejects corrupt known height values without changing the input', () => {
  const source = schema3State();
  source.preferences.worldV2.scenes[0].tokens[0].elevationFt = 'invalid';
  const before = structuredClone(source);
  assert.throws(() => migrateWorldSchema4State(source), { code: 'world_metric_migration_invalid' });
  assert.deepEqual(source, before);
});
