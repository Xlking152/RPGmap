import test from 'node:test';
import assert from 'node:assert/strict';
import { createFeatureInteractionSystem } from '../src/interaction/system.js';
import { registerRuntimeStateReader } from '../src/engine/state-access.js';
import { applyWorldOperations, projectWorldOperationState } from '../src/world/operations.js';

function node(tag) {
  return { tag, dataset: {}, children: [], listeners: new Map(), attributes: new Map(),
    style: { setProperty() {} }, append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
    setAttribute(name, value) { this.attributes.set(name, value); },
    addEventListener(name, callback) { this.listeners.set(name, callback); } };
}
function find(root, predicate) {
  if (predicate(root)) return root;
  for (const child of root.children || []) { const found = find(child, predicate); if (found) return found; }
  return null;
}
const settle = () => new Promise(resolve => setImmediate(resolve));

function fixture(t, { legacy = false, damageB = false } = {}) {
  const features = ['a', 'b'].map((id, index) => ({ id, name: id, category: 'building',
    center: [index * 10 + 1, 1], geometry: { points: [[index * 10, 0], [index * 10 + 2, 0], [index * 10 + 2, 2], [index * 10, 2]] },
    capabilities: { destructible: true, inspectable: true } }));
  const mapPackage = { id: 'map', version: '1', width: 100, height: 100, metersPerUnit: 1, features };
  const scene = { id: 'scene', mapPackage: { id: 'map', version: '1' }, tokens: [], markers: [], attackAreas: [],
    sceneEvents: damageB ? [{ id: 'damage-b', type: 'damage', objectIds: ['b'], clipHits: [] }] : [], featureStates: {}, settings: {} };
  let state = projectWorldOperationState({ preferences: { worldV2: { schemaVersion: 4, id: 'world', name: 'World',
    ruleset: { id: 'test', version: '1' }, activeSceneId: 'scene', actors: [], statusDefinitions: [], scenes: [scene] } } });
  let revision = 1, renders = 0, visuals = 0, canInteract = true, role = 'gm', selectedToken = 'token';
  let failAuthority = false, failPublicRead = false, canonical = true, ackHook = null;
  const listeners = new Map(), panel = node('panel'), replaceChildren = panel.replaceChildren;
  panel.replaceChildren = function (...children) { renders++; replaceChildren.call(this, ...children); };
  const document = { getElementById: () => ({}), createElement: tag => node(tag) };
  const shell = { querySelectorAll() { visuals++; return []; }, querySelector: () => null };
  const previousDocument = globalThis.document; globalThis.document = document;
  const api = { mapPackage, getState() { if (failPublicRead) throw new Error('Injected read exception'); return structuredClone(state); },
    ...(!legacy ? { getStateRevision: () => revision } : {}), map: { getContainer: () => ({ closest: () => shell }), on() {}, off() {} },
    uiPanels: { get: () => panel }, tokens: { list: () => [], resolveActor() {} }, movement: { canonicalSceneTokens: true },
    selection: { getPrimaryTokenId: () => selectedToken },
    status: { resolve: () => ({ statuses: [], capabilities: { canInteract } }) },
    multiplayer: { getCapabilities: () => ({ connected: true, role, canManageStructure: role === 'gm' }) },
    on(name, callback) { listeners.set(name, [...(listeners.get(name) || []), callback]); return () => {
      listeners.set(name, (listeners.get(name) || []).filter(item => item !== callback));
    }; },
    emit(name, detail) { for (const callback of [...listeners.get(name) || []]) callback({ detail }); },
    selectFeature(id) { api.emit('feature:select', { id }); return true; },
    showToast(message) { api.emit('test:toast', message); },
    world: { async performOperations(batch) {
      if (failAuthority) throw new Error('Injected authority rejection');
      const applied = applyWorldOperations(state, batch, { mapPackage, source: { role: 'offline' } });
      state = applied.state; revision++;
      if (canonical) api.emit('scene:content-change', { sceneId: 'scene', types: ['SceneEvent'] });
      await ackHook?.();
      return applied;
    } },
  };
  const unregister = registerRuntimeStateReader(api, () => state);
  t.after(() => { api.emit('app:destroy'); unregister(); globalThis.document = previousDocument; });
  createFeatureInteractionSystem().register(api);
  const counts = () => ({ renders, visuals });
  const button = action => find(panel, item => item.dataset.interactionAction === action);
  const nextEvent = name => new Promise(resolve => { const off = api.on(name, event => { off(); resolve(event.detail); }); });
  const click = async action => {
    const current = button(action); assert(current && !current.disabled);
    const done = nextEvent('interaction:executed');
    current.listeners.get('click')({ preventDefault() {}, stopPropagation() {} });
    const result = await done; await settle(); return result;
  };
  return { api, panel, features, state: () => state, counts, button, click, nextEvent, revision: () => revision,
    setStatus(value) { canInteract = value; }, setRole(value) { role = value; }, setToken(value) { selectedToken = value; },
    rejectAuthority(value) { failAuthority = value; }, rejectRead(value) { failPublicRead = value; },
    emitCanonical(value) { canonical = value; }, onAck(callback) { ackHook = callback; },
  };
}

test('canonical commits cover local damage/restore notifications, execute and the clicked button', async t => {
  const value = fixture(t); value.api.selectFeature('a');
  let before = value.counts();
  assert.equal((await value.click('damage')).ok, true);
  assert.deepEqual(value.counts(), { renders: before.renders + 1, visuals: before.visuals + 1 },
    'one authoritative damage render replaces repeated local post-ACK renders');
  assert.equal(value.button('damage').disabled, true);
  assert.equal(value.button('restore').disabled, false);
  before = value.counts();
  assert.equal((await value.click('restore')).ok, true);
  assert.deepEqual(value.counts(), { renders: before.renders + 1, visuals: before.visuals + 1 });
  assert.equal(value.button('damage').disabled, false);
  before = value.counts();
  value.api.emit('scene:restore'); value.api.emit('scene:damage'); await settle();
  assert.deepEqual(value.counts(), before, 'duplicate local notifications at the rendered revision do no work');
  value.api.emit('scene:content-change', { sceneId: 'scene', types: ['SceneEvent'] });
  assert.deepEqual(value.counts(), { renders: before.renders + 1, visuals: before.visuals + 1 },
    'canonical notifications still force rendering even at the same revision');
});

test('local commits without canonical notification still refresh new state and changed selected Token', async t => {
  const value = fixture(t); value.api.selectFeature('a'); value.emitCanonical(false);
  let before = value.counts();
  assert.equal((await value.api.interaction.damage('a')).ok, true); await settle();
  assert.deepEqual(value.counts(), { renders: before.renders + 1, visuals: before.visuals + 1 });
  assert.equal(value.button('restore').disabled, false);
  value.emitCanonical(true);
  value.onAck(() => value.setToken('other-token'));
  before = value.counts();
  assert.equal((await value.api.interaction.restore('a')).ok, true);
  assert.deepEqual(value.counts(), { renders: before.renders + 2, visuals: before.visuals + 1 },
    'canonical render followed by an unannounced selection change requires a fresh inspection');
});

test('failed or exceptional button calls rebuild the disabled button without a new revision', async t => {
  const value = fixture(t); value.api.selectFeature('a');
  const revision = value.revision(), first = value.button('damage'), before = value.counts();
  value.rejectAuthority(true);
  const denied = await value.click('damage');
  assert.equal(denied.ok, false); assert.match(denied.reason, /authority rejection/);
  assert.equal(value.revision(), revision);
  assert.deepEqual(value.counts(), { renders: before.renders + 1, visuals: before.visuals + 1 });
  assert.notEqual(value.button('damage'), first); assert.equal(value.button('damage').disabled, false);

  value.rejectAuthority(false); value.rejectRead(true);
  const next = value.button('damage'), exceptional = value.counts(), toast = value.nextEvent('test:toast');
  next.listeners.get('click')({ preventDefault() {}, stopPropagation() {} });
  assert.match(await toast, /read exception/); await settle();
  assert.equal(value.revision(), revision);
  assert.equal(value.counts().renders, exceptional.renders + 1);
  assert.notEqual(value.button('damage'), next); assert.equal(value.button('damage').disabled, false);
  value.rejectRead(false);
  value.setRole('player');
  const permissionButton = value.button('damage'), permissionCounts = value.counts();
  const forbidden = await value.click('damage');
  assert.equal(forbidden.ok, false); assert.match(forbidden.reason, /只有 GM/);
  assert.equal(value.revision(), revision);
  assert.equal(value.counts().renders, permissionCounts.renders + 1);
  assert.notEqual(value.button('damage'), permissionButton);
  assert.equal(value.button('damage').disabled, true, 'the recovered button reflects the newly denied permission');
});

test('same-revision status, Token and capability events force inspection; selection changes remain visible', async t => {
  const value = fixture(t, { damageB: true }); value.api.selectFeature('a');
  const revision = value.revision(); let before = value.counts();
  value.setStatus(false); value.api.emit('status:change');
  assert.equal(value.counts().renders, before.renders + 1); assert.equal(value.button('damage').disabled, true);
  value.setStatus(true); value.api.emit('status:change'); assert.equal(value.button('damage').disabled, false);
  for (const name of ['token:create', 'token:delete', 'token:move', 'token:property-change']) {
    before = value.counts(); value.api.emit(name);
    assert.equal(value.counts().renders, before.renders + 1, `${name} cannot be skipped by revision reuse`);
  }
  before = value.counts(); value.setRole('player'); value.api.emit('multiplayer:capabilities');
  assert.equal(value.counts().renders, before.renders + 1); assert.equal(value.button('damage').disabled, true);
  assert.equal(find(value.panel, item => Object.hasOwn(item.dataset, 'damagedFeatureSelect')), null);
  value.setRole('gm'); value.api.emit('multiplayer:capabilities');
  before = value.counts(); value.api.selectFeature('b');
  assert.equal(value.counts().renders, before.renders + 1); assert.equal(value.api.interaction.selectedFeatureId, 'b');
  assert.equal(value.button('restore').disabled, false);
  value.api.selectFeature(null);
  assert.ok(find(value.panel, item => Object.hasOwn(item.dataset, 'damagedFeatureSelect')));
  value.setRole('player'); before = value.counts(); value.api.emit('multiplayer:capabilities');
  assert.equal(value.counts().renders, before.renders + 1);
  assert.equal(find(value.panel, item => Object.hasOwn(item.dataset, 'damagedFeatureSelect')), null,
    'GM-only damaged list also disappears when no Feature is selected');
  assert.equal(value.revision(), revision);
});

test('legacy runtimes without a committed revision never suppress local refreshes', async t => {
  const value = fixture(t, { legacy: true }); value.api.selectFeature('a');
  const before = value.counts();
  assert.equal((await value.api.interaction.damage('a')).ok, true); await settle();
  assert.deepEqual(value.counts(), { renders: before.renders + 3, visuals: before.visuals + 3 },
    'canonical event, local damage completion and execute all remain fresh without revision qualification');
  const current = value.counts(); value.api.emit('scene:restore');
  assert.deepEqual(value.counts(), { renders: current.renders + 1, visuals: current.visuals + 1 });
});

test('damage still ejects occupants asynchronously and refreshes only after that work finishes', async t => {
  const value = fixture(t);
  value.features[0].capabilities.enterable = true;
  let ejections = 0, releaseExit;
  value.api.tokens.list = () => [{ id: 'occupant', placement: 'feature', featureId: 'a' }];
  value.api.movement.exitFeature = async id => { assert.equal(id, 'occupant'); ejections++; await new Promise(resolve => { releaseExit = resolve; }); };
  const before = value.counts();
  assert.equal((await value.api.interaction.damage('a')).ok, true);
  assert.equal(ejections, 1, 'only the destroyed containing Feature triggers ejection');
  assert.equal(typeof releaseExit, 'function', 'damage ACK does not await the background occupant exit');
  assert.deepEqual(value.counts(), { renders: before.renders + 1, visuals: before.visuals + 1 });
  releaseExit(); await settle();
  assert.deepEqual(value.counts(), { renders: before.renders + 1, visuals: before.visuals + 1 },
    'unchanged revision after ejection completion can reuse the canonical rendering');
});
