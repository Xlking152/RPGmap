import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as viteBuild } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const execFileAsync = promisify(execFile);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export async function listPayloadFiles(directory, prefix = '') {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`发布载荷不能包含符号链接：${relative}`);
    if (entry.isDirectory()) result.push(...await listPayloadFiles(path.join(directory, entry.name), relative));
    else if (entry.isFile()) result.push(relative);
  }
  return result.sort();
}

export async function buildDesktopRuntime({ stageRoot = path.join(root, 'artifact', 'desktop-stage'), buildClient = true } = {}) {
  const head = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
  const configuredCommit = process.env.RPGMAP_SOURCE_COMMIT || process.env.GITHUB_SHA;
  if (configuredCommit && configuredCommit.toLowerCase() !== head.toLowerCase()) throw new Error('构建源提交与实际检出的 HEAD 不一致。');
  const stage = path.resolve(stageRoot);
  const permittedRoot = path.join(root, 'artifact');
  if (stage === permittedRoot || !stage.startsWith(`${permittedRoot}${path.sep}`)) throw new Error('桌面暂存目录必须位于仓库 artifact 的子目录。');
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  await rm(stage, { recursive: true, force: true });
  await mkdir(path.join(stage, 'resources', 'server'), { recursive: true });
  await mkdir(path.join(stage, 'application', 'desktop'), { recursive: true });
  if (buildClient) await viteBuild();
  await cp(path.join(root, 'dist'), path.join(stage, 'resources', 'app'), { recursive: true });
  await rm(path.join(stage, 'resources', 'app', '.vite'), { recursive: true, force: true });
  const entries = [
    ['deployment/local-server/server.mjs', 'server.mjs'],
    ['deployment/local-server/exploration-worker.mjs', 'exploration-worker.mjs'],
  ];
  for (const [source, destination] of entries) {
    await viteBuild({
      configFile: false,
      logLevel: 'warn',
      ssr: { noExternal: true },
      build: {
        ssr: true,
        target: 'es2022', outDir: path.join(stage, 'resources', 'server'), emptyOutDir: false,
        minify: false, sourcemap: false,
        rollupOptions: { external: id => id.startsWith('node:') || id === 'electron', output: { entryFileNames: destination, chunkFileNames: 'shared-[hash].mjs' } },
        lib: { entry: path.join(root, source), formats: ['es'], fileName: () => destination },
      },
    });
  }
  for (const filename of ['main.cjs', 'preload.cjs', 'runtime-paths.cjs']) {
    await cp(path.join(root, 'desktop', filename), path.join(stage, 'application', 'desktop', filename));
  }
  await writeFile(path.join(stage, 'application', 'package.json'), `${JSON.stringify({
    name: 'rpgmap-desktop', version: pkg.version, private: true,
    description: 'RPGmap desktop launcher', author: 'RPGmap', main: 'desktop/main.cjs',
  }, null, 2)}\n`);
  const commit = head;
  if (!/^[a-f0-9]{40}$/i.test(commit)) throw new Error('发布清单需要完整的源提交。');
  const status = (await execFileAsync('git', ['status', '--porcelain'], { cwd: root })).stdout;
  const version = {
    app: 'RPGmap', version: pkg.version, releaseTag: `v${pkg.version}`, commit: commit.toLowerCase(),
    sourceDirty: Boolean(status.trim()), sourceStatusHash: sha256(Buffer.from(status)),
    worldSchema: 4, operationSchema: 4, statusSchema: 4, accessSchema: 4, occlusionSchema: 1,
    mapArchiveFormat: 1, serverMode: 'multiplayer', platform: 'windows-x64',
    launcherMode: 'electron-v3', storageMode: 'per-user-world-catalog', defaultPort: 30000,
    node: process.version, electron: pkg.devDependencies.electron, electronBuilder: pkg.devDependencies['electron-builder'],
  };
  await writeFile(path.join(stage, 'resources', 'server', 'VERSION.json'), `${JSON.stringify(version, null, 2)}\n`);
  const files = {};
  for (const relative of await listPayloadFiles(stage)) {
    const bytes = await readFile(path.join(stage, ...relative.split('/')));
    files[relative] = { bytes: bytes.length, sha256: sha256(bytes) };
  }
  await writeFile(path.join(stage, 'INSTALL-MANIFEST.json'), `${JSON.stringify({
    format: 1, appId: 'org.rpgmap.desktop', version: pkg.version, source: version,
    userData: '%LOCALAPPDATA%\\RPGmap\\UserData', files,
  }, null, 2)}\n`);
  return { stageRoot: stage, version, files };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await buildDesktopRuntime({ buildClient: !process.argv.includes('--skip-client-build') });
  console.log(JSON.stringify({ stageRoot: result.stageRoot, version: result.version.version, fileCount: Object.keys(result.files).length }, null, 2));
}
