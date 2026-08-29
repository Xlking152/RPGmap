import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { worldToLatLng } from '../src/engine/geometry.js';
import { prepareMapPackage } from '../src/map-package/contract.js';
import { featureAtMapLatLng } from '../src/interaction/map-inspector.js';
import { createMinimalReferencePackage } from '../reference/maps/minimal/package.js';

const movementIndex = await readFile(new URL('../src/movement/index.js', import.meta.url), 'utf8');
const movementController = await readFile(new URL('../src/movement/controller-v3.js', import.meta.url), 'utf8');
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

test('Movement system activates the restored live Token drag controller', () => {
  assert.match(movementIndex, /createMovementControllerV3\(\{ settings \}\)\.register\(api\)/);
  assert.match(movementController, /TokenDragPlan/);
  assert.match(movementController, /calculateWaypointRoute/);
  assert.match(movementController, /addEventListener\('pointermove'/);
  assert.match(movementController, /event\.ctrlKey \|\| event\.metaKey/);
  assert.match(movementController, /settings\.cycle\(direction, \{ source: 'wheel' \}\)/);
  assert.match(movementController, /api\.movement\.planTokenMove\(tokenId, target\)/);
  assert.match(movementController, /api\.movement\.commitTokenMove\(\)/);
});
