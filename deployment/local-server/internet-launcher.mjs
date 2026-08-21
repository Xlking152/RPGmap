import { randomBytes, randomInt } from 'node:crypto';
import { spawn } from 'node:child_process';
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

async function main() {
  const cloudflaredExe = String(process.env.RPGMAP_CLOUDFLARED_EXE || '').trim();
  if (!cloudflaredExe) throw new Error('RPGMAP_CLOUDFLARED_EXE is not set. Run start-rpgmap-internet.bat.');

  const port = Math.max(1, Number(process.env.PORT || 30000) || 30000);
  const originUrl = `http://127.0.0.1:${port}`;
  const credentials = createInternetCredentials();

  console.log('============================================================');
  console.log(' RPGmap Internet Multiplayer Launcher');
  console.log('============================================================');
  console.log(` Cloudflare : ${cloudflaredExe}`);
  console.log(' Transport  : HTTP/2 over TCP');
  console.log(` Origin     : ${originUrl}`);
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
    const serverEnv = {
      ...process.env,
      RPGMAP_PUBLIC: '1',
      RPGMAP_PUBLIC_URL: publicUrl,
      RPGMAP_JOIN_CODE: credentials.joinCode,
      RPGMAP_GM_SECRET: credentials.gmSecret,
      RPGMAP_PLAYER_WRITE: process.env.RPGMAP_PLAYER_WRITE || '1',
      PORT: String(port),
    };

    console.log('');
    console.log(`[OK] Quick Tunnel created: ${publicUrl}`);
    console.log('[INFO] Starting RPGmap Server with the public URL attached...');
    console.log('');

    server = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
      cwd: ROOT,
      env: serverEnv,
      stdio: 'inherit',
      windowsHide: false,
    });

    server.once('error', error => console.error('[RPGmap] Server process error:', error));
    await waitForServer(port);

    console.log('============================================================');
    console.log(' RPGmap Player Invite');
    console.log('============================================================');
    console.log(` Public URL : ${publicUrl}`);
    console.log(` Join Code  : ${credentials.joinCode}`);
    console.log('');
    console.log(' Send ONLY the Public URL + Join Code to Players.');
    console.log(` GM Secret  : ${credentials.gmSecret}  (GM only - do not share)`);
    console.log('============================================================');
    console.log('');

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
