import test, { after } from 'node:test';
import assert from 'node:assert/strict';

class Element {
  constructor() { this.style = {}; this.dataset = {}; this.children = []; this.listeners = new Map();
    this.classList = { add() {}, remove() {} }; }
  append(...children) { this.children.push(...children); }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  removeEventListener(name) { this.listeners.delete(name); }
  getBoundingClientRect() { return { left: 0, top: 0 }; }
}
const bootstrapDocument = { documentElement: { style: {} }, createElement: () => new Element() };
const originalGlobals = new Map(['window', 'document', 'navigator'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
const bootstrapWindow = { document: bootstrapDocument, navigator: { userAgent: 'Node', platform: 'Win32' },
  screen: { deviceXDPI: 1, logicalXDPI: 1 }, devicePixelRatio: 1 };
for (const [key, value] of Object.entries({ window: bootstrapWindow, document: bootstrapDocument, navigator: bootstrapWindow.navigator }))
  Object.defineProperty(globalThis, key, { configurable: true, value });
const L = (await import('leaflet')).default;
const originalLeaflet = { layerGroup: L.layerGroup, polyline: L.polyline, circleMarker: L.circleMarker, tooltip: L.tooltip };
L.layerGroup = () => ({ layers: [], addTo(map) { map.layers.push(this); return this; }, clearLayers() { this.layers = []; } });
const visual = () => ({ addTo(layer) { layer.layers.push(this); return this; }, setLatLng() { return this; }, setContent() { return this; } });
L.polyline = L.circleMarker = L.tooltip = visual;
const { createMovementController } = await import('../src/movement/controller.js');
after(() => {
  Object.assign(L, originalLeaflet);
  for (const [key, descriptor] of originalGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
  }
});

function fixture() {
  const doc = new Element(), container = new Element(), timers = new Map(), handlers = new Map();
  let sequence = 0, pending = false, tool = 'pan';
  const window = { setTimeout(fn) { const id = ++sequence; timers.set(id, fn); return id; }, clearTimeout(id) { timers.delete(id); },
    requestAnimationFrame(fn) { const id = ++sequence; timers.set(id, fn); return id; }, cancelAnimationFrame(id) { timers.delete(id); },
    addEventListener() {}, removeEventListener() {} };
  Object.assign(doc, { defaultView: window, head: new Element(), activeElement: null,
    createElement: () => new Element(), getElementById: () => null });
  container.ownerDocument = doc;
  let dragging = true;
  const token = { id: 'token', placement: 'map', x: 10, y: 10 };
  const commands = [], validations = [], statuses = [];
  const api = { mapPackage: { id: 'map', version: '1', width: 100, height: 100 },
    world: { isSceneTransitionPending: () => pending },
    map: { layers: [], getContainer: () => container, getPane: () => ({ style: {} }),
      containerPointToLatLng: point => ({ lng: point[0], lat: point[1] }), removeLayer() {},
      dragging: { enabled: () => dragging, disable: () => { dragging = false; }, enable: () => { dragging = true; } } },
    tokens: { get: () => token }, selection: { getSelectedTokenIds: () => [token.id], getPrimaryTokenId: () => token.id,
      replace() {}, subscribe: () => () => {} },
    movement: { canonicalSceneTokens: true, cancelPending() {}, inspectMovementAccess: () => ({ valid: true }) },
    movementFast: { moveTokenPath(...args) { return new Promise((resolve, reject) => commands.push({ args, resolve, reject })); },
      validateTokenMove(...args) { return new Promise(resolve => validations.push({ args, resolve })); } },
    getTool: () => tool, setTool: value => { tool = value; }, setStatus: message => statuses.push(message),
    on(name, callback) { const list = handlers.get(name) || []; list.push(callback); handlers.set(name, list);
      return () => handlers.set(name, list.filter(fn => fn !== callback)); },
    emit(name, detail) { if (name.endsWith('-starting')) pending = true; if (name.endsWith('-failed') || name.endsWith('-complete')) pending = false;
      for (const callback of handlers.get(name) || []) callback({ detail }); },
  };
  createMovementController({ settings: { step: 1, beginSession() {}, subscribe: () => () => {} } }).register(api);
  return { api, doc, timers, commands, validations, statuses,
    key(key) { doc.listeners.get('keydown')({ key, target: { closest: () => null }, preventDefault() {}, stopImmediatePropagation() {} }); },
    flush() { const scheduled = [...timers]; timers.clear(); for (const [, fn] of scheduled) fn(); } };
}

test('switching cancels a deferred plan, clears previews and never dereferences a removed interaction', async () => {
  const value = fixture();
  assert.equal(value.api.movementUi.begin('token'), true);
  assert.ok(value.api.map.layers.some(layer => layer.layers.length));
  const planned = value.api.movementUi.plan('token', { x: 20, y: 10 });
  value.api.emit('scene:switch-starting', { sceneId: 'b' });
  assert.equal(value.api.movementUi.getState().phase, 'idle');
  assert.ok(value.api.map.layers.every(layer => layer.layers.length === 0));
  assert.equal(value.api.movementUi.begin('token'), false);
  value.validations[0].resolve({ valid: true });
  assert.equal(await planned, null);
  assert.ok(value.api.map.layers.every(layer => layer.layers.length === 0));
  value.api.emit('scene:switch-complete', { sceneId: 'b' });
  assert.equal(value.api.movementUi.begin('token'), true);
  value.api.emit('app:destroy');
});

test('WASD cancellation removes queued work and ignores the pending old-scene ACK', async () => {
  const value = fixture();
  value.key('d'); value.flush();
  assert.equal(value.commands.length, 1);
  value.key('s');
  value.api.emit('scene:reset-starting', { sceneId: 'a' });
  const before = value.statuses.length;
  value.commands[0].resolve({ valid: true, distance: 1 });
  for (let index = 0; index < 5; index++) await Promise.resolve();
  value.flush();
  assert.equal(value.commands.length, 1);
  assert.equal(value.statuses.length, before, 'a late ACK cannot overwrite the new Scene status');
  value.key('w'); value.flush();
  assert.equal(value.commands.length, 1, 'input remains blocked until reset finishes');
  value.api.emit('scene:reset-failed', { sceneId: 'a' });
  value.key('w'); value.flush();
  assert.equal(value.commands.length, 2);
  value.api.emit('app:destroy');
  value.commands[1].resolve({ valid: true, distance: 1 });
});

test('the new Scene keyboard lane can operate while the cancelled Scene still awaits its ACK', async () => {
  const value = fixture();
  value.key('d'); value.flush();
  value.api.emit('scene:switch-starting', { sceneId: 'b' });
  value.api.emit('scene:switch-complete', { sceneId: 'b' });
  value.key('w'); value.flush();
  assert.equal(value.commands.length, 2, 'cancelled input does not hold the new Scene queue');
  value.commands[0].resolve({ valid: true, distance: 1 });
  for (let index = 0; index < 5; index++) await Promise.resolve();
  value.key('s'); value.flush();
  assert.equal(value.commands.length, 2, 'the cancelled callback cannot unlock the new in-flight lane');
  value.commands[1].resolve({ valid: true, distance: 1 });
  for (let index = 0; index < 5; index++) await Promise.resolve();
  value.flush();
  assert.equal(value.commands.length, 3);
  value.api.emit('app:destroy'); value.commands[2].resolve({ valid: true, distance: 1 });
});
