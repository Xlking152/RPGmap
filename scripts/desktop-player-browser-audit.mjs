import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { OriginWebSocket } from './desktop-origin-websocket.mjs';
import { closeOwnedBrowser, rejectPendingCdp } from './owned-browser-close.mjs';
import { preserveAuditFailureDuringCleanup } from './hosted-vision-commit.mjs';

export function validatePlayerBrowserOptions({ enabled, sceneAudit, reuseData, installer, legacyDirectory, prepareUpgradeFixture }) {
  if (enabled && (!sceneAudit || reuseData || installer || legacyDirectory || prepareUpgradeFixture)) {
    throw new Error('--player-browser-audit requires --scene-audit in fresh disposable data, without reuse, installer or legacy modes');
  }
}

export function assertPlayerSceneState(state, expected) {
  assert.equal(state.connected, true);
  assert.equal(state.applyingRemote,false);
  assert.equal(state.resuming,false);
  assert.equal(state.pendingOperationCount,0);
  assert.notEqual(state.sceneTransitionPending,true);
  assert.equal(state.role, 'player');
  assert.equal(state.identityStatus, 'active');
  assert.equal(state.userId, expected.userId, 'A Runtime reload must retain the same approved Player identity');
  assert.equal(state.worldId, expected.worldId);
  assert.equal(state.sceneId, expected.sceneId);
  assert.equal(state.map.id, expected.mapPackage.id);
  assert.equal(state.map.version, expected.mapPackage.version);
  assert.match(state.map.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(state.map.fingerprint, expected.fingerprint, 'GM, Player and installed package must resolve the same exact map');
  assert.equal(state.canManageWorld, false);
  assert.equal(state.worldWrite, true, 'An active Player may submit restricted World intents such as an owned Token path');
  for(const key of ['worldReset','manageAccess','combatManage','canManageStructure'])assert.equal(state[key],false,'A Player cannot acquire GM management authority');
  assert.equal(state.desktopBridge, false, 'The real Player browser cannot acquire the desktop bridge');
  assert.equal(state.svgReady, true);
}

export function assertPlayerBrowserMovement(result, expected) {
  assert.equal(result.role, 'player');
  assert.equal(result.userId, expected.userId);
  assert.equal(result.sceneId, expected.sceneId);
  assert.equal(result.canControlToken, true);
  assert.equal(result.valid, true);
  assert.equal(result.committed, true, 'The Player must receive a real authoritative movement acknowledgement');
  assert.deepEqual(result.from, expected.from);
  assert.deepEqual(result.to, expected.target);
  assert.notDeepEqual(result.to, result.from, 'A stationary Token is not a movement acceptance result');
  assert.ok(Number.isFinite(result.elapsedMs) && result.elapsedMs >= 0);
}

export function assertPlayerBrowserCoverage({observations,outages,recovery,exceptions}, {expectedSceneIds,requireVersions=[]}) {
  for(const id of expectedSceneIds)assert.ok(observations.some(entry=>entry.sceneId===id&&entry.movement?.committed===true),`Real Player browser did not exercise authorized movement in Scene ${id}`);
  for(const version of requireVersions)assert.ok(observations.some(entry=>entry.mapPackage.id==='rpgmap-minimal-reference'&&entry.mapPackage.version===version&&entry.movement?.committed===true),`Real Player browser did not exercise authorized movement in map version ${version}`);
  assert.ok(outages.length&&recovery.some(entry=>entry.afterOutageCount>0),'The real Player must observe a service outage and recover with its original approved identity');
  assert.deepEqual(exceptions,[],'The Player browser cannot emit unhandled Runtime exceptions during Scene reload or restart');
}

export function playerProbeCombatScope(state,sceneId) {
  const scene=state.preferences?.worldV2?.scenes.find(scene=>scene.id===sceneId),combat=state.preferences?.combatSystem?.combat;
  const tokenIds=new Set((scene?.tokens||[]).map(token=>token.id));
  const associatedTokenIds=(combat?.combatants||[]).filter(item=>tokenIds.has(item.tokenId)).map(item=>item.tokenId);
  const associated=Boolean(combat&&(combat.sceneId===sceneId||associatedTokenIds.length));
  return {allowed:!associated,combatPresent:Boolean(combat),combatState:combat?.state??null,associatedTokenIds,
    ...(associated?{reason:'The current Scene retains combat; an independent movement probe is not a valid current-turn action. No combat or turn authority is changed.'}:{})};
}

export async function playerBrowserButtonPoint(button) {
  if(!button||button.tagName!=='BUTTON')throw new Error('The actual Player identity control was not found');
  button.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'});
  await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  const box=button.getBoundingClientRect(),x=box.x+box.width/2,y=box.y+box.height/2,hit=document.elementFromPoint(x,y);
  return{x,y,width:box.width,height:box.height,enabled:!button.disabled,inside:x>=0&&y>=0&&x<innerWidth&&y<innerHeight,
    hit:hit===button||Boolean(hit&&button.contains(hit))};
}

// These browser functions are serialized by CDP. They must have no Node or
// closure dependencies and only use public production Runtime commands.
export function readPlayerBrowserState(api) {
  if (!api?.multiplayer) return null;
  const status=api.multiplayer.getStatus(), scene=api.world.getActiveScene();
  return {connected:status.connected,role:status.session?.role,identityStatus:status.session?.identityStatus,
    applyingRemote:status.applyingRemote,resuming:status.resuming,pendingOperationCount:status.pendingOperationCount,
    sceneTransitionPending:typeof api.isSceneTransitionPending==='function'?api.isSceneTransitionPending():undefined,
    userId:status.session?.userId,worldId:api.world.get().id,sceneId:scene?.id,
    map:{id:api.mapPackage.id,version:api.mapPackage.version,fingerprint:api.mapPackage.fingerprint},
    canManageWorld:api.multiplayer.getCapabilities().canManageWorld,canManageStructure:api.multiplayer.getCapabilities().canManageStructure,
    worldWrite:status.permissions?.worldWrite,worldReset:status.permissions?.worldReset,manageAccess:status.permissions?.manageAccess,combatManage:status.permissions?.combatManage,
    desktopBridge:typeof window.rpgmapDesktop!=='undefined',svgReady:Boolean(document.querySelector('.leaflet-pane svg')),
    timeOrigin:performance.timeOrigin,documentUrl:location.origin+location.pathname,
    dom:{mapContainers:document.querySelectorAll('.leaflet-container').length,svgRoots:document.querySelectorAll('.leaflet-pane svg').length,
      fogCanvases:document.querySelectorAll('.rpgmap-vision-fog-perception').length},
    resourceEntries:performance.getEntriesByType('resource').length};
}

export async function movePlayerBrowserProbe(api, tokenId, target) {
  const started=performance.now(),status=api.multiplayer.getStatus(),before=api.tokens.get(tokenId);
  if (!before || !api.multiplayer.canControlToken(tokenId)) throw new Error('The approved Player does not control the probe Token');
  const from={x:before.x,y:before.y};
  const result=await api.movementFast.moveTokenPath([tokenId],tokenId,[target],{method:'drag',movementMode:'walk'});
  const after=api.tokens.get(tokenId);
  return {role:status.session.role,userId:status.session.userId,sceneId:api.world.getActiveScene().id,
    canControlToken:api.multiplayer.canControlToken(tokenId),valid:result?.valid,committed:result?.committed,
    reason:result?.reason,code:result?.code,from,to:{x:after?.x,y:after?.y},elapsedMs:performance.now()-started};
}

export async function preparePlayerBrowserProbe(api, actorId, tokenId) {
  const scene=api.world.getActiveScene();
  if (scene.tokens.some(token=>token.id===tokenId)) throw new Error('A previous Player movement probe was not removed');
  const actor=api.world.get().actors.find(item=>item.id===actorId);
  if (!actor || actor.type!=='pc') throw new Error('The approved Player probe requires its actual PC Actor');
  const candidates=[{x:50.5,y:50.5},{x:api.mapPackage.width*.25+.5,y:api.mapPackage.height*.25+.5}];
  for (const origin of [...candidates]) for(let ring=1;ring<=8;ring++) for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]) candidates.push({x:origin.x+dx*ring*10,y:origin.y+dy*ring*10});
  for (const point of candidates) {
    const target={x:point.x+.5,y:point.y};
    if (!api.inspectTokenPlacement(null,point,{diameterMeters:1,elevationMeters:0}).valid
      || !api.inspectTokenPlacement(null,target,{diameterMeters:1,elevationMeters:0}).valid) continue;
    const token={id:tokenId,actorId,actorLink:true,actorDelta:null,placement:'map',...point,featureId:null,
      diameterMeters:1,rotation:0,elevationMeters:0,effects:[],controllerUserIds:[],visibility:{mode:'public',userIds:[]},
      vision:{enabled:false},locked:false,showName:true,movement:{mode:'walk',spentMeters:0,turnKey:null,adjudicationRequired:false}};
    await api.world.performOperations([{type:'token.upsert',payload:{sceneId:scene.id,token}}],{source:'desktop-player-browser-probe'});
    if (api.movementFast.inspectTokenMove(tokenId,target).valid) return {sceneId:scene.id,tokenId,from:point,target};
    await api.world.performOperations([{type:'token.delete',payload:{sceneId:scene.id,tokenId}}],{source:'desktop-player-browser-probe-cleanup'});
  }
  throw new Error('No physically valid short Player movement route could be prepared');
}

function chromeExecutable(override) {
  if (override) { assert.ok(existsSync(override),'Configured Chrome executable does not exist'); return path.resolve(override); }
  for(const base of [process.env['ProgramFiles(x86)'],process.env.ProgramFiles,process.env.LOCALAPPDATA].filter(Boolean)) {
    const file=path.join(base,'Google','Chrome','Application','chrome.exe'); if(existsSync(file))return file;
  }
  throw new Error('Google Chrome was not found for the explicit Player browser audit');
}

function waitSocket(socket,type) {
  return new Promise((resolve,reject)=>{
    const cleanup=()=>{clearTimeout(timer);socket.removeEventListener('message',message);socket.removeEventListener('close',closed);socket.removeEventListener('error',failed);};
    const message=event=>{const value=JSON.parse(String(event.data));if(value.type!==type&&value.type!=='error')return;cleanup();value.type==='error'?reject(new Error(value.code||'player_registration_denied')):resolve(value);};
    const closed=()=>{cleanup();reject(new Error('Player registration socket closed'));};
    const failed=event=>{cleanup();reject(event.error||new Error('Player registration transport failed'));};
    const timer=setTimeout(()=>{cleanup();reject(new Error(`Player registration timed out: ${type}`));},15000);
    socket.addEventListener('message',message);socket.addEventListener('close',closed);socket.addEventListener('error',failed);
  });
}

async function approvedIdentity({origin,catalog,health,actorId}) {
  const socket=new OriginWebSocket(origin.replace('http:','ws:')+'/ws',origin);
  try {
    await socket.open(); const ready=waitSocket(socket,'welcome');
    socket.send(JSON.stringify({type:'hello',name:'Desktop browser audit approval',requestedRole:'gm',capabilities:{occlusion:1},
      operationSchema:health.operationSchema,statusSchema:health.statusSchema,accessSchema:health.accessSchema,
      gmSecret:new URLSearchParams(new URL(catalog.connection.localUrl).hash.slice(1)).get('gmSecret')}));
    assert.equal((await ready).session.role,'gm');
    const claim=waitSocket(socket,'access.claim');
    socket.send(JSON.stringify({type:'access.user.create',name:'Desktop real Chrome Player',defaultActorId:actorId,ownership:{[actorId]:'owner'}}));
    const result=await claim; assert.ok(result.user?.id);assert.ok(result.claimCode);
    return {userId:result.user.id,playerKey:result.claimCode};
  } finally {socket.close();}
}

export async function sampleOwnedProcessMemory(pids) {
  if(process.platform!=='win32')return {available:false,reason:'Windows process metrics are unavailable'};
  assert.ok(pids.every(pid=>Number.isSafeInteger(pid)&&pid>0));
  const script=`$auditRoots=@(${pids.join(',')});$auditProcesses=@(Get-CimInstance Win32_Process);$auditIds=[System.Collections.Generic.HashSet[int]]::new();foreach($auditPid in $auditRoots){[void]$auditIds.Add($auditPid)};do{$auditChanged=$false;foreach($auditItem in $auditProcesses){if($auditIds.Contains([int]$auditItem.ParentProcessId)-and $auditIds.Add([int]$auditItem.ProcessId)){$auditChanged=$true}}}while($auditChanged);@($auditProcesses|Where-Object{$auditIds.Contains([int]$_.ProcessId)}|ForEach-Object{$auditInfo=Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue;if($auditInfo){[pscustomobject]@{pid=[int]$_.ProcessId;parentPid=[int]$_.ParentProcessId;name=$_.Name;workingSetBytes=$auditInfo.WorkingSet64;privateBytes=$auditInfo.PrivateMemorySize64}}})|ConvertTo-Json -Compress`;
  const stdout=await new Promise((resolve,reject)=>execFile('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,maxBuffer:1024*1024},(error,out)=>error?reject(error):resolve(out)));
  const parsed=JSON.parse(String(stdout)||'[]');return {available:true,scope:'owned root processes and their descendants only',roots:pids,processes:Array.isArray(parsed)?parsed:[parsed]};
}

class ChromePlayer {
  constructor({eventually,freePort,executable}) {this.eventually=eventually;this.executable=executable;this.freePort=freePort;this.pending=new Map();this.next=0;this.exceptions=[];}
  async launch(url) {
    this.profile=await mkdtemp(path.join(os.tmpdir(),'rpgmap-desktop-player-audit-'));
    this.port=await this.freePort();
    this.process=spawn(this.executable,['--no-first-run','--no-default-browser-check','--disable-background-timer-throttling','--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows','--disable-features=CalculateNativeWinOcclusion','--window-size=1440,900',
      `--remote-debugging-port=${this.port}`,`--user-data-dir=${this.profile}`,url],{windowsHide:false,stdio:['ignore','ignore','ignore']});
    this.process.on('error',error=>{this.launchError=error;});
    const target=await this.eventually(async()=>{if(this.launchError)throw this.launchError;if(this.process.exitCode!==null)throw new Error('Owned Chrome process exited before CDP was ready');
      const response=await fetch(`http://127.0.0.1:${this.port}/json/list`);return(await response.json()).find(item=>item.type==='page'&&item.webSocketDebuggerUrl&&item.url.startsWith(new URL(url).origin+'/'));});
    this.socket=new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Owned Chrome CDP connection timed out')),10000);
      this.socket.addEventListener('open',()=>{clearTimeout(timer);resolve();},{once:true});this.socket.addEventListener('error',()=>{clearTimeout(timer);reject(new Error('Owned Chrome CDP failed'));},{once:true});});
    this.socket.addEventListener('close',()=>rejectPendingCdp(this.pending,'Owned Chrome CDP closed'));
    this.socket.addEventListener('message',event=>{const packet=JSON.parse(String(event.data));
      if(packet.method==='Runtime.exceptionThrown')this.exceptions.push(packet.params.exceptionDetails.exception?.description||packet.params.exceptionDetails.text);
      const task=this.pending.get(packet.id);if(!task)return;this.pending.delete(packet.id);clearTimeout(task.timer);packet.error?task.reject(new Error(packet.error.message)):task.resolve(packet.result);});
    await this.call('Runtime.enable');await this.call('Page.enable');
  }
  call(method,params={}) {const id=++this.next;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(`Owned Chrome CDP timeout: ${method}`));},30000);
    this.pending.set(id,{resolve,reject,timer});try{this.socket.send(JSON.stringify({id,method,params}));}catch(error){clearTimeout(timer);this.pending.delete(id);reject(error);}});}
  async evaluate(expression) {const result=await this.call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
    if(result.exceptionDetails)throw new Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);return result.result?.value;}
  async close() {
    const errors=[];
    try {if(this.process)await closeOwnedBrowser({process:this.process,send:method=>this.call(method),pending:this.pending,label:'Owned Chrome Player',timeoutMs:10000});}
    catch(error){errors.push(error);}
    try {this.socket?.close();if(this.process?.exitCode===null&&this.process.signalCode===null)this.process.kill('SIGTERM');}
    catch(error){errors.push(error);}
    try {if(this.profile){const resolved=await realpath(this.profile);assert.equal(path.dirname(resolved).toLowerCase(),(await realpath(os.tmpdir())).toLowerCase());
      assert.ok(path.basename(resolved).startsWith('rpgmap-desktop-player-audit-'));await rm(resolved,{recursive:true,force:true,maxRetries:20,retryDelay:100});}}
    catch(error){errors.push(error);}
    if(errors.length)throw errors.length===1?errors[0]:new AggregateError(errors,'Owned Chrome shutdown and cleanup failed');
  }
}

export async function createDesktopPlayerBrowserAudit(context) {
  const {evaluate,call,eventually,freePort,catalogue,durableWorld,sceneContent,worldId,evidenceRoot,captureScreenshots,getDesktopPid}=context;
  const origin=await evaluate('location.origin');
  const catalog=await catalogue(),health=await evaluate("fetch('/api/health').then(response=>response.json())");
  const actorId='desktop-smoke-actor',tokenId='desktop-player-browser-probe';
  const identity=await approvedIdentity({origin,catalog,health,actorId});
  const browser=new ChromePlayer({eventually,freePort,executable:chromeExecutable(context.browserExecutable)});
  const browserExecutableSha256=createHash('sha256').update(await readFile(browser.executable)).digest('hex');
  const observations=[],outages=[],recovery=[];
  let currentOrigin=origin,lastState=null,closed=false,browserVersion;
  const gm=(fn,...args)=>evaluate(`(${fn.toString()})(document.querySelector('#app').rpgMapApp,${args.map(value=>JSON.stringify(value)).join(',')})`);
  const player=(fn,...args)=>browser.evaluate(`(${fn.toString()})(document.querySelector('#app')?.rpgMapApp,${args.map(value=>JSON.stringify(value)).join(',')})`);
  const connect=async(originToJoin,joinCode)=>{
    await eventually(()=>browser.evaluate(`location.origin===${JSON.stringify(originToJoin)}&&Boolean(document.querySelector('#app')?.rpgMapApp?.multiplayer)`));
    // Only the official Player connection is submitted to this separate browser.
    // No desktop cookies, GM secret, host flag or storage identity is injected.
    await browser.evaluate(`document.querySelector('#app').rpgMapApp.multiplayer.connect(${JSON.stringify({name:'Desktop real Chrome Player',requestedRole:'player',joinCode,playerKey:identity.playerKey})})`);
    await eventually(()=>player((api,userId)=>{const status=api?.multiplayer?.getStatus();return status?.connected&&status.session?.role==='player'&&status.session.identityStatus==='active'&&status.session.userId===userId;},identity.userId));
    currentOrigin=originToJoin;
  };
  const clearSavedIdentityViaUi=async()=>{
    await player(api=>api.multiplayer.disconnect());
    if(!await browser.evaluate("Boolean(localStorage.getItem('rpgmap:multiplayer:userId'))"))return false;
    for(const selector of ['.multiplayer-toolbar','[data-mp-clear-identity]']){
      const point=await browser.evaluate(`(${playerBrowserButtonPoint.toString()})(document.querySelector(${JSON.stringify(selector)}))`);
      assert.ok(point.width>0&&point.height>0&&point.enabled&&point.inside&&point.hit,'The actual Player identity button must receive the real pointer');
      await browser.call('Input.dispatchMouseEvent',{type:'mousePressed',x:point.x,y:point.y,button:'left',buttons:1,clickCount:1});
      await browser.call('Input.dispatchMouseEvent',{type:'mouseReleased',x:point.x,y:point.y,button:'left',buttons:0,clickCount:1});
    }
    assert.equal(await browser.evaluate("Boolean(localStorage.getItem('rpgmap:multiplayer:userId'))"),false);
    return true;
  };
  try {await browser.launch(origin+'/');browserVersion=await browser.call('Browser.getVersion');
    assert.match(browserVersion.product,/^Chrome\//,'The selected executable must actually be Google Chrome');
    assert.doesNotMatch(browserVersion.userAgent,/Edg\//,'The Player audit requires Google Chrome');await connect(origin,catalog.connection.joinCode);}
  catch(error){await browser.close().catch(()=>{});throw error;}
  async function observe({reason,startedAt=performance.now(),expectReload=false}) {
    const current=await gm(api=>({worldId:api.world.get().id,sceneId:api.world.getActiveScene().id,mapPackage:{id:api.mapPackage.id,version:api.mapPackage.version},fingerprint:api.mapPackage.fingerprint}));
    assert.equal(current.worldId,worldId);
    const installed=(await catalogue()).maps.find(map=>map.id===current.mapPackage.id&&map.version===current.mapPackage.version);
    assert.ok(installed,'The exact Scene map version must still be installed');
    assert.equal(current.fingerprint,installed.fingerprint,'The GM must resolve the actual installed package content');
    const expected={...current,userId:identity.userId};
    const state=await eventually(async()=>{const value=await player(readPlayerBrowserState);assertPlayerSceneState(value,expected);return value;});
    const playerReadyElapsedMs=performance.now()-startedAt;
    if(expectReload&&lastState)assert.notEqual(state.timeOrigin,lastState.timeOrigin,'A different exact map must rebuild the real Player Runtime and resume its identity without reconnect injection');
    const diskBefore=await eventually(async()=>{const disk=await durableWorld(worldId);if(Object.keys(disk.exploration?.jobs||{}).length)return false;
      assert.equal(disk.state.preferences.worldV2.activeSceneId,current.sceneId);return disk;});
    const before=sceneContent(diskBefore.state.preferences.worldV2.scenes.find(scene=>scene.id===current.sceneId));
    const combatScope=playerProbeCombatScope(diskBefore.state,current.sceneId);
    let probe,move={outcome:'not_executed',reason:combatScope.reason,combatScope};
    if(combatScope.allowed)await preserveAuditFailureDuringCleanup(async () => {
      probe=await gm(preparePlayerBrowserProbe,actorId,tokenId);
      await eventually(()=>player((api,id)=>Boolean(api?.tokens?.get(id)&&api.multiplayer.canControlToken(id)),tokenId));
      move=await player(movePlayerBrowserProbe,tokenId,probe.target);
      assertPlayerBrowserMovement(move,{...probe,userId:identity.userId});
      move.outcome='passed';
      await eventually(async()=>{const disk=await durableWorld(worldId);const token=disk.state.preferences.worldV2.scenes.find(scene=>scene.id===probe.sceneId)?.tokens.find(token=>token.id===tokenId);
        assert.deepEqual(token&&{x:token.x,y:token.y},probe.target,'The actual Player command must be durable on the server');
        const gmToken=await gm((api,id)=>api.tokens.get(id),tokenId);assert.deepEqual({x:gmToken.x,y:gmToken.y},probe.target);return true;});
    }, async () => {
      await gm(async(api,id)=>{const sceneId=api.world.getActiveScene().id;if(api.tokens.get(id))await api.world.performOperations([{type:'token.delete',payload:{sceneId,tokenId:id}}],{source:'desktop-player-browser-probe-cleanup'});},tokenId);
    });
    if(combatScope.allowed)await eventually(()=>player((api,id)=>{const status=api?.multiplayer?.getStatus();return status?.connected&&!status.resuming&&!status.applyingRemote&&status.pendingOperationCount===0&&!api.tokens.get(id);},tokenId));
    await eventually(async()=>{const disk=await durableWorld(worldId);if(Object.keys(disk.exploration?.jobs||{}).length)return false;
      assert.deepEqual(sceneContent(disk.state.preferences.worldV2.scenes.find(scene=>scene.id===current.sceneId)),before,'The disabled-vision probe must leave no persistent Scene changes');return true;});
    const denied=await browser.evaluate("fetch('/api/manage/catalog',{credentials:'same-origin',cache:'no-store'}).then(response=>({ok:response.ok,status:response.status}))");
    assert.equal(denied.status,403,'A Player browser cannot inherit the HttpOnly desktop management session');
    const gmHeap=await call('Runtime.getHeapUsage'),playerHeap=await browser.call('Runtime.getHeapUsage');
    const gmRuntime=await gm(readPlayerBrowserState);
    const workers=await browser.call('Target.getTargets');
    const entry={reason,sceneId:current.sceneId,mapPackage:current.mapPackage,fingerprint:current.fingerprint,
      playerReadyElapsedMs,identity:{userId:identity.userId,role:state.role,status:state.identityStatus},
      runtime:{timeOrigin:state.timeOrigin,previousTimeOrigin:lastState?.timeOrigin??null,exactMapReloadRequired:expectReload,dom:state.dom,resourceEntries:state.resourceEntries,
        workerTargets:workers.targetInfos.filter(target=>['worker','service_worker','shared_worker'].includes(target.type)).map(target=>({type:target.type,url:target.url}))},
      gmRuntime:{timeOrigin:gmRuntime.timeOrigin,dom:gmRuntime.dom,resourceEntries:gmRuntime.resourceEntries},
      movement:move,managementDeniedStatus:denied.status,heaps:{gm:gmHeap,player:playerHeap},
      processMemory:await sampleOwnedProcessMemory([getDesktopPid(),browser.process.pid]),
      cacheScope:'Cache entries are not exposed by the production API. These are observed Runtime identity, DOM/resource/worker lifecycle and heap/process samples, not a cache-eviction proof.'};
    entry.observationElapsedMs=performance.now()-startedAt;
    entry.observationScope='Scene readiness, authorized movement or its explicit combat exclusion, cleanup and memory sampling; playerReadyElapsedMs alone measures readiness';
    observations.push(entry);lastState=state;
    if(captureScreenshots){const screenshot=await browser.call('Page.captureScreenshot',{format:'png'});await writeFile(path.join(evidenceRoot,`desktop-player-browser-${observations.length}.png`),Buffer.from(screenshot.data,'base64'));}
    return entry;
  }
  return {
    userId:identity.userId,
    snapshot(){return {outcome:'in_progress',browser:'Google Chrome',browserExecutable:browser.executable,browserExecutableSha256,browserVersion,headless:false,userId:identity.userId,observations,outages,recovery,exceptions:[...browser.exceptions]};},
    async afterSceneActivated({startedAt,expectReload=false,reason='GM Scene activation'}={}) {return observe({startedAt,expectReload,reason});},
    async afterDesktopReady({reason='normal desktop process restart',restoredAccess=false}={}) {
      const nextOrigin=await evaluate('location.origin'),startedAt=performance.now();
      if(nextOrigin!==currentOrigin){
        const nextCatalog=await catalogue();await browser.call('Page.navigate',{url:nextOrigin+'/'});
        await eventually(()=>browser.evaluate(`location.origin===${JSON.stringify(nextOrigin)}&&Boolean(document.querySelector('#app')?.rpgMapApp?.multiplayer)`));
        const clearedSavedIdentityViaUi=await clearSavedIdentityViaUi();
        await connect(nextOrigin,nextCatalog.connection.joinCode);
        recovery.push({reason,elapsedMs:performance.now()-startedAt,endpointChanged:true,afterOutageCount:outages.length,identityUserId:identity.userId,clearedSavedIdentityViaUi,
          method:'navigate to the new temporary server port and explicitly rejoin with the existing approved Player Key; not automatic cross-origin reconnection'});
      } else if(restoredAccess){
        const nextCatalog=await catalogue(),clearedSavedIdentityViaUi=await clearSavedIdentityViaUi();
        await connect(nextOrigin,nextCatalog.connection.joinCode);
        recovery.push({reason,endpointChanged:false,afterOutageCount:outages.length,identityUserId:identity.userId,restoredAccess:true,clearedSavedIdentityViaUi,
          method:'complete World/access restore may invalidate a later browser credential; explicitly clear saved identity through its real UI and rejoin with the original approved Player Key; not automatic reconnection'});
      } else recovery.push({reason,endpointChanged:false,afterOutageCount:outages.length,identityUserId:identity.userId,method:'existing real browser connection or automatic production reconnect; no connect injection'});
      return observe({reason,startedAt});
    },
    async desktopStopped(stoppedOrigin) {
      if(stoppedOrigin!==currentOrigin)return;
      const startedAt=performance.now();await eventually(()=>player(api=>api?.multiplayer?.getStatus()?.connected===false));
      outages.push({detectedAfterMs:performance.now()-startedAt,userId:identity.userId,origin:stoppedOrigin});
    },
    async finish({expectedSceneIds,requireVersions=[]}) {
      assertPlayerBrowserCoverage({observations,outages,recovery,exceptions:browser.exceptions},{expectedSceneIds,requireVersions});
      await this.close();
      assert.equal(createHash('sha256').update(await readFile(browser.executable)).digest('hex'),browserExecutableSha256,'The Chrome executable must remain unchanged during this audit');
      return {outcome:'passed',browser:'Google Chrome',browserExecutable:browser.executable,browserExecutableSha256,browserVersion,headless:false,userId:identity.userId,observations,outages,recovery,
        limitations:['Local real Player browser, not a VPN machine.','Movement uses the production public moveTokenPath command and authoritative ACK; this supplement does not claim a native Player pointer drag.',
          'A new random desktop server port is a new browser origin; process-restart recovery explicitly reuses the original approved key through the normal Player connection. Exact-map reloads at the same origin must reconnect automatically.']};
    },
    async close(){if(closed)return;closed=true;await browser.close();},
  };
}
