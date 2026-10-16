'use strict';

const { readdir, writeFile, rm } = require('node:fs/promises');
const path = require('node:path');

async function programFiles(directory, prefix = '') {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Program payload contains a symlink: ${relative}`);
    if (entry.isDirectory()) files.push(...await programFiles(path.join(directory, entry.name), relative));
    else if (entry.isFile()) files.push(relative);
  }
  return files.sort();
}

module.exports = {
  appId: 'org.rpgmap.desktop',
  productName: 'RPGmap',
  executableName: 'RPGmap',
  asar: true,
  compression: 'maximum',
  npmRebuild: false,
  publish: null,
  afterPack: async context => {
    await rm(path.join(context.appOutDir, 'resources', 'default_app.asar'), { force: true });
    const files = await programFiles(context.appOutDir);
    if (files.some(file => /[\r\n:]|(?:^|\/)\.\.(?:\/|$)/.test(file))) throw new Error('Invalid program manifest entry.');
    files.push('resources/PROGRAM-FILES.txt');
    await writeFile(path.join(context.appOutDir, 'resources', 'PROGRAM-FILES.txt'), `${files.map(file => file.replaceAll('/', '\\')).sort().join('\r\n')}\r\n`);
  },
  directories: { output: 'artifact/desktop', buildResources: 'desktop' },
  files: [
    'desktop/main.cjs', 'desktop/preload.cjs', 'desktop/runtime-paths.cjs',
    'package.json', '!node_modules',
  ],
  extraResources: [
    { from: 'artifact/desktop-stage/resources/server', to: 'server', filter: ['**/*'] },
    { from: 'artifact/desktop-stage/resources/app', to: 'app', filter: ['**/*', '!.vite/**'] },
    { from: 'artifact/desktop-stage/INSTALL-MANIFEST.json', to: 'INSTALL-MANIFEST.json' },
  ],
  win: { target: [{ target: 'nsis', arch: ['x64'] }], artifactName: 'RPGmap-Setup-${version}.${ext}', signExecutable: false },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowElevation: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    deleteAppDataOnUninstall: false,
    packElevateHelper: false,
    runAfterFinish: false,
    include: 'desktop/installer.nsh',
  },
};
