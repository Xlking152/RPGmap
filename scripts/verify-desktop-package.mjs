import { readFile, stat, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { isDeepStrictEqual } from 'node:util';
import { listPayloadFiles } from './build-desktop-runtime.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = message => { throw new Error(`桌面包校验失败：${message}`); };

export function assertDesktopPayloadPath(relative) {
  const normalized = relative.replaceAll('\\', '/');
  if (!/^(?:application\/(?:desktop\/(?:main|preload|runtime-paths)\.cjs|package\.json)|resources\/app\/(?:index\.html|assets\/[^/]+\.(?:js|css|woff2?|ico|webp|png|svg))|resources\/server\/[^/]+\.(?:mjs|json))$/.test(normalized)) fail(`白名单之外的文件：${relative}`);
  if (/\.(?:map|rpgmap|rpgrules)$|(?:^|\/)(?:reference|maps|素材库|tests|node_modules|src)(?:\/|$)|(?:runtime|lanzhou)[^/]*\.(?:svg|json)/i.test(normalized)) fail(`程序包混入地图或制作数据：${relative}`);
}

export async function verifyDesktopStage(stageRoot = path.join(root, 'artifact', 'desktop-stage')) {
  const stage = path.resolve(stageRoot);
  const manifest = JSON.parse(await readFile(path.join(stage, 'INSTALL-MANIFEST.json'), 'utf8'));
  if (manifest.format !== 1 || manifest.appId !== 'org.rpgmap.desktop') fail('安装清单格式或应用 ID 错误。');
  if (!manifest.source?.commit?.match(/^[a-f0-9]{40}$/i)) fail('源提交缺失。');
  const present = (await listPayloadFiles(stage)).filter(file => file !== 'INSTALL-MANIFEST.json');
  if (JSON.stringify(present) !== JSON.stringify(Object.keys(manifest.files).sort())) fail('实际载荷与安装清单不同。');
  for (const relative of present) {
    assertDesktopPayloadPath(relative);
    const bytes = await readFile(path.join(stage, ...relative.split('/')));
    const record = manifest.files[relative];
    if (bytes.length !== record.bytes || sha256(bytes) !== record.sha256) fail(`文件校验失败：${relative}`);
    if (/\.(?:js|mjs|cjs|css|html)$/.test(relative)) {
      const source = bytes.toString('utf8');
      if (/sourceMappingURL=|reference[\\/]maps[\\/]lanzhou|lanzhouRuntimeJson|lanzhouRuntimeSvg/.test(source)) fail(`程序文件携带源码映射或内置兰州资源：${relative}`);
    }
  }
  for (const required of ['application/desktop/main.cjs', 'application/desktop/preload.cjs', 'resources/app/index.html', 'resources/server/server.mjs', 'resources/server/exploration-worker.mjs', 'resources/server/VERSION.json']) {
    if (!manifest.files[required]) fail(`缺少 ${required}`);
  }
  const version = JSON.parse(await readFile(path.join(stage, 'resources', 'server', 'VERSION.json'), 'utf8'));
  if (!isDeepStrictEqual(version, manifest.source)) fail('服务端 VERSION 与安装清单源身份不一致。');
  if (version.app !== 'RPGmap' || version.version !== manifest.version
    || version.releaseTag !== `v${manifest.version}`) fail('服务端版本或标签与安装清单不一致。');
  for (const schema of ['worldSchema', 'operationSchema', 'statusSchema', 'accessSchema']) {
    if (version[schema] !== 4) fail(`${schema} 必须为 4。`);
  }
  if (version.occlusionSchema !== 1 || version.mapArchiveFormat !== 1) fail('遮挡或地图归档契约格式错误。');
  const pkg = JSON.parse(await readFile(path.join(stage, 'application', 'package.json'), 'utf8'));
  if (pkg.main !== 'desktop/main.cjs' || pkg.dependencies) fail('桌面 ASAR 入口错误或带入多余依赖。');
  if (pkg.version !== manifest.version) fail('桌面应用版本与安装清单不一致。');
  return { version: manifest.version, files: present.length, source: manifest.source };
}

export async function verifyDesktopInstallation(installationRoot, stageRoot = path.join(root, 'artifact', 'desktop-stage')) {
  const installation = path.resolve(installationRoot);
  const manifest = JSON.parse(await readFile(path.join(stageRoot, 'INSTALL-MANIFEST.json'), 'utf8'));
  const resources = path.join(installation, 'resources');
  const entries = (await readdir(resources)).sort();
  const expected = ['INSTALL-MANIFEST.json', 'PROGRAM-FILES.txt', 'app', 'app.asar', 'server'];
  if (JSON.stringify(entries) !== JSON.stringify(expected)) fail(`resources 中有意外载荷：${entries.join(', ')}`);
  const installedManifest = JSON.parse(await readFile(path.join(resources, 'INSTALL-MANIFEST.json'), 'utf8'));
  if (JSON.stringify(installedManifest) !== JSON.stringify(manifest)) fail('安装清单不匹配。');
  for (const [relative, record] of Object.entries(manifest.files)) {
    if (!relative.startsWith('resources/')) continue;
    const target = path.join(installation, ...relative.split('/'));
    const bytes = await readFile(target);
    if (bytes.length !== record.bytes || sha256(bytes) !== record.sha256) fail(`安装载荷被改变：${relative}`);
  }
  const require = createRequire(import.meta.url);
  const asar = require('@electron/asar');
  const archive = path.join(resources, 'app.asar');
  const archiveFiles = asar.listPackage(archive).map(file => file.replaceAll('\\', '/').replace(/^\//, '')).filter(file => file && !asar.statFile(archive, file).files).sort();
  const expectedAsar = Object.keys(manifest.files).filter(file => file.startsWith('application/')).map(file => file.slice('application/'.length)).sort();
  if (JSON.stringify(archiveFiles) !== JSON.stringify(expectedAsar)) fail(`ASAR 内容不符合白名单：${archiveFiles.join(', ')}`);
  for (const filename of archiveFiles) {
    const bytes = asar.extractFile(archive, filename);
    const record = manifest.files[`application/${filename}`];
    if (sha256(bytes) !== record.sha256) fail(`ASAR 文件不匹配：${filename}`);
  }
  const executable = await stat(path.join(installation, 'RPGmap.exe'));
  if (!executable.isFile()) fail('缺少桌面运行程序。');
  const programManifest = (await readFile(path.join(resources, 'PROGRAM-FILES.txt'), 'utf8')).split(/\r?\n/).filter(Boolean).map(file => file.replaceAll('\\', '/')).sort();
  const actualFiles = (await listPayloadFiles(installation)).filter(file => file !== 'Uninstall RPGmap.exe');
  if (JSON.stringify(programManifest) !== JSON.stringify(actualFiles)) fail('程序清理清单与安装载荷不匹配。');
  return { version: manifest.version, executableBytes: executable.size, applicationFiles: archiveFiles.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const stage = process.argv.find(argument => argument.startsWith('--stage='))?.slice(8) || path.join(root, 'artifact', 'desktop-stage');
  const installed = process.argv.find(argument => argument.startsWith('--installed='))?.slice(12);
  const result = await verifyDesktopStage(stage);
  if (installed) result.installation = await verifyDesktopInstallation(installed, stage);
  console.log(JSON.stringify(result, null, 2));
}
