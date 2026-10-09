import test from 'node:test';
import assert from 'node:assert/strict';
import { createDamagePreview, createInitialState, commitDamageEvent, commitRestoreEvent, deriveSceneState } from '../src/engine/state.js';
import { damageFeatureState, listFeatureInteractions } from '../src/interaction/model.js';

const points = (x = 0) => [[x, 0], [x + 100, 0], [x + 100, 100], [x, 100]];
const feature = (id, category = 'wall', x = 0) => ({ id, category, mode: 'clip', ruinStyle: 'stone',
  geometry: { type: 'polygon', points: points(x) }, center: [x + 50, 50],
  capabilities: { destructible: true, inspectable: true } });
const attack = (length, x = 0, extra = {}) => ({ id: `area-${x}-${length}`, type: 'rectangle',
  center: { x, y: 50 }, length, width: 100, headingDeg: 90, ...extra });

test('one attack collapses exactly the qualifying building or wall segment at 95 percent', () => {
  for (const category of ['building', 'wall', 'gate', 'pass-wall', 'pass-gate']) {
    const a = feature('a', category), neighbor = feature('neighbor', category, 100);
    const partial = createDamagePreview(attack(94.99), [a, neighbor], null);
    assert.deepEqual(partial.objectIds, []);
    assert.deepEqual(partial.clipHits.map(hit => hit.featureId), ['a']);
    for (const length of [95, 95.01, 100]) {
      const preview = createDamagePreview(attack(length), [a, neighbor], null);
      assert.deepEqual(preview.objectIds, ['a']);
      assert.deepEqual(preview.clipHits, []);
    }
  }
});

test('successive attacks do not promote accumulated coverage into a whole-object event', () => {
  const a = feature('a'), map = { id: 'test', version: '1', features: [a] };
  let state = createInitialState(map);
  for (const area of [attack(60), attack(60, 40)]) {
    state = commitDamageEvent(state, area, createDamagePreview(area, [a], null));
  }
  assert.deepEqual(deriveSceneState(state.sceneEvents).destroyedObjectIds, []);
  assert.equal(deriveSceneState(state.sceneEvents).clipHits.length, 2);
});

test('continuous terrain remains local even when the entire feature is covered', () => {
  const terrain = feature('ground', 'terrain'); terrain.severeOnly = true;
  const preview = createDamagePreview(attack(200, -50, { severeDamage: true, craterEnabled: true }), [terrain], null);
  assert.deepEqual(preview.objectIds, []);
  assert.deepEqual(preview.clipHits.map(hit => hit.featureId), ['ground']);
  assert.ok(preview.craterPolygon);
});

test('direct action destroys only the selected multi-polygon wall and preserves restoration settings', () => {
  const wall = feature('wall'), other = feature('other', 'building', 100);
  wall.geometry = { type: 'MultiPolygon', coordinates: [[points()], [points(200)]] };
  delete wall.center;
  const map = { id: 'test', version: '1', features: [wall, other] };
  let state = createInitialState(map);
  state.preferences.featureStates = { wall: { open: true, vision: { occluder: false }, custom: { key: 'keep' } } };
  const area = attack(20, 100, { craterEnabled: true });
  state = commitDamageEvent(state, area, createDamagePreview(area, [other], null));
  state = damageFeatureState(state, map, 'wall');
  assert.deepEqual(state.sceneEvents.at(-1).objectIds, ['wall']);
  assert.deepEqual(state.sceneEvents.at(-1).clipHits, []);
  const unchanged = damageFeatureState(state, map, 'wall');
  assert.strictEqual(unchanged, state);
  const actions = listFeatureInteractions({ state, mapPackage: map, featureId: 'wall' });
  assert.equal(actions.find(action => action.id === 'restore').label, '恢复此对象');
  const restored = commitRestoreEvent(state, ['wall']);
  const derived = deriveSceneState(restored.sceneEvents);
  assert.ok(!derived.damagedFeatureIds.includes('wall'));
  assert.ok(derived.damagedFeatureIds.includes('other'));
  assert.equal(derived.craterRegions.length, 1);
  assert.deepEqual(restored.preferences.featureStates, state.preferences.featureStates);
});
