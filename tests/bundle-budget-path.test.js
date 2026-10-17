import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const execute = promisify(execFile);
const script = fileURLToPath(new URL('../scripts/check-bundle-budget.mjs', import.meta.url));
async function fixture(callback) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rpgmap-budget-path-'));
  try {
    for (const name of ['dist', 'app']) {
      await mkdir(path.join(root, name, '.vite'), { recursive: true });
      await writeFile(path.join(root, name, 'index.js'), 'export const ready = true;');
      await writeFile(path.join(root, name, '.vite/manifest.json'), JSON.stringify({
        'index.html': { isEntry: true, file: 'index.js' },
      }));
    }
    await callback(root);
  } finally {
    assert(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert(path.basename(root).startsWith('rpgmap-budget-path-'));
    await rm(root, { recursive: true, force: true });
  }
}

test('an isolated app build uses the same bundle measurement and fixed limits as dist', async () => {
  await fixture(async root => {
    const normal = JSON.parse((await execute(process.execPath, [script, root, '--strict-budget'])).stdout);
    const isolated = JSON.parse((await execute(process.execPath, [script, root, '--dist', 'app', '--strict-budget'])).stdout);
    assert.deepEqual(isolated, normal);
    assert.deepEqual(isolated.limits, { initialJsGzip: 11726, totalJsGzip: 328432, totalCssGzip: 7429 });
  });
});

test('explicit build paths do not bypass a budget failure', async () => {
  await fixture(async root => {
    await writeFile(path.join(root, 'app', 'oversized.js'), randomBytes(400000).toString('base64'));
    await assert.rejects(execute(process.execPath, [script, root, '--dist', 'app', '--strict-budget']), error => {
      assert.match(error.stderr, /totalJsGzip .* exceeds budget 328432/);
      assert(JSON.parse(error.stdout).measured.totalJsGzip > 328432);
      return true;
    });
  });
});

test('an empty build directory option fails instead of measuring a different directory', async () => {
  await assert.rejects(execute(process.execPath, [script, '.', '--dist', '--strict-budget']), /requires a build directory/);
});
