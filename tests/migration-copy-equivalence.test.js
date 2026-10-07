import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { migrateWorldSchema4State, migrateDetachedWorldSchema4State } from '../src/world/migration.js';
import { exportRuntimeState } from '../src/engine/runtime-state.js';
import { copyRuleset } from './fixtures/world-copy-inputs.js';
import { migrationCopyInput, migrationCopyDefinitions } from './fixtures/migration-copy-inputs.js';

const original = JSON.parse(readFileSync(new URL('./fixtures/migration-copy-original-hashes.json', import.meta.url), 'utf8'));
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const exportOptions = { ruleset: copyRuleset, mapPackage: { id: 'northern-song-lanzhou-1104', version: '1.1.0' } };

test('schema 2/3/4 migration retains original JSON bytes and flags with configured and legacy statuses', () => {
  assert.equal(original.sourceCommit, 'ed7e13baab0f116222333c20431e19ab63b60e37');
  for (const expected of original.records) {
    const input = migrationCopyInput(expected.schemaVersion), before = structuredClone(input);
    const result = migrateWorldSchema4State(input, expected.configured ? { statusDefinitions: migrationCopyDefinitions } : {});
    const detached = structuredClone(input);
    const detachedResult = migrateDetachedWorldSchema4State(detached,
      expected.configured ? { statusDefinitions: migrationCopyDefinitions } : {});
    assert.equal(hash(result), expected.result);
    assert.equal(hash(detachedResult), expected.result);
    assert.equal(detachedResult.state, detached, 'internal migration consumes its already detached snapshot');
    assert.equal(result.migrated, expected.migrated);
    assert.equal(result.fromSchemaVersion, expected.fromSchemaVersion);
    assert.deepEqual(input, before);
    const world = result.state.preferences.worldV2;
    assert.equal(world.scenes[0].tokens[0].id, world.scenes[1].tokens[0].id);
    assert.equal(world.scenes[0].tokens[0].x, 1);
    assert.equal(world.scenes[1].tokens[0].x, 2, 'same Token IDs in different Scenes keep their partition and data');
    assert.deepEqual(world.scenes[0].fog.exploredByParty.party.rows[2], [[1, 8]]);
    assert.equal(world.scenes[0].tokens[0].visibility.mode, 'gm');
    assert.equal(Object.hasOwn(world.scenes[0].tokens[0], 'hidden'), false);
  }
});

test('migration copy reduction preserves extension alias behavior and isolated canonical projections', () => {
  const input = migrationCopyInput(3), before = structuredClone(input);
  const result = migrateWorldSchema4State(input), world = result.state.preferences.worldV2;
  assert.equal(world.extension.aliasedActor.prototypeToken.elevationFt, 5);
  assert.equal(world.actors[0].prototypeToken.elevationMeters, 5 * .3048);
  assert.notEqual(world.extension.aliasedActor, world.actors[0], 'normalized Actors remain detached from raw Actor extension aliases');
  const scene = world.scenes[0];
  assert.equal(scene.extension.aliasedToken.hidden, true);
  assert.equal(scene.extension.aliasedToken.elevationFt, 12);
  assert.notEqual(scene.extension.aliasedToken, scene.tokens[0]);
  assert.equal(scene.extension.aliasedFeatureState, scene.featureStates.wall, 'surviving Scene metadata retains the original cloned alias relationship');
  assert.equal(scene.extension.aliasedFeatureState.custom.blockingHeightMeters, 20 * .3048);
  result.state.preferences.entitySystem.actors[0].prototypeToken.elevationMeters = 999;
  assert.equal(world.actors[0].prototypeToken.elevationMeters, 5 * .3048);
  world.actors[0].extension.nested.value = 'changed';
  scene.extension.nested.value = 'changed';
  assert.deepEqual(input, before);
});

test('known corrupt feet fields still reject atomically across schema versions', () => {
  const corruptions = [
    input => { input.preferences.worldV2.actors[0].prototypeToken.elevationFt = 'invalid'; },
    input => { input.preferences.worldV2.scenes[0].tokens[0].elevationFt = 'invalid'; },
    input => { input.preferences.worldV2.scenes[0].featureStates.wall.custom.blockingHeightFt = 'invalid'; },
    input => { input.preferences.worldV2.scenes[0].combat.turnOrigin.elevationFt = 'invalid'; },
    input => { input.preferences.combatSystem.combat.turnOrigin.elevationFt = 'invalid'; },
  ];
  for (const version of [2, 3, 4]) for (const corrupt of corruptions) {
    const input = migrationCopyInput(version); corrupt(input);
    const before = structuredClone(input);
    assert.throws(() => migrateWorldSchema4State(input), { code: 'world_metric_migration_invalid' });
    assert.deepEqual(input, before);
  }
});

test('migration remains separate from full destruction and crater validation', () => {
  const valid = migrateWorldSchema4State(migrationCopyInput(3)).state;
  assert.doesNotThrow(() => exportRuntimeState(valid, exportOptions));
  for (const field of ['craterPolygon', 'clipHits']) {
    const malformed = structuredClone(valid);
    if (field === 'craterPolygon') malformed.preferences.worldV2.scenes[0].sceneEvents[0].craterPolygon = [[1, 1], [2, 2]];
    else malformed.preferences.worldV2.scenes[0].sceneEvents[0].clipHits = [{ featureId: 'wall', polygon: [[1, 1], [2, 2]] }];
    const before = structuredClone(malformed);
    assert.throws(() => exportRuntimeState(malformed, exportOptions));
    assert.deepEqual(malformed, before);
  }
});

test('initial migration clone still rejects unsupported values and detaches no-World input', () => {
  const input = migrationCopyInput(4); input.preferences.worldV2.name = () => 'unsupported';
  assert.throws(() => migrateWorldSchema4State(input), error => error.name === 'DataCloneError');
  const empty = { extension: { nested: { value: 1 } } };
  const result = migrateWorldSchema4State(empty);
  assert.equal(result.migrated, false); assert.equal(result.fromSchemaVersion, null);
  result.state.extension.nested.value = 2;
  assert.equal(empty.extension.nested.value, 1);
});
