import { randomBytes, randomInt } from 'node:crypto';
import { spawn } from 'node:child_process';
import { access, mkdir, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PORT = 30000;
const SEPARATOR = '============================================================';
const REQUIRED_RUNTIME_FILES = Object.freeze([
  'server.mjs',
  'access-control.mjs',
  'portable-storage.mjs',
  'world-schema.mjs',
  'world-v2.mjs',
  'status-operations.mjs',
  path.join('app', 'index.html'),
]);

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function createSessionCredentials() {
  return {
    joinCode: String(randomInt(100000, 1000000)),
    gmSecret: randomBytes(8).toString('hex').toUpperCase(),
  };
}

export function buildHostLaunchUrl({ port = DEFAULT_PORT, gmSecret } = {}) {
  const secret = String(gmSecret || '').trim();
  const hash = new URLSearchParams({
    'rpgmap-host': '1',
    gmSecret: secret,
  });
  return `http://127.0.0.1:${Math.max(1, Number(port) || DEFAULT_PORT)}/#${hash.toString()}`;
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

export function buildConnectionInfo({
  lanUrls = [],
  joinCode,
  gmSecret,
  version = 'unknown',
  port = DEFAULT_PORT,
}) {
  const lines = [
    SEPARATOR,
    ` RPGmap ${version} · Local / LAN · READY`,
    SEPARATOR,
    ' PLAYER INVITE',
    `   Join Code    : ${joinCode}`,
    '',
    ' LOCAL / LAN',
    `   Local        : http://127.0.0.1:${port}`,
  ];
  if (lanUrls.length) {
    lanUrls.forEach((url, index) => lines.push(`   LAN URL ${index + 1}    : ${url}`));
  } else {
    lines.push('   LAN URL      : (no active LAN IPv4 address found)');
  }
  lines.push(
    '',
    ' GM ONLY',
    `   GM Secret    : ${gmSecret}`,
    '',
    ' HOST',
    '   Browser      : opens the local map automatically as GM',
    SEPARATOR,
  );
  return lines;
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
  const version = result.health?.version ? ` v${result.health.version}` : '';
  return `RPGmap${version} Local/LAN Server is already running on port ${targetPort}. Close that RPGmap window before starting another mode.`;
}

export function normalizeLaunchMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  if (['1', 'local', 'lan'].includes(mode)) return 'local';
  return null;
}

async function validateRuntime() {
  if (process.platform !== 'win32') {
    throw new Error('This RPGmap package is Windows-only. Use start-rpgmap.bat on Windows.');
  }
  for (const relative of REQUIRED_RUNTIME_FILES) {
    try {
      await access(path.join(ROOT, relative));
    } catch {
      throw new Error(`${relative} is missing. Use a complete RPGmap package.`);
    }
  }
  await mkdir(path.join(ROOT, 'map', 'uploads'), { recursive: true });
  await mkdir(path.join(ROOT, 'map', 'backups'), { recursive: true });
}

export function browserLaunchCandidates(url, platform = process.platform) {
  const target = String(url || '').trim();
  if (!target || platform !== 'win32') return [];
  const cmdTarget = target.replace(/"/g, '%22');
  const candidates = [
    {
      command: 'cmd.exe',
      args: ['/D', '/S', '/C', `start "" "${cmdTarget}"`],
      waitForExit: true,
      label: 'Windows start',
    },
  ];

  candidates.push({
    command: 'rundll32.exe',
    args: ['url.dll,FileProtocolHandler', target],
    waitForExit: true,
    label: 'Windows URL handler',
  });
  return candidates;
}

function waitForLaunch(child, { waitForExit, timeoutMs = 5000 } = {}) {
  return new Promise(resolve => {
    let settled = false;
    const timer = setTimeout(() => finish({ ok: !waitForExit, code: null, timedOut: true }), timeoutMs);
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    child.once('error', error => finish({ ok: false, error }));
    child.once('spawn', () => {
      if (!waitForExit) finish({ ok: true, code: null });
    });
    if (waitForExit) {
      child.once('exit', code => finish({ ok: code === 0, code }));
    }
  });
}

export async function openBrowser(url, {
  platform = process.platform,
  spawnImpl = spawn,
  env = process.env,
} = {}) {
  if (env.RPGMAP_NO_BROWSER === '1') {
    console.log('[INFO] Browser auto-open disabled by RPGMAP_NO_BROWSER=1.');
    return false;
  }

  const candidates = browserLaunchCandidates(url, platform);
  let lastError = null;
  for (const candidate of candidates) {
    let child;
    try {
      child = spawnImpl(candidate.command, candidate.args, {
        cwd: ROOT,
        detached: !candidate.waitForExit,
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch (error) {
      lastError = error;
      continue;
    }

    const result = await waitForLaunch(child, { waitForExit: candidate.waitForExit });
    if (result.ok) {
      if (!candidate.waitForExit) child.unref?.();
      console.log(`[OK] Browser launch requested via ${candidate.label}.`);
      return true;
    }
    lastError = result.error || new Error(`${candidate.label} exited with code ${result.code ?? 'unknown'}`);
  }

  const detail = lastError?.message ? ` (${lastError.message})` : '';
  console.warn(`[WARN] Browser could not be opened automatically${detail}.`);
  console.warn(`[WARN] Open this URL manually: ${url}`);
  return false;
}

function stopChild(child) {
  if (!child || child.killed || child.exitCode !== null) return;
  try { child.kill(); } catch {}
}

function spawnServer(env) {
  return spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'ignore', 'inherit'],
    windowsHide: false,
  });
}

async function waitForServer(port, server, { timeoutMs = 20000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (server?.exitCode !== null) {
      throw new Error(`RPGmap Server exited before becoming ready (code ${server.exitCode ?? 'unknown'}).`);
    }
    const status = await inspectServerPort(port, { timeoutMs: 700 });
    if (status.rpgmap) {
      return status.health;
    }
    await delay(250);
  }
  throw new Error(`RPGmap Server did not become ready at http://127.0.0.1:${port}/api/health.`);
}

async function ensurePortFree(port) {
  const existing = await inspectServerPort(port);
  if (existing.occupied) throw new Error(describePortConflict(existing, port));
}

function serverEnv({ port, credentials }) {
  return {
    ...process.env,
    RPGMAP_JOIN_CODE: credentials.joinCode,
    RPGMAP_GM_SECRET: credentials.gmSecret,
    RPGMAP_PUBLIC_DIR: path.join(ROOT, 'app'),
    RPGMAP_MAP_DIR: path.join(ROOT, 'map'),
    PORT: String(port),
  };
}

function printReady({ health, port, credentials }) {
  console.log('');
  for (const line of buildConnectionInfo({
    lanUrls: networkUrls(port),
    joinCode: credentials.joinCode,
    gmSecret: credentials.gmSecret,
    version: health?.version || 'unknown',
    port,
  })) console.log(line);
  console.log(' Press Ctrl+C to stop RPGmap.');
  console.log('');
}

async function runLocal(port) {
  await ensurePortFree(port);
  const credentials = createSessionCredentials();
  console.log('[INFO] Starting RPGmap Local / LAN...');
  const server = spawnServer(serverEnv({ port, credentials }));
  if (process.env.RPGMAP_SMOKE_PID_FILE) {
    await writeFile(path.resolve(process.env.RPGMAP_SMOKE_PID_FILE), `${server.pid}\n`, 'utf8');
  }
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
    const health = await waitForServer(port, server);
    printReady({ health, port, credentials });
    await openBrowser(buildHostLaunchUrl({ port, gmSecret: credentials.gmSecret }));
    const code = await new Promise(resolve => server.once('exit', resolve));
    if (!shuttingDown && code) process.exitCode = Number(code) || 1;
  } finally {
    cleanup();
  }
}

export async function main() {
  await validateRuntime();
  const port = Math.max(1, Number(process.env.PORT || DEFAULT_PORT) || DEFAULT_PORT);
  return runLocal(port);
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (entryPath === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error('');
    console.error('[ERROR] RPGmap startup failed:', error?.message || error);
    process.exitCode = 1;
  });
}
