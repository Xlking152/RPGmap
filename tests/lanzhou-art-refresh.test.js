import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createLanzhouMapPackage, lanzhouMapPackage } from '../maps/lanzhou/package.js';
import { inspectMapArchive, rewriteMapArchiveResources } from '../src/packages/map-archive.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = relative => readFile(path.join(root, relative));

test('art refresh preserves the complete shipped gameplay data receipt', async () => {
  const data = JSON.parse(await read('maps/lanzhou/runtime.json'));
  // v3.0.0 / MapPackage 1.1.0 receipt, including capabilities and all spatial metadata.
  assert.equal(createHash('sha256').update(JSON.stringify(data)).digest('hex'),
    '1b9b1325afa4c5ce42967f4fd68c0ab65819894a2d15c12fc9bddc39eb05f49c');
  assert.equal(data.version, '1.1.0');
  assert.equal(data.features.length, 103);
});

test('tree art remains optional and belongs to the original destructible tree groups', () => {
  const textured = createLanzhouMapPackage({ treeCanopyUrl: 'assets/tree-elm-canopy-v2.webp' });
  assert.deepEqual(textured.features, lanzhouMapPackage.features);
  assert.deepEqual(textured.navigation, lanzhouMapPackage.navigation);
  assert.doesNotMatch(lanzhouMapPackage.svg, /<image\b/);
  const expected = textured.features.filter(feature => feature.category === 'vegetation');
  assert.equal(expected.length > 0, true);
  const ownership = [...textured.svg.matchAll(/data-tree-art-for="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(new Set(ownership), new Set(expected.map(feature => feature.id)));
  assert.equal(ownership.length, expected.length);
  for (const feature of expected) {
    const start = textured.svg.indexOf(`id="feature-${feature.id}"`);
    const end = textured.svg.indexOf('<g id="feature-', start + 1);
    const group = textured.svg.slice(start, end < 0 ? undefined : end);
    assert.match(group, /overflow="hidden"/);
    assert.equal((group.match(/data-tree-art-for=/g) || []).length, 1);
  }
  assert.equal(textured.svg, textured.createSvg());
});

test('street material detail restores artwork contrast without global blur or false collision objects', async () => {
  const svg = (await read('maps/lanzhou/runtime.svg')).toString('utf8');
  assert.match(svg, /\.generated-building-art\s*\{[^}]*opacity:\s*\.94/);
  assert.match(svg, /\.generated-landmark-art\s*\{[^}]*opacity:\s*\.98/);
  assert.match(svg, /id="masonry-texture"/);
  assert.match(svg, /id="street-paving"/);
  assert.match(svg, /id="courtyard-gravel"/);
  assert.ok(svg.indexOf('id="layer-parcels"') < svg.indexOf('id="layer-roads"'), 'roads must remain visible above the parcel ground');
  assert.doesNotMatch(svg, /sepia\(|blur\(|opacity:\s*\.48\s*;/);
  assert.equal((svg.match(/data-building-art-for=/g) || []).length, 50);
});

test('independent art package exports a new version and resolves the real tree asset through the package loader', async () => {
  const output = await mkdtemp(path.join(os.tmpdir(), 'rpgmap-art-export-'));
  try {
    execFileSync(process.execPath, ['scripts/export-map-packages.mjs', '--out', output, '--map-version', '1.1.1'], { cwd: root });
    const filename = (await readdir(output)).find(name => name.endsWith('.rpgmap'));
    assert.ok(filename.endsWith('-1.1.1.rpgmap'));
    const archive = inspectMapArchive(await readFile(path.join(output, filename)));
    const runtimeData = JSON.parse(await read('maps/lanzhou/runtime.json'));
    assert.equal(archive.data.version, '1.1.1');
    assert.deepEqual(archive.data.features, runtimeData.features);
    assert.deepEqual(archive.data.navigation, runtimeData.navigation);
    assert.deepEqual(archive.data.liquidBodies, runtimeData.liquidBodies);
    const treePath = 'assets/tree-elm-canopy-v2.webp';
    assert.equal(archive.data.artAssets.treeCanopyUrl, treePath);
    assert.equal(archive.data.artAssets.loessTerrainUrl, 'assets/loess-terrain-v2.webp');
    assert.equal(archive.files.has('assets/loess-terrain.webp'), false, 'the prior texture is preserved in source, not duplicated in the candidate');
    assert.equal([...archive.files.keys()].filter(name => name.endsWith('.webp')).length, 30);
    assert.deepEqual(archive.files.get(treePath), await read(`maps/lanzhou/${treePath}`));
    assert.doesNotMatch(archive.svg, /__RPGMAP_ASSET_/);
    const loaded = rewriteMapArchiveResources(archive, { id: archive.data.id, version: '1.1.1' });
    assert.match(loaded.svg, /1\.1\.1\/files\/assets\/tree-elm-canopy-v2\.webp/);
    assert.equal((loaded.svg.match(/data-building-art-for=/g) || []).length, 50);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});

test('ground materials preserve road widths, feature geometry and optional vector rendering', () => {
  const material = createLanzhouMapPackage({
    streetPavingUrl: 'assets/street-stone-v3.webp',
    courtyardGroundUrl: 'assets/courtyard-ground-v3.webp',
  });
  assert.deepEqual(material.features, lanzhouMapPackage.features);
  assert.deepEqual(material.navigation, lanzhouMapPackage.navigation);
  assert.deepEqual(material.visionOccluders, lanzhouMapPackage.visionOccluders);
  assert.doesNotMatch(lanzhouMapPackage.svg, /<image\b/);
  assert.equal((material.svg.match(/class="parcel-material"/g) || []).length, 8);
  assert.equal((material.svg.match(/<mask id="parcel-surface-/g) || []).length, 8);
  assert.match(material.svg, /\.road\.major \{ stroke-width: 12; \}/);
  assert.match(material.svg, /\.road\.lane \{ stroke-width: 7; \}/);
  assert.match(material.svg, /\.road\.alley \{ stroke-width: 3; \}/);
  assert.doesNotMatch(material.svg.match(/\.wall-crown\s*\{[^}]*\}/)?.[0] || '', /dasharray/);
  assert.doesNotMatch(material.svg.match(/\.courtyard-walls[^}]*\}/)?.[0] || '', /dasharray/);
  assert.equal((material.svg.match(/data-feature-id=/g) || []).length,
    (lanzhouMapPackage.svg.match(/data-feature-id=/g) || []).length);
});

test('second art candidate loads both surface assets without changing authoritative map data', async () => {
  const output = await mkdtemp(path.join(os.tmpdir(), 'rpgmap-art-export-'));
  try {
    execFileSync(process.execPath, ['scripts/export-map-packages.mjs', '--out', output, '--map-version', '1.1.2'], { cwd: root });
    const archive = inspectMapArchive(await readFile(path.join(output, '北宋兰州城-1.1.2.rpgmap')));
    const runtimeData = JSON.parse(await read('maps/lanzhou/runtime.json'));
    const { artAssets, ...exportedData } = archive.data;
    assert.deepEqual(exportedData, { ...runtimeData, version: '1.1.2' });
    assert.equal(archive.fingerprint, '9679e39503f2ae13ba27e726ef10b1d45db860eb545929829cb2586841f87610');
    assert.equal([...archive.files.keys()].filter(name => name.endsWith('.webp')).length, 32);
    for (const [key, filename] of [['streetPavingUrl', 'street-stone-v3.webp'], ['courtyardGroundUrl', 'courtyard-ground-v3.webp']]) {
      const resource = `assets/${filename}`;
      assert.equal(artAssets[key], resource);
      assert.deepEqual(archive.files.get(resource), await read(`maps/lanzhou/${resource}`));
      assert.match(archive.svg, new RegExp(`href="assets/${filename}"`));
    }
    const loaded = rewriteMapArchiveResources(archive, { id: runtimeData.id, version: '1.1.2' });
    assert.match(loaded.svg, /1\.1\.2\/files\/assets\/street-stone-v3\.webp/);
    assert.match(loaded.svg, /1\.1\.2\/files\/assets\/courtyard-ground-v3\.webp/);
    assert.doesNotMatch(loaded.svg, /__RPGMAP_ASSET_/);
  } finally { await rm(output, { recursive: true, force: true }); }
});
