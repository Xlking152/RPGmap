import test from 'node:test';
import assert from 'node:assert/strict';
import { migrateWorldSchema4State } from '../src/world/migration.js';
import { exportRuntimeState, exportRuntimeStateAsync, validateRuntimeState } from '../src/engine/runtime-state.js';
import { copyMap, copyRuleset, worldCopyInput } from './fixtures/world-copy-inputs.js';

const options = { mapPackage: copyMap, ruleset: copyRuleset };
const errorOf = run => {
  try { run(); }
  catch (error) { return { name: error.name, message: error.message, code: error.code }; }
  assert.fail('expected original error');
};

test('full runtime validation retains BigInt, circular and clone-hook errors before later content checks', async () => {
  for (const corrupt of [state => { state.extension.big = 1n; },
    state => { state.extension.self = state.extension; },
    state => { state.extension.toJSON = () => 'unsupported'; }]) {
    const { state } = worldCopyInput(); corrupt(state);
    state.markers[0].x = 'invalid';
    const original = errorOf(() => migrateWorldSchema4State(state, { statusDefinitions: copyRuleset.statuses.definitions }));
    assert.deepEqual(errorOf(() => validateRuntimeState(state, options)), original);
    assert.deepEqual(errorOf(() => exportRuntimeState(state, options)), original);
    await assert.rejects(exportRuntimeStateAsync(state, options), error =>
      error.name === original.name && error.message === original.message && error.code === original.code);
  }
});

test('full validator reads source getters once and keeps nonenumerable serialization hooks outside its owned snapshot', async () => {
  for (const type of ['getter', 'non-enumerable-toJSON', 'non-enumerable-getter-toJSON']) {
    function setup() {
      const { state } = worldCopyInput(), calls = [];
      if (type === 'getter') Object.defineProperty(state.extension, 'observed', { enumerable: true,
        get() { calls.push('get'); return 'value'; } });
      if (type === 'non-enumerable-toJSON') Object.defineProperty(state.extension, 'toJSON', {
        value: () => { calls.push('hidden-toJSON'); return { value: 1 }; } });
      if (type === 'non-enumerable-getter-toJSON') Object.defineProperty(state.extension, 'toJSON', {
        get() { calls.push('hidden-getter'); return () => { calls.push('hidden-toJSON'); return { value: 1 }; }; } });
      return { state, calls };
    }
    const original = setup();
    migrateWorldSchema4State(original.state, { statusDefinitions: copyRuleset.statuses.definitions });
    const synchronous = setup(), asynchronous = setup();
    const expected = exportRuntimeState(synchronous.state, options);
    const actual = await exportRuntimeStateAsync(asynchronous.state, options, { budgetMs: 0, yieldTask: async () => {} });
    assert.equal(JSON.stringify(actual), JSON.stringify(expected));
    assert.deepEqual(synchronous.calls, original.calls);
    assert.deepEqual(asynchronous.calls, original.calls);
    assert.deepEqual(original.calls, type === 'getter' ? ['get'] : []);
  }
});

test('final canonical projection completes all content checks without an extra completed-work frame wait', async () => {
  const { state } = worldCopyInput();
  const expected = exportRuntimeState(state, options), before = structuredClone(state);
  let yields = 0;
  const actual = await exportRuntimeStateAsync(state, options, { budgetMs: 0,
    yieldTask: async () => { yields++; } });
  assert.equal(yields, 2);
  assert.equal(JSON.stringify(actual), JSON.stringify(expected));
  assert.deepEqual(state, before);
  for (const corrupt of [current => { current.preferences.worldV2.scenes[0].sceneEvents[0].craterPolygon = [[1, 1], [2, 2]]; },
    current => { current.preferences.worldV2.scenes[0].attackAreas = [{ id: 'retired', anchor: { type: 'character', characterId: 'old' } }]; }]) {
    const malformed = structuredClone(state); corrupt(malformed);
    const error = errorOf(() => exportRuntimeState(malformed, options));
    await assert.rejects(exportRuntimeStateAsync(malformed, options, { budgetMs: 0, yieldTask: async () => {} }),
      actualError => actualError.name === error.name && actualError.message === error.message);
  }
});
