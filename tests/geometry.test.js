import test from 'node:test';
import assert from 'node:assert/strict';

import {
  attackAreaToPolygon,
  coverageRatio,
  distanceMeters,
  featureToPolygon,
  formatDistance,
  hitTestFeatures,
  intersectionArea,
  latLngToWorld,
  markerIdsInBounds,
  pointInPolygon,
  polygonArea,
  routeSegments,
  snapPoint,
  snapValue,
  worldToLatLng,
} from '../src/engine/geometry.js';

const closeTo = (actual, expected, tolerance = 1e-9) => {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `expected ${actual} to be within ${tolerance} of ${expected}`,
  );
};

const bounds = (ring) => ({
  minX: Math.min(...ring.map(([x]) => x)),
  maxX: Math.max(...ring.map(([x]) => x)),
  minY: Math.min(...ring.map(([, y]) => y)),
  maxY: Math.max(...ring.map(([, y]) => y)),
});

const rectangle = (minX, minY, maxX, maxY) => [
  [minX, minY],
  [maxX, minY],
  [maxX, maxY],
  [minX, maxY],
];

test('world and Leaflet coordinates round-trip using height inversion', () => {
  const world = { x: 125, y: 750 };
  assert.deepEqual(worldToLatLng(world), { lat: 4250, lng: 125 });
  assert.deepEqual(latLngToWorld(worldToLatLng(world)), world);

  const outsideWorld = { x: -80, y: -25 };
  const outsideLatLng = worldToLatLng(outsideWorld, 3500);
  assert.deepEqual(outsideLatLng, { lat: 3525, lng: -80 });
  assert.deepEqual(latLngToWorld(outsideLatLng, 3500), outsideWorld);
});

test('distance uses map units as metres and formats metres/kilometres', () => {
  assert.equal(distanceMeters({ x: 0, y: 0 }, { x: 300, y: 400 }), 500);
  assert.equal(formatDistance(500), '500米');
  assert.equal(formatDistance(1250), '1.25公里');
});

test('circle polygon has the requested radius in both dimensions', () => {
  const polygon = attackAreaToPolygon({ shape: 'circle', origin: { x: 10, y: 20 }, radius: 50 });
  const box = bounds(polygon);
  closeTo(box.minX, -40);
  closeTo(box.maxX, 60);
  closeTo(box.minY, -30);
  closeTo(box.maxY, 70);
  closeTo(polygonArea(polygon), Math.PI * 50 ** 2, 11);
  assert.deepEqual(polygon[0], polygon.at(-1));
});

test('sector heading zero points up in a y-down world', () => {
  const polygon = attackAreaToPolygon({
    shape: 'sector',
    origin: { x: 0, y: 0 },
    range: 100,
    angleDeg: 90,
    headingDeg: 0,
  });
  const box = bounds(polygon);
  closeTo(box.minX, -Math.SQRT1_2 * 100, 1e-8);
  closeTo(box.maxX, Math.SQRT1_2 * 100, 1e-8);
  closeTo(box.minY, -100, 1e-8);
  closeTo(box.maxY, 0, 1e-8);
  closeTo(polygonArea(polygon), (Math.PI * 100 ** 2) / 4, 25);
});

test('rectangle uses origin as near-edge midpoint and extends along heading', () => {
  const polygon = attackAreaToPolygon({
    shape: 'rectangle',
    origin: { x: 0, y: 0 },
    length: 100,
    width: 40,
    headingDeg: 90,
  });
  const box = bounds(polygon);
  closeTo(box.minX, 0, 1e-8);
  closeTo(box.maxX, 100, 1e-8);
  closeTo(box.minY, -20, 1e-8);
  closeTo(box.maxY, 20, 1e-8);
  closeTo(polygonArea(polygon), 4000);
});

test('attack aliases and GeoJSON-style feature polygons are supported', () => {
  const circle = attackAreaToPolygon({ type: 'circle', center: { x: -20, y: -30 }, radius: 10 });
  assert.equal(pointInPolygon({ x: -20, y: -30 }, circle), true);
  assert.equal(pointInPolygon({ x: 0, y: 0 }, circle), false);

  const featurePolygon = featureToPolygon({
    geometry: { type: 'Polygon', coordinates: [rectangle(-10, -10, 10, 10)] },
  });
  assert.equal(polygonArea(featurePolygon), 400);
});

test('object-like features hit on any positive-area overlap', () => {
  const targetPolygon = rectangle(0, 0, 100, 100);
  const target = {
    id: 'target',
    category: 'building',
    mode: 'object',
    geometry: { type: 'polygon', points: targetPolygon },
    center: { x: 50, y: 50 },
    minCoverage: 0.95,
  };

  const partial24 = rectangle(0, 0, 24, 100);
  const corner = rectangle(99.9, 99.9, 101, 101);
  const full = rectangle(-10, -10, 110, 110);
  const boundaryTouch = rectangle(100, 20, 110, 30);

  closeTo(coverageRatio(targetPolygon, partial24), 0.24);
  assert.equal(hitTestFeatures(partial24, [target]).length, 1);
  assert.equal(hitTestFeatures(corner, [target]).length, 1);
  assert.equal(hitTestFeatures(full, [target]).length, 1);
  assert.equal(hitTestFeatures(boundaryTouch, [target]).length, 0);
});

test('clip features hit on any positive-area intersection and ignore boundary touch', () => {
  const clipTarget = {
    id: 'clip-target',
    category: 'terrain',
    mode: 'clip',
    geometry: { type: 'polygon', points: rectangle(0, 0, 100, 100) },
    center: { x: 50, y: 50 },
  };

  const tinyOverlap = rectangle(99.9, 99.9, 101, 101);
  const clipHits = hitTestFeatures(tinyOverlap, [clipTarget]);
  assert.equal(clipHits.length, 1);
  assert.ok(clipHits[0].coverage < 0.001);

  const boundaryTouch = rectangle(100, 20, 110, 30);
  assert.equal(intersectionArea(boundaryTouch, rectangle(0, 0, 100, 100)), 0);
  assert.equal(hitTestFeatures(boundaryTouch, [clipTarget]).length, 0);
});

test('category filtering only returns requested feature categories', () => {
  const area = rectangle(0, 0, 10, 10);
  const features = ['terrain', 'unit'].map((category) => ({
    id: category,
    category,
    mode: 'coverage',
    geometry: { type: 'polygon', points: area },
  }));
  assert.deepEqual(
    hitTestFeatures(area, features, ['unit']).map(({ featureId }) => featureId),
    ['unit'],
  );
});

test('snap supports 1/5/10/20 metre grids and free placement', () => {
  assert.equal(snapValue(12.4, 1), 12);
  assert.equal(snapValue(12.4, 5), 10);
  assert.equal(snapValue(12.4, 10), 10);
  assert.equal(snapValue(12.4, 20), 20);
  assert.equal(snapValue(12.4, 'free'), 12.4);
  assert.deepEqual(snapPoint({ x: -12.6, y: -7.4 }, 5), { x: -15, y: -5 });
  assert.deepEqual(snapPoint({ x: -12.6, y: -7.4 }, 'free'), { x: -12.6, y: -7.4 });
});

test('marker box selection supports reverse drags and includes boundary markers only', () => {
  const markers = [
    { id: 'northwest', x: 0, y: 0 },
    { id: 'inside', x: 5, y: 6 },
    { id: 'southeast-edge', x: 10, y: 10 },
    { id: 'outside-x', x: 10.01, y: 5 },
    { id: 'outside-y', x: 5, y: -0.01 },
  ];
  assert.deepEqual(
    markerIdsInBounds(markers, { x: 10, y: 10 }, { x: 0, y: 0 }),
    ['northwest', 'inside', 'southeast-edge'],
  );
  assert.deepEqual(markerIdsInBounds(markers, { x: 4, y: 5 }, { x: 6, y: 7 }), ['inside']);
});

test('routeSegments returns segment and cumulative distances', () => {
  const route = routeSegments([
    { x: -100, y: -100 },
    { x: 200, y: 300 },
    { x: 200, y: 400 },
  ]);
  assert.equal(route.segments.length, 2);
  assert.equal(route.segments[0].length, 500);
  assert.equal(route.segments[0].cumulative, 500);
  assert.equal(route.segments[1].length, 100);
  assert.equal(route.segments[1].cumulative, 600);
  assert.equal(route.total, 600);
});
