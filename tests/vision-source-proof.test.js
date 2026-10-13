import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { captureVisionSourceProof, assertVisionSourceProofUnchanged } from '../scripts/vision-source-proof.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const execFileAsync = promisify(execFile);

test('vision source proof includes complete tracked and untracked source coverage and UTF8-LF hashes without requiring a clean checkout', async () => {
  const proof = await captureVisionSourceProof(root);
  const files = (await execFileAsync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', 'src', 'deployment/local-server',
    'maps/lanzhou/runtime.json'], { cwd: root })).stdout.split('\0').filter(file => /\.(js|mjs)$/.test(file)
      || file === 'maps/lanzhou/runtime.json').sort();
  assert.deepEqual(Object.keys(proof).sort(), ['sourceCommit', 'sourceFileHashes', 'sourceHashEncoding', 'version']);
  assert.deepEqual(Object.keys(proof.sourceFileHashes), files);
  assert.equal(proof.sourceHashEncoding, 'utf8-lf');
  assert.equal(proof.sourceCommit, (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim());
  assert.equal(proof.version, JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version);
  for (const file of ['src/vision/mask-renderer.js', 'src/spatial/kernel.js', 'src/runtime/core/session.js',
    'deployment/local-server/server.mjs', 'deployment/local-server/package-store.mjs', 'maps/lanzhou/runtime.json']) {
    const text = (await readFile(path.join(root, file), 'utf8')).replaceAll('\r\n', '\n');
    assert.equal(proof.sourceFileHashes[file], createHash('sha256').update(text).digest('hex'));
  }
  await assertVisionSourceProofUnchanged(proof, root);
});

test('vision source completion check rejects changed identity, encoding, source bytes and incomplete coverage', async () => {
  const original = await captureVisionSourceProof(root);
  for (const mutate of [
    proof => { proof.sourceCommit = 'f'.repeat(40); },
    proof => { proof.version = '0.0.0'; },
    proof => { proof.sourceHashEncoding = 'utf8-crlf'; },
    proof => { proof.sourceFileHashes['src/vision/mask-renderer.js'] = 'f'.repeat(64); },
    proof => { delete proof.sourceFileHashes['src/spatial/kernel.js']; },
  ]) {
    const proof = structuredClone(original); mutate(proof);
    await assert.rejects(assertVisionSourceProofUnchanged(proof, root), /source changed during measurement/);
  }
});

test('candidate proof detects untracked runtime code changes and additions before source completion', async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'rpgmap-vision-source-proof-'));
  try {
    await mkdir(path.join(fixtureRoot, 'src/spatial'), { recursive: true });
    await mkdir(path.join(fixtureRoot, 'src/runtime/core'), { recursive: true });
    await mkdir(path.join(fixtureRoot, 'maps/lanzhou'), { recursive: true });
    await writeFile(path.join(fixtureRoot, 'src/spatial/kernel.js'), 'export const kernel = 1;\n');
    await writeFile(path.join(fixtureRoot, 'maps/lanzhou/runtime.json'), '{}\n');
    await writeFile(path.join(fixtureRoot, 'package.json'), JSON.stringify({ version: '3.0.0-rc.1' }));
    await execFileAsync('git', ['init', '--quiet'], { cwd: fixtureRoot });
    await execFileAsync('git', ['add', '.'], { cwd: fixtureRoot });
    await execFileAsync('git', ['-c', 'user.name=Test Fixture', '-c', 'user.email=fixture@example.invalid',
      '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'source proof fixture'], { cwd: fixtureRoot });
    const addedSource = path.join(fixtureRoot, 'src/runtime/core/session.js');
    await writeFile(addedSource, 'export const runtime = 1;\r\n');
    const proof = await captureVisionSourceProof(fixtureRoot);
    assert.equal(proof.version, '3.0.0-rc.1');
    assert.equal(proof.sourceFileHashes['src/runtime/core/session.js'],
      createHash('sha256').update('export const runtime = 1;\n').digest('hex'));
    await assertVisionSourceProofUnchanged(proof, fixtureRoot);
    await writeFile(addedSource, 'export const runtime = 2;\n');
    await assert.rejects(assertVisionSourceProofUnchanged(proof, fixtureRoot), /source changed during measurement/);
    await writeFile(addedSource, 'export const runtime = 1;\n');
    await writeFile(path.join(fixtureRoot, 'src/runtime/core/worker.js'), 'export const worker = 1;\n');
    await assert.rejects(assertVisionSourceProofUnchanged(proof, fixtureRoot), /source changed during measurement/);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});
