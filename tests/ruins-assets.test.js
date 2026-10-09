import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareMapPackage } from '../src/map-package/contract.js';
import { normalizeRuinsAssets } from '../src/map-package/ruins-assets.js';

test('ruin resources normalize only visual fields and retain ordinary/severe atlas bindings', () => {
  const value = normalizeRuinsAssets({ stone: { normal: ' /maps/stone.webp ', severe: {
    url: '/maps/severe.webp', width: 128, height: 64, columns: 2, rows: 1, column: 1,
    align: { offsetX: 2, scaleX: 1.2 }, occluder: true, blocks: true,
  } } });
  assert.equal(value.stone.normal, '/maps/stone.webp');
  assert.equal(value.stone.severe.column, 1);
  assert.deepEqual(value.stone.severe.align, { offsetX: 2, scaleX: 1.2 });
  assert.equal(value.stone.severe.occluder, undefined);
  assert.equal(value.stone.severe.blocks, undefined);
  assert.ok(Object.isFrozen(value) && Object.isFrozen(value.stone.severe.align));
});

test('legacy maps need no ruin resources and malformed atlas bindings are rejected', () => {
  const map = { id: 'a', version: '1', width: 100, height: 100, layers: ['base'], svg: '<svg></svg>', features: [] };
  assert.doesNotThrow(() => prepareMapPackage(map));
  for (const normal of ['', { url: 'a', columns: 2 }, { url: 'a', width: 10, height: 10, columns: 2, column: 2 },
    { url: 'a', align: { scaleX: 0 } }, { url: 'a', width: Infinity }]) {
    assert.throws(() => prepareMapPackage({ ...map, artAssets: { ruins: { stone: { normal } } } }), /Invalid MapPackage/);
  }
  const prepared = prepareMapPackage({ ...map, artAssets: { rubbleAtlas: { url: 'old' }, ruins: { stone: { normal: 'new' } } } });
  assert.equal(prepared.artAssets.rubbleAtlas.url, 'old');
  assert.equal(prepared.artAssets.ruins.stone.normal, 'new');
});
