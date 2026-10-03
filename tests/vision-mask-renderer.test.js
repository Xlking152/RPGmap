import test from 'node:test';
import assert from 'node:assert/strict';
import { continuousMaskBounds, createContinuousMaskRenderer } from '../src/vision/mask-renderer.js';

const viewport = { scaleX: 1, project: (x, y) => ({ x: 150.37 + x, y: 100.21 + y }) };

test('blend bounds include antialias padding, align to device pixels and skip offscreen circles', () => {
  for (const dpr of [1, 1.25, 1.5, 2]) {
    const bounds = continuousMaskBounds(viewport, { x: 0, y: 0 }, 20, 400, 300, dpr);
    assert.ok(bounds.x <= 128.37 && bounds.y <= 78.21);
    assert.ok(bounds.x + bounds.width >= 172.37 && bounds.y + bounds.height >= 122.21);
    for (const value of Object.values(bounds)) assert.ok(Math.abs(value * dpr - Math.round(value * dpr)) < 1e-9);
    const outside = continuousMaskBounds(viewport, { x: -1000, y: 0 }, 20, 400, 300, dpr);
    assert.equal(outside.width, 0);
    const full = continuousMaskBounds(viewport, { x: 0, y: 0 }, 1000, 400, 300, dpr);
    assert.deepEqual(full, { x: 0, y: 0, width: 400, height: 300 });
  }
});

function fakeDocument() {
  const canvases = [];
  return { canvases, createElement() {
    const context = { calls: [] };
    for (const name of ['setTransform', 'clearRect', 'beginPath', 'arc', 'save', 'restore', 'clip',
      'fill', 'moveTo', 'lineTo', 'closePath', 'fillRect', 'drawImage']) {
      context[name] = (...args) => context.calls.push({ name, args });
    }
    const canvas = { width: 300, height: 150, getContext: () => context };
    canvases.push(canvas); return canvas;
  } };
}

test('precise and vague masks retain two bounded frames and release their surfaces', () => {
  const document = fakeDocument(), renderer = createContinuousMaskRenderer(document);
  const target = document.createElement('canvas').getContext('2d');
  target.globalCompositeOperation = 'destination-out';
  const input = { geometry: { blocked: false, shadows: [], facades: [], illumination: { mode: 'all', regions: [] } },
    source: { x: 0, y: 0 }, radiusUnits: 20, viewport, width: 400, height: 300, dpr: 1 };
  renderer.draw(target, { ...input, key: 'vague-frame', kind: 'vague' });
  renderer.draw(target, { ...input, key: 'precise-frame', kind: 'precise' });
  renderer.draw(target, { ...input, key: 'vague-frame', kind: 'vague' });
  assert.equal(document.canvases.flatMap(canvas => canvas.getContext('2d').calls).filter(call => call.name === 'arc').length, 2);
  const copies = target.calls.filter(call => call.name === 'drawImage');
  assert.equal(copies.length, 3);
  assert.ok(copies.every(call => call.args.length === 9 && call.args[7] < 50 && call.args[8] < 50));
  const allocated = document.canvases.length;
  for (let index = 0; index < 20; index++) renderer.draw(target, { ...input, key: `precise-${index}`, kind: 'precise' });
  assert.equal(document.canvases.length, allocated);
  renderer.dispose();
  assert.ok(document.canvases.filter(canvas => canvas.getContext('2d') !== target).every(canvas => canvas.width === 0 && canvas.height === 0));
});

test('fractional backing dimensions preserve the full-image edge resampling path', () => {
  const document = fakeDocument(), renderer = createContinuousMaskRenderer(document);
  const target = document.createElement('canvas').getContext('2d');
  target.globalCompositeOperation = 'destination-out';
  renderer.draw(target, { key: 'fractional', kind: 'precise', viewport, source: { x: 0, y: 0 }, radiusUnits: 20,
    width: 401, height: 301, dpr: 1.25,
    geometry: { blocked: false, shadows: [], facades: [], illumination: { mode: 'all', regions: [] } } });
  const copies = target.calls.filter(call => call.name === 'drawImage');
  assert.equal(copies.length, 1);
  assert.deepEqual(copies[0].args.slice(1), [0, 0, 401, 301]);
});

test('fixed lighting union survives observer movement but refreshes for scene or viewport changes', () => {
  const document = fakeDocument(), renderer = createContinuousMaskRenderer(document);
  const target = document.createElement('canvas').getContext('2d');
  target.globalCompositeOperation = 'destination-out';
  const input = { kind: 'precise', viewport, radiusUnits: 20, width: 400, height: 300, dpr: 1,
    geometry: { blocked: false, shadows: [], facades: [], illumination: { mode: 'normal', regions: [
      { x: 10, y: 10, normalRadiusUnits: 30, radiusUnits: 60, shadows: [], blocked: false },
    ] } } };
  for (let frame = 0; frame < 5; frame++) renderer.draw(target, { ...input, key: `frame-${frame}`,
    lightingKey: 'geometry-1:lights-1:viewport-1', source: { x: frame * .5, y: 0 } });
  const lightContext = document.canvases[1].getContext('2d');
  assert.equal(lightContext.calls.filter(call => call.name === 'arc').length, 1);
  renderer.draw(target, { ...input, key: 'light-change', lightingKey: 'geometry-1:lights-2:viewport-1', source: { x: 3, y: 0 } });
  renderer.draw(target, { ...input, key: 'view-change', lightingKey: 'geometry-1:lights-2:viewport-2', source: { x: 3, y: 0 } });
  assert.equal(lightContext.calls.filter(call => call.name === 'arc').length, 3);
  renderer.reset();
  renderer.draw(target, { ...input, key: 'reset', lightingKey: 'geometry-1:lights-2:viewport-2', source: { x: 3, y: 0 } });
  assert.equal(lightContext.calls.filter(call => call.name === 'arc').length, 4);
  renderer.dispose();
});
