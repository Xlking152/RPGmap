import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import polygonClipping from 'polygon-clipping';
import { captureVisionSourceProof, assertVisionSourceProofUnchanged } from './vision-source-proof.mjs';
import { normalizeVisionOccluder } from '../src/spatial/kernel.js';
import { projectVisionOcclusion } from '../src/vision/ground-shadow.js';
import { projectVisionOcclusion as legacyProjection } from '../tests/fixtures/ground-shadow-before-row-optimization.js';

const sourceRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const sourceProof=await captureVisionSourceProof(sourceRoot);
const reference = await readFile(new URL('../tests/fixtures/vision-mask-raster-reference.js',import.meta.url),'utf8');
const candidate = await readFile(new URL('../src/vision/mask-renderer.js',import.meta.url),'utf8');
const vectorOracle = await readFile(new URL('../tests/fixtures/facade-vector-oracle.js',import.meta.url),'utf8');
const facadeHelper = await readFile(new URL('../src/vision/facade-mask.js',import.meta.url),'utf8');
const clippingLibrary = await readFile(new URL('../node_modules/polygon-clipping/dist/polygon-clipping.umd.min.js',import.meta.url),'utf8');
const regression = JSON.parse(await readFile(new URL('../tests/fixtures/vision-facade-sweep-regression.json',import.meta.url),'utf8'));
const closed = polygons=>polygons.map(rings=>rings.map(ring=>[...ring,ring[0]]));
assert.throws(()=>polygonClipping.difference(closed(regression.facade.polygons),closed(regression.shadows)),/SweepEvent/);
const rect=(x,y,w,h)=>[[x,y],[x+w,y],[x+w,y+h],[x,y+h]];
const shapes=[
  {id:'rect',kind:'building',polygon:rect(8,-5,3,10),blockingHeightMeters:6},
  {id:'concave',kind:'building',polygon:[[8,-5],[14,-5],[14,-2],[10,-2],[10,5],[8,5]],blockingHeightMeters:6},
  {id:'hole',kind:'building',polygon:rect(8,-5,8,10),polygons:[[rect(8,-5,8,10),rect(10,-2,4,4)]],blockingHeightMeters:6},
  {id:'fragments',kind:'building',polygon:rect(8,-5,3,10),polygons:[[rect(8,-5,3,3)],[rect(8,2,3,3)]],blockingHeightMeters:6},
];
const axes={geometryIds:shapes.map(shape=>shape.id),elevations:[0,15],sizes:[[400,300],[401,301]],
  dprs:[1,1.25,1.5,2],scales:[.25,1,3.5],modes:['all','normal','dark-and-normal'],centers:[[173.37,131.21],[-20.13,80.27]]};
const diagnosticSubset=process.argv.includes('--diagnostic-subset');
if(diagnosticSubset) {
  axes.dprs=[1.25];axes.scales=[1,3.5];axes.modes=['all','dark-and-normal'];axes.centers=[axes.centers[0]];
}
const expectedCases=Object.values(axes).reduce((total,values)=>total*values.length,1);
const referenceSource=reference;
const candidateSource=facadeHelper.replaceAll('export ','')+'\n'+candidate.replace(/^import .*facade-mask\.js.*;\r?\n/m,'');
const geometries=[];
for(const shape of shapes) for(const elevationMeters of axes.elevations) {
  const occluders=Object.freeze([{id:'near',kind:'wall',polygon:rect(4,-1,2,2),blockingHeightMeters:6},shape].map(normalizeVisionOccluder));
  assert(occluders.every(Boolean), `Invalid raster fixture: ${shape.id}`);
  const frames=[];
  for(let frame=0;frame<2;frame++) {
    const source={x:frame*.2,y:frame*.3,elevationMeters,tokenId:'raster-source',placement:'map',allowHostExemption:true};
    const input={source,radiusUnits:30,occluders};
    frames.push({source,old:legacyProjection(input),candidate:projectVisionOcclusion(input)});
  }
  geometries.push({geometryId:shape.id,elevationMeters,frames});
}
const executable=[process.env.ProgramFiles,process.env['ProgramFiles(x86)'],process.env.LOCALAPPDATA]
  .filter(Boolean).map(root=>path.join(root,'Google/Chrome/Application/chrome.exe')).find(existsSync);
assert(executable,'Chrome is required for facade raster acceptance');
const listener=net.createServer();await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));
const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));
const profile=await mkdtemp(path.join(os.tmpdir(),'rpgmap-facade-raster-'));
const browser=spawn(executable,['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check',
  `--remote-debugging-port=${port}`,`--user-data-dir=${profile}`,'about:blank'],{stdio:'ignore',windowsHide:true});
let socket;
try {
  let page;const deadline=Date.now()+30_000;
  while(!page&&Date.now()<deadline){try{page=(await(await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(item=>item.type==='page');}catch{}
    if(!page)await new Promise(resolve=>setTimeout(resolve,100));}
  assert(page,'Chrome CDP did not start');socket=new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
  let nextId=0;const pending=new Map();
  socket.addEventListener('message',event=>{const message=JSON.parse(String(event.data)),task=pending.get(message.id);if(!task)return;
    pending.delete(message.id);clearTimeout(task.timer);if(message.error)task.reject(new Error(message.error.message));else task.resolve(message.result);});
  const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++nextId,timer=setTimeout(()=>{pending.delete(id);reject(new Error(method+' timed out'));},60_000);
    pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));});
  const initial=await send('Runtime.evaluate',{returnByValue:true,expression:`
    globalThis.rpgmapFacadeRaster=(function*(){
      const oldFactory=(()=>{${referenceSource.replaceAll('export ','')};return createContinuousMaskRenderer;})();
      const newFactory=(()=>{${candidateSource.replaceAll('export ','')};return createContinuousMaskRenderer;})();
      const polygonClipping=(()=>{const module={exports:{}},exports=module.exports;
        ${clippingLibrary}
        return module.exports;})();
      ${vectorOracle.replace(/^import .*;\r?\n/m,'').replaceAll('export ','')}
      const geometries=${JSON.stringify(geometries)},axes=${JSON.stringify(axes)},regression=${JSON.stringify(regression)};
      const rawCases=[];let differingPixels=0,maxChannelError=0,maxEdgeErrorCss=0,interiorLeakedPixels=0,outsideEdgeHaloPixels=0;
      const lightingRegions=[
        {x:-2,y:-6,radiusUnits:24,normalRadiusUnits:18,shadows:[]},
        {x:14,y:6,radiusUnits:20,normalRadiusUnits:12,shadows:[[[[4,-1],[6,-1],[6,1],[4,1]]]]},
      ];
      for(const fixture of geometries.filter(value=>axes.geometryIds.includes(value.geometryId)))for(const [width,height]of axes.sizes)for(const dpr of axes.dprs)
        for(const scale of axes.scales)for(const mode of axes.modes)for(const center of axes.centers){
          const viewport={scaleX:scale,project:(x,y)=>({x:center[0]+x*scale,y:center[1]+y*scale})},outputs=[];
          for(const [factory,label]of [[oldFactory,'old'],[newFactory,'candidate']]){
            const canvas=document.createElement('canvas');canvas.width=Math.ceil(width*dpr);canvas.height=Math.ceil(height*dpr);
            const context=canvas.getContext('2d');context.setTransform(dpr,0,0,dpr,0,0);
            const renderer=factory(document),frames=[];
            for(let frame=0;frame<2;frame++){
              context.globalCompositeOperation='source-over';context.clearRect(0,0,width,height);context.fillStyle='#fff';
              const geometry={...fixture.frames[frame][label],illumination:{mode,regions:lightingRegions}};
              renderer.draw(context,{key:'precise:'+frame,geometry,source:fixture.frames[frame].source,radiusUnits:30,
                kind:'precise',viewport,width,height,dpr});frames.push(context.getImageData(0,0,canvas.width,canvas.height).data);
            }outputs.push(frames);renderer.dispose();
          }
          const record={geometryId:fixture.geometryId,elevationMeters:fixture.elevationMeters,width,height,dpr,scale,mode,center,frames:[]};
          const pixelsX=Math.ceil(width*dpr),pixelsY=Math.ceil(height*dpr);
          for(let frame=0;frame<2;frame++){
            const old=outputs[0][frame],actual=outputs[1][frame];
            let changed=0,error=0,edge=0,leaked=0,outside=0,visibleBoundary=null,opacityEdges=null;
            const outsideSamples=[],leakSamples=[],opaqueMismatchSamples=[];
            for(let index=0;index<old.length;index+=4){
              let difference=0;for(let channel=0;channel<4;channel++)difference=Math.max(difference,Math.abs(old[index+channel]-actual[index+channel]));
              if(!difference)continue;changed++;error=Math.max(error,difference);
              const alpha=old[index+3],actualAlpha=actual[index+3];if(alpha===actualAlpha)continue;
              visibleBoundary ||= referenceVisibleRegions(fixture.frames[frame].old,fixture.frames[frame].source,30,mode,
                lightingRegions,{center,scale,width,height,dpr});
              const pixel=index/4,x=pixel%pixelsX,y=Math.floor(pixel/pixelsX);
              const cssX=(x+.5)/dpr,cssY=(y+.5)/dpr;
              let distance=vectorBoundaryDistanceCss(visibleBoundary,cssX,cssY);
              if(alpha>0&&alpha<255) {
                opacityEdges ||= referenceOpacityEdges(fixture.frames[frame].old,fixture.frames[frame].source,30,mode,
                  lightingRegions,{center,scale,width,height,dpr});
                distance=Math.min(distance,vectorBoundaryDistanceCss(opacityEdges,cssX,cssY));
              }
              distance+=circleChordErrorCss(30,scale);
              if(!Number.isFinite(distance)||distance>1){outside++;if(alpha===0&&actualAlpha>0)leaked++;
                if(outsideSamples.length<4)outsideSamples.push({x,y,alpha,actualAlpha,distanceCss:distance});
                if(alpha===0&&actualAlpha>0&&leakSamples.length<8)leakSamples.push({x,y,alpha,actualAlpha,distanceCss:distance});
                if((alpha===0||alpha===255)&&opaqueMismatchSamples.length<8)opaqueMismatchSamples.push({x,y,alpha,actualAlpha,distanceCss:distance});
              }else edge=Math.max(edge,distance);
            }
            record.frames.push({frame,differingPixels:changed,maxChannelError:error,maxEdgeErrorCss:edge,interiorLeakedPixels:leaked,
              outsideEdgeHaloPixels:outside,outsideSamples,leakSamples,opaqueMismatchSamples});
            differingPixels+=changed;maxChannelError=Math.max(maxChannelError,error);maxEdgeErrorCss=Math.max(maxEdgeErrorCss,edge);interiorLeakedPixels+=leaked;outsideEdgeHaloPixels+=outside;
          }rawCases.push(record);if(rawCases.length%24===0)yield{cases:rawCases.length};
        }
      const inside=(point,rings)=>{let contained=false;for(const ring of rings){let value=false;for(let i=0,j=ring.length-1;i<ring.length;j=i++){
        const a=ring[i],b=ring[j];if((a[1]>point[1])!==(b[1]>point[1])&&point[0]<(b[0]-a[0])*(point[1]-a[1])/(b[1]-a[1])+a[0])value=!value;
      }if(value)contained=!contained;}return contained;};
      const distanceToEdges=(point,polygons)=>{let best=Infinity;for(const rings of polygons)for(const ring of rings)for(let i=0;i<ring.length;i++){
        const a=ring[i],b=ring[(i+1)%ring.length],dx=b[0]-a[0],dy=b[1]-a[1],t=Math.max(0,Math.min(1,((point[0]-a[0])*dx+(point[1]-a[1])*dy)/(dx*dx+dy*dy||1)));
        best=Math.min(best,Math.hypot(point[0]-a[0]-t*dx,point[1]-a[1]-t*dy));
      }return best;};
      const sweepRecords=[],own=regression.facade.polygons,shadows=[...own,...regression.shadows];
      const geometry={blocked:false,shadows,facades:[{...regression.facade,otherShadowIndices:regression.facade.otherShadowIndices.map(index=>index+own.length)}],illumination:{mode:'all',regions:[]}};
      for(const dpr of axes.dprs){
        const width=340,height=200,scale=2,left=3744.16,top=1647.1474678543889;
        const viewport={scaleX:scale,project:(x,y)=>({x:20+(x-left)*scale,y:20+(y-top)*scale})};
        const canvas=document.createElement('canvas');canvas.width=width*dpr;canvas.height=height*dpr;const context=canvas.getContext('2d');context.setTransform(dpr,0,0,dpr,0,0);
        const renderer=newFactory(document);const frames=[];
        for(let frame=0;frame<2;frame++){
          context.globalCompositeOperation='source-over';context.clearRect(0,0,width,height);context.fillStyle='#fff';
          renderer.draw(context,{key:'sweep:'+frame,geometry,source:regression.source,radiusUnits:1000,kind:'precise',viewport,width,height,dpr});
          const pixels=context.getImageData(0,0,canvas.width,canvas.height).data;let exposed=0,hidden=0,leaked=0,missing=0;
          for(let y=0;y<canvas.height;y++)for(let x=0;x<canvas.width;x++){
            const point=[left+((x+.5)/dpr-20)/scale,top+((y+.5)/dpr-20)/scale];
            if(!own.some(rings=>inside(point,rings))||distanceToEdges(point,[...own,...regression.shadows])*scale<=1)continue;
            const blocked=regression.shadows.some(rings=>inside(point,rings)),alpha=pixels[(y*canvas.width+x)*4+3];
            if(blocked){hidden++;if(alpha!==0)leaked++;}else{exposed++;if(alpha!==255)missing++;}
          }frames.push({frame,checkedInteriorPixels:exposed+hidden,visibleInteriorPixels:exposed,hiddenInteriorPixels:hidden,interiorLeakedPixels:leaked,missingVisibleInteriorPixels:missing});
        }renderer.dispose();sweepRecords.push({dpr,frames,completed:true});yield{cases:rawCases.length,regressionDprs:sweepRecords.length};
      }
      // The originally persistent alpha=1 point is outside every facade ROI.
      // Render the exact same geometry with and without presentation inputs to
      // distinguish main/light clip rounding from facade area subtraction.
      const probeFixture=geometries.find(value=>value.geometryId==='fragments'&&value.elevationMeters===0);
      const roundingProbe={x:238,y:157,width:400,height:300,dpr:1.25,scale:1,mode:'dark-and-normal',frame:1,records:[]};
      for(const [factory,label]of [[oldFactory,'old'],[newFactory,'candidate']])for(const includeFacades of [false,true]){
        const canvas=document.createElement('canvas');canvas.width=500;canvas.height=375;
        const context=canvas.getContext('2d');context.setTransform(1.25,0,0,1.25,0,0);
        const renderer=factory(document),viewport={scaleX:1,project:(x,y)=>({x:173.37+x,y:131.21+y})};
        for(let frame=0;frame<2;frame++){
          context.globalCompositeOperation='source-over';context.clearRect(0,0,400,300);context.fillStyle='#fff';
          const geometry={...probeFixture.frames[frame][label],illumination:{mode:'dark-and-normal',regions:[
            {x:-2,y:-6,radiusUnits:24,normalRadiusUnits:18,shadows:[]},
            {x:14,y:6,radiusUnits:20,normalRadiusUnits:12,shadows:[[[[4,-1],[6,-1],[6,1],[4,1]]]]},
          ]}};
          if(!includeFacades)geometry.facades=[];
          renderer.draw(context,{key:'probe:'+frame,geometry,source:probeFixture.frames[frame].source,radiusUnits:30,
            kind:'precise',viewport,width:400,height:300,dpr:1.25});
        }
        roundingProbe.records.push({label,includeFacades,rgba:[...context.getImageData(238,157,1,1).data]});renderer.dispose();
      }
      return{cases:rawCases.length,framesPerCase:2,axes,rawCases,differingPixels,maxChannelError,maxEdgeErrorCss,interiorLeakedPixels,outsideEdgeHaloPixels,
        diagnosticSubset:${diagnosticSubset},
        boundaryOracle:{kind:'final-visible-vector',circleSegments:ORACLE_CIRCLE_SEGMENTS,edgeToleranceCss:1,
          fractionalCopies:'legacy-chain',partialAlphaEdges:'reference-compositing-operands'},
        regression:{sweepReproduced:true,records:sweepRecords},roundingProbe,passed:interiorLeakedPixels===0&&outsideEdgeHaloPixels===0};
    })();true`});
  if(initial.exceptionDetails)throw new Error(initial.exceptionDetails.exception?.description||initial.exceptionDetails.text);
  let progress;
  do{const result=await send('Runtime.evaluate',{returnByValue:true,expression:'globalThis.rpgmapFacadeRaster.next()'});
    if(result.exceptionDetails)throw new Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);
    progress=result.result.value;assert(Number.isSafeInteger(progress?.value?.cases),'Facade raster progress missing');
  }while(!progress.done);
  const report={...progress.value,...sourceProof};
  await assertVisionSourceProofUnchanged(sourceProof,sourceRoot);
  console.log(JSON.stringify(report));
  assert.equal(report.cases,expectedCases);assert.equal(report.framesPerCase,2);
  assert.equal(report.interiorLeakedPixels,0,'Facade surface exposed an interior foreign-shadow pixel');
  assert.equal(report.outsideEdgeHaloPixels,0,'Facade differences exceed the one CSS pixel antialias boundary');
  assert(report.maxEdgeErrorCss<=1);
  assert.equal(report.regression.records.length,axes.dprs.length);
  for(const record of report.regression.records)for(const frame of record.frames){
    assert(frame.visibleInteriorPixels>1000&&frame.hiddenInteriorPixels>1000,'Sweep failure regression must inspect both exposed and hidden pixels');
    assert.equal(frame.interiorLeakedPixels,0);assert.equal(frame.missingVisibleInteriorPixels,0);
  }
  await send('Browser.close');
}finally{
  socket?.close();if(browser.exitCode===null)browser.kill('SIGKILL');
  const absoluteProfile=path.resolve(profile);
  assert(absoluteProfile.startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(absoluteProfile).startsWith('rpgmap-facade-raster-'));
  await rm(absoluteProfile,{recursive:true,force:true,maxRetries:20,retryDelay:100});
}
