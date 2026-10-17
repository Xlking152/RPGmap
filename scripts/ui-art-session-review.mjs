import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { readUiReviewOptions } from './ui-review-options.mjs';

const root = path.resolve(import.meta.dirname, '..');
const { sessionName, mapVersion, interactive } = readUiReviewOptions(process.argv.slice(2), { defaultArtReview: true });
const output = path.join(root, 'output', sessionName);
const config = JSON.parse(await readFile(path.join(output, 'session.json'), 'utf8'));
assert.equal(path.resolve(config.dataRoot), path.join(output, 'data'), 'Only the isolated art-review World may be modified');
const origin = new URL(config.origin);
assert.equal(origin.hostname, '127.0.0.1');
assert.notEqual(origin.port, '60404', 'The existing user test World is outside this review');
assert.equal(new URL(config.hostUrl).origin, origin.origin);
const health = await (await fetch(`${origin.origin}/api/health`)).json();
assert.equal(health.status, 'ok');
assert.equal(health.world.worldId, config.worldId);
assert.equal(health.world.mapPackage.version, mapVersion);
const portrait = `data:image/webp;base64,${(await readFile(path.join(root, 'scripts', 'fixtures', 'ui-silver-portrait.webp'))).toString('base64')}`;
const profile = interactive ? path.join(output, 'browser-profile')
  : await mkdtemp(path.join(os.tmpdir(), 'rpgmap-art-session-review-'));
if (interactive) await mkdir(profile, { recursive: true });
const browserPath = process.env.RPGMAP_BROWSER_EXECUTABLE || path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe');
const listener = net.createServer();
await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
const port = listener.address().port;
await new Promise(resolve => listener.close(resolve));
const browser = spawn(browserPath, [...(interactive ? ['--new-window', '--window-size=1600,1000'] : ['--headless=new']),
  '--no-first-run', '--no-default-browser-check', '--disable-gpu',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'],
{ windowsHide: !interactive, detached: interactive, stdio: 'ignore' });
const errors = [], httpErrors = [], failedRequests = [], findings = [], pending = new Map();
let socket, sequence = 0, welcome = null, damagedFeatureId = null, statusToRestore = null, reviewPassed = false;
const apiExpression = "document.querySelector('#app').rpgMapApp";
const delay = time => new Promise(resolve => setTimeout(resolve, time));
async function until(work, label) {
  const deadline = Date.now() + 90000;
  let failure;
  while (Date.now() < deadline) {
    try { const value = await work(); if (value) return value; } catch (error) { failure = error; }
    await delay(100);
  }
  throw new Error(`Timed out: ${label}${failure ? ` (${failure.message})` : ''}`);
}
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timed out: ${method}`)); }, 45000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}
function safeUrl(url) { try { const value = new URL(url); return `${value.origin}${value.pathname}`; } catch { return ''; } }
async function screenshot(name, { fog = false } = {}) {
  await delay(350);
  const layout = await evaluate(`(()=>{const map=document.querySelector('.leaflet-container').getBoundingClientRect();return {
    documentWidth:document.documentElement.scrollWidth,viewportWidth:innerWidth,map:{x:map.x,y:map.y,width:map.width,height:map.height},
    panel:${apiExpression}.getActivePanel(),connection:${apiExpression}.multiplayer.getConnectionState().connected};})()`);
  assert(layout.documentWidth <= layout.viewportWidth, `${name}: horizontal overflow`);
  assert(layout.map.width > 100 && layout.map.height > 100, `${name}: map must remain visible`);
  assert.equal(layout.connection, true);
  const image = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await writeFile(path.join(output, `${name}.png`), Buffer.from(image.data, 'base64'));
  const pixels = await evaluate(`(async()=>{const image=new Image();image.src='data:image/png;base64,${image.data}';await image.decode();
    const canvas=document.createElement('canvas');canvas.width=64;canvas.height=64;const ctx=canvas.getContext('2d');
    const r=${JSON.stringify(layout.map)};ctx.drawImage(image,r.x,r.y,r.width,r.height,0,0,64,64);const values=ctx.getImageData(0,0,64,64).data,colors=new Set();
    for(let i=0;i<values.length;i+=4)colors.add((values[i]>>3)+','+(values[i+1]>>3)+','+(values[i+2]>>3));
    return {colors:colors.size};})()`);
  assert(pixels.colors > (fog ? 8 : 24), `${name}: actual map pixels must not be blank`);
  findings.push({ name, ...layout, pixels });
}
async function viewport(width, height) {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await evaluate(`${apiExpression}.map.invalidateSize({pan:false});true`);
  await delay(150);
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
    else if (message.method === 'Network.responseReceived' && message.params.response.status >= 400) httpErrors.push({ url: safeUrl(message.params.response.url), status: message.params.response.status });
    else if (message.method === 'Network.loadingFailed') failedRequests.push({ type: message.params.type, error: message.params.errorText });
    else if (message.method === 'Network.webSocketFrameReceived') {
      let frame; try { frame = JSON.parse(message.params.response.payloadData); } catch { return; }
      if (frame.type === 'welcome') welcome = { role: frame.session?.role, identityStatus: frame.session?.identityStatus, worldId: frame.world?.state?.preferences?.worldV2?.id };
      if (frame.type === 'error') errors.push(`Server error: ${frame.code}`);
    }
  });
  await send('Runtime.enable'); await send('Network.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: config.hostUrl });
  await until(() => welcome?.role === 'gm', 'GM authentication');
  assert.equal(welcome.worldId, config.worldId); assert.equal(welcome.identityStatus, 'active');
  await until(() => evaluate(`!!document.querySelector('#app')?.rpgMapApp?.interaction && ${apiExpression}.multiplayer.getConnectionState().connected
    && document.querySelector('.multiplayer-backdrop')?.hidden && !!document.querySelector('.leaflet-pane svg [data-feature-id]')`), 'production Runtime');
  assert.equal(await evaluate('location.hash'), '', 'Launch credential hash must be removed');
  const seed = await evaluate(`(async()=>{const api=${apiExpression},world=api.world.get();
    if(world.id!==${JSON.stringify(config.worldId)})throw new Error('Unexpected World');
    const names=[{id:'art-review-silver',name:'银 · 样板',type:'pc'},{id:'art-review-han',name:'韩立 · 样板',type:'pc'},
      {id:'art-review-guard',name:'北门守卫 · 样板',type:'npc'}],sceneId=world.activeSceneId,scene=api.world.getActiveScene();
    const positions=[{x:3367.5,y:1606.5}];
    if(!api.inspectTokenPlacement(null,positions[0],{diameterMeters:1,elevationMeters:0}).valid)throw new Error('North-gate anchor is blocked');
    for(let radius=120;radius<360&&positions.length<3;radius+=20)for(const [dx,dy]of [[1,0],[0,1],[-1,0],[0,-1]]){
      const point={x:positions[0].x+dx*radius,y:positions[0].y+dy*radius};
      if(positions.every(other=>Math.hypot(other.x-point.x,other.y-point.y)>=120)&&api.inspectTokenPlacement(null,point,{diameterMeters:1,elevationMeters:0}).valid)positions.push(point);
      if(positions.length===3)break;}
    if(positions.length!==3)throw new Error('No safe positions for sample Tokens');
    const actors=names.filter(identity=>!world.actors.some(actor=>actor.id===identity.id)).map(identity=>({
      ...api.ruleset.actor.createFromImport({formName:'普通',identity:{name:identity.name},description:{summary:'北门街区独立美术验收角色。'},
        avatarDataUrl:identity.id==='art-review-silver'?${JSON.stringify(portrait)}:null,
        resources:{hp:{max:24},stamina:{max:12},willpower:{max:10}},attributes:[],checks:{skills:[
          {category:'感知',name:'观察',checkValue:6,level:4,bonus:2,specialties:'追踪'},
          {category:'体能',name:'运动',checkValue:5,level:3,bonus:2,specialties:''}],saves:[{name:'坚韧',checkValue:5,totalBonus:2}]},
        badStatuses:[],combat:{attacks:[],defenses:[]},detection:{configured:true,preciseRangeMeters:40,vagueRangeMeters:60},source:{type:'manual'}},
        {actorId:identity.id,name:identity.name}),...identity,partyId:identity.type==='pc'?'party-art-review':null}));
    const operations=actors.map(actor=>({type:'actor.upsert',payload:{actor}}));
    names.forEach((actor,index)=>{const existing=scene.tokens.find(token=>token.id===actor.id+'-token');if(!existing)operations.push({type:'token.create',payload:{sceneId,
      token:{id:actor.id+'-token',actorId:actor.id,name:actor.name,actorLink:actor.type==='pc',placement:'map',...positions[index],
        diameterMeters:1,elevationMeters:0,visibility:{mode:'public',userIds:[]},effects:[]}}});
      else if(existing.x!==positions[index].x||existing.y!==positions[index].y)operations.push({type:'token.reposition',payload:{sceneId,tokenId:existing.id,...positions[index],elevationMeters:0}});});
    if(operations.length)await api.world.performOperations(operations,{source:'ui-art-review:seed'});
    names.forEach((actor,index)=>{const token=api.tokens.get(actor.id+'-token');if(token?.x!==positions[index].x||token?.y!==positions[index].y)
      throw new Error('Server did not acknowledge sample Token placement');});
    if(actors.some(actor=>actor.id==='art-review-silver')){
      await api.health.applyDamageToTokenIds(['art-review-silver-token'],{amount:6,type:'L'});
      await api.status.apply({scope:'token',targetId:'art-review-silver-token',definitionId:'status-strengthened',duration:{unit:'turns',initial:3,remaining:3}});
      await api.status.apply({scope:'token',targetId:'art-review-silver-token',definitionId:'status-bleeding',duration:{unit:'turns',initial:2,remaining:2}});}
    api.selection.replace(['art-review-silver-token'],'art-review-silver-token');
    await api.vision.setSource('art-review-silver-token');await api.vision.setSource(null);
    api.setActivePanel('current');api.map.setView({lat:api.mapPackage.height-1720,lng:3300},.25,{animate:false});
    return {createdActors:actors.length,tokenIds:names.map(actor=>actor.id+'-token'),sceneId,map:{id:api.mapPackage.id,version:api.mapPackage.version},positions};})()`);
  assert.equal(seed.map.version, mapVersion);
  await until(() => evaluate(`${apiExpression}.vision.getSource()===null`), 'confirmed GM full view');
  assert.equal(await evaluate("document.querySelector('[data-role=app-title]').textContent"),
    await evaluate(`${apiExpression}.world.get().name`), 'The workspace heading must identify the actual World');
  await until(() => evaluate("getComputedStyle(document.querySelector('.selected-token-summary')).display==='none'"), 'inspector owns the visible Token summary');
  await evaluate(`${apiExpression}.chat.message('界面验收：北门街区已准备。')`);
  await until(() => evaluate("!document.querySelector('.chat-unread-badge').hidden"), 'authoritative chat updates the unread badge');
  await evaluate(`${apiExpression}.setActivePanel('chat');true`);
  await until(() => evaluate("document.querySelector('.chat-unread-badge').hidden && document.querySelector('.chat-log').textContent.includes('北门街区已准备')"), 'programmatic chat activation clears unread and displays the message');
  assert.equal(await evaluate("document.querySelectorAll('.sidebar [data-panel].active').length"), 1);
  await until(() => evaluate("getComputedStyle(document.querySelector('.selected-token-summary')).display!=='none'"), 'chat retains the compact Token summary');
  await evaluate(`${apiExpression}.setActivePanel('current');document.querySelector('[data-inspector-toggle]').click();true`);
  await until(() => evaluate("getComputedStyle(document.querySelector('.selected-token-summary')).display!=='none'"), 'collapsed inspector retains the compact Token summary');
  await evaluate("document.querySelector('[data-inspector-toggle]').click();true");
  await until(() => evaluate("getComputedStyle(document.querySelector('.selected-token-summary')).display==='none'"), 'expanded inspector removes duplicate summary');
  assert.equal(await evaluate("document.querySelectorAll('.sidebar [data-panel].active').length"), 1);
  const statusSnapshot = `(()=>{const api=${apiExpression},snapshot=api.status.resolve({actorId:'art-review-silver',tokenId:'art-review-silver-token'});
    return {actor:snapshot.actorStatuses,token:snapshot.tokenStatuses};})()`;
  const statusBefore = await evaluate(statusSnapshot);
  assert(statusBefore.token.some(status => status.definitionId === 'status-strengthened' && status.enabled !== false));
  const originalStatus = statusBefore.token.find(status => status.definitionId === 'status-strengthened');
  await evaluate(`${apiExpression}.statusUi.openQuickHud('art-review-silver-token',{clientX:850,clientY:180})`);
  await until(() => evaluate("document.querySelector('[data-quick-status=status-strengthened]')?.dataset.state==='enabled'"), 'HUD recognizes an existing Token-scoped status');
  statusToRestore = { type: 'status.setStacks', scope: 'token', targetId: 'art-review-silver-token', definitionId: 'status-strengthened',
    stacks: originalStatus.stacks || 1, enabled: true };
  await evaluate("document.querySelector('[data-quick-status=status-strengthened]').click();true");
  await until(async () => (await evaluate(statusSnapshot)).token.some(status => status.definitionId === 'status-strengthened' && status.enabled === false), 'server confirms original Token status disabled');
  const statusDisabled = await evaluate(statusSnapshot);
  assert.deepEqual(statusDisabled.actor, statusBefore.actor, 'HUD must not duplicate a Token status onto its shared Actor');
  const disabledStatus = statusDisabled.token.find(status => status.definitionId === 'status-strengthened');
  assert.equal(disabledStatus.id, originalStatus.id);
  assert.deepEqual(disabledStatus.duration, originalStatus.duration, 'Disabling a status must preserve its remaining duration');
  await until(() => evaluate("document.querySelector('[data-quick-status=status-strengthened]')?.dataset.state==='disabled'"), 'HUD reflects authoritative disabled state');
  await evaluate("document.querySelector('[data-quick-status=status-strengthened]').click();true");
  await until(async () => (await evaluate(statusSnapshot)).token.some(status => status.definitionId === 'status-strengthened' && status.enabled !== false), 'server confirms original Token status reenabled');
  const statusAfter = await evaluate(statusSnapshot);
  assert.deepEqual(statusAfter, statusBefore, 'The HUD cycle must preserve status identity, duration and scope');
  statusToRestore = null;
  await screenshot('08-status-hud');
  await evaluate("document.querySelector('[data-quick-action=close]').click();true");
  await screenshot('01-normal-map-inspector');
  await evaluate(`${apiExpression}.entities.openToken('art-review-silver-token','overview');true`);
  await until(() => evaluate('!!document.querySelector(".entity-sheet-body")'), 'Token sheet');
  const sheet = await evaluate(`(()=>{const node=document.querySelector('.entity-sheet-body'),r=node.getBoundingClientRect();return {height:r.height,client:node.clientWidth,scroll:node.scrollWidth,portrait:!!document.querySelector('.entity-sheet-header img')};})()`);
  assert(sheet.height >= 120 && sheet.scroll <= sheet.client && sheet.portrait, 'Real instance sheet and portrait must be usable');
  await screenshot('02-token-sheet');
  await evaluate("document.querySelector('.entity-sheet [data-sheet-action=close]').click();true");
  await evaluate(`${apiExpression}.setActivePanel('vision');true`);
  await evaluate(`document.querySelector('[data-vision-mode="token"]').click();true`);
  await until(() => evaluate(`${apiExpression}.vision.getSource()==='art-review-silver-token'`), 'authoritative vision source');
  await evaluate(`(()=>{const api=${apiExpression},token=api.tokens.get('art-review-silver-token');api.map.setView({lat:api.mapPackage.height-token.y,lng:token.x},2.5,{animate:false});})()`);
  await until(() => evaluate(`${apiExpression}.vision.getFeedbackState()?.rendered===true`), 'real LOS Canvas');
  const vision = await evaluate(`(()=>{const api=${apiExpression},source=api.vision.getVisibleRegion(),canvas=document.querySelector('[data-fog-layer=perception]'),
    pixels=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;let clear=0,opaque=0,partial=0;
    for(let i=3;i<pixels.length;i+=4){if(pixels[i]===0)clear++;else if(pixels[i]===255)opaque++;else partial++;}
    return {source,clear,opaque,partial};})()`);
  assert.equal(vision.source.preciseRangeMeters, 40); assert.equal(vision.source.lineOfSightEnabled, true);
  assert(vision.clear > 100 && vision.opaque > 100 && vision.partial > 100, 'Real visibility must have exact, unknown and intermediate pixels');
  await screenshot('03-real-los-vision', { fog: true });
  await viewport(390, 844);
  await evaluate(`(()=>{const api=${apiExpression},token=api.tokens.get('art-review-silver-token');api.map.setView({lat:api.mapPackage.height-token.y,lng:token.x},1.25,{animate:false});})()`);
  await screenshot('04-mobile-vision', { fog: true });
  await viewport(1600, 1000);
  await evaluate(`${apiExpression}.vision.setSource(null)`);
  const feature = await evaluate(`(()=>{const api=${apiExpression};return api.mapPackage.features.filter(feature=>feature.category==='building'
    &&api.interaction.actionsForFeature(feature.id).some(action=>action.id==='damage'&&action.enabled)).map(feature=>{
      const points=feature.geometry?.points||[],center=points.length?{x:points.reduce((n,p)=>n+p[0],0)/points.length,y:points.reduce((n,p)=>n+p[1],0)/points.length}:null;
      return {id:feature.id,name:feature.name,center,distance:center?Math.hypot(center.x-3367.5,center.y-1606.5):Infinity};}).sort((a,b)=>a.distance-b.distance)[0];})()`);
  assert(feature?.id && feature.center, 'A nearby actual building is required');
  damagedFeatureId = feature.id;
  const damage = await evaluate(`${apiExpression}.interaction.damage(${JSON.stringify(feature.id)})`);
  assert.equal(damage.ok, true);
  await until(() => evaluate(`${apiExpression}.interaction.stateForFeature(${JSON.stringify(feature.id)})?.destroyed===true`), 'authoritative building destruction');
  await evaluate(`(()=>{const api=${apiExpression};api.selectFeature(${JSON.stringify(feature.id)});api.map.setView({lat:api.mapPackage.height-${feature.center.y},lng:${feature.center.x}},1.5,{animate:false});})()`);
  await screenshot('05-destroyed-building');
  const restored = await evaluate(`${apiExpression}.interaction.restore(${JSON.stringify(feature.id)})`);
  assert.equal(restored.ok, true);
  await until(() => evaluate(`!${apiExpression}.interaction.stateForFeature(${JSON.stringify(feature.id)})?.destroyed`), 'authoritative building restoration');
  damagedFeatureId = null;
  await screenshot('06-restored-building');
  if (interactive) {
    await send('Emulation.clearDeviceMetricsOverride');
    await evaluate(`${apiExpression}.map.invalidateSize({pan:false});true`);
  }
  await evaluate(`(async()=>{const api=${apiExpression};api.selection.replace(['art-review-silver-token'],'art-review-silver-token');
    await api.vision.setSource('art-review-silver-token');await api.vision.setSource(null);api.setActivePanel('current');
    api.map.setView({lat:api.mapPackage.height-1720,lng:3300},.25,{animate:false});})()`);
  await until(() => evaluate(`${apiExpression}.vision.getSource()===null`), 'ready GM full view');
  await screenshot('07-ready-to-play');
  assert.deepEqual(errors, []); assert.deepEqual(httpErrors, []); assert.deepEqual(failedRequests, []);
  const report = { passed: true, interactive, scope: 'Real production Local/LAN GM session in isolated art-review World; not Player Audience validation',
    origin: config.origin, worldId: config.worldId, welcome, seed, sheet, vision, feature,
    statusReview: { originalStatus, disabledStatus, roundTripPreserved: true }, findings, errors, httpErrors, failedRequests };
  await writeFile(path.join(output, 'art-review-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  reviewPassed = true;
  console.log(JSON.stringify({ passed: true, interactive, output, screenshots: findings.length, seed, errors, httpErrors, failedRequests }));
} catch (error) {
  try { const image=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});await writeFile(path.join(output,'review-failure.png'),Buffer.from(image.data,'base64')); } catch { /* Keep the original failure. */ }
  console.error(JSON.stringify({ passed: false, failure: error.message, welcome, errors, httpErrors, failedRequests }));
  throw error;
} finally {
  if (statusToRestore && socket?.readyState === WebSocket.OPEN) {
    await evaluate(`${apiExpression}.status.applyBatch(${JSON.stringify([statusToRestore])})`).catch(error => console.error(`Review cleanup status restoration failed: ${error.message}`));
  }
  if (damagedFeatureId && socket?.readyState === WebSocket.OPEN) {
    await evaluate(`${apiExpression}.interaction.restore(${JSON.stringify(damagedFeatureId)})`).catch(error => console.error(`Review cleanup restoration failed: ${error.message}`));
  }
  const keepBrowser = interactive && reviewPassed;
  if (socket?.readyState === WebSocket.OPEN) {
    if (!keepBrowser) { try { await send('Browser.close'); } catch { /* Closing Chrome also closes CDP. */ } }
    socket.close();
  }
  for (const item of pending.values()) clearTimeout(item.timer);
  if (keepBrowser) browser.unref();
  else if (browser.exitCode === null) { await Promise.race([new Promise(resolve => browser.once('exit', resolve)), delay(2000)]); if (browser.exitCode === null) browser.kill(); }
  if (!interactive) {
    await delay(300);
    const resolved = path.resolve(profile);
    assert(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('rpgmap-art-session-review-'));
    await rm(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
  }
}
