import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocumentChanges, createDocumentChangesFull, createFogDocumentChanges } from '../src/documents/changes.js';

const nativeClone = structuredClone;
const plain = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));
function oldEqual(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && oldEqual(a[key], b[key]));
}
// Fixed pre-optimization oracle: every changed atomic field is copied by the
// original structuredClone path, including values that are not valid JSON.
function oldDiffFields(before, after, path = [], removed = []) {
  const changed = {};
  for (const key of Object.keys(before)) if (!Object.hasOwn(after, key)) removed.push([...path, key]);
  for (const [key, value] of Object.entries(after)) {
    if (oldEqual(before[key], value) && Object.hasOwn(before, key)) continue;
    if (plain(before[key]) && plain(value)) {
      const nested = oldDiffFields(before[key], value, [...path, key], removed);
      if (Object.keys(nested).length) changed[key] = nested;
    } else changed[key] = nativeClone(value);
  }
  return changed;
}

function state(value, fog = false) {
  return { preferences: { worldV2: { id: 'world', actors: [], statusDefinitions: [], journals: [],
    scenes: fog ? [{ id: 'scene', tokens: [], fog: { extension: value } }] : [],
    ...(fog ? {} : { extension: value }) } } };
}
const modes = {
  paired: (before, after) => createDocumentChanges(before, after),
  full: (before, after) => createDocumentChangesFull(before, after),
  fog: (before, after) => createFogDocumentChanges(before, after, { fog: [{ sceneId: 'scene', dirtyBounds: null }] }),
};
function expectedChange(before, after, fog) {
  const removed = [];
  const changed = oldDiffFields({ extension: before }, { extension: after }, [], removed);
  return [{ action: 'update', document: fog
    ? { type: 'Fog', id: 'scene', parent: { type: 'Scene', id: 'scene' } }
    : { type: 'World', id: 'world', parent: null }, changed,
  ...(removed.length ? { removed } : {}), ...(fog ? { dirtyBounds: null } : {}) }];
}

test('scalar and undefined patches match the old diff oracle in paired, full and Fog modes', () => {
  const cases = [
    ...[null, '', '建筑😀', false, true, 0, -0, Number.MAX_VALUE, Number.MIN_VALUE]
      .map(value => [1, value]),
    [1, undefined],
    [{ kept: undefined, removed: undefined, nested: { value: 2, remove: 'old' } },
      { kept: undefined, added: undefined, nested: { value: -0, add: null, deeper: { enabled: true, label: '门' } } }],
    [{ nested: { value: 1 } }, { nested: undefined }],
    [undefined, { deep: { value: 5, added: undefined } }],
  ];
  for (const [mode, create] of Object.entries(modes)) for (const [before, after] of cases) {
    const fog = mode === 'fog';
    const expected = expectedChange(before, after, fog);
    const actual = create(state(before, fog), state(after, fog));
    assert.deepEqual(actual, expected, mode);
    if (Object.is(after, -0)) assert.equal(Object.is(actual[0].changed.extension, -0), true);
    if (after === undefined) assert.equal(Object.hasOwn(actual[0].changed, 'extension'), true);
  }
});

test('objects stay detached; non-JSON clone behavior, errors and getter order match the old oracle', async () => {
  const cloneInputs = [];
  let observed;
  try {
    // Capture copies without changing their semantics, so undefined/nonfinite
    // numbers and unsupported values must still enter their original boundary.
    globalThis.structuredClone = value => { cloneInputs.push(value); return nativeClone(value); };
    observed = await import('../src/documents/changes.js?scalar-copy-boundaries');
  } finally { globalThis.structuredClone = nativeClone; }
  const observedModes = {
    paired: (before, after) => observed.createDocumentChanges(before, after),
    full: (before, after) => observed.createDocumentChangesFull(before, after),
    fog: (before, after) => observed.createFogDocumentChanges(before, after, { fog: [{ sceneId: 'scene', dirtyBounds: null }] }),
  };
  for (const [mode, create] of Object.entries(observedModes)) {
    const fog = mode === 'fog';
    for (const value of [undefined, 2n, NaN, Infinity, -Infinity]) {
      cloneInputs.length = 0;
      assert.deepEqual(create(state(0, fog), state(value, fog)), expectedChange(0, value, fog), mode);
      assert.equal(cloneInputs.length, 1, `${mode}: original atomic clone path`);
      assert.equal(Object.is(cloneInputs[0], value), true);
    }
    const object = [{ nested: { count: 2 } }];
    const actual = create(state(null, fog), state(object, fog));
    assert.deepEqual(actual, expectedChange(null, object, fog));
    assert.notEqual(actual[0].changed.extension, object);
    assert.notEqual(actual[0].changed.extension[0].nested, object[0].nested);
    actual[0].changed.extension[0].nested.count = 50;
    assert.equal(object[0].nested.count, 2);

    for (const unsupported of [null, () => 1, Symbol('unsupported')]) {
      function input(events) {
        const first = {};
        Object.defineProperty(first, 'value', { enumerable: true, get() {
          events.push('first'); return unsupported === null ? { nested: 3 } : unsupported;
        } });
        const second = {};
        Object.defineProperty(second, 'value', { enumerable: true, get() { events.push('second'); return 4; } });
        return [first, second];
      }
      const oldEvents = [], newEvents = [];
      let expected, oldError;
      try { expected = expectedChange(null, input(oldEvents), fog); } catch (error) { oldError = error; }
      if (oldError) {
        assert.throws(() => create(state(null, fog), state(input(newEvents), fog)),
          error => error.name === oldError.name && error.message === oldError.message);
        assert.equal(oldError.name, 'DataCloneError');
        assert.deepEqual(newEvents, ['first']);
      } else assert.deepEqual(create(state(null, fog), state(input(newEvents), fog)), expected);
      assert.deepEqual(newEvents, oldEvents, `${mode}: getter reads retain order and stop at the same failure`);
    }
  }
});
