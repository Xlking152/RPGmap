import test from 'node:test';
import assert from 'node:assert/strict';
import { declaredFeatureAction, listFeatureInteractions } from '../src/interaction/model.js';
import { createFeatureInteractionSystem } from '../src/interaction/system.js';
import { createFeatureOperations } from '../src/interaction/operations.js';
import { registerRuntimeStateReader } from '../src/engine/state-access.js';

test('restore declarations retain explicit action overrides, capability defaults and legacy defaults', () => {
  const cases = [
    [{ capabilities: { actions: { restore: false }, destructible: true }, destructible: true }, false],
    [{ capabilities: { actions: { restore: true }, destructible: false } }, true],
    [{ capabilities: { destructible: true } }, true],
    [{ capabilities: { destructible: false }, destructible: true }, false],
    [{ capabilities: { destructible: null }, destructible: true }, true],
    [{ destructible: true }, true],
    [{ destructible: false }, false],
    [{}, false],
  ];
  for (const [value, expected] of cases) {
    const feature = { id: 'object', ...value };
    assert.equal(declaredFeatureAction(feature, 'restore'), expected);
    const actions = listFeatureInteractions({ mapPackage: { features: [feature] }, state: { sceneEvents: [] }, featureId: feature.id });
    assert.equal(actions.some(action => action.id === 'restore'), expected,
      'declaration agrees with the existing descriptor presence, regardless of its enabled state');
  }
});

function node(tag = 'div') {
  return { tag, dataset: {}, children: [], attributes: new Map(), listeners: new Map(),
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
    setAttribute(name, value) { this.attributes.set(name, value); },
    addEventListener(name, callback) { this.listeners.set(name, callback); },
  };
}

function find(root, predicate) {
  if (predicate(root)) return root;
  for (const child of root.children || []) { const result = find(child, predicate); if (result) return result; }
  return null;
}

function panelFixture(role = 'gm') {
  const feature = (id, extra = {}) => ({ id, name: id, category: 'building',
    geometry: { points: [[0, 0], [1, 0], [1, 1], [0, 1]] }, ...extra });
  const features = [
    feature('explicit-off', { capabilities: { destructible: true, actions: { restore: false } } }),
    feature('explicit-on', { capabilities: { destructible: false, actions: { restore: true } } }),
    feature('capability-default', { capabilities: { destructible: true } }),
    feature('legacy-default', { destructible: true }),
    feature('no-restore'),
    feature('intact', { capabilities: { destructible: true } }),
  ];
  const sceneEvents = [{ id: 'damage', type: 'damage',
    objectIds: ['explicit-off', 'explicit-on', 'legacy-default', 'no-restore'],
    clipHits: [{ featureId: 'capability-default', polygon: [[0, 0], [.5, 0], [.5, 1], [0, 1]] }] }];
  const scene = { id: 'scene', sceneEvents, featureStates: {}, tokens: [{ id: 'token', actorId: 'actor', placement: 'map' }] };
  const state = { sceneEvents, preferences: { worldV2: { activeSceneId: 'scene', scenes: [scene], actors: [{ id: 'actor' }] } } };
  const panel = node(), listeners = new Map();
  const document = { getElementById: () => ({}), createElement: tag => node(tag) };
  const shell = { querySelectorAll: () => [], querySelector: () => null };
  // The production editor is unrelated to this panel; no map DOM document is supplied.
  const container = { closest: () => shell };
  let statusReads = 0, commits = 0, canInteract = false;
  const api = { mapPackage: { id: 'map', version: '1', features }, getState: () => structuredClone(state), getStateRevision: () => 1,
    map: { getContainer: () => container, on() {}, off() {} }, uiPanels: { get: () => panel },
    selection: { getPrimaryTokenId: () => 'token' }, tokens: { list: () => [], resolveActor() {} },
    movement: { canonicalSceneTokens: true }, world: { performOperations() { commits++; } },
    multiplayer: { getCapabilities: () => ({ connected: true, role, canManageStructure: role === 'gm' }) },
    status: { resolve() { statusReads++; return { statuses: [], capabilities: { canInteract } }; } },
    on(name, callback) { listeners.set(name, [...(listeners.get(name) || []), callback]); return () => {}; },
    emit(name, detail) { for (const callback of listeners.get(name) || []) callback({ detail }); },
  };
  const unregister = registerRuntimeStateReader(api, () => state);
  return { api, panel, document, state, statusReads: () => statusReads, commits: () => commits,
    allowInteraction(value) { canInteract = value; }, unregister };
}

test('GM damaged list uses declarations without resolving Token statuses; actual restore remains guarded', async () => {
  const value = panelFixture(), previousDocument = globalThis.document;
  globalThis.document = value.document;
  try {
    createFeatureInteractionSystem().register(value.api);
    const select = find(value.panel, item => Object.hasOwn(item.dataset, 'damagedFeatureSelect'));
    assert.deepEqual(select.children.map(option => option.value), ['explicit-on', 'capability-default', 'legacy-default']);
    assert.equal(select.children.find(option => option.value === 'capability-default').textContent, 'capability-default · 局部破坏');
    assert.equal(value.statusReads(), 0, 'listing restorable objects cannot normalize the selected Actor for every object/action');
    value.api.emit('scene:content-change', { sceneId: 'scene', types: ['SceneEvent'] });
    assert.equal(value.statusReads(), 0, 'authoritative damage redraw keeps the declaration-only fast path');

    const before = structuredClone(value.state);
    assert.equal(value.api.interaction.actionsForFeature('capability-default').find(action => action.id === 'restore').enabled, false);
    const denied = await value.api.interaction.restore('capability-default');
    assert.equal(denied.ok, false);
    assert.match(denied.reason, /禁止 Feature 交互/);
    assert.equal(value.commits(), 0);
    assert.deepEqual(value.state, before);
    assert.ok(value.statusReads() > 0, 'the actual selected action still resolves current Token status');
    value.allowInteraction(true);
    assert.equal(value.api.interaction.actionsForFeature('capability-default').find(action => action.id === 'restore').enabled, true,
      'the shared geometric context cannot cache an old status denial');
  } finally {
    value.api.emit('app:destroy'); value.unregister(); globalThis.document = previousDocument;
  }
});

test('player cannot see the GM damaged list or submit restoration', async () => {
  const value = panelFixture('player'), previousDocument = globalThis.document;
  globalThis.document = value.document;
  try {
    createFeatureInteractionSystem().register(value.api);
    assert.equal(find(value.panel, item => Object.hasOwn(item.dataset, 'damagedFeatureSelect')), null);
    assert.equal(value.statusReads(), 0);
    const denied = await value.api.interaction.restore('legacy-default');
    assert.equal(denied.ok, false);
    assert.match(denied.reason, /只有 GM/);
    assert.equal(value.commits(), 0);
    assert.equal(value.statusReads(), 0, 'structure permission rejection precedes Actor status resolution');
  } finally {
    value.api.emit('app:destroy'); value.unregister(); globalThis.document = previousDocument;
  }
});

function statusFixture() {
  const feature = { id: 'object', geometry: { points: [[0, 0], [1, 0], [1, 1], [0, 1]] },
    capabilities: { destructible: true, inspectable: true, openable: true,
      statusRules: { inspect: { requiresAll: ['knowledge'] }, damage: { requiresAll: ['ready'] }, open: { forbidsAny: ['jammed'] } } } };
  const state = { sceneEvents: [], preferences: { entitySystem: { actors: [], tokens: [{ id: 'token', placement: 'map' }] } } };
  return { feature, state, mapPackage: { features: [feature] } };
}

test('one synchronous action list resolves one coherent Token snapshot and the next list rereads its rules', () => {
  const value = statusFixture();
  let reads = 0, snapshot = { statuses: [{ definitionId: 'knowledge' }, { definitionId: 'ready' }], capabilities: { canInteract: true } };
  const resolveStatus = context => { reads++; assert.deepEqual(context, { tokenId: 'token' }); return snapshot; };
  const list = () => listFeatureInteractions({ ...value, featureId: value.feature.id, tokenId: 'token', resolveStatus });
  const first = list();
  assert.equal(reads, 1, 'inspect, damage and open use the same synchronous Token snapshot');
  for (const action of ['inspect', 'damage', 'open']) assert.equal(first.find(item => item.id === action).enabled, true);
  assert.equal(first.find(item => item.id === 'restore').reason, '对象当前完整');
  assert.equal(first.find(item => item.id === 'close').reason, '对象已经关闭');

  snapshot = { statuses: [{ definitionId: 'knowledge' }, { definitionId: 'jammed' }], capabilities: { canInteract: true } };
  const second = list();
  assert.equal(reads, 2, 'snapshot lifetime ends with this descriptor list, even when state identity is unchanged');
  assert.equal(second.find(item => item.id === 'inspect').enabled, true);
  assert.equal(second.find(item => item.id === 'damage').reason, '缺少所需状态：ready');
  assert.equal(second.find(item => item.id === 'open').reason, '当前状态禁止操作：jammed');

  snapshot = { statuses: [{ definitionId: 'knowledge' }], capabilities: { canInteract: false, reasons: ['Fresh interaction denial'] } };
  const third = list();
  assert.equal(reads, 3);
  assert.equal(third.find(item => item.id === 'inspect').enabled, true, 'inspect keeps its prior capability exception and own rule');
  for (const action of ['damage', 'open']) assert.equal(third.find(item => item.id === action).reason, 'Fresh interaction denial');
});

test('descriptor snapshot reuse retains missing Token and asynchronous resolver rejection behavior', () => {
  const value = statusFixture(); let reads = 0;
  const resolver = () => { reads++; return Promise.resolve({ statuses: [], capabilities: {} }); };
  const withoutToken = listFeatureInteractions({ ...value, featureId: value.feature.id, resolveStatus: resolver });
  assert.equal(reads, 0, 'a missing Token does not invoke the status resolver');
  assert.equal(withoutToken.find(item => item.id === 'damage').reason, '该操作需要先选择 Token 以检查状态');
  const asyncDescriptors = listFeatureInteractions({ ...value, featureId: value.feature.id, tokenId: 'token', resolveStatus: resolver });
  assert.equal(reads, 1);
  for (const action of ['inspect', 'damage', 'open']) {
    assert.equal(asyncDescriptors.find(item => item.id === action).enabled, false);
    assert.equal(asyncDescriptors.find(item => item.id === action).reason, '状态读取必须在操作前同步完成');
  }
});

test('real command independently rechecks status after a permitted descriptor list', async () => {
  const value = statusFixture(); let reads = 0, commits = 0, allowed = true;
  const operations = createFeatureOperations({ mapPackage: value.mapPackage, getState: () => structuredClone(value.state),
    replaceState() { commits++; }, performOperations() { commits++; },
    resolveStatus() { reads++; return { statuses: [{ definitionId: 'knowledge' }, { definitionId: 'ready' }], capabilities: { canInteract: allowed } }; } });
  assert.equal(operations.actionsForFeature('object', { tokenId: 'token' }).find(item => item.id === 'damage').enabled, true);
  assert.equal(reads, 1);
  allowed = false;
  const result = await operations.damage('object', { tokenId: 'token' });
  assert.equal(reads, 2, 'execute owns a new list and cannot reuse UI permission');
  assert.equal(result.ok, false);
  assert.match(result.reason, /禁止 Feature 交互/);
  assert.equal(commits, 0);
  assert.deepEqual(value.state.sceneEvents, []);
});
