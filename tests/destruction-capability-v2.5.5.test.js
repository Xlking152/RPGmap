import assert from 'node:assert/strict';
import test from 'node:test';
import clipping from 'polygon-clipping';
import { prepareMapPackage } from '../src/map-package/contract.js';
import { createDamagePreview, createInitialState, commitRestoreEvent, deriveSceneState } from '../src/engine/state.js';
import { createNavigationGrid, NAVIGATION_CELL_FLAGS } from '../src/engine/navigation.js';
import { damageFeatureState } from '../src/interaction/model.js';
import { deriveVisionOccluders } from '../src/spatial/kernel.js';

const points = [[40, 40], [70, 40], [70, 70], [40, 70]];
const attack = { id: 'attack', type: 'rectangle', center: { x: 40, y: 55 }, length: 30, width: 30, headingDeg: 90 };
const source = (category = 'wall', overrides = {}) => ({ id: 'object', category, geometry: { type: 'polygon', points },
  capabilities: { destructible: true, navigation: { blocks: true, collisionGroup: 'structure' } }, ...overrides });
const prepare = (features) => prepareMapPackage({ id: 'map', version: '1', width: 150, height: 150,
  layers: ['base', 'destructible'], svg: '<svg></svg>', features });
const derived = (state) => deriveSceneState(state.sceneEvents);
const blockers = (map, state) => deriveVisionOccluders(map, { featureStates: state.preferences.featureStates || {} }, derived(state));
const blocked = (map, state) => Boolean(createNavigationGrid(map, derived(state), null, { appState: state })
  .cellFlags({ x: 55, y: 55 }) & NAVIGATION_CELL_FLAGS.blocked);

test('area damage uses the prepared destructibility capability with the same precedence as direct actions', () => {
  for (const legacy of [undefined, true, { enabled: true }]) {
    const map = prepare([source('wall', { destructible: legacy,
      capabilities: { destructible: false, navigation: { blocks: true, collisionGroup: 'structure' } } })]);
    const preview = createDamagePreview(attack, map.features, null);
    assert.deepEqual(preview.objectIds, []);
    assert.deepEqual(preview.clipHits, []);
    assert.throws(() => damageFeatureState(createInitialState(map), map, 'object'), /not destructible/);
  }
  const explicitlyEnabled = prepare([source('wall', { destructible: false })]);
  assert.deepEqual(createDamagePreview(attack, explicitlyEnabled.features, null).objectIds, ['object']);
});

test('unprepared legacy damage descriptors keep their boolean and enabled compatibility', () => {
  for (const legacy of [false, { enabled: false }]) {
    const feature = { id: 'object', category: 'wall', geometry: { points }, destructible: legacy };
    assert.deepEqual(createDamagePreview(attack, [feature], null).featureIds, []);
  }
  for (const legacy of [undefined, true, { enabled: true }]) {
    const feature = { id: 'object', category: 'wall', geometry: { points }, destructible: legacy };
    assert.deepEqual(createDamagePreview(attack, [feature], null).objectIds, ['object']);
  }
});

test('new destructible structures default to releasing their own sight and collision after whole destruction', () => {
  for (const category of ['building', 'wall', 'gate', 'pass-wall', 'pass-gate', 'door']) {
    const map = prepare([source(category)]);
    const feature = map.features[0];
    assert.equal(feature.capabilities.navigation.passableWhenDestroyed, true, category);
    assert.equal(feature.capabilities.vision.passableWhenDestroyed, true, category);
    const initial = createInitialState(map);
    assert.equal(blockers(map, initial).length, 1, category);
    assert.equal(blocked(map, initial), true, category);
    const destroyed = damageFeatureState(initial, map, feature.id);
    assert.equal(blockers(map, destroyed).length, 0, category);
    assert.equal(blocked(map, destroyed), false, category);
    const restored = commitRestoreEvent(destroyed, [feature.id]);
    assert.equal(blockers(map, restored).length, 1, category);
    assert.equal(blocked(map, restored), true, category);
  }
});

test('legacy destructibility and capability-driven doors receive the same structure defaults', () => {
  const legacy = { id: 'object', category: 'building', destructible: { enabled: true }, geometry: { points },
    navigation: { blocks: true, collisionGroup: 'structure' } };
  const door = source('custom-door', { capabilities: { destructible: true, openable: true,
    navigation: { blocks: true, collisionGroup: 'structure', passableWhenOpen: true } } });
  for (const item of [legacy, door]) {
    const map = prepare([item]);
    assert.equal(map.features[0].capabilities.navigation.passableWhenDestroyed, true);
    assert.equal(map.features[0].capabilities.vision.passableWhenDestroyed, true);
    const destroyed = damageFeatureState(createInitialState(map), map, 'object');
    assert.equal(blockers(map, destroyed).length, 0);
    assert.equal(blocked(map, destroyed), false);
  }
});

test('explicit false rules remain independent and restoration preserves the saved door and vision settings', () => {
  for (const rules of [
    { navigation: { blocks: true, collisionGroup: 'structure', passableWhenDestroyed: false } },
    { navigation: { blocks: true, collisionGroup: 'structure', passableWhenDestroyed: false },
      vision: { occluder: true, polygon: points, passableWhenDestroyed: false } },
  ]) {
    const map = prepare([source('wall', { capabilities: { destructible: true, ...rules } })]);
    const initial = createInitialState(map);
    initial.preferences.featureStates = { object: { open: true, vision: { occluder: true }, custom: { retained: 'setting' } } };
    const settings = structuredClone(initial.preferences.featureStates);
    const destroyed = damageFeatureState(initial, map, 'object');
    assert.equal(map.features[0].capabilities.navigation.passableWhenDestroyed, false);
    assert.equal(map.features[0].capabilities.vision.passableWhenDestroyed, false);
    assert.equal(blockers(map, destroyed).length, 1);
    assert.equal(blocked(map, destroyed), true);
    const restored = commitRestoreEvent(destroyed, ['object']);
    assert.deepEqual(restored.preferences.featureStates, settings);
    assert.equal(blockers(map, restored).length, 1);
  }
  const map = prepare([source('wall', { capabilities: { destructible: true,
    navigation: { blocks: true, collisionGroup: 'structure' },
    vision: { occluder: true, polygon: points, passableWhenDestroyed: false } } })]);
  const destroyed = damageFeatureState(createInitialState(map), map, 'object');
  assert.equal(blockers(map, destroyed).length, 1, 'explicit vision false does not change the independent navigation default');
  assert.equal(blocked(map, destroyed), false);
});

test('non-destructible structures and continuous terrain retain their previous navigation defaults', () => {
  for (const item of [source('wall', { capabilities: { destructible: false,
    navigation: { blocks: true, collisionGroup: 'structure' } } }), source('terrain')]) {
    const map = prepare([item]);
    assert.equal(map.features[0].capabilities.navigation.passableWhenDestroyed, false);
    assert.equal(map.features[0].capabilities.vision.passableWhenDestroyed, false);
  }
});

test('normal and severe-only previews forward the map scale to local clipping retries', () => {
  const original = clipping.intersection;
  try {
    for (const severeOnly of [false, true]) {
      const calls = [];
      clipping.intersection = (subject, covering) => {
        calls.push(structuredClone(subject));
        if (calls.length === 1) throw new Error('Unable to pop() left SweepEvent injected from queue.');
        return original(subject, covering);
      };
      const map = prepare([source(severeOnly ? 'terrain' : 'wall', { severeOnly })]);
      const preview = createDamagePreview({ ...attack, severeDamage: severeOnly }, map.features,
        severeOnly ? [] : null, { metersPerUnit: 2 });
      assert.equal(calls.length, 2);
      assert.equal(calls[1][0][0][0][0], 0);
      assert.equal(calls[1][0][0][1][0], 60, 'thirty map units retry as sixty metres');
      assert.deepEqual(preview.featureIds, ['object']);
    }
  } finally { clipping.intersection = original; }
});
