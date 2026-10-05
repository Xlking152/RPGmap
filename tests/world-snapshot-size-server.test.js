import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createDefaultActor } from '../src/actor/index.js';
import { infiniteHorrorRuleset } from '../src/rulesets/infinite-horror/index.js';
import { migrateTestStateToWorldV3 } from './helpers/world-v3.js';
import { GM_SECRET, startBenchmarkServer, stopBenchmarkServer, connectBenchmarkClient, waitForMessage }
  from '../scripts/lan-benchmark-support.mjs';
import { createWorldWal } from '../deployment/local-server/world-wal.mjs';
import { applyWorldOperationPatch } from '../src/world/operations.js';

test('oversized valid operation is denied before WAL and keeps accepted private jobs and the retry key', async () => {
  const runtime = await startBenchmarkServer(process.cwd(),{env:{RPGMAP_TEST_PAUSE_EXPLORATION:'1'}});
  try {
    const health = await (await fetch(`${runtime.httpUrl}/api/health`)).json();
    const schemas = {operationSchema:health.operationSchema,statusSchema:health.statusSchema,accessSchema:health.accessSchema};
    const gm = await connectBenchmarkClient(runtime,schemas,{name:'Snapshot budget GM',requestedRole:'gm',gmSecret:GM_SECRET});
    const actor = createDefaultActor({id:'actor-a',name:'Scout',type:'pc',partyId:'party-a',ruleset:infiniteHorrorRuleset});
    const state = migrateTestStateToWorldV3({preferences:{worldV2:{schemaVersion:2,id:'snapshot-budget',name:'Budget',
      ruleset:{id:'infinite-horror',version:'1.1.0'},activeSceneId:'scene-test',actors:[actor],statusDefinitions:[],scenes:[{
        id:'scene-test',mapPackage:{id:'test-map',version:'1',width:1000,height:1000,metersPerUnit:1},
        tokens:[{id:'token-a',actorId:'actor-a',actorLink:true,actorDelta:null,placement:'map',x:10,y:10,
          featureId:null,diameterMeters:1,rotation:0,elevationMeters:0,effects:[],hidden:false,locked:false,showName:true,
          vision:{enabled:true,preciseRangeOverrideMeters:120,vagueRangeOverrideMeters:120}}],
        markers:[],attackAreas:[],sceneEvents:[],settings:{gridVisible:true},
      }]}}});
    const initialized = waitForMessage(gm.socket,value=>value.type==='world.snapshot'&&value.revision===1);
    gm.socket.send({type:'world.push',baseRevision:0,state,reason:'init'}); await initialized;
    const sourceAck = waitForMessage(gm.socket,value=>value.type==='vision.source.ack');
    gm.socket.send({type:'vision.source.set',tokenId:'token-a'});
    assert.equal((await sourceAck).revision,2);
    const walPath=path.join(runtime.mapDir,'world.operations.ndjson');
    const beforeWal=await readFile(walPath);
    const baseSnapshot=JSON.parse(await readFile(path.join(runtime.mapDir,'world.json'),'utf8'));
    const replay=()=>createWorldWal({filePath:walPath,applyPatch:(value,patch)=>applyWorldOperationPatch(value,patch,{project:false})})
      .replay(baseSnapshot,{repairTail:false});
    const before=await replay();
    assert.equal(Object.keys(before.exploration.jobs).length,1);
    const operations=Array.from({length:64},(_,index)=>({type:'actor.upsert',payload:{actor:{
      ...createDefaultActor({id:`large-${index}`,name:`Large ${index}`,ruleset:infiniteHorrorRuleset}),notes:'x'.repeat(65536),
    }}}));
    const message={type:'world.operation',operationId:'budget-retry',baseRevision:2,operations};
    assert.ok(Buffer.byteLength(JSON.stringify(message))<8*1024*1024,'request itself must be valid-sized');
    const denied=waitForMessage(gm.socket,value=>value.type==='world.operation.denied'&&value.operationId===message.operationId);
    gm.socket.send(message);
    assert.equal((await denied).code,'state_too_large');
    assert.deepEqual(await readFile(walPath),beforeWal,'denial must not append even a partial WAL record');
    const after=await replay();
    assert.deepEqual(after.state,before.state);
    assert.deepEqual(after.exploration,before.exploration);
    assert.equal((await fetch(`${runtime.httpUrl}/api/health`)).status,200,'deterministic budget rejection must not block writes');
    const retried=waitForMessage(gm.socket,value=>value.type==='world.operation.ack'&&value.operationId===message.operationId);
    gm.socket.send({...message,operations:[{type:'chat.append',payload:{text:'small retry'}}]});
    const ack=await retried;
    assert.equal(ack.duplicate,false);
    assert.equal(ack.revision,3);
    assert.deepEqual((await replay()).exploration,before.exploration);
    const exited=new Promise(resolve=>runtime.child.once('exit',resolve));
    runtime.child.send('rpgmap.shutdown'); await exited;
    const persisted=JSON.parse(await readFile(path.join(runtime.mapDir,'world.json'),'utf8'));
    const recovered=await createWorldWal({filePath:walPath,
      applyPatch:(value,patch)=>applyWorldOperationPatch(value,patch,{project:false})}).replay(persisted,{repairTail:false});
    assert.equal(recovered.revision,3);
    assert.deepEqual(recovered.exploration,before.exploration);
  } finally {await stopBenchmarkServer(runtime);}
});
