import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

if (process.platform !== 'win32') throw new Error('Packaged browser smoke requires Windows');
const browserName = String(process.env.RPGMAP_SMOKE_BROWSER || 'edge').toLowerCase();
if (!['edge', 'chrome'].includes(browserName)) throw new Error(`Unsupported smoke browser: ${browserName}`);
const targetUrl = String(process.argv[2] || '').trim();
if (!/^http:\/\/127\.0\.0\.1:\d+\/?/.test(targetUrl)) throw new Error('Browser smoke requires a loopback HTTP URL');
const timeoutMs = Math.max(10_000, Number(process.argv[3]) || 30_000);
const mode = String(process.argv[4] || 'bootstrap');
if (!['bootstrap', 'fog'].includes(mode)) throw new Error(`Unknown browser smoke mode: ${mode}`);
const viewportMatch = /^(\d{2,4})x(\d{2,4})$/.exec(String(process.env.RPGMAP_SMOKE_VIEWPORT || ''));

function edgePath() {
  const roots = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean);
  const suffixes = browserName === 'chrome'
    ? [['Google', 'Chrome', 'Application', 'chrome.exe'], ['Google', 'Chrome Beta', 'Application', 'chrome.exe']]
    : [['Microsoft', 'Edge', 'Application', 'msedge.exe'], ['Microsoft', 'Edge SxS', 'Application', 'msedge.exe']];
  for (const root of roots) {
    for (const suffix of suffixes) {
      const candidate = path.join(root, ...suffix);
      try {
        if (process.getBuiltinModule('fs').existsSync(candidate)) return candidate;
      } catch {}
    }
  }
  throw new Error(`${browserName === 'chrome' ? 'Google Chrome' : 'Microsoft Edge'} executable was not found`);
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
const profile = await mkdtemp(path.join(os.tmpdir(), `rpgmap-${browserName}-smoke-`));
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
    if (message.method === 'Network.loadingFailed' && message.params?.errorText !== 'net::ERR_ABORTED') {
      failures.push(message.params?.errorText || 'request failed');
    }
    if (message.method === 'Network.responseReceived' && Number(message.params?.response?.status) >= 400) {
      failures.push(`${message.params.response.status} ${message.params.response.url}`);
    }
    if (message.method === 'Network.responseReceived' && Number(message.params?.response?.status) < 400) {
      responses.push(String(message.params.response.url || ''));
    }
    if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params?.exceptionDetails?.text || 'runtime exception');
    if (message.method === 'Runtime.consoleAPICalled' && message.params?.type === 'error') {
      const rendered = (message.params.args || []).map(argument => (
        argument.value ?? argument.unserializableValue ?? argument.description ?? ''
      )).filter(Boolean).join(' ');
      exceptions.push(rendered || 'browser console error');
    }
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
  if (viewportMatch) {
    await send('Emulation.setDeviceMetricsOverride', {
      width: Number(viewportMatch[1]), height: Number(viewportMatch[2]),
      deviceScaleFactor: 1, mobile: true,
    });
    await send('Page.reload', { ignoreCache: true });
  }

  if (mode === 'bootstrap') {
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
  }
  let runtime;
  try {
    runtime = await retry(
      () => evaluate(`(() => {
        const api = document.querySelector('#app')?.rpgMapApp;
        const baseSvg = document.querySelector('.leaflet-base-pane svg.leaflet-image-layer');
        const bounds = baseSvg?.getBoundingClientRect();
        let center = null;
        let zoom = null;
        try {
          center = api?.map?.getCenter?.() || null;
          zoom = api?.map?.getZoom?.();
        } catch {}
        return {
          leaflet: Boolean(document.querySelector('.leaflet-container')),
          title: document.querySelector('[data-role="app-title"]')?.textContent || '',
          mapReady: Boolean(center) && Number.isFinite(zoom),
          baseSvg: Boolean(baseSvg),
          baseSvgWidth: bounds?.width || 0,
          baseSvgHeight: bounds?.height || 0,
          mapImages: baseSvg?.querySelectorAll('image').length || 0,
        };
      })()`).then(value => value?.leaflet
        && value.title.includes('北宋兰州城')
        && value.mapReady
        && value.baseSvg
        && value.baseSvgWidth > 0
        && value.baseSvgHeight > 0
        && value.mapImages > 0
        ? value
        : null),
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
  let fogAudit = null;
  if (mode === 'fog') {
    await retry(() => evaluate(`(() => {
        const api = document.querySelector('#app')?.rpgMapApp;
        return { connected: api?.multiplayer?.getStatus?.()?.connected === true, token: Boolean(api?.tokens?.get?.('smoke-pc-token')) };
      })()`).then(status => status?.connected && status?.token ? status : null),
    'LAN Runtime with smoke Token', deadline);
    await evaluate(`document.querySelector('#app').rpgMapApp.vision.setSource('smoke-pc-token')`);
    await evaluate(`document.querySelector('#app').rpgMapApp.selection.replace(['smoke-pc-token'], 'smoke-pc-token')`);
    fogAudit = await retry(() => evaluate(`(() => {
        const canvas = document.querySelector('.rpgmap-vision-fog-perception');
        if (!canvas || canvas.hidden || !canvas.width || !canvas.height) return null;
        const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        let minAlpha = 255, maxAlpha = 0;
        for (let index = 3; index < data.length; index += 4) {
          minAlpha = Math.min(minAlpha, data[index]);
          maxAlpha = Math.max(maxAlpha, data[index]);
        }
        return maxAlpha > 200 && minAlpha < 200 ? { width: canvas.width, height: canvas.height, minAlpha, maxAlpha } : null;
      })()`), 'Fog Canvas with opaque and realtime-visible pixels', deadline);
  }
  const assetAudit = await evaluate(`(async () => {
    const response = await fetch('./.vite/manifest.json', { cache: 'no-store' });
    if (!response.ok) throw new Error('manifest request failed: ' + response.status);
    const manifest = await response.json();
    const entry = manifest['src/map-package/default-map.js'];
    const assets = (entry?.assets || []).filter(file => file.endsWith('.webp'));
    const runtimeAssets = [
      manifest['reference/maps/lanzhou/runtime.json']?.file,
      manifest['reference/maps/lanzhou/runtime.svg']?.file,
    ];
    if (assets.length !== 29) throw new Error('expected 29 Lanzhou WebP assets, got ' + assets.length);
    if (runtimeAssets.some(file => !file) || runtimeAssets.some(file => !(entry?.assets || []).includes(file))) {
      throw new Error('Lanzhou runtime JSON/SVG assets are missing from the default MapPackage');
    }
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
    const runtimeSizes = await Promise.all(runtimeAssets.map(async file => {
      const assetResponse = await fetch('./' + file, { cache: 'no-store' });
      if (!assetResponse.ok) throw new Error(file + ' returned ' + assetResponse.status);
      const expectedType = file.endsWith('.json') ? 'application/json' : 'image/svg+xml';
      if (!String(assetResponse.headers.get('content-type') || '').startsWith(expectedType)) {
        throw new Error(file + ' has invalid content type');
      }
      const bytes = (await assetResponse.arrayBuffer()).byteLength;
      if (!bytes) throw new Error(file + ' is empty');
      return bytes;
    }));
    return {
      count: sizes.length,
      bytes: sizes.reduce((sum, value) => sum + value, 0),
      runtimeCount: runtimeSizes.length,
      runtimeBytes: runtimeSizes.reduce((sum, value) => sum + value, 0),
    };
  })()`);
  await new Promise(resolve => setTimeout(resolve, 750));
  const visualState = await evaluate(`({
    baseSvgCount: document.querySelectorAll('.leaflet-base-pane svg.leaflet-image-layer').length,
    mapImageCount: document.querySelectorAll('.leaflet-base-pane svg.leaflet-image-layer image').length,
    overlayChildren: document.querySelector('.leaflet-overlay-pane')?.childElementCount ?? -1,
    imageHrefs: [...document.querySelectorAll('image')].slice(0, 3).map(node => node.getAttribute('href')),
  })`);
  if (visualState.baseSvgCount !== 1 || visualState.mapImageCount < 1) {
    throw new Error(`Lanzhou base SVG was not rendered: ${JSON.stringify(visualState)}`);
  }
  const layoutAudit = await evaluate(`(() => {
    const summary = document.querySelector('.selected-token-summary:not([hidden])');
    const rect = summary?.getBoundingClientRect() || null;
    return {
      innerWidth,
      bodyScrollWidth: document.body.scrollWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
      summary: rect ? { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom } : null,
    };
  })()`);
  if (layoutAudit.bodyScrollWidth > layoutAudit.innerWidth || layoutAudit.documentScrollWidth > layoutAudit.innerWidth) {
    throw new Error(`Browser layout has horizontal overflow: ${JSON.stringify(layoutAudit)}`);
  }
  if (layoutAudit.summary && (layoutAudit.summary.left < 0 || layoutAudit.summary.right > layoutAudit.innerWidth)) {
    throw new Error(`Selected Token summary leaves the viewport: ${JSON.stringify(layoutAudit)}`);
  }
  if (process.env.RPGMAP_SMOKE_SCREENSHOT_DIR) {
    const directory = path.resolve(process.env.RPGMAP_SMOKE_SCREENSHOT_DIR);
    await mkdir(directory, { recursive: true });
    const capture = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await writeFile(path.join(directory, `packaged-${mode}.png`), Buffer.from(capture.data, 'base64'));
  }
  if (failures.length) throw new Error(`Browser requests failed: ${failures.join('; ')}`);
  if (exceptions.length) throw new Error(`Browser runtime errors: ${exceptions.join('; ')}`);
  for (const pattern of [/\/assets\/ruleset-[^/]+\.js$/, /\/assets\/map-runtime-[^/]+\.js$/, /\/assets\/default-map-[^/]+\.js$/, /\/assets\/runtime-[^/]+\.json$/, /\/assets\/runtime-[^/]+\.svg$/, /\.webp$/]) {
    if (!responses.some(url => pattern.test(url))) {
      throw new Error(`Browser did not load required Runtime asset: ${pattern}; visual=${JSON.stringify(visualState)}; responses=${JSON.stringify(responses.slice(-20))}`);
    }
  }
  console.log(JSON.stringify({ worldManager: mode === 'bootstrap', map: 'northern-song-lanzhou-1104', assets: assetAudit, fog: fogAudit, layout: layoutAudit, ...runtime }));
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
