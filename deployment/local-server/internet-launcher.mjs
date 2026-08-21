import { randomBytes, randomInt } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

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

export function buildConnectionInfo({ publicUrl, joinCode, gmSecret, version = '1.4.1', port = 30000 }) {
  return [
    '============================================================',
    ` RPGmap Multiplayer Connection Info  |  ${version}`,
    '============================================================',
    ` Public URL : ${publicUrl}`,
    ` Join Code  : ${joinCode}`,
    ` GM Secret  : ${gmSecret}`,
    ` Local URL  : http://127.0.0.1:${port}`,
    '============================================================',
    '',
    ' PLAYER SHARE ONLY:',
    `   URL       : ${publicUrl}`,
    `   Join Code : ${joinCode}`,
    '',
    ' GM Secret is for the GM only. Do not send it to Players.',
    ' The public URL is temporary and expires when this launcher stops.',
    '',
    ' All RPGmap World/User data stays inside this package map/ folder.',
    ' You may close this information window manually at any time.',
  ];
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

async function readVersion() {
  try {
    return JSON.parse(await readFile(path.join(ROOT, 'VERSION.json'), 'utf8'));
  } catch {
    return { app: 'RPGmap', version: '1.4.1', commit: 'unknown' };
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function openBrowser(url) {
  if (process.platform !== 'win32') return;
  try {
    const child = spawn('cmd.exe', ['/D', '/S', '/C', `start "" "${url}"`], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
  } catch {}
}

function escapeCmdEcho(value) {
  return String(value).replace(/[&|<>^]/g, match => `^${match}`);
}

function openConnectionInfoWindow(lines) {
  if (process.platform !== 'win32') return null;
  try {
    const echoCommands = lines.map(line => line ? `echo ${escapeCmdEcho(line)}` : 'echo.');
    const command = [
      'chcp 65001>nul',
      'title RPGmap Multiplayer Info',
      'color 0A',
      'mode con cols=100 lines=25',
      'cls',
      ...echoCommands,
      'echo.',
      'echo Press any key to close this information window...',
      'pause>nul',
    ].join(' & ');
    return spawn('cmd.exe', ['/D', '/Q', '/S', '/C', command], {
      cwd: ROOT,
      detached: false,
      stdio: 'ignore',
      windowsHide: false,
    });
  } catch {
    return null;
  }
}

function stopChild(child) {
  if (!child || child.killed || child.exitCode !== null) return;
  try { child.kill(); } catch {}
}

async function waitForTunnelUrl(tunnel, timeoutMs = 30000) {
  let scanBuffer = '';
  let settled = false;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('Cloudflare Quick Tunnel URL was not created within 30 seconds.'));
    }, timeoutMs);

    const inspect = chunk => {
      const text = String(chunk || '');
      process.stdout.write(text);
      scanBuffer = (scanBuffer + text).slice(-16384);
      const url = parseQuickTunnelUrl(scanBuffer);
      if (!url || settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(url);
    };

    tunnel.stdout?.on('data', inspect);
    tunnel.stderr?.on('data', inspect);
    tunnel.once('exit', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`cloudflared exited before creating a Quick Tunnel URL (code ${code ?? 'unknown'}).`));
    });
    tunnel.once('error', error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function waitForServer(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  const url = `http://127.0.0.1:${port}/api/health`;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { cache: 'no-store' });
      const body = await response.json();
      if (response.ok && body?.status === 'ok') return body;
    } catch {}
    await delay(500);
  }
  throw new Error(`RPGmap Server did not become ready at ${url}.`);
}

function printServerBanner({ port, publicUrl, credentials, health, version }) {
  const multiplayer = health?.multiplayer || {};
  const mapDir = path.resolve(process.env.RPGMAP_MAP_DIR || path.join(ROOT, 'map'));
  const packageVersion = version?.version || version?.packageVersion || health?.version || 'unknown';

  console.log('');
  console.log('============================================================');
  console.log(` RPGmap Multiplayer Server  |  ${packageVersion}`);
  console.log('============================================================');
  console.log(` Local     : http://127.0.0.1:${port}`);
  for (const url of networkUrls(port)) console.log(` Network   : ${url}`);
  console.log(` Public URL: ${publicUrl}`);
  console.log(` World     : ${multiplayer.worldId || 'default'} · revision ${multiplayer.revision ?? 0}`);
  console.log(` Map Root  : ${mapDir}`);
  console.log(` Users     : ${multiplayer.users ?? 0} persistent Player identities`);
  console.log(` Storage   : ${multiplayer.storageMode || 'portable-map-root'}`);
  console.log(' Public    : ON');
  console.log(` JoinCode  : ${credentials.joinCode}`);
  console.log(` GMSecret  : ${credentials.gmSecret}`);
  console.log(` Build     : ${version?.commit || 'unknown'}`);
  console.log(' Status    : READY');
  console.log('============================================================');
  console.log('');
  console.log(' PLAYER INVITE - send only these two items:');
  console.log(`   URL      : ${publicUrl}`);
  console.log(`   JoinCode : ${credentials.joinCode}`);
  console.log('');
  console.log(' GM Secret is for the GM only. Do not send it to Players.');
  console.log(' World/User data stays inside map/ beside this launcher.');
  console.log(' A separate connection-info window has been opened for quick reference.');
  console.log(' Press Ctrl+C to stop the server and tunnel.');
  console.log('');
}

async function main() {
  const cloudflaredExe = String(process.env.RPGMAP_CLOUDFLARED_EXE || '').trim();
  if (!cloudflaredExe) throw new Error('RPGMAP_CLOUDFLARED_EXE is not set. Run start-rpgmap-internet.bat.');

  const port = Math.max(1, Number(process.env.PORT || 30000) || 30000);
  const originUrl = `http://127.0.0.1:${port}`;
  const credentials = createInternetCredentials();
  const version = await readVersion();

  console.log('============================================================');
  console.log(' RPGmap Internet Multiplayer Launcher');
  console.log('============================================================');
  console.log(` Cloudflare : ${cloudflaredExe}`);
  console.log(' Transport  : HTTP/2 over TCP');
  console.log(` Origin     : ${originUrl}`);
  console.log(` Map Root   : ${path.resolve(process.env.RPGMAP_MAP_DIR || path.join(ROOT, 'map'))}`);
  console.log(' Status     : creating Quick Tunnel...');
  console.log('============================================================');
  console.log('');

  const tunnel = spawn(cloudflaredExe, [
    'tunnel', '--no-autoupdate', '--url', originUrl, '--protocol', 'http2',
  ], {
    cwd: ROOT,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: false,
  });

  let server = null;
  let infoWindow = null;
  let shuttingDown = false;
  const cleanup = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    stopChild(infoWindow);
    stopChild(server);
    stopChild(tunnel);
  };
  process.once('SIGINT', cleanup);
  process.once('SIGTERM', cleanup);
  process.once('exit', cleanup);

  try {
    const publicUrl = await waitForTunnelUrl(tunnel);
    const serverEnv = {
      ...process.env,
      RPGMAP_PUBLIC: '1',
      RPGMAP_PUBLIC_URL: publicUrl,
      RPGMAP_JOIN_CODE: credentials.joinCode,
      RPGMAP_GM_SECRET: credentials.gmSecret,
      RPGMAP_PLAYER_WRITE: process.env.RPGMAP_PLAYER_WRITE || '1',
      RPGMAP_PUBLIC_DIR: process.env.RPGMAP_PUBLIC_DIR || path.join(ROOT, 'app'),
      RPGMAP_MAP_DIR: process.env.RPGMAP_MAP_DIR || path.join(ROOT, 'map'),
      PORT: String(port),
    };

    console.log('');
    console.log(`[OK] Quick Tunnel created: ${publicUrl}`);
    console.log('[INFO] Starting RPGmap Server...');

    server = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
      cwd: ROOT,
      env: serverEnv,
      stdio: ['inherit', 'ignore', 'inherit'],
      windowsHide: false,
    });

    server.once('error', error => console.error('[RPGmap] Server process error:', error));
    const health = await waitForServer(port);
    printServerBanner({ port, publicUrl, credentials, health, version });

    const connectionInfo = buildConnectionInfo({
      publicUrl,
      joinCode: credentials.joinCode,
      gmSecret: credentials.gmSecret,
      version: version?.version || version?.packageVersion || '1.4.1',
      port,
    });
    infoWindow = openConnectionInfoWindow(connectionInfo);
    openBrowser(publicUrl);

    const result = await Promise.race([
      new Promise(resolve => server.once('exit', code => resolve({ source: 'server', code }))),
      new Promise(resolve => tunnel.once('exit', code => resolve({ source: 'tunnel', code }))),
    ]);
    if (!shuttingDown) {
      console.error(`[WARN] ${result.source} exited (code ${result.code ?? 'unknown'}). Stopping Internet Multiplayer.`);
    }
  } finally {
    cleanup();
  }
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (entryPath === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error('');
    console.error('[ERROR] Internet Multiplayer failed:', error?.message || error);
    process.exitCode = 1;
  });
}
