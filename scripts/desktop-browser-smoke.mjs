import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { createServer } from 'node:net';
import { readFile, readdir, mkdir, rm, writeFile, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDefaultActor } from '../src/actor/model.js';
import { infiniteHorrorRuleset } from '../src/rulesets/infinite-horror/index.js';
import { movementMetersPerPixel, recommendedMovementStep, snapMovementPoint } from '../src/movement/snap.js';
import { applyDocumentChanges } from '../src/documents/changes.js';
import { OriginWebSocket } from './desktop-origin-websocket.mjs';
import { createWorldWal, worldWalChecksum } from '../deployment/local-server/world-wal.mjs';
import { applyWorldOperationPatch } from '../src/world/operations.js';
import { runDesktopSceneLifecycleAudit, validateSceneLifecycleOptions } from './desktop-scene-lifecycle-audit.mjs';

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
const prepareUpgradeFixture = argumentsByName.has('--prepare-upgrade-fixture');
const exerciseExistingInput = argumentsByName.has('--exercise-input');
const sceneAudit = argumentsByName.has('--scene-audit');
const sceneLifecycleAudit = argumentsByName.has('--scene-lifecycle-audit');
const minimalMapFile = argumentsByName.get('--minimal-map') ? path.resolve(argumentsByName.get('--minimal-map')) : null;
const expectedSource = argumentsByName.get('--expected-source') || process.env.RPGMAP_SMOKE_EXPECTED_SOURCE_COMMIT;
if (installer && !reuseData && !mapFile) throw new Error('A running-application installer smoke requires --map to exercise a persisted World.');
if (prepareUpgradeFixture && (reuseData || installer || legacyDirectory)) throw new Error('Upgrade preparation is a separate, normally closed fixture run.');
if (sceneAudit && (!mapFile || !minimalMapFile || reuseData || prepareUpgradeFixture)) throw new Error('--scene-audit requires --map and --minimal-map in a new disposable World.');
if (minimalMapFile && !sceneAudit) throw new Error('--minimal-map requires --scene-audit; it cannot be silently ignored.');
validateSceneLifecycleOptions({ enabled: sceneLifecycleAudit, sceneAudit, reuseData, installer, legacyDirectory, prepareUpgradeFixture });
if (!dataRoot.startsWith(`${path.join(root, 'artifact')}${path.sep}`)) throw new Error('Unsafe test data directory');
async function resolvedDestination(file) {
  try { return await realpath(file); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return path.join(await resolvedDestination(path.dirname(file)), path.basename(file)); }
}
const realArtifactRoot = await realpath(path.join(root, 'artifact'));
const realWorkspaceRoot = await realpath(root);
assert(realArtifactRoot.toLowerCase().startsWith(`${realWorkspaceRoot}${path.sep}`.toLowerCase()), 'Artifact directory cannot resolve outside this workspace');
const resolvedDataRoot = await resolvedDestination(dataRoot);
assert.equal(resolvedDataRoot.toLowerCase(), path.join(realArtifactRoot, 'desktop-smoke', 'UserData').toLowerCase(), 'Test data cannot follow a junction into another directory');
if (legacyDirectory) {
  const legacyRoot = await realpath(legacyDirectory);
  assert(!legacyRoot.toLowerCase().startsWith(`${resolvedDataRoot}${path.sep}`.toLowerCase())
    && !resolvedDataRoot.toLowerCase().startsWith(`${legacyRoot}${path.sep}`.toLowerCase())
    && legacyRoot.toLowerCase() !== resolvedDataRoot.toLowerCase(), 'Legacy source and disposable test data cannot overlap');
}
async function ensureNoExistingDesktop() {
  if (process.platform !== 'win32') return;
  const output = await new Promise((resolve, reject) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '@(Get-Process -Name RPGmap -ErrorAction SilentlyContinue).Count'],
    { windowsHide: true }, (error, stdout) => error ? reject(error) : resolve(stdout)));
  assert.equal(Number(String(output).trim()), 0, 'An existing RPGmap process must remain untouched; close it before this isolated test');
}
await ensureNoExistingDesktop();
async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
const installationManifest = await readFile(path.join(path.dirname(executable), 'resources', 'INSTALL-MANIFEST.json'));
const buildSource = JSON.parse(installationManifest.toString('utf8')).source;
if (expectedSource) assert.equal(buildSource.commit, expectedSource, 'The installed executable must come from the frozen source commit');
assert.equal(buildSource.sourceDirty, false, 'Desktop acceptance requires a clean frozen application build');
const manifestSha256 = createHash('sha256').update(installationManifest).digest('hex');
const executableSha256 = await sha256(executable);
const mapSha256 = mapFile ? await sha256(mapFile) : null;
const minimalMapSha256 = minimalMapFile ? await sha256(minimalMapFile) : null;
const installerSha256 = installer ? await sha256(installer) : null;
const driverSha256 = await sha256(fileURLToPath(import.meta.url));
const observerTransportSha256 = sceneAudit ? await sha256(fileURLToPath(new URL('./desktop-origin-websocket.mjs', import.meta.url))) : null;
const lifecycleDriverSha256 = sceneLifecycleAudit ? await sha256(fileURLToPath(new URL('./desktop-scene-lifecycle-audit.mjs', import.meta.url))) : null;
if (!reuseData) await rm(dataRoot, { recursive: true, force: true });
await mkdir(evidenceRoot, { recursive: true });
const mode = sceneLifecycleAudit ? 'desktop-scene-lifecycle-audit' : sceneAudit ? 'desktop-scene-audit' : prepareUpgradeFixture ? 'desktop-upgrade-fixture' : exerciseExistingInput ? 'desktop-upgraded-smoke' : legacyDirectory ? 'desktop-legacy-smoke' : reuseData ? 'desktop-reuse-smoke' : 'desktop-smoke';
const recordFile = path.join(evidenceRoot, `${mode}.json`);
await rm(recordFile, { force: true });
const findings = [];
let child;
let debuggerClient;
let logs = '';
let runFailure = null;
const browserExceptions = [];
let lifecycleResult = null;

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
      if (packet.method === 'Runtime.exceptionThrown') {
        const exception = packet.params.exceptionDetails;
        browserExceptions.push({ text: exception.text, description: exception.exception?.description, url: exception.url, lineNumber: exception.lineNumber });
      }
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
  await ensureNoExistingDesktop();
  assert.equal(await sha256(path.join(path.dirname(executable), 'resources', 'INSTALL-MANIFEST.json')), manifestSha256, 'Restart must use the same frozen manifest');
  assert.equal(await sha256(executable), executableSha256, 'Restart must use the same frozen executable');
  const startedAt = performance.now();
  const port = await freePort();
  child = spawn(executable, [`--remote-debugging-port=${port}`], {
    cwd: path.dirname(executable), windowsHide: true,
    // Real pointer acceptance uses a visible window and active animation frames.
    env: { ...process.env, RPGMAP_DATA_DIR: dataRoot, RPGMAP_PORT: '0', NODE_ENV: 'test', RPGMAP_TEST_HIDE_WINDOW: '0' },
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
  await debuggerClient.call('Page.bringToFront');
  await eventually(() => debuggerClient.evaluate(`document.querySelector('.setup-content')?.children.length > 0`));
  findings.push({ test: 'measured packaged process spawn to populated management page', passed: true, milliseconds: Math.round(performance.now() - startedAt) });
  return target;
}

async function catalogue() {
  return debuggerClient.evaluate(`fetch('/api/manage/catalog').then(async response => { if(!response.ok) throw new Error(await response.text()); return response.json(); })`);
}

async function importAuditMap(file, expectedHash) {
  const transport = path.join(dataRoot, `transport-${path.basename(file)}`);
  assert.notEqual(path.resolve(file).toLowerCase(), transport.toLowerCase(), 'The removable transport copy cannot be the delivered archive');
  await writeFile(transport, await readFile(file));
  assert.equal(await sha256(transport), expectedHash);
  try {
    const archive = (await readFile(transport)).toString('base64');
    const installed = await debuggerClient.evaluate(`fetch('/api/manage/maps',{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:Uint8Array.from(atob(${JSON.stringify(archive)}),c=>c.charCodeAt(0))}).then(async response=>{if(!response.ok)throw new Error(await response.text());return response.json();})`);
    assert.ok(installed.id || installed.map?.id);
    return installed;
  } finally {
    await rm(transport, { force: true });
    await assert.rejects(readFile(transport), { code: 'ENOENT' });
    assert.equal(await sha256(file), expectedHash, 'The delivered map bytes must remain untouched');
  }
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

async function establishMapToken(actorId, tokenId, name) {
  await eventually(() => debuggerClient.evaluate(`Boolean(document.querySelector('#app')?.rpgMapApp?.multiplayer?.getStatus()?.connected)`));
  const actor = createDefaultActor({ id: actorId, name, ruleset: infiniteHorrorRuleset });
  return debuggerClient.evaluate(`(async () => {
    const api = document.querySelector('#app').rpgMapApp;
    const actor = ${JSON.stringify(actor)};
    const preferred = {x:Math.floor(Math.min(700, api.mapPackage.width / 4) / 10) * 10 + .5, y:Math.floor(Math.min(450, api.mapPackage.height / 4) / 10) * 10 + .5};
    const candidates = [preferred];
    for(let ring=1;ring<=12;ring++) for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,1],[1,-1],[-1,-1]]) {
      candidates.push({x:preferred.x+dx*ring*25,y:preferred.y+dy*ring*25});
    }
    const point=candidates.find(candidate=>candidate.x>=.5&&candidate.y>=.5&&candidate.x<=api.mapPackage.width-.5&&candidate.y<=api.mapPackage.height-.5
      && api.inspectTokenPlacement(null,candidate,{diameterMeters:1,elevationMeters:0}).valid);
    if(!point)throw new Error('No physically valid desktop Token fixture position was found');
    const token = {id:${JSON.stringify(tokenId)}, actorId:actor.id, actorLink:true, actorDelta:null, placement:'map', ...point,
      featureId:null, diameterMeters:1, rotation:0, elevationMeters:0, effects:[], controllerUserIds:[], visibility:{mode:'public',userIds:[]}, vision:{enabled:false}, locked:false, showName:true};
    await api.world.performOperations([{type:'actor.upsert',payload:{actor}}, {type:'token.upsert',payload:{sceneId:api.world.getActiveScene().id,token}}], {source:'desktop-smoke'});
    api.map.setView({lat:api.mapPackage.height-point.y,lng:point.x}, 1, {animate:false});
    return point;
  })()`);
}

function desktopKeyboardDiagnostic(event, token) {
  const key = String(event.key || '').toLowerCase(), code = String(event.code || '');
  if (!['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'shift', 'control', 'alt', 'meta'].includes(key)
    && !['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(code)) return null;
  return { type: event.type, key: event.key, code: event.code, repeat: event.repeat === true, isTrusted: event.isTrusted === true,
    targetTag: event.target?.tagName || null, at: Date.now(), tokenPosition: token ? { x: token.x, y: token.y } : null };
}

function desktopMovementWalResults(records, tokenId, afterRevision) {
  const movements = [];
  for (const record of records) {
    if (record.revision <= afterRevision) continue;
    const current = record.results?.find(result => result.operationId === record.operationId && result.revision === record.revision);
    const results = current?.results || record.results || [];
    for (const result of results) for (const motion of result.motion || []) {
      if (motion.tokenId === tokenId) movements.push({ revision: record.revision, operationId: record.operationId,
        tokenId, method: motion.method, from: motion.from, to: motion.to });
    }
  }
  return movements;
}

async function desktopMovementWalDiagnostics(worldId, tokenId, afterRevision) {
  const text = await readFile(path.join(dataRoot, 'worlds', worldId, 'world.operations.ndjson'), 'utf8');
  const complete = text.endsWith('\n') ? text : text.slice(0, text.lastIndexOf('\n') + 1);
  const records = complete.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  for (const record of records) assert.equal(record.checksum, worldWalChecksum(record), 'Movement diagnostic WAL records must retain valid checksums');
  return { afterRevision, records: desktopMovementWalResults(records, tokenId, afterRevision) };
}

async function checkMapInput(worldId) {
  const tokenId = 'desktop-smoke-token';
  const start = await establishMapToken('desktop-smoke-actor', tokenId, '桌面拖动验收');
  await eventually(() => debuggerClient.evaluate(`Boolean(document.querySelector('[data-token-id="${tokenId}"]'))`));
  const zoomBefore = await debuggerClient.evaluate(`document.querySelector('#app').rpgMapApp.map.getZoom()`);
  const zoomButton = await debuggerClient.evaluate(`(() => {const r=document.querySelector('.leaflet-control-zoom-in').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  await debuggerClient.call('Input.dispatchMouseEvent', { type: 'mousePressed', ...zoomButton, button: 'left', buttons: 1, clickCount: 1 });
  await debuggerClient.call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...zoomButton, button: 'left', buttons: 0, clickCount: 1 });
  await eventually(() => debuggerClient.evaluate(`document.querySelector('#app').rpgMapApp.map.getZoom() > ${zoomBefore}`));
  await eventually(() => debuggerClient.evaluate(`!document.querySelector('#app').rpgMapApp.map._animatingZoom`));
  await eventually(() => debuggerClient.evaluate(`Boolean([...document.querySelectorAll('.token-v2-tooltip')].find(node => node.textContent.includes('桌面拖动验收') && node.getBoundingClientRect().width > 0))`));
  const metersPerPixel = await debuggerClient.evaluate(`(${movementMetersPerPixel.toString()})(document.querySelector('#app').rpgMapApp.map, document.querySelector('#app').rpgMapApp.mapPackage)`);
  const movementStep = recommendedMovementStep({ metersPerPixel });
  const routeCandidates = [30, 15, 10, 5].flatMap(distance => [[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,1],[1,-1],[-1,-1]].map(([dx,dy]) => {
    const destination = { x: start.x + dx * distance, y: start.y + dy * distance };
    return { destination, expectedDestination: snapMovementPoint(destination, movementStep) };
  })).filter(route => route.expectedDestination.x !== start.x || route.expectedDestination.y !== start.y);
  const fixture = await debuggerClient.evaluate(`(() => {
    const api=document.querySelector('#app').rpgMapApp, routes=${JSON.stringify(routeCandidates)};
    const placement=api.inspectTokenPlacement('${tokenId}',${JSON.stringify(start)});
    if(!placement.valid)return {placement};
    for(const route of routes){
      const destinationPlacement=api.inspectTokenPlacement('${tokenId}',route.expectedDestination);
      if(!destinationPlacement.valid)continue;
      const move=api.movementFast.inspectTokenMove('${tokenId}',route.expectedDestination);
      if(move.valid)return {placement,destinationPlacement,move,...route};
    }
    return {placement,move:{valid:false,code:'fixture_route_not_found',reason:'No physically valid direct test route was found'}};
  })()`);
  findings.push({ test: 'Token fixture placement and direct route obey actual map physics', passed: fixture.placement?.valid === true && fixture.move?.valid === true, fixture });
  assert.equal(fixture.placement?.valid, true, 'the fixture start must pass physical placement checks');
  assert.equal(fixture.move?.valid, true, 'the fixture route must pass real movement and collision checks');
  const { destination, expectedDestination } = fixture;
  await eventually(() => debuggerClient.evaluate(`(() => {
    const api=document.querySelector('#app').rpgMapApp, r=document.querySelector('[data-token-id="${tokenId}"]').getBoundingClientRect(), box=api.map.getContainer().getBoundingClientRect();
    const p=api.map.latLngToContainerPoint({lat:api.mapPackage.height-${start.y},lng:${start.x}});
    return Math.abs(r.x+r.width/2-box.x-p.x)<3 && Math.abs(r.y+r.height/2-box.y-p.y)<3;
  })()`));
  const drag = await debuggerClient.evaluate(`(() => {
    const api=document.querySelector('#app').rpgMapApp, node=document.querySelector('[data-token-id="${tokenId}"]'), r=node.getBoundingClientRect();
    const p=api.map.latLngToContainerPoint({lat:api.mapPackage.height-${destination.y},lng:${destination.x}}), box=api.map.getContainer().getBoundingClientRect();
    return {from:{x:r.x+r.width/2,y:r.y+r.height/2},to:{x:box.x+p.x,y:box.y+p.y}};
  })()`);
  const hit = await debuggerClient.evaluate(`(() => {
    const api=document.querySelector('#app').rpgMapApp, node=document.elementFromPoint(${drag.from.x},${drag.from.y});
    return {tokenId:node?.closest('[data-token-id]')?.dataset.tokenId, access:api.movement.inspectMovementAccess('${tokenId}',${JSON.stringify(start)})};
  })()`);
  assert.equal(hit.tokenId, tokenId, 'CDP drag must start on the actual Token hit target');
  assert.notEqual(hit.access?.valid, false, 'the standard fixture must be movable through the regular permission and rule checks');
  const dragBaseRevision = (await sceneAuditDurableWorld(worldId)).revision;
  await debuggerClient.evaluate(`(() => {
    const api=document.querySelector('#app').rpgMapApp;
    window.__desktopSmokePointerTrace=[];
    window.__desktopSmokeKeyboardTrace=[];
    const keyboardDiagnostic=(${desktopKeyboardDiagnostic.toString()});
    for(const type of ['keydown','keyup']) window.addEventListener(type,event=>{
      const item=keyboardDiagnostic(event,api.tokens.get('${tokenId}'));
      if(item)window.__desktopSmokeKeyboardTrace.push(item);
    },{capture:true,passive:true});
    window.__desktopSmokeGeometry=()=>{
      const box=api.map.getContainer().getBoundingClientRect(),size=api.map.getSize(),origin=api.map.getPixelOrigin();
      return {box:{x:box.x,y:box.y,width:box.width,height:box.height},size:{x:size.x,y:size.y},origin:{x:origin.x,y:origin.y},center:api.map.getCenter()};
    };
    window.__desktopSmokeDragBefore={zoom:api.map.getZoom(),animatingZoom:Boolean(api.map._animatingZoom),hasFocus:document.hasFocus(),visibility:document.visibilityState,tool:api.getTool?.(),movement:api.movementUi?.getState?.(),selection:api.selection?.getSelectedTokenIds?.()};
    for(const type of ['pointerdown','pointermove','pointerup','pointercancel','blur']) window.addEventListener(type,event=>{
      const item={type,x:event.clientX,y:event.clientY,button:event.button,buttons:event.buttons,pointerId:event.pointerId,targetTokenId:event.target?.closest?.('[data-token-id]')?.dataset.tokenId};
      item.geometry=window.__desktopSmokeGeometry();
      if(Number.isFinite(event.clientX)&&Number.isFinite(event.clientY)){
        const point=api.map.containerPointToLatLng([event.clientX-item.geometry.box.x,event.clientY-item.geometry.box.y]);
        item.pointerWorld={x:point.lng,y:api.mapPackage.height-point.lat};
      }
      queueMicrotask(()=>{item.defaultPrevented=event.defaultPrevented;item.movement=api.movementUi?.getState?.();item.status=document.querySelector('[data-role="map-status"]')?.textContent;item.dragging=api.map.getContainer().classList.contains('fvtt-token-dragging');});
      if(window.__desktopSmokePointerTrace.length<60)window.__desktopSmokePointerTrace.push(item);
    },true);
  })()`);
  await debuggerClient.call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...drag.from });
  await debuggerClient.call('Input.dispatchMouseEvent', { type: 'mousePressed', ...drag.from, button: 'left', buttons: 1, clickCount: 1 });
  for (let step = 1; step <= 8; step += 1) {
    await debuggerClient.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: drag.from.x + (drag.to.x - drag.from.x) * step / 8, y: drag.from.y + (drag.to.y - drag.from.y) * step / 8, button: 'left', buttons: 1 });
    await delay(30);
  }
  // First selection updates the HUD/header and can move the map container.
  // Target the same prevalidated World position through the current transform,
  // retaining a real pointer drag and the original strict coordinate assertion.
  const finalPointer = await debuggerClient.evaluate(`(() => {
    const api=document.querySelector('#app').rpgMapApp,box=api.map.getContainer().getBoundingClientRect();
    const point=api.map.latLngToContainerPoint({lat:api.mapPackage.height-${expectedDestination.y},lng:${expectedDestination.x}});
    const world=api.map.containerPointToLatLng([point.x,point.y]);
    return {x:box.x+point.x,y:box.y+point.y,world:{x:world.lng,y:api.mapPackage.height-world.lat},geometry:window.__desktopSmokeGeometry()};
  })()`);
  assert.deepEqual(snapMovementPoint(finalPointer.world, movementStep), expectedDestination, 'the final pointer must map to the independently prevalidated World target');
  await debuggerClient.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: finalPointer.x, y: finalPointer.y, button: 'left', buttons: 1 });
  await delay(80);
  await debuggerClient.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: finalPointer.x, y: finalPointer.y, button: 'left', buttons: 0, clickCount: 1 });
  try {
    await eventually(() => debuggerClient.evaluate(`(() => {const token=document.querySelector('#app').rpgMapApp.tokens.get('${tokenId}');return token?.x===${expectedDestination.x} && token?.y===${expectedDestination.y};})()`));
  } catch (error) {
    const diagnostic = await debuggerClient.evaluate(`(() => {const api=document.querySelector('#app').rpgMapApp,token=api.tokens.get('${tokenId}'),node=document.querySelector('[data-token-id="${tokenId}"]');return {before:window.__desktopSmokeDragBefore,events:window.__desktopSmokePointerTrace,movementKeyEvents:window.__desktopSmokeKeyboardTrace,movementKeyEventCount:window.__desktopSmokeKeyboardTrace.length,token:{x:token?.x,y:token?.y,movement:token?.movement},movement:api.movementUi?.getState?.(),selection:api.selection?.getSelectedTokenIds?.(),status:document.querySelector('[data-role="map-status"]')?.textContent,zoom:api.map.getZoom(),animatingZoom:Boolean(api.map._animatingZoom),hasFocus:document.hasFocus(),marker:node?{x:node.getBoundingClientRect().x,y:node.getBoundingClientRect().y,width:node.getBoundingClientRect().width,height:node.getBoundingClientRect().height}:null};})()`);
    diagnostic.movementWal = await desktopMovementWalDiagnostics(worldId, tokenId, dragBaseRevision).catch(failure => ({ error: failure.message }));
    findings.push({ test: 'strict CDP Token drag diagnostics', passed: false, drag, finalPointer, destination, expectedDestination, movementStep, fixture, diagnostic, browserExceptions });
    throw error;
  }
  await eventually(() => debuggerClient.evaluate(`(() => {
    const api=document.querySelector('#app').rpgMapApp, r=document.querySelector('[data-token-id="${tokenId}"]').getBoundingClientRect(), box=api.map.getContainer().getBoundingClientRect();
    const p=api.map.latLngToContainerPoint({lat:api.mapPackage.height-${expectedDestination.y},lng:${expectedDestination.x}}), svg=api.map.getContainer().querySelector('svg');
    return Math.abs(r.x+r.width/2-box.x-p.x)<3 && Math.abs(r.y+r.height/2-box.y-p.y)<3 && svg?.getBoundingClientRect().width>0;
  })()`));
  const backup = await debuggerClient.evaluate(`fetch('/api/manage/worlds/backup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({worldId:${JSON.stringify(worldId)}})}).then(async response=>{if(!response.ok)throw new Error(await response.text());return response.json();})`);
  const saved = JSON.parse(await readFile(path.join(dataRoot, 'backups', `${backup.id}.json`), 'utf8')).record.snapshot.state.preferences.worldV2;
  const persisted = saved.scenes.find(scene => scene.id === saved.activeSceneId).tokens.find(token => token.id === tokenId);
  assert.equal(persisted.x, expectedDestination.x); assert.equal(persisted.y, expectedDestination.y);
  const keyboardDiagnostic = await debuggerClient.evaluate(`({movementKeyEvents:window.__desktopSmokeKeyboardTrace,movementKeyEventCount:window.__desktopSmokeKeyboardTrace.length})`);
  const movementWal = await desktopMovementWalDiagnostics(worldId, tokenId, dragBaseRevision);
  findings.push({ test: 'production Leaflet zoom, permanent Tooltip, CDP Token drag and server-persisted map position', passed: true, tokenId, from: start, pointerDestination: destination, to: expectedDestination, finalPointer, movementStep,
    ...keyboardDiagnostic, movementWal });
}

// Compare all persisted Scene content, excluding World timestamps and unrelated
// projection metadata. Matching only a Scene ID would miss state leaking across maps.
function sceneAuditContent(scene) {
  return structuredClone({
    id: scene.id, name: scene.name, mapPackage: scene.mapPackage,
    tokens: scene.tokens, markers: scene.markers, attackAreas: scene.attackAreas,
    sceneEvents: scene.sceneEvents, featureStates: scene.featureStates,
    occlusionShapes: scene.occlusionShapes, fog: scene.fog, settings: scene.settings,
  });
}

function sceneAuditExplorationSettled(snapshot, sceneId, partyId) {
  const scene = snapshot?.state?.preferences?.worldV2?.scenes?.find(item => item.id === sceneId);
  return Boolean(partyId && snapshot?.exploration?.jobs
    && !Object.keys(snapshot.exploration.jobs).length
    && Object.keys(scene?.fog?.exploredByParty?.[partyId]?.rows || {}).length);
}

async function sceneAuditDurableWorld(worldId) {
  const directory = path.join(dataRoot, 'worlds', worldId);
  const snapshot = JSON.parse(await readFile(path.join(directory, 'world.json'), 'utf8'));
  const wal = createWorldWal({ filePath: path.join(directory, 'world.operations.ndjson'),
    applyPatch: (state, patch) => applyWorldOperationPatch(state, patch, { project: false }) });
  return wal.replay(snapshot, { repairTail: false });
}

function socketMessage(socket, type) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { cleanup(); reject(new Error(`Scene observer timeout: ${type}`)); }, 10000);
    const listener = event => {
      const message = JSON.parse(String(event.data));
      if (message.type !== type && message.type !== 'error') return;
      cleanup();
      if (message.type === 'error') reject(new Error(message.code || 'scene_observer_error'));
      else resolve(message);
    };
    const failed = event => { cleanup(); reject(event.error || new Error('Scene observer transport failed')); };
    const closed = () => { cleanup(); reject(new Error(`Scene observer closed while waiting for ${type}`)); };
    const cleanup = () => {
      clearTimeout(timeout); socket.removeEventListener('message', listener);
      socket.removeEventListener('error', failed); socket.removeEventListener('close', closed);
    };
    socket.addEventListener('message', listener);
    socket.addEventListener('error', failed); socket.addEventListener('close', closed);
  });
}

async function createSceneObserver() {
  const origin = await debuggerClient.evaluate('location.origin');
  const { health, catalog } = await debuggerClient.evaluate(`Promise.all([fetch('/api/health').then(r=>r.json()),fetch('/api/manage/catalog').then(r=>r.json())]).then(([health,catalog])=>({health,catalog}))`);
  const sockets = [], events = [];
  let latest = null, failure = null;
  async function connect(requestedRole, identity, observe = false) {
    const socket = new OriginWebSocket(`${origin.replace('http:', 'ws:')}/ws`, origin);
    sockets.push(socket);
    socket.addEventListener('error', event => { failure = event.error || new Error('Scene observer transport failed'); });
    await socket.open();
    if (observe) socket.addEventListener('message', event => {
      try {
        const message = JSON.parse(String(event.data));
        if (message.type === 'welcome') latest = message.world?.state || null;
        else if (['world.snapshot', 'audience.snapshot'].includes(message.type)) latest = message.state;
        else if (['world.operation.committed', 'document.batch.committed'].includes(message.type)) {
          if (!latest) throw new Error('Player received a patch without its initial snapshot');
          latest = applyDocumentChanges(latest, message.changes, { updatedAt: message.updatedAt });
        }
        if (latest && ['welcome', 'world.snapshot', 'audience.snapshot', 'world.operation.committed', 'document.batch.committed'].includes(message.type)) {
          const world = latest.preferences?.worldV2;
          const scene = world?.scenes?.find(item => item.id === world.activeSceneId);
          events.push({ type: message.type, revision: message.revision ?? message.world?.revision,
            activeSceneId: world?.activeSceneId, mapPackage: scene?.mapPackage });
        }
      } catch (error) { failure = error; }
    });
    const welcome = socketMessage(socket, 'welcome');
    socket.send(JSON.stringify({ type: 'hello', requestedRole, name: 'Desktop Scene audit', capabilities: { occlusion: 1 },
      operationSchema: health.operationSchema, statusSchema: health.statusSchema, accessSchema: health.accessSchema, ...identity }));
    return { socket, welcome: await welcome };
  }
  try {
    const gmSecret = new URL(catalog.connection.localUrl).hash.slice(1);
    const gm = await connect('gm', { gmSecret: new URLSearchParams(gmSecret).get('gmSecret') });
    const claim = socketMessage(gm.socket, 'access.claim');
    gm.socket.send(JSON.stringify({ type: 'access.user.create', name: 'Desktop Scene audit Player' }));
    const created = await claim;
    const player = await connect('player', { claimCode: created.claimCode, joinCode: catalog.connection.joinCode }, true);
    assert.equal(player.welcome.identity?.status, 'active');
    assert.equal(player.welcome.session?.role, 'player');
    return { userId: created.user.id, events,
      async expectScene(sceneId, mapPackage) {
        await eventually(() => {
          if (failure) throw failure;
          const world = latest?.preferences?.worldV2;
          const active = world?.scenes?.find(scene => scene.id === world.activeSceneId);
          return world?.activeSceneId === sceneId && active?.mapPackage?.id === mapPackage.id
            && active.mapPackage.version === mapPackage.version;
        }, { timeoutMs: 15000, intervalMs: 100 });
      }, close() { sockets.forEach(socket => socket.close()); } };
  } catch (error) { sockets.forEach(socket => socket.close()); throw error; }
}

async function checkScenes(worldId, minimalMap) {
  const observer = await createSceneObserver();
  const readWorld = () => debuggerClient.evaluate(`document.querySelector('#app').rpgMapApp.world.get()`);
  const waitActive = (sceneId, mapPackage) => eventually(() => debuggerClient.evaluate(`(() => {
    const api=document.querySelector('#app')?.rpgMapApp;
    return api?.multiplayer?.getStatus()?.connected && api.world.getActiveScene()?.id===${JSON.stringify(sceneId)}
      && api.mapPackage.id===${JSON.stringify(mapPackage.id)} && api.mapPackage.version===${JSON.stringify(mapPackage.version)}
      && Boolean(document.querySelector('.leaflet-pane svg'));
  })()`));
  const activate = async (sceneId, mapPackage) => {
    await debuggerClient.evaluate(`document.querySelector('#app').rpgMapApp.scenes.activate(${JSON.stringify(sceneId)})`)
      .catch(error => { if (!/context|disconnected|navigated|closed/i.test(error.message)) throw error; });
    await waitActive(sceneId, mapPackage);
    await observer.expectScene(sceneId, mapPackage);
  };
  try {
    const before = await readWorld(), sceneA = before.scenes.find(scene => scene.id === before.activeSceneId);
    assert.equal(before.id, worldId);
    const created = await debuggerClient.evaluate(`(async () => {
      const api=document.querySelector('#app').rpgMapApp;
      const b=await api.scenes.create({name:'兰州独立场景 B',mapPackage:${JSON.stringify(sceneA.mapPackage)}});
      const c=await api.scenes.create({name:'最小地图场景 C',mapPackage:${JSON.stringify(minimalMap)}});
      return {b,c,activeSceneId:api.world.getActiveScene().id};
    })()`);
    assert.equal(created.activeSceneId, sceneA.id);
    const bInitial = sceneAuditContent(created.b), cInitial = sceneAuditContent(created.c);
    assert.equal(bInitial.tokens.length, 0); assert.equal(cInitial.tokens.length, 0);
    const mutation = await debuggerClient.evaluate(`(async () => {
      const api=document.querySelector('#app').rpgMapApp;
      const door=api.mapPackage.features.find(feature=>api.interaction.actionsForFeature(feature.id).some(action=>action.id==='open'&&action.enabled));
      const building=api.mapPackage.features.find(feature=>feature.id!==door?.id&&api.interaction.actionsForFeature(feature.id).some(action=>action.id==='damage'&&action.enabled));
      if(!door||!building)throw new Error('Lanzhou Scene audit needs a real openable door and destructible feature');
      const opened=await api.interaction.open(door.id);
      if(!opened.ok)throw new Error(opened.reason||'Door did not open');
      const damaged=await api.interaction.damage(building.id);
      if(!damaged.ok)throw new Error(damaged.reason||'Feature was not damaged');
      const token=api.tokens.get('desktop-smoke-token');
      const sceneId=api.world.getActiveScene().id;
      const actor=api.world.get().actors.find(item=>item.id===token.actorId);
      if(!actor?.partyId)throw new Error('Scene audit vision Token requires its real Actor party');
      await api.world.performOperations([
        {type:'token.upsert',payload:{sceneId,token:{...token,vision:{...token.vision,enabled:true,preciseRangeOverrideMeters:15,vagueRangeOverrideMeters:15}}}},
        {type:'scene.settings.patch',payload:{sceneId,patch:{lineOfSightEnabled:true}}},
      ],{source:'desktop-scene-audit-vision'});
      await api.multiplayer.setVisionSource(token.id);
      return {doorId:door.id,buildingId:building.id,tokenId:token.id,partyId:actor.partyId,
        doorState:api.interaction.stateForFeature(door.id),buildingState:api.interaction.stateForFeature(building.id)};
    })()`);
    await eventually(async () => sceneAuditExplorationSettled(await sceneAuditDurableWorld(worldId), sceneA.id, mutation.partyId),
      { timeoutMs: 20000, intervalMs: 100 });
    await debuggerClient.evaluate(`(async () => {
      const api=document.querySelector('#app').rpgMapApp;
      await api.multiplayer.setVisionSource(null);
      const token=api.tokens.get(${JSON.stringify(mutation.tokenId)});
      await api.world.performOperations([{type:'token.upsert',payload:{sceneId:api.world.getActiveScene().id,
        token:{...token,vision:{...token.vision,enabled:false}}}}],{source:'desktop-scene-audit-vision-stop'});
      await api.multiplayer.setVisionSource(null);
    })()`);
    const settled = await eventually(async () => {
      const durable = await sceneAuditDurableWorld(worldId);
      if (!sceneAuditExplorationSettled(durable, sceneA.id, mutation.partyId)) return false;
      const current = await readWorld();
      assert.deepEqual(sceneAuditContent(current.scenes.find(scene => scene.id === sceneA.id)),
        sceneAuditContent(durable.state.preferences.worldV2.scenes.find(scene => scene.id === sceneA.id)),
        'Scene A must display the same completed exploration as its read-only durable WAL prefix');
      return { world: current, durableRevision: durable.revision };
    }, { timeoutMs: 20000, intervalMs: 100 });
    const changed = settled.world, aChanged = sceneAuditContent(changed.scenes.find(scene => scene.id === sceneA.id));
    assert.equal(mutation.doorState.open, true);
    assert.notEqual(aChanged.sceneEvents.length, sceneA.sceneEvents.length);
    assert.ok(Object.keys(aChanged.fog?.exploredByParty?.[mutation.partyId]?.rows || {}).length, 'Scene A must contain genuine server-computed exploration for its Actor party');
    assert.notDeepEqual(aChanged.fog, sceneA.fog, 'Selecting a real vision source must produce new server-computed Fog');
    assert.equal(aChanged.tokens.find(token => token.id === mutation.tokenId).vision.enabled, false);
    assert.deepEqual(sceneAuditContent(changed.scenes.find(scene => scene.id === created.b.id)), bInitial);
    assert.deepEqual(sceneAuditContent(changed.scenes.find(scene => scene.id === created.c.id)), cInitial);
    findings.push({ test: 'formal Scene creation and A door/destruction/Fog changes keep same-map B and other-map C independent', passed: true,
      sceneIds: [sceneA.id, created.b.id, created.c.id], mapPackages: [sceneA.mapPackage, minimalMap], doorId: mutation.doorId, buildingId: mutation.buildingId,
      exploration: { partyId: mutation.partyId, sourceTokenId: mutation.tokenId, durableRevision: settled.durableRevision,
        pendingJobs: 0, sourceClearedAndDisabledBeforeSwitch: true, trigger: 'official Token vision and vision.source.set' } });
    await activate(created.b.id, created.b.mapPackage);
    assert.deepEqual(sceneAuditContent((await readWorld()).scenes.find(scene => scene.id === created.b.id)), bInitial);
    await activate(created.c.id, created.c.mapPackage);
    assert.deepEqual(sceneAuditContent((await readWorld()).scenes.find(scene => scene.id === created.c.id)), cInitial);
    if (captureScreenshots) {
      const screenshot = await debuggerClient.call('Page.captureScreenshot', { format: 'png' });
      await writeFile(path.join(evidenceRoot, `${mode}-scene-c.png`), Buffer.from(screenshot.data, 'base64'));
    }
    await activate(sceneA.id, sceneA.mapPackage);
    const returned = await readWorld();
    assert.deepEqual(sceneAuditContent(returned.scenes.find(scene => scene.id === sceneA.id)), aChanged);
    assert.deepEqual(returned.actors, changed.actors, 'Shared World Actors must survive cross-map Runtime reconstruction');
    if (captureScreenshots) {
      const screenshot = await debuggerClient.call('Page.captureScreenshot', { format: 'png' });
      await writeFile(path.join(evidenceRoot, `${mode}-scene-a-returned.png`), Buffer.from(screenshot.data, 'base64'));
    }
    findings.push({ test: 'GM switches same-map B to external C and returns to A through actual Runtime reloads with exact package versions and preserved content', passed: true });
    findings.push({ test: 'approved Player WebSocket receives the same active Scene and map versions across GM switches', passed: true,
      userId: observer.userId, transport: 'Node WebSocket observer; not a Player browser', events: observer.events });
    const refused = await debuggerClient.evaluate(`fetch('/api/manage/maps?id='+encodeURIComponent(${JSON.stringify(minimalMap.id)})+'&version='+encodeURIComponent(${JSON.stringify(minimalMap.version)}),{method:'DELETE'}).then(async response=>({ok:response.ok,status:response.status,body:await response.json()}))`);
    assert.equal(refused.ok, false); assert.equal(refused.body.error, 'map_package_in_use');
    assert.ok((await catalogue()).maps.some(map => map.id === minimalMap.id && map.version === minimalMap.version));
    findings.push({ test: 'formal uninstall refuses an installed map still referenced by a Scene', passed: true, mapPackage: minimalMap, status: refused.status });
    await checkMapInput(worldId);
    findings.push({ test: 'a real Token drag remains usable immediately after cross-map return', passed: true });
    return { activeSceneId: sceneA.id, mapPackage: sceneA.mapPackage, sceneIds: [sceneA.id, created.b.id, created.c.id],
      expectedScene: sceneAuditContent((await readWorld()).scenes.find(scene => scene.id === sceneA.id)) };
  } finally { observer.close(); }
}

async function verifyRestartedScenes(worldId, expected) {
  await closeDesktop();
  await launch();
  const recovered = await catalogue();
  assert.equal(recovered.maps.length, 2);
  assert.equal(recovered.activeWorldId, worldId);
  await debuggerClient.evaluate(`window.rpgmapDesktop.launchWorld(${JSON.stringify(worldId)})`).catch(error => { if (!/context|disconnected|navigated|closed/i.test(error.message)) throw error; });
  await eventually(() => debuggerClient.evaluate(`(() => {
    const api=document.querySelector('#app')?.rpgMapApp;
    return api?.multiplayer?.getStatus()?.connected && api.world.getActiveScene()?.id===${JSON.stringify(expected.activeSceneId)}
      && api.mapPackage.id===${JSON.stringify(expected.mapPackage.id)} && api.mapPackage.version===${JSON.stringify(expected.mapPackage.version)};
  })()`));
  const world = await debuggerClient.evaluate(`document.querySelector('#app').rpgMapApp.world.get()`);
  assert.deepEqual(sceneAuditContent(world.scenes.find(scene => scene.id === expected.activeSceneId)), expected.expectedScene);
  assert.deepEqual(world.scenes.map(scene => scene.id), expected.sceneIds);
  findings.push({ test: 'normal process restart restores the common active Scene and all three independently persisted Scenes without transport archives', passed: true });
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
    await writeFile(path.join(evidenceRoot, sceneAudit ? `${mode}-setup.png` : reuseData ? 'desktop-setup-restored.png' : 'desktop-setup.png'), Buffer.from(setupScreenshot.data, 'base64'));
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
  let minimalReference = null, sceneAuditResult = null;
  if (mapFile && !reuseData) {
    const importStartedAt = performance.now();
    let installed;
    if (sceneAudit) installed = await importAuditMap(mapFile, mapSha256);
    else {
      const archive = (await readFile(mapFile)).toString('base64');
      installed = await debuggerClient.evaluate(`fetch('/api/manage/maps', {method:'POST',headers:{'Content-Type':'application/octet-stream'},body:Uint8Array.from(atob(${JSON.stringify(archive)}), c => c.charCodeAt(0))}).then(async response => { if(!response.ok) throw new Error(await response.text()); return response.json(); })`);
    }
    assert.ok(installed.id || installed.map?.id);
    findings.push({ test: 'measured formal map import request through completed installation', passed: true, milliseconds: Math.round(performance.now() - importStartedAt) });
    const updated = await catalogue();
    const map = updated.maps[0]; const rule = updated.rulesets[0];
    const created = await debuggerClient.evaluate(`fetch('/api/manage/worlds', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(${JSON.stringify({ name: '桌面验收 World', ruleset: { id: rule.id, version: rule.version }, mapPackage: { id: map.id, version: map.version } })})}).then(async response => {if(!response.ok) throw new Error(await response.text()); return response.json();})`);
    worldId = created.id || created.world?.id || created.worldId;
    assert.ok(worldId);
    findings.push({ test: 'official map import and World creation', passed: true, worldId, map: `${map.id}@${map.version}` });
    if (sceneAudit) {
      await importAuditMap(minimalMapFile, minimalMapSha256);
      const installedMaps = (await catalogue()).maps;
      assert.equal(installedMaps.length, 2, 'Two separate map identities must be installed for the multi-map audit');
      const other = installedMaps.find(item => item.id !== map.id);
      assert.ok(other, 'The minimal map must be a different map identity');
      minimalReference = { id: other.id, version: other.version };
      findings.push({ test: 'formal independent Lanzhou and minimal-map import removes only disposable transport copies before Runtime loads', passed: true,
        mapSha256, minimalMapSha256, mapPackages: [{ id: map.id, version: map.version }, minimalReference] });
    }
  }
  if (worldId) {
    const firstMapStartedAt = performance.now();
    await debuggerClient.evaluate(`window.rpgmapDesktop.launchWorld(${JSON.stringify(worldId)})`).catch(error => { if (!/context|disconnected|navigated|closed/i.test(error.message)) throw error; });
    await eventually(() => debuggerClient.evaluate(`location.pathname !== '/setup' && Boolean(document.querySelector('.leaflet-container'))`));
    await eventually(() => debuggerClient.evaluate(`Boolean(document.querySelector('.leaflet-pane svg'))`));
    findings.push({ test: 'measured World launch request to first map SVG', passed: true, milliseconds: Math.round(performance.now() - firstMapStartedAt) });
    if (captureScreenshots) {
      const gameScreenshot = await debuggerClient.call('Page.captureScreenshot', { format: 'png' });
      await writeFile(path.join(evidenceRoot, sceneAudit ? `${mode}-game.png` : reuseData ? 'desktop-game-restored.png' : 'desktop-game.png'), Buffer.from(gameScreenshot.data, 'base64'));
    }
    findings.push({ test: 'supervised World launch into map UI', passed: true, worldId });
    if (!reuseData || exerciseExistingInput) {
      if (prepareUpgradeFixture) {
        const point = await establishMapToken('upgrade-smoke-actor', 'upgrade-smoke-token', '升级保留验收');
        findings.push({ test: 'historical release prepares a normal Document Actor and Token fixture without claiming drag acceptance', passed: true, point });
      } else await checkMapInput(worldId);
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
    if (sceneAudit) {
      sceneAuditResult = await checkScenes(worldId, minimalReference);
      await verifyRestartedScenes(worldId, sceneAuditResult);
      if (sceneLifecycleAudit) lifecycleResult = await runDesktopSceneLifecycleAudit({
        evaluate: expression => debuggerClient.evaluate(expression),
        call: (method, parameters) => debuggerClient.call(method, parameters),
        getSocket: () => debuggerClient.socket,
        eventually, catalogue, durableWorld: sceneAuditDurableWorld, sceneContent: sceneAuditContent,
        importMap: importAuditMap, closeDesktop, launch, createSceneObserver,
        worldId, minimalMapFile, minimalMapSha256, sourceCommit: buildSource.commit,
        evidenceRoot, dataRoot, findings, captureScreenshots, screenshotPrefix: mode,
      });
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
  assert.equal(recovered.maps.length, sceneLifecycleAudit ? lifecycleResult.expectedMapCount : reuseData ? initial.maps.length : sceneAudit ? 2 : mapFile ? 1 : 0);
  if (worldId) assert.equal(recovered.activeWorldId, worldId);
  findings.push({ test: 'process restart preserves imported package and active World', passed: true });
  await closeDesktop();
  assert.equal(browserExceptions.length, 0, 'Packaged map interaction must not emit unhandled Runtime exceptions');
  await writeFile(recordFile, `${JSON.stringify({ outcome: 'passed', mode, executable, executableSha256, mapFile, mapSha256, minimalMapFile, minimalMapSha256, sceneAudit, sceneLifecycleAudit, lifecycleResult, reuseData, installer, installerSha256, buildSource, manifestSha256, driverSha256, observerTransportSha256, lifecycleDriverSha256, at: new Date().toISOString(), findings, limitations: ['This tests the packaged executable on the development Windows host, not a clean Windows VM.', 'Map import uses the official management API; native file chooser selection is not automated.', ...(sceneAudit ? ['Player synchronization is observed through an approved Node WebSocket, not a separate Player browser or VPN machine.', ...(!sceneLifecycleAudit ? ['The two reset scopes and same-map ID with different package versions are not executed by this Scene audit.'] : lifecycleResult.limitations)] : []), ...(prepareUpgradeFixture ? ['This run prepares historical upgrade data; no Token drag or game-input acceptance is claimed.'] : [])] }, null, 2)}\n`);
  console.log(JSON.stringify(findings, null, 2));
} catch (error) {
  runFailure = error;
  throw error;
} finally {
  if (runFailure && debuggerClient && child?.exitCode === null) {
    try { await closeDesktop(); findings.push({ test: 'failed acceptance still requests a normal desktop shutdown', passed: true }); }
    catch (shutdownError) { findings.push({ test: 'failed acceptance normal shutdown', passed: false, error: shutdownError.message }); }
  }
  debuggerClient?.close();
  child?.kill();
  if (runFailure) await writeFile(recordFile, `${JSON.stringify({ outcome: 'failed', mode, executable, executableSha256, mapFile, mapSha256, minimalMapFile, minimalMapSha256, sceneAudit, sceneLifecycleAudit, lifecycleResult, reuseData, installer, installerSha256, buildSource, manifestSha256, driverSha256, observerTransportSha256, lifecycleDriverSha256, at: new Date().toISOString(), findings, error: runFailure.message.slice(0, 1000) }, null, 2)}\n`);
  await writeFile(path.join(evidenceRoot, `${mode}-process.log`), logs);
}
