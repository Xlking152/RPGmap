import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { readFile, readdir, mkdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDefaultActor } from '../src/actor/model.js';
import { infiniteHorrorRuleset } from '../src/rulesets/infinite-horror/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argumentsByName = new Map(process.argv.slice(2).map(argument => {
  const at = argument.indexOf('='); return at < 0 ? [argument, true] : [argument.slice(0, at), argument.slice(at + 1)];
}));
const executable = path.resolve(argumentsByName.get('--exe') || path.join(root, 'artifact', 'desktop', 'win-unpacked', 'RPGmap.exe'));
const dataRoot = path.join(root, 'artifact', 'desktop-smoke', 'UserData');
const evidenceRoot = path.join(root, 'artifact', 'desktop-smoke', 'evidence');
const mapFile = argumentsByName.get('--map') ? path.resolve(argumentsByName.get('--map')) : null;
const reuseData = argumentsByName.has('--reuse-data');
const installer = argumentsByName.get('--installer') ? path.resolve(argumentsByName.get('--installer')) : null;
const captureScreenshots = argumentsByName.has('--screenshots');
const legacyDirectory = argumentsByName.get('--legacy-directory') ? path.resolve(argumentsByName.get('--legacy-directory')) : null;
if (installer && !reuseData && !mapFile) throw new Error('A running-application installer smoke requires --map to exercise a persisted World.');
if (!dataRoot.startsWith(`${path.join(root, 'artifact')}${path.sep}`)) throw new Error('Unsafe test data directory');
if (!reuseData) await rm(dataRoot, { recursive: true, force: true });
await mkdir(evidenceRoot, { recursive: true });
const findings = [];
const installationManifest = await readFile(path.join(path.dirname(executable), 'resources', 'INSTALL-MANIFEST.json'));
const buildSource = JSON.parse(installationManifest.toString('utf8')).source;
const manifestSha256 = createHash('sha256').update(installationManifest).digest('hex');
let child;
let debuggerClient;
let logs = '';

async function delay(ms) { await new Promise(resolve => setTimeout(resolve, ms)); }
async function eventually(work, { timeoutMs = 60000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try { const result = await work(); if (result) return result; }
    catch (error) { last = error; }
    await delay(intervalMs);
  }
  throw last || new Error('Timed out waiting for desktop state');
}

async function freePort() {
  const listener = createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  return port;
}

class DevTools {
  constructor(socket) {
    this.socket = socket; this.next = 0; this.pending = new Map();
    socket.addEventListener('message', event => {
      const packet = JSON.parse(event.data);
      const request = this.pending.get(packet.id);
      if (!request) return;
      this.pending.delete(packet.id); clearTimeout(request.timeout);
      if (packet.error) request.reject(new Error(packet.error.message)); else request.resolve(packet.result);
    });
    socket.addEventListener('close', () => { for (const request of this.pending.values()) { clearTimeout(request.timeout); request.reject(new Error('Debugger disconnected')); } this.pending.clear(); });
  }
  call(method, params = {}) {
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { this.pending.delete(id); reject(new Error(`DevTools timeout: ${method}`)); }, 70000);
      this.pending.set(id, { resolve, reject, timeout });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const result = await this.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text + ': ' + (result.exceptionDetails.exception?.description || ''));
    return result.result?.value;
  }
  close() { this.socket.close(); }
}

async function launch() {
  const port = await freePort();
  child = spawn(executable, [`--remote-debugging-port=${port}`], {
    cwd: path.dirname(executable), windowsHide: true,
    env: { ...process.env, RPGMAP_DATA_DIR: dataRoot, RPGMAP_PORT: '0', NODE_ENV: 'test', RPGMAP_TEST_HIDE_WINDOW: captureScreenshots ? '0' : '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', chunk => { logs += String(chunk).slice(-20000); });
  child.stderr.on('data', chunk => { logs += String(chunk).slice(-20000); });
  const target = await eventually(async () => {
    if (child.exitCode !== null) throw new Error(`Desktop exited: ${child.exitCode}\n${logs}`);
    const response = await fetch(`http://127.0.0.1:${port}/json/list`);
    return (await response.json()).find(item => item.type === 'page' && /^http:\/\/127\.0\.0\.1:/.test(item.url));
  });
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  debuggerClient = new DevTools(socket);
  await debuggerClient.call('Runtime.enable');
  await eventually(() => debuggerClient.evaluate(`document.querySelector('.setup-content')?.children.length > 0`));
  return target;
}

async function catalogue() {
  return debuggerClient.evaluate(`fetch('/api/manage/catalog').then(async response => { if(!response.ok) throw new Error(await response.text()); return response.json(); })`);
}

async function sourceInventory(directory, prefix = '') {
  const files = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error('Legacy smoke source contains a symlink');
    if (entry.isDirectory()) files.push(...await sourceInventory(path.join(directory, entry.name), relative));
    else if (entry.isFile()) {
      const bytes = await readFile(path.join(directory, entry.name));
      files.push({ path: relative, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    }
  }
  return files;
}

async function checkMapInput(worldId) {
  await eventually(() => debuggerClient.evaluate(`Boolean(document.querySelector('#app')?.rpgMapApp?.multiplayer?.getStatus()?.connected)`));
  const actor = createDefaultActor({ id: 'desktop-smoke-actor', name: '桌面拖动验收', ruleset: infiniteHorrorRuleset });
  const tokenId = 'desktop-smoke-token';
  const start = await debuggerClient.evaluate(`(async () => {
    const api = document.querySelector('#app').rpgMapApp;
    const actor = ${JSON.stringify(actor)};
    const point = {x:Math.floor(Math.min(700, api.mapPackage.width / 4) / 10) * 10, y:Math.floor(Math.min(450, api.mapPackage.height / 4) / 10) * 10};
    const token = {id:${JSON.stringify(tokenId)}, actorId:actor.id, actorLink:true, actorDelta:null, placement:'map', ...point,
      featureId:null, diameterMeters:1, rotation:0, elevationMeters:0, effects:[], controllerUserIds:[], visibility:{mode:'public',userIds:[]}, vision:{enabled:false}, locked:false, showName:true};
    await api.world.performOperations([{type:'actor.upsert',payload:{actor}}, {type:'token.upsert',payload:{sceneId:api.world.getActiveScene().id,token}}], {source:'desktop-smoke'});
    api.map.setView({lat:api.mapPackage.height-point.y,lng:point.x}, 1, {animate:false});
    return point;
  })()`);
  await eventually(() => debuggerClient.evaluate(`Boolean(document.querySelector('[data-token-id="${tokenId}"]'))`));
  const zoomBefore = await debuggerClient.evaluate(`document.querySelector('#app').rpgMapApp.map.getZoom()`);
  const zoomButton = await debuggerClient.evaluate(`(() => {const r=document.querySelector('.leaflet-control-zoom-in').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  await debuggerClient.call('Input.dispatchMouseEvent', { type: 'mousePressed', ...zoomButton, button: 'left', buttons: 1, clickCount: 1 });
  await debuggerClient.call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...zoomButton, button: 'left', buttons: 0, clickCount: 1 });
  await eventually(() => debuggerClient.evaluate(`document.querySelector('#app').rpgMapApp.map.getZoom() > ${zoomBefore}`));
  await eventually(() => debuggerClient.evaluate(`Boolean([...document.querySelectorAll('.token-v2-tooltip')].find(node => node.textContent.includes('桌面拖动验收') && node.getBoundingClientRect().width > 0))`));
  const destination = { x: start.x + 30, y: start.y };
  const drag = await debuggerClient.evaluate(`(() => {
    const api=document.querySelector('#app').rpgMapApp, node=document.querySelector('[data-token-id="${tokenId}"]'), r=node.getBoundingClientRect();
    const p=api.map.latLngToContainerPoint({lat:api.mapPackage.height-${destination.y},lng:${destination.x}}), box=api.map.getContainer().getBoundingClientRect();
    return {from:{x:r.x+r.width/2,y:r.y+r.height/2},to:{x:box.x+p.x,y:box.y+p.y}};
  })()`);
  await debuggerClient.call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...drag.from });
  await debuggerClient.call('Input.dispatchMouseEvent', { type: 'mousePressed', ...drag.from, button: 'left', buttons: 1, clickCount: 1 });
  for (let step = 1; step <= 8; step += 1) {
    await debuggerClient.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: drag.from.x + (drag.to.x - drag.from.x) * step / 8, y: drag.from.y + (drag.to.y - drag.from.y) * step / 8, button: 'left', buttons: 1 });
    await delay(30);
  }
  await debuggerClient.call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...drag.to, button: 'left', buttons: 0, clickCount: 1 });
  await eventually(() => debuggerClient.evaluate(`(() => {const token=document.querySelector('#app').rpgMapApp.tokens.get('${tokenId}');return token?.x===${destination.x} && token?.y===${destination.y};})()`));
  await eventually(() => debuggerClient.evaluate(`(() => {
    const api=document.querySelector('#app').rpgMapApp, r=document.querySelector('[data-token-id="${tokenId}"]').getBoundingClientRect(), box=api.map.getContainer().getBoundingClientRect();
    const p=api.map.latLngToContainerPoint({lat:api.mapPackage.height-${destination.y},lng:${destination.x}}), svg=api.map.getContainer().querySelector('svg');
    return Math.abs(r.x+r.width/2-box.x-p.x)<3 && Math.abs(r.y+r.height/2-box.y-p.y)<3 && svg?.getBoundingClientRect().width>0;
  })()`));
  const backup = await debuggerClient.evaluate(`fetch('/api/manage/worlds/backup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({worldId:${JSON.stringify(worldId)}})}).then(async response=>{if(!response.ok)throw new Error(await response.text());return response.json();})`);
  const saved = JSON.parse(await readFile(path.join(dataRoot, 'backups', `${backup.id}.json`), 'utf8')).record.snapshot.state.preferences.worldV2;
  const persisted = saved.scenes.find(scene => scene.id === saved.activeSceneId).tokens.find(token => token.id === tokenId);
  assert.equal(persisted.x, destination.x); assert.equal(persisted.y, destination.y);
  findings.push({ test: 'production Leaflet zoom, permanent Tooltip, CDP Token drag and server-persisted map position', passed: true, tokenId, from: start, to: destination });
}

async function closeDesktop(upgradeInstaller) {
  const running = child;
  const origin = await debuggerClient.evaluate('location.origin');
  const ended = new Promise(resolve => running.once('exit', resolve));
  let installerEnded;
  if (upgradeInstaller) {
    const installProcess = spawn(upgradeInstaller, ['/S', `/D=${path.dirname(executable)}`], { windowsHide: true, stdio: 'ignore' });
    installerEnded = new Promise((resolve, reject) => {
      installProcess.once('error', reject);
      installProcess.once('exit', code => code === 0 ? resolve() : reject(new Error(`Installer while running exited: ${code}`)));
    });
    installerEnded.catch(() => {});
  } else await debuggerClient.evaluate('window.rpgmapDesktop.exit()').catch(() => {});
  let timeout;
  try {
    const exitCode = await Promise.race([ended, new Promise((_resolve, reject) => { timeout = setTimeout(() => reject(new Error('Desktop did not shut down gracefully')), upgradeInstaller ? 45000 : 20000); })]);
    assert.equal(exitCode, 0, 'desktop exit must complete normally before an update can count as passed');
  }
  finally { clearTimeout(timeout); }
  debuggerClient.close(); debuggerClient = null; child = null;
  await assert.rejects(fetch(`${origin}/api/health`));
  if (installerEnded) {
    let installerTimeout;
    try { await Promise.race([installerEnded, new Promise((_resolve, reject) => { installerTimeout = setTimeout(() => reject(new Error('Running-application upgrade did not complete')), 90000); })]); }
    finally { clearTimeout(installerTimeout); }
    findings.push({ test: 'NSIS requests a graceful running-application shutdown before replacing program files', passed: true });
  }
}

try {
  await launch();
  const privileges = await debuggerClient.evaluate(`({node: typeof require, process: typeof process, cookieVisible: document.cookie.includes('rpgmap_manager'), launcher: Object.keys(window.rpgmapDesktop)})`);
  assert.equal(privileges.node, 'undefined');
  assert.equal(privileges.process, 'undefined');
  assert.equal(privileges.cookieVisible, false);
  findings.push({ test: 'renderer privilege boundary and HttpOnly manager cookie', passed: true });
  const initial = await catalogue();
  if (captureScreenshots) {
    const setupScreenshot = await debuggerClient.call('Page.captureScreenshot', { format: 'png' });
    await writeFile(path.join(evidenceRoot, reuseData ? 'desktop-setup-restored.png' : 'desktop-setup.png'), Buffer.from(setupScreenshot.data, 'base64'));
  }
  if (!reuseData) {
    assert.equal(initial.maps.length, 0);
    assert.equal(initial.worlds.length, 0);
  } else {
    assert.ok(initial.maps.length);
    assert.ok(initial.worlds.length);
  }
  findings.push({ test: reuseData ? 'desktop reads the existing package and World catalogue' : 'real desktop opens /setup without any map installed', passed: true });
  let worldId = reuseData ? initial.activeWorldId : null;
  if (mapFile && !reuseData) {
    const archive = (await readFile(mapFile)).toString('base64');
    const installed = await debuggerClient.evaluate(`fetch('/api/manage/maps', {method:'POST',headers:{'Content-Type':'application/octet-stream'},body:Uint8Array.from(atob(${JSON.stringify(archive)}), c => c.charCodeAt(0))}).then(async response => { if(!response.ok) throw new Error(await response.text()); return response.json(); })`);
    assert.ok(installed.id || installed.map?.id);
    const updated = await catalogue();
    const map = updated.maps[0]; const rule = updated.rulesets[0];
    const created = await debuggerClient.evaluate(`fetch('/api/manage/worlds', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(${JSON.stringify({ name: '桌面验收 World', ruleset: { id: rule.id, version: rule.version }, mapPackage: { id: map.id, version: map.version } })})}).then(async response => {if(!response.ok) throw new Error(await response.text()); return response.json();})`);
    worldId = created.id || created.world?.id || created.worldId;
    assert.ok(worldId);
    findings.push({ test: 'official map import and World creation', passed: true, worldId, map: `${map.id}@${map.version}` });
  }
  if (worldId) {
    await debuggerClient.evaluate(`window.rpgmapDesktop.launchWorld(${JSON.stringify(worldId)})`).catch(error => { if (!/context|disconnected|navigated|closed/i.test(error.message)) throw error; });
    await eventually(() => debuggerClient.evaluate(`location.pathname !== '/setup' && Boolean(document.querySelector('.leaflet-container'))`));
    await eventually(() => debuggerClient.evaluate(`Boolean(document.querySelector('.leaflet-pane svg'))`));
    if (captureScreenshots) {
      const gameScreenshot = await debuggerClient.call('Page.captureScreenshot', { format: 'png' });
      await writeFile(path.join(evidenceRoot, reuseData ? 'desktop-game-restored.png' : 'desktop-game.png'), Buffer.from(gameScreenshot.data, 'base64'));
    }
    findings.push({ test: 'supervised World launch into map UI', passed: true, worldId });
    if (!reuseData) {
      await checkMapInput(worldId);
      const identity = await debuggerClient.evaluate(`(async () => {
        const health = await fetch('/api/health').then(response => response.json());
        const catalog = await fetch('/api/manage/catalog').then(response => response.json());
        const gmSecret = new URL(catalog.connection.localUrl).hash.slice(1);
        const sockets = [];
        const next = (socket, type) => new Promise((resolve, reject) => {
          const timer = setTimeout(() => { socket.removeEventListener('message', listener); reject(new Error('Identity fixture timeout: ' + type)); }, 10000);
          const listener = event => {
            const message = JSON.parse(event.data);
            if (message.type !== type && message.type !== 'error') return;
            clearTimeout(timer); socket.removeEventListener('message', listener);
            if (message.type === 'error') reject(new Error(message.code)); else resolve(message);
          };
          socket.addEventListener('message', listener);
        });
        const connect = async (requestedRole, identity) => {
          const socket = new WebSocket(location.origin.replace('http:', 'ws:') + '/ws'); sockets.push(socket);
          await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, {once:true}); socket.addEventListener('error', reject, {once:true}); });
          const welcome = next(socket, 'welcome');
          socket.send(JSON.stringify({ type:'hello', requestedRole, name:'Desktop permission smoke', capabilities:{occlusion:1}, operationSchema:health.operationSchema, statusSchema:health.statusSchema, accessSchema:health.accessSchema, ...identity }));
          return {socket, welcome:await welcome};
        };
        try {
          const gm = await connect('gm', {gmSecret:new URLSearchParams(gmSecret).get('gmSecret')});
          const claim = next(gm.socket, 'access.claim');
          gm.socket.send(JSON.stringify({type:'access.user.create', name:'Desktop smoke Player'}));
          const created = await claim;
          const player = await connect('player', {claimCode:created.claimCode, joinCode:catalog.connection.joinCode});
          if (player.welcome.identity.status !== 'active') throw new Error('Player was not approved');
          return {userId:created.user.id, role:player.welcome.session.role};
        } finally { sockets.forEach(socket => socket.close()); }
      })()`);
      assert.equal(identity.role, 'player');
      findings.push({ test: 'GM creates an approved Player and persists its identity before upgrade', passed: true, userId: identity.userId });
    }
  }
  if (legacyDirectory) {
    const original = await sourceInventory(legacyDirectory);
    const imported = await debuggerClient.evaluate(`fetch('/api/manage/worlds/import-directory',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({directory:${JSON.stringify(legacyDirectory)}})}).then(async response=>{if(!response.ok)throw new Error(await response.text());return response.json();})`);
    assert.equal(imported.originalPreserved, true);
    worldId = imported.id || imported.world?.id || imported.worldId;
    assert.ok(worldId);
    await debuggerClient.evaluate(`window.rpgmapDesktop.launchWorld(${JSON.stringify(worldId)})`).catch(error => { if (!/context|disconnected|navigated|closed/i.test(error.message)) throw error; });
    await eventually(() => debuggerClient.evaluate(`location.pathname !== '/setup' && Boolean(document.querySelector('.leaflet-pane svg')) && document.querySelector('#app')?.rpgMapApp?.multiplayer?.getStatus()?.connected`));
    assert.deepEqual(await sourceInventory(legacyDirectory), original, 'the actual old data directory must remain byte-for-byte unchanged');
    findings.push({ test: 'official actual legacy-directory import and packaged map launch preserve all original bytes', passed: true, worldId, sourceFiles: original.length, sourceInventorySha256: createHash('sha256').update(JSON.stringify(original)).digest('hex') });
  }
  await closeDesktop(installer);
  findings.push({ test: 'normal exit closes main process and server HTTP listener', passed: true });
  await launch();
  const recovered = await catalogue();
  assert.equal(recovered.maps.length, reuseData ? initial.maps.length : mapFile ? 1 : 0);
  if (worldId) assert.equal(recovered.activeWorldId, worldId);
  findings.push({ test: 'process restart preserves imported package and active World', passed: true });
  await closeDesktop();
  await writeFile(path.join(evidenceRoot, reuseData ? 'desktop-reuse-smoke.json' : 'desktop-smoke.json'), `${JSON.stringify({ executable, mapFile, reuseData, installer, buildSource, manifestSha256, at: new Date().toISOString(), findings, limitations: ['This tests the packaged executable on the development Windows host, not a clean Windows VM.', 'Map import uses the official management API; native file chooser selection is not automated.'] }, null, 2)}\n`);
  console.log(JSON.stringify(findings, null, 2));
} finally {
  debuggerClient?.close();
  child?.kill();
  await writeFile(path.join(evidenceRoot, 'desktop-process.log'), logs);
}
