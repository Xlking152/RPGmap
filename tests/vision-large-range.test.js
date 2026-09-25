import test from 'node:test';
import assert from 'node:assert/strict';
import { visibleFogRowsForCircle, exploreFogVisibleSweep, exploreFogVisibleCircle } from '../src/vision/fog.js';
import { inspectLineOfSight } from '../src/spatial/kernel.js';

const map = { width: 100, height: 100, metersPerUnit: 1 };
const wall = { polygon: [[40, 10], [60, 10], [60, 90], [40, 90]], blockingHeightMeters: 8 };
const hole = [[45, 30], [55, 30], [55, 70], [45, 70]];
function contains(rows, row, column) { return (rows[row] || []).some(([a, b]) => column >= a && column <= b); }

test('scanline shadows agree with reference rays for heights, holes, fragments and wall-adjacent eyes', () => {
  const sets = [[wall], [{ ...wall, polygons: [[wall.polygon, hole]] }],
    [{ ...wall, polygons: [[[[40, 10], [50, 10], [50, 40], [40, 40]]], [[[50, 60], [60, 60], [60, 90], [50, 90]]]] }],
    [wall, { polygon: [[65, 30], [90, 45], [75, 80]], blockingHeightMeters: 15 }]];
  for (const occluders of sets) for (const eye of [[20, 50], [50, 50], [40, 30], [75, 77], [12.5, 12.5]]) {
    for (const elevationMeters of [0, 4, 8, 12, 30]) {
      const circle = { x: eye[0], y: eye[1], radiusMeters: 100 };
      const source = { ...circle, elevationMeters };
      const rows = visibleFogRowsForCircle(circle, map, { occluders, sourceElevationMeters: elevationMeters });
      const full = visibleFogRowsForCircle(circle, map);
      for (let row = 0; row < 20; row++) for (let column = 0; column < 20; column++) {
        const expected = contains(full, row, column) && inspectLineOfSight({ from: source,
          to: { x: column * 5 + 2.5, y: row * 5 + 2.5, elevationMeters: 0 }, occluders }).clear;
        assert.equal(contains(rows, row, column), expected, JSON.stringify({ eye, elevationMeters, row, column, occluders }));
      }
    }
  }
});

test('optimized exploration retains every original 2.5 m sample and existing history', () => {
  const from = { x: 20, y: 20 }, to = { x: 20, y: 45 };
  let expected = exploreFogVisibleCircle({}, 'party', { x: 85, y: 85, radiusMeters: 10 }, map);
  const initial = structuredClone(expected);
  for (let i = 0; i <= 10; i++) expected = exploreFogVisibleCircle(expected, 'party', { x: 20, y: 20 + i * 2.5, radiusMeters: 60 }, map, { occluders: [wall] });
  assert.deepEqual(exploreFogVisibleSweep(initial, 'party', from, to, 60, map, { occluders: [wall] }), expected);
});

test('rotated footprints and finite-height projections match exact rays at varied map scales', () => {
  let seed = 351;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  for (let trial = 0; trial < 30; trial++) {
    const angle = random() * Math.PI;
    const polygon = [[-8,-15],[8,-15],[8,15],[-8,15]].map(([x,y]) => [50 + x * Math.cos(angle) - y * Math.sin(angle), 50 + x * Math.sin(angle) + y * Math.cos(angle)]);
    const occluders = [{ polygon, blockingHeightMeters: trial % 3 ? 8 : 0 }];
    const source = { x: random() * 100, y: random() * 100, elevationMeters: random() * 30 };
    const metrics = { ...map, metersPerUnit: trial % 2 ? 2 : 1 };
    const circle = { ...source, radiusMeters: 200 };
    const rows = visibleFogRowsForCircle(circle, metrics, { occluders, sourceElevationMeters: source.elevationMeters });
    const full = visibleFogRowsForCircle(circle, metrics);
    const cell = 5 / metrics.metersPerUnit;
    for (const [row, spans] of Object.entries(full)) for (const [start, end] of spans) for (let column = start; column <= end; column++) {
      assert.equal(contains(rows, row, column), inspectLineOfSight({ from: source,
        to: { x: (column + 0.5) * cell, y: (Number(row) + 0.5) * cell, elevationMeters: 0 }, occluders }).clear,
      JSON.stringify({ trial, row, column }));
    }
  }
});
