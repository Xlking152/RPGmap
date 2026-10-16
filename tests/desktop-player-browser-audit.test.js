import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { validatePlayerBrowserOptions, assertPlayerSceneState, assertPlayerBrowserMovement,
  assertPlayerBrowserCoverage, readPlayerBrowserState, movePlayerBrowserProbe, preparePlayerBrowserProbe,
  playerBrowserButtonPoint, playerProbeCombatScope } from '../scripts/desktop-player-browser-audit.mjs';
import { hostedBrowserRuntime } from './helpers/hosted-browser-runtime.js';
import { WORLD_OPERATION_SCHEMA_VERSION } from '../src/world/operations.js';
import { STATUS_SCHEMA_VERSION } from '../src/status/model.js';
import { ACCESS_SCHEMA_VERSION } from '../src/permissions/model.js';

const source=await readFile(new URL('../scripts/desktop-player-browser-audit.mjs',import.meta.url),'utf8');
const driver=await readFile(new URL('../scripts/desktop-browser-smoke.mjs',import.meta.url),'utf8');
const lifecycle=await readFile(new URL('../scripts/desktop-scene-lifecycle-audit.mjs',import.meta.url),'utf8');
const options={enabled:true,sceneAudit:true,reuseData:false,installer:null,legacyDirectory:null,prepareUpgradeFixture:false};

test('Real Player browser audit is an explicit fresh-data supplement and does not replace the original Scene audit',()=>{
  assert.doesNotThrow(()=>validatePlayerBrowserOptions(options));
  assert.doesNotThrow(()=>validatePlayerBrowserOptions({enabled:false,sceneAudit:false}));
  for(const change of [{sceneAudit:false},{reuseData:true},{installer:'installer.exe'},{legacyDirectory:'private-data'},{prepareUpgradeFixture:true}])
    assert.throws(()=>validatePlayerBrowserOptions({...options,...change}),/fresh disposable data/);
  assert.match(driver,/argumentsByName\.has\('--player-browser-audit'\)/);
  assert.match(driver,/sceneAuditResult = await checkScenes\(worldId, minimalReference\)/);
  assert.match(driver,/await verifyRestartedScenes\(worldId, sceneAuditResult\)/);
  assert.match(driver,/await playerBrowser\?\.afterDesktopReady/);
  assert.match(lifecycle,/afterSceneActivated\(\{startedAt,expectReload:true/);
  const restoredAccessAssertion=lifecycle.indexOf("assert.deepEqual(access, recoveryEnvelope.record.access");
  assert.ok(restoredAccessAssertion>0);
  assert.ok(lifecycle.indexOf("afterDesktopReady({reason:'complete World/access restore",restoredAccessAssertion)>restoredAccessAssertion,
    'Real Player re-binding must follow, rather than invalidate, exact recovery of the entire saved access table');
  assert.match(driver,/if\(playerCleanupFailure\)throw runFailure/);
  assert.match(driver,/new AggregateError\(\[runFailure,error\]/);
  for(const outcome of ['passed','failed']) {
    const record=driver.split('\n').find(line=>line.includes('writeFile(recordFile,')&&line.includes(`outcome: '${outcome}'`));
    assert.ok(record.includes('playerBrowserDriverSha256,')&&record.includes('playerBrowserResult,'));
  }
});

function expected(){return{userId:'player-native',worldId:'world',sceneId:'scene-c',mapPackage:{id:'map',version:'1.3.0'},fingerprint:'a'.repeat(64)};}
function state(){return{connected:true,role:'player',identityStatus:'active',userId:'player-native',worldId:'world',sceneId:'scene-c',
  applyingRemote:false,resuming:false,pendingOperationCount:0,sceneTransitionPending:false,
  map:{id:'map',version:'1.3.0',fingerprint:'a'.repeat(64)},worldWrite:true,worldReset:false,manageAccess:false,combatManage:false,
  canManageWorld:false,canManageStructure:false,desktopBridge:false,svgReady:true};}

test('Real Player scene acceptance requires exact identity, map content, ready SVG and actual Player permission semantics',()=>{
  assert.doesNotThrow(()=>assertPlayerSceneState(state(),expected()));
  for(const mutate of [
    value=>{value.connected=false;},value=>{value.role='gm';},value=>{value.identityStatus='pending';},value=>{value.userId='other-player';},
    value=>{value.worldId='other-world';},value=>{value.sceneId='other-scene';},value=>{value.map.id='other-map';},
    value=>{value.map.version='1.2.0';},value=>{value.map.fingerprint='b'.repeat(64);},value=>{value.desktopBridge=true;},
    value=>{value.worldWrite=false;},value=>{value.worldReset=true;},value=>{value.manageAccess=true;},value=>{value.combatManage=true;},
    value=>{value.canManageWorld=true;},value=>{value.canManageStructure=true;},value=>{value.svgReady=false;},
    value=>{value.applyingRemote=true;},value=>{value.resuming=true;},value=>{value.pendingOperationCount=1;},value=>{value.sceneTransitionPending=true;},
  ]){const changed=state();mutate(changed);assert.throws(()=>assertPlayerSceneState(changed,expected()));}
});

test('Player state sampling uses the actual production controller getStatus contract, not lightweight connectionState permissions',async t=>{
  const {api,socket}=await hostedBrowserRuntime(t);
  const value=api.exportState();api.mapPackage.fingerprint='a'.repeat(64);
  await socket.receive({type:'welcome',capabilities:{occlusion:1},operationSchema:WORLD_OPERATION_SCHEMA_VERSION,
    statusSchema:STATUS_SCHEMA_VERSION,accessSchema:ACCESS_SCHEMA_VERSION,world:{state:value,revision:40},
    session:{id:'player-session',userId:'player-native',role:'player',identityStatus:'active'},
    permissions:{worldWrite:true,worldReset:false,manageAccess:false,combatManage:false,actorOwnerIds:[],actorObserverIds:[],actorLimitedIds:[]},
    audienceRevision:0,audienceFingerprint:'audience'});
  await socket.receive({type:'identity.bound',userId:'player-native',authToken:'TEST-PRIVATE-NEVER-EXPORTED'});
  assert.equal(api.multiplayer.getConnectionState().permissions,undefined);
  assert.equal(api.multiplayer.getStatus().permissions.worldWrite,true);
  const observed=await runInNewContext(`(${readPlayerBrowserState.toString()})(api)`,{api,window:{},
    location:{origin:'http://127.0.0.1:30000',pathname:'/'},performance:{timeOrigin:123,getEntriesByType:()=>[]},
    document:{querySelector:()=>({}),querySelectorAll:()=>[{}]}});
  const wanted={...expected(),worldId:api.world.get().id,sceneId:api.world.getActiveScene().id,mapPackage:{id:api.mapPackage.id,version:api.mapPackage.version}};
  assertPlayerSceneState(observed,wanted);
  assert.equal(JSON.stringify(observed).includes('TEST-PRIVATE-NEVER-EXPORTED'),false);
  assert.equal(observed.resourceEntries,0);assert.equal(observed.timeOrigin,123);
});

function movementRuntime({controlled=true}={}){
  const token={id:'probe',x:50.5,y:50.5},calls=[];let finish,deny;
  const api={tokens:{get:()=>structuredClone(token)},world:{getActiveScene:()=>({id:'scene-c'})},multiplayer:{
    getStatus:()=>({session:{role:'player',userId:'player-native'}}),canControlToken:()=>controlled},
    movementFast:{moveTokenPath(...args){calls.push(args);return new Promise((resolve,reject)=>{finish=()=>{token.x=51;resolve({valid:true,committed:true});};deny=reject;});}}};
  return{api,calls,token,ack:()=>finish(),reject:error=>deny(error)};
}

test('Player probe awaits the real route ACK and verifies the changed authoritative position',async()=>{
  const runtime=movementRuntime(),target={x:51,y:50.5};let completed=false;
  const pending=movePlayerBrowserProbe(runtime.api,'probe',target).then(value=>{completed=true;return value;});
  await Promise.resolve();assert.equal(completed,false);assert.equal(runtime.token.x,50.5);
  assert.deepEqual(runtime.calls,[[['probe'],'probe',[target],{method:'drag',movementMode:'walk'}]]);
  runtime.ack();const result=await pending;
  assertPlayerBrowserMovement(result,{userId:'player-native',sceneId:'scene-c',from:{x:50.5,y:50.5},target});
  for(const change of [{committed:false},{valid:false},{role:'gm'},{userId:'another'},{sceneId:'wrong'},{canControlToken:false},{to:{x:50.5,y:50.5}}])
    assert.throws(()=>assertPlayerBrowserMovement({...result,...change},{userId:'player-native',sceneId:'scene-c',from:{x:50.5,y:50.5},target}));
});

test('Player probe surfaces collision or permission refusal without retrying or moving locally',async()=>{
  for(const code of ['path_blocked','permission_denied','revision_conflict']){
    const runtime=movementRuntime(),pending=movePlayerBrowserProbe(runtime.api,'probe',{x:51,y:50.5});
    runtime.reject(Object.assign(new Error('server refusal'),{code}));
    await assert.rejects(pending,{code});assert.equal(runtime.calls.length,1);assert.equal(runtime.token.x,50.5);
  }
  const denied=movementRuntime({controlled:false});
  await assert.rejects(movePlayerBrowserProbe(denied.api,'probe',{x:51,y:50.5}),/does not control/);assert.equal(denied.calls.length,0);
});

test('GM probe preparation uses only normal token intents and preflights actual placement and route geometry',async()=>{
  const tokens=[],operations=[];const api={mapPackage:{width:1000,height:1000},tokens:{get:id=>tokens.find(token=>token.id===id)},
    inspectTokenPlacement:()=>({valid:true}),movementFast:{inspectTokenMove:()=>({valid:true})},world:{
      getActiveScene:()=>({id:'scene-c',tokens}),get:()=>({actors:[{id:'actor',type:'pc'}]}),
      async performOperations(input){operations.push(...structuredClone(input));for(const operation of input)if(operation.type==='token.upsert')tokens.push(structuredClone(operation.payload.token));}}};
  const result=await preparePlayerBrowserProbe(api,'actor','probe');
  assert.equal(result.sceneId,'scene-c');assert.deepEqual(result.from,{x:50.5,y:50.5});assert.deepEqual(result.target,{x:51,y:50.5});
  assert.equal(operations.length,1);assert.equal(operations[0].type,'token.upsert');assert.equal(tokens[0].vision.enabled,false);
  assert.deepEqual(tokens[0].controllerUserIds,[],'Ownership comes from the approved Actor; no extra control grant is injected');
  await assert.rejects(preparePlayerBrowserProbe(api,'actor','probe'),/not removed/);
});

test('Real browser coverage rejects missing Scenes, skipped exact versions, missing restart recovery and Runtime errors',()=>{
  const evidence={observations:[{sceneId:'a',mapPackage:{id:'lanzhou',version:'1.1.0'},movement:{committed:true}},{sceneId:'b',mapPackage:{id:'lanzhou',version:'1.1.0'},movement:{committed:true}},
    {sceneId:'c',mapPackage:{id:'rpgmap-minimal-reference',version:'1.2.0'},movement:{committed:true}},{sceneId:'d',mapPackage:{id:'rpgmap-minimal-reference',version:'1.3.0'},movement:{committed:true}}],
    outages:[{}],recovery:[{afterOutageCount:1}],exceptions:[]};
  const requirement={expectedSceneIds:['a','b','c'],requireVersions:['1.2.0','1.3.0']};
  assert.doesNotThrow(()=>assertPlayerBrowserCoverage(evidence,requirement));
  for(const change of [{observations:evidence.observations.filter(entry=>entry.sceneId!=='b')},
    {observations:evidence.observations.filter(entry=>entry.sceneId!=='d')},
    {observations:evidence.observations.map(entry=>entry.sceneId==='d'?{...entry,movement:{outcome:'not_executed'}}:entry)},
    {outages:[]},{recovery:[{afterOutageCount:0}]},{exceptions:['unhandled']}])
    assert.throws(()=>assertPlayerBrowserCoverage({...evidence,...change},requirement));
});

test('A retained Scene combat prevents an unrelated movement probe without weakening required no-combat movement coverage',()=>{
  const value={preferences:{worldV2:{scenes:[{id:'a',tokens:[{id:'fighter'}]},{id:'b',tokens:[]}]},
    combatSystem:{combat:{state:'active',combatants:[{tokenId:'fighter'}]}}}};
  assert.equal(playerProbeCombatScope(value,'a').allowed,false);
  assert.deepEqual(playerProbeCombatScope(value,'a').associatedTokenIds,['fighter']);
  assert.equal(playerProbeCombatScope(value,'b').allowed,true,'Combat belonging to a different Scene does not block this movement fixture');
  const noCombat=structuredClone(value);noCombat.preferences.combatSystem.combat=null;
  assert.equal(playerProbeCombatScope(noCombat,'a').allowed,true);
  const explicitScene=structuredClone(value);explicitScene.preferences.combatSystem.combat.sceneId='b';
  assert.equal(playerProbeCombatScope(explicitScene,'b').allowed,false);
});

test('Restored-access identity clearing uses visible real buttons rather than direct credential-storage mutation',async()=>{
  const order=[],child={},button={tagName:'BUTTON',disabled:false,scrollIntoView(){order.push('scroll');},
    getBoundingClientRect(){order.push('measure');return{x:20,y:30,width:60,height:20};},contains:node=>node===child};
  const point=await runInNewContext(`(${playerBrowserButtonPoint.toString()})(button)`,{button,innerWidth:800,innerHeight:600,
    requestAnimationFrame:callback=>{order.push('frame');callback();},document:{elementFromPoint:()=>child}});
  assert.deepEqual(order,['scroll','frame','frame','measure']);assert.equal(point.hit,true);assert.equal(point.enabled,true);assert.equal(point.inside,true);
  assert.doesNotMatch(source,/localStorage\.(?:setItem|removeItem)|sessionStorage\.(?:setItem|removeItem)|RPGMAP_TEST_ALLOW_MISSING_ORIGIN|--no-sandbox|--headless/);
  assert.match(source,/Input\.dispatchMouseEvent/);assert.match(source,/\[data-mp-clear-identity\]/);
  assert.match(source,/endpointChanged:true/);assert.match(source,/not automatic cross-origin reconnection/);
  assert.match(source,/if\(expectReload&&lastState\)assert\.notEqual\(state\.timeOrigin,lastState\.timeOrigin/);
  assert.match(source,/sceneContent\(disk\.state\.preferences\.worldV2\.scenes/);
  assert.match(source,/closeOwnedBrowser/);
});
