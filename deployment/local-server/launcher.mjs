import { randomBytes, randomInt } from 'node:crypto';
import { spawn } from 'node:child_process';
import { access, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PORT = 30000;
const CLOUDFLARED_WINDOWS_URL = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe';
const SEPARATOR = '============================================================';

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function parseQuickTunnelUrl(text) {
  const match = String(text || '').match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/i);
  return match ? match[0] : null;
}

export function createInternetCredentials() {
  return {
    joinCode: String(randomInt(100000, 1000000)),
    gmSecret: randomBytes(8).toString('hex').toUpperCase(),
  };
}

export function buildConnectionInfo({
  publicUrl,
  joinCode,
  gmSecret,
  version = 'unknown',
  port = DEFAULT_PORT,
}) {
  return [
    SEPARATOR,
    ` RPGmap ${version} · Internet / Public · READY`,
    SEPARATOR,
    ' PLAYER INVITE',
    `   URL       : ${publicUrl}`,
    `   Join Code : ${joinCode}`,
    '',
    ' GM ONLY',
    `   GM Secret : ${gmSecret}`,
    '',
    ' LOCAL',
    `   Local     : http://127.0.0.1:${port}`,
    SEPARATOR,
  ];
}

async function isTcpPortOpen(port, host = '127.0.0.1', timeoutMs = 700) {
  const targetPort = Math.max(1, Number(port) || DEFAULT_PORT);
  return new Promise(resolve => {
    const socket = net.createConnection({ host, port: targetPort });
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

export async function inspectServerPort(port, {
  host = '127.0.0.1',
  timeoutMs = 900,
  fetchImpl = globalThis.fetch,
} = {}) {
  const targetPort = Math.max(1, Number(port) || DEFAULT_PORT);
  const occupied = await isTcpPortOpen(targetPort, host, Math.min(timeoutMs, 700));
  if (!occupied) return { occupied: false, rpgmap: false, health: null };

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`http://${host}:${targetPort}/api/health`, {
        cache: 'no-store',
        signal: controller.signal,
      });
      const health = await response.json();
      const rpgmap = response.ok && health?.status === 'ok' && health?.app === 'RPGmap';
      return { occupied: true, rpgmap, health: rpgmap ? health : null };
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return { occupied: true, rpgmap: false, health: null };
  }
}

export function describePortConflict(result, port) {
  const targetPort = Math.max(1, Number(port) || DEFAULT_PORT);
  if (!result?.occupied) return '';
  if (!result.rpgmap) {
    return `Port ${targetPort} is already in use by another program. Close that program or choose another PORT before starting RPGmap.`;
  }
  const multiplayer = result.health?.multiplayer || {};
  const mode = multiplayer.publicMode ? 'Internet/Public' : 'Local/LAN';
  const version = result.health?.version ? ` v${result.health.version}` : '';
  return `RPGmap${version} ${mode} Server is already running on port ${targetPort}. Close that RPGmap window before starting another mode.`;
}

export function normalizeLaunchMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  if (['1', 'local', 'lan'].includes(mode)) return 'local';
  if (['2', 'internet', 'public', 'online'].includes(mode)) return 'internet';
  return null;
}

function networkUrls(port) {
  const urls = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const item of entries || []) {
      if (item.family === 'IPv4' && !item.internal) urls.push(`http://${item.address}:${port}`);
    }
  }
  return [...new Set(urls)];
}

async function validateRuntime() {
  for (const relative of ['server.mjs', path.join('app', 'index.html')]) {
    try {
      await access(path.join(ROOT, relative));
    } catch {
      throw new Error(`${relative} is missing. Use a complete RPGmap package.`);
    }
  }
  await mkdir(path.join(ROOT, 'map', 'uploads'), { recursive: true });
  await mkdir(path.join(ROOT, 'map', 'backups'), { recursive: true });
}

function openBrowser(url) {
  try {
    let child;
    if (process.platform === 'win32') {
      child = spawn('cmd.exe', ['/D', '/S', '/C', `start "" "${url}"`], {
        cwd: ROOT,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
    } else if (process.platform === 'darwin') {
      child = spawn('open', [url], { detached: true, stdio: 'ignore' });
    } else {
      child = spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
    }
    child.unref();
  } catch {}
}

function stopChild(child) {
  if (!child || child.killed || child.exitCode !== null) return;
  try { child.kill(); } catch {}
}

function spawnServer(env) {
  return spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
    cwd: ROOT,
    env,
    // Launcher owns normal startup display; Server stderr remains visible for diagnostics.
    stdio: ['ignore', 'ignore', 'inherit'],
    windowsHide: false,
  });
}

async function waitForServer(port, server, { publicMode, timeoutMs = 20000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (server?.exitCode !== null) {
      throw new Error(`RPGmap Server exited before becoming ready (code ${server.exitCode ?? 'unknown'}).`);
    }
    const status = await inspectServerPort(port, { timeoutMs: 700 });
    if (status.rpgmap) {
      if (typeof publicMode === 'boolean' && Boolean(status.health?.multiplayer?.publicMode) !== publicMode) {
        throw new Error(`RPGmap Server started in the wrong mode on port ${port}.`);
      }
      return status.health;
    }
    await delay(250);
  }
  throw new Error(`RPGmap Server did not become ready at http://127.0.0.1:${port}/api/health.`);
}

async function waitForChild(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

async function executableWorks(command) {
  try {
    const child = spawn(command, ['--version'], {
      cwd: ROOT,
      stdio: 'ignore',
      windowsHide: true,
    });
    const result = await waitForChild(child);
    return result.code === 0;
  } catch {
    return false;
  }
}

async function findCommand(command) {
  if (path.isAbsolute(command)) return (await executableWorks(command)) ? command : null;
  const lookup = process.platform === 'win32' ? 'where.exe' : 'which';
  try {
    const child = spawn(lookup, [command], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    let output = '';
    child.stdout?.on('data', chunk => { output += String(chunk); });
    const result = await waitForChild(child);
    if (result.code !== 0) return null;
    const candidate = output.split(/\r?\n/).map(line => line.trim()).find(Boolean);
    return candidate && await executableWorks(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

async function installCloudflaredWindows() {
  const target = path.join(ROOT, 'cloudflared.exe');
  const temp = target + '.download';
  console.log('[INFO] cloudflared not found. Installing it for Internet mode...');

  try {
    await rm(temp, { force: true });
    const response = await fetch(CLOUDFLARED_WINDOWS_URL, { redirect: 'follow' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = Buffer.from(await response.arrayBuffer());
    if (payload.length < 1024 * 1024) throw new Error('downloaded file is unexpectedly small');
    await writeFile(temp, payload);
    await rm(target, { force: true });
    await rename(temp, target);
    if (!await executableWorks(target)) throw new Error('downloaded cloudflared.exe could not run');
    console.log('[OK] cloudflared is ready.');
    return target;
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    console.warn(`[WARN] Direct cloudflared download failed: ${error?.message || error}`);
  }

  const winget = await findCommand('winget.exe');
  if (winget) {
    console.log('[INFO] Trying Winget package Cloudflare.cloudflared...');
    const child = spawn(winget, [
      'install', '--id', 'Cloudflare.cloudflared', '--exact',
      '--accept-package-agreements', '--accept-source-agreements',
    ], { cwd: ROOT, stdio: 'inherit', windowsHide: false });
    const result = await waitForChild(child);
    if (result.code === 0) {
      const installed = await findCommand('cloudflared.exe');
      if (installed) return installed;
    }
  }

  throw new Error('cloudflared is unavailable. Put cloudflared.exe beside start-rpgmap.bat, then choose Internet mode again.');
}

async function resolveCloudflared() {
  const configured = String(process.env.RPGMAP_CLOUDFLARED_EXE || '').trim();
  if (configured) {
    const resolved = await findCommand(configured);
    if (resolved) return resolved;
    throw new Error(`Configured cloudflared could not run: ${configured}`);
  }

  const localName = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
  const local = path.join(ROOT, localName);
  if (await executableWorks(local)) return local;

  const system = await findCommand(localName);
  if (system) return system;

  if (process.platform === 'win32') return installCloudflaredWindows();
  throw new Error('cloudflared is required for Internet mode. Install it in PATH or place it beside launcher.mjs.');
}

function tunnelDiagnostic(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .slice(-3)
    .join(' | ');
}

async function waitForTunnelUrl(tunnel, timeoutMs = 30000) {
  let scanBuffer = '';
  return new Promise((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      // Keep the data listeners attached after READY so the child pipes continue
      // to drain silently; otherwise a chatty long-running tunnel could block.
      tunnel.off('exit', onExit);
      tunnel.off('error', onError);
    };
    const fail = message => {
      if (settled) return;
      settled = true;
      cleanup();
      const diagnostic = tunnelDiagnostic(scanBuffer);
      reject(new Error(diagnostic ? `${message} Cloudflare: ${diagnostic}` : message));
    };
    const inspect = chunk => {
      if (settled) return;
      scanBuffer = (scanBuffer + String(chunk || '')).slice(-16384);
      const url = parseQuickTunnelUrl(scanBuffer);
      if (!url) return;
      settled = true;
      cleanup();
      resolve(url);
    };
    const onExit = code => fail(`cloudflared exited before creating a Quick Tunnel URL (code ${code ?? 'unknown'}).`);
    const onError = error => fail(error?.message || String(error));
    const timer = setTimeout(
      () => fail('Cloudflare Quick Tunnel URL was not created within 30 seconds.'),
      timeoutMs,
    );

    tunnel.stdout?.on('data', inspect);
    tunnel.stderr?.on('data', inspect);
    tunnel.once('exit', onExit);
    tunnel.once('error', onError);
  });
}

async function ensurePortFree(port) {
  const existing = await inspectServerPort(port);
  if (existing.occupied) throw new Error(describePortConflict(existing, port));
}

function localServerEnv(port) {
  return {
    ...process.env,
    RPGMAP_PUBLIC: '0',
    RPGMAP_PUBLIC_URL: '',
    RPGMAP_JOIN_CODE: '',
    RPGMAP_GM_SECRET: '',
    RPGMAP_PUBLIC_DIR: path.join(ROOT, 'app'),
    RPGMAP_MAP_DIR: path.join(ROOT, 'map'),
    PORT: String(port),
  };
}

function publicServerEnv(port, publicUrl, credentials) {
  return {
    ...process.env,
    RPGMAP_PUBLIC: '1',
    RPGMAP_PUBLIC_URL: publicUrl,
    RPGMAP_JOIN_CODE: credentials.joinCode,
    RPGMAP_GM_SECRET: credentials.gmSecret,
    RPGMAP_PUBLIC_DIR: path.join(ROOT, 'app'),
    RPGMAP_MAP_DIR: path.join(ROOT, 'map'),
    PORT: String(port),
  };
}

function printLocalReady(health, port) {
  console.log('');
  console.log(SEPARATOR);
  console.log(` RPGmap ${health?.version || 'unknown'} · Local / LAN · READY`);
  console.log(SEPARATOR);
  console.log(` Local   : http://127.0.0.1:${port}`);
  for (const url of networkUrls(port)) console.log(` Network : ${url}`);
  console.log(SEPARATOR);
  console.log(' Press Ctrl+C to stop RPGmap.');
  console.log('');
}

async function runLocal(port) {
  await ensurePortFree(port);
  console.log('[INFO] Starting RPGmap Local / LAN...');
  const server = spawnServer(localServerEnv(port));
  let shuttingDown = false;
  const cleanup = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    stopChild(server);
  };
  process.once('SIGINT', cleanup);
  process.once('SIGTERM', cleanup);
  process.once('exit', cleanup);

  try {
    const health = await waitForServer(port, server, { publicMode: false });
    printLocalReady(health, port);
    openBrowser(`http://127.0.0.1:${port}`);
    const code = await new Promise(resolve => server.once('exit', resolve));
    if (!shuttingDown && code) process.exitCode = Number(code) || 1;
  } finally {
    cleanup();
  }
}

async function runInternet(port) {
  await ensurePortFree(port);
  console.log('[INFO] Preparing RPGmap Internet / Public...');
  const cloudflared = await resolveCloudflared();
  await ensurePortFree(port);

  const localUrl = `http://127.0.0.1:${port}`;
  const credentials = createInternetCredentials();
  const tunnel = spawn(cloudflared, [
    'tunnel', '--no-autoupdate', '--url', localUrl, '--protocol', 'http2',
  ], {
    cwd: ROOT,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: false,
  });

  let server = null;
  let shuttingDown = false;
  const cleanup = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    stopChild(server);
    stopChild(tunnel);
  };
  process.once('SIGINT', cleanup);
  process.once('SIGTERM', cleanup);
  process.once('exit', cleanup);

  try {
    const publicUrl = await waitForTunnelUrl(tunnel);
    await ensurePortFree(port);
    server = spawnServer(publicServerEnv(port, publicUrl, credentials));
    const health = await waitForServer(port, server, { publicMode: true });

    console.log('');
    for (const line of buildConnectionInfo({
      publicUrl,
      joinCode: credentials.joinCode,
      gmSecret: credentials.gmSecret,
      version: health?.version || 'unknown',
      port,
    })) console.log(line);
    for (const url of networkUrls(port)) console.log(` Network   : ${url}`);
    console.log(' Press Ctrl+C to stop RPGmap and the tunnel.');
    console.log('');

    openBrowser(publicUrl);

    const result = await Promise.race([
      new Promise(resolve => server.once('exit', code => resolve({ source: 'server', code }))),
      new Promise(resolve => tunnel.once('exit', code => resolve({ source: 'tunnel', code }))),
    ]);
    if (!shuttingDown) {
      console.error(`[WARN] ${result.source} exited (code ${result.code ?? 'unknown'}). Stopping Internet mode.`);
    }
  } finally {
    cleanup();
  }
}

async function chooseMode() {
  const requested = normalizeLaunchMode(process.argv[2] || process.env.RPGMAP_MODE);
  if (requested) return requested;
  if (!process.stdin.isTTY || !process.stdout.isTTY) return 'local';

  console.log('');
  console.log(SEPARATOR);
  console.log(' RPGmap Launcher');
  console.log(SEPARATOR);
  console.log('  1. Local / LAN');
  console.log('  2. Internet / Public');
  console.log('');
  console.log(' Internet mode already includes Local and LAN access.');
  console.log(SEPARATOR);

  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    while (true) {
      const mode = normalizeLaunchMode(await readline.question('Select mode [1/2]: '));
      if (mode) return mode;
      console.log('Please enter 1 or 2.');
    }
  } finally {
    readline.close();
  }
}

export async function main() {
  await validateRuntime();
  const port = Math.max(1, Number(process.env.PORT || DEFAULT_PORT) || DEFAULT_PORT);
  return (await chooseMode()) === 'internet'
    ? runInternet(port)
    : runLocal(port);
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (entryPath === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error('');
    console.error('[ERROR] RPGmap startup failed:', error?.message || error);
    process.exitCode = 1;
  });
}
