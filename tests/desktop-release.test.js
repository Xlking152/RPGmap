import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { after, test } from 'node:test';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assembleDesktopRelease, assertChecksumManifest, assertReleaseIdentity, releaseFiles, verifyDesktopRelease,
  LANZHOU_FINGERPRINT } from '../scripts/desktop-release.mjs';
import { inspectMapArchive, writeMapArchiveFiles } from '../src/packages/map-archive.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const temporary = await mkdtemp(path.join(tmpdir(), 'rpgmap-desktop-release-'));
after(async () => {
  if (path.dirname(temporary) !== path.resolve(tmpdir()) || !path.basename(temporary).startsWith('rpgmap-desktop-release-')) throw new Error('Unexpected temporary directory');
  await rm(temporary, { recursive: true, force: true });
});
execFileSync(process.execPath, ['scripts/export-map-packages.mjs', '--out', path.join(temporary, 'export')], { cwd: root, windowsHide: true, stdio: 'pipe' });
const mapBytes = await readFile(path.join(temporary, 'export', '北宋兰州城-1.1.0.rpgmap'));
let sequence = 0;

async function fixture() {
  const directory = path.join(temporary, String(++sequence));
  const stage = path.join(directory, 'stage');
  const version = '3.0.0', commit = sourceCommit;
  const source = { app: 'RPGmap', version, releaseTag: `v${version}`, commit, sourceDirty: false,
    worldSchema: 4, operationSchema: 4, statusSchema: 4, accessSchema: 4, occlusionSchema: 1, mapArchiveFormat: 1 };
  const sources = {
    'application/desktop/main.cjs': "'use strict';",
    'application/desktop/preload.cjs': "'use strict';",
    'application/desktop/runtime-paths.cjs': "'use strict';",
    'application/package.json': JSON.stringify({ version, main: 'desktop/main.cjs' }),
    'resources/app/index.html': '<!doctype html><html></html>',
    'resources/server/server.mjs': 'export const server = true;',
    'resources/server/exploration-worker.mjs': 'export const worker = true;',
    'resources/server/VERSION.json': JSON.stringify(source),
  };
  const files = {};
  for (const [name, content] of Object.entries(sources).sort()) {
    const bytes = Buffer.from(content);
    await mkdir(path.dirname(path.join(stage, name)), { recursive: true });
    await writeFile(path.join(stage, name), bytes);
    files[name] = { bytes: bytes.length, sha256: hash(bytes) };
  }
  const manifest = Buffer.from(JSON.stringify({ format: 1, appId: 'org.rpgmap.desktop', version,
    source, files }));
  await writeFile(path.join(stage, 'INSTALL-MANIFEST.json'), manifest);
  const installer = path.join(directory, 'installer.exe'), map = path.join(directory, 'map.rpgmap');
  const instructions = path.join(directory, 'instructions.md'), receipt = path.join(directory, 'build.json');
  const installerBytes = Buffer.from('test installer identity');
  const build = { schemaVersion: 1, version, sourceCommit: commit, sourceDirty: false,
    installer: { file: `RPGmap-Setup-${version}.exe`, bytes: installerBytes.length, sha256: hash(installerBytes) },
    stage: { version, sourceCommit: commit, sourceDirty: false, verified: true, installManifestSha256: hash(manifest) },
    checks: { desktopStage: 'passed', desktopInstallation: 'passed' } };
  await Promise.all([writeFile(installer, installerBytes), writeFile(map, mapBytes), writeFile(instructions, '# RPGmap v3.0.0\n安装并导入随附地图。\n'),
    writeFile(receipt, JSON.stringify(build))]);
  return { directory, installer, map, instructions, receipt, stage, version, commit,
    output: path.join(directory, 'delivery'), frozenReceipt: path.join(directory, 'freeze.json'), build };
}
const verify = f => verifyDesktopRelease({ ...f, directory: f.output, receipt: f.frozenReceipt });

test('the official assembler freezes exactly four independent files and validates their stage and map content', async () => {
  const f = await fixture();
  const result = await assembleDesktopRelease(f);
  assert.deepEqual((await readdir(f.output)).sort(), ['Lanzhou-1.1.0.rpgmap', 'README.md', 'RPGmap-Setup-3.0.0.exe', 'SHA256SUMS.txt']);
  assert.equal(result.map.fingerprint, LANZHOU_FINGERPRINT);
  assert.equal(result.sourceCommit, sourceCommit);
  assert.deepEqual(await verify(f), result);
  const checksums = await readFile(path.join(f.output, 'SHA256SUMS.txt'), 'utf8');
  assert.equal(checksums.trim().split('\n').length, 3);
  for (const filename of ['Lanzhou-1.1.0.rpgmap', 'README.md', 'RPGmap-Setup-3.0.0.exe']) {
    assert.ok(checksums.includes(`${hash(await readFile(path.join(f.output, filename)))} *${filename}\n`));
  }
});

test('release verification rejects byte replacement, additional assets and forged checksum entries', async () => {
  const f = await fixture(); await assembleDesktopRelease(f);
  const original = await readFile(path.join(f.output, 'README.md'));
  await writeFile(path.join(f.output, 'README.md'), 'substituted instructions');
  await assert.rejects(verify(f), /交付文件已变化/);
  await writeFile(path.join(f.output, 'README.md'), original);
  await writeFile(path.join(f.output, '验收报告.md'), 'not a release asset');
  await assert.rejects(verify(f), /恰好为四个/);
  const records = { 'a.exe': { sha256: 'a'.repeat(64) }, '地图.rpgmap': { sha256: 'b'.repeat(64) }, '使用说明.md': { sha256: 'c'.repeat(64) } };
  assert.throws(() => assertChecksumManifest(`${'a'.repeat(64)} *../a.exe\n`, records), /格式无效/);
  assert.throws(() => assertChecksumManifest(`${'a'.repeat(64)} *a.exe\n${'a'.repeat(64)} *a.exe\n`, records), /文件重复/);
});

test('a clean source identity and verified installation are mandatory, with no cross-version receipt reuse', async () => {
  const f = await fixture();
  for (const change of [b => b.sourceDirty = true, b => b.sourceCommit = 'a'.repeat(40), b => b.version = '3.0.1',
    b => b.stage.sourceDirty = true, b => b.checks.desktopInstallation = 'failed', b => b.installer.file = '../installer.exe']) {
    const modified = structuredClone(f.build); change(modified);
    assert.throws(() => assertReleaseIdentity(modified, f), /不匹配|无效|缺少/);
  }
  assert.throws(() => releaseFiles('3.0.0/../../bad'), /应用版本/);
  await writeFile(f.installer, 'different executable');
  await assert.rejects(assembleDesktopRelease(f), /安装器与构建收据不匹配/);
});

test('map imports cannot substitute another source commit or a second map version', async () => {
  const f = await fixture();
  const inspected = inspectMapArchive(mapBytes);
  for (const mutate of [m => m.sourceCommit = 'a'.repeat(40), m => m.version = '2.0.0']) {
    const files = new Map(inspected.files), manifest = structuredClone(inspected.manifest); mutate(manifest);
    files.set('manifest.json', Buffer.from(JSON.stringify(manifest)));
    await writeFile(f.map, writeMapArchiveFiles(files));
    await assert.rejects(assembleDesktopRelease(f), /地图身份|Map identity|version|版本/);
  }
});

test('stage mutation and old files in an assembly directory prevent publication', async () => {
  const f = await fixture();
  await writeFile(path.join(f.stage, 'resources/server/server.mjs'), 'changed code');
  await assert.rejects(assembleDesktopRelease(f), /文件校验失败/);
  const g = await fixture(); await mkdir(g.output); await writeFile(path.join(g.output, 'old.zip'), 'legacy');
  await assert.rejects(assembleDesktopRelease(g), /汇总目录必须为空/);
  assert.deepEqual(await readdir(g.output), ['old.zip']);
});

test('a receipt cannot be added as a fifth asset and symbolic-link assets are rejected', async t => {
  const f = await fixture();
  await assert.rejects(assembleDesktopRelease({ ...f, frozenReceipt: path.join(f.output, 'receipt.json') }), /第五个/);
  await assembleDesktopRelease(f);
  const target = path.join(f.output, 'README.md');
  await rm(target);
  try { await symlink(f.instructions, target, 'file'); } catch (error) {
    if (['EPERM', 'EACCES'].includes(error.code)) { t.diagnostic('OS does not allow file symlinks; path and allowlist cases still exercised.'); return; }
    throw error;
  }
  await assert.rejects(verify(f), /链接/);
});
