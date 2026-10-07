import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  migrateLegacySceneFeatureStates, migrateDetachedLegacySceneFeatureStates,
} from '../src/world/feature-states.js';
import {
  migrateWorldSchema4State, migrateDetachedWorldSchema4State,
} from '../src/world/migration.js';
import { migrationCopyInput, migrationCopyDefinitions } from './fixtures/migration-copy-inputs.js';
import { validateRuntimeState } from '../src/engine/runtime-state.js';
import { worldCopyInput, copyMap, copyRuleset } from './fixtures/world-copy-inputs.js';

const original = JSON.parse(readFileSync(new URL('./fixtures/migration-owned-original-hashes.json', import.meta.url), 'utf8'));
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

test('one-copy owned migration pipeline retains original schema 2/3/4 bytes and flags', () => {
  assert.equal(original.sourceCommit, 'ed7e13baab0f116222333c20431e19ab63b60e37');
  for (const expected of original.records) {
    const input = migrationCopyInput(expected.schemaVersion), before = structuredClone(input);
    const options = expected.configured ? { statusDefinitions: migrationCopyDefinitions } : {};
    const publicResult = migrateWorldSchema4State(migrateLegacySceneFeatureStates(input).state, options);
    const detached = structuredClone(input);
    const featureResult = migrateDetachedLegacySceneFeatureStates(detached);
    assert.equal(featureResult.state, detached);
    const ownedResult = migrateDetachedWorldSchema4State(featureResult.state, options);
    assert.equal(ownedResult.state, detached);
    assert.equal(hash(publicResult), expected.result);
    assert.equal(hash(ownedResult), expected.result);
    assert.equal(ownedResult.migrated, expected.migrated);
    assert.equal(ownedResult.fromSchemaVersion, expected.fromSchemaVersion);
    assert.deepEqual(input, before);
    assert.equal(Object.hasOwn(ownedResult.state.preferences, 'featureStates'), false);
    assert.equal(Object.hasOwn(ownedResult.state.preferences, 'featureInteractions'), false);
    const world = ownedResult.state.preferences.worldV2;
    assert.equal(world.scenes[0].tokens[0].x, 1);
    assert.equal(world.scenes[1].tokens[0].x, 2);
    assert.equal(world.scenes[0].featureStates.wall.custom.blockingHeightMeters, 20 * .3048);
    assert.notEqual(world.scenes[0].extension.aliasedFeatureState, world.scenes[0].featureStates.wall,
      'legacy Feature State replacement retains the original detached raw metadata alias');
    assert.equal(world.scenes[0].extension.aliasedFeatureState.custom.blockingHeightFt, 20);
    ownedResult.state.preferences.entitySystem.actors[0].prototypeToken.elevationMeters = 999;
    assert.equal(world.actors[0].prototypeToken.elevationMeters, 5 * .3048);
    assert.deepEqual(input, before);
  }
});

test('legacy migration public wrapper preserves detach and plain-object rejection order', () => {
  for (const raw of [null, [], () => 1, new Date()]) {
    assert.throws(() => migrateLegacySceneFeatureStates(raw), error =>
      error.name === 'TypeError' && /requires a state object/.test(error.message));
  }
  const unsupported = { preferences: {}, extension: { value: () => 1 } };
  assert.throws(() => migrateLegacySceneFeatureStates(unsupported), error => error.name === 'DataCloneError');
  const input = { preferences: {}, extension: { nested: { value: 1 } } };
  const result = migrateLegacySceneFeatureStates(input);
  assert.equal(result.migrated, false);
  assert.notEqual(result.state, input);
  result.state.extension.nested.value = 2;
  assert.equal(input.extension.nested.value, 1);
  const detached = structuredClone(input);
  assert.equal(migrateDetachedLegacySceneFeatureStates(detached).state, detached);
});

test('public legacy wrapper retains original non-plain preference-container behavior', () => {
  class Preferences { constructor() { this.featureStates = { wall: { open: true } }; } }
  const input = { preferences: new Preferences(), extension: { value: 1 } };
  const result = migrateLegacySceneFeatureStates(input);
  assert.equal(result.migrated, false, 'the original source container is inspected before structuredClone changes its prototype');
  assert.deepEqual(result.state.preferences.featureStates, { wall: { open: true } });
  assert.notEqual(result.state.preferences, input.preferences);
  const detached = structuredClone(input);
  const owned = migrateDetachedLegacySceneFeatureStates(detached, { hasLegacy: false });
  assert.equal(owned.migrated, false);
  assert.equal(owned.state, detached);
  assert.equal(JSON.stringify(owned), JSON.stringify(result));
});

test('public migration conflict and metric failure cannot mutate authority input', () => {
  const conflict = migrationCopyInput(3);
  conflict.preferences.featureStates = { wall: { open: false } };
  const before = structuredClone(conflict);
  assert.throws(() => migrateLegacySceneFeatureStates(conflict), { code: 'feature_state_migration_conflict' });
  assert.deepEqual(conflict, before);
  const invalid = migrationCopyInput(4);
  invalid.preferences.worldV2.scenes[0].featureStates.wall.custom.blockingHeightFt = 'invalid';
  const invalidBefore = structuredClone(invalid);
  assert.throws(() => migrateWorldSchema4State(invalid), { code: 'world_metric_migration_invalid' });
  assert.deepEqual(invalid, invalidBefore);
  const detached = structuredClone(invalid);
  assert.throws(() => migrateDetachedWorldSchema4State(detached), { code: 'world_metric_migration_invalid' });
  assert.deepEqual(invalid, invalidBefore);
});

test('schema migration public wrapper still clones before no-World or schema checks', () => {
  const input = { extension: { nested: { value: 1 } } };
  const result = migrateWorldSchema4State(input);
  assert.equal(result.migrated, false);
  assert.equal(result.fromSchemaVersion, null);
  result.state.extension.nested.value = 2;
  assert.equal(input.extension.nested.value, 1);
  const detached = structuredClone(input);
  assert.equal(migrateDetachedWorldSchema4State(detached).state, detached);
  assert.throws(() => migrateWorldSchema4State({ extension: () => 1 }), error => error.name === 'DataCloneError');
  assert.throws(() => migrateWorldSchema4State({ preferences: { worldV2: { schemaVersion: 99 } }, extension: () => 1 }),
    error => error.name === 'DataCloneError');
  assert.throws(() => migrateWorldSchema4State({ preferences: { worldV2: { schemaVersion: 99 } } }),
    { code: 'world_schema_incompatible' });
});

test('full validation preserves original class preference classification before its owned clone', () => {
  class Preferences {}
  const { state } = worldCopyInput();
  state.preferences = Object.assign(new Preferences(), state.preferences, { featureStates: { wall: { open: false } } });
  const before = structuredClone(state);
  const result = validateRuntimeState(state, { mapPackage: copyMap, ruleset: copyRuleset });
  // Original v2.5.4 full validation skips legacy merge for the non-plain
  // source preference container, preserving canonical wall.open = true.
  assert.equal(hash(result), '05086f00798d546ce65d070a0074c0e8bec095f88c73a7c63c842eb4fb2fd51d');
  assert.equal(result.preferences.worldV2.scenes[0].featureStates.wall.open, true);
  assert.deepEqual(structuredClone(state), before);
  assert.equal(Object.getPrototypeOf(state.preferences), Preferences.prototype);
});

test('full canonical validation retains non-plain state rejection before its clone boundary', () => {
  class State {}
  const state = Object.assign(new State(), worldCopyInput().state);
  state.unsupportedExtension = () => 1;
  assert.throws(() => validateRuntimeState(state, { mapPackage: copyMap, ruleset: copyRuleset }), error =>
    error.name === 'TypeError' && /Feature State migration requires a state object/.test(error.message));
  assert.equal(Object.getPrototypeOf(state), State.prototype);
});
