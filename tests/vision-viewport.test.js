import test from 'node:test';
import assert from 'node:assert/strict';
import { createVisionViewport, visionZoomTransform } from '../src/vision/viewport.js';

test('fractional zoom and pan preserve continuous world projection without pixel rounding', () => {
  for (let zoom = -4; zoom <= 5; zoom += 0.25) for (const pan of [0, 13.375, -211.2]) {
    const scale = 2 ** zoom;
    const map = { getZoom: () => zoom, getPixelOrigin: () => ({ x: 179.3, y: -97.7 }),
      project: point => ({ x: point.lng * scale, y: -point.lat * scale }),
      layerPointToContainerPoint: ([x, y]) => ({ x: x + pan, y: y - pan }),
      latLngToContainerPoint: () => { throw new Error('rounded projection must not be used'); } };
    const viewport = createVisionViewport(map, 5000);
    assert.ok(Math.abs(viewport.scaleX - scale) < 1e-9);
    assert.ok(Math.abs(viewport.scaleY - scale) < 1e-9);
    for (const [x, y] of [[0, 0], [2940, 2500], [5000, 5000], [14.25, 37.125]]) {
      const point = viewport.project(x, y);
      assert.ok(Math.abs(point.x - (x * scale - 179.3 + pan)) < 1e-7);
      assert.ok(Math.abs(point.y - (-(5000 - y) * scale + 97.7 - pan)) < 1e-7);
      const restored = viewport.unproject(point.x, point.y);
      assert.ok(Math.abs(restored.x - x) < 1e-7 && Math.abs(restored.y - y) < 1e-7);
    }
    assert.ok(viewport.rectangle(100, 200, 5, 5).height > 0);
  }
});

test('animated zoom aligns the previous completed mask with the new view through scale and pan', () => {
  for (const oldZoom of [-4, -0.25, 0, 2.25, 5]) for (let zoom=-4;zoom<=5;zoom+=0.25) {
    const origin={x:-31.25,y:19.5},size={x:960,y:720},pixelOrigin={x:173.2,y:-101.7};
    const map={getZoom:()=>oldZoom,getZoomScale:(a,b)=>2**(a-b),getSize:()=>size,
      containerPointToLayerPoint:()=>origin,getPixelOrigin:()=>pixelOrigin,
      project:(point,z=oldZoom)=>({x:point.lng*2**z,y:-point.lat*2**z}),
      layerPointToContainerPoint:([x,y])=>({x:x-origin.x,y:y-origin.y})};
    const center={lat:2300,lng:2700},viewport=createVisionViewport(map,5000);
    const transform=visionZoomTransform(map,5000,{center,zoom});
    const [,tx,ty,scale]=transform.match(/translate3d\(([-\d.e+]+)px,([-\d.e+]+)px,0\) scale\(([-\d.e+]+)\)/).map(Number);
    for (const [x,y] of [[0,0],[2940,2500],[5000,5000]]) {
      const old=viewport.project(x,y),expected={x:(x-center.lng)*2**zoom+size.x/2,
        y:(y-(5000-center.lat))*2**zoom+size.y/2};
      assert.ok(Math.abs(old.x*scale+tx-origin.x-expected.x)<1e-6);
      assert.ok(Math.abs(old.y*scale+ty-origin.y-expected.y)<1e-6);
    }
  }
});

test('minimal adapters use a wide baseline at the previously failing zoom', () => {
  const scale = 2 ** -0.25;
  const map = { latLngToContainerPoint: point => ({ x: Math.round(point.lng * scale), y: Math.round(-point.lat * scale) }) };
  const viewport = createVisionViewport(map, 5000);
  assert.ok(viewport.scaleX > 0 && viewport.scaleY > 0);
  assert.ok(Math.abs(viewport.scaleX - scale) < 1 / 1024);
  assert.ok(Math.abs(viewport.scaleY - scale) < 1 / 1024);
});
