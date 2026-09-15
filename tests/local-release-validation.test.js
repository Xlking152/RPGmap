import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

test('local release requires matching source, complete checks and the exact validated archive', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rpgmap-local-validation-'));
  const commit = 'a'.repeat(40);
  const archive = Buffer.from('candidate archive');
  const validation = { version: '2.5.0', commit, sha256: createHash('sha256').update(archive).digest('hex'),
    checks: Object.fromEntries(['tests', 'build', 'bundle', 'package', 'benchmark', 'lanBenchmark', 'edge', 'chrome'].map(key => [key, 'passed'])) };
  const run = () => execFileSync(process.execPath, ['scripts/verify-local-validation.mjs', directory, '2.5.0', commit], { stdio: 'pipe' });
  const save = () => writeFile(path.join(directory, 'local-validation.json'), JSON.stringify(validation));
  try {
    await writeFile(path.join(directory, 'RPGmap-v2.5.0.zip'), archive);
    await save();
    assert.doesNotThrow(run);
    validation.checks.chrome = 'failed'; await save(); assert.throws(run);
    validation.checks.chrome = 'passed'; validation.commit = 'b'.repeat(40); await save(); assert.throws(run);
    validation.commit = commit; await save();
    await writeFile(path.join(directory, 'RPGmap-v2.5.0.zip'), 'changed after validation');
    assert.throws(run);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
