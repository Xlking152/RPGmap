import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'output', 'art-map-slice-v2');
const profile = await mkdtemp(path.join(os.tmpdir(), 'rpgmap-map-art-'));
const browserPath = process.env.RPGMAP_BROWSER_EXECUTABLE || path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe');
const listener = net.createServer();
await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
const port = listener.address().port;
await new Promise(resolve => listener.close(resolve));
const browser = spawn(browserPath, ['--headless=new', '--no-first-run', '--no-default-browser-check', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
const errors = [], failures = [], pending = new Map(), findings = [];
let socket, sequence = 0;
const delay = time => new Promise(resolve => setTimeout(resolve, time));
async function until(work, label) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    try { const result = await work(); if (result) return result; } catch { /* Wait for the runtime. */ }
    await delay(100);
  }
  throw new Error(`Timed out: ${label}`);
}
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timed out: ${method}`)); }, 20000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}
async function capture(name, center, zoom) {
  await evaluate(`void window.uiRefreshFixture.api.map.setView([5000-${center[1]},${center[0]}],${zoom},{animate:false})`);
  await send('Page.bringToFront');
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  await delay(700);
  const state = await evaluate(`(()=>{const api=window.uiRefreshFixture.api,r=document.querySelector('#map').getBoundingClientRect(),svg=document.querySelector('#map svg[viewBox="0 0 6000 5000"]');return{width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth,map:{x:r.x,y:r.y,width:r.width,height:r.height},zoom:api.map.getZoom(),tier:svg.dataset.zoomTier,treeCount:svg.querySelectorAll('[data-tree-art-for]').length,buildingCount:svg.querySelectorAll('[data-building-art-for]').length,treeHref:svg.querySelector('.generated-tree-art').getAttribute('href'),labels:[...svg.querySelectorAll('[data-map-label]')].filter(e=>getComputedStyle(e).display!=='none').map(e=>({text:e.textContent,rect:(()=>{const r=e.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height}})()}))}})()`);
  assert.equal(state.overflow, false);
  assert.equal(state.buildingCount, 50);
  assert(state.treeCount > 0);
  assert.match(state.treeHref, /tree-elm-canopy-v2/);
  const full = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await writeFile(path.join(output, `${name}.png`), Buffer.from(full.data, 'base64'));
  const map = await send('Page.captureScreenshot', { format: 'png', clip: { ...state.map, scale: 1 } });
  await writeFile(path.join(output, `${name}-map.png`), Buffer.from(map.data, 'base64'));
  const pixels = await evaluate(`(async()=>{const image=new Image();image.src='data:image/png;base64,${map.data}';await image.decode();const canvas=document.createElement('canvas');canvas.width=64;canvas.height=64;const context=canvas.getContext('2d');context.drawImage(image,0,0,64,64);const pixels=context.getImageData(0,0,64,64).data,colors=new Set();let min=255,max=0;for(let i=0;i<pixels.length;i+=4){const value=(pixels[i]+pixels[i+1]+pixels[i+2])/3;min=Math.min(min,value);max=Math.max(max,value);colors.add((pixels[i]>>3)+','+(pixels[i+1]>>3)+','+(pixels[i+2]>>3));}return{colors:colors.size,range:max-min};})()`);
  assert(pixels.colors > 30 && pixels.range > 60, `${name}: the real map must render`);
  findings.push({ name, center, ...state, pixels });
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
    } else if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text);
    else if (message.method === 'Network.responseReceived' && message.params.response.status >= 400) failures.push(message.params.response.url);
  });
  await send('Runtime.enable'); await send('Network.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: 'http://127.0.0.1:5174/scripts/ui-refresh-preview.html' });
  await until(() => evaluate("document.documentElement.dataset.fixtureReady === 'true'"), 'live map');
  findings.push({ name: 'near-gate-placement', placements: await evaluate(`[{x:3367.5,y:1606.5},{x:3366.5,y:1612.5},{x:2774.5,y:2820.5},{x:2810.5,y:2375.5}].map(point=>({point,result:window.uiRefreshFixture.api.inspectTokenPlacement(null,point,{diameterMeters:1,elevationMeters:0})}))`) });
  await capture('north-gate-street', [3300, 1720], .25);
  await capture('city-middle', [3090, 2240], -.5);
  await capture('yamen-neighborhood', [2810, 2550], .25);
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
  await evaluate('void window.uiRefreshFixture.api.map.invalidateSize({pan:false})');
  await capture('mobile-north-gate', [3360, 1660], -.5);
  assert.deepEqual(errors, []); assert.deepEqual(failures, []);
  await writeFile(path.join(output, 'visual-check.json'), JSON.stringify({ scope: 'Real offline Runtime, map art only; independent package integration is tested separately', browserPath, findings, errors, failures }, null, 2));
  console.log(JSON.stringify({ passed: true, captures: findings.filter(item => item.center).length, errors, failures, output }));
} finally {
  if (socket?.readyState === WebSocket.OPEN) { try { await send('Browser.close'); } catch { /* Browser exit closes CDP. */ } socket.close(); }
  for (const item of pending.values()) clearTimeout(item.timer);
  if (browser.exitCode === null) { await Promise.race([new Promise(resolve => browser.once('exit', resolve)), delay(2000)]); if (browser.exitCode === null) browser.kill(); }
  await delay(300);
  const resolved = path.resolve(profile);
  assert(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('rpgmap-map-art-'));
  await rm(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
}
