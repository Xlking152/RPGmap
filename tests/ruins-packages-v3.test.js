import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { buildMapArchive } from '../src/packages/map-archive.js';
import { MapPackageStore } from '../deployment/local-server/package-store.mjs';
import { createMinimalReferencePackage } from '../maps/minimal/package.js';
import { loadPackagedRuinsMap } from '../scripts/ruins-lan-smoke.mjs';
import { createPackagedOfflineServer } from '../scripts/ruins-offline-browser-support.mjs';

test('v3 destruction evidence reads installed archive geometry and static SVG instead of baked frontend assets', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rpgmap-ruins-packages-'));
  assert.equal(path.dirname(directory), path.resolve(tmpdir()));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const packageRoot = path.join(directory, 'resources'), mapDir = path.join(directory, 'data');
  await mkdir(path.join(packageRoot, 'server'), { recursive: true }); await mkdir(path.join(packageRoot, 'app'));
  await writeFile(path.join(packageRoot, 'server', 'server.mjs'), '// package server');
  await writeFile(path.join(packageRoot, 'server', 'VERSION.json'), JSON.stringify({ version: '3.0.0-rc.1' }));
  const data = { ...createMinimalReferencePackage(), id: 'northern-song-lanzhou-1104', version: '1.1.0' };
  const bytes = buildMapArchive({ data });
  const store = await new MapPackageStore({ root: path.join(mapDir, 'packages/maps') }).initialize();
  const installed = await store.install(bytes), reference = { id: data.id, version: data.version };
  const map = await loadPackagedRuinsMap({ mapDir, packageRoot, reference });
  assert.equal(map.fingerprint, installed.fingerprint);
  assert.equal(map.features[0].id, data.features[0].id);
  assert.match(map.svg, /demo-house/);
  await assert.rejects(loadPackagedRuinsMap({ mapDir, packageRoot, reference: { ...reference, version: '2.0.0' } }), error => error.code === 'map_package_not_found');
  const archive = path.join(directory, 'map.rpgmap'); await writeFile(archive, bytes);
  const oldArchive = process.env.RPGMAP_BENCHMARK_MAP_PACKAGE;
  process.env.RPGMAP_BENCHMARK_MAP_PACKAGE = archive;
  let server;
  try {
    server = await createPackagedOfflineServer(packageRoot);
    const catalog = await (await fetch(`${server.url}api/packages/maps`)).json();
    assert.equal(catalog.maps[0].fingerprint, installed.fingerprint);
    const response = await (await fetch(`${server.url}api/packages/maps/${data.id}/${data.version}`)).json();
    assert.equal(response.fingerprint, installed.fingerprint); assert.match(response.svg, /demo-house/);
    const svg = await fetch(`${server.url}api/packages/maps/${data.id}/${data.version}/files/map.svg`);
    assert.equal(svg.status, 200); assert.match(await svg.text(), /demo-house/);
    assert.equal((await fetch(`${server.url}api/packages/maps/${data.id}/${data.version}/files/nonexistent.svg`)).status, 404);
    assert.equal((await fetch(`${server.url}api/packages/maps`, { method: 'POST' })).status, 405);
  } finally {
    await server?.close();
    if (oldArchive === undefined) delete process.env.RPGMAP_BENCHMARK_MAP_PACKAGE;
    else process.env.RPGMAP_BENCHMARK_MAP_PACKAGE = oldArchive;
  }
});
