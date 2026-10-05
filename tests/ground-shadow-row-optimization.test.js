import test from 'node:test';
import assert from 'node:assert/strict';
import { groundShadowRows, groundShadowRowsSteps } from '../src/vision/ground-shadow.js';
import { groundShadowRows as referenceRows,
  groundShadowRowsSteps as referenceSteps } from './fixtures/ground-shadow-before-row-optimization.js';
import { circleFogRows } from '../src/vision/fog.js';
import { normalizeVisionOccluder } from '../src/spatial/kernel.js';
import { finishWorkAsync } from '../src/vision/work.js';

const rectangle = (x, y, width, height) => [[x, y], [x + width, y], [x + width, y + height], [x, y + height]];
function obstacle(id, polygon, extra = {}) {
  return { id, kind: 'wall', polygon, blockingHeightMeters: 3, ...extra };
}
function geometry() {
  return [
    [],
    [obstacle('wall', rectangle(60, 20, 7, 130))],
    [obstacle('concave', [[55, 20], [115, 20], [115, 35], [75, 35], [75, 90], [55, 90]])],
    [obstacle('hole', rectangle(50, 20, 100, 130), { kind: 'building', polygons: [
      [rectangle(50, 20, 100, 130), rectangle(80, 55, 35, 55).reverse()],
    ] })],
    [obstacle('hole-arbitrary-winding', rectangle(50, 20, 100, 130), { polygons: [
      [rectangle(50, 20, 100, 130).reverse(), rectangle(80, 55, 35, 55).reverse()],
    ] })],
    [obstacle('fragments', rectangle(50, 20, 100, 130), { polygons: [
      [rectangle(50, 20, 12, 100)], [rectangle(100, 70, 50, 12)],
    ] })],
    [obstacle('outer', rectangle(20, 20, 130, 130), { kind: 'building', blockingHeightMeters: null }),
      obstacle('inner', rectangle(40, 40, 30, 30), { kind: 'building', blockingHeightMeters: null }),
      obstacle('independent-wall', rectangle(90, 20, 4, 140), { blockingHeightMeters: null })],
    [obstacle('low', rectangle(60, 20, 10, 60), { blockingHeightMeters: 0 }),
      obstacle('high', rectangle(100, 70, 10, 75), { blockingHeightMeters: 8 }),
      obstacle('unbounded', rectangle(150, 20, 10, 125), { blockingHeightMeters: null })],
  ];
}

function rowsFor(source, radius, scale, narrow = false) {
  const map = { width: 190, height: 180, metersPerUnit: scale };
  const rows = circleFogRows({ ...source, radiusMeters: radius * scale }, map);
  if (narrow) for (const [row, spans] of Object.entries(rows)) {
    const [start, end] = spans[0];
    const middle = Math.floor((start + end) / 2);
    rows[row] = start + 2 <= end ? [[start, Math.min(start + 1, end)], [Math.max(middle, start + 2), end]] : spans;
  }
  return rows;
}

function compare(source, radius, occluders, scale, narrow = false) {
  const rows = rowsFor(source, radius, scale, narrow);
  const prior = structuredClone({ source, rows, occluders });
  const actual = groundShadowRows(source, radius, occluders, 5 / scale, rows, scale);
  const expected = referenceRows(source, radius, occluders, 5 / scale, rows, scale);
  assert.deepEqual(actual, expected);
  assert.deepEqual({ source, rows, occluders }, prior, 'row work never changes public input');
  return actual;
}

test('optimized row work matches the old complete output for holes, fragments, heights, hosts and map scales', () => {
  const sources = [
    { x: 15, y: 80, elevationMeters: 0 },
    { x: 35, y: 35, elevationMeters: 0, allowHostExemption: true },
    { x: 45, y: 45, elevationMeters: 1, allowHostExemption: true },
    { x: 90, y: 80, elevationMeters: 5, allowHostExemption: true },
    { x: 165, y: 160, elevationMeters: 10 },
  ];
  for (const occluders of geometry()) for (const source of sources) for (const scale of [0.4, 1, 2.5]) {
    for (const narrow of [false, true]) compare(source, 130, occluders, scale, narrow);
  }
});

test('wall and cell tangencies retain old fallback, blocked and precise boundary decisions', () => {
  const walls = [obstacle('edge', rectangle(62.5, 22.5, 15, 90)),
    obstacle('triangle', [[92.5, 22.5], [137.5, 67.5], [92.5, 112.5]])];
  for (const x of [62.5, 62.5 - 1e-8, 62.5 + 1e-8, 77.5, 77.5 + 1e-8]) {
    for (const y of [22.5, 67.5, 112.5]) compare({ x, y, elevationMeters: 0 }, 100, walls, 1);
  }
  const source = { x: 12.5, y: 67.5, elevationMeters: 0 };
  for (const radius of [1, 25, 50, 100, 100 + 1e-9]) compare(source, radius, walls, 1, true);
  const inside = compare({ x: 65, y: 60, elevationMeters: 0 }, 100, walls, 1);
  assert.deepEqual(inside, {});
  const boundary = compare({ x: 62.5, y: 60, elevationMeters: 0 }, 100, walls, 1);
  assert.equal(boundary, null);
});

test('immutable spatial indexes preserve original shape order and mutable inputs rebuild each call', () => {
  const raw = [...geometry()[7], ...geometry()[5]];
  const source = { x: 15, y: 80, elevationMeters: 4 };
  const first = compare(source, 130, raw, 1);
  assert.equal(Object.isFrozen(raw), false);
  raw[0].polygon = rectangle(35, 10, 30, 150);
  raw[0].blockingHeightMeters = 10;
  const changed = compare(source, 130, raw, 1);
  assert.notDeepEqual(changed, first);
  const prepared = Object.freeze(raw.map(normalizeVisionOccluder));
  compare(source, 130, prepared, 1);
});

test('scratch arrays never escape through mutable returned rows or share output between calls', () => {
  const source = { x: 15, y: 80, elevationMeters: 0 }, raw = geometry()[1];
  const first = compare(source, 130, raw, 1);
  const row = Object.keys(first)[0];
  assert.ok(row);
  assert.equal(Object.isFrozen(first[row]), false);
  assert.equal(Object.isFrozen(first[row][0]), false);
  first[row][0][0] = 9999;
  first[row].push([9999, 9999]);
  const next = compare(source, 130, raw, 1);
  assert.notDeepEqual(next[row], first[row]);
  assert.notEqual(next[row], first[row]);
});

test('row generators retain every yield, cancellation and remaining public row reads', async () => {
  const source = { x: 15, y: 80, elevationMeters: 0 }, raw = geometry()[1];
  const leftRows = rowsFor(source, 130, 1), rightRows = structuredClone(leftRows);
  const left = groundShadowRowsSteps(source, 130, raw, 5, leftRows, 1);
  const right = referenceSteps(source, 130, raw, 5, rightRows, 1);
  assert.deepEqual(left.next(), right.next());
  assert.deepEqual(left.next(), right.next());
  const laterRow = Object.keys(leftRows)[5];
  leftRows[laterRow][0][1] -= 1;
  rightRows[laterRow][0][1] -= 1;
  let done = false, yields = 2;
  while (!done) {
    const actual = left.next(), expected = right.next();
    assert.deepEqual(actual, expected);
    done = actual.done;
    if (!done) yields += 1;
  }
  assert.equal(yields, Object.keys(leftRows).length);

  const cancelled = groundShadowRowsSteps(source, 130, raw, 5, leftRows, 1);
  const cancelledReference = referenceSteps(source, 130, raw, 5, rightRows, 1);
  assert.deepEqual(cancelled.next(), cancelledReference.next());
  assert.deepEqual(cancelled.return('cancelled'), cancelledReference.return('cancelled'));
  assert.deepEqual(cancelled.next(), cancelledReference.next());
  for (const make of [groundShadowRowsSteps, referenceSteps]) {
    const controller = new AbortController();
    let turns = 0;
    await assert.rejects(finishWorkAsync(make(source, 130, raw, 5, leftRows, 1), {
      signal: controller.signal, budgetMs: -1,
      yieldTask: async () => { turns += 1; controller.abort(new Error('cancel row work')); },
    }), /cancel row work/);
    assert.equal(turns, 1);
  }
  compare(source, 130, raw, 1);
});
