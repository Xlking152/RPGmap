import test from 'node:test';
import assert from 'node:assert/strict';

import { createMinimalReferencePackage } from '../reference/maps/minimal/package.js';
import { MapPackageRegistry } from '../src/map-package/registry.js';

test('MapPackage Registry lazy-loads and caches a registered package', async () => {
  const sample = createMinimalReferencePackage();
  const registry = new MapPackageRegistry();
  let loads = 0;
  registry.registerLoader({
    id: sample.id,
    title: sample.title,
    load: async () => { loads += 1; return sample; },
  });

  assert.equal(registry.list()[0].loaded, false);
  const first = await registry.load({ id: sample.id });
  const second = await registry.load({ id: sample.id });
  assert.equal(first.id, sample.id);
  assert.equal(second, first);
  assert.equal(loads, 1);
  assert.equal(registry.list()[0].loaded, true);
});

test('MapPackage Registry rejects unknown ids and incompatible versions', async () => {
  const sample = createMinimalReferencePackage();
  const registry = new MapPackageRegistry();
  registry.registerPackage(sample);
  await assert.rejects(registry.load({ id: 'missing-map' }), error => error.code === 'map_package_not_found');
  await assert.rejects(
    registry.load({ id: sample.id, version: '__wrong_version__' }),
    error => error.code === 'map_package_version_mismatch',
  );
});
