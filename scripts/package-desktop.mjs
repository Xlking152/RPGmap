import { readFile, mkdir, cp, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { buildDesktopRuntime } from './build-desktop-runtime.mjs';
import { verifyDesktopStage, verifyDesktopInstallation } from './verify-desktop-package.mjs';

const require = createRequire(import.meta.url);
const config = require('../desktop/builder.config.cjs');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform !== 'win32') throw new Error('Windows 安装器必须在 Windows 上生成。');
const stage = await buildDesktopRuntime({ buildClient: !process.argv.includes('--skip-client-build') });
await verifyDesktopStage(stage.stageRoot);
if (process.argv.includes('--stage-only')) {
  console.log(`桌面程序载荷已验证：${stage.stageRoot}`);
} else {
  const { build, Platform, Arch } = await import('electron-builder');
  const directoryOnly = process.argv.includes('--dir');
  const built = await build({
    projectDir: root,
    targets: Platform.WINDOWS.createTarget(directoryOnly ? 'dir' : 'nsis', Arch.x64),
    config: { ...config, electronVersion: stage.version.electron, electronDist: path.join(root, 'node_modules', 'electron', 'dist'), directories: { ...config.directories, app: 'artifact/desktop-stage/application' } },
  });
  const installation = path.join(root, 'artifact', 'desktop', 'win-unpacked');
  await verifyDesktopInstallation(installation, stage.stageRoot);
  if (!directoryOnly) {
    const delivery = path.join(root, 'artifact', `RPGmap-v${stage.version.version}-验收`);
    await mkdir(delivery, { recursive: true });
    const installer = built.find(item => /RPGmap-Setup-.+\.exe$/.test(item));
    if (!installer) throw new Error('未生成 NSIS 安装器。');
    const target = path.join(delivery, path.basename(installer));
    await cp(installer, target);
    const bytes = await readFile(target);
    const hash = createHash('sha256').update(bytes).digest('hex');
    await writeFile(path.join(delivery, 'SHA256SUMS.txt'), `${hash} *${path.basename(target)}\n`);
    console.log(JSON.stringify({ installer: target, sha256: hash, bytes: bytes.length, source: stage.version }, null, 2));
  }
}
