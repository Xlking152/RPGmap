import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { interpolateTokenPoint, normalizeTokenPoint, sameTokenPoint, tokenMoveDuration } from '../src/render/token-motion.js';
import { readConnectionState } from '../src/multiplayer/connection-state.js';

// Run the real renderer with a deterministic browser/Leaflet shell. Its normal
// import graph requires a full DOM, which Node's focused animation test lacks.
const rendererSource = readFileSync(new URL('../src/render/token-layer.js', import.meta.url), 'utf8')
  .replace(/^import .*\r?\n/gm, '').replace(/^export /gm, '');

function rendererFixture() {
  const callbacks = new Map();
  let nextFrame = 1;
  let currentTime = 0;
  const element = () => ({
    style: { setProperty() {} }, hidden: false, append() {}, replaceChildren() {},
  });
  const host = element();
  const documentNode = {
    head: element(), body: host,
    getElementById: () => null,
    createElement: () => element(),
    defaultView: {
      performance: { now: () => currentTime },
      matchMedia: () => ({ matches: false }),
      getComputedStyle: () => ({ position: 'relative' }),
      requestAnimationFrame(callback) { const id = nextFrame++; callbacks.set(id, callback); return id; },
      cancelAnimationFrame(id) { callbacks.delete(id); },
    },
  };
  const container = { ownerDocument: documentNode, parentElement: host };
  const panes = new Map();
  const listeners = new Map();
  const token = { id: 'token', actorId: 'actor', actorLink: true, placement: 'map', x: 0, y: 0,
    diameterMeters: 1, elevationMeters: 0, showName: false };
  const actor = { id: 'actor', name: 'Actor' };
  const api = {
    mapPackage: { height: 100, metersPerUnit: 1 },
    map: {
      getContainer: () => container,
      getPane: name => panes.get(name),
      createPane(name) { const pane = element(); panes.set(name, pane); return pane; },
      latLngToContainerPoint: value => ({ x: value.lng, y: value.lat }),
      on() {}, off() {}, removeLayer() {},
    },
    tokens: {
      list: () => [token], get: () => token, getActiveSceneId: () => 'scene',
      resolveActor: () => ({ actor }),
    },
    selection: {
      getSelectedTokenIds: () => [], getPrimaryTokenId: () => null, subscribe: () => () => {},
    },
    status: { getDefinitions: () => [], resolve: () => null },
    multiplayer: { getStatus: () => ({ connected: false }) },
    on(name, callback) {
      const items = listeners.get(name) || [];
      items.push(callback);
      listeners.set(name, items);
      return () => listeners.set(name, items.filter(item => item !== callback));
    },
    emit(name, detail) { for (const callback of listeners.get(name) || []) callback({ detail }); },
  };
  const leaflet = {
    divIcon: options => options,
    layerGroup: () => ({ addTo() { return this; }, removeLayer() {}, clearLayers() {} }),
    marker: (latLng, options) => ({
      latLng, options, addTo() { return this; }, on() { return this; },
      setLatLng(value) { this.latLng = value; return this; },
      setIcon() { return this; }, bindTooltip() { return this; },
      getTooltip: () => null,
    }),
    DomEvent: { stopPropagation() {}, preventDefault() {} },
  };
  const createTokenRendererSystem = new Function('worldToLatLng', 'formatMeters',
    'resolveStatusUiSnapshot', 'renderTokenStatusBadges', 'interpolateTokenPoint',
    'normalizeTokenPoint', 'sameTokenPoint', 'tokenMoveDuration', 'createTokenViewModel', 'L', 'readConnectionState',
    `${rendererSource}\nreturn createTokenRendererSystem;`)(
    (point, height) => ({ lat: height - point.y, lng: point.x }), String,
    () => ({ statuses: [], capabilities: {} }), () => '',
    interpolateTokenPoint, normalizeTokenPoint, sameTokenPoint, tokenMoveDuration,
    ({ token: value }) => ({ ...value, name: 'Actor', avatarDataUrl: null, color: '#336699',
      audienceRestricted: false, audienceVisibility: null, gmViewer: true, invisible: false }),
    leaflet, readConnectionState);
  createTokenRendererSystem().register(api);
  return {
    api, token,
    frame(time) {
      currentTime = time;
      const pending = [...callbacks];
      callbacks.clear();
      for (const [, callback] of pending) callback(time);
    },
    documentMove() {
      api.emit('document:move', { document: { type: 'Token', id: token.id, parent: { id: 'scene' } },
        fields: ['x', 'y'] });
    },
  };
}

test('confirmed route starts immediately and its first RAF advances from the current visual point', () => {
  const fixture = rendererFixture();
  fixture.token.x = 1;
  fixture.documentMove();
  fixture.frame(0);
  fixture.frame(16);
  assert.ok(fixture.api.renderer.getVisualTokenPoint('token').x > 0,
    'the first RAF after route acceptance must move the token');
  fixture.frame(66);
  const beforeReverse = fixture.api.renderer.getVisualTokenPoint('token').x;
  assert.ok(beforeReverse > 0 && beforeReverse < 1);

  fixture.token.x = 0.05;
  fixture.documentMove();
  assert.equal(fixture.api.renderer.getVisualTokenPoint('token').x, beforeReverse);
  fixture.frame(82);  // The first RAF must advance toward the newly confirmed destination.
  assert.ok(fixture.api.renderer.getVisualTokenPoint('token').x < beforeReverse);
  fixture.frame(98);
  fixture.frame(130);
  assert.ok(fixture.api.renderer.getVisualTokenPoint('token').x < beforeReverse,
    'the first new visual movement must head toward the confirmed destination');
  fixture.frame(246);
  assert.equal(fixture.api.renderer.getVisualTokenPoint('token').x, 0.05,
    'the route still completes at the confirmed point after its normal duration');
});
