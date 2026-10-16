import test from 'node:test';
import assert from 'node:assert/strict';
import lanzhou from '../maps/lanzhou/runtime.json' with { type: 'json' };
import { createMinimalReferencePackage } from '../maps/minimal/package.js';
import { mapForScene } from '../src/server/movement-authority-entry.js';
import { sceneVisionContext, releaseVisionContexts } from '../src/vision/context.js';
import { prepareMapPackage } from '../src/map-package/contract.js';
import { installServerMapFixtures } from './helpers/server-map-fixture.js';
import { readFile } from 'node:fs/promises';

installServerMapFixtures();

function assertFrozenData(value) {
  if (!value || typeof value !== 'object') return;
  assert.ok(Object.isFrozen(value));
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    assert.ok(Object.hasOwn(descriptor, 'value'));
    assertFrozenData(descriptor.value);
  }
}

for (const original of [lanzhou, createMinimalReferencePackage()]) {
  test(`server reuses immutable verified ${original.id} without changing public authoring data`, () => {
    const scene = { id: 'scene', mapPackage: { id: original.id, version: original.version },
      featureStates: {}, sceneEvents: [], occlusionShapes: [], tokens: [] };
    const owned = mapForScene(scene);
    assert.notEqual(owned, original);
    const normalized = prepareMapPackage({ ...original, svg: owned.svg });
    assert.deepEqual(owned.features, normalized.features);
    assert.deepEqual(owned.navigation, original.navigation);
    assert.equal(owned.width, original.width);
    assert.equal(owned.height, original.height);
    assert.match(owned.fingerprint, /^[0-9a-f]{64}$/);
    assertFrozenData(owned);
    assert.notEqual(owned.features, original.features);
    assert.notEqual(owned.features[0].geometry.points[0], original.features[0].geometry.points[0]);
    assert.throws(() => { owned.features[0].geometry.points[0][0] += 1; }, TypeError);
    if (original.createSvg) assert.equal(owned.createSvg(), original.createSvg());
    assert.equal(mapForScene({ mapPackage: { id: original.id, version: 'invalid' } }), null);

    const originalPoint = original.features[0].geometry.points[0];
    const x = originalPoint[0];
    try {
      originalPoint[0] = x + 7;
      assert.equal(owned.features[0].geometry.points[0][0], x,
        'public imported data cannot alter the server geometry');
    } finally { originalPoint[0] = x; }

    const stringify = JSON.stringify;
    let signatures = 0;
    JSON.stringify = function (value, ...options) {
      if (Array.isArray(value) && value[0] === owned.features) signatures++;
      return stringify.call(this, value, ...options);
    };
    try {
      const initial = sceneVisionContext(owned, scene);
      for (let i = 0; i < 12; i++) {
        scene.tokens = [{ id: 'source', placement: 'map', x: 25 + i, y: 20 }];
        assert.equal(sceneVisionContext(owned, scene).occluders, initial.occluders);
      }
      scene.featureStates[owned.features[0].id] = { vision: { occluder: true, blockingHeightMeters: 2 } };
      const height = sceneVisionContext(owned, scene);
      assert.notEqual(height.geometryVersion, initial.geometryVersion);
      assert.ok(height.occluders.some(item => item.id === owned.features[0].id && item.blockingHeightMeters === 2));
      scene.featureStates[owned.features[0].id].vision.occluder = false;
      assert.ok(!sceneVisionContext(owned, scene).occluders.some(item => item.id === owned.features[0].id));
      scene.occlusionShapes = [{ id: 'custom', kind: 'wall', points: [[5, 5], [8, 5], [8, 15], [5, 15]] }];
      const custom = sceneVisionContext(owned, scene);
      scene.occlusionShapes[0].enabled = false;
      const disabled = sceneVisionContext(owned, scene);
      assert.notEqual(disabled.geometryVersion, custom.geometryVersion);
      assert.ok(!disabled.occluders.some(item => item.id === 'custom'));
      assert.equal(signatures, 1, 'fixed map signature is shared while Scene geometry is rechecked');
      releaseVisionContexts(owned);
      assert.equal(sceneVisionContext(owned, scene).cacheHit, false);
      assert.equal(signatures, 2, 'release clears the static signature');
    } finally { JSON.stringify = stringify; releaseVisionContexts(owned); }
  });
}

test('server authority imports no bundled map and rejects mismatched installed versions', async () => {
  const source = await readFile(new URL('../src/server/movement-authority-entry.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /reference\/maps|createMinimalReferencePackage|runtime\.json|BUILT_IN_LANZHOU_MAP/);
  assert.match(source, /setServerMapResolver/);
  assert.equal(mapForScene({ mapPackage: { id: 'not-installed', version: '1.0.0' } }), null);
  assert.equal(mapForScene({ mapPackage: { id: lanzhou.id, version: '9.9.9' } }), null);
});
