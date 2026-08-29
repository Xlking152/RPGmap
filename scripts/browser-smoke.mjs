import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

if (process.platform !== 'win32') throw new Error('Packaged browser smoke requires Windows Edge');
const targetUrl = String(process.argv[2] || '').trim();
if (!/^http:\/\/127\.0\.0\.1:\d+\/?/.test(targetUrl)) throw new Error('Browser smoke requires a loopback HTTP URL');
const timeoutMs = Math.max(10_000, Number(process.argv[3]) || 30_000);

function edgePath() {
  const roots = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean);
  const suffixes = [
    ['Microsoft', 'Edge', 'Application', 'msedge.exe'],
    ['Microsoft', 'Edge SxS', 'Application', 'msedge.exe'],
  ];
  for (const root of roots) {
    for (const suffix of suffixes) {
      const candidate = path.join(root, ...suffix);
      try {
        if (process.getBuiltinModule('fs').existsSync(candidate)) return candidate;
      } catch {}
    }
  }
  throw new Error('Microsoft Edge executable was not found');
}

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function retry(task, label, deadline) {
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await task();
      if (value) return value;
    } catch (error) { lastError = error; }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error(`${label} timed out${lastError ? `: ${lastError.message}` : ''}`);
}

const port = await reservePort();
const profile = await mkdtemp(path.join(os.tmpdir(), 'rpgmap-edge-smoke-'));
const edge = spawn(edgePath(), [
  '--headless=new',
  '--disable-gpu',
  '--disable-dev-shm-usage',
  '--no-sandbox',
  '--no-first-run',
  '--no-default-browser-check',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`,
  targetUrl,
], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
let edgeError = '';
edge.stderr.setEncoding('utf8');
edge.stderr.on('data', chunk => { edgeError += chunk; });
let browserClosed = false;

try {
  const deadline = Date.now() + timeoutMs;
  const page = await retry(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`);
    const pages = await response.json();
    return pages.find(item => item.type === 'page' && item.webSocketDebuggerUrl);
  }, 'Edge CDP endpoint', deadline);

  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Edge CDP WebSocket open timed out')), 5_000);
    socket.addEventListener('open', () => { clearTimeout(timeout); resolve(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('Edge CDP WebSocket failed')); }, { once: true });
  });
  let nextId = 1;
  const pending = new Map();
  const failures = [];
  const exceptions = [];
  const responses = [];
  const rejectPending = message => {
    for (const { reject, timeout } of pending.values()) {
      clearTimeout(timeout);
      reject(new Error(message));
    }
    pending.clear();
  };
  socket.addEventListener('close', () => rejectPending('Edge CDP WebSocket closed'));
  socket.addEventListener('error', () => rejectPending('Edge CDP WebSocket failed'));
  socket.addEventListener('message', event => {
    const message = JSON.parse(String(event.data));
    if (message.id && pending.has(message.id)) {
      const { resolve, reject, timeout } = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(timeout);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
      return;
    }
    if (message.method === 'Network.loadingFailed') failures.push(message.params?.errorText || 'request failed');
    if (message.method === 'Network.responseReceived' && Number(message.params?.response?.status) >= 400) {
      failures.push(`${message.params.response.status} ${message.params.response.url}`);
    }
    if (message.method === 'Network.responseReceived' && Number(message.params?.response?.status) < 400) {
      responses.push(String(message.params.response.url || ''));
    }
    if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params?.exceptionDetails?.text || 'runtime exception');
    if (message.method === 'Log.entryAdded' && message.params?.entry?.level === 'error') {
      exceptions.push(message.params.entry.text || 'browser log error');
    }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Edge CDP command timed out: ${method}`));
    }, 5_000);
    pending.set(id, { resolve, reject, timeout });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'evaluation failed');
    return result.result?.value;
  };
  await Promise.all([send('Runtime.enable'), send('Network.enable'), send('Log.enable')]);

  await retry(
    () => evaluate(`Boolean(document.querySelector('[data-world-create-form]')) && document.body.innerText.includes('北宋兰州城')`),
    'World Manager with built-in Lanzhou metadata',
    deadline,
  );
  await evaluate(`(() => {
    const form = document.querySelector('[data-world-create-form]');
    form.querySelector('[name="name"]').value = 'Packaged Smoke World';
    form.requestSubmit();
    return true;
  })()`);
  let runtime;
  try {
    runtime = await retry(
      () => evaluate(`({
        leaflet: Boolean(document.querySelector('.leaflet-container')),
        title: document.querySelector('[data-role="app-title"]')?.textContent || '',
      })`).then(value => value?.leaflet && value.title.includes('北宋兰州城') ? value : null),
      'Lanzhou Leaflet Runtime',
      deadline,
    );
  } catch (error) {
    const pageState = await evaluate(`({
      title: document.title,
      boot: document.querySelector('[data-rpgmap-boot-status]')?.textContent || '',
      body: document.body.innerText.slice(0, 2000),
      leaflet: Boolean(document.querySelector('.leaflet-container')),
      features: document.querySelectorAll('[data-feature-id]').length,
    })`).catch(() => null);
    throw new Error(`${error.message}; page=${JSON.stringify(pageState)}; requests=${JSON.stringify(failures)}; errors=${JSON.stringify(exceptions)}`);
  }
  const assetAudit = await evaluate(`(async () => {
    const response = await fetch('./.vite/manifest.json', { cache: 'no-store' });
    if (!response.ok) throw new Error('manifest request failed: ' + response.status);
    const manifest = await response.json();
    const entry = manifest['src/map-package/default-map.js'];
    const assets = (entry?.assets || []).filter(file => file.endsWith('.webp'));
    if (assets.length !== 29) throw new Error('expected 29 Lanzhou WebP assets, got ' + assets.length);
    const sizes = await Promise.all(assets.map(async file => {
      const assetResponse = await fetch('./' + file, { cache: 'no-store' });
      if (!assetResponse.ok) throw new Error(file + ' returned ' + assetResponse.status);
      if (!String(assetResponse.headers.get('content-type') || '').startsWith('image/webp')) {
        throw new Error(file + ' has invalid content type');
      }
      const bytes = (await assetResponse.arrayBuffer()).byteLength;
      if (!bytes) throw new Error(file + ' is empty');
      return bytes;
    }));
    return { count: sizes.length, bytes: sizes.reduce((sum, value) => sum + value, 0) };
  })()`);
  await new Promise(resolve => setTimeout(resolve, 750));
  const visualState = await evaluate(`({
    svgCount: document.querySelectorAll('svg').length,
    imageCount: document.querySelectorAll('image').length,
    overlayChildren: document.querySelector('.leaflet-overlay-pane')?.childElementCount ?? -1,
    imageHrefs: [...document.querySelectorAll('image')].slice(0, 3).map(node => node.getAttribute('href')),
  })`);
  if (failures.length) throw new Error(`Browser requests failed: ${failures.join('; ')}`);
  if (exceptions.length) throw new Error(`Browser runtime errors: ${exceptions.join('; ')}`);
  for (const pattern of [/\/assets\/map-runtime-[^/]+\.js$/, /\/assets\/default-map-[^/]+\.js$/, /\.webp$/]) {
    if (!responses.some(url => pattern.test(url))) {
      throw new Error(`Browser did not load required Runtime asset: ${pattern}; visual=${JSON.stringify(visualState)}; responses=${JSON.stringify(responses.slice(-20))}`);
    }
  }
  console.log(JSON.stringify({ worldManager: true, map: 'northern-song-lanzhou-1104', assets: assetAudit, ...runtime }));
  await send('Browser.close');
  browserClosed = true;
} catch (error) {
  throw new Error(`${error.message}${edgeError ? `\nEdge stderr:\n${edgeError.slice(-4000)}` : ''}`);
} finally {
  if (!browserClosed && edge.exitCode === null) edge.kill('SIGKILL');
  if (edge.exitCode === null) {
    await new Promise(resolve => {
      const timeout = setTimeout(resolve, 2_000);
      edge.once('exit', () => { clearTimeout(timeout); resolve(); });
    });
  }
  await rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
    .catch(error => console.warn(`Browser smoke profile cleanup deferred: ${error.message}`));
}
