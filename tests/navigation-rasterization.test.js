import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createNavigationBase, createNavigationGrid, NAVIGATION_CELL_FLAGS as FLAGS,
} from '../src/engine/navigation.js';

// The previous scalar rasterizer is the oracle for cell-center boundary
// decisions; exercise the public field rather than private prepared vertices.
function originalContains(point, polygon) {
  const tuple = value => Array.isArray(value)
    ? [Number(value[0]), Number(value[1])] : [Number(value.x), Number(value.y)];
  const [x, y] = tuple(point);
  let inside = false;
  for (let current = 0, previous = polygon.length - 1; current < polygon.length; previous = current, current++) {
    const [cx, cy] = tuple(polygon[current]), [px, py] = tuple(polygon[previous]);
    if (cy > y !== py > y) {
      if (x < ((px - cx) * (y - cy)) / (py - cy) + cx) inside = !inside;
    }
  }
  return inside;
}

const rectangle = (left, top, right, bottom) => [[left, top], [right, top], [right, bottom], [left, bottom]];
const obstacle = polygon => ({ id: 'wall', geometry: { points: polygon },
  capabilities: { navigation: { blocks: true, damageCreatesPassage: true } } });
const grid = (map, scene = {}, base = null) => createNavigationGrid(map, scene, base, {
  appState: { preferences: { featureStates: {} } }, moverContext: {},
});

test('numeric preparation preserves every raster cell across chunk edges, scales and vertex representations', () => {
  const polygons = [
    rectangle(-2, 2.5, 67.5, 7.5),
    [[3.5, 12.5], [65.5, 12.5], [65.5, 65.5], [59.5, 65.5], [59.5, 20.5], [3.5, 20.5]],
    [[8.5, 8.5], [66.5, 66.5], [8.5, 66.5], [8.5, 8.5]],
  ];
  for (const scale of [1, 2, 0.5]) {
    for (const representation of ['tuple', 'object', 'mixed']) {
      const convert = (polygon, offset = 0) => polygon.map(([x, y], index) => {
        const tuple = [String(x / scale), String(y / scale)];
        return representation === 'object' || (representation === 'mixed' && (index + offset) % 2)
          ? { x: tuple[0], y: tuple[1] } : tuple;
      });
      const [road, water, wall] = polygons.map(convert);
      const map = { width: 68 / scale, height: 68 / scale, metersPerUnit: scale,
        roadBuffers: [{ polygon: road }], liquidBodies: [{ polygon: water }], features: [obstacle(wall)] };
      const before = structuredClone(map), navigation = grid(map);
      for (let row = 0; row < 68; row++) for (let column = 0; column < 68; column++) {
        const point = [(column + 0.5) / scale, (row + 0.5) / scale];
        let expected = originalContains(point, road) ? FLAGS.road : 0;
        if (originalContains(point, water)) expected |= FLAGS.water | FLAGS.blocked;
        if (originalContains(point, wall)) expected |= FLAGS.blocked | FLAGS.destructible;
        assert.equal(navigation.cellFlags({ x: column, y: row }), expected,
          `${representation}, scale ${scale}, cell ${column}/${row}`);
      }
      assert.deepEqual(map, before, 'preparation does not rewrite package polygons');
    }
  }
});

test('a fresh navigation field reads changed mutable vertices instead of retaining prepared coordinates', () => {
  const polygon = rectangle(10, 10, 20, 20).map(([x, y]) => ({ x, y }));
  const map = { width: 68, height: 68, features: [obstacle(polygon)] };
  const base = createNavigationBase(map), first = grid(map, {}, base);
  assert.ok(first.cellFlags({ x: 15, y: 15 }) & FLAGS.blocked);
  for (const point of polygon) point.x += 20;
  const second = grid(map, {}, base);
  assert.equal(second.cellFlags({ x: 15, y: 15 }) & FLAGS.blocked, 0);
  assert.ok(second.cellFlags({ x: 35, y: 15 }) & FLAGS.blocked);
});

test('mutable damage polygons retain object vertices and invalidate the Scene raster on edits', () => {
  const footprint = rectangle(10, 10, 50, 50).map(([x, y]) => ({ x: String(x), y: String(y) }));
  const damage = rectangle(10, 20, 50, 25).map(([x, y]) => ({ x, y }));
  const map = { width: 68, height: 68, features: [obstacle(footprint)] };
  const scene = { clipHits: [{ featureId: 'wall', polygon: damage }] };
  const navigation = grid(map, scene);
  assert.equal(navigation.cellFlags({ x: 30, y: 22 }) & FLAGS.blocked, 0);
  assert.ok(navigation.cellFlags({ x: 30, y: 32 }) & FLAGS.blocked);
  for (const point of damage) point.y += 10;
  assert.ok(navigation.cellFlags({ x: 30, y: 22 }) & FLAGS.blocked);
  assert.equal(navigation.cellFlags({ x: 30, y: 32 }) & FLAGS.blocked, 0);
});
