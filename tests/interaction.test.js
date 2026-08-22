import test from 'node:test';
import assert from 'node:assert/strict';

import { createInitialState, deriveSceneState } from '../src/engine/state.js';
import { inspectableFeaturesAtPoint } from '../src/engine/feature-selection.js';
import { mapPackageCapabilities, prepareMapPackage } from '../src/map-package/contract.js';
import {
  FEATURE_INTERACTION_STATE_KEY,
  damageFeatureState,
  getFeatureInteractionState,
  listFeatureInteractions,
  setFeatureOpenState,
} from '../src/interaction/model.js';
import { createMinimalReferencePackage } from '../reference/maps/minimal/package.js';

function preparedMinimal() {
  return prepareMapPackage(createMinimalReferencePackage(), { source: 'test:minimal' });
}

function actionMap(actions) {
  return Object.fromEntries(actions.map((action) => [action.id, action]));
}

test('MapPackage contract normalizes action capabilities including open/close', () => {
  const mapPackage = preparedMinimal();
  const door = mapPackage.features.find((feature) => feature.id === 'demo-door');
  const house = mapPackage.features.find((feature) => feature.id === 'demo-house');

  assert.ok(door);
  assert.equal(door.category, 'door');
  assert.equal(door.capabilities.inspectable, true);
  assert.equal(door.capabilities.openable, true);
  assert.equal(door.capabilities.actions.inspect, true);
  assert.equal(door.capabilities.actions.open, true);
  assert.equal(door.capabilities.actions.close, true);
  assert.equal(door.capabilities.actions.damage, false);

  assert.ok(house);
  assert.equal(house.capabilities.enterable, true);
  assert.equal(house.capabilities.destructible, true);
  assert.equal(house.capabilities.actions.enter, true);
  assert.equal(house.capabilities.actions.damage, true);
  assert.equal(house.capabilities.actions.restore, true);

  assert.equal(mapPackageCapabilities(mapPackage).openableCount, 1);
});

test('inspection uses Capability instead of Lanzhou-specific category allowlists', () => {
  const mapPackage = preparedMinimal();
  const hits = inspectableFeaturesAtPoint({ x: 500, y: 465 }, mapPackage.features);
  assert.ok(hits.some((feature) => feature.id === 'demo-door'));
});

test('open/close interactions are derived from generic Feature state', () => {
  const mapPackage = preparedMinimal();
  const door = mapPackage.features.find((feature) => feature.id === 'demo-door');
  let state = createInitialState(mapPackage);

  assert.deepEqual(getFeatureInteractionState(state, door), { open: false });
  let actions = actionMap(listFeatureInteractions({ mapPackage, state, featureId: door.id }));
  assert.equal(actions.open.enabled, true);
  assert.equal(actions.close.enabled, false);

  state = setFeatureOpenState(state, door.id, true);
  assert.equal(state.preferences[FEATURE_INTERACTION_STATE_KEY][door.id].open, true);
  assert.deepEqual(getFeatureInteractionState(state, door), { open: true });
  actions = actionMap(listFeatureInteractions({ mapPackage, state, featureId: door.id }));
  assert.equal(actions.open.enabled, false);
  assert.equal(actions.close.enabled, true);

  state = setFeatureOpenState(state, door.id, false);
  assert.equal(getFeatureInteractionState(state, door).open, false);
});

test('enter action is Capability-driven and reacts to character/Scene state', () => {
  const mapPackage = preparedMinimal();
  const house = mapPackage.features.find((feature) => feature.id === 'demo-house');
  let state = createInitialState(mapPackage);
  state.characters.push({
    id: 'actor-demo',
    name: '测试角色',
    color: '#3498db',
    avatarDataUrl: null,
    visible: true,
    location: { type: 'map', x: 500, y: 520 },
  });

  let actions = actionMap(listFeatureInteractions({
    mapPackage,
    state,
    featureId: house.id,
    characterId: 'actor-demo',
  }));
  assert.equal(actions.enter.enabled, true);
  assert.equal(actions.damage.enabled, true);
  assert.equal(actions.restore.enabled, false);

  state = damageFeatureState(state, mapPackage, house.id);
  assert.ok(deriveSceneState(state.sceneEvents).destroyedObjectIds.includes(house.id));

  actions = actionMap(listFeatureInteractions({
    mapPackage,
    state,
    featureId: house.id,
    characterId: 'actor-demo',
  }));
  assert.equal(actions.enter.enabled, false);
  assert.match(actions.enter.reason, /摧毁/);
  assert.equal(actions.damage.enabled, false);
  assert.equal(actions.restore.enabled, true);
});

test('direct Feature damage reuses normal Scene damage events', () => {
  const mapPackage = preparedMinimal();
  const state = createInitialState(mapPackage);
  const next = damageFeatureState(state, mapPackage, 'demo-house');

  assert.notEqual(next, state);
  assert.equal(next.sceneEvents.length, 1);
  assert.equal(next.sceneEvents[0].type, 'damage');
  assert.ok(next.sceneEvents[0].objectIds.includes('demo-house'));
  assert.ok(deriveSceneState(next.sceneEvents).destroyedObjectIds.includes('demo-house'));
});
