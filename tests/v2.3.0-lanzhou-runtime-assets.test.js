import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = relative => readFile(new URL(`../${relative}`, import.meta.url), 'utf8');

test('production Lanzhou package loads generated data and SVG as local runtime assets', async () => {
  const [defaultMap, runtimeDataText, runtimeSvg, generator] = await Promise.all([
    read('src/map-package/default-map.js'),
    read('reference/maps/lanzhou/runtime.json'),
    read('reference/maps/lanzhou/runtime.svg'),
    read('scripts/generate-lanzhou-runtime-svg.mjs'),
  ]);
  const runtimeData = JSON.parse(runtimeDataText);
  assert.equal(runtimeData.id, 'northern-song-lanzhou-1104');
  assert.equal(runtimeData.version, '1.0.5');
  assert.equal(runtimeData.features.length, runtimeData.featureCount);
  assert.equal(runtimeData.features.length, 98);
  assert.equal(Object.hasOwn(runtimeData, 'svg'), false);
  assert.equal(Object.hasOwn(runtimeData, 'artAssets'), false);
  assert.match(defaultMap, /runtime\.json\?url/);
  assert.match(defaultMap, /runtime\.svg\?url/);
  assert.match(defaultMap, /Promise\.all/);
  assert.match(defaultMap, /prepareMapPackage/);
  assert.doesNotMatch(defaultMap, /createLanzhouMapPackage|createLanzhouReferencePackage/);
  assert.match(generator, /createLanzhouMapData/);
  assert.match(generator, /createLanzhouSvg/);
  assert.match(runtimeSvg, /^<svg\b/);
  const placeholders = [...runtimeSvg.matchAll(/__RPGMAP_ASSET_([A-Za-z0-9.]+)__/g)].map(match => match[1]);
  assert.equal(placeholders.length > 50, true);
  assert.equal(new Set(placeholders).size, 28);
});

test('LAN operation broadcasts derive audience change sets from cropped patches', async () => {
  const server = await read('deployment/local-server/server.mjs');
  assert.match(server, /audienceChangeSetFromPatch/);
  assert.match(server, /changeSet:\s*audienceChangeSetFromPatch\(patch, afterProjection, changeSet\)/);
  assert.doesNotMatch(server, /createWorldOperationChangeSet\(beforeProjection, afterProjection\)/);
  assert.match(server, /operation\.type === 'actor\.upsert' \|\| operation\.type === 'actor\.delete'/);
});
