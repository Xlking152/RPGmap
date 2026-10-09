import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import polygonClipping from 'polygon-clipping';
import { prepareMapPackage } from '../src/map-package/contract.js';
import { applyLanzhouCapabilities } from '../reference/maps/lanzhou/capabilities.js';
import { createDamagePreview, deriveSceneState } from '../src/engine/state.js';
import { pointInPolygon } from '../src/engine/geometry.js';
import { deriveVisionOccluders, normalizeVisionOccluder, perceptionLevelAtPoint } from '../src/spatial/kernel.js';
import { projectVisionOcclusion } from '../src/vision/ground-shadow.js';
import { computeContinuousVisibility } from '../src/vision/continuous.js';
import { projectVisionOcclusion as legacyProjection } from './fixtures/ground-shadow-before-row-optimization.js';

const rect = (x, y, width, height) => [[x,y],[x+width,y],[x+width,y+height],[x,y+height]];
const observer = (x = 0, y = 0, elevationMeters = 0) => ({ x, y, elevationMeters,
  placement: 'map', tokenId: 'repro', preciseRangeMeters: 1000, vagueRangeMeters: 1000 });
const facadeVisible = (projection, point) => projection.facades.some(facade => pointInPolygon(point, facade.polygons)
  && !(facade.otherShadowIndices || []).some(index => pointInPolygon(point, projection.shadows[index])));

test('facade alpha inputs preserve the old visible exterior for holes, fragments, heights and foreign shadows', () => {
  const near = { id:'near', kind:'wall', polygon:rect(4,-1,2,2), blockingHeightMeters:6 };
  const shapes = [
    { id:'rect', kind:'building', polygon:rect(8,-5,3,10), blockingHeightMeters:6 },
    { id:'concave', kind:'building', polygon:[[8,-5],[14,-5],[14,-2],[10,-2],[10,5],[8,5]], blockingHeightMeters:6 },
    { id:'hole', kind:'building', polygon:rect(8,-5,8,10), polygons:[[rect(8,-5,8,10),rect(10,-2,4,4)]], blockingHeightMeters:6 },
    { id:'fragments', kind:'building', polygon:rect(8,-5,3,10), polygons:[[rect(8,-5,3,3)],[rect(8,2,3,3)]], blockingHeightMeters:6 },
  ];
  for (const raw of shapes) for (const elevationMeters of [0,3,15]) {
    const input = { source:observer(0,0,elevationMeters), radiusUnits:30,
      occluders:Object.freeze([near,raw].map(normalizeVisionOccluder)) };
    assert.ok(input.occluders.every(Boolean), `${raw.id} must exercise real normalized occlusion`);
    if (raw.id === 'fragments') assert.equal(input.occluders[1].polygons.length, 2);
    const actual = projectVisionOcclusion(input), expected = legacyProjection(input);
    assert.deepEqual(actual.shadows, expected.shadows, 'visibility shadows are independent of exterior drawing');
    assert.equal(actual.blocked, expected.blocked);
    assert.equal(actual.fallback, expected.fallback);
    for (const facade of actual.facades) {
      const obstacle = input.occluders.find(value=>value.id===facade.id);
      assert.strictEqual(facade.polygons, obstacle.polygons, 'no copied or clipped facade geometry');
      assert.ok(facade.otherShadowIndices.every(index=>Number.isSafeInteger(index)&&index>=0&&index<actual.shadows.length));
      assert.equal(new Set(facade.otherShadowIndices).size, facade.otherShadowIndices.length);
    }
    for (let y=-6.13;y<6;y+=.3) for (let x=7.17;x<17;x+=.3) {
      assert.equal(facadeVisible(actual,[x,y]),facadeVisible(expected,[x,y]),`exterior sample ${raw.id} ${x},${y} z=${elevationMeters}`);
    }
  }
});

test('facades never alter private target perception or share host exemption with an outside observer', () => {
  const blockers = Object.freeze([normalizeVisionOccluder({id:'house',kind:'building',polygon:rect(8,-5,3,10),blockingHeightMeters:6})]);
  const source = observer();
  const projection = projectVisionOcclusion({source,radiusUnits:30,occluders:blockers});
  assert.equal(facadeVisible(projection,[9,0]),true);
  assert.equal(perceptionLevelAtPoint({vision:source,target:{x:9,y:0},occluders:blockers,lineOfSightEnabled:true}),'none');
  assert.equal(perceptionLevelAtPoint({vision:source,target:{x:15,y:0},occluders:blockers,lineOfSightEnabled:true}),'none');
  assert.deepEqual(projectVisionOcclusion({source,radiusUnits:30,occluders:blockers,includeFacades:false}).facades,[]);
});

test('the saved destruction edge and projected foreign shadows reproduce the SweepEvent defect without boolean facade work', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/vision-facade-sweep-regression.json',import.meta.url),'utf8'));
  const closed = polygons=>polygons.map(rings=>rings.map(ring=>[...ring,ring[0]]));
  assert.throws(()=>polygonClipping.difference(closed(fixture.facade.polygons),closed(fixture.shadows)),/SweepEvent/,
    'fixed original floating-point operands must continue to expose the library failure');
  assert.equal(fixture.facade.id,'granary-02');
  assert.ok(fixture.facade.otherShadowIndices.length>0);
  // The renderer receives the unchanged facade and indices. No geometric
  // difference is required to determine a non-boundary alpha sample.
  let visible = 0, hidden = 0;
  const points=fixture.facade.polygons.flat(2), xs=points.map(point=>point[0]), ys=points.map(point=>point[1]);
  for(let y=Math.min(...ys)+.123;y<Math.max(...ys);y+=2) for(let x=Math.min(...xs)+.321;x<Math.max(...xs);x+=2) {
    if(!pointInPolygon([x,y],fixture.facade.polygons)) continue;
    if(facadeVisible({facades:[fixture.facade],shadows:fixture.shadows},[x,y])) visible++;
    else hidden++;
  }
  assert.ok(visible>0&&hidden>0,'the failing exterior has both exposed and foreign-shadow portions');
});

test('Lanzhou circular destruction updates observer and light contours without a SweepEvent exception', () => {
  const runtime = JSON.parse(readFileSync(new URL('../reference/maps/lanzhou/runtime.json',import.meta.url),'utf8'));
  const map = prepareMapPackage({...runtime,svg:'<svg></svg>',features:applyLanzhouCapabilities(runtime.features)});
  const area = { id:'repro-area',shape:'circle',center:{x:3581.491689174436,y:1553.9528916589916},radius:206.80454093031585 };
  const preview = createDamagePreview(area,map.features);
  assert.ok(preview.clipHits.length>0,'reproduction retains partially destroyed building edges');
  const derived = deriveSceneState([{id:'repro-damage',type:'damage',objectIds:preview.objectIds,clipHits:preview.clipHits}]);
  const occluders = deriveVisionOccluders(map,null,derived);
  const source = observer(3628.528142813593,1242.984768981114);
  for (const offset of [0,.25,2.5]) {
    const moved = {...source,x:source.x+offset};
    const result = computeContinuousVisibility({source:moved,map,occluders,lights:[],ignoresOcclusion:false});
    assert.equal(result.blocked,false);
    assert.equal(result.fallback,false);
    assert.ok(result.facades.length>0&&result.shadows.length>0);
    assert.doesNotThrow(()=>structuredClone(result),'the Worker result is plain transferable data');
  }
  const lights = Object.freeze([{...source,id:'repro-light',rangeMeters:1000,intensity:1}]);
  const dim = computeContinuousVisibility({source:{...source,lighting:'dim'},map,occluders,lights,ignoresOcclusion:true});
  assert.equal(dim.illumination.mode,'normal');
  assert.equal(dim.illumination.regions.length,1);
  assert.ok(dim.illumination.regions[0].shadows.length>0,'light still obeys damaged walls while skipping exterior calculations');
  assert.deepEqual(computeContinuousVisibility({source,map,occluders:deriveVisionOccluders(map),lights:[],ignoresOcclusion:false}).illumination,
    {mode:'all',regions:[]},'restored geometry returns to the ordinary lighting path');
});
