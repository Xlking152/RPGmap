'use strict';

const { app, BrowserWindow, dialog, ipcMain, session, shell, utilityProcess, Menu } = require('electron');
const { createWriteStream } = require('node:fs');
const { mkdir, stat, readFile, writeFile, rename } = require('node:fs/promises');
const { randomBytes } = require('node:crypto');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { resolveDesktopPaths, isLocalApplicationUrl, redactLogLine, stopUtilityProcess, verifyInstalledPayload } = require('./runtime-paths.cjs');

app.setName('RPGmap');
app.setAppUserModelId('org.rpgmap.desktop');
let window;
let server;
let origin;
let paths;
let shuttingDown = false;
let quitReady = false;
let logStream;
let restarting = false;
let restartCompletion = null;
let restartResolve = null;
let restartReject = null;
let pendingInstaller = null;
const managerSecret = randomBytes(32).toString('hex');
const gmSecret = randomBytes(32).toString('hex');
const secrets = [managerSecret, gmSecret];

function prepareRestartCompletion() {
  restartCompletion = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('服务重启超时，请查看运行日志并重新启动 RPGmap。')), 75000);
    restartResolve = () => { clearTimeout(timer); resolve(); };
    restartReject = error => { clearTimeout(timer); reject(error); };
  });
  restartCompletion.catch(() => {});
}

function log(message) {
  logStream?.write(`${new Date().toISOString()} ${redactLogLine(message, secrets)}\n`);
}

function trustedSender(event) {
  return window && event.sender === window.webContents
    && event.senderFrame === window.webContents.mainFrame
    && isLocalApplicationUrl(event.senderFrame.url, origin);
}

function handle(channel, handler) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!trustedSender(event)) throw new Error('此操作只允许从 RPGmap 主窗口调用。');
    if (shuttingDown) throw new Error('RPGmap 正在保存并退出。');
    return handler(...args);
  });
}

async function management(endpoint, { method = 'GET', body, headers = {} } = {}) {
  const response = await fetch(`${origin}/api/manage/${endpoint}`, {
    method,
    headers: { 'X-RPGmap-Manager': managerSecret, Origin: origin, ...headers },
    body,
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.message || result.error || `请求失败：${response.status}`);
  return result;
}

async function currentGameUrl() {
  const catalog = await management('catalog');
  const target = catalog.connection?.localUrl || catalog.connection?.hostUrl || `${origin}/`;
  if (!isLocalApplicationUrl(target, origin)) throw new Error('服务器返回了不匹配的本地游戏地址。');
  return target;
}

async function pickImport(kind) {
  const specs = {
    map: { extension: 'rpgmap', endpoint: 'maps', name: 'RPGmap 地图包', maximum: 256 * 1024 * 1024 },
    ruleset: { extension: 'rpgrules', endpoint: 'rulesets', name: 'RPGmap 规则包', maximum: 64 * 1024 * 1024 },
    world: { extension: 'json', endpoint: 'worlds/import', name: 'RPGmap World 存档', maximum: 256 * 1024 * 1024 },
  };
  const spec = specs[kind];
  if (!spec) throw new Error('不支持的内容类型。');
  const selection = await dialog.showOpenDialog(window, {
    title: `导入${spec.name}`,
    properties: ['openFile'],
    filters: [{ name: spec.name, extensions: [spec.extension] }],
  });
  if (selection.canceled || !selection.filePaths[0]) return { canceled: true };
  const selected = selection.filePaths[0];
  if (path.extname(selected).toLowerCase() !== `.${spec.extension}`) throw new Error(`请选择 .${spec.extension} 文件。`);
  const info = await stat(selected);
  if (!info.isFile() || info.size > spec.maximum) throw new Error('文件过大或不是普通文件。');
  const bytes = await readFile(selected);
  if (kind !== 'world') {
    const preview = await management(`${spec.endpoint}/inspect`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes });
    const accepted = await dialog.showMessageBox(window, {
      type: 'question', buttons: ['导入', '取消'], defaultId: 1, cancelId: 1,
      title: `导入${spec.name}`, message: preview.title,
      detail: `ID：${preview.id}\n版本：${preview.version}\n兼容契约：${JSON.stringify(preview.compatibility)}\n文件数：${preview.filesCount}\n${kind === 'ruleset' ? '仅导入信任作者提供的 RPGmap 规则契约包。安装后会执行规则代码，不提供第三方代码沙箱。' : '检查完成。导入将安装独立地图包，不修改已有场景。'}`,
    });
    if (accepted.response !== 0) return { canceled: true };
  }
  return management(spec.endpoint, {
    method: 'POST',
    headers: { 'Content-Type': kind === 'world' ? 'application/json' : 'application/octet-stream' },
    body: bytes,
  });
}

function registerBridge() {
  handle('rpgmap:open-data', async () => {
    const error = await shell.openPath(paths.dataRoot);
    if (error) throw new Error(error);
    return { opened: true };
  });
  handle('rpgmap:import-package', kind => pickImport(kind));
  handle('rpgmap:import-world', () => pickImport('world'));
  handle('rpgmap:import-legacy-directory', async () => {
    const selection = await dialog.showOpenDialog(window, {
      title: '选择旧版 RPGmap 数据目录（map/）', properties: ['openDirectory'],
    });
    if (selection.canceled || !selection.filePaths[0]) return { canceled: true };
    const directory = path.resolve(selection.filePaths[0]);
    if (!(await stat(directory)).isDirectory()) throw new Error('请选择旧版数据目录。');
    return management('worlds/import-directory', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ directory }) });
  });
  handle('rpgmap:launch-world', async worldId => {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(worldId) || worldId.endsWith('.')) throw new Error('World ID 无效。');
    try {
      prepareRestartCompletion();
      const activated = await management('worlds/activate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ worldId }) });
      if (activated.restartRequired) await restartCompletion;
      else restartResolve?.();
      await window.loadURL(await currentGameUrl());
      return { launched: true };
    } finally {
      restartResolve?.();
      restartCompletion = null;
      restartResolve = null;
      restartReject = null;
    }
  });
  handle('rpgmap:show-setup', async () => {
    await window.loadURL(`${origin}/setup`);
    return { opened: true };
  });
  handle('rpgmap:set-port', async port => {
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('端口必须是 1024–65535 的整数。');
    try {
      prepareRestartCompletion();
      const changed = await management('settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ port }) });
      if (changed.restartRequired) await restartCompletion;
      else restartResolve?.();
      await window.loadURL(`${origin}/setup`);
      return { port, updated: true };
    } finally {
      restartResolve?.();
      restartCompletion = null; restartResolve = null; restartReject = null;
    }
  });
  handle('rpgmap:open-browser', async () => {
    await shell.openExternal(await currentGameUrl());
    return { opened: true };
  });
  handle('rpgmap:exit', async () => {
    app.quit();
    return { closing: true };
  });
  handle('rpgmap:install-update', async () => {
    const selection = await dialog.showOpenDialog(window, {
      title: '选择新版 RPGmap 安装器', properties: ['openFile'],
      filters: [{ name: 'RPGmap 安装器', extensions: ['exe'] }],
    });
    if (selection.canceled || !selection.filePaths[0]) return { canceled: true };
    const selected = selection.filePaths[0];
    const filename = path.basename(selected);
    if (!/^RPGmap-Setup-\d+\.\d+\.\d+(?:-[a-zA-Z0-9.]+)?\.exe$/.test(filename)) throw new Error('请选择正式命名的 RPGmap-Setup-版本号.exe。');
    const checksum = await readFile(path.join(path.dirname(selected), 'SHA256SUMS.txt'), 'utf8').catch(() => '');
    const record = checksum.split(/\r?\n/).map(line => /^([a-f0-9]{64})\s+\*?(.+)$/i.exec(line.trim())).find(match => match?.[2] === filename);
    if (!record) throw new Error('安装器目录缺少对应 SHA256SUMS.txt 校验记录。');
    const bytes = await readFile(selected);
    if (bytes[0] !== 0x4d || bytes[1] !== 0x5a || createHash('sha256').update(bytes).digest('hex') !== record[1].toLowerCase()) throw new Error('安装器校验失败，请重新下载完整交付文件。');
    const accepted = await dialog.showMessageBox(window, {
      type: 'question', buttons: ['保存并运行安装器', '取消'], defaultId: 1, cancelId: 1,
      title: '升级 RPGmap', message: `运行 ${filename}？`,
      detail: '已检查文件完整性。请使用可信来源提供的安装器；哈希校验不能确认发布者身份。RPGmap 将正常停服并保存用户数据，然后打开安装器。',
    });
    if (accepted.response !== 0) return { canceled: true };
    pendingInstaller = selected;
    app.quit();
    return { closing: true };
  });
}

function pipeLog(stream, name) {
  if (!stream) return;
  let pending = '';
  stream.setEncoding('utf8');
  stream.on('data', chunk => {
    pending += chunk;
    let newline;
    while ((newline = pending.indexOf('\n')) >= 0) {
      log(`${name}: ${pending.slice(0, newline).replace(/\r$/, '')}`);
      pending = pending.slice(newline + 1);
    }
    if (pending.length > 32768) {
      log(`${name}: [overlong log line omitted]`);
      pending = '';
    }
  });
  stream.on('end', () => { if (pending) log(`${name}: ${pending}`); });
}

async function startServer(worldId, requestedPort) {
  await stat(paths.serverEntry);
  await stat(path.join(paths.staticDir, 'index.html'));
  let settings = {};
  try { settings = JSON.parse(await readFile(path.join(paths.configurationDir, 'settings.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error(`无法读取端口设置：${error.message}`); }
  const configuredPort = Number(requestedPort ?? process.env.RPGMAP_PORT ?? settings.port ?? 30000);
  if (!Number.isInteger(configuredPort) || configuredPort < 0 || configuredPort > 65535) throw new Error('RPGmap 端口无效。');
  const child = utilityProcess.fork(paths.serverEntry, [], {
    cwd: paths.serverDir,
    serviceName: 'RPGmap Local Server',
    stdio: 'pipe',
    env: {
      ...process.env,
      HOST: '0.0.0.0', PORT: String(configuredPort),
      RPGMAP_DESKTOP: '1',
      RPGMAP_DATA_DIR: paths.dataRoot,
      RPGMAP_STATIC_DIR: paths.staticDir,
      RPGMAP_PUBLIC_DIR: paths.staticDir,
      RPGMAP_PACKAGE_ROOT: paths.serverDir,
      RPGMAP_MANAGER_SECRET: managerSecret,
      RPGMAP_GM_SECRET: gmSecret,
      ...(worldId ? { RPGMAP_WORLD_ID: worldId } : {}),
    },
  });
  server = child;
  pipeLog(child.stdout, 'server');
  pipeLog(child.stderr, 'server error');
  child.on('exit', code => {
    log(`server exit: ${code}`);
    if (!shuttingDown && !restarting && window) {
      restartReject?.(new Error(`本地服务意外退出，退出码 ${code}。`));
      dialog.showMessageBox(window, { type: 'error', title: 'RPGmap 服务已停止', message: '本地服务已停止。请重新启动 RPGmap，存档将从持久化数据恢复。', detail: `退出码：${code}\n日志目录：${paths.logsDir}` });
    }
  });
  child.on('message', message => {
    if (message?.type === 'rpgmap:restart'
      && (!message.worldId || /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(message.worldId))
      && (message.port === undefined || Number.isInteger(message.port) && message.port >= 0 && message.port <= 65535)) {
      superviseRestart(child, message.worldId, message.port).catch(error => {
        log(`Restart failed: ${error.stack || error.message}`);
        restartReject?.(error);
        restarting = false;
        dialog.showErrorBox('World 启动失败', `${error.message}\n请重新打开 RPGmap。`);
      });
    }
  });
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { cleanup(); reject(new Error('本地服务启动超时，请查看日志。')); }, 60000);
    const onExit = code => { cleanup(); reject(new Error(`本地服务启动失败，退出码 ${code}。`)); };
    const onMessage = message => {
      if (message?.type !== 'rpgmap:ready') return;
      if (!Number.isInteger(message.port) || message.port < 1 || message.port > 65535) return;
      cleanup();
      resolve(`http://127.0.0.1:${message.port}`);
    };
    function cleanup() { clearTimeout(timeout); child.removeListener('exit', onExit); child.removeListener('message', onMessage); }
    child.once('exit', onExit);
    child.on('message', onMessage);
  });
}

async function authorizeDesktopSession() {
  await session.fromPartition('persist:rpgmap-desktop').cookies.set({
    url: origin, name: 'rpgmap_manager', value: managerSecret,
    path: '/', httpOnly: true, secure: false, sameSite: 'strict',
  });
}

async function superviseRestart(child, worldId, port) {
  if (restarting || shuttingDown) return;
  restarting = true;
  log(`Restarting service: world=${worldId || 'catalog'} port=${port ?? 'configured'}; waiting for persistence.`);
  await stopUtilityProcess(child, { onTimeout: () => log('World switch graceful stop timed out.') });
  if (shuttingDown) return;
  origin = await startServer(worldId, port);
  await authorizeDesktopSession();
  restarting = false;
  if (restartResolve) restartResolve();
  else await window?.loadURL(`${origin}/setup`);
  log(`World ready: ${worldId}`);
}

async function createWindow() {
  const desktopSession = session.fromPartition('persist:rpgmap-desktop');
  desktopSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  desktopSession.setPermissionCheckHandler(() => false);
  // HTTP cookies are host-scoped, not port-scoped. Never forward the launcher
  // credential to an unrelated service running on another loopback port.
  desktopSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = { ...details.requestHeaders };
    if (!isLocalApplicationUrl(details.url, origin)) {
      for (const key of Object.keys(headers)) {
        if (key.toLowerCase() === 'cookie') headers[key] = String(headers[key]).split(';').filter(item => !/^\s*rpgmap_manager=/.test(item)).join(';');
      }
    }
    callback({ requestHeaders: headers });
  });
  await authorizeDesktopSession();
  window = new BrowserWindow({
    width: 1440, height: 900, minWidth: 960, minHeight: 640,
    title: `RPGmap ${app.getVersion()}`, backgroundColor: '#f2eee6', show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      session: desktopSession,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, target) => { if (!isLocalApplicationUrl(target, origin)) event.preventDefault(); });
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.on('close', event => {
    if (!quitReady) { event.preventDefault(); app.quit(); }
  });
  window.on('closed', () => { window = null; });
  window.once('ready-to-show', () => { if (!(process.env.NODE_ENV === 'test' && process.env.RPGMAP_TEST_HIDE_WINDOW === '1')) window?.show(); });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'RPGmap', submenu: [
      { label: '返回管理首页', click: () => window?.loadURL(`${origin}/setup`) },
      { label: '打开用户数据目录', click: () => shell.openPath(paths.dataRoot) },
      { type: 'separator' }, { label: '退出', click: () => app.quit() },
    ] },
    { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: '显示', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] },
  ]));
  registerBridge();
  await window.loadURL(`${origin}/setup`);
}

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  log('Closing local service; waiting for persistence.');
  window?.webContents.send('rpgmap:closing');
  await stopUtilityProcess(server, { onTimeout: () => log('Graceful stop timed out; preserving the service and blocking exit/update.') });
  log('Desktop shutdown complete.');
  if (logStream) await new Promise(resolve => logStream.end(resolve));
  if (pendingInstaller) {
    const installer = spawn(pendingInstaller, [], { detached: true, stdio: 'ignore', windowsHide: true });
    installer.on('error', error => dialog.showErrorBox('安装器无法启动', error.message));
    installer.unref();
  }
  quitReady = true;
  app.quit();
}

function handleShutdownFailure(error) {
  log(`Desktop shutdown blocked: ${error.stack || error.message}`);
  shuttingDown = false;
  pendingInstaller = null;
  dialog.showErrorBox('RPGmap 尚未完成保存', `${error.message}\n程序未启动安装器。${paths ? `\n日志目录：${paths.logsDir}` : ''}`);
  window?.show();
  window?.focus();
}

function handleSecondInstance(_event, commandLine) {
  if (commandLine.includes('--rpgmap-exit-existing')) {
    app.quit();
    return;
  }
  if (window?.isMinimized()) window.restore();
  window?.show();
  window?.focus();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', handleSecondInstance);
  app.on('before-quit', event => { if (!quitReady) { event.preventDefault(); shutdown().catch(handleShutdownFailure); } });
  app.on('window-all-closed', () => app.quit());
  app.whenReady().then(async () => {
    paths = resolveDesktopPaths({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, projectRoot: path.resolve(__dirname, '..'), env: process.env, electronUserData: app.getPath('userData') });
    await mkdir(paths.logsDir, { recursive: true });
    await mkdir(paths.configurationDir, { recursive: true });
    app.setPath('userData', paths.configurationDir);
    logStream = createWriteStream(path.join(paths.logsDir, `desktop-${new Date().toISOString().slice(0, 10)}.log`), { flags: 'a' });
    log(`RPGmap ${app.getVersion()} | data=${paths.dataRoot} | resources=${paths.runtimeRoot}`);
    const receipt = await verifyInstalledPayload({
      manifestPath: path.join(app.isPackaged ? paths.runtimeRoot : path.dirname(paths.runtimeRoot), 'INSTALL-MANIFEST.json'),
      runtimeRoot: paths.runtimeRoot,
      applicationRoot: app.isPackaged ? app.getAppPath() : path.join(path.dirname(paths.runtimeRoot), 'application'),
      version: app.getVersion(),
    });
    origin = await startServer();
    await createWindow();
    await management('catalog');
    const readyRecord = path.join(paths.configurationDir, 'last-successful-program.json');
    await writeFile(`${readyRecord}.tmp`, `${JSON.stringify({ ...receipt, at: new Date().toISOString(), applicationDirectory: path.dirname(paths.runtimeRoot) }, null, 2)}\n`);
    await rename(`${readyRecord}.tmp`, readyRecord);
    log(`Program startup check passed: ${receipt.files} files, ${receipt.manifestSha256}`);
  }).catch(async error => {
    log(error.stack || error.message);
    dialog.showErrorBox('RPGmap 无法启动', `${error.message}\n${paths ? `日志目录：${paths.logsDir}` : ''}`);
    await shutdown();
  });
}
