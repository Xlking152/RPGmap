import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

const root = path.resolve(import.meta.dirname, '..');
const output = process.env.RPGMAP_UI_CHECK_OUTPUT ? path.resolve(process.env.RPGMAP_UI_CHECK_OUTPUT) : path.join(root, 'output', 'ui-refresh');
const profile = await mkdtemp(path.join(os.tmpdir(), 'rpgmap-workbench-ui-'));
const browserPath = process.env.RPGMAP_BROWSER_EXECUTABLE || path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe');
const listener = net.createServer();
await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
const port = listener.address().port;
await new Promise(resolve => listener.close(resolve));
const browser = spawn(browserPath, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-gpu', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
const errors = [], findings = [], gameSockets = [], pending = new Map();
let socket, sequence = 0;
const delay = time => new Promise(resolve => setTimeout(resolve, time));
async function until(work, label) {
  const deadline = Date.now() + 60000;
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
  await writeFile(path.join(output, `workbench-${name}.png`), Buffer.from(image.data, 'base64'));
  const styles = await evaluate(`(()=>{const selectors=['.ui-current-card','.entity-sheet','.entity-sheet-header','.entity-sheet-tabs','.entity-sheet-body','.entity-health-panel','.entity-play-resources','.entity-play-statuses','.status-quick-hud','.status-quick-group','.status-quick-grid button'];return selectors.flatMap(selector=>[...document.querySelectorAll(selector)].map(node=>{const rect=node.getBoundingClientRect(),style=getComputedStyle(node);return {selector,width:rect.width,height:rect.height,display:style.display,background:style.backgroundColor,color:style.color,fontSize:style.fontSize,padding:style.padding,border:style.border,gap:style.gap};}));})()`);
  await writeFile(path.join(output, `workbench-${name}.styles.json`), JSON.stringify(styles, null, 2));
}
async function geometry() {
  return evaluate(`(()=>{const map=document.querySelector('#map').getBoundingClientRect(),sidebar=document.querySelector('.sidebar').getBoundingClientRect();return{width:innerWidth,document:document.documentElement.scrollWidth,map:{x:map.x,y:map.y,width:map.width,height:map.height},sidebar:{width:sidebar.width,height:sidebar.height},expanded:document.querySelector('[data-inspector-toggle]').getAttribute('aria-expanded')}})()`);
}
async function verifyLayout(label) {
  const layout = await geometry();
  assert(layout.document <= layout.width, `${label}: document must not overflow horizontally`);
  assert(layout.map.width >= 100 && layout.map.height >= 100, `${label}: map must remain visible`);
  assert.equal(await evaluate("document.querySelector('vite-error-overlay') !== null"), false);
  findings.push({ name: label, ...layout });
  return layout;
}
async function verifyMapPixels(label) {
  const { map } = await geometry();
  const image = await send('Page.captureScreenshot', { format: 'png', clip: { x: map.x, y: map.y, width: map.width, height: map.height, scale: 1 } });
  const statistics = await evaluate(`(async()=>{const image=new Image();image.src='data:image/png;base64,${image.data}';await image.decode();const canvas=document.createElement('canvas');canvas.width=64;canvas.height=64;const context=canvas.getContext('2d');context.drawImage(image,0,0,64,64);const pixels=context.getImageData(0,0,64,64).data,colors=new Set();let min=255,max=0;for(let i=0;i<pixels.length;i+=4){const value=(pixels[i]+pixels[i+1]+pixels[i+2])/3;min=Math.min(min,value);max=Math.max(max,value);colors.add((pixels[i]>>3)+','+(pixels[i+1]>>3)+','+(pixels[i+2]>>3));}return{colors:colors.size,range:max-min};})()`);
  assert(statistics.colors > 32 && statistics.range > 40, `${label}: map screenshot must contain rendered map content`);
  findings.push({ name: `${label}-pixels`, ...statistics });
}
async function verifyChrome(label) {
  const expanded = await verifyLayout(`${label}-expanded`);
  assert.equal(expanded.expanded, 'true');
  const icons = await evaluate(`(()=>{const nodes=[...document.querySelectorAll('.tool-rail button')].filter(node=>!node.hidden&&node.getBoundingClientRect().width>0);return nodes.map(node=>{const r=node.getBoundingClientRect();return{label:node.getAttribute('aria-label')||node.title,icon:!!node.querySelector('svg.ui-icon'),inViewport:r.x>=0&&r.right<=innerWidth&&r.y>=0&&r.bottom<=innerHeight}});})()`);
  assert(icons.length >= 4 && icons.every(item => item.icon && item.inViewport), `${label}: all visible map tools need real icons within the viewport`);
  await evaluate("document.querySelector('[data-inspector-toggle]').click()"); await delay(200);
  const collapsed = await verifyLayout(`${label}-collapsed`);
  assert.equal(collapsed.expanded, 'false');
  assert.equal(collapsed.sidebar.width, 0);
  assert(collapsed.map.width > expanded.map.width || collapsed.map.height > expanded.map.height, `${label}: collapsing the inspector must return space to the map ${JSON.stringify({expanded,collapsed})}`);
  await capture(`${label}-map-expanded`);
  await evaluate("document.querySelector('[data-inspector-toggle]').click()"); await delay(200);
  assert.equal((await geometry()).expanded, 'true');
  await evaluate("document.querySelector('[data-world-commands] summary').click()");
  assert.equal(await evaluate("document.querySelector('[data-world-commands]').open"), true);
  assert.equal(await evaluate("(()=>{const r=document.querySelector('.ui-command-popover').getBoundingClientRect();return r.x>=0&&r.right<=innerWidth&&r.y>=0&&r.bottom<=innerHeight;})()"), true, `${label}: world operations must not be clipped`);
  await capture(`${label}-world-menu`);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  assert.equal(await evaluate("document.querySelector('[data-world-commands]').open"), false);
  await evaluate("document.querySelector('[data-ui-panel=actors]').click()");
  await until(() => evaluate("document.querySelector('[data-entity-search]')"), 'actor directory');
  const directoryCount = await evaluate("[...document.querySelectorAll('[data-entity-list] > [data-actor-id]')].filter(node=>!node.hidden).length");
  assert(directoryCount >= 2, 'The real actor directory must contain the fixture player characters');
  await evaluate(`(()=>{const input=document.querySelector('[data-entity-search]');window.uiSearchInputBefore=input;input.value='银';input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  assert.equal(await evaluate("[...document.querySelectorAll('[data-entity-list] > [data-actor-id]')].filter(node=>!node.hidden).length"), 1);
  assert.equal(await evaluate("window.uiSearchInputBefore === document.querySelector('[data-entity-search]')"), true);
  await capture(`${label}-directory-search`);
  await evaluate(`(()=>{const input=document.querySelector('[data-entity-search]');input.value='';input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  assert.equal(await evaluate("[...document.querySelectorAll('[data-entity-list] > [data-actor-id]')].filter(node=>!node.hidden).length"), directoryCount);
}
async function verifySheet(label) {
  await evaluate(`(()=>{const f=window.uiRefreshFixture;f.api.selection.replace([f.tokenIds[0]],f.tokenIds[0]);document.querySelector('[data-ui-panel=current]').click();})()`);
  await until(() => evaluate("document.querySelector('.ui-current-card')"), 'selected token inspector');
  assert.equal(await evaluate("document.querySelector('.ui-current-card').dataset.tokenId"), 'ui-review-silver-token');
  const summaryVisible = () => evaluate("(()=>{const node=document.querySelector('.selected-token-summary');return !!node && !node.hidden && getComputedStyle(node).display !== 'none'})()");
  assert.equal(await summaryVisible(), false, `${label}: object inspector replaces duplicate selected-token summary`);
  await evaluate("document.querySelector('[data-ui-sidebar=chat]').click()");
  assert.equal(await summaryVisible(), true, `${label}: chat keeps selected-token summary available`);
  await evaluate("document.querySelector('[data-ui-panel=current]').click();document.querySelector('[data-inspector-toggle]').click()");
  assert.deepEqual(await evaluate("[...document.querySelectorAll('.sidebar [data-panel].active')].map(node=>node.dataset.panel)"), ['current'], `${label}: changing back from chat leaves only the object panel active`);
  assert.equal(await summaryVisible(), true, `${label}: collapsed inspector keeps selected-token summary available`);
  await evaluate("document.querySelector('[data-inspector-toggle]').click()");
  assert.equal(await summaryVisible(), false, `${label}: reopening object inspector removes duplicate summary`);
  findings.push({ name: `${label}-contextual-selection-summary`, object: false, chat: true, collapsed: true });
  await capture(`${label}-selected-token`);
  await evaluate("window.uiRefreshFixture.api.statusUi.openQuickHud('ui-review-silver-token', { x: 90, y: 120 })");
  await until(() => evaluate("document.querySelector('.status-quick-hud')"), 'real status HUD');
  assert.equal(await evaluate("(()=>{const r=document.querySelector('.status-quick-hud').getBoundingClientRect();return r.x >= 0 && r.right <= innerWidth && r.bottom <= innerHeight})()"), true, 'status HUD fits viewport');
  await capture(`${label}-status-hud`);
  await evaluate("window.uiRefreshFixture.api.statusUi.closeQuickHud()");
  await evaluate("document.querySelector('.ui-current-card [aria-label=打开角色卡], .ui-current-card [aria-label=角色卡]').click()");
  await until(() => evaluate("document.querySelector('.entity-sheet')"), 'real actor sheet');
  await evaluate("document.querySelector('.entity-sheet-tabs [data-sheet-tab=overview]').click()");
  await until(() => evaluate("document.querySelector('[data-sheet-health-action=damage]')"), 'play health actions');
  const before = await evaluate("window.uiRefreshFixture.api.health.resolveToken('ui-review-silver-token').current");
  await evaluate("(()=>{const row=document.querySelector('[data-sheet-health-row=damage]');row.querySelector('input').value='6';row.querySelector('button').click()})()");
  await until(() => evaluate(`window.uiRefreshFixture.api.health.resolveToken('ui-review-silver-token').current === ${Math.max(0, before - 6)}`), 'damage confirmed on the sheet instance');
  await until(() => evaluate("document.querySelector('[data-health-panel]')?.dataset.healthPending === 'false' && !document.querySelector('[data-sheet-health-action=healing]').disabled"), 'damage control acknowledgement');
  await evaluate("(()=>{const row=document.querySelector('[data-sheet-health-row=healing]');row.querySelector('input').value='2';row.querySelector('button').click()})()");
  await until(() => evaluate(`window.uiRefreshFixture.api.health.resolveToken('ui-review-silver-token').current === ${Math.max(0, before - 6) + 2}`), 'healing confirmed on the sheet instance');
  assert.equal(await evaluate("window.uiRefreshFixture.api.health.resolveToken('ui-review-han-token').current"), 24, 'damage never touches another instance');
  await capture(`${label}-play-overview`);
  assert.equal(await evaluate("document.querySelector('.entity-sheet [data-sheet-mode-toggle]') === null"), true, 'Token cards never grant template editing permissions');
  const tabs = await evaluate("[...document.querySelectorAll('.entity-sheet-tabs [data-sheet-tab]')].map(node=>node.dataset.sheetTab)");
  for (const required of ['overview', 'combat', 'status', 'token']) assert(tabs.includes(required), `The actual Ruleset sheet must retain ${required}`);
  for (const tab of tabs) {
    await evaluate(`document.querySelector('.entity-sheet-tabs [data-sheet-tab="${tab}"]').click()`);
    await until(() => evaluate(`document.querySelector('.entity-sheet-tabs [data-sheet-tab="${tab}"]').getAttribute('aria-current') === 'page'`), `${tab} sheet tab`);
    await delay(100);
    const sheet = await evaluate(`(()=>{const node=document.querySelector('.entity-sheet'),tabs=node.querySelector('.entity-sheet-tabs'),body=node.querySelector('.entity-sheet-body'),r=node.getBoundingClientRect(),b=body.getBoundingClientRect();return{tab:${JSON.stringify(tab)},x:r.x,y:r.y,width:r.width,height:r.height,client:node.clientWidth,scroll:node.scrollWidth,tabsClient:tabs.clientWidth,tabsScroll:tabs.scrollWidth,bodyClient:body.clientWidth,bodyScroll:body.scrollWidth,bodyHeight:b.height,bodyVisibleHeight:Math.max(0,Math.min(r.bottom,b.bottom,innerHeight)-Math.max(r.top,b.top,0)),viewport:innerWidth,document:document.documentElement.scrollWidth};})()`);
    assert(sheet.bodyVisibleHeight >= 120 && sheet.bodyClient >= 250, `${label}/${tab}: sheet body must remain visible and usable ${JSON.stringify(sheet)}`);
    assert(sheet.document <= sheet.viewport, `${label}/${tab}: sheet must not cause document overflow`);
    assert(sheet.scroll <= sheet.client && sheet.bodyScroll <= sheet.bodyClient, `${label}/${tab}: sheet controls must fit their containers`);
    assert(sheet.x >= 0 && sheet.x + sheet.width <= sheet.viewport + 1, `${label}/${tab}: sheet must fit viewport`);
    findings.push({ name: `${label}-sheet-${tab}`, ...sheet });
    await capture(`${label}-sheet-${tab}`);
    if (tab === 'token') {
      const configurationTabs = await evaluate("[...document.querySelectorAll('.entity-sheet [data-token-tab]')].map(node=>node.dataset.tokenTab)");
      assert.deepEqual(configurationTabs, ['basic', 'vision', 'permissions', 'advanced']);
      for (const configurationTab of configurationTabs) {
        await evaluate(`document.querySelector('.entity-sheet [data-token-tab="${configurationTab}"]').click()`);
        await until(() => evaluate(`document.querySelector('.entity-sheet [data-token-tab="${configurationTab}"]').classList.contains('active')`), `${configurationTab} token tab`);
        const configuration = await evaluate(`(()=>{const body=document.querySelector('.entity-sheet-body'),nav=document.querySelector('.token-config-tabs'),buttons=[...nav.children].map(node=>{const r=node.getBoundingClientRect();return {width:r.width,top:r.top}});return{tab:${JSON.stringify(configurationTab)},client:body.clientWidth,scroll:body.scrollWidth,navClient:nav.clientWidth,navScroll:nav.scrollWidth,buttons};})()`);
        assert(configuration.navClient >= 250 && configuration.scroll <= configuration.client && configuration.navScroll <= configuration.navClient, `${label}/${configurationTab}: four Token tabs and controls must be visible and fit without horizontal overflow`);
        assert(configuration.buttons.every(button => Math.abs(button.width - configuration.buttons[0].width) <= 1 && button.top === configuration.buttons[0].top), `${label}: four Token tabs must occupy one equal-width row`);
        findings.push({ name: `${label}-token-${configurationTab}`, ...configuration });
        await capture(`${label}-token-${configurationTab}`);
      }
    }
  }
  await evaluate("document.querySelector('.entity-sheet [data-sheet-action=close]').click()");
  await until(() => evaluate("!document.querySelector('.entity-sheet')"), 'sheet close');
  await evaluate("window.uiRefreshFixture.api.entities.openActor('ui-review-silver', 'overview')");
  await until(() => evaluate("document.querySelector('[data-sheet-mode-toggle]')"), 'template mode control');
  await evaluate("document.querySelector('[data-sheet-mode-toggle]').click()");
  await until(() => evaluate("document.querySelector('.entity-sheet').dataset.sheetInteractionMode === 'edit'"), 'template edit mode');
  assert.equal(await evaluate("document.querySelector('[data-health-field-id]').getBoundingClientRect().height > 0"), true);
  await capture(`${label}-edit-overview`);
  await evaluate("document.querySelector('[data-sheet-mode-toggle]').click()");
  await until(() => evaluate("document.querySelector('.entity-sheet').dataset.sheetInteractionMode === 'play'"), 'template play mode restored');
  await evaluate("document.querySelector('.entity-sheet [data-sheet-action=close]').click()");
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
    else if (message.method === 'Network.webSocketCreated' && new URL(message.params.url).pathname === '/ws') gameSockets.push(message.params.url);
  });
  await send('Runtime.enable'); await send('Network.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `${process.env.RPGMAP_UI_PREVIEW_ORIGIN || 'http://127.0.0.1:5174'}/scripts/ui-refresh-preview.html` });
  await until(() => evaluate("document.documentElement.dataset.fixtureReady === 'true'"), 'live runtime fixture');
  const offlinePreview = await evaluate(`(()=>{const button=document.querySelector('.multiplayer-toolbar');button.click();return{disabled:button.disabled,label:button.querySelector('[data-mp-label]').textContent,loginHidden:document.querySelector('.multiplayer-backdrop').hidden,connected:window.uiRefreshFixture.api.multiplayer.getConnectionState().connected};})()`);
  assert.deepEqual(offlinePreview, { disabled: true, label: '离线预览', loginHidden: true, connected: false });
  findings.push({ name: 'offline-preview-does-not-offer-server-login', ...offlinePreview });
  await evaluate("document.querySelector('[data-ui-panel=actors]').click()");
  await until(() => evaluate("window.uiRefreshFixture.api.tokens.list().length === 3 && document.querySelector('[data-entity-search]')"), 'runtime token and directory registration');
  await delay(500);
  await capture('desktop-map');
  await verifyMapPixels('desktop');
  await verifyChrome('desktop');
  await verifySheet('desktop');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
  await evaluate("void window.uiRefreshFixture.api.map.invalidateSize({pan:false})"); await delay(300);
  await capture('mobile-map');
  await verifyMapPixels('mobile');
  await verifyChrome('mobile');
  await verifySheet('mobile');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await evaluate("void window.uiRefreshFixture.api.map.invalidateSize({pan:false})"); await delay(300);
  assert.deepEqual(gameSockets, [], 'The offline UI fixture must never open a game WebSocket');
  assert.deepEqual(errors, []);
  await writeFile(path.join(output, 'workbench-visual-check.json'), `${JSON.stringify({ fixture: true, browser: browserPath, findings, errors, gameSockets, scope: 'Real offline Runtime UI with development fixture; no LAN or server authority acceptance', checks: ['offline preview cannot open server login', 'no game WebSocket', 'nonblank map pixels', 'tool icons', 'inspector resize', 'world menu Escape', 'token selection', 'directory search preserves input', 'all real Ruleset sheet tabs', 'four equal-width Token configuration tabs', 'desktop and 390px overflow'] }, null, 2)}\n`);
  console.log(JSON.stringify({ passed: true, checks: findings.length, errors, output }));
} catch (error) {
  let state;
  try {
    state = await evaluate("({ready:document.documentElement.dataset.fixtureReady,tokens:window.uiRefreshFixture?.api.tokens.list().length,panels:[...document.querySelectorAll('[data-ui-panel]')].map(node=>({panel:node.dataset.uiPanel,active:node.classList.contains('active')})),layout:['.app-shell','.workspace','.topbar','.tool-rail','#map','.sidebar'].map(selector=>{const node=document.querySelector(selector),r=node.getBoundingClientRect(),s=getComputedStyle(node);return{selector,x:r.x,y:r.y,width:r.width,height:r.height,display:s.display,rows:s.gridTemplateRows,columns:s.gridTemplateColumns,position:s.position}}),body:document.body.innerText.slice(-2000)})");
    await capture('failure');
  } catch { /* Preserve the first failure if the browser itself stopped. */ }
  console.error(JSON.stringify({ failure: error.message, errors, state }));
  throw error;
} finally {
  if (socket?.readyState === WebSocket.OPEN) { try { await send('Browser.close'); } catch { /* Chrome closes the socket while acknowledging. */ } socket.close(); }
  for (const entry of pending.values()) clearTimeout(entry.timer);
  if (browser.exitCode === null) { await Promise.race([new Promise(resolve => browser.once('exit', resolve)), delay(2000)]); if (browser.exitCode === null) browser.kill(); }
  await delay(300);
  const resolved = path.resolve(profile);
  assert(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('rpgmap-workbench-ui-'));
  await rm(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
}
