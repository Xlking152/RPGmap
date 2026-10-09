import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { normalizeWorldV2, projectWorldV2ToRuntimeState } from '../src/world/model.js';
import { exportRuntimeState, validateRuntimeState } from '../src/engine/runtime-state.js';
import { worldCopyInput, copyMap, copyRuleset } from './fixtures/world-copy-inputs.js';

const original = JSON.parse(readFileSync(new URL('./fixtures/world-copy-original-hashes.json', import.meta.url), 'utf8'));
const options = { mapPackage: copyMap, ruleset: copyRuleset };
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

test('normalization, projection and full export keep original v2.5.4 JSON bytes including property order', () => {
  assert.equal(original.sourceCommit, 'ed7e13baab0f116222333c20431e19ab63b60e37');
  for (const expected of original.records) {
    const { state, world } = worldCopyInput(expected.activeSceneId);
    const before = structuredClone({ state, world });
    const normalized = normalizeWorldV2(world, options);
    const projected = projectWorldV2ToRuntimeState(state, world, options);
    assert.equal(hash(normalized), expected.normalized);
    assert.equal(hash(projected), expected.projected);
    assert.equal(hash(exportRuntimeState(projected, options)), expected.exported);
    assert.deepEqual({ state, world }, before);
  }
});

test('metadata-copy optimization still detaches mutable World, Scene and runtime extensions', () => {
  const { state, world } = worldCopyInput();
  const before = structuredClone({ state, world });
  const normalized = normalizeWorldV2(world, options);
  normalized.extension.nested.value = 'changed';
  normalized.scenes[0].extension.nested.value = 'changed';
  normalized.scenes[0].settings.extension.custom = false;
  normalized.scenes[0].fog.exploredByParty.party.extension.remembered = false;
  normalized.actors[0].system.extension.preserved[0] = 999;
  const projected = projectWorldV2ToRuntimeState(state, world, options);
  projected.extension.nested.value = 'changed';
  projected.preferences.extension.nested.value = 'changed';
  projected.preferences.entitySystem.extension.nested.value = 'changed';
  projected.preferences.entitySystem.actors[0].system.extension.preserved[0] = 999;
  projected.preferences.worldV2.scenes[0].tokens[0].extension.nested.value = 'changed';
  assert.deepEqual({ state, world }, before);
  assert.equal(projected.preferences.entitySystem.tokens[0].extension.nested.value, 'token', 'canonical and Entity projections do not share mutable extensions');
});

test('canonical projection does not clone nested stale documents that it replaces', () => {
  const { state, world } = worldCopyInput();
  let discardedReads = 0;
  const discarded = () => {
    const value = {};
    Object.defineProperty(value, 'nested', { enumerable: true, get() { discardedReads++; return { large: 'discarded' }; } });
    return value;
  };
  state.markers = [discarded()]; state.attackAreas = [discarded()]; state.sceneEvents = [discarded()];
  state.preferences.worldV2 = discarded(); state.preferences.featureStates = discarded();
  state.preferences.featureInteractions = discarded();
  state.preferences.entitySystem.actors = [discarded()];
  state.preferences.entitySystem.tokens = [discarded()];
  state.preferences.entitySystem.statusDefinitions = [discarded()];
  const projected = projectWorldV2ToRuntimeState(state, world, options);
  assert.equal(discardedReads, 0, 'only the replacement documents and surviving extension metadata are copied');
  assert.equal(projected.preferences.worldV2.id, world.id);
  assert.equal(projected.preferences.entitySystem.actors[0].id, 'actor-a');
  assert.equal(projected.sceneEvents[0].id, 'damage');
  assert.equal(projected.preferences.featureStates.wall.open, true);
});

test('full exports continue to reject malformed canonical SceneEvents, craters and Fog atomically', () => {
  const changes = [
    scene => { scene.sceneEvents[0].clipHits = [{ featureId: 'wall', polygon: [[0, 0], [1, 1]] }]; },
    scene => { scene.sceneEvents[0].craterPolygon = [[0, 0], [1, 1]]; },
    scene => { scene.sceneEvents[0].type = 'unsupported'; },
    scene => { scene.fog.exploredByParty.party.rows[2] = [[1, 3], [3, 5]]; },
  ];
  for (const change of changes) {
    const { state, world } = worldCopyInput();
    const projected = projectWorldV2ToRuntimeState(state, world, options);
    projected.sceneEvents = [];
    change(projected.preferences.worldV2.scenes[0]);
    const before = structuredClone(projected);
    assert.throws(() => exportRuntimeState(projected, options));
    assert.deepEqual(projected, before, 'rejection does not mutate the authority input');
  }
});

test('projection still rejects an active Scene whose map requires a different runtime', () => {
  const { state, world } = worldCopyInput();
  world.scenes[0].mapPackage.id = 'different-map';
  const before = structuredClone({ state, world });
  assert.throws(() => projectWorldV2ToRuntimeState(state, world, options), { code: 'world_scene_map_reload_required' });
  assert.deepEqual({ state, world }, before);
});

test('normalizers still reject unsupported replaced scalar values for direct callers', () => {
  for (const value of [() => 'unsupported', Symbol('unsupported')]) {
    for (const field of ['id', 'name', 'activeSceneId']) {
      const { world } = worldCopyInput(); world[field] = value;
      assert.throws(() => normalizeWorldV2(world, options), error => error.name === 'DataCloneError');
    }
    for (const field of ['id', 'name']) {
      const { world } = worldCopyInput(); world.scenes[0][field] = value;
      assert.throws(() => normalizeWorldV2(world, options), error => error.name === 'DataCloneError');
    }
  }
});

test('full validation still rejects unsupported values in replaced preference containers', () => {
  for (const value of [() => 'unsupported', Symbol('unsupported')]) {
    for (const preferences of [value, [value], { entitySystem: value }]) {
      const { state } = worldCopyInput();
      state.preferences = preferences;
      assert.throws(() => validateRuntimeState(state, options), error => error.name === 'DataCloneError');
    }
  }
});
