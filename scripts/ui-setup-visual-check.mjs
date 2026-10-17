import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'output', 'ui-refresh');
const profile = await mkdtemp(path.join(os.tmpdir(), 'rpgmap-setup-ui-'));
const browserPath = process.env.RPGMAP_BROWSER_EXECUTABLE || path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe');
const listener = net.createServer();
await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
const port = listener.address().port;
await new Promise(resolve => listener.close(resolve));
const browser = spawn(browserPath, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-gpu', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
const errors = [], findings = [], pending = new Map();
let socket, sequence = 0;
const delay = time => new Promise(resolve => setTimeout(resolve, time));
async function until(work, label) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try { const result = await work(); if (result) return result; } catch { /* Wait for browser startup or UI refresh. */ }
    await delay(100);
  }
  throw new Error(`Timed out: ${label}`);
}
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timed out: ${method}`)); }, 15000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}
async function capture(name) {
  await delay(100);
  assert.equal(await evaluate("document.querySelector('vite-error-overlay') !== null"), false, `${name}: Vite must not show an error overlay`);
  const image = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await writeFile(path.join(output, `setup-${name}.png`), Buffer.from(image.data, 'base64'));
}
async function openView(label) {
  await evaluate(`[...document.querySelectorAll('.setup-nav-item')].find(node => node.textContent.trim() === ${JSON.stringify(label)}).click()`);
}
async function verifyViewport(name) {
  const dimensions = await evaluate(`({ width:innerWidth, document:document.documentElement.scrollWidth, content:document.querySelector('.setup-content').clientWidth, contentScroll:document.querySelector('.setup-content').scrollWidth, active:[...document.querySelectorAll('.setup-view')].filter(node=>!node.hidden).map(node=>node.dataset.view) })`);
  assert.equal(dimensions.document, dimensions.width, `${name}: body must not overflow horizontally`);
  assert(dimensions.contentScroll <= dimensions.content, `${name}: management content must not overflow horizontally`);
  assert.equal(dimensions.active.length, 1);
  findings.push({ name, ...dimensions });
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
    else if (message.method === 'Network.responseReceived' && message.params.response.status >= 400) errors.push(`${message.params.response.status}: ${message.params.response.url}`);
    else if (message.method === 'Page.javascriptDialogOpening') void send('Page.handleJavaScriptDialog', { accept: true });
  });
  await send('Runtime.enable'); await send('Network.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `${process.env.RPGMAP_UI_PREVIEW_ORIGIN || 'http://127.0.0.1:5174'}/scripts/ui-setup-preview.html` });
  await until(() => evaluate('window.uiSetupReady'), 'management preview');
  await delay(500);
  for (const [id, label] of [['worlds', '世界'], ['maps', '地图'], ['rulesets', '规则'], ['backups', '恢复点'], ['settings', '设置']]) {
    await openView(label); await verifyViewport(`desktop-${id}`); await capture(`desktop-${id}`);
  }
  await openView('地图');
  await evaluate('window.uiSetupReady = false');
  await send('Page.reload');
  await until(() => evaluate('window.uiSetupReady'), 'management reload');
  assert.equal(await evaluate("document.querySelector('.setup-view-maps').hidden"), false);
  await openView('世界');
  await evaluate(`(()=>{const input=document.querySelector('[aria-label="搜索世界名称或规则"]');input.value='西北';input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  assert.equal(await evaluate(`[...document.querySelectorAll('.setup-world-row')].filter(node=>!node.hidden).length`), 1);
  await evaluate(`(()=>{const input=document.querySelector('[aria-label="搜索世界名称或规则"]');input.value='';input.dispatchEvent(new Event('input',{bubbles:true}));[...document.querySelectorAll('.setup-button')].find(node=>node.textContent==='新建世界').click();})()`);
  assert.equal(await evaluate('document.querySelector(".setup-dialog").open'), true);
  await capture('desktop-create-world');
  await evaluate(`document.querySelector('[aria-label="World 名称"]').value='浏览器验收世界';document.querySelector('.setup-create-world').requestSubmit()`);
  await until(() => evaluate('!document.querySelector(".setup-dialog")'), 'world creation');
  assert.equal(await evaluate('window.uiSetupFixture.catalog.worlds.length'), 4);
  await openView('恢复点');
  await evaluate(`document.querySelector('[aria-label="恢复点所属世界"]').value='preview-world-a';document.querySelector('[aria-label="恢复点所属世界"]').dispatchEvent(new Event('change',{bubbles:true}));[...document.querySelectorAll('.setup-view-backups .setup-button')].find(node=>node.textContent==='恢复此记录').click()`);
  await until(() => evaluate(`window.uiSetupFixture.requests.some(item=>item.endpoint.endsWith('/restore'))`), 'restore request');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
  for (const [id, label] of [['worlds', '世界'], ['maps', '地图'], ['rulesets', '规则'], ['backups', '恢复点'], ['settings', '设置']]) {
    await openView(label); await evaluate(`document.querySelector('.setup-content').scrollTop=0`); await verifyViewport(`mobile-${id}`); await capture(`mobile-${id}`);
  }
  await openView('世界');
  await evaluate(`[...document.querySelectorAll('.setup-button')].find(node=>node.textContent==='新建世界').click()`);
  await verifyViewport('mobile-create-world'); await capture('mobile-create-world');
  assert.deepEqual(errors, []);
  await writeFile(path.join(output, 'setup-visual-check.json'), `${JSON.stringify({ fixture: true, browser: browserPath, findings, errors, checks: ['five views', 'persistent navigation', 'search', 'create world', 'restore', 'desktop and 390px overflow'] }, null, 2)}\n`);
  console.log(JSON.stringify({ passed: true, viewportChecks: findings.length, errors, output }));
} finally {
  if (socket?.readyState === WebSocket.OPEN) { try { await send('Browser.close'); } catch { /* Chrome closes the socket while acknowledging. */ } socket.close(); }
  for (const entry of pending.values()) clearTimeout(entry.timer);
  if (browser.exitCode === null) { await Promise.race([new Promise(resolve => browser.once('exit', resolve)), delay(2000)]); if (browser.exitCode === null) browser.kill(); }
  await delay(300);
  const resolved = path.resolve(profile);
  assert(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('rpgmap-setup-ui-'));
  await rm(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
}
