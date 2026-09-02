import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { worldToLatLng } from '../src/engine/geometry.js';
import { prepareMapPackage } from '../src/map-package/contract.js';
import { featureAtMapLatLng } from '../src/interaction/map-inspector.js';
import { createMinimalReferencePackage } from '../reference/maps/minimal/package.js';

const movementIndex = await readFile(new URL('../src/movement/index.js', import.meta.url), 'utf8');
const movementController = await readFile(new URL('../src/movement/controller.js', import.meta.url), 'utf8');
const featureInspector = await readFile(new URL('../src/interaction/map-inspector.js', import.meta.url), 'utf8');

test('direct map inspection resolves an inspectable Feature from Leaflet coordinates', () => {
  const mapPackage = prepareMapPackage(createMinimalReferencePackage(), { source: 'test:restored-map-inspection' });
  const feature = featureAtMapLatLng(worldToLatLng({ x: 500, y: 465 }, mapPackage.height), mapPackage);
  assert.equal(feature?.id, 'demo-door');
});

test('map inspector uses Runtime tool state and supports both browse and inspect clicks', () => {
  assert.match(featureInspector, /api\.getTool\?\.\(\)/);
  assert.match(featureInspector, /\['pan', 'inspect'\]\.includes\(tool\)/);
  assert.match(featureInspector, /api\.selectFeature\(feature\.id, \{ switchTab: true \}\)/);
  assert.doesNotMatch(featureInspector, /\[data-tool\]\.active/);
});

test('Movement system activates the RAF document-drag and coalesced-keyboard controller', () => {
  assert.match(movementIndex, /createMovementFastPathSystem\(\)\.register\(api\)/);
  assert.match(movementIndex, /createMovementController\(\{ settings \}\)\.register\(api\)/);
  assert.match(movementController, /documentNode\.addEventListener\('pointermove', pointerMove, true\)/);
  assert.match(movementController, /documentNode\.addEventListener\('pointerup', pointerUp, true\)/);
  assert.match(movementController, /documentNode\.addEventListener\('pointercancel', pointerCancel, true\)/);
  assert.match(movementController, /api\.movement\.planTokenGroupMove/);
  assert.match(movementController, /api\.movementFast\?\.moveTokenTo \|\| api\.movement\.moveTokenTo/);
  assert.match(movementController, /const keyboardQueue = \[\]/);
  assert.match(movementController, /sameDirection\(last, direction\)/);
  assert.match(movementController, /w: \{ x: 0, y: -1 \}/);
  assert.match(movementController, /\[data-actor-sheet\]/);
  assert.match(movementController, /requestAnimationFrame/);
  assert.doesNotMatch(movementController, /setPointerCapture|releasePointerCapture/);
});
