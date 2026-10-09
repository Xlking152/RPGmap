import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify, isDeepStrictEqual } from 'node:util';
import path from 'node:path';

const execFileAsync = promisify(execFile);
const sourcePaths = ['src', 'deployment/local-server', 'reference/maps/lanzhou/runtime.json'];
const sourceFile = file => /\.(js|mjs)$/.test(file) || file === 'reference/maps/lanzhou/runtime.json';
const hash = text => createHash('sha256').update(text.replaceAll('\r\n', '\n')).digest('hex');

async function identity(root) {
  const [head, tracked, packageText] = await Promise.all([
    execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root }),
    execFileAsync('git', ['ls-files', '-z', '--', ...sourcePaths], { cwd: root }),
    readFile(path.join(root, 'package.json'), 'utf8'),
  ]);
  const sourceCommit = head.stdout.trim(), version = JSON.parse(packageText).version;
  if (!/^[a-f0-9]{40}$/.test(sourceCommit) || !/^\d+\.\d+\.\d+$/.test(version || '')) {
    throw new Error('Vision source identity is invalid');
  }
  const files = tracked.stdout.split('\0').filter(sourceFile).sort();
  if (!files.includes('src/spatial/kernel.js') || !files.includes('reference/maps/lanzhou/runtime.json')
    || new Set(files).size !== files.length || files.some(file => !/^(src\/|deployment\/local-server\/|reference\/maps\/lanzhou\/runtime\.json$)/.test(file)
      || file.split('/').includes('..'))) throw new Error('Vision source file coverage is invalid');
  return { sourceCommit, version, files };
}

/** Dirty diagnostic sources are allowed; formal release cleanliness is checked by the caller. */
export async function captureVisionSourceProof(sourceRoot = process.cwd()) {
  const root = path.resolve(sourceRoot), before = await identity(root);
  const sourceFileHashes = Object.fromEntries(await Promise.all(before.files.map(async file => [file,
    hash(await readFile(path.join(root, file), 'utf8'))])));
  if (!isDeepStrictEqual(await identity(root), before)) throw new Error('Vision source identity changed during capture');
  return { version: before.version, sourceCommit: before.sourceCommit, sourceHashEncoding: 'utf8-lf', sourceFileHashes };
}

export async function assertVisionSourceProofUnchanged(proof, sourceRoot = process.cwd()) {
  if (!isDeepStrictEqual(await captureVisionSourceProof(sourceRoot), proof)) {
    throw new Error('Vision source changed during measurement');
  }
}
