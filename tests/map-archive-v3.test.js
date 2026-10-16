import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildMapArchive, inspectMapArchive, readMapArchiveFiles, writeMapArchiveFiles, validateMapArchivePath } from '../src/packages/map-archive.js';
import { createMinimalReferencePackage } from '../maps/minimal/package.js';
import { MapPackageStore } from '../deployment/local-server/package-store.mjs';
import { MapPackageRegistry } from '../src/map-package/registry.js';

const sample = changes => ({ ...createMinimalReferencePackage(), ...changes });
const archive = changes => buildMapArchive({ data: sample(changes) });
function modifiedManifest(bytes, modify) {
  const files = readMapArchiveFiles(bytes), manifest = JSON.parse(files.get('manifest.json'));
  modify(manifest); files.set('manifest.json', Buffer.from(JSON.stringify(manifest)));
  return writeMapArchiveFiles(files);
}

test('map archive round-trips real geometry, physical properties and static SVG with Store and Deflate', () => {
  const bytes = archive(), inspected = inspectMapArchive(bytes);
  assert.equal(inspected.manifest.formatVersion, 1);
  assert.equal(inspected.manifest.mapPackageApiVersion, 1);
  assert.equal(inspected.data.features[1].interaction.initialState.open, false);
  assert.deepEqual(inspected.data.features[0].capabilities.navigation, sample().features[0].capabilities.navigation);
  assert.equal(inspected.data.features[2].mode, 'clip');
  assert.equal(Object.hasOwn(inspected.data, 'createSvg'), false);
  assert.equal(Object.hasOwn(inspected.data, 'svg'), false);
  assert.match(inspected.svg, /data-feature-id="demo-house"/);
  assert.deepEqual(inspectMapArchive(writeMapArchiveFiles(inspected.files, { compress: false })).data, inspected.data);
  assert.equal(inspectMapArchive(archive()).fingerprint, inspected.fingerprint);
});

test('archive rejects corrupt ZIP content, mismatched hashes, absent entries and incompatible format', () => {
  const bytes = archive(), files = readMapArchiveFiles(bytes);
  files.set('map.svg', Buffer.from(sample().svg.replace('#eee5cf', '#000000')));
  assert.throws(() => inspectMapArchive(writeMapArchiveFiles(files)), error => error.code === 'map_archive_corrupt');
  files.delete('map.svg');
  assert.throws(() => inspectMapArchive(writeMapArchiveFiles(files)), error => error.code === 'map_archive_resource_missing');
  assert.throws(() => inspectMapArchive(modifiedManifest(bytes, manifest => { manifest.formatVersion = 99; })), error => error.code === 'map_archive_incompatible');
  const corrupted = Buffer.from(bytes);
  corrupted[corrupted.readUInt16LE(26) + 30 + 3] ^= 0xff;
  assert.throws(() => inspectMapArchive(corrupted), /ZIP (integrity|decompression)/);
  assert.throws(() => inspectMapArchive(bytes.subarray(0, bytes.length - 1)), /end record/);
});

test('ZIP paths reject traversal, Windows aliases, reserved names, scripts and case duplicates', () => {
  for (const entry of ['../wall.png', '/wall.png', 'assets\\wall.png', 'assets/../wall.png', 'assets/a:stream.png', 'assets/CON.png', 'assets/wall.png.', 'assets/wall.png ', 'assets/%2e%2e/wall.png']) {
    assert.throws(() => validateMapArchivePath(entry), error => error.code === 'map_archive_path_invalid');
  }
  assert.throws(() => readMapArchiveFiles(writeMapArchiveFiles(new Map([['assets/map.js', Buffer.from('alert(1)')]]))), error => error.code === 'map_archive_file_unsupported');
  assert.throws(() => readMapArchiveFiles(writeMapArchiveFiles(new Map([['map.svg', Buffer.from('a')], ['MAP.SVG', Buffer.from('b')]]))), error => error.code === 'map_archive_duplicate_path');
});

test('map validation rejects absent resources, malformed geometry, invalid host bindings and game state', () => {
  assert.throws(() => buildMapArchive({ data: sample(), svg: sample().svg.replace('</svg>', '<image href="assets/missing.webp"/></svg>') }), error => error.code === 'map_archive_resource_missing');
  assert.throws(() => archive({ artAssets: { ruins: { stone: { normal: 'assets/missing.webp' } } } }), /missing ruin style|Missing package resource/);
  const duplicate = sample(); duplicate.features = [...duplicate.features, duplicate.features[0]];
  assert.throws(() => buildMapArchive({ data: duplicate }), /feature IDs must be unique/);
  const broken = structuredClone(inspectMapArchive(archive()).data);
  broken.features[0].geometry.points = [[0, 0], [1, 1], [2, 2]];
  assert.throws(() => buildMapArchive({ data: broken, svg: sample().svg }), error => error.code === 'map_archive_geometry_invalid');
  broken.features[0].geometry.points = [[0, 0], [4, 3], [0, 4], [2, 0]];
  assert.throws(() => buildMapArchive({ data: broken, svg: sample().svg }), /self-intersecting/);
  broken.features[0].geometry.points = [[0, 0], [1, 0], [1, 1]];
  broken.features[0].hostFeatureId = 'unknown';
  assert.throws(() => buildMapArchive({ data: broken, svg: sample().svg }), error => error.code === 'map_archive_reference_invalid');
  assert.throws(() => archive({ sceneEvents: [] }), /cannot contain sceneEvents/);
});

test('map SVG cannot execute scripts, embed HTML, request external content or conceal URLs', () => {
  for (const fragment of ['<script>alert(1)</script>', '<foreignObject><p>HTML</p></foreignObject>', '<g onclick="alert(1)"/>',
    '<image href="data:image/svg+xml;base64,abcd"/>', '<image href="//example.com/a.png"/>', '<image href="javascript&#58;alert(1)"/>',
    '<style>@import "evil";</style>', '<style>g{fill:u\\72l(assets/x.png)}</style>', '<animate attributeName="href" to="evil"/>',
    '<image href=assets/x.png/>']) {
    assert.throws(() => buildMapArchive({ data: sample(), svg: sample().svg.replace('</svg>', `${fragment}</svg>`) }), error => error.code?.startsWith('map_archive_'));
  }
});

test('static SVG namespace aliases cannot conceal external hrefs, escaped CSS or executable elements', () => {
  for (const svg of [
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:q="http://www.w3.org/1999/xlink"><image q:href="//example.com/image.svg"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><image q:href="//example.com/image.svg"/></svg>',
    String.raw`<svg xmlns="http://www.w3.org/2000/svg" xmlns:s="http://www.w3.org/2000/svg"><s:style>@\69mport '\2f\2fexample.com/x.css';</s:style></svg>`,
    '<svg xmlns="http://www.w3.org/2000/svg"><s:script>alert(1)</s:script></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><image xmlns:xlink="http://example.com/other" xlink:href="#image"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><g xmlns="http://www.w3.org/1999/xhtml"><script>alert(1)</script></g></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><discard begin="1s"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><image href="#one" HREF="//example.com/image.svg"/></svg>',
  ]) {
    assert.throws(() => buildMapArchive({ data: sample(), svg }), error => error.code === 'map_archive_svg_unsafe');
  }
});

test('canonical xlink resources and CSS URLs use the same validation and rewrite profile without changing feature IDs', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rpgmap-svg-xlink-'));
  try {
    const data = sample(), svg = data.svg.replace('<svg ', '<svg xmlns:xlink="http://www.w3.org/1999/xlink" ')
      .replace('</svg>', '<image xlink:href="assets/rubble.webp"/><image HREF="assets/rubble.webp"/><g style="fill:URL(assets/rubble.webp)"/></svg>');
    const bytes = buildMapArchive({ data, svg, assets: { 'assets/rubble.webp': Buffer.from('rubble image') } });
    const inspected = inspectMapArchive(bytes), store = await new MapPackageStore({ root }).initialize();
    assert.deepEqual(inspected.data.features.map(feature => feature.id), data.features.map(feature => feature.id));
    const receipt = await store.install(bytes), installed = store.get(receipt);
    const url = `/api/packages/maps/${receipt.id}/${receipt.version}/files/assets/rubble.webp`;
    assert.ok(installed.svg.includes(`xlink:href="${url}"`));
    assert.ok(installed.svg.includes(`HREF="${url}"`));
    assert.ok(installed.svg.includes(`fill:url(${url})`));
    assert.match(installed.svg, /data-feature-id="demo-house"/);
    assert.deepEqual(inspectMapArchive(bytes).data.features, inspected.data.features);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('installed map assets and authoritative data persist independently and are deeply immutable', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rpgmap-store-'));
  try {
    const data = sample({ artAssets: { rubbleAtlas: { url: 'assets/rubble.webp', width: 10, height: 10 } } });
    const svg = data.svg.replace('</svg>', '<image href="assets/rubble.webp"/></svg>');
    const bytes = buildMapArchive({ data, svg, assets: { 'assets/rubble.webp': Buffer.from('image bytes') } });
    const store = new MapPackageStore({ root }); await store.initialize();
    assert.equal(store.list().length, 0);
    const receipt = await store.install(bytes), pkg = store.get(receipt);
    assert.equal(receipt.reused, false);
    assert.equal((await store.install(bytes)).reused, true);
    const repacked = buildMapArchive({ data, svg, assets: { 'assets/rubble.webp': Buffer.from('image bytes') },
      metadata: { sourceCommit: 'new-release-commit', generatedAt: '2026-10-14T00:00:00Z' } });
    assert.equal(inspectMapArchive(repacked).fingerprint, receipt.fingerprint);
    assert.equal((await store.install(repacked)).reused, true, 'unchanged content may be repacked with new provenance');
    assert.match(pkg.svg, /\/api\/packages\/maps\/rpgmap-minimal-reference\/1.2.0\/files\/assets\/rubble.webp/);
    assert.match(pkg.artAssets.rubbleAtlas.url, /files\/assets\/rubble.webp$/);
    assert.equal(pkg.createSvg(), pkg.svg);
    assert.equal(Object.isFrozen(pkg.features[0].geometry.points[0]), true);
    assert.throws(() => { pkg.features[0].geometry.points[0][0] = 999; }, TypeError);
    const resource = store.file(receipt, 'assets/rubble.webp');
    assert.equal((await readFile(resource)).toString(), 'image bytes');
    assert.throws(() => store.file(receipt, '../package.rpgmap'), error => error.code === 'map_archive_path_invalid');
    const restarted = new MapPackageStore({ root }); await restarted.initialize();
    assert.equal(restarted.mapForScene({ mapId: receipt.id, mapVersion: receipt.version }).fingerprint, receipt.fingerprint);
    assert.throws(() => restarted.mapForScene({ mapId: 'not-installed', mapVersion: '1.0.0' }), error => error.code === 'map_package_not_found');
    await writeFile(resource, 'tampered image');
    await assert.rejects(new MapPackageStore({ root }).initialize(), error => error.code === 'map_archive_corrupt');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('immutable installs coexist by version and deletion preserves scene and backup references', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rpgmap-versions-'));
  try {
    const store = new MapPackageStore({ root }); await store.initialize();
    const first = await store.install(archive()), second = await store.install(archive({ version: '1.3.0' }));
    assert.equal(store.list().length, 2);
    assert.notEqual(store.get(first), store.get(second));
    await assert.rejects(store.install(archive({ title: 'Different same-version content' })), error => error.code === 'map_package_version_conflict');
    const refs = [{ mapId: first.id, mapVersion: first.version, worldId: 'world-a', sceneId: 'scene-a' }, { id: first.id, version: first.version, backup: 'restore-point' }];
    await assert.rejects(store.remove(first, { references: refs }), error => error.code === 'map_package_in_use' && error.details.length === 2);
    assert.equal(store.list().length, 2);
    await store.remove(second, { references: refs });
    assert.equal(store.list().length, 1);
    await store.remove(first);
    assert.equal(store.list().length, 0);
    assert.throws(() => store.get(first), error => error.code === 'map_package_not_found');
    const restarted = new MapPackageStore({ root }); await restarted.initialize(); assert.equal(restarted.list().length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('version-keyed browser registry never substitutes another installed version and deduplicates concurrent loading', async () => {
  const registry = new MapPackageRegistry(), first = sample(), second = sample({ version: '1.3.0' });
  let loads = 0;
  registry.registerLoader({ id: first.id, version: first.version, load: async () => { loads++; return first; } });
  registry.registerPackage(second);
  const [a, b] = await Promise.all([registry.load(first), registry.load(first)]);
  assert.equal(a, b); assert.equal(loads, 1);
  assert.equal((await registry.load(second)).version, second.version);
  await assert.rejects(registry.load({ id: first.id }), error => error.code === 'map_package_version_required');
  await assert.rejects(registry.load({ id: first.id, version: '9.9.9' }), error => error.code === 'map_package_version_mismatch');
  assert.equal(registry.has(first.id, first.version), true);
  registry.unregister(first); assert.equal(registry.has(first.id, first.version), false);
  assert.equal((await registry.load({ id: first.id })).version, second.version);
});
