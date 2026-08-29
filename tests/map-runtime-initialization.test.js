import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  canProjectMapCoordinates,
  positionFeatureControls,
} from '../src/interaction/control-layer.js';

const runtimeSource = readFileSync(new URL('../src/engine/runtime.js', import.meta.url), 'utf8');
const controlLayerSource = readFileSync(new URL('../src/interaction/control-layer.js', import.meta.url), 'utf8');
const browserSmokeSource = readFileSync(new URL('../scripts/browser-smoke.mjs', import.meta.url), 'utf8');

function controlFixture() {
  const button = { style: {} };
  const controls = new Map([['gate', {
    descriptor: { anchor: [10, 20] },
    button,
  }]]);
  return { button, controls };
}

test('Feature controls do not project coordinates before the Leaflet map is ready', () => {
  let projectionCalls = 0;
  const map = {
    getCenter() { throw new Error('Set map center and zoom first.'); },
    getZoom() { return undefined; },
    latLngToContainerPoint() { projectionCalls += 1; return { x: 1, y: 2 }; },
  };
  const { button, controls } = controlFixture();

  assert.equal(canProjectMapCoordinates(map), false);
  assert.equal(positionFeatureControls(map, controls, 100), false);
  assert.equal(projectionCalls, 0);
  assert.equal(button.style.left, undefined);
  assert.equal(button.style.top, undefined);
});

test('Feature controls project coordinates after the Leaflet map is ready', () => {
  let projectionCalls = 0;
  const map = {
    getCenter() { return { lat: 0, lng: 0 }; },
    getZoom() { return 1.5; },
    latLngToContainerPoint() { projectionCalls += 1; return { x: 12.4, y: 18.6 }; },
  };
  const { button, controls } = controlFixture();

  assert.equal(canProjectMapCoordinates(map), true);
  assert.equal(positionFeatureControls(map, controls, 100), true);
  assert.equal(projectionCalls, 1);
  assert.equal(button.style.left, '12px');
  assert.equal(button.style.top, '19px');
});

test('Runtime establishes the initial Leaflet view before registering tools', () => {
  const viewIndex = runtimeSource.lastIndexOf('fitInitialView(false);');
  const toolIndex = runtimeSource.lastIndexOf('for (const tool of tools)');
  assert.ok(viewIndex >= 0, 'runtime must establish an initial view');
  assert.ok(toolIndex >= 0, 'runtime must register tools');
  assert.ok(viewIndex < toolIndex, 'initial view must be established before tool registration');
  assert.match(controlLayerSource, /api\.map\.whenReady\?\.\(positionControls\)/);
});

test('Packaged browser smoke requires a rendered ready Lanzhou map', () => {
  assert.match(browserSmokeSource, /Runtime\.consoleAPICalled/);
  assert.match(browserSmokeSource, /mapReady/);
  assert.match(browserSmokeSource, /leaflet-base-pane svg\.leaflet-image-layer/);
  assert.match(browserSmokeSource, /baseSvgWidth > 0/);
  assert.match(browserSmokeSource, /mapImages > 0/);
});
