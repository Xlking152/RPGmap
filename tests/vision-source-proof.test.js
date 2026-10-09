import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { captureVisionSourceProof, assertVisionSourceProofUnchanged } from '../scripts/vision-source-proof.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const execFileAsync = promisify(execFile);

test('vision source proof includes complete tracked source coverage and UTF8-LF hashes without requiring a clean checkout', async () => {
  const proof = await captureVisionSourceProof(root);
  const files = (await execFileAsync('git', ['ls-files', '-z', '--', 'src', 'deployment/local-server',
    'reference/maps/lanzhou/runtime.json'], { cwd: root })).stdout.split('\0').filter(file => /\.(js|mjs)$/.test(file)
      || file === 'reference/maps/lanzhou/runtime.json').sort();
  assert.deepEqual(Object.keys(proof).sort(), ['sourceCommit', 'sourceFileHashes', 'sourceHashEncoding', 'version']);
  assert.deepEqual(Object.keys(proof.sourceFileHashes), files);
  assert.equal(proof.sourceHashEncoding, 'utf8-lf');
  assert.equal(proof.sourceCommit, (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim());
  assert.equal(proof.version, JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version);
  for (const file of ['src/vision/mask-renderer.js', 'src/spatial/kernel.js', 'deployment/local-server/server.mjs', 'reference/maps/lanzhou/runtime.json']) {
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
