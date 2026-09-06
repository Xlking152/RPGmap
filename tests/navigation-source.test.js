import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createNavigationBase, createNavigationGrid, inspectDirectNavigationPath,
  NAVIGATION_CELL_FLAGS as FLAGS, snapNavigationPoint, nearestWalkablePoint,
} from '../src/engine/navigation.js';
import { deriveFloodRegions } from '../src/engine/state.js';
import { polygonArea } from '../src/engine/geometry.js';

const rectangle = (x, y, width, height) => [[x, y], [x + width, y], [x + width, y + height], [x, y + height]];
const obstacle = (id, polygon, navigation = {}) => ({
  id, geometry: { points: polygon }, capabilities: { navigation: { blocks: true, ...navigation } },
});
const field = (features, { scene = {}, states = {}, mover = {}, ...map } = {}) => createNavigationGrid({
  width: 150, height: 150, features, roadBuffers: [], liquidBodies: [], ...map,
}, scene, null, { appState: { preferences: { featureStates: states } }, moverContext: mover });
const at = (navigation, x = 55, y = 55) => navigation.cellFlags({ x, y });

test('an open or destroyed door removes only its own obstacle regardless of Feature order', () => {
  const door = obstacle('door', rectangle(40, 40, 30, 30), { passableWhenOpen: true, passableWhenDestroyed: true });
  const building = obstacle('building', rectangle(50, 50, 10, 10));
  for (const features of [[door, building], [building, door]]) {
    for (const options of [{ states: { door: { open: true } } }, { scene: { destroyedObjectIds: ['door'] } }]) {
      const navigation = field(features, options);
      assert.ok(at(navigation) & FLAGS.blocked, 'overlapping building remains blocked');
      assert.equal(at(navigation, 45, 45) & FLAGS.blocked, 0, 'door-only cells become passable');
    }
  }
});

test('a wall breach cannot clear an overlapping intact wall or a different Feature footprint', () => {
  const wall = obstacle('wall', rectangle(40, 40, 30, 30), { damageCreatesPassage: true });
  const other = obstacle('other', rectangle(50, 50, 40, 10));
  const scene = { clipHits: [{ featureId: 'wall', polygon: rectangle(0, 0, 120, 120) }] };
  for (const features of [[wall, other], [other, wall]]) {
    const navigation = field(features, { scene });
    assert.ok(at(navigation) & FLAGS.blocked);
    assert.ok(at(navigation, 80, 55) & FLAGS.blocked);
    assert.equal(at(navigation, 45, 45) & FLAGS.blocked, 0);
  }
});

test('a bridge provides a water crossing without clearing structures, craters or boundaries', () => {
  const bridge = { id: 'bridge', geometry: { points: rectangle(-10, 40, 180, 30) } };
  const building = obstacle('building', rectangle(50, 40, 10, 30));
  const map = {
    liquidBodies: [{ id: 'river', polygon: rectangle(30, 0, 90, 150) }],
    navigation: { bridgeFeatureIds: ['bridge'] },
  };
  const navigation = field([bridge, building], map);
  assert.ok(at(navigation) & FLAGS.blocked);
  assert.equal(at(navigation, 80, 55) & FLAGS.blocked, 0);
  assert.ok(at(navigation, 80, 30) & FLAGS.water);
  assert.ok(at(navigation, -1, 55) & FLAGS.boundary);
  const broken = field([bridge, building], {
    ...map, scene: { clipHits: [{ featureId: 'bridge', polygon: rectangle(75, 40, 10, 30) }] },
  });
  assert.ok(at(broken, 80, 55) & FLAGS.water);
  assert.equal(at(broken, 100, 55) & FLAGS.blocked, 0);
  const crater = field([bridge], { ...map, scene: { craterRegions: [{ polygon: rectangle(75, 40, 10, 30) }] } });
  assert.ok(at(crater, 80, 55) & FLAGS.crater);
});

test('height and capability exemptions leave other sources and water blocked', () => {
  const lowWall = obstacle('low', rectangle(40, 40, 30, 30), { blockingHeightFt: 10, collisionGroup: 'structure' });
  const highWall = obstacle('high', rectangle(50, 50, 10, 10), { blockingHeightFt: 20, collisionGroup: 'boundary' });
  const navigation = field([lowWall, highWall], { mover: { elevationFt: 11, collisionBypassGroups: ['structure'] } });
  assert.ok(at(navigation) & FLAGS.blocked);
  assert.equal(at(navigation, 45, 45) & FLAGS.blocked, 0);
  assert.ok(at(field([lowWall], { mover: { elevationFt: 10 } })) & FLAGS.blocked, 'exact obstacle top still blocks');
});

test('one-meter cells, chunk boundaries and Token footprints are invariant under map coordinate scale', () => {
  for (const metersPerUnit of [1, 2, 0.5, 0.3048]) {
    const polygon = rectangle(70, 0, 2, 150).map(point => point.map(value => value / metersPerUnit));
    const navigation = field([obstacle('wall', polygon)], {
      width: 150 / metersPerUnit, height: 150 / metersPerUnit, metersPerUnit,
    });
    assert.equal(navigation.columns, 150);
    assert.ok(Math.abs(navigation.cellSize * metersPerUnit - 1) < 1e-12);
    assert.equal(at(navigation, 69, 80) & FLAGS.blocked, 0);
    assert.ok(at(navigation, 70, 80) & FLAGS.blocked);
    const point = (x, y) => ({ x: x / metersPerUnit, y: y / metersPerUnit });
    assert.equal(inspectDirectNavigationPath(navigation, point(64.5, 10.5), point(64.5, 100.5), { diameterMeters: 1 }).valid, true);
    assert.equal(inspectDirectNavigationPath(navigation, point(66.5, 10.5), point(66.5, 100.5), { diameterMeters: 10 }).valid, false);
    assert.equal(inspectDirectNavigationPath(navigation, point(20.5, 80.5), point(110.5, 80.5)).valid, false);
    const snapped = snapNavigationPoint(point(30.1, 30.1), navigation);
    assert.ok(Math.abs(snapped.x * metersPerUnit - 30.5) < 1e-9);
    const safe = nearestWalkablePoint(navigation, point(70.5, 80.5), 5);
    assert.ok(safe && safe.distance <= 5.5);
    assert.ok(Math.abs(safe.distance - Math.hypot(safe.x * metersPerUnit - 70.5, safe.y * metersPerUnit - 80.5)) < 1e-9);
  }
});

test('navigation rejects invalid scale and mismatched static bases instead of silently changing units', () => {
  for (const metersPerUnit of [0, -1, Infinity, NaN, 'bad']) {
    assert.throws(() => createNavigationBase({ width: 150, height: 150, metersPerUnit }), /navigation.*scale/);
  }
  const map = { width: 150, height: 150, metersPerUnit: 1 };
  const base = createNavigationBase(map);
  assert.throws(() => createNavigationGrid({ ...map, metersPerUnit: 2 }, {}, base), /navigation base/);
});

test('flood inflow thresholds and widths remain metric at non-unit map scales', () => {
  for (const metersPerUnit of [1, 2, 0.5, 0.3048]) {
    const polygon = (...values) => rectangle(...values).map(point => point.map(value => value / metersPerUnit));
    const scene = { craterRegions: [
      { eventId: 'near', polygon: polygon(30, 30, 10, 10) },
      { eventId: 'far', polygon: polygon(33, 60, 10, 10) },
    ] };
    const liquidBodies = [{ id: 'river', polygon: polygon(0, 0, 20, 100) }];
    const before = structuredClone({ scene, liquidBodies });
    const regions = deriveFloodRegions(scene, liquidBodies, [], {}, metersPerUnit);
    assert.ok(regions.some(region => region.eventId === 'near' && region.kind === 'crater'));
    assert.ok(!regions.some(region => region.eventId === 'far'));
    const inlet = regions.find(region => region.kind === 'inlet');
    assert.ok(Math.abs(polygonArea(inlet.polygon) * metersPerUnit ** 2 - 60) < 1e-6, 'ten-meter inlet has six-meter width');
    const navigation = field([], { width: 150 / metersPerUnit, height: 150 / metersPerUnit, metersPerUnit, scene, liquidBodies });
    assert.ok(at(navigation, 25, 30) & FLAGS.water, 'navigation and renderer use the same metric inlet');
    const wall = { ...obstacle('wall', polygon(23, 0, 5, 100)), category: 'wall' };
    assert.equal(deriveFloodRegions(scene, liquidBodies, [wall], {}, metersPerUnit).length, 0);
    assert.deepEqual({ scene, liquidBodies }, before, 'coordinate conversion cannot mutate Scene or MapPackage');
  }
});
