import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { normalizeFogState, exploreFogVisibleSweep } from '../src/vision/fog.js';
import { deriveVisionOccluders } from '../src/spatial/kernel.js';
import { deriveSceneState } from '../src/engine/state.js';

function history() {
  const rows = Object.fromEntries(Array.from({ length: 320 }, (_, row) =>
    [String(row), [[12, 18], [1, 3], [6, 8], [3, 4]]]));
  return {
    extension: { nested: { label: 'fog', values: [1, 2, 3] } },
    exploredByParty: {
      ' party ': { extension: { nested: { label: 'party' } }, rows, label: 'remembered' },
      other: { label: 'other', rows: { 0: [[0, 0], [2, 3]] }, extension: { keep: true } },
    },
    cellSizeMeters: 2,
    schemaVersion: 0,
    label: 'history',
  };
}

test('large Fog histories retain v2.5.4 JSON order, merge ranges and clip map bounds', () => {
  const input = history(), before = structuredClone(input);
  const normalized = normalizeFogState(input, { width: 75, height: 1100, metersPerUnit: 1 });
  const hash = createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
  // Original normalizeFogState at ed7e13baab0f116222333c20431e19ab63b60e37.
  assert.equal(hash, '6d1cbb27b84e5d3e97297d9ca42ec1e8bfac46943c0d60fbb53c1a95451f9b6b');
  assert.deepEqual(Object.keys(normalized), Object.keys(input));
  assert.deepEqual(Object.keys(normalized.exploredByParty.party), ['extension', 'rows', 'label']);
  assert.equal(Object.keys(normalized.exploredByParty.party.rows).length, 220);
  assert.deepEqual(normalized.exploredByParty.party.rows[0], [[1, 4], [6, 8], [12, 14]]);
  assert.deepEqual(normalized.exploredByParty.other.rows[0], [[0, 0], [2, 3]]);
  assert.deepEqual(input, before);
});

test('Fog metadata, separated visibility intervals and all rows are detached from input', () => {
  const input = history(), before = structuredClone(input);
  const normalized = normalizeFogState(input);
  normalized.extension.nested.values[0] = 999;
  normalized.exploredByParty.party.extension.nested.label = 'changed';
  normalized.exploredByParty.party.rows[0][0][0] = 999;
  normalized.exploredByParty.other.rows[0][0][0] = 999;
  delete normalized.exploredByParty.party.rows[100];
  assert.deepEqual(input, before);
  assert.deepEqual(normalized.exploredByParty.party.rows[101], [[1, 4], [6, 8], [12, 18]],
    'unexplored gaps are retained rather than joining separate visible intervals');
  assert.notEqual(normalized.exploredByParty.party.rows[101], input.exploredByParty[' party '].rows[101]);
});

test('surviving Fog extensions retain their cloned aliases without sharing normalized rows', () => {
  const input = history();
  const rawRows = input.exploredByParty[' party '].rows;
  input.extension.rowsAlias = rawRows;
  input.exploredByParty[' party '].extension.rowsAlias = rawRows;
  const normalized = normalizeFogState(input);
  assert.notEqual(normalized.extension.rowsAlias, rawRows);
  assert.notEqual(normalized.exploredByParty.party.extension.rowsAlias, rawRows);
  assert.notEqual(normalized.extension.rowsAlias, normalized.exploredByParty.party.rows);
  assert.deepEqual(normalized.extension.rowsAlias[0], [[12, 18], [1, 3], [6, 8], [3, 4]]);
  normalized.extension.rowsAlias[0][0][0] = 999;
  assert.equal(rawRows[0][0][0], 12);
  assert.deepEqual(normalized.exploredByParty.party.rows[0], [[1, 4], [6, 8], [12, 18]]);
});

test('discarded Fog rows and party records still reject unsupported values', () => {
  const mutations = [
    fog => { fog.exploredByParty.party.rows.invalid = [() => 1]; },
    fog => { fog.exploredByParty.party.rows[99] = [[1, 3, Symbol('extra')]]; },
    fog => { fog.exploredByParty.party.rows[99] = [[1, 3]]; fog.exploredByParty.party.rows[99].extra = () => 1; },
    fog => { fog.exploredByParty.party.rows[99] = [[1, 3]]; fog.exploredByParty.party.rows[99][0].extra = () => 1; },
    fog => { fog.exploredByParty[' '] = { ignored: () => 1 }; },
    fog => { fog.exploredByParty.party = () => 1; },
    fog => { fog.exploredByParty.party.rows = new WeakMap(); },
    fog => { fog.exploredByParty = new WeakMap(); },
  ];
  for (const mutate of mutations) {
    const input = { exploredByParty: { party: { rows: { 0: [[1, 3]] } } } };
    mutate(input);
    assert.throws(() => normalizeFogState(input, { width: 25, height: 25 }), error => error.name === 'DataCloneError');
  }
});

test('non-numeric legacy rows retain normalization and unusual container compatibility', () => {
  const input = { extension: { keep: true }, exploredByParty: { party: {
    rows: { 0: [['1', '3'], [4.9, 8.9], null, [-1, 5]], invalid: [[1, 2]], 99: [[1, 3]] },
    extension: { label: 'legacy' },
  } } };
  const before = structuredClone(input);
  const normalized = normalizeFogState(input, { width: 25, height: 25 });
  assert.deepEqual(normalized.exploredByParty.party.rows, { 0: [[1, 4]] });
  assert.deepEqual(normalized.exploredByParty.party.extension, { label: 'legacy' });
  assert.deepEqual(input, before);
});

test('numeric-row copy optimization preserves the span limit and atomic failure', () => {
  const spans = Array.from({ length: 4097 }, (_, index) => [index * 3, index * 3]);
  const input = { exploredByParty: { party: { rows: { 0: spans } } } };
  const before = structuredClone(input);
  assert.throws(() => normalizeFogState(input), { code: 'fog_limit' });
  assert.deepEqual(input, before);
});

test('425 metre Lanzhou sweep retains every v2.5.4 visible cell and JSON order', async () => {
  const map = JSON.parse(await readFile(new URL('../reference/maps/lanzhou/runtime.json', import.meta.url), 'utf8'));
  const occluders = deriveVisionOccluders(map, { featureStates: {}, sceneEvents: [], tokens: [] }, deriveSceneState([]));
  const fog = exploreFogVisibleSweep({}, 'party', { x: 2940, y: 2500, elevationMeters: 0 },
    { x: 3365, y: 2500, elevationMeters: 0 }, 1000, map, { occluders });
  // Frozen five-round baseline at released ed7e13b; all 171 path samples.
  assert.equal(createHash('sha256').update(JSON.stringify(fog)).digest('hex'),
    '1a149fc9d5199006112531db83cab17e4e65ed4468f7b7ab86449c4ee8430618');
});
