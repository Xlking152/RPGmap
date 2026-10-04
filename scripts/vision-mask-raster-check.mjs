import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

// Independent full-viewport raster reference before local-surface optimization.
const reference = await readFile(new URL('../tests/fixtures/vision-mask-raster-reference.js', import.meta.url), 'utf8');
const candidate = await readFile(new URL('../src/vision/mask-renderer.js', import.meta.url), 'utf8');
const executable = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA]
  .filter(Boolean).map(root => path.join(root, 'Google/Chrome/Application/chrome.exe')).find(existsSync);
assert(executable, 'Chrome is required for the raster oracle');
const listener = net.createServer();
await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
const port = listener.address().port;
await new Promise(resolve => listener.close(resolve));
const profile = await mkdtemp(path.join(os.tmpdir(), 'rpgmap-mask-raster-'));
const browser = spawn(executable, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore', windowsHide: true });
let socket;
try {
  let page;
  const deadline = Date.now() + 30_000;
  while (!page && Date.now() < deadline) {
    try { page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(item => item.type === 'page'); } catch {}
    if (!page) await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert(page, 'Chrome CDP did not start');
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const message = JSON.parse(String(event.data)), task = pending.get(message.id);
    if (!task) return;
    pending.delete(message.id); clearTimeout(task.timer);
    if (message.error) task.reject(new Error(message.error.message)); else task.resolve(message.result);
  });
  function send(method, params = {}) { return new Promise((resolve, reject) => {
    const id = ++nextId, timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 60_000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  }); }
  // Keep each CDP command bounded without placing all software-rendered cases
  // in one long command. Every case still draws both frames and checks every
  // pixel; yielding does not change the zero-difference acceptance threshold.
  const initialized = await send('Runtime.evaluate', { returnByValue: true, expression: `
    globalThis.rpgmapMaskRasterIterator = (function* () {
    const oldFactory = (() => { ${reference.replaceAll('export ', '')}; return createContinuousMaskRenderer; })();
    const newFactory = (() => { ${candidate.replaceAll('export ', '')}; return createContinuousMaskRenderer; })();
    let cases = 0, differingPixels = 0, maxChannelError = 0, maxAlphaError = 0, maxPremultipliedError = 0, worstDifference = null, firstDifference = null;
    const ring = [[-15,-25],[10,-25],[10,35],[-15,35]];
    const geometry = { blocked: false, shadows: [[ring, [[-5,-5],[-5,8],[2,8],[2,-5]]]],
      facades: [{ polygons: [[[[8,-25],[13,-25],[13,35],[8,35]]]] }],
      illumination: { mode: 'all', regions: [] } };
    for (const [width,height] of [[400,300],[401,301],[399,257]])
      for (const dpr of [1,1.25,1.5,2]) for (const scale of [.25,1,3.5])
      for (const center of [[173.37,131.21],[-20.13,80.27],[405.12,301.23],[20.42,20.37]])
      for (const radiusUnits of [5,60,120,1000]) for (const mode of ['all','normal','dark-and-normal','blocked']) {
        const source={x:0,y:0};
        const viewport={scaleX:scale,scaleY:scale,project:(x,y)=>({x:center[0]+x*scale,y:center[1]+y*scale})};
        const current={...geometry,blocked:mode==='blocked',illumination:{mode:mode==='blocked'?'all':mode,
          regions:[{x:-25,y:15,radiusUnits:80,normalRadiusUnits:45,blocked:false,shadows:[[ring]]},
            {x:40,y:40,radiusUnits:50,normalRadiusUnits:25,blocked:false,shadows:[]}]}};
        const outputs=[];
        for (const factory of [oldFactory,newFactory]) {
          const canvas=document.createElement('canvas');canvas.width=Math.ceil(width*dpr);canvas.height=Math.ceil(height*dpr);
          const context=canvas.getContext('2d');context.setTransform(dpr,0,0,dpr,0,0);
          const renderer=factory(document);
          const frames=[];
          for(let frame=0;frame<2;frame++) {
          context.globalCompositeOperation='source-over';context.clearRect(0,0,width,height);
          context.fillStyle='rgba(8,12,14,.96)';context.fillRect(0,0,width,height);
          for (const [kind,blend,fillStyle] of [['vague','destination-out','#000'],['vague','source-over','rgba(218,226,228,.20)'],['precise','destination-out','#000']]) {
            context.globalCompositeOperation=blend;context.fillStyle=fillStyle;
            renderer.draw(context,{key:kind+':'+frame,lightingKey:'oracle-lights:'+cases,geometry:current,
              source:{x:frame*.5,y:frame*.75},radiusUnits:kind==='precise'?radiusUnits*.75:radiusUnits,
              kind,viewport,width,height,dpr});
          }
          frames.push(context.getImageData(0,0,canvas.width,canvas.height).data);
          }
          outputs.push(frames); renderer.dispose();
        }
        cases++;
        for(let frame=0;frame<2;frame++) for(let index=0;index<outputs[0][frame].length;index+=4) {
          let difference=0;
          for(let channel=0;channel<4;channel++) difference=Math.max(difference,Math.abs(outputs[0][frame][index+channel]-outputs[1][frame][index+channel]));
          if(difference){differingPixels++;maxChannelError=Math.max(maxChannelError,difference);
            const alphaError=Math.abs(outputs[0][frame][index+3]-outputs[1][frame][index+3]);
            maxAlphaError=Math.max(maxAlphaError,alphaError);
            let premultipliedError=alphaError;
            for(let channel=0;channel<3;channel++) premultipliedError=Math.max(premultipliedError,
              Math.abs(outputs[0][frame][index+channel]*outputs[0][frame][index+3]-outputs[1][frame][index+channel]*outputs[1][frame][index+3])/255);
            if(premultipliedError>maxPremultipliedError) {maxPremultipliedError=premultipliedError;
              worstDifference={width,height,dpr,scale,center,radiusUnits,mode,frame,pixel:index/4,old:[...outputs[0][frame].slice(index,index+4)],candidate:[...outputs[1][frame].slice(index,index+4)]};}
            firstDifference ||= {width,height,dpr,scale,center,radiusUnits,mode,frame,pixel:index/4,old:[...outputs[0][frame].slice(index,index+4)],candidate:[...outputs[1][frame].slice(index,index+4)]};}
        }
        if (cases % 32 === 0) yield { cases };
      }
    return {cases,framesPerCase:2,differingPixels,maxChannelError,maxAlphaError,maxPremultipliedError,worstDifference,firstDifference};
  })(); true` });
  if (initialized.exceptionDetails) throw new Error(initialized.exceptionDetails.exception?.description || initialized.exceptionDetails.text);
  let progress;
  do {
    const result = await send('Runtime.evaluate', { returnByValue: true,
      expression: 'globalThis.rpgmapMaskRasterIterator.next()' });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    progress = result.result.value;
    assert(Number.isSafeInteger(progress?.value?.cases), 'Raster oracle progress missing');
  } while (!progress.done);
  console.log(JSON.stringify(progress.value, null, 2));
  assert.equal(progress.value.cases, 2304, 'Raster oracle must complete all cases');
  assert.equal(progress.value.framesPerCase, 2, 'Raster oracle must draw both consecutive frames');
  assert.equal(progress.value.differingPixels, 0, 'Cropped mask must match full-viewport software raster pixels');
  await send('Browser.close');
} finally {
  socket?.close();
  if (browser.exitCode === null) browser.kill('SIGKILL');
  const absoluteProfile = path.resolve(profile);
  assert(absoluteProfile.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(absoluteProfile).startsWith('rpgmap-mask-raster-'));
  await rm(absoluteProfile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
