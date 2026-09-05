import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { build as viteBuild } from 'vite';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));
const version = pkg.version;
const outputRoot = path.resolve(process.env.RPGMAP_PACKAGE_DIR || path.join(projectRoot, 'artifact'));
const root = path.join(outputRoot, `RPGmap-v${version}`);
const archiveName = `RPGmap-v${version}.zip`;
const archive = path.join(outputRoot, archiveName);
const checksum = `${archive}.sha256`;
const execFileAsync = promisify(execFile);

async function sourceCommit() {
  const configured = String(process.env.RPGMAP_SOURCE_COMMIT || process.env.GITHUB_SHA || '').trim();
  const commit = configured || (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: projectRoot })).stdout.trim();
  if (!/^[0-9a-f]{40}$/i.test(commit)) throw new Error('RPGmap package requires a full 40-character source commit');
  return commit.toLowerCase();
}

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
for (const file of [
  'server.mjs',
  'access-control.mjs',
  'http-runtime.mjs',
  'status-capabilities-v2.mjs',
  'portable-storage.mjs',
  'world-schema.mjs',
  'world-v2.mjs',
  'websocket-runtime.mjs',
  'world-wal.mjs',
  'launcher.mjs',
  'start-rpgmap.bat',
]) {
  await copy(path.join('deployment', 'local-server', file), file);
}
async function bundleServerModule(entry, fileName) {
  await viteBuild({
    configFile: false,
    logLevel: 'error',
    build: {
      target: 'es2020',
      emptyOutDir: false,
      minify: false,
      outDir: root,
      lib: {
        entry: path.join(projectRoot, entry),
        formats: ['es'],
        fileName: () => fileName,
      },
    },
  });
}

await bundleServerModule('src/server/world-operations-entry.js', 'world-operations.mjs');
await bundleServerModule('src/server/authority.js', 'ruleset-authority.mjs');
await bundleServerModule('src/server/movement-authority-entry.js', 'movement-authority.mjs');
await bundleServerModule('src/permissions/model.js', 'permissions-model.mjs');
await bundleServerModule('deployment/local-server/status-operations.mjs', 'status-operations.mjs');
await copy('文档/操作指南.md', 'docs/OPERATION-GUIDE.md');

await writeFile(path.join(root, 'VERSION.json'), `${JSON.stringify({
  app: 'RPGmap', version, releaseTag: `v${version}`,
  commit: await sourceCommit(),
  worldSchema: 3,
  operationSchema: 4,
  statusSchema: 4,
  accessSchema: 4,
  serverMode: 'multiplayer', platform: 'windows', storageMode: 'portable-map-root-server-authoritative',
  launcherMode: 'local-lan-v2', defaultPort: 30000,
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

await execFileAsync(process.execPath, [
  path.join(projectRoot, 'scripts', 'verify-package.mjs'),
  `--root=${root}`,
  `--archive=${archive}`,
]);

console.log(archive);
