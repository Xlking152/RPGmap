import test from 'node:test';
import assert from 'node:assert/strict';
import { createMapGridRenderer } from '../src/render/map-grid.js';

function fixture() {
  const state = { west: 10, east: 40, north: 20, south: 5, spacing: 10, clears: 0, fail: false, lines: [] };
  const mapPackage = { width: 50, height: 40 };
  const map = { getBounds: () => ({ getWest: () => state.west, getEast: () => state.east,
    getNorth: () => state.north, getSouth: () => state.south }) };
  const layer = { clearLayers() { state.clears++; state.lines = []; } };
  const leaflet = { polyline(points, options) { return { addTo(target) {
    assert.equal(target, layer); if (state.fail) throw new Error('drawing failed');
    state.lines.push({ points, options });
  } }; } };
  return { state, mapPackage, render: createMapGridRenderer({ map, mapPackage, layer, leaflet, getSpacing: () => state.spacing }) };
}

test('World/Fog updates retain grid nodes while pan, zoom spacing and map metrics rebuild exact coordinates', () => {
  const { state, mapPackage, render } = fixture();
  assert.equal(render(), true); assert.equal(state.lines.length, 8);
  assert.deepEqual(state.lines[0].points, [{ lat: 20, lng: 10 }, { lat: 5, lng: 10 }]);
  assert.deepEqual(state.lines.at(-1).points, [{ lat: 0, lng: 10 }, { lat: 0, lng: 40 }]);
  const original = state.lines;
  for (let revision = 0; revision < 100; revision++) assert.equal(render(), false);
  assert.equal(state.lines, original); assert.equal(state.clears, 1);
  state.west = 15; state.east = 45; assert.equal(render(), true);
  assert.deepEqual(state.lines.at(-1).points, [{ lat: 0, lng: 15 }, { lat: 0, lng: 45 }]);
  state.spacing = 5; assert.equal(render(), true); assert.equal(state.lines.length, 13);
  mapPackage.height = 100; assert.equal(render(), true);
  assert.deepEqual(state.lines[0].points, [{ lat: 20, lng: 15 }, { lat: 5, lng: 15 }]);
  assert.equal(render(), false);
});

test('failed grid replacement cannot leave an earlier viewport falsely cached', () => {
  const { state, render } = fixture(); render();
  state.west = 15; state.fail = true; assert.throws(render, /drawing failed/);
  state.west = 10; state.fail = false;
  assert.equal(render(), true); assert.equal(state.lines.length, 8); assert.equal(state.clears, 3);
});
