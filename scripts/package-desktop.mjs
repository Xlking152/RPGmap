import { readFile, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { buildDesktopRuntime } from './build-desktop-runtime.mjs';
import { verifyDesktopStage, verifyDesktopInstallation } from './verify-desktop-package.mjs';

const require = createRequire(import.meta.url);
const config = require('../desktop/builder.config.cjs');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform !== 'win32') throw new Error('Windows 安装器必须在 Windows 上生成。');
const stageOnly = process.argv.includes('--stage-only');
const sourceStatus = () => execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim();
if (!stageOnly && sourceStatus()) throw new Error('正式桌面构建需要干净的已提交源码。');
const receiptPath = path.join(root, 'artifact', 'desktop-build-receipt.json');
if (!stageOnly) await rm(receiptPath, { force: true });
const stage = await buildDesktopRuntime({ buildClient: !process.argv.includes('--skip-client-build') });
await verifyDesktopStage(stage.stageRoot);
if (stageOnly) {
  console.log(`桌面程序载荷已验证：${stage.stageRoot}`);
} else {
  // Electron 44 separates the npm package from its runtime download. Prepare
  // that package's exact, checksum-verified runtime after a fresh npm ci.
  execFileSync(process.execPath, [require.resolve('electron/install.js')], { cwd: root, stdio: 'inherit', windowsHide: true });
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
    const installer = built.find(item => /RPGmap-Setup-.+\.exe$/.test(item));
    if (!installer) throw new Error('未生成 NSIS 安装器。');
    if (sourceStatus() || execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim() !== stage.version.commit) throw new Error('打包期间源码发生改变，不能冻结产物。');
    const digest = bytes => createHash('sha256').update(bytes).digest('hex');
    const bytes = await readFile(installer);
    const receipt = {
      schemaVersion: 1, version: stage.version.version, sourceCommit: stage.version.commit, sourceDirty: false,
      installer: { file: path.basename(installer), sha256: digest(bytes), bytes: bytes.length },
      stage: { installManifestSha256: digest(await readFile(path.join(stage.stageRoot, 'INSTALL-MANIFEST.json'))),
        verified: true, version: stage.version.version, sourceCommit: stage.version.commit, sourceDirty: false },
      installation: { executableSha256: digest(await readFile(path.join(installation, 'RPGmap.exe'))) },
      checks: { desktopStage: 'passed', desktopInstallation: 'passed' },
    };
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
    console.log(JSON.stringify({ installer, receipt: receiptPath, ...receipt }, null, 2));
  }
}
