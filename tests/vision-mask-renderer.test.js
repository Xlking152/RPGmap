import test from 'node:test';
import assert from 'node:assert/strict';
import { continuousMaskBounds, createContinuousMaskRenderer, copyViewportCanvas } from '../src/vision/mask-renderer.js';

const viewport = { scaleX: 1, project: (x, y) => ({ x: 150.37 + x, y: 100.21 + y }) };

test('blend bounds include antialias padding, align to device pixels and skip offscreen circles', () => {
  for (const dpr of [1, 1.25, 1.5, 2]) {
    const bounds = continuousMaskBounds(viewport, { x: 0, y: 0 }, 20, 400, 300, dpr);
    assert.ok(bounds.x <= 128.37 && bounds.y <= 78.21);
    assert.ok(bounds.x + bounds.width >= 172.37 && bounds.y + bounds.height >= 122.21);
    for (const value of Object.values(bounds)) assert.ok(Math.abs(value * dpr - Math.round(value * dpr)) < 1e-9);
    const outside = continuousMaskBounds(viewport, { x: -1000, y: 0 }, 20, 400, 300, dpr);
    assert.equal(outside.width, 0);
    const full = continuousMaskBounds(viewport, { x: 0, y: 0 }, 1000, 400, 300, dpr);
    assert.deepEqual(full, { x: 0, y: 0, width: 400, height: 300 });
  }
});

function fakeDocument() {
  const canvases = [];
  return { canvases, createElement() {
    const context = { calls: [] };
    for (const name of ['setTransform', 'clearRect', 'beginPath', 'rect', 'arc', 'save', 'restore', 'clip',
      'fill', 'stroke', 'moveTo', 'lineTo', 'closePath', 'fillRect', 'drawImage', 'putImageData']) {
      context[name] = (...args) => context.calls.push({ name, args, composite:context.globalCompositeOperation,
        lineWidth:context.lineWidth, lineJoin:context.lineJoin });
    }
    context.getImageData = (x,y,width,height) => {
      context.calls.push({name:'getImageData',args:[x,y,width,height]});
      return {width,height,data:new Uint8ClampedArray(width*height*4)};
    };
    const canvas = { width: 300, height: 150, getContext: () => context };
    canvases.push(canvas); return canvas;
  } };
}

test('viewport copies retain fractional resampling and preserve the caller path and blend', () => {
  const document = fakeDocument(), target = document.createElement('canvas').getContext('2d');
  target.globalCompositeOperation = 'destination-in';
  for (const [width, height, dpr] of [[400, 300, 1], [400, 300, 1.25], [400, 300, 2], [401, 301, 1.25]]) {
    target.calls.length = 0;
    const canvas = { width: Math.ceil(width * dpr), height: Math.ceil(height * dpr) };
    copyViewportCanvas(target, canvas, width, height, dpr);
    const copy = target.calls.find(call => call.name === 'drawImage');
    assert.equal(copy.composite, 'destination-in');
    if (Number.isInteger(width * dpr) && Number.isInteger(height * dpr)) {
      assert.deepEqual(target.calls.map(call => call.name), ['save', 'setTransform', 'drawImage', 'restore']);
      assert.deepEqual(copy.args, [canvas, 0, 0]);
    } else assert.deepEqual(copy.args, [canvas, 0, 0, width, height]);
    assert.equal(target.calls.some(call => ['beginPath', 'clip', 'clearRect'].includes(call.name)), false);
  }
  target.calls.length = 0;
  const differentlySized = { width: 401, height: 300 };
  copyViewportCanvas(target, differentlySized, 400, 300, 1);
  assert.deepEqual(target.calls[0].args, [differentlySized, 0, 0, 400, 300]);
});

test('precise and vague masks retain two bounded frames and release their surfaces', () => {
  const document = fakeDocument(), renderer = createContinuousMaskRenderer(document);
  const target = document.createElement('canvas').getContext('2d');
  target.globalCompositeOperation = 'destination-out';
  const input = { geometry: { blocked: false, shadows: [], facades: [], illumination: { mode: 'all', regions: [] } },
    source: { x: 0, y: 0 }, radiusUnits: 20, viewport, width: 400, height: 300, dpr: 1 };
  renderer.draw(target, { ...input, key: 'vague-frame', kind: 'vague' });
  renderer.draw(target, { ...input, key: 'precise-frame', kind: 'precise' });
  renderer.draw(target, { ...input, key: 'vague-frame', kind: 'vague' });
  assert.equal(document.canvases.flatMap(canvas => canvas.getContext('2d').calls).filter(call => call.name === 'arc').length, 2);
  const copies = target.calls.filter(call => call.name === 'drawImage');
  assert.equal(copies.length, 3);
  assert.ok(copies.every(call => call.args.length === 9 && call.args[7] < 50 && call.args[8] < 50));
  assert.ok(copies.every(call=>call.args.slice(1).every(Number.isInteger)), 'aligned copies only use integer backing-pixel coordinates');
  const allocated = document.canvases.length;
  for (let index = 0; index < 20; index++) renderer.draw(target, { ...input, key: `precise-${index}`, kind: 'precise' });
  assert.equal(document.canvases.length, allocated);
  renderer.dispose();
  assert.ok(document.canvases.filter(canvas => canvas.getContext('2d') !== target).every(canvas => canvas.width === 0 && canvas.height === 0));
});

test('unchanged colored masks reuse the existing tint surface and refresh after precise lighting', () => {
  const document = fakeDocument(), renderer = createContinuousMaskRenderer(document);
  const target = document.createElement('canvas').getContext('2d');
  const input = { viewport, width: 400, height: 300, dpr: 1.25, source: { x: 0, y: 0 }, radiusUnits: 20,
    geometry: { blocked: false, shadows: [], facades: [], illumination: { mode: 'all', regions: [] } } };
  target.globalCompositeOperation = 'source-over'; target.fillStyle = 'rgba(218,226,228,0.20)';
  renderer.draw(target, { ...input, key: 'vague', kind: 'vague' });
  const colored = document.canvases[2], coloredContext = colored.getContext('2d');
  for (let i = 0; i < 10; i++) {
    target.globalCompositeOperation = 'destination-out';
    renderer.draw(target, { ...input, key: 'precise', kind: 'precise',
      geometry: { ...input.geometry, illumination: { mode: 'dark-and-normal', regions: [] } } });
    target.globalCompositeOperation = 'source-over';
    renderer.draw(target, { ...input, key: 'vague', kind: 'vague' });
  }
  assert.equal(coloredContext.calls.filter(call => call.name === 'drawImage').length, 3);
  assert.equal(coloredContext.calls.filter(call => call.name === 'fillRect').length, 2);
  assert.equal(document.canvases.length, 6, 'two sight masks reuse the existing three scratch surfaces');
  target.fillStyle = 'rgba(0,0,0,0.3)';
  renderer.draw(target, { ...input, key: 'vague', kind: 'vague' });
  assert.equal(coloredContext.calls.filter(call => call.name === 'fillRect').length, 3);
  renderer.reset();
  renderer.draw(target, { ...input, key: 'vague', kind: 'vague' });
  assert.equal(coloredContext.calls.filter(call => call.name === 'fillRect').length, 4);
  renderer.dispose();
  assert.ok(document.canvases.filter(canvas => canvas.getContext('2d') !== target).every(canvas => !canvas.width && !canvas.height));
});

test('partially offscreen circles retain the original viewport raster boundary', () => {
  const document = fakeDocument(), renderer = createContinuousMaskRenderer(document);
  const target = document.createElement('canvas').getContext('2d'); target.globalCompositeOperation = 'destination-out';
  renderer.draw(target, { key: 'edge', kind: 'precise', width: 400, height: 300, dpr: 2,
    viewport: { scaleX: 1, project: (x, y) => ({ x: 405.12 + x, y: 301.23 + y }) },
    source: { x: .5, y: .75 }, radiusUnits: 120,
    geometry: { blocked: false, shadows: [], facades: [], illumination: { mode: 'all', regions: [] } } });
  const copy = target.calls.find(call => call.name === 'drawImage');
  assert.equal(copy.args[0].width, 800); assert.equal(copy.args[0].height, 600);
  assert.equal(copy.args[1], copy.args[5]); assert.equal(copy.args[2], copy.args[6]);
  renderer.dispose();
});

test('native integer-pixel copy clips retain the caller path and reuse only two rectangles', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'Path2D'), paths = [];
  Object.defineProperty(globalThis, 'Path2D', { configurable: true, value: class {
    constructor() { paths.push(this); }
    rect(...arguments_) { this.rectangle = arguments_; }
  } });
  const document = fakeDocument(), renderer = createContinuousMaskRenderer(document);
  const target = document.createElement('canvas').getContext('2d'); target.globalCompositeOperation = 'destination-out';
  const input = { key: 'same', kind: 'precise', viewport, source: { x: 0, y: 0 }, radiusUnits: 20,
    width: 400, height: 300, dpr: 1.25,
    geometry: { blocked: false, shadows: [], facades: [], illumination: { mode: 'all', regions: [] } } };
  try {
    for (let i = 0; i < 3; i++) renderer.draw(target, input);
    assert.equal(paths.length, 1);
    assert.ok(paths[0].rectangle.every(Number.isInteger));
    assert.equal(target.calls.filter(call => call.name === 'beginPath').length, 0);
    assert.ok(target.calls.filter(call => call.name === 'drawImage').every(call => call.args.length === 3));
    for (const radiusUnits of [30, 40, 20]) renderer.draw(target, { ...input, key: `radius-${radiusUnits}`, radiusUnits });
    assert.equal(paths.length, 4, 'the oldest rectangle is discarded after two distinct bounds');
    renderer.reset(); renderer.draw(target, input);
    assert.equal(paths.length, 5, 'reset clears the clip cache');
  } finally {
    renderer.dispose();
    if (previous) Object.defineProperty(globalThis, 'Path2D', previous);
    else delete globalThis.Path2D;
  }
});

test('fractional backing dimensions preserve the full-image edge resampling path', () => {
  const document = fakeDocument(), renderer = createContinuousMaskRenderer(document);
  const target = document.createElement('canvas').getContext('2d');
  target.globalCompositeOperation = 'destination-out';
  renderer.draw(target, { key: 'fractional', kind: 'precise', viewport, source: { x: 0, y: 0 }, radiusUnits: 20,
    width: 401, height: 301, dpr: 1.25,
    geometry: { blocked: false, shadows: [], facades: [], illumination: { mode: 'all', regions: [] } } });
  const copies = target.calls.filter(call => call.name === 'drawImage');
  assert.equal(copies.length, 1);
  assert.deepEqual(copies[0].args.slice(1), [0, 0, 401, 301]);
});

test('fixed lighting union survives observer movement but refreshes for scene or viewport changes', () => {
  const document = fakeDocument(), renderer = createContinuousMaskRenderer(document);
  const target = document.createElement('canvas').getContext('2d');
  target.globalCompositeOperation = 'destination-out';
  const input = { kind: 'precise', viewport, radiusUnits: 20, width: 400, height: 300, dpr: 1,
    geometry: { blocked: false, shadows: [], facades: [], illumination: { mode: 'normal', regions: [
      { x: 10, y: 10, normalRadiusUnits: 30, radiusUnits: 60, shadows: [], blocked: false },
    ] } } };
  for (let frame = 0; frame < 5; frame++) renderer.draw(target, { ...input, key: `frame-${frame}`,
    lightingKey: 'geometry-1:lights-1:viewport-1', source: { x: frame * .5, y: 0 } });
  const lightContext = document.canvases[1].getContext('2d');
  assert.equal(lightContext.calls.filter(call => call.name === 'arc').length, 1);
  renderer.draw(target, { ...input, key: 'light-change', lightingKey: 'geometry-1:lights-2:viewport-1', source: { x: 3, y: 0 } });
  renderer.draw(target, { ...input, key: 'view-change', lightingKey: 'geometry-1:lights-2:viewport-2', source: { x: 3, y: 0 } });
  assert.equal(lightContext.calls.filter(call => call.name === 'arc').length, 3);
  renderer.reset();
  renderer.draw(target, { ...input, key: 'reset', lightingKey: 'geometry-1:lights-2:viewport-2', source: { x: 3, y: 0 } });
  assert.equal(lightContext.calls.filter(call => call.name === 'arc').length, 4);
  renderer.dispose();
});

test('overlapping ordinary shadows retain the full-viewport reference clipping and draw order', () => {
  const document=fakeDocument(),renderer=createContinuousMaskRenderer(document);
  const target=document.createElement('canvas').getContext('2d');target.globalCompositeOperation='destination-out';
  const shadows=[[[[0,0],[8,0],[8,8],[0,8]]],[[[6,0],[10,0],[10,8],[6,8]]]];
  renderer.draw(target,{key:'overlap-clip',kind:'precise',dpr:1.25,width:400,height:300,radiusUnits:30,source:{x:.2,y:.3},viewport,
    geometry:{blocked:false,shadows,facades:[],illumination:{mode:'all',regions:[]}}});
  const mask=document.canvases.at(-1).getContext('2d');
  assert.deepEqual(mask.calls.find(call=>call.name==='clearRect').args,[0,0,400,300]);
  assert.equal(mask.calls.filter(call=>call.name==='rect').length,0,'no new clip affects ordinary shadow alpha rounding');
  assert.deepEqual(mask.calls.filter(call=>call.name==='fill'&&call.composite==='destination-out').map(call=>call.args),
    [['evenodd'],['evenodd']],'original shadow order and independent rasterization are preserved');
  renderer.dispose();
});

test('facade holes share foreign-shadow boundaries and never require a pixel readback or extra surface',()=>{
  const document=fakeDocument(),renderer=createContinuousMaskRenderer(document);
  const target=document.createElement('canvas').getContext('2d');target.globalCompositeOperation='destination-out';
  const rect=(x,y,w,h)=>[[x,y],[x+w,y],[x+w,y+h],[x,y+h]];
  const geometry={blocked:false,shadows:[[rect(6,-10,4,20)]],
    facades:[{id:'building',polygons:[[rect(-10,-10,20,20),rect(-3,-3,6,6)]],otherShadowIndices:[0]}],
    illumination:{mode:'all',regions:[]}};
  const snapshot=structuredClone(geometry);
  const input={geometry,source:{x:0,y:0},radiusUnits:20,viewport,width:400,height:300,dpr:1.25,kind:'precise'};
  renderer.draw(target,{...input,key:'facade'});
  assert.equal(document.canvases.length,5,'only the existing three light/tint surfaces, target and sight mask are allocated');
  const mask=document.canvases.at(-1).getContext('2d');
  assert.deepEqual(mask.calls.filter(call=>call.name==='fill').map(call=>[call.composite,call.args]),
    [['source-over',[]],['destination-out',['evenodd']],['source-over',['evenodd']]]);
  assert.deepEqual(renderer.cacheStats(),{objects:1,versions:1,vertices:8},'outer boundary and original hole share one cached component');
  const readbacks=()=>document.canvases.flatMap(canvas=>canvas.getContext('2d').calls).filter(call=>call.name==='getImageData');
  assert.equal(readbacks().length,0);
  const allocated=document.canvases.length;
  renderer.draw(target,{...input,key:'zoomed',viewport:{scaleX:2,project:(x,y)=>({x:150.37+x*2,y:100.21+y*2})}});
  assert.equal(document.canvases.length,allocated);assert.deepEqual(renderer.cacheStats(),{objects:1,versions:1,vertices:8});
  assert.equal(readbacks().length,0);assert.deepEqual(geometry,snapshot);
  renderer.reset();assert.deepEqual(renderer.cacheStats(),{objects:0,versions:0,vertices:0});
  renderer.dispose();
});

test('darkvision and normal-light passes reuse one prepared exterior mask',()=>{
  const document=fakeDocument(),renderer=createContinuousMaskRenderer(document);
  const target=document.createElement('canvas').getContext('2d');target.globalCompositeOperation='destination-out';
  const wall=[[[4,-1],[6,-1],[6,1],[4,1]]];
  const geometry={blocked:false,shadows:[wall],facades:[{id:'building',polygons:[[[[0,-10],[10,-10],[10,10],[0,10]]]],otherShadowIndices:[0]}],
    illumination:{mode:'dark-and-normal',regions:[{x:0,y:0,radiusUnits:30,normalRadiusUnits:15,shadows:[wall]}]}};
  renderer.draw(target,{key:'dark-facade',kind:'precise',geometry,viewport,source:{x:0,y:0},radiusUnits:20,width:400,height:300,dpr:1});
  assert.deepEqual(renderer.cacheStats(),{objects:1,versions:1,vertices:8});
  assert.equal(document.canvases.flatMap(canvas=>canvas.getContext('2d').calls).filter(call=>call.name==='getImageData').length,0);
  assert.ok(document.canvases.flatMap(canvas=>canvas.getContext('2d').calls).some(call=>call.name==='drawImage'&&call.composite==='destination-in'));
  renderer.dispose();
});

test('facade cache remains local to each viewer and retains only two geometry versions per object',()=>{
  const make=()=>{const document=fakeDocument(),renderer=createContinuousMaskRenderer(document);
    const target=document.createElement('canvas').getContext('2d');target.globalCompositeOperation='destination-out';return{document,renderer,target};};
  const a=make(),b=make();
  const geometry=shift=>({blocked:false,shadows:[[[[4+shift,-10],[6+shift,-10],[6+shift,10],[4+shift,10]]]],
    facades:[{id:'same-object',polygons:[[[[0,-10],[10,-10],[10,10],[0,10]]]],otherShadowIndices:[0]}],illumination:{mode:'all',regions:[]}});
  const input={viewport,source:{x:0,y:0},radiusUnits:20,width:400,height:300,dpr:1,kind:'precise'};
  for(let frame=0;frame<5;frame++)a.renderer.draw(a.target,{...input,key:`a-${frame}`,geometry:geometry(frame*.1)});
  b.renderer.draw(b.target,{...input,key:'b',geometry:geometry(-2)});
  assert.deepEqual(a.renderer.cacheStats(),{objects:1,versions:2,vertices:16});
  assert.deepEqual(b.renderer.cacheStats(),{objects:1,versions:1,vertices:8});
  const exterior=context=>context.calls.filter(call=>call.composite==='source-over'&&call.name==='lineTo').map(call=>call.args);
  assert.notDeepEqual(exterior(a.document.canvases.at(-1).getContext('2d')),exterior(b.document.canvases.at(-1).getContext('2d')));
  a.renderer.reset();assert.deepEqual(a.renderer.cacheStats(),{objects:0,versions:0,vertices:0});
  assert.deepEqual(b.renderer.cacheStats(),{objects:1,versions:1,vertices:8});
  a.renderer.dispose();b.renderer.dispose();assert.deepEqual(b.renderer.cacheStats(),{objects:0,versions:0,vertices:0});
});

test('facade cache evicts beyond 512 objects and releases all derived data on dispose',()=>{
  const document=fakeDocument(),renderer=createContinuousMaskRenderer(document);
  const target=document.createElement('canvas').getContext('2d');target.globalCompositeOperation='destination-out';
  const polygon=[[[0,-10],[10,-10],[10,10],[0,10]]];
  const geometry={blocked:false,shadows:[[[[4,-10],[6,-10],[6,10],[4,10]]]],
    facades:Array.from({length:513},(_,index)=>({id:`building-${index}`,polygons:[polygon],otherShadowIndices:[0]})),
    illumination:{mode:'all',regions:[]}};
  renderer.draw(target,{key:'many-facades',kind:'precise',geometry,viewport,source:{x:0,y:0},radiusUnits:20,width:400,height:300,dpr:1});
  assert.deepEqual(renderer.cacheStats(),{objects:512,versions:512,vertices:4096});
  renderer.dispose();assert.deepEqual(renderer.cacheStats(),{objects:0,versions:0,vertices:0});
  assert.ok(document.canvases.filter(canvas=>canvas.getContext('2d')!==target).every(canvas=>canvas.width===0&&canvas.height===0));
});
