import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  MAP_PACKAGE_API_VERSION,
  MAP_PACKAGE_FORMAT,
  mapPackageCapabilities,
  prepareMapPackage,
} from '../src/map-package/contract.js';
import {
  commitDamageEvent,
  createDamagePreview,
  createInitialState,
  deriveSceneState,
} from '../src/engine/state.js';
import { createLanzhouMapPackage } from '../reference/maps/lanzhou/package.js';
import { cleanMapPackagePresentation } from '../reference/maps/lanzhou/presentation.js';
import { LANZHOU_LAYER_PLAN } from '../reference/maps/lanzhou/manifest.js';
import { createMinimalReferencePackage } from '../reference/maps/minimal/package.js';
import { registerBuiltInMapPackages } from '../src/map-package/builtins.js';
import { BUILT_IN_LANZHOU_MAP } from '../src/map-package/constants.js';
import { MapPackageRegistry } from '../src/map-package/registry.js';

function logicalRoles(mapPackage) {
  return new Set(mapPackage.layerPlan.map((layer) => layer.role));
}

test('Lanzhou is normalized through the generic MapPackage contract', () => {
  const mapPackage = prepareMapPackage(cleanMapPackagePresentation({
    ...createLanzhouMapPackage(),
    layerPlan: LANZHOU_LAYER_PLAN,
  }), { source: 'reference/maps/lanzhou:test' });

  assert.equal(mapPackage.packageFormat, MAP_PACKAGE_FORMAT);
  assert.equal(mapPackage.mapPackageApiVersion, MAP_PACKAGE_API_VERSION);
  assert.equal(mapPackage.id, 'northern-song-lanzhou-1104');
  assert.equal(mapPackage.width, 6000);
  assert.equal(mapPackage.height, 5000);
  assert.deepEqual(
    logicalRoles(mapPackage),
    new Set(['base', 'terrain', 'liquid', 'special', 'destructible', 'labels']),
  );

  const capabilities = mapPackageCapabilities(mapPackage);
  assert.equal(capabilities.featureCount, mapPackage.features.length);
  assert.ok(capabilities.destructibleCount > 0);
  assert.ok(capabilities.enterableCount > 0);
  assert.ok(mapPackage.features.every((feature) => typeof feature.capabilities?.interactive === 'boolean'));
});

test('minimal reference map uses the same Core destruction and Scene State logic', () => {
  const mapPackage = prepareMapPackage(createMinimalReferencePackage(), {
    source: 'reference/maps/minimal:test',
  });
  const house = mapPackage.features.find((feature) => feature.id === 'demo-house');
  assert.ok(house);
  assert.equal(house.capabilities.destructible, true);
  assert.equal(house.capabilities.enterable, true);

  const area = {
    id: 'destroy-demo-house',
    type: 'circle',
    center: { x: house.center[0], y: house.center[1] },
    radius: 600,
  };
  const preview = createDamagePreview(area, [house], ['building']);
  assert.deepEqual(preview.objectIds, ['demo-house']);

  let state = createInitialState(mapPackage);
  state = commitDamageEvent(state, area, preview);
  const scene = deriveSceneState(state.sceneEvents);
  assert.ok(scene.destroyedObjectIds.includes('demo-house'));
});

test('application entry resolves MapPackages through the registry without implementation coupling', async () => {
  const mainSource = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
  const mapRuntimeSource = await readFile(new URL('../src/runtime/map-runtime.js', import.meta.url), 'utf8');
  const compatibilityShim = await readFile(new URL('../src/maps/lanzhou.js', import.meta.url), 'utf8');

  assert.match(mainSource, /registerBuiltInMapPackages/);
  assert.match(mainSource, /await import\('\.\/runtime\/map-runtime\.js'\)/);
  assert.match(mapRuntimeSource, /mapPackageRegistry\.load/);
  assert.doesNotMatch(mainSource, /createDefaultMapPackage/);
  assert.doesNotMatch(mainSource, /Lanzhou|lanzhou|assets\/generated/);
  assert.match(compatibilityShim, /reference\/maps\/lanzhou\/package\.js/);
});

test('built-in Registry lists Lanzhou metadata before loading its Runtime package', () => {
  const registry = registerBuiltInMapPackages(new MapPackageRegistry());
  assert.deepEqual(registry.list(), [{
    ...BUILT_IN_LANZHOU_MAP,
    source: 'reference/maps/lanzhou',
    loaded: false,
  }]);
});

test('invalid maps are rejected before they enter the Engine', () => {
  assert.throws(
    () => prepareMapPackage({ id: 'broken', version: '1', width: 100, height: 100, layers: ['base'] }),
    /createSvg\(\) or svg markup is required/,
  );
});
