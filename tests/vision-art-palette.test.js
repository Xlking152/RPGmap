import test from 'node:test';
import assert from 'node:assert/strict';
import { FOG_PALETTE, createVisionFogSystem } from '../src/vision/system.js';
import { registerRuntimeStateReader } from '../src/engine/state-access.js';

test('fog palette keeps unexplored fully opaque and ordered dark perception levels', () => {
  assert.equal(FOG_PALETTE.unexplored, 'rgb(14,19,23)');
  const alpha = color => Number(color.match(/,([\d.]+)\)$/)?.[1] || 1);
  assert.ok(alpha(FOG_PALETTE.explored) > alpha(FOG_PALETTE.vague));
  assert.ok(alpha(FOG_PALETTE.vague) > .5);
  assert.ok(Object.isFrozen(FOG_PALETTE));
});

test('fog art changes tint only confirmed masks and keep exact circle boundaries', () => {
  const canvases = [], frames = [], handlers = new Map();
  const documentNode = { defaultView: { requestAnimationFrame(fn) { frames.push(fn); return frames.length; }, cancelAnimationFrame() {} },
    createElement() {
      const calls = [];
      const context = new Proxy({ calls }, { get(target, key) {
        if (key in target) return target[key];
        return (...args) => calls.push({ name: key, args, fill: target.fillStyle, blend: target.globalCompositeOperation });
      } });
      const canvas = { style: {}, dataset: {}, setAttribute() {}, remove() {}, getContext: () => context };
      canvases.push(canvas); return canvas;
    } };
  const scene = { id: 's', tokens: [{ id: 't', actorId: 'a', placement: 'map', x: 50, y: 50 }], fog: {
    schemaVersion: 1, cellSizeMeters: 5, exploredByParty: { party: { rows: { 1: [[1, 2]] } } } } };
  const state = { preferences: { worldV2: { activeSceneId: 's', actors: [{ id: 'a', partyId: 'party' }], scenes: [scene] },
    audienceVision: { partyIds: ['party'], source: { tokenId: 't', x: 50, y: 50,
      preciseRangeMeters: 10, vagueRangeMeters: 20, lineOfSightEnabled: false, lighting: 'normal' } } } };
  const pane = { style: {}, append() {} };
  const api = { mapPackage: { id: 'map', width: 100, height: 100, metersPerUnit: 1, features: [] },
    map: { getContainer: () => ({ ownerDocument: documentNode }), getPane: () => pane,
      getSize: () => ({ x: 100, y: 100 }), containerPointToLayerPoint: point => ({ x: point[0], y: point[1] }),
      latLngToContainerPoint: point => ({ x: point.lng, y: 100 - point.lat }), on() {}, off() {} },
    getStateRevision: () => 1,
    multiplayer: { getConnectionState: () => ({ connected: true, session: { role: 'player' } }), getVisionSource: () => 't' },
    on(name, handler) { handlers.set(name, handler); return () => handlers.delete(name); } };
  registerRuntimeStateReader(api, () => state);
  createVisionFogSystem().register(api);
  const exploration = canvases.find(canvas => canvas.dataset.fogLayer === 'exploration-cache').getContext('2d');
  const perception = canvases.find(canvas => canvas.dataset.fogLayer === 'perception').getContext('2d');
  assert.ok(exploration.calls.some(call => call.name === 'fillRect' && call.fill === FOG_PALETTE.unexplored && call.args.join() === '0,0,100,100'));
  assert.ok(exploration.calls.some(call => call.name === 'fillRect' && call.fill === FOG_PALETTE.explored));
  assert.deepEqual(perception.calls.filter(call => call.name === 'arc').map(call => call.args[2]), [20, 20, 10]);
  assert.ok(perception.calls.some(call => call.name === 'fill' && call.fill === FOG_PALETTE.vague && call.blend === 'source-over'));
  assert.equal(perception.calls.filter(call => call.name === 'fill').at(-1).blend, 'destination-out');
  assert.equal(perception.calls.some(call => call.name === 'stroke'), false, 'no outer glow reveals pixels beyond the confirmed mask');
  handlers.get('app:destroy')?.();
});
