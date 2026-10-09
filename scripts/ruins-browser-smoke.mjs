const STORAGE_KEY = 'rpgmap-packaged-ruins-smoke';

/** Runs after the ordinary Chrome feedback measurements, against the installed package. */
export async function runRuinsBrowserSmoke(evaluate, { beforeRecovery, afterRecovery, enforcePerformanceGates = true } = {}) {
  const initial = await evaluate(`(${prepareAndDamage.toString()})(${JSON.stringify(STORAGE_KEY)},(${captureCommittedVisionRevision.toString()}))`, 60_000);
  await evaluate('setTimeout(() => location.reload(), 0); true');
  const deadline = Date.now() + 30_000;
  let reloaded = false;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 100));
    try {
      reloaded = await evaluate(`(() => {
        if(globalThis.__rpgmapRuinsBeforeReload)return false;
        const saved=sessionStorage.getItem(${JSON.stringify(STORAGE_KEY)});
        if(!saved)return false;
        // Offline startup intentionally opens World Manager. Reopen the exact
        // saved World through its normal entry button, then inspect its data.
        const worldId=JSON.parse(saved).original.worldId;
        const entry=[...document.querySelectorAll('[data-world-open]')].find(node=>node.dataset.worldOpen===worldId);
        if(entry){entry.click();return false;}
        return Boolean(document.querySelector('#app')?.rpgMapApp?.sceneAreas);
      })()`);
      if (reloaded) break;
    } catch {}
  }
  if (!reloaded) throw new Error('Ruins smoke package did not reload its saved World: '+JSON.stringify(await evaluate(`({
    beforeReload:!!globalThis.__rpgmapRuinsBeforeReload,entries:[...document.querySelectorAll('[data-world-open]')].map(node=>node.dataset.worldOpen),
    status:document.querySelector('[data-rpgmap-boot-status]')?.textContent,api:!!document.querySelector('#app')?.rpgMapApp})`)));
  await beforeRecovery?.();
  let recovered;
  try { recovered = await evaluate(`(${verifyRecoveryAndRestore.toString()})(${JSON.stringify(STORAGE_KEY)},(${captureCommittedVisionRevision.toString()}),(${matchesCommittedRuinsFeedback.toString()}),${enforcePerformanceGates !== false})`, 60_000); }
  finally { await afterRecovery?.(); }
  return { ...initial, ...recovered, passed: true };
}

// Fog completion can commit while an operation waits for durable persistence.
// Capture the operation's actual synchronous authority revision rather than a
// later, unrelated Fog revision. The mask still must follow this commit and
// must have been requested after the measured operation began.
export async function captureCommittedVisionRevision(api, source, operation) {
  let revision = null;
  const off = api.on('state:patch', event => {
    if (event.detail?.source === `document.${source}`) revision = api.getStateRevision();
  });
  try {
    const value = await operation();
    if (!Number.isSafeInteger(revision)) throw new Error(`No authoritative commit observed for ${source}`);
    return { value, revision };
  } finally { off(); }
}

export function matchesCommittedRuinsFeedback(feedback, revision, started, point = null) {
  return Boolean(feedback?.rendered && feedback.stateRevision >= revision && feedback.requestedAt >= started
    && (!point || (Math.abs(feedback.source?.x - point.x) <= .001 && Math.abs(feedback.source?.y - point.y) <= .001)));
}

async function prepareAndDamage(storageKey, captureRevision) {
  const api = document.querySelector('#app').rpgMapApp;
  if (api.multiplayer?.getStatus?.().connected) throw new Error('Ruins save/reload smoke requires the independent offline fixture');
  if (typeof api.getSceneRenderDiagnostics !== 'function') throw new Error('Scene rendering diagnostics are unavailable');
  if (typeof api.getOcclusionGeometryCacheDiagnostics !== 'function') throw new Error('Occlusion geometry cache diagnostics are unavailable');
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const sourceId = api.vision.getSource();
  const original = { worldId:api.world.get().id, scene: api.world.getActiveScene(), token: api.tokens.get(sourceId), sourceId,
    center: { ...api.map.getCenter() }, zoom: api.map.getZoom() };
  check(original.token, 'Ruins smoke needs the existing offline vision Token');
  const sceneId = original.scene.id;
  const area = { id:'ruins-smoke-circle',name:'Ruins SweepEvent regression',shape:'circle',
    origin:{x:3581.491689174436,y:1553.9528916589916},anchor:{type:'free',markerId:null},
    radius:206.80454093031585,range:200,angleDeg:60,length:300,width:80,headingDeg:0,
    color:'#d63d32',opacity:.18,visible:false,destructionEnabled:true,severeDamage:false,craterEnabled:false,
    destructionTargets:['building','wall','vegetation','bridge','terrain'] };
  const eye = { x:3628.528142813593,y:1242.984768981114 };
  const token = { ...original.token,...eye,elevationMeters:0,placement:'map',featureId:null,
    vision:{...original.token.vision,preciseRangeOverrideMeters:1000,vagueRangeOverrideMeters:1000} };
  const setupStarted = performance.now();
  const setupCommit = await captureRevision(api,'ruins-smoke:fixture',()=>api.world.performOperations([
    {type:'scene.content.replace',payload:{sceneId,sceneEvents:[],attackAreas:[area]}},
    {type:'scene.settings.patch',payload:{sceneId,patch:{lineOfSightEnabled:true,movementBudgetMetersPerTurn:null}}},
    {type:'token.upsert',payload:{sceneId,token}},
  ],{source:'ruins-smoke:fixture'}));
  await api.vision.setSource(sourceId);
  api.selection.replace([sourceId],sourceId);
  api.map.setView([api.mapPackage.height-eye.y,eye.x],0,{animate:false});
  const feedback = async (started, revision=api.getStateRevision()) => {
    const until=performance.now()+5000;
    while(performance.now()<until) {
      const state=api.vision.getFeedbackState(),current=api.tokens.get(sourceId);
      if(state?.rendered&&state.stateRevision>=revision&&state.requestedAt>=started
        &&Math.abs(state.source?.x-current.x)<.001&&Math.abs(state.source?.y-current.y)<.001) {
        return { elapsedMs:performance.now()-started,revision,stateRevision:state.stateRevision,
          requestedAt:state.requestedAt,rendered:true,x:state.source.x,y:state.source.y };
      }
      await wait(8);
    }
    throw new Error('Destroyed-scene mask did not finish: '+JSON.stringify({revision,state:api.vision.getFeedbackState()}));
  };
  await feedback(setupStarted,setupCommit.revision);
  const imageRecord = id => {
    const groups=[...document.querySelectorAll('#layer-scene-ruins .scene-ruin')].filter(node=>node.dataset.ruinFor===id);
    check(groups.length===1,'Each damaged Feature must have exactly one ruins group: '+id);
    const group=groups[0],normal=group.querySelector('.scene-ruin-texture:not(.scene-ruin-texture-severe)');
    const images=[...normal.querySelectorAll('image')];
    check(images.length===1,'Building ruins must load one bound texture: '+id);
    check(!group.hasAttribute('data-feature-id')&&!group.hasAttribute('data-tag'),'Ruins must not create a tagged entity');
    const svg=images[0].parentElement;
    return {featureId:id,groups:groups.length,normalImages:images.length,taggedEntity:false,
      severeImages:group.querySelectorAll('.scene-ruin-texture-severe image').length,
      mask:normal.getAttribute('mask'),
      anchor:Object.fromEntries(['x','y','width','height','viewBox'].map(key=>[key,svg.getAttribute(key)])),
      href:images[0].getAttribute('href')};
  };
  const apply = async () => {
    const preview=await api.sceneAreas.preview(area.id);
    const started=performance.now();
    const commit=await captureRevision(api,'scene-area:damage',()=>api.sceneAreas.apply(area.id));
    check(commit.value,'Scene area apply rejected');
    const committedAt=performance.now(),revision=commit.revision;
    const complete=await feedback(started,revision);
    return {preview,commitMs:committedAt-started,feedback:complete};
  };
  const first=await apply();
  const buildings=new Set(api.mapPackage.features.filter(item=>item.category==='building').map(item=>item.id));
  const partialId=first.preview.clipHits.map(hit=>hit.featureId).find(id=>buildings.has(id));
  check(partialId,'Fixed regression attack needs a partially destroyed building');
  const partial=imageRecord(partialId);
  check(Boolean(partial.mask),'Partial ruin image is clipped to the actual attack range');
  const wholeId=first.preview.clipHits.map(hit=>hit.featureId).find(id=>buildings.has(id)&&id!==partialId)
    || api.mapPackage.features.find(item=>item.category==='building'&&item.id!==partialId
      &&api.interaction.actionsForFeature(item.id).some(action=>action.id==='damage'&&action.enabled))?.id;
  check(wholeId,'Ruins smoke needs a second independently restorable building');
  const secondArea={...area,origin:{x:area.origin.x+5,y:area.origin.y}};
  await api.world.performOperations([{type:'scene.content.replace',payload:{sceneId,attackAreas:[secondArea]}}],{source:'ruins-smoke:overlap'});
  const second=await apply(),overlap=imageRecord(partialId);
  check(JSON.stringify(partial.anchor)===JSON.stringify(overlap.anchor)&&partial.href===overlap.href,
    'Overlapping partial hits must keep the texture at its original world anchor');
  const severeArea={...secondArea,severeDamage:true,craterEnabled:true};
  await api.world.performOperations([{type:'scene.content.replace',payload:{sceneId,attackAreas:[severeArea]}}],{source:'ruins-smoke:severe'});
  const severeResult=await apply(),severe=imageRecord(partialId);
  check(severe.severeImages===1,'Severe partial damage needs the severe ruins texture');
  check(JSON.stringify(partial.anchor)===JSON.stringify(severe.anchor),'Severe damage cannot stretch the bound image');
  check(document.querySelector('#layer-scene-ruins .scene-crater'),'Severe damage keeps its independent crater display');
  const executeButton = async (featureId,action) => {
    api.selectFeature(featureId,{switchTab:true});
    const button=document.querySelector('[data-panel="inspect"] [data-interaction-action="'+action+'"]');
    check(button&&!button.disabled,'Inspection action is unavailable: '+action+' '+featureId);
    const started=performance.now();
    const commit=await captureRevision(api,'feature:'+action,()=>new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{off?.();reject(new Error('Inspection action timed out'));},5000);
      const off=api.on('interaction:executed',event=>{
        if(event.detail?.action!==action||event.detail?.featureId!==featureId)return;
        clearTimeout(timer);off();resolve(event.detail);
      });
      button.click();
    }));
    const result=commit.value;
    check(result.ok,'Inspection action failed: '+JSON.stringify(result));
    const committedAt=performance.now(),revision=commit.revision;
    const complete=await feedback(started,revision);
    return {action,featureId,commitMs:committedAt-started,feedback:complete};
  };
  const wholeResult=await executeButton(wholeId,'damage'),whole=imageRecord(wholeId);
  check(!whole.mask,'Whole destruction exposes the complete bound texture: '+JSON.stringify({whole,
    state:api.interaction.stateForFeature(wholeId),events:api.world.getActiveScene().sceneEvents.slice(-4),
    diagnostics:api.getSceneRenderDiagnostics()}));
  check(api.interaction.stateForFeature(wholeId)?.destroyed===true,'Whole destruction remains in authoritative Scene data');
  check(document.querySelector('[data-feature-id="'+CSS.escape(wholeId)+'"]')?.classList.contains('scene-destroyed'),
    'Whole destruction hides the original building');
  whole.originalHidden=true;whole.destructionConfirmed=true;
  // The exact SweepEvent source is inside the river. Keep it for the fixed
  // projection regression, then place the ordinary mover on nearby dry ground.
  const movementOrigin={x:eye.x,y:1345};
  const placementStarted=performance.now();
  const placementCommit=await captureRevision(api,'ruins-smoke:dry-ground',()=>api.world.performOperations([{type:'token.upsert',payload:{sceneId,
    token:{...api.tokens.get(sourceId),...movementOrigin}}}],{source:'ruins-smoke:dry-ground'}));
  await feedback(placementStarted,placementCommit.revision);
  const movement=[];
  for(const offset of [.25,2.5,0]) {
    const started=performance.now();
    const destination={x:movementOrigin.x+offset,y:movementOrigin.y};
    check(api.movementFast.inspectTokenMove(sourceId,destination).valid,'Ruins movement fixture must use a passable route');
    const commit=await captureRevision(api,'token:reposition',()=>api.tokens.reposition(sourceId,destination));
    movement.push(await feedback(started,commit.revision));
  }
  const zoom=[];
  for(const value of [-2,.25,2,0]) {
    api.map.setView([api.mapPackage.height-movementOrigin.y,movementOrigin.x],value,{animate:false});
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    api.vision.render();
    await new Promise(resolve=>requestAnimationFrame(resolve));
    const canvas=document.querySelector('.rpgmap-vision-fog-perception'),point=api.map.latLngToContainerPoint([api.mapPackage.height-movementOrigin.y,movementOrigin.x]);
    const ratio=canvas.width/api.map.getSize().x;
    const alpha=canvas.getContext('2d').getImageData(Math.floor(point.x*ratio),Math.floor(point.y*ratio),1,1).data[3];
    check(alpha<=12,'Destroyed scene becomes opaque at zoom '+value);
    zoom.push({zoom:value,centerAlpha:alpha});
  }
  const queueStarted=performance.now();
  while(api.world.getExplorationStatus().queued||api.world.getExplorationStatus().running) {
    check(performance.now()-queueStarted<45000,'Ruins exploration queue did not drain');await wait(20);
  }
  check(await api.persistNow(),'Damaged fixture did not persist');
  const expected={sceneEvents:api.world.getActiveScene().sceneEvents,attackAreas:api.world.getActiveScene().attackAreas,
    partialId,wholeId,partialAnchor:partial.anchor,partialHref:partial.href};
  sessionStorage.setItem(storageKey,JSON.stringify({original,expected}));
  globalThis.__rpgmapRuinsBeforeReload=true;
  return {reproduction:{area:area.origin,radiusMeters:area.radius,source:eye,rangeMeters:1000,
      first:{commitMs:first.commitMs,feedback:first.feedback},second:{commitMs:second.commitMs,feedback:second.feedback},
      severe:{commitMs:severeResult.commitMs,feedback:severeResult.feedback}},
    partial,overlap,severe,whole,wholeAction:wholeResult,movementOrigin,movement,zoom,
    beforeReload:{diagnostics:api.getSceneRenderDiagnostics(),queue:api.world.getExplorationStatus()}};
}

async function verifyRecoveryAndRestore(storageKey,captureRevision,matchesFeedback,enforcePerformanceGates=true) {
  const api=document.querySelector('#app').rpgMapApp,{original,expected}=JSON.parse(sessionStorage.getItem(storageKey));
  const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const check=(condition,message)=>{if(!condition)throw new Error(message);};
  const sceneId=api.world.getActiveScene().id;
  const stable=value=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a],[b])=>a<b?-1:a>b?1:0)) : item);
  check(sceneId===original.scene.id,'Reload changed the active Scene');
  check(api.world.get().id===original.worldId,'Reload changed the saved World');
  check(stable(api.world.getActiveScene().sceneEvents)===stable(expected.sceneEvents),
    'Reload lost confirmed destruction history: '+JSON.stringify({expected:expected.sceneEvents,actual:api.world.getActiveScene().sceneEvents}));
  check(stable(api.world.getActiveScene().attackAreas)===stable(expected.attackAreas),'Reload lost the attack area');
  await api.vision.setSource(original.sourceId);api.selection.replace([original.sourceId],original.sourceId);
  const recoveredToken=api.tokens.get(original.sourceId);
  api.map.setView([api.mapPackage.height-recoveredToken.y,recoveredToken.x],0,{animate:false});
  const rendered=async(revision=api.getStateRevision(),started=0,point=null)=>{
    const deadline=performance.now()+5000;
    while(performance.now()<deadline){const feedback=api.vision.getFeedbackState();
      if(matchesFeedback(feedback,revision,started,point))return feedback;
      await wait(8);
    }throw new Error('Restored-scene vision feedback did not finish');
  };
  await rendered();
  const group=id=>[...document.querySelectorAll('#layer-scene-ruins .scene-ruin')].find(node=>node.dataset.ruinFor===id);
  check(group(expected.partialId)&&group(expected.wholeId),'Saved partial or whole ruins failed to reload');
  const image=group(expected.partialId).querySelector('.scene-ruin-texture:not(.scene-ruin-texture-severe) image');
  check(image&&image.getAttribute('href')===expected.partialHref,'Reload changed the bound ruins resource');
  const anchor=Object.fromEntries(['x','y','width','height','viewBox'].map(key=>[key,image.parentElement.getAttribute(key)]));
  check(JSON.stringify(anchor)===JSON.stringify(expected.partialAnchor),'Reload moved the ruins image');
  const restored=[];
  const restoreThroughList=async id=>{
    api.selectFeature(id,{switchTab:true});
    const select=document.querySelector('[data-damaged-feature-select]'),inspect=document.querySelector('[data-damaged-feature-inspect]');
    check(select&&inspect&&[...select.options].some(option=>option.value===id),'Restorable object is absent from the damaged-object list');
    select.value=id;inspect.click();
    check(api.getSelectedFeatureId()===id,'Damaged-object selection did not open the intended Feature');
    const button=document.querySelector('[data-panel="inspect"] [data-interaction-action="restore"]');
    check(button&&!button.disabled&&button.textContent.includes('此对象'),'Single-object restore button is unavailable');
    const started=performance.now();
    const commit=await captureRevision(api,'feature:restore',()=>new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{off?.();reject(new Error('Single-object restore timed out'));},5000);
      const off=api.on('interaction:executed',event=>{if(event.detail?.action!=='restore'||event.detail?.featureId!==id)return;
        clearTimeout(timer);off();resolve(event.detail);});button.click();
    }));
    const result=commit.value;
    check(result.ok,'Single-object restore failed: '+JSON.stringify(result));
    const commitMs=performance.now()-started,feedback=await rendered(commit.revision,started);
    check(!group(id)&&!api.interaction.stateForFeature(id)?.damaged,'Restore kept damage or its ruins group');
    return {featureId:id,commitMs,feedbackMs:performance.now()-started,stateRevision:feedback.stateRevision};
  };
  restored.push(await restoreThroughList(expected.wholeId));
  check(group(expected.partialId),'Restoring the whole building also restored a different damaged building');
  restored.push(await restoreThroughList(expected.partialId));
  check(document.querySelector('#layer-scene-ruins .scene-crater'),'Single-object restore removed an independent crater');
  const afterRestore={diagnostics:api.getSceneRenderDiagnostics(),remainingRuins:document.querySelectorAll('#layer-scene-ruins .scene-ruin').length};
  // Movement checks use a navigable dry-ground route. The following pressure
  // measurements return to the fixed SweepEvent observation point so their
  // recorded source and the independent release verifier use the same input.
  const stressSetup=performance.now();
  const stressPoint={x:3628.528142813593,y:1242.984768981114};
  const sourceCommit=await captureRevision(api,'ruins-smoke:stress-source',()=>api.world.performOperations([{type:'token.upsert',payload:{sceneId,token:{...api.tokens.get(original.sourceId),
    ...stressPoint}}}],{source:'ruins-smoke:stress-source'}));
  await rendered(sourceCommit.revision,stressSetup,stressPoint);
  // The prior movement scenario is complete before fixed-source pressure
  // begins. Its animation and durable historical path must both finish;
  // destruction still queues and measures its own exploration normally.
  const setupDeadline=performance.now()+45000;
  while(api.world.getExplorationStatus().queued||api.world.getExplorationStatus().running){
    check(performance.now()<setupDeadline,'Stress source setup exploration did not drain');await wait(20);
  }
  await rendered(sourceCommit.revision,stressSetup,stressPoint);
  const stress=[],frameSamples=[],longTasks=[],heapBytesBefore=performance.memory?.usedJSHeapSize??null,stressStartedAt=performance.now();
  const observer=new PerformanceObserver(list=>longTasks.push(...list.getEntries().map(entry=>({startTime:entry.startTime,duration:entry.duration}))));
  observer.observe({type:'longtask',buffered:false});
  let frameId,lastFrame=null;
  const frameTick=time=>{if(lastFrame!==null)frameSamples.push(time-lastFrame);lastFrame=time;frameId=requestAnimationFrame(frameTick);};
  frameId=requestAnimationFrame(frameTick);
  await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  try {
    for(let round=0;round<12;round++) {
      const start=performance.now(),damageCommit=await captureRevision(api,'feature:damage',()=>api.interaction.damage(expected.wholeId)),damaged=damageCommit.value;
      check(damaged.ok,'Repeated whole destruction failed');const damageCommitMs=performance.now()-start;
      const damageRevision=damageCommit.revision,damageFeedback=await rendered(damageRevision,start);const damageFeedbackMs=performance.now()-start;
      const restoreStart=performance.now(),restoreCommit=await captureRevision(api,'feature:restore',()=>api.interaction.restore(expected.wholeId)),restored=restoreCommit.value;
      check(restored.ok,'Repeated single-object restoration failed');const restoreCommitMs=performance.now()-restoreStart;
      const restoreRevision=restoreCommit.revision,restoreFeedback=await rendered(restoreRevision,restoreStart);
      const restoreFeedbackMs=performance.now()-restoreStart;
      stress.push({round,damageCommitMs,damageFeedbackMs,restoreCommitMs,restoreFeedbackMs,
        damageOk:damaged.ok,restoreOk:restored.ok,
        damageFeedback:{elapsedMs:damageFeedbackMs,revision:damageRevision,rendered:damageFeedback.rendered,
          stateRevision:damageFeedback.stateRevision,requestedAt:damageFeedback.requestedAt,x:damageFeedback.source.x,y:damageFeedback.source.y},
        restoreFeedback:{elapsedMs:restoreFeedbackMs,revision:restoreRevision,rendered:restoreFeedback.rendered,
          stateRevision:restoreFeedback.stateRevision,requestedAt:restoreFeedback.requestedAt,x:restoreFeedback.source.x,y:restoreFeedback.source.y},
        diagnostics:api.getSceneRenderDiagnostics(),geometryCache:api.getOcclusionGeometryCacheDiagnostics()});
    }
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  } finally {
    cancelAnimationFrame(frameId);
    longTasks.push(...observer.takeRecords().map(entry=>({startTime:entry.startTime,duration:entry.duration})));observer.disconnect();
  }
  const percentile=values=>[...values].sort((a,b)=>a-b)[Math.ceil(values.length*.95)-1];
  const stressEndedAt=performance.now();
  const frames={samplesMs:frameSamples,count:frameSamples.length,averageFPS:frameSamples.length*1000/frameSamples.reduce((sum,value)=>sum+value,0),p95Ms:percentile(frameSamples)};
  const maxLongTaskMs=Math.max(0,...longTasks.map(task=>task.duration));
  const damageP95Ms=percentile(stress.map(sample=>sample.damageFeedbackMs)),restoreP95Ms=percentile(stress.map(sample=>sample.restoreFeedbackMs));
  check(frameSamples.length>=24&&(!enforcePerformanceGates||(frames.averageFPS>=58&&frames.p95Ms<=20)),'Continuous damage/restoration failed frame responsiveness: '+JSON.stringify({
    frames,stress:stress.map(sample=>({round:sample.round,damageCommitMs:sample.damageCommitMs,restoreCommitMs:sample.restoreCommitMs,
      damageFeedbackMs:sample.damageFeedbackMs,restoreFeedbackMs:sample.restoreFeedbackMs,diagnostics:sample.diagnostics})),longTasks}));
  check(!enforcePerformanceGates||maxLongTaskMs<=100,'Continuous damage/restoration has a long task above 100 ms');
  check(!enforcePerformanceGates||(damageP95Ms<=100&&restoreP95Ms<=100),'Continuous damage/restoration failed 1000 m feedback latency: '+JSON.stringify({
    damageP95Ms,restoreP95Ms,frames,stress,longTasks}));
  for(const sample of stress){
    check(sample.geometryCache.entries<=512&&sample.geometryCache.largestFeatureVersions<=2,'Continuous damage/restoration exceeded geometry cache bounds');
    check(sample.diagnostics.ruinObjects<=api.mapPackage.features.length&&sample.diagnostics.craterObjects<=1,'Continuous damage/restoration leaked render nodes');
  }
  const heapBytesAfter=performance.memory?.usedJSHeapSize??null;
  const queueStart=performance.now();
  await api.vision.setSource(null);
  while(api.world.getExplorationStatus().queued||api.world.getExplorationStatus().running){
    check(performance.now()-queueStart<45000,'Restored fixture exploration did not drain');await wait(20);
  }
  const stressFinal={diagnostics:api.getSceneRenderDiagnostics(),geometryCache:api.getOcclusionGeometryCacheDiagnostics(),queue:api.world.getExplorationStatus()};
  check(stressFinal.diagnostics.inactiveRuins<=stressFinal.diagnostics.inactiveRuinsLimit
    &&stressFinal.diagnostics.inactiveRuinsLimit<=512&&stressFinal.diagnostics.largestRuinVersions<=2,
    'Detached ruins display cache exceeded its object/version limits');
  await api.world.performOperations([
    {type:'scene.content.replace',payload:{sceneId,sceneEvents:original.scene.sceneEvents,attackAreas:original.scene.attackAreas,settings:original.scene.settings}},
    {type:'token.upsert',payload:{sceneId,token:original.token}},
  ],{source:'ruins-smoke:cleanup'});
  await api.vision.setSource(original.sourceId);
  api.map.setView(original.center,original.zoom,{animate:false});
  check(await api.persistNow(),'Ruins smoke cleanup failed to persist');
  sessionStorage.removeItem(storageKey);
  return {reload:{worldIdRetained:true,sceneEventsRetained:true,attackAreasRetained:true,anchorRetained:true},
    restore:{singleObjectOnly:true,independentCraterRetained:true,actions:restored},afterRestore,
    stress:{rounds:stress.length,samples:stress,frames,framesGateEnforced:enforcePerformanceGates,performanceGatesEnforced:enforcePerformanceGates,longTasks,maxLongTaskMs,damageP95Ms,restoreP95Ms,
      observerSupported:true,startedAt:stressStartedAt,endedAt:stressEndedAt,durationMs:stressEndedAt-stressStartedAt,
      heapBytesBefore,heapBytesAfter,finalDiagnostics:stressFinal.diagnostics,
      finalGeometryCache:stressFinal.geometryCache,finalQueue:stressFinal.queue},cleanup:true};
}
