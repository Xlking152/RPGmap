import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));
const version = pkg.version;
const outputRoot = path.resolve(process.env.RPGMAP_PACKAGE_DIR || path.join(projectRoot, 'artifact'));
const root = path.join(outputRoot, `RPGmap-v${version}`);
const archiveName = `RPGmap-v${version}.zip`;
const archive = path.join(outputRoot, archiveName);
const checksum = `${archive}.sha256`;
const execFileAsync = promisify(execFile);

async function copy(relative, target = relative) {
  await cp(path.join(projectRoot, relative), path.join(root, target), { recursive: true });
}

await rm(root, { recursive: true, force: true });
await rm(archive, { force: true });
await rm(checksum, { force: true });
await mkdir(path.join(root, 'map', 'uploads'), { recursive: true });
await mkdir(path.join(root, 'map', 'backups'), { recursive: true });
await mkdir(path.join(root, 'docs'), { recursive: true });

await copy('dist', 'app');
await copy('reference');
for (const file of [
  'server.mjs',
  'access-control.mjs',
  'portable-storage.mjs',
  'world-schema.mjs',
  'world-v2.mjs',
  'status-operations.mjs',
  'launcher.mjs',
  'start-rpgmap.bat',
  'README.md',
]) {
  await copy(path.join('deployment', 'local-server', file), file);
}
for (const [source, target] of [
  ['文档/操作指南.md', 'docs/OPERATION-GUIDE.md'],
  ['CHANGELOG.md', 'docs/CHANGELOG.md'],
]) await copy(source, target);
await copy('deployment/local-server/map/README.txt', 'map/README.txt');

await writeFile(path.join(root, 'VERSION.json'), `${JSON.stringify({
  app: 'RPGmap', version, releaseTag: `v${version}`,
  commit: process.env.RPGMAP_SOURCE_COMMIT || process.env.GITHUB_SHA || 'local-build',
  serverMode: 'multiplayer', platform: 'windows', storageMode: 'portable-map-root-server-authoritative',
  launcherMode: 'local-lan-only-v1', defaultPort: 30000,
}, null, 2)}\n`);

try {
  // Windows ships bsdtar, which selects ZIP from the archive extension. GNU
  // tar on Linux does not create ZIP archives, so CI must call zip directly.
  // Both paths archive the same versioned root directory.
  if (process.platform === 'win32') {
    await execFileAsync('tar', ['-a', '-c', '-f', archiveName, path.basename(root)], { cwd: outputRoot });
  } else {
    await execFileAsync('zip', ['-r', '-9', '-q', archiveName, path.basename(root)], { cwd: outputRoot });
  }
} catch (error) {
  throw new Error(`无法创建 Windows 发布 ZIP：${error.message}`);
}
const hash = createHash('sha256').update(await readFile(archive)).digest('hex');
await writeFile(checksum, `${hash} *${archiveName}\n`, 'utf8');

console.log(archive);
