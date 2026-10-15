import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { validateSceneLifecycleOptions, lifecyclePersistentContent, assertLifecycleResetContent,
  createLifecycleMapFixtures, lifecycleFixtureDirectory, clickDesktopConfirmation, desktopButtonPoint, assertLifecycleVersionPhysics } from '../scripts/desktop-scene-lifecycle-audit.mjs';
import { createDefaultSceneSettings } from '../src/world/scene-defaults.js';
import { normalizeFogState } from '../src/vision/fog.js';
import { buildMapArchive, inspectMapArchive, mapFileHash } from '../src/packages/map-archive.js';
import { createMinimalReferencePackage } from '../maps/minimal/package.js';
import { inspectContentPackage } from '../deployment/local-server/package-inspection.mjs';
import { normalizeStatusDefinition } from '../src/status/model.js';

const driver = await readFile(new URL('../scripts/desktop-browser-smoke.mjs',import.meta.url),'utf8');
const helper = await readFile(new URL('../scripts/desktop-scene-lifecycle-audit.mjs',import.meta.url),'utf8');
const options = {enabled:true,sceneAudit:true,reuseData:false,installer:null,legacyDirectory:null,prepareUpgradeFixture:false};

test('supplemental fixture receipts stay isolated across source commits and input archives', () => {
  const reference = { sourceCommit: 'a'.repeat(40), sourceArchiveSha256: 'b'.repeat(64) };
  const first = lifecycleFixtureDirectory('evidence', reference);
  assert.equal(lifecycleFixtureDirectory('evidence', reference), first);
  assert.notEqual(lifecycleFixtureDirectory('evidence', { ...reference, sourceCommit: 'c'.repeat(40) }), first);
  assert.notEqual(lifecycleFixtureDirectory('evidence', { ...reference, sourceArchiveSha256: 'd'.repeat(64) }), first);
  assert.throws(() => lifecycleFixtureDirectory('evidence', { ...reference, sourceCommit: '../outside' }));
});

test('Lifecycle extension is explicit and cannot operate on reused, historical or upgrade data',()=>{
  assert.doesNotThrow(()=>validateSceneLifecycleOptions(options));
  assert.doesNotThrow(()=>validateSceneLifecycleOptions({enabled:false,sceneAudit:false}));
  for(const change of [{sceneAudit:false},{reuseData:true},{installer:'setup.exe'},{legacyDirectory:'real-save'},{prepareUpgradeFixture:true}]) {
    assert.throws(()=>validateSceneLifecycleOptions({...options,...change}),/requires --scene-audit in a new disposable World/);
  }
  assert.match(driver,/const sceneLifecycleAudit = argumentsByName\.has\('--scene-lifecycle-audit'\)/);
  assert.match(driver,/await verifyRestartedScenes\(worldId, sceneAuditResult\);\s*if \(sceneLifecycleAudit\)/);
  assert.match(driver,/sceneLifecycleAudit \? lifecycleResult\.expectedMapCount : reuseData \? initial\.maps\.length : sceneAudit \? 2/);
  assert.match(driver,/const lifecycleDriverSha256 = sceneLifecycleAudit \?/);
  for(const outcome of ['passed','failed']) {
    const record=driver.split('\n').find(line=>line.includes('writeFile(recordFile,')&&line.includes(`outcome: '${outcome}'`));
    assert.ok(record.includes('lifecycleDriverSha256,'));
  }
});

function state(){
  return {preferences:{worldV2:{schemaVersion:4,id:'world',name:'Game',updatedAt:'before',ruleset:{id:'rule',version:'1'},activeSceneId:'a',
    actors:[{id:'actor',privateState:{hp:7}}],journals:[{id:'journal',content:'keep'}],scenes:[{
      id:'a',name:'A',mapPackage:{id:'map',version:'1.2.0'},tokens:[{id:'token',actorId:'actor',actorLink:false,actorDelta:{hp:3},x:10,y:20}],
      markers:[{id:'marker',kind:'note'}],attackAreas:[{id:'area',anchor:{type:'token',tokenId:'token'}}],
      sceneEvents:[{id:'damage'}],featureStates:{door:{open:true}},occlusionShapes:[{id:'wall'}],
      fog:normalizeFogState({exploredByParty:{party:{rows:{1:[[0,3]]}}}}),
      settings:{...createDefaultSceneSettings(),gridVisible:false,lineOfSightEnabled:true,movementBudgetMetersPerTurn:10},
    },{id:'b',name:'B',mapPackage:{id:'map',version:'1.2.0'},tokens:[],fog:normalizeFogState()}]},
    chatSystem:{schemaVersion:1,messages:[{id:'chat',text:'keep'}]},combatSystem:{schemaVersion:2,combat:{id:'combat',combatants:[{tokenId:'token'}]}}}};
}
function reset(value,clear){
  const result=structuredClone(value),scene=result.preferences.worldV2.scenes[0];
  result.preferences.worldV2.updatedAt='later';scene.sceneEvents=[];scene.featureStates={};scene.occlusionShapes=[];scene.fog=normalizeFogState();
  if(clear){scene.tokens=[];scene.markers=[];scene.attackAreas=[];scene.settings=createDefaultSceneSettings();result.preferences.combatSystem.combat=null;}
  return result;
}

test('Lifecycle reset checks distinguish retained instances and a full Scene clear without losing other World content',()=>{
  const before=state();
  assert.doesNotThrow(()=>assertLifecycleResetContent(before,reset(before,false),'scene.environment.reset'));
  assert.doesNotThrow(()=>assertLifecycleResetContent(before,reset(before,true),'scene.clear'));
  for(const mutate of [
    value=>{value.preferences.worldV2.scenes[0].tokens[0].actorDelta.hp=9;},
    value=>{value.preferences.worldV2.scenes[0].markers=[];},
    value=>{value.preferences.worldV2.scenes[0].mapPackage.version='1.3.0';},
    value=>{value.preferences.worldV2.scenes[1].name='changed';},
    value=>{value.preferences.worldV2.actors[0].privateState.hp=9;},
    value=>{value.preferences.worldV2.journals=[];},
    value=>{value.preferences.chatSystem.messages=[];},
    value=>{value.preferences.combatSystem.combat=null;},
  ]){
    const changed=reset(before,false);mutate(changed);
    assert.throws(()=>assertLifecycleResetContent(before,changed,'scene.environment.reset'));
  }
  const uncleared=reset(before,true);uncleared.preferences.worldV2.scenes[0].fog=before.preferences.worldV2.scenes[0].fog;
  assert.throws(()=>assertLifecycleResetContent(before,uncleared,'scene.clear'));
});

test('Full recovery comparison includes every Scene, Actor, Journal, chat and combat while ignoring only the World timestamp',()=>{
  const before=state(),timestamp=structuredClone(before);timestamp.preferences.worldV2.updatedAt='new time';
  assert.deepEqual(lifecyclePersistentContent(before),lifecyclePersistentContent(timestamp));
  const changed=structuredClone(before);changed.preferences.worldV2.scenes[1].fog.exploredByParty.other={rows:{9:[[1,2]]}};
  assert.notDeepEqual(lifecyclePersistentContent(before),lifecyclePersistentContent(changed));
  const detached=lifecyclePersistentContent(before);detached.world.actors[0].privateState.hp=99;
  assert.equal(before.preferences.worldV2.actors[0].privateState.hp,7);
  assert.match(helper,/assert\.deepEqual\(lifecyclePersistentContent\(final\.state\), beforeUninstallRestart/);
});

test('Lifecycle comparison equates only omitted status-definition defaultDuration with the contractual null duration',()=>{
  const definition={id:'status-native-audit',name:'验收状态',scopes:['actor'],description:'preserve all fields',customMetadata:{version:1}};
  const normalizedMissing=normalizeStatusDefinition(definition);
  const normalizedNull=normalizeStatusDefinition({...definition,defaultDuration:null});
  assert.equal(normalizedMissing.defaultDuration,null);
  assert.deepEqual(normalizedMissing,normalizedNull,'The official status contract gives omitted and null duration the same meaning');
  const duration={unit:'turns',value:3};
  assert.deepEqual(normalizeStatusDefinition({...definition,defaultDuration:duration}).defaultDuration,duration);
  const omitted=state();omitted.preferences.worldV2.statusDefinitions=[structuredClone(definition)];
  const explicit=structuredClone(omitted);explicit.preferences.worldV2.statusDefinitions[0].defaultDuration=null;
  const untouched=structuredClone(omitted);
  assert.deepEqual(lifecyclePersistentContent(omitted),lifecyclePersistentContent(explicit));
  assert.deepEqual(omitted,untouched,'Comparison canonicalization must not mutate source state');
  assert.equal(Object.hasOwn(omitted.preferences.worldV2.statusDefinitions[0],'defaultDuration'),false);
  for(const value of [duration,{unit:'turns',value:4},{unit:'rounds',value:3},0,'',{},undefined]){
    const changed=structuredClone(explicit);changed.preferences.worldV2.statusDefinitions[0].defaultDuration=value;
    assert.notDeepEqual(lifecyclePersistentContent(changed),lifecyclePersistentContent(explicit),'Numeric, structured or invalid explicit durations must remain distinguishable');
  }
  for(const mutate of [
    value=>{value.preferences.worldV2.statusDefinitions[0].description='changed';},
    value=>{value.preferences.worldV2.statusDefinitions[0].customMetadata.version=2;},
    value=>{value.preferences.worldV2.statusDefinitions[0].optionalOtherField=null;},
    value=>{value.preferences.worldV2.actors[0].defaultDuration=null;},
    value=>{value.preferences.worldV2.scenes[0].defaultDuration=null;},
    value=>{value.preferences.chatSystem.defaultDuration=null;},
    value=>{value.preferences.combatSystem.defaultDuration=null;},
  ]){
    const changed=structuredClone(explicit);mutate(changed);
    assert.notDeepEqual(lifecyclePersistentContent(changed),lifecyclePersistentContent(explicit),'Every field outside this single optional status-definition duration must stay strict');
  }
});

test('Supplemental same-ID map fixtures retain the original archive and record distinct content, exact versions and frozen source provenance',()=>{
  const bytes=buildMapArchive({data:createMinimalReferencePackage()}),original=Buffer.from(bytes),base=inspectMapArchive(bytes);
  const fixtures=createLifecycleMapFixtures(base,{sourceCommit:'a'.repeat(40),sourceArchiveSha256:mapFileHash(bytes)});
  assert.deepEqual(bytes,original);assert.equal(base.data.version,'1.2.0');
  assert.equal(base.data.features.find(feature=>feature.id==='demo-door').interaction.initialState.open,false);
  assert.deepEqual(fixtures.map(fixture=>fixture.receipt.version),['1.3.0','1.4.0']);
  assert.equal(new Set(fixtures.map(fixture=>fixture.receipt.id)).size,1);
  assert.notEqual(fixtures[0].receipt.fingerprint,fixtures[1].receipt.fingerprint);
  assert.notEqual(fixtures[0].receipt.sha256,fixtures[1].receipt.sha256);
  for(const fixture of fixtures){
    const inspected=inspectMapArchive(fixture.bytes);
    const managementInspection=inspectContentPackage('map',fixture.bytes);
    assert.equal(managementInspection.id,fixture.receipt.id);
    assert.equal(managementInspection.version,fixture.receipt.version);
    assert.equal(managementInspection.fingerprint,fixture.receipt.fingerprint);
    assert.equal(managementInspection.kind,'map');
    assert.equal(inspected.manifest.sourceCommit,'a'.repeat(40));
    assert.equal(inspected.manifest.sourceArchiveSha256,mapFileHash(bytes));
    assert.deepEqual(inspected.data.features.map(feature=>feature.id),base.data.features.map(feature=>feature.id));
    assert.equal(fixture.receipt.sha256,mapFileHash(fixture.bytes));
    assert.equal(inspected.data.features.find(feature=>feature.id==='demo-door').interaction.initialState.open,fixture.receipt.version==='1.3.0');
  }
});

test('Closed-version physics requires the actual path_blocked refusal and rejects unrelated failures',()=>{
  const closed={startPlacement:{valid:true},targetPlacement:{valid:false},accepted:false,denial:{code:'path_blocked',message:'collision'},position:{x:500,y:500}};
  assert.doesNotThrow(()=>assertLifecycleVersionPhysics(closed,false));
  const open={startPlacement:{valid:true},targetPlacement:{valid:true},accepted:true,denial:null,position:{x:500,y:465}};
  assert.doesNotThrow(()=>assertLifecycleVersionPhysics(open,true));
  for(const code of ['permission_denied','revision_conflict','invalid_operation','world_operation_denied','operation_cancelled',null]){
    assert.throws(()=>assertLifecycleVersionPhysics({...closed,denial:{code,message:'some other refusal'}},false),/closed doorway must be refused for physical collision/);
  }
  assert.throws(()=>assertLifecycleVersionPhysics({...closed,startPlacement:{valid:false}},false),/physically valid location/);
  assert.throws(()=>assertLifecycleVersionPhysics({...closed,position:{x:500,y:465}},false));
  assert.throws(()=>assertLifecycleVersionPhysics({...open,denial:{code:'path_blocked'}},true),/cannot contain a server refusal/);
});

function confirmationFixture(message){
  const listeners=new Set(),calls=[];
  const socket={addEventListener(_type,listener){listeners.add(listener);},removeEventListener(_type,listener){listeners.delete(listener);}};
  return {calls,listeners,context:{getSocket:()=>socket,evaluate:async()=>({x:10,y:20,width:30,height:15,disabled:false,inViewport:true,hitButton:true}),
    async call(method,parameters){
      calls.push({method,parameters});
      if(method==='Input.dispatchMouseEvent'&&parameters.type==='mouseReleased')for(const listener of [...listeners])listener({data:JSON.stringify({method:'Page.javascriptDialogOpening',params:{type:'confirm',message}})});
    }}};
}

test('Lifecycle UI driver clicks the real button and accepts or cancels the actual scope confirmation',async()=>{
  for(const accept of [true,false]){
    const fixture=confirmationFixture('恢复地图环境：保留 Token，执行前保存恢复点');
    const result=await clickDesktopConfirmation(fixture.context,()=>null,['恢复地图环境','恢复点'],{accept});
    assert.equal(result.accepted,accept);assert.equal(fixture.listeners.size,0);
    assert.deepEqual(fixture.calls.filter(call=>call.method==='Input.dispatchMouseEvent').map(call=>call.parameters.type),['mousePressed','mouseReleased']);
    assert.equal(fixture.calls.find(call=>call.method==='Page.handleJavaScriptDialog').parameters.accept,accept);
  }
  const mismatched=confirmationFixture('wrong scope');
  await assert.rejects(clickDesktopConfirmation(mismatched.context,()=>null,['恢复地图环境']),/Confirmation must describe/);
  assert.equal(mismatched.calls.find(call=>call.method==='Page.handleJavaScriptDialog').parameters.accept,false);
  assert.equal(mismatched.listeners.size,0);
});

test('Lifecycle button targeting scrolls before measuring, waits for layout and verifies the exact hit target',async()=>{
  const events=[],child={},button={tagName:'BUTTON',disabled:false,
    scrollIntoView(options){events.push('scroll');assert.equal(options.block,'center');assert.equal(options.behavior,'instant');},
    getBoundingClientRect(){assert.deepEqual(events,['scroll','frame','frame']);events.push('rect');return{x:120,y:700,width:60,height:24};},
    contains(node){return node===child;}};
  const point=await runInNewContext(`(${desktopButtonPoint.toString()})(button)`,{button,innerWidth:1440,innerHeight:900,
    requestAnimationFrame(callback){events.push('frame');callback();},document:{elementFromPoint(x,y){events.push('hit');assert.equal(x,150);assert.equal(y,712);return child;}}});
  assert.deepEqual(events,['scroll','frame','frame','rect','hit']);
  assert.equal(point.inViewport,true);assert.equal(point.hitButton,true);
  const blocked=confirmationFixture('恢复地图环境');blocked.context.evaluate=async()=>({...point,hitButton:false});
  await assert.rejects(clickDesktopConfirmation(blocked.context,()=>null,['恢复地图环境']),/must hit the requested button/);
  assert.equal(blocked.calls.some(call=>call.method==='Input.dispatchMouseEvent'),false);
  const outside=confirmationFixture('恢复地图环境');outside.context.evaluate=async()=>({...point,inViewport:false});
  await assert.rejects(clickDesktopConfirmation(outside.context,()=>null,['恢复地图环境']),/inside the actual viewport/);
  assert.equal(outside.calls.some(call=>call.method==='Input.dispatchMouseEvent'),false);
  assert.doesNotMatch(desktopButtonPoint.toString(),/\.click\(|dispatchEvent/);
});

test('Lifecycle native audit keeps production reset, restore, inspection and uninstall boundaries',()=>{
  assert.doesNotMatch(helper,/scene\.fog\.explore|window\.confirm\s*=|\.world\.commit\(|writeFile\([^\n]*world\.json/);
  assert.match(helper,/Page\.javascriptDialogOpening/);
  assert.match(helper,/Page\.handleJavaScriptDialog/);
  assert.match(helper,/reason === 'scene\.environment\.reset'/);
  assert.match(helper,/reason === 'authoritative-scene-reset'/);
  assert.match(helper,/recoveryEnvelope\.record\.access/);
  assert.match(helper,/before-restore/);
  assert.match(helper,/\/api\/manage\/maps\/inspect/);
  assert.match(helper,/type:'token\.movePath'/);
  assert.match(helper,/result\.accepted, shouldPass/);
  assert.match(helper,/map_package_in_use/);
  assert.match(helper,/scope: 'complete World and access'/);
});
