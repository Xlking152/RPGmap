import test from 'node:test';
import assert from 'node:assert/strict';

import { createInitialState, deriveSceneState } from '../src/engine/state.js';
import { inspectableFeaturesAtPoint } from '../src/engine/feature-selection.js';
import { mapPackageCapabilities, prepareMapPackage } from '../src/map-package/contract.js';
import {
  FEATURE_STATE_KEY,
  LEGACY_FEATURE_INTERACTION_STATE_KEY,
  damageFeatureState,
  getFeatureInteractionState,
  getFeatureRuntimeState,
  listFeatureInteractions,
  patchFeatureRuntimeState,
  setFeatureOpenState,
} from '../src/interaction/model.js';
import { createFeatureOperations } from '../src/interaction/operations.js';
import { createMinimalReferencePackage } from '../reference/maps/minimal/package.js';

function preparedMinimal() {
  return prepareMapPackage(createMinimalReferencePackage(), { source: 'test:minimal' });
}

function preparedGenericOperationsMap() {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 120"><g data-layer="base"></g></svg>';
  return prepareMapPackage({
    id: 'generic-operation-map',
    version: '1.0.0',
    width: 200,
    height: 120,
    layers: ['base'],
    svg,
    createSvg: () => svg,
    features: [
      {
        id: 'portal-a',
        name: 'Portal A',
        category: 'mechanism',
        geometry: { type: 'polygon', points: [[40, 20], [60, 20], [60, 100], [40, 100]] },
        center: [50, 60],
        entrance: [50, 100],
        interaction: { initialState: { open: false, custom: { lockMode: 'manual' } } },
        capabilities: {
          inspectable: true,
          enterable: true,
          openable: true,
          actions: { inspect: true, enter: true, exit: true, open: true, close: true },
        },
      },
      {
        id: 'crate-a',
        name: 'Crate A',
        category: 'prop',
        mode: 'object',
        geometry: { type: 'polygon', points: [[100, 40], [140, 40], [140, 80], [100, 80]] },
        center: [120, 60],
        destructible: { enabled: true },
        capabilities: { inspectable: true, destructible: true },
      },
    ],
  }, { source: 'test:generic-operations' });
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

test('MapPackage contract validates structured status rules without script fields', () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><g data-layer="base"/></svg>';
  const mapPackage = prepareMapPackage({
    id: 'status-rule-map', version: '1', width: 100, height: 100, layers: ['base'], svg,
    features: [{
      id: 'altar', geometry: { points: [[10, 10], [20, 10], [20, 20], [10, 20]] },
      capabilities: {
        actions: { open: true },
        statusRules: {
          open: {
            requiresAll: ['status-spirit'],
            forbidsAny: ['status-incapacitated'],
            onSuccess: {
              apply: [{ statusId: 'blessed', scope: 'actor', stacks: 2 }],
              remove: [{ statusId: 'muddy', scope: 'token' }],
            },
          },
        },
      },
    }],
  });
  assert.deepEqual(mapPackage.features[0].capabilities.statusRules.open, {
    requiresAll: ['status-spirit'],
    forbidsAny: ['status-incapacitated'],
    onSuccess: {
      apply: [{ statusId: 'blessed', scope: 'actor', stacks: 2 }],
      remove: [{ statusId: 'muddy', scope: 'token' }],
    },
  });
  assert.throws(() => prepareMapPackage({
    id: 'bad-status-rule-map', version: '1', width: 100, height: 100, layers: ['base'], svg,
    features: [{ id: 'bad', geometry: { points: [[0, 0], [1, 0], [1, 1]] }, capabilities: {
      statusRules: { enter: { onSuccess: { apply: [{ statusId: 'x', scope: 'world' }] } } },
    } }],
  }), /scope must be actor or token/);
});

test('inspection uses Capability instead of map-category allowlists', () => {
  const mapPackage = preparedMinimal();
  const hits = inspectableFeaturesAtPoint({ x: 500, y: 465 }, mapPackage.features);
  assert.ok(hits.some((feature) => feature.id === 'demo-door'));
});

test('Feature State unifies open, Scene damage status and custom state', () => {
  const mapPackage = preparedGenericOperationsMap();
  const portal = mapPackage.features.find((feature) => feature.id === 'portal-a');
  const crate = mapPackage.features.find((feature) => feature.id === 'crate-a');
  let state = createInitialState(mapPackage);

  assert.deepEqual(getFeatureRuntimeState(state, portal), {
    open: false,
    status: 'intact',
    damaged: false,
    destroyed: false,
    custom: { lockMode: 'manual' },
  });

  state = patchFeatureRuntimeState(state, portal.id, { open: true, custom: { lockMode: 'remote', channel: 2 } });
  assert.equal(state.preferences[FEATURE_STATE_KEY][portal.id].open, true);
  assert.deepEqual(getFeatureRuntimeState(state, portal).custom, { lockMode: 'remote', channel: 2 });

  state = damageFeatureState(state, mapPackage, crate.id);
  const damaged = getFeatureRuntimeState(state, crate);
  assert.equal(damaged.status, 'destroyed');
  assert.equal(damaged.destroyed, true);
  assert.equal(damaged.damaged, true);
});

test('Feature State reads legacy featureInteractions and writes the unified featureStates key', () => {
  const mapPackage = preparedMinimal();
  const door = mapPackage.features.find((feature) => feature.id === 'demo-door');
  let state = createInitialState(mapPackage);
  state.preferences[LEGACY_FEATURE_INTERACTION_STATE_KEY] = { [door.id]: { open: true } };

  assert.equal(getFeatureRuntimeState(state, door).open, true);
  state = setFeatureOpenState(state, door.id, false);
  assert.equal(state.preferences[FEATURE_STATE_KEY][door.id].open, false);
  assert.equal(getFeatureRuntimeState(state, door).open, false);
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
  assert.equal(state.preferences[FEATURE_STATE_KEY][door.id].open, true);
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

test('direct Feature damage reuses normal Scene damage events without category routing', () => {
  const mapPackage = preparedGenericOperationsMap();
  const state = createInitialState(mapPackage);
  const next = damageFeatureState(state, mapPackage, 'crate-a');

  assert.notEqual(next, state);
  assert.equal(next.sceneEvents.length, 1);
  assert.equal(next.sceneEvents[0].type, 'damage');
  assert.ok(next.sceneEvents[0].objectIds.includes('crate-a'));
  assert.ok(deriveSceneState(next.sceneEvents).destroyedObjectIds.includes('crate-a'));
});

test('Feature Operations await map-independent Runtime ports before reporting success', async () => {
  const mapPackage = preparedGenericOperationsMap();
  let state = createInitialState(mapPackage);
  state.characters.push({
    id: 'actor-a',
    name: 'Actor A',
    color: '#3498db',
    avatarDataUrl: null,
    visible: true,
    location: { type: 'map', x: 20, y: 60 },
  });
  const calls = [];
  const events = [];
  const operations = createFeatureOperations({
    mapPackage,
    getState: () => state,
    replaceState: (next) => { state = next; },
    selectFeature: (featureId) => { calls.push(['inspect', featureId]); return true; },
    planFeatureEntry: ({ feature, characterId }) => { calls.push(['enter', feature.id, characterId]); return true; },
    exitFeature: ({ feature, characterId }) => { calls.push(['exit', feature.id, characterId]); return true; },
    restoreFeatures: (featureIds) => { calls.push(['restore', ...featureIds]); return true; },
    emit: (name, detail) => events.push([name, detail]),
  });

  assert.equal((await operations.inspect('portal-a')).ok, true);
  assert.equal((await operations.open('portal-a')).ok, true);
  assert.equal(operations.stateForFeature('portal-a').open, true);
  assert.equal((await operations.enter('portal-a', 'actor-a')).ok, true);

  state.characters[0].location = { type: 'feature', featureId: 'portal-a' };
  assert.equal((await operations.exit('portal-a', 'actor-a')).ok, true);

  const damaged = await operations.damage('crate-a');
  assert.equal(damaged.ok, true);
  assert.equal(operations.stateForFeature('crate-a').destroyed, true);
  assert.deepEqual(calls, [
    ['inspect', 'portal-a'],
    ['enter', 'portal-a', 'actor-a'],
    ['exit', 'portal-a', 'actor-a'],
  ]);
  assert.ok(events.some(([name]) => name === 'interaction:state-change'));
  assert.ok(events.some(([name]) => name === 'scene:damage'));
});

test('Feature status requirements are rechecked and status side effects commit atomically', async () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><g data-layer="base"/></svg>';
  const mapPackage = prepareMapPackage({
    id: 'feature-status-atomic', version: '1', width: 100, height: 100, layers: ['base'], svg,
    features: [{
      id: 'spirit-door', geometry: { points: [[40, 0], [60, 0], [60, 100], [40, 100]] },
      capabilities: {
        openable: true,
        actions: { open: true, close: true },
        statusRules: { open: {
          requiresAll: ['status-spirit'], forbidsAny: ['status-incapacitated'],
          onSuccess: { apply: [{ statusId: 'blessed', scope: 'actor', stacks: 1 }] },
        } },
      },
    }],
  });
  let state = createInitialState(mapPackage);
  state.characters.push({ id: 'character-a', location: { type: 'map', x: 10, y: 10 } });
  state.preferences.entitySystem = {
    schemaVersion: 3,
    statusDefinitions: [{ id: 'blessed', name: 'Blessed', scopes: ['actor'], maxStacks: 1, changes: [], capabilities: {} }],
    actors: [{ id: 'actor-a', effects: [] }],
    tokens: [{ id: 'token-a', actorId: 'actor-a', characterId: 'character-a', effects: [] }],
  };
  let activeStatuses = [];
  const resolveStatus = () => ({ statuses: activeStatuses, capabilities: { canInteract: true } });
  let actions = actionMap(listFeatureInteractions({
    mapPackage, state, featureId: 'spirit-door', characterId: 'character-a', resolveStatus,
  }));
  assert.match(actions.open.reason, /status-spirit/);

  activeStatuses = [{ definitionId: 'status-spirit', enabled: true }];
  actions = actionMap(listFeatureInteractions({
    mapPackage, state, featureId: 'spirit-door', characterId: 'character-a', resolveStatus,
  }));
  assert.equal(actions.open.enabled, true);

  const rejected = createFeatureOperations({
    mapPackage, getState: () => state, replaceState: next => { state = next; }, resolveStatus,
    getStatusDefinitions: () => [
      { id: 'status-spirit', builtIn: true, persisted: true },
      { id: 'blessed', persisted: true },
    ],
    applyStatusMutations: () => { throw new Error('simulated status rejection'); },
  });
  assert.equal((await rejected.open('spirit-door', { characterId: 'character-a' })).ok, false);
  assert.equal(rejected.stateForFeature('spirit-door').open, false, 'Feature must not commit before a failing status effect');

  let replacementCount = 0;
  const accepted = createFeatureOperations({
    mapPackage, getState: () => state, replaceState: next => { replacementCount += 1; state = next; }, resolveStatus,
    getStatusDefinitions: () => [
      { id: 'status-spirit', builtIn: true, persisted: true },
      { id: 'blessed', persisted: true },
    ],
    applyStatusMutations: (draft, mutations) => {
      const next = structuredClone(draft);
      next.preferences.entitySystem.actors[0].effects.push({
        id: 'effect-blessed', definitionId: mutations[0].statusId, stacks: mutations[0].stacks, enabled: true,
      });
      return next;
    },
  });
  const result = await accepted.open('spirit-door', { characterId: 'character-a' });
  assert.equal(result.ok, true);
  assert.equal(replacementCount, 1);
  assert.equal(accepted.stateForFeature('spirit-door').open, true);
  assert.equal(state.preferences.entitySystem.actors[0].effects[0].definitionId, 'blessed');

  const canonicalBeforeFailure = structuredClone(state);
  const persistenceRejected = createFeatureOperations({
    mapPackage,
    getState: () => state,
    replaceState: async () => { throw new Error('simulated LAN persistence rejection'); },
    resolveStatus,
    getStatusDefinitions: () => [
      { id: 'status-spirit', builtIn: true, persisted: true },
      { id: 'blessed', persisted: true },
    ],
    applyStatusMutations: draft => structuredClone(draft),
  });
  const failedClose = await persistenceRejected.close('spirit-door', { characterId: 'character-a' });
  assert.equal(failedClose.ok, false);
  assert.match(failedClose.reason, /persistence rejection/);
  assert.deepEqual(state, canonicalBeforeFailure, 'a rejected LAN commit must leave the canonical Feature and status state unchanged');
});
