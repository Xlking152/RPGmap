import test from 'node:test';
import assert from 'node:assert/strict';
import { computeContinuousVisibility } from '../src/vision/continuous.js';
import { computeVisibilityRows } from '../src/vision/visibility.js';
import { normalizeVisionOccluder, perceptionLevelAtPoint, sphereGroundRadiusMeters } from '../src/spatial/kernel.js';

function inRing({ x, y }, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax, ay] = ring[i], [bx, by] = ring[j];
    if ((ay > y) !== (by > y) && x < (bx - ax) * (y - ay) / (by - ay) + ax) inside = !inside;
  }
  return inside;
}
const insidePolygon = (point, rings) => rings.reduce((inside, ring) => inside !== inRing(point, ring), false);
function insideRegion(point, region, normal = false) {
  return !region.blocked && Math.hypot(point.x - region.x, point.y - region.y)
    < (normal ? region.normalRadiusUnits : region.radiusUnits)
    && !region.shadows.some(rings => insidePolygon(point, rings));
}
function preciseMask(point, source, geometry) {
  if (geometry.blocked || Math.hypot(point.x - source.x, point.y - source.y) > source.preciseGroundRangeMeters
    || geometry.shadows.some(rings => insidePolygon(point, rings))) return false;
  const { mode, regions } = geometry.illumination;
  if (mode === 'all') return true;
  if (mode === 'lit') return regions.some(region => insideRegion(point, region));
  if (mode === 'dark-and-normal') return !regions.some(region => insideRegion(point, region))
    || regions.some(region => insideRegion(point, region, true));
  return regions.some(region => insideRegion(point, region, true));
}

test('continuous circle and light masks match authoritative point perception for every sense combination', () => {
  const map = { width: 250, height: 250, metersPerUnit: 1 };
  const occluders = Object.freeze([normalizeVisionOccluder({ id: 'wall', kind: 'wall',
    polygon: [[45, 30], [52, 30], [52, 105], [45, 105]], blockingHeightMeters: 8 })]);
  const lights = Object.freeze([{ id: 'a', x: 35, y: 80, elevationMeters: 3, rangeMeters: 90, intensity: 2 },
    { id: 'b', x: 95, y: 75, elevationMeters: 0, rangeMeters: 70, intensity: 0.4 },
    { id: 'c', x: 60, y: 20, elevationMeters: 12, rangeMeters: 60, intensity: 1.2, occlusion: 'none' }]);
  for (const lighting of ['normal', 'dim', 'dark']) for (const lowLightVision of [false, true]) for (const darkvision of [false, true]) {
    const source = { tokenId: 'scout', x: 20, y: 60, elevationMeters: 4, preciseRangeMeters: 120, vagueRangeMeters: 150,
      preciseGroundRangeMeters: sphereGroundRadiusMeters(120, 4), vagueGroundRangeMeters: sphereGroundRadiusMeters(150, 4),
      lighting, senses: { lowLightVision, darkvision } };
    const geometry = computeContinuousVisibility({ source, map, occluders, lights, ignoresOcclusion: false });
    assert.equal(geometry.fallback, false);
    for (let x = 2.37; x < 150; x += 7.13) for (let y = 1.17; y < 150; y += 8.71) {
      const target = { x, y, elevationMeters: 0 };
      const expected = perceptionLevelAtPoint({ vision: source, target, ambient: lighting, lights, occluders,
        metersPerUnit: 1, lineOfSightEnabled: true }) === 'precise';
      assert.equal(preciseMask(target, source, geometry), expected,
        `${lighting} low=${lowLightVision} dark=${darkvision} at (${x},${y})`);
    }
  }
});

test('realtime degenerate wall boundaries preserve the exact grid fallback', () => {
  const occluders = [normalizeVisionOccluder({id:'wall',kind:'wall',
    polygon:[[40,10],[45,10],[45,90],[40,90]],blockingHeightMeters:null})];
  const input = { map:{width:150,height:150,metersPerUnit:1},occluders,lights:[],
    source:{tokenId:'scout',x:40,y:50,elevationMeters:0,preciseRangeMeters:60,vagueRangeMeters:80,
      lineOfSightEnabled:true,lighting:'normal'} };
  const ordinary = computeVisibilityRows(input), continuous = computeVisibilityRows({...input,continuous:true});
  assert.equal(continuous.continuous.fallback,true);
  assert.deepEqual(continuous.precise, ordinary.precise);
  assert.deepEqual(continuous.vague, ordinary.vague);
});

test('x-ray bypasses observer shadows without making lights pass through the wall', () => {
  const occluders = Object.freeze([normalizeVisionOccluder({ id: 'wall', kind: 'wall',
    polygon: [[45, 0], [52, 0], [52, 150], [45, 150]], blockingHeightMeters: null })]);
  const lights = Object.freeze([{ x: 20, y: 60, elevationMeters: 0, rangeMeters: 120, intensity: 4 }]);
  const source = { tokenId: 'scout', x: 20, y: 60, preciseRangeMeters: 150, vagueRangeMeters: 150,
    preciseGroundRangeMeters: 150, vagueGroundRangeMeters: 150, lighting: 'dark', senses: { xrayVision: true } };
  const geometry = computeContinuousVisibility({ source, map: { metersPerUnit: 1 }, occluders, lights, ignoresOcclusion: true });
  assert.equal(geometry.shadows.length, 0);
  assert.equal(preciseMask({ x: 70, y: 60 }, source, geometry), false);
  assert.equal(preciseMask({ x: 30, y: 60 }, source, geometry), true);
});
