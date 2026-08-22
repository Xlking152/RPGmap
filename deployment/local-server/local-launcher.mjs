import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { delay, describePortConflict, inspectServerPort } from './launcher-guard.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

function networkUrls(port) {
  const urls = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const item of entries || []) {
      if (item.family === 'IPv4' && !item.internal) urls.push(`http://${item.address}:${port}`);
    }
  }
  return [...new Set(urls)];
}

function openBrowser(url) {
  try {
    if (process.platform === 'win32') {
      const child = spawn('cmd.exe', ['/D', '/S', '/C', `start "" "${url}"`], {
        cwd: ROOT,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.unref();
      return;
    }
    if (process.platform === 'darwin') {
      const child = spawn('open', [url], { detached: true, stdio: 'ignore' });
      child.unref();
      return;
    }
    const child = spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
    child.unref();
  } catch {}
}

function stopChild(child) {
  if (!child || child.killed || child.exitCode !== null) return;
  try { child.kill(); } catch {}
}

async function waitForServer(port, server, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(`RPGmap Server exited before becoming ready (code ${server.exitCode ?? 'unknown'}).`);
    }
    const status = await inspectServerPort(port, { timeoutMs: 700 });
    if (status.rpgmap) return status.health;
    await delay(250);
  }
  throw new Error(`RPGmap Server did not become ready at http://127.0.0.1:${port}/api/health.`);
}

export async function main() {
  const port = Math.max(1, Number(process.env.PORT || 30000) || 30000);
  const localUrl = `http://127.0.0.1:${port}`;
  const existing = await inspectServerPort(port);
  if (existing.occupied) throw new Error(describePortConflict(existing, port));

  const serverEnv = {
    ...process.env,
    RPGMAP_PUBLIC: '0',
    RPGMAP_PUBLIC_URL: '',
    RPGMAP_JOIN_CODE: '',
    RPGMAP_GM_SECRET: '',
    RPGMAP_PUBLIC_DIR: process.env.RPGMAP_PUBLIC_DIR || path.join(ROOT, 'app'),
    RPGMAP_MAP_DIR: process.env.RPGMAP_MAP_DIR || path.join(ROOT, 'map'),
    PORT: String(port),
  };

  console.log('============================================================');
  console.log(' RPGmap Local / LAN Launcher');
  console.log('============================================================');
  console.log(` Local    : ${localUrl}`);
  for (const url of networkUrls(port)) console.log(` Network  : ${url}`);
  console.log(` Map Root : ${serverEnv.RPGMAP_MAP_DIR}`);
  console.log(' Mode     : LOCAL / LAN only');
  console.log(' Status   : starting server...');
  console.log('============================================================');
  console.log('');

  const server = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
    cwd: ROOT,
    env: serverEnv,
    stdio: 'inherit',
    windowsHide: false,
  });

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
    if (health?.multiplayer?.publicMode) {
      throw new Error('Local launcher started a Public-mode server unexpectedly. Refusing to open the browser.');
    }
    console.log(`[OK] RPGmap Local/LAN Server READY: ${localUrl}`);
    console.log('[INFO] Opening browser only after /api/health is ready.');
    openBrowser(localUrl);

    const code = await new Promise(resolve => server.once('exit', resolve));
    if (!shuttingDown && code) process.exitCode = Number(code) || 1;
  } finally {
    cleanup();
  }
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (entryPath === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error('');
    console.error('[ERROR] Local/LAN startup failed:', error?.message || error);
    process.exitCode = 1;
  });
}
