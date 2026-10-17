import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { readUiReviewOptions } from './ui-review-options.mjs';

const root = path.resolve(import.meta.dirname, '..');
const { sessionName, mapVersion } = readUiReviewOptions(process.argv.slice(2));
const output = path.join(root, 'output', sessionName);
const config = JSON.parse(await readFile(path.join(output, 'session.json'), 'utf8'));
const health = await (await fetch(`${config.origin}/api/health`)).json();
assert.equal(health.status, 'ok');
assert.equal(health.world.worldId, config.worldId);
assert.equal(health.world.mapPackage.version, mapVersion);
const profile = await mkdtemp(path.join(os.tmpdir(), 'rpgmap-local-session-smoke-'));
const browserPath = process.env.RPGMAP_BROWSER_EXECUTABLE || path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe');
const listener = net.createServer();
await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
const port = listener.address().port;
await new Promise(resolve => listener.close(resolve));
const browser = spawn(browserPath, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-gpu', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
const errors = [], httpErrors = [], failedRequests = [], resources = [], pending = new Map();
let socket, sequence = 0, welcome = null;
const delay = time => new Promise(resolve => setTimeout(resolve, time));
async function until(work, label) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    try { const value = await work(); if (value) return value; } catch { /* Wait for production initialization. */ }
    await delay(100);
  }
  throw new Error(`Timed out: ${label}`);
}
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timed out: ${method}`)); }, 15000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}
function resourcePath(url) {
  try { const value = new URL(url); return `${value.origin}${value.pathname}`; } catch { return 'invalid-url'; }
}
try {
  await mkdir(output, { recursive: true });
  const target = await until(async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(item => item.type === 'page'), 'Chrome target');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const request = pending.get(message.id); if (!request) return;
      pending.delete(message.id); clearTimeout(request.timer);
      if (message.error) request.reject(new Error(message.error.message)); else request.resolve(message.result);
    } else if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
    else if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') errors.push(message.params.args.map(item => item.value || item.description).join(' '));
    else if (message.method === 'Network.responseReceived') {
      const response = message.params.response;
      resources.push({ url: resourcePath(response.url), type: message.params.type, status: response.status });
      if (response.status >= 400) httpErrors.push({ url: resourcePath(response.url), status: response.status });
    } else if (message.method === 'Network.loadingFailed') failedRequests.push({ type: message.params.type, error: message.params.errorText });
    else if (message.method === 'Network.webSocketFrameReceived') {
      let frame; try { frame = JSON.parse(message.params.response.payloadData); } catch { return; }
      if (frame.type === 'welcome') welcome = { role: frame.session?.role, identityStatus: frame.session?.identityStatus, worldId: frame.world?.state?.preferences?.worldV2?.id, revision: frame.world?.revision };
      if (frame.type === 'error') errors.push(`Server rejected connection: ${frame.code}`);
    }
  });
  await send('Runtime.enable'); await send('Network.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: config.hostUrl });
  await until(() => welcome?.role === 'gm', 'authoritative GM welcome');
  assert.equal(welcome.identityStatus, 'active');
  assert.equal(welcome.worldId, config.worldId);
  await until(() => evaluate("document.querySelector('.multiplayer-toolbar')?.dataset.state === 'online' && document.querySelector('.multiplayer-backdrop')?.hidden && !!document.querySelector('.leaflet-pane svg [data-feature-id]')"), 'authenticated and rendered production map');
  await delay(1800);
  const state = await evaluate(`(()=>{const map=document.querySelector('.leaflet-container'),rect=map.getBoundingClientRect(),images=[...map.querySelectorAll('image')];return{url:location.origin+location.pathname,hashCleared:location.hash==='',connection:document.querySelector('.multiplayer-toolbar').dataset.state,label:document.querySelector('[data-mp-label]').textContent,loginHidden:document.querySelector('.multiplayer-backdrop').hidden,map:{width:rect.width,height:rect.height,features:map.querySelectorAll('[data-feature-id]').length,images:images.length},imageUrls:[...new Set(images.map(image=>image.getAttribute('href')||image.getAttribute('xlink:href')).filter(Boolean))],overflow:document.documentElement.scrollWidth>innerWidth};})()`);
  assert.equal(state.hashCleared, true, 'GM launch credentials must be removed from the URL');
  assert.equal(state.connection, 'online'); assert.equal(state.loginHidden, true); assert.match(state.label, /^GM/);
  assert.equal(state.overflow, false); assert(state.map.width > 400 && state.map.height > 400);
  assert(state.map.features > 50 && state.map.images > 0, 'The real map and image assets must be present');
  const imageCheck = await evaluate(`(async()=>{const urls=${JSON.stringify(state.imageUrls)};const loaded=await Promise.all(urls.map(async url=>{const image=new Image();image.src=url;await image.decode();return image.naturalWidth>0&&image.naturalHeight>0;}));return{count:loaded.length,allLoaded:loaded.every(Boolean)};})()`);
  assert(imageCheck.count > 0 && imageCheck.allLoaded, 'Every referenced map sprite must decode successfully');
  delete state.imageUrls;
  const screenshot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await writeFile(path.join(output, 'connected-gm-map.png'), Buffer.from(screenshot.data, 'base64'));
  const pixels = await evaluate(`(async()=>{const image=new Image();image.src='data:image/png;base64,${screenshot.data}';await image.decode();const canvas=document.createElement('canvas');canvas.width=64;canvas.height=64;const ctx=canvas.getContext('2d'),r=document.querySelector('.leaflet-container').getBoundingClientRect();ctx.drawImage(image,r.x,r.y,r.width,r.height,0,0,64,64);const data=ctx.getImageData(0,0,64,64).data,colors=new Set();for(let i=0;i<data.length;i+=4)colors.add((data[i]>>3)+','+(data[i+1]>>3)+','+(data[i+2]>>3));return{colors:colors.size};})()`);
  assert(pixels.colors > 32, 'The production map must not be a blank surface');
  assert.deepEqual(errors, []); assert.deepEqual(httpErrors, []); assert.deepEqual(failedRequests, []);
  const report = { passed: true, scope: 'Read-only production dist GM connection; no World mutations or Player authority acceptance', origin: config.origin, worldId: config.worldId, welcome, state, imageCheck, pixels, errors, httpErrors, failedRequests, resources };
  await writeFile(path.join(output, 'smoke-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ passed: true, welcome, state, imageCheck, pixels, errors, httpErrors, failedRequests, output }));
} catch (error) {
  console.error(JSON.stringify({ passed: false, failure: error.message, welcome, errors, httpErrors, failedRequests }));
  throw error;
} finally {
  if (socket?.readyState === WebSocket.OPEN) { try { await send('Browser.close'); } catch { /* Browser closes while acknowledging. */ } socket.close(); }
  for (const item of pending.values()) clearTimeout(item.timer);
  if (browser.exitCode === null) { await Promise.race([new Promise(resolve => browser.once('exit', resolve)), delay(2000)]); if (browser.exitCode === null) browser.kill(); }
  await delay(300);
  const resolved = path.resolve(profile);
  assert(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('rpgmap-local-session-smoke-'));
  await rm(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
}
