import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_MAP_ID, createSerializableDefaultMapPackage } from '../scripts/export-maps.mjs';

test('default MapPackage serializes into external maps directory format', () => {
  const mapPackage = createSerializableDefaultMapPackage();

  assert.equal(mapPackage.id, DEFAULT_MAP_ID);
  assert.equal(mapPackage.packageFormat, 'rpgmap-map-v1');
  assert.equal(mapPackage.runtimeSource, 'external-maps-directory');
  assert.equal(typeof mapPackage.createSvg, 'undefined');
  assert.equal(typeof mapPackage.svg, 'string');
  assert.match(mapPackage.svg, /^<svg\b/);
  assert.ok(Array.isArray(mapPackage.features));
  assert.ok(mapPackage.features.length > 0);
  assert.ok(mapPackage.artAssets.yellowRiverUrl.startsWith(`/maps/${DEFAULT_MAP_ID}/assets/`));
  assert.ok(mapPackage.artAssets.rubbleAtlas.url.startsWith(`/maps/${DEFAULT_MAP_ID}/assets/`));

  const encoded = JSON.stringify(mapPackage);
  assert.ok(encoded.includes('external-maps-directory'));
  assert.ok(!encoded.includes('function createSvg'));
});
