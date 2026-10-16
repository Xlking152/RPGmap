import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectMapArchive } from '../src/packages/map-archive.js';
import { inspectRulesetArchive } from '../deployment/local-server/ruleset-store.mjs';
import { installBrowserBenchmarkMap } from '../scripts/lan-benchmark-support.mjs';

const run = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));

for (const fixtures of [false, true]) {
  test(`content export ${fixtures ? 'explicitly includes development fixtures' : 'excludes development fixtures by default'}`, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'rpgmap-content-export-'));
    try {
      const args = ['--out', directory, ...(fixtures ? ['--fixtures'] : [])];
      await run(process.execPath, ['scripts/export-map-packages.mjs', ...args], { cwd: root, windowsHide: true });
      await run(process.execPath, ['scripts/export-ruleset-packages.mjs', ...args], { cwd: root, windowsHide: true });
      const names = (await readdir(directory)).sort();
      assert.deepEqual(names, ['北宋兰州城-1.1.0.rpgmap', '地图打包记录.json', '无限规则-1.1.0.rpgrules', '规则打包记录.json', ...(fixtures ? ['fixtures'] : [])].sort());
      const map = inspectMapArchive(await readFile(path.join(directory, '北宋兰州城-1.1.0.rpgmap')));
      assert.equal(map.fingerprint, '9a8de38844f6b6f5e528d507bf38bd134045d27f24c948f1e82ad1c0ea87c947');
      assert.equal(map.data.features.length, 103);
      const rules = inspectRulesetArchive(await readFile(path.join(directory, '无限规则-1.1.0.rpgrules')));
      assert.equal(rules.manifest.id, 'infinite-horror');
      assert.equal(rules.manifest.version, '1.1.0');
      const maps = JSON.parse(await readFile(path.join(directory, '地图打包记录.json'), 'utf8'));
      const rulesets = JSON.parse(await readFile(path.join(directory, '规则打包记录.json'), 'utf8'));
      assert.equal(maps.packages.length, fixtures ? 2 : 1);
      assert.equal(rulesets.packages.length, fixtures ? 2 : 1);
      if (fixtures) {
        assert.deepEqual((await readdir(path.join(directory, 'fixtures'))).sort(), ['最小测试地图-1.2.0.rpgmap', '最小测试规则-1.0.0.rpgrules']);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test('browser benchmarks find the production export without a private map-path override', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rpgmap-export-benchmark-'));
  try {
    const output = path.join(directory, 'artifact', 'content-packages');
    await run(process.execPath, ['scripts/export-map-packages.mjs', '--out', output], { cwd: root, windowsHide: true });
    await writeFile(path.join(directory, 'package.json'), JSON.stringify({ version: '3.0.0' }));
    const result = await installBrowserBenchmarkMap(directory, path.join(directory, 'UserData'), { archivePath: null });
    assert.equal(result.path, path.join(output, '北宋兰州城-1.1.0.rpgmap'));
    assert.equal(result.fingerprint, '9a8de38844f6b6f5e528d507bf38bd134045d27f24c948f1e82ad1c0ea87c947');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
