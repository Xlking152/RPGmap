import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { assertDesktopPayloadPath, verifyDesktopStage } from '../scripts/verify-desktop-package.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { resolveDesktopPaths, isLocalApplicationUrl, redactLogLine, stopUtilityProcess, verifyInstalledPayload } = require('../desktop/runtime-paths.cjs');

test('desktop data is per-user and cannot share the program resources directory', () => {
  const configuration = resolveDesktopPaths({ packaged: true, resourcesPath: path.join(tmpdir(), 'installed-program', 'resources'), projectRoot: root, env: { LOCALAPPDATA: path.join(tmpdir(), 'account') } });
  assert.equal(configuration.dataRoot, path.join(tmpdir(), 'account', 'RPGmap', 'UserData'));
  assert.equal(configuration.serverEntry, path.join(tmpdir(), 'installed-program', 'resources', 'server', 'server.mjs'));
  assert.throws(() => resolveDesktopPaths({ packaged: true, resourcesPath: path.join(tmpdir(), 'program', 'resources'), projectRoot: root, env: { RPGMAP_DATA_DIR: path.join(tmpdir(), 'program', 'user') } }), /不能位于程序资源目录/);
});

test('desktop navigation accepts only its exact loopback origin', () => {
  const origin = 'http://127.0.0.1:30000';
  assert.equal(isLocalApplicationUrl(`${origin}/#gmSecret=private`, origin), true);
  for (const target of ['https://127.0.0.1:30000/', 'http://127.0.0.1:30001/', 'http://localhost:30000/', 'file:///C:/secret', 'http://127.0.0.1.evil.test:30000/', 'javascript:alert(1)']) {
    assert.equal(isLocalApplicationUrl(target, origin), false, target);
  }
});

test('desktop log lines redact both injected credentials and printed legacy codes', () => {
  assert.equal(redactLogLine('GET secretValue / GMSecret : 42', ['secretValue']), 'GET [REDACTED] / GMSecret : [REDACTED]');
  assert.equal(redactLogLine(' JoinCode : AABB'), ' JoinCode : [REDACTED]');
});

test('desktop shutdown waits for the utility server exit after requesting persistence', async () => {
  const child = new EventEmitter();
  child.pid = 10;
  child.postMessage = message => {
    assert.deepEqual(message, { type: 'rpgmap:shutdown' });
    setTimeout(() => { child.pid = undefined; child.emit('exit', 0); }, 10);
  };
  child.kill = () => assert.fail('正常退出不应强制关闭进程');
  const result = await stopUtilityProcess(child, { timeoutMs: 200 });
  assert.deepEqual(result, { stopped: true, forced: false });
  assert.equal(child.listenerCount('exit'), 0);
});

test('desktop shutdown blocks replacement and preserves a stalled server', async () => {
  const child = new EventEmitter();
  child.pid = 10;
  child.postMessage = () => {};
  let killed = false;
  child.kill = () => { killed = true; };
  await assert.rejects(stopUtilityProcess(child, { timeoutMs: 10 }), /尚未完成保存/);
  assert.equal(killed, false, 'pending persistence must never be terminated for an upgrade');
  assert.equal(child.listenerCount('exit'), 0);
});

test('desktop shutdown refuses to treat an abnormal server exit or broken IPC as a completed flush', async () => {
  const failed = new EventEmitter();
  failed.pid = 10;
  failed.postMessage = () => setTimeout(() => failed.emit('exit', 1), 5);
  failed.kill = () => assert.fail('不能为完成更新强制结束本地服务');
  await assert.rejects(stopUtilityProcess(failed, { timeoutMs: 200 }), /未正常退出/);
  assert.equal(failed.listenerCount('exit'), 0);
  failed.postMessage = () => { throw new Error('IPC disconnected'); };
  await assert.rejects(stopUtilityProcess(failed, { timeoutMs: 200 }), /IPC disconnected/);
  assert.equal(failed.listenerCount('exit'), 0);
});

test('preload exposes bounded launcher operations without filesystem or raw IPC access', async () => {
  const source = await readFile(path.join(root, 'desktop', 'preload.cjs'), 'utf8');
  let exposed;
  const invoked = [];
  vm.runInNewContext(source, {
    require: id => {
      assert.equal(id, 'electron');
      return {
        contextBridge: { exposeInMainWorld: (name, api) => { assert.equal(name, 'rpgmapDesktop'); exposed = api; } },
        ipcRenderer: { invoke: (channel, ...args) => { invoked.push([channel, ...args]); return Promise.resolve(); } },
      };
    },
  });
  assert.equal(Object.isFrozen(exposed), true);
  assert.deepEqual(Object.keys(exposed).sort(), ['exit', 'importLegacyDirectory', 'importPackage', 'importWorld', 'installUpdate', 'launchWorld', 'openDataDirectory', 'openGameInBrowser', 'setPort', 'showSetup'].sort());
  await exposed.launchWorld('world-test');
  await exposed.importPackage('map');
  await exposed.importLegacyDirectory('C:/private-do-not-read');
  assert.deepEqual(invoked, [['rpgmap:launch-world', 'world-test'], ['rpgmap:import-package', 'map'], ['rpgmap:import-legacy-directory']]);
  for (const forbidden of ['readFile', 'writeFile', 'exec', 'spawn', 'ipcRenderer', 'send', 'invoke', 'require']) assert.equal(exposed[forbidden], undefined);
});

test('native package import displays inspected identity and compatibility before the installation request', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rpgmap-import-preview-'));
  try {
    const selected = path.join(directory, 'trusted.rpgrules');
    const bytes = Buffer.from('selected package bytes');
    await writeFile(selected, bytes);
    let accepted = false;
    const calls = [], dialogs = [];
    const preview = { kind: 'ruleset', title: '最小测试规则', id: 'minimal-test', version: '1.0.0', compatibility: { formatVersion: 1, rulesetApiVersion: 1 }, filesCount: 2 };
    const electron = {
      app: { setName() {}, setAppUserModelId() {}, requestSingleInstanceLock: () => false, quit() {} },
      dialog: {
        showOpenDialog: async () => ({ canceled: false, filePaths: [selected] }),
        showMessageBox: async (_window, options) => { dialogs.push(options); return { response: accepted ? 0 : 1 }; },
      },
    };
    const context = {
      require: id => id === 'electron' ? electron : require(id === './runtime-paths.cjs' ? '../desktop/runtime-paths.cjs' : id),
      module: { exports: {} }, __dirname: path.join(root, 'desktop'), process, Buffer, URL, setTimeout, clearTimeout,
      fetch: async (url, options) => {
        calls.push(url);
        assert.equal(options.method, 'POST');
        assert.deepEqual(options.body, bytes, 'inspect and install must use the same selected bytes');
        return { ok: true, json: async () => url.endsWith('/inspect') ? preview : { installed: true } };
      },
    };
    const source = await readFile(path.join(root, 'desktop', 'main.cjs'), 'utf8');
    vm.runInNewContext(`${source}\nmodule.exports = {pickImport,setOrigin(){origin='http://127.0.0.1:30000';}};`, context);
    context.module.exports.setOrigin();
    assert.equal((await context.module.exports.pickImport('ruleset')).canceled, true);
    assert.deepEqual(calls, ['http://127.0.0.1:30000/api/manage/rulesets/inspect']);
    assert.equal(dialogs[0].message, '最小测试规则');
    assert.match(dialogs[0].detail, /minimal-test.*\n版本：1\.0\.0/);
    assert.match(dialogs[0].detail, /rulesetApiVersion.*\n文件数：2/);
    assert.match(dialogs[0].detail, /信任作者.*执行规则代码/);
    assert.equal(dialogs[0].cancelId, 1);
    accepted = true;
    assert.equal((await context.module.exports.pickImport('ruleset')).installed, true);
    assert.deepEqual(calls.slice(1), ['http://127.0.0.1:30000/api/manage/rulesets/inspect', 'http://127.0.0.1:30000/api/manage/rulesets']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('desktop main frame validates IPC sender and keeps browser privileges disabled', async () => {
  const source = await readFile(path.join(root, 'desktop', 'main.cjs'), 'utf8');
  const handlers = new Map();
  let options;
  let browser;
  let cookie;
  let beforeSendHeaders;
  let requestedQuit = 0;
  const errors = [];
  class MockWindow extends EventEmitter {
    constructor(configuration) {
      super(); options = configuration; browser = this;
      this.webContents = new EventEmitter();
      this.webContents.mainFrame = { url: 'http://127.0.0.1:30000/setup' };
      this.webContents.setWindowOpenHandler = fn => { this.popup = fn; };
    }
    async loadURL(url) { this.url = url; }
    show() { this.visible = true; }
    focus() { this.focused = true; }
  }
  const fakeSession = { cookies: { set: async value => { cookie = value; } }, webRequest: { onBeforeSendHeaders: fn => { beforeSendHeaders = fn; } }, setPermissionRequestHandler() {}, setPermissionCheckHandler() {} };
  const electron = {
    app: { setName() {}, setAppUserModelId() {}, requestSingleInstanceLock: () => false, quit() { requestedQuit += 1; }, getVersion: () => '3.0.0-rc.1' },
    BrowserWindow: MockWindow,
    session: { fromPartition: () => fakeSession },
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    Menu: { setApplicationMenu() {}, buildFromTemplate: template => template },
    shell: { openPath: async () => '' }, dialog: { showErrorBox: (...args) => errors.push(args) }, utilityProcess: {},
  };
  const context = {
    require: id => id === 'electron' ? electron : id === './runtime-paths.cjs' ? { resolveDesktopPaths, isLocalApplicationUrl, redactLogLine, stopUtilityProcess } : require(id),
    module: { exports: {} }, __dirname: path.join(root, 'desktop'), process, Buffer, URL, setTimeout, clearTimeout,
  };
  vm.runInNewContext(`${source}\nmodule.exports = { createWindow, handleSecondInstance, handleShutdownFailure, setTestContext() { origin = 'http://127.0.0.1:30000'; paths = { dataRoot: '/user-data' }; }, setFailedShutdown() { shuttingDown = true; pendingInstaller = '/installer.exe'; }, quitState() { return { shuttingDown, pendingInstaller, quitReady }; } };`, context);
  context.module.exports.setTestContext();
  await context.module.exports.createWindow();
  assert.equal(options.webPreferences.nodeIntegration, false);
  assert.equal(options.webPreferences.contextIsolation, true);
  assert.equal(options.webPreferences.sandbox, true);
  assert.equal(options.webPreferences.webSecurity, true);
  assert.equal(cookie.httpOnly, true);
  assert.equal(cookie.sameSite, 'strict');
  assert.equal(browser.popup().action, 'deny');
  beforeSendHeaders({ url: 'http://127.0.0.1:30001/', requestHeaders: { Cookie: 'normal=x; rpgmap_manager=secret' } }, result => assert.equal(result.requestHeaders.Cookie, 'normal=x'));
  beforeSendHeaders({ url: 'http://127.0.0.1:30000/api/manage/catalog', requestHeaders: { Cookie: 'rpgmap_manager=secret' } }, result => assert.equal(result.requestHeaders.Cookie, 'rpgmap_manager=secret'));
  const openData = handlers.get('rpgmap:open-data');
  await assert.rejects(openData({ sender: {}, senderFrame: {} }), /主窗口/);
  await assert.rejects(openData({ sender: browser.webContents, senderFrame: { url: 'http://127.0.0.1:30000/setup' } }), /主窗口/);
  await openData({ sender: browser.webContents, senderFrame: browser.webContents.mainFrame });
  const beforeQuit = requestedQuit;
  context.module.exports.handleSecondInstance(null, ['RPGmap.exe', '--rpgmap-exit-existing']);
  assert.equal(requestedQuit, beforeQuit + 1, 'installer shutdown request uses the normal application quit lifecycle');
  let closePrevented = false;
  browser.emit('close', { preventDefault() { closePrevented = true; } });
  assert.equal(closePrevented, true, 'keep the window alive until its service has completed persistence');
  const beforeFailure = requestedQuit;
  context.module.exports.setFailedShutdown();
  context.module.exports.handleShutdownFailure(new Error('flush stalled'));
  const quitState = context.module.exports.quitState();
  assert.equal(quitState.shuttingDown, false);
  assert.equal(quitState.pendingInstaller, null);
  assert.equal(quitState.quitReady, false);
  assert.equal(requestedQuit, beforeFailure, 'failed persistence must not continue to app.quit');
  assert.equal(browser.visible, true);
  assert.equal(browser.focused, true);
  assert.match(errors.at(-1)[1], /flush stalled/);
});

test('desktop package allowlist excludes campaign data, raw maps and source maps', () => {
  for (const permitted of ['application/desktop/main.cjs', 'resources/server/server.mjs', 'resources/app/assets/index-A123.js', 'resources/app/index.html']) assert.doesNotThrow(() => assertDesktopPayloadPath(permitted));
  for (const forbidden of ['resources/app/assets/runtime.svg', 'resources/app/assets/lanzhou-123.json', 'resources/app/assets/file.js.map', 'resources/server/map/world.json', 'resources/maps/lanzhou.rpgmap', 'application/node_modules/library/a.js', '../escape.mjs']) assert.throws(() => assertDesktopPayloadPath(forbidden));
});

test('desktop stage checksum catches modified program payloads', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rpgmap-desktop-stage-'));
  try {
    await mkdir(path.join(directory, 'application', 'desktop'), { recursive: true });
    const contents = Buffer.from('original');
    await writeFile(path.join(directory, 'application', 'desktop', 'main.cjs'), contents);
    await writeFile(path.join(directory, 'INSTALL-MANIFEST.json'), JSON.stringify({
      format: 1, appId: 'org.rpgmap.desktop', version: '3.0.0-rc.1', source: { commit: '0'.repeat(40) },
      files: { 'application/desktop/main.cjs': { bytes: contents.length, sha256: createHash('sha256').update(contents).digest('hex') } },
    }));
    await writeFile(path.join(directory, 'application', 'desktop', 'main.cjs'), 'modified');
    await assert.rejects(verifyDesktopStage(directory), /文件校验失败/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('desktop stage binds server VERSION, desktop version and every persistence contract to its manifest', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rpgmap-desktop-contract-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = { app: 'RPGmap', version: '3.0.0', releaseTag: 'v3.0.0', commit: 'a'.repeat(40),
    worldSchema: 4, operationSchema: 4, statusSchema: 4, accessSchema: 4, occlusionSchema: 1, mapArchiveFormat: 1 };
  const writeStage = async ({ declared = source, server = declared, appVersion = '3.0.0' } = {}) => {
    const payload = {
      'application/package.json': JSON.stringify({ version: appVersion, main: 'desktop/main.cjs' }),
      'application/desktop/main.cjs': 'module.exports = {};',
      'application/desktop/preload.cjs': 'module.exports = {};',
      'resources/app/index.html': '<!doctype html><title>RPGmap</title>',
      'resources/server/server.mjs': 'export const server = true;',
      'resources/server/exploration-worker.mjs': 'export const worker = true;',
      'resources/server/VERSION.json': JSON.stringify(server),
    };
    const files = {};
    for (const [file, text] of Object.entries(payload)) {
      const bytes = Buffer.from(text), target = path.join(directory, ...file.split('/'));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, bytes);
      files[file] = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    }
    await writeFile(path.join(directory, 'INSTALL-MANIFEST.json'), JSON.stringify({
      format: 1, appId: 'org.rpgmap.desktop', version: '3.0.0', source: declared, files,
    }));
  };
  await writeStage();
  assert.equal((await verifyDesktopStage(directory)).version, '3.0.0');
  await writeStage({ server: { ...source, commit: 'b'.repeat(40) } });
  await assert.rejects(verifyDesktopStage(directory), /VERSION.*源身份不一致/);
  for (const schema of ['worldSchema', 'operationSchema', 'statusSchema', 'accessSchema']) {
    await writeStage({ declared: { ...source, [schema]: 3 } });
    await assert.rejects(verifyDesktopStage(directory), new RegExp(`${schema} 必须为 4`));
  }
  for (const format of ['occlusionSchema', 'mapArchiveFormat']) {
    await writeStage({ declared: { ...source, [format]: 2 } });
    await assert.rejects(verifyDesktopStage(directory), /契约格式错误/);
  }
  await writeStage({ declared: { ...source, version: '3.0.1' } });
  await assert.rejects(verifyDesktopStage(directory), /版本或标签/);
  await writeStage({ declared: { ...source, releaseTag: 'v3.0.0-rc.3' } });
  await assert.rejects(verifyDesktopStage(directory), /版本或标签/);
  await writeStage({ appVersion: '3.0.0-rc.3' });
  await assert.rejects(verifyDesktopStage(directory), /桌面应用版本/);
});

test('installer retains user data and uses a stable per-user identity', () => {
  const configuration = require('../desktop/builder.config.cjs');
  assert.equal(configuration.appId, 'org.rpgmap.desktop');
  assert.equal(configuration.asar, true);
  assert.equal(configuration.nsis.perMachine, false);
  assert.equal(configuration.nsis.deleteAppDataOnUninstall, false);
  assert.equal(configuration.nsis.allowElevation, false);
  assert.equal(configuration.win.target[0].target, 'nsis');
  assert.equal(configuration.productName, 'RPGmap');
  assert.equal(configuration.executableName, 'RPGmap');
  assert.equal(configuration.win.signExecutable, false, 'unsigned development releases retain PE resource editing');
  assert.notEqual(configuration.win.signAndEditExecutable, false, 'disabling resource editing would retain Electron product metadata');
  assert.notEqual(configuration.forceCodeSigning, true, 'building the launcher must not require a signing certificate');
});

test('setup distinguishes built-in rules and handles reference-protected external rule removal', async () => {
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.dataset = {}; this.style = {}; this.attributes = {}; this.listeners = new Map(); }
    setAttribute(name, value) { this.attributes[name] = value; }
    addEventListener(name, listener) { this.listeners.set(name, listener); }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    async click() { await this.listeners.get('click')?.({}); }
  }
  const descendants = node => [node, ...node.children.flatMap(descendants)];
  const container = new Element('div');
  const catalog = {
    maps: [], worlds: [],
    rulesets: [
      { id: 'infinite-horror', version: '1.1.0', name: '无限', builtIn: true },
      { id: 'minimal-test', version: '1.0.0', name: '测试规则', builtIn: false },
    ],
  };
  let referenced = true;
  const deletions = [];
  const source = await readFile(path.join(root, 'src', 'app', 'desktop-setup.js'), 'utf8');
  const context = {
    document: { createElement: tag => new Element(tag), title: '' },
    location: { href: 'http://127.0.0.1:30000/setup', origin: 'http://127.0.0.1:30000', port: '30000' },
    URL, globalThis: {}, module: { exports: {} }, confirm: () => true,
  };
  vm.runInNewContext(`${source.replace(/^import .*;\r?\n/gm, '').replace('export async function startDesktopSetup', 'async function startDesktopSetup')}\nmodule.exports = { startDesktopSetup };`, context);
  await context.module.exports.startDesktopSetup({ container, fetchImpl: async (url, options) => {
    if (options.method === 'DELETE') {
      deletions.push(url);
      if (referenced) return { ok: false, status: 409, json: async () => ({ error: '规则被引用', references: [{ worldId: 'world-active', backupId: 'backup-1' }] }) };
      catalog.rulesets.pop();
      return { ok: true, json: async () => ({ removed: true }) };
    }
    assert.equal(url, '/api/manage/catalog');
    return { ok: true, json: async () => structuredClone(catalog) };
  } });
  const rows = () => descendants(container).filter(node => node.tag === 'article');
  const row = name => rows().find(node => descendants(node).some(child => child.tag === 'h3' && child.textContent === name));
  assert.equal(descendants(row('无限')).some(node => node.textContent?.includes('随程序预置')), true);
  assert.equal(descendants(row('无限')).some(node => node.tag === 'button'), false);
  const remove = descendants(row('测试规则')).find(node => node.tag === 'button' && node.textContent === '卸载');
  assert.ok(remove);
  await remove.click();
  const status = descendants(container).find(node => node.attributes.role === 'status');
  assert.match(status.textContent, /规则被引用.*world-active.*恢复点 backup-1/);
  assert.equal(status.dataset.error, 'true');
  assert.ok(row('测试规则'), 'rejected removal keeps the registered rule visible');
  referenced = false;
  await remove.click();
  assert.deepEqual(deletions, [
    '/api/manage/rulesets?id=minimal-test&version=1.0.0',
    '/api/manage/rulesets?id=minimal-test&version=1.0.0',
  ]);
  assert.equal(row('测试规则'), undefined, 'successful removal refreshes the package catalog');
  assert.equal(status.dataset.error, 'false');
});

test('browser package import requires an inspected preview and cancellation never installs the archive', async () => {
  const nodes = [];
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.dataset = {}; this.style = {}; this.listeners = new Map(); nodes.push(this); }
    setAttribute(name, value) { this[name] = value; }
    addEventListener(name, listener) { this.listeners.set(name, listener); }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    async click() { await this.listeners.get('click')?.({}); }
  }
  const container = new Element('div'), calls = [], dialogs = [];
  const bytes = new Uint8Array([1, 2, 3]).buffer;
  let accepted = false;
  const source = await readFile(path.join(root, 'src', 'app', 'desktop-setup.js'), 'utf8');
  const context = {
    document: { createElement: tag => new Element(tag), title: '' },
    location: { href: 'http://127.0.0.1:30000/setup', origin: 'http://127.0.0.1:30000', port: '30000' },
    URL, globalThis: {}, module: { exports: {} }, confirm: message => { dialogs.push(message); return accepted; },
  };
  vm.runInNewContext(`${source.replace(/^import .*;\r?\n/gm, '').replace('export async function startDesktopSetup', 'async function startDesktopSetup')}\nmodule.exports = { startDesktopSetup };`, context);
  await context.module.exports.startDesktopSetup({ container, fetchImpl: async (url, options) => {
    if (options.method === 'GET') return { ok: true, json: async () => ({ maps: [], rulesets: [], worlds: [] }) };
    calls.push(url);
    assert.equal(options.body, bytes);
    return { ok: true, json: async () => url.endsWith('/inspect')
      ? { title: '测试规则', id: 'test-rules', version: '2.0.0', filesCount: 4, compatibility: { rulesetApiVersion: 1 } }
      : { installed: true } };
  } });
  const button = nodes.find(node => node.tag === 'button' && node.textContent === '导入规则');
  const attempt = async () => {
    const action = button.click();
    const input = nodes.findLast(node => node.tag === 'input' && node.type === 'file');
    input.files = [{ arrayBuffer: async () => bytes }];
    await input.listeners.get('change')();
    await action;
  };
  await attempt();
  assert.deepEqual(calls, ['/api/manage/rulesets/inspect']);
  assert.match(dialogs[0], /测试规则.*\nID：test-rules.*\n版本：2\.0\.0/);
  assert.match(dialogs[0], /rulesetApiVersion.*\n文件数：4/);
  assert.match(dialogs[0], /信任作者.*执行规则代码/);
  accepted = true;
  await attempt();
  assert.deepEqual(calls.slice(1), ['/api/manage/rulesets/inspect', '/api/manage/rulesets']);
});

test('desktop startup detects a corrupted or traversing installation before starting its server', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rpgmap-desktop-verify-'));
  try {
    const runtimeRoot = path.join(directory, 'resources');
    await mkdir(path.join(runtimeRoot, 'server'), { recursive: true });
    const source = Buffer.from('valid server');
    await writeFile(path.join(runtimeRoot, 'server', 'server.mjs'), source);
    const manifestPath = path.join(runtimeRoot, 'INSTALL-MANIFEST.json');
    const manifest = { format: 1, appId: 'org.rpgmap.desktop', version: '3.0.0-rc.1', files: {
      'resources/server/server.mjs': { bytes: source.length, sha256: createHash('sha256').update(source).digest('hex') },
    } };
    await writeFile(manifestPath, JSON.stringify(manifest));
    const configuration = { manifestPath, runtimeRoot, applicationRoot: path.join(directory, 'app.asar'), version: '3.0.0-rc.1' };
    assert.equal((await verifyInstalledPayload(configuration)).files, 1);
    await writeFile(path.join(runtimeRoot, 'server', 'server.mjs'), 'corrupted');
    await assert.rejects(verifyInstalledPayload(configuration), /程序文件校验失败/);
    manifest.files = { 'resources/../../private': { bytes: 0, sha256: '0'.repeat(64) } };
    await writeFile(manifestPath, JSON.stringify(manifest));
    await assert.rejects(verifyInstalledPayload(configuration), /越界文件/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
