import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocumentChangesFull, createFogDocumentChanges } from '../src/documents/changes.js';

const options = { fog: [{ sceneId: 'scene', dirtyBounds: null }] };
const state = fog => ({ preferences: { worldV2: { id: 'world', actors: [], statusDefinitions: [], journals: [],
  scenes: [{ id: 'scene', tokens: [], fog }] } } });

test('one-pass Fog patches retain the full diff oracle for nested equality, deletions and atomic arrays', () => {
  const cases = [
    [{}, {}],
    [{ party: { rows: { 0: [[0, 3]], 1: [[4, 7]] } } }, { party: { rows: { 0: [[0, 3]], 1: [[4, 7]] } } }],
    [{ party: { rows: { 0: [[0, 3]], 1: [[4, 7]] }, empty: {}, removed: 1 }, gone: {} },
      { party: { rows: { 0: [[0, 5]], 2: [[8, 9]] }, empty: {} }, added: {} }],
    [{ party: { nested: { remove: 1 } } }, { party: { nested: {} } }],
    [{ party: {} }, { party: { nested: {} } }],
    [{ value: 0 }, { value: -0 }],
    [{ value: 1 }, { value: -0 }],
    [{ value: 1 }, { value: NaN }],
    [{ value: 1 }, { value: Infinity }],
    [{ value: 1 }, { value: undefined }],
    [{ value: { removed: undefined } }, { value: { added: undefined } }],
    [{ value: [{ nested: 1 }] }, { value: [{ nested: 2 }] }],
    [{ value: Object.assign(Object.create(null), { keep: 1, gone: 2 }) },
      { value: Object.assign(Object.create(null), { keep: 1, added: null }) }],
    [undefined, { party: { rows: {} } }],
    [{ party: { rows: {} } }, undefined],
    [null, {}],
    [{}, []],
  ];
  for (const [beforeFog, afterFog] of cases) {
    const before = state(beforeFog), after = state(afterFog);
    const expected = createDocumentChangesFull(before, after, null, options);
    const actual = createFogDocumentChanges(before, after, options);
    assert.deepEqual(actual, expected);
    assert.equal(JSON.stringify(actual), JSON.stringify(expected));
  }
});

test('Fog subtree traversal does not compare each ancestor before collecting the same patch', () => {
  const row = { 0: [[0, 2]], 1: [[4, 6]], 2: [[8, 10]] };
  const before = state({ exploredByParty: { party: { rows: row } } });
  const after = structuredClone(before);
  after.preferences.worldV2.scenes[0].fog.exploredByParty.party.rows[2][0][1] = 12;
  const keys = Object.keys;
  let rowReads = 0;
  Object.keys = value => { if (value === row) rowReads++; return keys(value); };
  try {
    const actual = createFogDocumentChanges(before, after, options);
    const focusedReads = rowReads;
    rowReads = 0;
    const expected = createDocumentChangesFull(before, after, null, options);
    assert.deepEqual(actual, expected);
    assert.equal(focusedReads, 1, 'the old row object is visited once while its patch is collected');
    assert.ok(rowReads > focusedReads, 'the full oracle retains the original repeated ancestor comparisons');
  } finally { Object.keys = keys; }
});
