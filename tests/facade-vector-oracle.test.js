import test from 'node:test';
import assert from 'node:assert/strict';
import { referenceVisibleRegions, vectorBoundaryDistanceCss, circleChordErrorCss,
  referenceOpacityEdges, ORACLE_CIRCLE_SEGMENTS } from './fixtures/facade-vector-oracle.js';

const rect = (left,top,right,bottom) => [[left,top],[right,top],[right,bottom],[left,bottom]];
const projection = () => ({blocked:false,shadows:[],facades:[]});
const source = {x:0,y:0};
const bounds = polygons => {
  const points=polygons.flat(2);
  return {left:Math.min(...points.map(point=>point[0])),right:Math.max(...points.map(point=>point[0])),
    top:Math.min(...points.map(point=>point[1])),bottom:Math.max(...points.map(point=>point[1]))};
};
const near = (actual,expected) => assert(Math.abs(actual-expected)<1e-9,`${actual} != ${expected}`);

test('final visible boundary excludes edges buried inside overlapping shadows', () => {
  const value=projection();value.shadows=[[rect(-2,-2,2,2)],[rect(0,-2,4,2)]];
  const snapshot=structuredClone(value);
  const visible=referenceVisibleRegions(value,source,10,'all',[]);
  near(vectorBoundaryDistanceCss(visible,0,0),2);
  near(vectorBoundaryDistanceCss(visible,3,0),1);
  assert.deepEqual(value,snapshot,'QA boolean operands must not mutate the render fixture');
});

test('facade holes retain their final hidden boundary and fragments remain separate', () => {
  const value=projection();value.shadows=[[rect(-6,-6,6,6)]];
  value.facades=[{polygons:[[rect(-4,-4,4,4),rect(-1,-1,1,1)],[rect(7,-1,8,1)]]}];
  const visible=referenceVisibleRegions(value,source,10,'all',[]);
  near(vectorBoundaryDistanceCss(visible,0,0),1);
  near(vectorBoundaryDistanceCss(visible,2,0),1);
  near(vectorBoundaryDistanceCss(visible,5,0),1);
});

test('fractional backing dimensions apply two final copies to the base circle', () => {
  const viewport={center:[50,60],scale:2,width:401,height:301,dpr:1.25};
  const qx=401*1.25/Math.ceil(401*1.25),qy=301*1.25/Math.ceil(301*1.25);
  const actual=bounds(referenceVisibleRegions(projection(),source,10,'all',[],viewport));
  near(actual.left,(50-20)*qx**2);near(actual.right,(50+20)*qx**2);
  near(actual.top,(60-20)*qy**2);near(actual.bottom,(60+20)*qy**2);
});

test('normal lighting follows its two light copies plus two final copies', () => {
  const viewport={center:[50,60],scale:2,width:401,height:301,dpr:1.25};
  const qx=401*1.25/Math.ceil(401*1.25),qy=301*1.25/Math.ceil(301*1.25);
  const region={x:0,y:0,radiusUnits:5,normalRadiusUnits:2,shadows:[]};
  const actual=bounds(referenceVisibleRegions(projection(),source,10,'normal',[region],viewport));
  near(actual.left,(50-4)*qx**4);near(actual.right,(50+4)*qx**4);
  near(actual.top,(60-4)*qy**4);near(actual.bottom,(60+4)*qy**4);
});

test('low-light lit mode uses the full illumination radius rather than normal-light radius', () => {
  const region={x:0,y:0,radiusUnits:5,normalRadiusUnits:2,shadows:[]};
  const actual=bounds(referenceVisibleRegions(projection(),source,10,'lit',[region]));
  near(actual.left,-5);near(actual.right,5);near(actual.top,-5);near(actual.bottom,5);
});

test('dark-and-normal component uses three geometry copies and five normal-light copies', () => {
  const viewport={center:[50,60],scale:2,width:401,height:301,dpr:1.25};
  const qx=401*1.25/Math.ceil(401*1.25),qy=301*1.25/Math.ceil(301*1.25);
  // A large light covers all darkness, leaving only the normal-light island.
  const region={x:0,y:0,radiusUnits:100,normalRadiusUnits:2,shadows:[]};
  const actual=bounds(referenceVisibleRegions(projection(),source,10,'dark-and-normal',[region],viewport));
  near(actual.left,(50-4)*qx**5);near(actual.right,(50+4)*qx**5);
  near(actual.top,(60-4)*qy**5);near(actual.bottom,(60+4)*qy**5);
});

test('blocked geometry and absent illumination cannot invent visible boundaries', () => {
  assert.deepEqual(referenceVisibleRegions({...projection(),blocked:true},source,10,'all',[]),[]);
  assert.deepEqual(referenceVisibleRegions(projection(),source,10,'normal',[]),[]);
  assert.equal(vectorBoundaryDistanceCss([],0,0),Infinity);
});

test('circle approximation has a conservative CSS error bound below 0.00013 at the largest fixture scale', () => {
  assert.equal(ORACLE_CIRCLE_SEGMENTS,2048);
  const error=circleChordErrorCss(30,3.5);
  assert(error>0&&error<0.00013);
  near(error,105-105*Math.cos(Math.PI/2048));
});

test('partial-opacity operand edges preserve real compositing seams without moving the binary hidden boundary', () => {
  const value=projection();value.shadows=[[rect(-2,-2,2,2)],[rect(0,-2,4,2)]];
  const visible=referenceVisibleRegions(value,source,10,'all',[]);
  const opacity=referenceOpacityEdges(value,source,10,'all',[]);
  near(vectorBoundaryDistanceCss(visible,0,0),2);
  near(vectorBoundaryDistanceCss(opacity,0,0),0);
  // The raster checker uses the former for old alpha 0/255 and only permits
  // the latter for measured old partial alpha. Buried opaque shadow edges
  // therefore cannot excuse exposed black interiors.
});

test('reference opacity seams retain separate dark-normal geometry and lighting copy counts', () => {
  const viewport={center:[50,60],scale:2,width:401,height:301,dpr:1.25};
  const qx=401*1.25/Math.ceil(401*1.25),qy=301*1.25/Math.ceil(301*1.25);
  const value=projection(),region={x:0,y:0,radiusUnits:5,normalRadiusUnits:2,shadows:[]};
  const edges=referenceOpacityEdges(value,source,10,'dark-and-normal',[region],viewport);
  assert.equal(edges.length,4,'base, extra tint, full light and normal light are distinct opacity operands');
  const [base,tint,full,normal]=edges.map(polygons=>bounds([polygons]));
  near(base.right,70*qx**2);near(tint.right,70*qx**3);
  near(full.right,60*qx**4);near(normal.right,54*qx**5);
  near(base.top,40*qy**2);near(tint.top,40*qy**3);
  near(full.top,50*qy**4);near(normal.top,56*qy**5);
});
