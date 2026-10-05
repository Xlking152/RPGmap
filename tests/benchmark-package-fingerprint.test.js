import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { benchmarkBuildInfo } from '../scripts/lan-benchmark-support.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');

test('benchmark fingerprint covers browser assets and hidden manifest but excludes mutable saves', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rpgmap-benchmark-fingerprint-'));
  t.after(async () => {
    if (path.dirname(path.resolve(directory)) !== path.resolve(tmpdir())
      || !path.basename(directory).startsWith('rpgmap-benchmark-fingerprint-')) throw new Error('Unexpected fixture directory');
    await rm(directory, { recursive: true, force: true });
  });
  await Promise.all(['app/assets/nested', 'app/.vite', 'map'].map(relative => mkdir(path.join(directory, relative), { recursive: true })));
  const metadata = { version: '2.5.4', commit: 'a'.repeat(40) };
  const files = { 'server.mjs': 'server', 'exploration-worker.mjs': 'worker', 'app/index.html': 'page',
    'app/.vite/manifest.json': '{}', 'app/assets/nested/mask.js': 'continuous mask', 'app/assets/map.webp': 'image' };
  await writeFile(path.join(directory, 'VERSION.json'), JSON.stringify(metadata));
  await Promise.all(Object.entries(files).map(([file, text]) => writeFile(path.join(directory, file), text)));
  await writeFile(path.join(directory, 'map/world.json'), 'original save');
  const initial = await benchmarkBuildInfo(directory, directory);
  assert.deepEqual(initial, { metadata, fileHashes: Object.fromEntries(Object.keys(files).sort().map(file => [file, hash(files[file])])) });
  assert.deepEqual(Object.keys(initial.fileHashes), [...Object.keys(initial.fileHashes)].sort());
  await writeFile(path.join(directory, 'map/world.json'), 'updated save and pending exploration');
  assert.deepEqual(await benchmarkBuildInfo(directory, directory), initial);
  await writeFile(path.join(directory, 'app/assets/nested/mask.js'), 'different rendering implementation');
  assert.notDeepEqual(await benchmarkBuildInfo(directory, directory), initial);
});

test('benchmark cannot silently fingerprint a package without its browser application', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rpgmap-benchmark-fingerprint-'));
  t.after(async () => {
    if (path.dirname(path.resolve(directory)) !== path.resolve(tmpdir())
      || !path.basename(directory).startsWith('rpgmap-benchmark-fingerprint-')) throw new Error('Unexpected fixture directory');
    await rm(directory, { recursive: true, force: true });
  });
  await writeFile(path.join(directory, 'VERSION.json'), JSON.stringify({ version: '2.5.4' }));
  await assert.rejects(benchmarkBuildInfo(directory, directory), { code: 'ENOENT' });
});
