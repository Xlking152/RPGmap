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

function preparedMinimal() { return prepareMapPackage(createMinimalReferencePackage(), { source: 'test:minimal' }); }

function preparedGenericOperationsMap() {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 120"><g data-layer="base"></g></svg>';
  return prepareMapPackage({
    id: 'generic-operation-map', version: '1.0.0', width: 200, height: 120, layers: ['base'], svg, createSvg: () => svg,
    features: [
      { id: 'portal-a', name: 'Portal A', category: 'mechanism', geometry: { type: 'polygon', points: [[40,20],[60,20],[60,100],[40,100]] }, center: [50,60], entrance: [50,100], interaction: { initialState: { open: false, custom: { lockMode: 'manual' } } }, capabilities: { inspectable: true, enterable: true, openable: true, actions: { inspect: true, enter: true, exit: true, open: true, close: true } } },
      { id: 'crate-a', name: 'Crate A', category: 'prop', mode: 'object', geometry: { type: 'polygon', points: [[100,40],[140,40],[140,80],[100,80]] }, center: [120,60], destructible: { enabled: true }, capabilities: { inspectable: true, destructible: true } },
    ],
  }, { source: 'test:generic-operations' });
}

function actionMap(actions) { return Object.fromEntries(actions.map(action => [action.id, action])); }
function installToken(state, { id = 'token-a', actorId = 'actor-a', placement = 'map', featureId = null } = {}) {
  state.preferences.entitySystem = {
    schemaVersion: 3,
    statusDefinitions: state.preferences.entitySystem?.statusDefinitions || [],
    actors: state.preferences.entitySystem?.actors || [{ id: actorId, effects: [] }],
    tokens: [{ id, actorId, placement, x: placement === 'map' ? 20 : null, y: placement === 'map' ? 60 : null, featureId, effects: [] }],
  };
  return state;
}

test('MapPackage contract normalizes action capabilities including open/close', () => {
  const mapPackage = preparedMinimal();
  const door = mapPackage.features.find(feature => feature.id === 'demo-door');
  const house = mapPackage.features.find(feature => feature.id === 'demo-house');
  assert.equal(door.capabilities.openable, true);
  assert.equal(door.capabilities.actions.open, true);
  assert.equal(house.capabilities.enterable, true);
  assert.equal(house.capabilities.actions.enter, true);
  assert.equal(mapPackageCapabilities(mapPackage).openableCount, 1);
});

test('MapPackage contract validates structured status rules without script fields', () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><g data-layer="base"/></svg>';
  const mapPackage = prepareMapPackage({ id: 'status-rule-map', version: '1', width: 100, height: 100, layers: ['base'], svg, features: [{ id: 'altar', geometry: { points: [[10,10],[20,10],[20,20],[10,20]] }, capabilities: { actions: { open: true }, statusRules: { open: { requiresAll: ['status-spirit'], forbidsAny: ['status-incapacitated'], onSuccess: { apply: [{ statusId: 'blessed', scope: 'actor', stacks: 2 }], remove: [{ statusId: 'muddy', scope: 'token' }] } } } } }] });
  assert.equal(mapPackage.features[0].capabilities.statusRules.open.onSuccess.apply[0].scope, 'actor');
  assert.throws(() => prepareMapPackage({ id: 'bad-status-rule-map', version: '1', width: 100, height: 100, layers: ['base'], svg, features: [{ id: 'bad', geometry: { points: [[0,0],[1,0],[1,1]] }, capabilities: { statusRules: { enter: { onSuccess: { apply: [{ statusId: 'x', scope: 'world' }] } } } } }] }), /scope must be actor or token/);
});

test('inspection uses Capability instead of map-category allowlists', () => {
  assert.ok(inspectableFeaturesAtPoint({ x: 500, y: 465 }, preparedMinimal().features).some(feature => feature.id === 'demo-door'));
});

test('Feature State unifies open, Scene damage status and custom state', () => {
  const mapPackage = preparedGenericOperationsMap();
  const portal = mapPackage.features.find(feature => feature.id === 'portal-a');
  const crate = mapPackage.features.find(feature => feature.id === 'crate-a');
  let state = createInitialState(mapPackage);
  assert.equal(getFeatureRuntimeState(state, portal).open, false);
  state = patchFeatureRuntimeState(state, portal.id, { open: true, custom: { lockMode: 'remote', channel: 2 } });
  assert.equal(state.preferences[FEATURE_STATE_KEY][portal.id].open, true);
  state = damageFeatureState(state, mapPackage, crate.id);
  assert.equal(getFeatureRuntimeState(state, crate).destroyed, true);
});

test('Feature State reads legacy featureInteractions but writes unified featureStates', () => {
  const mapPackage = preparedMinimal();
  const door = mapPackage.features.find(feature => feature.id === 'demo-door');
  let state = createInitialState(mapPackage);
  state.preferences[LEGACY_FEATURE_INTERACTION_STATE_KEY] = { [door.id]: { open: true } };
  assert.equal(getFeatureRuntimeState(state, door).open, true);
  state = setFeatureOpenState(state, door.id, false);
  assert.equal(state.preferences[FEATURE_STATE_KEY][door.id].open, false);
});

test('open/close interactions are derived from generic Feature state', () => {
  const mapPackage = preparedMinimal();
  const door = mapPackage.features.find(feature => feature.id === 'demo-door');
  let state = createInitialState(mapPackage);
  assert.deepEqual(getFeatureInteractionState(state, door), { open: false });
  let actions = actionMap(listFeatureInteractions({ mapPackage, state, featureId: door.id }));
  assert.equal(actions.open.enabled, true);
  state = setFeatureOpenState(state, door.id, true);
  actions = actionMap(listFeatureInteractions({ mapPackage, state, featureId: door.id }));
  assert.equal(actions.close.enabled, true);
});

test('enter action is Capability-driven and reacts to canonical Token/Scene state', () => {
  const mapPackage = preparedMinimal();
  const house = mapPackage.features.find(feature => feature.id === 'demo-house');
  let state = installToken(createInitialState(mapPackage), { id: 'token-demo' });
  let actions = actionMap(listFeatureInteractions({ mapPackage, state, featureId: house.id, tokenId: 'token-demo' }));
  assert.equal(actions.enter.enabled, true);
  state = damageFeatureState(state, mapPackage, house.id);
  assert.ok(deriveSceneState(state.sceneEvents).destroyedObjectIds.includes(house.id));
  actions = actionMap(listFeatureInteractions({ mapPackage, state, featureId: house.id, tokenId: 'token-demo' }));
  assert.equal(actions.enter.enabled, false);
  assert.match(actions.enter.reason, /摧毁/);
});

test('direct Feature damage reuses normal Scene damage events without category routing', () => {
  const mapPackage = preparedGenericOperationsMap();
  const next = damageFeatureState(createInitialState(mapPackage), mapPackage, 'crate-a');
  assert.equal(next.sceneEvents[0].type, 'damage');
  assert.ok(deriveSceneState(next.sceneEvents).destroyedObjectIds.includes('crate-a'));
});

test('Feature Operations await Token-based Runtime ports before reporting success', async () => {
  const mapPackage = preparedGenericOperationsMap();
  let state = installToken(createInitialState(mapPackage), { id: 'token-a' });
  const calls = [];
  const events = [];
  const operations = createFeatureOperations({
    mapPackage, getState: () => state, replaceState: next => { state = next; },
    selectFeature: featureId => { calls.push(['inspect', featureId]); return true; },
    planFeatureEntry: ({ feature, tokenId }) => { calls.push(['enter', feature.id, tokenId]); return true; },
    exitFeature: ({ feature, tokenId }) => { calls.push(['exit', feature.id, tokenId]); return true; },
    emit: (name, detail) => events.push([name, detail]),
  });
  assert.equal((await operations.inspect('portal-a')).ok, true);
  assert.equal((await operations.open('portal-a')).ok, true);
  assert.equal((await operations.enter('portal-a', 'token-a')).ok, true);
  state.preferences.entitySystem.tokens[0] = { ...state.preferences.entitySystem.tokens[0], placement: 'feature', x: null, y: null, featureId: 'portal-a' };
  assert.equal((await operations.exit('portal-a', 'token-a')).ok, true);
  assert.equal((await operations.damage('crate-a')).ok, true);
  assert.deepEqual(calls, [['inspect','portal-a'], ['enter','portal-a','token-a'], ['exit','portal-a','token-a']]);
  assert.ok(events.some(([name]) => name === 'scene:damage'));
});

test('Feature status requirements and side effects use tokenId atomically', async () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><g data-layer="base"/></svg>';
  const mapPackage = prepareMapPackage({ id: 'feature-status-atomic', version: '1', width: 100, height: 100, layers: ['base'], svg, features: [{ id: 'spirit-door', geometry: { points: [[40,0],[60,0],[60,100],[40,100]] }, capabilities: { openable: true, actions: { open: true, close: true }, statusRules: { open: { requiresAll: ['status-spirit'], onSuccess: { apply: [{ statusId: 'blessed', scope: 'actor', stacks: 1 }] } } } } }] });
  let state = installToken(createInitialState(mapPackage));
  state.preferences.entitySystem.statusDefinitions = [{ id: 'blessed', name: 'Blessed', scopes: ['actor'], maxStacks: 1, changes: [], capabilities: {} }];
  let activeStatuses = [];
  const resolveStatus = ({ tokenId }) => tokenId === 'token-a' ? { statuses: activeStatuses, capabilities: { canInteract: true } } : null;
  let actions = actionMap(listFeatureInteractions({ mapPackage, state, featureId: 'spirit-door', tokenId: 'token-a', resolveStatus }));
  assert.match(actions.open.reason, /status-spirit/);
  activeStatuses = [{ definitionId: 'status-spirit', enabled: true }];
  actions = actionMap(listFeatureInteractions({ mapPackage, state, featureId: 'spirit-door', tokenId: 'token-a', resolveStatus }));
  assert.equal(actions.open.enabled, true);

  let replacementCount = 0;
  const accepted = createFeatureOperations({
    mapPackage, getState: () => state, replaceState: next => { replacementCount += 1; state = next; }, resolveStatus,
    getStatusDefinitions: () => [{ id: 'status-spirit', builtIn: true, persisted: true }, { id: 'blessed', persisted: true }],
    applyStatusMutations: (draft, mutations) => {
      const next = structuredClone(draft);
      next.preferences.entitySystem.actors[0].effects.push({ id: 'effect-blessed', definitionId: mutations[0].statusId, stacks: 1, enabled: true });
      return next;
    },
  });
  const result = await accepted.open('spirit-door', { tokenId: 'token-a' });
  assert.equal(result.ok, true);
  assert.equal(replacementCount, 1);
  assert.equal(state.preferences.entitySystem.actors[0].effects[0].definitionId, 'blessed');
});
