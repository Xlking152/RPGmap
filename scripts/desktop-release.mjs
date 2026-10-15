import { cp, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectMapArchive } from '../src/packages/map-archive.js';
import { verifyDesktopStage } from './verify-desktop-package.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = message => { throw new Error(`正式交付校验失败：${message}`); };
const commitPattern = /^[a-f0-9]{40}$/;
export const LANZHOU_FINGERPRINT = '9a8de38844f6b6f5e528d507bf38bd134045d27f24c948f1e82ad1c0ea87c947';

export function releaseFiles(version) {
  if (!/^3\.\d+\.\d+(?:-rc\.\d+)?$/.test(version)) fail('应用版本必须是明确的 v3 版本。');
  return [`RPGmap-Setup-${version}.exe`, '北宋兰州城-1.1.0.rpgmap', 'SHA256SUMS.txt', '使用说明.md'].sort();
}

export function assertReleaseIdentity(receipt, { version, commit }) {
  releaseFiles(version);
  if (!commitPattern.test(commit || '')) fail('需要完整的小写源提交。');
  if (receipt?.schemaVersion !== 1 || receipt.version !== version || receipt.sourceCommit !== commit
    || receipt.sourceDirty !== false) fail('构建收据的版本、源提交或干净状态不匹配。');
  const build = receipt.build || receipt;
  if (build.schemaVersion !== 1 || build.version !== version || build.sourceCommit !== commit || build.sourceDirty !== false
    || build.stage?.verified !== true || build.stage?.version !== version || build.stage?.sourceCommit !== commit
    || build.stage?.sourceDirty !== false || !/^[a-f0-9]{64}$/.test(build.stage?.installManifestSha256 || '')
    || build.checks?.desktopStage !== 'passed' || build.checks?.desktopInstallation !== 'passed') {
    fail('构建收据缺少通过验证的程序载荷和安装记录。');
  }
  const installer = build.installer;
  if (installer?.file !== `RPGmap-Setup-${version}.exe` || !/^[a-f0-9]{64}$/.test(installer.sha256 || '')
    || !Number.isSafeInteger(installer.bytes) || installer.bytes <= 0) fail('安装器构建记录无效。');
  return build;
}

async function regularFile(filename) {
  const info = await lstat(filename);
  if (!info.isFile() || info.isSymbolicLink()) fail(`必须是普通文件，不能使用目录或链接：${filename}`);
  return readFile(filename);
}

async function assertPlainDirectory(directory) {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) fail(`目录不能是链接：${directory}`);
}

export function assertChecksumManifest(text, expected) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  const found = new Map();
  for (const line of lines) {
    const match = /^([a-f0-9]{64}) \*([^/\\\r\n]+)$/.exec(line);
    if (!match || found.has(match[2])) fail('SHA 清单格式无效、路径不安全或文件重复。');
    found.set(match[2], match[1]);
  }
  const names = Object.keys(expected).filter(name => name !== 'SHA256SUMS.txt').sort();
  if (JSON.stringify([...found.keys()].sort()) !== JSON.stringify(names)) fail('SHA 清单必须恰好覆盖另外三个正式文件。');
  for (const name of names) if (found.get(name) !== expected[name].sha256) fail(`SHA 清单不匹配：${name}`);
}

async function inspectReleaseMap(bytes, commit) {
  const inspected = inspectMapArchive(bytes);
  if (inspected.manifest.id !== 'northern-song-lanzhou-1104' || inspected.manifest.version !== '1.1.0'
    || inspected.manifest.sourceCommit !== commit || inspected.fingerprint !== LANZHOU_FINGERPRINT) {
    fail('地图身份、源提交或兰州 1.1.0 内容指纹不匹配。');
  }
  return { id: inspected.manifest.id, version: inspected.manifest.version, fingerprint: inspected.fingerprint };
}

async function verifyStage(stage, build, identity) {
  await assertPlainDirectory(stage);
  const result = await verifyDesktopStage(stage);
  const manifestBytes = await regularFile(path.join(stage, 'INSTALL-MANIFEST.json'));
  if (digest(manifestBytes) !== build.stage.installManifestSha256 || result.version !== identity.version
    || result.source.commit !== identity.commit || result.source.sourceDirty !== false) fail('实际程序载荷与冻结构建收据不匹配。');
}

export async function verifyDesktopRelease({ directory, receipt: receiptPath, stage, version, commit }) {
  await assertPlainDirectory(directory);
  const receipt = JSON.parse(await regularFile(receiptPath));
  const build = assertReleaseIdentity(receipt, { version, commit });
  if (!receipt.build || !receipt.release?.files) fail('需要冻结交付收据，不能只提供构建收据。');
  const names = (await readdir(directory)).sort(), wanted = releaseFiles(version);
  if (JSON.stringify(names) !== JSON.stringify(wanted)
    || JSON.stringify(Object.keys(receipt.release.files).sort()) !== JSON.stringify(wanted)) fail('正式交付必须恰好为四个白名单文件。');
  const files = {};
  let map;
  for (const name of names) {
    const bytes = await regularFile(path.join(directory, name));
    const entry = { bytes: bytes.length, sha256: digest(bytes) };
    const pinned = receipt.release.files[name];
    if (entry.bytes !== pinned?.bytes || entry.sha256 !== pinned?.sha256) fail(`交付文件已变化：${name}`);
    if (name === build.installer.file && (entry.sha256 !== build.installer.sha256 || entry.bytes !== build.installer.bytes)) fail('安装器与构建收据不匹配。');
    if (name.endsWith('.rpgmap')) map = await inspectReleaseMap(bytes, commit);
    files[name] = entry;
  }
  if (JSON.stringify(map) !== JSON.stringify(receipt.release.map)) fail('冻结地图内容记录不匹配。');
  assertChecksumManifest((await readFile(path.join(directory, 'SHA256SUMS.txt'))).toString('utf8'), files);
  if (stage) await verifyStage(stage, build, { version, commit });
  return { version, sourceCommit: commit, sourceDirty: false, files, map };
}

export async function assembleDesktopRelease({ installer, map, instructions, receipt: receiptPath, stage,
  output, frozenReceipt, version, commit }) {
  const build = JSON.parse(await regularFile(receiptPath));
  assertReleaseIdentity(build, { version, commit });
  if (!stage) fail('汇总正式交付时必须验证实际程序载荷。');
  await verifyStage(stage, build, { version, commit });
  const input = [[installer, `RPGmap-Setup-${version}.exe`], [map, '北宋兰州城-1.1.0.rpgmap'], [instructions, '使用说明.md']];
  const files = {};
  let mapIdentity;
  for (const [source, name] of input) {
    const bytes = await regularFile(source);
    files[name] = { bytes: bytes.length, sha256: digest(bytes) };
    if (name === build.installer.file && (files[name].sha256 !== build.installer.sha256 || bytes.length !== build.installer.bytes)) fail('安装器与构建收据不匹配。');
    if (name.endsWith('.rpgmap')) mapIdentity = await inspectReleaseMap(bytes, commit);
    if (name.endsWith('.md') && !bytes.toString('utf8').trim()) fail('使用说明不能为空。');
  }
  if (path.dirname(path.resolve(frozenReceipt)) === path.resolve(output)) fail('构建收据不能作为第五个正式资产。');
  await mkdir(output, { recursive: true });
  await assertPlainDirectory(output);
  if ((await readdir(output)).length) fail('汇总目录必须为空，防止混入旧包。');
  for (const [source, name] of input) await cp(source, path.join(output, name), { errorOnExist: true, force: false });
  const checksums = Object.keys(files).sort().map(name => `${files[name].sha256} *${name}\n`).join('');
  await writeFile(path.join(output, 'SHA256SUMS.txt'), checksums, { flag: 'wx' });
  files['SHA256SUMS.txt'] = { bytes: Buffer.byteLength(checksums), sha256: digest(Buffer.from(checksums)) };
  const frozen = { schemaVersion: 1, version, sourceCommit: commit, sourceDirty: false, build,
    release: { files, map: mapIdentity } };
  await mkdir(path.dirname(path.resolve(frozenReceipt)), { recursive: true });
  await writeFile(frozenReceipt, `${JSON.stringify(frozen, null, 2)}\n`, { flag: 'wx' });
  return verifyDesktopRelease({ directory: output, receipt: frozenReceipt, stage, version, commit });
}

function options(args) {
  const result = {};
  for (const arg of args) {
    const match = /^--([a-z-]+)=(.+)$/.exec(arg);
    if (!match || Object.hasOwn(result, match[1])) fail(`未知或重复参数：${arg}`);
    result[match[1]] = match[2];
  }
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2), opts = options(args);
  const version = opts.version || JSON.parse(await readFile(path.join(projectRoot, 'package.json'))).version;
  const commit = opts.commit || execFileSync('git', ['rev-parse', 'HEAD'], { cwd: projectRoot, encoding: 'utf8' }).trim();
  const allowed = command === 'assemble' ? ['version', 'commit', 'installer', 'map', 'instructions', 'receipt', 'stage', 'output', 'frozen-receipt']
    : ['version', 'commit', 'directory', 'receipt', 'stage'];
  if (!['assemble', 'verify'].includes(command) || Object.keys(opts).some(key => !allowed.includes(key))) fail('用法：desktop-release.mjs assemble|verify --参数=值');
  const result = command === 'assemble' ? await assembleDesktopRelease({ ...opts, version, commit,
    frozenReceipt: opts['frozen-receipt'] || path.join(path.dirname(path.resolve(opts.output)), 'desktop-release-receipt.json') })
    : await verifyDesktopRelease({ ...opts, version, commit });
  console.log(JSON.stringify(result, null, 2));
}
