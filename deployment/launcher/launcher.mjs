import http from 'node:http';
import { createReadStream } from 'node:fs';
import { access, chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { randomBytes, randomInt } from 'node:crypto';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LauncherAdminClient } from './admin-client.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(process.env.RPGMAP_PACKAGE_ROOT || path.join(ROOT, '..'));
const UI_DIR = ROOT;
const GAME_PORT = Math.max(1, Number(process.env.RPGMAP_GAME_PORT || 30000) || 30000);
const PREFERRED_LAUNCHER_PORT = Math.max(1, Number(process.env.RPGMAP_LAUNCHER_PORT || 29999) || 29999);
const LAUNCHER_HOST = '127.0.0.1';
const APP_DIR = path.resolve(process.env.RPGMAP_PUBLIC_DIR || path.join(PACKAGE_ROOT, 'app'));
const WORLD_DIR = path.resolve(process.env.RPGMAP_WORLD_DIR || path.join(PACKAGE_ROOT, 'world'));
const MAPS_DIR = path.resolve(process.env.RPGMAP_MAPS_DIR || path.join(PACKAGE_ROOT, 'maps'));
const TOOLS_DIR = path.resolve(process.env.RPGMAP_TOOLS_DIR || path.join(PACKAGE_ROOT, 'tools'));
const SERVER_ENTRY = path.resolve(process.env.RPGMAP_SERVER_ENTRY || path.join(PACKAGE_ROOT, 'server', 'server.mjs'));
const VERSION_FILE = path.join(PACKAGE_ROOT, 'VERSION.json');
const AUTH_TOKEN = randomBytes(32).toString('hex');
const MAX_BODY = 1024 * 1024;
const MAX_LOG_LINES = 400;
const LAUNCHER_PORT_CANDIDATES = [...new Set([
  PREFERRED_LAUNCHER_PORT,
  29998,
  29997,
  29996,
  29995,
])].filter(port => port > 0 && port <= 65535 && port !== GAME_PORT);
let launcherPortIndex = 0;
let launcherPort = LAUNCHER_PORT_CANDIDATES[0] || PREFERRED_LAUNCHER_PORT;
let usingAutomaticLauncherPort = false;

const MIME = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.ico', 'image/x-icon'],
]);

let version = { app: 'RPGmap', version: '1.4.3', commit: 'unknown' };
try { version = JSON.parse(await readFile(VERSION_FILE, 'utf8')); } catch {}

const runtime = {
  mode: 'stopped',
  server: null,
  tunnel: null,
  admin: null,
  starting: false,
  stopping: false,
  startedAt: null,
  publicUrl: null,
  joinCode: null,
  gmSecret: null,
  cloudflaredPath: null,
  health: null,
  lastError: null,
  logs: [],
};

function log(source, line) {
  for (const item of String(line || '').replace(/\r/g, '').split('\n')) {
    if (!item) continue;
    const entry = `${new Date().toLocaleTimeString()} [${source}] ${item}`;
    runtime.logs.push(entry);
    if (runtime.logs.length > MAX_LOG_LINES) runtime.logs.splice(0, runtime.logs.length - MAX_LOG_LINES);
    console.log(entry);
  }
}

function attachLogs(child, source) {
  child.stdout?.setEncoding?.('utf8');
  child.stderr?.setEncoding?.('utf8');
  child.stdout?.on('data', chunk => log(source, chunk));
  child.stderr?.on('data', chunk => log(source, chunk));
}

function networkUrls(port = GAME_PORT) {
  const urls = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const item of entries || []) {
      if (item.family === 'IPv4' && !item.internal) urls.push(`http://${item.address}:${port}`);
    }
  }
  return [...new Set(urls)];
}

function createCredentials() {
  return {
    joinCode: String(randomInt(100000, 1000000)),
    gmSecret: randomBytes(8).toString('hex').toUpperCase(),
  };
}

export function parseQuickTunnelUrl(text) {
  const match = String(text || '').match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/i);
  return match ? match[0] : null;
}

export function buildPlayerInvite({ mode, publicUrl, lanUrls = [], joinCode } = {}) {
  const target = mode === 'internet' ? publicUrl : lanUrls[0];
  if (!target || !joinCode) return '';
  return [
    'RPGmap 房间',
    '',
    `地址：${target}`,
    `房间号：${joinCode}`,
  ].join('\n');
}

function launcherUrl() {
  return `http://${LAUNCHER_HOST}:${launcherPort}/?token=${AUTH_TOKEN}`;
}

function gameLocalUrl() {
  return `http://127.0.0.1:${GAME_PORT}`;
}

function adminSocketUrl() {
  return `ws://127.0.0.1:${GAME_PORT}/ws`;
}

function openBrowser(url) {
  if (!url) return;
  try {
    let child;
    if (process.platform === 'win32') {
      child = spawn('cmd.exe', ['/D', '/S', '/C', `start "" "${url}"`], { detached: true, stdio: 'ignore', windowsHide: true });
    } else if (process.platform === 'darwin') {
      child = spawn('open', [url], { detached: true, stdio: 'ignore' });
    } else {
      child = spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
    }
    child.unref();
  } catch {}
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function isExecutable(command) {
  return new Promise(resolve => {
    let settled = false;
    const child = spawn(command, ['--version'], { stdio: 'ignore', windowsHide: true });
    const finish = value => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    child.once('error', () => finish(false));
    child.once('exit', code => finish(code === 0));
    setTimeout(() => {
      try { child.kill(); } catch {}
      finish(false);
    }, 3000).unref?.();
  });
}

async function resolveCloudflared({ install = false } = {}) {
  const envPath = String(process.env.RPGMAP_CLOUDFLARED_EXE || '').trim();
  const localName = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
  const candidates = [envPath, path.join(TOOLS_DIR, localName), path.join(PACKAGE_ROOT, localName), 'cloudflared'].filter(Boolean);
  for (const candidate of candidates) {
    if (await isExecutable(candidate)) return candidate;
  }

  if (!install) return null;
  if (process.platform !== 'win32') throw new Error('未检测到 cloudflared。非 Windows 系统请先将 cloudflared 安装到 PATH。');

  await mkdir(TOOLS_DIR, { recursive: true });
  const target = path.join(TOOLS_DIR, 'cloudflared.exe');
  const temp = `${target}.download`;
  log('Launcher', '未检测到 cloudflared，正在下载 Windows 64-bit 官方版本…');
  const response = await fetch('https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe', { redirect: 'follow' });
  if (!response.ok) throw new Error(`cloudflared 下载失败：HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length < 1024 * 1024) throw new Error('cloudflared 下载文件异常，文件尺寸过小');
  await writeFile(temp, buffer);
  await writeFile(target, buffer);
  try { await chmod(target, 0o755); } catch {}
  if (!(await isExecutable(target))) throw new Error('cloudflared 已下载，但无法执行');
  try { await access(temp); } catch { return target; }
  return target;
}

function stopChild(child) {
  if (!child || child.exitCode !== null || child.killed) return;
  try { child.kill(); } catch {}
}

async function waitForHealth(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  const url = `${gameLocalUrl()}/api/health`;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { cache: 'no-store' });
      const body = await response.json();
      if (response.ok && body?.status === 'ok') return body;
    } catch {}
    await delay(300);
  }
  throw new Error(`RPGmap Server 未能在 ${url} 就绪`);
}

async function waitForTunnelUrl(child, timeoutMs = 30000) {
  let buffer = '';
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(new Error('Cloudflare Quick Tunnel 30 秒内未返回公网地址')), timeoutMs);
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    const inspect = chunk => {
      const text = String(chunk || '');
      buffer = (buffer + text).slice(-32768);
      const url = parseQuickTunnelUrl(buffer);
      if (url) finish(null, url);
    };
    child.stdout?.on('data', inspect);
    child.stderr?.on('data', inspect);
    child.once('exit', code => finish(new Error(`cloudflared 在建立 Tunnel 前退出（${code ?? 'unknown'}）`)));
    child.once('error', error => finish(error));
  });
}

function processAlive(child) {
  return Boolean(child && child.exitCode === null && !child.killed);
}

async function connectAdmin() {
  runtime.admin?.close();
  const admin = new LauncherAdminClient({ url: adminSocketUrl(), gmSecret: runtime.gmSecret, name: 'RPGmap Launcher Admin' });
  runtime.admin = admin;
  await admin.connect();
  return admin;
}

function childExited(kind, child, code) {
  if (kind === 'server' && runtime.server !== child) return;
  if (kind === 'tunnel' && runtime.tunnel !== child) return;
  log(kind === 'server' ? 'Server' : 'Tunnel', `进程已退出，code=${code ?? 'unknown'}`);
  if (!runtime.stopping && runtime.mode !== 'stopped') {
    runtime.lastError = `${kind === 'server' ? 'RPGmap Server' : 'Cloudflare Tunnel'} 意外退出`;
    stopRuntime().catch(() => {});
  }
}

async function startRuntime(mode) {
  if (!['local', 'internet'].includes(mode)) throw new Error('启动模式必须是 local 或 internet');
  if (runtime.starting) throw new Error('RPGmap 正在启动，请勿重复操作');
  runtime.starting = true;
  runtime.lastError = null;
  try {
    await stopRuntime();
    runtime.starting = true;
    const credentials = createCredentials();
    runtime.joinCode = credentials.joinCode;
    runtime.gmSecret = credentials.gmSecret;
    runtime.publicUrl = null;
    runtime.health = null;
    runtime.mode = 'starting';
    runtime.startedAt = null;

    if (mode === 'internet') {
      runtime.cloudflaredPath = await resolveCloudflared({ install: true });
      const tunnel = spawn(runtime.cloudflaredPath, [
        'tunnel', '--no-autoupdate', '--url', gameLocalUrl(), '--protocol', 'http2',
      ], {
        cwd: PACKAGE_ROOT,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      runtime.tunnel = tunnel;
      attachLogs(tunnel, 'Tunnel');
      tunnel.once('exit', code => childExited('tunnel', tunnel, code));
      runtime.publicUrl = await waitForTunnelUrl(tunnel);
      log('Launcher', `公网地址已建立：${runtime.publicUrl}`);
    }

    const serverEnv = {
      ...process.env,
      RPGMAP_PACKAGE_ROOT: PACKAGE_ROOT,
      RPGMAP_PUBLIC_DIR: APP_DIR,
      RPGMAP_WORLD_DIR: WORLD_DIR,
      RPGMAP_MAPS_DIR: MAPS_DIR,
      RPGMAP_PUBLIC: mode === 'internet' ? '1' : '0',
      RPGMAP_PUBLIC_URL: runtime.publicUrl || '',
      RPGMAP_JOIN_CODE: runtime.joinCode,
      RPGMAP_GM_SECRET: runtime.gmSecret,
      PORT: String(GAME_PORT),
    };
    const server = spawn(process.execPath, [SERVER_ENTRY], {
      cwd: PACKAGE_ROOT,
      env: serverEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    runtime.server = server;
    attachLogs(server, 'Server');
    server.once('exit', code => childExited('server', server, code));
    runtime.health = await waitForHealth();
    await connectAdmin();
    runtime.mode = mode;
    runtime.startedAt = new Date().toISOString();
    log('Launcher', `${mode === 'internet' ? '互联网' : '本机/局域网'}模式启动完成`);
    return statusPayload();
  } catch (error) {
    runtime.lastError = error?.message || String(error);
    log('Launcher', `启动失败：${runtime.lastError}`);
    await stopRuntime({ preserveError: true });
    throw error;
  } finally {
    runtime.starting = false;
  }
}

async function stopRuntime({ preserveError = false } = {}) {
  if (runtime.stopping) return;
  runtime.stopping = true;
  const error = preserveError ? runtime.lastError : null;
  try {
    runtime.admin?.close();
    runtime.admin = null;
    const server = runtime.server;
    const tunnel = runtime.tunnel;
    runtime.server = null;
    runtime.tunnel = null;
    stopChild(server);
    stopChild(tunnel);
    await delay(120);
    runtime.mode = 'stopped';
    runtime.startedAt = null;
    runtime.publicUrl = null;
    runtime.health = null;
    runtime.joinCode = null;
    runtime.gmSecret = null;
    runtime.lastError = error;
  } finally {
    runtime.stopping = false;
  }
}

async function refreshAdminIfNeeded() {
  if (!processAlive(runtime.server) || !runtime.gmSecret) return;
  if (!runtime.admin?.connected) {
    try { await connectAdmin(); } catch (error) { runtime.lastError = error?.message || String(error); }
  }
}

function statusPayload() {
  const lanUrls = networkUrls();
  const admin = runtime.admin?.snapshot?.() || { connected: false, access: { users: [], pending: [], actors: [] }, presence: [] };
  const mode = ['local', 'internet'].includes(runtime.mode) ? runtime.mode : 'stopped';
  return {
    app: version.app || 'RPGmap',
    version: version.version || '1.4.3',
    build: version.commit || 'unknown',
    launcher: { host: LAUNCHER_HOST, port: launcherPort, url: `http://${LAUNCHER_HOST}:${launcherPort}/` },
    running: processAlive(runtime.server),
    starting: runtime.starting,
    mode,
    startedAt: runtime.startedAt,
    server: {
      localUrl: gameLocalUrl(),
      lanUrls,
      publicUrl: runtime.publicUrl,
      joinCode: runtime.joinCode,
      gmSecret: runtime.gmSecret,
      health: runtime.health,
    },
    inviteText: buildPlayerInvite({ mode, publicUrl: runtime.publicUrl, lanUrls, joinCode: runtime.joinCode }),
    storage: { world: WORLD_DIR, maps: MAPS_DIR },
    cloudflared: { path: runtime.cloudflaredPath, running: processAlive(runtime.tunnel) },
    admin,
    lastError: runtime.lastError,
  };
}

function json(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': payload.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(payload);
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error('请求内容过大');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function authorized(req) {
  return String(req.headers['x-rpgmap-launcher-token'] || '') === AUTH_TOKEN;
}

function safeUiPath(urlPath) {
  let pathname = '/';
  try { pathname = new URL(urlPath || '/', `http://${LAUNCHER_HOST}`).pathname; } catch {}
  if (pathname === '/') pathname = '/index.html';
  const target = path.resolve(UI_DIR, `.${pathname}`);
  if (target !== UI_DIR && !target.startsWith(UI_DIR + path.sep)) return null;
  return target;
}

async function serveUi(req, res) {
  const target = safeUiPath(req.url);
  if (!target) return json(res, 400, { error: 'bad_path' });
  try {
    const info = await stat(target);
    if (!info.isFile()) throw new Error('not file');
    res.writeHead(200, {
      'Content-Type': MIME.get(path.extname(target).toLowerCase()) || 'application/octet-stream',
      'Content-Length': info.size,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    createReadStream(target).pipe(res);
  } catch {
    json(res, 404, { error: 'not_found' });
  }
}

async function adminAction(route, body) {
  await refreshAdminIfNeeded();
  if (!runtime.admin?.connected) throw new Error('RPGmap Server 未运行或 Launcher Admin 未连接');
  if (route === '/api/admin/create-user') return runtime.admin.createUser(body);
  if (route === '/api/admin/approve') return runtime.admin.approvePending(body);
  if (route === '/api/admin/update-user') return runtime.admin.updateUser(body);
  if (route === '/api/admin/reset-key') return runtime.admin.resetPlayerKey(String(body.userId || ''));
  if (route === '/api/admin/delete-user') return runtime.admin.deleteUser(String(body.userId || ''));
  if (route === '/api/admin/refresh') return runtime.admin.refresh();
  throw new Error('未知 Admin 操作');
}

const launcherServer = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${LAUNCHER_HOST}:${launcherPort}`);
    if (!url.pathname.startsWith('/api/')) return serveUi(req, res);
    if (!authorized(req)) return json(res, 403, { error: 'launcher_token_required' });

    if (req.method === 'GET' && url.pathname === '/api/status') {
      await refreshAdminIfNeeded();
      return json(res, 200, statusPayload());
    }
    if (req.method === 'GET' && url.pathname === '/api/logs') {
      return json(res, 200, { lines: runtime.logs.slice(-MAX_LOG_LINES) });
    }
    if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });

    const body = await readJsonBody(req);
    if (url.pathname === '/api/start') return json(res, 200, await startRuntime(String(body.mode || 'local')));
    if (url.pathname === '/api/stop') {
      await stopRuntime();
      return json(res, 200, statusPayload());
    }
    if (url.pathname === '/api/open-game') {
      if (!processAlive(runtime.server)) throw new Error('请先启动 RPGmap Server');
      openBrowser(gameLocalUrl());
      return json(res, 200, { ok: true, url: gameLocalUrl() });
    }
    if (url.pathname.startsWith('/api/admin/')) return json(res, 200, await adminAction(url.pathname, body));
    if (url.pathname === '/api/shutdown') {
      await stopRuntime();
      json(res, 200, { ok: true });
      setTimeout(() => launcherServer.close(() => process.exit(0)), 50);
      return;
    }
    return json(res, 404, { error: 'not_found' });
  } catch (error) {
    runtime.lastError = error?.message || String(error);
    log('Launcher', runtime.lastError);
    return json(res, 500, { error: 'launcher_error', message: runtime.lastError });
  }
});

async function launcherReady() {
  const address = launcherServer.address();
  if (address && typeof address === 'object') launcherPort = address.port;
  log('Launcher', `RPGmap Launcher ${version.version || '1.4.3'} 已启动`);
  if (launcherPort !== PREFERRED_LAUNCHER_PORT) {
    if (usingAutomaticLauncherPort) {
      log('Launcher', `预设 Launcher 端口均被占用，Windows 已自动分配空闲端口 ${launcherPort}`);
    } else {
      log('Launcher', `默认端口 ${PREFERRED_LAUNCHER_PORT} 被占用，已自动改用 ${launcherPort}`);
    }
  }
  log('Launcher', `Control: http://${LAUNCHER_HOST}:${launcherPort}`);
  log('Launcher', `World: ${WORLD_DIR}`);
  log('Launcher', `Maps : ${MAPS_DIR}`);
  runtime.cloudflaredPath = await resolveCloudflared().catch(() => null);
  openBrowser(launcherUrl());
}

function listenLauncher() {
  launcherServer.listen(launcherPort, LAUNCHER_HOST, launcherReady);
}

launcherServer.on('error', error => {
  if (error?.code === 'EADDRINUSE' && !usingAutomaticLauncherPort && launcherPortIndex + 1 < LAUNCHER_PORT_CANDIDATES.length) {
    const occupiedPort = launcherPort;
    launcherPortIndex += 1;
    launcherPort = LAUNCHER_PORT_CANDIDATES[launcherPortIndex];
    console.warn(`[Launcher] 端口 ${occupiedPort} 已被占用，正在尝试 ${launcherPort}…`);
    setTimeout(listenLauncher, 50);
    return;
  }
  if (error?.code === 'EADDRINUSE' && !usingAutomaticLauncherPort) {
    console.warn(`[Launcher] 预设端口均被占用，改由 Windows 自动选择空闲端口…`);
    usingAutomaticLauncherPort = true;
    launcherPort = 0;
    setTimeout(listenLauncher, 50);
    return;
  }
  console.error(error);
  process.exit(1);
});

listenLauncher();

const cleanup = () => {
  runtime.admin?.close();
  stopChild(runtime.server);
  stopChild(runtime.tunnel);
};
process.once('SIGINT', () => { cleanup(); process.exit(0); });
process.once('SIGTERM', () => { cleanup(); process.exit(0); });
process.once('exit', cleanup);