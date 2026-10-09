import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import clipping from 'polygon-clipping';
import { applyWorldOperations, projectWorldOperationState } from '../src/world/operations.js';
import { worldOperationsToDocumentWrites, documentWritesToWorldOperations } from '../src/documents/protocol.js';

class Element {
  constructor(document = null) { this.ownerDocument = document; this.children = []; this.dataset = {}; this.style = {}; this.listeners = new Map(); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  removeEventListener(type) { this.listeners.delete(type); }
  querySelector() { return null; }
  setAttribute() {}
  getContext() {}
}
const document = { documentElement: { style: {} }, addEventListener() {},
  createElement: () => new Element(), createElementNS: () => new Element() };
const previousGlobals = new Map(['window', 'document', 'navigator'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
const window = { document, navigator: { userAgent: 'Node', platform: 'Win32' },
  screen: { deviceXDPI: 1, logicalXDPI: 1 }, devicePixelRatio: 1,
  addEventListener() {}, removeEventListener() {}, setTimeout, clearTimeout };
for (const [key, value] of Object.entries({ window, document, navigator: window.navigator }))
  Object.defineProperty(globalThis, key, { configurable: true, value });
const L = (await import('leaflet')).default;
const originalLeaflet = { layerGroup: L.layerGroup, polygon: L.polygon, marker: L.marker, divIcon: L.divIcon };
L.layerGroup = () => ({ layers: [], addTo(map) { (map.testLayers ||= []).push(this); return this; }, clearLayers() { this.layers = []; } });
L.polygon = () => ({ addTo() { return this; }, bindTooltip() {}, on() {} });
L.divIcon = options => options;
L.marker = (point, options) => ({ options, listeners: new Map(),
  addTo(layer) { layer.layers.push(this); return this; },
  on(type, callback) { this.listeners.set(type, callback); return this; },
  setLatLng(value) { this.point = Array.isArray(value) ? { lat: value[0], lng: value[1] } : value; return this; },
  getLatLng() { return this.point; },
  fire(type) { this.listeners.get(type)?.(); },
}).setLatLng(point);
const { createSceneAreaSystem } = await import('../src/scene/areas.js');
const { createSceneAreaHandleSystem } = await import('../src/scene/area-handles.js');
after(() => {
  Object.assign(L, originalLeaflet);
  for (const [key, descriptor] of previousGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
});

const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const rect = (x, y, width, height) => [[x, y], [x + width, y], [x + width, y + height], [x, y + height]];

function fixture({ connected = false, denied = false, legacy = false, staleProjection = false } = {}) {
  const feature = (id, x) => ({ id, name: id, category: 'building', mode: 'clip',
    geometry: { type: 'polygon', points: rect(x, 20, 20, 60) },
    capabilities: { destructible: true, vision: { occluder: true, polygon: rect(x, 20, 20, 60) } } });
  const mapPackage = { id: 'area-map', version: '1', width: 200, height: 200, metersPerUnit: 1,
    features: [feature('house', 40), feature('other', 140)] };
  const area = { id: 'area', name: 'Attack', shape: 'circle', origin: { x: 40, y: 50 },
    anchor: { type: 'free', markerId: null }, radius: 10, color: '#d63d32', opacity: .18,
    visible: true, destructionEnabled: true, severeDamage: false, craterEnabled: false,
    destructionTargets: ['building'] };
  const scene = { id: 'scene', name: 'Scene', mapPackage: { id: mapPackage.id, version: '1' },
    tokens: [], markers: [], attackAreas: [area], sceneEvents: [], featureStates: {}, occlusionShapes: [], settings: {} };
  let state = projectWorldOperationState({ preferences: { worldV2: { schemaVersion: 4, id: 'world', name: 'World',
    ruleset: { id: 'test', version: '1' }, activeSceneId: scene.id, actors: [], statusDefinitions: [], scenes: [scene] } } });
  if (legacy) delete state.preferences.worldV2;
  if (staleProjection) state.attackAreas = [];
  const doc = { createElement: () => new Element(doc), createTextNode: text => ({ textContent: text }),
    addEventListener() {}, removeEventListener() {} };
  const panel = new Element(doc), status = new Element(doc), container = new Element(doc);
  container.closest = () => ({ querySelector: selector => selector === '[data-role="map-status"]' ? status : null });
  const mapListeners = new Map(), listeners = new Map(), emitted = [], pending = [], toasts = [];
  let tool = 'pan', legacyWrites = 0;
  const api = { mapPackage, getState: () => structuredClone(state), uiPanels: { get: () => panel },
    map: { getContainer: () => container, getPane: () => ({ style: {} }),
      on: (name, callback) => mapListeners.set(name, callback), off() {}, removeLayer() {} },
    multiplayer: { getStatus: () => ({ connected }) },
    tokens: { list: () => [], get: () => null },
    getTool: () => tool, setTool: value => { tool = value; }, setActivePanel() {},
    showToast: (...args) => toasts.push(args), setStatus: message => { status.textContent = message; },
    on(name, callback) {
      listeners.set(name, [...(listeners.get(name) || []), callback]);
      return () => listeners.set(name, listeners.get(name).filter(value => value !== callback));
    },
    emit(name, detail) { emitted.push({ name, detail }); for (const callback of listeners.get(name) || []) callback({ detail }); },
    commitState(next) {
      legacyWrites++;
      if (!legacy) throw new Error('World-backed areas cannot use optimistic commitState');
      state = structuredClone(next); api.emit('state:commit', { state }); return true;
    },
  };
  if (!legacy) api.world = { getActiveScene: () => structuredClone(state.preferences.worldV2.scenes.find(item => item.id === state.preferences.worldV2.activeSceneId)),
    performOperations(batch, options) {
      const world = state.preferences.worldV2;
      const values = connected ? documentWritesToWorldOperations(worldOperationsToDocumentWrites(batch,
        { worldId: world.id, sceneId: world.activeSceneId })) : structuredClone(batch);
      return new Promise((resolve, reject) => pending.push({ values, options, resolve, reject }));
    } };
  createSceneAreaSystem().register(api);
  return { api, panel, status, emitted, pending, toasts, mapListeners, state: () => state, legacyWrites: () => legacyWrites,
    change(name, value) { panel.listeners.get('change')({ target: { name, value } }); },
    mutateScene(callback, notify = false) {
      const next = structuredClone(state); callback(next.preferences.worldV2.scenes[0]);
      state = projectWorldOperationState(next);
      if (notify) api.emit('scene:content-change', { types: ['AttackArea'] });
    },
    switchScene() {
      const next = structuredClone(state), world = next.preferences.worldV2;
      world.scenes.push({ ...structuredClone(world.scenes[0]), id: 'scene-b' }); world.activeSceneId = 'scene-b';
      state = projectWorldOperationState(next); api.emit('scene:activate', { sceneId: 'scene-b' });
    },
    enableHandles({ noUpdate = false } = {}) {
      api.sceneAreas.select('area');
      if (noUpdate) api.sceneAreas = Object.freeze({ ...api.sceneAreas, update: undefined });
      createSceneAreaHandleSystem().register(api);
      return api.map.testLayers.at(-2);
    },
    async flush() {
      const item = pending.shift();
      try {
        if (denied) throw Object.assign(new Error('Only the GM can perform scene.content.replace'), { code: 'scene_content_replace_gm_only' });
        const applied = applyWorldOperations(state, item.values, { mapPackage, source: { role: connected ? 'gm' : 'offline' } });
        state = applied.state;
        api.emit('scene:content-change', { types: item.values[0].payload.attackAreas ? ['AttackArea'] : ['SceneEvent'] });
        item.resolve(applied);
      } catch (error) { item.reject(error); }
      await settle();
    },
  };
}

for (const connected of [false, true]) {
  test(`${connected ? 'LAN' : 'offline'} area destruction waits for authority and durable confirmation before reporting success`, async () => {
    const value = fixture({ connected, staleProjection: true });
    const preview = await value.api.sceneAreas.preview('area');
    assert.equal(preview.clipHits.length, 1, 'area reads the canonical Scene despite stale top-level projection');
    const before = structuredClone(value.state());
    const result = value.api.sceneAreas.apply('area');
    assert.equal(value.pending.length, 1);
    const payload = value.pending[0].values[0].payload;
    assert.equal(payload.sceneId, 'scene');
    assert.equal(payload.expectedActiveSceneId, 'scene');
    assert.deepEqual(payload.expectedSceneEvents, []);
    assert.deepEqual(payload.expectedAttackAreas, before.preferences.worldV2.scenes[0].attackAreas);
    assert.deepEqual(value.state(), before);
    assert.equal(value.emitted.filter(event => event.name === 'scene:damage').length, 0);
    await value.flush();
    assert.equal(await result, true);
    assert.equal(value.state().sceneEvents.length, 1);
    assert.equal(value.emitted.filter(event => event.name === 'scene:damage').length, 1);
    assert.equal(value.status.textContent, '场景破坏已应用');
    assert.equal(value.legacyWrites(), 0);
  });

  test(`${connected ? 'LAN' : 'offline'} area editing and placement use guarded authority without optimistic changes`, async () => {
    const value = fixture({ connected });
    value.api.sceneAreas.select('area');
    value.change('radius', '12');
    assert.equal(value.pending.length, 1);
    assert.equal(value.state().attackAreas[0].radius, 10);
    assert.equal(value.api.sceneAreas.list()[0].radius, 10);
    assert.equal(value.pending[0].values[0].payload.expectedAttackAreas[0].radius, 10);
    await value.flush();
    assert.equal(value.state().attackAreas[0].radius, 12);
    assert.equal(value.api.sceneAreas.list()[0].radius, 12);
    await value.api.sceneAreas.beginPlacement('rectangle');
    value.mapListeners.get('click')({ latlng: { lng: 100, lat: 100 } });
    assert.equal(value.state().attackAreas.length, 1);
    assert.equal(value.emitted.filter(event => event.name === 'area:create').length, 0);
    await value.flush();
    assert.equal(value.state().attackAreas.length, 2);
    assert.equal(value.emitted.filter(event => event.name === 'area:create').length, 1);
    assert.equal(value.legacyWrites(), 0);
  });
}

test('denied LAN damage leaves state and preview unchanged without reporting successful destruction', async () => {
  const value = fixture({ connected: true, denied: true });
  await value.api.sceneAreas.preview('area');
  const before = structuredClone(value.state());
  const pending = value.api.sceneAreas.apply('area');
  const rejection = assert.rejects(pending, error => error.code === 'scene_content_replace_gm_only');
  await value.flush(); await rejection;
  assert.deepEqual(value.state(), before);
  assert.equal(value.emitted.filter(event => event.name === 'scene:damage').length, 0);
  assert.match(value.status.textContent, /场景破坏未应用.*Only the GM/);
  assert.equal(value.toasts.at(-1)[1], 'error');
});

test('actual geometry preflight failure rejects range damage atomically and identifies the object', async () => {
  const value = fixture();
  await value.api.sceneAreas.preview('area');
  const before = structuredClone(value.state());
  const original = clipping.difference;
  clipping.difference = () => { throw new Error('Unable to pop() left SweepEvent injected from queue.'); };
  try {
    const pending = value.api.sceneAreas.apply('area');
    const rejection = assert.rejects(pending, error => error.code === 'geometry_clip_failed' && error.featureId === 'house');
    await value.flush(); await rejection;
    assert.deepEqual(value.state(), before);
    assert.equal(value.emitted.filter(event => event.name === 'scene:damage').length, 0);
    assert.match(value.status.textContent, /场景破坏未应用.*house/);
  } finally { clipping.difference = original; }
});

test('queued range damage cannot erase concurrent events or apply after the active Scene changes', async () => {
  for (const kind of ['history', 'scene', 'area']) {
    const value = fixture({ connected: true });
    await value.api.sceneAreas.preview('area');
    const pending = value.api.sceneAreas.apply('area');
    const rejection = assert.rejects(pending, error => error.code === 'scene_content_conflict');
    if (kind === 'scene') value.switchScene();
    else value.mutateScene(scene => {
      if (kind === 'history') scene.sceneEvents.push({ id: 'foreign', type: 'damage', objectIds: ['other'], clipHits: [] });
      else scene.attackAreas[0].radius = 15;
    });
    const before = structuredClone(value.state());
    await value.flush(); await rejection;
    assert.deepEqual(value.state(), before);
    assert.equal(value.emitted.filter(event => event.name === 'scene:damage').length, 0);
    assert.equal(value.toasts.at(-1)[1], 'error');
  }
});

test('concurrent authoritative area editing is preserved and surfaced instead of overwritten', async () => {
  const value = fixture({ connected: true });
  value.api.sceneAreas.select('area'); value.change('radius', '12');
  value.mutateScene(scene => { scene.attackAreas[0].radius = 15; });
  await value.flush();
  assert.equal(value.state().attackAreas[0].radius, 15);
  assert.equal(value.api.sceneAreas.list()[0].radius, 15);
  assert.match(value.status.textContent, /范围未保存.*范围已更新/);
  assert.equal(value.toasts.at(-1)[1], 'error');
});

test('a preview without any affected object does not create a transaction or false success', async () => {
  const value = fixture();
  value.mutateScene(scene => { scene.attackAreas[0].origin = { x: 170, y: 170 }; });
  await value.api.sceneAreas.preview('area');
  assert.equal(await value.api.sceneAreas.apply('area'), false);
  assert.equal(value.pending.length, 0);
  assert.equal(value.emitted.filter(event => event.name === 'scene:damage').length, 0);
});

test('legacy callers without World authority retain the existing Scene area API', async () => {
  const value = fixture({ legacy: true });
  await value.api.sceneAreas.preview('area');
  assert.equal(await value.api.sceneAreas.apply('area'), true);
  assert.equal(value.legacyWrites(), 1);
  assert.equal(value.state().sceneEvents.length, 1);
  value.api.sceneAreas.select('area'); value.change('radius', '12'); await settle();
  assert.equal(value.state().attackAreas[0].radius, 12);
});

for (const connected of [false, true]) {
  for (const noUpdate of [false, true]) {
    test(`${connected ? 'LAN' : 'offline'} handle drag ${noUpdate ? 'direct World fallback' : 'SceneArea update'} waits for ACK and commits only the area collection`, async () => {
      const value = fixture({ connected });
      const layer = value.enableHandles({ noUpdate });
      const marker = layer.layers.find(item => item.options.title === '拖动修改半径');
      marker.fire('dragstart'); marker.setLatLng({ lng: 55, lat: 150 }); marker.fire('dragend');
      assert.equal(value.pending.length, 1);
      assert.equal(value.state().attackAreas[0].radius, 10);
      assert.equal(value.status.textContent, '正在保存范围…');
      const payload = value.pending[0].values[0].payload;
      assert.equal(payload.sceneId, 'scene');
      assert.equal(payload.expectedActiveSceneId, 'scene');
      assert.equal(payload.expectedAttackAreas[0].radius, 10);
      assert.equal(payload.attackAreas[0].radius, 15);
      assert.equal('sceneEvents' in payload, false);
      await value.flush();
      assert.equal(value.state().attackAreas[0].radius, 15);
      assert.equal(value.status.textContent, '范围已更新');
      assert.equal(value.legacyWrites(), 0);
      assert.equal(value.api.map.testLayers.at(-1).layers.length, 0);
      value.api.emit('app:destroy');
    });
  }
}

test('dragging an anchored origin detaches only that area after authority confirms', async () => {
  const value = fixture({ connected: true });
  value.mutateScene(scene => {
    scene.markers.push({ id: 'anchor', x: 65, y: 80 });
    scene.attackAreas[0].anchor = { type: 'marker', markerId: 'anchor' };
    scene.attackAreas.push({ ...structuredClone(scene.attackAreas[0]), id: 'other-area' });
  }, true);
  const layer = value.enableHandles();
  const marker = layer.layers.find(item => item.options.title === '拖动范围起点');
  assert.deepEqual(marker.getLatLng(), { lat: 120, lng: 65 });
  marker.fire('dragstart'); marker.setLatLng({ lng: 90, lat: 105 }); marker.fire('dragend');
  assert.equal(value.state().attackAreas[0].anchor.type, 'marker');
  await value.flush();
  assert.deepEqual(value.state().attackAreas[0].origin, { x: 90, y: 95 });
  assert.deepEqual(value.state().attackAreas[0].anchor, { type: 'free', markerId: null });
  assert.deepEqual(value.state().attackAreas[1].anchor, { type: 'marker', markerId: 'anchor' });
  assert.deepEqual(value.state().markers, [{ id: 'anchor', x: 65, y: 80 }]);
  value.api.emit('app:destroy');
});

test('authoritative AttackArea and Marker changes refresh active controls without unrelated redraws', async () => {
  const value = fixture({ connected: true });
  const layer = value.enableHandles();
  value.mutateScene(scene => { scene.attackAreas[0].radius = 20; });
  value.api.emit('scene:content-change', { sceneId: 'scene', types: ['AttackArea'] });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(layer.layers.find(item => item.options.title === '拖动修改半径').getLatLng().lng, 60);
  const sameMarker = layer.layers[0];
  value.api.emit('scene:content-change', { sceneId: 'other-scene', types: ['AttackArea'] });
  value.api.emit('scene:content-change', { sceneId: 'scene', types: ['SceneEvent'] });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(layer.layers[0], sameMarker, 'inactive scenes and destruction-only changes do not recreate controls');
  value.mutateScene(scene => {
    scene.markers = [{ id: 'anchor', x: 65, y: 80 }];
    scene.attackAreas[0].anchor = { type: 'marker', markerId: 'anchor' };
  });
  value.api.emit('scene:content-change', { sceneId: 'scene', types: ['AttackArea', 'Marker'] });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(layer.layers.find(item => item.options.title === '拖动范围起点').getLatLng(), { lat: 120, lng: 65 });
  value.mutateScene(scene => { scene.markers[0].x = 75; scene.markers[0].y = 90; });
  value.api.emit('scene:content-change', { sceneId: 'scene', types: ['Marker'] });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(layer.layers.find(item => item.options.title === '拖动范围起点').getLatLng(), { lat: 110, lng: 75 });
  value.api.emit('app:destroy');
});

test('handle edits retain their drag-start guard when authority updates before dragend', async () => {
  for (const noUpdate of [false, true]) {
    for (const kind of ['edit', 'delete', 'scene']) {
      const value = fixture({ connected: true });
      const layer = value.enableHandles({ noUpdate });
      const marker = layer.layers.find(item => item.options.title === '拖动修改半径');
      marker.fire('dragstart');
      if (kind === 'scene') value.switchScene();
      else value.mutateScene(scene => {
        if (kind === 'delete') scene.attackAreas = [];
        else scene.attackAreas[0].radius = 20;
      }, true);
      const before = structuredClone(value.state());
      marker.setLatLng({ lng: 55, lat: 150 }); marker.fire('dragend');
      assert.equal(value.pending[0].values[0].payload.expectedAttackAreas[0].radius, 10);
      await value.flush();
      assert.deepEqual(value.state(), before);
      assert.match(value.status.textContent, /范围保存失败/);
      assert.equal(value.toasts.length, 1);
      assert.equal(value.toasts[0][1], 'error');
      assert.equal(value.legacyWrites(), 0);
      assert.equal(value.api.map.testLayers.at(-1).layers.length, 0);
      if (kind === 'edit') {
        assert.equal(value.api.sceneAreas.list()[0].radius, 20);
        assert.equal(layer.layers.find(item => item.options.title === '拖动修改半径').getLatLng().lng, 60);
      }
      value.api.emit('app:destroy');
    }
  }
});

test('denied handle edit clears its preview and reports failure without a success status', async () => {
  const value = fixture({ connected: true, denied: true });
  const layer = value.enableHandles();
  const marker = layer.layers.find(item => item.options.title === '拖动修改半径');
  marker.fire('dragstart'); marker.setLatLng({ lng: 55, lat: 150 }); marker.fire('dragend');
  const before = structuredClone(value.state());
  await value.flush();
  assert.deepEqual(value.state(), before);
  assert.match(value.status.textContent, /范围保存失败.*Only the GM/);
  assert.equal(value.toasts.length, 1);
  assert.equal(value.api.map.testLayers.at(-1).layers.length, 0);
  assert.equal(layer.layers.find(item => item.options.title === '拖动修改半径').getLatLng().lng, 50);
  value.api.emit('app:destroy');
});

test('legacy handles retain detached draft commits only when no modern transaction port exists', async () => {
  const value = fixture({ legacy: true });
  const layer = value.enableHandles({ noUpdate: true });
  const marker = layer.layers.find(item => item.options.title === '拖动范围起点');
  marker.fire('dragstart'); marker.setLatLng({ lng: 90, lat: 105 }); marker.fire('dragend');
  await settle();
  assert.equal(value.legacyWrites(), 1);
  assert.deepEqual(value.state().attackAreas[0].origin, { x: 90, y: 95 });
  assert.equal(value.status.textContent, '范围已更新');
  value.api.emit('app:destroy');
});
