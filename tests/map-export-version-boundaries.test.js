import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectMapArchive } from '../src/packages/map-archive.js';
import { resolveLanzhouExportPreset, verifyLanzhouExportReceipt } from '../scripts/map-export-presets.mjs';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));

test('map export accepts only the frozen published and art candidate identities', () => {
  assert.equal(resolveLanzhouExportPreset().version, '1.1.0');
  assert.equal(resolveLanzhouExportPreset('1.1.0').published, true);
  assert.equal(resolveLanzhouExportPreset('1.1.1').published, false);
  assert.equal(resolveLanzhouExportPreset('1.1.1').snapshot, '1.1.1');
  assert.equal(resolveLanzhouExportPreset('1.1.2').snapshot, null);
  for (const version of ['1.1.3', '3.0.0', 'latest', '', '__proto__']) {
    assert.throws(() => resolveLanzhouExportPreset(version), { code: 'map_export_version_unknown' });
  }
});

test('fingerprint validation rejects changed published content and relabeled candidate content', () => {
  const published = resolveLanzhouExportPreset('1.1.0'), candidate = resolveLanzhouExportPreset('1.1.1');
  const identity = version => ({ id: 'northern-song-lanzhou-1104', version });
  assert.throws(() => verifyLanzhouExportReceipt({ manifest: identity('1.1.0'), fingerprint: candidate.fingerprint }, published),
    { code: 'map_release_fingerprint_mismatch' });
  assert.throws(() => verifyLanzhouExportReceipt({ manifest: identity('1.1.1'), fingerprint: candidate.fingerprint }, published),
    { code: 'map_export_identity_mismatch' });
  assert.throws(() => verifyLanzhouExportReceipt({ manifest: identity('1.1.1'), fingerprint: published.fingerprint }, candidate),
    { code: 'map_candidate_fingerprint_mismatch' });
});

test('explicit published export retains the original content and excludes candidate textures', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'rpgmap-map-version-'));
  try {
    await run(process.execPath, ['scripts/export-map-packages.mjs', '--out', directory, '--map-version', '1.1.0'], { cwd: root, windowsHide: true });
    const archive = inspectMapArchive(await readFile(path.join(directory, '北宋兰州城-1.1.0.rpgmap')));
    assert.equal(archive.fingerprint, '9a8de38844f6b6f5e528d507bf38bd134045d27f24c948f1e82ad1c0ea87c947');
    assert.equal(archive.files.has('assets/tree-elm-canopy-v2.webp'), false);
    assert.equal(archive.files.has('assets/loess-terrain-v2.webp'), false);
    assert.equal(archive.files.has('assets/loess-terrain.webp'), true);
    assert.equal([...archive.files.keys()].filter(name => name.endsWith('.webp')).length, 29);
    assert.equal(Object.hasOwn(archive.manifest, 'sourceMapVersion'), false);
    assert.doesNotMatch(archive.svg, /data-tree-art-for/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('unknown export versions fail before creating output artifacts', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'rpgmap-map-version-'));
  const output = path.join(directory, 'must-not-exist');
  try {
    await assert.rejects(run(process.execPath, ['scripts/export-map-packages.mjs', '--out', output, '--map-version', '1.1.3'], { cwd: root, windowsHide: true }),
      error => error.stderr.includes('map_export_version_unknown'));
    await assert.rejects(access(output), { code: 'ENOENT' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('the installed first art candidate remains frozen after the second art candidate is added', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'rpgmap-map-version-'));
  try {
    await run(process.execPath, ['scripts/export-map-packages.mjs', '--out', directory, '--map-version', '1.1.1'], { cwd: root, windowsHide: true });
    const archive = inspectMapArchive(await readFile(path.join(directory, '北宋兰州城-1.1.1.rpgmap')));
    assert.equal(archive.fingerprint, '053bfb332654867f7134565d06ae8035b4397b34e2caa14c78a4eebe23063795');
    assert.equal([...archive.files.keys()].filter(name => name.endsWith('.webp')).length, 30);
    assert.equal(archive.files.has('assets/street-stone-v3.webp'), false);
    assert.equal(archive.files.has('assets/courtyard-ground-v3.webp'), false);
    assert.doesNotMatch(archive.svg, /parcel-surface-|generated-street-paving/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
