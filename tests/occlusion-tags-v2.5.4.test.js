import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareMapPackage } from '../src/map-package/contract.js';
import { applyLanzhouCapabilities } from '../reference/maps/lanzhou/capabilities.js';
import { normalizeOcclusionShape, normalizeOcclusionShapes, resolveEffectiveOcclusionShapes } from '../src/vision/occlusion-model.js';
import { deriveVisionOccluders, normalizeVisionOccluder, inspectLineOfSight, resolveSourceHostOccluderId,
  visionOccludersForSource, perceptionLevelAtPoint, lightContributionAtPoint } from '../src/spatial/kernel.js';
import { projectVisionOcclusion } from '../src/vision/ground-shadow.js';
import { exploreFogVisibleCircle, exploreFogVisibleSweep, computeFogExploration, computeFogExplorationAsync,
  exploreFogCircle, isFogCellExplored } from '../src/vision/fog.js';
import { pointInPolygon } from '../src/engine/geometry.js';

const rect = (x, y, w, h) => [[x,y],[x+w,y],[x+w,y+h],[x,y+h]];
const feature = (id, polygon, height = 6, overrides = {}) => ({ id, category:'building',
  geometry:{type:'polygon',points:polygon}, capabilities:{navigation:{blocks:true,collisionGroup:'structure',
    blockingHeightMeters:height,passableWhenDestroyed:true},...overrides} });
const mapWith = (features = [], shapes = []) => prepareMapPackage({ id:'tags-test',version:'1',width:100,height:100,
  svg:'<svg></svg>',layers:['structure'],features,occlusionShapes:shapes });
const ray = occluders => inspectLineOfSight({ from:{x:0,y:0}, to:{x:12,y:0}, occluders }).clear;
const source = (x, y, z = 0) => ({ tokenId:'source',placement:'map',x,y,elevationMeters:z,
  preciseRangeMeters:100,vagueRangeMeters:100 });

test('shared shape validation rejects malformed geometry, ID collisions and ambiguous bindings', () => {
  const raw = {id:'shape-a',kind:'wall',points:rect(1,1,4,4)};
  const normalized = normalizeOcclusionShape(raw);
  assert.equal(normalized.blockingHeightMeters,null);
  assert.equal(Object.isFrozen(normalized.points[0]),true);
  assert.throws(()=>normalizeOcclusionShape({...raw,points:[[1,1],[5,5],[1,5],[5,1]]}),/self-intersecting/);
  assert.throws(()=>normalizeOcclusionShape({...raw,points:rect(1,1,0,4)}),/duplicate|zero/);
  assert.throws(()=>normalizeOcclusionShape({...raw,blockingHeightMeters:Infinity}),/height/);
  assert.throws(()=>normalizeOcclusionShapes([raw,raw]),/unique/);
  const map=mapWith([feature('building',rect(4,-4,2,8))]);
  assert.throws(()=>resolveEffectiveOcclusionShapes(map,{occlusionShapes:[{...raw,featureId:'missing'}]}),/unknown Feature/);
  assert.throws(()=>resolveEffectiveOcclusionShapes(map,{occlusionShapes:[{...raw,featureId:'building'},
    {...raw,id:'shape-b',featureId:'building'}]}),/Multiple/);
});

test('map default shapes and Scene overrides remain independent and survive JSON save reload', () => {
  const base = {id:'wall',kind:'wall',points:rect(4,-2,2,4)};
  const map = mapWith([], [base]);
  const scene = {occlusionShapes:[{...base,enabled:false},{id:'local',kind:'wall',points:rect(8,-2,2,4)}]};
  assert.equal(resolveEffectiveOcclusionShapes(map,scene).length,2);
  assert.equal(deriveVisionOccluders(map,scene).length,1);
  assert.deepEqual(deriveVisionOccluders(map,JSON.parse(JSON.stringify(scene))),deriveVisionOccluders(map,scene));
  assert.equal(map.occlusionShapes[0].enabled,true);
  assert.equal(deriveVisionOccluders(map)[0].id,'wall');
});

test('unavailable external maps retain fallback projection and independent Scene occlusion geometry', () => {
  assert.deepEqual(resolveEffectiveOcclusionShapes(null, {}), []);
  assert.deepEqual(deriveVisionOccluders(null, {}), []);
  assert.deepEqual(deriveVisionOccluders(undefined, null), []);
  const scene = { occlusionShapes: [{ id: 'outline', kind: 'building', featureId: 'external-house', points: rect(4,-2,2,4) }] };
  const blockers = deriveVisionOccluders(null, scene);
  assert.equal(blockers.length, 1);
  assert.equal(ray(blockers), false);
  // Providing a loaded map restores strict reference validation.
  assert.throws(() => deriveVisionOccluders({ features: [] }, scene), /unknown Feature/);
});

test('explicit tags, Scene overrides, finite-height edits and unbounded height share one LOS model', () => {
  const raw=feature('house',rect(4,-2,2,4),6);
  const map=mapWith([raw]);
  assert.equal(ray(deriveVisionOccluders(map)),false);
  assert.equal(ray(deriveVisionOccluders(map,{featureStates:{house:{vision:{occluder:false}}}})),true);
  const overridden=deriveVisionOccluders(map,{featureStates:{house:{custom:{blockingHeightMeters:40}}}});
  assert.equal(overridden[0].blockingHeightMeters,40);
  assert.equal(deriveVisionOccluders(map,{featureStates:{house:{vision:{blockingHeightMeters:'unbounded'}}}})[0].blockingHeightMeters,Infinity);
  const disabled=mapWith([feature('house',raw.geometry.points,6,{vision:{occluder:false}})]);
  assert.equal(deriveVisionOccluders(disabled).length,0);
  assert.equal(deriveVisionOccluders(disabled,{featureStates:{house:{vision:{occluder:true}}}}).length,1);
  const infinite=deriveVisionOccluders(mapWith([feature('house',raw.geometry.points,null)]));
  assert.equal(infinite[0].blockingHeightMeters,Infinity);
  assert.equal(normalizeVisionOccluder(JSON.parse(JSON.stringify(infinite[0]))).blockingHeightMeters,Infinity);
  assert.equal(inspectLineOfSight({from:{x:0,y:0,elevationMeters:1000},to:{x:12,y:0,elevationMeters:1000},occluders:infinite}).clear,false);
  const declaredFalse=applyLanzhouCapabilities([{...raw,capabilities:{...raw.capabilities,vision:{occluder:false}}}]);
  assert.equal(mapWith(declaredFalse).features[0].capabilities.vision,null);
});

test('binding a shape replaces its Feature geometry and retains destruction and tag overrides', () => {
  const map=mapWith([feature('house',rect(4,-2,2,4))]);
  const scene={occlusionShapes:[{id:'outline',kind:'building',featureId:'house',points:rect(8,-2,2,4)}]};
  const values=deriveVisionOccluders(map,scene);
  assert.equal(values.length,1);
  assert.equal(values[0].id,'house');
  assert.equal(inspectLineOfSight({from:{x:0,y:0},to:{x:7,y:0},occluders:values}).clear,true);
  assert.equal(ray(values),false);
  assert.equal(deriveVisionOccluders(map,scene,{destroyedObjectIds:['house']}).length,0);
  assert.equal(deriveVisionOccluders(map,{...scene,featureStates:{house:{vision:{occluder:false}}}}).length,0);
});

test('open and destroyed drawn doors cut host apertures; closed doors restore their own finite blocker', () => {
  const map=mapWith([], [{id:'host',kind:'building',points:rect(4,-6,4,12),blockingHeightMeters:10},
    {id:'door',kind:'door',hostShapeId:'host',points:rect(3,-1,6,2),blockingHeightMeters:3}]);
  assert.equal(ray(deriveVisionOccluders(map)),false);
  const open=deriveVisionOccluders(map,{featureStates:{door:{open:true}}});
  assert.equal(ray(open),true);
  assert.equal(inspectLineOfSight({from:{x:0,y:3},to:{x:12,y:3},occluders:open}).clear,false);
  const transparent = deriveVisionOccluders(map,{featureStates:{door:{open:false,vision:{occluder:false}}}});
  assert.equal(ray(transparent),true);
  assert.equal(inspectLineOfSight({from:{x:0,y:3},to:{x:12,y:3},occluders:transparent}).clear,false);
  assert.equal(ray(deriveVisionOccluders(map,null,{destroyedObjectIds:['door']})),true);
  const partial=deriveVisionOccluders(map,null,{clipHits:[{featureId:'door',polygon:rect(2,-0.25,8,0.5)}]});
  assert.equal(ray(partial),true);
  assert.equal(inspectLineOfSight({from:{x:0,y:0.75},to:{x:12,y:0.75},occluders:partial}).clear,false);
  assert.equal(inspectLineOfSight({from:{x:0,y:0,elevationMeters:4},to:{x:12,y:0,elevationMeters:4},occluders:deriveVisionOccluders(map)}).clear,true);
});

test('host exclusion is source scoped, strictly interior and deterministic for overlaps and heights', () => {
  const building=(id,polygon,polygons)=>normalizeVisionOccluder({id,kind:'building',polygon,polygons,blockingHeightMeters:6});
  const large=building('large',rect(2,2,20,20)), small=building('small',rect(4,4,4,4));
  const values=Object.freeze([large,small]);
  assert.equal(resolveSourceHostOccluderId(source(5,5),values),'small');
  assert.deepEqual(visionOccludersForSource(source(5,5),values).map(value=>value.id),['large']);
  assert.equal(values.length,2);
  assert.equal(resolveSourceHostOccluderId({x:5,y:5},values),null);
  assert.equal(resolveSourceHostOccluderId({...source(5,5),placement:'feature'},values),null);
  assert.equal(resolveSourceHostOccluderId(source(5,5,7),values),null);
  assert.equal(resolveSourceHostOccluderId(source(4,5),[small]),null);
  const hole=building('hole',rect(0,0,20,20),[[rect(0,0,20,20),rect(4,4,4,4)]]);
  assert.equal(resolveSourceHostOccluderId(source(5,5),[hole]),null);
  assert.equal(resolveSourceHostOccluderId(source(3,3),[hole]),'hole');
  assert.equal(resolveSourceHostOccluderId(source(5,5),[building('b',rect(4,4,4,4)),building('a',rect(4,4,4,4))]),'a');
});

test('equal-area host IDs have a fixed order across browser and server locales', () => {
  const building = (id, offset) => normalizeVisionOccluder({ id, kind: 'building',
    polygon: rect(offset, 2, 8, 8), blockingHeightMeters: 6 });
  for (const [left, right, expected] of [['a', 'Z', 'Z'], ['ä', 'z', 'z'], ['乙', '丁', '丁']]) {
    const values = [building(left, 2), building(right, 3)];
    assert.equal(resolveSourceHostOccluderId(source(5, 5), values), expected);
    assert.equal(resolveSourceHostOccluderId(source(5, 5), [...values].reverse()), expected);
    const remaining = visionOccludersForSource(source(5, 5), Object.freeze(values));
    assert.equal(remaining.length, 1);
    assert.notEqual(remaining[0].id, expected);
  }
});

test('host immunity lets the inside character see out, while outsiders, target hosts and light rays still block', () => {
  const values=deriveVisionOccluders(mapWith([feature('host',rect(4,4,4,4))]));
  const vision=source(5,5);
  assert.equal(perceptionLevelAtPoint({vision,target:{x:12,y:5},occluders:values,lineOfSightEnabled:true}), 'precise');
  assert.equal(perceptionLevelAtPoint({vision:source(12,5),target:{x:5,y:5},occluders:values,lineOfSightEnabled:true}), 'none');
  assert.equal(lightContributionAtPoint({x:12,y:5},[{x:5,y:5,rangeMeters:20,intensity:1}],{occluders:values}),0);
  assert.equal(perceptionLevelAtPoint({vision,target:{x:12,y:5},ambient:'dark',lights:[{x:5,y:5,rangeMeters:20}],
    occluders:values,lineOfSightEnabled:true}),'vague');
});

test('prepared source blockers match independent rays without granting the same exemption to lights', () => {
  const values=Object.freeze(deriveVisionOccluders(mapWith([
    feature('host',rect(4,4,4,4)), feature('other',rect(15,0,2,20)),
  ])));
  const lights=[{x:5,y:5,rangeMeters:100,intensity:1,occlusion:'scene'}];
  for(const vision of [source(5,5),source(4,5),source(12,5),source(5,5,7)]) {
    const sourceOccluders=visionOccludersForSource(vision,values);
    for(const ambient of ['normal','dim','dark']) for(const target of [
      {x:12,y:5},{x:20,y:5},{x:6,y:6},{x:12,y:5,elevationMeters:8},
    ]) {
      const input={vision,target,ambient,lights,occluders:values,lineOfSightEnabled:true};
      assert.equal(perceptionLevelAtPoint({...input,sourceOccluders}),perceptionLevelAtPoint(input));
    }
  }
  assert.equal(perceptionLevelAtPoint({vision:source(5,5),target:{x:12,y:5},ambient:'dark',lights,
    occluders:values,sourceOccluders:visionOccludersForSource(source(5,5),values),lineOfSightEnabled:true}),'vague');
});

test('Fog sweeps resolve the host at every preserved 2.5 metre sample and match a union of circles', () => {
  const map=mapWith([feature('host',rect(5,0,5,15))]);
  const occluders=Object.freeze(deriveVisionOccluders(map)), from={x:7.5,y:7.5},to={x:22.5,y:7.5};
  let expected={};
  for(let i=0;i<=6;i++) expected=exploreFogVisibleCircle(expected,'party',{x:7.5+i*2.5,y:7.5,radiusMeters:8},map,
    {occluders,allowHostExemption:true});
  const sweep=exploreFogVisibleSweep({},'party',from,to,8,map,{occluders,allowHostExemption:true});
  assert.deepEqual(sweep,expected);
  assert.equal(isFogCellExplored(sweep,'party',{x:2.5,y:7.5}),true);
  assert.equal(isFogCellExplored(exploreFogVisibleSweep({},'party',from,to,8,map,{occluders}),'party',{x:2.5,y:7.5}),false);
  assert.deepEqual(computeFogExploration({partyId:'party',payload:{from,to,radiusMeters:8,visionSourceTokenId:'source'},
    map,occluders,lineOfSightEnabled:true}),expected);
});

test('continuous shadows preserve exact finite heights, boundary fallback and only visible facade portions', () => {
  const near=normalizeVisionOccluder({id:'near',kind:'building',polygon:rect(4,-1,2,2),blockingHeightMeters:6});
  const far=normalizeVisionOccluder({id:'far',kind:'building',polygon:rect(8,-5,2,10),blockingHeightMeters:6});
  const projection=projectVisionOcclusion({source:source(0,0),radiusUnits:30,occluders:[near,far]});
  assert.equal(projection.fallback,false);
  assert.equal(projection.shadows.some(rings=>pointInPolygon([12,0],rings)),true);
  const facade=projection.facades.find(value=>value.id==='far');
  assert.ok(facade);
  assert.equal(pointInPolygon([9,0],facade.polygons),false);
  assert.equal(pointInPolygon([9,4],facade.polygons),true);
  const hidden=normalizeVisionOccluder({id:'hidden',kind:'building',polygon:rect(8,-0.5,2,1),blockingHeightMeters:6});
  assert.equal(projectVisionOcclusion({source:source(0,0),radiusUnits:30,occluders:[near,hidden]}).facades.some(value=>value.id==='hidden'),false);
  assert.equal(projectVisionOcclusion({source:source(4,0),radiusUnits:30,occluders:[near]}).fallback,true);
  assert.equal(projectVisionOcclusion({source:{x:5,y:0},radiusUnits:30,occluders:[near]}).blocked,true);
  assert.equal(projectVisionOcclusion({source:source(5,0),radiusUnits:30,occluders:[near]}).blocked,false);
  const elevated=projectVisionOcclusion({source:source(0,0,30),radiusUnits:30,occluders:[near]});
  assert.equal(elevated.shadows.some(rings=>pointInPolygon([12,0],rings)),false);
});

test('durable sphere-range input recomputes every elevated sample while legacy radius remains a ground radius', async () => {
  const map=mapWith(), from={x:30,y:30,elevationMeters:0},to={x:40,y:30,elevationMeters:18};
  for(const lineOfSightEnabled of [true,false]) {
    const input={partyId:'party',payload:{from,to,radiusMeters:20,visionSourceTokenId:'source'},map,occluders:[],
      lineOfSightEnabled,sourceRangeMeters:20};
    let expected={};
    for(let i=0;i<=4;i++) {
      const ratio=i/4, elevationMeters=18*ratio;
      const circle={x:30+10*ratio,y:30,elevationMeters,radiusMeters:Math.sqrt(400-elevationMeters**2)};
      expected=(lineOfSightEnabled ? exploreFogVisibleCircle : exploreFogCircle)(expected,'party',circle,map,
        {sourceElevationMeters:elevationMeters,occluders:[]});
    }
    assert.deepEqual(computeFogExploration(input),expected);
    assert.deepEqual(await computeFogExplorationAsync(input),expected);
    const legacy={...input}; delete legacy.sourceRangeMeters;
    assert.notDeepEqual(computeFogExploration(legacy),expected);
    const circleInput={...input,payload:{x:40,y:30,elevationMeters:18,radiusMeters:20}};
    assert.deepEqual(computeFogExploration(circleInput),(lineOfSightEnabled ? exploreFogVisibleCircle : exploreFogCircle)({},'party',
      {...circleInput.payload,radiusMeters:Math.sqrt(400-18**2)},map,{sourceElevationMeters:18,occluders:[]}));
  }
});
