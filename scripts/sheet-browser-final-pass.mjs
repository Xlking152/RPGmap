import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

if (process.platform !== 'win32') throw new Error('Final sheet browser smoke requires Windows');
const browserName = String(process.env.RPGMAP_SMOKE_BROWSER || 'edge').toLowerCase();
if (!['edge', 'chrome'].includes(browserName)) throw new Error(`Unsupported smoke browser: ${browserName}`);
const targetUrl = String(process.argv[2] || '').trim();
if (!/^http:\/\/127\.0\.0\.1:\d+\/?/.test(targetUrl)) throw new Error('Final sheet smoke requires a loopback HTTP URL');
const timeoutMs = Math.max(20_000, Number(process.argv[3]) || 45_000);

function edgePath() {
  const roots = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean);
  const suffixes = browserName === 'chrome'
    ? [['Google','Chrome','Application','chrome.exe'], ['Google','Chrome Beta','Application','chrome.exe']]
    : [['Microsoft','Edge','Application','msedge.exe'], ['Microsoft','Edge SxS','Application','msedge.exe']];
  for (const root of roots) for (const suffix of suffixes) {
    const candidate = path.join(root, ...suffix); if (existsSync(candidate)) return candidate;
  }
  throw new Error(`${browserName === 'chrome' ? 'Google Chrome' : 'Microsoft Edge'} executable was not found`);
}
async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve,reject)=>server.listen(0,'127.0.0.1',resolve).once('error',reject));
  const port=server.address().port; await new Promise(resolve=>server.close(resolve)); return port;
}
async function retry(task,label,deadline) {
  let lastError=null;
  while(Date.now()<deadline){try{const value=await task();if(value)return value;}catch(error){lastError=error;}await new Promise(r=>setTimeout(r,150));}
  throw new Error(`${label} timed out${lastError?`: ${lastError.message}`:''}`);
}

const port=await reservePort();
const profile=await mkdtemp(path.join(os.tmpdir(),`rpgmap-${browserName}-sheet-final-pass-`));
const edge=spawn(edgePath(),['--headless=new','--disable-gpu','--disable-dev-shm-usage','--no-sandbox','--no-first-run','--no-default-browser-check','--window-size=1440,1000',`--remote-debugging-port=${port}`,`--user-data-dir=${profile}`,targetUrl],{stdio:['ignore','ignore','pipe'],windowsHide:true});
let edgeError='',browserClosed=false;edge.stderr.setEncoding('utf8');edge.stderr.on('data',chunk=>{edgeError+=chunk;});

try {
  const deadline=Date.now()+timeoutMs;
  const page=await retry(async()=>{const response=await fetch(`http://127.0.0.1:${port}/json/list`);const pages=await response.json();return pages.find(item=>item.type==='page'&&item.webSocketDebuggerUrl);},'Edge CDP endpoint',deadline);
  const socket=new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Edge CDP WebSocket open timed out')),5000);socket.addEventListener('open',()=>{clearTimeout(timer);resolve();},{once:true});socket.addEventListener('error',()=>{clearTimeout(timer);reject(new Error('Edge CDP WebSocket failed'));},{once:true});});
  let nextId=1;const pending=new Map(),failures=[],exceptions=[];
  const rejectPending=message=>{for(const item of pending.values()){clearTimeout(item.timer);item.reject(new Error(message));}pending.clear();};
  socket.addEventListener('close',()=>rejectPending('Edge CDP WebSocket closed'));socket.addEventListener('error',()=>rejectPending('Edge CDP WebSocket failed'));
  socket.addEventListener('message',event=>{const message=JSON.parse(String(event.data));if(message.id&&pending.has(message.id)){const item=pending.get(message.id);pending.delete(message.id);clearTimeout(item.timer);return message.error?item.reject(new Error(message.error.message)):item.resolve(message.result);}if(message.method==='Network.loadingFailed'&&message.params?.errorText!=='net::ERR_ABORTED')failures.push(message.params?.errorText||'request failed');if(message.method==='Network.responseReceived'&&Number(message.params?.response?.status)>=400)failures.push(`${message.params.response.status} ${message.params.response.url}`);if(message.method==='Runtime.exceptionThrown')exceptions.push(message.params?.exceptionDetails?.exception?.description||message.params?.exceptionDetails?.text||'runtime exception');if(message.method==='Runtime.consoleAPICalled'&&message.params?.type==='error')exceptions.push((message.params.args||[]).map(arg=>arg.value??arg.description??'').filter(Boolean).join(' ')||'browser console error');});
  const send=(method,params={})=>new Promise((resolve,reject)=>{const id=nextId++;const timer=setTimeout(()=>{pending.delete(id);reject(new Error(`Edge CDP command timed out: ${method}`));},7500);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));});
  const evaluate=async expression=>{const result=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(result.exceptionDetails)throw new Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text||'evaluation failed');return result.result?.value;};
  await Promise.all([send('Runtime.enable'),send('Network.enable'),send('Log.enable')]);

  const ready=await retry(()=>evaluate(`(()=>{const api=document.querySelector('#app')?.rpgMapApp,mp=api?.multiplayer?.getStatus?.(),status=document.querySelector('[data-role="map-status"]')?.textContent||'';return api?.world?.performOperations&&api?.entities?.openActor&&api?.entities?.openToken&&mp?.connected===true&&mp?.session?.role==='gm'&&mp?.permissions?.worldWrite===true&&/^联机同步完成/.test(status)?{revision:mp.revision,status}:null;})()`),'authoritative GM runtime after initial sync',deadline);
  const ids={pcActor:'smoke-final-pc',pcToken:'smoke-final-pc-token',npcActor:'smoke-final-npc',npcToken:'smoke-final-npc-token'};
  const snapshot=label=>evaluate(`(()=>{const api=document.querySelector('#app')?.rpgMapApp;return{label:${JSON.stringify(label)},revision:api?.multiplayer?.getStatus?.()?.revision||null,records:api?.entities?.listOpenSheets?.()||[],sheets:[...document.querySelectorAll('.entity-sheet')].map(s=>({key:s.dataset.sheetWindowKey,actorId:s.dataset.actorId,tokenId:s.dataset.tokenId,mode:s.dataset.sheetMode,kind:s.dataset.sheetKind,interaction:s.dataset.sheetInteractionMode,tab:s.querySelector('.entity-sheet-tab.active')?.dataset.sheetTab,width:s.getBoundingClientRect().width,height:s.getBoundingClientRect().height})),mapStatus:document.querySelector('[data-role="map-status"]')?.textContent||''};})()`);
  const retrySnapshot=async(task,label)=>{try{return await retry(task,label,deadline);}catch(error){throw new Error(`${error.message}; snapshot=${JSON.stringify(await snapshot(label))}; browserErrors=${JSON.stringify(exceptions)}`);}};

  const fixture=await evaluate(`(async()=>{const api=document.querySelector('#app').rpgMapApp,existing=new Set((api.world.get().actors||[]).map(a=>String(a.id)));const resets=['${ids.pcActor}','${ids.npcActor}'].filter(id=>existing.has(id)).map(actorId=>({type:'actor.delete',payload:{actorId}}));if(resets.length)await api.world.performOperations(resets,{source:'smoke:final:reset'});const imported=name=>({formName:'Smoke Form',identity:{name},description:{},resources:{hp:{max:20}},attributes:[],checks:{skills:[],saves:[]},badStatuses:[],combat:{attacks:[],defenses:[]},detection:{},tokenAppearance:{color:'#557f83',scale:1},source:{type:'manual'}});const pc0=api.ruleset.actor.createFromImport(imported('Smoke PC'),{actorId:'${ids.pcActor}',name:'Smoke PC'}),npc0=api.ruleset.actor.createFromImport(imported('Smoke NPC'),{actorId:'${ids.npcActor}',name:'Smoke NPC'}),pc={...pc0,id:'${ids.pcActor}',name:'Smoke PC',type:'pc',partyId:null,effects:[]},npc={...npc0,id:'${ids.npcActor}',name:'Smoke NPC',type:'npc',partyId:null,effects:[]},sceneId=api.world.get().activeSceneId;await api.world.performOperations([{type:'actor.upsert',payload:{actor:pc}},{type:'actor.upsert',payload:{actor:npc}},{type:'token.create',payload:{sceneId,token:{id:'${ids.pcToken}',actorId:'${ids.pcActor}',actorLink:true,placement:'map',x:120,y:80,diameterMeters:1,visibility:{mode:'public',userIds:[]},effects:[]}}},{type:'token.create',payload:{sceneId,token:{id:'${ids.npcToken}',actorId:'${ids.npcActor}',actorLink:false,placement:'map',x:140,y:80,diameterMeters:1,visibility:{mode:'public',userIds:[]},effects:[]}}}],{source:'smoke:final:setup'});const pcToken=api.tokens.get('${ids.pcToken}'),npcToken=api.tokens.get('${ids.npcToken}'),present=Boolean(pcToken&&npcToken);if(present){await api.entities.openToken('${ids.pcToken}');await api.entities.openToken('${ids.npcToken}');await api.entities.openActor('${ids.pcActor}');await api.entities.openActor('${ids.npcActor}');}return{present,sceneId,pcActorLink:pcToken?.actorLink,npcActorLink:npcToken?.actorLink,revision:api.multiplayer.getStatus().revision};})()`);
  if(!fixture?.present||fixture.pcActorLink!==true||fixture.npcActorLink!==false)throw new Error(`Linked/Unlinked fixture invalid: ${JSON.stringify(fixture)}`);

  const cards=await retrySnapshot(()=>evaluate(`(()=>{const token=id=>document.querySelector('.entity-sheet[data-token-id="'+id+'"]'),actor=id=>[...document.querySelectorAll('.entity-sheet[data-actor-id="'+id+'"]')].find(s=>!String(s.dataset.tokenId||'')),info=s=>s?{kind:s.dataset.sheetKind,mode:s.dataset.sheetMode,interaction:s.dataset.sheetInteractionMode,tab:s.querySelector('.entity-sheet-tab.active')?.dataset.sheetTab,key:s.dataset.sheetWindowKey,toggle:Boolean(s.querySelector('[data-sheet-mode-toggle]'))}:null,r={pcToken:info(token('${ids.pcToken}')),npcToken:info(token('${ids.npcToken}')),pcActor:info(actor('${ids.pcActor}')),npcActor:info(actor('${ids.npcActor}'))};if(Object.values(r).some(v=>!v)||new Set(Object.values(r).map(v=>v.key)).size!==4)return null;if(r.pcToken.kind!=='character'||r.pcToken.tab!=='overview')return null;if(r.npcToken.kind!=='npc'||r.npcToken.mode!=='instance'||r.npcToken.tab!=='overview')return null;if(r.pcActor.kind!=='character'||r.pcActor.interaction!=='play'||!r.pcActor.toggle)return null;if(r.npcActor.kind!=='npc'||r.npcActor.interaction!=='play'||!r.npcActor.toggle)return null;return r;})()`),'Character/NPC live cards');

  const healthBefore=await retrySnapshot(()=>evaluate(`(()=>{const api=document.querySelector('#app').rpgMapApp,t=api.health?.resolveToken?.('${ids.pcToken}'),a=api.health?.resolveActor?.('${ids.pcActor}'),input=document.querySelector('.entity-sheet[data-token-id="${ids.pcToken}"] [data-health-field-id]:not([disabled])');return t&&a&&input&&JSON.stringify(t)===JSON.stringify(a)?{health:t,fieldId:input.dataset.healthFieldId}:null;})()`),'Linked PC Health shared before edit');
  const healthChange=await evaluate(`(()=>{const input=document.querySelector('.entity-sheet[data-token-id="${ids.pcToken}"] [data-health-field-id="${healthBefore.fieldId}"]:not([disabled])'),current=Number(input.value),min=input.min===''?0:Number(input.min),next=current>min?current-1:current+1;input.value=String(next);input.dispatchEvent(new Event('change',{bubbles:true}));return{current,next};})()`);
  await retrySnapshot(()=>evaluate(`(()=>{const api=document.querySelector('#app').rpgMapApp,t=api.health.resolveToken('${ids.pcToken}'),a=api.health.resolveActor('${ids.pcActor}');return JSON.stringify(t)!==${JSON.stringify(JSON.stringify(healthBefore.health))}&&JSON.stringify(t)===JSON.stringify(a)?true:null;})()`),'Linked PC Health shared after edit');

  const resizeBefore=await evaluate(`(()=>{const pc=[...document.querySelectorAll('.entity-sheet[data-actor-id="${ids.pcActor}"]')].find(s=>!String(s.dataset.tokenId||'')),npc=[...document.querySelectorAll('.entity-sheet[data-actor-id="${ids.npcActor}"]')].find(s=>!String(s.dataset.tokenId||'')),a=pc.getBoundingClientRect(),b=npc.getBoundingClientRect();return{pc:{width:a.width,height:a.height},npc:{width:b.width,height:b.height}};})()`);
  const resizeApplied=await evaluate(`(()=>{const sheet=[...document.querySelectorAll('.entity-sheet[data-actor-id="${ids.pcActor}"]')].find(s=>!String(s.dataset.tokenId||'')),before=sheet.getBoundingClientRect(),targetWidth=Math.round(before.width+92),targetHeight=Math.max(320,Math.round(before.height-120));sheet.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,clientX:before.right-2,clientY:before.bottom-2}));sheet.style.width=targetWidth+'px';sheet.style.height=targetHeight+'px';const applied=sheet.getBoundingClientRect();sheet.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,button:0,clientX:applied.right-2,clientY:applied.bottom-2}));return{requested:{width:targetWidth,height:targetHeight},actual:{width:applied.width,height:applied.height}};})()`);
  if(Math.abs(resizeApplied.actual.width-resizeBefore.pc.width)<40&&Math.abs(resizeApplied.actual.height-resizeBefore.pc.height)<40)throw new Error(`Browser did not apply a meaningful resize: ${JSON.stringify({resizeBefore,resizeApplied})}`);
  const resizeCaptured=await retrySnapshot(()=>evaluate(`(()=>{const api=document.querySelector('#app').rpgMapApp,record=(api.entities.listOpenSheets?.()||[]).find(r=>r.key==='actor:${ids.pcActor}'),npc=(api.entities.listOpenSheets?.()||[]).find(r=>r.key==='actor:${ids.npcActor}');if(!record||Math.abs(Number(record.width)-${resizeApplied.actual.width})>2||Math.abs(Number(record.height)-${resizeApplied.actual.height})>2)return null;return{width:record.width,height:record.height,npcWidth:npc?.width??null,npcHeight:npc?.height??null};})()`),'actual resize geometry captured by SheetManager');
  await evaluate(`(()=>{const s=[...document.querySelectorAll('.entity-sheet[data-actor-id="${ids.pcActor}"]')].find(n=>!String(n.dataset.tokenId||''));s.querySelector('[data-sheet-tab="status"]').click();return true;})()`);
  const resizeRerender=await retrySnapshot(()=>evaluate(`(()=>{const s=[...document.querySelectorAll('.entity-sheet[data-actor-id="${ids.pcActor}"]')].find(n=>!String(n.dataset.tokenId||'')),r=s?.getBoundingClientRect();return r&&Math.abs(r.width-${resizeApplied.actual.width})<=2&&Math.abs(r.height-${resizeApplied.actual.height})<=2?{width:r.width,height:r.height,tab:s.querySelector('.entity-sheet-tab.active')?.dataset.sheetTab}:null;})()`),'resize survives tab rerender');
  await evaluate(`(()=>{const s=[...document.querySelectorAll('.entity-sheet[data-actor-id="${ids.pcActor}"]')].find(n=>!String(n.dataset.tokenId||''));s.querySelector('[data-sheet-action="close"]').click();return true;})()`);
  await retrySnapshot(()=>evaluate(`!([...document.querySelectorAll('.entity-sheet[data-actor-id="${ids.pcActor}"]')].find(n=>!String(n.dataset.tokenId||'')))`),'Character Actor close');
  await evaluate(`document.querySelector('#app').rpgMapApp.entities.openActor('${ids.pcActor}')`);
  const resizeReopen=await retrySnapshot(()=>evaluate(`(()=>{const s=[...document.querySelectorAll('.entity-sheet[data-actor-id="${ids.pcActor}"]')].find(n=>!String(n.dataset.tokenId||'')),r=s?.getBoundingClientRect();return r&&Math.abs(r.width-${resizeApplied.actual.width})<=2&&Math.abs(r.height-${resizeApplied.actual.height})<=2?{width:r.width,height:r.height,tab:s.querySelector('.entity-sheet-tab.active')?.dataset.sheetTab}:null;})()`),'resize survives close and reopen');

  await retrySnapshot(()=>evaluate(`(()=>{const s=[...document.querySelectorAll('.entity-sheet[data-actor-id="${ids.pcActor}"]')].find(n=>!String(n.dataset.tokenId||''));return s?.dataset.sheetInteractionMode==='play'&&s.querySelector('[data-sheet-mode-toggle]')?true:null;})()`),'Character Play mode');
  await evaluate(`(()=>{const s=[...document.querySelectorAll('.entity-sheet[data-actor-id="${ids.pcActor}"]')].find(n=>!String(n.dataset.tokenId||''));s?.querySelector('[data-sheet-mode-toggle]')?.click();return true;})()`);
  await retrySnapshot(()=>evaluate(`(()=>{const s=[...document.querySelectorAll('.entity-sheet[data-actor-id="${ids.pcActor}"]')].find(n=>!String(n.dataset.tokenId||''));return s?.dataset.sheetInteractionMode==='edit'?true:null;})()`),'Character Edit mode');
  await evaluate(`(()=>{const s=[...document.querySelectorAll('.entity-sheet[data-actor-id="${ids.pcActor}"]')].find(n=>!String(n.dataset.tokenId||''));s?.querySelector('[data-sheet-mode-toggle]')?.click();return true;})()`);
  const playEdit=await retrySnapshot(()=>evaluate(`(()=>{const s=[...document.querySelectorAll('.entity-sheet[data-actor-id="${ids.pcActor}"]')].find(n=>!String(n.dataset.tokenId||''));return s?.dataset.sheetInteractionMode==='play'?{before:'play',edit:'edit',restored:'play'}:null;})()`),'Character Play mode restored');

  await new Promise(r=>setTimeout(r,300));if(failures.length)throw new Error(`Final browser requests failed: ${failures.join('; ')}`);if(exceptions.length)throw new Error(`Final browser runtime errors: ${exceptions.join('; ')}`);
  console.log(JSON.stringify({ready,fixture,cards,linkedHealth:{change:healthChange,shared:true},resize:{before:resizeBefore,applied:resizeApplied,captured:resizeCaptured,rerender:resizeRerender,reopen:resizeReopen},playEdit}));
  await send('Browser.close');browserClosed=true;
} catch(error) { throw new Error(`${error.message}${edgeError?`\nEdge stderr:\n${edgeError.slice(-4000)}`:''}`); }
finally { if(!browserClosed&&edge.exitCode===null)edge.kill('SIGKILL');if(edge.exitCode===null)await new Promise(resolve=>{const timer=setTimeout(resolve,2000);edge.once('exit',()=>{clearTimeout(timer);resolve();});});await rm(profile,{recursive:true,force:true,maxRetries:20,retryDelay:100}).catch(error=>console.warn(`Final sheet smoke profile cleanup deferred: ${error.message}`)); }
